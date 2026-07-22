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

  // Wind data & timeseries API: network-first, fall back to last cached response
  if (url.pathname === "/api/wind" || url.pathname === "/api/timeseries") {
    event.respondWith(
      fetch(event.request)
        .then(function (response) {
          if (response.ok) {
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function (cache) {
              // Cache keyed by the full URL including ?range= query
              cache.put(event.request, clone);
            });
          }
          return response;
        })
        .catch(function () {
          // Network failed — try to serve the cached version for this
          // exact range, or fall back to any cached wind response
          return caches.match(event.request).then(function (cached) {
            if (cached) return cached;

            // Last resort: return any cached response for this
            // same API path (different time range is better than nothing)
            var apiPath = url.pathname;
            return caches.open(CACHE_NAME).then(function (cache) {
              return cache.keys().then(function (keys) {
                for (var i = 0; i < keys.length; i++) {
                  var k = new URL(keys[i].url);
                  if (k.pathname === apiPath) {
                    return cache.match(keys[i]);
                  }
                }
                // Nothing cached at all — return a synthetic
                // empty-but-valid JSON so the app doesn't crash
                return new Response(JSON.stringify({ stations: {} }), {
                  status: 200,
                  headers: {
                    "Content-Type": "application/json",
                    "X-Windrose-Offline": "true",
                  },
                });
              });
            });
          });
        }),
    );
    return;
  }

  // Everything else: plain network fetch
  event.respondWith(fetch(event.request));
});
