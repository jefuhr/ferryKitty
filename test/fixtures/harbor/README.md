# Harbor test fixtures

Everything here is invented. The landings sit in open water and are not real berths, the vessels and MMSIs do not exist, and no row is copied from any real slip survey. Keep it that way: real berth coordinates never enter this repository.

- `stops.json`: the invented stops the slip CSV names, plus one partner terminal with no slips.
- `slips.csv`: every slip label scheme, a yard, one duplicated slip label with two points, and one row whose landing matches no stop. Slip 1 and Slip 2 at Test Cove are 14 m apart on purpose.
- `roster.json`: two operators, one vessel with an MMSI, one that can only be found by AIS name, one partner vessel, one inactive.
- `ais-arrival.ndjson`: aisstream.io messages for MMSI 367000001. Static data, an approach to Test Point's North slip starting at 2026-11-11T15:00:00.000Z, a four-minute dwell with jitter, an unavailable heading (511) and course (360), one 0.6 kn blip, then a departure at 2026-11-11T15:09:40.000Z, and a final message of a type the tracker ignores.
