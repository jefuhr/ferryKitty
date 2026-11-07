"""Match the user-selected Board notes to exact November weekday GTFS events.
No nearest-time matching, guessed stop, or archived working-number assignment.
The source JSON contains operational notes only, excluding personnel names.
"""
import collections
import importlib.util
import json
from pathlib import Path
import re
ROOT = Path(__file__).resolve().parents[1]

def module(filename):
    spec = importlib.util.spec_from_file_location('shift_parser', ROOT / 'scripts' / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def build(source, feed, kind="weekday", service_ids=None):
    if source['sheet'] != 'Board':
        raise ValueError('Only the user-selected Board sheet is authorized')
    parser = module('import-boat-shifts.py')
    tables = feed['tables']
    services = ({r['service_id'] for r in tables['calendar'] if r['monday']=='1' and r['saturday']==r['sunday']=='0'}
                if kind == 'weekday' else {r['service_id'] for r in tables['calendar'] if r['saturday']=='1' or r['sunday']=='1'})
    if service_ids is not None:
        # Explicit optional services may be exception-only, with no recurring flags.
        services = set(service_ids)
    trips = {r['trip_id']:r for r in tables['trips'] if r['service_id'] in services}
    sequences = collections.defaultdict(list)
    for call in tables['stop_times']:
        sequences[call['trip_id']].append(int(call['stop_sequence']))
    places = {'Hunters Point South':'4','Wall St/Pier 11':'87','East 34th Street':'17',
              'Midtown West/W 39th St-Pier 79':'138','East 90th St':'113','Red Hook/Atlantic Basin':'24',
              'Gov. Island/Yankee Pier':'65','Rockaway':'88','Ferry Point Park':'141','St. George':'137'}
    records, rejected = [], []
    blocks = collections.defaultdict(set)
    for entry in source['assignments']:
        label = parser.LABEL.search(entry['label'])
        if not label or not label[2] or not label[2].isdigit():
            raise ValueError('Unrecognized operational label: '+entry['cell'])
        route, number = parser.ROUTES[label[1]], int(label[2])
        boat = route + str(number)
        record = {'boat':boat,'routeId':route,'number':number,'shift':'MID' if 'MID' in entry['label'].upper() else 'AM' if 'AM' in entry['label'] else 'PM',
                  'source':source['sheet']+'!'+entry['cell']}
        for kind, regex, field in [('start',parser.FIRST,'departure_time'),('end',parser.LAST,'arrival_time')]:
            match = regex.search(entry['note'])
            if not match:
                rejected.append({'source':record['source'],'boat':boat,'field':kind,'reason':'unparsed boundary'})
                continue
            clock, place = match.groups()
            place = re.sub(r'\bP\s+79\b','P79',place)
            stop = places.get(parser.place(place))
            matches = [r for r in tables['stop_times'] if r['trip_id'] in trips
                       and trips[r['trip_id']]['route_id']==route and r['stop_id']==stop and r[field]==clock.zfill(5)+':00'
                       and (kind!='start' or (r.get('pickup_type')!='1' and int(r['stop_sequence'])<max(sequences[r['trip_id']])))
                       and (kind!='end' or int(r['stop_sequence'])>min(sequences[r['trip_id']]))]
            if len(matches)!=1:
                rejected.append({'source':record['source'],'boat':boat,'field':kind,'time':clock,'stopId':stop,
                                 'reason':f'expected one exact event, found {len(matches)}'})
                continue
            call = matches[0]
            block = trips[call['trip_id']]['block_id']
            blocks[boat].add(block)
            record[kind] = {'time':clock.zfill(5),'stopId':stop,'tripId':call['trip_id'],'blockId':block}
        records.append(record)
    if any(len(value)!=1 for value in blocks.values()):
        raise ValueError('Board working maps to conflicting GTFS blocks')
    reverse = {}
    for boat, values in blocks.items():
        route = re.sub(r'\d+$','',boat)
        key = route,next(iter(values))
        if key in reverse:
            raise ValueError('Two Board workings map to the same block')
        reverse[key] = int(re.search(r'\d+$',boat)[0])
    assignments = {id:reverse[t['route_id'],t['block_id']] for id,t in trips.items() if (t['route_id'],t['block_id']) in reverse}
    relief = sorted({parser.ROUTES[m[1]]+m[2] for cell in ['N3','N4']
                     for m in parser.LABEL.finditer(source['shuttleCells'].get(cell) or '') if m[2] and m[2].isdigit()})
    shuttles = []
    if source.get('reliefTimingInterpretation',{}).get('kind') == 'crew-shuttle':
        for row in [3,4]:
            boats = sorted({parser.ROUTES[m[1]]+m[2] for m in parser.LABEL.finditer(source['shuttleCells'][f'N{row}']) if m[2] and m[2].isdigit()})
            when = round(float(source['shuttleCells'][f'Q{row}'])*86400)
            shuttles.append({'time':f'{when//3600:02d}:{when%3600//60:02d}', 'boats':boats,
                             'source':f"Board!N{row}:Q{row}", 'kind':'crew-shuttle', 'timeReference':'board-listed'})
    return {'sheet':source['sheet'],'workbookSha256':source['workbookSha256'],'feedVersion':feed['feedVersion'],
            'sourceSha256':feed['sourceSha256'],'startDate':feed['startDate'],'endDate':feed['endDate'],
            'serviceIds':sorted(services),'assignments':assignments,'shifts':records,'rejected':rejected,
            'reliefBoats':relief,'crewShuttles':shuttles,'shuttleStatus':'user-confirmed crew shuttles; time reference unspecified',
            'counts':{'shifts':len(records),'exactBoundaries':sum('start' in r for r in records)+sum('end' in r for r in records),
                      'unconfirmedBoundaries':len(rejected),'assignedTrips':len(assignments),'workings':len(reverse)}}

if __name__ == '__main__':
    result = build(json.loads((ROOT/'schedules/november-2026-board-source.json').read_text()),
                   json.loads((ROOT/'schedules/november-2026-live.json').read_text()))
    (ROOT/'schedules/november-2026-crew.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result['counts']))
