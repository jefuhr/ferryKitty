# November 2 service rollover

Production's curated fall calendar ended November 1. A refresh on the repository's
historical `main` signage branch did not update the webapp deployed from `mobile`.

`python3 scripts/import-november-live.py` reads the unmodified operator ZIP at
`fall-2026-sources/nycferry-20261102.zip`, verifies its SHA-256, and generates
`november-2026-live.json`. Source URL:
https://nycferry.connexionz.net/rtt/public/resource/gtfs.zip

The builder combines those tables with the archive-pinned fall schedule. November
trip and service IDs use `nyc:november:` internally to avoid collisions; `liveTripId`
retains the actual published ID for realtime and connections. Published stop times,
service dates, restrictions, and exceptions are preserved. No summer/fall working
number, crew shift, shuttle, or turnaround is assigned to a November trip.

Historical crew boundaries and historical trip mappings remain unchanged. Current
crew shifts and boat assignments remain unconfirmed until a current workbook is
reviewed. The freshness check includes the November schedule and still rejects a
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
