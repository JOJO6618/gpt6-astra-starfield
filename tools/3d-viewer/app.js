/* ============================================================
 * 3D 旋臂预览 · 渲染器
 *
 * 用当前 2D 轨迹（js/arms-data.js 的 XY）+ config3d.js 构造的 Z，
 * 把 5 条臂画成空间曲线；轨道相机支持拖动/缩放，并内置官网同款
 * 「垂直俯视 → 斜视」开场运镜。
 *
 * 纯 Canvas 2D 手写透视投影，无外部依赖；加色混合，无需深度排序。
 * ============================================================ */
(function () {
  'use strict';

  const { ARMS } = window.ASTRA_DATA;
  const { sampleSpline, CENTER } = window.ASTRA_SPLINE;
  const TAU = Math.PI * 2;
  const S = 420; // 设计 px → 世界单位

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

  /* ---------------- DOM / 画布 ---------------- */
  const canvas = document.getElementById('view');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1, F = 600; // F = 焦距(px)

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    F = Math.min(W, H) * 1.2;
  }

  /* ---------------- 发光 sprite ---------------- */
  function makeSprite(color) {
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
    return cv;
  }

  /* ---------------- 相机 ---------------- */
  const cam = { az: 0, el: 90, dist: 5.6 }; // el: 90=俯视 越小越平视
  const CAM_MOVE = { dur: 9, delay: 0.6, el: 24, az: -16, dist: 4.6 }; // 官网运镜终点
  let camAnim = null;

  function playCam() {
    camAnim = {
      t0: performance.now() + CAM_MOVE.delay * 1000,
      from: { ...cam },
    };
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

  /** 世界点 → 屏幕（附带深度与像素比例） */
  function project(p, B) {
    const vz = p.x * B.fwd[0] + p.y * B.fwd[1] + p.z * B.fwd[2] + B.dist;
    const f = F / Math.max(vz, 0.2);
    return {
      x: W / 2 + (p.x * B.right[0] + p.y * B.right[1] + p.z * B.right[2]) * f,
      y: H / 2 - (p.x * B.up[0] + p.y * B.up[1] + p.z * B.up[2]) * f,
      vz,
      sc: f, // 该深度下 1 世界单位的像素数
    };
  }

  /* ---------------- 臂构建（XY + Z 构造） ---------------- */
  let arms = [];

  function buildArms() {
    arms = window.ARMS_3D.map((cfg3) => {
      const def = ARMS.find((a) => a.name === cfg3.src);
      const cps = def.pts.map(([x, y]) => ({ x, y }));
      const { pts } = sampleSpline(cps, 560);
      const cum = [0];
      for (let i = 1; i < pts.length; i++) {
        cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
      }
      const total = cum[cum.length - 1];
      // 世界坐标：XY 平面为设计稿平面，y = 构造高度
      const world = pts.map((p, i) => {
        const u = cum[i] / total;
        const zh = cfg3.z0 * Math.pow(1 - u, cfg3.k);
        return { x: (p.x - CENTER.x) / S, y: zh / S, z: (p.y - CENTER.y) / S };
      });
      // 流动粒子
      const parts = [];
      for (let i = 0; i < 80; i++) {
        parts.push({ ph: Math.random(), sp: rand(0.85, 1.2), sz: rand(0.5, 1.5), a: rand(0.5, 1) });
      }
      return { ...cfg3, world, proj: null, parts, sprite: makeSprite(cfg3.color) };
    });
  }

  /* ---------------- 中心亮团 ---------------- */
  const core = [];
  for (let i = 0; i < 46; i++) {
    const a = Math.random() * TAU;
    const b = Math.acos(rand(-1, 1));
    const r = 0.075 * Math.pow(Math.random(), 1.6);
    core.push({
      x: r * Math.sin(b) * Math.cos(a),
      y: r * Math.cos(b) * 0.7,
      z: r * Math.sin(b) * Math.sin(a),
      sz: rand(0.5, 1.4),
      a: rand(0.4, 0.95),
    });
  }
  const coreSprite = makeSprite('#ffffff');
  const haloSprite = makeSprite('#dceaff');

  /* ---------------- 背景 / 网格 / 落点 ---------------- */
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
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(140,160,190,0.13)';
    ctx.lineWidth = 1;
    for (const r of [0.75, 1.25, 1.75]) {
      ctx.beginPath();
      for (let i = 0; i <= 72; i++) {
        const a = (i / 72) * TAU;
        const p = project({ x: r * Math.cos(a), y: 0, z: r * Math.sin(a) }, B);
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      }
      ctx.stroke();
    }
    // 坐标轴
    ctx.strokeStyle = 'rgba(140,160,190,0.2)';
    for (const [a, b] of [
      [{ x: -1.9, y: 0, z: 0 }, { x: 1.9, y: 0, z: 0 }],
      [{ x: 0, y: 0, z: -1.9 }, { x: 0, y: 0, z: 1.9 }],
      [{ x: 0, y: -0.65, z: 0 }, { x: 0, y: 0.8, z: 0 }],
    ]) {
      const pa = project(a, B), pb = project(b, B);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
  }

  function drawDrops(B) {
    ctx.globalCompositeOperation = 'source-over';
    for (const a of arms) {
      const p0 = a.world[0];
      const top = project(p0, B);
      const bot = project({ x: p0.x, y: 0, z: p0.z }, B);
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = a.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(bot.x, bot.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = a.color;
      ctx.beginPath();
      ctx.arc(top.x, top.y, 4, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.arc(bot.x, bot.y, 2.5, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  /* ---------------- 臂与粒子 ---------------- */
  function drawArm(a) {
    const pts = a.proj;
    const CH = 44; // 分段数：按深度分批描边
    const per = Math.max(1, Math.floor((pts.length - 1) / CH));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let c = 0; c < CH; c++) {
      const i0 = c * per;
      const i1 = c === CH - 1 ? pts.length - 1 : (c + 1) * per;
      let vz = 0;
      for (let i = i0; i <= i1; i++) vz += pts[i].vz;
      vz /= i1 - i0 + 1;
      ctx.globalAlpha = clamp(1.55 - vz / 5.2, 0.14, 0.9);
      ctx.strokeStyle = a.color;
      ctx.lineWidth = clamp((3.4 * 4.6) / vz, 0.7, 5.2);
      ctx.beginPath();
      ctx.moveTo(pts[i0].x, pts[i0].y);
      for (let i = i0 + 1; i <= i1; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawParts(a, t) {
    const period = 34;
    const n = a.world.length - 1;
    for (const pt of a.parts) {
      const u = (pt.ph + (t / period) * pt.sp) % 1;
      const p = a.proj[Math.min(n, Math.floor(u * n))];
      const fade = smoothstep(0, 0.05, u) * (1 - smoothstep(0.94, 1, u));
      const d = 0.055 * pt.sz * p.sc * 2.2;
      ctx.globalAlpha = fade * pt.a * clamp(1.7 - p.vz / 5.5, 0.2, 1);
      ctx.drawImage(a.sprite, p.x - d / 2, p.y - d / 2, d, d);
    }
    ctx.globalAlpha = 1;
  }

  function drawCore(B) {
    const c = project({ x: 0, y: 0, z: 0 }, B);
    const hd = 0.6 * c.sc;
    ctx.globalAlpha = 0.26;
    ctx.drawImage(haloSprite, c.x - hd / 2, c.y - hd / 2, hd, hd);
    for (const s of core) {
      const p = project(s, B);
      const d = 0.055 * s.sz * p.sc * 2.4;
      ctx.globalAlpha = s.a;
      ctx.drawImage(coreSprite, p.x - d / 2, p.y - d / 2, d, d);
    }
    ctx.globalAlpha = 1;
  }

  /* ---------------- 主循环 ---------------- */
  const flags = { grid: true, drops: true, parts: true };
  let infoTick = 0;

  function frame(now) {
    // 开场运镜
    if (camAnim) {
      const k = clamp((now - camAnim.t0) / (CAM_MOVE.dur * 1000), 0, 1);
      const e = easeInOutCubic(k);
      cam.el = lerp(camAnim.from.el, CAM_MOVE.el, e);
      cam.az = lerp(camAnim.from.az, CAM_MOVE.az, e);
      cam.dist = lerp(camAnim.from.dist, CAM_MOVE.dist, e);
      if (k >= 1) camAnim = null;
    }

    const B = basis();
    drawBg();

    if (flags.grid) drawGrid(B);
    if (flags.drops) drawDrops(B);

    ctx.globalCompositeOperation = 'lighter';
    for (const a of arms) {
      a.proj = a.world.map((p) => project(p, B));
      drawArm(a);
      if (flags.parts) drawParts(a, now / 1000);
    }
    drawCore(B);
    ctx.globalCompositeOperation = 'source-over';

    if (++infoTick % 12 === 0) {
      document.getElementById('camInfo').textContent =
        `俯仰角 ${cam.el.toFixed(1)}°（90=俯视）· 方位 ${cam.az.toFixed(1)}° · 距离 ${cam.dist.toFixed(2)}`;
    }
    requestAnimationFrame(frame);
  }

  /* ---------------- 鼠标轨道 ---------------- */
  let dragging = false, lx = 0, ly = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    lx = e.clientX; ly = e.clientY;
    camAnim = null;
    canvas.classList.add('dragging');
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // 抓住场景跟随鼠标：向右拖场景向右转，向下拖场景向下倾
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
    camAnim = null;
    cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.001), 2.6, 9);
  }, { passive: false });
  canvas.addEventListener('dblclick', () => {
    camAnim = null;
    cam.az = 0; cam.el = 90; cam.dist = 5.6;
  });

  /* ---------------- 控制面板 ---------------- */
  function buildUI() {
    const armRows = document.getElementById('armRows');
    const kRows = document.getElementById('kRows');
    window.ARMS_3D.forEach((c3, i) => {
      const row = document.createElement('div');
      row.className = 'arm-row';
      row.innerHTML =
        `<span class="dot" style="color:${c3.color};background:${c3.color}"></span>` +
        `<span class="name" style="color:${c3.color}">${c3.name}</span>` +
        `<input type="range" min="-300" max="300" step="5" value="${c3.z0}">` +
        `<span class="val">${c3.z0}</span>`;
      const slider = row.querySelector('input');
      const val = row.querySelector('.val');
      slider.addEventListener('input', () => {
        c3.z0 = +slider.value;
        val.textContent = slider.value;
        buildArms();
      });
      armRows.appendChild(row);

      const krow = document.createElement('div');
      krow.className = 'arm-row';
      krow.innerHTML =
        `<span class="name" style="color:${c3.color}">${c3.name}</span>` +
        `<input type="range" min="0.6" max="4" step="0.05" value="${c3.k}">` +
        `<span class="val">${c3.k.toFixed(2)}</span>`;
      const ks = krow.querySelector('input');
      const kv = krow.querySelector('.val');
      ks.addEventListener('input', () => {
        c3.k = +ks.value;
        kv.textContent = (+ks.value).toFixed(2);
        buildArms();
      });
      kRows.appendChild(krow);
    });

    document.getElementById('replay').addEventListener('click', playCam);
    document.getElementById('tGrid').addEventListener('change', (e) => { flags.grid = e.target.checked; });
    document.getElementById('tDrops').addEventListener('change', (e) => { flags.drops = e.target.checked; });
    document.getElementById('tParts').addEventListener('change', (e) => { flags.parts = e.target.checked; });
    document.getElementById('exportBtn').addEventListener('click', async (e) => {
      const out = {};
      window.ARMS_3D.forEach((c3) => { out[c3.name] = { z0: c3.z0, k: c3.k, color: c3.color }; });
      const text = JSON.stringify(out, null, 2);
      try { await navigator.clipboard.writeText(text); } catch { prompt('复制：', text); }
      e.target.textContent = '已复制 ✓';
      setTimeout(() => { e.target.textContent = '导出Z配置'; }, 1500);
    });
  }

  /* ---------------- 启动 ---------------- */
  window.addEventListener('resize', resize);
  resize();
  buildArms();
  buildUI();
  playCam(); // 打开即播放官网同款运镜
  requestAnimationFrame(frame);
})();
