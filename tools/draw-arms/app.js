/* ============================================================
 * 旋臂画板 · 主逻辑
 *
 * 两种模式：
 *   ✏️ 画线 —— 按住鼠标画线，松开后 RDP 拟合为控制点；
 *              选中已有线条的臂再画，新线段自动从上次终点接续。
 *   👆 拖点 —— 悬停高亮控制点，按住拖动微调；实时重采样曲线。
 *
 * 状态栏实时显示鼠标极坐标与「距其他臂的最近距离」（<40px 变红）。
 * ============================================================ */
(function () {
  'use strict';

  const {
    DESIGN_W, DESIGN_H, CENTER, MERGE_R, MIN_GAP,
    dist, polarOf, rdp, sampleSpline,
  } = window.ASTRA_SPLINE;

  const ARMS_META = [
    { name: 'G', color: '#4ade80', hint: '主螺旋：从右上尾巴尖经头部弧线画向中心' },
    { name: 'R', color: '#f87171', hint: '第二道：从左上外缘经左侧画向中心' },
    { name: 'O', color: '#fb923c', hint: '外圈主体：从左侧画满 6 的身体' },
    { name: 'P', color: '#c084fc', hint: '紫臂分叉：从腰部右侧画向中心' },
    { name: 'B', color: '#60a5fa', hint: '下弧内侧：从底部画向右侧再内汇' },
  ];

  /* ---------------- 状态 ---------------- */
  const lines = {}; // name -> { cps:[{x,y}], sampled:[{x,y}], length }
  // 导入文件里的 CFG / 调色板源码块：导出时原样带回，避免旧模板覆盖引擎侧最新调参
  let importedBlocks = { cfg: null, colors: null };
  let currentArm = 'G';
  let mode = 'draw'; // 'draw' | 'edit'
  let drawing = false;
  let rawLine = [];
  let dragCp = null;  // { arm, index } 拖动中
  let hoverCp = null; // { arm, index } 悬停中
  let epsilon = 5;
  let refAlpha = 0.45;
  let refMode = 'final';
  let refMove = false;        // 背景图平移模式：开启后画布拖动只移动背景图
  const refOffsets = {};      // 每种参考图各自的设计坐标偏移 refMode -> {x,y}
  let panning = null;         // 拖动中 { sx, sy, ox, oy }
  let showGrid = true;
  let mouse = null;
  const refImages = {};

  /* ---------------- DOM ---------------- */
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  let viewScale = 1, dpr = 1;

  const metaOf = (name) => ARMS_META.find((m) => m.name === name);

  /** 当前参考图的偏移量（不存在则创建） */
  const refOff = () => (refOffsets[refMode] = refOffsets[refMode] || { x: 0, y: 0 });

  /* ---------------- 臂数据操作 ---------------- */
  function resample(name) {
    const L = lines[name];
    const { pts, length } = sampleSpline(L.cps);
    L.sampled = pts;
    L.length = length;
  }

  /** 画线结束：RDP 拟合 + 与已有线段接续合并 */
  function finalizeLine() {
    if (rawLine.length < 2) { rawLine = []; return; }
    let cps = rdp(rawLine, epsilon).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    const existing = lines[currentArm];
    if (existing) {
      // rawLine 首点是旧终点，rdp 后仍保留 → 去掉旧线尾点避免重复
      cps = [...existing.cps.slice(0, -1), ...cps];
    }
    lines[currentArm] = { cps };
    resample(currentArm);
    rawLine = [];
    const next = ARMS_META.find((m) => !lines[m.name]);
    setArm(next ? next.name : currentArm);
    updateStatus();
  }

  function setArm(name) {
    currentArm = name;
    refreshArmPicker();
    updateTip();
  }

  function updateTip() {
    const m = metaOf(currentArm);
    if (mode === 'edit') {
      $('tipbar').innerHTML =
        `<b>拖点模式</b> —— 悬停控制点（小圆点）会变白，按住拖动微调位置。` +
        `状态栏显示与其他臂的距离，<b>≥${MIN_GAP}px</b> 达标，<b class="warn">变红说明太近</b>。`;
      return;
    }
    const L = lines[currentArm];
    $('tipbar').innerHTML = L
      ? `<b style="color:${m.color}">正在画 ${m.name}</b>（已有 ${L.cps.length} 个控制点）—— ` +
        `新线段将<b>从上次终点接续</b>；想重画请先点「清除当前臂」。`
      : `<b style="color:${m.color}">正在画 ${m.name}</b> —— ${m.hint}。` +
        `从外侧起点画向中心，与已有线保持 <b>≥${MIN_GAP}px</b>。画到中心附近即可，引擎会自动吸附。`;
  }

  function refreshArmPicker() {
    $('armPicker').innerHTML = ARMS_META.map((m) => {
      const done = lines[m.name] ? '<span class="done">✓</span>' : '';
      return `<button class="arm-btn ${m.name === currentArm ? 'active' : ''}"
        style="--c:${m.color}" data-arm="${m.name}">
        <span class="dot"></span>${m.name}${done}</button>`;
    }).join('');
    $('armPicker').querySelectorAll('.arm-btn').forEach((b) =>
      b.addEventListener('click', () => setArm(b.dataset.arm))
    );
  }

  function updateStatus() {
    const n = Object.keys(lines).length;
    $('stArms').textContent = `已画 ${n} / 5 条` +
      (n ? ' · ' + ARMS_META.filter((m) => lines[m.name])
        .map((m) => `${m.name}(${lines[m.name].cps.length}点/${Math.round(lines[m.name].length)}px)`)
        .join(' ') : '');
  }

  /* ---------------- 视图 ---------------- */
  function resize() {
    const pad = 26;
    viewScale = Math.min((stage.clientWidth - pad * 2) / DESIGN_W,
                         (stage.clientHeight - pad * 2) / DESIGN_H);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = DESIGN_W * viewScale + 'px';
    canvas.style.height = DESIGN_H * viewScale + 'px';
    canvas.width = Math.round(DESIGN_W * viewScale * dpr);
    canvas.height = Math.round(DESIGN_H * viewScale * dpr);
    draw();
  }

  function toDesign(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / viewScale,
      y: (e.clientY - rect.top) / viewScale,
    };
  }

  function draw() {
    ctx.setTransform(dpr * viewScale, 0, 0, dpr * viewScale, 0, 0);
    ctx.fillStyle = '#070a10';
    ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);

    // 参考图（contain 适配设计区 + 用户平移偏移）
    const img = refImages[refMode];
    if (img && img.complete && img.naturalWidth) {
      const s = Math.min(DESIGN_W / img.naturalWidth, DESIGN_H / img.naturalHeight);
      const w = img.naturalWidth * s, h = img.naturalHeight * s;
      const o = refOff();
      ctx.globalAlpha = refAlpha;
      ctx.drawImage(img, (DESIGN_W - w) / 2 + o.x, (DESIGN_H - h) / 2 + o.y, w, h);
      ctx.globalAlpha = 1;
    }

    // 网格
    if (showGrid) {
      ctx.lineWidth = 1;
      for (let x = 0; x <= DESIGN_W; x += 100) {
        ctx.strokeStyle = x % 500 === 0 ? 'rgba(120,140,170,0.16)' : 'rgba(120,140,170,0.07)';
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, DESIGN_H); ctx.stroke();
      }
      for (let y = 0; y <= DESIGN_H; y += 100) {
        ctx.strokeStyle = y % 500 === 0 ? 'rgba(120,140,170,0.16)' : 'rgba(120,140,170,0.07)';
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(DESIGN_W, y); ctx.stroke();
      }
    }

    // 中心标记 + 汇入区圈
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(CENTER.x - 16, CENTER.y); ctx.lineTo(CENTER.x + 16, CENTER.y);
    ctx.moveTo(CENTER.x, CENTER.y - 16); ctx.lineTo(CENTER.x, CENTER.y + 16);
    ctx.stroke();
    ctx.setLineDash([5, 6]);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath(); ctx.arc(CENTER.x, CENTER.y, MERGE_R, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText(`中心 (${CENTER.x}, ${CENTER.y})`, CENTER.x + 20, CENTER.y - 20);

    // 已画臂：拟合平滑线 + 控制点
    for (const m of ARMS_META) {
      const L = lines[m.name];
      if (!L) continue;
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      L.sampled.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      L.cps.forEach((p, i) => {
        const hot = hoverCp && hoverCp.arm === m.name && hoverCp.index === i;
        ctx.beginPath();
        ctx.arc(p.x, p.y, hot ? 6 : 3, 0, Math.PI * 2);
        ctx.fillStyle = hot ? '#ffffff' : m.color;
        ctx.fill();
        if (hot) { ctx.strokeStyle = m.color; ctx.lineWidth = 1.5; ctx.stroke(); }
      });
      // 起点标记 + 名称
      const s = L.cps[0];
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(s.x, s.y, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = m.color;
      ctx.fillText(m.name, s.x + 10, s.y - 8);
      // 终点标记（汇入中心前的最后一个手绘点）
      const e = L.cps[L.cps.length - 1];
      ctx.beginPath(); ctx.arc(e.x, e.y, 5, 0, Math.PI * 2); ctx.stroke();
    }

    // 正在画的原始轨迹（续画时首点为旧终点，天然连线）
    if (rawLine.length > 1) {
      ctx.strokeStyle = metaOf(currentArm).color;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 2;
      ctx.beginPath();
      rawLine.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 鼠标十字
    if (mouse && mouse.x >= 0 && mouse.x <= DESIGN_W && mouse.y >= 0 && mouse.y <= DESIGN_H) {
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(mouse.x, 0); ctx.lineTo(mouse.x, DESIGN_H);
      ctx.moveTo(0, mouse.y); ctx.lineTo(DESIGN_W, mouse.y);
      ctx.stroke();
    }
  }

  /* ---------------- 距离查询 ---------------- */
  function nearestDist(p, excludeArm) {
    let best = Infinity, bestArm = '';
    for (const m of ARMS_META) {
      if (m.name === excludeArm) continue;
      const L = lines[m.name];
      if (!L) continue;
      for (const q of L.sampled) {
        const d = dist(p, q);
        if (d < best) { best = d; bestArm = m.name; }
      }
    }
    return { d: best, arm: bestArm };
  }

  /** 平移模式下的状态栏：鼠标坐标 + 当前背景偏移 */
  function updateRefStatus(p) {
    const o = refOff();
    $('stPos').textContent = `坐标 (${Math.round(p.x)}, ${Math.round(p.y)})`;
    const el = $('stDist');
    el.textContent = `背景偏移 (${o.x}, ${o.y})`;
    el.className = '';
  }

  function updateMouseStatus(p, excludeArm) {
    $('stPos').textContent = `坐标 (${Math.round(p.x)}, ${Math.round(p.y)})`;
    const pl = polarOf(p);
    $('stPolar').textContent = `极坐标 α ${pl.alpha.toFixed(0)}° · r ${pl.r.toFixed(0)}`;
    const { d, arm } = nearestDist(p, excludeArm);
    const el = $('stDist');
    if (!isFinite(d)) {
      el.textContent = '与其他臂距离 –';
      el.className = '';
    } else {
      el.textContent = `与其他臂距离 ${d.toFixed(0)}px（最近：${arm}）`;
      el.className = d < MIN_GAP ? 'danger' : 'ok';
    }
  }

  /* ---------------- 拖点 ---------------- */
  function findCpNear(p, radius) {
    let best = null;
    for (const m of ARMS_META) {
      const L = lines[m.name];
      if (!L) continue;
      L.cps.forEach((cp, i) => {
        const d = dist(p, cp);
        if (d < radius && (!best || d < best.d)) best = { arm: m.name, index: i, d };
      });
    }
    return best;
  }

  /* ---------------- 指针交互 ---------------- */
  canvas.addEventListener('pointerdown', (e) => {
    const p = toDesign(e);
    if (p.x < 0 || p.x > DESIGN_W || p.y < 0 || p.y > DESIGN_H) return;

    // 背景图平移模式：拖动只改偏移，不画线不拖点
    if (refMove) {
      if (!refImages[refMode]) return;
      const o = refOff();
      panning = { sx: p.x, sy: p.y, ox: o.x, oy: o.y };
      canvas.style.cursor = 'grabbing';
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (mode === 'edit') {
      const hit = findCpNear(p, 14 / viewScale);
      if (hit) {
        dragCp = { arm: hit.arm, index: hit.index };
        if (hit.arm !== currentArm) setArm(hit.arm);
        canvas.setPointerCapture(e.pointerId);
      }
      return;
    }

    // 画线模式：续画时从旧终点起笔
    drawing = true;
    const existing = lines[currentArm];
    rawLine = existing ? [{ ...existing.cps[existing.cps.length - 1] }, p] : [p];
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = toDesign(e);
    mouse = p;

    // 背景图平移模式：更新偏移并实时重绘；状态栏显示当前偏移量
    if (refMove) {
      if (panning) {
        const o = refOff();
        o.x = Math.round(panning.ox + (p.x - panning.sx));
        o.y = Math.round(panning.oy + (p.y - panning.sy));
        draw();
      }
      updateRefStatus(p);
      return;
    }

    if (mode === 'edit') {
      if (dragCp) {
        const cp = lines[dragCp.arm].cps[dragCp.index];
        cp.x = Math.round(Math.max(0, Math.min(DESIGN_W, p.x)));
        cp.y = Math.round(Math.max(0, Math.min(DESIGN_H, p.y)));
        resample(dragCp.arm);
        updateMouseStatus(p, dragCp.arm); // 与其他臂的距离
      } else {
        hoverCp = findCpNear(p, 14 / viewScale);
        canvas.style.cursor = hoverCp ? 'grab' : 'crosshair';
        updateMouseStatus(p, null);
      }
      draw();
      return;
    }

    updateMouseStatus(p, currentArm); // 续画时排除当前臂自身
    if (drawing) {
      const last = rawLine[rawLine.length - 1];
      if (dist(p, last) >= 2.5) rawLine.push(p);
    }
    draw();
  });

  canvas.addEventListener('pointerup', () => {
    if (refMove) {
      panning = null;
      canvas.style.cursor = 'grab';
      return;
    }
    if (mode === 'edit') {
      if (dragCp) {
        dragCp = null;
        updateStatus();
        openExportKeep();
      }
      return;
    }
    if (!drawing) return;
    drawing = false;
    finalizeLine();
    draw();
  });

  canvas.addEventListener('pointerleave', () => { mouse = null; hoverCp = null; draw(); });

  /* ---------------- 间距检查 ---------------- */
  function checkSpacing() {
    const names = ARMS_META.map((m) => m.name).filter((n) => lines[n]);
    const issues = [];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const A = lines[names[i]].sampled, B = lines[names[j]].sampled;
        let min = Infinity, at = null;
        const skipA = Math.floor(A.length * 0.04), skipB = Math.floor(B.length * 0.04);
        for (let a = skipA; a < A.length - skipA; a++) {
          const pa = A[a];
          if (Math.hypot(pa.x - CENTER.x, pa.y - CENTER.y) < MERGE_R) continue;
          for (let b = skipB; b < B.length - skipB; b++) {
            const pb = B[b];
            if (Math.hypot(pb.x - CENTER.x, pb.y - CENTER.y) < MERGE_R) continue;
            const d = dist(pa, pb);
            if (d < min) { min = d; at = pa; }
          }
        }
        if (min < MIN_GAP) {
          issues.push(`${names[i]} ↔ ${names[j]}: ${min.toFixed(0)}px @ (${Math.round(at.x)}, ${Math.round(at.y)})`);
        }
      }
    }
    return issues;
  }

  /* ---------------- 导出 ---------------- */
  /** 从 arms-data.js 源码中整段抽取代码块（含缩进与注释），失败返回 null */
  function extractBlock(text, header, closer) {
    const i = text.indexOf(header);
    if (i < 0) return null;
    const j = text.indexOf('\n' + closer, i);
    if (j < 0) return null;
    return text.slice(i, j + 1 + closer.length);
  }

  // 默认配置块：与 js/arms-data.js 当前版本保持一致（导入过文件时以导入为准）
  const DEFAULT_CFG_BLOCK = `const CFG = {
    designW: 1600,
    designH: 900,
    center: { x: 800, y: 555 },
    centerAnchorY: 0.615,
    shapeW: 730,
    shapeH: 880,
    viewFit: 0.95,   // 取景留白系数：1 = 形状贴满窗口限制边；越小四周边距越大

    scatterEnd: 1.8,
    gatherEnd: 5.0,
    centerStarIn: [3.2, 5.4],
    originGlowIn: [4.0, 5.6],

    bandHalf: 9.5,  // 官网星带并非细线：恢复少量横向厚度
    bandHalfY: 5.5,
    flowPeriod: [40, 60],
    flowDensity: 0.56, // 增加彩色微星数量，让旋臂更接近官网的颗粒密度
    bgStars: 640,      // 官网背景仍有相当数量的低亮彩色针尖星

    trailAlphaGather: 1,
    trailAlphaFlow: 1,
    maxDPR: 2,
  };`;

  const DEFAULT_COLORS_BLOCK = `const STAR_COLORS = [
    { rgb: [255, 255, 255], weight: 30 }, // neutral white
    { rgb: [186, 230, 255], weight: 22 }, // ice blue-white
    { rgb: [86, 205, 246],  weight: 18 }, // cyan
    { rgb: [52, 162, 224],  weight: 8 },  // deep cyan
    { rgb: [255, 221, 181], weight: 7 },  // warm white
    { rgb: [255, 157, 83],  weight: 10 }, // amber
    { rgb: [255, 101, 62],  weight: 5 },  // coral
  ];`;

  function buildExport() {
    const armBlocks = ARMS_META.filter((m) => lines[m.name]).map((m) => {
      const pts = lines[m.name].cps.map((p) => `[${p.x}, ${p.y}]`);
      const rows = [];
      for (let i = 0; i < pts.length; i += 5) rows.push(pts.slice(i, i + 5).join(', '));
      return `    {\n      name: '${m.name}',\n      pts: [\n        ${rows.join(',\n        ')},\n      ],\n    }`;
    }).join(',\n');

    const origins = ARMS_META.filter((m) => lines[m.name] && m.name !== 'P')
      .map((m) => `'${m.name}'`).join(', ');

    // CFG / 调色板优先沿用导入文件里的源码块；未导入时用上方默认块
    const cfgBlock = importedBlocks.cfg || DEFAULT_CFG_BLOCK;
    const colorsBlock = importedBlocks.colors || DEFAULT_COLORS_BLOCK;

    return `/* ============================================================
 * GPT-6 Astra 星空动效 · 配置与旋臂路径数据
 * —— 旋臂控制点由「旋臂画板」手绘拟合生成 ——
 * 坐标系：1600 x 900 设计稿坐标，螺旋中心 C = (800, 555)。
 * ============================================================ */
(function () {
  'use strict';

  ${cfgBlock}

  ${colorsBlock}

  const ARMS = [
${armBlocks}
  ];

  const ORIGINS = [${origins}];

  window.ASTRA_DATA = { CFG, STAR_COLORS, ARMS, ORIGINS };
})();
`;
  }

  function openExport() {
    const issues = checkSpacing();
    const el = $('exportCheck');
    if (!Object.keys(lines).length) {
      el.textContent = '还没有画任何旋臂';
      el.className = 'export-check bad';
    } else if (issues.length) {
      el.textContent = `⚠ ${issues.length} 处间距不足 ${MIN_GAP}px：${issues.join('；')}`;
      el.className = 'export-check bad';
    } else {
      el.textContent = `✓ 间距检查通过（≥${MIN_GAP}px）`;
      el.className = 'export-check ok';
    }
    $('exportCode').value = buildExport();
    $('exportPanel').hidden = false;
  }

  function openExportKeep() {
    if (!$('exportPanel').hidden) openExport();
  }

  /* ---------------- 导入 ---------------- */
  /** 解析 arms-data.js（IIFE 写入 window.ASTRA_DATA 的格式） */
  function parseArmsFile(text) {
    return new Function('window', `${text}\n;return window.ASTRA_DATA;`)({});
  }

  function importData(text) {
    let data = null;
    try {
      data = parseArmsFile(text);
    } catch (err) {
      $('tipbar').innerHTML = `<b class="warn">导入失败</b>：文件解析出错 —— ${err.message}`;
      return;
    }
    // 记住导入文件里的 CFG / 调色板源码块，导出时原样带回
    importedBlocks = {
      cfg: extractBlock(text, 'const CFG = {', '  };'),
      colors: extractBlock(text, 'const STAR_COLORS = [', '  ];'),
    };
    // 旧版文件兼容：臂名 O1/O2 自动映射为新名 O/P
    const LEGACY = { O1: 'O', O2: 'P' };
    const arms = data && Array.isArray(data.ARMS) ? data.ARMS : [];
    const loaded = [];
    for (const def of arms) {
      const canon = LEGACY[def.name] || def.name;
      if (!metaOf(canon) || !Array.isArray(def.pts) || def.pts.length < 2) continue;
      lines[canon] = {
        cps: def.pts.map(([x, y]) => ({ x: Math.round(x), y: Math.round(y) })),
      };
      resample(canon);
      loaded.push(canon);
    }
    if (!loaded.length) {
      $('tipbar').innerHTML =
        '<b class="warn">导入失败</b>：文件里没有可识别的旋臂数据（G/R/O/P/B）';
      return;
    }
    // 清空导入文件里没有的旧臂，避免与新数据混在一起
    for (const m of ARMS_META) {
      if (!loaded.includes(m.name)) delete lines[m.name];
    }
    refreshArmPicker();
    updateStatus();
    setArm(loaded[0]);
    // 导入就是为了改 → 自动切到拖点模式
    mode = 'edit';
    document.querySelectorAll('.mode-btn').forEach((x) =>
      x.classList.toggle('active', x.dataset.mode === 'edit'));
    updateTip();
    draw();
    $('tipbar').innerHTML =
      `✓ 已导入 <b>${loaded.length}</b> 条旋臂（${loaded.join('、')}），已切换到 <b>👆 拖点模式</b> —— ` +
      `直接拖动控制点修改（状态栏距离变绿即达标），改完点「导出数据」。`;
    openExportKeep();
  }

  function readArmFile(f) {
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => importData(String(rd.result || ''));
    rd.readAsText(f);
  }

  /* ---------------- 自定义背景图 ---------------- */
  /** 导入本地图片作为描摹背景：加入参考图下拉并自动选中 */
  function importRefImage(f) {
    if (!f || !f.type.startsWith('image/')) {
      $('tipbar').innerHTML = '<b class="warn">导入失败</b>：请选择图片文件（png / jpg / webp 等）';
      return;
    }
    const rd = new FileReader();
    rd.onload = () => {
      const img = new Image();
      img.onload = () => {
        refImages.custom = img;
        refOffsets.custom = { x: 0, y: 0 }; // 新图重新对位，从默认居中开始
        const sel = $('refSelect');
        let opt = sel.querySelector('option[value="custom"]');
        if (!opt) {
          opt = document.createElement('option');
          opt.value = 'custom';
          sel.appendChild(opt);
        }
        const name = f.name.length > 18 ? f.name.slice(0, 17) + '…' : f.name;
        opt.textContent = `自定义：${name}`;
        sel.value = 'custom';
        refMode = 'custom';
        draw();
        $('tipbar').innerHTML =
          `✓ 已导入背景图 <b>${f.name}</b>（${img.naturalWidth}×${img.naturalHeight}）—— ` +
          `按 contain 适配设计区，用「透明度」滑杆调节；在「参考图」下拉里可切回预设图。`;
      };
      img.onerror = () => {
        $('tipbar').innerHTML = '<b class="warn">导入失败</b>：图片解析出错，换一张试试';
      };
      img.src = String(rd.result || '');
    };
    rd.readAsDataURL(f);
  }

  /* ---------------- 事件绑定 ---------------- */
  document.querySelectorAll('.mode-btn').forEach((b) =>
    b.addEventListener('click', () => {
      mode = b.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach((x) =>
        x.classList.toggle('active', x === b));
      hoverCp = null;
      updateTip();
      draw();
    })
  );

  $('refSelect').addEventListener('change', (e) => { refMode = e.target.value; draw(); });
  // 移动背景图：开关平移模式（开启时画线/拖点自动挂起；退出后图片固定在当前位置）
  $('refMoveBtn').addEventListener('click', () => {
    if (!refMove && !refImages[refMode]) {
      $('tipbar').innerHTML = '当前没有显示参考图 —— 先在「参考图」下拉里选一张，或点「导入背景图」。';
      return;
    }
    refMove = !refMove;
    $('refMoveBtn').classList.toggle('active', refMove);
    canvas.style.cursor = refMove ? 'grab' : 'crosshair';
    if (refMove) {
      $('tipbar').innerHTML =
        '<b>移动背景图</b> —— 在画布上按住拖动，把图中螺旋中心对准<b>中心十字 (800, 555)</b>；' +
        '状态栏实时显示偏移量。对准后再点一次「移动背景图」退出，图片即固定在该位置。';
    } else {
      updateTip();
    }
    draw();
  });
  $('refResetBtn').addEventListener('click', () => {
    refOffsets[refMode] = { x: 0, y: 0 };
    if (refMove) updateRefStatus(mouse || { x: 0, y: 0 });
    draw();
  });
  $('refAlpha').addEventListener('input', (e) => { refAlpha = e.target.value / 100; draw(); });
  $('epsilon').addEventListener('input', (e) => {
    epsilon = +e.target.value;
    $('epsilonVal').textContent = `${epsilon}px`;
  });
  $('gridToggle').addEventListener('change', (e) => { showGrid = e.target.checked; draw(); });
  $('reverseBtn').addEventListener('click', () => {
    const L = lines[currentArm];
    if (!L) return;
    L.cps.reverse();
    resample(currentArm);
    draw();
    openExportKeep();
  });
  $('clearArmBtn').addEventListener('click', () => {
    delete lines[currentArm];
    refreshArmPicker(); updateStatus(); updateTip(); draw();
  });
  $('clearAllBtn').addEventListener('click', () => {
    Object.keys(lines).forEach((k) => delete lines[k]);
    refreshArmPicker(); updateStatus(); updateTip(); draw();
  });
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => {
    readArmFile(e.target.files && e.target.files[0]);
    e.target.value = ''; // 允许重复选择同一个文件
  });
  $('refImgBtn').addEventListener('click', () => $('refImgFile').click());
  $('refImgFile').addEventListener('change', (e) => {
    importRefImage(e.target.files && e.target.files[0]);
    e.target.value = ''; // 允许重复选择同一个文件
  });
  // 直接把 arms-data.js 或图片文件拖进窗口任意位置也能导入
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) importRefImage(f); // 图片 → 背景
    else readArmFile(f);                                     // 其它 → 臂数据
  });
  $('exportBtn').addEventListener('click', openExport);
  $('closeExportBtn').addEventListener('click', () => { $('exportPanel').hidden = true; });
  $('copyBtn').addEventListener('click', async () => {
    const code = $('exportCode').value;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      $('exportCode').select();
      document.execCommand('copy');
    }
    $('copyBtn').textContent = '已复制 ✓';
    setTimeout(() => { $('copyBtn').textContent = '复制代码'; }, 1500);
  });
  $('downloadBtn').addEventListener('click', () => {
    const blob = new Blob([$('exportCode').value], { type: 'text/javascript' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'arms-data.js';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  /* ---------------- 启动 ---------------- */
  refImages.final = new Image();
  refImages.final.src = 'assets/ref-final.png';
  refImages.final.onload = draw;
  refImages.sketch = new Image();
  refImages.sketch.src = 'assets/ref-sketch.png';
  refImages.sketch.onload = draw;

  window.addEventListener('resize', resize);
  refreshArmPicker();
  setArm('G');
  updateStatus();
  resize();
})();
