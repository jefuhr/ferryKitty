import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildDisplayData } from '../lib/schedule-builder.js';
import { timelineDepartures } from '../public/assets/schedule.js';
import { activeServices, createConnectionIndex } from '../lib/connections.js';
test('November operator trips restore NYC Ferry service without inheriting fall crew labels', async () => {
 const data = await buildDisplayData({ landingNumber: 16 });
 const crew = JSON.parse(await readFile(new URL('../schedules/november-2026-crew.json', import.meta.url), 'utf8'));
 const active = activeServices(createConnectionIndex(new Map([[16, data]])), '2026-11-02');
 const rows = data.departures.filter(r => r.tripId.startsWith('nyc:november:') && r.operator === 'NYC Ferry' && active.has(r.serviceId));
 assert.ok(rows.length > 100, 'NYC Ferry must have active weekday departures after the fall season ends');
 assert.equal(data.meta.feedVersion, '20261102');
 for (const row of rows) {
  assert.equal(row.boatAssignment, crew.assignments[row.liveTripId] ?? null);
  assert.equal(row.outOfService, false);
  assert.match(row.liveTripId, /^\d+$/);
  assert.ok(data.tripSchedules[row.tripId]?.stops.length > 1);
 }
 const historical = activeServices(createConnectionIndex(new Map([[16, data]])), '2026-11-01');
 assert.ok(rows.every(r => !historical.has(r.serviceId)));
 const first = rows[0];
 const now = new Date('2026-11-02T05:00:00Z');
 const visible = timelineDepartures({data,now,realtime:{stale:false,updates:[{tripId:first.liveTripId,stopId:first.stopId,delaySeconds:120}]},limitPerGroup:1000});
 assert.equal(visible.find(r => r.departure.tripId === first.tripId)?.departure.delay, 120);
});
test('Belford November changes apply on Monday without changing the previous timetable', async () => {
 const data = await buildDisplayData({ landingNumber: 26 });
 const index = createConnectionIndex(new Map([[26, data]]));
 const at = date => data.departures.filter(r => r.routeId === 'wbf:belford' && activeServices(index,date).has(r.serviceId) && !r.arrival);
 assert.ok(at('2026-11-02').some(r => r.departureTime === '18:15:00'));
 assert.equal(at('2026-10-26').some(r => r.departureTime === '18:15:00'), false);
});
