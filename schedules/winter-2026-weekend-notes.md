# Winter weekend Board import

Source: `NYC Ferry Vessel Assignment Board 11:7 winter.xlsx`, first worksheet
`Board`. Its SHA-256 and literal operational notes are archived in
`winter-2026-weekend-board-source.json`. The workbook is unchanged. No personnel
names are included. The older `WINTER WEEKEND 26-27` template was not used.

The 26 regular shift notes identify 13 workings and 128 published trips. Exact
route, stop, timestamp and unique block evidence is required. The label typo
`RWSDV 3 PM` at `Board!C10` is normalized to `RWSV` for matching; its original label
and note remain in the source. There are 44 verified boundaries and eight
unmatched regular boundaries. No nearest-time substitutions are made.

The current source is the unmodified operator GTFS `20261103`, archived at
`fall-2026-sources/nycferry-20261103.zip`, SHA-256
`14fd496026292af6095e774fdcc4f4fbeba81f5915652bbd5d04ddca1dd47e02`.
Its stop times and calendars match `20261102`; only destination wording changed.
The previous 259 weekday assignments, 42 shifts and six rejections remain unchanged.

## Optional workings

`optionalPolicy` in the source controls activation. Optional calendars have all
seven recurring flags set to zero. Only explicitly approved dates that also have
published GTFS service are added as exceptions. Trip IDs retain their real live
identities for realtime and connections.

- **ER3 Mid** is disabled, with display label `ER3`. `Board!C18` copies ER2 AM's
  08:55 Pier 11 start and 14:07 East 34th finish. The current feed has no distinct
  weekend ER3 working. Enabling requires separate exact boundaries and explicit
  dates; an import that would take ER2's trips fails. Exception-only published
  services are supported. The activation test uses synthetic fixture data only.
- **SBK Cruise Shuttle** uses the operator's distinct SB block `33` and `330x`
  working numbers, displayed as `SB3`. The 23 published trips run between
  Red Hook and Pier 11. The [operator announcement](https://static.ferry.nyc/blog/winter-2026-2027/)
  lists November 7, November 28 and December 19. Only November 7 is supported by
  the current feed; the later two dates remain pending. Regenerate after a feed
  review to activate newly published service. Ordinary weekends never inherit it.
  Setting `enabled` to false removes its active dates while retaining its scoped
  trip calendar, so it cannot fall back to recurring service.

The cruise note lists 07:22 Red Hook and 12:32 Pier 11. Published passenger trips
instead start from Red Hook at 07:15 and finish at Pier 11 at 12:55. Both Board
boundaries remain rejected. Published passenger times are preserved, and no
cruise home-port departures or returns are invented. Boundary events on another
block cannot establish cruise crew movements.

## Remaining operational uncertainty

| Working | Field | Board time | Place |
| --- | --- | --- | --- |
| SG1 PM | End | 20:38 | Pier 11 |
| SG2 AM | End | 13:10 | Pier 11 |
| RS2 PM | End | 20:53 | Rockaway |
| AS1 PM | Start | 15:26 | East 90th |
| RS1 AM | End | 14:15 | Pier 11 |
| RS2 AM | End | 15:21 | Pier 11 |
| RS3 AM | End | 14:17 | Pier 11 |
| RS4 AM | End | 15:23 | Pier 11 |
| SB3 Cruise | Start | 07:22 | Red Hook |
| SB3 Cruise | End | 12:32 | Pier 11 |

The weekend board reports all ten unresolved boundaries. Verified boundaries may
still supply operations for the same working; unresolved fields stay absent.

`Board!J3:M5` lists crew relief times: 14:00 for RS1 / RS3 / SG1 and 14:40 for AS2
and AS1. These remain notes on Pier 11 and Pier C. Endpoint departure/pickup
references are unspecified, so no shuttle travel windows are inferred.

Regular crew operations have a separate Saturday/Sunday calendar beginning
November 7. Published weekday holiday exceptions do not automatically acquire
weekend crew movements. Passenger service calendars remain as published.

## Reproduction

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/import-november-live.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/import-november-crew.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/import-winter-weekend-crew.py
node scripts/export-hardcoded-data.js
npm run build
```

Validation commands and results are recorded in `winter-2026-weekend-validation.md`.
