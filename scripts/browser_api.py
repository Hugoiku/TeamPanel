#!/usr/bin/env python3
"""browser_api.py <url> <outdir> [--wait ms] [--executable chrome] — 捕获 JS 页面的 XHR/JSON 响应"""
import sys, os, json
url = sys.argv[1]
outdir = sys.argv[2]
wait = 5000
chrome = None
args = sys.argv[3:]
if "--wait" in args: wait = int(args[args.index("--wait") + 1])
if "--executable" in args: chrome = args[args.index("--executable") + 1]
os.makedirs(outdir, exist_ok=True)
from patchright.sync_api import sync_playwright
captures = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=chrome, headless=True) if chrome else p.chromium.launch(headless=True)
    page = browser.new_page()
    def on_response(resp):
        try:
            ct = (resp.headers.get("content-type") or "").lower()
            if "json" in ct and resp.request.resource_type in ("xhr", "fetch"):
                body = resp.text()
                captures.append({"url": resp.url, "status": resp.status, "body": body[:200000]})
        except Exception:
            pass
    page.on("response", on_response)
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(wait)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e), "captures": captures}))
        browser.close(); sys.exit(1)
    browser.close()
index = []
for i, c in enumerate(captures):
    fn = os.path.join(outdir, "xhr-%03d.json" % (i + 1))
    try:
        parsed = json.loads(c["body"])
        open(fn, "w", encoding="utf-8").write(json.dumps(parsed, ensure_ascii=False, indent=2))
    except Exception:
        open(fn, "w", encoding="utf-8").write(c["body"])
    index.append({"file": os.path.basename(fn), "url": c["url"], "status": c["status"]})
open(os.path.join(outdir, "index.json"), "w", encoding="utf-8").write(json.dumps(index, ensure_ascii=False, indent=2))
print(json.dumps({"ok": True, "count": len(index), "index": index}, ensure_ascii=False))
