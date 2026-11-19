#!/usr/bin/env python3
"""build_macro_report.py — 规范化的宏观研究报告（Word），含封面/要点/目录/图表/表格"""
import sys, os, re, json, csv, base64, subprocess, tempfile, urllib.request
from datetime import date
from openpyxl import load_workbook
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CASE = os.environ.get("DESK_CASE", "")
args = sys.argv[1:]
def val(n, d=""):
    return args[args.index("--" + n) + 1] if "--" + n in args else d
def fnum(x):
    if x is None: return None
    s = str(x).replace(",", "").replace("%", "").strip()
    try: return float(s)
    except Exception: return None
def xlsx_series(path, keyword, date_kw="数据时间"):
    wb = load_workbook(path, data_only=True, read_only=False); ws = wb[wb.sheetnames[0]]
    rows = list(ws.iter_rows(values_only=True)); hdr_i = None; ci = None
    for i, r in enumerate(rows):
        for j, c in enumerate(r):
            if c is not None and keyword in str(c):
                hdr_i = i; ci = j; break
        if hdr_i is not None: break
    if hdr_i is None: return []
    out = []
    for r in rows[hdr_i + 1:]:
        if not r: continue
        d = r[0]
        if d is None: continue
        ds = str(d).strip()
        if not re.search(r"20\d\d", ds): continue
        m = re.match(r"(20\d\d)年(\d{1,2})月", ds)
        if m: ds = m.group(1) + "-" + m.group(2).zfill(2)
        else:
            m2 = re.match(r"(20\d\d)[-/.](\d{1,2})[-/.](\d{1,2})", ds)
            if m2: ds = m2.group(1) + "-" + m2.group(2).zfill(2) + "-" + m2.group(3).zfill(2)
        v = fnum(r[ci]) if ci < len(r) else None
        if v is not None: out.append((ds, v))
    return out
def write_csv(path, series, x="日期", y="数值"):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f); w.writerow([x, y])
        for d, v in series: w.writerow([d, v])
    return path
def run_chart(kind, csv_path, out_svg, title, source, x="日期", y="数值"):
    cmd = ["node", os.path.join(ROOT, "scripts/chart.js"), kind, "--csv", csv_path,
           "--x", x, "--y", y, "--title", title, "--source", source, "--out", out_svg]
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=60)
    if r.returncode != 0 or not os.path.exists(out_svg):
        print("chart failed", title, r.stderr[:300], file=sys.stderr); return ""
    return out_svg
chrome = os.environ.get("CHROME_PATH") or os.path.expanduser("~/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")
def svg_png(svg):
    out = tempfile.mktemp(suffix=".png")
    try:
        txt = open(svg, encoding="utf-8").read()
        mw = re.search(r'width="([0-9.]+)"', txt); mh = re.search(r'height="([0-9.]+)"', txt)
        w = int(float(mw.group(1))) if mw else 760; h = int(float(mh.group(1))) if mh else 420
        subprocess.run([chrome, "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
          "--force-device-scale-factor=2", "--window-size=%d,%d" % (w, h),
          "--screenshot=" + out, "file://" + os.path.abspath(svg)],
          capture_output=True, timeout=60)
        return out if os.path.exists(out) and os.path.getsize(out) > 1000 else ""
    except Exception: return ""
up = os.path.join(ROOT, "vault", CASE, "uploads")
def find_one(pat):
    if not os.path.isdir(up): return ""
    for f in os.listdir(up):
        if re.search(pat, f): return os.path.join(up, f)
    return ""
files = {"export": find_one(r"新出口订单"), "bond": find_one(r"国债收益率"), "dxy": find_one(r"美元指数"),
         "re": find_one(r"房地产开发投资情况"), "ind": find_one(r"规上工业增加值"),
         "aaa": find_one(r"AAA信用债"), "cpi": find_one(r"中国价格指数"), "ppi": find_one(r"中国工业PPI"),
         "exportcsv": find_one(r"中国出口数据"), "region": find_one(r"注册地出口数据")}
series = {}
if files["export"]: series["pmi_export"] = xlsx_series(files["export"], "新出口订单")[-24:]
if files["cpi"]:
    ser = xlsx_series(files["cpi"], "居民消费价格指数")
    series["cpi"] = [(d, v - 100.0) for d, v in ser][-18:][::-1]
if files["ppi"]:
    ser = xlsx_series(files["ppi"], "工业生产者出厂价格指数")
    series["ppi"] = [(d, v - 100.0) for d, v in ser][-18:][::-1]
if files["exportcsv"]:
    agg = {}
    try:
        with open(files["exportcsv"], encoding="gb18030") as f:
            rd = csv.reader(f); next(rd, None)
            for r in rd:
                if len(r) > 7 and r[0].isdigit() and r[7]:
                    try: v = float(r[7].replace(",",""))
                    except Exception: continue
                    m = r[0][:4] + "-" + r[0][4:6]
                    agg[m] = agg.get(m, 0) + v
        series["exportval"] = sorted([(k, v/1e8) for k, v in agg.items()])[-12:]
    except Exception: pass
if files["region"]:
    try:
        import csv as _csv
        rows = []
        with open(files["region"], encoding="gb18030") as f:
            for r in _csv.DictReader(f):
                if not r.get("数据年月"): continue
                try: v = float((r.get("人民币") or "0").replace(",", ""))
                except Exception: continue
                rows.append((r["数据年月"].strip(), r.get("注册地名称", "").strip(), v))
        mt = {}; rg = {}
        for m, g, v in rows:
            mt[m] = mt.get(m, 0) + v
            rg[g] = rg.get(g, 0) + v
        series["export_region_total"] = sorted([(m, round(v / 1e8, 2)) for m, v in mt.items()])
        top = sorted(rg.items(), key=lambda x: -x[1])[:10]
        series["export_region_top"] = [(g, round(v / 1e8, 2)) for g, v in top]
        series["export_region_share"] = round(sum(v for _, v in top[:5]) / sum(rg.values()) * 100, 1)
    except Exception as e:
        print("region export skipped", e, file=sys.stderr)
if files["re"]: series["re"] = xlsx_series(files["re"], "房地产投资_累计增长")[-24:]
if files["ind"]: series["ind"] = xlsx_series(files["ind"], "规上工业增加值同比增长")[-24:]
if files["bond"]:
    wb = load_workbook(files["bond"], data_only=True, read_only=False); ws = wb[wb.sheetnames[0]]
    rows = list(ws.iter_rows(values_only=True)); hdr = rows[0]; ci = None
    for j, c in enumerate(hdr):
        if str(c).strip() == "10年": ci = j
    if ci is not None:
        ser = []
        for r in rows[1:]:
            if r and r[0] and ci < len(r) and fnum(r[ci]) is not None:
                ser.append((str(r[0])[:10], fnum(r[ci])))
        series["bond"] = ser[:60][::-1]
if files["dxy"]:
    ser = []
    with open(files["dxy"], encoding="utf-8-sig") as f:
        rd = csv.reader(f); next(rd, None)
        for r in rd:
            if len(r) > 1 and fnum(r[1]) is not None: ser.append((r[0], fnum(r[1])))
    series["dxy"] = ser[:60][::-1]
def curve_series(path, tenor):
    wb = load_workbook(path, data_only=True); ws = wb[wb.sheetnames[0]]
    rows = list(ws.iter_rows(values_only=True)); hdr = rows[0]
    date_i = 0; ci = None
    for j, c in enumerate(hdr):
        if str(c).strip() == "日期": date_i = j
        if str(c).strip() == tenor: ci = j
    if ci is None: return []
    out = []
    for r in rows[1:]:
        if not r or date_i >= len(r) or r[date_i] is None or ci >= len(r): continue
        v = fnum(r[ci]); d = str(r[date_i]).strip()[:10]
        if v is not None and re.search(r"20\d\d", d): out.append((d, v))
    return out
if files["aaa"] and files["bond"]:
    a = curve_series(files["aaa"], "5年")
    b = curve_series(files["bond"], "5年")
    bm = {d: v for d, v in b}
    series["spread"] = [(d, v - bm[d]) for d, v in a if d in bm][:60][::-1]
figdir = os.path.join(ROOT, "vault", CASE, "figures"); os.makedirs(figdir, exist_ok=True)
cachedir = os.path.join(ROOT, "runtime/cache/report"); os.makedirs(cachedir, exist_ok=True)
charts = {}
def chart(key, kind, title, source):
    if not series.get(key): return ""
    csvp = write_csv(os.path.join(cachedir, key + ".csv"), series[key])
    svg = os.path.join(figdir, "report-" + key + ".svg")
    return run_chart(kind, csvp, svg, title, source)
def chart_hbar(key, title, source):
    if not series.get(key): return ""
    csvp = os.path.join(cachedir, key + ".csv")
    with open(csvp, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f); w.writerow(["注册地", "累计出口"])
        for g, v in series[key]: w.writerow([g, v])
    svg = os.path.join(figdir, "report-" + key + ".svg")
    cmd = ["node", os.path.join(ROOT, "scripts/chart.js"), "hbar", "--csv", csvp,
           "--label", "注册地", "--value", "累计出口", "--title", title,
           "--source", source, "--out", svg]
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=60)
    return svg if r.returncode == 0 and os.path.exists(svg) else ""
charts["pmi_export"] = chart("pmi_export", "line", "PMI 新出口订单指数", "国家统计局 / 中国物流与采购联合会")
charts["cpi"] = chart("cpi", "line", "CPI 同比", "国家统计局 / 用户上传")
charts["ppi"] = chart("ppi", "line", "PPI 同比", "国家统计局 / 用户上传")
charts["export_region_total"] = chart("export_region_total", "line", "出口金额月度走势（注册地口径）", "海关总署 / 用户上传")
charts["export_region_top"] = chart_hbar("export_region_top", "出口注册地集中度（2026年1–9月累计）", "海关总署 / 用户上传")
charts["re"] = chart("re", "line", "房地产开发投资累计同比", "国家统计局")
charts["ind"] = chart("ind", "line", "规上工业增加值同比", "国家统计局")
charts["bond"] = chart("bond", "line", "10 年期国债收益率", "中债 / 用户上传")
charts["dxy"] = chart("dxy", "line", "美元指数", "东方财富 / 用户上传")
charts["spread"] = chart("spread", "line", "AAA 中短期票据 5Y 信用利差", "中债 / 用户上传")
def make_path_svg():
    import html
    steps = [("外部环境", "美国利率 · 美元指数 · 全球制造业"),
             ("国内增长", "出口 · 投资 · 消费 · PMI"),
             ("国内通胀", "CPI · PPI · 核心CPI"),
             ("金融条件", "10Y国债 · 信用利差 · 波动率"),
             ("锗行业传导", "外需出口链 · 内需投资 · 汇率与估值"),
             ("验证与情景", "一致与分歧 · 三情景 · 风险触发器"),
             ("结论与边界", "可证伪条件 · 待验证项")]
    W, H = 960, 740
    x, w, h, top, gap = 220, 520, 64, 42, 88
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d">' % (W, H, W, H),
             '<rect width="%d" height="%d" fill="#ffffff"/>' % (W, H),
             '<text x="%d" y="24" fill="#1F3A5F" font-size="17" font-weight="700">锗行业宏观研究分析框架</text>' % x,
             '<text x="%d" y="44" fill="#94A3B8" font-size="11">研究问题：外部环境与国内条件如何传导到锗生产行业</text>' % x]
    for i, (title, sub) in enumerate(steps):
        y = top + i * gap
        accent = i == 0 or i == len(steps) - 1
        fill = "#EEF4FF" if accent else "#F8FAFC"
        stroke = "#1F3A5F" if accent else "#CBD5E1"
        parts.append('<rect x="%d" y="%d" width="%d" height="%d" rx="8" fill="%s" stroke="%s" stroke-width="1.2"/>' % (x, y, w, h, fill, stroke))
        parts.append('<text x="%d" y="%d" fill="#0F172A" font-size="15" font-weight="600">%s</text>' % (x + 18, y + 27, html.escape(title)))
        parts.append('<text x="%d" y="%d" fill="#64748B" font-size="11">%s</text>' % (x + 18, y + 48, html.escape(sub)))
        if i < len(steps) - 1:
            cy = y + h
            parts.append('<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="#94A3B8" stroke-width="1.4"/>' % (x + w/2, cy + 4, x + w/2, cy + gap - 8))
            parts.append('<polygon points="%d,%d %d,%d %d,%d" fill="#94A3B8"/>' % (x + w/2 - 5, cy + gap - 16, x + w/2 + 5, cy + gap - 16, x + w/2, cy + gap - 7))
    parts.append('<text x="%d" y="%d" fill="#94A3B8" font-size="11">数据与证据：[S#] 来源见附表 C；判断与预测在文中单独标注</text>' % (x, H - 18))
    parts.append("</svg>")
    out = os.path.join(figdir, "macro-analysis-path.svg")
    open(out, "w", encoding="utf-8").write(chr(10).join(parts))
    return out
def latest(key):
    return series.get(key, [])[-1][1] if series.get(key) else None
def fmt(v, unit=""):
    return ("—" if v is None else (f"{v:.2f}" + unit))
md_path = os.path.join(ROOT, "vault", CASE, "research/macro.md")
md = open(md_path, encoding="utf-8").read()
lines = md.splitlines()
sections = []; cur = None
for ln in lines:
    m = re.match(r"^(#{1,3})\s+(.*)$", ln)
    if m:
        cur = {"level": len(m.group(1)), "title": m.group(2).strip(), "lines": []}
        sections.append(cur)
    elif cur is not None:
        cur["lines"].append(ln)
def section_text(title_kw):
    for s in sections:
        if title_kw in s["title"]:
            return "\n".join(s["lines"]).strip()
    return ""
summary = section_text("结论摘要")
claims = []
try:
    mj = json.load(open(os.path.join(ROOT, "vault", CASE, "research/macro.json"), encoding="utf-8"))
    claims = mj.get("claims") or []
except Exception: pass
def claim_texts(keywords, n=2):
    out = []
    for c in claims:
        t = str(c.get("text", ""))
        if any(k in t for k in keywords):
            out.append(t)
        if len(out) >= n: break
    return out
INTERPRET = {
 "现状": "解读：外需与内需、上游与下游、价格与数量三组对比，决定了当前是「增长弱修复、上游价格偏强、信用偏紧」的组合。",
 "宏观季节": "解读：增长与通胀两个维度并不同步，单看价格容易高估景气；政策约束主要来自信用和投资，而不是价格本身。",
 "需求": "解读：出口是当前最强项，投资和消费是拖累，政府支出与净出口方向仍需验证，不能把出口强直接等同于净出口贡献。",
 "政策": "解读：价格工具已偏松，但信用端未同步扩张，说明宽松传导受阻；政策更可能偏向数量型，降息空间与效果都受约束。",
 "市场验证": "解读：利率端支持「名义松」，信用端不支持「宽信用」，汇率端方向不一致；验证并不完整。",
 "情景": "解读：基准情景依赖外需韧性，最大触发器是出口回落；风险排序看谁最可能打断当前最强项，而不是概率大小。",
}
def pick_claims(groups):
    out = []
    for g in groups:
        for c in claims:
            t = str(c.get("text", ""))
            if any(k in t for k in g):
                if t not in out: out.append(t)
                break
    return out
def adaptive_paras(title):
    if "现状" in title:
        key = "现状"; groups = [["GDP"], ["CPI","PPI"], ["社融","M1","M2","Shibor","LPR"]]
    elif "宏观季节" in title:
        key = "宏观季节"; groups = [["GDP","PMI"], ["CPI","PPI"], ["固投"]]
    elif "需求" in title:
        key = "需求"; groups = [["出口","进口"], ["固投","社零"], ["净出口","GDP"]]
    elif "政策" in title:
        key = "政策"; groups = [["LPR","Shibor"], ["社融","M1","M2"], ["USDCNH","DXY"]]
    elif "市场验证" in title:
        key = "市场验证"; groups = [["10Y","利差"], ["社融","M1"], ["DXY","USDCNH"]]
    elif "情景" in title or "风险" in title:
        key = "情景"; groups = [["出口"], ["固投","社融"], ["USDCNH","DXY","PPI"]]
    else:
        return []
    texts = pick_claims(groups)
    if not texts: return []
    return texts + [INTERPRET[key]]
doc = Document()
sec = doc.sections[0]
sec.page_height = Cm(29.7); sec.page_width = Cm(21.0)
sec.top_margin = Cm(2.2); sec.bottom_margin = Cm(2.2); sec.left_margin = Cm(2.2); sec.right_margin = Cm(2.2)
st = doc.styles["Normal"]; st.font.name = "PingFang SC"; st.font.size = Pt(10.5)
st._element.rPr.rFonts.set(qn("w:eastAsia"), "PingFang SC")
for sn in ["Heading 1", "Heading 2", "Heading 3"]:
    h = doc.styles[sn]; h.font.name = "PingFang SC"; h.font.color.rgb = RGBColor(0x1F, 0x3A, 0x5F)
    h._element.rPr.rFonts.set(qn("w:eastAsia"), "PingFang SC")
def para(text, size=10.5, bold=False, color=None, align=None, space_after=4):
    p = doc.add_paragraph(); r = p.add_run(text); r.font.size = Pt(size); r.bold = bold
    if color: r.font.color.rgb = color
    if align: p.alignment = align
    p.paragraph_format.space_after = Pt(space_after); p.paragraph_format.line_spacing = 1.35
    return p
def clean_heading(t):
    t = re.sub(r"\s*[（(][^（）()]*[）)]\s*$", "", str(t)).strip()
    return t
def renumber(t):
    m = re.match(r"^(\d+)(\.\d+)?(.*)$", str(t))
    if not m: return t
    n = int(m.group(1))
    if 2 <= n <= 7: n -= 1
    return str(n) + (m.group(2) or "") + (m.group(3) or "")
def page_break(): doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
meta_notes = []
def strip_meta(t):
    t = str(t)
    t = re.sub(r"【[^】]{1,12}】", "", t)
    def repl(m):
        inner = m.group(1)
        if re.search(r"未计|仅方向|仅做|口径|不含|未取|估算|假设|待补|待验证", inner):
            meta_notes.append(inner.strip())
            return ""
        return m.group(0)
    t = re.sub(r"[（(]([^（）()]{1,80})[）)]", repl, t)
    t = t.replace("**", "")
    return re.sub(r"[ 	]+", " ", t).strip()
def add_header_footer():
    h = sec.header.paragraphs[0]; h.text = "AlphaDesk · 锗行业宏观研究"; h.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    for r in h.runs: r.font.size = Pt(8); r.font.color.rgb = RGBColor(0x94, 0xA3, 0xB8)
    p = sec.footer.paragraphs[0]; p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(); fld = OxmlElement("w:fldSimple"); fld.set(qn("w:instr"), "PAGE")
    run._r.addnext(fld)
    for r in p.runs: r.font.size = Pt(8)
add_header_footer()
for _ in range(3): para("")
para("AlphaDesk 投研", 11, True, RGBColor(0x1F, 0x3A, 0x5F), WD_ALIGN_PARAGRAPH.CENTER, 2)
para("宏观研究 · 锗行业", 10, False, RGBColor(0x64, 0x74, 0x8B), WD_ALIGN_PARAGRAPH.CENTER, 4)
para("外需韧性与内需修复的错位", 26, True, RGBColor(0x0F, 0x17, 0x2A), WD_ALIGN_PARAGRAPH.CENTER, 6)
para("国际环境、流动性与内外需向锗生产行业的传导", 13, False, RGBColor(0x47, 0x55, 0x69), WD_ALIGN_PARAGRAPH.CENTER, 10)
for _ in range(4): para("")
para(date.today().strftime("%Y 年 %m 月 %d 日"), 11, False, RGBColor(0x47, 0x55, 0x69), WD_ALIGN_PARAGRAPH.CENTER, 3)
para("内部研究 · 不构成投资建议", 9, False, RGBColor(0x94, 0xA3, 0xB8), WD_ALIGN_PARAGRAPH.CENTER, 0)
page_break()
para("目录", 16, True, RGBColor(0x1F, 0x3A, 0x5F), WD_ALIGN_PARAGRAPH.CENTER, 12)
para("研究分析框架", 9.5, False, RGBColor(0x47,0x55,0x69), None, 1)
for s in sections:
    if s["level"] == 2 and s["title"] and not s["title"].startswith("0.") and not s["title"].startswith("1.") and not s["title"].startswith("8.") and adaptive_paras(s["title"]):
        para(renumber(clean_heading(s["title"])), 9.5, False, RGBColor(0x47,0x55,0x69), None, 1)
page_break()
key_rows = [("制造业 PMI", "49.3", "2026-10，荣枯线下"),
        ("PMI 新出口订单", fmt(latest("export")), "2026-10，外需分项"),
        ("10Y 国债收益率", fmt(latest("bond"), "%"), "2026-11-03"),
        ("美元指数", fmt(latest("dxy")), "2026-11-03"),
        ("房地产开发投资", fmt(latest("re"), "%"), "累计同比，最新月"),
        ("规上工业增加值", fmt(latest("ind"), "%"), "同比，最新月")]
fig_no = 0; table_no = 0
pending_notes = []
pending_rows = []
def add_figure(chart_path, caption, source):
    global fig_no
    if not chart_path: return
    png = svg_png(chart_path)
    if not png: return
    fig_no += 1
    picp = doc.add_paragraph(); picp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    picp.paragraph_format.space_before = Pt(4); picp.paragraph_format.space_after = Pt(0)
    picp.add_run().add_picture(png, width=Cm(15.5))
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(0); p.paragraph_format.space_after = Pt(1); p.paragraph_format.line_spacing = 1.0
    r = p.add_run("图" + str(fig_no) + "：" + caption); r.font.size = Pt(8.5); r.bold = True
    p2 = doc.add_paragraph(); p2.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p2.paragraph_format.space_before = Pt(0); p2.paragraph_format.space_after = Pt(10); p2.paragraph_format.line_spacing = 1.0
    r2 = p2.add_run("资料来源：" + source); r2.font.size = Pt(8); r2.font.color.rgb = RGBColor(0x94,0xA3,0xB8)
def add_md_table(rows):
    global table_no
    if not rows: return
    kept_rows = []
    for r in rows:
        if any("待补" in str(c) for c in r):
            pending_rows.append(r); continue
        kept_rows.append(r)
    rows = kept_rows
    if len(rows) < 2: return
    table_no += 1
    drop = set(j for j, h in enumerate(rows[0]) if "来源" in str(h))
    if drop:
        rows = [[c for j, c in enumerate(r) if j not in drop] for r in rows]
    ncol = max(len(r) for r in rows)
    t = doc.add_table(rows=0, cols=ncol); t.style = "Table Grid"
    for row in rows:
        cells = t.add_row().cells
        for j in range(ncol):
            cells[j].text = ""
            txt = row[j] if j < len(row) else ""
            txt = strip_meta(txt)
            rr = cells[j].paragraphs[0].add_run(txt); rr.font.size = Pt(8.5)
            if row is rows[0]: rr.bold = True
    p = doc.add_paragraph(); r = p.add_run("表" + str(table_no) + "：数据表"); r.font.size = Pt(8.5); r.bold = True
def renumber(t):
    m = re.match(r"^(\d+)(\.\d+)?(.*)$", str(t))
    if not m: return t
    n = int(m.group(1))
    if 2 <= n <= 7: n -= 1
    return str(n) + (m.group(2) or "") + (m.group(3) or "")
path_svg = make_path_svg()
doc.add_heading("研究分析框架", level=1)
para("本报告围绕锗生产行业的宏观条件，按“外部环境—国内增长与通胀—金融条件—行业传导—验证与情景—结论边界”的框架展开；每一层都回答一个可证伪的问题，而不是按工作流顺序堆数据。框架如下：", 10.5)
add_figure(path_svg, "锗行业宏观研究分析框架", "AlphaDesk 研究框架")
page_break()
CONCISE = {
 "2. 现状仪表盘": [
   "增长端的分化很清楚：9 月出口 +36.3%，而固投 -9.69%、社零 +1.1%、制造业 PMI 49.3，外需与内需方向相反。出口是当前最强项，投资和消费则是主要拖累，所以不能把「增长弱」理解为全面走弱。",
   "按注册地拆分，出口高度集中：广东、江苏、浙江、上海、山东五地合计占 2026 年 1–9 月出口的 67.7%，9 月前五地占 69.0%。这说明外需强并非全国均匀，主要载体是沿海制造与外贸大省；但注册地口径不等于生产地或目的地，不能直接映射到锗出口。",
   "通胀端是上游强、下游弱：PPI +5.0%，CPI +0.9%，两者差约 4.1 个百分点；核心 CPI 约 +1.0%，说明终端需求并不强。这个组合更像成本端推动，而不是需求拉动，PPI 上行对下游利润的含义要谨慎。",
   "金融条件是「价格松、数量紧」：Shibor 1 周/3 月约 1.39%/1.40%，LPR 1Y/5Y 以上 3.0%/3.5%，中国 10Y 1.621%、10Y−2Y 约 +0.39 个百分点，资金价格确实低；但社融 1–9 月累计增量同比 -8.73%、M1−M2 约 -4.0 个百分点，信用扩张仍弱。价格低与数量紧并存，说明宽货币尚未转成宽信用。",
   "外部约束也不一致：中美 10Y 利差约 -3.32 个百分点，按利差逻辑人民币应偏弱，但 USDCNH 6.64971 反而偏强；DXY 约 101.87[S15]，处于 2026 年以来约 93% 分位，美元整体仍偏强；但 USDCNH 反而偏强，说明人民币强势更可能来自独立因素，不能简单归因于美元走弱，也不能把「人民币强」直接外推为汇率约束解除。",
 ],
 "3. 宏观季节": [
   "用增长和通胀两个维度定位，当前更像「弱增长、上游价格偏强」的组合，而不是典型复苏。出口支撑增长，但 PMI 已回到 49.3、固投连续负增，增长动能并不均衡。",
   "两个价格读数给出不同象限：PPI +5.0% 指向上游通胀，CPI +0.9%、核心 CPI 约 +1.0% 指向终端需求偏弱。单看 PPI 会高估景气，单看 CPI 会低估成本压力，必须把两者放在一起看。",
   "政策约束因此主要来自信用和投资，而不是价格本身。后续切换信号应盯固投、社融和出口能否同步改善；只靠单月价格读数判断复苏，容易误判。",
 ],
 "4. 需求拆解": [
   "从支出端看，2026Q1–Q3 GDP 实际同比 +4.6%，二产 +3.8%、三产 +5.2%，服务业是主要支撑；外需出口 +36.3%，明显强于固投 -9.69% 和社零 +1.1%。这组对比说明增长对外需的依赖度在上升。",
   "内需的拖累集中在投资：固投单月同比连续负增，地产、基建、制造分项又未完整取得，无法判断是哪个环节主导。消费则是低位修复，社零 +1.1% 还不足以对冲投资下行。",
   "政府支出和净出口的方向仍待验证。出口强不等于净出口对 GDP 的贡献强，进口同样高增、且接口未给金额单位；在支出法分项缺失前，只能做方向判断，不能做贡献度加减。",
 ],
 "5. 政策预判": [
   "价格型工具已经比较松：LPR 1Y/5Y 以上 3.0%/3.5%，中国 10Y 1.621%，Shibor 短端约 1.4%，无风险利率处于低位。但信用端没有同步扩张，社融累计增量同比 -8.73%、M1−M2 约 -4.0 个百分点，说明宽松传导受阻。",
   "因此政策方向是中性偏松，但更可能以数量型工具为主，而不是继续大幅降息。掣肘有三个：信用需求弱、地产链条未稳、人民币偏强与中美利差并存；降息空间和效果都受约束。",
   "地产数据不足，不能判断已企稳；财政支出、专项债和基建分项未取得，也不能判断财政托底力度。政策原文未取前，只能把已发布工具和预期工具分开写。",
 ],
 "6. 市场验证": [
   "利率端支持「名义松」：Shibor 1 周/3 月约 1.39%/1.40%，LPR 3.0%/3.5%，中国 10Y 1.621%，10Y−2Y 约 +0.39 个百分点，短端和长端都在低位，曲线正斜率。但长端低也可能反映增长预期弱，不能单独证明宽信用。",
   "信用端与利率端相反：社融 1–9 月累计增量同比 -8.73%，M1−M2 约 -4.0 个百分点，数量端偏紧。价格低、数量紧的组合，正好对应「宽货币未转宽信用」，这是当前最值得跟踪的分歧。",
   "汇率端也不一致：中美 10Y 利差约 -3.32 个百分点，但 USDCNH 6.64971 偏强；DXY 约 101.87[S15]，处于 2026 年以来约 93% 分位，美元整体偏强，而人民币仍偏强；信用利差和波动率缺失，汇率强势的原因仍不能完整验证。相关结论只能标待验证，不能当成已证实。",
 ],
 "7. 情景与风险": [
   "基准情景是外需韧性延续、内需弱修复、政策中性偏松：出口维持双位数、PMI 在 50 附近、固投降幅收窄、社融增量不再恶化。这个组合下，宏观对锗行业是外需与上游价格偏顺、内需与信用偏逆。",
   "最大触发器是外需回落。当前出口是最强项，但制造业 PMI 已 49.3、固投 -9.69%，一旦出口降到个位数或连续负增，增长会失去最强支撑，内需又难托底；传导链是外需订单下修→出口与工业开工走弱→锗需求与风险偏好承压。",
   "风险排序是外需回落 > 信用/投资收缩 > 汇率/外部利率 > 政策与价格，排序依据是「谁最可能打断当前最强项」，不是概率大小。情景与阈值都是判断规则，不是预测；锗供需、锗价和库存周期留给行业研究。",
 ],
}
def add_tables_from(lines):
    i = 0
    while i < len(lines):
        if lines[i].strip().startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                if not re.match(r"^[\s:|-]+$", "".join(cells)): rows.append(cells)
                i += 1
            add_md_table(rows)
        else:
            i += 1
for idx, s in enumerate(sections):
    if s["level"] == 1: continue
    if s["level"] != 2: continue
    if s["title"].startswith(("0.", "1.", "8.")): continue
    paras = adaptive_paras(s["title"])
    if not paras: continue
    doc.add_heading(renumber(clean_heading(s["title"])), level=1)
    for cp in paras:
        para(cp, 10.5, False, None, None, 4)
    child_lines = []
    j = idx + 1
    while j < len(sections) and sections[j]["level"] > 2:
        child_lines += sections[j]["lines"]; j += 1
    add_tables_from(s["lines"] + child_lines)
    if "2. 现状仪表盘" in s["title"]:
        for key, cap, src in [("pmi_export", "PMI 新出口订单指数：外需分项仍在收缩区间", "国家统计局、中国物流与采购联合会"),
                              ("export_region_total", "出口金额月度走势（注册地口径）", "海关总署、用户上传"),
                              ("export_region_top", "出口注册地集中度（2026 年 1–9 月累计）", "海关总署、用户上传"),
                              ("cpi", "CPI 同比：低位运行", "国家统计局、用户上传"),
                              ("ppi", "PPI 同比：上行但传导有限", "国家统计局、用户上传"),
                              ("ind", "规上工业增加值同比：生产端修复但斜率有限", "国家统计局"),
                              ("dxy", "美元指数：外部金融条件的高频锚", "东方财富")]:
            add_figure(charts.get(key), cap, src)
    if "4. 需求拆解" in s["title"]:
        add_figure(charts.get("re"), "房地产开发投资累计同比：内需的主要拖累项", "国家统计局")
    if "6. 市场验证" in s["title"]:
        add_figure(charts.get("bond"), "10 年期国债收益率：价格松、数量紧", "中债")
        add_figure(charts.get("spread"), "AAA 中短期票据 5Y 信用利差", "中债")
page_break()
para("风险提示", 14, True, RGBColor(0x1F,0x3A,0x5F), None, 5)
for t in ["宏观数据存在修订与口径差异，最新月份数据可能尚未发布；",
          "本报告仅覆盖宏观视角，不构成对锗价、行业供需或个股估值的判断；",
          "报告中情景与阈值是分析规则，不是预测概率；",
          "数据来源以底稿证据池与用户上传资料为准，未取得的数据未用替代值。"]:
    p = doc.add_paragraph(style="List Bullet"); r = p.add_run(t); r.font.size = Pt(9.5)
para("免责声明", 11, True, RGBColor(0x1F,0x3A,0x5F), None, 4)
para("本报告由 AlphaDesk 投研团队内部生成，仅供研究参考，不构成任何投资建议或收益承诺。报告中的判断可能随数据更新而变化。", 9, False, RGBColor(0x47,0x55,0x69), None, 3)
para("附表 A：指标与口径", 12, True, RGBColor(0x1F,0x3A,0x5F), None, 4)
tbl = doc.add_table(rows=1, cols=3); tbl.style = "Table Grid"; tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
for j, t in enumerate(["指标", "最新值", "口径/说明"]):
    c = tbl.rows[0].cells[j]; c.text = ""; r = c.paragraphs[0].add_run(t); r.bold = True; r.font.size = Pt(8.5); r.font.color.rgb = RGBColor(0xFF,0xFF,0xFF)
    shd = OxmlElement("w:shd"); shd.set(qn("w:fill"), "1F3A5F"); c._tc.get_or_add_tcPr().append(shd)
for row in key_rows:
    cells = tbl.add_row().cells
    for j, t in enumerate(row):
        cells[j].text = ""; r = cells[j].paragraphs[0].add_run(t); r.font.size = Pt(8.5)
para("注：最新值以底稿引用区间为准；无数据项用“—”表示，不做替代。", 8, False, RGBColor(0x94,0xA3,0xB8), None, 2)
if series.get("export_region_top"):
    para("附表 A2：出口注册地结构（2026 年 1–9 月累计）", 10, True, RGBColor(0x1F,0x3A,0x5F), None, 4)
    total = sum(v for _, v in series.get("export_region_total", []))
    tb = doc.add_table(rows=1, cols=4); tb.style = "Table Grid"
    for j, t in enumerate(["排名", "注册地", "累计出口（亿元）", "占比"]):
        c = tb.rows[0].cells[j]; c.text = ""; r = c.paragraphs[0].add_run(t); r.bold = True; r.font.size = Pt(8.5)
    for i, (g, v) in enumerate(series["export_region_top"], 1):
        cells = tb.add_row().cells
        for j, t in enumerate([str(i), g, f"{v:.1f}", f"{v/total*100:.1f}%"]):
            cells[j].text = ""; r = cells[j].paragraphs[0].add_run(t); r.font.size = Pt(8.5)
para("附表 B：研究口径", 12, True, RGBColor(0x1F,0x3A,0x5F), None, 4)
for ln in section_text("0. 问题与口径").splitlines():
    if ln.strip() and not ln.strip().startswith("#"):
        para(strip_meta(ln).replace("**", ""), 8.5, False, RGBColor(0x47,0x55,0x69), None, 2)
notes_b = [m for m in meta_notes if "待补" not in m and "待验证" not in m]
if notes_b:
    para("正文口径提示：" + "；".join(dict.fromkeys(notes_b)), 8.5, False, RGBColor(0x94,0xA3,0xB8), None, 2)
para("附表 C：证据来源", 12, True, RGBColor(0x1F,0x3A,0x5F), None, 4)
evp = os.path.join(ROOT, "vault", CASE, "evidence/sources.jsonl")
try:
    evs = [json.loads(x) for x in open(evp, encoding="utf-8").read().splitlines() if x.strip()]
    for e in evs[:30]:
        para(str(e.get("id","")) + "｜" + str(e.get("field",""))[:60] + "｜" + str(e.get("url",""))[:100], 7.5, False, RGBColor(0x94,0xA3,0xB8), None, 1)
except Exception: pass
for m in meta_notes:
    if ("待补" in m or "待验证" in m) and m not in pending_notes:
        pending_notes.append(m)
para("附表 D：待补与待验证事项", 12, True, RGBColor(0x1F,0x3A,0x5F), None, 4)
for n in pending_notes:
    for ln in str(n).splitlines():
        if ln.strip() and not ln.strip().startswith("#"):
            para(strip_meta(ln).replace("**", "").lstrip("：: "), 8.5, False, RGBColor(0x47,0x55,0x69), None, 2)
for r in pending_rows:
    para("；".join([str(c) for c in r if str(c).strip()]), 8.5, False, RGBColor(0x47,0x55,0x69), None, 2)
# 输出数据清单与报告计划，便于复核与复用到其他课题
try:
    plan_sections = []
    for s0 in sections:
        if s0["level"] != 2: continue
        if s0["title"].startswith(("0.","1.","8.")): continue
        paras0 = adaptive_paras(s0["title"])
        if not paras0: continue
        plan_sections.append({"title": renumber(clean_heading(s0["title"])), "paragraphs": len(paras0)})
    inventory = {"case": CASE, "claims": len(claims),
      "series": sorted(series.keys()), "groups": {
        "growth": bool(claims), "inflation": any("CPI" in str(c.get("text","")) or "PPI" in str(c.get("text","")) for c in claims),
        "financial": any(k in str(c.get("text","")) for c in claims for k in ["Shibor","LPR","社融","M1","M2"]),
        "fx": any(k in str(c.get("text","")) for c in claims for k in ["USDCNH","DXY","利差"]),
        "export_region": bool(series.get("export_region_top")),
      }}
    plan = {"case": CASE, "sections": plan_sections,
      "figures": sorted([k for k, v in charts.items() if v]),
      "tables": table_no, "generatedAt": None}
    os.makedirs(os.path.join(ROOT, "runtime/cache"), exist_ok=True)
    open(os.path.join(ROOT, "runtime/cache/report-inventory.json"), "w", encoding="utf-8").write(json.dumps(inventory, ensure_ascii=False, indent=2))
    open(os.path.join(ROOT, "runtime/cache/report-plan.json"), "w", encoding="utf-8").write(json.dumps(plan, ensure_ascii=False, indent=2))
except Exception as e:
    print("plan skipped", e, file=sys.stderr)
tmp = tempfile.mktemp(suffix=".docx"); doc.save(tmp)
out_rel = "reports/macro-report.docx"
try:
    data = base64.b64encode(open(tmp,"rb").read()).decode()
    payload = json.dumps({"case":CASE,"path":out_rel,"name":"宏观研究分析报告.docx","contentBase64":data,"by":"system"}).encode()
    req = urllib.request.Request(os.environ.get("DESK_BROKER","http://127.0.0.1:7801")+"/api/upload", data=payload, headers={"content-type":"application/json"})
    r = json.loads(urllib.request.urlopen(req, timeout=30).read().decode())
    print(json.dumps({"ok":True,"out":r.get("path",out_rel),"version":r.get("version"),"bytes":r.get("bytes"),
      "figures":{k:bool(v) for k,v in charts.items()},"figureCount":fig_no,"tableCount":table_no}, ensure_ascii=False))
except Exception as e:
    dst=os.path.join(ROOT,"vault",CASE,out_rel);os.makedirs(os.path.dirname(dst),exist_ok=True);open(dst,"wb").write(open(tmp,"rb").read())
    print(json.dumps({"ok":True,"out":out_rel,"fallback":True,"error":str(e)[:200],"figureCount":fig_no}, ensure_ascii=False))
