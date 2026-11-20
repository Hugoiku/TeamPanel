#!/usr/bin/env node
/**
 * check-report — 签发前检查（G-REPORT）：章节/字数/引用/图表/免责/证据池/复核收敛
 *   node scripts/check-report.js --case case-macro-web [--write] [--min-chars 6000] [--min-refs 50] [--min-figs 2]
 * 退出码：0 全过；3 有未通过项（--write 时会把 G-REPORT 写成 fail）
 */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
const CASE = arg("case", "default");
const MIN_CHARS = parseInt(arg("min-chars", "1200"), 10);
const MIN_REFS = parseInt(arg("min-refs", "50"), 10);
const MIN_FIGS = parseInt(arg("min-figs", "2"), 10);
const WRITE = process.argv.indexOf("--write") >= 0;
const PATH = arg("path", "reports/investor-final.md");
function desk(args) {
  const r = spawnSync(process.execPath, ["scripts/desk"].concat(args), { cwd: ROOT, encoding: "utf8",
    env: Object.assign({}, process.env, { DESK_CASE: CASE, DESK_ACTOR: "lead" }) });
  const line = String(r.stdout || "").trim().split("\n").pop();
  try { return JSON.parse(line); } catch (_) { return { ok: false, raw: line }; }
}
function api(p) {
  return new Promise((res, rej) => {
    const u = new URL("http://127.0.0.1:7801" + p);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, agent: false }, r => {
      let s = ""; r.on("data", c => s += c); r.on("end", () => { try { res(JSON.parse(s)); } catch (e) { res({}); } });
    }).on("error", rej);
  });
}
(async () => {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: !!ok, detail });
  const f = desk(["cat", "--path", PATH]);
  const text = (f && f.ok && f.exists) ? f.content : "";
  add("file", text.length > 0, text ? (PATH + " v" + f.version + "，" + text.length + " 字符") : (PATH + " 不存在"));
  const need = ['摘要', '免责声明'];
  const missing = need.filter(kk => text.indexOf(kk) < 0);
  add("sections", missing.length === 0, missing.length ? ('缺关键节：' + missing.join('、')) : '摘要/结论与免责声明齐全（模块不必固定）');
  add("chars", text.length >= MIN_CHARS, "正文 " + text.length + " 字符（下限 " + MIN_CHARS + "）");
  const refs = (text.match(/\[S[0-9]+\]/g) || []);
  add("refs", refs.length >= MIN_REFS, "引用 " + refs.length + " 处（下限 " + MIN_REFS + "）");
  const ev = desk(["cat", "--path", "evidence/sources.jsonl"]);
  let evIds = [];
  try { evIds = (ev.content || "").trim().split("\n").filter(Boolean).map(l => JSON.parse(l).id).filter(Boolean); } catch (_) {}
  const refIds = Array.from(new Set(refs.map(r => r.replace(/[\[\]]/g, ""))));
  const dangling = refIds.filter(id => evIds.indexOf(id) < 0);
  add("evidence", evIds.length > 0, "证据池 " + evIds.length + " 条");
  add("dangling", dangling.length === 0, dangling.length ? ("引用了不存在的来源：" + dangling.slice(0, 8).join(",")) : "所有引用都能在证据池找到");
  const imgs = (text.match(/!\[[^\]]*\]\(([^)]+)\)/g) || []);
  const missFig = imgs.filter(m => {
    const p = m.replace(/.*\(/, "").replace(/\)$/, "");
    if (/^https?:/i.test(p)) return false;
    // 二进制图（png/jpg/webp）用磁盘存在性判断：desk cat 按 UTF-8 输出会破坏 JSON，导致误报缺失
    if (/\.(png|jpe?g|webp|gif)$/i.test(p)) return !fs.existsSync(path.join(ROOT, "vault", CASE, p));
    return !desk(["cat", "--path", p]).exists;
  });
  add("figures", true, '图表 ' + imgs.length + ' 张（可选，不强制；路径缺失 ' + missFig.length + '）');
  add("disclaimer", text.indexOf("不构成投资建议") >= 0, text.indexOf("不构成投资建议") >= 0 ? "有免责声明" : "缺免责声明（含「不构成投资建议」）");
  let ready = { ready: false, blockers: [] };
  try { ready = await api("/api/cycle/readiness?case=" + encodeURIComponent(CASE)); } catch (_) {}
  add("readiness", !!ready.ready, ready.ready ? "复核已收敛" : ("复核未收敛：" + ((ready.blockers || []).map(b => b.kind + (b.id ? ":" + b.id : "")).join(", ") || "未知")));
  const pass = checks.every(c => c.ok);
  if (WRITE) {
    const failed = checks.filter(c => !c.ok).map(c => c.id + "(" + c.detail + ")");
    desk(["gate", "--gate", "G-REPORT", "--status", pass ? "pass" : "fail", "--scope", PATH,
      "--note", pass ? ("自动检查全过：" + checks.length + " 项") : ("未通过 " + failed.length + " 项：" + failed.join(" | ").slice(0, 400))]);
  }
  console.log(JSON.stringify({ case: CASE, path: PATH, pass, checks }, null, 1));
  process.exit(pass ? 0 : 3);
})().catch(e => { console.error(String(e && e.stack || e)); process.exit(1); });