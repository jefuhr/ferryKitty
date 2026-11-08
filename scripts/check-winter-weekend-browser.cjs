// Check real weekend boards, optional cruise dates and live identity at phone/desktop widths.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { serve, ARTIFACTS } = require('./mobile-check-harness.cjs');

(async () => {
	const { buildDisplayData } = await import('../lib/schedule-builder.js');
	const { activeServices } = await import('../public/assets/schedule.js');
	const { createConnectionIndex, tripConnections } = await import('../lib/connections.js');
	const boards = new Map(await Promise.all([16, 17, 27].map(async id =>
		[id, await buildDisplayData({ landingNumber: id })])));
	const index = createConnectionIndex(boards);
	let now, realtime;
	const site = await serve({ api: {
		'/api/display-data': url => boards.get(Number(url.searchParams.get('landingId')) || 16),
		'/api/landings': { landings: [], operators: [] },
		'/api/realtime': () => realtime,
		'/api/alerts': { available: true, alerts: [] },
		'/api/changelog': { entries: [] },
		'/api/connections': url => ({ ...tripConnections({ index, tripId: url.searchParams.get('tripId'), now,
			updates: new Map(realtime.updates.map(row => [`${row.tripId}|${row.stopId}`, row])),
			vehicles: new Map(realtime.vehicles.map(row => [row.tripId, row])) }), generatedAt: now.toISOString() })
	} });
	const browser = await chromium.launch({ headless: true });
	const results = [];
	await fs.mkdir(ARTIFACTS, { recursive: true });
	try {
		for (const width of [390, 1440]) for (const date of ['2026-11-07', '2026-11-08', '2026-11-14', '2026-11-28']) {
			now = new Date(`${date}T05:00:00Z`);
			const cruiseDay = date === '2026-11-07';
			const live = boards.get(16).departures.find(row => row.routeId === 'SB' && row.boatAssignment === (cruiseDay ? 3 : 1)
				&& activeServices(boards.get(16), date).has(row.serviceId));
			assert.ok(live, 'Expected an active published SB trip');
			realtime = { available: true, stale: false, fetchedAt: now.toISOString(),
				updates: [{ tripId: live.liveTripId, stopId: live.stopId, delaySeconds: 120 }],
				vehicles: [{ tripId: live.liveTripId, boatName: 'Weekend vessel', boat: `SB${live.boatAssignment}` }] };
			const name = `winter-weekend-${date}-${width}`;
			const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
			await context.tracing.start({ screenshots: true, snapshots: true });
			const page = await context.newPage(), errors = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.addInitScript(instant => {
				const Real = Date;
				globalThis.Date = class extends Real {
					constructor(...args) { super(...(args.length ? args : [instant])); }
					static now() { return +new Real(instant); }
				};
				localStorage.setItem('nyc-ferry-did-sort', 'time');
			}, now.toISOString());
			try {
				for (const landing of [16, 17, 27]) {
					await page.goto(`${site.origin}/ferryTimesMobile/?landing=${landing}`);
					await page.locator('#departures [data-trip-id]').first().waitFor();
					await page.waitForFunction(() => document.querySelector('#boardNote')?.textContent.includes('10 boundaries'));
					const labels = await page.locator('#departures .boat-assignment').allTextContents();
					if (landing !== 17) {
						assert.ok(labels.includes('ER1'), `${landing}: normal ER1 label missing`);
						assert.ok(labels.includes('ER2'), `${landing}: normal ER2 label missing`);
					}
					assert.ok(!labels.includes('ER3'), 'Disabled ER3 must not claim a published working');
					assert.equal(labels.includes('SB3'), cruiseDay && landing !== 27,
						'Cruise passenger trips need a verified date; unmatched crew returns stay absent');
					assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
					if (landing === 16) {
						const target = page.locator(`#departures [data-trip-id="${live.tripId}"]`).first();
						await page.waitForFunction(id => document.querySelector(`#departures [data-trip-id="${id}"]`)?.textContent.includes('Weekend vessel'), live.tripId);
						assert.match(await target.textContent(), /\+2 min/);
						await target.click();
						await page.locator('#tripMenu:not([hidden])').waitFor();
						await page.waitForFunction(() => !document.querySelector('#tripStops').textContent.includes('Checking…'));
						assert.doesNotMatch(await page.locator('#tripStops').textContent(), /could not be loaded|unavailable|too old/);
						assert.equal(await page.locator('#tripMapLabel').textContent(), 'See Weekend vessel on the map');
					}
					await page.screenshot({ path: path.join(ARTIFACTS, `${name}-landing-${landing}.png`), fullPage: true });
				}
				assert.deepEqual(errors, []);
				results.push({ date, width, landings: [16, 17, 27], cruiseDay, er3: 'disabled', liveTripId: live.liveTripId, delayMinutes: 2, connections: true });
			} finally {
				await context.tracing.stop({ path: path.join(ARTIFACTS, `${name}.zip`) });
				await context.close();
			}
		}
		await fs.writeFile(path.join(ARTIFACTS, 'winter-weekend-results.json'), JSON.stringify(results, null, 2) + '\n');
		console.log(JSON.stringify(results, null, 2));
	} finally {
		await browser.close();
		await site.close();
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
