const SHELL='nyc-ferry-did-shell-v128',DATA='nyc-ferry-did-data-v128';
const requestedBase = new URL(self.location.href).searchParams.get('base');
const BASE = requestedBase === '/ferryTimesMobile/' ? requestedBase : '/';
const FILES=[BASE,`${BASE}ride`,'/assets/ride.js?v=128','/assets/ride.css?v=128','/assets/ride-controller.js','/assets/ride-session.js','/assets/ride-notifications.js','/assets/map-projection.js','/assets/view-lifecycle.js','/assets/app-shell.js?v=128','/assets/app-shell.css?v=128','/assets/schedule.js','/assets/preferences.js','/assets/panels.js','/assets/schedule-store.js','/assets/app-icon.png?v=128','/assets/app-icon-180.png?v=128','/assets/app-icon-maskable-512.png?v=128','/assets/waterway.png','/assets/seastreak.png','/assets/nyu.png','/assets/cityferry.png','/assets/gi.png',`${BASE}map`,'/styles.css?v=128','/app.js?v=128','/assets/mobile-runtime.js?v=128','/assets/map.js?v=128','/assets/map.css?v=128','/assets/map-theme.js?v=128','/assets/site.webmanifest?v=128','/assets/app-icon-192.png?v=128','/assets/app-icon-512.png?v=128','/assets/fonts/lato-regular-latin.woff2','/assets/fonts/lato-bold-latin.woff2','/assets/fonts/lato-black-latin.woff2','/assets/fonts/oswald-variable-latin.woff2'];
// Theme artwork and optional fonts enter the cache after first use.
self.addEventListener('install',event=>event.waitUntil(caches.open(SHELL).then(cache=>cache.addAll(FILES)).then(()=>self.skipWaiting())));
async function upgradeCaches() {
  const names = await caches.keys();
  const data = await caches.open(DATA);
  const oldData = names.filter(name => /^nyc-ferry-did-data-v\d+$/.test(name) && name !== DATA)
    .sort((a, b) => Number(b.split('-v').at(-1)) - Number(a.split('-v').at(-1)));
  for (const name of oldData) {
    try {
      const previous = await caches.open(name);
      for (const request of await previous.keys()) {
        const path = new URL(request.url).pathname;
        if (!path.startsWith('/api/') || path === '/api/override' || path.startsWith('/api/ride-notifications') || await data.match(request)) continue;
        const response = await previous.match(request);
        if (response) await data.put(request, response);
      }
      await caches.delete(name);
    } catch { /* Keep the source cache if copying fails; schedules must not be lost on upgrade. */ }
  }
  await Promise.all(names.filter(name => name.startsWith('nyc-ferry-did-shell-v') && name !== SHELL).map(name => caches.delete(name)));
}
self.addEventListener('activate',event=>event.waitUntil(upgradeCaches().then(()=>self.clients.claim())));
async function networkFirst(request,cacheName,wait=10000){
  const cache=await caches.open(cacheName).catch(()=>null);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),wait);
  try{
    const response=await fetch(request,{signal:controller.signal});
    if(!response.ok)throw new Error('unavailable');
    // Cache errors must not discard a successful response.
    try{await cache?.put(request,response.clone())}catch{}
    return response;
  }catch(error){
    const saved=await cache?.match(request);
    if(saved){
      if(cacheName===DATA){
        const headers=new Headers(saved.headers);headers.set('X-Ferry-Saved','1');
        return new Response(saved.body,{status:saved.status,statusText:saved.statusText,headers});
      }
      return saved;
    }
    if(request.mode==='navigate'){
      const isMap=/\/map(?:\.html)?$/.test(new URL(request.url).pathname);
      const shell=await cache?.match(isMap?`${BASE}map`:BASE);
      if(shell)return shell;
    }
    throw error;
  }finally{clearTimeout(timer)}
}
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==location.origin)return;
  const url=new URL(event.request.url);
  if(url.pathname === '/api/override' || url.pathname.startsWith('/api/ride-notifications'))return;
  if(url.pathname.startsWith('/api/'))event.respondWith(networkFirst(event.request,DATA));
  else if(event.request.mode==='navigate')event.respondWith(networkFirst(event.request,SHELL,2500));
  else event.respondWith(caches.match(event.request).then(saved=>saved||fetch(event.request).then(response=>{
    if(response.ok)event.waitUntil(caches.open(SHELL).then(cache=>cache.put(event.request,response.clone())).catch(()=>{}));
    return response;
  })));
});

self.addEventListener('push', event => {
  let message;
  try { message = event.data.json(); } catch { return; }
  if (!message || typeof message.body !== 'string' || !String(message.tag).startsWith('ride-')) return;
  const url = ['/ride', '/ferryTimesMobile/ride'].includes(message.url) ? message.url : `${BASE}ride`;
  event.waitUntil(self.registration.showNotification('Scheduled departure', {
    body: message.body, tag: message.tag, icon: '/assets/app-icon-192.png',
    badge: '/assets/app-icon-192.png', vibrate: [200, 100, 200],
    data: { url, vesselId: message.vesselId }, renotify: false
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const path = ['/ride', '/ferryTimesMobile/ride'].includes(event.notification.data?.url) ? event.notification.data.url : `${BASE}ride`;
  const destination = new URL(path, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => {
      const url = new URL(client.url);
      return url.origin === self.location.origin && /^\/(?:ferryTimesMobile\/)?(?:ride|map(?:\.html)?|index\.html)?$/.test(url.pathname);
    });
    if (existing) {
      const navigated = await existing.navigate(destination);
      if (navigated) return navigated.focus();
    }
    return self.clients.openWindow(destination);
  })());
});
