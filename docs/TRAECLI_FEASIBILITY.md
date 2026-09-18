# TraeCLI（trae-cli）实测取证

> 日期：2026-09-16
> 目的：验证「让 DSH 直接调用 Trae CLI」这条路能否让插件拿到 IDE 独占的 4 个模型
> （`deepseek-v4.1-flash` / `glm-5.3-flash` / `kimi-k2.8-preview` / `qwen3.8-flash`）。
> 结论：**不可行**。CLI 是一个自带 agent 的终端 Code Agent，不是可复用的模型代理；
> 且公网版 CLI 需要交互式 SSO 登录才能拿到任何模型。

---

## 1. 安装与版本

安装命令（官方引导的公网版）：

```bash
sh -c "$(curl -L https://trae.cn/trae-cli/install.sh)"
```

| 项 | 值 |
|---|---|
| 版本 | `0.120.52` |
| build date | `2026-08-12T01:31:30Z` |
| build commit | `6756e52a9238b6d493928e55b05127957dbfefb4` |
| 平台 | darwin/arm64 |
| 二进制 | `~/.local/share/trae-cli/trae-cli` |
| 符号链接 | `~/.local/bin/{trae-cli,traecli,trae-agent,ta}` |

内部标识：Go 模块路径 `code.byted.org/nextcode/coco/tenant/trae/cli/...`，
即 TraeCLI 是字节内部 **coco** 体系的 `tenant/trae/cli` 分支。

---

## 2. 关键否定证据

### 2.1 未登录 → 零模型

```console
$ trae-cli models --json
[]
```

```console
$ trae-cli --json -p "hi"
{
  "session_id": "4eb6ddfa-...",
  "agent_states": [{"messages": null, "instruction": null, "tools": null}],
  "error": "failed to create agent: failed to create agent: Models is required"
}
```

`~/Library/Caches/trae-cli/log/root.log` 反复打印：

```json
{"level":"ERROR","msg":"failed to get models from provider",
 "error":"failed to get value from keyring: secret not found in keyring"}
```

**凭证存放位置**：macOS Keychain（`keyring.macOSXKeychain`，走 `security find-generic-password`）。
实测 keychain 中**不存在**任何 `trae-cli` 条目：

```console
$ security find-generic-password -s "trae-cli"
security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.
```

**结论**：模型列表**完全由云端下发**，依赖 keyring 中的登录凭证。
本地 YAML 写死 `models:` 不能凭空造出模型（实测无效，见 §2.2）。

### 2.2 本地自定义 YAML 无法绕过

按官方 `model-config` 文档，provider 只有
`open_ai` / `claude` / `gemini` / `deepseek` / `ark` / `byted_gpt`。
尝试用文档未列出的 `trae:` provider：

```yaml
# /tmp/traeprobe/.trae/traecli.yaml
model:
  name: "m1"
models:
  - name: "m1"
    trae:
      model: "deepseek-v4.1-flash"
```

```console
$ trae-cli models --json
[]
$ trae-cli doctor
  ✘ model: no effective model configured
```

**结论**：`trae` provider 是**内置、隐藏、且受登录态门控**的，
不是用户可声明的 YAML provider。

### 2.3 公网版必须交互式 `/login`

二进制内字符串：

```
Please use /login to sign in first.
user not logged in
invalid trae model
```

官方 FAQ「安装版本不对（误装公网版）」明确：

> - TUI 内有 `/login` 命令（**内部版本没有 `/login`**，这是最直接的判定信号）。
> - 公网版本（`docs.trae.cn` 引导安装的对外版 TraeCLI）在内场无法登录、无可用模型。

FAQ 亦说明认证降级后果：

> **根因：** 当前系统没有可用 keyring……token 在进程退出后丢失。
> **修复：** 无 keyring 环境下，SSO token **无法跨进程持久化**。

**结论**：公网 CLI 的登录是**交互式 SSO**（浏览器回调 `http://localhost:%d/callback`，
`authentication timeout after 5 minutes`）。DSH 插件**无法在后台静默完成**并持久化凭证。

---

## 3. 架构判定：CLI 不是模型代理，是完整 Agent

这是**决定性**的一点。二进制中包含完整的 agent runtime：

```
coco/adk/model/failover/...
coco/adk/model/loopdetection/...
coco/adk/model/retry/retry_model.go
coco/adk/model/sanitize/sanitize.go
coco/adk/model/timeout/...
```

以及 tool 体系：

```
Bash / Edit / Replace / InsertStringAtCurrentPosition
text_editor_code_execution_create_result
findReferences / documentSymbol / callHierarchy
LSP server %s: send request %s
```

CLI 自己的 agent 配置项（`--help` 可见）：
`--allowed-tool` / `--disallowed-tool` / `--permission-mode` / `--yolo` /
`--add-dir` / `-w/--worktree` / `--resume` / `--session-id`。

它的模型出口是**自家后端**：

```
/trae-cli/api/v1/llm/proxy
```

`chatmodel.(*ModelProvider).newTraeModel` / `chatmodel.TraeChatModel`：
`buildRequest` → `Generate` / `Stream`，带 `anthropic_messages` APIFormat，
注入 `X-IDE-Version-Codex-*`、`trae_remote_log_id`、`cli_session_invoke` 等私有头。

实测本地端口（Trae CN `51000`、TRAE SOLO CN `51001`）**均不提供 HTTP**
（`curl` 返回 `000`）；`17788` 对该路径返回 `404`。
`/trae-cli/api/v1/llm/proxy` 是 **CLI 进程自己对外发起**的上游路径，
不是一个可供第三方挂载的本地服务。

### 判定

| 维度 | TraeCLI 事实 |
|---|---|
| 它是不是可调用的 LLM 代理？ | **不是**。`-p` 跑的是它自己的 agent loop |
| 它会不会把 `tool_calls` 交给调用方执行？ | **不会**。它自己执行 tool（Bash/Edit/…） |
| 它的模型出口能否被 DSH 复用？ | 不能。私有头 + 私有后端 + 登录态门控 |
| 用它工作，谁是 agent？ | **CLI 是 agent，DSH 退化为壳** |

**这正是用户明确否决的形态**：

> 如果用 trae cli 就变成了用 trae cli 干活，并不是用 dsh 干活了？

因此「让 DSH 调用 Trae CLI 以获取 4 个 IDE 独占模型」**不成立**，直接否决。

---

## 4. 与既有三条路径的关系

| 路径 | 阻塞点 | 状态 |
|---|---|---|
| `create_agent_task` | 业务错误 `4001 config item is empty for config opt`（需客户端注册 config） | 已否决 |
| `/api/ide/v1/agents/runs` | `5003 agent running quota limit is exceeded`（账号级配额） | 已否决 |
| 本地 Hub Bridge / Aha IPC | 私有协议，要求 IDE 同机常驻 | 已否决 |
| **TraeCLI** | 自带 agent + 交互式 SSO 登录 + keyring 凭证 | **本次否决** |

四条路径全部走不通，且否决原因**互相独立**（协议 / 配额 / 同机 / 登录态与 agent 归属）。
这不是「还没找到正确调用方式」，而是**上游没有开放可复用的模型出口**。

---

## 5. 对插件的最终建议

1. **不再投入** CLI 路径，也不建议引导用户安装 TraeCLI。
2. 4 个 IDE 独占模型（`deepseek-v4.1-flash`、`glm-5.3-flash`、
   `kimi-k2.8-preview`、`qwen3.8-flash`）**在插件中标记为不可用**，
   不进入模型目录、不提供选择项。
3. 插件继续走**已验证可用**的通道矩阵：
   - SOLO 通道（14 模型，含 `glm-5.3`，工具调用已实测）
   - Trae Code 通道
   - 区域：`cn` / `ai` 双套存储
4. 用户若确实要用这 4 个模型，**走 Trae IDE 本体**，而非 DSH 插件。

---

## 6. 复现命令

```bash
# 安装
sh -c "$(curl -L https://trae.cn/trae-cli/install.sh)"

# 观察零模型 + 未登录
trae-cli models --json          # []
trae-cli doctor                 # ✘ model: no effective model configured
trae-cli --json -p "hi"         # error: Models is required

# 观察 keyring 缺失
tail -5 ~/Library/Caches/trae-cli/log/root.log
security find-generic-password -s "trae-cli"   # not found

# 观察 CLI 自带 agent 面
trae-cli --help                 # acp/config/doctor/mcp/models/plugin/update
trae-cli doc model-config       # 仅 open_ai/claude/gemini/deepseek/ark/byted_gpt

# 观察本地端口无 HTTP
curl -m 3 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:51000/trae-cli/api/v1/llm/proxy  # 000
```
