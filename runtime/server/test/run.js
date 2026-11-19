#!/usr/bin/env node
/**
 * M1 验收测试：3 个真实进程抢同一把写锁 + 共享读 + 写优先 + 租约回收 + 版本 CAS。
 *   node runtime/server/test/run.js
 */
"use strict";
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../../..");
const TMP = path.join(ROOT, "runtime/test-tmp");
const PORT = 7851 + Math.floor(Math.random() * 100);
const BASE = "http://127.0.0.1:" + PORT;
const CASE = "case-test";
const FILE = "research/note.md";

const passes = [], fails = [];
const ok = (cond, msg) => { (cond ? passes : fails).push(msg); console.log((cond ? "  ✓ " : "  ✗ ") + msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function desk(args, timeoutMs) {
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(ROOT, "scripts/desk")].concat(args),
      { env: Object.assign({}, process.env, { DESK_BROKER: BASE }), timeout: timeoutMs || 40000 },
      (err, stdout) => {
        let body = {};
        try { body = JSON.parse(String(stdout || "").trim().split("\n").pop()); } catch (_) {}
        resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0, body });
      });
  });
}
function httpGet(p) {
  return new Promise((resolve, reject) => {
    const http = require("http");
    http.get(BASE + p, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(d || "{}") }));
    }).on("error", reject);
  });
}
async function waitHealthy(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await httpGet("/api/health"); if (r.body.ok) return true; } catch (_) {}
    await sleep(100);
  }
  return false;
}

/* 一个员工：申请 W → 持有 → 读版本 → 写入 → （写成功即自动释放） */
async function agent(name, delayMs, holdMs) {
  await sleep(delayMs);
  const acq = await desk(["acquire", "--case", CASE, "--path", FILE, "--mode", "write",
    "--note", name, "--wait", "30", "--actor", name]);
  if (!acq.body.ok) return { name, ok: false, stage: "acquire", body: acq.body };
  const gotAt = Date.now();
  await sleep(holdMs);
  const rd = await desk(["peek", "--case", CASE, "--path", FILE]);
  const wr = await desk(["write", "--case", CASE, "--path", FILE, "--lock", acq.body.lock.id,
    "--expected-version", String(rd.body.version), "--content",
    String(rd.body.content || "") + name + "\n", "--note", name]);
  if (!wr.body.ok) return { name, ok: false, stage: "write", body: wr.body };
  return { name, ok: true, version: wr.body.version, waitedMs: acq.body.waitedMs, gotAt };
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const broker = spawn(process.execPath, [path.join(ROOT, "runtime/server/broker.js"),
    "--port", String(PORT), "--root", TMP], { stdio: ["ignore", "pipe", "pipe"] });
  broker.stdout.on("data", d => process.env.VERBOSE && process.stdout.write("[broker] " + d));
  broker.stderr.on("data", d => process.stdout.write("[broker:err] " + d));

  const healthy = await waitHealthy(8000);
  if (!healthy) { console.log("broker 启动失败"); broker.kill(); process.exit(1); }
  console.log("broker up on " + BASE + "  root=" + TMP + "\n");

  /* ---------- A. 严格 FIFO + 版本递增 ---------- */
  console.log("A. 三个进程抢同一把写锁（FIFO）");
  const t0 = Date.now();
  const agents = [agent("agent-a", 0, 300), agent("agent-b", 120, 300), agent("agent-c", 240, 300)];
  const res = await Promise.all(agents);
  const elapsed = Date.now() - t0;
  ok(res.every(r => r.ok), "三个 agent 都成功写入");
  ok(res[0].version === 1 && res[1].version === 2 && res[2].version === 3,
     "版本严格递增 1/2/3（实际 " + res.map(r => r.version).join("/") + "）");
  ok(res[0].gotAt < res[1].gotAt && res[1].gotAt < res[2].gotAt, "获得锁的顺序与入队顺序一致");
  ok(res[1].waitedMs >= 200 && res[2].waitedMs >= 400, "后来者确实等待了（" + res.map(r => r.waitedMs).join("/") + "ms）");
  ok(elapsed < 5000, "无死锁，总耗时 " + elapsed + "ms");

  const ledger = fs.readFileSync(path.join(TMP, "runtime/ledger/events.jsonl"), "utf8")
    .split("\n").filter(Boolean).map(l => JSON.parse(l));
  const grantOrder = ledger.filter(e => e.type === "lock.granted").map(e => e.actor);
  ok(grantOrder.join(",") === "agent-a,agent-b,agent-c", "账本里的授权顺序正确：" + grantOrder.join(" → "));
  ok(ledger.filter(e => e.type === "file.written").length === 3, "账本记录 3 次写入");

  /* ---------- B. 共享读 + 写优先 ---------- */
  console.log("\nB. 共享读（两个读者并发）与写者排队");
  const FILE2 = "research/shared.md";
  const rd1 = desk(["acquire", "--case", CASE, "--path", FILE2, "--mode", "read", "--wait", "5", "--actor", "reader-1"]);
  const rd2 = desk(["acquire", "--case", CASE, "--path", FILE2, "--mode", "read", "--wait", "5", "--actor", "reader-2"]);
  const [r1, r2] = await Promise.all([rd1, rd2]);
  ok(r1.body.ok && r2.body.ok, "两个读者同时拿到读锁");
  const snap1 = await httpGet("/api/snapshot?case=" + CASE);
  const sh = snap1.body.files.find(f => f.path === FILE2);
  ok(sh && sh.holders.length === 2, "同一文件上有 2 个读者（共享读）");
  const wr = desk(["acquire", "--case", CASE, "--path", FILE2, "--mode", "write", "--wait", "0.3", "--actor", "writer-1"]);
  const wrRes = await wr;
  ok(wrRes.code === 2 && wrRes.body.queued, "写者在读者未释放时排队（超时返回 queued）");
  await desk(["release", "--lock", r1.body.lock.id]);
  await desk(["release", "--lock", r2.body.lock.id]);
  const wr2 = await desk(["acquire", "--case", CASE, "--path", FILE2, "--mode", "write", "--wait", "5", "--actor", "writer-1"]);
  ok(wr2.body.ok, "读者释放后写者拿到写锁");
  await desk(["release", "--lock", wr2.body.lock.id]);

  /* ---------- C. 租约回收 ---------- */
  console.log("\nC. 租约到期自动回收");
  const lease = await desk(["acquire", "--case", CASE, "--path", "research/lease.md",
    "--mode", "write", "--ttl", "1", "--wait", "5", "--actor", "sleeper"]);
  ok(lease.body.ok, "sleeper 拿到 1 秒租约");
  const blocked = await desk(["acquire", "--case", CASE, "--path", "research/lease.md",
    "--mode", "write", "--wait", "0.3", "--actor", "waiter"]);
  ok(blocked.code === 2, "租约内其他人拿不到");
  await sleep(1400);
  const after = await desk(["acquire", "--case", CASE, "--path", "research/lease.md",
    "--mode", "write", "--wait", "5", "--actor", "waiter"]);
  ok(after.body.ok, "租约到期后自动释放，waiter 拿到");
  await desk(["release", "--lock", after.body.lock.id]);
  const ledger2 = fs.readFileSync(path.join(TMP, "runtime/ledger/events.jsonl"), "utf8")
    .split("\n").filter(Boolean).map(l => JSON.parse(l));
  ok(ledger2.some(e => e.type === "lock.expired" && e.actor === "sleeper"), "账本记录了 lock.expired");

  /* ---------- D. 版本 CAS ---------- */
  console.log("\nD. 版本冲突（CAS）");
  const cas = await desk(["acquire", "--case", CASE, "--path", FILE, "--mode", "write", "--wait", "5", "--actor", "cas-agent"]);
  const bad = await desk(["write", "--case", CASE, "--path", FILE, "--lock", cas.body.lock.id,
    "--expected-version", "99", "--content", "x", "--note", "bad"]);
  ok(bad.code === 3 && bad.body.conflict, "版本不符返回 409/conflict");
  ok(bad.body.currentVersion === 3, "返回当前版本号 3");
  await desk(["release", "--lock", cas.body.lock.id]);

  /* ---------- E. 无锁写入被拒 ---------- */
  console.log("\nE. 绕过锁的写入");
  const noLock = await desk(["write", "--case", CASE, "--path", FILE, "--lock", "L999",
    "--expected-version", "3", "--content", "x"]);
  ok(noLock.code === 4, "无有效锁的写入被拒绝");

  /* ---------- 汇总 ---------- */
  console.log("\n" + "=".repeat(56));
  console.log("通过 " + passes.length + " 项，失败 " + fails.length + " 项");
  if (fails.length) { fails.forEach(f => console.log("  ✗ " + f)); }
  broker.kill();
  await sleep(200);
  process.exit(fails.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
