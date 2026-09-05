/* ============================================================
 * 3D 相机模块（四元数轨迹球）
 *
 * 世界坐标：设计稿 XY 平面 = 世界 XZ 平面（1 设计 px = 1/420 世界单位），
 * 世界 Y = 构造高度（向上为正）。
 *
 * 朝向用四元数表示，避免欧拉角在天顶点的翻转/退化：
 *   - setView(el, az) 设定「目标朝向」（滚动驱动：俯视 90° → 平视 22°）
 *   - drag(dx, dy)   轨迹球增量：绕当前屏幕竖直轴 / 水平轴旋转，角度不限
 *   - tick(dt, dragging) 松手后按最短弧平滑回位到目标朝向
 *
 * el=90°、az=0 时投影与旧 2D 映射逐像素一致。
 * ============================================================ */
(function () {
  'use strict';

  const S = 420; // 设计 px → 世界单位
  const RAD = Math.PI / 180;
  const RETURN_SPEED = 4.2; // 松手回位速度（指数趋近，越大越快）

  let W = 0, H = 0, F = 600, cy = 0;
  let baseDist = 5, dollyCur = 1;
  let q = null;   // 当前朝向（null = 未初始化，首帧取目标朝向）
  let qT = [0, 0, 0, 1];
  let B = null;

  /* ---------------- 四元数 [x, y, z, w] ---------------- */
  const qAxis = (axis, rad) => {
    const s = Math.sin(rad / 2);
    return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(rad / 2)];
  };
  const qMul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  const qNorm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2], v[3]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l, v[3] / l];
  };
  /** 最短弧球面插值 */
  const qSlerp = (a, b, t) => {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    let bb = b;
    if (d < 0) { d = -d; bb = [-b[0], -b[1], -b[2], -b[3]]; }
    if (d > 0.9995) return qNorm([0, 1, 2, 3].map((i) => a[i] + (bb[i] - a[i]) * t));
    const th = Math.acos(Math.min(1, d));
    const s = Math.sin(th);
    const sa = Math.sin(th * (1 - t)) / s;
    const sb = Math.sin(th * t) / s;
    return [0, 1, 2, 3].map((i) => a[i] * sa + bb[i] * sb);
  };
  /** 用四元数旋转向量 */
  const rotVec = (qq, v) => {
    const x = qq[0], y = qq[1], z = qq[2], w = qq[3];
    const tx = 2 * (y * v[2] - z * v[1]);
    const ty = 2 * (z * v[0] - x * v[2]);
    const tz = 2 * (x * v[1] - y * v[0]);
    return [
      v[0] + w * tx + (y * tz - z * ty),
      v[1] + w * ty + (z * tx - x * tz),
      v[2] + w * tz + (x * ty - y * tx),
    ];
  };

  /** el/az → 目标朝向（与旧球坐标实现等价：qy(az) ⊗ qx(−el)） */
  function qFromElAz(el, az) {
    const qx = qAxis([1, 0, 0], -el * RAD);
    const qy = qAxis([0, 1, 0], az * RAD);
    return qMul(qy, qx);
  }

  /**
   * @param scale2d 旧 2D 的 min(W/shapeW, H/shapeH)，用于对齐取景
   * @param anchorY 螺旋中心的屏幕纵向锚点（0~1）
   */
  function setViewport(w, h, scale2d, anchorY) {
    W = w; H = h;
    F = Math.min(w, h) * 1.62;      // 焦距：1.2 × 1.35（1.35 为透视柔化系数）
    baseDist = F / (S * scale2d);   // 反推距离，使 el=90° 时取景与旧 2D 一致
    cy = h * anchorY;
    B = null;
  }

  /** 设定目标朝向（滚动驱动） */
  function setView(el, az, dolly) {
    qT = qFromElAz(el, az);
    dollyCur = dolly;
    if (!q) q = qT; // 首帧直接落在目标朝向，避免开场甩动
    B = null;
  }

  /** 轨迹球拖动：绕当前屏幕竖直轴（左右拖）/ 水平轴（上下拖）增量旋转 */
  function drag(dxDeg, dyDeg) {
    const b = basis();
    const qy = qAxis(b.up, -dxDeg * RAD);
    const qx = qAxis(b.right, -dyDeg * RAD);
    q = qNorm(qMul(qx, qMul(qy, q)));
    B = null;
  }

  /** 每帧推进：松手状态下向目标朝向按最短弧回位 */
  function tick(dt, dragging) {
    if (!dragging && q) {
      const k = 1 - Math.exp(-dt * RETURN_SPEED);
      q = qSlerp(q, qT, k);
    }
    B = null;
  }

  function basis() {
    if (B) return B;
    B = {
      right: rotVec(q, [1, 0, 0]),
      up: rotVec(q, [0, 1, 0]),
      fwd: rotVec(q, [0, 0, -1]),
      dist: baseDist * dollyCur,
    };
    return B;
  }

  /**
   * 世界点 → 屏幕投影
   * @returns {x, y, vz, sc} sc = 该深度下 1 世界单位的像素数（近大远小）
   */
  function project(p) {
    const b = basis();
    const vz = p.x * b.fwd[0] + p.y * b.fwd[1] + p.z * b.fwd[2] + b.dist;
    const f = F / Math.max(vz, 0.2);
    return {
      x: W / 2 + (p.x * b.right[0] + p.y * b.right[1] + p.z * b.right[2]) * f,
      y: cy - (p.x * b.up[0] + p.y * b.up[1] + p.z * b.up[2]) * f,
      vz,
      sc: f,
    };
  }

  /**
   * 屏幕像素 → 当前视线的世界射线（单位方向 + 相机位置），用于反投影锚点
   */
  function rayAt(sx, sy) {
    const b = basis();
    const dx = (sx - W / 2) / F;
    const dy = (cy - sy) / F;
    const d = [
      b.right[0] * dx + b.up[0] * dy + b.fwd[0],
      b.right[1] * dx + b.up[1] * dy + b.fwd[1],
      b.right[2] * dx + b.up[2] * dy + b.fwd[2],
    ];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    return {
      dir: [d[0] / l, d[1] / l, d[2] / l],
      camPos: [-b.fwd[0] * b.dist, -b.fwd[1] * b.dist, -b.fwd[2] * b.dist],
    };
  }

  window.CAM3D = { S, setViewport, setView, drag, tick, project, rayAt };
})();
