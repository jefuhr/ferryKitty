import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { buildDisplayData } from '../lib/schedule-builder.js';
import { timelineDepartures } from '../public/assets/schedule.js';
import { normalizeTripUpdates, boatByTrip } from '../lib/realtime.js';
import { createConnectionIndex, tripConnections } from '../lib/connections.js';
import { buildServiceTripIndex, describeBoats } from '../lib/fleet-map.js';

const mapping = JSON.parse(await readFile(new URL('../schedules/fall-2026-post-sukkot-live.json', import.meta.url)));
const pier11 = await buildDisplayData({ landingNumber: 16 });
const now = new Date('2026-10-03T13:00:00Z');

test('October feed identities replace reused September IDs', () => {
  assert.equal(mapping.feedVersion, '20261007');
  assert.equal(mapping.matches['36'], '1698');
  const row = pier11.departures.find(row => row.tripId === '36');
  assert.equal(row.liveTripId, '1698');
  const realtime = { stale: false, updates: [
    {tripId: '1696', stopId: row.stopId, delaySeconds: 900},
    {tripId: '1698', stopId: row.stopId, delaySeconds: 120}
  ], vehicles: [{tripId:'1696',boatName:'Wrong boat'}, {tripId:'1698',boatName:'Correct boat'}] };
  const visible = timelineDepartures({data:pier11,realtime,now,limitPerGroup:1000})
    .find(item => item.departure.tripId === '36').departure;
  assert.equal(visible.delay, 120);
  assert.equal(visible.boatName, 'Correct boat');
});

test('cruise-day mappings are unique per date and do not guess later unpublished IDs', () => {
  assert.equal(mapping.datedMatches['820']['2026-10-03'], undefined);
  assert.equal(mapping.datedMatches['820']['2026-10-10'], '2065');
  assert.equal(mapping.datedMatches['820']['2026-10-17'], '2092');
  assert.equal(mapping.datedMatches['820']['2026-10-24'], '2113');
  assert.ok(mapping.unmatchedDates['820'].includes('2026-10-31'));
  assert.equal(mapping.counts.ambiguous, 0);
});

test('cruise departures and boat assignments follow the live ID for their service date', () => {
  const row = pier11.departures.find(row => row.tripId === '820');
  assert.ok(row, 'SB3 has a Pier 11 departure');
  for (const [date,id] of [['2026-10-10','2065'],['2026-10-11','2065'],['2026-10-17','2092'],['2026-10-24','2113']]) {
    const realtime = {stale:false,updates:[{tripId:id,stopId:row.stopId,delaySeconds:180}],vehicles:[{tripId:id,boatName:'Cruise boat'}]};
    const dateNow = new Date(`${date}T04:00:00Z`);
    const visible = timelineDepartures({data:pier11,realtime,now:dateNow,limitPerGroup:1000})
      .find(item=>item.departure.tripId==='820').departure;
    assert.equal(visible.liveTripId,id);
    assert.equal(visible.delay,180);
    assert.equal(visible.boatName,'Cruise boat');
    assert.equal(boatByTrip(pier11.departures,{asOfMs:+dateNow}).get(id),'SB3');
  }
  const later = timelineDepartures({data:pier11,realtime:{stale:false,updates:[{tripId:'820',stopId:row.stopId,delaySeconds:900}]},
    now:new Date('2026-10-31T04:00:00Z'),limitPerGroup:1000}).find(item=>item.departure.tripId==='820').departure;
  assert.equal(later.hasLiveTiming,false);
});

test('trip schedules and turnarounds retain ordinary feed aliases for terminal arrival and next-trip timing', () => {
  const schedule = pier11.tripSchedules['36'];
  assert.equal(schedule.liveTripId,'1698');
  assert.equal(schedule.turnaround.nextLiveTripId,mapping.matches[schedule.turnaround.nextTripId]);
  const terminal = schedule.stops.at(-1);
  const normalized = normalizeTripUpdates({entity:[{tripUpdate:{trip:{tripId:'1698'},stopTimeUpdate:[{
    stopId:terminal.stopId,arrival:{delay:120}
  }]}}]},[terminal.stopId],{departures:pier11.departures,tripSchedules:pier11.tripSchedules,asOfMs:+now});
  assert.equal(normalized.find(row=>row.tripId==='1698' && row.stopId===terminal.stopId)?.delaySeconds,120);
  const index = createConnectionIndex(new Map([[16,pier11]]));
  const connections = tripConnections({index,tripId:'36',now,updates:new Map(normalized.map(row=>[`${row.tripId}|${row.stopId}`,row]))});
  assert.equal(connections.stops.at(-1).turnaround.hasLiveTiming,true);
  assert.equal(connections.stops.at(-1).estimatedArrivalSeconds,terminal.arrivalSeconds+120);
});

test('Pier C prediction trips use the current feed IDs', async () => {
  const home = await buildDisplayData({landingNumber:27});
  const current = timelineDepartures({data:home,realtime:{},now:new Date('2026-10-03T04:00:00Z'),limitPerGroup:1000});
  const firstER1 = current.find(item=>item.departure.routeId==='ER' && item.departure.boatAssignment===1);
  assert.ok(firstER1?.departure.predictTripId);
  assert.ok(Object.values(mapping.matches).includes(firstER1.departure.predictTripId));
});

test('cruise trip details and map resolve the same dated identity as the board', () => {
  const dateNow = new Date('2026-10-10T13:00:00Z');
  const terminal = pier11.tripSchedules['820'].stops.at(-1);
  const index = createConnectionIndex(new Map([[16,pier11]]));
  const response = tripConnections({index,tripId:'820',now:dateNow,updates:new Map([
    [`2009|${terminal.stopId}`,{delaySeconds:900}],
    [`2065|${terminal.stopId}`,{delaySeconds:180}]
  ])});
  assert.equal(response.stops.at(-1).afterSeconds,terminal.arrivalSeconds+180);
  const serviceTrips = buildServiceTripIndex({byLanding:new Map([[16,pier11]])});
  const describe = id => describeBoats([{id:'boat',tripId:id,latitude:40.7,longitude:-74,stopSequence:terminal.sequence}],
    {serviceTrips,asOf:+dateNow,routes:new Map([['SB',{id:'SB',shortName:'SB'}]])})[0];
  assert.equal(describe('2065').destination,pier11.stops[terminal.stopId].name);
  assert.equal(describe('2009').destination,null,'an expired cruise identity cannot describe another Saturday');
});

test('feed freshness checks current service without requiring archived Sukkot IDs to change', () => {
  const result = JSON.parse(execFileSync('python3',['-c',`
import json,runpy
m=runpy.run_path('scripts/check-nyc-feed-freshness.py')
print(json.dumps([m['stale_mappings']('20261007','2026-10-10'),m['stale_mappings']('20261004','2026-10-10')]))
`],{cwd:new URL('../',import.meta.url),encoding:'utf8'}));
  assert.deepEqual(result[0],[]);
  assert.equal(result[1].length,1);
  assert.match(result[1][0],/fall-2026-post-sukkot-live/);
});

test('feed freshness fails once no reviewed map covers today instead of going quietly green', () => {
  const result = JSON.parse(execFileSync('python3',['-c',`
import json,runpy
m=runpy.run_path('scripts/check-nyc-feed-freshness.py')
print(json.dumps([m['covering_mappings']('2026-10-26'),m['covering_mappings']('2026-11-02'),m['stale_mappings']('20261025','2026-11-02')]))
`],{cwd:new URL('../',import.meta.url),encoding:'utf8'}));
  assert.deepEqual(result[0],['schedules/fall-2026-post-sukkot-live.json']);
  assert.deepEqual(result[1],[],'nothing reviewed covers November 2');
  assert.deepEqual(result[2],[],'stale_mappings alone would report no problem');
});
