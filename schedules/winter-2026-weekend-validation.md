# Winter weekend verification

Validated November 7, 2026 in the isolated `winter-weekend-crews` checkout, based
on `mobile` revision `0fa01f0170d34f0bf98fa9a66d4301f95faf1501`.

## Automated checks

- `npm test`: 475 passed, no failures or skips.
- `PYTHONDONTWRITEBYTECODE=1 python3 test/winter-weekend-import.test.py`: eight
  passed. Covers reproducibility, recurring upstream cruise service, disabling
  cruise service, rejecting the copied ER3 note, separate dated ER3 activation,
  exception-only published service, rejecting cruise boundaries from another
  block, and excluding weekday holidays from weekend crew operations.
- `PYTHONDONTWRITEBYTECODE=1 python3 test/november-crew-import.test.py`: five passed.
  Current weekday assignments, shifts and rejections were also compared with
  the base revision and are unchanged.
- `node scripts/check-winter-weekend-browser.cjs`: eight responsive cases,
  rendering 24 boards across Pier 11, Red Hook and Pier C at 390px and 1440px.
  Dates: November 7, 8, 14 and 28. Checks normal labels, disabled ER3, dated SB3,
  missing unverified cruise crew movements, Board warnings, live delays,
  trip details and horizontal overflow.
- `node scripts/check-post-sukkot-browser.cjs`: ten responsive historical/current
  weekday cases passed, including realtime aliases, connections and Pier C.
- `node scripts/check-pier-101-browser.cjs`: two responsive Pier 101 cases passed
  across the home-port search, board and map flows.
- `node scripts/build-ios-service-contract.mjs artifacts/native-service-contract`:
  generated 31 landings, 753 service-date/mode cases, 58,821 departure projections.
  Includes the current weekday, optional cruise date, ordinary winter weekends
  and the still-unpublished November 28 cruise date.
- `FERRY_SERVICE_CONTRACT="$PWD/artifacts/native-service-contract" swift test --package-path ios/FerryCore`:
  45 tests, one skipped, zero failures. The generated service parity test ran.
- `FERRY_SERVICE_CONTRACT="$PWD/artifacts/native-service-contract" bash scripts/android.sh core --offline -I /tmp/weekend-native-reports.gradle`:
  56 tests, one skipped, zero failures. Used cached pinned dependencies. The
  temporary Gradle init script disabled HTML reports to keep browser-only report
  JavaScript outside Node's automatic test discovery. XML results are preserved.
- `npm run check:nyc-feed`: current reviewed sources match official feed `20261103`.
- `npm run build`: passed, 1,170 scheduled Pier 11 rows across current and archived
  calendars. The existing expired Statue of Liberty Ferry feed warning remains.
- `git diff --check`: passed.

The one skipped native test on each platform requires opt-in live-production
network access. Passing generated parity does not establish production delivery,
device installation or physical-device acceptance.

The native parity checks initially failed because their historical assertions
required a timed crew-shuttle row on every browsed day. The assertions now retain
that requirement for historical timetables and explicitly forbid fabricated
timed shuttle rows for the November Board's note-only relief times. Native parity
also now includes all 31 configured landings, including Pier 101. All final
projection comparisons pass without relaxing any field comparisons.

## Source and visual verification

The original workbook's SHA-256 was rechecked after extraction. All 28 archived
operational notes and six relief cells exactly match `Board`. No workbook edits
were made. The archived official ZIP is verified by the importer's pinned hash.

Inspected phone screenshots for Red Hook's November 7 `SB3` departures and the
Pier C Board warning/working labels. Browser screenshots, Playwright traces and
JSON results are in `artifacts/browser/`. Full local test logs, initial failure
logs and Android XML results are retained in `artifacts/winter-weekend/`.

No production deployment, physical-device install or manual device verification
was performed. The ten unconfirmed operational boundaries remain unconfirmed.
