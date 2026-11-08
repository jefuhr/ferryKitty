"""Import November's official GTFS alongside the archive-pinned fall schedule.
Keep raw source bytes. Namespaced trip IDs prevent collisions with historical trips;
live IDs remain the actual operator IDs. Crew assignments require a separate review.

With no argument this rebuilds the reviewed map from the pinned 20261103 archive.
Pass a newer archived ZIP (inside the repo) to draft a refresh from it; the draft
still has to be reviewed before it replaces the pinned source.
"""
import csv
import hashlib
import io
import json
from pathlib import Path
import sys
import zipfile
ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'schedules/fall-2026-sources/nycferry-20261103.zip'
PINNED_SHA256 = '14fd496026292af6095e774fdcc4f4fbeba81f5915652bbd5d04ddca1dd47e02'
START, END = '2026-11-02', '2027-12-31'

def main(argv=None):
 argv = sys.argv[1:] if argv is None else argv
 source = (Path(argv[0]) if argv else SOURCE).resolve()
 pinned = source == SOURCE.resolve()
 digest = hashlib.sha256(source.read_bytes()).hexdigest()
 if pinned:
  assert digest == PINNED_SHA256
 with zipfile.ZipFile(source) as archive:
  tables = {name[:-4]: list(csv.DictReader(io.StringIO(archive.read(name).decode('utf-8-sig'))))
            for name in ['feed_info.txt','routes.txt','stops.txt','trips.txt','stop_times.txt','calendar.txt','calendar_dates.txt']}
 info = tables['feed_info'][0]
 if pinned:
  assert info['feed_version'] == '20261103'
  assert info['feed_start_date'] == '20261102'
 else:
  assert info['feed_start_date'] <= START.replace('-', ''), f"feed starts {info['feed_start_date']}, after {START}"
  assert info['feed_end_date'] >= END.replace('-', ''), f"feed ends {info['feed_end_date']}, before {END}"
 ids = {t['trip_id'] for t in tables['trips']}
 assert len(ids) == len(tables['trips'])
 assert all(s['trip_id'] in ids for s in tables['stop_times'])
 result = {'source': str(source.relative_to(ROOT)), 'sourceSha256': digest,
           'feedVersion': info['feed_version'], 'startDate': START, 'endDate': END,
           'crewStatus': 'unconfirmed', 'tables': tables}
 (ROOT / 'schedules/november-2026-live.json').write_text(json.dumps(result, separators=(',',':'))+'\n')
 print(f"Imported {len(ids)} published trips from GTFS {info['feed_version']}, with original live IDs and no crew assignments")
if __name__ == '__main__': main()
