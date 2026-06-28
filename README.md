# dak — Dog Agents Kit CLI

> Language: **English** | [中文版](#中文版)

## What it is / What it does

`dak` is a small local CLI tool that helps you **wire the same set of skills / hooks / agents into multiple AI tools (Codex, Claude Code, etc.) at once, without copying a copy into each tool**.

**How it works**: you put the source files of your skills / hooks / agents into a single folder (the store). dak creates symlinks inside each tool's directory that point back to the source files in the store — it never copies the real files. So:

- One source file, shared by multiple tools;
- Edit the one copy in the store, every tool sees the new content immediately;
- Add a new tool, just run `dak link` to wire it up — no more copying.

**Pain it solves**: you used to keep two copies of the same skill for Codex and Claude Code (`~/.codex/skills/foo` and `~/.claude/skills/foo`); editing foo meant remembering to edit both, and forgetting one left them out of sync. With dak you store one copy and both tools pick it up.

> **Supported tools**: right now only Claude Code and Codex are wired up out of the box. More tools will be added later — PRs welcome. If you can't wait, clone the repo and edit the config file yourself (see [Config file](#config-file) below for the format).

## Installation

**Option 1: npm global install (recommended)**

```bash
npm install -g @dog_world/dak
```

After install the `dak` command is globally available. Requires Node.js >= 20.

Uninstall:

```bash
npm uninstall -g @dog_world/dak
```

> Upgrade the npm version: `npm update -g @dog_world/dak`

**Option 2: install from source**

```bash
git clone https://github.com/zzy1099207684/dog-agents-kit.git && cd dog-agents-kit
npm install
npm run build      # output in dist/
npm link           # register global command dak (or just run node dist/cli.js)
```


## Directory & structure created

After `dak init`, `~/.dog-agents-kit/` (the default store) contains:

```
~/.dog-agents-kit/
├── dak.config.json   # config: store path + target tool mappings
├── .dak-state.json   # link state (managed by dak, don't hand-edit)
├── skills/           # your skills source files
├── hooks/            # your hooks source files
└── agents/           # your agents source files
```

The default config wires up two target tools (written automatically by `dak init`):

| Target name  | Tool root   |
| ------------ | ----------- |
| `codex`      | `~/.codex`  |
| `claudecode` | `~/.claude` |

> The target name is a key you pick, not hardcoded. To add Cursor/Windsurf etc., just edit `dak.config.json`'s `targets` and add a line. Change store location with `dak init --store <path>`; multiple stores can coexist without interfering.

## Command reference

### Usage examples

| Action                              | Example                                |
| ----------------------------------- | -------------------------------------- |
| Initialize store                    | `dak init`                             |
| Initialize at custom location       | `dak init --store ~/my-dak-store`      |
| List store resources                | `dak list`                             |
| List a specific store               | `dak list --store ~/my-dak-store`      |
| Link to Codex                       | `dak link codex`                       |
| Link to Claude Code                 | `dak link claudecode`                  |
| Link all targets at once            | `dak link all`                         |
| Link hooks only                     | `dak link codex -r hooks`              |
| Link skills only                    | `dak link codex -r skills`             |
| Link agents only                    | `dak link codex -r agents`             |
| Backup old file on conflict, link   | `dak link codex --on-conflict backup`  |
| Overwrite on conflict               | `dak link all --on-conflict overwrite` |
| View link status                    | `dak status`                           |
| View skills status only             | `dak status -r skills`                 |
| Sync: add new links, clear stale    | `dak update`                           |
| Sync hooks only                     | `dak update -r hooks`                  |
| Backup on conflict during sync      | `dak update --on-conflict backup`      |
| Unlink all Codex links              | `dak unlink codex`                     |
| Unlink all targets                  | `dak unlink all`                       |
| Unlink agents only                  | `dak unlink codex -r agents`           |
| Unlink hooks from all targets       | `dak unlink all -r hooks`              |

### Command explanations

| Command         | Explanation                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `init`          | Run first. Creates the store dir, default config `dak.config.json`, and an empty state file. Does not overwrite an existing config. |
| `list`          | Lists existing skills / hooks / agents in the store (marks `[dir]` folders, `[link]` symlinks). Never touches any links. |
| `link <target>` | Symlinks store resources into the given target tool dir. `all` = every target in the config. Conflicts handled by `--on-conflict`. |
| `status`        | Shows each resource's link status in the target (`linked`/`missing`/`stale`/`broken`/`conflict`). Read-only. |
| `update`        | Aligns store with already-linked targets: new resources in store get linked, removed resources get unlinked. |
| `unlink <target>` | Removes links, deleting only the symlinks in the target — **never the store source files**. `all` = every target. |

### Common flags

| Flag                                     | Description                                                                                | Applies to                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------- |
| `--store <path>`                         | Specify store path (must match the `store` in config, else `config store mismatch`)        | all                                     |
| `-r` / `--resource <type>`               | Process only one resource type (`skills`/`hooks`/`agents` or custom types declared in config); omit to process all three | `link` / `unlink` / `status` / `update` |
| `--on-conflict <skip\|backup\|overwrite>` | Conflict strategy: skip / backup old / overwrite old                                      | `link` / `update`                       |

> When no conflict strategy is passed: in an interactive terminal (TTY) dak asks per item `[s]kip/[b]ackup/[o]verwrite` (default skip); non-interactive (script/pipe) just skips.
> **Protection rule**: real files, links from other stores, and hand-modified links are always protected (`conflict` status) under `update`/`unlink` — even `--on-conflict overwrite` won't delete them.

## Quick start

```bash
dak init                  # 1. Create the default store (~/.dog-agents-kit/{skills,hooks,agents}/ three empty dirs)
dak link all              # 3. Wire up codex + claudecode at once
dak status                # 4. Check status to confirm
# After that, edit source files in the store → all tools see it immediately;
# run dak update to sync after adding/removing resources.
```

> **Step 2 is manual**: `dak init` only creates empty dirs and copies no resources. You must organize your existing, shareable skill / hook / agent **source files** into the store's corresponding folders before `dak link`:
>
> | Shared resource | Where to put it in the store          |
> | --------------- | ------------------------------------- |
> | skill source    | `~/.dog-agents-kit/skills/`           |
> | hook source     | `~/.dog-agents-kit/hooks/`            |
> | agent source    | `~/.dog-agents-kit/agents/`           |
>
> Example: you previously kept two copies of the same skill at `~/.claude/skills/foo` and `~/.codex/skills/foo`. Now keep only the store copy (`~/.dog-agents-kit/skills/foo`); delete the other two or let `dak link --on-conflict backup` handle them, and editing this one copy updates both tools.

## Config file

`<store>/dak.config.json`, structure:

```jsonc
{
  "store": "~/.dog-agents-kit",        // store path, must match --store after resolution
  "resourceTypes": ["skills", "hooks", "agents"],  // managed resource types, extendable
  "targets": {
    "codex": {
      "path": "~/.codex",              // tool root (supports ~ or absolute path)
      "resources": {                   // sub-path of each resource in the target; missing types are skipped
        "skills": "skills",
        "hooks": "hooks",
        "agents": "agents"
      }
    },
    "claudecode": { "path": "~/.claude", "resources": { "skills": "skills", "hooks": "hooks", "agents": "agents" } }
    // add a new tool: add a line like "cursor": { "path": "...", "resources": { "skills": "skills" } }
  }
}
```

After editing the config, run `dak link` / `dak update` to apply (`init` won't overwrite an existing config).

## Status fields (`status` / `unlink` output)

| Status                                  | Meaning                                                  |
| --------------------------------------- | -------------------------------------------------------- |
| `linked`                                | symlink exists and points to the current store source    |
| `created` / `backed-up` / `overwritten` | newly created / created after backup / created after overwrite |
| `missing`                               | store has this resource but the target path doesn't      |
| `stale`                                 | state has a record but store source was deleted (`update` clears it) |
| `broken`                                | symlink points to a non-existent target                  |
| `conflict`                              | target location is a real file or external symlink (protected, not deleted) |
| `deleted`                               | link safely deleted this run                             |

---

# 中文版

> 语言：[English](#dak--dog-agents-kit-cli) | **中文版**

## 这是什么 / 做什么用

`dak` 是一个本机命令行小工具,帮你**把同一批 skills / hooks / agents 同时接到多个 AI 工具(Codex、Claude Code 等)上,还不用每个工具都复制一份**。

**怎么做到的**:你把 skill / hook / agent 的源文件集中放进一个文件夹(store)。dak 在各工具目录里建「软链接」(快捷方式)指回 store 里的源文件,不复制实体文件。于是:

- 一份源文件,多个工具共用;
- 改 store 里这一份,所有工具立刻看到新内容;
- 新加工具,跑一下 `dak link` 就接上,不用再复制。

**解决的痛点**:同一 skill 想给 Codex 和 Claude Code 用,以前得复制两份(`~/.codex/skills/foo` 和 `~/.claude/skills/foo`),改了 foo 得记着改两处,漏一处就不同步。用 dak 只存一份,两边都生效。

> **支持的工具**:目前开箱即用的只有 Claude Code 和 Codex。后续会增加更多工具,也欢迎提 PR。急用的话,可以自己下载项目改配置文件(格式见下方 [配置文件](#配置文件))。

## 安装

**方式一：npm 全局安装（推荐）**

```bash
npm install -g @dog_world/dak
```

装完后 `dak` 命令全局可用。需要 Node.js >= 20。

卸载：

```bash
npm uninstall -g @dog_world/dak
```

> 升级 npm 安装版：`npm update -g @dog_world/dak`

**方式二：从源码安装**

```bash
git clone https://github.com/zzy1099207684/dog-agents-kit.git && cd dog-agents-kit
npm install
npm run build      # 产物在 dist/
npm link           # 注册全局命令 dak（或直接 node dist/cli.js）
```


## 创建的目录与结构

`dak init` 后在 `~/.dog-agents-kit/`（默认 store）生成：

```
~/.dog-agents-kit/
├── dak.config.json   # 配置：store 路径 + 目标工具映射
├── .dak-state.json   # 链接状态（dak 自维护，别手改）
├── skills/           # 你的 skills 源文件
├── hooks/            # 你的 hooks 源文件
└── agents/           # 你的 agents 源文件
```

默认配置两个目标工具（`dak init` 自动写入）：

| 目标名       | 工具根目录  |
| ------------ | ----------- |
| `codex`      | `~/.codex`  |
| `claudecode` | `~/.claude` |

> 目标名是自己起的 key，不是写死的。想加 Cursor/Windsurf 等工具，直接编辑 `dak.config.json` 的 `targets` 加一行即可。换 store 位置用 `dak init --store <path>`，多 store 并存互不干扰。

## 指令大集合

### 用法示例

| 指令                   | 示例                                   |
| ---------------------- | -------------------------------------- |
| 初始化 store           | `dak init`                             |
| 初始化到自定义位置     | `dak init --store ~/my-dak-store`      |
| 列出 store 资源        | `dak list`                             |
| 列出指定 store         | `dak list --store ~/my-dak-store`      |
| 链接到 Codex           | `dak link codex`                       |
| 链接到 Claude Code     | `dak link claudecode`                  |
| 一次性链全部目标       | `dak link all`                         |
| 只链 hooks             | `dak link codex -r hooks`              |
| 只链 skills            | `dak link codex -r skills`             |
| 只链 agents            | `dak link codex -r agents`             |
| 冲突时备份旧文件再链   | `dak link codex --on-conflict backup`  |
| 冲突时直接覆盖         | `dak link all --on-conflict overwrite` |
| 查看链接状态           | `dak status`                           |
| 只看 skills 状态       | `dak status -r skills`                 |
| 同步：补新链、清失效链 | `dak update`                           |
| 只同步 hooks           | `dak update -r hooks`                  |
| 同步时冲突先备份       | `dak update --on-conflict backup`      |
| 取消 Codex 全部链接    | `dak unlink codex`                     |
| 取消所有目标链接       | `dak unlink all`                       |
| 只取消 agents 链接     | `dak unlink codex -r agents`           |
| 取消所有目标的 hooks   | `dak unlink all -r hooks`              |

### 指令解释

| 指令            | 解释                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `init`          | 首次使用跑。建 store 目录、生成默认配置 `dak.config.json` 和空状态文件。配置已存在则不覆盖。       |
| `list`          | 列出 store 里现有的 skills / hooks / agents（标注 `[dir]` 文件夹、`[link]` 软链）。不碰任何链接。  |
| `link <目标>`   | 把 store 资源软链接到指定目标工具目录。`all` = 配置里所有目标。冲突按 `--on-conflict` 处理。       |
| `status`        | 查看每个资源在目标里的链接状态（`linked`/`missing`/`stale`/`broken`/`conflict`）。只读，不改东西。 |
| `update`        | 对齐 store 与已链接目标：store 新增的资源自动补链、store 删掉的资源自动清链。                      |
| `unlink <目标>` | 取消链接，只删目标里的软链，**不删 store 源文件**。`all` = 取消所有目标。                          |

### 通用参数

| 参数                                      | 说明                                                                                       | 适用命令                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------- |
| `--store <path>`                          | 指定 store 路径（须与配置里 `store` 一致，否则报 `config store mismatch`）                 | 全部                                    |
| `-r` / `--resource <类型>`                | 只处理某一类资源（`skills`/`hooks`/`agents` 或 config 声明的自定义类型），不传则三类全处理 | `link` / `unlink` / `status` / `update` |
| `--on-conflict <skip\|backup\|overwrite>` | 冲突处理策略：跳过 / 备份旧的 / 覆盖旧的                                                   | `link` / `update`                       |

> 冲突策略没传时：交互式终端（TTY）里 dak 逐个问你 `[s]kip/[b]ackup/[o]verwrite`（默认 skip）；非交互（脚本/管道）直接 skip。
> **保护规则**：真实文件、其他 store 的链接、手动改过的链接，在 `update`/`unlink` 里永远受保护（`conflict` 状态），传 `--on-conflict overwrite` 也不会删。

## 快速上手

```bash
dak init                  # 1. 建默认 store (~/.dog-agents-kit/{skills,hooks,agents}/ 三个空目录)
dak link all              # 3. 一键链到 codex + claudecode
dak status                # 4. 看状态确认
# 之后改了 store 里的源文件 → 所有工具立即可见；
# 新增/删除资源后跑 dak update 对齐。
```

> **第 2 步要手动做**：`dak init` 只建空目录，不会复制任何资源。你得把自己现有的、想多工具共用的 skill / hook / agent **源文件**整理进 store 对应文件夹，再 `dak link`：
>
> | 共用资源       | 放进 store 的位置                    |
> | -------------- | ------------------------------------ |
> | skill 源文件   | `~/.dog-agents-kit/skills/`          |
> | hook 源文件    | `~/.dog-agents-kit/hooks/`           |
> | agent 源文件   | `~/.dog-agents-kit/agents/`          |
>
> 举例：你原先在 `~/.claude/skills/foo` 和 `~/.codex/skills/foo` 各存了一份同一个 skill，现在只留 store 这一份（`~/.dog-agents-kit/skills/foo`），原两处删掉或让 `dak link` 用 `--on-conflict backup` 处理，之后改这一份两边都生效。

## 配置文件

`<store>/dak.config.json`，结构：

```jsonc
{
  "store": "~/.dog-agents-kit",        // store 路径，须与 --store 解析后一致
  "resourceTypes": ["skills", "hooks", "agents"],  // 受管理资源类型，可加自定义
  "targets": {
    "codex": {
      "path": "~/.codex",              // 工具根目录（支持 ~ 或绝对路径）
      "resources": {                   // 各资源在目标里的子路径；缺哪类就跳过哪类
        "skills": "skills",
        "hooks": "hooks",
        "agents": "agents"
      }
    },
    "claudecode": { "path": "~/.claude", "resources": { "skills": "skills", "hooks": "hooks", "agents": "agents" } }
    // 加新工具：在这加一行 "cursor": { "path": "...", "resources": { "skills": "skills" } }
  }
}
```

改完配置后跑 `dak link` / `dak update` 生效（`init` 不会覆盖已存在的配置）。

## 状态字段（`status` / `unlink` 输出）

| 状态                                    | 含义                                             |
| --------------------------------------- | ------------------------------------------------ |
| `linked`                                | 软链存在且指向当前 store 源                      |
| `created` / `backed-up` / `overwritten` | 本次新建 / 备份后新建 / 覆盖后新建               |
| `missing`                               | store 有此资源，但目标路径不存在                 |
| `stale`                                 | state 有记录，但 store 源已删（`update` 会清掉） |
| `broken`                                | 软链指向不存在的目标                             |
| `conflict`                              | 目标位置是真实文件或外部软链（受保护，不删）     |
| `deleted`                               | 本次安全删除链接                                 |
