#!/usr/bin/env node
"use strict";
/** test-data-quality — 数据质量门禁单元测试（不联网）。 */
const assert = require("assert");
const q = require("./data-quality");

let passed = 0, failed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log("  PASS " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + " :: " + String((e && e.message) || e)); }
}
const now = "2026-11-16";
const monthly = { frequency: "monthly", unit: "%", maxStalenessMonths: 2 };
const daily = { frequency: "daily", unit: "%", maxStalenessDays: 7 };
function recs(periods, unit) { return periods.map(p => ({ period: p, value: 1.2, unit: unit === undefined ? "%" : unit })); }

console.log("=== 月度 ===");
ok("连续且新鲜 → ok", () => {
  const r = q.check(monthly, recs(["2026-09", "2026-10", "2026-11"]), { now });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dataAsOf, "2026-11");
  assert.strictEqual(r.stale, false);
});
ok("缺月 → 结构失败", () => {
  const r = q.check(monthly, recs(["2026-09", "2026-11"]), { now });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.structural, false);
  assert.ok(r.issues.some(x => /缺 1 期/.test(x)), r.issues.join("；"));
});
ok("单位不一致 → 结构失败", () => {
  const r = q.check(monthly, recs(["2026-10", "2026-11"], "亿元"), { now });
  assert.strictEqual(r.ok, false);
  assert.ok(r.issues.some(x => /单位不一致/.test(x)), r.issues.join("；"));
});
ok("重复 period → 结构失败", () => {
  const r = q.check(monthly, recs(["2026-10", "2026-10", "2026-11"]), { now });
  assert.strictEqual(r.ok, false);
  assert.ok(r.issues.some(x => /重复 period/.test(x)), r.issues.join("；"));
});
ok("过期 → 不 ok，但结构仍 ok", () => {
  const r = q.check(monthly, recs(["2026-04"]), { now });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.structural, true);
  assert.strictEqual(r.fresh, false);
  assert.strictEqual(r.dataAsOf, "2026-04");
  assert.ok(/落后 7 个月/.test(r.staleDetail), r.staleDetail);
});

console.log("=== 日度 ===");
ok("日度不要求每天连续，但重复要失败", () => {
  const r = q.check(daily, recs(["2026-11-10", "2026-11-12", "2026-11-16"]), { now });
  assert.strictEqual(r.ok, true);
  const d = q.check(daily, recs(["2026-11-10", "2026-11-10", "2026-11-16"]), { now });
  assert.strictEqual(d.ok, false);
});
ok("日度过期 → 失败", () => {
  const r = q.check(daily, recs(["2026-10-01"]), { now });
  assert.strictEqual(r.ok, false);
  assert.ok(/落后 46 天/.test(r.staleDetail), r.staleDetail);
});

console.log("=== 季度 ===");
ok("季度连续（03/06/09/12）→ ok", () => {
  const m = { frequency: "quarterly", unit: "亿元", maxStalenessMonths: 6 };
  const r = q.check(m, recs(["2025-12", "2026-03", "2026-06", "2026-09"], "亿元"), { now });
  assert.strictEqual(r.ok, true);
});
ok("季度缺期 → 失败", () => {
  const m = { frequency: "quarterly", unit: "亿元", maxStalenessMonths: 6 };
  const r = q.check(m, recs(["2025-12", "2026-06"], "亿元"), { now });
  assert.strictEqual(r.ok, false);
});

console.log("=== 空/非法 ===");
ok("空 records → 失败", () => {
  assert.strictEqual(q.check(monthly, [], { now }).ok, false);
});
ok("非数字 value 被过滤后为空 → 失败", () => {
  assert.strictEqual(q.check(monthly, [{ period: "2026-11", value: "x" }], { now }).ok, false);
});

console.log("\n" + JSON.stringify({ ok: failed === 0, passed, failed }));
process.exit(failed ? 1 : 0);
