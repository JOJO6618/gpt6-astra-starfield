#!/usr/bin/env python3
"""验证旋臂锚点间距：与 js/app.js 相同的 centripetal Catmull-Rom 采样，
计算任意两条臂之间的最小距离（排除中心汇入区与各臂首尾端）。

用法：python3 tools/check_arms.py
标准：任意两臂（非端点区）最小间距 >= 40px（设计坐标）。
"""
import math
import re
import sys
from pathlib import Path

CENTER = (800, 555)
EXCLUDE_R = 120     # 中心汇入区：r < 120 内不检查（各臂在此淡出汇入亮星）
END_SKIP = 0.04     # 首尾各 4% 弧长不参与检查（起点/终点允许靠近）
MIN_GAP = 40        # 达标间距（设计 px）

# 分叉臂对：P 是 O 的伴生分叉（同起点、前段并行后分开），不检查间距
EXEMPT_PAIRS = {frozenset(('O', 'P'))}


def parse_arms(js_path: str):
    """从 arms-data.js 中提取各臂控制点。"""
    text = Path(js_path).read_text(encoding="utf-8")
    arms = {}
    for m in re.finditer(r"name:\s*'(\w+)'.*?pts:\s*\[(.*?)\n\s*\]", text, re.S):
        name, body = m.group(1), m.group(2)
        pts = [tuple(map(float, p)) for p in re.findall(r"\[(\d+),\s*(\d+)\]", body)]
        arms[name] = pts
    return arms


def crc(p0, p1, p2, p3, t):
    """centripetal Catmull-Rom，与 JS 版一致。"""
    d01 = max(math.dist(p0, p1) ** 0.5, 1e-4)
    d12 = max(math.dist(p1, p2) ** 0.5, 1e-4)
    d23 = max(math.dist(p2, p3) ** 0.5, 1e-4)
    t0, t1, t2, t3 = 0.0, d01, d01 + d12, d01 + d12 + d23
    tt = t1 + (t2 - t1) * t

    def mix(a, b, k):
        return (a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k)

    A1 = mix(p0, p1, (tt - t0) / (t1 - t0))
    A2 = mix(p1, p2, (tt - t1) / (t2 - t1))
    A3 = mix(p2, p3, (tt - t2) / (t3 - t2))
    B1 = mix(A1, A2, (tt - t0) / (t2 - t0))
    B2 = mix(A2, A3, (tt - t1) / (t3 - t1))
    return mix(B1, B2, (tt - t1) / (t2 - t1))


def sample(pts, total=800):
    P = list(pts)
    P.append(CENTER)  # 终点=中心（与 JS 一致）
    ref = lambda a, b: (2 * a[0] - b[0], 2 * a[1] - b[1])
    out = []
    seg_n = max(4, round(total / (len(P) - 1)))
    for i in range(len(P) - 1):
        p0 = ref(P[0], P[1]) if i == 0 else P[i - 1]
        p3 = ref(P[-1], P[-2]) if i + 2 >= len(P) else P[i + 2]
        for j in range(seg_n):
            out.append(crc(p0, P[i], P[i + 1], p3, j / seg_n))
    out.append(CENTER)
    # 累积弧长
    cum = [0.0]
    for i in range(1, len(out)):
        cum.append(cum[-1] + math.dist(out[i], out[i - 1]))
    return out, cum


def usable_indices(cum):
    """排除首尾各 END_SKIP 弧长比例，返回可用索引区间。"""
    total = cum[-1]
    lo = next(i for i, c in enumerate(cum) if c >= total * END_SKIP)
    hi = next(i for i, c in enumerate(cum) if c >= total * (1 - END_SKIP))
    return lo, max(lo + 1, hi)


def near_center(p):
    return math.dist(p, CENTER) < EXCLUDE_R


def main():
    js = Path(__file__).parent.parent / "js" / "arms-data.js"
    arms = parse_arms(str(js))
    if len(arms) != 5:
        print(f"!! 解析到 {len(arms)} 条臂（应为 5）：{list(arms)}")
        sys.exit(1)

    sampled = {}
    for name, pts in arms.items():
        pts_s, cum = sample(pts)
        lo, hi = usable_indices(cum)
        # 过滤掉中心汇入区的点
        keep = [(i, p) for i, p in enumerate(pts_s) if lo <= i <= hi and not near_center(p)]
        sampled[name] = keep
        print(f"臂 {name}: 控制点 {len(pts)} 个, 弧长 {cum[-1]:.0f}px, 参与检查 {len(keep)} 采样点")

    print(f"\n臂间最小间距（排除中心区 r<{EXCLUDE_R} 与首尾 {END_SKIP*100:.0f}%）：")
    ok = True
    names = list(sampled)
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a, b = names[i], names[j]
            if frozenset((a, b)) in EXEMPT_PAIRS:
                print(f"  -- {a} <-> {b}: 分叉臂对，豁免检查")
                continue
            best = (float("inf"), None, None)
            for _, pa in sampled[a]:
                for _, pb in sampled[b]:
                    d = math.dist(pa, pb)
                    if d < best[0]:
                        best = (d, pa, pb)
            flag = "OK " if best[0] >= MIN_GAP else "!! "
            if best[0] < MIN_GAP:
                ok = False
            print(f"  {flag}{a} <-> {b}: {best[0]:6.1f}px   at {best[1]} ~ {best[2]}")

    print("\n结果：" + ("全部达标 ✓" if ok else f"存在间距 < {MIN_GAP}px 的位置，需调整锚点"))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
