/**
 * MCP 冒烟测试：用 @modelcontextprotocol/sdk 连 `tokensave serve`，
 * 走完整的 initialize → tools/list → tools/call 流程。
 * 模拟 dsh-mcp-client 会对这个 server 做的事。
 *
 * 环境变量（均有默认值）：
 *   TOKENSAVE_BINARY — tokensave 可执行文件（默认 "tokensave"）
 *   TOKENSAVE_CWD    — 项目根目录（默认当前目录）
 *   MCP_SDK_DIR      — @modelcontextprotocol/sdk/dist/esm 的绝对路径
 *                      （默认本机 DSH profile 里的那份）
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const BINARY = process.env.TOKENSAVE_BINARY ?? "tokensave";
const CWD = process.env.TOKENSAVE_CWD ?? process.cwd();
const SDK_DIR =
  process.env.MCP_SDK_DIR ??
  "C:/Users/wangz/.dsh/profiles/node_modules/@modelcontextprotocol/sdk/dist/esm";

const { Client } = await import(pathToFileURL(join(SDK_DIR, "client/index.js")).href);
const { StdioClientTransport } = await import(pathToFileURL(join(SDK_DIR, "client/stdio.js")).href);

const transport = new StdioClientTransport({
  command: BINARY,
  args: ["serve"],
  cwd: CWD,
});

const client = new Client({ name: "dsh-tokensave-smoke", version: "0.0.1" });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`OK: discovered ${tools.length} tools:`);
  for (const t of tools) console.log(`  - mcp__tokensave__${t.name}: ${(t.description || "").split("\n")[0]}`);

  if (tools.length > 0) {
    const first = tools[0];
    const args = first.name === "tokensave_search" ? { query: "workspace" } : {};
    const res = await client.callTool({ name: first.name, arguments: args });
    const text = (res.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    console.log(`\nOK: tools/call ${first.name} ->`);
    console.log(text.slice(0, 400));
  }
} finally {
  await client.close();
}
console.log("SMOKE TEST PASSED");
