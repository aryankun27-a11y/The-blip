/*
 * The Blip - page-world script.
 * Wraps the camera stream Meet receives, so we can dissolve "you" into dust
 * and show the empty room instead. Runs in the MAIN world at document_start.
 */
(() => {
  'use strict';
  if (window.__meetVanish) return;
  window.__meetVanish = true;

  // ---------------------------------------------------------------- state --
  const cfg = { enabled: true, gestureEnabled: true, returnSec: 60, sensitivity: 50 };
  const st = {
    cam: false,          // a processed camera stream is active
    state: 'live',       // live | out | gone | in
    hasBg: false,
    bgTime: 0,
    detectorReady: false,
    detectorError: '',
    hand: false,
    returnAt: 0,
  };
  let pipe = null;                 // active pipeline
  let bgStore = null;              // { w, h, data: Uint8ClampedArray }
  const audioTracks = new Set();
  let returnTimer = 0;

  const post = (type, data) =>
    window.postMessage({ __mv: true, to: 'content', type, ...(data || {}) }, location.origin);
  const pushState = () => post('state', { st: { ...st } });
  const toast = (text) => post('toast', { text });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------- tuning values ---
  const OUT_DURATION = 2.6;   // seconds for the dissolve
  const IN_DURATION = 1.8;    // seconds for the reform

  // small deterministic-ish random helpers
  const rnd = Math.random;
  function hash2(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  // ------------------------------------------------------------ pipeline ---
  function createPipeline(vTrack) {
    const s = vTrack.getSettings();
    const w = s.width || 640;
    const h = s.height || 480;
    const cell = Math.max(3, Math.round(w / 220));
    const gw = Math.ceil(w / cell);
    const gh = Math.ceil(h / cell);

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([vTrack]);
    video.play().catch(() => {});

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: false });

    const work = document.createElement('canvas');
    work.width = w;
    work.height = h;
    const wctx = work.getContext('2d', { willReadFrequently: true });

    // static frames (canvases) used while the effect plays
    const sCanvas = document.createElement('canvas'); // snapshot when snapped
    sCanvas.width = w; sCanvas.height = h;
    const gCanvas = document.createElement('canvas'); // snapshot minus you
    gCanvas.width = w; gCanvas.height = h;

    // dynamic dissolving base canvas (reveals empty room underneath)
    const baseCanvas = document.createElement('canvas');
    baseCanvas.width = w; baseCanvas.height = h;
    const baseCtx = baseCanvas.getContext('2d');
    let baseImageData = null;
    let base32 = null;

    // dedicated overlay canvas for active dust particles
    const partCanvas = document.createElement('canvas');
    partCanvas.width = w; partCanvas.height = h;
    const partCtx = partCanvas.getContext('2d');
    const partImg = partCtx.createImageData(w, h);
    const part32 = new Uint32Array(partImg.data.buffer);

    // subtle sensor noise so the empty room does not look frozen
    const noise = document.createElement('canvas');
    noise.width = noise.height = 192;
    {
      const nctx = noise.getContext('2d');
      const nd = nctx.createImageData(192, 192);
      for (let i = 0; i < nd.data.length; i += 4) {
        const v = rnd() * 255;
        nd.data[i] = nd.data[i + 1] = nd.data[i + 2] = v;
        nd.data[i + 3] = 255;
      }
      nctx.putImageData(nd, 0, 0);
    }

    const P = {
      track: vTrack, w, h, cell, gw, gh, video, canvas,
      mode: 'live',
      t0: 0,
      dur: OUT_DURATION,
      parts: null,        // particle arrays
      G32: null,          // "empty room" frame (Uint32)
      L32: null,          // reform frame (Uint32)
      detTimer: 0,
      detBusy: false,
      detBusyAt: 0,
      destroyed: false,
    };

    const grab = () => {
      wctx.drawImage(video, 0, 0, w, h);
      return wctx.getImageData(0, 0, w, h);
    };

    // ---- background capture ------------------------------------------------
    P.captureBg = async () => {
      const n = 14;
      const acc = new Uint32Array(w * h * 4);
      for (let i = 0; i < n; i++) {
        await sleep(50);
        const d = grab().data;
        for (let k = 0; k < d.length; k++) acc[k] += d[k];
      }
      const data = new Uint8ClampedArray(w * h * 4);
      for (let k = 0; k < data.length; k++) data[k] = acc[k] / n;
      bgStore = { w, h, data };
      st.hasBg = true;
      st.bgTime = Date.now();
      pushState();
    };

    // ---- mask: where are "you" compared to the empty room ------------------
    function computeMask(S) {
      const s8 = S.data;
      const b8 = bgStore.data;

      // Sample border areas (top 15%, left 15%, right 15%) so person in center does not bias exposure
      const rr = [], gg = [], bb = [];
      const step = Math.max(3, Math.round(w / 100));
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const isBorder = (y < h * 0.15) || (x < w * 0.15) || (x > w * 0.85);
          if (!isBorder) continue;
          const i = (y * w + x) * 4;
          rr.push((s8[i] + 8) / (b8[i] + 8));
          gg.push((s8[i + 1] + 8) / (b8[i + 1] + 8));
          bb.push((s8[i + 2] + 8) / (b8[i + 2] + 8));
        }
      }
      const med = (a) => {
        if (!a.length) return 1.0;
        a.sort((x, y) => x - y);
        return Math.min(1.6, Math.max(0.6, a[a.length >> 1] || 1));
      };
      const gain = [med(rr), med(gg), med(bb)];

      const bgAdj = new Uint8ClampedArray(b8.length);
      for (let i = 0; i < b8.length; i += 4) {
        bgAdj[i] = Math.min(255, b8[i] * gain[0]);
        bgAdj[i + 1] = Math.min(255, b8[i + 1] * gain[1]);
        bgAdj[i + 2] = Math.min(255, b8[i + 2] * gain[2]);
        bgAdj[i + 3] = 255;
      }

      // Per-cell colour difference using perceptual Euclidean distance
      const d = new Float32Array(gw * gh);
      const c = cell;
      const offs = [[c >> 1, c >> 1], [0, 0], [c - 1, 0], [0, c - 1], [c - 1, c - 1]];
      for (let gy = 0; gy < gh; gy++) {
        for (let gx = 0; gx < gw; gx++) {
          let sum = 0;
          for (let k = 0; k < offs.length; k++) {
            const px = Math.min(w - 1, gx * c + offs[k][0]);
            const py = Math.min(h - 1, gy * c + offs[k][1]);
            const i = (py * w + px) * 4;
            const dr = s8[i] - bgAdj[i];
            const dg = s8[i + 1] - bgAdj[i + 1];
            const db = s8[i + 2] - bgAdj[i + 2];
            sum += Math.sqrt(0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db);
          }
          d[gy * gw + gx] = sum / offs.length;
        }
      }

      // 3x3 box smooth and threshold
      const thr = 36 - cfg.sensitivity * 0.24;
      const sm = new Float32Array(gw * gh);
      for (let gy = 0; gy < gh; gy++) {
        for (let gx = 0; gx < gw; gx++) {
          let t = 0, n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const x = gx + dx, y = gy + dy;
              if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
              t += d[y * gw + x]; n++;
            }
          }
          sm[gy * gw + gx] = t / n;
        }
      }
      const m = new Uint8Array(gw * gh);
      for (let i = 0; i < m.length; i++) m[i] = sm[i] > thr ? 1 : 0;

      // Majority clean-up & hole fill (without harsh dilation)
      const cnt = (arr, gx, gy) => {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const x = gx + dx, y = gy + dy;
            if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
            n += arr[y * gw + x];
          }
        }
        return n;
      };
      const m2 = new Uint8Array(gw * gh);
      for (let gy = 0; gy < gh; gy++) {
        for (let gx = 0; gx < gw; gx++) {
          const n = cnt(m, gx, gy);
          const self = m[gy * gw + gx];
          m2[gy * gw + gx] = (n >= 5 || (self && n >= 2)) ? 1 : 0;
        }
      }
      const m3 = new Uint8Array(gw * gh);
      let count = 0;
      for (let gy = 0; gy < gh; gy++) {
        for (let gx = 0; gx < gw; gx++) {
          const self = m2[gy * gw + gx];
          const n = cnt(m2, gx, gy);
          const v = self || (n >= 3) ? 1 : 0;
          m3[gy * gw + gx] = v;
          count += v;
        }
      }
      return { mask: m3, count, bgAdj };
    }

    // ---- particles --------------------------------------------------------
    function buildParticles(S, mask, count, reverse, dur) {
      const s8 = S.data;
      const scale = w / 640;
      const px = new Float32Array(count), py = new Float32Array(count);
      const start = new Float32Array(count), life = new Float32Array(count);
      const vx = new Float32Array(count), vy = new Float32Array(count);
      const col32 = new Uint32Array(count);
      const gxs = new Int16Array(count), gys = new Int16Array(count);
      let k = 0;
      const maxLife = 1.3;
      for (let gy = 0; gy < gh; gy++) {
        for (let gx = 0; gx < gw; gx++) {
          if (!mask[gy * gw + gx]) continue;
          const hx = gx * cell, hy = gy * cell;
          px[k] = hx; py[k] = hy;
          gxs[k] = gx; gys[k] = gy;
          // sweep across the frame with patchy noise
          const bn = hash2(gx >> 3, gy >> 3);
          let dly = 0.5 * (gx / gw) + 0.3 * bn + 0.2 * rnd();
          if (reverse) dly = 0.5 * (1 - gx / gw) + 0.3 * bn + 0.2 * rnd();
          start[k] = dly * Math.max(0.1, dur - maxLife);
          life[k] = 0.8 + rnd() * 0.5;
          vx[k] = (140 + rnd() * 150) * scale;
          vy[k] = (-25 - rnd() * 120 + (rnd() - 0.5) * 50) * scale;
          const ci = (Math.min(h - 1, hy + (cell >> 1)) * w + Math.min(w - 1, hx + (cell >> 1))) * 4;
          const r = s8[ci], g = s8[ci + 1], b = s8[ci + 2];
          col32[k] = (b << 16) | (g << 8) | r;
          k++;
        }
      }
      return { n: count, px, py, gx: gxs, gy: gys, start, life, vx, vy, col32 };
    }

    function putCanvas(cv, imgData) {
      cv.getContext('2d').putImageData(imgData, 0, 0);
    }

    // ---- start / stop the effect ------------------------------------------
    P.vanish = () => {
      if (P.mode !== 'live' || !bgStore || bgStore.w !== w || bgStore.h !== h) return false;
      const S = grab();
      const { mask, count, bgAdj } = computeMask(S);
      if (count < 30) toast("Couldn't find you against the background. Try recapturing it.");
      else if (count > gw * gh * 0.85) toast('Background looks different from now. Recapture it for a clean vanish.');

      // G = snapshot with the person cells swapped for the empty room
      const G = new ImageData(new Uint8ClampedArray(S.data), w, h);
      const g8 = G.data;
      for (let gy = 0; gy < gh; gy++) {
        for (let gx = 0; gx < gw; gx++) {
          if (!mask[gy * gw + gx]) continue;
          const x0 = gx * cell, y0 = gy * cell;
          const x1 = Math.min(w, x0 + cell), y1 = Math.min(h, y0 + cell);
          for (let y = y0; y < y1; y++) {
            const row = y * w;
            for (let x = x0; x < x1; x++) {
              const i = (row + x) * 4;
              g8[i] = bgAdj[i]; g8[i + 1] = bgAdj[i + 1]; g8[i + 2] = bgAdj[i + 2]; g8[i + 3] = 255;
            }
          }
        }
      }
      putCanvas(sCanvas, S);
      putCanvas(gCanvas, G);
      P.G32 = new Uint32Array(g8.buffer);

      // Initialize baseCanvas with sCanvas (person visible)
      baseCtx.drawImage(sCanvas, 0, 0);
      baseImageData = baseCtx.getImageData(0, 0, w, h);
      base32 = new Uint32Array(baseImageData.data.buffer);

      P.mask = mask;
      P.maskCount = count;
      P.parts = buildParticles(S, mask, count, false, OUT_DURATION);
      P.released = new Uint8Array(count);
      P.dur = OUT_DURATION;
      P.t0 = performance.now();
      P.mode = 'out';
      st.state = 'out';
      st.returnAt = 0;
      pushState();
      return true;
    };

    P.reform = () => {
      if (P.mode !== 'gone' || !P.G32) return false;
      const L = grab();
      const { mask, count } = computeMask(L);
      if (count < 30) {
        // nobody in frame: just go live
        P.mode = 'live';
        st.state = 'live';
        st.returnAt = 0;
        pushState();
        return true;
      }

      // Initialize baseCanvas with gCanvas (empty room)
      baseCtx.drawImage(gCanvas, 0, 0);
      baseImageData = baseCtx.getImageData(0, 0, w, h);
      base32 = new Uint32Array(baseImageData.data.buffer);

      P.L32 = new Uint32Array(L.data.buffer);
      P.mask = mask;
      P.maskCount = count;
      P.parts = buildParticles(L, mask, count, true, IN_DURATION);
      P.landed = new Uint8Array(count);
      P.dur = IN_DURATION;
      P.t0 = performance.now();
      P.mode = 'in';
      st.state = 'in';
      st.returnAt = 0;
      pushState();
      return true;
    };

    // ---- frame renderer ----------------------------------------------------
    const noisePattern = ctx.createPattern(noise, 'repeat');
    function drawNoise() {
      ctx.save();
      ctx.globalAlpha = 0.04;
      ctx.globalCompositeOperation = 'overlay';
      ctx.translate(-((rnd() * 192) | 0), -((rnd() * 192) | 0));
      ctx.fillStyle = noisePattern;
      ctx.fillRect(0, 0, w + 192, h + 192);
      ctx.restore();
    }

    function renderOut(now) {
      const t = (now - P.t0) / 1000;
      const pr = P.parts;
      const sc = w / 640;
      let allDone = true;
      let baseDirty = false;
      const G32 = P.G32;

      // 1. Reveal empty room for newly dissolved cells (each cell copied once)
      for (let i = 0; i < pr.n; i++) {
        const elapsed = t - pr.start[i];
        if (elapsed < pr.life[i]) allDone = false;
        if (elapsed <= 0) continue;
        if (!P.released[i]) {
          P.released[i] = 1;
          baseDirty = true;
          const gx = pr.gx[i], gy = pr.gy[i];
          const x0 = gx * cell, y0 = gy * cell;
          const x1 = Math.min(w, x0 + cell), y1 = Math.min(h, y0 + cell);
          for (let y = y0; y < y1; y++) {
            const row = y * w;
            for (let x = x0; x < x1; x++) base32[row + x] = G32[row + x];
          }
        }
      }
      if (baseDirty) {
        baseCtx.putImageData(baseImageData, 0, 0);
      }

      ctx.drawImage(baseCanvas, 0, 0);

      // 2. Render active floating particles
      part32.fill(0);
      for (let i = 0; i < pr.n; i++) {
        const elapsed = t - pr.start[i];
        if (elapsed <= 0 || elapsed >= pr.life[i]) continue;
        const p = elapsed / pr.life[i];
        const e = 1 - (1 - p) * (1 - p);
        const a = (Math.pow(1 - p, 1.3) * 255) | 0;
        if (a <= 0) continue;
        const col = (a << 24) | pr.col32[i];
        const px = (pr.px[i] + pr.vx[i] * e) | 0;
        const py = (pr.py[i] + pr.vy[i] * e + 30 * sc * p * p) | 0;
        const size = Math.max(1, Math.round(cell * (1 - 0.35 * p)));
        for (let dy = 0; dy < size; dy++) {
          const yy = py + dy;
          if (yy < 0 || yy >= h) continue;
          const row = yy * w;
          for (let dx = 0; dx < size; dx++) {
            const xx = px + dx;
            if (xx < 0 || xx >= w) continue;
            part32[row + xx] = col;
          }
        }
      }
      partCtx.putImageData(partImg, 0, 0);
      ctx.drawImage(partCanvas, 0, 0);

      if (allDone && t >= P.dur - 0.05) {
        P.mode = 'gone';
        st.state = 'gone';
        st.returnAt = cfg.returnSec > 0 ? Date.now() + cfg.returnSec * 1000 : 0;
        clearTimeout(returnTimer);
        if (cfg.returnSec > 0) returnTimer = setTimeout(() => api.return(), cfg.returnSec * 1000);
        pushState();
        post('vanished');
      }
    }

    function renderIn(now) {
      const t = (now - P.t0) / 1000;
      const pr = P.parts;
      const sc = w / 640;
      let allDone = true;
      let baseDirty = false;
      const L32 = P.L32;

      // 1. Restore cells that landed
      for (let i = 0; i < pr.n; i++) {
        const elapsed = t - pr.start[i];
        if (elapsed < pr.life[i]) {
          allDone = false;
        } else if (!P.landed[i]) {
          P.landed[i] = 1;
          baseDirty = true;
          const gx = pr.gx[i], gy = pr.gy[i];
          const x0 = gx * cell, y0 = gy * cell;
          const x1 = Math.min(w, x0 + cell), y1 = Math.min(h, y0 + cell);
          for (let y = y0; y < y1; y++) {
            const row = y * w;
            for (let x = x0; x < x1; x++) base32[row + x] = L32[row + x];
          }
        }
      }
      if (baseDirty) {
        baseCtx.putImageData(baseImageData, 0, 0);
      }

      ctx.drawImage(baseCanvas, 0, 0);

      // 2. Render flying incoming particles
      part32.fill(0);
      for (let i = 0; i < pr.n; i++) {
        const elapsed = t - pr.start[i];
        if (elapsed <= 0 || elapsed >= pr.life[i]) continue;
        const p = elapsed / pr.life[i];
        const back = (1 - p) * (1 - p);
        const a = (Math.pow(p, 1.1) * 255) | 0;
        if (a <= 0) continue;
        const col = (a << 24) | pr.col32[i];
        const px = (pr.px[i] + pr.vx[i] * back) | 0;
        const py = (pr.py[i] + pr.vy[i] * back + 30 * sc * back) | 0;
        const size = Math.max(1, Math.round(cell * (0.65 + 0.35 * p)));
        for (let dy = 0; dy < size; dy++) {
          const yy = py + dy;
          if (yy < 0 || yy >= h) continue;
          const row = yy * w;
          for (let dx = 0; dx < size; dx++) {
            const xx = px + dx;
            if (xx < 0 || xx >= w) continue;
            part32[row + xx] = col;
          }
        }
      }
      partCtx.putImageData(partImg, 0, 0);
      ctx.drawImage(partCanvas, 0, 0);

      if (allDone && t >= P.dur - 0.05) {
        P.mode = 'live';
        st.state = 'live';
        pushState();
        post('returned');
      }
    }

    P.tick = (now) => {
      if (P.destroyed) return;
      if (video.readyState < 2) return;
      const time = now || performance.now();
      switch (P.mode) {
        case 'live':
          ctx.drawImage(video, 0, 0, w, h);
          break;
        case 'out':
          renderOut(time);
          break;
        case 'gone':
          ctx.drawImage(gCanvas, 0, 0);
          drawNoise();
          break;
        case 'in':
          renderIn(time);
          break;
      }
    };

    // Driven by requestAnimationFrame for jitter-free 60+ FPS rendering synced to display
    let rafId = 0;
    function frameLoop(now) {
      if (P.destroyed) return;
      P.tick(now);
      rafId = requestAnimationFrame(frameLoop);
    }
    rafId = requestAnimationFrame(frameLoop);

    // ---- gesture frames -> detector iframe ---------------------------------
    P.detect = async () => {
      if (P.destroyed || pipe !== P || !cfg.enabled || !cfg.gestureEnabled || !st.detectorReady) return;
      if (P.mode === 'out' || P.mode === 'in') return; // Pause hand detector during animations
      if (video.readyState < 2) return;
      const now = performance.now();
      if (P.detBusy && now - P.detBusyAt < 600) return;
      const frame = document.getElementById('mv-detector-frame');
      if (!frame || !frame.contentWindow) return;
      P.detBusy = true;
      P.detBusyAt = now;
      try {
        const rw = 256;
        const rh = Math.max(1, Math.round((256 * h) / w));
        const bmp = await createImageBitmap(video, { resizeWidth: rw, resizeHeight: rh, resizeQuality: 'low' });
        frame.contentWindow.postMessage({ __mv: true, to: 'detector', type: 'frame', bitmap: bmp, aspect: w / h }, '*', [bmp]);
      } catch (e) {
        P.detBusy = false;
      }
    };

    P.detTimer = setInterval(P.detect, 100);

    P.destroy = () => {
      if (P.destroyed) return;
      P.destroyed = true;
      cancelAnimationFrame(rafId);
      clearInterval(P.detTimer);
      clearTimeout(returnTimer);
      video.srcObject = null;
      if (pipe === P) {
        pipe = null;
        st.cam = false;
        st.state = 'live';
        st.returnAt = 0;
        st.hand = false;
        pushState();
      }
    };

    return P;
  }

  // ------------------------------------------------------ stream wrapping ---
  async function wrapStream(stream) {
    const vTrack = stream.getVideoTracks()[0];
    stream.getAudioTracks().forEach((t) => audioTracks.add(t));
    if (!vTrack) return stream;

    const P = createPipeline(vTrack);
    // wait for first frame so the canvas has the right content immediately
    await new Promise((res) => {
      if (P.video.readyState >= 2) return res();
      P.video.addEventListener('loadeddata', () => res(), { once: true });
      setTimeout(res, 1500);
    });
    P.tick();

    // Meet may open a preview stream and a call stream; keep older ones
    // running until Meet stops their tracks, but control the newest one.
    pipe = P;
    st.cam = true;
    st.state = 'live';
    pushState();

    const base = vTrack.getSettings();
    const fps = base.frameRate || 30;
    const outTrack = P.canvas.captureStream(fps).getVideoTracks()[0];
    const origStop = outTrack.stop.bind(outTrack);
    outTrack.stop = () => {
      origStop();
      try { vTrack.stop(); } catch (e) {}
      P.destroy();
    };
    // Meet adjusts constraints on the camera track; the canvas track can't,
    // so swallow those calls instead of throwing.
    outTrack.applyConstraints = async () => {};
    outTrack.getSettings = () => ({ ...base, width: P.w, height: P.h, frameRate: fps });
    try {
      Object.defineProperty(outTrack, 'label', { value: vTrack.label, configurable: true });
    } catch (e) {}

    return new MediaStream([outTrack, ...stream.getAudioTracks()]);
  }

  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async function (constraints) {
      const stream = await orig(constraints);
      try {
        if (constraints && constraints.video) return await wrapStream(stream);
        stream.getAudioTracks().forEach((t) => audioTracks.add(t));
      } catch (e) {
        console.warn('[The Blip] could not wrap camera stream', e);
      }
      return stream;
    };
  }

  // ----------------------------------------------------------- public API ---
  const api = {
    vanish() {
      if (!cfg.enabled || !pipe) return;
      if (pipe.mode !== 'live') return;
      if (!st.hasBg) { toast('Capture your background first.'); post('need-bg'); return; }
      if (pipe.vanish()) post('vanishing');
    },
    return() {
      clearTimeout(returnTimer);
      if (!pipe || pipe.mode !== 'gone') return;
      if (pipe.reform()) post('returning');
    },
    toggle() {
      if (!pipe) return;
      if (pipe.mode === 'live') api.vanish();
      else if (pipe.mode === 'gone') api.return();
    },
    async captureBg() {
      if (!pipe) { toast('Turn your camera on first.'); return; }
      if (pipe.mode !== 'live') { toast('Return first, then capture the background.'); return; }
      await pipe.captureBg();
      toast('Background saved.');
    },
  };

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__mv !== true) return;

    // messages from the extension's content script
    if (e.source === window && d.to === 'main') {
      switch (d.type) {
        case 'config':
          Object.assign(cfg, d.cfg || {});
          break;
        case 'vanish': api.vanish(); break;
        case 'return': api.return(); break;
        case 'toggle': api.toggle(); break;
        case 'captureBg': api.captureBg(); break;
        case 'audioEnabled':
          audioTracks.forEach((t) => { if (t.readyState === 'live') t.enabled = !!d.value; });
          break;
        case 'detectorGone':
          st.detectorReady = false; st.hand = false; pushState(); break;
        case 'ping': pushState(); break;
      }
      return;
    }

    // messages from the hidden detector iframe
    const frame = document.getElementById('mv-detector-frame');
    if (d.to === 'main' && frame && e.source === frame.contentWindow) {
      switch (d.type) {
        case 'detector-ready':
          st.detectorReady = true; st.detectorError = ''; pushState(); break;
        case 'detector-error':
          st.detectorReady = false; st.detectorError = String(d.error || 'failed'); pushState(); break;
        case 'frame-done':
          if (pipe) pipe.detBusy = false; break;
        case 'hand':
          if (st.hand !== !!d.present) { st.hand = !!d.present; pushState(); } break;
        case 'snap':
          if (!cfg.enabled || !cfg.gestureEnabled || !pipe) break;
          if (pipe.mode === 'live') api.vanish();
          else if (pipe.mode === 'gone') api.return();
          break;
      }
    }
  });
})();
