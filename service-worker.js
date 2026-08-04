/* ============================================================================
 * service-worker.js
 * ----------------------------------------------------------------------------
 * PHASE PWA-REBUILD (v3) — OFFLINE-FIRST, MULTI-BUCKET CACHING, SAFE UPDATES
 *
 * WHAT THIS FILE IS
 *   Pure infrastructure, per this project's PWA/Service Worker standard
 *   ("The Service Worker is infrastructure. Business logic must never be
 *   implemented inside the Service Worker."). It never touches IndexedDB,
 *   Repository.js, or any application data — the app's existing
 *   offline-first data layer (StorageAdapter -> IndexedDBAdapter ->
 *   Repository) is untouched and unaware this file exists.
 *
 * WHAT CHANGED FROM v1/v2 (this is a genuine restructure, not just a
 * version bump — see the delivery report for the full before/after)
 *   1. FOUR cache buckets instead of two, each with its own strategy,
 *      because "every resource defines its strategy" (this project's own
 *      PWA standard) is not actually true with one runtime bucket for
 *      everything:
 *        SHELL_CACHE   — index.html, offline.html, css/*, js/* (Cache
 *                         First; versioned as a whole via SW_VERSION).
 *        ICON_CACHE    — manifest icons/favicon/apple-touch-icon (Cache
 *                         First, precached, tiny and effectively static —
 *                         see manifest.json for why only a small critical
 *                         subset of the full assets/icons/ set is
 *                         precached here; the rest — splash screens,
 *                         maskable 1024, OG/social images — are the "Lazy
 *                         Cache" case below, fetched and cached only the
 *                         first time something actually requests them,
 *                         since they are large and not needed for the
 *                         very first paint).
 *        IMAGE_CACHE   — any other same-origin image request (Accept:
 *                         image/* or a common image extension) — Cache
 *                         First with an entry cap, kept separate from
 *                         RUNTIME_CACHE so a burst of document/attachment
 *                         thumbnails a person opens in one session can
 *                         never evict cached CSS/JS from RUNTIME_CACHE's
 *                         own cap, and vice versa. This is the "Image
 *                         Cache" and "Lazy Cache" requirement.
 *        RUNTIME_CACHE — everything else same-origin (Stale-While-
 *                         Revalidate, entry-capped) — unchanged from v1/v2.
 *   2. Offline Page: offline.html (new, static, dependency-free file) is
 *      now the final fallback for a failed navigation when even the
 *      cached index.html is unavailable — previously that case returned
 *      Response.error() (a browser network-error page). See offline.html
 *      itself for exactly when this can happen (it is rare).
 *   3. Background Sync scaffold: registers a real 'sync' event listener
 *      (tag 'ahp-connectivity-restored'). Per the "SW is infrastructure
 *      only" rule above, it does not call into any business/data logic
 *      itself — this codebase has no existing write-queue/replay
 *      mechanism for it to safely trigger (verified: no
 *      `addEventListener('online'` anywhere in js/ before this phase, so
 *      there is nothing already-working to wire into without guessing at
 *      undocumented behavior). Instead it broadcasts a postMessage to
 *      every open tab; js/core/pwa/InstallPromptManager.js listens and
 *      dispatches a `document` CustomEvent ('ahp:connectivity-restored')
 *      any future feature can attach to. This is documented as a
 *      "future recommendation" in the delivery report, not silently
 *      pretended to be full queued background sync.
 *   4. Network Fallback for images: an image request that fails AND has
 *      no cache entry now resolves to a tiny inline placeholder SVG
 *      instead of a broken-image icon / hard failure.
 *
 * EVERYTHING BELOW THIS POINT THAT v1/v2 ALREADY GOT RIGHT IS UNCHANGED
 * IN BEHAVIOR (same guarantees, just reorganized to fit the new buckets):
 *   - Cache Versioning: SW_VERSION is still the only thing that has to
 *     change to ship a new shell version; bumping it creates all-new
 *     cache names so an already-open tab never has a cache mutated out
 *     from under a mid-flight request.
 *   - Cache Cleanup: activate() still deletes every cache name not in
 *     CURRENT_CACHES.
 *   - Manual Update: still no self.skipWaiting() on install and no
 *     self.clients.claim() before activation — updates wait for the
 *     person to click "Update now" on ServiceWorkerRegistrar.js's banner
 *     via postMessage({type:'SKIP_WAITING'}).
 *   - Navigation requests still Network First (falls back to cached
 *     index.html, and now falls back further to offline.html — see #2).
 *   - Precached shell files still Cache First.
 *   - Anything cross-origin (Google Fonts, Apps Script) and anything
 *     that is not a GET (Apps Script sync POSTs) is still left
 *     completely untouched by fetch() below — same "never cache
 *     sensitive requests" guarantee as before.
 *
 * EVIDENCE THE PRECACHE LIST IS CORRECT (not hand-typed, not guessed)
 *   PRECACHE_URLS was regenerated directly from this exact index.html's
 *   own <link rel="stylesheet"> and <script src> tags (grep -oE, same
 *   technique the original v1 header documented), in the order those
 *   tags appear, immediately after this phase's own edits to index.html
 *   (the two new <script src> tags this phase added —
 *   js/core/pwa/InstallPromptManager.js — and manifest.json/offline.html
 *   are included; nothing was invented, renamed, or assumed).
 * ==========================================================================*/

'use strict';

/* ----------------------------------------------------------------------
 * PHASE 30-HOTFIX-2 — RECURRING POST-UPDATE INSTABILITY (root cause + fix)
 * ----------------------------------------------------------------------
 * Carried over from Phase 29-Hotfix-2 — see docs/phase29's hotfix-2
 * report on the previous build for the full evidence trail (Facebook
 * in-app-browser screenshots, storage-eviction analysis, etc.). Summary:
 *
 *   (A) DATA LOSS, not a caching bug — no `navigator.storage.persist()`
 *       anywhere, so best-effort IndexedDB gets evicted more aggressively
 *       in non-installed / in-app-WebView contexts than in an installed,
 *       standalone PWA. Fixed by js/core/pwa/StoragePersistence.js +
 *       js/core/pwa/EnvironmentWarning.js.
 *
 *   (B) STALE SHELL FILES after a deploy — every JS/CSS URL in
 *       PRECACHE_URLS was an unversioned bare filename, so a person who
 *       never saw/clicked the manual-update banner kept being served old
 *       JS/CSS beside a freshly-fetched new index.html. Fixed by giving
 *       every local JS/CSS reference in index.html (and the matching
 *       PRECACHE_URLS entry) a `?v=<APP_BUILD_VERSION>` query string, and
 *       by making ServiceWorkerRegistrar.js re-check for updates
 *       periodically and on tab-focus/online instead of only once per
 *       fresh load.
 *
 *   (C) NEW IN THIS PHASE, same root cause as (B): Phase 30's licensing
 *       framework added css/license.css + 9 files under js/license/ to
 *       index.html but never added them to PRECACHE_URLS — a live
 *       instance of exactly the "new pages/scripts added, shell cache
 *       list never updated to match" pattern this hotfix exists to
 *       close. Added below, versioned identically to every other file.
 * ---------------------------------------------------------------------- */

/* ----------------------------------------------------------------------
 * PHASE 29 — OFFLINE STARTUP HOTFIX (root cause + fix)
 * ----------------------------------------------------------------------
 * SYMPTOM REPORTED: offline app either loses CSS files, or opens on
 * index.html and stalls on the first splash/logo screen — every time,
 * not rarely.
 *
 * EVIDENCE:
 *   1. index.html line 54: <link rel="canonical"
 *      href="https://fxstrict.github.io/hossam/"> — this app is deployed
 *      under a GitHub Pages PROJECT subpath ("/hossam/"), not domain root.
 *   2. ServiceWorkerRegistrar.js registers this file with a relative path
 *      ('./service-worker.js'), so its scope is that same "/hossam/"
 *      subpath — correct, and not being changed here.
 *   3. THE BUG (this file, fetch handler, pre-existing): `path =
 *      url.pathname.replace(/^\//, '')` strips only the leading slash,
 *      giving "hossam/css/base.css" for a request to
 *      "https://fxstrict.github.io/hossam/css/base.css". That string is
 *      then compared against PRECACHE_URLS, whose entries are root-
 *      relative ("css/base.css", no "hossam/" prefix) — so it NEVER
 *      matches under this deployment. Every shell CSS/JS request falls
 *      through past the SHELL_CACHE/ICON_CACHE branches into the final
 *      staleWhileRevalidate(RUNTIME_CACHE) branch instead.
 *   4. RUNTIME_CACHE was never precached (only SHELL_CACHE/ICON_CACHE are,
 *      in the install handler below) and is capped at
 *      RUNTIME_CACHE_MAX_ENTRIES with oldest-entry eviction
 *      (trimCache()). staleWhileRevalidate(), offline, with no existing
 *      RUNTIME_CACHE entry for a given file, resolves to `undefined`
 *      (its own network branch's `.catch` returns the un-set `cached`
 *      variable) — an invalid Service Worker response, which the browser
 *      reports as a failed resource load.
 *   5. This exactly matches BOTH reported symptoms from one root cause:
 *      whichever shell files are NOT currently sitting in the capped,
 *      rotating RUNTIME_CACHE at the moment the device goes offline fail
 *      to load — CSS files fail visibly (unstyled page), and if a
 *      boot-critical JS file (e.g. js/core/boot/BootManager.js) is the
 *      one missing, the app hangs on the splash/logo screen forever
 *      because boot never receives the script it is waiting on. Which
 *      specific files are missing varies run to run (whatever RUNTIME_CACHE
 *      happened to still hold), which is why the symptom looked
 *      inconsistent rather than a clean, single reproducible file.
 *
 * FIX: compute `path` relative to THIS SCRIPT'S OWN registration scope
 * (the directory service-worker.js itself lives in) instead of relative
 * to the origin root. Works identically for root deployments (scope "/")
 * and subpath deployments (scope "/hossam/", or any other subpath) — see
 * pathRelativeToScope() below. SW_VERSION is bumped so every existing
 * install picks up new, correctly-keyed caches instead of continuing to
 * read from the old mis-keyed RUNTIME_CACHE entries.
 *
 * Also hardened cacheFirstIn() (used for SHELL_CACHE/ICON_CACHE) with a
 * network-failure fallback to a cross-cache lookup, so a single file that
 * silently failed to precache during install (the install handler below
 * already treats per-file precache failure as non-fatal and continues)
 * does not hard-fail as an unhandled rejection offline — see that
 * function for the residual limitation this does NOT solve.
 * ---------------------------------------------------------------------- */

var SW_VERSION = 'v6';
var SHELL_CACHE = 'ahp-shell-' + SW_VERSION;
var ICON_CACHE = 'ahp-icons-' + SW_VERSION;
var IMAGE_CACHE = 'ahp-images-' + SW_VERSION;
var RUNTIME_CACHE = 'ahp-runtime-' + SW_VERSION;
var CURRENT_CACHES = [SHELL_CACHE, ICON_CACHE, IMAGE_CACHE, RUNTIME_CACHE];

var IMAGE_CACHE_MAX_ENTRIES = 80;
var RUNTIME_CACHE_MAX_ENTRIES = 60;

// Small, critical icon subset only — see file header point #1 (ICON_CACHE).
var ICON_PRECACHE_URLS = [
  'assets/favicon/favicon.ico',
  'assets/favicon/favicon-16.png',
  'assets/favicon/favicon-32.png',
  'assets/favicon/favicon-48.png',
  'assets/apple/apple-touch-icon-180.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/maskable/icon-maskable-192.png',
  'assets/icons/maskable/icon-maskable-512.png'
];

// Generated from index.html's own <link>/<script> tags — see file header.
var PRECACHE_URLS = [
  'index.html',
  'manifest.json',
  'offline.html',
  'css/variables.css?v=30.1',
  'css/base.css?v=30.1',
  'css/layout.css?v=30.1',
  'css/components.css?v=30.1',
  'css/responsive.css?v=30.1',
  'css/utilities.css?v=30.1',
  'css/skeleton.css?v=30.1',
  'css/boot-error.css?v=30.1',
  'css/safe-mode.css?v=30.1',
  'css/dashboard-smart.css?v=30.1',
  /* PHASE 30-HOTFIX-2 — the Phase 30 licensing framework (css/license.css
     + js/license/*.js, 10 files) was wired into index.html but never
     added here, so it was never precached and never covered by the
     ?v= cache-busting scheme either — the exact "new files added, shell
     cache never updated to match" pattern this hotfix exists to close.
     Added below, versioned the same as every other shell asset. */
  'css/license.css?v=30.1',
  'js/license/license-public-key.js?v=30.1',
  'js/license/LicenseCrypto.js?v=30.1',
  'js/license/MachineFingerprint.js?v=30.1',
  'js/license/LicenseCore.js?v=30.1',
  'js/license/ReadOnlyGuard.js?v=30.1',
  'js/license/SubscriptionManager.js?v=30.1',
  'js/license/ActivationWizard.js?v=30.1',
  'js/license/LicenseOnlineValidator.js?v=30.1',
  'js/license/LicenseManagerPanel.js?v=30.1',
  'assets/favicon/favicon.ico',
  'assets/favicon/favicon-16.png',
  'assets/favicon/favicon-32.png',
  'assets/favicon/favicon-48.png',
  'assets/apple/apple-touch-icon-180.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/maskable/icon-maskable-192.png',
  'assets/icons/maskable/icon-maskable-512.png',
  'js/debug/RuntimeDebugLayer.js?v=30.1',
  'js/api/api.js?v=30.1',
  'js/core/OfflineQueue.js?v=30.1',
  'js/ui-utils.js?v=30.1',
  'js/print-utils.js?v=30.1',
  'js/core/StorageAdapter.js?v=30.1',
  'js/core/StartupTimeoutManager.js?v=30.1',
  'js/core/LocalStorageAdapter.js?v=30.1',
  'js/core/DatabaseService.js?v=30.1',
  'js/core/Repository.js?v=30.1',
  'js/core/UndoManager.js?v=30.1',
  'js/core/UndoReconciler.js?v=30.1',
  'js/core/IndexedDBErrors.js?v=30.1',
  'js/core/IndexedDBSchema.js?v=30.1',
  'js/core/IndexedDBUtils.js?v=30.1',
  'js/core/IndexedDBVersion.js?v=30.1',
  'js/core/IndexedDBTransaction.js?v=30.1',
  'js/core/IndexedDBEngine.js?v=30.1',
  'js/core/IndexedDBAdapter.js?v=30.1',
  'js/core/MigrationService.js?v=30.1',
  'js/core/MigrationBootstrap.js?v=30.1',
  'js/repositories/CasesRepository.js?v=30.1',
  'js/repositories/ClientsRepository.js?v=30.1',
  'js/repositories/ClientMessagesRepository.js?v=30.1',
  'js/repositories/ChildrenRepository.js?v=30.1',
  'js/repositories/SessionsRepository.js?v=30.1',
  'js/repositories/TasksRepository.js?v=30.1',
  'js/repositories/FeesRepository.js?v=30.1',
  'js/repositories/DocumentsRepository.js?v=30.1',
  'js/repositories/LibraryRepository.js?v=30.1',
  'js/repositories/TemplatesRepository.js?v=30.1',
  'js/repositories/SettingsRepository.js?v=30.1',
  'js/repositories/SettingsRepositoryWiring.js?v=30.1',
  'js/core/RepositoryReadyTimeout.js?v=30.1',
  'js/modules/cases.js?v=30.1',
  'js/modules/settings.js?v=30.1',
  'js/modules/firstrun.js?v=30.1',
  'js/modules/calendar.js?v=30.1',
  'js/modules/children.js?v=30.1',
  'js/modules/dashboard.js?v=30.1',
  'js/modules/tasks.js?v=30.1',
  'js/modules/documents.js?v=30.1',
  'js/modules/sessions.js?v=30.1',
  'js/core/HistoryPanel.js?v=30.1',
  'js/modules/clients.js?v=30.1',
  'js/modules/client-messages.js?v=30.1',
  'js/modules/fees.js?v=30.1',
  'js/modules/library.js?v=30.1',
  'js/modules/templates.js?v=30.1',
  'js/modules/historypanel-ui.js?v=30.1',
  'js/core/RepositoryReadyCoordinator.js?v=30.1',
  'js/core/boot/BootManager.js?v=30.1',
  'js/core/shell/ShellEvents.js?v=30.1',
  'js/core/shell/BootState.js?v=30.1',
  'js/core/shell/PageRegistry.js?v=30.1',
  'js/core/shell/ViewRegistry.js?v=30.1',
  'js/core/shell/NavigationRegistry.js?v=30.1',
  'js/core/shell/ShellState.js?v=30.1',
  'js/core/shell/ShellRegistry.js?v=30.1',
  'js/core/shell/LifecycleManager.js?v=30.1',
  'js/core/render/RenderMetrics.js?v=30.1',
  'js/core/render/RenderTask.js?v=30.1',
  'js/core/render/RenderRegistry.js?v=30.1',
  'js/core/render/RenderScheduler.js?v=30.1',
  'js/core/render/RenderDispatcher.js?v=30.1',
  'js/core/render/RenderQueue.js?v=30.1',
  'js/core/view/ViewVersion.js?v=30.1',
  'js/core/view/DirtyTracker.js?v=30.1',
  'js/core/view/ViewCache.js?v=30.1',
  'js/core/view/PageState.js?v=30.1',
  'js/core/view/ViewLifecycle.js?v=30.1',
  'js/core/dom/DomKeyIndex.js?v=30.1',
  'js/core/dom/DomNodeFactory.js?v=30.1',
  'js/core/dom/DomPatch.js?v=30.1',
  'js/core/dom/DomRecycler.js?v=30.1',
  'js/core/shell/ApplicationShell.js?v=30.1',
  'js/core/shell/NavigationManager.js?v=30.1',
  'js/core/boot/SafeModeController.js?v=30.1',
  'js/core/pwa/ServiceWorkerRegistrar.js?v=30.1',
  'js/core/pwa/InstallPromptManager.js?v=30.1',
  'js/core/pwa/StoragePersistence.js?v=30.1',
  'js/core/pwa/EnvironmentWarning.js?v=30.1'
];

// 1x1-scale, dependency-free inline placeholder for a same-origin image
// request that fails offline and was never cached — see file header #4.
var IMAGE_FALLBACK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">' +
  '<rect width="200" height="200" fill="#0D1B2A"/>' +
  '<text x="100" y="105" font-size="13" fill="#C9A84C" text-anchor="middle" font-family="sans-serif">لا يوجد اتصال</text>' +
  '</svg>';

self.addEventListener('install', function (event) {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then(function (cache) {
        return Promise.all(PRECACHE_URLS.map(function (url) {
          return cache.add(url).catch(function (err) {
            try { console.warn('[SW] shell precache skipped (non-fatal):', url, err && err.message); } catch (e) {}
          });
        }));
      }),
      caches.open(ICON_CACHE).then(function (cache) {
        return Promise.all(ICON_PRECACHE_URLS.map(function (url) {
          return cache.add(url).catch(function (err) {
            try { console.warn('[SW] icon precache skipped (non-fatal):', url, err && err.message); } catch (e) {}
          });
        }));
      })
    ])
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        if (CURRENT_CACHES.indexOf(name) === -1) {
          return caches.delete(name);
        }
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// Lets js/core/pwa/ServiceWorkerRegistrar.js hand control to a waiting
// update only after the person explicitly asks for it. See file header.
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Background Sync scaffold — see file header point #3 for exactly what
// this does and does not do.
self.addEventListener('sync', function (event) {
  if (event.tag !== 'ahp-connectivity-restored') return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      clientList.forEach(function (client) {
        client.postMessage({ type: 'AHP_BACKGROUND_SYNC_TICK' });
      });
    })
  );
});

// Directory this SW script itself lives in, e.g. '/hossam/' for a GitHub
// Pages project subpath, or '/' for a root deployment. Computed once from
// self.location (always available, unlike self.registration.scope which
// is not guaranteed populated in every event) — see PHASE 29 note above.
var SCOPE_PATH = self.location.pathname.replace(/[^/]*$/, '');

// Root-cause fix (PHASE 29): path must be computed relative to THIS
// SCOPE, not relative to the origin root, or every PRECACHE_URLS/
// ICON_PRECACHE_URLS lookup silently fails under a subpath deployment.
function pathRelativeToScope(url) {
  if (url.pathname.indexOf(SCOPE_PATH) === 0) {
    return url.pathname.slice(SCOPE_PATH.length);
  }
  return url.pathname.replace(/^\//, ''); // defensive fallback, unchanged old behavior
}

function isNavigationRequest(request) {
  if (request.mode === 'navigate') return true;
  var accept = request.headers.get('accept');
  return request.method === 'GET' && !!accept && accept.indexOf('text/html') !== -1;
}

function isImageRequest(request, url) {
  var accept = request.headers.get('accept');
  if (accept && accept.indexOf('image/') !== -1) return true;
  return /\.(png|jpg|jpeg|gif|webp|svg|ico)$/i.test(url.pathname);
}

function networkFirstShell(request) {
  return fetch(request).then(function (response) {
    if (response && response.ok) {
      var copy = response.clone();
      caches.open(SHELL_CACHE).then(function (cache) { cache.put('index.html', copy); });
    }
    return response;
  }).catch(function () {
    return caches.match('index.html').then(function (cached) {
      if (cached) return cached;
      // Deepest fallback — see offline.html's own header for exactly when
      // this path is reached (rare: first-ever visit, offline, before any
      // precache completed).
      return caches.match('offline.html').then(function (offlineCached) {
        return offlineCached || Response.error();
      });
    });
  });
}

function cacheFirstIn(cacheName, request) {
  return caches.match(request).then(function (cached) {
    if (cached) return cached;
    return fetch(request).then(function (response) {
      if (response && response.ok) {
        var copy = response.clone();
        caches.open(cacheName).then(function (cache) { cache.put(request, copy); });
      }
      return response;
    }).catch(function () {
      // PHASE 29 hardening: offline AND not found in `cacheName` — this
      // means the specific file's install-time precache silently failed
      // (see the install handler's per-file .catch). Last resort: check
      // every cache bucket before giving up, in case it landed somewhere
      // else. Does NOT solve the underlying "precache can silently miss a
      // file" behavior — that is an intentional, pre-existing install()
      // policy (fail soft rather than block install on one flaky file)
      // and changing it is out of this fix's scope.
      return caches.match(request);
    });
  });
}

function trimCache(cacheName, maxEntries) {
  caches.open(cacheName).then(function (cache) {
    cache.keys().then(function (keys) {
      if (keys.length > maxEntries) {
        cache.delete(keys[0]).then(function () { trimCache(cacheName, maxEntries); });
      }
    });
  });
}

function cacheFirstImage(request) {
  return caches.match(request, { cacheName: IMAGE_CACHE }).then(function (cached) {
    if (cached) return cached;
    return fetch(request).then(function (response) {
      if (response && response.ok) {
        var copy = response.clone();
        caches.open(IMAGE_CACHE).then(function (cache) {
          cache.put(request, copy);
          trimCache(IMAGE_CACHE, IMAGE_CACHE_MAX_ENTRIES);
        });
      }
      return response;
    }).catch(function () {
      // Network Fallback for images — see file header point #4.
      return new Response(IMAGE_FALLBACK_SVG, { headers: { 'Content-Type': 'image/svg+xml' } });
    });
  });
}

function staleWhileRevalidate(request) {
  return caches.open(RUNTIME_CACHE).then(function (cache) {
    return cache.match(request).then(function (cached) {
      var networkFetch = fetch(request).then(function (response) {
        if (response && response.ok) {
          cache.put(request, response.clone());
          trimCache(RUNTIME_CACHE, RUNTIME_CACHE_MAX_ENTRIES);
        }
        return response;
      }).catch(function () { return cached; });
      return cached || networkFetch;
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return; // never intercept writes/sync calls

  var url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return; // cross-origin (fonts, Apps Script) — untouched

  if (isNavigationRequest(request)) {
    event.respondWith(networkFirstShell(request));
    return;
  }

  var path = pathRelativeToScope(url);

  if (PRECACHE_URLS.indexOf(path) !== -1) {
    event.respondWith(cacheFirstIn(SHELL_CACHE, request));
    return;
  }
  if (ICON_PRECACHE_URLS.indexOf(path) !== -1) {
    event.respondWith(cacheFirstIn(ICON_CACHE, request));
    return;
  }
  if (isImageRequest(request, url)) {
    event.respondWith(cacheFirstImage(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
