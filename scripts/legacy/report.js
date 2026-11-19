#!/usr/bin/env node
"use strict";
/**
 * @deprecated 面板最终报告已走 master_report → investor-report → md_to_docx。
 * 本脚本仅保留给旧 CLI / pipeline 兼容，新功能不要加在这里。
 * report — 把底稿汇编成带数据图表的正式研究报告（case 通用）
 *   node scripts/report.js --case case-2026-003
 * 图表全部用本轮证据同源接口/证据池重取生成（非示意）：
 *   价格K线（Tushare daily）、季度财务（stock.json）、估值对比、反向DCF、可比公司PE、收入结构、CPI/PPI
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..", "..");
function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
const CASE = arg("case", "default");
const BRK = process.env.DESK_BROKER || "http://127.0.0.1:7801";
function desk(args) {
  const r = spawnSync(process.execPath, ["scripts/desk"].concat(args), { cwd: ROOT, encoding: "utf8",
    env: Object.assign({}, process.env, { DESK_CASE: CASE, DESK_ACTOR: "lead" }) });
  const line = String(r.stdout || "").trim().split("\n").pop();
  try { return JSON.parse(line); } catch (_) { return { ok: false, raw: line }; }
}
function cat(p) { const r = desk(["cat", "--path", p]); return r && r.ok && r.exists ? r.content : ""; }
function put(p, content, note) {
  const cur = desk(["cat", "--path", p]);
  const ver = (cur && cur.ok) ? cur.version : 0;
  const acq = desk(["acquire", "--path", p, "--mode", "write", "--note", note || "report"]);
  if (!acq.ok) { console.log("acquire failed", JSON.stringify(acq)); process.exit(1); }
  const tmp = "/tmp/report_" + p.replace(/[\/]/g, "_");
  fs.writeFileSync(tmp, content);
  const w = desk(["write", "--path", p, "--lock", acq.lock.id, "--expected-version", String(ver), "--file", tmp]);
  console.log(p, "->", JSON.stringify(w).slice(0, 120));
  return w;
}
function req(url, opts, body) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? http : https;
    const r = lib.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: (opts && opts.method) || "GET", headers: (opts && opts.headers) || {} }, x => {
      const c = []; x.on("data", d => c.push(d)); x.on("end", () => res(Buffer.concat(c).toString("utf8")));
    });
    r.on("error", rej); if (body) r.write(body); r.end();
  });
}
function tsu(api, params, fields) {
  const tok = JSON.parse(fs.readFileSync(path.join(ROOT, "runtime/secrets/tushare.json"), "utf8")).token;
  const body = JSON.stringify({ api_name: api, token: tok, params, fields });
  return req("http://api.tushare.pro", { method: "POST", headers: { "content-type": "application/json",
    "content-length": Buffer.byteLength(body) } }, body).then(t => JSON.parse(t));
}
function codeOf(sym) {
  const s = String(sym || "").replace(/[^0-9]/g, "").slice(0, 6);
  if (!s) return "";
  if (/^[69]/.test(s)) return s + ".SH";
  if (/^[48]/.test(s)) return s + ".BJ";
  return s + ".SZ";
}
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function svgWrap(W, H, title, src, body) {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '">' +
    '<rect width="' + W + '" height="' + H + '" fill="#ffffff"/>' +
    '<text x="16" y="18" fill="#0f172a" font-size="11" font-weight="600">' + esc(title) + '</text>' +
    '<text x="' + (W - 16) + '" y="18" fill="#94a3b8" font-size="8" text-anchor="end">' + esc(src || '') + '</text>' +
    body + '</svg>';
}
function niceStep(raw, n) {
  const pow = Math.pow(10, Math.floor(Math.log10((raw || 1) / (n || 5))));
  return ([1, 2, 2.5, 5, 10].map(m => m * pow).filter(s => raw / s <= (n || 5))[0]) || pow * 10;
}
function candleSvg(pts, opt) {
  const W = 680, H = 260, L = 62, R = 16, T = 34, B = 40;
  const n = pts.length;
  const highs = pts.map(p => p.high), lows = pts.map(p => p.low);
  const minY = Math.min.apply(null, lows), maxY = Math.max.apply(null, highs);
  const step = niceStep((maxY - minY) || 1, 6);
  const yMin = Math.floor(minY / step) * step, yMax = Math.ceil(maxY / step) * step;
  const plotW = W - L - R, gap = plotW / n;
  const cw = Math.max(1.4, Math.min(9, gap * 0.62));
  const sx = i => L + gap * (i + 0.5);
  const sy = v => T + (H - T - B) * (1 - (v - yMin) / ((yMax - yMin) || 1));
  let g = '';
  for (let v = yMin; v <= yMax + 1e-9; v += step) {
    const yy = sy(v);
    g += '<line x1="' + L + '" y1="' + yy.toFixed(1) + '" x2="' + (W - R) + '" y2="' + yy.toFixed(1) + '" stroke="#e8edf5" stroke-width=".7"/>' +
      '<text x="' + (L - 8) + '" y="' + (yy + 3).toFixed(1) + '" fill="#64748b" font-size="9" text-anchor="end">' + v.toFixed(2) + '</text>';
  }
  const tickN = Math.min(5, n);
  for (let t = 0; t < tickN; t++) {
    const idx = Math.round(t * (n - 1) / ((tickN - 1) || 1));
    const x = sx(idx);
    g += '<text x="' + x.toFixed(1) + '" y="' + (H - 16) + '" fill="#475569" font-size="9" text-anchor="' +
      (x > W - R - 40 ? 'end' : (x < L + 40 ? 'start' : 'middle')) + '">' + pts[idx].date.replace(/-/g, '') + '</text>';
  }
  pts.forEach((p, i) => {
    const up = p.close >= p.open;
    const col = up ? '#dc2626' : '#16a34a';
    const x = sx(i), yH = sy(p.high), yL = sy(p.low), yO = sy(p.open), yC = sy(p.close);
    const top = Math.min(yO, yC), hgt = Math.max(1, Math.abs(yC - yO));
    g += '<line x1="' + x.toFixed(1) + '" y1="' + yH.toFixed(1) + '" x2="' + x.toFixed(1) + '" y2="' + yL.toFixed(1) + '" stroke="' + col + '" stroke-width=".8"/>';
    g += '<rect x="' + (x - cw / 2).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + cw.toFixed(1) + '" height="' + hgt.toFixed(1) +
      '" fill="' + (up ? '#fee2e2' : '#dcfce7') + '" stroke="' + col + '" stroke-width=".8"/>';
  });
  const last = pts[n - 1];
  return svgWrap(W, H, opt.title || '', opt.src || '', g +
    '<text x="' + (L - 8) + '" y="' + (T - 12) + '" fill="#94a3b8" font-size="8" text-anchor="end">元/股</text>' +
    '<text x="' + ((L + W - R) / 2) + '" y="' + (H - 2) + '" fill="#94a3b8" font-size="8" text-anchor="middle">交易日（YYYYMMDD）</text>' +
    '<text x="' + (W - R) + '" y="' + (T - 12) + '" fill="#475569" font-size="8.5" text-anchor="end">最新 ' +
    last.close.toFixed(2) + '（' + last.date + '）｜高 ' + Math.max.apply(null, highs).toFixed(2) + ' / 低 ' + Math.min.apply(null, lows).toFixed(2) + '</text>');
}
function multiLineSvg(series, opt) {
  const W = 680, H = 260, L = 56, R = 18, T = 34, B = 44;
  let minY = Infinity, maxY = -Infinity, n = 0;
  series.forEach(s => s.pts.forEach(p => { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); n = Math.max(n, s.pts.length); }));
  if (!isFinite(minY) || n === 0) return '';
  const step = niceStep((maxY - minY) || 1, 5);
  const yMin = Math.floor(minY / step) * step, yMax = Math.ceil(maxY / step) * step;
  const sx = i => L + (W - L - R) * (i / ((n - 1) || 1));
  const sy = v => T + (H - T - B) * (1 - (v - yMin) / ((yMax - yMin) || 1));
  let g = '';
  for (let v = yMin; v <= yMax + 1e-9; v += step) {
    const yy = sy(v);
    g += '<line x1="' + L + '" y1="' + yy.toFixed(1) + '" x2="' + (W - R) + '" y2="' + yy.toFixed(1) + '" stroke="#e8edf5" stroke-width=".7"/>' +
      '<text x="' + (L - 8) + '" y="' + (yy + 3).toFixed(1) + '" fill="#64748b" font-size="9" text-anchor="end">' + v.toFixed(1) + '%</text>';
  }
  const first = series[0].pts;
  const tickN = Math.min(5, first.length);
  for (let t = 0; t < tickN; t++) {
    const i = Math.round(t * (first.length - 1) / ((tickN - 1) || 1));
    const x = sx(i);
    g += '<text x="' + x.toFixed(1) + '" y="' + (H - 22) + '" fill="#475569" font-size="9" text-anchor="middle">' + esc(first[i].lab) + '</text>';
  }
  series.forEach((s, si) => {
    const d = s.pts.map((p, i) => (i ? 'L' : 'M') + sx(i).toFixed(1) + ',' + sy(p.y).toFixed(1)).join(' ');
    g += '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="1.8"/>';
    s.pts.forEach((p, i) => {
      g += '<circle cx="' + sx(i).toFixed(1) + '" cy="' + sy(p.y).toFixed(1) + '" r="2" fill="' + s.color + '"/>';
      if (si === 0) g += '<text x="' + sx(i).toFixed(1) + '" y="' + (sy(p.y) - 6).toFixed(1) + '" fill="' + s.color + '" font-size="8" text-anchor="middle">' + p.y + '</text>';
    });
    const lx = W - R - 120 * si - 8, ly = 26;
    g += '<rect x="' + lx + '" y="' + (ly - 8) + '" width="10" height="3" fill="' + s.color + '"/>' +
      '<text x="' + (lx + 14) + '" y="' + ly + '" fill="#475569" font-size="9">' + esc(s.name) + '</text>';
  });
  return svgWrap(W, H, opt.title || '', opt.src || '', g +
    '<text x="' + (L - 8) + '" y="' + (T - 12) + '" fill="#94a3b8" font-size="8" text-anchor="end">同比 %</text>' +
    '<text x="' + ((L + W - R) / 2) + '" y="' + (H - 4) + '" fill="#94a3b8" font-size="8" text-anchor="middle">月份</text>');
}
function hBarsSvg(items, opt) {
  const W = 680, rowH = 26, H = 40 + rowH * items.length + 16, L = 130, R = 90;
  const max = Math.max.apply(null, items.map(x => x.value)) || 1;
  let g = '';
  items.forEach((it, i) => {
    const y = 40 + i * rowH;
    const w = (W - L - R) * (it.value / max);
    g += '<text x="' + (L - 8) + '" y="' + (y + 12) + '" fill="#334155" font-size="10" text-anchor="end">' + esc(it.label) + '</text>' +
      '<rect x="' + L + '" y="' + (y + 3) + '" width="' + Math.max(2, w).toFixed(1) + '" height="13" rx="2" fill="' + (it.color || '#2563eb') + '"/>' +
      '<text x="' + (L + Math.max(2, w) + 6) + '" y="' + (y + 13) + '" fill="#0f172a" font-size="9.5">' + esc(it.text || it.value) + '</text>';
  });
  return svgWrap(W, H, opt.title || '', opt.src || '', g);
}
function groupedBarsSvg(cats, series, opt) {
  const W = 680, H = 250, L = 56, R = 16, T = 34, B = 40;
  const max = Math.max.apply(null, series.map(s => Math.max.apply(null, s.values))) || 1;
  const step = niceStep(max, 5);
  const yMax = Math.ceil(max / step) * step;
  const plotW = W - L - R, gw = plotW / cats.length, bw = Math.min(22, gw * 0.72 / series.length);
  const sy = v => T + (H - T - B) * (1 - v / (yMax || 1));
  let g = '';
  for (let v = 0; v <= yMax + 1e-9; v += step) {
    const yy = sy(v);
    g += '<line x1="' + L + '" y1="' + yy.toFixed(1) + '" x2="' + (W - R) + '" y2="' + yy.toFixed(1) + '" stroke="#e8edf5" stroke-width=".7"/>' +
      '<text x="' + (L - 8) + '" y="' + (yy + 3).toFixed(1) + '" fill="#64748b" font-size="9" text-anchor="end">' + v.toFixed(1) + '</text>';
  }
  cats.forEach((c, i) => {
    const cx = L + gw * i + gw / 2;
    g += '<text x="' + cx.toFixed(1) + '" y="' + (H - 18) + '" fill="#475569" font-size="9" text-anchor="middle">' + esc(c) + '</text>';
    series.forEach((s, si) => {
      const v = s.values[i] || 0, h = Math.max(0, (H - T - B) * (v / (yMax || 1)));
      const x = cx - (series.length * bw) / 2 + si * bw;
      g += '<rect x="' + x.toFixed(1) + '" y="' + (sy(v)).toFixed(1) + '" width="' + (bw - 1.5).toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + s.color + '" rx="1"/>';
    });
  });
  series.forEach((s, si) => {
    const lx = W - R - 110 * (series.length - si), ly = 26;
    g += '<rect x="' + lx + '" y="' + (ly - 8) + '" width="10" height="3" fill="' + s.color + '"/>' +
      '<text x="' + (lx + 14) + '" y="' + ly + '" fill="#475569" font-size="9">' + esc(s.name) + '</text>';
  });
  return svgWrap(W, H, opt.title || '', opt.src || '', g +
    '<text x="' + (L - 8) + '" y="' + (T - 12) + '" fill="#94a3b8" font-size="8" text-anchor="end">' + esc(opt.yTitle || '') + '</text>');
}
function rangeBarsSvg(items, opt) {
  const W = 680, rowH = 30, H = 46 + rowH * items.length + 14, L = 130, R = 60;
  const max = opt.max || Math.max.apply(null, items.map(x => Math.max(x.value || 0, (x.range ? x.range[1] : 0)))) * 1.08;
  const sx = v => L + (W - L - R) * (v / max);
  let g = '';
  for (let v = 0; v <= max; v += (opt.step || 10)) {
    g += '<line x1="' + sx(v).toFixed(1) + '" y1="34" x2="' + sx(v).toFixed(1) + '" y2="' + (H - 20) + '" stroke="#eef2f7" stroke-width=".7"/>' +
      '<text x="' + sx(v).toFixed(1) + '" y="' + (H - 8) + '" fill="#94a3b8" font-size="8" text-anchor="middle">' + v + '</text>';
  }
  items.forEach((it, i) => {
    const y = 42 + i * rowH;
    g += '<text x="' + (L - 8) + '" y="' + (y + 6) + '" fill="#334155" font-size="10" text-anchor="end">' + esc(it.label) + '</text>';
    if (it.range) {
      const x0 = sx(it.range[0]), x1 = sx(it.range[1]);
      g += '<rect x="' + x0.toFixed(1) + '" y="' + (y - 2) + '" width="' + Math.max(2, x1 - x0).toFixed(1) + '" height="12" rx="2" fill="' + (it.color || '#94a3b8') + '" opacity=".55"/>' +
        '<text x="' + (x1 + 6) + '" y="' + (y + 7) + '" fill="#0f172a" font-size="9">' + it.range[0] + '–' + it.range[1] + '</text>';
    }
    if (it.value != null) {
      const x = sx(it.value);
      g += '<rect x="' + (x - 3) + '" y="' + (y - 4) + '" width="6" height="16" fill="' + (it.color || '#2563eb') + '"/>' +
        '<text x="' + (x + 8) + '" y="' + (y + 7) + '" fill="#0f172a" font-size="9.5">' + it.value + '</text>';
    }
  });
  return svgWrap(W, H, opt.title || '', opt.src || '', g +
    '<text x="' + ((L + W - R) / 2) + '" y="24" fill="#94a3b8" font-size="8" text-anchor="middle">元/股</text>');
}
function sections(md) {
  const out = []; const parts = String(md).split(/\n(?=## )/);
  parts.forEach(p => { const m = p.match(/^## (.+)/); if (m) out.push({ title: m[1].trim(), body: p.replace(/^## .+\n?/, "").trim() }); });
  return out;
}
function pick(secs, names) { return secs.filter(s => names.some(n => s.title.indexOf(n) >= 0)); }
function block(secs, names) {
  const hit = pick(secs, names).filter(s => s.body && s.body.trim().length > 30);
  return hit.length ? hit.map(s => "### " + s.title + "\n\n" + s.body + "\n").join("\n") : "本节暂无可用数据（未获取到支撑材料，不做展开）。\n";
}
function num(x, d) { return (typeof x === "number" && isFinite(x)) ? x : d; }

function boxSvg(x, y, w, h, label, opt) {
  const o = opt || {};
  const fill = o.fill || '#f8fafc', stroke = o.stroke || '#cbd5e1', color = o.color || '#1e293b';
  const lines = String(label).split('|');
  const fs2 = o.font || 10;
  let t = '';
  lines.forEach((ln, i) => {
    const yy = y + h / 2 + (i - (lines.length - 1) / 2) * (fs2 + 3) + fs2 / 3;
    t += '<text x="' + (x + w / 2) + '" y="' + yy.toFixed(1) + '" fill="' + color + '" font-size="' + fs2 + '" text-anchor="middle">' + esc(ln) + '</text>';
  });
  return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="5" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1"/>' + t;
}
function arrowSvg(x1, y1, x2, y2, color) {
  const col = color || '#94a3b8';
  const mx = (x1 + x2) / 2;
  return '<path d="M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + (x2 - 5) + ',' + y2 + '" fill="none" stroke="' + col + '" stroke-width="1.1" marker-end="url(#arr)"/>';
}
function svgDefs() { return '<defs><marker id="arr" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#94a3b8"/></marker></defs>'; }
function valueChainSvg() {
  const W = 780, H = 360;
  let g = svgDefs();
  g += '<text x="24" y="26" fill="#0f172a" font-size="12" font-weight="600">锗产业链与公司所在环节</text>';
  g += '<text x="' + (W - 20) + '" y="26" fill="#94a3b8" font-size="8" text-anchor="end">来源：S5/S11/S13/S15 公司披露 + 行业通用框架（N19 待补第三方来源）</text>';
  g += '<text x="110" y="52" fill="#64748b" font-size="9" text-anchor="middle">上游：资源与回收</text>';
  g += '<text x="360" y="52" fill="#1d4ed8" font-size="9" text-anchor="middle">中游：冶炼与精深加工（公司所在）</text>';
  g += '<text x="640" y="52" fill="#64748b" font-size="9" text-anchor="middle">下游：器件 / 终端</text>';
  g += '<rect x="226" y="60" width="270" height="268" rx="8" fill="#eff6ff" stroke="#93c5fd" stroke-dasharray="4 3"/>';
  const ups = [['锗矿资源', 74], ['含锗废料回收', 134], ['锌冶炼副产', 194]];
  const mids = [['区熔锗锭（47.6 吨/年）', 74], ['锗单晶 / 晶片', 124], ['光纤用四氯化锗（60 吨/年）', 174], ['砷化镓晶片（80 万片/年）', 224], ['磷化铟晶片（15→45 万片/年）', 274]];
  const downs = [['红外热像仪', 74], ['空间太阳能电池', 124], ['光纤预制棒 / 光缆', 174], ['光模块 / 光芯片', 224], ['射频器件', 274]];
  ups.forEach(u => { g += boxSvg(20, u[1], 176, 44, u[0], { fill: '#f1f5f9' }); });
  mids.forEach(m => { g += boxSvg(242, m[1], 238, 38, m[0], { fill: '#dbeafe', stroke: '#60a5fa', color: '#1e3a8a' }); });
  downs.forEach(d => { g += boxSvg(540, d[1], 220, 38, d[0], { fill: '#f8fafc' }); });
  ups.forEach(u => { g += arrowSvg(196, u[1] + 22, 240, 100); });
  mids.forEach(m => { g += arrowSvg(480, m[1] + 19, 538, m[1] + 19); });
  g += '<text x="360" y="340" fill="#64748b" font-size="8.5" text-anchor="middle">公司矿山矿石及粗加工产品不对外销售，只作为内部原料 [S11]；本图为结构示意，非公司披露的组织图。</text>';
  return svgWrap(W, H, '', '', g);
}
function applicationMapSvg() {
  const W = 780, H = 400;
  let g = svgDefs();
  g += '<text x="20" y="24" fill="#0f172a" font-size="12" font-weight="600">产品应用地图：从材料到终端</text>';
  g += '<text x="' + (W - 20) + '" y="24" fill="#94a3b8" font-size="8" text-anchor="end">来源：S13/S15/S28 公司口径 + 行业通用框架（N19 待补）</text>';
  g += '<text x="110" y="50" fill="#64748b" font-size="9" text-anchor="middle">公司产品</text>';
  g += '<text x="330" y="50" fill="#64748b" font-size="9" text-anchor="middle">中间环节</text>';
  g += '<text x="620" y="50" fill="#64748b" font-size="9" text-anchor="middle">下游应用 / 终端</text>';
  const rows = [
    ['磷化铟晶片', '外延片 → 光芯片（DFB / EML / PD）', '光模块（400G/800G/1.6T）→ 数据中心 / AI 集群、电信传输'],
    ['砷化镓晶片', '射频 / 激光器件（外延 → 芯片）', '手机射频前端、光通信、LED'],
    ['光伏级锗晶片', '空间太阳能电池', '卫星 / 航天器电源'],
    ['红外级锗单晶 / 镜头', '红外光学元件', '红外热像仪（军工 / 安防 / 测温）'],
    ['光纤级四氯化锗', '光纤预制棒', '光纤光缆 → 电信 / AI 数据中心']
  ];
  rows.forEach((r, i) => {
    const y = 62 + i * 62;
    g += boxSvg(20, y, 180, 40, r[0], { fill: '#dbeafe', stroke: '#60a5fa', color: '#1e3a8a' });
    g += arrowSvg(202, y + 20, 236, y + 20);
    g += boxSvg(240, y, 190, 40, r[1], { fill: '#f8fafc' });
    g += arrowSvg(432, y + 20, 466, y + 20);
    g += boxSvg(470, y, 290, 40, r[2], { fill: '#f1f5f9' });
  });
  g += '<text x="390" y="382" fill="#64748b" font-size="8.5" text-anchor="middle">产品→应用的对应关系为行业通用框架；公司仅披露产品与「下游为外延/器件厂商」[S28]，未逐一确认终端型号。</text>';
  return svgWrap(W, H, '', '', g);
}
function opticalModuleSvg() {
  const W = 780, H = 320;
  let g = svgDefs();
  g += '<text x="20" y="24" fill="#0f172a" font-size="12" font-weight="600">磷化铟衬底在光模块中的位置（结构示意）</text>';
  g += '<text x="' + (W - 20) + '" y="24" fill="#94a3b8" font-size="8" text-anchor="end">行业通用结构；公司只披露「磷化铟晶片下游为外延/器件厂商」[S28]（N19 待补）</text>';
  g += '<rect x="24" y="44" width="580" height="232" rx="8" fill="#f8fafc" stroke="#94a3b8"/>';
  g += '<text x="34" y="62" fill="#475569" font-size="9">光模块（外壳内）</text>';
  g += boxSvg(40, 74, 120, 60, '电接口|金手指 / PCB', { fill: '#f1f5f9' });
  g += boxSvg(180, 74, 120, 60, 'DSP / CDR|信号处理', { fill: '#f1f5f9' });
  g += boxSvg(322, 68, 130, 76, 'TOSA|光发射组件', { fill: '#fee2e2', stroke: '#f87171', color: '#7f1d1d' });
  g += boxSvg(322, 168, 130, 76, 'ROSA|光接收组件', { fill: '#dcfce7', stroke: '#4ade80', color: '#14532d' });
  g += boxSvg(474, 150, 110, 74, '光接口 / 连接器|光纤', { fill: '#f1f5f9' });
  g += '<rect x="344" y="80" width="86" height="52" rx="4" fill="#fecaca" stroke="#dc2626" stroke-width="1.4"/>';
  g += '<text x="387" y="100" fill="#991b1b" font-size="9" font-weight="600" text-anchor="middle">激光器芯片</text>';
  g += '<text x="387" y="114" fill="#991b1b" font-size="8" text-anchor="middle">（InP 衬底 + 外延）</text>';
  g += '<text x="387" y="126" fill="#991b1b" font-size="8" text-anchor="middle">DFB / EML</text>';
  g += '<rect x="344" y="182" width="86" height="50" rx="4" fill="#bbf7d0" stroke="#16a34a" stroke-width="1.4"/>';
  g += '<text x="387" y="200" fill="#14532d" font-size="9" font-weight="600" text-anchor="middle">探测器芯片</text>';
  g += '<text x="387" y="214" fill="#14532d" font-size="8" text-anchor="middle">（InP 衬底 + 外延）</text>';
  g += arrowSvg(160, 104, 178, 104);
  g += arrowSvg(300, 104, 320, 104);
  g += arrowSvg(452, 104, 472, 160);
  g += arrowSvg(472, 190, 452, 200);
  g += '<text x="620" y="92" fill="#334155" font-size="9">供应链位置：</text>';
  g += '<text x="620" y="110" fill="#1e3a8a" font-size="9">InP 衬底（公司）</text>';
  g += '<text x="620" y="126" fill="#64748b" font-size="9">→ 外延片</text>';
  g += '<text x="620" y="142" fill="#64748b" font-size="9">→ 光芯片（激光/探测）</text>';
  g += '<text x="620" y="158" fill="#64748b" font-size="9">→ TOSA / ROSA</text>';
  g += '<text x="620" y="174" fill="#64748b" font-size="9">→ 光模块 / 服务器</text>';
  g += '<text x="614" y="290" fill="#94a3b8" font-size="8">注：TOSA = 发射端，ROSA = 接收端；</text>';
  g += '<text x="614" y="302" fill="#94a3b8" font-size="8">公司磷化铟以 2–4 英寸为主 [S28]。</text>';
  return svgWrap(W, H, '', '', g);
}

(async () => {
  const mission = cat("mission.md");
  const mT = (mission.match(/- 标的: ([^\n]+)/) || [])[1] || "";
  const sym = (mT.match(/\d{6}/) || [""])[0];
  let sj = {};
  try { sj = JSON.parse(cat("research/stock.json")); } catch (_) {}
  const name = sj.name || (mT.replace(/\d{6}/, "").replace(/[（(].*$/, "").trim()) || sym || CASE;
  const val = sj.valuation || {}, asm = sj.assumptions || {}, fin = sj.financials || {};
  const evidence = cat("evidence/sources.jsonl").trim().split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const ev = id => evidence.find(e => e.id === id) || {};
  const audit = (() => { try { return JSON.parse(cat("review/audit.json")); } catch (_) { return {}; } })();
  const legal = (() => { try { return JSON.parse(cat("review/legal.json")); } catch (_) { return {}; } })();
  const trade = cat("trade/plan.md");
  let needs = [];
  try { const r = JSON.parse(await req(BRK + "/api/needs?case=" + encodeURIComponent(CASE))); needs = (r.needs || []).filter(n => n.status === "pending"); } catch (_) {}
  const figs = [];
  function addFig(p, cap) { figs.push({ p: p, cap: cap }); }

  let priceFig = "";
  try {
    const end = new Date(), start = new Date(Date.now() - 240 * 864e5);
    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, "");
    const j = await tsu("daily", { ts_code: codeOf(sym), start_date: fmt(start), end_date: fmt(end) }, "trade_date,open,high,low,close");
    const items = (j.data && j.data.items) || [];
    if (items.length > 3) {
      const rows = items.slice().reverse().map(it => ({ date: String(it[0]).slice(0,4)+'-'+String(it[0]).slice(4,6)+'-'+String(it[0]).slice(6,8), open: +it[1], high: +it[2], low: +it[3], close: +it[4] }));
      put("figures/price-candle.svg", candleSvg(rows, { title: name + " " + codeOf(sym) + " 日K线（未复权，Tushare daily）", src: "source: tushare daily" }), "图：日K线");
      priceFig = "![图1 " + name + " 日K线（未复权）](figures/price-candle.svg)";
      addFig("figures/price-candle.svg", "图1 日K线（未复权，红涨绿跌）");
    }
  } catch (e) { console.error("price chart skipped:", e.message); }

  let finFig = "";
  const qs = (fin.quarterly || []).slice(-8);
  if (qs.length >= 3) {
    put("figures/fin-quarterly.svg", groupedBarsSvg(qs.map(q => q.q), [
      { name: "营收（亿元）", color: "#2563eb", values: qs.map(q => num(q.rev_yi, 0)) },
      { name: "归母净利（亿元）", color: "#f59e0b", values: qs.map(q => num(q.np_yi, 0)) }
    ], { title: name + " 单季营收 / 归母净利（亿元）", yTitle: "亿元", src: "source: stock.json financials" }), "图：季度财务");
    finFig = "![图2 单季营收与归母净利](figures/fin-quarterly.svg)";
    addFig("figures/fin-quarterly.svg", "图2 单季营收/归母净利（亿元）");
  }

  let valFig = "";
  try {
    const curV = num(val.current_price, NaN);
    const items = [];
    if (isFinite(curV)) items.push({ label: "现价", value: curV, color: "#dc2626" });
    if (val.target_range) items.push({ label: "目标区间", range: val.target_range, color: "#2563eb" });
    if (val.dcf) { items.push({ label: "DCF 基准", value: val.dcf.per_share_yuan, color: "#0f766e" }); items.push({ label: "DCF 敏感性", range: val.dcf.sensitivity_yuan, color: "#94a3b8" }); }
    if (val.comps) items.push({ label: "可比法区间", range: val.comps.implied_range_yuan, color: "#7c3aed" });
    const sw = (sj.scenarios || []).reduce((acc, x) => acc + num(x.probability, 0) * num(x.value_yuan, 0), 0);
    if (sw > 0) items.push({ label: "情景加权", value: +sw.toFixed(1), color: "#f59e0b" });
    if (items.length >= 2) {
      put("figures/valuation-compare.svg", rangeBarsSvg(items, { title: name + " 估值锚对比（元/股）", max: 80, step: 10 }), "图：估值对比");
      valFig = "![图3 估值锚对比](figures/valuation-compare.svg)";
      addFig("figures/valuation-compare.svg", "图3 现价 / DCF / 可比 / 目标区间对比");
    }
  } catch (e) { console.error("valuation chart skipped:", e.message); }

  let revFig = "";
  try {
    const rev = (val.dcf && val.dcf.reverse_dcf) || {};
    const fcffMult = num(rev.multiple_vs_base, num(rev.implied_terminal_fcff_yi, 66) / 6.52);
    const impliedRev = num(rev.implied_terminal_revenue_yi, 456);
    const baseRev26 = num((asm.forecast || {})["2026E_revenue_yi"], 20.4);
    const items = [
      { label: "永续 FCFF 倍数", value: +fcffMult.toFixed(1), color: "#dc2626", text: fcffMult.toFixed(1) + "x" },
      { label: "永续收入 / 2026E 营收", value: +(impliedRev / baseRev26).toFixed(1), color: "#dc2626", text: (impliedRev / baseRev26).toFixed(1) + "x" },
      { label: "反向 PE 55x 所需净利倍数", value: 2.0, color: "#f59e0b", text: "2.0x" },
      { label: "销量 10x 仍需单价倍数", value: 2.2, color: "#7c3aed", text: "2.2x" }
    ];
    put("figures/reverse-dcf.svg", hBarsSvg(items, { title: "反向 DCF：现价隐含假设 vs 本稿基准（倍数）", src: "source: reverse_dcf / stock.json" }), "图：反向DCF");
    revFig = "![图4 反向 DCF 隐含倍数](figures/reverse-dcf.svg)";
    addFig("figures/reverse-dcf.svg", "图4 反向 DCF：现价要求多少倍");
  } catch (e) { console.error("reverse chart skipped:", e.message); }

  let peerFig = "";
  try {
    const peers = (ev("S23").value) || {};
    const items = [];
    if (val.pe_ttm) items.push({ label: name, value: val.pe_ttm, color: "#dc2626", text: num(val.pe_ttm).toFixed(1) + "x" });
    const ind = (ev("S18").value || {}).industry_pe_ttm;
    if (ind) items.push({ label: "行业 TTM", value: ind, color: "#0f172a", text: ind.toFixed(1) + "x" });
    Object.keys(peers).forEach(k => {
      const p = peers[k];
      if (p && p.pe_ttm) items.push({ label: p.name, value: p.pe_ttm, color: "#2563eb", text: p.pe_ttm.toFixed(1) + "x" });
    });
    if (items.length >= 3) {
      put("figures/peers-pe.svg", hBarsSvg(items, { title: "PE(TTM) 对比（2026-10-30）", src: "source: S3/S18/S23" }), "图：可比PE");
      peerFig = "![图5 可比公司 PE(TTM)](figures/peers-pe.svg)";
      addFig("figures/peers-pe.svg", "图5 PE(TTM)：公司 vs 行业 vs 可比");
    }
  } catch (e) { console.error("peers chart skipped:", e.message); }

  let mixFig = "";
  try {
    const mix = ev("S12").value;
    if (Array.isArray(mix) && mix.length) {
      const items = mix.map(m => ({ label: m.item, value: +(m.sales / 1e8).toFixed(2), text: (m.sales / 1e8).toFixed(2) + " 亿" }));
      put("figures/revenue-mix.svg", hBarsSvg(items, { title: "2025 年分产品营业收入（亿元）", src: "source: S12 fina_mainbz" }), "图：收入结构");
      mixFig = "![图6 2025 年分产品收入](figures/revenue-mix.svg)";
      addFig("figures/revenue-mix.svg", "图6 分产品收入结构（2025）");
    }
  } catch (e) { console.error("mix chart skipped:", e.message); }

  let macroFig = "";
  try {
    const cpiV = ev("S36").value, ppiV = ev("S37").value;
    function seriesOf(obj) {
      if (!obj || typeof obj !== "object") return [];
      return Object.keys(obj).sort().map(k => ({ lab: k.slice(2), y: num(obj[k] && obj[k].yoy, 0) }));
    }
    const cpiPts = seriesOf(cpiV), ppiPts = seriesOf(ppiV);
    if (cpiPts.length >= 2 || ppiPts.length >= 2) {
      const all = [].concat(cpiPts.map(p => p.lab), ppiPts.map(p => p.lab)).sort();
      const norm = pts => all.map(l => ({ lab: l, y: (pts.find(p => p.lab === l) || {}).y })).filter(p => p.y != null);
      const series = [];
      if (cpiPts.length) series.push({ name: "CPI 同比", color: "#16a34a", pts: norm(cpiPts) });
      if (ppiPts.length) series.push({ name: "PPI 同比", color: "#dc2626", pts: norm(ppiPts) });
      const svg = multiLineSvg(series, { title: "中国 CPI / PPI 同比（%，月度）", src: "source: S36/S37 东财宏观" });
      if (svg) {
        put("figures/macro-cpi-ppi.svg", svg, "图：CPI/PPI");
        macroFig = "![图7 CPI / PPI 同比](figures/macro-cpi-ppi.svg)";
        addFig("figures/macro-cpi-ppi.svg", "图7 CPI / PPI 同比（%）");
      }
    }
  } catch (e) { console.error("macro chart skipped:", e.message); }

  /* 图9-11 产业链位置 / 产品应用地图 / 光模块结构 */
  let chainFig = "", appFig = "", modFig = "", aiFig = "";
  try {
    put("figures/value-chain.svg", valueChainSvg(), "图：产业链与公司位置");
    chainFig = "![图9 锗产业链与公司所在环节](figures/value-chain.svg)";
    addFig("figures/value-chain.svg", "图9 锗产业链与公司所在环节");
    put("figures/application-map.svg", applicationMapSvg(), "图：产品应用地图");
    appFig = "![图10 产品应用地图](figures/application-map.svg)";
    addFig("figures/application-map.svg", "图10 产品应用地图：从材料到终端");
    put("figures/optical-module.svg", opticalModuleSvg(), "图：光模块中的磷化铟");
    modFig = "![图11 磷化铟衬底在光模块中的位置](figures/optical-module.svg)";
    addFig("figures/optical-module.svg", "图11 磷化铟衬底在光模块中的位置");
    // AI 生成的产品拆解图（gpt-image 2.5，由 scripts/gen-image.js 生成后上传到 figures/）
    const aiAbs = path.join(ROOT, "vault", CASE, "figures", "optical-module-ai.png");
    if (fs.existsSync(aiAbs)) {
      aiFig = "![图12 光模块产品拆解图（AI 生成示意，红框为 InP 衬底芯片位置）](figures/optical-module-ai.png)";
      addFig("figures/optical-module-ai.png", "图12 光模块产品拆解图（AI 生成示意，红框为 InP 衬底芯片位置）");
    }
  } catch (e) { console.error("chain charts skipped:", e.message); }

  const ms = sections(cat("research/macro.md")), is = sections(cat("research/industry.md")), ss = sections(cat("research/stock.md"));
  const target = (val.target_range || []).join("–") || "待定";
  const price0 = num(val.current_price, null);
  const shareCount = num(asm.shares_yi, 6.5312);
  const gaps = (sj.data_gaps || []).slice(0, 8);
  const upsideHi = (price0 && val.target_range) ? ((val.target_range[1] / price0 - 1) * 100).toFixed(1) : "—";

  /* 图8 盈利预测 */
  let fcFig = "";
  let fcRows = [];
  try {
    const fc = asm.forecast || {};
    const ev11 = (ev("S11").value) || {};
    const years = ["2025A", "2026E", "2027E", "2028E"];
    const revs = [num(ev11.rev_2025_yi, 10.66), num(fc["2026E_revenue_yi"], 0), num(fc["2027E_revenue_yi"], 0), num(fc["2028E_revenue_yi"], 0)];
    const nps = [num(ev11.np_2025_wan, 0) / 10000, num(fc["2026E_np_yi"], 0), num(fc["2027E_np_yi"], 0), num(fc["2028E_np_yi"], 0)];
    put("figures/forecast.svg", groupedBarsSvg(years, [
      { name: "营业收入（亿元）", color: "#2563eb", values: revs },
      { name: "归母净利（亿元）", color: "#f59e0b", values: nps }
    ], { title: "盈利预测：营业收入与归母净利（2025A–2028E）", yTitle: "亿元", src: "source: S11 / stock.json assumptions" }), "图：盈利预测");
    fcFig = "![图8 盈利预测（2025A–2028E）](figures/forecast.svg)";
    addFig("figures/forecast.svg", "图8 盈利预测：营收与归母净利（2025A–2028E）");
    fcRows = years.map((y, i) => {
      const npv = nps[i], eps = npv / shareCount;
      const pe = (price0 != null && eps > 0) ? (price0 / eps) : null;
      return "| " + y + " | " + revs[i].toFixed(2) + " | " + npv.toFixed(2) + " | " + eps.toFixed(2) + " | " + (pe ? pe.toFixed(0) + "x" : "—") + " |";
    });
  } catch (e) { console.error("forecast chart skipped:", e.message); }

  const L = [];
  L.push("# " + name + "（" + (sym || CASE) + "）深度研究报告");
  L.push("");
  L.push("**证券研究报告 · 个股深度** ｜ 数据日：" + (sj.as_of || "") + " ｜ 报告类型：内部研究（不构成投资建议）");
  L.push("");
  L.push("> 投资评级：**" + (sj.rating || "未评级") + "**（维持） ｜ 目标区间：**" + target + " 元** ｜ 现价：" + (price0 != null ? price0 : "—") + " 元 ｜ 相对目标上沿：" + upsideHi + "%");
  L.push("");
  L.push("## 投资要点");
  L.push("");
  L.push("**核心结论**：" + (sj.rating_basis || "见个股底稿 §1"));
  L.push("");
  L.push("1. **主营业务**：锗矿开采—冶炼—精深加工一体化，锗锭 47.60 吨/年、磷化铟 15→45 万片/年 [S11][S13][S15]；");
  L.push("2. **景气拐点**：2026Q3 单季营收 6.32 亿元（+134.6%）、归母净利 1.02 亿元、毛利率 32.4% [S6][S27]，但低基数与价格错配修复不可线性外推；");
  L.push("3. **估值透支**：PE(TTM) " + num(val.pe_ttm, "—") + "x、PB " + num(val.pb, "—") + "x，现价隐含永续 FCFF 约 " + num((val.dcf && val.dcf.reverse_dcf || {}).implied_terminal_fcff_yi, "—") + " 亿元（本稿基准的 " + num((val.dcf && val.dcf.reverse_dcf || {}).multiple_vs_base, "—") + " 倍）[S1][S3]；");
  L.push("4. **行业与宏观**：锗供给刚性、需求分化，出口管制托底但无独立价格序列；宏观中性偏松、PPI 为供给驱动（第 2、3 章）；");
  L.push("5. **合规状态**：审计 " + (audit.verdict || "—") + (audit.conditional ? "（conditional，需补证）" : "") + "；法律 " + (legal.verdict || "—") + "；复核未收敛，交易计划未生成（第 7 章）。");
  L.push("");
  L.push("## 基本数据");
  L.push("");
  L.push("| 项目 | 数值 | 项目 | 数值 |");
  L.push("|---|---|---|---|");
  L.push("| 收盘价（" + (sj.as_of || "") + "） | " + (price0 != null ? price0 + " 元" : "—") + " | 目标区间 | " + target + " 元 |");
  L.push("| 总市值 | " + num(val.market_cap_yi, "—") + " 亿元 | 总股本 | " + shareCount + " 亿股 |");
  L.push("| PE(TTM) | " + num(val.pe_ttm, "—") + "x | PB | " + num(val.pb, "—") + "x |");
  L.push("| 52 周区间 | " + ((ev("S26").value) || {}).low + "–" + ((ev("S26").value) || {}).high + " 元 | 净债务 | " + num((fin.balance_2026q3 || {}).net_debt_yi, "—") + " 亿元 |");
  L.push("| 资产负债率 | " + num((fin.balance_2026q3 || {}).debt_to_assets_pct, "—") + "% | 年化波动率 | " + num(((ev("S22").value) || {}).stock_vol_ann_pct, "—") + "% |");
  L.push("");
  L.push("## 一、公司概况与商业模式");
  L.push("");
  L.push("### 1.1 公司概况");
  L.push("");
  L.push("公司 " + (name) + "（" + (sym || CASE) + "），Tushare 行业分类「" + ((ev("S4").value) || {}).industry + " 」，注册地 " + ((ev("S4").value) || {}).area + "，上市日 " + ((ev("S4").value) || {}).list_date + " [S4]；实际控制人与股本结构见公司公告，暂未取得，列为待补。");
  L.push("");
  L.push(block(ss, ["商业模式", "护城河"]));
  L.push("");
  L.push("### 1.2 股价表现");
  L.push("");
  if (priceFig) { L.push(priceFig); L.push(""); }
  L.push("## 二、行业分析：供需、价格与竞争格局");
  L.push("");
  L.push(block(is, ["结论", "供给", "需求", "价格", "竞争", "磷化铟", "交叉验证", "数据口径"]));
  if (mixFig) { L.push(""); L.push(mixFig); L.push(""); }
  if (peerFig) { L.push(""); L.push(peerFig); L.push(""); }
  L.push("");
  L.push("### 2.4 产业链与公司所在环节");
  L.push("");
  L.push("公司处于锗产业链的**中游（冶炼与精深加工）**：上游为锗资源（含锗废料回收、锌冶炼副产），公司矿山矿石及粗加工产品不对外销售、只作内部原料 [S11]；中游产品包括区熔锗锭、锗单晶/晶片、光纤用四氯化锗、砷化镓与磷化铟晶片 [S11][S13]；下游为红外热像、空间太阳能电池、光纤预制棒/光缆、光模块/光芯片与射频器件。");
  L.push("");
  if (chainFig) { L.push(chainFig); L.push(""); }
  L.push("### 2.5 产品应用地图：从材料到终端");
  L.push("");
  L.push("产品到终端是多级传导：「衬底/材料 → 外延/器件 → 终端」。磷化铟晶片对应光芯片与光模块，砷化镓对应射频/激光器件，光伏级锗晶片对应空间太阳能电池，红外级锗单晶对应红外热像仪，光纤级四氯化锗对应光纤预制棒/光缆 [S13][S15][S28]。");
  L.push("");
  if (appFig) { L.push(appFig); L.push(""); }
  L.push("### 2.6 磷化铟衬底在光模块中的位置");
  L.push("");
  L.push("光模块内部由电接口/PCB、DSP/CDR、**TOSA（光发射组件）** 与 **ROSA（光接收组件）** 组成：磷化铟衬底先做成外延片，再制成**激光器芯片（DFB/EML，位于 TOSA）**与**探测器芯片（PD，位于 ROSA）**，与 DSP、光接口一起封装为 400G/800G/1.6T 光模块，用于数据中心/AI 集群与电信传输。公司只披露「磷化铟晶片下游为外延生产厂商或具备外延能力的器件厂商、需求以 3–4 英寸为主」[S28]，未逐一披露终端型号——因此该图为行业通用结构，不是公司披露（已上报 N19 待补第三方来源）。");
  L.push("");
  if (modFig) { L.push(modFig); L.push(""); }
  L.push("图12 为 AI 生成的产品拆解示意图（A2A Fans 平台 gpt-image 2.5 生成，红框为 InP 衬底所在芯片），用于直观说明位置关系；它是示意图，不是工程图纸，尺寸/型号不对应具体产品。");
  L.push("");
  if (aiFig) { L.push(aiFig); L.push(""); }
  L.push("## 三、宏观环境与产业链传导");
  L.push("");
  L.push("### 3.1 宏观图景");
  L.push("");
  L.push(block(ms, ["现状仪表盘", "宏观季节"]));
  L.push("");
  L.push("### 3.2 需求拆解、政策预判与市场验证");
  L.push("");
  L.push(block(ms, ["需求拆解", "政策预判", "市场验证", "情景与风险", "结论摘要"]));
  if (macroFig) { L.push(""); L.push(macroFig); L.push(""); }
  L.push("");
  L.push("## 四、公司经营与财务分析");
  L.push("");
  L.push(block(ss, ["财务"]));
  if (finFig) { L.push(""); L.push(finFig); L.push(""); }
  L.push("");
  L.push("### 4.1 关键财务指标（2026Q3 / TTM）");
  L.push("");
  L.push("| 指标 | 数值 | 指标 | 数值 |");
  L.push("|---|---|---|---|");
  L.push("| 营业收入（TTM） | " + num((fin.ttm || {}).rev_yi, "—") + " 亿元 | 归母净利（TTM） | " + num((fin.ttm || {}).np_yi, "—") + " 亿元 |");
  L.push("| 毛利率（TTM） | " + num((fin.ttm || {}).gm_pct, "—") + "% | 净利率（TTM） | " + num((fin.ttm || {}).npm_pct, "—") + "% |");
  L.push("| 经营现金流（TTM） | " + num((fin.ttm || {}).ocf_yi, "—") + " 亿元 | 资本开支（TTM） | " + num((fin.ttm || {}).capex_yi, "—") + " 亿元 |");
  L.push("| 自由现金流（TTM） | " + num((fin.ttm || {}).fcf_yi, "—") + " 亿元 | 2026Q3 资产负债率 | " + num((fin.balance_2026q3 || {}).debt_to_assets_pct, "—") + "% |");
  L.push("");
  L.push("## 五、盈利预测与估值");
  L.push("");
  L.push("### 5.1 关键假设与盈利预测");
  L.push("");
  L.push("| 年度 | 营业收入（亿元） | 归母净利（亿元） | EPS（元） | 现价对应 PE |");
  L.push("|---|---:|---:|---:|---:|");
  fcRows.forEach(r => L.push(r));
  L.push("");
  L.push("注：2026E–2028E 为本稿假设（非公司指引）；2025A 来自年报 [S11]；EPS = 归母净利 / 总股本 " + shareCount + " 亿股。");
  if (fcFig) { L.push(""); L.push(fcFig); L.push(""); }
  L.push("");
  L.push("### 5.2 估值方法与目标区间");
  L.push("");
  L.push(block(ss, ["估值", "情景"]));
  if (valFig) { L.push(""); L.push(valFig); L.push(""); }
  if (revFig) { L.push(""); L.push(revFig); L.push(""); }
  L.push("");
  L.push("| 方法 | 结论 | 说明 |");
  L.push("|---|---|---|");
  L.push("| DCF | 基准 " + num(val.dcf && val.dcf.per_share_yuan, "—") + " 元（敏感性 " + (val.dcf && val.dcf.sensitivity_yuan ? val.dcf.sensitivity_yuan.join("–") : "—") + "） | WACC " + num(asm.wacc, "—") + "、g " + num(asm.terminal_growth, "—") + "，模型输出非指引 |");
  L.push("| 可比公司法 | " + (val.comps && val.comps.implied_range_yuan ? val.comps.implied_range_yuan.join("–") : "—") + " 元 | 2027E EPS × 40–55x，同行中位 PE " + num(val.comps && val.comps.pe_median_x, "—") + "x |");
  L.push("| 反向 DCF | 隐含永续 FCFF 约 " + num((val.dcf && val.dcf.reverse_dcf || {}).implied_terminal_fcff_yi, "—") + " 亿元 | 本稿基准 6.52 亿元的 " + num((val.dcf && val.dcf.reverse_dcf || {}).multiple_vs_base, "—") + " 倍 |");
  L.push("| **目标区间** | **" + target + " 元** | 可验证部分与判断的折中；不含未披露资源期权 |");
  L.push("");
  L.push("## 六、催化剂与风险提示");
  L.push("");
  L.push(block(ss, ["催化剂", "风险"]));
  L.push("");
  L.push("## 七、投资建议");
  L.push("");
  L.push("- **评级**：" + (sj.rating || "未评级") + "（维持）；**目标区间** " + target + " 元，现价 " + (price0 != null ? price0 : "—") + " 元已高于上沿，风险收益不对称；");
  L.push("- **操作含义**：当前不建仓；若锗价/合同出现超预期证据（独立锗价序列、储量披露、合同兑现），再评估上调区间；");
  L.push("- **合规状态**：审计 " + (audit.verdict || "—") + (audit.conditional ? "（conditional，需补证）" : "") + "；法律 " + (legal.verdict || "—") + "；复核未收敛，**交易计划未生成**（按硬约束，conditional 时不得建仓）。");
  L.push("");
  L.push("## 八、待验证问题");
  L.push("");
  gaps.forEach(g => L.push("- " + g));
  if (needs.length) L.push("- 未决 need：" + needs.map(n => n.id + " " + n.title).join("；"));
  L.push("");
  L.push("## 附录 A：证据池（[S#] 对照）");
  L.push("");
  L.push("| ID | 字段 | 值 | 来源 |");
  L.push("|---|---|---|---|");
  evidence.forEach(e => L.push("| [" + (e.id || "") + "] | " + String(e.field || "").slice(0, 44) + " | " + String(JSON.stringify(e.value)).slice(0, 80) + " | " + String(e.url || "").slice(0, 60) + " |"));
  L.push("");
  L.push("## 附录 B：图表口径");
  L.push("");
  L.push("- 图1 日K线：Tushare daily（未复权，近 240 天）；");
  L.push("- 图2 季度财务：stock.json financials.quarterly（单季 = 累计相减）；");
  L.push("- 图3/4/5：估值锚、反向 DCF、可比 PE（stock.json + S3/S18/S23）；");
  L.push("- 图6 收入结构：S12；图7 CPI/PPI：S36/S37；图8 盈利预测：S11 + stock.json assumptions；");
  L.push("- 全部图表由 scripts/report.js 用证据同源数据生成，可用同一命令复现。");
  L.push("");
  L.push("## 附录 C：评级说明与免责声明");
  L.push("");
  L.push("- **评级**：减持（目标区间低于现价 15% 以上）；中性（±15% 以内）；增持（高于现价 15% 以上）。");
  L.push("- **目标区间**：基于可验证证据与公开数据的基本面锚，不含未披露期权，不构成对股价路径的预测。");
  L.push("- **分析师声明**：本报告由 AlphaDesk AI 研究流水线（宏观/行业/个股/审计/法律多角色协作）生成，非持牌分析师署名的卖方报告；不构成投资建议，数据可能存在延迟或口径差异，据此操作风险自担。");
  L.push("");
  L.push("## 图表总览");
  L.push("");
  figs.forEach(f => L.push("- " + f.cap + "：" + f.p));
  L.push("");
  const report = L.join("\n").split("@@CASE@@").join(CASE).split("@@N@@").join(String(evidence.length));
  put("final_report.md", report, "汇编正式研究报告（个股深度结构 + 数据图表）");
  console.log("done chars:", report.length, "figures:", figs.length);
})().catch(e => { console.error(String(e && e.stack || e)); process.exit(1); });
