#!/usr/bin/env python3
"""ocr.py <file> [--out out.txt] [--max-pages N] — 图片/PDF OCR（tesseract + PyMuPDF）"""
import sys, os, subprocess, tempfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESS = os.environ.get("TESSERACT", "tesseract")
TESSDATA = os.path.join(ROOT, "runtime/tessdata")
args = sys.argv[1:]
if not args:
    print("用法: ocr.py <file> [--out x.txt] [--max-pages N]", file=sys.stderr); sys.exit(2)
src = args[0]
out = ""
maxpages = 40
if "--out" in args: out = args[args.index("--out") + 1]
if "--max-pages" in args: maxpages = int(args[args.index("--max-pages") + 1])
langs = "chi_sim+eng"
if not os.path.exists(os.path.join(TESSDATA, "chi_sim.traineddata")):
    langs = "eng"

def ocr_img(path):
    cmd = [TESS, path, "stdout", "-l", langs, "--tessdata-dir", TESSDATA, "--psm", "6"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else (r.stdout + "\n[OCR ERROR] " + r.stderr[-300:])

texts = []
ext = os.path.splitext(src)[1].lower()
if ext == ".pdf":
    import fitz
    doc = fitz.open(src)
    with tempfile.TemporaryDirectory() as td:
        for i, page in enumerate(doc):
            if i >= maxpages: break
            pix = page.get_pixmap(dpi=200)
            p = os.path.join(td, "p%d.png" % i)
            pix.save(p)
            texts.append("\n## 第 %d 页\n" % (i + 1) + ocr_img(p))
else:
    texts.append(ocr_img(src))
text = "\n".join(texts)
if out:
    open(out, "w", encoding="utf-8").write(text)
print(text)
