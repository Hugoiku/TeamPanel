"use strict";
/** Independent WorkItem heartbeat process. */
const http = require("http");
const BASE = process.env.DESK_BROKER || "http://127.0.0.1:7801";
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; }
const CASE = arg("case", ""), WORK = arg("work", ""), OWNER = arg("owner", ""), LEASE = arg("lease", "");
const PARENT = parseInt(arg("parent-pid", "0"), 10) || 0;
const INTERVAL = Math.max(5000, parseInt(arg("interval", "15000"), 10) || 15000);
const LEASE_MS = Math.max(30000, parseInt(arg("lease-ms", "120000"), 10) || 120000);
if (!CASE || !WORK) process.exit(2);
function post(body) {
  return new Promise(resolve => {
    const data = JSON.stringify(body);
    const req = http.request(BASE + "/api/work/heartbeat", { method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, res => {
      let s = ""; res.on("data", d => s += d); res.on("end", () => {
        let j = {}; try { j = JSON.parse(s || "{}"); } catch (e) {}
        resolve({ status: res.statusCode, body: j });
      });
    });
    req.on("error", () => resolve({ status: 0, body: {} })); req.write(data); req.end();
  });
}
function parentAlive() {
  if (!PARENT) return true;
  try { process.kill(PARENT, 0); return true; } catch (e) { return false; }
}
(async () => {
  while (true) {
    if (!parentAlive()) process.exit(0);
    const r = await post({ case: CASE, id: WORK, owner: OWNER, leaseId: LEASE, leaseMs: LEASE_MS });
    if (r.status === 404 || r.status === 409) process.exit(0);
    await new Promise(x => setTimeout(x, INTERVAL));
  }
})().catch(() => process.exit(1));
