#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
let CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "config/indicators.json"), "utf8")); } catch (e) { return { indicators: [] }; } })();
function reload() {
  try { CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "config/indicators.json"), "utf8")); }
  catch (e) { CFG = { indicators: [] }; }
  return CFG;
}
function norm(s) {
  return String(s || "").toLowerCase()
    .replace(/[（(]/g, "").replace(/[）)]/g, "")
    .replace(/10\s*年/g, "10y").replace(/5\s*年/g, "5y").replace(/3\s*年/g, "3y").replace(/1\s*年/g, "1y")
    .replace(/[\\s\\p{P}\\p{S}]/gu, "");
}
const byId = {};
(CFG.indicators || []).forEach(i => { byId[i.id] = i; });
function resolve(item) {
  if (!item) return "";
  if (item.indicatorId && byId[item.indicatorId]) return item.indicatorId;
  const text = norm(item.indicator || item.name || "");
  if (!text) return "";
  let best = null, bestLen = 0;
  for (const ind of (CFG.indicators || [])) {
    const names = [ind.name].concat(ind.aliases || []);
    for (const n of names) {
      const nn = norm(n);
      if (nn && (text === nn || text.indexOf(nn) >= 0)) {
        if (nn.length > bestLen) { best = ind.id; bestLen = nn.length; }
      }
    }
  }
  return best || ("raw:" + text);
}
function needIndicatorIds(need) {
  const ids = [];
  const items = (need && need.spec && Array.isArray(need.spec.items)) ? need.spec.items : [];
  items.forEach(it => { const id = resolve(it); if (id) ids.push(id); });
  if (!ids.length && need && need.title) {
    for (const ind of (CFG.indicators || [])) {
      const names = [ind.name].concat(ind.aliases || []);
      if (names.some(n => norm(n) && norm(need.title).indexOf(norm(n)) >= 0)) ids.push(ind.id);
    }
  }
  return Array.from(new Set(ids)).sort();
}
function isSubset(a, b) { const B = new Set(b); return a.every(x => B.has(x)); }
module.exports = { norm, resolve, needIndicatorIds, isSubset, reload, config: CFG };
if (require.main === module) {
  const arg = process.argv[2] || "";
  console.log(JSON.stringify({ input: arg, id: resolve({ indicator: arg }) }, null, 2));
}
