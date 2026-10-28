// Desktop wheel/trackpad regression checks with bundled cartography and stationary boats.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { check } = require('./mobile-check-harness.cjs');
const { instrumentMap, mapEvaluate } = require('./map-test-scope.cjs');

(async () => {
  const { harbor, positions } = await require('./map-browser-fixture.cjs')();
  await check('desktop map zoom', {
    context: { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false },
    api: { '/api/map': harbor, '/api/boats': positions }
  }, async ({ page, site, save }) => {
    await page.route('**/assets/map.js*', async route => route.fulfill({
      contentType: 'text/javascript',
      body: instrumentMap(await fs.readFile('public/assets/map.js', 'utf8'))
    }));
    await page.goto(`${site.origin}/map`);
    await page.waitForSelector('.boat');
    const box = await page.locator('#chart').boundingBox();
    const cursor = { x: box.x + box.width * .65, y: box.y + box.height * .35 };
    await page.mouse.move(cursor.x, cursor.y);
    const camera = () => mapEvaluate(page, () => ({ ...view }));
    const before = await camera();
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(180);
    const after = await camera();
    assert(after.width < before.width, 'ordinary mouse scrolling zooms without modifiers');
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(180);
    assert(Math.abs((await camera()).width - before.width) < .001, 'opposite wheel deltas restore the scale');

    const result = await mapEvaluate(page, async () => {
      const frame = () => new Promise(requestAnimationFrame);
      const chart = document.querySelector('#chart');
      const box = chart.getBoundingClientRect();
      const x = box.x + box.width * .65, y = box.y + box.height * .35;
      const wheel = (deltaY, deltaMode = 0, extra = {}) => {
        const event = new WheelEvent('wheel', { clientX: x, clientY: y,
          deltaY, deltaMode, cancelable: true, bubbles: true, ...extra });
        chart.dispatchEvent(event);
        if (deltaY && !event.defaultPrevented) throw new Error('wheel must not scroll the page');
      };
      setView({ x: base.width * .3, y: base.height * .3, width: base.width / 4 });
      await frame();
      const anchorBefore = toDrawing(x, y);
      wheel(-1);
      const anchorAfter = toDrawing(x, y);
      if (Math.hypot(anchorBefore.x - anchorAfter.x, anchorBefore.y - anchorAfter.y) > .001)
        throw new Error('zoom must preserve the point under the cursor');
      const start = { ...view };
      wheel(-3, 1);
      const lineWidth = view.width;
      setView(start);
      wheel(-48);
      if (Math.abs(view.width - lineWidth) > .001) throw new Error('line deltas normalize to pixels');

      await frame();
      let writes = 0;
      const observer = new MutationObserver(records => {
        writes += records.filter(r => r.attributeName === 'viewBox').length;
      });
      observer.observe(chart, { attributes: true });
      for (let i = 0; i < 20; i++) wheel(-1);
      await frame();
      await Promise.resolve();
      observer.disconnect();
      if (writes !== 1) throw new Error(`wheel burst must render once per frame, saw ${writes}`);

      const limits = [];
      for (const [width, delta] of [[base.width / MAX_ZOOM, -120], [base.width, 120]]) {
        setView({ x: base.width * .3, y: base.height * .3, width });
        await frame();
        const atLimit = JSON.stringify(view);
        for (let i = 0; i < 20; i++) { wheel(delta); await frame(); }
        if (JSON.stringify(view) !== atLimit) throw new Error('scrolling at a zoom limit moved the camera');
        limits.push({ delta, camera: { ...view } });
      }
      wheel(0, 0, { deltaX: 80 });
      wheel(-10, 0, { ctrlKey: true });
      if (!(view.width < base.width)) throw new Error('trackpad pinch still zooms');
      return { anchorBefore, anchorAfter, writes, limits,
        pageScroll: { x: window.scrollX, y: window.scrollY } };
    });
    assert.deepEqual(result.pageScroll, { x: 0, y: 0 });
    await save('desktop-map-zoom-checks.json', { before, after, ...result });
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
