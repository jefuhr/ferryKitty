"""Import the winter weekend Board with explicit, non-recurring optional workings.

The workbook notes remain literal source evidence. Exact GTFS matching is shared
with weekdays; optional dates never extend the operator's published service.
"""
import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('weekday_import', ROOT/'scripts/import-november-crew.py')
matcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(matcher)


def services_on(tables, day):
    key, name = day.strftime('%Y%m%d'), day.strftime('%A').lower()
    active = {r['service_id'] for r in tables['calendar']
              if r['start_date'] <= key <= r['end_date'] and r[name] == '1'}
    for row in tables['calendar_dates']:
        if row['date'] == key:
            if row['exception_type'] == '1': active.add(row['service_id'])
            else: active.discard(row['service_id'])
    return active


def build(source, feed):
    parser = matcher.module('import-boat-shifts.py')
    tables = feed['tables']
    policy = source['optionalPolicy']
    optional_cells = {p['sourceCell'] for p in policy.values()}
    regular = copy.deepcopy(source)
    regular['assignments'] = [dict(r, label=r['label'].replace('RWSDV', 'RWSV'))
                              for r in source['assignments'] if r['cell'] not in optional_cells]
    regular['shuttleCells'] = {}
    result = matcher.build(regular, feed, kind='weekend', service_ids={'2'})
    result['kind'] = 'weekend'
    result['startDate'] = max(source['startDate'], feed['startDate'])
    result['optionalWorkings'] = {}
    result['tripServiceOverrides'] = {}
    result['operationServiceByTrip'] = {}
    result['additionalCalendars'] = []
    result['additionalExceptions'] = []
    result['operationServiceIds'] = []
    calls = {name:r for name,r in ((r['trip_id'], r) for r in tables['trips'])}
    base_calendar = next(r for r in tables['calendar'] if r['service_id'] == '2')
    operation_id = 'crew-winter-weekend'
    result['additionalCalendars'].append(dict(base_calendar, service_id=operation_id,
        start_date=result['startDate'].replace('-', '')))
    result['additionalExceptions'].extend(dict(row, service_id=operation_id)
        for row in tables['calendar_dates'] if row['service_id'] == '2' and row['exception_type'] == '2')
    result['operationServiceIds'].append(operation_id)
    for trip_id in result['assignments']: result['operationServiceByTrip'][trip_id] = operation_id
    for record in result['shifts']: record['serviceIds'] = [operation_id]

    for key, config in policy.items():
        entry = next(r for r in source['assignments'] if r['cell'] == config['sourceCell'])
        optional = dict(config, source=copy.deepcopy(entry), verifiedDates=[], tripIds=[])
        result['optionalWorkings'][key] = optional
        if key != 'sbkCruise' and (not config['enabled'] or not config['dates']):
            optional['status'] = 'disabled'
            continue
        dates = sorted(set(config['dates'])) if config['enabled'] else []
        for date in dates:
            dt.date.fromisoformat(date)
        selected = copy.deepcopy(source)
        selected['shuttleCells'] = {}
        normalized = copy.deepcopy(entry)
        if key == 'sbkCruise':
            first = re.search(r'First\s+Shuttle\s+(\d{2})(\d{2})\s+RH\b', entry['note'], re.I)
            if not first: raise ValueError('Cruise first shuttle must identify a literal HHMM Red Hook departure')
            # The published cruise block is 33, with working numbers 3301 onward.
            # Its distinct block provides the numeric SB3 label; Board calls it Cruise Shuttle.
            normalized['label'] = 'SBK 3 CRUISE'
            normalized['note'] = re.sub(r'First\s+Shuttle\s+\d{4}\s+RH\b',
                f'First departure {first[1]}:{first[2]} at Red Hook', entry['note'], flags=re.I)
            service_ids = {t['service_id'] for t in tables['trips'] if t['route_id']=='SB' and t['block_id']=='33'}
            optional['numberSource'] = 'Published SB block 33 and 330x working numbers; Board crew boundaries remain separately checked'
        else:
            normalized['label'] = 'ERF 3 MID'
            service_ids = set().union(*(services_on(tables, dt.date.fromisoformat(date)) for date in dates))
        selected['assignments'] = [normalized]
        matched = matcher.build(selected, feed, kind='weekend', service_ids=service_ids)
        if key == 'sbkCruise':
            published = {t['trip_id']:t for t in tables['trips'] if t['route_id']=='SB' and t['block_id']=='33'}
            if not published or any(not re.fullmatch(r'33\d{2}', t['trip_short_name']) for t in published.values()):
                raise ValueError('Cruise working needs the distinct published 33 / 330x identity')
            if any(c['stop_id'] not in {'24','87'} for c in tables['stop_times'] if c['trip_id'] in published):
                raise ValueError('Cruise block no longer matches the published Red Hook / Pier 11 shuttle')
            for record in matched['shifts']:
                for field in ['start','end']:
                    event = record.get(field)
                    if event and event['tripId'] not in published:
                        matched['rejected'].append({'source':record['source'],'boat':record['boat'],
                            'field':field,'time':event['time'],'stopId':event['stopId'],
                            'reason':'exact event belongs to a different published block'})
                        del record[field]
            # Operator working numbers can identify passenger trips even when Board crew
            # boundary notes disagree. Those two operational boundaries remain rejected.
            matched['assignments'] = {id:3 for id in published}
            result['rejected'].extend(matched['rejected'])
        elif matched['rejected'] or not matched['assignments']:
            raise ValueError(f'{key}: optional working needs distinct, exact published boundary evidence')
        if set(matched['assignments']) & set(result['assignments']):
            raise ValueError(f'{key}: optional working would steal trips from an ordinary working')
        ids = sorted(matched['assignments'])
        verified = [date for date in dates if date >= result['startDate'] and date <= result['endDate']
                    and all(calls[id]['service_id'] in services_on(tables, dt.date.fromisoformat(date)) for id in ids)]
        scoped = 'optional-'+key.lower()
        result['additionalCalendars'].append({'service_id':scoped,
            **{day:'0' for day in ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']},
            'start_date':result['startDate'].replace('-', ''), 'end_date':result['endDate'].replace('-', '')})
        result['additionalExceptions'].extend({'service_id':scoped,'date':date.replace('-',''),'exception_type':'1'} for date in verified)
        result['operationServiceIds'].append(scoped)
        result['assignments'].update(matched['assignments'])
        for trip_id in ids:
            result['tripServiceOverrides'][trip_id] = scoped
            result['operationServiceByTrip'][trip_id] = scoped
        for record in matched['shifts']:
            record['shift'] = 'CRUISE' if key == 'sbkCruise' else 'MID'
            record['serviceIds'] = [scoped]
            result['shifts'].append(record)
        optional.update(status='date-scoped' if config['enabled'] else 'disabled', crewBoundaryStatus='unconfirmed' if matched['rejected'] else 'verified', verifiedDates=verified, tripIds=ids,
                        pendingDates=[date for date in dates if date not in verified])

    shuttles, relief = [], set()
    for row in [3,4,5]:
        label, clock = source['operationalCells'][f'J{row}'], source['operationalCells'][f'M{row}']
        boats = sorted({parser.ROUTES[m[1]]+m[2] for m in parser.LABEL.finditer(label) if m[2] and m[2].isdigit()})
        relief.update(boats)
        seconds = round(float(clock)*86400)
        shuttles.append({'time':f'{seconds//3600:02d}:{seconds%3600//60:02d}', 'boats':boats,
            'source':f'Board!J{row}:M{row}', 'kind':'crew-shuttle', 'timeReference':'board-listed'})
    result.update(reliefBoats=sorted(relief), crewShuttles=shuttles,
                  shuttleStatus='Board-listed crew relief times; endpoint timing unspecified')
    result['counts']['regularWorkings'] = result['counts']['workings']
    result['counts'].update(assignedTrips=len(result['assignments']), shifts=len(result['shifts']),
        workings=result['counts']['regularWorkings']+sum(p['status']=='date-scoped' for p in result['optionalWorkings'].values()),
        unconfirmedBoundaries=len(result['rejected']),
        exactBoundaries=sum('start' in r for r in result['shifts'])+sum('end' in r for r in result['shifts']),
        optionalWorkings=sum(p['status']=='date-scoped' for p in result['optionalWorkings'].values()))
    return result


if __name__ == '__main__':
    result = build(json.loads((ROOT/'schedules/winter-2026-weekend-board-source.json').read_text()),
                   json.loads((ROOT/'schedules/november-2026-live.json').read_text()))
    (ROOT/'schedules/winter-2026-weekend-crew.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result['counts']))
