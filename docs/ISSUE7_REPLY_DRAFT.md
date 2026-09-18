# issue #7 回复（2.0.2 发布后贴）

> 用途：回复 https://github.com/dingminhua/dsh-connect-trae/issues/7
> （zyk-mjzs：「traecode 有 glm 5.3 但这边只有 5.2」；BrowserZz 追加：「traecode 有
> GLM-5.3-Flash、DeepSeek-V4.1-Flash 模型。什么时候支持？」）
>
> **先发布 2.0.2 到 npm，确认 `npm view dsh-connect-trae version` 显示 2.0.2
> 之后再贴。** 可直接复制横线以内的内容。

---

感谢 @zyk-mjzs @BrowserZz 两位的反馈，这里一次说清结论。

## 结论

**TraeCode 通道的这 4 个模型，本插件目前不支持——需要等官方开放到 SOLO 通道。**

| 模型 | 状态 |
| --- | --- |
| `glm-5.3-flash` | 暂不支持（TraeCode 通道） |
| `deepseek-v4.1-flash` | 暂不支持（TraeCode 通道） |
| `kimi-k2.8-preview` | 暂不支持（TraeCode 通道） |
| `qwen3.8-flash` | 暂不支持（TraeCode 通道） |

它们目前只在 **Trae IDE 客户端**内可用。插件走的是 Trae 的 **SOLO 通道**，这条通道上没有它们，所以插件侧拿不到——不是漏读目录，而是没有可调用的通道。

**需要等官方把这批模型开放到 SOLO 通道后，插件才能支持。**

## 关于 GLM-5.3：这个已经支持了

@zyk-mjzs 提到的 **GLM-5.3 其实已经支持**（2.0.2 起）。请更新后再看一下：

```bash
npm i -g dsh-connect-trae@2.0.2
```

> 顺带区分一个容易混的点：**`GLM-5.3` 支持**（走 SOLO），**`glm-5.3-flash` 不支持**——名字像，但是两个不同的模型。

## 为什么拿不到

我逐条实测过所有可能的路径，都不通，且原因各不相同：

- **`create_agent_task`（TraeCode 的对话协议）**：绑定层已解开（HTTP 200 + SSE），但业务层卡在 `4001 config item is empty`——它需要 IDE 客户端本地注册的 config，插件无法伪造。
- **`/api/ide/v1/agents/runs`**：端点存在、鉴权通过，返回账号级 `5003 agent running quota limit is exceeded`。
- **本地 Hub Bridge / Aha IPC**：存在，但是私有协议，且要求 IDE 同机常驻。
- **TraeCLI（`trae-cli`）**：公网版需要交互式 SSO 登录；而且它**本身就是 agent**，模型出口是私有后端（`/trae-cli/api/v1/llm/proxy` + 私有头），不是可复用的 LLM 代理。用它就等于让 TraeCLI 干活、DSH 退化成壳，与插件定位冲突。

一句话：这属于**上游授权边界**，不是插件能绕过的技术问题。取证细节我留在了仓库里（`docs/DS41_CALLABILITY.md`、`docs/CODEC_CHANNEL_FEASIBILITY.md`、`docs/TRAECLI_FEASIBILITY.md`）。

## 现在想用这 4 个模型怎么办

**直接用 Trae IDE 本体。**

## 插件会怎么处理

这 4 个模型**不会出现在插件列表里**——因为「能选中但每次对话都失败」比「不显示」更糟。README 的「模型覆盖范围」一节也写清楚了同样的事。

如果哪天官方把它们开放到 SOLO 通道，插件会自动出现在列表里（目录是实时拉取的），不需要改代码。

再次感谢反馈 🙏
