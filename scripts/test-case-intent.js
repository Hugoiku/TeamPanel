#!/usr/bin/env node
"use strict";
/** test-case-intent — 新 case 自然语言意图抽取（规则层）。 */
const assert = require("assert");
const { parse } = require("./case-intent");

const a = parse("评估招商银行的投资价值");
assert.strictEqual(a.ticker, "招商银行");
assert.strictEqual(a.kind, "个股");
assert.strictEqual(a.ambiguous, false);
assert.strictEqual(a.mandate, "评估招商银行的投资价值");

const b = parse("AI短剧行业 2026 年投资机会");
assert.strictEqual(b.ticker, "AI短剧");
assert.strictEqual(b.kind, "行业");
assert.strictEqual(b.ambiguous, false);

const c = parse("600519 贵州茅台 估值");
assert(c.ticker.indexOf("600519") === 0, c.ticker);
assert.strictEqual(c.kind, "个股");

const d = parse("随便看看");
assert.strictEqual(d.ambiguous, true);
assert(Array.isArray(d.options) && d.options.length > 1);

console.log("ALL PASS test-case-intent");
