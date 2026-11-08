# November 2 service rollover

Production's curated fall calendar ended November 1. A refresh on the repository's
historical `main` signage branch did not update the webapp deployed from `mobile`.

`python3 scripts/import-november-live.py` reads the unmodified operator ZIP at
`fall-2026-sources/nycferry-20261103.zip`, verifies its SHA-256, and generates
`november-2026-live.json`. Source URL:
https://nycferry.connexionz.net/rtt/public/resource/gtfs.zip

The builder combines those tables with the archive-pinned fall schedule. November
trip and service IDs use `nyc:november:` internally to avoid collisions; `liveTripId`
retains the actual published ID for realtime and connections. Published stop times,
service dates, restrictions, and exceptions are preserved. Summer/fall working numbers and crew shifts are never used to label November trips.
The separately reviewed `Board` sources supply current weekday and winter weekend
workings. See `winter-2026-weekend-notes.md` for optional workings and date controls.
The November 3 feed changes destination wording only; its stop times and calendars
match November 2. Weekday assignments, shift boundaries and rejections are preserved.

Historical crew boundaries and historical trip mappings remain unchanged. The user-selected `Board` sheet is recorded in `november-2026-board-source.json`,
with the original workbook SHA-256 and operational comments only (no personnel names).
`python3 scripts/import-november-crew.py` verifies exact stop/time events and consistent
GTFS blocks, producing 259 trip assignments across 21 weekday workings. Of 84 noted
boundaries, 78 match exactly; 6 remain explicitly rejected without nearest-time
substitution. Unmatched returns and starts remain absent, and weekends/holidays do
not inherit weekday crews. The user confirmed the two relief rows are crew shuttles: 12:45 for RS1 / RS4
and 13:45 for RS3 / RS6. These appear as Board-listed crew-shuttle times in the
current weekday Pier 11 and Pier C notes. Their departure/pickup reference remains
unspecified, so no endpoint timestamps or travel windows are inferred. The freshness check includes the November schedule and still rejects a
new unreviewed feed version or dates outside reviewed coverage.

The separate Belford feed keeps the September weekday trips through November 1
and introduces November 2 weekday services from the archived advisory image
`waterway-sources/BelfordSch_261102a.jpg`:
https://www.nywaterway.com/AdvisoryDetails.aspx?aid=912

The new trips depart Belford at 06:20, arriving Pier 11 at 07:00, Brookfield at
07:10 and Paulus Hook at 07:15. The 05:15 departure runs Monday–Thursday and the
18:15 Midtown return runs Monday–Friday. Transfer-only Midtown calls remain
excluded from direct trips. Weekend service is unchanged.

Verification: `npm test`, `npm run check:nyc-feed`, `npm run build`, and
`node scripts/check-post-sukkot-browser.cjs`. Browser screenshots, Playwright traces,
and `post-sukkot-results.json` are written to `artifacts/browser/`; the browser
check covers November 2 plus four historical dates at 390px and 1440px.
