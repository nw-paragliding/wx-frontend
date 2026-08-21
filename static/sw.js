var CACHE_NAME = "windrose-__BUILD_HASH__";
var STATIC_ASSETS = [
  "/",
  "/api/config",
  "/uPlot.min.js",
  "/uPlot.min.css",
  "/theme.css",
  "/layout.css",
  "/app.css",
  "/app.js",
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(STATIC_ASSETS);
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names
          .filter(function (name) {
            return name !== CACHE_NAME;
          })
          .map(function (name) {
            return caches.delete(name);
          }),
      );
    }),
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);

  // Static assets (HTML page, config, vendored libs): stale-while-revalidate
  if (
    url.pathname === "/" ||
    url.pathname === "/api/config" ||
    url.pathname === "/uPlot.min.js" ||
    url.pathname === "/uPlot.min.css" ||
    url.pathname === "/theme.css" ||
    url.pathname === "/layout.css" ||
    url.pathname === "/app.css" ||
    url.pathname === "/app.js"
  ) {
    event.respondWith(
      caches.match(event.request).then(function (cached) {
        // Return cache hit immediately, but update in background
        var fetchPromise = fetch(event.request)
          .then(function (response) {
            if (response.ok) {
              var clone = response.clone();
              caches.open(CACHE_NAME).then(function (cache) {
                cache.put(event.request, clone);
              });
            }
            return response;
          })
          .catch(function () {
            return cached;
          });

        return cached || fetchPromise;
      }),
    );
    return;
  }

  // Wind and timeseries responses are deliberately NOT cached. Serving a
  // cached one resolves fetch() with a normal 200, so the app cannot tell it
  // from a live reading: it would stamp hours-old data as just-received, show
  // a green "live" dot, and defeat the staleness TTL entirely. Letting the
  // request fail instead lets the app fall back to its own timestamped cache
  // and blank anything older than the TTL.

  // Everything else: plain network fetch
  event.respondWith(fetch(event.request));
});
