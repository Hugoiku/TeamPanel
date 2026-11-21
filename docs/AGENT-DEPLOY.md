# 交给 DeepSeek Harness Agent 自动部署

如果你不想手动敲命令，可以把下面这段直接交给具备 shell / 网络权限的 DeepSeek Harness Agent。  
目标不是“把仓库 clone 下来”，而是“配置到 Panel 能正式启动员工”。

## 部署提示词

~~~text
你是天枢 Panel 的部署 Agent。目标：把 https://github.com/Hugoiku/TeamPanel
部署到本机，并验证到“Panel 可启动、员工可运行”的正式使用状态。

硬约束：
1. 不要伪造 API Key，不要把 Key 写进 README、Git、日志或聊天记录。
2. 不要提交 .env、vault/、runtime/secrets/。
3. 每一步先检查现状，不要重复 clone / 覆盖已有 .env。
4. 如果缺少 shell、网络、dsh 或模型凭据，停下来向用户报告缺什么。
5. 不要假设 provider 一定是 opencode-go；以用户当前 dsh 实际可用模型为准。

执行步骤：
1. 检查 node >= 18、git、dsh --version、当前目录权限。
2. clone 仓库；如果已存在，先 git status / git pull，不要覆盖用户改动。
3. 进入项目，执行 node scripts/init-worktree.js --demo。
4. 确认“用户当前能用的模型”，不要假设 provider：
   - 先看 dsh 实际能调用哪个 provider / model；
   - 如果用户已说明，按其 provider / model / base_url / key 配置；
   - 如果 DSH 依赖账号登录而不是环境变量，先用 dry-run 验证 Panel 子进程能否复用；
   - 需要 key 时，让用户把 key 写入 .env 的对应变量，不要打印值。
5. 初始配置：把 Panel 的默认模型设为 dsh 当前正在使用的 provider/model：
   - 目的只是保证 Panel 第一次派活能跑通；
   - 自建/provider 需要 base_url 时填 base_url；
   - key_ref 用 env:YOUR_KEY_NAME，不写明文；
   - 如果 config/desk.json 的示例模型不是用户可用模型，改 config/desk.local.json 或面板默认模型，不要改源码默认值。
   注意：这只是初始默认值；之后用户可以在面板给单个员工或全员切换其他模型，
   Panel 不要求所有模型都与 dsh 保持一致。
6. 确认 dsh 可用；如果不在 PATH，设置 DSH_BIN 为实际绝对路径。
7. 启动：./start.sh；如果端口占用，使用 PORT=7802 ./start.sh。
8. 验证：
   curl -s http://127.0.0.1:7801/api/health
   curl -s http://127.0.0.1:7801/api/doctor
   curl -s http://127.0.0.1:7801/api/models
9. 运行 dry-run：
   node runtime/agents/employee.js --agent macro --case case-demo --task "部署验收" --dry-run
10. 如果模型可用，再跑一个最小真实任务；失败则保留错误原文，不要假装成功。
11. 最后报告：
   - 本地 URL
   - doctor 哪些项通过/失败
   - 实际使用的 provider / model
   - 是否达到“可正式使用”
   - 还缺什么（dsh / 模型 / 数据源 / Python）

重要：
部署 Agent 自己的模型调用权限，不等于 Panel 员工的模型凭据。
Panel 员工由 dsh 子进程启动，初始默认要使用 dsh 当前能调用的 provider/model；
跑通后可以在 Panel 切换到其他 dsh 能加载的 provider/model。
不要假设一定是 opencode-go，也不要假设任何固定 provider。
如果唯一可用的 provider 需要额外 key，让用户提供，不能伪造。
~~~

## 模型策略：初始一致，之后自由

部署时只要求一件事：

~~~text
Panel 初始默认模型 = dsh 当前正在使用的模型
~~~

原因是第一次派活要能跑通。

跑通之后，Panel 的模型配置是独立的：

~~~text
可以全员换模型
可以给单个员工换模型
可以加多个 provider / 网关
不要求与 dsh 当前模型一直一致
~~~

不要把“Panel 模型必须永远等于 dsh”写死。

## 正式使用的最低验收

Agent 报告“完成”前，至少满足：

~~~text
Node.js >= 18
dsh 能找到
/api/health 返回 ok
/api/doctor 中 node / dsh / config / vault 通过
/api/models 的初始默认模型与 dsh 当前使用模型一致（保证第一次能跑）
dry-run 能启动员工进程
用户能给一个 case 派活并看到 agent.run.started
~~~

只满足“页面能打开”不算正式使用。

## 不建议让 Agent 自动做的事

~~~text
不要让 Agent 猜 API Key
不要让 Agent 把 .env 内容输出到聊天
不要让 Agent 自动提交 vault/ 或 runtime/secrets/
不要让 Agent 直接暴露 HOST=0.0.0.0 到公网
~~~

需要远程访问时，让用户自己设置：

~~~bash
HOST=0.0.0.0 PANEL_TOKEN='用户自己的口令' ./start.sh
~~~
