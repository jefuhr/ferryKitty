// Reproduce the October feed rollover with real browser rendering and deterministic live data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { serve, ARTIFACTS } = require('./mobile-check-harness.cjs');

(async () => {
  const { buildDisplayData } = await import('../lib/schedule-builder.js');
  const { createConnectionIndex, tripConnections } = await import('../lib/connections.js');
  const boards = new Map(await Promise.all([16,26].map(async id => [id, await buildDisplayData({landingNumber:id})])));
  const index = createConnectionIndex(boards);
  let now, realtime;
  const site = await serve({api:{
    '/api/display-data': url => boards.get(Number(url.searchParams.get('landingId')) || 16),
    '/api/landings': {landings:[],operators:[]},
    '/api/realtime': () => realtime,
    '/api/alerts': {available:true,alerts:[]},
    '/api/changelog': {entries:[]},
    '/api/connections': url => ({...tripConnections({index,tripId:url.searchParams.get('tripId'),now,
      updates:new Map(realtime.updates.map(row=>[`${row.tripId}|${row.stopId}`,row])),
      vehicles:new Map(realtime.vehicles.map(row=>[row.tripId,row]))}),generatedAt:now.toISOString()})
  }});
  const browser = await chromium.launch({headless:true});
  const results = [];
  await fs.mkdir(ARTIFACTS,{recursive:true});
  try {
    for (const width of [390,1440]) for (const [date,tripId,liveId] of [
      ...(() => { const data = boards.get(16), row = data.departures.find(r => r.tripId.startsWith('nyc:november:') && data.calendars.some(c => c.serviceId === r.serviceId && c.weekdays[1])); return [['2026-11-02',row.tripId,row.liveTripId]]; })(),
      ['2026-10-03','36','1698'], ['2026-10-17','820','2092'], ['2026-10-10','820','2065'], ['2026-10-24','820','2113']
    ]) {
      const row = boards.get(16).departures.find(row=>row.tripId===tripId);
      now = new Date(`${date}T${date >= "2026-11-01" ? "05" : "04"}:00:00Z`);
      realtime = {available:true,stale:false,fetchedAt:now.toISOString(),
        updates:[{tripId:liveId,stopId:row.stopId,delaySeconds:120}],
        vehicles:[{tripId:liveId,boatName:'Verified vessel',boat:row.boatAssignment ? `${row.routeId}${row.boatAssignment}` : null}]};
      const name = `post-sukkot-${date}-${tripId.replaceAll(":", "-")}-${width}`;
      const context = await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
      await context.tracing.start({screenshots:true,snapshots:true});
      const page = await context.newPage(), errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(instant=>{
        const Real=Date;
        globalThis.Date=class extends Real {constructor(...args){super(...(args.length?args:[instant]));} static now(){return +new Real(instant);}};
        localStorage.setItem('nyc-ferry-did-sort','time');
      },now.toISOString());
      try {
        await page.goto(`${site.origin}/ferryTimesMobile/?landing=16`);
        const target=page.locator(`#departures [data-trip-id="${tripId}"]`).first();
        await target.waitFor();
        await page.waitForFunction(id=>document.querySelector(`#departures [data-trip-id="${id}"]`)?.textContent.includes('Verified vessel'),tripId);
        const text=await target.textContent();
        assert.match(text,/Verified vessel/);
        assert.match(text,/\+2 min/);
        assert.doesNotMatch(await page.locator('#boardNote').textContent(),/Sukkot|await dispatch/);
        await target.click();
        await page.locator('#tripMenu:not([hidden])').waitFor();
        await page.waitForFunction(()=>!document.querySelector('#tripStops').textContent.includes('Checking…'));
        assert.doesNotMatch(await page.locator('#tripStops').textContent(),/could not be loaded|unavailable|too old/);
        assert.equal(await page.locator('#tripMapLabel').textContent(),'See Verified vessel on the map');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        await page.screenshot({path:path.join(ARTIFACTS,`${name}.png`),fullPage:true});
        assert.deepEqual(errors,[]);
        results.push({date,tripId,liveId,width,boat:'Verified vessel',delayMinutes:2,connections:true});
      } finally {
        await context.tracing.stop({path:path.join(ARTIFACTS,`${name}.zip`)});
        await context.close();
      }
    }
    await fs.writeFile(path.join(ARTIFACTS,'post-sukkot-results.json'),JSON.stringify(results,null,2)+'\n');
    console.log(JSON.stringify(results,null,2));
  } finally {
    await browser.close();
    await site.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
