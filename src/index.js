/**
 * dsh-tokensaver — DSH 移植版 pi-tokensaver
 *
 * pi-tokensaver 的 4 个阶段在 DSH 里的归属：
 *   1. init/sync 语义图 + .gitignore 卫生  → 本插件（apply 时同步执行）
 *   2. 工具桥接                            → cli 直连（0.2.0 起 MCP 模式已移除）：
 *        `tokensave tool <name> --args <json>` 调用，无需 serve 进程、
 *        无需 MCP，工具名 tokensave_*。
 *   3. 系统提示词注入                        → 本插件（ctx.systemPrompt.section）
 *   4. teardown                            → 无长驻进程，无需处理
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import s from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

const execFileAsync = promisify(execFile);

/** Cordis plugin name used by loader diagnostics. */
export const name = "tokensaver";

/** 本插件不硬依赖任何服务；systemPrompt / tools 采用机会式获取。 */
export const inject = [];

/** 配置 schema（schemastery）。 */
export const Config = s.object({
  /** tokensave 可执行文件路径或 PATH 上的命令名。 */
  binary: s.string().default("tokensave"),
  /** 项目根目录；缺省用启动 dsh 的目录（process.cwd()）。 */
  cwd: s.string().default(""),
  /** 启动时执行 init（无索引）/ sync（有索引）。false 则只注入提示词。 */
  autoSync: s.boolean().default(true),
  /** 同步超时（毫秒）。 */
  syncTimeoutMs: s.number().default(10 * 60 * 1000),
  /** 提示词 section 的 order（工具指导带 100–199）。 */
  promptOrder: s.number().default(150),
  /** 保持 .gitignore 卫生（非 git 仓库自动跳过）。 */
  gitignoreHygiene: s.boolean().default(true),
  /**
   * 桥接模式（历史字段）：0.2.0 起 MCP 模式已移除，仅支持 "cli"（直连）。
   * 旧的 "mcp" 值会在加载时报错——删除该键或改为 "cli" 即可。
   */
  bridge: s.union(["cli"]).default("cli"),
  /** cli 模式：单次工具调用超时（毫秒）。 */
  callTimeoutMs: s.number().default(120 * 1000),
  /** 启动时检查 tokensave 是否有新版本（查 crates.io API）。 */
  updateCheck: s.boolean().default(true),
  /** 更新检查网络超时（毫秒）。 */
  updateCheckTimeoutMs: s.number().default(10 * 1000),
});

/**
 * 插件入口。apply 期间 await 同步，保证工具注册前索引已就绪。
 * 任何失败都降级（只记录日志），不阻塞 profile 启动 —— 与原插件"优雅失败"一致。
 */
export async function apply(ctx, config) {
  const root = config.cwd || process.cwd();
  const logger = ctx.logger ?? console;

  // ── Phase 1: 校验 binary + 同步语义图 ──
  let binaryOk = false;
  let installedVersion = "";
  try {
    const version = await execFileAsync(config.binary, ["--version"], {
      windowsHide: true,
      timeout: 15_000,
    });
    binaryOk = true;
    installedVersion = parseVersion(version.stdout) ?? "";
    logger.info(`tokensaver: binary ok (${version.stdout.trim()})`);
  } catch (err) {
    logger.warn(
      `tokensaver: binary "${config.binary}" not usable (${err.message}); ` +
        "工具不会注册。可用 `cargo install tokensave` 安装。"
    );
  }

  // ── Phase 1.5: 更新检测（查 crates.io 最新版）──
  if (binaryOk && config.updateCheck) {
    try {
      const latest = await fetchLatestTokensaveVersion(config.updateCheckTimeoutMs);
      if (latest && installedVersion && isNewer(latest, installedVersion)) {
        logger.warn(
          `tokensaver: tokensave v${installedVersion} is outdated — latest v${latest} ` +
            "(run `tokensave upgrade` to update)"
        );
      } else if (latest && installedVersion) {
        logger.info(`tokensaver: tokensave is up to date (v${installedVersion})`);
      }
    } catch (err) {
      // 网络不可用时不打扰：仅 info 级别
      logger.info(`tokensaver: update check skipped (${err.message})`);
    }
  }

  if (binaryOk && config.autoSync) {
    try {
      const indexed = existsSync(join(root, ".tokensave"));
      const args = indexed ? ["sync", root] : ["init", root];
      const { stdout } = await execFileAsync(config.binary, args, {
        cwd: root,
        windowsHide: true,
        timeout: config.syncTimeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
      logger.info(
        `tokensaver: ${indexed ? "sync" : "init"} ok (${root}) — ${stdout.trim() || "index ready"}`
      );
    } catch (err) {
      // 同步失败不致命：serve / CLI 仍可服务已有索引
      logger.warn(`tokensaver: index ${existsSync(join(root, ".tokensave")) ? "sync" : "init"} failed: ${err.message}`);
    }

    if (config.gitignoreHygiene) {
      try {
        await ensureGitignore(root);
      } catch {
        // 非 git 仓库或 git 不可用：忽略
      }
    }
  }

  // ── Phase 2: 工具注册（cli 直连；0.2.0 起 MCP 模式已移除）──
  let toolNames = []; // 提示词里列出的工具名

  if (binaryOk) {
    const tools = ctx.get("tools");
    if (tools) {
      try {
        const discovered = await discoverTools(config.binary, root);
        // 并行取每个工具的 --help 以生成参数 schema
        const withSchemas = await Promise.all(
          discovered.map(async (t) => {
            try {
              const help = await run(
                config.binary, ["tool", t.name, "--help"], root, config.callTimeoutMs
              );
              return { ...t, params: parseToolHelp(help) };
            } catch {
              return { ...t, params: [] };
            }
          })
        );
        for (const t of withSchemas) {
          const publicName = `tokensave_${t.name}`;
          const schema = buildToolSchema(t.name, t.description, t.params);
          tools.register(defineTool({
            name: publicName,
            description: t.description,
            parameters: schema,
            output: {
              schema: { type: "json" },
              render: (_args, value) => [
                { type: "text", text: JSON.stringify(value, null, 2) },
              ],
            },
            async execute(args, exec) {
              const out = await run(
                config.binary, ["tool", t.name, "--args", JSON.stringify(args)],
                root, config.callTimeoutMs, exec.signal
              );
              const trimmed = out.trim();
              if (!trimmed) return null;
              return JSON.parse(trimmed);
            },
          }));
          toolNames.push(publicName);
        }
        logger.info(`tokensaver: cli bridge registered ${toolNames.length} tools`);
      } catch (err) {
        logger.warn(`tokensaver: cli bridge failed (${err.message})`);
      }
    } else {
      logger.warn("tokensaver: ctx.tools 不可用，跳过工具注册");
    }
  }

  // ── Phase 3: 提示词注入（只在 binary 可用时注册，避免模型被指向不存在的工具）──
  const systemPrompt = ctx.get("systemPrompt");
  if (binaryOk && toolNames.length > 0 && systemPrompt) {
    systemPrompt.section({
      name: "tokensaver:guidance",
      order: config.promptOrder,
      text: [
        "## TokenSave semantic graph tools",
        "",
        `Prefer the \`${toolNames[0]}\` tools for codebase exploration — finding`,
        "functions, their callers, types, and imports. They query a pre-built local",
        "semantic graph and are dramatically more token-efficient than reading whole",
        "files or running raw grep/glob.",
        "",
        "Fall back to grep/glob/read only when the semantic tools genuinely cannot",
        "answer (e.g. exact file content at specific line numbers or binary files).",
        "",
      ].join("\n"),
    });
  }

  // ── Phase 4: teardown ──
  // 无长驻进程（cli 直连），无需处理。
}

// ---------------------------------------------------------------------------
// cli 桥：发现工具 / 解析参数 schema / 执行调用
// ---------------------------------------------------------------------------

/** 执行一次 tokensave CLI 调用；非零退出抛错，stdout 原样返回。 */
async function run(binary, args, cwd, timeoutMs, signal) {
  const { stdout } = await execFileAsync(binary, args, {
    cwd,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  return stdout;
}

/**
 * 发现可用工具：解析 `tokensave tool`（裸命令）输出。
 * 输出形如：
 *   Available tools (run `tokensave tool <name> --help` for parameters):
 *
 *   [analysis]
 *     circular                          Detect circular dependencies ...
 *     complexity                        Rank functions/methods ...
 */
export async function discoverTools(binary, cwd) {
  const out = await run(binary, ["tool"], cwd, 30_000);
  const tools = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("  ") && !line.trimStart().startsWith("[")) {
      const m = line.match(/^ {2}([A-Za-z0-9_]+)\s+(.+)$/);
      if (m) tools.push({ name: m[1], description: m[2].trim() });
    }
  }
  return tools;
}

/**
 * 解析单个工具的 `--help` 输出，提取参数定义。
 * 输出形如：
 *   Parameters:
 *     --max-depth                  number   optional  Maximum traversal depth ...
 *     --node-id                    string   required  The unique node ID ...
 *   Reserved flags: --json, --project <path>, --args <json>, -h/--help
 *
 * @returns [{ flag, type, required, description }]
 */
export function parseToolHelp(helpText) {
  const params = [];
  const lines = helpText.split(/\r?\n/);
  let inParams = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "Parameters:") { inParams = true; continue; }
    if (!inParams) continue;
    if (!trimmed || trimmed.startsWith("Reserved flags")) break;
    const m = trimmed.match(/^--([a-z0-9-]+)\s+(\S+)\s+(required|optional)\s*(.*)$/);
    if (m) {
      params.push({
        flag: m[1],
        type: m[2],
        required: m[3] === "required",
        description: m[4].trim(),
      });
    } else if (params.length > 0 && !trimmed.startsWith("--")) {
      // clap 换行续行：追加到上一个参数的描述
      params[params.length - 1].description += " " + trimmed;
    }
  }
  return params;
}

/** kebab-case → camelCase（--path-exclude → pathExclude）。 */
export function kebabToCamel(flag) {
  return flag.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * 把 CLI 参数定义映射成 DSH defineTool 的参数 schema。
 * clap 类型：string / number / boolean / array。
 */
export function buildToolSchema(toolName, _description, params) {
  const properties = {};
  for (const p of params) {
    const key = kebabToCamel(p.flag);
    let spec;
    switch (p.type) {
      case "number":
        spec = { type: "number" };
        break;
      case "boolean":
        spec = { type: "boolean" };
        break;
      case "array":
        spec = { type: "array", items: { type: "string" } };
        break;
      default:
        spec = { type: "string" };
    }
    if (p.required) spec.required = true;
    if (p.description) spec.description = p.description;
    properties[key] = spec;
  }
  return properties;
}

// ---------------------------------------------------------------------------
// 更新检测：查 crates.io 最新版本
// ---------------------------------------------------------------------------

/** 从 `tokensave --version` 输出里提取版本号（如 "tokensave 7.9.0" → "7.9.0"）。 */
export function parseVersion(text) {
  const m = String(text || "").match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return m ? m[1] : null;
}

/** 语义化比较：a 比 b 新返回 true（逐段比较点分数字段，忽略 pre-release 后缀）。 */
export function isNewer(a, b) {
  const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db;
  }
  return false;
}

/**
 * 查询 crates.io 上 tokensave 的最新稳定版本。
 * crates.io 要求 User-Agent；超时由 AbortSignal 控制。
 * 网络不可用 / 解析失败时抛错，调用方负责降级。
 */
export async function fetchLatestTokensaveVersion(timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://crates.io/api/v1/crates/tokensave", {
      headers: { "User-Agent": "dsh-tokensaver/update-check" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`crates.io HTTP ${res.status}`);
    const data = await res.json();
    return data?.crate?.max_stable_version ?? null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// gitignore 卫生
// ---------------------------------------------------------------------------

/**
 * 像 pi-tokensaver 一样，把 `.tokensave/` 追加进 .gitignore（尊重全局 ignore 规则）。
 * 仅当 `git check-ignore` 明确说"未忽略"时才写入。
 */
async function ensureGitignore(root) {
  const git = async (...args) => {
    try {
      const { code } = await execFileAsync("git", args, {
        cwd: root,
        windowsHide: true,
        timeout: 15_000,
      });
      return code;
    } catch (err) {
      // execFile 对非零退出会 reject；code 在 err 上
      return err.code;
    }
  };

  if ((await git("rev-parse", "--is-inside-work-tree")) !== 0) return;

  // 0 = 已忽略, 1 = 未忽略, 128 = 错误
  const ignored = await git("check-ignore", "-q", ".tokensave/");
  if (ignored !== 1) return;

  await appendFile(
    join(root, ".gitignore"),
    "\n# TokenSave semantic graph data\n.tokensave/\n"
  );
}
