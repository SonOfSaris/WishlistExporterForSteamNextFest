// popup.js - Wishlist Exporter for Steam Next Fest
// Everything runs here in the popup: a run takes seconds (a handful of batched requests),
// so there's no long job to keep alive in a service worker. Requests carry your Steam
// cookies (host permissions + credentials: "include"), which is how the wishlist is read.

const $ = (id) => document.getElementById(id);

const SALE_URL = "https://store.steampowered.com/sale/nextfest";
const QUERY_URL = "https://store.steampowered.com/saleaction/ajaxgetsaledynamicappquery";
const USERDATA_URL = "https://store.steampowered.com/dynamicstore/userdata/";
const GETITEMS_URL = "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/";
const WISHLIST_URL = "https://api.steampowered.com/IWishlistService/GetWishlist/v1/";
const TAGS_URL = "https://store.steampowered.com/tagdata/populartags/english";
const STORE_APP = "https://store.steampowered.com/app/";
const BATCH_SIZE = 100;
const CONCURRENCY = 4;

// Used only if the live sale page can't be read. Same values the Next Fest Demo Exporter
// uses for October 2026; the page is normally parsed so a new fest needs no edit here.
const FALLBACK_FEST = {
  name: "Next Fest October 2026", clanAccountID: "39049601",
  clanAnnouncementGID: "713414759190366804", tabuniqueid: "23", sectionuniqueid: "80225"
};

const ENRICH_KEY = "enrichData_v1";

// ---------- network ----------
async function getJSON(url) {
  const r = await fetch(url, { credentials: "include", headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.slice(0, 70)}...`);
  return r.json();
}

async function runBatches(ids, dataRequest, onItems) {
  const batches = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) batches.push(ids.slice(i, i + BATCH_SIZE));
  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const payload = {
        ids: batches[next++].map(appid => ({ appid })),
        context: { language: "english", country_code: "US" },
        data_request: dataRequest
      };
      const data = await getJSON(`${GETITEMS_URL}?input_json=${encodeURIComponent(JSON.stringify(payload))}`);
      onItems(data?.response?.store_items || []);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

function unescapeHtml(s) {
  return s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// Reads the current fest's query params (and your steamid, if signed in) from the sale page.
async function getFestInfo() {
  const r = await fetch(SALE_URL, { credentials: "include" });
  const html = await r.text();
  let fest = { ...FALLBACK_FEST, fromPage: false };
  try {
    const m = html.match(/data-partnereventstore="([^"]*)"/);
    const ev = JSON.parse(unescapeHtml(m[1]))[0];
    const jd = JSON.parse(ev.jsondata);
    const browser = jd.sale_sections.find(s => s.section_type === "sale_item_browser");
    fest = {
      name: (ev.event_name || "").replace(/\s*-\s*LIVE NOW\s*$/i, "") || FALLBACK_FEST.name,
      clanAccountID: String(BigInt(ev.clan_steamid) - 103582791429521408n),
      clanAnnouncementGID: ev.announcement_body.gid,
      tabuniqueid: String(browser.show_on_tabs[0]),
      sectionuniqueid: String(browser.unique_id),
      fromPage: true
    };
  } catch (e) { /* page layout changed - fall back to the known October 2026 params */ }
  let steamid = null;
  try {
    const u = html.match(/data-userinfo="([^"]*)"/);
    steamid = JSON.parse(unescapeHtml(u[1])).steamid || null;
  } catch (e) {}
  return { fest, steamid };
}

async function getFestDemoIds(fest) {
  const qs = new URLSearchParams({
    cc: "US", l: "english",
    clanAccountID: fest.clanAccountID, clanAnnouncementGID: fest.clanAnnouncementGID,
    flavor: "dailyactiveuserdemo", strFacetFilter: "",
    tabuniqueid: fest.tabuniqueid, sectionuniqueid: fest.sectionuniqueid,
    return_capsules: "false", bRequestFacetCounts: "false", bUseCreatorHomeApps: "false",
    bAllowDemos: "false", strTabFilter: "", origin: "https://store.steampowered.com",
    start: "0", count: "10000"
  });
  const data = await getJSON(`${QUERY_URL}?${qs}`);
  if (data.success !== 1) throw new Error("Next Fest demo list query failed");
  return data.appids || [];
}

// Wishlist appids for the signed-in user (works for private wishlists too), plus rank and
// date added when the wishlist is visible to the public API.
async function getWishlist(steamid) {
  const ud = await getJSON(USERDATA_URL);
  const ids = ud.rgWishlist || [];
  const meta = new Map();
  if (steamid) {
    try {
      const w = await getJSON(`${WISHLIST_URL}?steamid=${encodeURIComponent(steamid)}`);
      for (const it of w?.response?.items || []) meta.set(it.appid, it);
    } catch (e) { /* private wishlist - rank/date columns stay blank */ }
  }
  // GetWishlist can include items userdata's cache hasn't caught up with yet.
  for (const id of meta.keys()) if (!ids.includes(id)) ids.push(id);
  return { ids, meta };
}

// ---------- shaping ----------
const SUFFIX_RE = /\b(llc|ltd|inc|co|corp|gmbh|srl|s\.a|studios?|games?|entertainment|interactive|productions?|publishing)\b\.?/gi;
const normName = s => (s || "").toLowerCase().replace(SUFFIX_RE, "").replace(/[^\p{L}\p{N}]+/gu, "");

function isSelfPublished(devs, pubs) {
  const d = new Set(devs.map(normName).filter(Boolean));
  const p = [...new Set(pubs.map(normName).filter(Boolean))];
  if (!d.size || !p.length) return null;
  return p.every(x => d.has(x));
}

const isoDate = ts => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "");

// Release label honoring the announced precision (exact date / month / quarter / year / TBA).
function releaseText(r) {
  if (!r) return "";
  const disp = r.coming_soon_display;
  if (disp === "text_tba") return "TBA";
  if (disp === "text_comingsoon") return "Coming soon";
  if (!r.steam_release_date) return r.custom_release_date_message || "";
  const dt = new Date(r.steam_release_date * 1000), y = dt.getUTCFullYear();
  if (disp === "date_year") return String(y);
  if (disp === "date_quarter") return `Q${Math.floor(dt.getUTCMonth() / 3) + 1} ${y}`;
  if (disp === "date_month") return dt.toLocaleDateString("en-US", { year: "numeric", month: "short", timeZone: "UTC" });
  return isoDate(r.steam_release_date);
}

function releaseStatus(r) {
  if (!r) return "";
  if (r.is_coming_soon) return "Upcoming";
  return r.steam_release_date ? "Released" : "";
}

const AI_CAT_LABELS = {
  art: "Art", marketing: "Store page", music: "Music/SFX", voice: "Voice", writing: "Writing",
  translation: "Translation", code: "Code", live: "Live generation", other: "Other", unspecified: "Unspecified"
};
const AI_NOT_IN_GAME = new Set(["marketing", "other"]);

const COLUMNS = [
  "Name", "Store URL", "App ID", "In Next Fest", "Demo URL", "Demo App ID",
  "Wishlist Rank", "Date Added", "Release Status", "Release Date", "Price",
  "Review %", "Review Count", "Review Summary", "Demo Review %", "Demo Reviews",
  "Developers", "Publishers", "Self-Published", "Debut Studio", "Prior Releases",
  "Uses AI", "AI Used For", "AI In-Game", "AI Code Only", "AI Disclosure", "Tags"
];

function buildRow(appid, it, wl, demo, extra, tagMap) {
  const bi = it?.basic_info || {};
  const devs = (bi.developers || []).map(x => x.name);
  const pubs = (bi.publishers || []).map(x => x.name);
  const rev = it?.reviews?.summary_filtered;
  const drev = demo?.reviews?.summary_filtered;
  const price = it?.is_free ? "Free" : (it?.best_purchase_option?.formatted_final_price || "");
  const tags = (it?.tags || []).slice().sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .slice(0, 6).map(t => tagMap.get(t.tagid)).filter(Boolean);
  const cats = extra?.cats || null;
  const ai = typeof extra?.ai === "boolean" ? extra.ai : null;
  return {
    "Name": it?.name || "(unavailable on the store)",
    "Store URL": STORE_APP + appid + "/",
    "App ID": appid,
    "In Next Fest": !!demo,
    "Demo URL": demo ? STORE_APP + demo.appid + "/" : "",
    "Demo App ID": demo ? demo.appid : "",
    "Wishlist Rank": wl?.priority || "",
    "Date Added": isoDate(wl?.date_added),
    "Release Status": releaseStatus(it?.release),
    "Release Date": releaseText(it?.release),
    "Price": price,
    "Review %": rev?.review_count ? rev.percent_positive : "",
    "Review Count": rev?.review_count || 0,
    "Review Summary": rev?.review_count ? rev.review_score_label : "",
    "Demo Review %": drev?.review_count ? drev.percent_positive : "",
    "Demo Reviews": demo ? (drev?.review_count || 0) : "",
    "Developers": devs.join(", "),
    "Publishers": pubs.join(", "),
    "Self-Published": isSelfPublished(devs, pubs),
    "Debut Studio": typeof extra?.debut === "boolean" ? extra.debut : null,
    "Prior Releases": extra?.prior ?? "",
    "Uses AI": ai,
    "AI Used For": cats && ai ? cats.map(c => AI_CAT_LABELS[c] || c).join(", ") : "",
    "AI In-Game": cats && ai ? cats.some(c => !AI_NOT_IN_GAME.has(c)) : null,
    "AI Code Only": cats && ai ? (cats.length === 1 && cats[0] === "code") : null,
    "AI Disclosure": ai ? (extra.aiText || "") : "",
    "Tags": tags.join(", ")
  };
}

// CSV for Google Sheets: UTF-8 with BOM, CRLF, TRUE/FALSE booleans. Cells that would start
// with = + - @ are prefixed with ' so a game name can't be read as a formula.
function csvCell(v) {
  if (v == null) return "";
  let s = typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCSV(rows) {
  const lines = [COLUMNS.map(csvCell).join(",")];
  for (const r of rows) lines.push(COLUMNS.map(c => csvCell(r[c])).join(","));
  return "﻿" + lines.join("\r\n");
}

// ---------- the run ----------
async function buildExport(onlyFest, setStatus) {
  setStatus("Reading the Next Fest page...");
  const { fest, steamid } = await getFestInfo();

  setStatus("Reading your wishlist...");
  const { ids, meta } = await getWishlist(steamid);
  if (!ids.length) {
    throw new Error("No wishlist found. Sign in to the Steam store in this Chrome profile, then try again.");
  }

  setStatus(`Fetching the ${fest.name} demo list...`);
  const festDemoIds = await getFestDemoIds(fest);

  // Map each fest demo to its full game, so wishlisted games can be matched to the fest.
  setStatus(`Matching ${ids.length} wishlisted games against ${festDemoIds.length} fest demos...`);
  const demoByParent = new Map();
  await runBatches(festDemoIds, { include_related_items: true, include_reviews: true }, items => {
    for (const it of items) {
      const parent = it.related_items?.parent_appid;
      if (parent && !demoByParent.has(parent)) demoByParent.set(parent, it);
    }
  });

  setStatus("Fetching game details...");
  const tagMap = new Map((await getJSON(TAGS_URL)).map(t => [t.tagid, t.name]));
  const items = new Map();
  await runBatches(ids, {
    include_basic_info: true, include_release: true, include_reviews: true,
    include_tag_count: 12, include_all_purchase_options: true
  }, list => { for (const it of list) if (it.success === 1) items.set(it.appid, it); });

  const enrich = await loadEnrich();
  let rows = ids.map(appid => {
    const demo = demoByParent.get(appid) || null;
    // Export files are keyed by demo appid; fall back to the game's own appid.
    const extra = enrich?.apps[demo?.appid] || enrich?.apps[appid] || null;
    return buildRow(appid, items.get(appid), meta.get(appid), demo, extra, tagMap);
  });
  if (onlyFest) rows = rows.filter(r => r["In Next Fest"]);
  // Wishlist rank order when known, else as Steam lists it; fest games first within that.
  rows.sort((a, b) => (+b["In Next Fest"] - +a["In Next Fest"]) ||
    ((a["Wishlist Rank"] || Infinity) - (b["Wishlist Rank"] || Infinity)));

  return {
    csv: toCSV(rows),
    total: ids.length,
    inFest: ids.filter(a => demoByParent.has(a)).length,
    rows: rows.length,
    ranked: meta.size > 0,
    fest
  };
}

// ---------- optional enrichment files (from the Next Fest Demo Exporter / viewer) ----------
// Stored as one compact appid map: { "<appid>": { ai, aiText, cats, debut, prior } }
async function loadEnrich() {
  try { return (await chrome.storage.local.get(ENRICH_KEY))[ENRICH_KEY] || null; }
  catch (e) { return null; }
}

async function addEnrichFiles(files) {
  const cur = (await loadEnrich()) || { files: [], apps: {} };
  for (const f of files) {
    const data = JSON.parse(await f.text());
    if (Array.isArray(data?.demos)) {
      // A Next Fest export: AI (only from files that checked demo + full-game pages) and studio info.
      const aiOk = data.meta?.ai_scope === "union";
      for (const d of data.demos) {
        const e = cur.apps[d.appid] || (cur.apps[d.appid] = {});
        if (aiOk && typeof d.ai_disclosed === "boolean") { e.ai = d.ai_disclosed; e.aiText = d.ai_disclosure || ""; }
        if (typeof d.debut_studio === "boolean") { e.debut = d.debut_studio; e.prior = d.dev_prior_releases ?? ""; }
      }
    } else if (data?.items) {
      // ai_categories.json
      for (const [id, v] of Object.entries(data.items)) {
        const cats = Array.isArray(v) ? v : v?.cats;
        if (Array.isArray(cats)) (cur.apps[id] || (cur.apps[id] = {})).cats = cats;
      }
    } else {
      throw new Error(`${f.name} isn't a Next Fest export or ai_categories.json`);
    }
    cur.files = [...cur.files.filter(n => n !== f.name), f.name];
  }
  await chrome.storage.local.set({ [ENRICH_KEY]: cur });
  return cur;
}

function showEnrich(e) {
  const info = $("enrichInfo");
  info.textContent = "";
  if (!e) return;
  const v = Object.values(e.apps);
  info.append(`Using ${e.files.join(", ")}: ${v.filter(x => typeof x.ai === "boolean").length.toLocaleString()} AI, ` +
    `${v.filter(x => x.cats).length.toLocaleString()} categorised, ${v.filter(x => typeof x.debut === "boolean").length.toLocaleString()} studio. `);
  const clear = document.createElement("a");
  clear.href = "#";
  clear.textContent = "Clear";
  clear.addEventListener("click", async (ev) => {
    ev.preventDefault();
    await chrome.storage.local.remove(ENRICH_KEY);
    showEnrich(null);
  });
  info.append(clear);
}

// ---------- UI ----------
if (typeof document !== "undefined" && $("go")) {
  const status = $("status"), go = $("go"), dl = $("dl");
  const setStatus = (t, err) => { status.textContent = t; status.classList.toggle("err", !!err); };

  try { $("onlyFest").checked = localStorage.getItem("onlyFest") === "1"; } catch (e) {}
  $("onlyFest").addEventListener("change", () => {
    try { localStorage.setItem("onlyFest", $("onlyFest").checked ? "1" : "0"); } catch (e) {}
  });

  $("enrichPick").addEventListener("click", (e) => { e.preventDefault(); $("enrichFile").click(); });
  $("enrichFile").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (!files.length) return;
    $("enrichInfo").textContent = "Reading...";
    try { showEnrich(await addEnrichFiles(files)); }
    catch (err) { $("enrichInfo").textContent = "Couldn't use that file: " + err.message; }
  });
  loadEnrich().then(showEnrich);

  go.addEventListener("click", async () => {
    go.disabled = true;
    dl.style.display = "none";
    try {
      const out = await buildExport($("onlyFest").checked, setStatus);
      const url = URL.createObjectURL(new Blob([out.csv], { type: "text/csv;charset=utf-8" }));
      dl.href = url;
      dl.download = `wishlist_nextfest_${new Date().toISOString().slice(0, 10)}.csv`;
      dl.style.display = "block";
      dl.click();
      setStatus(`${out.inFest} of ${out.total} wishlisted games are in ${out.fest.name}. ` +
        `${out.rows} rows exported` + (out.ranked ? "." : " (wishlist rank/date blank: wishlist is private)."));
    } catch (e) {
      setStatus("Error: " + (e && e.message ? e.message : e), true);
    } finally {
      go.disabled = false;
    }
  });
}
