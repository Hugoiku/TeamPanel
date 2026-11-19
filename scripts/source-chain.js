#!/usr/bin/env node
"use strict";
/**
 * source-chain — 指标 -> 数据源 fallback 链。
 *
 * 规则：
 * - metric.sources 的数组顺序就是 fallback 顺序（免费源在前，积分/账号源在后）；
 * - 没有显式 sources 时，按 capabilities 匹配并按 priority 排序；
 * - 只保留结构化来源（structured !== false），draft 来源跳过；
 * - 用 source-health 过滤掉不可用来源，并把原因带回去给面板/缺口展示。
 */
const sourceHealth = require("./source-health");

function metricSources(metric, sources) {
  const hasExplicit = !!(metric && Array.isArray(metric.sources));
  const ids = hasExplicit ? metric.sources : [];
  if (hasExplicit) {
    // 显式 sources: [] 表示“明确没有可用来源”，不能再按 capability 模糊匹配到通用源。
    const byId = new Map((sources || []).map(s => [s.id, s]));
    return ids.map(id => byId.get(id)).filter(Boolean);
  }
  const mid = String((metric && metric.id) || "");
  return (sources || [])
    .filter(s => (s.capabilities || []).some(c => c === mid || (mid && mid.startsWith(c + "."))))
    .sort((a, b) => (a.priority || 99) - (b.priority || 99));
}

function buildChain(metric, sources, opts) {
  const o = opts || {};
  const health = o.health || sourceHealth;
  const structuredOnly = o.structuredOnly !== false;
  const chain = [], skipped = [];
  // 显式 sources 里引用了未注册来源时，也要留下原因，不能静默消失。
  if (metric && Array.isArray(metric.sources)) {
    const known = new Set((sources || []).map(s => s.id));
    for (const id of metric.sources) if (!known.has(id)) skipped.push({ id, reason: "来源未在 config/data/sources.json 注册" });
  }
  for (const s of metricSources(metric, sources)) {
    if (!s || !s.id) continue;
    if (structuredOnly && s.structured === false) { skipped.push({ id: s.id, reason: "非结构化来源，不能直接建数据任务" }); continue; }
    if (s.status === "draft") { skipped.push({ id: s.id, reason: "来源已注册但未启用" }); continue; }
    let h;
    try { h = health.getHealth(s, o); } catch (e) { h = { available: false, reason: String((e && e.message) || e) }; }
    if (h && h.available === false) { skipped.push({ id: s.id, reason: h.reason || "不可用", tier: h.tier || sourceHealth.tierOf(s) }); continue; }
    chain.push(s.id);
  }
  return { chain, skipped };
}

function summarizeSkipped(skipped, max) {
  const list = Array.isArray(skipped) ? skipped : [];
  if (!list.length) return "";
  const n = max || 4;
  const head = list.slice(0, n).map(s => s.id + "：" + String(s.reason || "不可用").slice(0, 80)).join("；");
  return head + (list.length > n ? "；等 " + list.length + " 个" : "");
}

function noSourceReason(skipped, metric) {
  const list = Array.isArray(skipped) ? skipped : [];
  const base = "无可用数据源";
  const detail = summarizeSkipped(list);
  const onlyOptional = list.length > 0 && list.every(s => s.tier === "credit" || s.tier === "account");
  const hint = !list.length
    ? "该指标尚未配置数据源；可上传 CSV/Excel，或先在 config/data/sources.json 注册来源"
    : (onlyOptional
      ? "该指标暂无免费公开源；可上传 CSV/Excel，或配置可选积分源（Tushare，需积分）后重试"
      : "可上传 CSV/Excel，或在面板「数据源」中配置免费凭据/免费 Key 后重试");
  return base + (detail ? "（" + detail + "）" : "") + "。" + hint + (metric && metric.id ? "；指标：" + metric.id : "");
}

module.exports = { metricSources, buildChain, summarizeSkipped, noSourceReason };
