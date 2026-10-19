# Wishlist Exporter for Steam Next Fest

Sister extension to the Next Fest Demo Exporter (`../nextfest-exporter/`). It exports your
Steam wishlist to a CSV you can open in Google Sheets, flagging which wishlisted games are
in the current Next Fest.

## Install

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** and pick this `nextfest-wishlist-exporter` folder.
3. Be signed in to store.steampowered.com in the same Chrome profile.

## Use

Click the extension, then **Export wishlist CSV**. A run takes a few seconds. To open it in
Google Sheets: **File > Import > Upload**, pick the CSV, and choose "Insert new sheet(s)".

- **Only games in Next Fest** limits the rows to wishlisted games with a demo in the fest.
- **Add AI / studio data from Next Fest export files…** (optional) takes a Next Fest Demo
  Exporter file (full or slim JSON) and/or `ai_categories.json`. Their AI-disclosure,
  AI-category and debut-studio values are matched to your wishlist by demo. They're
  remembered until you click Clear. Without them those columns are blank.

The current fest is read from https://store.steampowered.com/sale/nextfest each run, so a
new fest needs no code change. If that page can't be read, the October 2026 values in
`popup.js` (`FALLBACK_FEST`) are used.

## Columns

| Column | Notes |
|---|---|
| Name, Store URL, App ID | The wishlisted game |
| In Next Fest, Demo URL, Demo App ID | TRUE when one of the game's demos is in the fest |
| Wishlist Rank, Date Added | Only when your wishlist is public; blank if private |
| Release Status, Release Date | Released / Upcoming; the date at the precision Steam shows (exact date, month, quarter, year, TBA) |
| Price | Current US price; blank for unreleased games |
| Review %, Review Count, Review Summary | The full game's Steam reviews |
| Demo Review %, Demo Reviews | The fest demo's reviews |
| Developers, Publishers, Self-Published | Self-published = every publisher is also a developer |
| Debut Studio, Prior Releases | From an added Next Fest export run with Studio info |
| Uses AI, AI Used For, AI In-Game, AI Code Only, AI Disclosure | From an added Next Fest export (AI) and `ai_categories.json` (categories) |
| Tags | Top six store tags |

Booleans are written as TRUE/FALSE so Sheets treats them as checkboxes-ready values. The
file is UTF-8 with a BOM so non-English names survive the import.
