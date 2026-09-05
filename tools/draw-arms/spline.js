/* ============================================================
 * 旋臂画板 · 几何与拟合模块
 * RDP 折线抽稀 + centripetal Catmull-Rom 采样（与动效引擎一致）
 * ============================================================ */
(function () {
  'use strict';

  const DESIGN_W = 1600;
  const DESIGN_H = 900;
  const CENTER = { x: 800, y: 555 };
  const MERGE_R = 120; // 中心汇入区半径
  const MIN_GAP = 40; // 臂间最小间距标准

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  /** 相对螺旋中心的极坐标（α：从正东起逆时针度数） */
  function polarOf(p) {
    return {
      alpha: ((Math.atan2(CENTER.y - p.y, p.x - CENTER.x) * 180) / Math.PI + 360) % 360,
      r: Math.hypot(p.x - CENTER.x, p.y - CENTER.y),
    };
  }

  function perpDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-6) return dist(p, a);
    return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / Math.sqrt(len2);
  }

  /** Ramer-Douglas-Peucker 折线抽稀 */
  function rdp(points, eps) {
    if (points.length < 3) return points.slice();
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let maxD = 0, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = perpDist(points[i], points[a], points[b]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps && idx > 0) {
        keep[idx] = 1;
        stack.push([a, idx], [idx, b]);
      }
    }
    return points.filter((_, i) => keep[i]);
  }

  /* centripetal Catmull-Rom（与 js/app.js 引擎一致） */
  function crcPoint(p0, p1, p2, p3, t) {
    const d01 = Math.max(Math.hypot(p1.x - p0.x, p1.y - p0.y) ** 0.5, 1e-4);
    const d12 = Math.max(Math.hypot(p2.x - p1.x, p2.y - p1.y) ** 0.5, 1e-4);
    const d23 = Math.max(Math.hypot(p3.x - p2.x, p3.y - p2.y) ** 0.5, 1e-4);
    const t0 = 0, t1 = d01, t2 = t1 + d12, t3 = t2 + d23;
    const tt = t1 + (t2 - t1) * t;
    const mix = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
    const A1 = mix(p0, p1, (tt - t0) / (t1 - t0));
    const A2 = mix(p1, p2, (tt - t1) / (t2 - t1));
    const A3 = mix(p2, p3, (tt - t2) / (t3 - t2));
    const B1 = mix(A1, A2, (tt - t0) / (t2 - t0));
    const B2 = mix(A2, A3, (tt - t1) / (t3 - t1));
    return mix(B1, B2, (tt - t1) / (t2 - t1));
  }

  /** 控制点 → 密采样折线（终点吸附到中心，与引擎一致） */
  function sampleSpline(cps, total = 600) {
    const P = cps.map((p) => ({ x: p.x, y: p.y }));
    P.push({ ...CENTER });
    const ref = (a, b) => ({ x: 2 * a.x - b.x, y: 2 * a.y - b.y });
    const segN = Math.max(4, Math.round(total / (P.length - 1)));
    const out = [];
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = i === 0 ? ref(P[0], P[1]) : P[i - 1];
      const p3 = i + 2 >= P.length ? ref(P[P.length - 1], P[P.length - 2]) : P[i + 2];
      for (let j = 0; j < segN; j++) out.push(crcPoint(p0, P[i], P[i + 1], p3, j / segN));
    }
    out.push({ ...CENTER });
    let length = 0;
    for (let i = 1; i < out.length; i++) length += dist(out[i], out[i - 1]);
    return { pts: out, length };
  }

  window.ASTRA_SPLINE = {
    DESIGN_W, DESIGN_H, CENTER, MERGE_R, MIN_GAP,
    dist, polarOf, perpDist, rdp, crcPoint, sampleSpline,
  };
})();
