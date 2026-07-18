const CACHE_NAME = 'sentry-batch-shell-v2';
const APP_SHELL = [
  './index.html',
  './guard.js',
  './main.js',
  './api.js',
  './utils.js',
  './cache.js',
  './charts.js',
  './config.js',
  './intelligence.js',
  './parser.js',
  './table.js',
  './ui.js',
  './workflow.js',
  './manifest.webmanifest',
  './icon.svg',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js',
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600;700;800&display=swap'
];

// Hosts whose responses should NEVER be cached by the service worker.
// This covers every external API, every geo provider, every CORS proxy, and
// every CDN that might carry API keys in URLs or request headers.
// The rule is intentionally permissive: if a host is not the page origin
// and not an explicit static-asset CDN, let it bypass the cache.
const STATIC_CDN_HOSTS = new Set([
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
]);

/**
 * Returns true when the request should bypass the service-worker cache
 * entirely and go straight to the network.
 *
 * Specifically: anything that is NOT
 *   - the page's own origin (same-origin app shell), or
 *   - one of the explicit static CDN hosts above
 * is treated as a live API/proxy call and never cached.
 */
function shouldBypassCache(request){
  // Never cache non-GET requests.
  if(request.method !== 'GET') return true;

  const url = new URL(request.url);

  // Same-origin requests → may be cached (app shell files).
  if(url.origin === self.location.origin) return false;

  // Known static CDNs → may be cached (Chart.js, Google Fonts).
  if(STATIC_CDN_HOSTS.has(url.hostname)) return false;

  // Everything else (API hosts, geo providers, CORS proxies, etc.) → bypass.
  return true;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const responses = await Promise.allSettled(APP_SHELL.map(url => fetch(url, { cache: 'reload' })));
    await Promise.all(responses.map(async (res, idx) => {
      if(res.status !== 'fulfilled') return;
      const response = res.value;
      if(response && (response.ok || response.type === 'opaque')){
        await cache.put(APP_SHELL[idx], response.clone());
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Delete ALL old caches, including the previous version name.
    await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if(request.method !== 'GET') return;

  // API calls, geo lookups, CORS proxies — never intercept, go straight to network.
  if(shouldBypassCache(request)) return;

  // Navigation — network-first, fall back to cached shell.
  if(request.mode === 'navigate'){
    event.respondWith((async () => {
      try{
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        cache.put('./index.html', fresh.clone());
        return fresh;
      }catch(e){
        const cached = await caches.match('./index.html');
        return cached || Response.error();
      }
    })());
    return;
  }

  // Static app-shell assets — stale-while-revalidate.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if(cached){
      event.waitUntil((async () => {
        try{
          const fresh = await fetch(request);
          if(fresh && (fresh.ok || fresh.type === 'opaque')) cache.put(request, fresh.clone());
        }catch(e){}
      })());
      return cached;
    }
    try{
      const fresh = await fetch(request);
      if(fresh && (fresh.ok || fresh.type === 'opaque')){
        cache.put(request, fresh.clone());
      }
      return fresh;
    }catch(e){
      if(request.destination === 'style' || request.destination === 'script' || request.destination === 'font' || request.destination === 'image'){
        return cached || Response.error();
      }
      return Response.error();
    }
  })());
});
