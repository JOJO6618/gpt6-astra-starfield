# GPT-6 Astra · Starfield Spiral "6"

**[中文](README.md) | English**

A recreation of the starfield background animation from OpenAI's [GPT-6 Astra landing page](https://openai.com/index/gpt-6-astra/): thousands of stars converge from random scatter into a spiral galaxy shaped like "6", a scroll-driven 3D camera tilts the view, the mouse interacts with stars via a force field, and scrolling further splits the galaxy into two halves that dissolve to the sides.

> 🎬 **Demo GIF goes here** — a screen recording is the single most important part of this README (`docs/demo.gif`).

## ⚠️ Recreation Notes (read first)

This is an **unofficial, educational recreation** with known differences from the original:

- **Arm paths are not a pixel-perfect match**: the planar trajectories of the five spiral arms were hand-traced over screenshots using the bundled drawing tool. The overall shape is close, but point-by-point curvature and spacing differ from the original
- **Star colors are not exact**: the 7-color highlight palette and its proportions were tuned by eye against the official page, not sampled from the real color values
- The 3D height profiles, animation timing, and interaction feel are likewise approximations

## ✨ Features

- **Gather animation**: scattered stars converge along S-curve or counterclockwise arc paths (switchable) into the spiral "6"
- **Pseudo-3D arms**: 5 arms each with an independent height profile (Z-curve); pixel-identical to 2D from top view, spatially interwoven when tilted
- **Scroll-driven camera**: scrolling down tilts the view smoothly from top-down (90°) to 35° — plain page scroll, no scroll-jacking
- **Mouse force field**: sweeping past stars applies a "repel-ahead, attract-behind" force along the mouse velocity direction, with spring return
- **Drag to rotate**: after gathering, drag to flip the galaxy at any angle (quaternion trackball, no gimbal singularity); release to spring back along the shortest arc
- **Split transition**: past the threshold, the galaxy splits into two half-density spirals drifting apart while dispersion grows, finally dissolving into uniform star fields on both sides as the side texts fade out
- **Center cluster**: 70 white glow balls orbiting slowly, each independently responding to the mouse
- **Background starfield**: depth-layered parallax; retreats to the sides during the split
- **Zero dependencies**: pure Canvas 2D + vanilla JS, no build step

## 🚀 Quick Start

Nothing to install — just open the file:

```bash
open index.html        # macOS
# or simply double-click index.html
```

## 🎮 Interactions

| Action | Effect |
|---|---|
| Page load | Scatter → gather into "6" → continuous flow; stars absorbed by the center cluster and respawn |
| Mouse sweep | Stars are pushed/dragged along the mouse velocity direction, springing back afterwards |
| Scroll down | Camera tilts from top-down to 35°, revealing the arms' 3D layering |
| Drag (after gather) | Rotate the galaxy freely; release to return smoothly |
| Scroll past threshold | Galaxy splits into two halves → dissolves into side star fields; texts fade |
| Bottom-right button | Replay |

## 🎛 Tuning

All key parameters are commented — edit and refresh:

**`js/arms-data.js` — `CFG`**

| Param | Meaning |
|---|---|
| `flowPeriod: [40, 60]` | Flow period along arms (seconds); larger = slower |
| `flowDensity: 0.39` | Flow star density |
| `bandHalf / bandHalfY` | Arm width / vertical thickness |
| `bgStars: 700` | Background star count |
| `STAR_COLORS` | 7-color palette with weights |

**`js/app.js` — top constants**

| Param | Meaning |
|---|---|
| `GATHER_MODE` | `'s'` S-curve / `'arc'` arc gather path |
| `CAM_MOVE.elEnd` | Scroll-limit tilt angle (currently 35°) |
| `SPLIT.*` | All split-transition params (shift, dispersion, side regions, lag, arc) |
| `MOUSE.*` | Mouse force field (push/pull/radius/spring/max offset) |
| `CORE_SPIN` | Center cluster spin speed |
| `BG_DRAG_FORCE` | Whether background stars respond to mouse force while dragging |

## 🛠 Bundled Tools (`tools/`)

The project's data wasn't hand-coded — it was drawn with purpose-built editors:

| Tool | Purpose |
|---|---|
| `tools/draw-arms/` | **Arm drawing board**: trace arm paths over a reference overlay, auto-fit spline control points; supports continue-drawing, point dragging, importing existing data, exporting `arms-data.js` |
| `tools/z-editor/` | **Height editor**: drag 9 stations per arm to shape height profiles, live 3D preview, exports `arms-3d.js` |
| `tools/3d-viewer/` | **3D viewer**: orbit camera to inspect arm spatial relations, z0/k sliders |

## 🧠 How It Works (brief)

- **Arms**: control points + centripetal Catmull-Rom splines + arc-length parameterization; stars flow along arms with Gaussian spread along the normal, forming bands with width
- **Pseudo-3D**: world coordinates (design XY → world XZ plane, Z-editor data → world Y) + per-point perspective projection, pixel-aligned with 2D at top view
- **Camera**: quaternion trackball (avoids Euler-angle degeneration at the zenith); scroll sets the target orientation, drags rotate incrementally, release slerps back along the shortest arc
- **Mouse force**: screen-space spring model, force direction = mouse velocity (repel ahead, attract behind) — avoids the circular "holes" a 360° radial force sweeps out
- **Split transition**: two overlapping mechanisms — coherent per-side translation (spiral shape preserved) + sqrt-curve dispersion growth + per-star staggered slot dissolve

## 📁 Structure

```
├── index.html          # page (side words + replay button + scroll spacer)
├── css/style.css
├── js/
│   ├── app.js          # main engine (particles/interaction/rendering)
│   ├── cam3d.js        # 3D camera (quaternion trackball + perspective)
│   ├── arms-data.js    # arm planar data + CFG
│   ├── arms-3d.js      # arm height profiles
│   └── zcurve.js       # Z-curve interpolation (shared with editors)
└── tools/              # drawing board / height editor / 3D viewer
```

## ⚖️ Disclaimer

- This is an **unofficial** personal educational recreation, not affiliated with OpenAI
- Inspired by and visually referenced from [openai.com/index/gpt-6-astra](https://openai.com/index/gpt-6-astra/)
- All code and starfield visuals are hand-written; the two reference images under `tools/draw-arms/assets/` are screenshots of the official page used solely as tracing references — copyright belongs to the original author
- If the official party objects, this repo will be removed upon request
