# Live Boat Layer Verification

Verified November 13, 2026, on top of `d76f6c0` in `jefuhr/harbor-slip-editor`,
using Node v26.13.0. No packages were added or changed.

## Automated checks

```text
node --test test/harbor-slip-editor.test.js
9 tests passed, 0 failed

npm test
822 tests passed, 0 failed

npm run test:harbor
harbor E2E passed: 10 steps. Record: artifacts/harbor/e2e.json

node --check scripts/harbor-slip-editor.mjs
node --check tools/slip-editor/editor.js
git diff --check
All exited 0.
```

The new HTTP test runs against a stub tracker on an ephemeral local port. It
checks the positioned-boat projection and removal of unrelated tracker fields,
missing/invalid positions, malformed JSON and response structure, HTTP errors,
redirect refusal without following the redirect, the three-second timeout,
a stopped tracker returning HTTP 200 with `available: false`, and the survey
remaining accessible. It checks both allowed hostnames, rejects non-local and
non-HTTP URLs, and starts the CLI with `--tracker http://example.com` to verify
that it exits with the local-HTTP validation error before contacting that host.
Only `name`, `operatorName`, `latitude`, `longitude`, `bearing`, `speedKnots`,
`ageSeconds`, `state`, `stale`, and `mmsi` reach the page; `mmsi` keys marker
updates. Full command output is retained locally at
`/tmp/harbor-slip-editor-boats-npm-test.log` and
`/tmp/harbor-slip-editor-boats-harbor-test.log`.

## Hand-driven browser checks

The editor was started against a temporary copy of the survey:

```sh
node scripts/harbor-slip-editor.mjs --port 0 --slips /absolute/path/to/temporary/slips.csv
```

It printed `http://127.0.0.1:53647`. The real tracker at
`http://127.0.0.1:8090/api/harbor/vessels` was accessed with read-only GET
requests, directly for initial inspection and through the editor's proxy.
At the initial inspection it returned 104 vessels, of which 83 had positions;
the page displayed 83 boat markers and left the 21 without positions out.

Using Orca browser commands by hand:

- Confirmed Boats was checked initially, and selected Rockaway / North and
  Dream Boat. Its readout showed NYC Ferry, docked, 0.0 knots, fix age in
  seconds, and latitude/longitude with seven decimal places. Its triangle
  marker and name label were visibly distinct from the slip circles.
- Left latitude `40.5842999` typed but unapplied, with focus in that input.
  Observed three more `/api/boats` requests (resource timing count 9 → 12).
  The input value, focus, selected slip, and map-pane transform stayed the same;
  the live boat readout updated. There were 41 faded boat markers at that check.
- Clicked **Add point at this boat**. The point count changed from 94 to 95 and
  the new selected point matched the displayed boat position
  `40.5841500, -73.8318500`. The temporary CSV remained byte-identical to the
  original file before Save, despite polling and the addition.
- Clicked Undo: 94 points and the saved state returned. Added again and saved;
  the only appended CSV row was
  `Rockaway,North,40.5841500,-73.8318500`, with no boat metadata in the file.
- Toggled Boats off and on. Off removed boat markers and hid the boat readout;
  the 95 survey points and saved state remained intact. On restored the layer.
- Opened a second editor configured to an unused local tracker port. It loaded
  all 95 survey points, displayed the small `boats unavailable` note, and showed
  no error dialog. Both pages' console inspections returned no entries.

The second editor used the same temporary file and this invocation:

```sh
node scripts/harbor-slip-editor.mjs --port 0 --slips /absolute/path/to/temporary/slips.csv --tracker http://127.0.0.1:<unused-local-port>
```

The real tracker was never stopped, reconfigured, or written to. The actual
survey still matches the base commit byte-for-byte. The screenshot
[boats-verification.png](boats-verification.png) preserves the real-tracker
readout and boat marker next to survey points. Both verification editor servers
were stopped after the checks.

## Limits

No known implementation issues remain from these checks. Tracker timeout,
malformed responses and redirect behavior were checked automatically against
the stub, not induced on the real tracker. Refresh was checked while typing;
refresh during an active drag or Save request was not separately driven by
hand. Light mode and Node 22 itself were not separately exercised.
Partner-operator terminals remain reference-only under the unchanged CSV loader.

Start normally with `npm run harbor:slips`, or override the tracker with
`npm run harbor:slips -- --tracker http://localhost:8090`. The editor binds only
to `127.0.0.1`; the tracker proxy permits only HTTP on `127.0.0.1` or `localhost`,
follows no redirects, and times out after three seconds. Browser connections
remain restricted to the editor's own origin by CSP.
