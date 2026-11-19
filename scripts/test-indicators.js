#!/usr/bin/env node
"use strict";
const { resolve, needIndicatorIds, isSubset } = require("./indicators");
const cases = [
  ["中国10年期国债到期收益率", "cn.cgb.10y.ytm"],
  ["10Y国债", "cn.cgb.10y.ytm"],
  ["10年国债", "cn.cgb.10y.ytm"],
  ["10Y美债", null],
  ["AAA信用利差", "cn.credit.spread.aaa"],
  ["AA信用利差", "cn.credit.spread.aa"],
  ["DXY", "global.dxy.close"],
  ["美元指数", "global.dxy.close"],
  ["DR007", "cn.dr007"],
  ["FR007", null],
  ["核心CPI", "cn.cpi.core.yoy"],
  ["CPI", "cn.cpi.yoy"],
  ["工业增加值", "cn.iva.yoy"],
  ["分行业PPI", "cn.ppi.industry.yoy"]
];
let pass = 0, fail = 0;
for (const [text, want] of cases) {
  const got = resolve({ indicator: text });
  const ok = want ? got === want : got.startsWith("raw:");
  if (ok) { pass++; console.log("  ✓", text, "→", got); }
  else { fail++; console.log("  ✗", text, "→", got, "期望", want); }
}
const a = needIndicatorIds({ spec: { items: [{ indicator: "10Y国债" }, { indicator: "DXY" }] } });
const b = needIndicatorIds({ spec: { items: [{ indicator: "10Y国债" }] } });
if (isSubset(b, a)) { pass++; console.log("  ✓ 子集识别：10Y ⊆ 10Y+DXY"); }
else { fail++; console.log("  ✗ 子集识别失败"); }
console.log("\n通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
