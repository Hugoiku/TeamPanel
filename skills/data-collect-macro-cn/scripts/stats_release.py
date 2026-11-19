#!/usr/bin/env python3
"""stats_release.py — 从发布列表找最新含关键词的文章并解析 HTML 表格
用法: stats_release.py --list URL --keyword 房地产 --max 1
"""
import sys, re, json, urllib.request
from html.parser import HTMLParser
from urllib.parse import urljoin
args = sys.argv[1:]
def val(name, default=""):
    return args[args.index("--" + name) + 1] if "--" + name in args else default
list_url = val("list")
keyword = val("keyword")
if not list_url or not keyword:
    print(json.dumps({"ok": False, "error": "需要 --list 和 --keyword"})); sys.exit(2)
def fetch(url):
    req = urllib.request.Request(url, headers={"user-agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "ignore")
class Links(HTMLParser):
    def __init__(self): super().__init__(); self.links=[]
    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.cur = dict(attrs).get("href", "")
    def handle_data(self, data):
        if getattr(self, "cur", ""):
            self.links.append((self.cur, data.strip())); self.cur = ""
pages = int(val("pages", "5"))
all_cands = []
for pg in range(0, max(1, pages)):
    page_url = list_url if pg == 0 else urljoin(list_url, "index_%d.html" % pg)
    try:
        p = Links(); p.feed(fetch(page_url))
    except Exception:
        break
    found = [(urljoin(page_url, h), t) for h, t in p.links
             if keyword in t and h and not h.startswith(("javascript:", "mailto:", "#"))]
    all_cands.extend(found)
    if found:
        break
cands = all_cands
if not cands:
    print(json.dumps({"ok": False, "error": "列表里没找到关键词：" + keyword}, ensure_ascii=False)); sys.exit(3)
url, title = cands[0]
html = fetch(url)
class Text(HTMLParser):
    def __init__(self): super().__init__(); self.parts=[]
    def handle_data(self, data): self.parts.append(data)
html_text = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", html, flags=re.I)
tx = Text(); tx.feed(html_text)
body_text = " ".join(" ".join(tx.parts).split())[:6000]

class Tables(HTMLParser):
    def __init__(self): super().__init__(); self.tables=[]; self.cur=None; self.row=None; self.cell=None
    def handle_starttag(self, tag, attrs):
        if tag == "table": self.cur=[]; self.tables.append(self.cur)
        elif tag == "tr" and self.cur is not None: self.row=[]
        elif tag in ("td","th") and self.row is not None: self.cell=[]
    def handle_data(self, data):
        if self.cell is not None: self.cell.append(data)
    def handle_endtag(self, tag):
        if tag in ("td","th") and self.cell is not None:
            self.row.append(" ".join("".join(self.cell).split())); self.cell=None
        elif tag == "tr" and self.row is not None:
            if any(self.row): self.cur.append(self.row)
            self.row=None
        elif tag == "table": self.cur=None
t = Tables(); t.feed(html)
tables = [{"index": i, "rows": rows[:120]} for i, rows in enumerate(t.tables) if rows]
print(json.dumps({"ok": True, "list": list_url, "keyword": keyword, "url": url, "title": title,
                  "text": body_text, "tables": tables}, ensure_ascii=False))
