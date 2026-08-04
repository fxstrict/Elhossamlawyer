/* ============================================================================
 * js/core/pwa/StoragePersistence.js
 * ----------------------------------------------------------------------------
 * PHASE 30-HOTFIX-2 — PERSISTENT STORAGE REQUEST (root-cause fix)
 *
 * ROOT CAUSE THIS FILE FIXES
 *   Reported symptom: after almost every update, or after the case/session
 *   list grows, the dashboard shows every counter as 0 and the app displays
 *   the first-run "ابدأ بإضافة أول موكل" screen — as if the database were
 *   brand new — in every browser except Chrome, and unreliably even inside
 *   Chrome; but it is always stable when opened from the installed
 *   home-screen app icon.
 *
 *   That pattern is the signature of storage EVICTION, not a code bug in
 *   cases.js/dashboard.js/etc. Every browser keeps IndexedDB (and
 *   localStorage) under a "best-effort" storage bucket by default: under
 *   disk pressure, or after a period of not being visited, the browser is
 *   explicitly allowed by spec to silently wipe an origin's storage with no
 *   warning to the app or the person. This project never asked for
 *   protection from that — grep confirms no prior call anywhere to
 *   `navigator.storage.persist()` in this codebase before this phase.
 *
 *   Which origins get evicted first is exactly what varies by browser
 *   engine and hosting context, which is why the symptom looked
 *   browser-dependent rather than code-dependent:
 *     - An installed, home-screen PWA (standalone display mode) is
 *       automatically granted persistent storage by Chrome/Chromium once
 *       installed — matches the report that the home-screen icon is
 *       always stable.
 *     - A page opened inside another app's in-app browser (Facebook/
 *       Instagram/Messenger — confirmed from the screenshots supplied with
 *       this report: com.facebook.katana) runs inside that host app's own
 *       WebView, which is far more aggressive about reclaiming storage
 *       when the host app is backgrounded or the device needs memory —
 *       matches "any browser other than Chrome" and "even in Chrome
 *       sometimes" (a same-device Chrome tab is still only best-effort
 *       unless persisted).
 *
 * WHAT THIS FILE DOES
 *   Requests persistent storage (`navigator.storage.persist()`) as early as
 *   physically possible in boot — loaded immediately after the diagnostic
 *   layer, before the Repository/StorageAdapter stack initializes — so the
 *   browser is asked to exempt this origin's IndexedDB from best-effort
 *   eviction before any data is even written. Per spec this is a no-op
 *   promise that resolves true/false; it cannot throw, cannot block boot,
 *   and requires no permission prompt in any current browser (eligibility
 *   is decided by the browser's own heuristics — bookmarked/installed/
 *   frequently-used origins qualify automatically in Chromium; Firefox
 *   grants it more readily than it evicts).
 *
 *   This file does NOT and cannot force persistence inside an in-app
 *   browser that refuses to honor the API (some do) — no web-page code
 *   can override a host app's own WebView storage policy. That residual
 *   case is handled separately by js/core/pwa/EnvironmentWarning.js, which
 *   tells the person directly when they are in such a browser.
 *
 * WHAT THIS FILE DOES NOT DO
 *   No IndexedDB, Repository, or business logic — pure environment
 *   plumbing only, same rule as every other file in js/core/pwa/. Fails
 *   silently (console.warn only) if the API is unsupported.
 * ==========================================================================*/
(function () {
  'use strict';

  if (!(navigator.storage && navigator.storage.persist)) return; // unsupported browser — no-op

  try {
    navigator.storage.persisted().then(function (already) {
      if (already) return;
      navigator.storage.persist().then(function (granted) {
        window.__ahpStoragePersisted = !!granted;
        try {
          document.dispatchEvent(new CustomEvent('ahp:storage-persist-result', { detail: { granted: !!granted } }));
        } catch (e) {}
      }).catch(function (err) {
        try { console.warn('[Storage] persist() request failed (non-fatal):', err && err.message); } catch (e) {}
      });
    }).catch(function () {});
  } catch (e) {
    try { console.warn('[Storage] persistence check skipped:', e && e.message); } catch (e2) {}
  }
})();
