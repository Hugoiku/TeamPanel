#!/usr/bin/env node
"use strict";
/** source-probe — 对一个已注册来源做一次真实抽样，验证能否产出 records。 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return d; } }
function loadSource(id) {
  const dir = path.join(ROOT, "config/sources");
  let list = [];
  try { list = fs.readdirSync(dir).filter(f => f.endsWith(".json")).map(f => readJson(path.join(dir, f), null)).filter(Boolean); } catch (e) {}
  return list.find(s => s.id === id) || null;
}
function loadRegistry(id) {
  const j = readJson(path.join(ROOT, "config/data/sources.json"), { sources: [] });
  return (j.sources || []).find(s => s.id === id || s.configSource === id) || null;
}
function parseRecords(j, reg) {
  let arr = Array.isArray(j.records) ? j.records :
    (Array.isArray(j.data) ? j.data :
    (j && j.result && Array.isArray(j.result.data) ? j.result.data :
    (j && Array.isArray(j.result) ? j.result : null)));
  if (!arr) return [];
  if (!reg || !reg.connector) return arr;
  const pf = reg.periodField || "REPORT_DATE", vf = reg.valueField || "VALUE";
  return arr.map(x => {
    let p = x[pf] || x.TIME || x.DATE || x.period || "";
    p = String(p).replace(/年(\d{1,2})月/, "-$1").replace(/[^0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (/^\d{4}-\d{2}/.test(p)) p = p.slice(0, 7);
    const v = Number(x[vf]);
    return { period: p, value: v, unit: reg.unit || x.unit || "" };
  }).filter(x => /^\d{4}-\d{2}/.test(x.period) && Number.isFinite(x.value));
}
function probe(sourceId, metricId) {
  const src = loadSource(sourceId) || loadSource((loadRegistry(sourceId) || {}).configSource);
  if (!src) return { ok: false, sourceId, error: "source config not found" };
  const out = path.join(ROOT, "runtime/cache/probe", sourceId + "-" + Date.now() + ".json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/collect.js"), "source", src.id, "--out", out],
    { cwd: ROOT, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  let j = null;
  try { j = JSON.parse(String(r.stdout || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(out, "utf8")); } catch (e) {}
  const reg = loadRegistry(src.id) || {};
  const records = payload ? parseRecords(payload, reg) : [];
  const sample = records.slice(0, 5);
  return { ok: r.status === 0 && records.length > 0, sourceId: src.id, metricId: metricId || "",
    checkedAt: new Date().toISOString(), count: records.length,
    fields: records[0] ? Object.keys(records[0]) : [], sample,
    error: records.length ? "" : "抓取成功但未得到结构化 records，需要模型/审计解析",
    raw: j && j.preview ? String(j.preview).slice(0, 300) : "" };
}
module.exports = { probe, parseRecords, loadSource, loadRegistry };
if (require.main === module) {
  const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; };
  const out = probe(arg("source", ""), arg("metric", ""));
  process.stdout.write(JSON.stringify(out) + String.fromCharCode(10));
  process.exit(out.ok ? 0 : 1);
}
