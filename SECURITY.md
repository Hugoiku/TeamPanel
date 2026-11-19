# 安全与敏感信息政策

天枢会接触模型凭据、数据源 API Key、本地研究数据与账本。开源仓库不包含任何真实凭据、用户研究内容或运行期数据。

## 不提交的内容

以下路径已在 `.gitignore` 中忽略：

- `runtime/`：运行期数据、账本、缓存、任务队列、日志、PID；
- `vault/`：用户 case 的研究产物、上传文件、报告；
- `drafts/`：研究草稿；
- `runtime/secrets/`：Tushare、FRED、A2A 等凭据；
- `.env`、`.env.*`（保留 `.env.example`）；
- `config/desk.local.json` 与 `config/*.local.json`；
- `.agents/`、`skills/hithink-finance/`、`skills/lieflat-less-ai-tone/`：本地/第三方许可受限内容。

## 本地配置方式

1. 复制环境变量示例：

   ```bash
   cp .env.example .env
   ```

2. 在 `.env` 或 `runtime/secrets/` 中配置自己的 key，不要写进源码。

3. 本地模型/端口配置使用：

   ```bash
   cp config/desk.json config/desk.local.json
   ```

   `config/desk.local.json` 已被忽略。

## 提交前检查

```bash
git status --short
git diff --cached --name-only
git grep -nE 'sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|api[_-]?key.*=.*[A-Za-z0-9]{16,}'
```

确认没有 `.env`、`runtime/secrets`、`vault/`、`drafts/`、`config/desk.local.json` 被 staged。

## 如果误提交了密钥

1. 立即在对应平台吊销/轮换密钥；
2. 不要只删除文件，历史 commit 仍包含；
3. 使用 `git filter-repo` 或 BFG 清理历史；
4. 强制推送后通知所有协作者重新 clone。

## 报告安全问题

请通过仓库 Issue 或维护者邮箱私下联系，不要在公开 Issue 中粘贴真实密钥。
