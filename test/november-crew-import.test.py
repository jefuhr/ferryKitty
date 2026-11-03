import copy
import importlib.util
import json
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('november_import',ROOT/'scripts/import-november-crew.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class NovemberCrewImport(unittest.TestCase):
    def setUp(self):
        self.source=json.loads((ROOT/'schedules/november-2026-board-source.json').read_text())
        self.feed=json.loads((ROOT/'schedules/november-2026-live.json').read_text())

    def test_only_exact_boundaries_and_weekday_assignments_are_accepted(self):
        data=module.build(self.source,self.feed)
        self.assertEqual(data['counts'],{'shifts':42,'exactBoundaries':78,'unconfirmedBoundaries':6,'assignedTrips':259,'workings':21})
        self.assertEqual(len(data['rejected']),6)
        self.assertTrue(all(t['service_id']=='1' for t in self.feed['tables']['trips'] if t['trip_id'] in data['assignments']))
        self.assertTrue(any(r['boat']=='ER3' and r['field']=='end' and r['time']=='21:39' for r in data['rejected']))

    def test_conflicting_block_evidence_stops_import(self):
        note=next(r for r in self.source['assignments'] if r['cell']=='A26')
        note['note']=note['note'].replace('15:45','14:40')
        with self.assertRaisesRegex(ValueError,'conflicting GTFS blocks'):
            module.build(self.source,self.feed)

    def test_no_nearest_time_substitution_for_mismatched_note(self):
        note=next(r for r in self.source['assignments'] if r['cell']=='A26')
        note['note']=note['note'].replace('15:45','15:46')
        data=module.build(self.source,self.feed)
        record=next(r for r in data['shifts'] if r['source']=='Board!A26')
        self.assertNotIn('start',record)
        self.assertIn('end',record)

    def test_user_confirmation_preserves_the_two_listed_shuttle_times(self):
        data=module.build(self.source,self.feed)
        self.assertEqual([(s['time'],s['boats']) for s in data['crewShuttles']],
                         [('12:45',['RS1','RS4']),('13:45',['RS3','RS6'])])
        self.assertEqual(len(data['rejected']),6)

    def test_generated_file_is_reproducible(self):
        self.assertEqual(module.build(self.source,self.feed),json.loads((ROOT/'schedules/november-2026-crew.json').read_text()))

if __name__=='__main__': unittest.main()
