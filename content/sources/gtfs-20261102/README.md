# November 2, 2026 GTFS refresh

The ZIPs are unmodified operator downloads. `manifest.json` records URLs and SHA-256 hashes.
Reproduce the feed import with `python3 scripts/import-gtfs-20261102.py`.

- NYC Ferry: replace the root feed with published version `20261102`.
- NY Waterway: refresh Trillium's feed, retaining existing terminal IDs and bus routes. Add only Connexionz route 60 (Belford), namespacing its IDs with `belford:` and mapping its four shared terminals to the existing Trillium IDs. Other Connexionz routes are excluded to avoid duplicate service. Remove obsolete fare files absent from the new Trillium archive. Trillium's shorter feed validity (April 1, 2027) remains unchanged.
- Belford's calendars are bounded to the November 2 effective date. Times, stop restrictions, exceptions, and shapes come from Connexionz without inferred transfer legs. In particular, the advisory's Midtown times marked as requiring a transfer at Pier 11 are not represented as direct Belford sailings.
- The [official advisory](https://nywaterway.com/AdvisoryDetails.aspx?aid=912) and archived `../belford-20261102/BelfordSch_261102a.jpg` confirm the 06:20 departure, Monday–Thursday 05:15 departure, and Monday–Friday 18:15 return from Midtown. The route webpage still lists older conflicting times.
- NYC Ferry no longer includes Yankee Pier stop 111. Landing 11 remains available for the Trust's separate feed using its former published position, with no NYC Ferry departures invented.
- Summer-specific integration tests use `test/fixtures/summer-2026.json.gz`, captured from the base revision in the manifest. Current feed checks remain separate in `test/gtfs-refresh.test.js`; the existing feed-freshness check still reads current data.
