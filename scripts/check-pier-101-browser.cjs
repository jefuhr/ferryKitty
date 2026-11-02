const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { serve, ARTIFACTS } = require('./mobile-check-harness.cjs');
(async () => {
 const { buildDisplayData } = await import('../lib/schedule-builder.js');
 const { createConnectionIndex, tripConnections } = await import('../lib/connections.js');
 const { loadHarborMap } = await import('../lib/fleet-map.js');
 const boards = new Map(await Promise.all([11,16,29,32].map(async id => [id,await buildDisplayData({landingNumber:id})])));
 const landings = [...boards].map(([id,data])=>({id,...data.meta.landing}));
 const harbor = await loadHarborMap({root:process.cwd(),landings,byLanding:boards});
 const now = new Date('2026-11-02T12:00:00-05:00');
 const index = createConnectionIndex(boards);
 const site = await serve({api:{
  '/api/display-data': url=>boards.get(Number(url.searchParams.get('landingId'))||16),
  '/api/landings': {landings,operators:['NYC Ferry','The Trust for Governors Island'],configured:16},
  '/api/map':harbor.map, '/api/boats':{available:true,boats:[]},
  '/api/realtime':{available:true,stale:false,updates:[],vehicles:[]},
  '/api/alerts':{available:true,alerts:[]}, '/api/changelog':{entries:[]}, '/api/override':{text:''},
  '/api/connections':url=>tripConnections({index,tripId:url.searchParams.get('tripId'),now})
 }});
 const browser = await chromium.launch({headless:true});
 const results=[];
 await fs.mkdir(ARTIFACTS,{recursive:true});
 try {
  for (const width of [390,1440]) {
   const context = await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
   await context.tracing.start({screenshots:true,snapshots:true});
   const page=await context.newPage(), errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(instant=>{const Real=Date;globalThis.Date=class extends Real {constructor(...args){super(...(args.length?args:[instant]));}static now(){return +new Real(instant);}};},now.toISOString());
   try {
    await page.goto(`${site.origin}/?landing=16`);
    if (!await page.locator('#landingSearch').isVisible()) await page.locator('#menuButton').click();
    await page.locator('#landingSearch').fill('101');
    const choice=page.locator('#landingMenu [data-landing-id="32"]');
    await choice.waitFor();
    assert.match(await choice.innerText(),/Pier 101/);
    await choice.click();
    if (width < 900) await page.locator("#landingMenu").waitFor({state:"hidden"});
    await page.waitForFunction(()=>document.querySelector('#landingName').textContent.includes('Pier 101'));
    await page.locator('#departures [data-trip-id^="nyc:november:"]').first().waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:path.join(ARTIFACTS,`pier-101-board-${width}.png`),fullPage:true});
    await page.goto(`${site.origin}/map?landing=32`);
    const pin=page.locator('[data-dock-id="32"]');
    await pin.waitFor();
    assert.equal(Number(await pin.getAttribute('data-latitude')),40.69141);
    assert.equal(Number(await pin.getAttribute('data-longitude')),-74.01233);
    await page.screenshot({path:path.join(ARTIFACTS,`pier-101-map-${width}.png`),fullPage:true});
    assert.deepEqual(errors,[]);
    results.push({width,landing:32,search:true,board:true,map:true});
   } finally {await context.tracing.stop({path:path.join(ARTIFACTS,`pier-101-${width}.zip`)});await context.close();}
  }
  await fs.writeFile(path.join(ARTIFACTS,'pier-101-results.json'),JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify(results,null,2));
 } finally {await browser.close();await site.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
