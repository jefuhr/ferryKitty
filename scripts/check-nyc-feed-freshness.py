#!/usr/bin/env python3
"""Fail when NYC Ferry's published GTFS has changed since the live maps were reviewed.

Also fails when no reviewed map covers today, so the check cannot go green just
because every season it knows about has ended. With --archive-dir, the fetched
ZIP is saved as nycferry-<feed_version>.zip so a refresh can start from the
exact bytes this run compared.
"""
import argparse
import csv
import datetime as dt
import hashlib
import io
import json
from pathlib import Path
import sys
import urllib.request
import zipfile
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
URL = 'https://nycferry.connexionz.net/rtt/public/resource/gtfs.zip'
MAPS = ('schedules/sukkot-2026-live.json',
        'schedules/sukkot-2026-crew.json',
        'schedules/fall-2026-post-sukkot-live.json')


def coverage(reviewed):
    if reviewed.get('dates'):
        return min(reviewed['dates']), max(reviewed['dates'])
    return reviewed.get('startDate'), reviewed.get('endDate')


def stale_mappings(version, date, root=ROOT):
    stale = []
    for name in MAPS:
        reviewed = json.loads((root / name).read_text())
        end = coverage(reviewed)[1]
        # A finished holiday remains tied to its historical archive, not today's new feed.
        if end and end < date:
            continue
        if reviewed['feedVersion'] != version:
            stale.append(f"{name}: reviewed {reviewed['feedVersion']}")
    return stale


def covering_mappings(date, root=ROOT):
    covering = []
    for name in MAPS:
        start, end = coverage(json.loads((root / name).read_text()))
        if (not start or start <= date) and (not end or date <= end):
            covering.append(name)
    return covering


def describe(version, content, archive, date, root=ROOT):
    info = next(csv.DictReader(io.StringIO(archive.read('feed_info.txt').decode('utf-8-sig'))))
    print(f'Published feed: {URL}')
    print(f'  feed_version {version}, {len(content)} bytes, SHA-256 {hashlib.sha256(content).hexdigest()}')
    print(f"  feed_start_date {info.get('feed_start_date') or '?'}, feed_end_date {info.get('feed_end_date') or '?'}")
    print(f'Reviewed maps as of {date} (America/New_York):')
    for name in MAPS:
        reviewed = json.loads((root / name).read_text())
        start, end = coverage(reviewed)
        state = 'finished, archive-pinned' if end and end < date else 'current'
        print(f"  {name}: reviewed {reviewed['feedVersion']}, covers {start} to {end} ({state})")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--archive-dir', type=Path,
                        help='save the fetched ZIP here as nycferry-<feed_version>.zip')
    args = parser.parse_args(argv)
    # Keep the diagnostics above the stderr verdict in CI logs.
    sys.stdout.reconfigure(line_buffering=True)

    request = urllib.request.Request(URL, headers={'User-Agent': 'Ferry-Kitty/1.0'})
    with urllib.request.urlopen(request, timeout=20) as response:
        content = response.read(10 * 1024 * 1024 + 1)
    if len(content) > 10 * 1024 * 1024:
        raise ValueError('GTFS ZIP exceeded 10 MB')
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        version = next(csv.DictReader(io.StringIO(
            archive.read('feed_info.txt').decode('utf-8-sig'))))['feed_version']
        date = dt.datetime.now(ZoneInfo('America/New_York')).date().isoformat()
        describe(version, content, archive, date)

    if args.archive_dir:
        args.archive_dir.mkdir(parents=True, exist_ok=True)
        saved = args.archive_dir / f'nycferry-{version}.zip'
        saved.write_bytes(content)
        print(f'Saved fetched feed to {saved}')

    failed = False
    stale = stale_mappings(version, date)
    if stale:
        print(f'NYC Ferry GTFS is now {version}; review and regenerate live trip maps:', file=sys.stderr)
        for item in stale:
            print(f'  {item}', file=sys.stderr)
        print('Archive the new ZIP, then regenerate the affected live and crew mappings.', file=sys.stderr)
        failed = True
    if not covering_mappings(date):
        print(f'No reviewed live map covers {date}; every known season has ended. '
              'Add a mapping for the current service before trusting this check.', file=sys.stderr)
        failed = True
    if failed:
        return 1
    print(f'NYC Ferry GTFS {version} matches all current trip and crew maps.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
