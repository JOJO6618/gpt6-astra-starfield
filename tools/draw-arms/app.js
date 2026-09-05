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
    { name: 'O1', color: '#fb923c', hint: '外圈主体：从左侧画满 6 的身体' },
    { name: 'O2', color: '#fdba74', hint: '橙臂分叉：从腰部右侧画向中心' },
    { name: 'B', color: '#60a5fa', hint: '下弧内侧：从底部画向右侧再内汇' },
  ];

  /* ---------------- 状态 ---------------- */
  const lines = {}; // name -> { cps:[{x,y}], sampled:[{x,y}], length }
  let currentArm = 'G';
  let mode = 'draw'; // 'draw' | 'edit'
  let drawing = false;
  let rawLine = [];
  let dragCp = null;  // { arm, index } 拖动中
  let hoverCp = null; // { arm, index } 悬停中
  let epsilon = 5;
  let refAlpha = 0.45;
  let refMode = 'final';
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

    // 参考图（contain 适配设计区）
    const img = refImages[refMode];
    if (img && img.complete && img.naturalWidth) {
      const s = Math.min(DESIGN_W / img.naturalWidth, DESIGN_H / img.naturalHeight);
      const w = img.naturalWidth * s, h = img.naturalHeight * s;
      ctx.globalAlpha = refAlpha;
      ctx.drawImage(img, (DESIGN_W - w) / 2, (DESIGN_H - h) / 2, w, h);
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
  function buildExport() {
    const armBlocks = ARMS_META.filter((m) => lines[m.name]).map((m) => {
      const pts = lines[m.name].cps.map((p) => `[${p.x}, ${p.y}]`);
      const rows = [];
      for (let i = 0; i < pts.length; i += 5) rows.push(pts.slice(i, i + 5).join(', '));
      return `    {\n      name: '${m.name}',\n      pts: [\n        ${rows.join(',\n        ')},\n      ],\n    }`;
    }).join(',\n');

    const origins = ARMS_META.filter((m) => lines[m.name] && m.name !== 'O2')
      .map((m) => `'${m.name}'`).join(', ');

    return `/* ============================================================
 * GPT-6 Astra 星空动效 · 配置与旋臂路径数据
 * —— 旋臂控制点由「旋臂画板」手绘拟合生成 ——
 * 坐标系：1600 x 900 设计稿坐标，螺旋中心 C = (800, 555)。
 * ============================================================ */
(function () {
  'use strict';

  const CFG = {
    designW: 1600,
    designH: 900,
    center: { x: 800, y: 555 },
    centerAnchorY: 0.615,
    shapeW: 730,
    shapeH: 880,

    scatterEnd: 1.8,
    gatherEnd: 5.0,
    centerStarIn: [3.2, 5.4],
    originGlowIn: [4.0, 5.6],

    bandHalf: 10,   // 平面宽度（半宽，设计 px）
    bandHalfY: 6,   // 垂直厚度（半宽，设计 px）：斜视时臂呈扁椭圆截面管道，不再薄成线
    flowPeriod: [40, 60],
    flowDensity: 0.39,
    bgStars: 700,

    trailAlphaGather: 1,
    trailAlphaFlow: 1,
    maxDPR: 2,
  };

  const STAR_COLORS = [
    { rgb: [255, 255, 255], weight: 32 },
    { rgb: [150, 205, 255], weight: 20 },
    { rgb: [110, 175, 255], weight: 10 },
    { rgb: [255, 170, 92], weight: 16 },
    { rgb: [255, 110, 95], weight: 10 },
    { rgb: [255, 214, 140], weight: 8 },
    { rgb: [255, 140, 70], weight: 4 },
  ];

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
    const arms = data && Array.isArray(data.ARMS) ? data.ARMS : [];
    const loaded = [];
    for (const def of arms) {
      if (!metaOf(def.name) || !Array.isArray(def.pts) || def.pts.length < 2) continue;
      lines[def.name] = {
        cps: def.pts.map(([x, y]) => ({ x: Math.round(x), y: Math.round(y) })),
      };
      resample(def.name);
      loaded.push(def.name);
    }
    if (!loaded.length) {
      $('tipbar').innerHTML =
        '<b class="warn">导入失败</b>：文件里没有可识别的旋臂数据（G/R/O1/O2/B）';
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
  // 直接把 arms-data.js 文件拖进窗口任意位置也能导入
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    readArmFile(e.dataTransfer.files && e.dataTransfer.files[0]);
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
