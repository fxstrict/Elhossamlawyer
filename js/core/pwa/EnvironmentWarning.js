/* ============================================================================
 * js/core/pwa/EnvironmentWarning.js
 * ----------------------------------------------------------------------------
 * PHASE 30-HOTFIX-2 — IN-APP BROWSER DETECTION + GUIDANCE BANNER
 *
 * WHY THIS FILE EXISTS
 *   The screenshots supplied alongside this bug report were all captured
 *   inside com.facebook.katana's in-app browser (visible in the filenames
 *   and in the black system status bar shown behind the page). In-app
 *   browsers embedded inside Facebook/Instagram/Messenger/TikTok/etc. run
 *   as a WebView owned by that host app, not the device's real browser:
 *     - Storage (IndexedDB/localStorage/Cache API) can be tied to the host
 *       app's own lifecycle and is reclaimed far more aggressively than a
 *       real browser profile — see StoragePersistence.js for the
 *       persistence request this project now makes, which helps but is
 *       not guaranteed to be honored by every such WebView.
 *     - Service Worker support/update behavior is inconsistent across
 *       these WebViews and cannot be made fully reliable from page code.
 *   No amount of code inside this app can fully fix a host app's WebView
 *   storage policy — the only reliable fix is for the person to leave that
 *   embedded browser. This file's only job is to tell them that, clearly,
 *   the first time they land here from one of these apps.
 *
 * WHAT THIS FILE DOES
 *   Detects common in-app browser signatures in the User-Agent
 *   (FBAN/FBAV = Facebook, Instagram, Messenger, TikTok's musical_ly/
 *   Bytedance webview, Line, MicroMessenger = WeChat, Twitter). If matched
 *   AND the app is not already running standalone/installed, shows a
 *   single dismissible banner (own DOM node, no dependency on app CSS —
 *   same isolation pattern as ServiceWorkerRegistrar.js's update banner)
 *   explaining that their data may not be saved reliably here, with a
 *   "نسخ الرابط" button (copies the URL so the person can paste it into
 *   their real browser — the one action that reliably works across every
 *   platform, unlike guessing at intent:// URIs that only work on some
 *   Android/browser combinations).
 *
 * WHAT THIS FILE DOES NOT DO
 *   No IndexedDB/Repository/business logic. Never shown twice in the same
 *   browser session (sessionStorage flag) so it does not nag on every
 *   internal navigation. Fails silently if anything is unsupported.
 * ==========================================================================*/
(function () {
  'use strict';

  try {
    if (sessionStorage.getItem('ahp_env_warning_dismissed_v1') === '1') return;
  } catch (e) { /* private-mode storage block — continue, just can't remember dismissal */ }

  var isStandalone = false;
  try {
    isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true; // iOS home-screen
  } catch (e) {}
  if (isStandalone) return; // installed app — not the environment this warns about

  var ua = navigator.userAgent || '';
  var IN_APP_PATTERNS = [
    /FBAN|FBAV/i,          // Facebook app
    /Instagram/i,
    /Messenger/i,
    /Line\//i,
    /MicroMessenger/i,     // WeChat
    /Twitter/i,
    /musical_ly|TikTok|BytedanceWebview/i
  ];
  var matched = IN_APP_PATTERNS.some(function (re) { return re.test(ua); });
  if (!matched) return;

  function showBanner() {
    if (document.getElementById('ahpEnvWarningBanner')) return;

    var bar = document.createElement('div');
    bar.id = 'ahpEnvWarningBanner';
    bar.setAttribute('dir', 'rtl');
    bar.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'top:0', 'z-index:99999',
      'display:flex', 'align-items:center', 'justify-content:center',
      'gap:12px', 'flex-wrap:wrap', 'padding:10px 16px',
      'background:#7A1F1F', 'color:#fff', 'font-size:13px',
      'font-family:Cairo,Tahoma,Arial,sans-serif',
      'box-shadow:0 2px 10px rgba(0,0,0,0.25)'
    ].join(';');

    var msg = document.createElement('span');
    msg.textContent = '\u26A0\uFE0F أنت تستخدم متصفحًا داخل تطبيق آخر — بياناتك قد لا تُحفظ هنا بشكل موثوق. يُفضّل فتح الرابط في متصفحك الأساسي (Chrome).';
    bar.appendChild(msg);

    var copyBtn = document.createElement('button');
    copyBtn.textContent = 'نسخ الرابط';
    copyBtn.style.cssText = 'background:#fff;color:#7A1F1F;border:none;border-radius:6px;padding:6px 14px;font-size:13px;cursor:pointer;font-family:inherit;font-weight:700;';
    copyBtn.onclick = function () {
      var url = location.href;
      var done = function () {
        copyBtn.textContent = 'تم النسخ ✓';
        setTimeout(function () { copyBtn.textContent = 'نسخ الرابط'; }, 2000);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done).catch(function () { prompt('انسخ الرابط يدويًا:', url); });
      } else {
        prompt('انسخ الرابط يدويًا:', url);
      }
    };
    bar.appendChild(copyBtn);

    var dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'إخفاء';
    dismissBtn.style.cssText = 'background:transparent;color:#fff;border:1px solid rgba(255,255,255,0.5);border-radius:6px;padding:6px 14px;font-size:13px;cursor:pointer;font-family:inherit;';
    dismissBtn.onclick = function () {
      try { sessionStorage.setItem('ahp_env_warning_dismissed_v1', '1'); } catch (e) {}
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    };
    bar.appendChild(dismissBtn);

    document.body.appendChild(bar);
  }

  if (document.body) {
    showBanner();
  } else {
    document.addEventListener('DOMContentLoaded', showBanner);
  }
})();
