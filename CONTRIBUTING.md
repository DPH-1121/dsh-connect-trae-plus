# 这个仓库是什么

**`dsh-connect-trae` 加固分支的源码仓** —— 包名 `dsh-connect-trae`，版本线 `2.0.4-dsh.N`。

| | |
|---|---|
| 上游（原始插件） | [`dingminhua/dsh-connect-trae`](https://github.com/dingminhua/dsh-connect-trae) `v2.0.4`，commit `9c7c1139b707e11933ae107a8e0213b4ab229614` |
| 本仓库 | `HaydenSmith1121/dsh-connect-trae-plus` —— 加固分支，**唯一能改这个插件的源码的地方** |
| 插件集合（分发产物） | [`HaydenSmith1121/dsh-plugin-collection`](https://github.com/HaydenSmith1121/dsh-plugin-collection) → `plugins/dsh-connect-trae/` |
| 插件市场（目录） | [`HaydenSmith1121/dsh-plugins`](https://github.com/HaydenSmith1121/dsh-plugins) |

**改了什么、为什么改**：见 [`FORK.md`](./FORK.md)（机制、修复清单、证据、复现步骤）。

---

## 三个仓库的分工（别搞混）

```
本仓库（源码）              ← 你在这里改代码
   │  pnpm run build / pnpm pack
   ▼
插件集合（冻结的 tarball）   ← 只放产物 + 说明，**不许改已发布版本的字节**
   │  manifest.json 被市场采集
   ▼
插件市场（目录配置）         ← 用户面板读的那一份
```

三条硬规矩：

1. **源码只在本仓库改。** 插件集合里 `plugins/dsh-connect-trae/` 下的 tarball 是**产物**，
   改它等于换掉用户装到的那份字节，会让集合仓库的 sha256 校验直接报错。
2. **已发布的版本不许重建。** 同一个版本号对应的字节一旦发布就冻结：要改就发新版本
   （`2.0.4-dsh.2` → …），在集合仓库里**新增** tarball 文件，不要覆盖。
3. **市场那边不用手写。** 市场的采集脚本读集合仓库的 `manifest.json` 自动生成目录配置，
   版本号 / sha256 / 下载地址全部照抄。

## 发一个新版本

```bash
# 1) 改代码 + 升版本号（package.json 与 CHANGELOG.md 同一次提交）
#    版本线约定：2.0.4-dsh.1 → 2.0.4-dsh.2 …（上游发 2.0.5 时再考虑跟进）
pnpm install
pnpm run check          # typecheck + test + build
pnpm pack               # 产出 dsh-connect-trae-<版本>.tgz

# 2) 把 tarball 放进插件集合仓库（新增文件，不覆盖旧版本）
#    plugins/dsh-connect-trae/0.1.6-alpha.1/dsh-connect-trae-<版本>.tgz
#    snapshots/dsh-connect-trae/<版本>/dsh-connect-trae-<版本>.tgz   ← 同字节副本
#    改 plugins/dsh-connect-trae/plugin.json，然后：
node scripts/build-manifest.mjs      # 在集合仓库里跑，重新生成 manifest.json

# 3) 提交并推送两边。市场目录由它的每日定时任务自动跟上（也可 workflow_dispatch 手动触发）
```

## 本地开发

```bash
pnpm install
pnpm run typecheck   # tsc，宿主 + 客户端两套配置
pnpm test            # 243 例
pnpm run build       # tsdown → lib/
pnpm run check       # 上面三件事一起跑
```

`lib/` 不进版本库（`.gitignore` 已忽略）—— 它是构建产物，随 tarball 分发。
发布时 `files` 白名单会把 `lib`、`src`、`tests`、`docs` 一起打进包：
**产物给运行时，源码与测试给复核**，这是本分支刻意保留的差异（上游包只带 `lib` 与文档）。

## 与上游的关系

本分支**不打算长期分叉**。上游若采纳等效修复，本仓库应退役、直接回到上游包。
发现上游也有这个问题，可以反馈到上游 issue：<https://github.com/dingminhua/dsh-connect-trae/issues>。

## 许可

MIT。上游代码版权归原作者 dingminhua（包内 `LICENSE` 为上游原文，未改写）；
本分支的改动同样以 MIT 发布。归属说明见包内 `THIRD_PARTY_NOTICES.md`。
