/**
 * cli 桥单元自测：发现工具 → 解析 --help → 生成 schema → 真实调用。
 * 运行前需要 node_modules 链接（见根 README 开发节）。
 */
import { execFileSync } from "node:child_process";
import { discoverTools, parseToolHelp, buildToolSchema, kebabToCamel } from "./src/index.js";

const BIN = process.env.TOKENSAVE_BINARY ?? "C:\\Users\\wangz\\.cargo\\bin\\tokensave.exe";
const CWD = process.env.TOKENSAVE_CWD ?? process.cwd();

// 1. 发现
const tools = await discoverTools(BIN, CWD);
console.log(`1) discovered ${tools.length} tools`);
const search = tools.find((t) => t.name === "search");
const callers = tools.find((t) => t.name === "callers");
const status = tools.find((t) => t.name === "status");
console.log("   search desc:", search?.description.slice(0, 60));
console.log("   callers desc:", callers?.description.slice(0, 60));
console.log("   status exists:", !!status);
if (!search || !callers || !status) throw new Error("discovery incomplete");

// 2. --help 解析 + schema 生成
for (const t of [search, callers, status]) {
  const help = execFileSync(BIN, ["tool", t.name, "--help"], { cwd: CWD, encoding: "utf8", windowsHide: true });
  const params = parseToolHelp(help);
  const schema = buildToolSchema(t.name, t.description, params);
  console.log(`2) ${t.name}: ${params.length} params ->`, JSON.stringify(schema));
}

// 3. kebab → camel
console.log("3) kebabToCamel:", kebabToCamel("path-exclude"), kebabToCamel("node-id"), kebabToCamel("max-depth"));

// 4. 真实调用 + 耗时
const t0 = Date.now();
const out = execFileSync(BIN, ["tool", "search", "--args", JSON.stringify({ query: "ensureGitignore" })], {
  cwd: CWD, encoding: "utf8", windowsHide: true,
});
const ms = Date.now() - t0;
console.log(`4) tool search ok (${ms}ms):`, out.trim().slice(0, 120));

console.log("CLI BRIDGE SELF-TEST PASSED");
