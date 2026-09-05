/* ============================================================
 * Z 轴编辑器 · 3D 预览模块
 * 与 tools/3d-viewer 同源的轻量轨道相机渲染器，由编辑器注入臂数据。
 * 暴露：init(canvas) / setArms(list) / setMarker(m) / playCam()
 * ============================================================ */
window.PREVIEW3D = (function () {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const smoothstep = (a, b, v) => {
    const t = clamp((v - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const easeInOutCubic = (t) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };

  let canvas, ctx;
  let W = 0, H = 0, dpr = 1, F = 600;
  const cam = { az: 0, el: 90, dist: 5.4 };
  const MOVE = { dur: 8, delay: 0.4, el: 26, az: -14, dist: 4.4 };
  let anim = null;
  let arms = [];
  let marker = null; // { name, u }
  const partsCache = {}; // 按臂名缓存粒子，避免重建时重新洗牌

  /* ---------------- sprite ---------------- */
  const spriteCache = {};
  function spriteOf(color) {
    if (!spriteCache[color]) {
      const s = 48;
      const cv = document.createElement('canvas');
      cv.width = cv.height = s;
      const c = cv.getContext('2d');
      const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.18, color + 'cc');
      g.addColorStop(0.5, color + '44');
      g.addColorStop(1, color + '00');
      c.fillStyle = g;
      c.fillRect(0, 0, s, s);
      spriteCache[color] = cv;
    }
    return spriteCache[color];
  }
  const coreSprite = spriteOf('#ffffff');
  const haloSprite = spriteOf('#dceaff');
  const core = [];
  for (let i = 0; i < 40; i++) {
    const a = Math.random() * TAU;
    const b = Math.acos(rand(-1, 1));
    const r = 0.07 * Math.pow(Math.random(), 1.6);
    core.push({
      x: r * Math.sin(b) * Math.cos(a),
      y: r * Math.cos(b) * 0.7,
      z: r * Math.sin(b) * Math.sin(a),
      sz: rand(0.5, 1.3),
      a: rand(0.4, 0.95),
    });
  }

  /* ---------------- 相机 ---------------- */
  function playCam() {
    anim = { t0: performance.now() + MOVE.delay * 1000, from: { ...cam } };
  }

  function basis() {
    const er = (cam.el * Math.PI) / 180;
    const ar = (cam.az * Math.PI) / 180;
    const eye = [
      cam.dist * Math.cos(er) * Math.sin(ar),
      cam.dist * Math.sin(er),
      cam.dist * Math.cos(er) * Math.cos(ar),
    ];
    const fwd = norm([-eye[0], -eye[1], -eye[2]]);
    const up0 = Math.abs(fwd[1]) > 0.999 ? [0, 0, -1] : [0, 1, 0];
    const right = norm(cross(fwd, up0));
    const up = cross(right, fwd);
    return { right, up, fwd, dist: cam.dist };
  }

  function project(p, B) {
    const vz = p.x * B.fwd[0] + p.y * B.fwd[1] + p.z * B.fwd[2] + B.dist;
    const f = F / Math.max(vz, 0.2);
    return {
      x: W / 2 + (p.x * B.right[0] + p.y * B.right[1] + p.z * B.right[2]) * f,
      y: H / 2 - (p.x * B.up[0] + p.y * B.up[1] + p.z * B.up[2]) * f,
      vz,
      sc: f,
    };
  }

  /* ---------------- 对外接口 ---------------- */
  function setArms(list) {
    arms = list.map((a) => {
      if (!partsCache[a.name]) {
        const arr = [];
        for (let i = 0; i < 60; i++) {
          arr.push({ ph: Math.random(), sp: rand(0.85, 1.2), sz: rand(0.5, 1.4), a: rand(0.5, 1) });
        }
        partsCache[a.name] = arr;
      }
      return { ...a, sprite: spriteOf(a.color), parts: partsCache[a.name], proj: null };
    });
  }

  function setMarker(m) { marker = m; }

  /* ---------------- 绘制 ---------------- */
  function drawBg() {
    const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W, H) * 0.62);
    g.addColorStop(0, '#010204');
    g.addColorStop(0.3, '#030408');
    g.addColorStop(0.65, '#071020');
    g.addColorStop(1, '#0b1728');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function drawGrid(B) {
    ctx.strokeStyle = 'rgba(140,160,190,0.12)';
    ctx.lineWidth = 1;
    for (const r of [0.75, 1.25, 1.75]) {
      ctx.beginPath();
      for (let i = 0; i <= 60; i++) {
        const a = (i / 60) * TAU;
        const p = project({ x: r * Math.cos(a), y: 0, z: r * Math.sin(a) }, B);
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      }
      ctx.stroke();
    }
  }

  function drawArm(a) {
    const pts = a.proj;
    const CH = 40;
    const per = Math.max(1, Math.floor((pts.length - 1) / CH));
    ctx.lineCap = 'round';
    for (let c = 0; c < CH; c++) {
      const i0 = c * per;
      const i1 = c === CH - 1 ? pts.length - 1 : (c + 1) * per;
      let vz = 0;
      for (let i = i0; i <= i1; i++) vz += pts[i].vz;
      vz /= i1 - i0 + 1;
      ctx.globalAlpha = clamp(1.5 - vz / 5.2, 0.15, 0.85);
      ctx.strokeStyle = a.color;
      ctx.lineWidth = clamp((3.2 * 4.4) / vz, 0.7, 5);
      ctx.beginPath();
      ctx.moveTo(pts[i0].x, pts[i0].y);
      for (let i = i0 + 1; i <= i1; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawParts(a, t) {
    const period = 30;
    const n = a.world.length - 1;
    for (const pt of a.parts) {
      const u = (pt.ph + (t / period) * pt.sp) % 1;
      const p = a.proj[Math.min(n, Math.floor(u * n))];
      const fade = smoothstep(0, 0.05, u) * (1 - smoothstep(0.94, 1, u));
      const d = 0.05 * pt.sz * p.sc * 2.2;
      ctx.globalAlpha = fade * pt.a * clamp(1.6 - p.vz / 5.5, 0.2, 1);
      ctx.drawImage(a.sprite, p.x - d / 2, p.y - d / 2, d, d);
    }
    ctx.globalAlpha = 1;
  }

  function drawCore(B) {
    const c = project({ x: 0, y: 0, z: 0 }, B);
    const hd = 0.55 * c.sc;
    ctx.globalAlpha = 0.26;
    ctx.drawImage(haloSprite, c.x - hd / 2, c.y - hd / 2, hd, hd);
    for (const s of core) {
      const p = project(s, B);
      const d = 0.05 * s.sz * p.sc * 2.4;
      ctx.globalAlpha = s.a;
      ctx.drawImage(coreSprite, p.x - d / 2, p.y - d / 2, d, d);
    }
    ctx.globalAlpha = 1;
  }

  function drawMarker(B) {
    if (!marker) return;
    const a = arms.find((x) => x.name === marker.name);
    if (!a || !a.proj) return;
    const i = Math.min(a.proj.length - 1, Math.round(marker.u * (a.proj.length - 1)));
    const p = a.proj[i];
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x - 13, p.y); ctx.lineTo(p.x + 13, p.y);
    ctx.moveTo(p.x, p.y - 13); ctx.lineTo(p.x, p.y + 13);
    ctx.stroke();
  }

  /* ---------------- 主循环 ---------------- */
  function frame(now) {
    if (anim) {
      const k = clamp((now - anim.t0) / (MOVE.dur * 1000), 0, 1);
      const e = easeInOutCubic(k);
      cam.el = lerp(anim.from.el, MOVE.el, e);
      cam.az = lerp(anim.from.az, MOVE.az, e);
      cam.dist = lerp(anim.from.dist, MOVE.dist, e);
      if (k >= 1) anim = null;
    }
    const B = basis();
    drawBg();
    drawGrid(B);
    ctx.globalCompositeOperation = 'lighter';
    for (const a of arms) {
      a.proj = a.world.map((p) => project(p, B));
      drawArm(a);
      drawParts(a, now / 1000);
    }
    drawCore(B);
    ctx.globalCompositeOperation = 'source-over';
    drawMarker(B);
    requestAnimationFrame(frame);
  }

  /* ---------------- 初始化 ---------------- */
  function init(cv) {
    canvas = cv;
    ctx = canvas.getContext('2d');
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      F = Math.min(W, H) * 1.2;
    };
    window.addEventListener('resize', resize);
    resize();

    let dragging = false, lx = 0, ly = 0;
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      lx = e.clientX; ly = e.clientY;
      anim = null;
      canvas.classList.add('dragging');
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      cam.az -= (e.clientX - lx) * 0.25;
      cam.el = clamp(cam.el + (e.clientY - ly) * 0.25, 3, 90);
      lx = e.clientX; ly = e.clientY;
    });
    canvas.addEventListener('pointerup', () => {
      dragging = false;
      canvas.classList.remove('dragging');
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      anim = null;
      cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.001), 2.6, 9);
    }, { passive: false });
    canvas.addEventListener('dblclick', () => {
      anim = null;
      cam.az = 0; cam.el = 90; cam.dist = 5.4;
    });

    playCam();
    requestAnimationFrame(frame);
  }

  return { init, setArms, setMarker, playCam };
})();
