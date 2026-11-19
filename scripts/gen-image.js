#!/usr/bin/env node
"use strict";
/**
 * gen-image — 用 A2A Fans 开放平台生成图片（默认 gpt-image 2.5 / Image 2.5 Sunburst）
 *
 *   node scripts/gen-image.js --prompt "..." --out ./x.png
 *   node scripts/gen-image.js --prompt "..." --out ./x.png --model "Image 2.5 Sunburst" --size 2048x1360
 *   node scripts/gen-image.js --prompt "..." --out ./x.png --upload case-2026-003 --path figures/x.png
 *
 * 凭证：runtime/secrets/a2a.json（base_url + agent_key，已 gitignore），可用环境变量 A2A_API_KEY 覆盖。
 * 平台文档：https://public.a2afans.cn/skills/a2a-openapi/SKILL.md
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");

function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
function flag(n) { return process.argv.indexOf("--" + n) >= 0; }
function req(url, opts, body) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? require("http") : https;
    const r = lib.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: (opts && opts.method) || "GET", headers: (opts && opts.headers) || {} }, x => {
      const c = []; x.on("data", d => c.push(d)); x.on("end", () => res({ status: x.statusCode, body: Buffer.concat(c) }));
    });
    r.on("error", rej); if (body) r.write(body); r.end();
  });
}
function loadCred() {
  const p = path.join(ROOT, "runtime/secrets/a2a.json");
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return { base: j.base_url || "https://openapi.a2afans.cn/api/v1",
    key: process.env.A2A_API_KEY || j.agent_key || "" };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const prompt = arg("prompt");
  const out = arg("out", "");
  const model = arg("model", "Image 2.5 Sunburst");
  const size = arg("size", "2048x1360");
  const quality = arg("quality", "auto");
  if (!prompt || !out) { console.error("用法: node scripts/gen-image.js --prompt <文本> --out <文件.png> [--model ...] [--size WxH] [--upload <case> --path <vault路径>]"); process.exit(2); }
  const { base, key } = loadCred();
  if (!key) { console.error("缺凭证：runtime/secrets/a2a.json 或 A2A_API_KEY"); process.exit(3); }
  const rid = "a2a-openapi-" + require("crypto").randomUUID();
  const payload = JSON.stringify({ model, prompt, size, quality,
    output_format: "png", response_format: "url", n: 1 });
  const sub = await req(base + "/images/generations?mode=async&a2a_openapi_request_id=" + rid,
    { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" } }, payload);
  if (sub.status !== 202 && sub.status !== 200) { console.error("提交失败", sub.status, sub.body.toString().slice(0, 300)); process.exit(4); }
  const cost = (() => { try { return JSON.parse(sub.body.toString()).agt_cost; } catch (_) { return "?"; } })();
  console.log("[gen-image] queued rid=" + rid + " model=" + model + " size=" + size + " cost=" + cost + " AGT");
  let task = null;
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    const r = await req(base + "/images/tasks/" + rid, { headers: { authorization: "Bearer " + key } });
    try { task = JSON.parse(r.body.toString()); } catch (_) { continue; }
    if (task.status === "succeeded" || task.status === "failed") break;
  }
  if (!task || task.status !== "succeeded") {
    console.error("[gen-image] 失败/超时：", task && JSON.stringify(task.error || task.status));
    process.exit(5);
  }
  const url = ((task.data || [])[0] || {}).url;
  if (!url) { console.error("[gen-image] 无图片 URL"); process.exit(6); }
  const img = await req(url);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, img.body);
  console.log("[gen-image] 已下载 " + out + " " + img.body.length + " bytes, cost=" + task.agt_cost + " AGT");
  const upCase = arg("upload", "");
  const upPath = arg("path", "");
  if (upCase && upPath) {
    const d = spawnSync(process.execPath, [path.join(ROOT, "scripts/desk"), "upload", "--file", path.resolve(out),
      "--path", upPath], { cwd: ROOT, encoding: "utf8",
      env: Object.assign({}, process.env, { DESK_CASE: upCase, DESK_ACTOR: "lead" }) });
    console.log("[gen-image] upload ->", String(d.stdout || "").trim().split("\n").pop());
  }
})().catch(e => { console.error(String(e && e.stack || e)); process.exit(1); });
