"""Import November's official GTFS alongside the archive-pinned fall schedule.
Keep raw source bytes. Namespaced trip IDs prevent collisions with historical trips;
live IDs remain the actual operator IDs. Crew assignments require a separate review.
"""
import csv
import hashlib
import io
import json
from pathlib import Path
import zipfile
ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'schedules/fall-2026-sources/nycferry-20261102.zip'

def main():
 assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == '91713d54f1faab5a49d6a37ab4b631288547446227214857ccb783484349ce3a'
 with zipfile.ZipFile(SOURCE) as archive:
  tables = {name[:-4]: list(csv.DictReader(io.StringIO(archive.read(name).decode('utf-8-sig'))))
            for name in ['feed_info.txt','routes.txt','stops.txt','trips.txt','stop_times.txt','calendar.txt','calendar_dates.txt']}
 info = tables['feed_info'][0]
 assert info['feed_version'] == '20261102'
 assert info['feed_start_date'] == '20261102'
 ids = {t['trip_id'] for t in tables['trips']}
 assert len(ids) == len(tables['trips'])
 assert all(s['trip_id'] in ids for s in tables['stop_times'])
 result = {'source': str(SOURCE.relative_to(ROOT)), 'sourceSha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
           'feedVersion': info['feed_version'], 'startDate': '2026-11-02', 'endDate': '2027-12-31',
           'crewStatus': 'unconfirmed', 'tables': tables}
 (ROOT / 'schedules/november-2026-live.json').write_text(json.dumps(result, separators=(',',':'))+'\n')
 print(f"Imported {len(ids)} published trips, with original live IDs and no crew assignments")
if __name__ == '__main__': main()
