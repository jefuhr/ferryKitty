import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCsv, buildDisplayData } from '../scripts/build-data.js';
const rows = async (file) => parseCsv(await readFile(new URL(`../gtfs/${file}`, import.meta.url), 'utf8'));
test('November 2 feeds contain the announced Belford weekday changes', async () => {
 const trips = (await rows('waterway/trips.txt')).filter(t => t.route_id === 'belford:60');
 const times = await rows('waterway/stop_times.txt');
 const calendars = await rows('waterway/calendar.txt');
 const active = (day) => trips.filter(t => calendars.some(c => c.service_id === t.service_id && c[day] === '1'));
 const at = (trip, stop, time) => times.some(s => s.trip_id === trip.trip_id && s.stop_id === stop && s.departure_time === time);
 assert.ok(active('monday').some(t => at(t, 'belford:2', '05:15:00')));
 assert.ok(!active('friday').some(t => at(t, 'belford:2', '05:15:00')));
 for (const day of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']) {
  assert.ok(active(day).some(t => at(t, 'belford:2', '06:20:00') && at(t, '2439146', '07:00:00') && at(t, '2729332', '07:10:00') && at(t, '2439141', '07:15:00')));
  assert.ok(!active(day).some(t => at(t, 'belford:2', '06:30:00')));
  assert.ok(active(day).some(t => at(t, '2439145', '18:15:00') && at(t, 'belford:2', '19:45:00')));
 }
 assert.equal((await rows('feed_info.txt'))[0].feed_version, '20261102');
});
test('Belford departures reach all three configured Manhattan boards', async () => {
 for (const landingNumber of [16, 25, 26]) {
  const data = await buildDisplayData({ landingNumber, waterwayEnabled: true, busesEnabled: false });
  assert.ok(data.departures.some(d => d.routeId === 'wtr:belford:60'));
 }
});
test('current feed builds every landing and keeps Yankee Pier available for partner service', async () => {
 const landings = JSON.parse(await readFile(new URL('../config/landings.json', import.meta.url), 'utf8'));
 for (const [number, config] of Object.entries(landings)) {
  if (config.unused) continue;
  const data = await buildDisplayData({ landingNumber: Number(number) });
  assert.ok(Number.isFinite(data.meta.landing.latitude));
  if (number === '11') {
   assert.equal(data.departures.some(d => !d.routeId.includes(':')), false);
   assert.ok(data.departures.some(d => d.routeId.startsWith('gi:')));
  }
 }
});
test('refreshed feeds have unique trip IDs and valid route, service and stop references', async () => {
 for (const prefix of ['', 'waterway/']) {
  const trips = await rows(`${prefix}trips.txt`);
  const times = await rows(`${prefix}stop_times.txt`);
  const routeIds = new Set((await rows(`${prefix}routes.txt`)).map(r => r.route_id));
  const stopIds = new Set((await rows(`${prefix}stops.txt`)).map(r => r.stop_id));
  const services = new Set([
   ...await rows(`${prefix}calendar.txt`), ...await rows(`${prefix}calendar_dates.txt`)
  ].map(r => r.service_id));
  const tripIds = new Set(trips.map(t => t.trip_id));
  assert.equal(tripIds.size, trips.length);
  for (const trip of trips) {
   assert.ok(routeIds.has(trip.route_id));
   assert.ok(services.has(trip.service_id));
  }
  for (const time of times) {
   assert.ok(tripIds.has(time.trip_id));
   assert.ok(stopIds.has(time.stop_id));
  }
 }
});
