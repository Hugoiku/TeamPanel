#!/usr/bin/env python3
"""md_to_docx.py — Markdown -> Word（含表格/图片），并上传到 vault"""
import sys, os, re, json, base64, subprocess, tempfile, urllib.request
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from datetime import date
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = sys.argv[1:]
def val(n, d=""):
    return args[args.index("--" + n) + 1] if "--" + n in args else d
def flag(n):
    return "--" + n in args
def add_toc(doc, levels="1-3"):
    p = doc.add_paragraph()
    run = p.add_run()
    fld = OxmlElement("w:fldSimple")
    instr = "TOC " + chr(92) + "o " + chr(34) + levels + chr(34) + " " + chr(92) + "h " + chr(92) + "z " + chr(92) + "u"
    fld.set(qn("w:instr"), instr)
    run._r.append(fld)
def add_page_field(paragraph):
    run = paragraph.add_run()
    f1 = OxmlElement("w:fldChar"); f1.set(qn("w:fldCharType"), "begin")
    it = OxmlElement("w:instrText"); it.set(qn("xml:space"), "preserve"); it.text = "PAGE"
    f2 = OxmlElement("w:fldChar"); f2.set(qn("w:fldCharType"), "end")
    run._r.append(f1); run._r.append(it); run._r.append(f2)
def shade_cell(cell, fill):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd"); shd.set(qn("w:fill"), fill)
    tcPr.append(shd)
def repeat_header(row):
    trPr = row._tr.get_or_add_trPr()
    th = OxmlElement("w:tblHeader"); th.set(qn("w:val"), "true"); trPr.append(th)
md_path = val("md")
out_rel = val("out", "reports/report.docx")
case = os.environ.get("DESK_CASE", "")
if not md_path or not os.path.exists(md_path):
    print(json.dumps({"ok": False, "error": "md not found"})); sys.exit(2)
md_dir = os.path.dirname(os.path.abspath(md_path))
vault_root = os.path.dirname(md_dir)
doc = Document()
title = val("title", "")
subtitle = val("subtitle", "")
role = val("role", "")
if title:
    for _ in range(3): doc.add_paragraph("")
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run(title); r.bold = True; r.font.size = Pt(26); r.font.color.rgb = RGBColor(0x1F, 0x3A, 0x5F)
    if subtitle:
        p2 = doc.add_paragraph(); p2.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r2 = p2.add_run(subtitle); r2.font.size = Pt(13); r2.font.color.rgb = RGBColor(0x64, 0x74, 0x8B)
    for _ in range(3): doc.add_paragraph("")
    if not flag("investor"):
        meta = [("case", case), ("role", role), ("date", date.today().isoformat()), ("confidential", "内部研究 · 不构成投资建议")]
        for k, v in meta:
            p3 = doc.add_paragraph(); p3.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p3.add_run(k + "：" + str(v)).font.size = Pt(9)
    doc.add_page_break()
if flag("toc") or (title and not flag("investor")):
    doc.add_heading("目录", level=1)
    add_toc(doc)
    doc.add_page_break()
style = doc.styles["Normal"]
style.font.name = "PingFang SC"
style.font.size = Pt(10.5)
style._element.rPr.rFonts.set(qn("w:eastAsia"), "PingFang SC")
for sname in ["Heading 1", "Heading 2", "Heading 3"]:
    try:
        h = doc.styles[sname]; h.font.name = "PingFang SC"
        h._element.rPr.rFonts.set(qn("w:eastAsia"), "PingFang SC")
    except Exception:
        pass
try:
    sec = doc.sections[0]
    hp = sec.header.paragraphs[0]
    hp.text = (title or "AlphaDesk 研究报告") + ("  ·  " + case if case else "")
    hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    for run in hp.runs: run.font.size = Pt(8); run.font.color.rgb = RGBColor(0x94, 0xA3, 0xB8)
    fp = sec.footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    add_page_field(fp)
    for run in fp.runs: run.font.size = Pt(8)
except Exception:
    pass
def clean(s):
    s = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", s)
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)
    s = s.replace("**", "").replace("__", "")
    s = s.replace(chr(96), "")
    return s.strip()
def add_inline(paragraph, text):
    parts = re.split(r"(\[S\d+\])", clean(text))
    for part in parts:
        if not part: continue
        run = paragraph.add_run(part)
        if re.fullmatch(r"\[S\d+\]", part):
            run.font.superscript = True
            run.font.size = Pt(7.5)
            run.font.color.rgb = RGBColor(0x25, 0x63, 0xEB)

def find_path(p):
    p = p.strip().replace(chr(92), "/")
    case_root = os.path.join(ROOT, "vault", case) if case else ""
    bases = [md_dir, os.path.dirname(md_dir), vault_root]
    if case_root: bases += [case_root, os.path.join(case_root, "reports")]
    for base in bases:
        q = os.path.normpath(os.path.join(base, p))
        if os.path.exists(q): return q
    return ""
chrome = os.environ.get("CHROME_PATH") or "/Users/chenyonghong/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
_pw = None
_pw_browser = None
def svg_png(svg):
    global _pw, _pw_browser
    if not os.path.exists(chrome): return ""
    out = tempfile.mktemp(suffix=".png")
    try:
        txt = open(svg, encoding="utf-8").read()
        mw = re.search(r'width="([0-9.]+)"', txt); mh = re.search(r'height="([0-9.]+)"', txt)
        w = int(float(mw.group(1))) if mw else 760; h = int(float(mh.group(1))) if mh else 420
        try:
            from playwright.sync_api import sync_playwright
            if _pw is None:
                _pw = sync_playwright().start()
                _pw_browser = _pw.chromium.launch(headless=True, executable_path=chrome)
            pg = _pw_browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=2)
            pg.goto("file://" + os.path.abspath(svg))
            pg.screenshot(path=out)
            pg.close()
            if os.path.exists(out) and os.path.getsize(out) > 1000: return out
        except Exception:
            pass
        ud = tempfile.mkdtemp(prefix="docx-chrome-")
        subprocess.run([chrome, "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
          "--no-first-run", "--disable-extensions", "--user-data-dir=" + ud,
          "--force-device-scale-factor=2", "--window-size=%d,%d" % (w, h),
          "--screenshot=" + out, "file://" + os.path.abspath(svg)],
          capture_output=True, timeout=10)
        try:
            import shutil; shutil.rmtree(ud, ignore_errors=True)
        except Exception: pass
        return out if os.path.exists(out) and os.path.getsize(out) > 1000 else ""
    except Exception:
        return ""

lines = open(md_path, encoding="utf-8").read().splitlines()
i = 0
first_h1_skipped = False
while i < len(lines):
    line = lines[i]
    if line.strip() == "<!-- pagebreak -->":
        doc.add_page_break(); i += 1; continue
    if line.strip() == "<!-- toc -->":
        doc.add_heading("目录", level=1); add_toc(doc); doc.add_page_break(); i += 1; continue
    if line.strip().startswith("~~~"):
        buf = []; i += 1
        while i < len(lines) and not lines[i].strip().startswith("~~~"):
            buf.append(lines[i]); i += 1
        i += 1
        p = doc.add_paragraph("\n".join(buf))
        for r in p.runs:
            r.font.name = "Menlo"; r.font.size = Pt(9)
        continue
    m = re.match(r"^(#{1,6})\s+(.*)$", line)
    if m:
        lvl = len(m.group(1))
        if title and lvl == 1 and not first_h1_skipped:
            first_h1_skipped = True
            i += 1; continue
        heading_text = re.sub(r"（≤\s*\d+\s*字）", "", clean(m.group(2))).strip()
        doc.add_heading(heading_text, level=min(3, lvl))
        i += 1; continue
    if line.strip().startswith("|") and i + 1 < len(lines) and re.match(r"^\s*\|?[\s:|-]+\|", lines[i + 1]):
        rows = []
        while i < len(lines) and lines[i].strip().startswith("|"):
            cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
            if not re.match(r"^[\s:|-]+$", "".join(cells)): rows.append(cells)
            i += 1
        if rows:
            ncol = max(len(r) for r in rows)
            table = doc.add_table(rows=0, cols=ncol); table.style = "Table Grid"
            for ri, r in enumerate(rows):
                cells = table.add_row().cells
                for j in range(ncol):
                    cells[j].text = clean(r[j]) if j < len(r) else ""
                    for pp in cells[j].paragraphs:
                        for run in pp.runs: run.font.size = Pt(8.5)
                    if ri == 0: shade_cell(cells[j], "EAF2FB")
            table.alignment = WD_TABLE_ALIGNMENT.CENTER
            if len(table.rows): repeat_header(table.rows[0])
        continue
    imgs = re.findall(r"!\[([^\]]*)\]\(([^)]+)\)", line)
    if imgs:
        for alt, path in imgs:
            fp = find_path(path)
            if fp and fp.lower().endswith(".svg"): fp = svg_png(fp)
            if fp:
                try:
                    fig_no = globals().get("fig_no", 0) + 1
                    globals()["fig_no"] = fig_no
                    p_img = doc.add_paragraph(); p_img.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    p_img.add_run().add_picture(fp, width=Cm(14.5))
                    cap = ("图 " + str(fig_no) + "：" if alt else "") + (alt or "")
                    if cap:
                        p_cap = doc.add_paragraph(cap, style="Caption"); p_cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
                except Exception:
                    pass
        i += 1; continue
    if re.match(r"^\s*[-*]\s+", line):
        p0 = doc.add_paragraph(style="List Bullet"); add_inline(p0, re.sub(r"^\s*[-*]\s+", "", line)); i += 1; continue
    if re.match(r"^\s*\d+\.\s+", line):
        p0 = doc.add_paragraph(style="List Number"); add_inline(p0, re.sub(r"^\s*\d+\.\s+", "", line)); i += 1; continue
    if line.strip().startswith("> "):
        p0 = doc.add_paragraph(); add_inline(p0, line.strip()[2:]); p0.runs[0].italic = True if p0.runs else False; i += 1; continue
    if line.strip():
        p0 = doc.add_paragraph(); add_inline(p0, line)
    i += 1
# 证据索引与免责声明
try:
    evp = os.path.join(ROOT, "vault", case, "evidence/sources.jsonl")
    evs = []
    if case and os.path.exists(evp):
        for line in open(evp, encoding="utf-8"):
            try: evs.append(json.loads(line))
            except Exception: pass
    if evs and flag("evidence-appendix"):
        doc.add_page_break(); doc.add_heading("附录：证据索引", level=1)
        rows = [["证据", "字段", "数值", "来源/URL", "抓取时间"]]
        for e in evs[-120:]:
            rows.append([str(e.get("id", "")), str(e.get("field", ""))[:40], str(e.get("value", ""))[:60],
              str(e.get("url", ""))[:90], str(e.get("fetched_at", ""))[:19]])
        t = doc.add_table(rows=0, cols=5); t.style = "Table Grid"
        for ri, r in enumerate(rows):
            cells = t.add_row().cells
            for j in range(5):
                cells[j].text = r[j] if j < len(r) else ""
                for pp in cells[j].paragraphs:
                    for run in pp.runs: run.font.size = Pt(7.5)
                if ri == 0: shade_cell(cells[j], "EAF2FB")
        repeat_header(t.rows[0])
except Exception: pass
if not flag("no-disclaimer"):
    doc.add_paragraph("")
    doc.add_heading("免责声明", level=1)
    doc.add_paragraph("本报告由 AI 投研工作流生成，仅供内部研究讨论，不构成任何投资建议。数据与结论需经审计、法务及投委会复核后使用。")
# 部分完成说明（从账本读取本 case 的 partial WorkItem）
try:
    ledger = os.path.join(ROOT, "runtime/ledger/events.jsonl")
    seen = {}
    if case and os.path.exists(ledger):
        for line in open(ledger, encoding="utf-8"):
            try:
                e = json.loads(line)
                if e.get("case") == case and e.get("type") == "work.finished" and e.get("partial"):
                    seen[e.get("workId")] = e
            except Exception: pass
    if seen:
        doc.add_page_break(); doc.add_heading("附录：部分完成说明", level=1)
        for wid, e in seen.items():
            doc.add_paragraph("• " + str(e.get("nodeId") or wid) + "：部分完成；" + str(e.get("error") or "相关结论置信度下降。"))
except Exception: pass
tmp = tempfile.mktemp(suffix=".docx"); doc.save(tmp)
try:
    data = base64.b64encode(open(tmp, "rb").read()).decode()
    payload = json.dumps({"case": case, "path": out_rel, "name": os.path.basename(out_rel),
      "contentBase64": data, "by": "system"}).encode()
    req = urllib.request.Request(os.environ.get("DESK_BROKER", "http://127.0.0.1:7801") + "/api/upload",
      data=payload, headers={"content-type": "application/json"})
    r = json.loads(urllib.request.urlopen(req, timeout=30).read().decode())
    print(json.dumps({"ok": True, "out": r.get("path", out_rel), "version": r.get("version"), "bytes": r.get("bytes")}))
except Exception as e:
    dst = os.path.join(ROOT, "vault", case, out_rel); os.makedirs(os.path.dirname(dst), exist_ok=True)
    open(dst, "wb").write(open(tmp, "rb").read())
    print(json.dumps({"ok": True, "out": out_rel, "fallback": True, "error": str(e)[:200]}))
