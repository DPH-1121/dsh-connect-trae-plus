# 接入 Trae 的开源项目调研（2026-09-15）

> 目的：为「是否接入 Trae IDE 通道（`create_agent_task`）以拿到 IDE 侧模型
> （deepseek-v4.1-flash / glm-5.3-flash / kimi-k2.8-preview）」寻找先例与做法参考。

## 一、结论先说

**开源生态里没有任何项目真正实现了 Trae IDE 的 agent-task 通道。** 现有项目全部停在
「SOLO 通道」或「IDE 旧 chat 端点」两条路上，它们的模型集合都不包含 IDE 的新模型。
换句话说：**要做 IDE 通道，是一次没有先例可抄的逆向工程。**

## 二、调研到的项目与路线

| 项目 | 语言/热度 | 使用的端点 | 能拿到 IDE 新模型吗 |
|---|---|---|---|
| [`Sliverkiss/traework2api`](https://github.com/Sliverkiss/traework2api)（本机 `traework2api/`） | Go | `llm_utils_chat`（`function=solo_work_lite`）+ `get_detail_param` | ❌ SOLO 侧 14 个 |
| [`laojichao/trae-local-api`](https://github.com/laojichao/trae-local-api) | JS ⭐54（2026-07 更新） | 主：`llm_utils_chat`（`function=inline_chat`）；失败后**盲试** `/api/ide/v1/chat`、`create_agent_task` | ❌ |
| 本机 `trae2api/`（已停更） | Go | `/api/ide/v1/model_list?type=chat` + `/api/ide/v1/chat` | ❌ 实测 8 个旧模型 |
| [`arch3rPro/Trae-Proxy`](https://github.com/arch3rPro/Trae-Proxy) | Python ⭐195 | OpenAI 请求转发代理（与 Trae 接入无关） | — |
| [`asakumizy/dsh-trae-bridge`](https://github.com/asakumizy/dsh-trae-bridge) | JS（DSH 同类插件） | 以 subagent/CLI 方式接 Trae（无独立上游协议实现） | — |
| 本项目 `dsh-connect-trae` | TS | 多 function 并集 + 按模型回放 function | ❌（同 SOLO 侧） |

## 三、关键观察

### 1. 「三端点盲试」不是 agent-task 实现

`laojichao/trae-local-api` 的 `trae-client.js` 头部注释写得很清楚：

```js
 * 1. /api/agent/v3/llm_utils_chat (primary - lightweight chat)
 * 2. /api/ide/v1/chat (fallback 1 - standard chat)
 * 3. /api/agent/v3/create_agent_task (fallback 2 - full agent)
```

但它的实现是 **`for (const endpoint of endpoints)` 用同一个 chat body 依次尝试**，并没有为
`create_agent_task` 构造专门的 agent-task body。因此它必然撞上我们实测到的绑定校验
（`conversation_id` / `session_id` / `user_id` / `device_id` / `agent_type` /
`model_name` / `ide_version` / `user_input` 等必填字段）——**「列在 fallback 里」不等于
「能工作」**。

### 2. 身份处理上，多数项目走的是本项目已明确拒绝的路

同一项目用：

```js
function generateMachineId() { return crypto.randomBytes(32).toString('hex'); }   // 每次请求随机
```

即**每个请求随机生成 machine id**。本项目的 `docs/ANALYSIS.md` 已把这种做法列为失败样本的
特征（上游对设备的稳定性有校验，随机身份在真实使用中不可靠），本项目改为从 Trae 自身持久化
的 `machineid` / `telemetry.machineId` 读取，并在纯 CLI 环境降级到 CLI 家目录的稳定标识。

### 3. 兼容层项目普遍做「模型名映射」而非「原生模型集完整」

`laojichao/trae-local-api` 维护一张 `MODEL_MAP`，把 `claude-opus-4-7`、`gpt-4o` 等外部名字
映射到 Trae 侧模型（`glm-5.2`、`DeepSeek-V4-Pro`…）。这类项目的目标客户是 Claude Code /
Cursor 等客户端，**只求「能跑」，不追求把 Trae 的模型菜单完整暴露**——与本项目的目标不同。

### 4. 国际版 host 的一个新线索

该项目用 `DEFAULT_BASE_URL_SG = 'https://a0ai-api-sg.byteintlapi.com'`（与
本项目实测的 `coresg-normal.trae.ai` 不同）。可作为国际版网关的**备用常量**记录
（本项目当前网关已验证可用，不急于切换）。

## 四、对本项目决策的意义

| 选项 | 先例 | 风险 |
|---|---|---|
| 继续 SOLO 通道（现状，2.0.2 已放出 SOLO 全部 14 个模型，含 glm-5.3） | 多项目验证 | 低 |
| 接入 IDE `create_agent_task` | **无先例** | 高：协议未公开、`ideagent.UserInput` 结构未解、IDE 模型列表还依赖本地 Hub Bridge IPC、且需解决「工具调用能否交给客户端执行」这一未知 |
| 接入 IDE 旧 chat 端点（`/api/ide/v1/chat`） | 有（trae2api，已停更） | 中：实测只覆盖 8 个旧模型，拿不到新模型，收益不足 |

**建议**：把 IDE 通道当作**独立的探索性项目**（先做可行性验证：解开 `UserInput`、
跑通一次最小任务、确认工具调用归属），而不是当作「换个端点」的增量改动。在它成功前，
SOLO 通道（本项目的 2.0.2）已是开源生态里对该账号能力覆盖最全的实现。

## 五、调研方法与可复现命令

```bash
# 端点与做法（本文件结论的主要来源）
curl -s https://api.github.com/repos/laojichao/trae-local-api/contents/src/trae-client.js \
  -H "Accept: application/vnd.github.raw" | grep -nE "endpoint|function:|MODEL_MAP|BASE_URL"

# IDE 旧 chat 端点的模型列表（本机实测 8 个旧模型）
# GET https://trae-api-cn.mchost.guru/api/ide/v1/model_list?type=chat

# 本项目的相关取证
node scripts/probe-code-fields.mjs glm-5.3 12   # create_agent_task 必填字段还原
node scripts/probe-toolcalls.mjs                # SOLO 各 function 工具调用能力
```

> 搜索覆盖面：GitHub 平台搜索（多组关键词）、web 搜索（中英文）、本机已有的 4 个参考项目
> 源码。未发现任何项目或文章描述 `create_agent_task` 的成功实现细节。

## 六、关于「是否必须走 agent-task 通道」的补充调研（2026-09-16）

### 6.1 发现了一个系统性的逆向资料库

[`vibe-coding-labs/trae-reverse-engineering`](https://github.com/vibe-coding-labs/trae-reverse-engineering)
（JS，2026-07 更新）对 Trae 的 `ai-agent`（本机那个 199MB 的原生库）做了 11 轮分析，
产出 `analysis/iteration-*.md` 共 11 份文档（含 CLI LLM proxy、IPC/RPC、工具调用/MCP、
模型配置、实现指南）。这是目前能找到的**唯一系统性 Trae 协议逆向资料**。

其 `iteration-11-final-summary.md` 给出的端点表（节选）：

```
AI:
POST /trae-cli/api/v1/llm/proxy      ← OpenAI 兼容的 LLM 代理（Codex CLI 集成用）
POST /api/ide/v1/chat
GET  /api/ide/v1/model_list
POST /api/ide/v1/agents/runs         ← agent 运行（SSE）
```

`iteration-4-tool-call-mcp-analysis.md` 给出了**工具调用闭环**的关键证据：

```
// POST /api/ide/v1/agents/runs/:id/tool_call_outputs   ← 客户端提交工具执行结果
def handle_tool_call(tool_call):
    tool_id  = tool_call['id']
    tool_name = tool_call['name']
    arguments = tool_call['input']

事件：agent_task_plan_first_token / agent_task_plan_sub_agents /
      agent_model_llm_stream_first_token / agent_model_llm_stream /
      agent_task_plan_finish / agent_task_plan_final_token
```

**含义**：agent 通道**确实允许客户端执行工具并回传结果**（这正是 DSH 需要的模式），
因此它在能力上能承载 DSH 的工具循环——这是一个**正面结论**。

### 6.2 本机验证（零消耗）

| 探测 | 结果 |
|---|---|
| `GET /api/ide/v1/model_list?type=chat` | 200，**8 个旧模型**（seed_m8 / Doubao-1.5 / deepseek-R1·V3·V3-0324 / kimi-k3 / deepseek-v4-pro·flash）——**无 v4.1** |
| `GET .../model_list?type=builder` | 200，3 个（kimi-k3 / deepseek-v4-pro / deepseek-v4-flash） |
| `type=agent/all/code/chat_agent/...` | 400（无此 type） |
| `/api/ide/v1/get_all_models`、`/v2/models`、`/available_models`、`/model_configs`、`/api/agent/v3/models` | 全部 404 |
| **`POST /api/ide/v1/agents/runs`** | **200 + SSE**，`code:5003`（agent 运行配额类）→ **端点存在、鉴权通过** |
| `POST /trae-cli/api/v1/llm/proxy`（4 个候选 host） | 全部 404 → 它是 **Trae CLI 的本地端点**，不是远程 API |
| 本机监听端口 | Trae CN 在 `127.0.0.1:51000` 监听，但**不响应 HTTP**（私有 IPC）；另有 `1.10-main.sock` 等 Unix socket |

### 6.3 结论：要用 deepseek-v4.1-flash，是否必须走 agent 通道？

**是（在远程 API 层面）。** 理由：

1. SOLO 通道的**全部 8 个 function** 都没有该模型（上一章已证）；
2. **所有 HTTP 模型列表端点**都不暴露它；
3. 它只出现在 **IDE 自己的模型菜单**里，而那份菜单的数据来源是
   **本地 Hub Bridge（IPC）** 或 **agent 运行通道**；
4. 本地那个「OpenAI 兼容代理」(`/trae-cli/api/v1/llm/proxy`) 是**进程内私有服务**
   （本机 51000 端口不答 HTTP），依赖本机运行 Trae CLI/IDE，不能作为插件的远程通道。

**但结论是建设性的**：agent 通道既然有 `tool_call_outputs` 回传端点，就**具备承载
DSH 工具循环的能力**；缺的是完整实现（会话生命周期、事件解析、工具回传、上下文构造），
而上述逆向资料正好提供了所需的协议地图。

### 6.4 可选路径

| 路径 | 说明 | 评估 |
|---|---|---|
| A. 保持 SOLO 通道 | 14 个模型（含 glm-5.3），生产验证 | 现状，零风险 |
| B. 实现 agent 通道 | 依上述逆向资料实现 `create_agent_task` / `agents/runs` 适配 | 中等偏大工程；**有资料可依**，且能一次性拿到 IDE 全部模型 |
| C. 等上游下放 | 若 Trae 把 v4.1 等模型放进 SOLO 目录，则自动可用 | 不可控 |

**建议**：若要投入 B，第一步应是**跑通一次最小 agent 任务**（用逆向资料解开
`ideagent.UserInput` 结构），确认工具调用回传闭环后再评估完整实现的工作量。
