#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Deterministic Word tone cleanup: remove inline scaffold labels, replace prose semicolons."""
import sys, os, re, json, shutil
from docx import Document
args = sys.argv[1:]
def val(k, d=""):
    return args[args.index("--"+k)+1] if "--"+k in args else d
p = val("docx")
if not p or not os.path.exists(p):
    print(json.dumps({"ok": False, "error": "docx not found"})); sys.exit(2)
doc = Document(p)
labels = "结论|判断|一句话|边界|待补|口径提示|事实|传导链|政策含义|监测|方向|掣肘|状态区分|拐点信号|分歧|最大触发器|排序|数据期|当前状态|总量|口径|谁拉动|解读|注"
pat = re.compile(r"^\s*(?:" + labels + r")\s*[：:]\s*")
removed = 0; semis = 0
for para in doc.paragraphs:
    t = para.text
    if not t.strip(): continue
    nt = pat.sub("", t, count=1)
    if nt != t: removed += 1
    n2 = nt.replace("；", "，")
    if n2 != nt: semis += (nt.count("；"))
    if n2 != t:
        para.text = n2
# tables: only trim label prefix in first cell, don't rewrite numeric separators
for table in doc.tables:
    for row in table.rows:
        for cell in row.cells:
            for para in cell.paragraphs:
                t = para.text
                nt = pat.sub("", t, count=1)
                if nt != t:
                    para.text = nt; removed += 1
out = val("out", p)
if os.path.abspath(out) != os.path.abspath(p):
    shutil.copyfile(p, out)
doc.save(out)
print(json.dumps({"ok": True, "out": out, "removedLabels": removed, "semicolons": semis}, ensure_ascii=False))
