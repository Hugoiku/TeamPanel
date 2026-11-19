#!/usr/bin/env node
/**
 * 真实跑一遍：5 个"员工"进程通过 desk CLI 协作，全部经过 Broker。
 *   node runtime/server/broker.js --port 7801 --root . &
 *   node runtime/server/test/demo.js --case case-2026-001
 * 这不是模拟——文件真写进 vault/，事件真进 ledger。
 */
"use strict";
const { execFile } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "../../..");
const BASE = process.env.DESK_BROKER || "http://127.0.0.1:7801";
const CASE = (process.argv[2] === "--case" ? process.argv[3] : null) || "case-2026-001";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function desk(actor, args) {
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(ROOT, "scripts/desk")].concat(args),
      { env: Object.assign({}, process.env, { DESK_BROKER: BASE, DESK_ACTOR: actor }), timeout: 60000 },
      (err, stdout) => {
        let body = {};
        try { body = JSON.parse(String(stdout || "").trim().split("\n").pop()); } catch (_) {}
        resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0, body });
      });
  });
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function lockAndWrite(actor, rel, content, opts) {
  opts = opts || {};
  const acq = await desk(actor, ["acquire", "--case", CASE, "--path", rel, "--mode", "write",
    "--note", opts.note || rel, "--wait", String(opts.wait || 30), "--ttl", String(opts.ttl || 120)]);
  if (!acq.body.ok) { log("  ! " + actor + " 未拿到锁 " + rel + " " + JSON.stringify(acq.body)); return null; }
  const lock = acq.body.lock.id;
  if (opts.hold) await sleep(opts.hold);
  const rd = await desk(actor, ["peek", "--case", CASE, "--path", rel]);
  const wr = await desk(actor, ["write", "--case", CASE, "--path", rel, "--lock", lock,
    "--expected-version", String(rd.body.version), "--content", content, "--note", opts.note || ""]);
  log("  ✓ " + actor + " 写入 " + rel + " v" + wr.body.version);
  return wr.body;
}
async function readWithLock(actor, rel, ms) {
  const acq = await desk(actor, ["acquire", "--case", CASE, "--path", rel, "--mode", "read",
    "--note", "读取", "--wait", "20"]);
  if (!acq.body.ok) { log("  ! " + actor + " 读锁失败 " + rel); return null; }
  const rd = await desk(actor, ["peek", "--case", CASE, "--path", rel]);
  log("  · " + actor + " 读取 " + rel + " v" + rd.body.version);
  await sleep(ms || 300);
  await desk(actor, ["release", "--lock", acq.body.lock.id]);
  return rd.body;
}
const gate = (actor, id, status, note) => desk(actor,
  ["gate", "--case", CASE, "--gate", id, "--status", status, "--note", note || ""]);

async function main() {
  log("=== 宏观研究员 ===");
  await lockAndWrite("macro", "research/macro.md",
    "# 宏观底稿 v1\n\n政策周期：宽松延续至明年二季度。\n关键分歧：汇率。\n", { hold: 900, note: "宏观底稿" });
  await gate("broker", "G-DATA", "pass", "宏观数据均带来源");

  log("=== 行业研究员（读宏观，再写行业）===");
  await readWithLock("industry", "research/macro.md", 400);
  await lockAndWrite("industry", "research/industry.md",
    "# 行业底稿 v1\n\n高端稳、次高端承压。渠道库存去化到 1.5 个月。\n", { hold: 1200, note: "行业底稿" });

  log("=== 个股研究员（在读行业时，法律顾问来抢读）===");
  const reading = readWithLock("stock", "research/industry.md", 600);
  await sleep(200);
  const blocked = await desk("legal", ["acquire", "--case", CASE, "--path", "research/industry.md",
    "--mode", "read", "--wait", "0.4"]);
  if (blocked.code === 2) log("  · 法律顾问排队等 research/industry.md（队位 " + blocked.body.position + "）");
  else if (blocked.body.ok) {
    log("  · 法律顾问同时拿到读锁（共享读）");
    await desk("legal", ["release", "--lock", blocked.body.lock.id]);
  }
  await reading;

  await lockAndWrite("stock", "research/stock.md",
    "# 个股底稿 v1\n\n护城河：品牌 + 产能稀缺性。估值中枢 1650-1820。\n", { hold: 1400, note: "个股底稿" });

  log("=== 审计：核验前被驳回一次 ===");
  await gate("audit", "G-AUDIT", "fail", "覆盖率 78% < 90%，2 条论断缺来源");
  await sleep(600);
  await lockAndWrite("audit", "review/audit.md",
    "# 审计报告 v2\n\n覆盖率 94%，0 条缺来源。\n", { hold: 500, note: "审计 v2" });
  await gate("audit", "G-AUDIT", "pass", "覆盖率 94%");

  log("=== 法律顾问 ===");
  await lockAndWrite("legal", "review/legal.md",
    "# 法律意见 v1\n\n无内幕信息与绝对化表述，免责声明已加。\n", { hold: 600, note: "法律意见" });
  await gate("broker", "G-LEGAL", "pass", "无 BLOCK 级表述");

  log("=== 交易员 ===");
  await readWithLock("trader", "research/stock.md", 300);
  await lockAndWrite("trader", "trade/plan.md",
    "# 交易计划 v1\n\n目标仓位 5%，止损 1580 / 1520，分两档建仓。\n", { hold: 500, note: "交易计划" });

  log("=== 完成 ===");
}
main().catch(e => { console.error(e); process.exit(1); });
