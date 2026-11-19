#!/usr/bin/env node
"use strict";
const dt = require("./datatask");
const dq = require("./data-quality");
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra === undefined ? "" : JSON.stringify(extra)); }
}
function need() {
  return { id: "N325", title: "缺招行H股前复权价格、分红序列与官方HKD/CNY中间价",
    spec: { items: [
      { indicator: "招商银行H股前复权收盘价", definition: "03968.HK 日频前复权收盘价", source: "港交所", frequency: "日", range: "2021-01-01至2026-11-17", unit: "港元", format: "CSV: date,close_adj_hkd" },
      { indicator: "招商银行每股现金分红与除净日", definition: "每股现金分红", source: "公告", frequency: "年度/半年度", range: "2021-2025", unit: "港元/人民币", format: "CSV: year,ex_date,dps,currency" },
      { indicator: "HKD/CNY官方中间价", definition: "中国外汇交易中心", source: "CFETS", frequency: "日", range: "2021-01-01至2026-11-17", unit: "人民币/港元", format: "CSV: date,hkd_cny_mid" },
      { indicator: "港股通红利税税率", definition: "适用税率及扣缴规则", source: "财政部", frequency: "一次性确认", range: "现行", unit: "%", format: "文本说明" }
    ] } };
}
const contract = dt.buildContract(need());
ok("契约 4 项", contract.items.length === 4, contract.items.length);
ok("日频 expected > 1000", contract.items[0].expected > 1000, contract.items[0].expected);
ok("年度事件 expected 5", contract.items[1].expected === 5, contract.items[1].expected);
ok("文本 expected 1", contract.items[3].expected === 1, contract.items[3].expected);
ok("日频 periodType daily", contract.items[0].periodType === "daily", contract.items[0].periodType);

const monthly = { id: "N1", title: "月频测试", spec: { items: [
  { indicator: "M1", definition: "月频值", frequency: "月", range: "2026-01至2026-03", unit: "亿元", format: "CSV: period,value" }
] } };
const mc = dt.buildContract(monthly);
const mkCand = (period, value, unit, extra) => Object.assign({ id: "C" + period, itemIndex: 0, value: String(value), period, unit: unit || "亿元", sourceUrl: "https://example.com/a", locator: { page: 1 }, status: "pending" }, extra || {});
const NOW = Date.parse("2026-04-15T00:00:00Z");
let cov = dt.computeCoverage(mc, [mkCand("2026-01", 1), mkCand("2026-02", 2), mkCand("2026-03", 3)], NOW);
ok("3/3 月频 pass", cov.items[0].gate === "pass" && cov.ready, cov.items[0]);
cov = dt.computeCoverage(mc, [mkCand("2026-01", 1)], NOW);
ok("1/3 月频 fail", cov.items[0].gate === "fail", cov.items[0]);
cov = dt.computeCoverage(mc, [mkCand("2026-01", 1, "元"), mkCand("2026-02", 2, "元"), mkCand("2026-03", 3, "元")], NOW);
ok("单位不一致 fail", cov.items[0].gate === "fail", cov.items[0]);
cov = dt.computeCoverage(mc, [mkCand("2026-01", 1), mkCand("2026-02", 2), mkCand("2026-03", 3, undefined, { locator: null, snapshotPath: "" })], NOW);
ok("缺 locator warn", cov.items[0].gate === "warn", cov.items[0]);
const qualityFn = (item, cands) => dq.check({ frequency: item.periodType, unit: item.unit },
  cands.map(c => ({ period: c.period, value: c.value, unit: c.unit })), { now: NOW });
cov = dt.computeCoverage(mc, [mkCand("2026-01", 1), mkCand("2026-01", 1), mkCand("2026-02", 2), mkCand("2026-03", 3)], NOW, [], qualityFn);
ok("质量门禁重复 period fail", cov.items[0].gate === "fail", cov.items[0]);

ok("periodKey 日", dt.periodKey("2026-11-14", "daily") === "2026-11-14");
ok("periodKey 月", dt.periodKey("2026-3", "monthly") === "2026-03");
ok("periodKey 年", dt.periodKey("2024-06-30", "event") === "2024");

const r1 = { itemIndex: 2, name: "HKD/CNY官方中间价", value: "0.91", period: "2026-11-14", unit: "人民币/港元", sourceUrl: "https://example.com" };
ok("record 按 itemIndex 匹配", dt.matchRecordToItem(r1, contract) === 2, dt.matchRecordToItem(r1, contract));
ok("candidate 映射", dt.candidateFromRecord(r1, contract.items[2], { id: "DS1", ref: "https://example.com" }, "DT1", "DA1").itemIndex === 2);

const key1 = dt.attemptKey([{ kind: "url", ref: "https://a.com" }], "web.agent", "", dt.contractHash(contract));
const key2 = dt.attemptKey([{ kind: "url", ref: "https://a.com" }], "web.agent", "", dt.contractHash(contract));
const key3 = dt.attemptKey([{ kind: "url", ref: "https://b.com" }], "web.agent", "", dt.contractHash(contract));
ok("attemptKey 相同", key1 === key2);
ok("attemptKey 换来源不同", key1 !== key3);

ok("内网阻断", dt.checkSource({ kind: "url", ref: "http://127.0.0.1/x" }, {}).ok === false);
ok("http 允许", dt.checkSource({ kind: "url", ref: "https://example.com/x" }, {}).ok === true);
ok("URL 尾部分号清理", dt.checkSource({ kind: "url", ref: "https://example.com/x;" }, {}).ref === "https://example.com/x");
ok("域名白名单", dt.checkSource({ kind: "url", ref: "https://example.com/x" }, { allowedDomains: ["example.com"] }).ok === true);
ok("域名不在白名单", dt.checkSource({ kind: "url", ref: "https://evil.com/x" }, { allowedDomains: ["example.com"] }).ok === false);
ok("文件路径穿越阻断", dt.checkSource({ kind: "file", ref: "../x.csv" }, {}).ok === false);
ok("文件类型允许", dt.checkSource({ kind: "file", ref: "uploads/a.csv" }, {}).ok === true);

ok("ready nextAction confirm", dt.nextAction({ attempts: [], policy: { maxAttempts: 3 } }, { ready: true }) === "confirm");
ok("未 ready 可重试", dt.nextAction({ attempts: [{}], policy: { maxAttempts: 3 } }, { ready: false }) === "add_source_or_retry");
ok("尝试耗尽 needs_human", dt.nextAction({ attempts: [{}, {}, {}], policy: { maxAttempts: 3 } }, { ready: false }) === "needs_human");

console.log("\n通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
