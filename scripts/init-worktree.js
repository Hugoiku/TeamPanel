#!/usr/bin/env node
/**
 * init-worktree — 首次运行：建好运行期目录；可选放一个演示 case。
 *
 *   node scripts/init-worktree.js          # 只建目录（幂等）
 *   node scripts/init-worktree.js --demo   # 再拷一个 demo case 到 vault/case-demo
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const demo = process.argv.includes("--demo");

const dirs = [
  "vault", "drafts", "runtime/ledger", "runtime/history", "runtime/locks",
  "runtime/profiles", "runtime/kb"
];
dirs.forEach(d => fs.mkdirSync(path.join(ROOT, d), { recursive: true }));

// 每个角色一个知识库目录（从 config/desk.json 读角色，缺配置回落六角色）
let agents = [];
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config/desk.json"), "utf8"));
  agents = (cfg.agents || []).filter(a => a.id !== "lead").map(a => a.id);
} catch (_) {
  agents = ["macro", "industry", "stock", "audit", "legal", "trader"];
}
agents.concat(["lead"]).forEach(a => fs.mkdirSync(path.join(ROOT, "runtime/kb", a), { recursive: true }));

if (demo) {
  const from = path.join(ROOT, "demo/mission.md");
  const to = path.join(ROOT, "vault/case-demo/mission.md");
  if (!fs.existsSync(to)) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    console.log("[init] demo case → vault/case-demo（面板里选 case-demo 即可）");
  } else {
    console.log("[init] vault/case-demo 已存在，跳过");
  }
}

console.log("[init] 目录就绪。下一步：");
console.log("  1) 复制 .env.example 为 .env 并填模型凭据（或 export）");
console.log("  2) ./start.sh   然后打开 http://127.0.0.1:7801/live");
console.log("  3) 面板左下角「模型配置」加一个模型（开源默认不预置模型）");
