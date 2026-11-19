#!/usr/bin/env node
"use strict";
/**
 * test-connectors — 免费公开数据源 connector 集成测试
 * 零依赖（Node 22），真实联网，单项 30s 超时。
 *
 *   node scripts/test-connectors.js            # 真实联网：4 个 connector + 样本打印
 *   node scripts/test-connectors.js --offline  # 不联网：语法检查 + 参数校验/失败契约
 *
 * 断言：ok=true、records.length>0、source 非空、period 合法（YYYY-MM 或 YYYY-MM-DD）、
 *       value 为有限数、records 按 period 升序、stdout 恰好一行 JSON。
 * FRED 没有 key 时标记 SKIP（打印原因），不算失败。任一 FAIL → exit 1。
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const TIMEOUT_MS = 30000;

const TESTS = [
  {
    name: "eastmoney · M1 同比（月度）",
    file: "eastmoney-series.js",
    args: ["--report", "RPT_ECONOMY_CURRENCY_SUPPLY", "--period-field", "REPORT_DATE",
      "--value-field", "CURRENCY_SAME", "--unit", "%", "--date-mode", "monthly", "--range", "2025-01..2026-10"],
  },
  {
    name: "eastmoney · LPR 1Y（日度，需 token）",
    file: "eastmoney-series.js",
    args: ["--report", "RPTA_WEB_RATE", "--period-field", "TRADE_DATE", "--value-field", "LPR1Y",
      "--unit", "%", "--date-mode", "daily", "--range", "2026-01-01..2026-11-16",
      "--extra", '{"token":"894050c76af8597a853f5b408b759f5d"}'],
  },
  {
    name: "mofcom · 社融规模增量（月度）",
    file: "mofcom-tsf.js",
    args: ["--range", "2025-01..2026-10"],
  },
  {
    name: "chinamoney · SHIBOR 1W（日度）",
    file: "chinamoney-series.js",
    args: ["--path", "cm-u-bk-shibor/ShiborHis", "--field", "1W", "--range", "2026-10-01..2026-11-16"],
  },
  {
    name: "chinamoney · SHIBOR 1W 跨年分片（2025-01..2026-11）",
    file: "chinamoney-series.js",
    args: ["--path", "cm-u-bk-shibor/ShiborHis", "--field", "1W", "--range", "2025-01..2026-11"],
    check: (j) => {
      const first = j.records[0].period, last = j.records[j.records.length - 1].period;
      if (first > "2025-02-01") return "起始覆盖不足（首条 " + first + "）";
      if (last < "2026-10-01") return "末尾覆盖不足（末条 " + last + "）";
      return "";
    },
  },
  {
    name: "fred · DGS10（日度）",
    file: "fred-series.js",
    args: ["--series", "DGS10", "--range", "2026-10-01..2026-11-16"],
    requiresKey: true,
  },
];

function run(file, args) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", file)].concat(args), {
    cwd: ROOT, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = String(r.stdout || "");
  const lines = stdout.trim().split("\n").filter(Boolean);
  let json = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try { json = JSON.parse(lines[i]); break; } catch (e) { /* 继续找上一行 */ }
  }
  const timedOut = !!(r.error && r.error.code === "ETIMEDOUT");
  return {
    status: r.status, signal: r.signal, timedOut, json, lines: lines.length,
    stdout: stdout, stderr: String(r.stderr || ""), elapsedMs: Date.now() - started,
  };
}

function fredKeyAvailable() {
  if (String(process.env.FRED_API_KEY || "").trim()) return "FRED_API_KEY";
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, "runtime/secrets/fred.json"), "utf8"));
    if (String(j.api_key || j.apiKey || j.key || "").trim()) return "runtime/secrets/fred.json";
  } catch (e) { /* 无 secrets 文件 */ }
  return "";
}

function validate(r) {
  if (r.timedOut) return "超时 " + TIMEOUT_MS / 1000 + "s";
  if (r.status !== 0) {
    const err = r.json && r.json.error ? "：" + r.json.error : (r.stderr ? "：" + r.stderr.trim().slice(0, 200) : "");
    return "exit " + r.status + err;
  }
  if (r.lines !== 1) return "stdout 应为一行 JSON，实际 " + r.lines + " 行";
  const j = r.json;
  if (!j) return "stdout 不是 JSON";
  if (j.ok !== true) return "ok 不为 true" + (j.error ? "：" + j.error : "");
  if (typeof j.source !== "string" || !j.source) return "缺少 source";
  if (!Array.isArray(j.records)) return "records 不是数组";
  if (!j.records.length) return "records 为空";
  let prev = "";
  for (const rec of j.records) {
    if (!rec || typeof rec !== "object") return "record 不是对象";
    if (!/^\d{4}-\d{2}(-\d{2})?$/.test(String(rec.period))) return "period 非法：" + rec.period;
    if (!Number.isFinite(Number(rec.value))) return "value 非有限数：" + rec.value;
    if (typeof rec.unit !== "string") return "unit 不是字符串";
    if (prev && String(rec.period) < prev) return "period 未升序：" + rec.period + " < " + prev;
    prev = String(rec.period);
  }
  return "";
}

function sample(records) {
  return records.slice(0, 3).map(r => r.period + "=" + r.value + r.unit).join(" · ");
}

function onlineSuite() {
  console.log("=== 免费 connector 集成测试（真实联网，单项超时 " + TIMEOUT_MS / 1000 + "s）===");
  let passed = 0, skipped = 0, failed = 0;
  TESTS.forEach((t, i) => {
    const tag = "[" + (i + 1) + "/" + TESTS.length + "] " + t.name + " (" + t.file + ")";
    if (t.requiresKey) {
      const src = fredKeyAvailable();
      if (!src) {
        console.log(tag);
        console.log("  SKIP  未检测到 FRED API key（env FRED_API_KEY / runtime/secrets/fred.json），跳过，不算失败");
        skipped += 1;
        return;
      }
    }
    const r = run(t.file, t.args);
    let why = validate(r);
    if (!why && typeof t.check === "function") why = t.check(r.json) || "";
    if (why) {
      failed += 1;
      console.log(tag);
      console.log("  FAIL  " + why);
      if (r.stdout.trim()) console.log("  stdout: " + r.stdout.trim().slice(0, 300));
      if (r.stderr.trim()) console.log("  stderr: " + r.stderr.trim().slice(0, 300));
      return;
    }
    passed += 1;
    const j = r.json;
    console.log(tag);
    const shardNote = j.shards ? " · 分片 " + j.shards.ok + "/" + j.shards.total : "";
    console.log("  PASS  " + j.records.length + " 条 · " + r.elapsedMs + "ms · source=" + j.source
      + " · 首/末=" + j.records[0].period + "/" + j.records[j.records.length - 1].period + shardNote);
    console.log("  样本: " + sample(j.records));
    j.records.slice(0, 3).forEach(rec => console.log("    " + JSON.stringify(rec)));
  });
  const ok = failed === 0;
  console.log("");
  console.log(JSON.stringify({ ok: ok, passed: passed, skipped: skipped, failed: failed }));
  process.exit(ok ? 0 : 1);
}

/** 不联网：语法检查 + 参数校验（非法 --range 必须在 fetch 之前被拦截，exit 1 + ok:false） */
function offlineSuite() {
  console.log("=== 免费 connector 离线校验（--offline，不联网）===");
  const files = ["eastmoney-series.js", "mofcom-tsf.js", "chinamoney-series.js", "fred-series.js"];
  let passed = 0, failed = 0;
  files.forEach((file, i) => {
    const tag = "[" + (i + 1) + "/" + files.length + "] " + file;
    const chk = spawnSync(process.execPath, ["--check", path.join(ROOT, "scripts", file)], { encoding: "utf8" });
    const problems = [];
    if (chk.status !== 0) problems.push("语法错误：" + String(chk.stderr || "").trim().slice(0, 200));
    const r = run(file, ["--range", "BAD..RANGE"]);
    if (r.status !== 1) problems.push("非法 --range 应 exit 1，实际 exit " + r.status);
    if (!r.json || r.json.ok !== false) problems.push("非法 --range 应输出 ok:false");
    if (!r.json || !r.json.error) problems.push("ok:false 应带 error 字段");
    if (r.lines !== 1) problems.push("失败时 stdout 应恰好一行 JSON，实际 " + r.lines + " 行");
    if (r.elapsedMs > 5000) problems.push("参数校验阶段疑似联网（耗时 " + r.elapsedMs + "ms）");
    if (problems.length) {
      failed += 1;
      console.log(tag);
      problems.forEach(p => console.log("  FAIL  " + p));
      return;
    }
    passed += 1;
    console.log(tag);
    console.log("  PASS  语法 OK · 参数校验 exit 1 + ok:false · " + r.elapsedMs + "ms（未联网）");
  });
  const ok = failed === 0;
  console.log("");
  console.log(JSON.stringify({ ok: ok, mode: "offline", passed: passed, failed: failed }));
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes("--offline")) offlineSuite();
else onlineSuite();
