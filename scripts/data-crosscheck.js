#!/usr/bin/env node
"use strict";
/**
 * data-crosscheck — 核心宏观多源交叉校验（确定性，不调用模型）。
 *
 * 只在 metric.crossCheck.enabled 时启用；比较主源与备用源的共同 period：
 * - 差异超过 absTolerance 或相对 relTolerance → mismatch；
 * - 无共同 period → insufficient（不阻断，只提示无法交叉校验）；
 * - 备用源不可用由 data-worker 标 unavailable（不阻断主源）。
 */
function normPeriod(metric, p) {
  const s = String(p || "");
  const freq = String((metric && metric.frequency) || "monthly").toLowerCase();
  if (freq === "daily") return s.slice(0, 10);
  return s.slice(0, 7);
}
function compare(metric, primary, secondary, opts) {
  const cfg = (metric && metric.crossCheck) || {};
  const absTol = Number(cfg.absTolerance || 0);
  const relTol = Number(cfg.relTolerance || 0);
  const maxPeriods = Math.max(1, Number(cfg.maxPeriods || 6));
  const secMap = new Map();
  (Array.isArray(secondary) ? secondary : []).forEach(r => {
    if (!r || r.period === undefined) return;
    const v = Number(r.value);
    if (!Number.isFinite(v)) return;
    secMap.set(normPeriod(metric, r.period), v);
  });
  const common = (Array.isArray(primary) ? primary : [])
    .map(r => ({ period: normPeriod(metric, r && r.period), value: Number(r && r.value) }))
    .filter(r => Number.isFinite(r.value) && secMap.has(r.period))
    .sort((a, b) => a.period.localeCompare(b.period))
    .slice(-maxPeriods);
  if (!common.length) {
    return { ok: true, status: "insufficient", compared: 0,
      issues: ["主源与交叉源没有共同 period，无法交叉校验"], tolerance: { absTol, relTol } };
  }
  const issues = [];
  for (const r of common) {
    const s = secMap.get(r.period);
    const diff = Math.abs(r.value - s);
    const tol = Math.max(absTol, Math.abs(r.value) * relTol);
    if (diff > tol) {
      issues.push(r.period + "：主源 " + r.value + " vs 交叉源 " + s +
        "（差 " + Number(diff.toFixed(6)) + " > 容差 " + Number(tol.toFixed(6)) + "）");
    }
  }
  return {
    ok: issues.length === 0,
    status: issues.length ? "mismatch" : "match",
    compared: common.length,
    issues,
    latestCommon: common[common.length - 1].period,
    tolerance: { absTol, relTol }
  };
}
module.exports = { compare, normPeriod };
