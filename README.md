# dsh-tokensaver

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 移植版 [pi-tokensaver](https://github.com/xilnick/pi-tokensaver)（[Pi coding agent](https://github.com/mariozechner/pi-coding-agent) 扩展）——
> 把 [tokensave](https://github.com/aovestdipaperino/tokensave) 的本地语义图引擎接进 DSH，让 agent 用语义查询代替暴力 grep/读文件，大幅省 token。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.1.1-orange.svg)](https://github.com/Miku196/dsh-tokensave)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blueviolet)](https://github.com/topics/dsh-plugin)

## 它做什么

| pi-tokensaver 阶段 | DSH 中的实现 |
|---|---|
| 1. `tokensave sync` + `.gitignore` 卫生 | **本插件**（apply 时执行 `init`/`sync`） |
| 2. 工具桥接（两种模式） | **`bridge: "mcp"`**：官方 `@deepseek-ai/dsh-mcp-client`（握手/重连/超时，工具名 `mcp__tokensave__*`）<br>**`bridge: "cli"`**：本插件直接调 `tokensave tool`，无 MCP、无长驻进程，工具名 `tokensave_*` |
| 3. 系统提示词注入 | **本插件**（`ctx.systemPrompt.section`） |
| 4. teardown 杀进程 | mcp 模式由 mcp-client 负责；cli 模式无长驻进程 |

装好后模型会自动获得 80+ 个语义图工具（`search` / `callers` / `callees` / `body` / `entities` / `status` / `dead_code` / `circular` …），并在系统提示词中被引导优先使用它们探索代码——一次语义查询省 900–2000 token，`tokensave_metrics` 可量化每次调用省了多少。

### cli 模式 vs mcp 模式

| | `bridge: "cli"`（推荐） | `bridge: "mcp"` |
|---|---|---|
| 依赖 | 只有本插件 | 本插件 + dsh-mcp-client 行 |
| 长驻进程 | 无（每次调用 ~70ms 冷启动） | `tokensave serve` 常驻 |
| 工具名 | `tokensave_search` | `mcp__tokensave__tokensave_search` |
| 失败模式 | 单次调用失败 | 连接/重连管理 |

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
dsh plugin --profile web add file:/path/to/dsh-tokensaver
```

### 挂载配置

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里加（**cli 模式只需一行**）：

```yaml
- insert:
    - id: tokensaver
      name: dsh-tokensaver
      config:
        bridge: cli                  # 直连模式：无需 serve 进程、无需 MCP
        binary: /path/to/tokensave   # 或 PATH 上的命令名
        cwd: /path/to/your/project   # 语义图所在目录
        autoSync: true
```

> **mcp 模式**需要两行（顺序不能反）：先本插件（`bridge: mcp` 或省略），
> 再一行 `@deepseek-ai/dsh-mcp-client` 指向 `tokensave serve`，工具名带 `mcp__` 前缀。

保存后 `dsh web` 会自动热重载（无需重启）。新会话中模型即可调用 `tokensave_search`、`tokensave_callers` 等工具。

### 更新插件

```bash
dsh plugin --profile web update dsh-tokensaver
```

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `binary` | `tokensave` | 可执行文件路径或 PATH 命令名 |
| `cwd` | `process.cwd()` | 项目根目录（语义图所在目录） |
| `bridge` | `mcp` | 工具桥接模式：`cli`（直连，推荐）或 `mcp`（配合 dsh-mcp-client） |
| `autoSync` | `true` | 启动时 `init`（无索引）/ `sync`（有索引） |
| `syncTimeoutMs` | 600000 | 同步超时 |
| `callTimeoutMs` | 120000 | cli 模式单次工具调用超时 |
| `updateCheck` | `true` | 启动时查 crates.io 是否有 tokensave 新版本，有则告警 |
| `updateCheckTimeoutMs` | 10000 | 更新检查网络超时 |
| `promptOrder` | 150 | 提示词 section 顺序（工具指导带 100–199） |
| `gitignoreHygiene` | `true` | 自动把 `.tokensave/` 加进 .gitignore |

任何失败都优雅降级：binary 缺失时只告警，不阻塞 profile 启动，也不注入提示词（避免模型调用不存在的工具）。

## 开发

```bash
# 1. cli 桥单元自测（工具发现 / --help 解析 / schema 生成 / 真实调用）
TOKENSAVE_BINARY=/path/to/tokensave TOKENSAVE_CWD=/path/to/your/project node test-cli.mjs

# 2. MCP 冒烟测试（验证 tokensave serve 的 MCP 协议与工具可用性）
TOKENSAVE_BINARY=/path/to/tokensave \
TOKENSAVE_CWD=/path/to/your/project \
MCP_SDK_DIR=/path/to/@modelcontextprotocol/sdk/dist/esm \
node smoke-test.mjs
```

## 致谢

- [pi-tokensaver](https://github.com/xilnick/pi-tokensaver)（MIT）— 本插件的功能原型
- [tokensave](https://github.com/aovestdipaperino/tokensave) — Rust 语义图引擎
- [@deepseek-ai/dsh-mcp-client](https://github.com/deepseek-ai/deepseek-harness) — MCP 桥接

## License

[MIT](LICENSE) © dsh-tokensaver contributors
