#!/usr/bin/env python3
"""chinabond.py — 抓取中债国债收益率曲线当前 10Y（浏览器会话）"""
import json, re, sys
from patchright.sync_api import sync_playwright
chrome = sys.argv[1] if len(sys.argv) > 1 else None
out = {"ok": False, "source": "chinabond", "indicator": "中国10年期国债到期收益率"}
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=chrome, headless=True) if chrome else p.chromium.launch(headless=True)
        pg = b.new_page()
        detail = []
        pg.on("response", lambda r: detail.append(r.text()) if "ycDetail" in r.url else None)
        pg.goto("https://yield.chinabond.com.cn/cbweb-mn/yield_main", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(5000)
        html = detail[0] if detail else pg.content()
        m = re.search(r"10\.0y</td>\s*<td>([0-9.]+)</td>", html)
        if not m:
            m = re.search(r"10(?:\.0)?y[^0-9]{0,80}([0-9]+\.[0-9]+)", html)
        if m:
            out.update({"ok": True, "value": float(m.group(1)), "unit": "%",
                        "tenor": "10Y", "url": pg.url})
        else:
            out["error"] = "10Y 未解析到"
        b.close()
except Exception as e:
    out["error"] = str(e)[:300]
print(json.dumps(out, ensure_ascii=False))
