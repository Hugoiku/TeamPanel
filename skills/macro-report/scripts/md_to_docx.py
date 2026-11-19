#!/usr/bin/env python3
"""md_to_docx.py — Markdown -> Word（含表格/图片），并上传到 vault"""
import sys, os, re, json, base64, subprocess, tempfile, urllib.request
from docx import Document
from docx.shared import Pt, Cm
from docx.oxml.ns import qn
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = sys.argv[1:]
def val(n, d=""):
    return args[args.index("--" + n) + 1] if "--" + n in args else d
md_path = val("md")
out_rel = val("out", "reports/report.docx")
case = os.environ.get("DESK_CASE", "")
if not md_path or not os.path.exists(md_path):
    print(json.dumps({"ok": False, "error": "md not found"})); sys.exit(2)
md_dir = os.path.dirname(os.path.abspath(md_path))
vault_root = os.path.dirname(md_dir)
doc = Document()
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
def clean(s):
    s = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", s)
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)
    s = s.replace("**", "").replace("__", "")
    s = s.replace(chr(96), "")
    return s.strip()
def find_path(p):
    p = p.strip().replace("\\", "/")
    for base in (md_dir, os.path.dirname(md_dir), vault_root):
        q = os.path.normpath(os.path.join(base, p))
        if os.path.exists(q): return q
    return ""
chrome = os.environ.get("CHROME_PATH") or os.path.expanduser("~/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")
def svg_png(svg):
    if not os.path.exists(chrome): return ""
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
    except Exception:
        return ""
lines = open(md_path, encoding="utf-8").read().splitlines()
i = 0
while i < len(lines):
    line = lines[i]
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
        doc.add_heading(clean(m.group(2)), level=min(3, len(m.group(1))))
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
            for r in rows:
                cells = table.add_row().cells
                for j in range(ncol):
                    cells[j].text = clean(r[j]) if j < len(r) else ""
                    for pp in cells[j].paragraphs:
                        for run in pp.runs: run.font.size = Pt(8.5)
        continue
    imgs = re.findall(r"!\[([^\]]*)\]\(([^)]+)\)", line)
    if imgs:
        for alt, path in imgs:
            fp = find_path(path)
            if fp and fp.lower().endswith(".svg"): fp = svg_png(fp)
            if fp:
                try:
                    doc.add_picture(fp, width=Cm(15))
                    if alt: doc.add_paragraph(alt, style="Caption")
                except Exception:
                    pass
        i += 1; continue
    if re.match(r"^\s*[-*]\s+", line):
        doc.add_paragraph(clean(re.sub(r"^\s*[-*]\s+", "", line)), style="List Bullet"); i += 1; continue
    if re.match(r"^\s*\d+\.\s+", line):
        doc.add_paragraph(clean(re.sub(r"^\s*\d+\.\s+", "", line)), style="List Number"); i += 1; continue
    if line.strip():
        doc.add_paragraph(clean(line))
    i += 1
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
