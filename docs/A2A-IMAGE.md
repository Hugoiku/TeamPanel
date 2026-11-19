# A2A Fans 开放平台接入（图片生成）

本文记录 AlphaDesk 如何调用 A2A Fans OpenAPI 做研究报告配图。平台文档：https://public.a2afans.cn/skills/a2a-openapi/SKILL.md

## 1. 凭证

- 存放：`runtime/secrets/a2a.json`（`{"base_url":"https://openapi.a2afans.cn/api/v1","agent_key":"ak-..."}`，目录已 gitignore，权限 600）；
- 也可用环境变量 `A2A_API_KEY` 覆盖；**任何输出/日志/报告里都不出现 key**；
- 开源仓库不包含该文件，使用者需自备 key。

## 2. 平台能力（与本项目相关的）

| 能力 | 接口 | 说明 |
|---|---|---|
| 生图 | `POST /images/generations` | `model`（如 Image 2.5 Sunburst / Image 2 / 香蕉2 / MJ）、`prompt`、`size`（16 倍数）、`quality`、`output_format` |
| 改图 | `POST /images/edits` | 1–6 张参考图（HTTPS URL / OSS key / base64 data URL） |
| 香蕉 | `POST /images/banana/generations` | `contents[].parts[]` + `aspectRatio/imageSize` |
| MJ | `POST /images/mj/generations` | `prompt` 内写 `--ar 16:9 --hd`，固定 4 张 |
| 异步轮询 | `GET /images/tasks/<request_id>` | `queued → running → succeeded/failed`；重试复用同一 request_id 不重复扣费 |
| 试算价格 | `GET /images/estimate_price` | 不扣费；2K 大约 3–6 AGT/张 |
| 余额 | `GET /a2afans/users/me` | `wallet.points` 为可用 AGT |
| 参考图上传 | `POST /files/presign` + PUT | 单张 ≤10MB，JPEG/PNG/WebP |

其他能力（小红书 App V2 / 蒲公英 / Web V3 数据）本报告暂未使用，接口清单见平台 Skill 文档。

## 3. 本项目封装

```bash
# 生图并直接上传到某个 case 的 figures/
node scripts/gen-image.js --prompt "..." --out /tmp/x.png \
  --model "Image 2.5 Sunburst" --size 2048x1360 \
  --upload case-2026-003 --path figures/optical-module-ai.png
```

- 脚本：读取 `runtime/secrets/a2a.json` → 提交异步任务 → 轮询 → 下载 URL → 可选 `desk upload` 入库；
- 报告：若 `vault/<case>/figures/optical-module-ai.png` 存在，`report.js` 会自动把它作为「图12 光模块产品拆解图（AI 生成示意）」编入 §2.6；
- 成本：本次 2048×1360（2K 档）用 Image 2.5 Sunburst，**6 AGT/张**；4K 档 30 AGT/张；MJ 50 AGT/组（4 张）。

## 4. 合规与标注

- AI 生成图仅作**示意**，不是工程图纸，尺寸/型号不对应具体产品；报告正文已加此声明；
- 图中产品结构（TOSA/ROSA/InP 衬底位置）为行业通用结构，公司仅披露「磷化铟晶片下游为外延/器件厂商」[S28]；已上报 N19 待补第三方来源；
- 对外发布前需按法律意见落地 A0/A3。

