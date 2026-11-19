#!/usr/bin/env node
"use strict";
/**
 * source-policy — 凭据/配额/成本/适用性策略。
 *   - 不读明文 token；
 *   - 只判断“这个源在当前任务里是否允许使用”；
 *   - 付费/积分源需要显式 allowPaid。
 */
const health = require("./source-health");
const usage = require("./source-usage");

function costOf(src) {
  const a = (src && src.access) || {};
  const c = a.cost || {};
  return {
    unit: String(c.unit || a.costUnit || "call"),
    perCall: Math.max(0, Number(c.perCall !== undefined ? c.perCall : (a.costPerCall || 0)) || 0),
    dailyQuota: Math.max(0, Number(c.dailyQuota || a.dailyQuota || 0) || 0)
  };
}
function tierOf(src) { return health.tierOf(src); }
function checkSource(src, opts) {
  const o = opts || {};
  const h = health.getHealth(src, { hasSecret: o.hasSecret });
  const tier = h.tier || tierOf(src);
  const cost = costOf(src);
  if (h.available === false) {
    const reason = h.reason || "来源不可用";
    const code = (tier === "account" || /未配置凭据|需要账号|token|API key|积分|权限/i.test(reason))
      ? "needs_credential" : "unavailable";
    return { ok: false, code, sourceId: src && src.id, tier,
      reason, homepage: ((src && src.access) || {}).homepage || "", cost };
  }
  if ((tier === "credit" || tier === "token" || tier === "account" || tier === "free-key") && o.allowCredential !== true) {
    // 已配置凭据的源默认允许；未配置的源由 health 判为 unavailable。
    if (tier === "account") return { ok: false, code: "needs_credential", sourceId: src && src.id, tier,
      reason: h.reason || "需要账号登录", homepage: ((src && src.access) || {}).homepage || "", cost };
  }
  if ((tier === "credit" || cost.perCall > 0) && o.allowPaid !== true) {
    return { ok: false, code: "needs_paid_approval", sourceId: src && src.id, tier,
      reason: "该来源需要积分/付费调用；需显式 allowPaid=true", cost };
  }
  if (cost.dailyQuota > 0 && usage.usedToday(src.id) + cost.perCall > cost.dailyQuota) {
    return { ok: false, code: "quota_exhausted", sourceId: src && src.id, tier,
      reason: "今日配额已用尽：" + usage.usedToday(src.id) + "/" + cost.dailyQuota, cost };
  }
  return { ok: true, sourceId: src && src.id, tier, reason: "", cost,
    structured: src && src.structured !== false, homepage: ((src && src.access) || {}).homepage || "" };
}
function coverageAllows(src, metric, opts) {
  const o = opts || {};
  const cov = src && src.coverage;
  if (src && src.status === "draft") return { ok: false, code: "draft", reason: "来源仍是草稿，未启用" };
  if (o.requireStructured && src && src.structured === false) {
    return { ok: false, code: "not_structured", reason: "来源只能抓文本，不能直接产出结构化 records" };
  }
  if (!cov || !Array.isArray(cov.metrics) || !cov.metrics.length) return { ok: true, code: "", reason: "" };
  const mid = metric && metric.id;
  if (mid && cov.metrics.indexOf(mid) < 0) {
    return { ok: false, code: "coverage_mismatch", reason: "来源未声明覆盖指标 " + mid };
  }
  return { ok: true, code: "", reason: "" };
}
function selectSource(metric, sources, opts) {
  const o = opts || {};
  const ids = Array.isArray(metric && metric.sources) ? metric.sources : [];
  const list = Array.isArray(sources) ? sources : [];
  const ordered = ids.length ? ids.map(id => list.find(s => s.id === id || s.configSource === id)).filter(Boolean)
    : list.filter(s => s.status !== "draft");
  const skipped = [];
  for (const s of ordered) {
    const cov = coverageAllows(s, metric, o);
    if (!cov.ok) {
      skipped.push({ sourceId: s.id, code: cov.code, reason: cov.reason, tier: tierOf(s) });
      continue;
    }
    const c = checkSource(s, o);
    if (c.ok) return { source: s, check: c, skipped };
    skipped.push({ sourceId: s.id, code: c.code, reason: c.reason, tier: c.tier });
    if (c.code === "needs_credential" || c.code === "needs_paid_approval") return { source: null, check: c, skipped };
  }
  return { source: null, check: null, skipped };
}
module.exports = { costOf, checkSource, selectSource };
