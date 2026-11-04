"""Summarize what changed between two November live maps, table by table.
The live map is stored minified, so a plain diff is unreadable; this prints counts
and the first few trip IDs added, removed or retimed so a reviewer knows where to look.
"""
import json
import sys


def keyed(rows, key):
    return {key(r): r for r in rows}


def main(before_path, after_path):
    before = json.load(open(before_path))
    after = json.load(open(after_path))
    print(f"Reviewed map GTFS {before['feedVersion']} -> draft GTFS {after['feedVersion']}")
    for name in sorted(set(before['tables']) | set(after['tables'])):
        old, new = before['tables'].get(name, []), after['tables'].get(name, [])
        print(f"  {name}: {len(old)} -> {len(new)} rows, "
              f"{len([r for r in new if r not in old])} new or changed, {len([r for r in old if r not in new])} gone or changed")
    old_trips = keyed(before['tables']['trips'], lambda r: r['trip_id'])
    new_trips = keyed(after['tables']['trips'], lambda r: r['trip_id'])
    def times(table):
        result = {}
        for r in table:
            result.setdefault(r['trip_id'], []).append((int(r['stop_sequence']), r['stop_id'], r['arrival_time'], r['departure_time']))
        return {k: sorted(v) for k, v in result.items()}
    old_times, new_times = times(before['tables']['stop_times']), times(after['tables']['stop_times'])
    added = sorted(set(new_trips) - set(old_trips))
    removed = sorted(set(old_trips) - set(new_trips))
    retimed = sorted(t for t in set(old_trips) & set(new_trips)
                     if old_times.get(t) != new_times.get(t) or old_trips[t] != new_trips[t])
    for label, ids in [('added', added), ('removed', removed), ('changed', retimed)]:
        sample = ', '.join(ids[:10]) + (' ...' if len(ids) > 10 else '')
        print(f"  trips {label}: {len(ids)}" + (f" ({sample})" if ids else ''))


if __name__ == '__main__':
    main(*sys.argv[1:3])
