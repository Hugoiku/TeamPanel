#!/usr/bin/env node
"use strict";
/**
 * chart — 零依赖 SVG 图表（给员工/报告用）
 *
 *   node scripts/chart.js line --csv data.csv --x date --y value --title "..." --out figures/x.svg
 *   node scripts/chart.js bar  --csv data.csv --label name --value value --out figures/x.svg
 *   node scripts/chart.js hbar --csv data.csv --label name --value value --out figures/x.svg
 *   node scripts/chart.js grouped --json data.json --title "..." --out figures/x.svg
 *   node scripts/chart.js line --csv data.csv --x date --y value --color "#2563eb" --source "[S1][S2]"
 */
const fs = require("fs");
const path = require("path");
function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function parseCsv(file) {
  const txt = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const lines = txt.split(/\r?\n/).filter(l => l.trim());
  const head = lines.shift().split(",").map(s => s.trim().replace(/^"|"$/g, ""));
  return lines.map(line => {
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(c => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
    const o = {}; head.forEach((h, i) => o[h] = (cells[i] || "").trim()); return o;
  });
}
function parseJson(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Array.isArray(j)) return j;
  if (j.data && Array.isArray(j.data)) return j.data;
  if (j.series && Array.isArray(j.series)) return j;
  return [];
}
function num(v) { const n = Number(String(v).replace(/[%,，\s]/g, "")); return isFinite(n) ? n : null; }
function fmt(n) { return Math.abs(n) >= 1000 ? n.toFixed(0) : (Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2)); }
function decimals(span) { return Math.abs(span) < 0.05 ? 3 : (Math.abs(span) < 50 ? 2 : 0); }
function axes(W, H, pad, xLabels, yMin, yMax, yTicks) {
  let s = "";
  const dec = decimals(yMax - yMin);
  for (let i = 0; i <= yTicks; i++) {
    const y = pad.t + (H - pad.t - pad.b) * (1 - i / yTicks);
    const v = yMin + (yMax - yMin) * i / yTicks;
    s += '<line x1="' + pad.l + '" y1="' + y + '" x2="' + (W - pad.r) + '" y2="' + y + '" stroke="#eef2f7"/>';
    s += '<text x="' + (pad.l - 6) + '" y="' + (y + 3) + '" fill="#94a3b8" font-size="10" text-anchor="end">' + v.toFixed(dec) + "</text>";
  }
  xLabels.forEach((lab, i) => {
    const x = pad.l + (W - pad.l - pad.r) * (xLabels.length === 1 ? 0.5 : i / (xLabels.length - 1));
    const anchor = xLabels.length > 1 && i === 0 ? "start" : (xLabels.length > 1 && i === xLabels.length - 1 ? "end" : "middle");
    s += '<text x="' + x + '" y="' + (H - 20) + '" fill="#94a3b8" font-size="10" text-anchor="' + anchor + '">' + esc(lab) + "</text>";
  });
  return s;
}
function frame(W, H, title, source, body) {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '">' +
    '<rect width="' + W + '" height="' + H + '" fill="#ffffff"/>' +
    '<text x="16" y="24" fill="#0f172a" font-size="15" font-weight="650">' + esc(title || "") + "</text>" +
    (source ? '<text x="16" y="' + (H - 4) + '" fill="#94a3b8" font-size="9">来源：' + esc(source) + "</text>" : "") +
    body + "</svg>";
}
function writeSvg(out, svg) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), svg);
  console.log(JSON.stringify({ ok: true, out: out, bytes: Buffer.byteLength(svg) }));
}
const cmd = process.argv[2] || "";
const csv = arg("csv", ""), json = arg("json", "");
if (!cmd || (!csv && !json)) { console.error("用法见脚本头部注释"); process.exit(2); }
const rows = csv ? parseCsv(csv) : parseJson(json);
const W = parseInt(arg("width", "760"), 10), H = parseInt(arg("height", "420"), 10);
const title = arg("title", ""), source = arg("source", "");
const color = arg("color", "#2563eb");
if (cmd === "bar" || cmd === "hbar") {
  const labelKey = arg("label", Object.keys(rows[0] || {})[0]);
  const valKey = arg("value", Object.keys(rows[0] || {})[1]);
  const items = rows.map(r => ({ label: r[labelKey], v: num(r[valKey]) })).filter(x => x.v != null);
  if (!items.length) { console.error("没有可绘制的数值"); process.exit(3); }
  if (cmd === "hbar") {
    const left = 120, right = 30, top = 44, rowH = Math.min(34, (H - top - 30) / items.length);
    const max = Math.max(...items.map(x => Math.abs(x.v)), 1);
    let body = "";
    items.forEach((it, i) => {
      const y = top + i * rowH, bw = (W - left - right) * Math.abs(it.v) / max;
      body += '<text x="' + (left - 8) + '" y="' + (y + rowH * 0.65) + '" fill="#475569" font-size="11" text-anchor="end">' + esc(it.label) + "</text>";
      body += '<rect x="' + left + '" y="' + (y + 4) + '" width="' + Math.max(1, bw) + '" height="' + (rowH - 10) + '" fill="' + color + '" rx="2"/>';
      body += '<text x="' + (left + Math.max(1, bw) + 6) + '" y="' + (y + rowH * 0.65) + '" fill="#334155" font-size="10">' + fmt(it.v) + "</text>";
    });
    writeSvg(arg("out", "figures/chart.svg"), frame(W, H, title, source, body));
  } else {
    const pad = { l: 48, r: 16, t: 44, b: 34 };
    const max = Math.max(...items.map(x => x.v), 0), min = Math.min(...items.map(x => x.v), 0);
    const span = (max - min) || 1;
    const yv = v => pad.t + (H - pad.t - pad.b) * (1 - (v - min) / span);
    let body = axes(W, H, pad, [], min, max, 4);
    const bw = Math.min(72, (W - pad.l - pad.r) / items.length * 0.6);
    items.forEach((it, i) => {
      const x = pad.l + (W - pad.l - pad.r) * (i + 0.5) / items.length;
      body += '<rect x="' + (x - bw / 2) + '" y="' + yv(Math.max(0, it.v)) + '" width="' + bw + '" height="' + Math.abs(yv(it.v) - yv(0)) + '" fill="' + color + '" rx="2"/>';
      body += '<text x="' + x + '" y="' + (yv(it.v) - 5) + '" fill="#334155" font-size="10" text-anchor="middle">' + it.v.toFixed(decimals(span)) + "</text>";
      body += '<text x="' + x + '" y="' + (H - 20) + '" fill="#94a3b8" font-size="10" text-anchor="middle">' + esc(it.label) + "</text>";
    });
    writeSvg(arg("out", "figures/chart.svg"), frame(W, H, title, source, body));
  }
  process.exit(0);
}
if (cmd === "line") {
  const xKey = arg("x", Object.keys(rows[0] || {})[0]);
  const yKey = arg("y", Object.keys(rows[0] || {})[1]);
  const pts = rows.map(r => ({ x: r[xKey], v: num(r[yKey]) })).filter(p => p.v != null);
  if (pts.length < 2) { console.error("至少需要 2 个数据点"); process.exit(3); }
  const pad = { l: 48, r: 16, t: 44, b: 34 };
  const dataMax = Math.max(...pts.map(p => p.v)), dataMin = Math.min(...pts.map(p => p.v));
  // 可选固定纵轴范围：--ymin/--ymax；不传则按数据区间（旧行为）
  const yMinArg = arg("ymin", ""), yMaxArg = arg("ymax", "");
  const max = yMaxArg !== "" && isFinite(Number(yMaxArg)) ? Number(yMaxArg) : dataMax;
  const min = yMinArg !== "" && isFinite(Number(yMinArg)) ? Number(yMinArg) : dataMin;
  const span = (max - min) || 1;
  const xv = i => pad.l + (W - pad.l - pad.r) * (i / (pts.length - 1));
  const yv = v => pad.t + (H - pad.t - pad.b) * (1 - (v - min) / span);
  let body = axes(W, H, pad, pts.map(p => p.x), min, max, 4);
  body += '<polyline fill="none" stroke="' + color + '" stroke-width="2" points="' + pts.map((p, i) => xv(i) + "," + yv(p.v)).join(" ") + '"/>';
  // 数值标签按数据极差定精度，避免固定纵轴后把 1.401 显示成 1.40
  const dec = decimals(dataMax - dataMin);
  pts.forEach((p, i) => {
    const anchor = pts.length > 1 && i === 0 ? "start" : (pts.length > 1 && i === pts.length - 1 ? "end" : "middle");
    const lx = xv(i) + (i === 0 ? 6 : (i === pts.length - 1 ? -6 : 0));
    body += '<circle cx="' + xv(i) + '" cy="' + yv(p.v) + '" r="3" fill="#fff" stroke="' + color + '" stroke-width="1.5"/>';
    // 每个点都标注数值：首点若恰为最小值，旧逻辑会静默丢标签，导致折线少一个读数
    body += '<text x="' + lx + '" y="' + (yv(p.v) - 8) + '" fill="#334155" font-size="10" text-anchor="' + anchor + '">' + p.v.toFixed(dec) + "</text>";
  });
  writeSvg(arg("out", "figures/chart.svg"), frame(W, H, title, source, body));
  process.exit(0);
}
console.error("未知图表类型：" + cmd + "（支持 line/bar/hbar）"); process.exit(2);
