import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

// 解析当前脚本目录，定位 serial-mcp 服务入口
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mcpDir = path.join(__dirname, "serial-mcp");
const serverEntry = path.join(mcpDir, "server.js");
const mcpConfigPath = path.join(mcpDir, "config.json");
const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, "utf8"));

// 从 serial-mcp 目录解析 SDK，避免根目录无 node_modules 时无法加载
const require = createRequire(import.meta.url);
const sdkClientPath = require.resolve("@modelcontextprotocol/sdk/client/index.js", {
  paths: [mcpDir],
});
const sdkStdioPath = require.resolve("@modelcontextprotocol/sdk/client/stdio.js", {
  paths: [mcpDir],
});

const [{ Client }, { StdioClientTransport }] = await Promise.all([
  import(pathToFileURL(sdkClientPath).href),
  import(pathToFileURL(sdkStdioPath).href),
]);

/**
 * 统一解析工具返回，优先使用 structuredContent，兜底解析 text JSON
 */
function parseToolResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }

  const textItem = result?.content?.find(
    (item) => item?.type === "text" && typeof item.text === "string",
  );

  if (!textItem) return {};

  try {
    return JSON.parse(textItem.text);
  } catch {
    return { raw: textItem.text };
  }
}

/**
 * 调用 MCP 工具并在失败时抛错，方便主流程统一处理
 */
async function callTool(client, name, args = {}) {
  const result = await client.callTool({
    name,
    arguments: args,
  });

  const payload = parseToolResult(result);

  if (result?.isError) {
    const msg =
      payload?.error ?? payload?.message ?? `工具 ${name} 调用失败: ${JSON.stringify(payload)}`;
    throw new Error(msg);
  }

  return payload;
}

const client = new Client(
  {
    name: "serial-mcp-test-loop",
    version: "1.0.0",
  },
  {
    capabilities: {},
  },
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: mcpDir,
  stderr: "inherit",
});

try {
  await client.connect(transport);

  // 1/2. 调用 list_ports，打印可用串口
  const portsResult = await callTool(client, "list_ports");
  const ports = Array.isArray(portsResult?.ports) ? portsResult.ports : [];
  console.log("可用串口：");
  if (ports.length === 0) {
    console.log("- 未发现可用串口");
  } else {
    for (const port of ports) {
      console.log(`- ${port.path} (${port.name ?? "unknown"})`);
    }
  }

  // 3. 连接配置中的串口，波特率 115200
  const targetPort = String(mcpConfig?.serial?.port || "").trim();
  if (!targetPort) {
    throw new Error("serial-mcp/config.json 缺少 serial.port 配置");
  }
  await callTool(client, "connect_port", {
    port: targetPort,
    baudRate: 115200,
  });
  console.log(`已连接串口：${targetPort} @ 115200`);

  // 4. 创建新会话，记录 session_id
  const sessionStart = new Date().toISOString();
  const sessionResult = await callTool(client, "new_session");
  const sessionId = sessionResult?.session_id;
  if (!sessionId) {
    throw new Error("new_session 未返回 session_id");
  }
  console.log(`新会话 session_id：${sessionId}`);

  // 5. 等待 3 秒，让虚拟单片机输出几条数据
  console.log("等待 3 秒采集串口输出...");
  await sleep(3000);

  // 6. 读取最新 5 条
  const latestResult = await callTool(client, "read_latest", {
    port: targetPort,
    limit: 5,
    session_id: sessionId,
  });
  const latestRows = Array.isArray(latestResult?.rows) ? latestResult.rows : [];
  console.log(`最新 5 条（实际 ${latestRows.length} 条）：`);
  for (const row of latestRows) {
    console.log(`[${row.timestamp}] ${row.text ?? ""}`.trimEnd());
  }

  // 7. 发送 GET_STATUS 并打印响应
  const statusResult = await callTool(client, "send_and_wait", {
    port: targetPort,
    data: "GET_STATUS\r\n",
    mode: "timeout",
    timeout: 1500,
  });
  console.log(`GET_STATUS 响应：${statusResult?.response ?? ""}`);

  // 8. 发送 GET_TEMP 并打印响应
  const tempResult = await callTool(client, "send_and_wait", {
    port: targetPort,
    data: "GET_TEMP\r\n",
    mode: "timeout",
    timeout: 1500,
  });
  console.log(`GET_TEMP 响应：${tempResult?.response ?? ""}`);

  // 9. 发送 RESET 并打印响应
  const resetResult = await callTool(client, "send_and_wait", {
    port: targetPort,
    data: "RESET\r\n",
    mode: "timeout",
    timeout: 1500,
  });
  console.log(`RESET 响应：${resetResult?.response ?? ""}`);

  // 10. 读取本次 session 所有数据并打印总条数
  const sinceResult = await callTool(client, "read_since", {
    port: targetPort,
    timestamp: sessionStart,
    session_id: sessionId,
  });
  const total = Number(sinceResult?.count ?? 0);
  console.log(`本次 session 数据总条数：${total}`);

  // 11. 打印闭环验证完成
  console.log("🎉 闭环验证完成");
} catch (error) {
  console.error("联调脚本执行失败：", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  // 关闭 MCP 连接，释放子进程资源
  await transport.close().catch(() => {});
}
