import copy
import importlib.util
import json
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('weekend_import',ROOT/'scripts/import-winter-weekend-crew.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class WinterWeekendImport(unittest.TestCase):
    def setUp(self):
        self.source=json.loads((ROOT/'schedules/winter-2026-weekend-board-source.json').read_text())
        self.feed=json.loads((ROOT/'schedules/november-2026-live.json').read_text())

    def test_reproducible_weekend_source_preserves_conflicts(self):
        data=module.build(self.source,self.feed)
        self.assertEqual(data,json.loads((ROOT/'schedules/winter-2026-weekend-crew.json').read_text()))
        self.assertEqual(data['counts']['regularWorkings'],13)
        self.assertEqual(data['counts']['assignedTrips'],151)
        self.assertEqual(data['counts']['exactBoundaries'],44)
        self.assertEqual(len(data['rejected']),10)
        self.assertEqual(data['optionalWorkings']['sbkCruise']['verifiedDates'],['2026-11-07'])
        self.assertEqual(data['optionalWorkings']['sbkCruise']['pendingDates'],['2026-11-28','2026-12-19'])

    def test_even_recurring_upstream_cruise_service_requires_approved_dates(self):
        for row in self.feed['tables']['calendar']:
            if row['service_id']=='3':row['end_date']='20271231'
        data=module.build(self.source,self.feed)
        dates=[r['date'] for r in data['additionalExceptions'] if r['service_id']=='optional-sbkcruise']
        self.assertEqual(dates,['20261107','20261128','20261219'])
        self.assertNotIn('20261108',dates)
        calendar=next(r for r in data['additionalCalendars'] if r['service_id']=='optional-sbkcruise')
        self.assertEqual(calendar['saturday'],'0')
        self.assertEqual(calendar['sunday'],'0')

    def test_disabled_cruise_is_still_scoped_out_of_the_base_calendar(self):
        self.source['optionalPolicy']['sbkCruise']['enabled']=False
        data=module.build(self.source,self.feed)
        self.assertEqual(len(data['tripServiceOverrides']),23)
        self.assertFalse(any(r['service_id']=='optional-sbkcruise' for r in data['additionalExceptions']))

    def test_copied_er3_note_cannot_steal_er2_trips(self):
        self.source['optionalPolicy']['er3Mid'].update(enabled=True,dates=['2026-11-08'])
        with self.assertRaisesRegex(ValueError,'steal trips from an ordinary working'):
            module.build(self.source,self.feed)

    def test_distinct_er3_can_be_activated_on_an_explicit_date(self):
        policy=self.source['optionalPolicy']['er3Mid']
        policy.update(enabled=True,dates=['2026-11-08'])
        note=next(r for r in self.source['assignments'] if r['cell']=='C18')
        note['note']='ERF 3 MID\nFirst departure 02:01 at Pier 11\nLast drop 02:31 at 34th'
        trip=copy.deepcopy(next(t for t in self.feed['tables']['trips'] if t['route_id']=='ER' and t['service_id']=='2'))
        trip.update(trip_id='fixture-er3-extra',block_id='fixture-separate-working',trip_short_name='fixture-extra',service_id='fixture-date-only')
        self.feed['tables']['trips'].append(trip)
        calendar=copy.deepcopy(next(r for r in self.feed['tables']['calendar'] if r['service_id']=='2'))
        calendar.update(service_id='fixture-date-only',saturday='0',sunday='0')
        self.feed['tables']['calendar'].append(calendar)
        self.feed['tables']['calendar_dates'].append({'service_id':'fixture-date-only','date':'20261108','exception_type':'1'})
        for sequence,stop,time in [(1,'87','02:01:00'),(2,'17','02:31:00')]:
            self.feed['tables']['stop_times'].append({'trip_id':trip['trip_id'],'stop_id':stop,'stop_sequence':str(sequence),
                'arrival_time':time,'departure_time':time,'pickup_type':'0','drop_off_type':'0'})
        data=module.build(self.source,self.feed)
        self.assertEqual(data['assignments']['fixture-er3-extra'],3)
        self.assertEqual(data['optionalWorkings']['er3Mid']['displayLabel'],'ER3')
        self.assertEqual(data['optionalWorkings']['er3Mid']['verifiedDates'],['2026-11-08'])
        self.assertEqual(data['tripServiceOverrides']['fixture-er3-extra'],'optional-er3mid')

    def test_optional_matching_supports_exception_only_published_services(self):
        for row in self.feed['tables']['calendar']:
            if row['service_id']=='3':
                row.update(saturday='0',sunday='0')
        self.feed['tables']['calendar_dates'].append({'service_id':'3','date':'20261107','exception_type':'1'})
        data=module.build(self.source,self.feed)
        self.assertEqual(data['optionalWorkings']['sbkCruise']['verifiedDates'],['2026-11-07'])
        self.assertEqual(len(data['rejected']),10)

    def test_cruise_boundaries_cannot_use_a_different_block_on_the_same_calendar(self):
        trip=copy.deepcopy(next(t for t in self.feed['tables']['trips'] if t['route_id']=='SB'))
        trip.update(trip_id='fixture-decoy',block_id='not-cruise',service_id='3')
        self.feed['tables']['trips'].append(trip)
        for sequence,stop,time in [(1,'24','07:22:00'),(2,'87','12:32:00')]:
            self.feed['tables']['stop_times'].append({'trip_id':trip['trip_id'],'stop_id':stop,'stop_sequence':str(sequence),
                'arrival_time':time,'departure_time':time,'pickup_type':'0','drop_off_type':'0'})
        data=module.build(self.source,self.feed)
        self.assertNotIn('fixture-decoy',data['assignments'])
        record=next(r for r in data['shifts'] if r['source']=='Board!I18')
        self.assertNotIn('start',record)
        self.assertNotIn('end',record)
        self.assertEqual(len(data['rejected']),10)

    def test_weekend_crew_calendar_does_not_claim_holiday_weekdays(self):
        data=module.build(self.source,self.feed)
        self.assertFalse(any(r['service_id']=='crew-winter-weekend' and r['exception_type']=='1' for r in data['additionalExceptions']))

if __name__=='__main__':unittest.main()
