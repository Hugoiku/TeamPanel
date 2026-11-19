#!/usr/bin/env python3
"""
web_agent.py — 通用网页数据解析 Agent（浏览器 + 模型工具调用）

用法：
  python3 scripts/web_agent.py --url <URL> --goal "统计信息里 银行业总资产 月度" --out runtime/cache/web-agent.json

模型通过工具自主决定：看页面、点 tab、跟链接、读 XHR、下载 XLS/PDF、OCR 图片。
"""
import argparse, json, os, re, subprocess, sys, tempfile, time
from urllib.parse import urljoin

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = os.path.join(ROOT, "runtime/py")


def read_key():
    if os.environ.get("OPENCODE_GO_API_KEY"):
        return os.environ["OPENCODE_GO_API_KEY"]
    try:
        s = open(os.path.expanduser("~/.dsh/.credentials.yaml"), encoding="utf-8").read()
        m = re.search(r"OPENCODE_GO_API_KEY:\s*(\S+)", s)
        return m.group(1) if m else ""
    except Exception:
        return ""


def parse_xls(path):
    try:
        import xlrd
        book = xlrd.open_workbook(path)
        out = []
        for sh in book.sheets():
            out.append("## sheet: " + sh.name)
            for i in range(min(sh.nrows, 200)):
                vals = [str(sh.cell_value(i, j)) for j in range(min(sh.ncols, 40))]
                if any(v.strip() for v in vals):
                    out.append(",".join(vals))
        return "\n".join(out)
    except Exception as e:
        return "[xls parse error] " + str(e)


def parse_xlsx(path):
    try:
        import openpyxl
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        out = []
        for ws in wb.worksheets:
            out.append("## sheet: " + ws.title)
            for row in ws.iter_rows(values_only=True):
                vals = ["" if c is None else str(c) for c in row]
                if any(v.strip() for v in vals):
                    out.append(",".join(vals))
        return "\n".join(out)
    except Exception as e:
        return "[xlsx parse error] " + str(e)


def parse_pdf(path):
    try:
        from pypdf import PdfReader
        r = PdfReader(path)
        return "\n".join((p.extract_text() or "") for p in r.pages[:20])
    except Exception as e:
        return "[pdf parse error] " + str(e)


def ocr_file(path):
    tess = os.environ.get("TESSERACT", "tesseract")
    tessdata = os.path.join(ROOT, "runtime/tessdata")
    langs = "chi_sim+eng" if os.path.exists(os.path.join(tessdata, "chi_sim.traineddata")) else "eng"
    try:
        r = subprocess.run([tess, path, "stdout", "-l", langs, "--tessdata-dir", tessdata, "--psm", "6"],
                           capture_output=True, text=True, timeout=120)
        return r.stdout if r.returncode == 0 else "[ocr error] " + (r.stderr or "")[-300:]
    except Exception as e:
        return "[ocr error] " + str(e)


def find_chrome():
    import glob
    cands = []
    if os.environ.get("CHROME_PATH"): cands.append(os.environ["CHROME_PATH"])
    if os.environ.get("SCRAPLING_EXECUTABLE_PATH"): cands.append(os.environ["SCRAPLING_EXECUTABLE_PATH"])
    roots = [os.path.join(ROOT, "runtime/py/browsers"), os.path.expanduser("~/Library/Caches/ms-playwright")]
    if os.environ.get("LOCALAPPDATA"): roots.append(os.path.join(os.environ["LOCALAPPDATA"], "ms-playwright"))
    for root in roots:
        for d in sorted(glob.glob(os.path.join(root, "chromium-*")), reverse=True):
            for plat in ["chrome-mac-arm64", "chrome-mac", "chrome-win", "chrome-linux"]:
                for p in [os.path.join(d, plat, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
                          os.path.join(d, plat, "chrome")]:
                    if os.path.exists(p): cands.append(p)
    for p in ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              "/Applications/Chromium.app/Contents/MacOS/Chromium"]:
        if os.path.exists(p): cands.append(p)
    return cands[0] if cands else ""


class WebAgent:
    def __init__(self, url, goal, max_steps=8):
        self.url = url
        self.goal = goal
        self.max_steps = max_steps
        self.captures = []
        self.trace = []
        self.pw = None
        self.browser = None
        self.page = None

    def start(self):
        from patchright.sync_api import sync_playwright
        self.pw = sync_playwright().start()
        chrome = find_chrome()
        self.browser = self.pw.chromium.launch(headless=True, executable_path=chrome) if chrome else self.pw.chromium.launch(headless=True)
        self.page = self.browser.new_page(viewport={"width": 1440, "height": 1000})
        self.page.on("response", self._on_response)
        self.page.goto(self.url, wait_until="domcontentloaded", timeout=60000)
        self.page.wait_for_timeout(3000)

    def _on_response(self, resp):
        try:
            ct = (resp.headers.get("content-type") or "").lower()
            if "json" in ct and resp.request.resource_type in ("xhr", "fetch"):
                self.captures.append({"url": resp.url, "status": resp.status,
                                      "body": resp.text()[:6000]})
                if len(self.captures) > 40:
                    self.captures = self.captures[-40:]
        except Exception:
            pass

    def snapshot(self):
        p = self.page
        data = {"url": p.url, "title": p.title()}
        try:
            data["text"] = p.inner_text("body")[:12000]
        except Exception:
            data["text"] = ""
        try:
            data["links"] = p.eval_on_selector_all("a",
                "els => els.map(e => ({text:(e.innerText||'').trim().slice(0,100), href:e.href}))"
                ".filter(x => x.text && x.href).slice(0, 250)")
        except Exception:
            data["links"] = []
        try:
            data["attachments"] = p.eval_on_selector_all("a[href]",
                "els => els.map(e => ({text:(e.innerText||'').trim().slice(0,120), href:e.href}))"
                ".filter(x => /\\.(xls|xlsx|csv|pdf)(?:$|[?#])/i.test(x.href)).slice(0, 50)")
        except Exception:
            data["attachments"] = []
        try:
            data["buttons"] = p.eval_on_selector_all("button,[role=tab],.tab,.nav-item",
                "els => els.map(e => ({text:(e.innerText||'').trim().slice(0,60)}))"
                ".filter(x => x.text).slice(0, 50)")
        except Exception:
            data["buttons"] = []
        try:
            data["tables"] = p.eval_on_selector_all("table", """els => els.map(t => {
              const rows = Array.from(t.querySelectorAll('tr')).slice(0, 30).map(r =>
                Array.from(r.querySelectorAll('th,td')).map(c => (c.innerText||'').trim().slice(0,120)));
              return rows;
            }).filter(r => r.length).slice(0, 8)""")
        except Exception:
            data["tables"] = []
        return data

    def open_url(self, url):
        try:
            self.page.goto(url, wait_until="domcontentloaded", timeout=60000)
            self.page.wait_for_timeout(2000)
            return {"ok": True, "url": self.page.url, "title": self.page.title()}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def click(self, text):
        p = self.page
        try:
            p.get_by_text(text, exact=False).first.click(timeout=5000)
        except Exception:
            try:
                p.locator("text=" + text).first.click(timeout=5000)
            except Exception:
                try:
                    p.get_by_role("link", name=text, exact=False).first.click(timeout=5000)
                except Exception as e:
                    return {"ok": False, "error": str(e)}
        p.wait_for_timeout(1800)
        return {"ok": True, "url": p.url, "title": p.title()}

    def network(self):
        out = list(self.captures)
        self.captures = []
        return {"count": len(out), "items": out[-20:]}

    def download(self, url):
        try:
            # 用页面上下文请求，带上 cookie/referer，政府站点附件更稳。
            r = self.page.request.get(url, timeout=60000)
            body = r.body()
            ext = (url.split("?")[0].split(".")[-1] or "").lower()
            fd, path = tempfile.mkstemp(suffix="." + ext if ext else "")
            os.close(fd)
            open(path, "wb").write(body)
            if ext == "xls":
                text = parse_xls(path)
            elif ext == "xlsx":
                text = parse_xlsx(path)
            elif ext == "pdf":
                text = parse_pdf(path)
            else:
                text = body.decode("utf-8", "ignore")
            return {"ok": True, "url": url, "chars": len(text), "text": text[:20000]}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def paginate(self, max_pages=5, filter_text=""):
        max_pages = max(1, min(30, int(max_pages or 5)))
        filter_text = str(filter_text or "")
        items, seen, pages = [], set(), []
        for i in range(max_pages):
            data = self.snapshot()
            for l in data.get("links", []):
                href = l.get("href") or ""
                text = l.get("text") or ""
                if not re.search(r"(ItemDetail|docId=|\.xls|\.xlsx|\.csv|\.pdf)", href, re.I):
                    continue
                if filter_text and (filter_text not in href and filter_text not in text):
                    continue
                if href not in seen:
                    seen.add(href)
                    items.append({"text": text, "url": href})
            pages.append({"page": i + 1, "url": data.get("url"), "title": data.get("title"),
                          "items": len(items)})
            if i == max_pages - 1:
                break
            clicked = False
            for label in ["下一页", "下页", "Next", "next"]:
                try:
                    self.page.get_by_text(label, exact=False).first.click(timeout=3000)
                    clicked = True
                    break
                except Exception:
                    pass
            if not clicked:
                try:
                    self.page.get_by_text(str(i + 2), exact=True).first.click(timeout=2000)
                    clicked = True
                except Exception:
                    pass
            if not clicked:
                break
            self.page.wait_for_timeout(1600)
        return {"pages": pages, "items": items, "count": len(items)}

    def extract(self):
        data = self.snapshot()
        out = {"url": data.get("url"), "title": data.get("title"),
               "tables": data.get("tables") or [], "attachments": [], "network": self.network()}
        for a in (data.get("attachments") or [])[:5]:
            href = a.get("href") or ""
            if not href:
                continue
            r = self.download(href)
            out["attachments"].append({"text": a.get("text") or "", "url": href,
                                       "ok": r.get("ok"), "chars": r.get("chars", 0),
                                       "text": r.get("text", "")[:20000]})
        return out

    def ocr(self, selector=""):
        p = self.page
        try:
            fd, path = tempfile.mkstemp(suffix=".png")
            os.close(fd)
            if selector:
                p.locator(selector).first.screenshot(path=path)
            else:
                p.screenshot(path=path, full_page=False)
            return {"ok": True, "text": ocr_file(path)[:12000]}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def close(self):
        try: self.browser.close()
        except Exception: pass
        try: self.pw.stop()
        except Exception: pass


TOOLS = [
    {"type": "function", "function": {"name": "open", "description": "直接打开一个 URL（从 links/attachments 里拿到的链接）",
        "parameters": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}}},
    {"type": "function", "function": {"name": "snapshot", "description": "查看当前页面的文本、链接、按钮、表格、附件",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {"name": "click", "description": "点击按钮/tab/链接（按可见文字）",
        "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}},
    {"type": "function", "function": {"name": "network", "description": "读取页面加载/点击后产生的 JSON XHR 响应",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {"name": "paginate", "description": "列表页分页：自动点下一页，收集详情/附件链接（最多 maxPages 页）",
        "parameters": {"type": "object", "properties": {"maxPages": {"type": "number"}, "filter": {"type": "string"}}}}},
    {"type": "function", "function": {"name": "extract", "description": "自动提取当前页表格、XLS/PDF 附件和 XHR JSON；详情页优先用它",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {"name": "download", "description": "下载 XLS/XLSX/CSV/PDF 附件并解析成文本",
        "parameters": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}}},
    {"type": "function", "function": {"name": "ocr", "description": "对当前页面或指定元素截图并 OCR（仅图片数据兜底）",
        "parameters": {"type": "object", "properties": {"selector": {"type": "string"}}}}},
    {"type": "function", "function": {"name": "finish", "description": "完成提取，返回结构化记录",
        "parameters": {"type": "object", "properties": {
            "records": {"type": "array", "items": {"type": "object"}},
            "notes": {"type": "string"},
            "needsReview": {"type": "boolean"}
        }, "required": ["records"]}}}
]


def read_previous(path):
    if not path:
        return ""
    try:
        j = json.load(open(path, encoding="utf-8"))
        r = j.get("result") or {}
        recs = r.get("records") or []
        return json.dumps({"notes": r.get("notes", ""), "records": recs[:8]}, ensure_ascii=False)[:6000]
    except Exception:
        return ""


def verify_records(records, needs_review=False):
    required = ["name", "value", "period", "unit", "sourceUrl"]
    missing, low = [], []
    for i, r in enumerate(records or []):
        for k in required:
            if r.get(k) in (None, "", []):
                missing.append("records[%d].%s" % (i, k))
        try:
            if float(r.get("confidence", 0)) < 0.8:
                low.append(i)
        except Exception:
            low.append(i)
    status = "needs_confirmation" if (missing or low or needs_review or not records) else "ready"
    return {"status": status, "total": len(records or []), "missingFields": missing[:20],
            "lowConfidence": low[:20], "needsHumanConfirm": status != "ready"}


def call_model(base_url, key, model, headers, messages):
    import requests
    r = requests.post(base_url.rstrip("/") + "/chat/completions",
        headers=dict({"content-type": "application/json", "authorization": "Bearer " + key}, **headers),
        json={"model": model, "messages": messages, "tools": TOOLS, "tool_choice": "auto", "temperature": 0.1},
        timeout=180)
    if r.status_code >= 300:
        raise RuntimeError("model HTTP " + str(r.status_code) + ": " + r.text[:500])
    return r.json()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--goal", required=True)
    ap.add_argument("--out", default="")
    ap.add_argument("--max-steps", type=int, default=10)
    ap.add_argument("--max-pages", type=int, default=5)
    ap.add_argument("--feedback", default="", help="用户对上一轮结果的纠正/补充，用于多轮重试")
    ap.add_argument("--previous", default="", help="上一轮 web-agent 结果 JSON 路径")
    ap.add_argument("--base-url", default=os.environ.get("AGENT_OPENAI_BASE_URL", "https://opencode.ai/zen/go/v1"))
    ap.add_argument("--model", default=os.environ.get("AGENT_OPENAI_MODEL", "deepseek-v4.1-flash"))
    ap.add_argument("--key", default="")
    ap.add_argument("--header", action="append", default=[])
    args = ap.parse_args()
    key = args.key or os.environ.get("AGENT_OPENAI_KEY") or read_key()
    if not key:
        print(json.dumps({"ok": False, "error": "缺少模型 Key（OPENCODE_GO_API_KEY / AGENT_OPENAI_KEY）"}, ensure_ascii=False))
        return 2
    headers = {}
    try:
        headers.update(json.loads(os.environ.get("AGENT_OPENAI_HEADERS", "{}")))
    except Exception:
        pass
    headers.setdefault("x-opencode-session", "alphadesk-web-agent")
    for h in args.header:
        if ":" in h:
            k, v = h.split(":", 1); headers[k.strip()] = v.strip()
    agent = WebAgent(args.url, args.goal, args.max_steps)
    trace = []
    try:
        agent.start()
        messages = [
            {"role": "system", "content": "你是网页数据解析 Agent。用工具自主浏览页面、点 tab、跟链接、读 XHR、下载 XLS/PDF；优先结构化数据，图片 OCR 只作兜底并标记 needsReview。不要编造数字。优先从 snapshot 的 links 找统计/数据列表里的文档标题，进入详情页后先调用 extract 自动下载 .xls/.pdf 附件；不要优先点图表 tab，也不要猜附件 URL。JSON XHR 用 network 读，不要 open JSON URL。列表页有分页时先调用 paginate（按目标时间范围/页数上限；filter 可传 itemId=954 或目标关键词），再用 open + extract 处理详情页。最后调用 finish，records 里每条包含 name/value/period/unit/sourceUrl/confidence。"},
            {"role": "user", "content": "网址：" + args.url + "\n目标板块/数据：" + args.goal +
             "\n如果列表有分页，最多翻 " + str(max(1, min(30, args.max_pages))) + " 页；优先按目标时间范围停止。" +
             ("\n用户对上一轮的纠正/补充：" + args.feedback if args.feedback else "") +
             ("\n上一轮结果：" + read_previous(args.previous) if args.previous else "")}
        ]
        final = None
        for step in range(args.max_steps):
            j = call_model(args.base_url, key, args.model, headers, messages)
            msg = (j.get("choices") or [{}])[0].get("message") or {}
            calls = msg.get("tool_calls") or []
            if not calls:
                content = msg.get("content") or ""
                try:
                    final = json.loads(re.search(r"\{[\s\S]*\}", content).group(0))
                except Exception:
                    final = {"records": [], "notes": content[:1000]}
                break
            messages.append({"role": "assistant", "content": msg.get("content") or None, "tool_calls": calls})
            for tc in calls:
                fn = (tc.get("function") or {}).get("name") or ""
                try: a = json.loads((tc.get("function") or {}).get("arguments") or "{}")
                except Exception: a = {}
                if fn == "open": res = agent.open_url(a.get("url", ""))
                elif fn == "paginate": res = agent.paginate(a.get("maxPages", 5), a.get("filter", ""))
                elif fn == "extract": res = agent.extract()
                elif fn == "snapshot": res = agent.snapshot()
                elif fn == "click": res = agent.click(a.get("text", ""))
                elif fn == "network": res = agent.network()
                elif fn == "download": res = agent.download(a.get("url", ""))
                elif fn == "ocr": res = agent.ocr(a.get("selector", ""))
                elif fn == "finish": res = {"ok": True}; final = a
                else: res = {"ok": False, "error": "unknown tool " + fn}
                trace.append({"step": step + 1, "tool": fn, "args": a,
                              "result": str(res)[:1500]})
                messages.append({"role": "tool", "tool_call_id": tc.get("id", ""),
                                 "content": json.dumps(res, ensure_ascii=False)[:12000]})
                if final is not None:
                    break
            if final is not None:
                break
        result = final or {"records": [], "notes": "max steps reached"}
        verification = verify_records(result.get("records") or [], bool(result.get("needsReview")))
        out = {"ok": final is not None, "url": args.url, "goal": args.goal,
               "status": verification["status"], "verification": verification,
               "result": result, "trace": trace,
               "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S")}
    except Exception as e:
        out = {"ok": False, "url": args.url, "goal": args.goal, "error": str(e), "trace": trace}
    finally:
        agent.close()
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        open(args.out, "w", encoding="utf-8").write(json.dumps(out, ensure_ascii=False, indent=2))
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
