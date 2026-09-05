/* ============================================================
 * Z 轴编辑器 · 主逻辑
 *
 * 每条臂沿弧长均布 9 个站点（u = 0 起点 → 1 中心），
 * 站点上下拖动改变 Z 高度，js/zcurve.js 自动平滑过点；
 * 右侧 3D 预览（preview3d.js）实时联动，悬停站点在 3D 中标记位置。
 * 导出完整 js/arms-3d.js（复制 / 下载）。
 * ============================================================ */
(function () {
  'use strict';

  const { ARMS } = window.ASTRA_DATA;
  const { sampleSpline, CENTER } = window.ASTRA_SPLINE;
  const TAU = Math.PI * 2;
  const S = 420;
  const STATIONS = 9; // 站点数（含起点与中心；中心锁定 z=0）
  const COLORS = { G: '#4ade80', R: '#f87171', O1: '#fb923c', O2: '#c084fc', B: '#60a5fa' };
  const NAMES = { O2: 'P' };
  const ORDER = ['G', 'R', 'O1', 'O2', 'B'];

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const round1 = (v) => Math.round(v * 10) / 10;

  /* ---------------- 状态 ---------------- */
  function formulaPts(z0, k) {
    const pts = [];
    for (let i = 0; i < STATIONS; i++) {
      const u = i / (STATIONS - 1);
      pts.push([u, round1(z0 * Math.pow(1 - u, k))]);
    }
    return pts;
  }

  function loadState() {
    return ORDER.map((src) => {
      const c = window.ARMS_3D[src] || { z0: 0, k: 1 };
      return {
        src,
        name: NAMES[src] || src,
        color: COLORS[src],
        z0: c.z0,
        k: c.k,
        zpts: c.zpts ? c.zpts.map((p) => [p[0], p[1]]) : formulaPts(c.z0, c.k),
      };
    });
  }

  let armz = loadState();
  const initial = JSON.parse(JSON.stringify(armz)); // “全部重置”基准
  let activeSrc = null;  // 高亮臂（null = 全部）
  let hover = null;      // { src, i }
  let drag = null;       // { src, i }

  /* ---------------- XY 样条缓存 + 世界坐标构建 ---------------- */
  const splineCache = {};
  function armSamples(src) {
    if (!splineCache[src]) {
      const def = ARMS.find((a) => a.name === src);
      const cps = def.pts.map(([x, y]) => ({ x, y }));
      const { pts } = sampleSpline(cps, 560);
      const cum = [0];
      for (let i = 1; i < pts.length; i++) {
        cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
      }
      splineCache[src] = { pts, cum, total: cum[cum.length - 1] };
    }
    return splineCache[src];
  }

  function buildWorld(a) {
    const { pts, cum, total } = armSamples(a.src);
    const zFn = window.ZCURVE.make(a.zpts);
    return pts.map((p, i) => {
      const u = cum[i] / total;
      return { x: (p.x - CENTER.x) / S, y: zFn(u) / S, z: (p.y - CENTER.y) / S };
    });
  }

  function syncPreview() {
    PREVIEW3D.setArms(armz.map((a) => ({ name: a.name, color: a.color, world: buildWorld(a) })));
  }

  /* ---------------- 剖面编辑器画布 ---------------- */
  const board = document.getElementById('board');
  const bctx = board.getContext('2d');
  let BW = 0, BH = 0, bdpr = 1;
  const PAD = { l: 50, r: 26, t: 22, b: 34 };

  function resizeBoard() {
    bdpr = Math.min(window.devicePixelRatio || 1, 2);
    BW = board.clientWidth;
    BH = board.clientHeight;
    board.width = Math.round(BW * bdpr);
    board.height = Math.round(BH * bdpr);
    bctx.setTransform(bdpr, 0, 0, bdpr, 0, 0);
    drawBoard();
  }

  function zRange() {
    let m = 60;
    for (const a of armz) for (const p of a.zpts) m = Math.max(m, Math.abs(p[1]));
    return m * 1.18;
  }

  const uToX = (u) => PAD.l + u * (BW - PAD.l - PAD.r);
  const zToY = (z, zm) => PAD.t + ((zm - z) / (2 * zm)) * (BH - PAD.t - PAD.b);
  const yToZ = (y, zm) => zm - ((y - PAD.t) / (BH - PAD.t - PAD.b)) * 2 * zm;

  function drawBoard() {
    const zm = zRange();
    bctx.fillStyle = '#0a0f18';
    bctx.fillRect(0, 0, BW, BH);

    // 横向网格线（每 50px 高度一档）+ z=0 平面线
    bctx.font = '10px ui-monospace, monospace';
    for (let z = Math.ceil(-zm / 50) * 50; z <= zm; z += 50) {
      const y = zToY(z, zm);
      bctx.strokeStyle = z === 0 ? 'rgba(200,220,250,0.4)' : 'rgba(120,140,170,0.10)';
      bctx.lineWidth = 1;
      bctx.beginPath();
      bctx.moveTo(PAD.l, y);
      bctx.lineTo(BW - PAD.r, y);
      bctx.stroke();
      bctx.fillStyle = z === 0 ? 'rgba(200,220,250,0.65)' : 'rgba(140,160,185,0.4)';
      bctx.fillText(z === 0 ? 'z=0 平面' : String(z), 6, y + 3);
    }
    // 站点竖线 + u 刻度
    for (let i = 0; i < STATIONS; i++) {
      const u = i / (STATIONS - 1);
      const x = uToX(u);
      bctx.strokeStyle = 'rgba(120,140,170,0.10)';
      bctx.beginPath();
      bctx.moveTo(x, PAD.t);
      bctx.lineTo(x, BH - PAD.b);
      bctx.stroke();
      bctx.fillStyle = 'rgba(140,160,185,0.45)';
      bctx.fillText(i === 0 ? '起点' : i === STATIONS - 1 ? '中心' : u.toFixed(3), x - 10, BH - 12);
    }

    // 各臂曲线与站点
    for (const a of armz) {
      const dim = activeSrc && activeSrc !== a.src;
      const zFn = window.ZCURVE.make(a.zpts);
      bctx.globalAlpha = dim ? 0.25 : 1;
      bctx.strokeStyle = a.color;
      bctx.lineWidth = 2;
      bctx.beginPath();
      for (let i = 0; i <= 200; i++) {
        const u = i / 200;
        const x = uToX(u), y = zToY(zFn(u), zm);
        i ? bctx.lineTo(x, y) : bctx.moveTo(x, y);
      }
      bctx.stroke();

      a.zpts.forEach((p, i) => {
        const x = uToX(p[0]), y = zToY(p[1], zm);
        const locked = i === STATIONS - 1;
        const hot = hover && hover.src === a.src && hover.i === i;
        if (locked) {
          // 中心站点：方形，固定 z=0
          bctx.fillStyle = 'rgba(160,175,195,0.6)';
          bctx.fillRect(x - 4, y - 4, 8, 8);
          return;
        }
        bctx.beginPath();
        bctx.arc(x, y, hot ? 7.5 : 5.5, 0, TAU);
        bctx.fillStyle = hot ? '#ffffff' : a.color;
        bctx.fill();
        if (hot) {
          bctx.strokeStyle = a.color;
          bctx.lineWidth = 1.5;
          bctx.stroke();
        }
      });
      bctx.globalAlpha = 1;
    }

    // 悬停/拖动标签
    const h = drag || hover;
    if (h) {
      const a = armz.find((x) => x.src === h.src);
      const p = a.zpts[h.i];
      bctx.fillStyle = 'rgba(235,242,252,0.9)';
      bctx.font = '12px ui-monospace, monospace';
      const label = `${a.name}  u=${p[0]}  z=${p[1] > 0 ? '+' : ''}${p[1]}`;
      const lx = clamp(uToX(p[0]) + 12, 8, BW - 130);
      const ly = clamp(zToY(p[1], zm) - 12, 14, BH - 8);
      bctx.fillText(label, lx, ly);
    }
  }

  /* ---------------- 站点拾取与拖动 ---------------- */
  function findPoint(mx, my) {
    const zm = zRange();
    let best = null;
    for (const a of armz) {
      a.zpts.forEach((p, i) => {
        if (i === STATIONS - 1) return; // 中心锁定
        const d = Math.hypot(mx - uToX(p[0]), my - zToY(p[1], zm));
        if (d < 14 && (!best || d < best.d)) best = { src: a.src, i, d };
      });
    }
    return best;
  }

  function toBoard(e) {
    const rect = board.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  board.addEventListener('pointerdown', (e) => {
    const m = toBoard(e);
    const hit = findPoint(m.x, m.y);
    if (hit) {
      drag = hit;
      board.setPointerCapture(e.pointerId);
    }
  });

  board.addEventListener('pointermove', (e) => {
    const m = toBoard(e);
    if (drag) {
      const zm = zRange();
      const a = armz.find((x) => x.src === drag.src);
      a.zpts[drag.i][1] = round1(clamp(yToZ(m.y, zm), -600, 600));
      hover = { src: drag.src, i: drag.i };
      syncPreview();
      PREVIEW3D.setMarker({ name: a.name, u: a.zpts[drag.i][0] });
    } else {
      const hit = findPoint(m.x, m.y);
      hover = hit;
      board.style.cursor = hit ? 'ns-resize' : 'crosshair';
      if (hit) {
        const a = armz.find((x) => x.src === hit.src);
        PREVIEW3D.setMarker({ name: a.name, u: a.zpts[hit.i][0] });
      } else {
        PREVIEW3D.setMarker(null);
      }
    }
    drawBoard();
  });

  board.addEventListener('pointerup', () => {
    drag = null;
    drawBoard();
  });

  board.addEventListener('pointerleave', () => {
    if (!drag) {
      hover = null;
      PREVIEW3D.setMarker(null);
      drawBoard();
    }
  });

  /* ---------------- 臂高亮选择 ---------------- */
  function refreshPicker() {
    const el = document.getElementById('armPicker');
    const chips = [{ src: null, name: '全部', color: '#9db4d0' }]
      .concat(armz.map((a) => ({ src: a.src, name: a.name, color: a.color })));
    el.innerHTML = chips.map((c) =>
      `<button class="arm-btn ${activeSrc === c.src ? 'active' : ''}" style="--c:${c.color}" data-src="${c.src}">
        <span class="dot"></span>${c.name}</button>`
    ).join('');
    el.querySelectorAll('.arm-btn').forEach((b) =>
      b.addEventListener('click', () => {
        activeSrc = b.dataset.src === 'null' ? null : b.dataset.src;
        refreshPicker();
        drawBoard();
      })
    );
  }

  /* ---------------- 重置与导出 ---------------- */
  document.getElementById('resetArmBtn').addEventListener('click', () => {
    const a = armz.find((x) => x.src === (activeSrc || 'G'));
    a.zpts = formulaPts(a.z0, a.k);
    syncPreview();
    drawBoard();
  });

  document.getElementById('resetAllBtn').addEventListener('click', () => {
    armz = JSON.parse(JSON.stringify(initial));
    syncPreview();
    drawBoard();
  });

  function exportText() {
    const rows = armz.map((a) => {
      const pts = a.zpts.map((p) => `[${p[0]}, ${p[1]}]`).join(', ');
      return `    ${a.src}: { z0: ${a.zpts[0][1]}, k: ${a.k}, zpts: [${pts}] },`;
    }).join('\n');
    return `/* ============================================================
 * 旋臂高度(Z)配置 · 控制点版（由「Z 轴编辑器」导出）
 *
 *   每条臂沿弧长均布 ${STATIONS} 个站点（u = 0 起点 → 1 中心），
 *   z(u) 由 js/zcurve.js 的平滑样条插值，严格经过每个站点；
 *   中心站点（u=1）恒为 0（所有臂汇入中心）。
 *   z0 / k 为公式兜底（zpts 缺失时使用 z0·(1−u)^k）。
 *   键名与 arms-data.js 的臂名一致（P 的数据仍叫 O2）。
 * ============================================================ */
(function () {
  'use strict';

  window.ARMS_3D = {
${rows}
  };
})();
`;
  }

  document.getElementById('copyBtn').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(exportText()); } catch { /* 忽略 */ }
    e.target.textContent = '已复制 ✓';
    setTimeout(() => { e.target.textContent = '复制代码'; }, 1500);
  });

  document.getElementById('exportBtn').addEventListener('click', () => {
    const blob = new Blob([exportText()], { type: 'text/javascript' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'arms-3d.js';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  /* ---------------- 启动 ---------------- */
  window.addEventListener('resize', resizeBoard);
  refreshPicker();
  resizeBoard();
  PREVIEW3D.init(document.getElementById('view3d'));
  syncPreview();
})();
