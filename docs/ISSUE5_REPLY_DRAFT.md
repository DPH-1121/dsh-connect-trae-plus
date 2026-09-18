# issue #5 回复草稿（发布 2.0.1 之后再贴）

> 用途：回复 https://github.com/dingminhua/dsh-connect-trae/issues/5 中 JoberYongk 反馈的「模型列表显示不出来」。
> 发布 2.0.1 到 npm 并确认 `npm view dsh-connect-trae version` 显示 2.0.1 后，再把下面横线以内的内容贴到 issue。

---

感谢反馈，你提到的**「模型列表显示不出来」我已经定位到根因并修复（v2.0.1）**——它和上次的「未登录」是两个不同层的问题，你让 AI 修的方向应该也是这个。

## 问题原因

上次（1.4.x）修的是**凭据层**：让插件认得出 `traecli` 写在 `~/.trae-cn/trae-jwt-token` 的裸 JWT。所以账号列表能出来了。

但**身份层**当时没动，它仍然只认桌面版：

```
~/.config/<Trae 目录名>/User/globalStorage/storage.json   ← 机器/设备 ID 的唯一来源
```

请求头发给 Trae 的 `x-machine-id` / `x-device-id` / `x-app-version` 全从这份文件读。而纯 CLI 环境（WSL2 常见）**根本没有这份文件**，于是身份解析直接抛错——而**模型目录查询和每一次聊天请求都需要先构造这些头**，所以：

- 模型目录永远拉不到 → 只能显示插件自带的兜底列表（看起来「显示不出来 / 对不上」）
- 即使选中兜底列表里的模型，对话也会失败

## 修复内容（v2.0.1）

桌面安装一个都没有时，身份解析降级到 **CLI 家目录自己写下的持久化标识**，不再报错：

- `~/.trae-cn/argv.json` 的 `crash-reporter-id`（CLI 首次运行写入的稳定 UUID）→ 设备 ID
- `~/.trae-cn/builtin/ide_version.json` 的 `version` → `x-app-version`
- 设备 ID + 主机名 + 用户名做 SHA-256 → 64 字符 `x-machine-id`（与官方客户端形态一致）

这些都是 CLI 自己持久化的稳定值，**不是每次请求随机生成的假身份**；机器上有桌面版时仍然优先使用桌面版的 `machineid` / `telemetry.machineId`。另外，如果桌面文件存在但内容损坏，仍然会把真实错误报出来，不会被降级掩盖。

## 升级方式

```bash
npm i -g dsh-connect-trae@2.0.1
```

## 如果升级后仍不正常

麻烦回帖告知一下，特别是这两点：

1. 卡片现在显示的模型列表**有哪些模型名**（截图即可）
2. 你之前让 AI 修复「模型列表显示不出来」时**具体改了什么**（比如是不是也在补 `x-machine-id` / `x-device-id`）——如果思路不同，我想对照一下，避免漏掉别的路径

> ⚠️ 仍然提醒：**不要贴 `cat ~/.trae-cn/trae-jwt-token` 的输出**，那是 token 本身。目录名列表（`ls -d ~/.trae* ~/.config/*[Tt]rae*`）可以放心贴。

---

## 备注（发布后自查，勿贴）

- **v2.0.1 已于 2026-09-15 发布**：npm `latest = 2.0.1`、tag `v2.0.1` → `ef8b19e`、
  GitHub Release https://github.com/dingminhua/dsh-connect-trae/releases/tag/v2.0.1
- 发布后一致性核验（RELEASING.md 第 8 步）：8 个源文件与 tagged 提交逐字节一致；
  `lib/` 由 tagged 源码重建后与 npm 产物逐字节相同；修复代码（`crash-reporter-id`
  与 `resolveTraeIdentity`）确认在发布包内
- 修复提交：`ef8b19e`（含 6 个 CLI-only 身份解析用例，226/226 全绿）
- 验证方式：临时 home 内只放 `~/.trae-cn/{trae-jwt-token,argv.json,builtin/ide_version.json}`，确认 `resolveTraeIdentity` 由「必抛」变为成功返回（machineId 64 hex、deviceId 取 crash-reporter-id、appVersion 取 CLI version）
- 若用户回帖说仍失败，下一步要取证的是：**官方 traecli 实际发送的请求头集合**（本机已无 traecli 可执行文件，无法自行抓取）
