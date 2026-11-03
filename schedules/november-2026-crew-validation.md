# Board import verification

Input: the user-selected `Board` sheet of the local vessel assignment workbook.
The workbook's SHA-256 is recorded in `november-2026-board-source.json` and was
rechecked after extraction. The workbook was not modified. Only operational labels,
cell notes and the relief timing cells are archived; personnel names are excluded.

Results: 42 shift notes, 21 uniquely identified weekday workings, 259 assigned
published trips, 78 exact boundaries, 6 unresolved boundaries. Matching requires
an exact stop and timestamp, consistent route and unique GTFS block evidence.
Weekends and holiday exceptions do not inherit ordinary weekday crews.

Unresolved fields remain absent rather than corrected:

| Working | Field | Board time |
| --- | --- | --- |
| ER3 PM | Last drop | 21:39 |
| RS5 PM | First departure | 16:05 |
| RS1 AM | Last drop | 13:03 |
| RS3 AM | Last drop | 14:09 |
| RS4 AM | Last drop | 12:57 |
| RS6 AM | Last drop | 14:07 |

The user confirmed the 12:45 (RS1 / RS4) and 13:45 (RS3 / RS6) relief rows are
crew shuttles. They are shown as Board-listed crew-shuttle times in the weekday
Pier 11 and Pier C notes. No departure/pickup reference, endpoint timestamps or
travel windows are invented; that detail was not specified by the confirmation.

Checks:

- `npm test`: 472 passed, 0 failed.
- `PYTHONDONTWRITEBYTECODE=1 python3 test/november-crew-import.test.py`: 5 passed,
  including rejection of conflicting block evidence and nearest-time substitutions.
- `swift test --package-path ios/FerryCore`: 44 tests, 2 skipped, 0 failures.
- `bash scripts/android.sh core --offline`: 55 tests, 2 skipped, 0 failures.
  This used cached build dependencies. The generated HTML report was preserved at
  `artifacts/android-core-report/` to keep browser-only report JavaScript outside
  Node's automatic test-directory discovery.
- `node scripts/check-post-sukkot-browser.cjs`: 10 responsive cases passed,
  including current Board warnings, live delays, trip details and Pier C rows.
  Screenshots, traces and results are under `artifacts/browser/`.
- `npm run check:nyc-feed`: passed for `20261102`.
- `npm run build`: passed, 1162 scheduled Pier 11 rows across current and archived calendars.
- `git diff --check`: passed.

No production deployment or installed-device validation was performed. Native
core live-production and generated service-parity tests were skipped rather than
reported as passing. Historical crew data and its original coverage are preserved.
