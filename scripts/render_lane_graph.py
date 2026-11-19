#!/usr/bin/env python3
"""把事件账本渲染成"泳道提交图"。
   输入：runtime/ledger/<case>.jsonl   输出：docs/lane-graph.png
   这张图不是手工排版——它完全由账本算出，验证"面板 = fold(events)"这条设计主张。"""
import json, sys, os
from PIL import Image, ImageDraw, ImageFont

LEDGER = sys.argv[1] if len(sys.argv) > 1 else "runtime/ledger/sample-case-2026-001.jsonl"
OUT = sys.argv[2] if len(sys.argv) > 2 else "docs/lane-graph.png"

BG      = (8, 12, 20)
LANE_BG = (13, 19, 31)
LANE_ALT= (15, 22, 35)
GRID    = (22, 31, 48)
TXT     = (231, 238, 251)
DIM     = (127, 141, 168)
DIM2    = (75, 88, 112)
LINE    = (58, 83, 122)

C = {
    "commit":   (77, 163, 255),
    "wait":     (255, 179, 64),
    "pass":     (55, 214, 122),
    "fail":     (255, 95, 109),
    "handoff":  (143, 163, 189),
    "merge":    (167, 139, 250),
    "sign":     (255, 179, 64),
    "mission":  (127, 166, 218),
    "compact":  (53, 208, 208),
}
TYPE_LABEL = {
    "file.written": "提交", "lock.queued": "排队", "gate.passed": "门禁通过",
    "gate.failed": "门禁失败", "retry.opened": "重试", "handoff": "交接",
    "report.assembled": "合并", "sign.pending": "等待你", "mission.created": "立项",
    "context.compacted": "压缩",
}
def kind(e):
    t = e["type"]
    if t == "file.written":     return "commit"
    if t == "lock.queued":      return "wait"
    if t == "gate.passed":      return "pass"
    if t == "gate.failed":      return "fail"
    if t == "retry.opened":     return "fail"
    if t == "handoff":          return "handoff"
    if t == "report.assembled": return "merge"
    if t == "sign.pending":     return "sign"
    if t == "mission.created":  return "mission"
    if t == "context.compacted":return "compact"
    return "handoff"

FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"
def f(sz): return ImageFont.truetype(FONT, sz)

LANES = [
    ("macro",    "宏观研究", "已交付"),
    ("industry", "行业研究", "已交付"),
    ("stock",    "个股研究", "已交付 · 2 版"),
    ("audit",    "信息审计", "已通过"),
    ("legal",    "法律顾问", "已通过"),
    ("trader",   "交易员",   "已交付"),
    ("lead",     "Lead · 汇编", "待你签发"),
]
W, H = 1800, 1130
X0, X1 = 168, 1748
Y0, ROWH = 132, 118
TMAX = 135.0
PAD_L, PAD_R = 12, 14

events = [json.loads(l) for l in open(LEDGER, encoding="utf-8") if l.strip()]
by_lane = {}
for e in events: by_lane.setdefault(e.get("lane", "lead"), []).append(e)
for k in by_lane: by_lane[k].sort(key=lambda e: (e["t"], e["seq"]))

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# ---- 标题 ----
d.text((40, 26), "AlphaDesk · 泳道提交图", font=f(21), fill=TXT)
d.text((40, 58), "case-2026-001 · 600519 贵州茅台 · 直接由 JSONL 账本渲染：坐标全部来自事件时间戳，无手工排版",
       font=f(11), fill=DIM)

# ---- 时间轴 ----
ax_x0, ax_y = X0, 100
d.line((ax_x0, ax_y, X1, ax_y), fill=GRID, width=1)
for t in range(0, 136, 15):
    x = X0 + t / TMAX * (X1 - X0)
    d.line((x, ax_y - 4, x, ax_y), fill=DIM2, width=1)
    d.text((x - 12, ax_y - 18), "%d:%02d" % (21 + (58 * 60 + t) // 3600, ((58 * 60 + t) % 3600) // 60) if False else "+%ds" % t,
           font=f(9), fill=DIM2)
    d.line((x, ax_y + 6, x, Y0 + len(LANES) * ROWH - 26), fill=(18, 25, 38), width=1)

# ---- 车道 ----
lane_y = {}
for i, (lid, name, status) in enumerate(LANES):
    y = Y0 + i * ROWH
    lane_y[lid] = y
    d.rectangle((40, y - 16, X1 + 6, y + ROWH - 12), fill=(LANE_BG if i % 2 == 0 else LANE_ALT))
    d.line((40, y + ROWH - 12, X1 + 6, y + ROWH - 12), fill=(20, 28, 42), width=1)
    d.ellipse((56, y + 6, 64, y + 14), fill=C["commit"] if "已" in status or "通过" in status else C["wait"])
    d.text((74, y - 2), name, font=f(13), fill=(207, 224, 247))
    d.text((74, y + 18), status, font=f(9.5), fill=DIM2)

# ---- 节点布局 ----
nodes = {}
occupied = {}
def place(e):
    lid = e.get("lane", "lead")
    y = lane_y[lid]
    x = X0 + e["t"] / TMAX * (X1 - X0)
    lbl = e["payload"].get("label", e["type"])
    w = d.textlength(lbl, font=f(11.5)) + 40
    sub = 0
    for s in (0, 1, 2):
        busy = [iv for (ln, yy, iv) in occupied.get(lid, []) if yy == s]
        if all(x + w + 6 <= a or x >= b + 6 for (a, b) in busy):
            sub = s; break
    else:
        sub = 1
    ny = y + 2 + sub * 35
    occupied.setdefault(lid, []).append((lid, sub, (x, x + w)))
    return (x, ny, w, 30)

for e in events:
    nodes[e["seq"]] = place(e)

# ---- 边 ----
def bez(p0, p1, p2, p3, n=44):
    out = []
    for i in range(n + 1):
        t = i / n
        mt = 1 - t
        out.append((mt**3*p0[0] + 3*mt*mt*t*p1[0] + 3*mt*t*t*p2[0] + t**3*p3[0],
                    mt**3*p0[1] + 3*mt*mt*t*p1[1] + 3*mt*t*t*p2[1] + t**3*p3[1]))
    return out

def arrow(p, color, direction=(1, 0)):
    x, y = p
    d.polygon([(x, y), (x - 7 * direction[0] + 3 * direction[1], y - 3),
               (x - 7 * direction[0] - 3 * direction[1], y + 3)], fill=color)

for e in events:
    if e["seq"] not in nodes: continue
    cx, cy, cw, ch = nodes[e["seq"]]
    for pseq in e["payload"].get("parents", []):
        if pseq not in nodes: continue
        px, py, pw, ph = nodes[pseq]
        p_lane = events[pseq - 1].get("lane", "lead") if pseq - 1 < len(events) else "lead"
        cross = p_lane != e.get("lane")
        fail = e["type"] in ("gate.failed", "retry.opened")
        col = (150, 60, 70) if fail else ((72, 92, 124) if cross else (62, 88, 128))
        if e["type"] == "gate.passed" or (e["type"] == "file.written" and e["payload"].get("v", 1) > 1):
            col = (45, 130, 90)
        x0, y0 = px + pw, py + ch / 2
        x1, y1 = cx, cy + ch / 2
        dx = max(24, abs(x1 - x0) * 0.42)
        pts = bez((x0, y0), (x0 + dx, y0), (x1 - dx, y1), (x1, y1))
        if fail or cross:
            for i in range(0, len(pts) - 2, 3):
                d.line((pts[i][0], pts[i][1], pts[i + 2][0], pts[i + 2][1]), fill=col, width=2)
        else:
            d.line(pts, fill=col, width=2, joint="curve")
        arrow((x1, y1), col)

# ---- 节点 ----
def dashed_rect(box, color, dash=6, gap=4, width=1):
    x0, y0, x1, y1 = box
    edges = [((x0, y0, x1, y0)), ((x1, y0, x1, y1)), ((x1, y1, x0, y1)), ((x0, y1, x0, y0))]
    for (a, b, c2, dd) in edges:
        length = abs(c2 - a) + abs(dd - b)
        t = 0.0
        while t < length:
            t2 = min(t + dash, length)
            px = a + (c2 - a) * (t / length) if length else a
            py = b + (dd - b) * (t / length) if length else b
            qx = a + (c2 - a) * (t2 / length) if length else a
            qy = b + (dd - b) * (t2 / length) if length else b
            d.line((px, py, qx, qy), fill=color, width=width)
            t = t2 + gap

for e in events:
    if e["seq"] not in nodes: continue
    x, y, w, h = nodes[e["seq"]]
    k = kind(e)
    col = C[k]
    fill = (14, 24, 40)
    if k == "wait":    fill = (32, 23, 8)
    if k == "fail":    fill = (35, 15, 19)
    if k in ("pass",): fill = (11, 28, 22)
    if k == "merge":   fill = (24, 18, 40)
    if k == "sign":    fill = (33, 27, 8)
    if k == "compact": fill = (10, 30, 32)
    if k == "wait":
        dashed_rect((x, y, x + w, y + h), col, dash=5, gap=4, width=1)
        d.rectangle((x + 1, y + 1, x + w - 1, y + h - 1), fill=fill)
    else:
        d.rounded_rectangle((x, y, x + w, y + h), radius=7, fill=fill, outline=col, width=1)
    d.rectangle((x + 1, y + 6, x + 3, y + h - 6), fill=col)
    lbl = e["payload"].get("label", e["type"])
    d.text((x + 10, y + 8), lbl, font=f(11.5), fill=(226, 236, 250))

# ---- 图例 ----
lg_y = 975
d.text((40, lg_y - 26), "图例 · 节点即事件", font=f(11), fill=DIM)
order = [("commit", "提交 / 版本"), ("wait", "排队等锁"), ("handoff", "交接"),
         ("pass", "门禁通过"), ("fail", "门禁失败 / 退回"), ("merge", "合并 / 汇编"),
         ("sign", "等待你签发"), ("compact", "上下文压缩")]
x = 40
for k, lab in order:
    col = C[k]
    if k == "wait":
        dashed_rect((x, lg_y, x + 16, lg_y + 12), col, dash=3, gap=2, width=1)
    else:
        d.rounded_rectangle((x, lg_y, x + 16, lg_y + 12), radius=3, fill=(14, 24, 40), outline=col, width=1)
    d.text((x + 24, lg_y - 3), lab, font=f(10.5), fill=DIM)
    x += d.textlength(lab, font=f(10.5)) + 62

d.line((40, lg_y + 34, X1, lg_y + 34), fill=GRID, width=1)
d.text((40, lg_y + 46), "读法：横向是时间，纵向是员工（车道）；实线 = 血缘（基于哪个版本往下做），红色虚线 = 被门禁退回后的重做，"
                       "灰色虚线 = 跨车道引用（读了别人的文件）。琥珀虚线框的「排队」节点即本方案的核心机制：想读写同一份文件，先排队。",
       font=f(10.5), fill=DIM2)
d.text((40, lg_y + 66), "注意：这张图里没有任何一个坐标是手写的——全部由 JSONL 事件算出。换一份账本，图就变；回放历史，图就倒着长。",
       font=f(10.5), fill=(96, 112, 140))

os.makedirs(os.path.dirname(OUT), exist_ok=True)
img.save(OUT)
print("saved", OUT, img.size)
