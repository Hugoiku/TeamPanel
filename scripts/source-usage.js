#!/usr/bin/env node
"use strict";
/** source-usage — 数据源调用/成本/配额记录（append-only JSONL）。 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const FILE = path.join(ROOT, "runtime/data/source-usage.jsonl");
function day(ts) { return String(ts || new Date().toISOString()).slice(0, 10); }
function read(limit) {
  const out = [];
  try {
    const lines = fs.readFileSync(FILE, "utf8").split(String.fromCharCode(10));
    for (const line of lines) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch (e) {} }
  } catch (e) {}
  return limit ? out.slice(-limit) : out;
}
function record(entry) {
  const e = Object.assign({ at: new Date().toISOString(), day: day(), cost: 0, status: "ok" }, entry || {});
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.appendFileSync(FILE, JSON.stringify(e) + String.fromCharCode(10));
  return e;
}
function usedToday(sourceId, ts) {
  const d = day(ts);
  return read().filter(x => x.sourceId === sourceId && x.day === d && x.status !== "released")
    .reduce((n, x) => n + (Number(x.cost) || 0), 0);
}
function callsToday(sourceId, ts) {
  const d = day(ts);
  return read().filter(x => x.sourceId === sourceId && x.day === d && x.status !== "released").length;
}
function summary(sources) {
  const rows = [];
  for (const s of sources || []) {
    const a = (s.access || {});
    const cost = (a.cost && a.cost.perCall) || a.costPerCall || 0;
    rows.push({ sourceId: s.id, cost: Number(cost) || 0,
      dailyQuota: Number((a.cost && a.cost.dailyQuota) || a.dailyQuota || 0) || 0,
      usedToday: usedToday(s.id), callsToday: callsToday(s.id) });
  }
  return rows;
}
module.exports = { FILE, day, read, record, usedToday, callsToday, summary };
