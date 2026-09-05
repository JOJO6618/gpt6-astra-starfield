/* ============================================================
 * Z 曲线模块：由控制站点 [[u, z], ...] 构造平滑插值函数 z(u)
 * 均匀 Catmull-Rom（端点反射），曲线严格经过每一个站点。
 * 引擎（app.js）与 Z 轴编辑器（tools/z-editor）共用，保证所见即所得。
 * ============================================================ */
(function () {
  'use strict';

  /**
   * @param pts 站点数组 [[u, z], ...]，u 升序、等距（编辑器约定 0, 1/8, ..., 1）
   * @returns {function(number): number} z(u)
   */
  function make(pts) {
    const n = pts.length;
    const us = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[1]);
    const u0 = us[0], u1 = us[n - 1];

    // 端点反射取值（区间均匀，直接对 z 值反射）
    const zAt = (i) => {
      if (i < 0) return 2 * zs[0] - zs[1];
      if (i > n - 1) return 2 * zs[n - 1] - zs[n - 2];
      return zs[i];
    };

    return function (u) {
      const uu = Math.min(Math.max(u, u0), u1);
      let i = 0;
      while (i < n - 2 && uu > us[i + 1]) i++;
      const span = us[i + 1] - us[i] || 1;
      const t = (uu - us[i]) / span;
      const p0 = zAt(i - 1), p1 = zAt(i), p2 = zAt(i + 1), p3 = zAt(i + 2);
      return 0.5 * (
        2 * p1 +
        (-p0 + p2) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t
      );
    };
  }

  window.ZCURVE = { make };
})();
