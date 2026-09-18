# TraeCode 通道（create_agent_task）可行性取证

> 背景：issue #7 暴露「TraeCode 侧模型（glm-5.3 / glm-5.3-flash / kimi-k2.8-preview /
> deepseek-v4.1-flash）不在插件模型列表里」。产品决策问题：**国内与国际是否都放弃
> SOLO 通道、只走 TraeCode 通道**。本文是「先验证再定」的取证结果。
>
> 取证时间 2026-09-15（CN 账号）。**全部请求都停在参数绑定层，零额度消耗。**

## 一、结论摘要

| 问题 | 答案 |
|---|---|
| `create_agent_task` 端点可达、鉴权通过？ | **是**（用插件现有的 `Cloud-IDE-JWT` + identity 头即可，绑定层正常响应） |
| 能否最小化 body？ | **不能**——它是**有状态的会话任务**协议，必填字段远多于 chat |
| 已还原的必填字段 | 见下表（13 个） |
| 协议语义 | **会话/任务型**（`conversation_id` + `session_id` + `agent_type` + `user_input` 结构体），不是无状态 chat |
| 对 DSH 的适配成本 | **高**：需要实现「会话任务协议 ↔ chat completions」双向转换 + 工具调用回传 |

## 二、必填字段还原（Go 绑定的报错逐个点名，零消耗）

上游是 Go 实现，缺字段时的错误形如：

```
{"code":4001,"message":"bad request: binding: expr_path=<field>, cause=missing required parameter"}
```

依次点名的字段（每轮补一个，6→9 轮）：

| # | 字段 | 类型/值 | 说明 |
|---|---|---|---|
| 1 | `conversation_id` | string(uuid) | **会话 ID** — 有状态协议的第一个标记 |
| 2 | `session_id` | string(uuid) | 会话内的一次执行 |
| 3 | `user_id` | string | 真实账号 ID |
| 4 | `device_id` | string | 设备标识 |
| 5 | `agent_type` | **string** | 传数字会被拒：`cannot unmarshal number into Go struct field CreateAgentTaskRequest.agent_type of type string` |
| 6 | `model_name` | string | 模型名 |
| 7 | `ide_version` | string | IDE 版本号 |
| 8 | `user_input` | **对象 `ideagent.UserInput`** | 传字符串会被拒：`cannot unmarshal string into Go struct field CreateAgentTaskRequest.user_input of type ideagent.UserInput` |
| — | `messages` / `model` / `config_name` / `function` / `stream` / `request_id` | | 插件草案里的字段，一并携带 |

**未解开**：`ideagent.UserInput` 的内部必填结构（传 `{text: "..."}` 仍被报
"missing required parameter"，说明其内部还有必填子字段）。继续盲猜的组合空间大，需要
从 bundle（`out/vs/workbench/*.js`、`modules/ai-agent/libai_agent.dylib`）或真实 IDE
抓包取得定义。

## 三、与 SOLO 通道的语义差异（决定性）

| 维度 | SOLO 通道（现用） | TraeCode 通道 |
|---|---|---|
| 调用形态 | 无状态 `chat completions` 风格：一次请求 = 一轮对话 | **有状态会话任务**：`conversation_id`/`session_id`/`agent_type`/`user_input` |
| 谁执行工具 | **客户端**（DSH 本地执行 read/write/bash，结果回传模型） | **Trae 云端 agent**（历史日志出现过 `commit_toolcall_result`，即 IDE 作为客户端提交工具结果——那个客户端是 Trae IDE 自己） |
| 与 DSH 抽象的匹配度 | 天然匹配（shim → PiAiAdapter 的 chat seam） | **不匹配**：需要把「长连接会话任务」双向转换成「多轮 chat + 工具回传」 |
| body 复杂度 | 简版 envelope（~1KB） | 实测约 146KB（历史/技能/上下文/agent 类型等） |
| 已实现度 | **生产在用**，CN + 国际均已端到端验证 | 未接入 |

## 四、可行性判断

**技术上可行，但不是「换个 endpoint」，而是一个协议适配引擎。**

若要让 DSH 只走 TraeCode 通道，需要：

1. **还原完整请求形态**：`ideagent.UserInput` 结构、必填字段全集、agent 类型枚举
   （当前只到第 8 个字段就卡住）。
2. **实现会话-任务协议适配**：DSH 的 PiAiAdapter 是「一次请求一轮对话」，而
   `create_agent_task` 是「一个会话长连接 + 云端 agent 执行」。需要：
   - 工具调用事件 → DSH 本地执行 → `commit_toolcall_result` 回传的完整闭环；
   - 会话生命周期管理（创建/续接/中断/超时）；
   - 上下文构造（历史/技能/记忆字段，IDE 侧约 146KB 的体量）。
3. **接受上游不确定性**：该协议无公开文档、字段集庞大、上游随时可能调整；调试
   只能靠受控探测。

**风险**：若 TraeCode 通道的工具事件**不允许客户端接管执行**（例如只回最终文本），
DSH 将失去本地工具调用能力（read/write/bash 全失效）——这是功能倒退。此点在
跑通一次完整任务前**无法确认**。

## 五、建议

| 选项 | 说明 | 建议 |
|---|---|---|
| A. 保持 SOLO 通道 | 现有能力不减，TraeCode 侧模型（glm-5.3 等）在卡片上标注「当前通道不支持」 | **短期推荐**：零风险，先消除用户困惑 |
| B. 继续受控取证 | 再投入一轮：解开 `UserInput`、跑通一次最小任务、观察事件里是否出现「可交给客户端执行」的工具调用 | **中期推荐**：这是决定 A/C 的前提，且单次成本可控 |
| C. 全量切换到 TraeCode | 放弃 SOLO | **暂不推荐**：协议未取证完毕、工具语义未确认、工作量与风险都最大 |

**决策所需的关键未知只有一个**：TraeCode 通道的事件流里，工具调用**是否可由客户端执行**
（而非 Trae 自执行）。这一项一旦确认，A/B/C 的取舍立刻清晰。

## 六、复现方式

```bash
# 迭代字段还原（零消耗，全部停在绑定层）
node scripts/probe-code-fields.mjs glm-5.3 12

# 单次最小请求（观察绑定层反应）
node scripts/probe-code-channel.mjs glm-5.3
```

两个脚本都不打印 token，也不修改账号状态。

---

# 追加：create_agent_task 请求体已解开（2026-09-16）

## 已解开的部分（本轮重大进展）

`create_agent_task` 的**参数绑定层已完全通过**（HTTP 200 + SSE，不再报 missing required
parameter）。可用的请求体结构：

```jsonc
{
  "messages": [{ "role": "user", "content": [{ "type": "text", "text": "..." }] }],
  "model": "<model>", "config_name": "<model>", "model_name": "<model>",
  "function": "<function>",          // 见下方卡点
  "stream": true,
  "request_id": "<uuid>", "conversation_id": "<uuid>", "session_id": "<uuid>",
  "user_id": "<account user id>", "device_id": "<device id>",
  "agent_type": "chat", "mode_type": 0,
  "ide_version": "<appVersion>",
  "user_input": {                     // ideagent.UserInput
    "id": "<uuid>",                   // 必填（binder 逐层点名 expr_path=user_input.id）
    "text": "...", "content": "...", "type": "text", "role": "user"
  }
}
```

要点：binder 逐层点名（`expr_path=user_input` → `expr_path=user_input.id`），补上 `id`
后绑定通过；Go 会忽略未知字段，因此可以一次性投喂多个候选字段名来加速定位。

## 当前卡点（业务层）：`config item is empty for config opt`

通过绑定层后，上游按请求参数查找一个**服务端配置项**并失败：

```
code:4001  message: "config item is empty for config opt:
  {"AppId":"6eefa01c-…","Function":"chat","ConfigName":"deepseek-v4.1-flash",
   "VersionCode":20260716,"PluginChannel":null,"IdeVersion":"3.3.100",
   "ModeType":0,"AgentType":…}"
```

说明：**服务端正确解析出了 `ConfigName: deepseek-v4.1-flash`**，但找不到与之匹配的
config。遍历 `function` 的 7 个候选值（`inline_chat` / `chat` / `agent` / `solo_agent` /
`solo_work_remote` / `builder` / `code`）结果一致，因此卡点不在 function 参数。

对照证据（本机 Trae 安装包的 `libai_agent.dylib` 字符串）：

- `INSERT INTO model_config_cache (user_id, env, function, config_data, updated_at)`
  —— 客户端本地有**模型配置缓存表**；
- `[Hub Bridge] get_models: user_id is empty, skip request` —— IDE 的模型列表经
  **本地 Hub Bridge（IPC）** 获取；
- `upsert-config --check-and-recovery-env --storage-path --config-name` —— 存在
  **配置注册/上报**的动作。

**推断**：`create_agent_task` 依赖的是「客户端注册到服务端的 config」，而 IDE 的模型
菜单走的是另一条路（本地缓存 + Hub Bridge）。这解释了为什么公开生态里没有该通道的
成功实现——门槛不止是协议格式，还有**配置注册链路**。

## 下一步的验证点

1. 找到 config 注册动作（`upsert-config` 相关的本地 IPC / 远程端点），确认能否为
   `deepseek-v4.1-flash` 建立服务端 config；
2. 或改用 `/api/ide/v1/agents/runs`（实测存在且鉴权通过，返回 `code:5003` agent 配额类
   错误）探索另一条 agent 路径；
3. 若两者都被「客户端注册链路」挡住，则结论是：**该模型只能由 Trae 客户端自身使用**，
   插件侧应维持 SOLO 通道（14 个模型）。

## 复现

```bash
node scripts/probe-agent-task-body.mjs deepseek-v4.1-flash 14   # 绑定层解算（零额度）
node scripts/probe-code-fields.mjs glm-5.3 12                   # 更早的必填字段还原
```

---

# 最终结论：三条 agent 路径的阻塞点与可行性判定（2026-09-16）

## 三条路径的实测状态

| 路径 | 实测结果 | 阻塞点 |
|---|---|---|
| `POST /api/agent/v3/create_agent_task` | 绑定层**完全通过**（HTTP 200 + SSE），请求体已完整解开 | 业务层 `4001 config item is empty for config opt` —— 需客户端注册的 config |
| `POST /api/ide/v1/agents/runs` | 端点存在、鉴权通过（最小 body 与 GET 都返回同一业务错误） | **`5003 We're sorry, your agent running quota limit is exceeded.`** —— **账号级 agent 运行配额** |
| 本地 Hub Bridge / Aha IPC（IDE 自身所用） | 确认存在（`1.10-main.sock`、私有 socket、51000 端口不答 HTTP） | 私有 IPC 协议，且**要求本机运行 Trae IDE** |

## 判定

**这三条都通向同一个事实：IDE 侧能力（含 deepseek-v4.1-flash / glm-5.3-flash /
kimi-k2.8-preview）是「Trae 客户端专属」的，不对第三方 API 消费者开放。**

- `create_agent_task` 需要**客户端先把 config 注册到服务端**（本地 `model_config_cache`
  表 + Hub Bridge + `upsert-config` 链路），第三方无法凭空构造；
- `agents/runs` 直接受**账号 agent 运行配额**约束（本机 CN 账号实测已超出）；
- 本地 IPC 路线要求插件与 Trae IDE 同机运行，与「DSH 插件只读本机登录态」的形态冲突。

因此：**在可预见的范围内，插件无法通过 agent 通道获得这些模型。** 这不是协议难度问题
（协议我们已经解开），而是**授权与配额边界**问题。

## 对项目的意义

| 结论 | 说明 |
|---|---|
| SOLO 通道是 Trae 开放给 API 的通道 | `llm_utils_chat` 稳定可用，本插件已覆盖其全部 14 个模型（含 glm-5.3） |
| IDE 侧模型不可得 | 除非上游把模型下放到 SOLO 目录，或官方开放 agent API |
| 本轮的资产 | `create_agent_task` 的完整请求体结构、绑定层逐字段解算方法、三条路径的阻塞点证据——若未来官方开放 agent API，这些可直接复用 |

## 交付建议

维持 SOLO 通道（2.0.2 已把该通道的模型全部放出），把本轮调研与解算结果作为技术资产
存档；不再为此投入实现工作量。
