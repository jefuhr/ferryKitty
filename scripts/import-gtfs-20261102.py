"""Reproduce the November 2 refresh from archived operator bytes, without network access.

Retain Trillium's terminal IDs and bus routes. Supplement only Belford from Connexionz
so overlapping Waterway routes are not duplicated. No timetable values are inferred.
"""
import csv
import io
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'content/sources/gtfs-20261102'


def read(feed, name):
	return list(csv.DictReader(io.StringIO(feed.read(name).decode('utf-8-sig'))))


def write(name, rows, fields):
	with (ROOT / 'gtfs/waterway' / name).open('w', newline='') as output:
		writer = csv.DictWriter(output, fieldnames=fields)
		writer.writeheader()
		writer.writerows(rows)


def main():
	manifest = json.loads((SOURCE / "manifest.json").read_text())
	for source in manifest["sources"]:
		actual = hashlib.sha256((SOURCE / source["file"]).read_bytes()).hexdigest()
		if actual != source["sha256"]:
			raise ValueError(f"Source hash mismatch: {source['file']}")
	with ZipFile(SOURCE / 'nycferry.zip') as feed:
		for name in feed.namelist():
			assert '/' not in name and name.endswith('.txt')
			(ROOT / 'gtfs' / name).write_bytes(feed.read(name))
	with ZipFile(SOURCE / 'waterway-trillium.zip') as base, ZipFile(SOURCE / 'waterway-connexionz.zip') as supplement:
		trips = [row for row in read(supplement, 'trips.txt') if row['route_id'] == '60']
		trip_ids = {row['trip_id'] for row in trips}
		times = [row for row in read(supplement, 'stop_times.txt') if row['trip_id'] in trip_ids]
		services = {row['service_id'] for row in trips}
		shapes = {row['shape_id'] for row in trips}
		stops = {row['stop_id'] for row in times}
		stop_map = {'18': '2439146', '4': '2729332', '14': '2439145', '17': '2439141'}
		selected = {
			'routes.txt': [row for row in read(supplement, 'routes.txt') if row['route_id'] == '60'],
			'trips.txt': trips,
			'stop_times.txt': times,
			'stops.txt': [row for row in read(supplement, 'stops.txt') if row['stop_id'] in stops and row['stop_id'] not in stop_map],
			'calendar.txt': [row for row in read(supplement, 'calendar.txt') if row['service_id'] in services],
			'calendar_dates.txt': [row for row in read(supplement, 'calendar_dates.txt') if row['service_id'] in services],
			'shapes.txt': [row for row in read(supplement, 'shapes.txt') if row['shape_id'] in shapes],
		}
		for name in base.namelist():
			assert '/' not in name and name.endswith('.txt')
			rows = read(base, name)
			fields = next(csv.reader(io.StringIO(base.read(name).decode('utf-8-sig'))))
			for source in selected.get(name, []):
				row = dict(source)
				for key in ['route_id', 'trip_id', 'service_id', 'shape_id', 'block_id']:
					if row.get(key):
						row[key] = 'belford:' + row[key]
				if 'stop_id' in row:
					row['stop_id'] = stop_map.get(row['stop_id'], 'belford:' + row['stop_id'])
				if 'agency_id' in row:
					row['agency_id'] = '815'
				# The advisory takes effect Nov 2; Connexionz's shared calendar starts Nov 1.
				if name == 'calendar.txt':
					row['start_date'] = max(row['start_date'], '20261102')
				fields.extend(key for key in row if key not in fields)
				rows.append(row)
			write(name, rows, fields)
		# The composite retains Trillium's shorter validity window and publisher provenance.
		# Belford's separate source/version are documented in the accompanying source manifest.
		for obsolete in ['fare_attributes.txt', 'fare_rules.txt']:
			(ROOT / 'gtfs/waterway' / obsolete).unlink(missing_ok=True)


if __name__ == '__main__':
	main()
