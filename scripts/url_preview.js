#!/usr/bin/env node
"use strict";
/**
 * url_preview — 从 URL 抓取并预览，尝试提取字段/数值（不写证据）
 *   node scripts/url_preview.js --url ... --field "10Y国债,DXY"
 */
const https = require("https");
const http = require("http");
function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
function fetchBuf(url, redirect) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), lib = u.protocol === "http:" ? http : https;
    const req = lib.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { "user-agent": "Mozilla/5.0 AlphaDesk/1.0", accept: "*/*" } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirect > 0)
        return fetchBuf(new URL(res.headers.location, url).toString(), redirect - 1).then(resolve, reject);
      const chunks = []; res.on("data", d => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.setTimeout(30000, () => req.destroy(new Error("timeout")));
  });
}
function strip(html) {
  return String(html).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}
function tablesOf(html) {
  const out = [], re = /<table[\s\S]*?<\/table>/gi; let m;
  while ((m = re.exec(html))) {
    const rows = [], rr = /<tr[\s\S]*?<\/tr>/gi; let r;
    while ((r = rr.exec(m[0]))) {
      const cells = [], cr = /<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi; let c;
      while ((c = cr.exec(r[0]))) cells.push(strip(c[2]));
      if (cells.some(Boolean)) rows.push(cells);
    }
    if (rows.length) out.push(rows);
  }
  return out.slice(0, 12);
}
function candidatesFromRows(rows, fields) {
  const out = [];
  const fs = fields.map(x => String(x).toLowerCase());
  rows.forEach((row, ri) => {
    const line = row.join(" ");
    fs.forEach(f => {
      if (f && line.toLowerCase().indexOf(f) >= 0) {
        const nums = row.map(c => String(c).trim())
          .filter(c => /^-?\d+(?:\.\d+)?%?$/.test(c))
          .map(c => c.replace(/%$/, ""));
        if (nums.length) out.push({ tableRow: ri, field: f, cells: row, value: nums.slice(0, 4).join(" / ") });
      }
    });
  });
  return out.slice(0, 20);
}
(async () => {
  const url = arg("url", ""); if (!url) { console.error("need --url"); process.exit(2); }
  const fields = String(arg("field", "") || "").split(",").map(s => s.trim()).filter(Boolean);
  const r = await fetchBuf(url, 3);
  const ct = String(r.headers["content-type"] || "").toLowerCase();
  const buf = r.body;
  let kind = "text", text = "", tables = [], candidates = [];
  if (ct.indexOf("json") >= 0) {
    kind = "json"; text = JSON.stringify(JSON.parse(buf.toString("utf8")), null, 2);
    const lines = [];
    (function walk(o, path) {
      if (o && typeof o === "object") Object.keys(o).forEach(k => walk(o[k], path ? path + "." + k : k));
      else if (o != null) lines.push(path + " = " + o);
    })(JSON.parse(buf.toString("utf8")), "");
    text = lines.join("\n").slice(0, 4000);
  } else if (ct.indexOf("csv") >= 0 || /\.csv($|\?)/i.test(url)) {
    kind = "csv"; text = buf.toString("utf8").slice(0, 4000);
    const rows = text.split(/\r?\n/).filter(Boolean).map(l => l.split(","));
    candidates = candidatesFromRows(rows, fields);
  } else if (ct.indexOf("html") >= 0 || ct.indexOf("xml") >= 0) {
    kind = "html"; const html = buf.toString("utf8");
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    text = (title ? title + "\n\n" : "") + strip(html).slice(0, 5000);
    tables = tablesOf(html);
    candidates = candidatesFromRows(tables.flat(), fields);
  } else if (ct.indexOf("pdf") >= 0 || /\.pdf($|\?)/i.test(url)) {
    kind = "pdf"; text = "PDF 已识别；请在确认入库时用 collect pdf 提取文本/表格。";
  } else {
    text = buf.toString("utf8").slice(0, 5000);
  }
  console.log(JSON.stringify({ ok: true, url, status: r.status, contentType: ct, kind, text,
    tables: tables.map((t, i) => ({ index: i, rows: t.slice(0, 20) })),
    candidates }, null, 2));
})().catch(e => { console.error(JSON.stringify({ ok: false, error: String(e && e.message || e) })); process.exit(1); });
