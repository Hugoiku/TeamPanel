#!/usr/bin/env python3
"""web_table.py <url> [--grep keyword] — 把网页中的 HTML 表格转成行文本/JSON"""
import sys, json, urllib.request
from html.parser import HTMLParser
url = sys.argv[1]
grep = ""
if "--grep" in sys.argv: grep = sys.argv[sys.argv.index("--grep") + 1]
class P(HTMLParser):
    def __init__(self):
        super().__init__(); self.tables=[]; self.cur=None; self.row=None; self.cell=None
    def handle_starttag(self, tag, attrs):
        if tag=="table": self.cur=[]; self.tables.append(self.cur)
        elif tag=="tr" and self.cur is not None: self.row=[]
        elif tag in ("td","th") and self.row is not None: self.cell=[]
    def handle_data(self, data):
        if self.cell is not None: self.cell.append(data)
    def handle_endtag(self, tag):
        if tag in ("td","th") and self.cell is not None:
            self.row.append(" ".join("".join(self.cell).split())); self.cell=None
        elif tag=="tr" and self.row is not None:
            if any(x for x in self.row): self.cur.append(self.row)
            self.row=None
        elif tag=="table": self.cur=None
try:
    req=urllib.request.Request(url, headers={"user-agent":"Mozilla/5.0"})
    html=urllib.request.urlopen(req, timeout=30).read().decode("utf-8","ignore")
    p=P(); p.feed(html)
    tables=[]
    for i,t in enumerate(p.tables):
        rows=[r for r in t if not grep or any(grep in c for c in r)]
        if rows: tables.append({"index":i,"rows":rows[:200]})
    print(json.dumps({"ok":True,"url":url,"grep":grep,"tables":tables}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"ok":False,"error":str(e)[:300]}, ensure_ascii=False)); sys.exit(1)
