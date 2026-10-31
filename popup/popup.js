(() => {
  'use strict';

  const DEFAULTS = { enabled: true, gestureEnabled: true, returnSec: 60, muteMic: true, sensitivity: 50 };
  let settings = { ...DEFAULTS };

  const $ = (id) => document.getElementById(id);
  const els = {
    enabled: $('enabled'), gestureEnabled: $('gestureEnabled'), muteMic: $('muteMic'),
    sensitivity: $('sensitivity'), seg: $('returnSeg'),
    chipMeet: $('chipMeet'), chipHand: $('chipHand'), chipBg: $('chipBg'),
    vMeet: $('vMeet'), vHand: $('vHand'), vBg: $('vBg'),
    capture: $('capture'), toggle: $('toggle'), hint: $('hint'),
  };

  // ------------------------------------------------------------ settings --
  function save() { chrome.storage.local.set({ mvSettings: settings }); }

  function paintSettings() {
    els.enabled.checked = settings.enabled;
    els.gestureEnabled.checked = settings.gestureEnabled;
    els.muteMic.checked = settings.muteMic;
    els.sensitivity.value = settings.sensitivity;
    els.seg.querySelectorAll('button').forEach((b) =>
      b.setAttribute('aria-checked', String(Number(b.dataset.v) === settings.returnSec)));
  }

  ['enabled', 'gestureEnabled', 'muteMic'].forEach((k) =>
    els[k].addEventListener('change', () => { settings[k] = els[k].checked; save(); refresh(); }));
  els.sensitivity.addEventListener('input', () => { settings.sensitivity = Number(els.sensitivity.value); save(); });
  els.seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    settings.returnSec = Number(b.dataset.v);
    save();
    paintSettings();
  });

  // -------------------------------------------------------------- status --
  async function meetTab() {
    const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
    return tabs.find((t) => t.active && t.lastFocusedWindow) || tabs.find((t) => t.active) || tabs[0] || null;
  }

  const send = async (msg) => {
    const tab = await meetTab();
    if (!tab) return null;
    try { return await chrome.tabs.sendMessage(tab.id, msg); } catch (e) { return null; }
  };

  function chip(el, val, cls, text) {
    el.className = 'chip ' + cls;
    val.textContent = text;
  }

  function ago(ts) {
    const m = Math.floor((Date.now() - ts) / 60000);
    return m < 1 ? 'just now' : m + ' min ago';
  }

  async function refresh() {
    const r = await send({ type: 'getStatus' });
    const st = r && r.st;

    if (!settings.enabled) {
      chip(els.chipMeet, els.vMeet, '', 'Off');
      chip(els.chipHand, els.vHand, '', 'Off');
      chip(els.chipBg, els.vBg, '', st && st.hasBg ? 'Saved' : 'Not saved');
      els.capture.disabled = true; els.toggle.disabled = true;
      els.hint.textContent = 'Turn The Blip on to use it in a call.';
      return;
    }

    if (!r) {
      chip(els.chipMeet, els.vMeet, 'bad', 'No Meet tab');
      chip(els.chipHand, els.vHand, '', '–');
      chip(els.chipBg, els.vBg, '', '–');
      els.capture.disabled = true; els.toggle.disabled = true;
      els.toggle.textContent = 'Vanish now';
      els.hint.textContent = 'Open a Google Meet call (reload the tab once after installing).';
      return;
    }

    if (!st.cam) chip(els.chipMeet, els.vMeet, 'warn', 'Camera is off');
    else chip(els.chipMeet, els.vMeet, 'ok', 'Camera on');

    if (!settings.gestureEnabled) chip(els.chipHand, els.vHand, '', 'Gesture off');
    else if (!st.cam) chip(els.chipHand, els.vHand, '', 'Waiting for camera');
    else if (st.detectorError) chip(els.chipHand, els.vHand, 'bad', 'Failed to load');
    else if (!st.detectorReady) chip(els.chipHand, els.vHand, 'warn', 'Loading…');
    else chip(els.chipHand, els.vHand, 'ok', st.hand ? 'Hand seen' : 'Ready');

    if (st.hasBg) chip(els.chipBg, els.vBg, 'ok', 'Saved · ' + ago(st.bgTime));
    else chip(els.chipBg, els.vBg, 'warn', 'Not captured');

    const animating = st.state === 'out' || st.state === 'in';
    els.capture.disabled = !st.cam || st.state !== 'live' || r.capturing;
    els.capture.textContent = st.hasBg ? 'Recapture background' : 'Capture background';
    els.toggle.disabled = !st.cam || !st.hasBg || animating;
    els.toggle.textContent = st.state === 'gone' ? 'Return' : 'Vanish now';

    if (st.detectorError) els.hint.textContent = 'Hand tracker could not start. Use buttons or press Alt+V.';
    else if (!st.cam) els.hint.textContent = 'Join a call and turn your camera on.';
    else if (!st.hasBg) els.hint.textContent = 'Step out of frame, capture the empty room once, then snap.';
    else if (st.state === 'gone') els.hint.textContent = 'You are vanished. Snap again or press Alt+V to come back.';
    else els.hint.textContent = 'Hold thumb + middle finger together, then snap (or press Alt+V).';
  }

  els.capture.addEventListener('click', async () => {
    await send({ type: 'capture' });
    window.close();
  });
  els.toggle.addEventListener('click', async () => {
    await send({ type: 'toggle' });
    setTimeout(refresh, 150);
  });

  chrome.storage.local.get('mvSettings', (r) => {
    settings = { ...DEFAULTS, ...(r.mvSettings || {}) };
    paintSettings();
    refresh();
    setInterval(refresh, 1000);
  });
})();
