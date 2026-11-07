import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildDisplayData} from '../lib/schedule-builder.js';
import {activeServices, confirmedCrewCoverage} from '../public/assets/schedule.js';
const activeRows=(data,date)=>{const active=activeServices(data,date);return data.departures.filter(r=>active.has(r.serviceId));};
test('winter weekend Board assigns normal workings without enabling ER3 Mid',async()=>{
 const data=await buildDisplayData({landingNumber:16});
 for(const date of ['2026-11-07','2026-11-08','2026-11-14']){
  const rows=activeRows(data,date).filter(r=>r.tripId.startsWith('nyc:november:')&&r.operator==='NYC Ferry');
  assert.ok(rows.length>50);
  assert.ok(rows.filter(r=>r.routeId==='ER').every(r=>[1,2].includes(r.boatAssignment)));
  assert.ok(!rows.some(r=>r.routeId==='ER'&&r.boatAssignment===3));
  assert.ok(confirmedCrewCoverage(data,date));
 }
});
test('cruise shuttle is date-scoped on passenger and Pier C boards',async()=>{
 for(const landingNumber of [16,17,27]){
  const data=await buildDisplayData({landingNumber});
  const cruise=date=>activeRows(data,date).filter(r=>r.routeId==='SB'&&r.boatAssignment===3);
  if(landingNumber===27) assert.equal(cruise('2026-11-07').length,0,'unverified cruise crew boundaries must not create Pier C movements');
  else assert.ok(cruise('2026-11-07').length>0,`cruise working at landing ${landingNumber}`);
  for(const date of ['2026-11-08','2026-11-14','2026-11-21','2026-11-28','2026-12-19'])assert.equal(cruise(date).length,0,date);
 }
});
test('weekend review preserves weekday mismatches and leaves ER3 explicitly disabled',async()=>{
 const weekday=JSON.parse(await readFile(new URL('../schedules/november-2026-crew.json',import.meta.url),'utf8'));
 assert.equal(weekday.rejected.length,6);
 const weekend=JSON.parse(await readFile(new URL('../schedules/winter-2026-weekend-crew.json',import.meta.url),'utf8'));
 assert.equal(weekend.optionalWorkings.er3Mid.enabled,false);
 assert.equal(weekend.optionalWorkings.er3Mid.displayLabel,'ER3');
 assert.deepEqual(weekend.optionalWorkings.er3Mid.dates,[]);
 const data=await buildDisplayData({landingNumber:27});
 const weekendIds=new Set(weekend.operationServiceIds.map(id=>'nyc:november:'+id));
 assert.ok(!activeRows(data,'2026-11-09').some(r=>weekendIds.has(r.serviceId)));
});
