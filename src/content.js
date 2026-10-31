/*
 * The Blip - content script (isolated world).
 * Bridges settings and popup commands to the page script, hosts the hidden
 * hand-tracker iframe, mutes the mic via Meet's own button, and draws the
 * small Material-style overlay (button, banner, snackbar).
 */
(() => {
  'use strict';
  if (window.__meetVanishContent) return;
  window.__meetVanishContent = true;

  const DEFAULTS = { enabled: true, gestureEnabled: true, returnSec: 60, muteMic: true, sensitivity: 50 };
  let settings = { ...DEFAULTS };
  let st = { cam: false, state: 'live', hasBg: false, bgTime: 0, detectorReady: false, detectorError: '', hand: false, returnAt: 0 };

  const toMain = (type, data) =>
    window.postMessage({ __mv: true, to: 'main', type, ...(data || {}) }, location.origin);

  // ---------------------------------------------------------- settings ----
  function pushConfig() {
    toMain('config', {
      cfg: {
        enabled: settings.enabled,
        gestureEnabled: settings.gestureEnabled,
        returnSec: settings.returnSec,
        sensitivity: settings.sensitivity,
      },
    });
    syncDetector();
    render();
  }

  chrome.storage.local.get('mvSettings', (r) => {
    settings = { ...DEFAULTS, ...(r.mvSettings || {}) };
    pushConfig();
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.mvSettings) {
      settings = { ...DEFAULTS, ...(ch.mvSettings.newValue || {}) };
      pushConfig();
    }
  });

  // ------------------------------------------------- hidden detector iframe
  function syncDetector() {
    const want = settings.enabled && settings.gestureEnabled && st.cam;
    const el = document.getElementById('mv-detector-frame');
    if (want && !el) {
      const f = document.createElement('iframe');
      f.id = 'mv-detector-frame';
      f.src = chrome.runtime.getURL('detector/detector.html');
      f.setAttribute('aria-hidden', 'true');
      f.tabIndex = -1;
      f.style.cssText =
        'position:fixed;left:-9999px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
      (document.body || document.documentElement).appendChild(f);
    } else if (!want && el) {
      el.remove();
      toMain('detectorGone');
    }
  }

  // ------------------------------------------------------------ mic mute --
  let weMuted = false;
  let weTrackMuted = false;

  function findMicButton() {
    const btns = document.querySelectorAll('button[data-is-muted]');
    for (const b of btns) {
      const label = b.getAttribute('aria-label') || '';
      if (/(ctrl|⌘|cmd)\s*\+\s*d\b/i.test(label) || /micro/i.test(label)) return b;
    }
    return null;
  }

  function muteMic() {
    if (!settings.muteMic) return;
    const b = findMicButton();
    if (b) {
      if (b.getAttribute('data-is-muted') === 'false') {
        b.click();
        weMuted = true;
      }
    } else {
      toMain('audioEnabled', { value: false });
      weTrackMuted = true;
    }
  }

  function unmuteMic() {
    if (weMuted) {
      const b = findMicButton();
      if (b && b.getAttribute('data-is-muted') === 'true') b.click();
      weMuted = false;
    }
    if (weTrackMuted) {
      toMain('audioEnabled', { value: true });
      weTrackMuted = false;
    }
  }

  // ---------------------------------------------------------------- UI ----
  const host = document.createElement('div');
  host.id = 'mv-root';
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .root { font-family: "Google Sans", "Google Sans Text", Roboto, Arial, sans-serif; color: #1f1f1f; }
      button { font: inherit; cursor: pointer; border: 0; outline: none; }

      .banner { position: fixed; top: 20px; left: 50%; transform: translate(-50%, -140%); width: min(420px, calc(100vw - 32px));
        background: #fff; border-radius: 16px; padding: 16px 20px 12px; pointer-events: auto;
        box-shadow: 0 4px 8px 3px rgba(0,0,0,.15), 0 1px 3px rgba(0,0,0,.3);
        transition: transform .25s cubic-bezier(.2,0,0,1); }
      .banner.show { transform: translate(-50%, 0); }
      .banner h2 { margin: 0 0 4px; font-size: 16px; line-height: 24px; font-weight: 500; }
      .banner p { margin: 0 0 12px; font-size: 14px; line-height: 20px; color: #444746; }
      .bar { height: 4px; border-radius: 2px; background: #d3e3fd; overflow: hidden; }
      .bar > i { display: block; height: 100%; width: 0; background: #0b57d0; transition: width .2s linear; }
      .actions { display: flex; justify-content: flex-end; margin-top: 8px; }
      .text { height: 36px; padding: 0 12px; border-radius: 18px; background: transparent; color: #0b57d0; font-size: 14px; font-weight: 500; }
      .text:hover { background: rgba(11,87,208,.08); }

      .snack { position: fixed; left: 50%; bottom: 64px; transform: translate(-50%, 24px); opacity: 0; pointer-events: none;
        background: #202124; color: #f8f9fa; border-radius: 8px; padding: 12px 20px; font-size: 14px; line-height: 20px; max-width: min(480px, calc(100vw - 32px));
        box-shadow: 0 3px 5px -1px rgba(0,0,0,.3), 0 6px 10px rgba(0,0,0,.2), 0 1px 18px rgba(0,0,0,.15);
        transition: opacity .25s cubic-bezier(.2,0,0,1), transform .25s cubic-bezier(.2,0,0,1); z-index: 10; border: 1px solid rgba(255,255,255,.1); }
      .snack.show { opacity: 1; transform: translate(-50%, 0); }
    </style>
    <div class="root">
      <div class="banner" id="banner" role="status" aria-live="polite">
        <h2>Step out of the frame</h2>
        <p id="bannerText"></p>
        <div class="bar"><i id="bar"></i></div>
        <div class="actions"><button class="text" id="cancel" type="button">Cancel</button></div>
      </div>
      <div class="snack" id="snack" role="status" aria-live="polite"></div>
    </div>`;

  const $ = (id) => shadow.getElementById(id);
  const banner = $('banner'), bannerText = $('bannerText'), bar = $('bar'), snack = $('snack');

  let snackTimer = 0;
  function showSnack(text) {
    snack.textContent = text;
    snack.classList.add('show');
    clearTimeout(snackTimer);
    snackTimer = setTimeout(() => snack.classList.remove('show'), 4000);
  }

  function render() {
    // Dock button is removed from screen to keep Google Meet's call interface clean.
  }

  // ------------------------------------------------ keyboard shortcuts ----
  window.addEventListener('keydown', (e) => {
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

    // Alt+V or Ctrl+Shift+V to toggle Vanish / Return
    if ((e.altKey && e.code === 'KeyV') || (e.ctrlKey && e.shiftKey && e.code === 'KeyV')) {
      e.preventDefault();
      toMain('toggle');
    }
    // Alt+C to capture background
    else if (e.altKey && e.code === 'KeyC') {
      e.preventDefault();
      startCapture();
    }
  });

  // --------------------------------------------------- background capture --
  let capturing = false;
  let capTimer = 0;
  function startCapture() {
    if (capturing || !st.cam) return;
    if (st.state !== 'live') { showSnack('Return first, then capture the background.'); return; }
    capturing = true;
    const total = 5;
    const t0 = Date.now();
    banner.classList.add('show');
    render();
    const tick = () => {
      const left = total - (Date.now() - t0) / 1000;
      if (left <= 0) {
        clearInterval(capTimer);
        banner.classList.remove('show');
        capturing = false;
        toMain('captureBg');
        render();
        return;
      }
      bannerText.textContent = `Capturing your empty room in ${Math.ceil(left)}… Keep the light steady.`;
      bar.style.width = ((total - left) / total) * 100 + '%';
    };
    tick();
    capTimer = setInterval(tick, 200);
  }
  $('cancel').addEventListener('click', () => {
    clearInterval(capTimer);
    banner.classList.remove('show');
    capturing = false;
    render();
  });

  // -------------------------------------------------- messages from page ---
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.__mv !== true || d.to !== 'content') return;
    switch (d.type) {
      case 'state': {
        const prev = st;
        st = d.st;
        if (prev.cam !== st.cam) {
          syncDetector();
          if (!st.cam) unmuteMic();
        }
        if (prev.state !== st.state) {
          if (st.state === 'gone') showSnack('Vanished. Snap or press Alt+V to return.');
          else if (st.state === 'live' && prev.state === 'in') showSnack('Welcome back.');
        }
        render();
        break;
      }
      case 'toast': showSnack(d.text); break;
      case 'need-bg': render(); break;
      case 'vanishing': muteMic(); break;
      case 'returning': unmuteMic(); break;
    }
  });

  // ------------------------------------------------ messages from popup ----
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg && msg.type) {
      case 'getStatus':
        toMain('ping');
        reply({ st, capturing });
        return;
      case 'capture': startCapture(); reply({ ok: true }); return;
      case 'toggle': toMain('toggle'); reply({ ok: true }); return;
    }
  });

  // mount
  const mount = () => (document.body || document.documentElement).appendChild(host);
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
