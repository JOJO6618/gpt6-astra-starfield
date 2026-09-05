/* ============================================================
 * GPT-6 Astra · 星空螺旋 "6" 动效引擎（3D · Canvas 2D 透视投影）
 *
 * 三阶段时间线：
 *   0 ~ scatterEnd   散星：满屏随机星，缓慢漂移
 *   scatterEnd ~ gatherEnd  汇聚：每颗星沿瘦高 S 形路径归入旋臂（可切换圆弧）
 *   gatherEnd ~      流动：粒子在起点亮起 → 沿臂逆时针流动
 *                     → 汇入中心光团消失
 *
 * 3D 结构：
 *   - 设计稿 XY = 世界 XZ 平面；每臂高度 z(u)=z0·(1−u)^k（js/arms-3d.js）
 *   - 相机：俯视 90° → 页面向下滚动 → 趋于平视（js/cam3d.js 投影）
 *   - 逐点透视：近大远小；el=90° 时与旧 2D 逐像素一致
 *
 * 星带构成（参考官网特写）：
 *   - 粒子在臂法线方向高斯散布 → 旋臂是有宽度的星带
 *   - 比例：95.5% 中小星 / 4% 大光晕星（无芒）/ 0.5% 特大星（十字芒）
 *   - 5% 中小星在途中被“点燃”，3 秒平滑变大成为大光晕星
 *   - 亮度恒定无闪烁；星星在臂起点由小变大“点燃”
 *   - 鼠标“来拒去留”：靠近推开 / 远离吸附，弹簧缓慢归位
 *   - 拖动旋转：轨迹球任意角度旋转，松手自动回位
 *
 * 依赖：js/arms-data.js（ASTRA_DATA）+ js/arms-3d.js（ARMS_3D）
 *       + js/cam3d.js（CAM3D）+ js/zcurve.js（ZCURVE）
 * ============================================================ */
(function () {
  'use strict';

  const { CFG, STAR_COLORS, ARMS, ORIGINS } = window.ASTRA_DATA;
  const Z3 = window.ARMS_3D;
  const CAM = window.CAM3D;
  const S = 420; // 设计 px → 世界单位（与 cam3d.js 一致）

  /* ---------------- 工具 ---------------- */
  const TAU = Math.PI * 2;
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, v) => {
    const t = clamp((v - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const easeInOutCubic = (t) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  /** 标准正态分布采样（Box-Muller） */
  function gauss() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function pickColorIndex() {
    let total = 0;
    for (const c of STAR_COLORS) total += c.weight;
    let r = Math.random() * total;
    for (let i = 0; i < STAR_COLORS.length; i++) {
      r -= STAR_COLORS[i].weight;
      if (r <= 0) return i;
    }
    return 0;
  }

  /* ---------------- 相机滚动驱动参数 ---------------- */
  const CAM_MOVE = {
    elStart: 90, elEnd: 35,   // 俯仰角：垂直俯视 → 倾斜 35°
    azStart: 0,  azEnd: -10,  // 方位角轻微偏转
    dollyEnd: 1.12,           // 末端轻微拉远，缓和透视畸变
    smooth: 3.2,              // 滚动平滑系数（越大越跟手）
  };

  /* ---------------- 分裂阶段（滚动超过相机极限后） ---------------- */
  // 滚动进度 prog：0~1 驱动相机；1~2 驱动分裂。分裂时每颗星从螺旋轨道位置平滑插值到
  // 所属一侧空白区内的均匀随机槽位（左半/右半各一半）；过渡期内 u 照常推进、螺旋流动
  // 不中断，带内散布同步放大（更离散），滚回时一切平滑收拢归位。
  const SPLIT = {
    progStart: 1.0,          // 分裂起点（prog > 1 后进入）
    // 阶段一（裂成两半）：每条臂的星按归属侧分成两半，两个半密度旋臂整体左右平移
    moveSpan: [0.0, 0.8],    // 平移贯穿分裂前 80%，与离散同时进行
    moveMax: 0.22,           // 两半最大平移 = 屏宽 × 此值
    // 阶段二（离散溶解）：从分开瞬间就启动——离散度增加 + 按各自滞后沿曲线溶向两侧槽位
    dissolveSpan: [0.0, 1.0], // 与平移同时开始，最终随机分布在左右
    disperse: 5.0,           // 离散期带内散布放大倍数
    regionX: [0.0, 0.30],    // 单侧空白区横向范围（屏宽比例，右侧取 1-x 镜像）：从屏幕最左/最右边缘开始铺
    regionY: [0.0, 1.0],     // 纵向范围：从上到下铺满全屏
    lagMax: 0.45,            // 离散期每颗星的随机滞后（层次感）
    arc: [40, 150],          // 离散期路径弧线幅度 px：中途向上/下拱起、两端归零
  };

  /* ---------------- 中心光团自转 ---------------- */
  const CORE_SPIN = TAU / 50; // 缓慢旋转（弧度/秒，50s 一圈）

  /* ---------------- 离屏剔除 ---------------- */
  // 屏幕外（含余量）的星星跳过鼠标交互与绘制；余量 = 最大光晕半径 + 鼠标偏移上限 150 + 漂移
  const CULL_M = 240;

  /* ---------------- 背景星拖动受力开关 ---------------- */
  // 按住鼠标拖动星系旋转期间，背景星是否仍受“来拒去留”力（默认 false；当前按需求打开）
  const BG_DRAG_FORCE = true;

  /* ---------------- 汇聚路径 ---------------- */
  const GATHER_MODE = 'arc'; // 's' = 瘦高 S 形（官网同款）/ 'arc' = 逆时针圆弧
  const S_SHAPE = {
    blend: 0.8,  // 侧弯方向权重（相对弦方向混入逆时针切向的程度）
    a1: 0.45,    // 出弯控制臂长（占弦长比例，越大弯得越开）
    a2: 0.45,    // 入弯控制臂长（占弦长比例）
  };

  /* ---------------- 拖动旋转（轨迹球，松手回位） ---------------- */
  const DRAG_ROT = { degPerPx: 0.25 }; // 灵敏度；回位速度在 cam3d.js RETURN_SPEED

  /* ---------------- 鼠标交互参数 ---------------- */
  const MOUSE = {
    radius: 150,   // 影响半径(px)
    push: 3.2,     // 来拒：推开前方星星的强度
    pull: 2.0,     // 去留：拖带后方星星的强度
    spring: 1.8,   // 归位弹簧刚度（越小回得越慢）
    damp: 3.0,     // 阻尼（近临界阻尼，归位不震荡）
    maxOff: 150,   // 最大位移(px)
  };

  /* ---------------- 样条：centripetal Catmull-Rom（设计坐标） ---------------- */
  function crcPoint(p0, p1, p2, p3, t) {
    const d01 = Math.max(Math.hypot(p1.x - p0.x, p1.y - p0.y) ** 0.5, 1e-4);
    const d12 = Math.max(Math.hypot(p2.x - p1.x, p2.y - p1.y) ** 0.5, 1e-4);
    const d23 = Math.max(Math.hypot(p3.x - p2.x, p3.y - p2.y) ** 0.5, 1e-4);
    const t0 = 0, t1 = t0 + d01, t2 = t1 + d12, t3 = t2 + d23;
    const tt = t1 + (t2 - t1) * t;
    const mix = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
    const A1 = mix(p0, p1, (tt - t0) / (t1 - t0));
    const A2 = mix(p1, p2, (tt - t1) / (t2 - t1));
    const A3 = mix(p2, p3, (tt - t2) / (t3 - t2));
    const B1 = mix(A1, A2, (tt - t0) / (t2 - t0));
    const B2 = mix(A2, A3, (tt - t1) / (t3 - t1));
    return mix(B1, B2, (tt - t1) / (t2 - t1));
  }

  /**
   * 控制点 → 3D 世界采样（含弧长参数化与平面内法线）
   * XY 取设计稿平面，Y（高度）由 ARMS_3D 的 z(u)=z0·(1−u)^k 构造
   */
  function buildArm(def) {
    const P = def.pts.map(([x, y]) => ({ x, y }));
    P.push({ x: CFG.center.x, y: CFG.center.y }); // 终点 = 螺旋中心

    const reflect = (a, b) => ({ x: 2 * a.x - b.x, y: 2 * a.y - b.y });
    const segCount = P.length - 1;
    const segSamples = Math.max(4, Math.round(720 / segCount));
    const pts = [];
    for (let i = 0; i < segCount; i++) {
      const p0 = i === 0 ? reflect(P[0], P[1]) : P[i - 1];
      const p1 = P[i];
      const p2 = P[i + 1];
      const p3 = i + 2 >= P.length ? reflect(P[P.length - 1], P[P.length - 2]) : P[i + 2];
      for (let j = 0; j < segSamples; j++) pts.push(crcPoint(p0, p1, p2, p3, j / segSamples));
    }
    pts.push({ x: CFG.center.x, y: CFG.center.y });

    const cum = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) {
      cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    const length = cum[cum.length - 1];

    const z3 = Z3[def.name] || { z0: 0, k: 1 };
    // 优先使用控制点 Z 曲线（zpts），否则回退 z0·(1−u)^k 公式
    const zFn = z3.zpts && window.ZCURVE
      ? window.ZCURVE.make(z3.zpts)
      : (u) => z3.z0 * Math.pow(1 - u, z3.k);
    const world = pts.map((s, i) => {
      const u = cum[i] / length;
      const zh = zFn(u);
      return { x: (s.x - CFG.center.x) / S, y: zh / S, z: (s.y - CFG.center.y) / S };
    });
    // 平面内法线（nx→x, ny→z）
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const tx = b.x - a.x, ty = b.y - a.y;
      const len = Math.hypot(tx, ty) || 1;
      world[i].nx = -ty / len;
      world[i].nz = tx / len;
    }

    function posAt(u) {
      const target = clamp(u, 0, 1) * length;
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < target) lo = mid + 1; else hi = mid;
      }
      const i = Math.max(1, lo);
      const segLen = cum[i] - cum[i - 1] || 1;
      const k = (target - cum[i - 1]) / segLen;
      const A = world[i - 1], Bp = world[i];
      return {
        x: lerp(A.x, Bp.x, k),
        y: lerp(A.y, Bp.y, k),
        z: lerp(A.z, Bp.z, k),
        nx: lerp(A.nx, Bp.nx, k),
        nz: lerp(A.nz, Bp.nz, k),
      };
    }

    return { name: def.name, start: world[0], length, endU: def.endU || 1, posAt };
  }

  /* ---------------- 发光 sprite 预渲染 ---------------- */
  /** 中小星 / 大光晕星：高斯式柔和衰减（核心白 → 本色 → 消散） */
  function makeGlowSprite(rgb) {
    const s = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const c = cv.getContext('2d');
    const col = rgb.join(',');
    const mixW = rgb.map((v) => Math.round(v + (255 - v) * 0.55)).join(',');
    const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0.0, 'rgba(255,255,255,1)');
    g.addColorStop(0.06, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.14, `rgba(${mixW},0.55)`);
    g.addColorStop(0.26, `rgba(${col},0.26)`);
    g.addColorStop(0.42, `rgba(${col},0.10)`);
    g.addColorStop(0.65, `rgba(${col},0.03)`);
    g.addColorStop(1, `rgba(${col},0)`);
    c.fillStyle = g;
    c.fillRect(0, 0, s, s);
    return cv;
  }

  /** 特大星：高斯柔光主体 + 细十字星芒 */
  function makeHaloSprite(rgb) {
    const s = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const c = cv.getContext('2d');
    const col = rgb.join(',');
    for (const [sx, sy] of [[1, 0.03], [0.03, 1]]) {
      c.save();
      c.translate(s / 2, s / 2);
      c.scale(sx, sy);
      const g = c.createRadialGradient(0, 0, 0, 0, 0, s / 2);
      g.addColorStop(0, 'rgba(255,255,255,0.32)');
      g.addColorStop(0.3, `rgba(${col},0.10)`);
      g.addColorStop(1, `rgba(${col},0)`);
      c.fillStyle = g;
      c.fillRect(-s / 2, -s / 2, s, s);
      c.restore();
    }
    const g2 = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.3);
    g2.addColorStop(0, 'rgba(255,255,255,1)');
    g2.addColorStop(0.1, 'rgba(255,255,255,0.85)');
    g2.addColorStop(0.3, `rgba(${col},0.45)`);
    g2.addColorStop(0.6, `rgba(${col},0.12)`);
    g2.addColorStop(1, `rgba(${col},0)`);
    c.fillStyle = g2;
    c.fillRect(0, 0, s, s);
    return cv;
  }

  /* ---------------- 场景 ---------------- */
  class AstraScene {
    constructor(root) {
      this.root = root;
      this.canvas = root.querySelector('.astra-canvas');
      this.ctx = this.canvas.getContext('2d');

      this.sprites = STAR_COLORS.map((c) => makeGlowSprite(c.rgb));
      this.halos = STAR_COLORS.map((c) => makeHaloSprite(c.rgb));

      this.particles = [];
      this.bgStars = [];
      this.coreStars = [];
      this.pulse = 0;
      this.last = 0;
      this.prog = 0;        // 滚动进度（平滑后）：0~1 相机 / 1~2 分裂
      this.scrollTarget = 0;
      this.splitRaw = 0;      // 分裂原始线性进度
      this.moveK = 0;         // 阶段一进度：两半分离平移
      this.dissolveK = 0;     // 阶段二进度：离散溶解
      this.splitShiftPx = 0;  // 阶段一平移量（屏幕 px）

      this.resize = this.resize.bind(this);
      this.frame = this.frame.bind(this);
      window.addEventListener('resize', this.resize);

      const replayBtn = root.querySelector('.astra-replay');
      if (replayBtn) replayBtn.addEventListener('click', () => this.reset());

      // 鼠标状态（位置 + 平滑速度）
      this.mouse = { x: 0, y: 0, vx: 0, vy: 0, lx: 0, ly: 0, lt: 0, active: false };
      root.addEventListener('pointermove', (e) => {
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const m = this.mouse;
        const now = performance.now();
        if (m.active && now > m.lt) {
          const iv = 1000 / (now - m.lt);
          m.vx = m.vx * 0.45 + (mx - m.lx) * iv * 0.55;
          m.vy = m.vy * 0.45 + (my - m.ly) * iv * 0.55;
        }
        m.x = m.lx = mx;
        m.y = m.ly = my;
        m.lt = now;
        m.active = true;
      });
      root.addEventListener('pointerleave', () => {
        this.mouse.active = false;
        this.mouse.vx = this.mouse.vy = 0;
      });
      this.tNow = 0;
      this.curCursor = '';
      // 两侧大字：入场动画（0.9s 延迟 + 2.2s）结束后由 JS 接管透明度，供分裂段淡出
      this.words = Array.from(root.querySelectorAll('.astra-word'));
      this.wordsReady = false;
      this.lastWordA = 1;

      // 拖动旋转整个星系（轨迹球，仅鼠标，触屏留给滚动；松手后自动回位）
      this.dragRot = { on: false, lx: 0, ly: 0 };
      root.addEventListener('pointerdown', (e) => {
        if (e.pointerType && e.pointerType !== 'mouse') return;
        if (e.target.closest('.astra-replay')) return;
        if (this.tNow < CFG.gatherEnd) return; // 汇聚成 6 后才可拖动
        const dr = this.dragRot;
        dr.on = true;
        dr.lx = e.clientX; dr.ly = e.clientY;
      });
      window.addEventListener('pointermove', (e) => {
        const dr = this.dragRot;
        if (!dr.on) return;
        // 轨迹球增量：绕屏幕竖直轴（左右拖）/ 水平轴（上下拖），角度不限
        CAM.drag((e.clientX - dr.lx) * DRAG_ROT.degPerPx,
                 (e.clientY - dr.ly) * DRAG_ROT.degPerPx);
        dr.lx = e.clientX; dr.ly = e.clientY;
      });
      window.addEventListener('pointerup', () => { this.dragRot.on = false; });
      window.addEventListener('pointercancel', () => { this.dragRot.on = false; });

      // 滚动 → 相机俯仰（0~1）+ 分裂阶段（1~2）
      this.readScroll = () => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        this.scrollTarget = max > 0 ? clamp(window.scrollY / max, 0, 1) * 2 : 0;
      };
      window.addEventListener('scroll', this.readScroll, { passive: true });
      this.readScroll();

      this.resize();
      requestAnimationFrame(this.frame);
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, CFG.maxDPR);
      this.W = this.root.clientWidth;
      this.H = this.root.clientHeight;
      this.canvas.width = Math.round(this.W * dpr);
      this.canvas.height = Math.round(this.H * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      this.scale = Math.min(this.W / CFG.shapeW, this.H / CFG.shapeH);
      CAM.setViewport(this.W, this.H, this.scale, CFG.centerAnchorY);

      this.arms = ARMS.map((def) => buildArm(def));
      this.originArms = this.arms.filter((a) => ORIGINS.includes(a.name));

      // 深空背景：中心圆形区域近黑，越靠外越偏深蓝
      const bg = this.ctx.createRadialGradient(
        this.W / 2, this.H / 2, 0,
        this.W / 2, this.H / 2, Math.hypot(this.W, this.H) * 0.62
      );
      bg.addColorStop(0, '#010204');
      bg.addColorStop(0.3, '#030408');
      bg.addColorStop(0.65, '#071020');
      bg.addColorStop(1, '#0b1728');
      this.bgGrad = bg;
      this.ctx.fillStyle = bg;
      this.ctx.fillRect(0, 0, this.W, this.H);
      this.reset();
    }

    reset() {
      this.t0 = performance.now();
      this.pulse = 0;
      this.particles.length = 0;
      this.bgStars.length = 0;
      this.coreStars.length = 0;

      const bandHalf = CFG.bandHalf; // 设计 px
      for (const arm of this.arms) {
        const n = Math.max(80, Math.round(arm.length * CFG.flowDensity));
        for (let i = 0; i < n; i++) this.particles.push(this.makeParticle(arm, bandHalf));
      }
      // 背景星：三档尺寸比例与流动星一致（95.5% 中小 / 4% 大光晕 / 0.5% 十字芒），
      // 不参与汇聚/螺旋变形，一直在背景上；仅在分裂阶段退到两侧（滚回则归位）。
      // 3D 视差（屏幕插值模型，位移有界）：
      //   - 生成区域扩出屏幕四周（x -30%~130%，y -35%~135%）+ 边缘羽化，倾斜时看不到“矩形边”
      //   - 深度平方分布 0.15~1.0：远多近少，最近层与主体同幅度（滚到底最大约 500px）
      CAM.setView(90, 0, 1); // 以初始俯视为生成基准
      const EX0 = -0.3 * this.W, EX1 = 1.3 * this.W, EY0 = -0.35 * this.H, EY1 = 1.35 * this.H;
      for (let i = 0; i < CFG.bgStars; i++) {
        const roll = Math.random();
        let tier;
        if (roll < 0.5306) tier = 'dust';
        else if (roll < 0.955) tier = 'mid';
        else if (roll < 0.995) tier = 'big';
        else tier = 'giant';
        const size = {
          dust: () => rand(0.25, 0.65),
          mid: () => rand(0.7, 1.6),
          big: () => rand(1.8, 3.5),
          giant: () => rand(2.6, 3.8),
        }[tier]();
        const hx = rand(EX0, EX1);
        const hy = rand(EY0, EY1);
        // 反投影：过该像素的射线与星系平面（y=0）的交点 = 视差锚点
        const ray = CAM.rayAt(hx, hy);
        const tt = -ray.camPos[1] / (ray.dir[1] || -1e-6);
        const ax = ray.camPos[0] + ray.dir[0] * tt;
        const az = ray.camPos[2] + ray.dir[2] * tt;
        // 边缘羽化系数：生成矩形外侧 15% 带宽内淡出，任何角度都看不到硬边
        const mx = Math.min(hx - EX0, EX1 - hx) / (0.15 * this.W);
        const my = Math.min(hy - EY0, EY1 - hy) / (0.15 * this.H);
        const edgeA = 0.25 + 0.75 * clamp(Math.min(mx, my), 0, 1);
        const bside = Math.random() < 0.5 ? -1 : 1;
        const bfx = rand(SPLIT.regionX[0], SPLIT.regionX[1]);
        this.bgStars.push({
          x: hx,
          y: hy,
          ax, az,                    // 星系平面上的视差锚点
          depth: 0.15 + 0.85 * Math.random() * Math.random(), // 深度：远多近少，1 = 与主体同幅度
          edgeA,                     // 边缘羽化透明度
          size, tier,
          ci: pickColorIndex(), // 与主体同一套 7 色高亮配色
          baseA: rand(0.55, 1), // 亮度也与主体一致
          ox: 0, oy: 0, vx: 0, vy: 0,
          side: bside,
          sfx: bside < 0 ? bfx : 1 - bfx,
          sfy: rand(SPLIT.regionY[0], SPLIT.regionY[1]),
          lag: rand(0, SPLIT.lagMax),
          arcA: rand(SPLIT.arc[0], SPLIT.arc[1]) * (Math.random() < 0.5 ? -1 : 1),
        });
      }
      // 中心光团：白色光晕球（初始满屏散布 → 弧线汇聚 → 聚成中心团）
      const coreR = 26 / S; // 世界单位
      for (let i = 0; i < 70; i++) {
        const a = Math.random() * TAU;
        const b = Math.acos(rand(-1, 1));
        const rr = coreR * Math.pow(Math.random(), 1.8);
        const cside = Math.random() < 0.5 ? -1 : 1;
        const cfx = rand(SPLIT.regionX[0], SPLIT.regionX[1]);
        const clag = rand(0, SPLIT.lagMax);
        const carc = rand(SPLIT.arc[0], SPLIT.arc[1]) * (Math.random() < 0.5 ? -1 : 1);
        this.coreStars.push({
          wx: rr * Math.sin(b) * Math.cos(a),
          wy: rr * Math.cos(b) * 0.7,
          wz: rr * Math.sin(b) * Math.sin(a),
          size: Math.random() < 0.12 ? rand(2.2, 3.6) : rand(0.8, 2.0),
          ci: Math.random() < 0.85 ? 0 : 1,
          baseA: rand(0.35, 0.8),
          x0: Math.random() * this.W,
          y0: Math.random() * this.H,
          driftP: rand(0, TAU),
          driftR: rand(4, 14),
          delay: Math.random() * 0.55,
          ox: 0, oy: 0, vx: 0, vy: 0, // 每个球独立的鼠标交互位移/速度
          side: cside,                                     // 分裂归属侧
          sfx: cside < 0 ? cfx : 1 - cfx,                  // 分裂槽位（屏宽比例）
          sfy: rand(SPLIT.regionY[0], SPLIT.regionY[1]),   // 分裂槽位（屏高比例）
          lag: clag, arcA: carc,                           // 分裂滞后 + 弧线幅度
          ga: null,
        });
      }
    }

    makeParticle(arm, bandHalf) {
      // 比例：95.5% 中小星 / 4% 大光晕星 / 0.5% 带十字芒特大星
      const roll = Math.random();
      let tier;
      if (roll < 0.5306) tier = 'dust'; // 中小星内部仍按 尘埃5 : 中等4 分配
      else if (roll < 0.955) tier = 'mid';
      else if (roll < 0.995) tier = 'big';
      else tier = 'giant';

      // 横向散布（设计 px）：大星靠近带中心，尘埃散布更宽
      const sigmaScale = { dust: 1.35, mid: 0.85, big: 0.5, giant: 0.35 }[tier];
      const off = clamp(gauss(), -2.2, 2.2) * bandHalf * sigmaScale;
      // 垂直厚度散布（设计 px）：同一套 sigmaScale，截面呈扁椭圆管道
      const offY = clamp(gauss(), -2.2, 2.2) * (CFG.bandHalfY || 0) * sigmaScale;

      const size = {
        dust: () => rand(0.25, 0.65),
        mid: () => rand(0.7, 1.6),
        big: () => rand(1.8, 3.5),
        giant: () => rand(2.6, 3.8),
      }[tier]();

      // 分裂槽位：所属一侧空白区内的均匀随机位置（屏宽/高比例，随窗口自适应）
      const side = Math.random() < 0.5 ? -1 : 1;
      const fx = rand(SPLIT.regionX[0], SPLIT.regionX[1]);
      const sfx = side < 0 ? fx : 1 - fx;
      const sfy = rand(SPLIT.regionY[0], SPLIT.regionY[1]);
      // 分裂路径：随机滞后（先后层次）+ 向上/下拱起的弧线幅度（走曲线）
      const lag = rand(0, SPLIT.lagMax);
      const arcA = rand(SPLIT.arc[0], SPLIT.arc[1]) * (Math.random() < 0.5 ? -1 : 1);

      return {
        arm,
        u: Math.random(),
        period: rand(CFG.flowPeriod[0], CFG.flowPeriod[1]),
        delay: Math.random() * 0.55,
        x0: Math.random() * this.W,
        y0: Math.random() * this.H,
        driftP: rand(0, TAU),
        driftR: rand(4, 14),
        off,
        offY,
        size,
        tier,
        ox: 0, oy: 0, vx: 0, vy: 0, // 鼠标交互位移/速度
        ci: pickColorIndex(),
        baseA: rand(0.55, 1),
        side, sfx, sfy, // 分裂阶段归属侧 + 槽位
        lag, arcA,      // 分裂滞后 + 弧线幅度
        // 5% 中小星在运动中被“点燃”，平滑变大成为大光晕星
        willGrow: (tier === 'dust' || tier === 'mid') && Math.random() < 0.05,
        growAt: rand(0.15, 0.8),
        growK: 0,
        bigSize: rand(1.8, 3.5),
        ga: null, // 汇聚弧线缓存
      };
    }

    /** 粒子在臂上的世界坐标（含平面法线偏移 + 垂直厚度偏移；分裂时散布放大） */
    armPos(p) {
      const tp = p.arm.posAt(p.u);
      // 离散度用 sqrt 快起步曲线：分裂刚开始就明显蓬松（dsp 即时可见），后段增速放缓
      const dsp = 1 + Math.sqrt(this.dissolveK) * SPLIT.disperse;
      const ow = (p.off * dsp) / S;
      return { x: tp.x + tp.nx * ow, y: tp.y + (p.offY * dsp) / S, z: tp.z + tp.nz * ow };
    }

    /**
     * 鼠标“来拒去留”力 + 弹簧归位（屏幕空间）：直接更新粒子的偏移量 (ox, oy)
     *  力方向 = 鼠标运动速度方向（不是 360° 径向，避免扫出圆形空洞）：
     *  来拒：前方星星被向前推开（顺速度方向逃离）
     *  去留：后方星星被向前拖带（跟随鼠标尾流）
     *  无鼠标力时：弱弹簧把偏移量缓慢拉回 0（回到原运行路径）
     */
    interact(p, x, y, dt, forceOnDrag) {
      const m = this.mouse;
      if (m.active && (forceOnDrag || !this.dragRot.on)) { // 拖动旋转时默认不施力，除非调用处显式打开
        const speed = Math.hypot(m.vx, m.vy);
        if (speed > 1) {
          const dx = x + p.ox - m.x;
          const dy = y + p.oy - m.y;
          const d2 = dx * dx + dy * dy;
          const R = MOUSE.radius;
          if (d2 < R * R && d2 > 0.01) {
            const d = Math.sqrt(d2);
            const fall = (1 - d / R) ** 2;
            // 速度方向的单位向量
            const ux = m.vx / speed, uy = m.vy / speed;
            const appr = m.vx * (dx / d) + m.vy * (dy / d);
            // 前方（appr>0）用推力系数，后方用拖带系数；方向一律沿速度
            const f = speed * (appr > 0 ? MOUSE.push : MOUSE.pull) * fall;
            p.vx += ux * f * dt;
            p.vy += uy * f * dt;
          }
        }
      }
      p.vx += (-MOUSE.spring * p.ox - MOUSE.damp * p.vx) * dt;
      p.vy += (-MOUSE.spring * p.oy - MOUSE.damp * p.vy) * dt;
      p.ox += p.vx * dt;
      p.oy += p.vy * dt;
      const o2 = p.ox * p.ox + p.oy * p.oy;
      if (o2 > MOUSE.maxOff * MOUSE.maxOff) {
        const s = MOUSE.maxOff / Math.sqrt(o2);
        p.ox *= s; p.oy *= s;
        p.vx *= 0.4; p.vy *= 0.4;
      }
    }

    /**
     * 汇聚路径（屏幕空间）：两种可切换（文件顶部 GATHER_MODE）
     *  's'   瘦高 S 形：三次贝塞尔，先向逆时针侧弯出、再从对侧回摆汇入
     *  'arc' 逆时针圆弧：绕 O 点极坐标插值
     */
    gatherPos(p, tx, ty, sx, sy, progress, O) {
      if (progress <= 0) return { x: sx, y: sy };
      const k = easeInOutCubic(progress);

      if (GATHER_MODE === 's') {
        if (!p.gs) {
          // 首帧锚定：弦方向 + 逆时针切向 → 出/入弯方向（两侧相反成 S）
          const dx0 = tx - sx, dy0 = ty - sy;
          const len0 = Math.hypot(dx0, dy0) || 1;
          const rx = sx - O.x, ry = sy - O.y;
          const rl = Math.hypot(rx, ry) || 1;
          const ccwx = ry / rl, ccwy = -rx / rl; // 屏幕坐标逆时针切向
          let vx = (dx0 / len0) * 0.6 + ccwx * S_SHAPE.blend;
          let vy = (dy0 / len0) * 0.6 + ccwy * S_SHAPE.blend;
          const vl = Math.hypot(vx, vy) || 1;
          vx /= vl; vy /= vl;
          p.gs = {
            sx, sy, vx, vy, len0,
            m1: S_SHAPE.a1 * rand(0.75, 1.3), // 每颗星幅度略有差异
            m2: S_SHAPE.a2 * rand(0.75, 1.3),
          };
        }
        const g = p.gs;
        const c1x = g.sx + g.vx * g.len0 * g.m1;
        const c1y = g.sy + g.vy * g.len0 * g.m1;
        const c2x = tx - g.vx * g.len0 * g.m2; // 入弯控制点随目标移动
        const c2y = ty - g.vy * g.len0 * g.m2;
        const u = 1 - k;
        return {
          x: u * u * u * g.sx + 3 * u * u * k * c1x + 3 * u * k * k * c2x + k * k * k * tx,
          y: u * u * u * g.sy + 3 * u * u * k * c1y + 3 * u * k * k * c2y + k * k * k * ty,
        };
      }

      // 'arc'：逆时针圆弧（保留）
      if (!p.ga) {
        p.ga = {
          a0: Math.atan2(sy - O.y, sx - O.x),
          r0: Math.hypot(sx - O.x, sy - O.y),
          extra: 0,
        };
        const a10 = Math.atan2(ty - O.y, tx - O.x);
        const gap0 = ((p.ga.a0 - a10) % TAU + TAU) % TAU;
        if (gap0 < 0.8) p.ga.extra = TAU; // 角距太小则多绕一整圈，保证弧线明显
      }
      const a1 = Math.atan2(ty - O.y, tx - O.x);
      const r1 = Math.hypot(tx - O.x, ty - O.y);
      const gap = ((p.ga.a0 - a1) % TAU + TAU) % TAU;
      const a = p.ga.a0 - (gap + p.ga.extra) * k;
      const r = lerp(p.ga.r0, r1, k);
      return { x: O.x + Math.cos(a) * r, y: O.y + Math.sin(a) * r };
    }

    frame(now) {
      if (!this.last) this.last = now;
      const dt = Math.min((now - this.last) / 1000, 0.05);
      this.last = now;
      const t = (now - this.t0) / 1000;
      this.tNow = t;
      const { ctx, W, H } = this;

      // 鼠标速度衰减（停止移动后迅速归零，避免残余推力）
      const vdk = Math.exp(-dt * 6);
      this.mouse.vx *= vdk;
      this.mouse.vy *= vdk;

      // 滚动平滑 → 相机（页面向下滚动，视角趋于平行）
      this.prog += (this.scrollTarget - this.prog) * (1 - Math.exp(-dt * CAM_MOVE.smooth));
      // 分裂强度：相机到达极限（prog>1）后继续滚动
      //   阶段一 moveK：裂成两半，两个半密度旋臂整体左右平移（形状保持）
      //   阶段二 dissolveK：离散度增加 + 溶解到两侧均匀槽位
      this.splitRaw = clamp(this.prog - SPLIT.progStart, 0, 1);
      this.moveK = smoothstep(SPLIT.moveSpan[0], SPLIT.moveSpan[1], this.splitRaw);
      this.dissolveK = smoothstep(SPLIT.dissolveSpan[0], SPLIT.dissolveSpan[1], this.splitRaw);
      this.splitShiftPx = this.moveK * SPLIT.moveMax * W;

      // 两侧大字：过阈值继续滚动 → 随分裂进度淡出（往回补滚会淡回来）
      if (!this.wordsReady && t > 3.3) {
        this.words.forEach((w) => { w.style.animation = 'none'; w.style.opacity = '1'; });
        this.wordsReady = true;
      }
      if (this.wordsReady) {
        const wa = 1 - smoothstep(0, 0.45, this.splitRaw);
        if (Math.abs(wa - this.lastWordA) > 0.005) {
          this.lastWordA = wa;
          const blur = (1 - wa) * 8;
          for (const w of this.words) {
            w.style.opacity = wa.toFixed(3);
            w.style.filter = blur > 0.1 ? 'blur(' + blur.toFixed(1) + 'px)' : 'none';
          }
        }
      }
      // 相机：滚动设定目标朝向（prog 超过 1 后保持极限角度）；拖动轨迹球偏移；松手后最短弧回位
      const dr = this.dragRot;
      const camProg = clamp(this.prog, 0, 1);
      CAM.setView(
        lerp(CAM_MOVE.elStart, CAM_MOVE.elEnd, camProg),
        lerp(CAM_MOVE.azStart, CAM_MOVE.azEnd, camProg),
        lerp(1, CAM_MOVE.dollyEnd, camProg)
      );
      CAM.tick(dt, dr.on);
      const O = CAM.project({ x: 0, y: 0, z: 0 }); // 原点屏幕位置（恒为画面中心锚点）

      /* ----- 背景覆盖（极深蓝渐变；trailAlpha<1 时呈拖尾） ----- */
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = t < CFG.gatherEnd ? CFG.trailAlphaGather : CFG.trailAlphaFlow;
      ctx.fillStyle = this.bgGrad;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;

      ctx.globalCompositeOperation = 'lighter';

      /* ----- 远景静态星（响应鼠标；相机倾斜时按深度视差错位；分裂时退到两侧） ----- */
      for (const s of this.bgStars) {
        if (s.baseA <= 0.02) continue;
        // 锚点随星系平面移动，星星全幅度跟随 → 与主体一致的 3D 错位
        const ap = CAM.project({ x: s.ax, y: 0, z: s.az });
        let bx = lerp(s.x, ap.x, s.depth);
        let by = lerp(s.y, ap.y, s.depth);
        // 分裂阶段二：背景星同步退到两侧（滞后 + 弧线）
        if (this.dissolveK > 0) {
          const k = smoothstep(0, 1, clamp((this.dissolveK - s.lag) / (1 - s.lag), 0, 1));
          if (k > 0) {
            bx = lerp(bx, s.sfx * W, k);
            by = lerp(by, s.sfy * H, k) + Math.sin(Math.PI * k) * s.arcA;
          }
        }
        // 离屏剔除：跳过交互与绘制；鼠标偏移缓慢衰减，回到屏内时不跳变
        if (bx < -CULL_M || bx > W + CULL_M || by < -CULL_M || by > H + CULL_M) {
          s.ox *= 0.88; s.oy *= 0.88; s.vx = s.vy = 0;
          continue;
        }
        this.interact(s, bx, by, dt, BG_DRAG_FORCE); // 背景星：拖动旋转时是否受力由开关控制
        ctx.globalAlpha = s.baseA * s.edgeA;
        const f = s.tier === 'giant' ? 24 : s.tier === 'big' ? 16 : 10; // 与流动星同系数
        const d = s.size * f * this.scale;
        const spr = s.tier === 'giant' ? this.halos[s.ci] : this.sprites[s.ci];
        ctx.drawImage(spr, bx + s.ox - d / 2, by + s.oy - d / 2, d, d);
      }

      /* ----- 流动星 ----- */
      const ramp = smoothstep(CFG.scatterEnd, CFG.gatherEnd, t);
      const gathered = t >= CFG.gatherEnd;
      // 手型光标：汇聚完成后悬停显示抓手，拖动中显示抓紧
      const wantCursor = dr.on ? 'grabbing' : (gathered ? 'grab' : '');
      if (this.curCursor !== wantCursor) {
        this.root.style.cursor = wantCursor;
        this.curCursor = wantCursor;
      }
      let absorbed = 0;

      for (const p of this.particles) {
        if (ramp > 0) {
          // 匀速流动，仅最末端轻微加速（+30%）
          const speedK = 1 + 0.3 * smoothstep(0.9, 1, p.u / p.arm.endU);
          p.u += (dt / p.period) * ramp * speedK;
          if (p.u >= p.arm.endU) {
            p.u -= p.arm.endU;
            absorbed++;
            // 重生：中小星重新掷 5% 的“点燃”概率
            if (p.tier === 'dust' || p.tier === 'mid') {
              p.willGrow = Math.random() < 0.05;
              p.growAt = rand(0.15, 0.8);
              p.growK = 0;
              p.bigSize = rand(1.8, 3.5);
            }
          }
        }
        // 到达触发点开始平滑变大（约 3s 完成）
        if (p.willGrow && p.growK < 1 && p.u / p.arm.endU >= p.growAt) {
          p.growK = Math.min(1, p.growK + dt / 3);
        }
        const sp = CAM.project(this.armPos(p));

        let x, y;
        if (gathered) {
          x = sp.x; y = sp.y;
        } else {
          const sx = p.x0 + Math.cos(t * 0.35 + p.driftP) * p.driftR;
          const sy = p.y0 + Math.sin(t * 0.28 + p.driftP * 1.7) * p.driftR;
          const progress = clamp(
            (t - CFG.scatterEnd - p.delay) / (CFG.gatherEnd - CFG.scatterEnd - 0.4), 0, 1
          );
          const g = this.gatherPos(p, sp.x, sp.y, sx, sy, progress, O);
          x = g.x; y = g.y;
        }

        // 分裂阶段一：归属侧整体平移——裂成两个半密度旋臂，形状完整、流动不中断
        x += this.splitShiftPx * p.side;

        // 分裂阶段二：离散度增加的同时，按各自滞后、沿拱起曲线溶解到侧方槽位
        if (this.dissolveK > 0) {
          const k = smoothstep(0, 1, clamp((this.dissolveK - p.lag) / (1 - p.lag), 0, 1));
          if (k > 0) {
            const arc = Math.sin(Math.PI * k) * p.arcA; // 中途拱起，两端归零
            const ddx = Math.cos(t * 0.35 + p.driftP) * p.driftR * k;
            const ddy = Math.sin(t * 0.28 + p.driftP * 1.7) * p.driftR * k;
            x = lerp(x, p.sfx * W + ddx, k);
            y = lerp(y, p.sfy * H + ddy, k) + arc;
          }
        }

        // 离屏剔除：跳过交互与绘制（u 推进保留，流动不暂停）
        if (x < -CULL_M || x > W + CULL_M || y < -CULL_M || y > H + CULL_M) {
          p.ox *= 0.88; p.oy *= 0.88; p.vx = p.vy = 0;
          continue;
        }

        // 鼠标交互：来拒去留 + 弹簧归位
        this.interact(p, x, y, dt);
        x += p.ox;
        y += p.oy;

        // 亮度恒定，无任何闪烁
        const eU = p.arm.endU;
        const fadeEnds = smoothstep(0, 0.045 * eU, p.u) * (1 - smoothstep(eU - 0.055 * eU, eU, p.u));
        const fade = lerp(1, fadeEnds, ramp);
        const alpha = p.baseA * fade;
        if (alpha <= 0.015) continue;

        // 出生段：星星在起点从微小光点逐渐长大（约 6% 臂长内完成）
        const born = smoothstep(0, 0.06 * eU, p.u);
        const sizeK = lerp(1, lerp(0.12, 1, born), ramp);

        const grow = 1 + 0.3 * smoothstep(0.9, 1, p.u / eU);
        const px = sp.sc / S; // 设计 px → 屏幕 px（含逐点深度：近大远小）
        ctx.globalAlpha = alpha;
        if (p.tier === 'giant') {
          const d = p.size * 24 * px * grow * sizeK;
          ctx.drawImage(this.halos[p.ci], x - d / 2, y - d / 2, d, d);
        } else if (p.tier === 'big') {
          const d = p.size * 16 * px * grow * sizeK;
          ctx.drawImage(this.sprites[p.ci], x - d / 2, y - d / 2, d, d);
        } else {
          // 中小星：被“点燃”的平滑过渡为大光晕星
          const gk = p.growK;
          const ek = 1 - Math.pow(1 - gk, 3); // easeOutCubic
          const size = gk > 0 ? lerp(p.size, p.bigSize, ek) : p.size;
          const d = size * lerp(10, 16, ek) * px * grow * sizeK;
          ctx.drawImage(this.sprites[p.ci], x - d / 2, y - d / 2, d, d);
        }
      }

      this.pulse = this.pulse * 0.9 + Math.min(absorbed * 0.008, 0.1);

      /* ----- 起点光斑（星星诞生处的小亮点，恒定亮度） ----- */
      const originIn = smoothstep(CFG.originGlowIn[0], CFG.originGlowIn[1], t);
      if (originIn > 0) {
        this.originArms.forEach((arm) => {
          const sp = CAM.project(arm.start);
          ctx.globalAlpha = 0.07 * originIn;
          const d = 32 * (sp.sc / S);
          ctx.drawImage(this.sprites[0], sp.x - d / 2, sp.y - d / 2, d, d);
        });
      }

      /* ----- 中心光团（光晕球散布→汇聚→成团；吞星增亮；每个球独立响应鼠标） ----- */
      // 光晕球本体：全程可见，从满屏散布沿逆时针弧线汇入中心；独立受力，鼠标擦过呈果冻形变
      const boost = 1 + this.pulse * 0.8;
      const coreRot = t * CORE_SPIN;         // 中心光团小范围缓慢自转
      const cosR = Math.cos(coreRot), sinR = Math.sin(coreRot);
      for (const s of this.coreStars) {
        // 绕世界 Y 轴（过中心）旋转
        const rx = s.wx * cosR + s.wz * sinR;
        const rz = -s.wx * sinR + s.wz * cosR;
        const tp = CAM.project({ x: rx, y: s.wy, z: rz });
        let x, y;
        if (gathered) {
          x = tp.x; y = tp.y;
        } else {
          const x0 = s.x0 + Math.cos(t * 0.35 + s.driftP) * s.driftR;
          const y0 = s.y0 + Math.sin(t * 0.28 + s.driftP * 1.7) * s.driftR;
          const progress = clamp(
            (t - CFG.scatterEnd - s.delay) / (CFG.gatherEnd - CFG.scatterEnd - 0.4), 0, 1
          );
          const g = this.gatherPos(s, tp.x, tp.y, x0, y0, progress, O);
          x = g.x; y = g.y;
        }
        // 分裂阶段一：光球随归属侧整体平移
        x += this.splitShiftPx * s.side;
        // 分裂阶段二：光球同样按各自滞后、沿拱起曲线溶解到侧方槽位
        if (this.dissolveK > 0) {
          const k = smoothstep(0, 1, clamp((this.dissolveK - s.lag) / (1 - s.lag), 0, 1));
          if (k > 0) {
            const arc = Math.sin(Math.PI * k) * s.arcA;
            const ddx = Math.cos(t * 0.35 + s.driftP) * s.driftR * k;
            const ddy = Math.sin(t * 0.28 + s.driftP * 1.7) * s.driftR * k;
            x = lerp(x, s.sfx * W + ddx, k);
            y = lerp(y, s.sfy * H + ddy, k) + arc;
          }
        }
        this.interact(s, x, y, dt); // 每球独立：来拒去留 + 弹簧回位
        x += s.ox; y += s.oy;
        ctx.globalAlpha = Math.min(1, s.baseA * boost);
        const d = s.size * 13 * (tp.sc / S);
        ctx.drawImage(this.sprites[s.ci], x - d / 2, y - d / 2, d, d);
      }

      ctx.globalAlpha = 1;
      requestAnimationFrame(this.frame);
    }
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    document.querySelectorAll('.astra-hero').forEach((root) => {
      if (!root.__astraScene) root.__astraScene = new AstraScene(root);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  window.AstraScene = AstraScene;
})();
