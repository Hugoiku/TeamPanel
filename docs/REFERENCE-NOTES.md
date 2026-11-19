# 参考实现笔记 · Agraael/lancer-automations

> 核查时间：2026-10-29　·　被核查版本：v4.4.4.1（默认分支 main，最近提交 2026-10-28）
> 仓库：https://github.com/Agraael/lancer-automations　·　授权：WTFPL（可自由使用/修改/商用）

## 0. 结论先说

**有帮助，但不能当底座。** 它是 Foundry VTT 的 Lancer 桌游规则自动化模块，源码体量可观：入口 `scripts/main.js` 97KB、反应管理器 `reaction-manager.js` 163KB、反应引擎 `reactions-engine.js` 80KB、战报渲染 `recap.js` 134KB，光 `doc/` 下的 API 文档就有 ~340KB。

它解决的问题和我们**同构**：

| 它的问题 | 我们的问题 |
|---|---|
| 一次攻击触发多个 token 的反应，反应要排队、要人工确认 | 一个阶段触发多个 Agent 的加工，加工要排队、要人工签批 |
| 多个客户端同时改同一条数据，靠 socket 让 GM 做权威 | 多个 Agent 同时改同一份文件，靠 Broker 做权威 |
| 战斗全过程埋点 → 派生统计 → 生成战后战报 | 流水线全过程埋点 → 派生状态 → 面板投影 |
| 手工改血条不可归因，只能单独标记 | Agent 绕过 Broker 直写，只能靠巡检留痕 |

它**没有**的东西：LLM / Agent 编排、跨进程锁、文件版本 CAS。所以核心协作层还是自己写，但**中间件怎么写**可以直接借鉴。

---

## 1. 值得直接抄的 6 个模式

### P1 · 串行化队列 = promise 链（40 行，最值钱的一页）

出处：`scripts/activations/flow-queue.js`

单线程里做 FIFO 互斥，最简正确实现不是数组 + 定时器，而是"把下一个任务接在上一个的 promise 后面"：

```js
let chain = Promise.resolve();
function queue(fn) {
  const next = chain.then(fn);     // 排在所有已入队任务之后
  chain = next.catch(() => {});    // 吞掉异常，避免链条断掉
  return next;                     // 调用方 await 到自己的执行结果
}
```

它比"轮询 + 标志位"可靠，因为顺序由微任务队列保证，天然无竞态。它还额外做了两件我们会想要的事：

- `INTER_FLOW_DELAY_MS = 400`：排队相邻两项之间强制间隔，理由是人眼要能看清"一步接一步"。我们的面板同理——两个 Agent 在 50ms 内连续交接，人类看不出发生了什么。
- `_renderIndicator()`：把"队列长度 − 正在执行数 = 等待数"直接渲染成一个带编号 tooltip 的角标。这就是我们锁看板的原型：`waiting = queue.length - active`。

**怎么用**：Broker 内部每个文件一条 lane，HTTP 请求 await 自己在 lane 上的 promise。面板读到的 `waiting` 用同一公式算。

### P2 · 深度守卫解决"父等子"自锁

出处：同上文件 `_flowBodyDepth` / `runInFlowBody()` / `innerChain`

任务一旦可以嵌套，就会出现"队列里排着的任务又发起一个子任务，而子任务排在父任务后面"——父等子、子等父，永久卡死。它的解法是**双车道 + 深度计数**：

```js
let _flowBodyDepth = 0;
export async function queue(fn) {
  if (_flowBodyDepth > 0) return _queueOn(innerChain /* 子车道 */, fn);
  return _queueOn(chain /* 主车道 */, fn);
}
export async function runInFlowBody(fn) {
  _flowBodyDepth++;               // 执行任务体期间，它发起的子任务走子车道
  try { return await fn(); } finally { _flowBodyDepth--; }
}
```

注释里写得很直白："While >0, queue() bypasses to avoid the parent-awaits-child deadlock."

**怎么用**：我在设计 v0.1 里写的是"v1 禁止嵌套持锁"——太粗暴，实际业务里采集型 Agent 经常要"拿着结论文件再回头读证据"。改成 v0.2 的双车道方案。注意：深度守卫只解决**同一资源的重入**；跨资源成环（A 等 B、B 等 A）仍然要靠 `txn` 全局字典序 + TTL 兜底，这一点它没有解决，因为它是单资源场景。

### P3 · 权威方 RPC + `wait: true`

出处：`doc/AUTOMATION_SYSTEM.md` §8、`scripts/socket.js`

客户端权限不够时，把活委派给 GM：`sendMessageToReactor(data, gmUserId, { wait: true })`，`wait:true` 时**同步返回**远端结果；`opts` 里还有 `waitTitle / waitDescription` 用来在本地画一张"等待卡片"，告诉玩家"正等着 GM 处理"。

**怎么用**：这个三件套（委派 → wait → 等待态 UI）几乎是我们 `desk` CLI 的规格：默认阻塞直到锁拿到、写入确认；`--no-wait` 才异步；面板上每个排队中的员工都显示"正在等谁"。

### P4 · 事件日志 → 派生 → 回顾（三段式）

出处：`scripts/Battelog/`（`combat-telemetry.js` 定义事件 → `combat-telemetry-derive.js` 50KB 派生 → `recap.js` 137KB 渲染）

- 事件类型用 JSDoc `@typedef` 精确定义字段（`ActionEvent / AttackEvent / DamageEvent / DamageUndoEvent…`），**包括撤销事件**；
- 有一条 `manual` 字段专门标记"在 tick 上检测到的手工改动，不是正规伤害卡"——即**无法归因的带外修改单独成事件类型**，而不是试图掩盖；
- 存储层（`telemetry-store.js`）维持"每个战斗一个规范对象"，写入用**每键 promise 链**串行化，注释解释了原因：Foundry 每次 update 都会重新克隆 flag，"所以我们从不持久化一个重新读出来的克隆"——否则后写覆盖先写。

**怎么用**：①面板=纯投影这条路线被验证是对的；②我的 `violation` 改成 `file.out_of_band`（巡检 diff 出无对应 `lock.granted` 的写入），且**不静默修正，只留痕报警**；③Broker 内存里持有规范态、落盘串行，避免"读盘→改→写盘"的丢更新。

### P5 · 配额门 API（比 step budget 更好的写法）

出处：`doc/AUTOMATION_SYSTEM.md` §10，"Real limits come from…" 一段

```js
await api.consumeOncePerRound(token, 'my_key', target)  // 本轮每目标仅一次，返回 true/false
api.consumeGate(key, window)                            // 更长窗口
```

它明确区分了"展示用的频次字符串"和"真正强制执行的配额"。**怎么用**：每角色步数预算、单阶段对同一文件的写入次数上限、`audit` 的复审轮数（我原来写"上限 3 轮"），都应该做成 Broker 侧的 gate 调用，返回布尔值让 Agent 自己决定，而不是靠 prompt 里写"最多 3 次"。

### P6 · 冲突检测 + 自测 + 工程闸门

- `scripts/activations/activation-conflicts.js`：把每条自动化规则归一成 `kind|key|index` 的 `entryId` 再比对，找出"同一触发器被多条规则抢"的冲突，界面用 300px 抽屉列出。→ 我们的"两个 Agent 抢同一文件""两条门禁同时命中"可以复用这个 ID 归一化 + 抽屉的交互。
- `tests/flow-queue.js`：不用浏览器，用 fake flow 记录执行顺序，直接断言 `['start:A','end:A','start:B','end:B']`。→ 和我 `dashboard/test.js` 里对模拟时间轴的断言是同一套思路；它还把这套测试挂成 `api.tests.flowQueue.runAll()` 在**产品内**可跑。→ 我们可以给 Broker 加一个 `GET /api/selftest`，面板上一键跑。
- `package.json` 的 `check`：`lint:ci + conventions:ci + i18n:check + typecheck:ratchet`。其中 **ratchet（棘轮）** 指"违规计数只许降不许升"，而不是一次清零。→ 我们的"协议合规审计"用棘轮最合适：直接写 `vault` 的次数、无锁写入次数，作为基线只能下降。

---

## 2. 不能照搬的 3 件事

1. **它没有真并发。** Foundry 每个客户端是单线程，跨客户端靠 socket 中继，消息天然串行。我们的 Agent 是独立 OS 进程，可能同时写盘——promise 链只能在 Broker 进程内部用，对外仍然需要 HTTP 级排队 + 文件级锁 + 租约。**别以为抄了队列就解决了并发。**
2. **它的"cancel 必须发生在第一个 await 之前"是个反面教材。** 因为 Foundry 的 hook 非阻塞，异步之后再做否决就晚了（文档里专门有一节解释为什么 `awaitActivationCompletion` 不是救命稻草）。迁移到我们这里就是一条硬要求：**门禁校验必须发生在写入提交的同一个事务内**，不能"先写入、再校验、发现不对再回滚"。否则我们的护栏会有 TOCTOU 缺口。
3. **前端强耦合 Foundry。** `reaction-editor.html` 是 40KB 的 hand-rolled 表单（form-group / code-section），依赖 Foundry 的 `{{}}` Handlebars 模板、CSS 变量和 `game/canvas` 全局。只借交互模式，不借代码。

另外：仓库 261MB（含音频/图片资源），**不要把 clone 留在项目里**，也没必要 fork 维护。

---

## 3. 落地改造（我们自己的代码长什么样）

```ts
// broker/lane.ts —— 每份文件一条车道
type Mode = "R" | "W";
interface Waiter { agent: string; mode: Mode; note: string; enqueuedAt: number;
                   resolve: (lock: Lock) => void; reject: (e: Error) => void; }

class Lane {
  mode: Mode | null = null;
  holders = new Set<string>();
  queue: Waiter[] = [];
  private chain: Promise<unknown> = Promise.resolve();   // P1
  private inner: Promise<unknown> = Promise.resolve();   // P2 子车道
  private depth = 0;

  /** 重入：同一上下文内再次申请，走子车道，不排到父后面 */
  request(w: Waiter, reentrant = false) {
    const lane = reentrant ? this.inner : this.chain;
    const next = lane.then(() => this.waitTurn(w));      // 返回的 promise = 拿到锁
    this.chain = next.catch(() => {});
    return next;
  }
  runBody<T>(fn: () => Promise<T>): Promise<T> {          // P2
    this.depth++;
    return fn().finally(() => { this.depth--; });
  }
  get waiting() { return Math.max(0, this.queue.length - this.holders.size); }  // P6 面板
}
```

```ts
// broker/events.ts —— 事件用 schema 定型，含撤销与带外
type FileEvent =
  | { type: "file.written";      path: string; v: number; sha: string; by: string }
  | { type: "file.undo";         path: string; v: number; by: string }        // P4 撤销
  | { type: "file.out_of_band";  path: string; diskSha: string; ledgerSha: string; at: number }
  | { type: "lock.granted" | "lock.queued" | "lock.released" | "lock.expired";
      path: string; agent: string; mode: Mode; position?: number };
```

---

## 4. 这次核查改了什么（v0.1 → v0.2）

| # | 原设计 | 修订后 | 依据 |
|---|---|---|---|
| 1 | 禁止嵌套持锁 | inner 车道 + 深度计数，允许受控重入 | P2 |
| 2 | "巡检发现直写 → violation" | 独立的 `file.out_of_band` 事件类型，只留痕不静默修正 | P4 |
| 3 | 版本仓库语义未明确 | 明确"内存规范对象 + 每键串行落盘"，禁止读盘-改-写盘 | P4 |
| 4 | 频次限制写在 prompt 里 | 改成 Broker 侧 gate API 返回布尔 | P5 |

**没改**的部分（它给不了）：跨进程锁、租约、CAS、DAG 编排、面板的 Agent 语义。这些仍按原方案做。

---

## 5. 许可

WTFPL v2 —— 保留作者署名即可放心借用代码片段。如果最后真的搬了 `flow-queue.js` 的实现思路，在 `broker/lane.ts` 文件头写一行来源即可。
