#!/usr/bin/env node
"use strict";
/**
 * vol — 用东方财富日 K 计算指数已实现波动率
 *   node scripts/vol.js --code 000300 --window 20 --days 60
 * 输出 JSON：最新收盘、20 日年化已实现波动率、历史序列
 */
const https = require("https");
function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
function fetchJson(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { "user-agent": "Mozilla/5.0" } }, r => { let s = ""; r.on("data", d => s += d); r.on("end", () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on("error", rej);
  });
}
(async () => {
  const code = String(arg("code", "000300")).replace(/^sh|^sz/i, "");
  const window = Math.max(2, parseInt(arg("window", "20"), 10) || 20);
  const days = Math.max(window + 5, parseInt(arg("days", "90"), 10) || 90);
  const secid = arg("secid", "") || (code === "000300" ? "1.000300" :
    (code.startsWith("399") ? "0." : (code.startsWith("0") ? "0." : "1.")) + code);
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, "");
  const end = new Date(), beg = new Date(Date.now() - days * 2 * 86400000);
  const url = "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=" + secid +
    "&fields1=f1,f2,f3&fields2=f51,f53&klt=101&fqt=0&beg=" + fmt(beg) + "&end=" + fmt(end);
  const j = await fetchJson(url);
  const rows = (j.data && j.data.klines) || [];
  const closes = rows.map(x => { const p = x.split(","); return { date: p[0], close: Number(p[1]) }; })
    .filter(x => isFinite(x.close));
  if (closes.length < window + 1) { console.error("数据不足"); process.exit(2); }
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i].close / closes[i - 1].close));
  const sample = rets.slice(-window);
  const mean = sample.reduce((s, x) => s + x, 0) / sample.length;
  const variance = sample.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (sample.length - 1);
  const vol = Math.sqrt(variance) * Math.sqrt(252) * 100;
  console.log(JSON.stringify({ ok: true, code, name: j.data && j.data.name, window,
    latest: closes[closes.length - 1], vol20dAnnualized: Number(vol.toFixed(2)),
    series: closes.slice(-window) }, null, 2));
})().catch(e => { console.error(String(e && e.message || e)); process.exit(1); });
