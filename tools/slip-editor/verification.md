# Slip Editor Verification

Verified on November 13, 2026 with Node v26.13.0, starting from
`7817596c6efbab2795b1a191bb8b5d48d462b2b0` on `jefuhr/harbor-slip-editor`.

## Automated checks

Commands and final results:

```text
node --test test/harbor-slip-editor.test.js
ℹ tests 8
ℹ pass 8
ℹ fail 0

npm test
ℹ tests 821
ℹ pass 821
ℹ fail 0

npm run test:harbor
harbor E2E passed: 10 steps. Record: artifacts/harbor/e2e.json

node --check lib/harbor-slip-editor.js
node --check scripts/harbor-slip-editor.mjs
node --check tools/slip-editor/editor.js
git diff --check
All exited 0.
```

The eight tests cover byte-identical no-op round trips (including quoting,
CRLF, blank lines, and no final newline); editing one coordinate without changing
other cells or row order; editing a returned point array without mutating the original CSV baseline; adding, renaming, and deleting rows; validation and
tracker round trips without warnings; stale revisions; a real ephemeral HTTP
server with file readback, invalid saves, conflicts, local-origin protection,
and locally served browser assets; and reading a temporary SQLite database
without changing its bytes. Missing databases are covered by the HTTP test.
Full-suite output was retained at `/tmp/harbor-slip-editor-npm-test.log` and the
harbor check at `/tmp/harbor-slip-editor-harbor-test.log` on the development host.

An additional read-only round trip of the actual `content/harbor-slips.csv`
reported `94 points, byte-identical`. Its bytes were compared with
`git show 7817596:content/harbor-slips.csv` and match exactly.

## Browser checks

The editor was started against a temporary copy, never the actual survey:

```sh
node scripts/harbor-slip-editor.mjs --port 0 --slips /absolute/path/to/temporary/slips.csv
```

The printed URL was `http://127.0.0.1:51304`. The following were exercised by
hand through Orca browser commands, rather than just calling the JSON API:

1. Loaded all 94 existing points and selected Hunters Point South / Slip 1.
2. Applied typed latitude `40.7418613`, then dragged its marker 32 pixels right
   and 12 pixels down at zoom 21. The UI reported a move and displayed
   `40.7418551, -73.9614066` afterward.
3. Created `Browser verification berth`, clicked the map to add its first point,
   and renamed it `Browser renamed berth`. The point count became 95.
4. Deleted that point and clicked Undo to restore it.
5. Clicked Save CSV and read the temporary file back from disk. It contained the
   moved original point and the new row
   `Hunters Point South,Browser renamed berth,40.7418393,-73.9613832`.
6. Reloaded and confirmed the new slip persisted. Deleted the whole slip using
   its confirmation dialog, saved, then clicked Undo after the save and saved
   again. The row and 95-point count were restored, verifying Undo across saves.
7. Observed OpenStreetMap tiles and attribution, point labels, reference markers,
   the nearest-point distance, seven-decimal coordinate fields, and zoom-21
   overzoom. Browser console inspection returned no entries.

The unsaved-navigation handler was checked by dispatching a cancelable
`beforeunload` event in the browser while the deletion was unsaved; its
`defaultPrevented` value was `true`. The actual browser navigation dialog was
not manually triggered. The dwell overlay was tested through SQLite/HTTP,
not manually with a populated live collector database. Light mode and zoom 24
were not separately exercised by hand; the browser used dark mode and zoom 21.
The final browser screenshot is [browser-verification.png](browser-verification.png).

Initial tile requests exposed a too-strict referrer policy; this was corrected
to `strict-origin-when-cross-origin`, and a reload visibly loaded the map tiles.
No alternate tile provider or outbound service was used.

## Dependencies and limits

Only `leaflet@1.9.4` was added, as an exact devDependency, to provide the local
map, marker dragging, and tile overzoom. The npm registry version was checked
with `npm view leaflet version`, then installed with:

```sh
npm install --save-dev --save-exact leaflet@1.9.4 --ignore-scripts --no-audit --no-fund
```

No existing packages were removed or upgraded. Leaflet JS/CSS are served from
`node_modules` by the local server, not from a CDN. Node 22 was not separately
run; SQLite uses the specified `node:sqlite` API with `{ readOnly: true }`.

Partner-operator terminals and partner-only board landings remain reference-only:
the unchanged tracker loader accepts `gtfs/stops.txt` names and `Pier C`, so it
cannot represent partner-terminal slips in this CSV. The dwell layer displays
at most the most recent 50,000 recorded positions. No other implementation
issues remain known from these checks.

Start the tool normally with `npm run harbor:slips`; default port 8095 binds
only to `127.0.0.1`. The verification server was stopped after the checks.
