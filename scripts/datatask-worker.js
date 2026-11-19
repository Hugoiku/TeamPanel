#!/usr/bin/env node
"use strict";
/**
 * datatask-worker — 有界执行一次 DataTask attempt。
 *   输入：broker 写出的 task snapshot JSON
 *   执行：URL → web_agent.py；文件 → extract.js/CSV 表格
 *   输出：POST /api/datatask/attempt/finish
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const dt = require("./datatask");

function arg(name, def) { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : def; }
const FILE = arg("file", "");
const BROKER = arg("broker", "http://127.0.0.1:7801");
if (!FILE || !fs.existsSync(FILE)) { console.error("missing task file"); process.exit(2); }
const snap = JSON.parse(fs.readFileSync(FILE, "utf8"));
const CODE_ROOT = path.resolve(__dirname, "..");
const ROOT = path.resolve(snap.root || CODE_ROOT);
const task = snap.contract ? { contract: snap.contract, sources: snap.sources || [], policy: snap.policy || {} } : snap;
const policy = task.policy || {};
const deadline = Date.now() + Math.max(30000, Number(policy.maxWallClockMs) || 600000);
const errors = [], notes = [], records = [];
const stats = { sources: 0, urls: 0, files: 0, records: 0, elapsedMs: 0 };

function remain() { return Math.max(5000, deadline - Date.now()); }
function addRecord(rec, source, itemIndex) {
  const item = (task.contract.items || []).find(x => x.index === itemIndex);
  if (!item) return;
  const value = String(rec.value === undefined || rec.value === null ? "" : rec.value).trim();
  if (!value) return;
  records.push({
    itemIndex,
    name: rec.name || item.indicator,
    value,
    period: String(rec.period || rec.date || rec.asOf || "").slice(0, 80),
    unit: String(rec.unit || item.unit || "").slice(0, 40),
    sourceUrl: String(rec.sourceUrl || rec.url || source.ref || "").slice(0, 2000),
    sourceId: source.id || "",
    confidence: rec.confidence === undefined ? 0.7 : Math.max(0, Math.min(1, Number(rec.confidence) || 0)),
    dataAsOf: String(rec.dataAsOf || rec.period || rec.date || "").slice(0, 80),
    locator: rec.locator || { url: rec.sourceUrl || source.ref || "", page: rec.page, tableRow: rec.tableRow, cells: rec.cells || [] },
    snapshotPath: String(rec.snapshotPath || "").slice(0, 1000),
    sha256: String(rec.sha256 || "").slice(0, 80),
    extractor: String(rec.extractor || (source.kind === "file" ? "file_table" : "web.agent"))
  });
}

async function runUrl(source) {
  const goal = dt.buildGoal(task, source.expectedItems) + (snap.feedback ? "\n用户反馈：" + snap.feedback : "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, Math.max(1000, Math.min(180000, remain())));
  let g = null, body = {};
  try {
    g = await fetch(BROKER + "/api/data/gateway", { method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ case: snap.case, mode: "web_agent", url: source.ref, goal,
        maxSteps: policy.maxSteps || 10, maxPages: policy.maxPages || 5,
        jobId: snap.id + ":" + snap.attemptId + ":" + source.id,
        idempotencyKey: "dt:" + snap.id + ":" + snap.attemptId + ":" + source.id }) });
    body = await g.json().catch(() => ({}));
  } catch (e) {
    errors.push(source.ref + "：Gateway 超时/失败 " + String(e && e.message || e).slice(0, 200));
    return;
  } finally { clearTimeout(timer); }
  if (!g || g.status !== 200 || !body.ok) {
    errors.push(source.ref + "：" + String(body.error || ("gateway http " + (g && g.status))).slice(0, 300));
    return;
  }
  const j = body.webAgent || {};
  if (j.ok === false) {
    errors.push(source.ref + "：" + String(j.error || "web_agent failed").slice(0, 300));
    return;
  }
  const recs = (j.result && Array.isArray(j.result.records)) ? j.result.records : (Array.isArray(j.records) ? j.records : []);
  recs.forEach(rec => {
    let idx = Number(rec.itemIndex);
    if (!Number.isInteger(idx) || !(task.contract.items || []).some(x => x.index === idx)) idx = dt.matchRecordToItem(rec, task.contract);
    if (idx === null) { notes.push("跳过无法匹配的记录：" + (rec.name || rec.indicator || "")); return; }
    addRecord(rec, source, idx);
  });
  stats.urls += 1;
}

function readTableText(abs, rel) {
  const ext = (rel.split(".").pop() || "").toLowerCase();
  if (ext === "csv" || ext === "tsv" || ext === "txt") return fs.readFileSync(abs, "utf8");
  const args = [path.join(CODE_ROOT, "scripts/extract.js"), "--file", abs];
  if (ext === "pdf") args.push("--tables");
  const r = spawnSync(process.execPath, args, {
    cwd: CODE_ROOT, encoding: "utf8", timeout: Math.min(120000, remain()), maxBuffer: 64 * 1024 * 1024 });
  return String(r.stdout || "");
}

function parseCsv(text) {
  const lines = String(text || "").split(/\r?\n/).filter(x => x.trim() && !x.startsWith("##"));
  if (!lines.length) return [];
  const split = line => {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === "," && !q) { out.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    out.push(cur.trim()); return out;
  };
  const header = split(lines[0]);
  return { header, rows: lines.slice(1).map(split) };
}

function runFile(source) {
  const abs = path.isAbsolute(source.ref) ? source.ref : path.join(ROOT, "vault", snap.case, source.ref);
  if (!fs.existsSync(abs)) { errors.push("文件不存在：" + source.ref); return; }
  const text = readTableText(abs, source.ref);
  const table = parseCsv(text);
  if (!table.rows || !table.rows.length) { errors.push("文件无可解析表格行：" + source.ref); return; }
  const before = records.length;
  const isNum = v => /^-?\d+(\.\d+)?$/.test(String(v || "").replace(/,/g, ""));
  const isNumericCol = i => table.rows.some(row => isNum(row[i]));
  // 优先真正的日期/除净日列，避免 dividend 文件把 year 当 period。
  let dateIdx = table.header.findIndex(h => /ex_date|date|日期|period|期间|时间/i.test(h));
  if (dateIdx < 0) dateIdx = table.header.findIndex(h => /year|年份|月份|month/i.test(h));
  for (const item of (task.contract.items || [])) {
    if (Array.isArray(source.expectedItems) && source.expectedItems.length && source.expectedItems.indexOf(item.index) < 0) continue;
    let col = -1;
    const fmt = String(item.format || "").match(/CSV:\s*(.*)/i);
    if (fmt) {
      const fields = fmt[1].split(",").map(x => x.trim()).filter(Boolean);
      for (let k = fields.length - 1; k >= 0; k--) {
        const f = fields[k];
        col = table.header.findIndex(h => h.toLowerCase() === f.toLowerCase() || h.toLowerCase().indexOf(f.toLowerCase()) >= 0);
        if (col >= 0 && col !== dateIdx && isNumericCol(col)) break;
      }
    }
    if (col < 0 || !isNumericCol(col)) {
      col = table.header.findIndex((h, i) => i !== dateIdx && isNumericCol(i) && /value|close|dps|mid|rate|amount|余额|数值|收盘|分红/i.test(h));
    }
    if (col < 0 || !isNumericCol(col)) {
      col = table.header.findIndex((h, i) => i !== dateIdx && isNumericCol(i));
    }
    if (col < 0) continue;
    table.rows.forEach((row, ri) => {
      const value = String(row[col] || "").replace(/,/g, "").trim();
      if (!/^-?\d+(\.\d+)?$/.test(value)) return;
      const period = dateIdx >= 0 ? String(row[dateIdx] || "").trim() : "";
      if (!period) return;
      addRecord({ value, period, unit: item.unit, sourceUrl: source.ref,
        locator: { file: source.ref, row: ri + 2, column: table.header[col] || "" },
        confidence: 0.75, dataAsOf: period, extractor: "file_table" }, source, item.index);
    });
  }
  if (records.length === before) {
    const ext = (source.ref.split(".").pop() || "").toLowerCase();
    errors.push((ext === "pdf" ? "PDF 表格未识别出可映射的 period/value（建议先转 CSV/XLSX，或提供结构化表格）：" : "文件未识别出可映射的 period/value：") + source.ref);
  }
  stats.files += 1;
}

(async () => {
  try {
    for (const source of (task.sources || [])) {
      if (Date.now() > deadline) { errors.push("超过任务时间预算"); break; }
      stats.sources += 1;
      try {
        if (source.kind === "file") runFile(source); else await runUrl(source);
      } catch (e) {
        errors.push((source.ref || "") + "：" + String(e && e.message || e).slice(0, 300));
      }
    }
    stats.records = records.length;
    stats.elapsedMs = Math.max(0, (Number(policy.maxWallClockMs) || 600000) - remain());
    const body = { case: snap.case, id: snap.id, attemptId: snap.attemptId,
      ok: records.length > 0 || errors.length === 0, records,
      notes: notes.slice(0, 20).join("；"), error: errors.slice(0, 5).join("；"), stats };
    const r = await fetch(BROKER + "/api/datatask/attempt/finish", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) { console.error("finish failed", r.status, j); process.exit(3); }
    console.log(JSON.stringify({ ok: true, records: records.length, errors: errors.length }));
    process.exit(0);
  } catch (e) {
    console.error(e && e.stack || e);
    try {
      await fetch(BROKER + "/api/datatask/attempt/finish", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ case: snap.case, id: snap.id, attemptId: snap.attemptId,
          ok: false, records: [], error: String(e && e.message || e).slice(0, 800), stats }) });
    } catch (e2) {}
    process.exit(4);
  }
})();
