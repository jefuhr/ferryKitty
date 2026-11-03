import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildDisplayData} from '../lib/schedule-builder.js';
import {activeServices, timelineDepartures, confirmedCrewCoverage} from '../public/assets/schedule.js';
const crew=JSON.parse(await readFile(new URL('../schedules/november-2026-crew.json',import.meta.url),'utf8'));
test('Board weekdays assign current trips without borrowing weekend crews',async()=>{
 const data=await buildDisplayData({landingNumber:16});
 for(const date of ['2026-11-02','2026-11-07']){
  const active=activeServices(data,date);
  const rows=data.departures.filter(r=>r.tripId.startsWith('nyc:november:')&&active.has(r.serviceId)&&!r.outOfService);
  assert.ok(rows.length);
  for(const row of rows) assert.equal(row.boatAssignment,crew.assignments[row.liveTripId]??null);
 }
});
test('only source-verified weekday shift returns appear after November 1',async()=>{
 const data=await buildDisplayData({landingNumber:8});
 const rows=timelineDepartures({data,realtime:{},viewDate:'2026-11-02',now:new Date('2026-11-02T05:00:00Z'),limitPerGroup:1000}).map(r=>r.departure);
 assert.ok(rows.some(r=>r.tripId.startsWith('november:crew:')&&r.outOfService));
 assert.ok(!rows.some(r=>r.tripId.startsWith('november:crew:')&&r.departureTime==='21:39:00'));
});

test('reviewed November weekday coverage leaves holidays and weekends unconfirmed',async()=>{
 const data=await buildDisplayData({landingNumber:27});
 assert.match(confirmedCrewCoverage(data,'2026-11-02').message,/6 boundaries/);
 for(const day of ['2026-11-07','2026-11-26','2026-11-27','2028-01-03'])assert.equal(confirmedCrewCoverage(data,day),null,day);
 const active=activeServices(data,'2026-11-02');
 const starts=data.departures.filter(r=>r.tripId.startsWith('november:crew:')&&r.fromHomePort&&active.has(r.serviceId));
 assert.ok(starts.length>20);
 for(const row of starts) for(const call of data.tripSchedules[row.tripId]?.stops||[])assert.ok(data.stops[call.stopId]?.name);
 assert.ok(!starts.some(r=>r.routeId==='RS'&&r.boatAssignment===5&&r.departureTime.startsWith('16:05')));
});

test('confirmed relief times are listed as crew shuttles without inventing pickup windows',async()=>{
 assert.deepEqual(crew.crewShuttles.map(s=>[s.time,s.boats]),[['12:45',['RS1','RS4']],['13:45',['RS3','RS6']]]);
 for(const landingNumber of [16,27]){
  const data=await buildDisplayData({landingNumber});
  const message=confirmedCrewCoverage(data,'2026-11-02').message;
  assert.match(message,/Crew shuttles: 12:45 \(RS1 \/ RS4\); 13:45 \(RS3 \/ RS6\)/);
  assert.ok(!data.departures.some(r=>r.tripId.startsWith('november:crew:')&&r.crewShuttle),'no fabricated endpoint timestamps');
 }
 assert.equal(crew.rejected.length,6);
});
