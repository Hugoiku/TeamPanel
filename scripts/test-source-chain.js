#!/usr/bin/env node
"use strict";
/**
 * test-source-chain — 数据源能力分层 / 免费优先 fallback 链的单元测试（不联网）。
 *   node scripts/test-source-chain.js
 */
const assert = require("assert");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const health = require("./source-health");
const chain = require("./source-chain");

let passed = 0, failed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log("  PASS " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + " :: " + String((e && e.message) || e)); }
}
function src(id, access, extra) { return Object.assign({ id, name: id, access, structured: true }, extra || {}); }

console.log("=== source-health 能力分层 ===");
ok("free 源无需凭据即可用", () => {
  const r = health.staticCheck(src("f", { tier: "free" }));
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.tier, "free");
});
ok("credit 源缺 token 时不可用并说明缺什么", () => {
  const r = health.staticCheck(src("t", { tier: "credit", auth: "token", secret: "runtime/secrets/tushare.json", env: ["TUSHARE_TOKEN"], minPoints: 2000 }), { hasSecret: false });
  assert.strictEqual(r.available, false);
  assert.ok(/未配置凭据/.test(r.reason), r.reason);
  assert.ok(/tushare\.json/.test(r.reason), r.reason);
});
ok("free-key 源缺 key 时不可用并给出申请地址", () => {
  const r = health.staticCheck(src("k", { tier: "free-key", auth: "token", secret: "runtime/secrets/fred.json", homepage: "https://fred.stlouisfed.org/docs/api/api_key.html" }), { hasSecret: false });
  assert.strictEqual(r.available, false);
  assert.ok(/fred\.json/.test(r.reason), r.reason);
  assert.ok(/fred\.stlouisfed\.org/.test(r.reason), r.reason);
});
ok("account 源默认不启用", () => {
  const r = health.staticCheck(src("a", { tier: "account", auth: "account" }));
  assert.strictEqual(r.available, false);
  assert.ok(/账号/.test(r.reason), r.reason);
});
ok("tier 推断：无 access 视为 free，auth=token 视为 token", () => {
  assert.strictEqual(health.tierOf({ id: "x" }), "free");
  assert.strictEqual(health.tierOf({ id: "x", auth: "token" }), "token");
});

console.log("=== metricSources 顺序 ===");
const reg = health.loadRegistry();
ok("显式 sources 数组顺序 = fallback 顺序（不被 priority 重排）", () => {
  const m = { id: "macro.m1_yoy", sources: ["eastmoney-money-m1", "tushare-cn-m1"] };
  const list = chain.metricSources(m, reg);
  assert.deepStrictEqual(list.map(s => s.id), ["eastmoney-money-m1", "tushare-cn-m1"]);
});
ok("没有显式 sources 时按 capabilities + priority 匹配", () => {
  const sources = [
    { id: "b", capabilities: ["x.y"], priority: 2, structured: true },
    { id: "a", capabilities: ["x.y"], priority: 1, structured: true }
  ];
  assert.deepStrictEqual(chain.metricSources({ id: "x.y" }, sources).map(s => s.id), ["a", "b"]);
});
ok("显式 sources: [] 不会被 capability 模糊匹配到通用源", () => {
  const sources = [{ id: "stats", capabilities: ["macro"], structured: true }];
  assert.deepStrictEqual(chain.metricSources({ id: "macro.credit_spread", sources: [] }, sources), []);
});

console.log("=== buildChain fallback ===");
ok("不可用源被跳过，链保留可用源与原因", () => {
  const sources = [src("bad", { tier: "credit" }), src("good", { tier: "free" })];
  const fakeHealth = { getHealth: s => s.id === "bad" ? { available: false, reason: "未配置 token", tier: "credit" } : { available: true, tier: "free" } };
  const r = chain.buildChain({ id: "x", sources: ["bad", "good"] }, sources, { health: fakeHealth });
  assert.deepStrictEqual(r.chain, ["good"]);
  assert.strictEqual(r.skipped.length, 1);
  assert.ok(/token/.test(r.skipped[0].reason));
});
ok("draft 与非结构化来源被跳过", () => {
  const sources = [src("d", { tier: "free" }, { status: "draft" }), src("w", { tier: "free" }, { structured: false }), src("ok", { tier: "free" })];
  const fakeHealth = { getHealth: () => ({ available: true, tier: "free" }) };
  const r = chain.buildChain({ id: "x", sources: ["d", "w", "ok"] }, sources, { health: fakeHealth });
  assert.deepStrictEqual(r.chain, ["ok"]);
  assert.strictEqual(r.skipped.length, 2);
});
ok("全部不可用时给出可上传/可配置的明确提示", () => {
  const skipped = [{ id: "tushare-dr007", reason: "未配置凭据", tier: "credit" }];
  const msg = chain.noSourceReason(skipped, { id: "macro.dr007" });
  assert.ok(/上传 CSV/.test(msg), msg);
  assert.ok(/暂无免费公开源/.test(msg), msg);
  assert.ok(/macro\.dr007/.test(msg), msg);
});
ok("有免费源失败时提示配置免费凭据而不是只说积分源", () => {
  const skipped = [{ id: "mofcom-tsf", reason: "HTTP 500", tier: "free" }];
  const msg = chain.noSourceReason(skipped, { id: "macro.tsf" });
  assert.ok(/免费凭据/.test(msg), msg);
});

console.log("=== 真实 registry 的免费优先约束 ===");
const byId = new Map(reg.map(s => [s.id, s]));
ok("每个 metric 的 sources 都存在于 registry", () => {
  const mj = JSON.parse(require("fs").readFileSync(path.join(ROOT, "config/data/metrics.json"), "utf8"));
  for (const m of mj.metrics || []) {
    for (const id of m.sources || []) assert.ok(byId.has(id), m.id + " -> 未知来源 " + id);
  }
});
ok("核心通用指标首源不是积分源（免费或免费 Key 优先）", () => {
  const mj = JSON.parse(require("fs").readFileSync(path.join(ROOT, "config/data/metrics.json"), "utf8"));
  const mustFreeFirst = ["macro.tsf", "macro.m1_yoy", "macro.m2_yoy", "rates.lpr_1y", "rates.shibor_1w", "rates.us10y"];
  for (const id of mustFreeFirst) {
    const m = (mj.metrics || []).find(x => x.id === id);
    assert.ok(m, "缺少 metric " + id);
    assert.ok((m.sources || []).length, id + " 没有 sources");
    const first = byId.get(m.sources[0]);
    assert.ok(first, id + " 首源不存在");
    const tier = health.tierOf(first);
    assert.ok(tier === "free" || tier === "free-key", id + " 首源是 " + tier + "，不是免费源");
  }
});
ok("没有免费源的指标必须显式标注并允许上传（sources 只含可选积分源）", () => {
  const mj = JSON.parse(require("fs").readFileSync(path.join(ROOT, "config/data/metrics.json"), "utf8"));
  for (const id of ["macro.dr007", "rates.repo7"]) {
    const m = (mj.metrics || []).find(x => x.id === id);
    assert.ok(m, "缺少 metric " + id);
    const tiers = (m.sources || []).map(sid => health.tierOf(byId.get(sid)));
    assert.ok(tiers.every(t => t === "credit"), id + " 应只有可选积分源");
    assert.ok(/上传 CSV/.test(m.sourceNote || ""), id + " 缺少上传提示");
  }
});

console.log("\n" + JSON.stringify({ ok: failed === 0, passed, failed }));
process.exit(failed ? 1 : 0);
