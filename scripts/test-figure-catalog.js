#!/usr/bin/env node
"use strict";
const assert = require("assert");
const c = require("./figure-catalog");
assert.strictEqual(c.titleFor("fig-nim-trend.svg"), "NIM 趋势");
assert.strictEqual(c.titleFor("macro-credit-spread.svg"), "信用利差");
assert.strictEqual(c.placementFor("macro-rate.svg"), "macro");
assert.strictEqual(c.placementFor("industry-nim.svg"), "industry");
assert.strictEqual(c.placementFor("cmb-nim.svg"), "company");
assert.strictEqual(c.placementFor("fig-npl.svg"), "figures");
console.log("ALL PASS test-figure-catalog");
