import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

import Database from "better-sqlite3";
import { SerialPort } from "serialport";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// 解析当前文件目录，用于 __dirname 和放置本地 SQLite 数据库文件
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 日志文件路径
const LOG_FILE = path.join(__dirname, "mcp.log");

function loadRuntimeConfig() {
  const configPath = path.join(__dirname, "config.json");
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function buildListenerUrl(rawUrl, pathname) {
  const text = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!text) {
    throw new Error("config.json 缺少 listener.url 配置");
  }

  const endpoint = new URL(text);
  if (endpoint.protocol !== "http:") {
    throw new Error("listener.url 必须是 http:// 协议");
  }

  endpoint.pathname = pathname;

  return endpoint.toString();
}

const runtimeConfig = loadRuntimeConfig();
const LISTENER_SEND_URL = buildListenerUrl(runtimeConfig.listener?.url, "/send");
const LISTENER_SESSION_URL = buildListenerUrl(runtimeConfig.listener?.url, "/session");
const LISTENER_CONNECT_URL = buildListenerUrl(runtimeConfig.listener?.url, "/connect");
const LISTENER_DISCONNECT_URL = buildListenerUrl(runtimeConfig.listener?.url, "/disconnect");
const LISTENER_STATUS_URL = buildListenerUrl(runtimeConfig.listener?.url, "/status");
const DEFAULT_RESPONSE_TIMEOUT = Number(runtimeConfig.response?.timeout) > 0
  ? Number(runtimeConfig.response.timeout)
  : 3000;

// 封装日志写入，同时输出到控制台和日志文件
function logToFile(...args) {
  const timestamp = new Date().toISOString();
  const msg = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ");
  const line = `[${timestamp}] ${msg}`;
  fs.appendFileSync(LOG_FILE, line + "\n");
}

// 封装错误日志写入，同时输出到控制台和日志文件
function logErrorToFile(...args) {
  const timestamp = new Date().toISOString();
  const msg = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ");
  const line = `[${timestamp}] ${msg}`;
  fs.appendFileSync(LOG_FILE, line + "\n");
}

// 替换 console.log 和 console.error，使其同时写入日志文件
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
console.log = (...args) => { originalConsoleLog(...args); logToFile(...args); };
console.error = (...args) => { originalConsoleError(...args); logErrorToFile(...args); };

// 当前活动 session_id（调用 new_session 后会更新）
let activeSessionId = null;

// 数据库相关状态（better-sqlite3 为同步初始化）
let db = null;

function jsonResult(payload, isError = false) {
  const safePayload =
    payload !== null && typeof payload === "object"
      ? { ...payload }
      : { value: payload };

  return {
    isError: Boolean(isError),
    content: [{ type: "text", text: JSON.stringify(safePayload) }],
    structuredContent: safePayload,
  };
}

function normalizeTimestamp(input) {
  // 支持 ISO 字符串或毫秒时间戳，统一返回毫秒整数
  if (typeof input === "number") {
    if (Number.isFinite(input)) return Math.trunc(input);
  }

  if (typeof input === "string") {
    const value = input.trim();

    if (/^\d+$/.test(value)) {
      const ms = Number(value);
      if (Number.isFinite(ms)) return Math.trunc(ms);
    }

    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.getTime();
  }

  throw new Error("timestamp 格式无效，请传 ISO 时间字符串或毫秒时间戳");
}

function httpPost(urlText, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(urlText);
    const requestPath = endpoint.pathname && endpoint.pathname !== "" ? endpoint.pathname : "/send";
    const options = {
      hostname: endpoint.hostname,
      port: endpoint.port || 80,
      path: requestPath,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    };

    let settled = false;
    const doneResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const doneReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            doneResolve(json);
          } else {
            doneReject(new Error(json.error || `HTTP ${res.statusCode}`));
          }
        } catch {
          doneReject(new Error(`Invalid response: ${data}`));
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("HTTP request timeout"));
    });

    req.on("error", doneReject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function httpGet(urlText) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(urlText);
    const options = {
      hostname: endpoint.hostname,
      port: endpoint.port || 80,
      path: endpoint.pathname || "/",
      method: "GET",
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data || "{}");
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(json.error || `HTTP ${res.statusCode}`));
          }
        } catch {
          reject(new Error(`Invalid response: ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const tools = [
  {
    name: "list_ports",
    description: "扫描并返回所有可用串口列表",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "connect_port",
    description: "连接到指定串口。用户告知串口号后调用此工具，支持 Windows (COM5) 和 Linux (/dev/ttyUSB0) 格式。连接成功后自动创建新会话，之前的数据不会丢失。",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "string" },
        baudRate: { type: "integer", minimum: 1 },
        dataBits: { type: "integer", enum: [5, 6, 7, 8] },
        stopBits: { type: "number", enum: [1, 1.5, 2] },
        parity: { type: "string", enum: ["none", "even", "odd", "mark", "space"] },
      },
      required: ["port"],
      additionalProperties: false,
    },
  },
  {
    name: "disconnect_port",
    description: "断开当前串口连接",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "send_data",
    description: "向串口发送数据，写入数据库 direction=tx",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "string" },
        data: { type: "string" },
        encoding: { type: "string", enum: ["text", "hex"] },
      },
      required: ["port", "data", "encoding"],
      additionalProperties: false,
    },
  },
  {
    name: "read_latest",
    description: "从数据库读取最新 N 条收到的数据",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 10000 },
        session_id: { type: "string" },
      },
      required: ["port", "limit"],
      additionalProperties: false,
    },
  },
  {
    name: "read_since",
    description: "读取某个时间点之后的所有数据",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "string" },
        timestamp: { type: "string" },
        session_id: { type: "string" },
      },
      required: ["port", "timestamp"],
      additionalProperties: false,
    },
  },
  {
    name: "send_and_wait",
    description: "发送指令并等待响应（串口由 listener 管理，port 参数仅作标记）",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "string" },
        data: { type: "string" },
        mode: { type: "string", enum: ["timeout", "delimiter"] },
        delimiter: { type: "string" },
        timeout: { type: "integer", minimum: 1 },
      },
      required: ["data"],
      additionalProperties: false,
    },
  },
  {
    name: "new_session",
    description: "创建新 session_id",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_status",
    description: "返回当前 listener 串口连接状态（connected/port/baudRate/sessionId）",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

const server = new Server(
  {
    name: "serial-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const name = request.params.name;
    const args = request.params.arguments ?? {};

    switch (name) {
      case "list_ports": {
        const ports = await SerialPort.list();

        return jsonResult({
          ports: ports.map((item) => ({
            name: item.friendlyName ?? item.path,
            path: item.path,
            manufacturer: item.manufacturer ?? null,
          })),
        });
      }

      case "connect_port": {
        const payload = {
          port: String(args.port),
          baudRate: Number(args.baudRate || 115200),
          dataBits: Number(args.dataBits || 8),
          stopBits: Number(args.stopBits || 1),
          parity: String(args.parity || "none"),
        };

        const result = await httpPost(LISTENER_CONNECT_URL, payload);
        if (result?.sessionId) {
          activeSessionId = String(result.sessionId);
        }

        return jsonResult(result);
      }

      case "disconnect_port": {
        const result = await httpPost(LISTENER_DISCONNECT_URL, {});
        return jsonResult(result);
      }

      case "send_data": {
        const data = String(args.data);
        const encoding = String(args.encoding || "text");

        // 通过 HTTP 转发给 listener 写入串口
        const result = await httpPost(LISTENER_SEND_URL, {
          data,
          encoding,
          session_id: activeSessionId,
        });

        return jsonResult({ success: true, ...result });
      }

      case "read_latest": {
        const port = String(args.port);
        const limit = Number(args.limit);
        const sessionId = args.session_id ? String(args.session_id) : null;

        const sql = sessionId
          ? `
            SELECT id, port, direction, text, raw, session_id, timestamp
            FROM serial_data
            WHERE port = ? AND direction = 'rx' AND session_id = ?
            ORDER BY id DESC
            LIMIT ?
          `
          : `
            SELECT id, port, direction, text, raw, session_id, timestamp
            FROM serial_data
            WHERE port = ? AND direction = 'rx'
            ORDER BY id DESC
            LIMIT ?
          `;

        // 使用 better-sqlite3 的 all() 一次性读取结果集
        const rows = db
          ? sessionId
            ? db.prepare(sql).all(port, sessionId, limit)
            : db.prepare(sql).all(port, limit)
          : [];

        return jsonResult({ rows, count: rows.length });
      }

      case "read_since": {
        const port = String(args.port);
        const ts = normalizeTimestamp(args.timestamp);
        const sessionId = args.session_id ? String(args.session_id) : null;

        const sql = sessionId
          ? `
            SELECT id, port, direction, text, raw, session_id, timestamp
            FROM serial_data
            WHERE port = ? AND direction = 'rx' AND timestamp > ? AND session_id = ?
            ORDER BY id ASC
          `
          : `
            SELECT id, port, direction, text, raw, session_id, timestamp
            FROM serial_data
            WHERE port = ? AND direction = 'rx' AND timestamp > ?
            ORDER BY id ASC
          `;

        // 使用 better-sqlite3 的 all() 一次性读取结果集
        const rows = db
          ? sessionId
            ? db.prepare(sql).all(port, ts, sessionId)
            : db.prepare(sql).all(port, ts)
          : [];

        return jsonResult({ rows, count: rows.length });
      }

      case "send_and_wait": {
        const data = String(args.data);
        const mode = String(args.mode || "timeout");
        const delimiter = typeof args.delimiter === "string" ? args.delimiter : "";
        const encoding = String(args.encoding || "text");
        const timeout = Number(args.timeout || DEFAULT_RESPONSE_TIMEOUT);

        if (mode !== "timeout" && mode !== "delimiter") {
          throw new Error("mode 仅支持 timeout 或 delimiter");
        }

        if (mode === "delimiter" && !delimiter) {
          throw new Error("delimiter 模式必须提供 delimiter");
        }

        const t0 = Date.now();

        await httpPost(LISTENER_SEND_URL, {
          data,
          encoding,
          session_id: activeSessionId,
        });

        let response = "";
        while (Date.now() - t0 < timeout) {
          await sleep(100);
          const row =
            mode === "delimiter"
              ? db.prepare(
                "SELECT text FROM serial_data WHERE direction='rx' AND timestamp > ? AND session_id = ? AND text LIKE ? ORDER BY id ASC LIMIT 1"
              ).get(t0, activeSessionId, `%${delimiter}%`)
              : db.prepare(
                "SELECT text FROM serial_data WHERE direction='rx' AND timestamp > ? AND session_id = ? ORDER BY id ASC LIMIT 1"
              ).get(t0, activeSessionId);

          if (row) {
            response = row.text || "";
            break;
          }
        }

        const timedOut = response === "";
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                response,
                duration: Date.now() - t0,
                timedOut,
              }),
            },
          ],
        };
      }

      case "new_session": {
        const sessionId = randomUUID();

        await httpPost(LISTENER_SESSION_URL, {
          session_id: sessionId,
        });

        activeSessionId = sessionId;
        return jsonResult({ session_id: activeSessionId });
      }

      case "get_status": {
        const status = await httpGet(LISTENER_STATUS_URL);
        return jsonResult(status);
      }

      default:
        throw new Error(`未知工具: ${name}`);
    }
  } catch (error) {
    return jsonResult(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      true,
    );
  }
});

async function shutdown() {
  // better-sqlite3 直接基于文件数据库，退出时关闭连接即可
  if (db) {
    try {
      db.close();
    } catch {
      // 忽略数据库关闭异常
    }
  }
}

function initDatabase() {
  // 从 config.json 读取数据库路径
  const dbPath = path.resolve(__dirname, runtimeConfig.db?.path || "../serial-db/serial.db");
  const dbDir = path.dirname(dbPath);

  // 确保数据库目录存在，避免首次启动时报错
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // 同步创建/打开 SQLite 连接
  db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS serial_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      port TEXT,
      timestamp INTEGER,
      direction TEXT,
      raw BLOB,
      text TEXT,
      session_id TEXT
    )
  `);
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

async function main() {
  initDatabase();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[serial-mcp] 启动失败:", err);
  process.exit(1);
});
