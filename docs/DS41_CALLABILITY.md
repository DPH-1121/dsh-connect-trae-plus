# deepseek-v4.1-flash 可调用性取证（issue #7 后续）

> 问题：用户实测 Trae IDE 的模型菜单里有 `deepseek-v4.1-flash`，但插件列表里没有；
> 追问「能不能调用 DS 4.1 这个模型」。取证时间 2026-09-15（CN 账号）。

## 结论：SOLO 通道无法调用，它不是 SOLO 侧模型

**`deepseek-v4.1-flash` 不属于 SOLO 通道的任何 function**。全部 8 个 SOLO function
（从 Trae 安装包的 `modules/ai-agent/libai_agent.dylib` 中提取的 Rust 枚举
`UIBuilder / SoloBuilder / SoloCoder / SoloAgent / SoloAgentLite / SoloWorkLite /
SoloAgentRemote / SoloWorkRemote / SoloDesignLite`）逐一体检：

| function | wire 条目 | 含 v4.1 |
|---|---|---|
| `solo_work_remote` | 41 | ✗ |
| `solo_work_lite` | 41 | ✗ |
| `solo_agent` | 52 | ✗ |
| `solo_agent_remote` | 39 | ✗ |
| `solo_coder` | 44 | ✗ |
| `solo_builder` | 6 | ✗ |
| `solo_design_lite` | 24 | ✗ |
| `solo_design` / `design_lite` | 0 | ✗ |

**直接调用验证**（SOLO 通道 `llm_utils_chat`，`config_name=deepseek-v4.1-flash`）：

| function | 结果 |
|---|---|
| `solo_work_remote` / `solo_work_lite` / `solo_agent` / `solo_agent_remote` / `solo_coder` | 全部 **HTTP 200 + `code:4001`（param is invalid）** |

**remote 目录**（`solo.trae.cn/api/remote/v1/models`）在 2 凭证 × 2 host 的 8 次探测中
一致给出同样的 14 个模型，其中没有 v4.1：

```
Doubao-Seed-Evolving, Doubao-Seed-2.1-Pro, Doubao-Seed-2.1-Turbo, Doubao-Seed-Code,
glm-5.3, glm-5.2, DeepSeek-V4-Flash-Official, DeepSeek-V4-Pro-Official,
kimi-k3, kimi-k2.7-code, kimi-k2.6, minimax-m3, qwen3.8-max, qwen-3.7-plus
```

## 它属于哪里

`deepseek-v4.1-flash` 出现在 **Trae IDE（TraeCode）自己的模型菜单**（本机 Trae CN 的
renderer 日志，`model_config_name: "deepseek-v4.1-flash"`）。IDE 的对话链路是
**`create_agent_task`（agent task 协议）**，与 SOLO 轻量通道是两套调用面。

同一批「IDE 有、SOLO 没有」的模型还包括：`glm-5.3-flash`、`kimi-k2.8-preview`。

## 令牌类型不是变量（关键澄清）

实测两类登录令牌 × 两条通道：

| 令牌 | `create_agent_task`（IDE 通道） | `llm_utils_chat`（SOLO 通道） |
|---|---|---|
| Trae IDE CN | 通过绑定层（400 缺字段 = 鉴权 OK） | 200 正常流式 |
| TRAE SOLO CN | **同样通过绑定层** | 200 正常流式 |

**结论：令牌不限制通道**，模型集合由「通道 + function」决定。因此「只保留 IDE 令牌」
既不能让模型变多，也不是接入 IDE 通道的前提（收窄令牌只会减少兼容面）。

## 接入 IDE 通道的现状与未知

已完成的第一轮协议取证（全部停在参数绑定层，**零额度消耗**）：

- 端点：`trae-api-cn.mchost.guru/api/agent/v3/create_agent_task`（国际：`coresg-normal.trae.ai` 同路径，日志实测 289 次）
- 已还原 8 个必填字段：`conversation_id` / `session_id` / `user_id` / `device_id` /
  `agent_type`(string) / `model_name` / `ide_version` / `user_input`(**`ideagent.UserInput` 结构体**)
- **卡点**：`ideagent.UserInput` 的内部必填结构未解开（传 `{text:…}` 仍报 missing）

从安装包挖到的额外线索：

- `[create_agent_task] request body: ` —— IDE 会把完整请求体写进日志（本机日志为压缩格式，未能直接读取）
- `[Hub Bridge] get_models` —— **IDE 的模型列表经本地 Hub Bridge（IPC）从 IDE 前端获取**，不走 HTTP；
  这意味着「IDE 侧模型集合」的获取本身依赖本地进程间协议，不只是换一个 HTTP 端点。
- IDE 通道的会话语义（conversation/session/agent_type/user_input）与 DSH「一次请求一轮对话 +
  本地执行 tool_calls」的模型不同，接入需要一层双向协议适配。

## 复现

```bash
node scripts/probe-code-fields.mjs glm-5.3 12   # 迭代字段还原（零消耗）
node scripts/probe-code-channel.mjs glm-5.3      # 单次最小请求（零消耗）
```

（本文的 function 体检与直接调用验证可用 `scripts/probe-toolcalls.mjs` 的同款脚本改造复跑。）
