/*
 * The Blip - hand tracker (runs in a hidden extension iframe).
 * Receives small video frames from the page, runs MediaPipe Hands fully on
 * device, and reports a "snap" when it sees the Thanos pose (thumb + middle
 * finger pressed together) followed by a quick release.
 */
(() => {
  'use strict';

  const toParent = (type, data) =>
    parent.postMessage({ __mv: true, to: 'main', type, ...(data || {}) }, '*');

  let aspect = 16 / 9;
  let busy = false;
  let ready = false;

  // gesture state
  let armedSince = 0;
  let lastPinchAt = 0;
  let armed = false;
  let cooldownUntil = 0;
  let handPresent = false;
  let lastPinchDist = 0;
  let lastPinchTime = 0;

  const PINCH_ON = 0.22;   // tight pinch: thumb tip <-> middle tip
  const PINCH_OFF = 0.45;  // crisp separation on flick
  const ARM_MS = 280;      // hold the pose with intention (280ms)
  const FLICK_MS = 380;    // flick must follow quickly
  const COOLDOWN_MS = 1800;

  function setHand(present) {
    if (present !== handPresent) {
      handPresent = present;
      toParent('hand', { present });
    }
  }

  function fire(now) {
    armed = false;
    armedSince = 0;
    if (now < cooldownUntil) return;
    cooldownUntil = now + COOLDOWN_MS;
    toParent('snap');
  }

  function onResults(res) {
    const now = performance.now();
    const lm = res.multiHandLandmarks && res.multiHandLandmarks[0];

    if (!lm) {
      // Never trigger vanish when hand simply drops or leaves camera view
      armed = false;
      armedSince = 0;
      lastPinchDist = 0;
      lastPinchTime = 0;
      setHand(false);
      return;
    }
    setHand(true);

    const d = (i, j) => Math.hypot((lm[i].x - lm[j].x) * aspect, lm[i].y - lm[j].y);
    const handSize = d(0, 9) + 1e-6;       // wrist -> middle knuckle
    const pinch = d(4, 12) / handSize;     // thumb tip -> middle fingertip

    let velocity = 0;
    if (lastPinchTime && now - lastPinchTime < 300) {
      const dt = (now - lastPinchTime) / 1000;
      if (dt > 0) velocity = (pinch - lastPinchDist) / dt;
    }
    lastPinchDist = pinch;
    lastPinchTime = now;

    if (pinch < PINCH_ON) {
      if (!armedSince) armedSince = now;
      lastPinchAt = now;
      if (now - armedSince >= ARM_MS) armed = true;
    } else if (pinch > PINCH_OFF) {
      const elapsed = now - lastPinchAt;
      // Require intentional arming, crisp flick window, and rapid separation speed
      if (armed && elapsed < FLICK_MS && velocity > 0.7) {
        fire(now);
      }
      armed = false;
      armedSince = 0;
    } else if (armed && now - lastPinchAt > FLICK_MS) {
      armed = false;
      armedSince = 0;
    }
  }

  async function init() {
    try {
      const hands = new Hands({ locateFile: (f) => 'mediapipe/' + f });
      hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 0,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.5,
        selfieMode: false,
      });
      hands.onResults(onResults);
      await hands.initialize();
      ready = true;
      toParent('detector-ready');

      window.addEventListener('message', async (e) => {
        const m = e.data;
        if (!m || m.__mv !== true || m.to !== 'detector' || m.type !== 'frame') return;
        const bmp = m.bitmap;
        if (busy || !ready) {
          if (bmp && bmp.close) bmp.close();
          toParent('frame-done');
          return;
        }
        busy = true;
        aspect = m.aspect || aspect;
        try {
          await hands.send({ image: bmp });
        } catch (err) {
          /* skip frame */
        }
        if (bmp && bmp.close) bmp.close();
        busy = false;
        toParent('frame-done');
      });
    } catch (err) {
      toParent('detector-error', { error: (err && err.message) || String(err) });
    }
  }

  init();
})();
