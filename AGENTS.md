# AGENTS.md — GPT-6 Astra 星空动效

## 项目概述

纯 Canvas 2D + 原生 JS 实现的星空螺旋 "6" 动效复刻。零依赖、无构建步骤，直接浏览器运行。

## 技术栈

- Canvas 2D API（`globalCompositeOperation = 'lighter'` 叠加发光）
- 原生 ES6+（IIFE 模块，无打包器）
- 四元数轨迹球（`js/cam3d.js`）实现 3D 相机与拖动旋转

## 快速开始

无需安装依赖，直接用浏览器打开：

```bash
open index.html           # macOS
python3 -m http.server    # 或本地 HTTP 服务
```

## 项目结构

```
gpt6-astra/
├── index.html          # 页面结构（左右大字 + 重播按钮 + 滚动占位）
├── css/style.css       # 样式（全屏 canvas、大字入场动画）
├── js/
│   ├── app.js          # 主引擎：粒子系统 / 三阶段动画 / 鼠标交互 / 渲染循环
│   ├── cam3d.js        # 3D 相机：四元数轨迹球 + 透视投影 + slerp 回位
│   ├── arms-data.js    # 旋臂平面路径 + CFG 配置 + STAR_COLORS 调色板
│   ├── arms-3d.js      # 旋臂高度剖面（z0·k / zpts 曲线）
│   └── zcurve.js       # Z 曲线插值（引擎与编辑器共用）
└── tools/
    ├── draw-arms/      # 旋臂画板：描摹工具，导出 arms-data.js
    ├── z-editor/       # 高度编辑器：调整臂高剖面，导出 arms-3d.js
    ├── 3d-viewer/      # 3D 预览器：轨道相机查看空间关系
    └── check_arms.py   # ⚠️ 禁止使用（见下方约定）
```

## 脚本加载顺序（不可改）

`index.html` 中 `<script>` 的加载顺序有依赖关系，不可调换：

1. `arms-data.js` → 暴露 `window.ASTRA_DATA`
2. `arms-3d.js` → 暴露 `window.ARMS_3D`
3. `zcurve.js` → 暴露 `window.ZCURVE`
4. `cam3d.js` → 暴露 `window.CAM3D`
5. `app.js` → 读取以上全部全局变量后启动 `AstraScene`

## 编码规范

- 模块用 IIFE：`(function () { 'use strict'; ... })()`
- 命名：`camelCase`（函数/变量）、`PascalCase`（Class）、`UPPER_SNAKE_CASE`（常量）
- 数学常量/工具函数放在文件顶部，便于复用
- 配置（`CFG`、`STAR_COLORS`、`ARMS`）集中放在 `arms-data.js`，`app.js` 只读不改
- 所有颜色值统一使用 `STAR_COLORS` 中的索引 `ci`，不要硬编码 RGB

## 发光 Sprite 体系（v3 版本）

星星的视觉效果由四层 sprite 叠加构成（从大到小）：

| Sprite | 尺寸 | 用途 | 生成函数 |
|--------|------|------|----------|
| `mists` | 320px | 超宽低频雾光，营造镜头空气感 | `makeMistSprite` |
| `coreHaze` | 512px | 中心大雾专用：单张平顶高斯雾（中心圆内压平为圆边缘亮度，不淹没光球），可见直径≈绘制尺寸的 2/3 | `makeCoreHazeSprite` |
| `blooms` | 192px | 大面积过曝光晕 | `makeBloomSprite` |
| `sprites` | 96px | 紧致星核主体 | `makeGlowSprite` |
| `halos` | 128px | 特大星 + 竖向 streak 星芒 | `makeHaloSprite` |

**修改光感时**：先确认 diff 涉及哪一层 sprite，再修改对应的 `makeXxxSprite` 函数和绘制逻辑中的 `ctx.globalAlpha` / 尺寸系数。

## 颜色与尺寸分层系统

`app.js` 中通过 `COLOR_WEIGHTS`、`TIER_CDF`、`STAR_SIZE` 将星星按尺寸分为 4 档：

- `dust`：微星，色彩最丰富（cyan/amber 权重高）
- `mid`：中等亮星
- `big`：大光晕星，偏白/冰白
- `giant`：特大星，白色过曝为主

**调色板**定义在 `arms-data.js` 的 `STAR_COLORS`（7 色），`weight` 仅作为 fallback，`app.js` 按 tier 使用分层权重。

## 关键约定

### 1. 禁止运行测试/验证脚本

部署新的 `arms-data.js` 旋臂数据时，**禁止运行 `tools/check_arms.py`**，也不要主动跑其它测试脚本。

正确流程：
```bash
# 1. 用新数据覆盖
# 2. 只做语法检查
node --check js/arms-data.js
# 3. 由用户自己在浏览器刷新页面，目测视觉效果
```

视觉效果好坏由用户判断，不要替用户下"是否重叠/是否合格"的结论。用户偏好："你只写文件，我来看视觉效果"。

### 2. 参数调优入口

| 需求 | 修改文件 | 关键参数 |
|------|---------|----------|
| 旋臂密度/宽度/背景星数量 | `js/arms-data.js` | `CFG.flowDensity`、`bandHalf`、`bgStars` |
| 取景留白（6 不贴窗口边缘） | `js/arms-data.js` | `CFG.viewFit`（1 = 贴满，越小边距越大） |
| 星星颜色/调色板 | `js/arms-data.js` | `STAR_COLORS` |
| 汇聚模式 | `js/app.js` 顶部 | `GATHER_MODE`（`'s'` / `'arc'`）|
| 相机极限角度 | `js/app.js` 顶部 | `CAM_MOVE.elEnd` |
| 分裂转场参数 | `js/app.js` 顶部 | `SPLIT.*` |
| 鼠标力场强度 | `js/app.js` 顶部 | `MOUSE.*` |

### 3. 旋臂平面路径修改

如需重绘旋臂，使用 `tools/draw-arms/` 画板工具（浏览器打开 `tools/draw-arms/index.html`），描摹后导出替换 `js/arms-data.js`。

### 4. 高度剖面修改

如需调整臂的立体穿插关系，使用 `tools/z-editor/`（浏览器打开 `tools/z-editor/index.html`），调整 Z 曲线后导出替换 `js/arms-3d.js`。

## 注意事项

- `app.js` 使用 `globalCompositeOperation = 'lighter'` 实现星星发光叠加，修改绘制顺序会影响混合效果
- 星星重生时（`u >= endU`）会重新掷骰子决定 `willGrow`（点燃概率）和 `ci`（颜色），长运行后星群分布会趋于统计均值
- 中心光团由 70 个独立光晕球组成，每个球都有自己的鼠标交互位移，不要合并为单一对象
- 中心还有一圈额外的大雾（单张 `coreHaze` 平顶高斯 sprite，中心圆内压平、可见直径≈图形宽度一半，无分层边界），锚在 `this.coreKing`（reset 时选出的最亮球）上随其移动；其他球只画 sprite 本体、不叠大雾层（官网：小球光晕极小、外形清晰）
- 滚动占位 `.scroll-space` 提供页面高度用于驱动相机，其高度通过 CSS 控制，与 JS 逻辑无关
