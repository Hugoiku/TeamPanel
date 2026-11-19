#!/usr/bin/env node
"use strict";
/**
 * data-quality — 自动采集 records 的确定性质量门禁（不调用模型）。
 *
 * 检查：非空 / period 格式 / 重复 / 升序 / 周期连续 / 单位 / 新鲜度。
 * 任何结构性失败或过期 → ok=false，broker 会把缺口置为 needs_review，而不是自动关闭。
 * 新鲜度阈值可在 metrics.json 用 maxStalenessDays / maxStalenessMonths 覆盖。
 */
function pad2(x) { return String(x).padStart(2, "0"); }
function uniq(a) { return Array.from(new Set(a)); }
function parseYM(p) {
  const m = String(p || "").match(/^(\d{4})-(\d{2})$/);
  return m ? { y: Number(m[1]), m: Number(m[2]) } : null;
}
function monthIndex(ym) { const x = parseYM(ym); return x ? x.y * 12 + (x.m - 1) : null; }
function monthLabel(idx) { return String(Math.floor(idx / 12)) + "-" + pad2((idx % 12) + 1); }
function monthsBetween(latest, now) {
  const a = monthIndex(latest); if (a === null) return 0;
  const b = now.getFullYear() * 12 + now.getMonth();
  return Math.max(0, b - a);
}
function daysBetween(latest, now) {
  const d = Date.parse(String(latest) + "T00:00:00Z");
  if (!Number.isFinite(d)) return 0;
  return Math.max(0, Math.floor((now.getTime() - d) / 86400000));
}
function expectedMonthly(first, last, step) {
  const a = monthIndex(first), b = monthIndex(last);
  if (a === null || b === null || b < a) return [];
  const out = [];
  for (let i = a; i <= b; i += (step || 1)) out.push(monthLabel(i));
  return out;
}

function check(metric, records, opts) {
  const o = opts || {};
  const now = o.now ? new Date(o.now) : new Date();
  const m = metric || {};
  const freq = String(m.frequency || "monthly").toLowerCase();
  const checks = [], issues = [];
  const add = (id, label, ok, detail) => {
    checks.push({ id, label, ok: !!ok, detail: detail || "" });
    if (!ok) issues.push(detail || label);
  };
  const arr = (Array.isArray(records) ? records : [])
    .filter(r => r && r.period !== undefined && Number.isFinite(Number(r.value)))
    .map(r => ({ period: String(r.period), value: Number(r.value), unit: r.unit === undefined ? "" : String(r.unit) }));
  add("nonempty", "有记录", arr.length > 0, arr.length ? arr.length + " 条" : "没有 records");
  if (!arr.length) {
    return { ok: false, structural: false, fresh: false, checks, issues,
      latestPeriod: "", dataAsOf: "", stale: true, staleDetail: "没有 records" };
  }

  const sorted = arr.slice().sort((a, b) => a.period.localeCompare(b.period));
  const periods = sorted.map(r => r.period);
  const dup = uniq(periods.filter((p, i) => i > 0 && p === periods[i - 1]));
  add("duplicate", "period 不重复", dup.length === 0, dup.length ? "重复 period：" + dup.slice(0, 5).join(", ") : "");

  const fmt = freq === "daily" ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}$/;
  const badFmt = periods.filter(p => !fmt.test(p));
  add("period_format", "period 格式符合频率", badFmt.length === 0,
    badFmt.length ? "非法 period：" + badFmt.slice(0, 5).join(", ") : "频率 " + freq);

  if (m.unit) {
    const badUnit = sorted.filter(r => r.unit !== String(m.unit));
    add("unit", "单位与指标定义一致", badUnit.length === 0,
      badUnit.length ? "单位不一致：" + uniq(badUnit.map(r => r.unit || "空")).slice(0, 3).join("/") + "，应为 " + m.unit : "单位 " + m.unit);
  }

  if (freq === "monthly" || freq === "quarterly") {
    const step = freq === "quarterly" ? 3 : 1;
    const expected = expectedMonthly(periods[0], periods[periods.length - 1], step);
    const missing = expected.filter(p => periods.indexOf(p) < 0);
    add("continuity", "周期连续", missing.length === 0,
      missing.length ? "缺 " + missing.length + " 期：" + missing.slice(0, 6).join(", ") : expected.length + " 期连续");
  }

  add("sorted", "period 升序", periods.every((p, i) => i === 0 || p > periods[i - 1]), "");

  const latest = periods[periods.length - 1];
  let stale = false, staleDetail = "";
  if (freq === "daily") {
    const maxDays = Number(m.maxStalenessDays || 7);
    const d = daysBetween(latest, now);
    stale = d > maxDays;
    staleDetail = "数据截至 " + latest + "，落后 " + d + " 天（阈值 " + maxDays + " 天）";
  } else {
    const maxMonths = Number(m.maxStalenessMonths || (freq === "quarterly" ? 6 : 2));
    const d = monthsBetween(latest, now);
    stale = d > maxMonths;
    staleDetail = "数据截至 " + latest + "，落后 " + d + " 个月（阈值 " + maxMonths + " 个月）";
  }
  add("freshness", "数据新鲜度", !stale, staleDetail);

  const structural = checks.filter(c => c.id !== "freshness").every(c => c.ok);
  return {
    ok: structural && !stale,
    structural, fresh: !stale,
    checks, issues,
    latestPeriod: latest, dataAsOf: latest,
    stale, staleDetail,
    frequency: freq, count: arr.length,
    firstPeriod: periods[0], lastPeriod: latest
  };
}

module.exports = { check };
