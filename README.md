# dsh-tokensaver

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 移植版 [pi-tokensaver](https://github.com/xilnick/pi-tokensaver)（[Pi coding agent](https://github.com/mariozechner/pi-coding-agent) 扩展）——
> 把 [tokensave](https://github.com/aovestdipaperino/tokensave) 的本地语义图引擎接进 DSH，让 agent 用语义查询代替暴力 grep/读文件，大幅省 token。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.2.0-orange.svg)](https://github.com/Miku196/dsh-tokensave)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blueviolet)](https://github.com/topics/dsh-plugin)

## 它做什么

| pi-tokensaver 阶段 | DSH 中的实现 |
|---|---|
| 1. `tokensave sync` + `.gitignore` 卫生 | **本插件**（apply 时执行 `init`/`sync`） |
| 2. 工具桥接 | **cli 直连**（0.2.0 起 MCP 模式已移除）：`tokensave tool <name> --args <json>`，无 serve 进程、无 MCP，工具名 `tokensave_*` |
| 3. 系统提示词注入 | **本插件**（`ctx.systemPrompt.section`） |
| 4. teardown 杀进程 | 无长驻进程，无需处理 |

装好后模型会自动获得 80+ 个语义图工具（`search` / `callers` / `callees` / `body` / `entities` / `status` / `dead_code` / `circular` …），并在系统提示词中被引导优先使用它们探索代码——一次语义查询省 900–2000 token。

## 安装（web profile 示例）

前置条件：

1. [tokensave](https://github.com/aovestdipaperino/tokensave) 已安装（`cargo install tokensave`，或从 GitHub Releases 下载 `tokensave-vX.Y.Z-x86_64-windows.zip` 解压后放入 PATH）。
2. `dsh` 可用，且 profile 目录有 `pnpm`（`dsh plugin` 依赖）。

### 从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:Miku196/dsh-tokensave
```

### 本地开发安装

```bash
dsh plugin --profile web add file:/path/to/dsh-tokensave
```

### 挂载配置

`dsh-tokensaver` 是 **bundle 插件**（自带 `cordis.patch.yml` 声明，安装后即注册）。**通常无需任何配置**——工具调用自动跟随会话工作目录（见下"索引定位"）。仅在需要固定操作根时（如 headless/无会话场景），在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里用 **id 定位的 config override**——**不要**再 `insert` 同名条目，否则重复声明会导致 dsh 崩溃：

```yaml
- id: tokensaver
  config:
    binary: tokensave            # 可执行文件路径或 PATH 上的命令名（默认）
    cwd: /path/to/your/project   # 可选：固定操作根（默认跟随会话工作目录）
    autoSync: true               # 默认：启动时 init（无索引）/ sync（有索引）
```

> `config` 是整体替换：未写出的字段回落到插件的 schema 默认值。
> 0.2.0 起仅支持 cli 直连，MCP 模式（`bridge: "mcp"` + dsh-mcp-client 行）已移除。

保存后 `dsh web` 会自动热重载（无需重启）。新会话中模型即可调用 `tokensave_search`、`tokensave_callers` 等工具。

### 更新插件

```bash
dsh plugin --profile web update dsh-tokensaver
```

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `binary` | `tokensave` | 可执行文件路径或 PATH 命令名 |
| `cwd` | 跟随会话工作目录 | 可选固定操作根。不配时每次工具调用自动使用**当前会话工作目录**（`exec.agent.session.header.cwd`），无需手动指定 |
| `bridge` | `cli` | 历史字段（仅 `cli`）：0.2.0 起 MCP 模式已移除，填 `mcp` 会报错 |
| `autoSync` | `true` | 启动时 `init`（无索引）/ `sync`（有索引，含祖先索引根） |
| `syncTimeoutMs` | 600000 | 同步超时 |
| `callTimeoutMs` | 120000 | cli 模式单次工具调用超时 |
| `updateCheck` | `true` | 启动时查 crates.io 是否有 tokensave 新版本，有则告警 |
| `updateCheckTimeoutMs` | 10000 | 更新检查网络超时 |
| `promptOrder` | 150 | 提示词 section 顺序（工具指导带 100–199） |
| `gitignoreHygiene` | `true` | 自动把 `.tokensave/` 加进 .gitignore |

### 索引定位（零配置，不用为每个文件夹建索引）

tokensave 只在**精确目录**找索引（不向上/向下查找），而索引覆盖整个目录树。插件因此自动补齐：

- **每次工具调用跟随当前会话工作目录**（`cwd` 未配置时）：目录或其任意**祖先**已有索引（`.tokensave/tokensave.db`）→ 直接使用该索引根，任何子目录、任何盘符（如 `D:\geo` 与 `C:\...\项目`）下工具都自动可用；
- 全新目录（向上找不到索引）→ 首次调用时自动 `tokensave init` 建索引；
- **安全保护**：主目录（`~`）及其直接子目录（Desktop/Documents/Downloads 等）**永不自动 init**——在这些位置工具会给出明确提示，避免误索引整个主目录；
- `~/.tokensave`（tokensave 的全局配置目录）不会被误判为项目索引。

任何失败都优雅降级：binary 缺失时只告警，不阻塞 profile 启动，也不注入提示词（避免模型调用不存在的工具）。

## 开发

```bash
# 1. 链接运行自测所需的依赖（schemastery / dsh-tools 来自 dsh 安装，勿提交 node_modules/）
npm install    # 或手动建 junction：见 test-cli.mjs 头部注释

# 2. cli 桥单元自测（工具发现 / --help 解析 / schema 生成 / 版本检测 / 真实调用）
#    Windows（PowerShell）：
$env:TOKENSAVE_BINARY = "C:\path\to\tokensave.exe"
$env:TOKENSAVE_CWD = "C:\path\to\indexed\project"
node test-cli.mjs

#    macOS / Linux：
#    TOKENSAVE_BINARY=/path/to/tokensave TOKENSAVE_CWD=/path/to/indexed/project node test-cli.mjs
```

## 致谢

- [pi-tokensaver](https://github.com/xilnick/pi-tokensaver)（MIT）— 本插件的功能原型
- [tokensave](https://github.com/aovestdipaperino/tokensave) — Rust 语义图引擎

## License

[MIT](LICENSE) © dsh-tokensaver contributors
