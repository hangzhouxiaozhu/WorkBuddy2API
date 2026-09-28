# WorkBuddy2API

将本机 WorkBuddy 的 ACP 能力接入 OpenAI-compatible Chat Completions API，附带 Token 用量 Dashboard。

**实验性 macOS 本机网关，非官方项目。** 需要自行安装 WorkBuddy 并使用自己的有效账号授权。本仓库不包含 WorkBuddy 二进制、产品配置、密钥或历史用量，也不安装 Claude Code。

## 功能

- `/v1/chat/completions`：文本请求、SSE 输出与外部工具调用格式适配。
- `/v1/models`：从本机 WorkBuddy 获取可用模型。
- 并发、排队、上下文裁剪与用量记录。
- Dashboard：每日 Token、模型请求量、调用方、最近 100 条请求与 CSV 导出，每 30 秒刷新。
- 官方浏览器授权流程；API 使用独立的随机 Bearer Token。
- 仅监听 `127.0.0.1`，适合本机客户端。

```text
OpenAI-compatible 客户端
          │ Bearer Token
          ▼
WorkBuddy2API :18490 ─── Dashboard
          │ ACP / loopback
          ▼
WorkBuddy CLI :18491 ─── 已授权账号
```

## 快速开始

要求：macOS、Node.js 22 或更新版本，以及安装在 `/Applications/WorkBuddy.app` 的 WorkBuddy。实现源于 WorkBuddy 2.147.x 的本机集成；其他版本的 CLI 协议可能变化。

```sh
git clone https://github.com/hangzhouxiaozhu/WorkBuddy2API.git
cd WorkBuddy2API
npm run setup
npm start
```

无第三方 npm 依赖。`setup` 从自己安装的 WorkBuddy 读取产品配置，并在 `~/.workbuddy2api/` 生成私有运行文件；不会修改 WorkBuddy 安装目录或覆盖已有网关 Token。

在另一个终端中授权：

```sh
cd WorkBuddy2API
npm run login
# 在打开的官方页面完成本次授权后：
npm run auth:status
```

访问 [Dashboard](http://127.0.0.1:18490/dashboard)。客户端配置：

| 项目 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:18490/v1` |
| API Key | `~/.workbuddy2api/token` 文件内容，只在本机客户端填写 |
| Model | `auto`，或 `/v1/models` 返回的模型 ID |

最小请求示例，凭据从文件读取：

```sh
curl http://127.0.0.1:18490/v1/chat/completions \
  -H "Authorization: Bearer $(cat "$HOME/.workbuddy2api/token")" \
  -H 'Content-Type: application/json' \
  -H 'X-Client-Name: local-example' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Reply OK"}]}'
```

前台运行，按 `Ctrl+C` 停止。本项目不自动安装开机服务。端口被占用时先停掉旧实例，或同时为两个终端设置不同的 `WB_GATEWAY_PORT` 和 `WB_BACKEND_PORT`。

## 环境变量

通过 shell 导出；项目不自动读取 `.env`。

| 变量 | 默认值 / 用途 |
| --- | --- |
| `WB_GATEWAY_PORT` | `18490` |
| `WB_BACKEND_PORT` | `18491` |
| `WB_DATA_DIR` | `~/.workbuddy2api` |
| `WB_TOKEN_FILE` | 数据目录中的 `token` |
| `WB_USAGE_FILE` | Token 文件同目录的 `usage.jsonl` |
| `WB_PRODUCT_CONFIG` | 数据目录中的 `product-gateway.json` |
| `WB_CLI` | WorkBuddy 安装目录中的 `cli/bin/codebuddy` |
| `WB_SOURCE_PRODUCT_CONFIG` | `setup` 使用的原始 `cli/product.json` |
| `WB_CONFIG_DIR` | `~/.workbuddy` |
| `WB_WORKSPACE` | 当前目录 |
| `WB_DEFAULT_MODEL` | `auto` |
| `WB_MAX_CONCURRENT` | `60`；请根据账号容量调低 |
| `WB_MAX_QUEUED` | `16` |
| `WB_QUEUE_TIMEOUT_MS` | `180000` |
| `WB_MAX_CONTEXT_TOKENS` | `1000000`，仍受后端模型窗口限制 |
| `WB_MAX_BODY_BYTES` | `2097152` |
| `WB_DASHBOARD_DIR` | 源码中的 `dashboard/` |

## API 与状态

除本机 Dashboard 和 `/healthz` 外，以下接口均要求 Bearer Token：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/healthz` | 进程/后端健康、执行与排队数；不证明账号已授权 |
| GET | `/v1/backend-auth/status` | 当前账号授权状态 |
| POST | `/v1/backend-auth/login` | 发起授权，JSON 请求体 `{}` |
| GET | `/v1/models` | 模型列表 |
| POST | `/v1/chat/completions` | 聊天请求 |
| POST | `/v1/context/preview` | 上下文裁剪预览 |
| GET | `/v1/usage` | 网关累计用量 |
| 各方法 | `/acp`、`/acp/*` | 底层 ACP 转发，高级用途 |

Dashboard 的工作流是规划示意，不是自动调度器。运行状态只覆盖本网关；不会把其他客户端或桌面任务当成空闲。Claude Code 分支仅作示意，不提供 Anthropic Messages 适配。

## 已知限制

- **授权保存在内存中，重启网关后需要重新运行 `npm run login`。** 不读取或解密桌面客户端的受保护凭据。
- OpenAI-compatible 是部分兼容：文本消息会转成 ACP 提示词，图片/音频不支持；不是完整 OpenAI API 实现。
- 外部工具调用采用提示词约束和 JSON 解析，不是原生工具调用协议，可靠性取决于模型；工具模式会缓冲输出。客户端自行执行返回的工具调用。
- 上下文长度使用启发式估算，旧消息可能被裁剪；1M 是配置上限，不保证每个模型具备该窗口。
- 长请求仍可能受到后端/Node 网络超时影响；客户端断开后的后端取消不完整。尚未验证超长请求稳定性。
- 用量只统计经本网关的请求；缺失的缓存/推理字段可能显示为 0，不表示确定没有消耗。无费用估算，不是服务方账单。
- 用量文件为追加 JSONL，暂不自动轮转。Dashboard 可由本机其他用户访问，请勿经公网隧道或反向代理对外开放。
- 开源提取版尚未单独运行端到端测试；本机原始版本已完成授权及实际请求验证。

## 故障排查

1. `401` / authentication unavailable：执行 `npm run auth:status`，需要时运行 `npm run login`。普通官网登录不代表网关已授权。
2. `EADDRINUSE`：已有进程占用端口，避免同时启动两个网关。
3. WorkBuddy 更新后无法启动：重新 `npm run setup`；若 CLI 路径或协议变化，需要更新适配。
4. `429`：并发/队列已满或排队超时，减少调用频率。
5. 健康检查成功但模型请求失败：健康检查只检查后端存活，检查授权及实际请求结果。

## 许可证

本仓库原创网关与 Dashboard 代码采用 [MIT](LICENSE)。WorkBuddy、Codex、Claude 及其商标、客户端、模型服务属于各自权利人，不包含在本项目许可证中。请遵守所用服务的条款及账号权限。
