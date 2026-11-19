#!/usr/bin/env node
"use strict";
/**
 * extract — 把 vault 里的本地资料转成员工/面板可读的文本
 *
 *   node scripts/extract.js --case case-2026-003 --path uploads/xxx.xlsx
 *   node scripts/extract.js --case c --path uploads/yyy.pdf --max 40000
 *
 * 支持：txt/md/csv/json/jsonl 直接读；xlsx/xls 用 python openpyxl 转 CSV；
 *       pdf 用 python pypdf / PyPDF2 / pdfminer 提取；图片只返回元数据提示。
 * 输出：stdout 文本（最多 --max 字符，默认 200000）。
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
const CASE = arg("case", "default");
const FILE = arg("file", "");
const REL = arg("path", "") || (FILE ? path.basename(FILE) : "");
const MAX = parseInt(arg("max", "200000"), 10);
if (!REL) { console.error("用法: node scripts/extract.js --case <case> --path <vault 相对路径> | --file <绝对路径>"); process.exit(2); }
const abs = FILE ? path.resolve(FILE) : path.join(ROOT, "vault", CASE, REL);
if (!fs.existsSync(abs)) { console.error("文件不存在: " + REL); process.exit(3); }
const ext = (REL.split(".").pop() || "").toLowerCase();
const info = { file: REL, bytes: fs.statSync(abs).size, ext };

function py(code, args) {
  // pypdf 等解析库装在 runtime/py（工作区内，已 gitignore），避免污染系统 Python
  const sep = process.platform === "win32" ? ";" : ":";
  const env = Object.assign({}, process.env, {
    PYTHONPATH: path.join(ROOT, "runtime/py") + (process.env.PYTHONPATH ? sep + process.env.PYTHONPATH : "")
  });
  const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  const p = spawnSync(PY, ["-c", code].concat(args || []), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env, shell: process.platform === "win32" });
  if (p.status !== 0) return { ok: false, err: String(p.stderr || "").slice(0, 500) };
  return { ok: true, out: String(p.stdout || "") };
}

if (["csv", "json", "jsonl", "md", "txt", "tsv", "yml", "yaml"].indexOf(ext) >= 0) {
  process.stdout.write(fs.readFileSync(abs, "utf8").slice(0, MAX));
  process.exit(0);
}
if (ext === "docx") {
  const code = "import sys\nfrom docx import Document\nd=Document(sys.argv[1])\nfor p in d.paragraphs:\n  if p.text.strip(): print(p.text)\nfor ti,t in enumerate(d.tables):\n  print('## table',ti+1)\n  for row in t.rows:\n    print(' | '.join(c.text for c in row.cells))\n";
  const r = py(code, [abs]);
  if (!r.ok) { console.error("无法解析 Word（需要 python-docx）：" + r.err); process.exit(6); }
  const head = "## 文件：" + REL + "（" + fs.statSync(abs).size + " bytes，docx→text）\n";
  process.stdout.write((head + r.out).slice(0, MAX));
  process.exit(0);
}
if (ext === "xlsx" || ext === "xls") {
  const code = "import sys,openpyxl\nwb=openpyxl.load_workbook(sys.argv[1],data_only=True,read_only=True)\nfor ws in wb.worksheets:\n  print('## sheet:',ws.title)\n  for row in ws.iter_rows(values_only=True):\n    cells=[('' if c is None else str(c)) for c in row]\n    if any(cells): print(','.join(cells))\n";
  let r = py(code, [abs]);
  // 老式 .xls（OLE）openpyxl 不支持，用 xlrd 兜底；NFRA 等政府站点附件常见。
  if (!r.ok && ext === "xls") {
    const codeXls = "import sys,xlrd\nbook=xlrd.open_workbook(sys.argv[1])\nfor sh in book.sheets():\n  print('## sheet:',sh.name)\n  for i in range(sh.nrows):\n    vals=[str(sh.cell_value(i,j)) for j in range(sh.ncols)]\n    if any(v.strip() for v in vals): print(','.join(vals))\n";
    r = py(codeXls, [abs]);
  }
  if (!r.ok) { console.error("无法解析表格（需要 python3 + openpyxl/xlrd）：" + r.err); process.exit(4); }
  const head = "## 文件：" + REL + "（" + fs.statSync(abs).size + " bytes，xlsx→CSV）\n";
  process.stdout.write((head + r.out).slice(0, MAX));
  process.exit(0);
}
if (ext === "pdf") {
  const TABLES = process.argv.indexOf("--tables") >= 0;
  let code;
  if (TABLES) {
    code = "import sys, pdfplumber\nwith pdfplumber.open(sys.argv[1]) as pdf:\n" +
      "    for i, page in enumerate(pdf.pages):\n" +
      "        print('## 第 %d 页' % (i+1))\n" +
      "        for t in page.extract_tables():\n" +
      "            for row in t:\n" +
      "                print(','.join('' if c is None else str(c).replace(chr(10),' ') for c in row))\n";
  } else {
    code = "import sys\ntry:\n  from pypdf import PdfReader\nexcept Exception:\n  try:\n    from PyPDF2 import PdfReader\n  except Exception:\n    from pdfminer.high_level import extract_text as _et\n    print(_et(sys.argv[1])); raise SystemExit(0)\nr=PdfReader(sys.argv[1])\nprint(chr(10).join((p.extract_text() or '') for p in r.pages))\n";
  }
  const r = py(code, [abs]);
  if (!r.ok) { console.error("无法解析 PDF（需要 pypdf/PyPDF2/pdfminer 或 pdfplumber）：" + r.err); process.exit(5); }
  const head = "## 文件：" + REL + "（" + fs.statSync(abs).size + " bytes，" + (TABLES ? "pdf→tables" : "pdf→text") + "）\n";
  process.stdout.write((head + r.out).slice(0, MAX));
  process.exit(0);
}
if (["png", "jpg", "jpeg", "webp", "gif"].indexOf(ext) >= 0) {
  process.stdout.write("## 图片：" + REL + "（" + fs.statSync(abs).size + " bytes）\n图片无法自动转文字：请在面板里预览，或把它转成 CSV/文字后上传；需要员工引用时请补一份文字摘要。\n");
  process.exit(0);
}
process.stdout.write("## 未识别格式：" + REL + "（" + fs.statSync(abs).size + " bytes）\n请转成 CSV/Excel/PDF 或文本后上传。\n");
