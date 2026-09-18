# issue #8 取证：国际版未安装时「Trae Global 加载失败」

> issue：https://github.com/dingminhua/dsh-connect-trae/issues/8
> （hackxmli：「本机没安装国际版,是不是导致国内模型也取不到」）
> 截图报错：
> ```
> Trae Global 加载失败：adapter returned invalid context metadata for provider "trae-global" model "gemini-3.1-pro"
> Trae Global + 自动识图 加载失败：adapter returned invalid context metadata for provider "trae-global-vision" model "gemini-3.1-pro"
> ```
>
> 日期：2026-09-16

## 结论

**用户的猜测方向对了一半，但根因不是「没装国际版导致国内取不到」。**

真实根因：**两个区域的内置兜底目录（fallback）里，每个模型都缺少 `contextWindow` 字段**，
而 DSH 要求它必须是正整数。于是**只要某个区域走了兜底目录**，该区的 provider 就会加载失败。

「没装国际版」只是**触发条件之一**（它让国际区必然走兜底），不是原因本身。
国内版同样有这个缺陷，只是在「国内账号已登录、目录刷新成功」时被实时目录掩盖了。

## 证据链

### 1. DSH 的校验规则（`dsh-llm`）

`@deepseek-ai/dsh-llm/lib/index.js`：

```js
const context = resolved.context;
if (context !== void 0 && (!Number.isInteger(context.contextWindow) || context.contextWindow <= 0))
  throw new LlmError(`adapter returned invalid context metadata for provider "${provider}" model "${model}"`,
                     "INVALID_MODEL_CONTEXT");
```

### 2. 区间内没有默认值可用

`@deepseek-ai/dsh-llm-pi-ai/lib/index.js` 解析每个模型条目：

```js
const contextWindow = entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow;
if (!Number.isInteger(contextWindow) || contextWindow <= 0)
  invalid(provider, `model "${entry.id}" contextWindow must be a positive integer`);
```

即 `entry.contextWindow` 缺失时会依次回退到：
1. 已安装 catalog 的 `base.contextWindow`
2. `request.defaultContextWindow`

而本插件的 `registerAdapter` **没有传 `defaultContextWindow`**（`src/index.ts:647-648`），
且兜底模型不在已安装 catalog 里，两条回退都是 `undefined` → 校验失败。

### 3. 本插件的兜底目录确实没有 `contextWindow`（实测）

```
=== AI fallback（国际版兜底）===
  gemini-3.1-pro           contextWindow=undefined  -> INVALID
  gemini-3-flash-solo      contextWindow=undefined  -> INVALID
  minimax-m3               contextWindow=undefined  -> INVALID
  minimax-m2.7             contextWindow=undefined  -> INVALID
  kimi-k2.5                contextWindow=undefined  -> INVALID
  gpt-5.4                  contextWindow=undefined  -> INVALID
  gpt-5.2                  contextWindow=undefined  -> INVALID
=== CN fallback ===
  DeepSeek-V4-Flash-Official  contextWindow=undefined  -> INVALID
  DeepSeek-V4-Pro-Official    contextWindow=undefined  -> INVALID
  glm-5.2                     contextWindow=undefined  -> INVALID
  kimi-k2.6                   contextWindow=undefined  -> INVALID
```

复现脚本：`node /tmp/repro8.mjs`（导入 `lib/index.js` 的 `FALLBACK_TRAE_MODELS*`）。

`FALLBACK_TRAE_MODELS` 的注释原文即写明「identity only」——它当初被设计成纯身份占位，
但注册给 DSH 的模型**必须**带合法 context，两者冲突。

### 4. 为什么国际区必然走兜底

`src/index.ts` 的启动种子：

```js
const models = await stack.discoverModels()
stack.catalog.set(derive(current(), models, region))
// catch → stack.catalog.set(configuredModels(current(), region))
```

`configuredModels` 在没有任何保存目录时落到 `fallbackModels(value, region)`。
本机没有国际版安装 → 国际区无凭证 → `discoverModels` 抛错 → 走 `configuredModels` → 兜底
→ 每个模型都缺 `contextWindow` → provider 加载失败。

**国内区同理**：如果国内账号未登录、或目录拉取恰好失败（该端点有已知的间歇性 401），
国内 provider 也会以同样方式失败。所以这不是「国际版拖累国内版」，
而是**两个区域各自独立地有这个缺陷**。

### 5. 为什么报告者看到的是 `gemini-3.1-pro`

兜底列表的第一个条目。校验是逐条目抛出的，因此最先报出来的就是列表首项。

## 影响

| 场景 | 结果 |
|---|---|
| 国际版已安装 + 目录刷新成功 | 正常（实时目录带 context） |
| **国际版未安装** | **`trae-global` provider 整个加载失败** |
| 国内账号未登录 / 目录拉取失败 | **`trae` provider 同样加载失败** |
| 首次安装、尚未刷新过目录 | 两区都可能失败 |

失败粒度是 **provider 级**（整区不可用），不是单模型级——这比「少几个模型」严重得多。

## 修复方向

两条都要做：

1. **给兜底目录补上真实 `contextWindow`**（依据实测目录）：
   - AI（`docs/INTL_SG_EVIDENCE.md` §3，2026-09-15 实测）：
     `gemini-3.1-pro` 200000、`gemini-3-flash-solo` 200000、`minimax-m3` 200000、
     `minimax-m2.7` 200000、`kimi-k2.5` 200000、`gpt-5.4` 272000、`gpt-5.2` 272000
   - CN（`docs/DS41_CALLABILITY.md`）：SOLO 通道 200000 / Max 1000000
2. **注册 adapter 时传 `defaultContextWindow`** 作为最终防线，
   这样将来任何来源的条目缺字段都不会再让整个 provider 挂掉。

并补测试：**兜底目录中每个模型都必须有正整数 `contextWindow`**（锁定该不变量）。
