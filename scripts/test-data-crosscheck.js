#!/usr/bin/env node
"use strict";
/** test-data-crosscheck — 多源交叉校验单元测试（不联网）。 */
const assert = require("assert");
const { compare } = require("./data-crosscheck");
let passed = 0, failed = 0;
function ok(name, fn) { try { fn(); passed++; console.log("  PASS " + name); } catch (e) { failed++; console.log("  FAIL " + name + " :: " + String((e && e.message) || e)); } }
function recs(pairs) { return pairs.map(([period, value]) => ({ period, value, unit: "%" })); }
const m = { frequency: "monthly", crossCheck: { absTolerance: 0.1, maxPeriods: 6 } };

ok("共同 period 在容差内 → match", () => {
  const r = compare(m, recs([["2026-08", 1.2], ["2026-09", 1.3], ["2026-10", 1.4]]),
    recs([["2026-08", 1.21], ["2026-09", 1.29], ["2026-10", 1.42]]));
  assert.strictEqual(r.status, "match");
  assert.strictEqual(r.compared, 3);
});
ok("差异超过绝对容差 → mismatch", () => {
  const r = compare(m, recs([["2026-10", 1.4]]), recs([["2026-10", 1.8]]));
  assert.strictEqual(r.status, "mismatch");
  assert.ok(r.issues.length && /2026-10/.test(r.issues[0]));
});
ok("相对容差生效", () => {
  const mm = { frequency: "monthly", crossCheck: { relTolerance: 0.02, maxPeriods: 6 } };
  assert.strictEqual(compare(mm, recs([["2026-10", 100]]), recs([["2026-10", 101.5]])).status, "match");
  assert.strictEqual(compare(mm, recs([["2026-10", 100]]), recs([["2026-10", 103]])).status, "mismatch");
});
ok("没有共同 period → insufficient 不阻断", () => {
  const r = compare(m, recs([["2026-10", 1]]), recs([["2026-09", 1]]));
  assert.strictEqual(r.status, "insufficient");
  assert.strictEqual(r.ok, true);
});
ok("只比较最近 maxPeriods 个共同 period", () => {
  const mm = { frequency: "monthly", crossCheck: { absTolerance: 0.01, maxPeriods: 2 } };
  const p = recs([["2026-01", 1], ["2026-02", 1], ["2026-03", 9], ["2026-04", 9]]);
  const s = recs([["2026-01", 1], ["2026-02", 1], ["2026-03", 9.5], ["2026-04", 9.5]]);
  const r = compare(mm, p, s);
  assert.strictEqual(r.compared, 2);
  assert.strictEqual(r.status, "mismatch");
});
ok("日度按完整日期对齐", () => {
  const dm = { frequency: "daily", crossCheck: { absTolerance: 0.02, maxPeriods: 6 } };
  const r = compare(dm, recs([["2026-11-16", 1.39]]), recs([["2026-11-16", 1.40]]));
  assert.strictEqual(r.status, "match");
  const bad = compare(dm, recs([["2026-11-16", 1.39]]), recs([["2026-11-16", 1.45]]));
  assert.strictEqual(bad.status, "mismatch");
});
console.log("\n" + JSON.stringify({ ok: failed === 0, passed, failed }));
process.exit(failed ? 1 : 0);
