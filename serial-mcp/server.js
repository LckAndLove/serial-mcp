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

// 已打开串口状态映射：key=端口路径，value=状态对象
const openPorts = new Map();

// 当前活动 session_id（调用 new_session 后会更新）
let activeSessionId = null;

// 数据库相关状态（better-sqlite3 为同步初始化）
let db = null;
let insertLogStmt = null;

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

function writeLog({ port, direction, buffer, sessionId }) {
  if (!db || !insertLogStmt) return;
  // 串口收发统一落库，便于后续按端口/会话追溯（better-sqlite3 使用 run 写入）
  insertLogStmt.run({
    port,
    direction,
    raw: buffer,
    text: buffer.toString("utf8"),
    session_id: sessionId ?? activeSessionId,
    timestamp: Date.now(),
  });
}

async function openPort(port, baudRate) {
  const existing = openPorts.get(port);

  if (existing?.serialPort?.isOpen) {
    return { success: true, port };
  }

  const serialPort =
    existing?.serialPort ??
    new SerialPort({
      path: port,
      baudRate,
      autoOpen: false,
    });

  await new Promise((resolve, reject) => {
    serialPort.open((err) => (err ? reject(err) : resolve()));
  });

  // 监听串口接收数据并写入数据库 direction=rx
  const dataHandler = (chunk) => {
    try {
      writeLog({
        port,
        direction: "rx",
        buffer: Buffer.from(chunk),
      });
    } catch (err) {
      console.error(`[serial-mcp] 写入 rx 失败 (${port})`, err);
    }
  };

  serialPort.on("data", dataHandler);
  serialPort.on("error", (err) => {
    console.error(`[serial-mcp] 串口异常 (${port})`, err);
  });
  serialPort.on("close", () => {
    const state = openPorts.get(port);
    if (state) {
      state.isOpen = false;
    }
  });

  openPorts.set(port, {
    serialPort,
    baudRate,
    isOpen: true,
    dataHandler,
  });

  return { success: true, port };
}

async function closePort(port) {
  const state = openPorts.get(port);

  if (!state?.serialPort || !state.serialPort.isOpen) {
    return { success: true, port };
  }

  await new Promise((resolve, reject) => {
    state.serialPort.close((err) => (err ? reject(err) : resolve()));
  });

  state.isOpen = false;
  return { success: true, port };
}

function httpPost(urlText, body) {
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

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
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
    req.write(JSON.stringify(body));
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
    name: "open_port",
    description: "打开指定串口",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "string" },
        baudRate: { type: "integer", minimum: 1 },
      },
      required: ["port", "baudRate"],
      additionalProperties: false,
    },
  },
  {
    name: "close_port",
    description: "关闭指定串口",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "string" },
      },
      required: ["port"],
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
    description: "返回当前所有已打开串口的状态",
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

      case "open_port": {
        const result = await openPort(String(args.port), Number(args.baudRate));
        return jsonResult(result);
      }

      case "close_port": {
        const result = await closePort(String(args.port));
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
                "SELECT text FROM serial_data WHERE direction='rx' AND timestamp > ? AND text LIKE ? ORDER BY id ASC LIMIT 1"
              ).get(t0, `%${delimiter}%`)
              : db.prepare(
                "SELECT text FROM serial_data WHERE direction='rx' AND timestamp > ? ORDER BY id ASC LIMIT 1"
              ).get(t0);

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
        const ports = [...openPorts.entries()].map(([port, state]) => ({
          port,
          baudRate: state.baudRate,
          isOpen: Boolean(state.serialPort?.isOpen),
        }));

        return jsonResult({ ports });
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
  // 进程退出前关闭串口，防止资源泄漏
  const closeJobs = [...openPorts.values()].map((state) => {
    if (!state.serialPort?.isOpen) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      state.serialPort.close(() => resolve());
    });
  });

  await Promise.allSettled(closeJobs);

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

  insertLogStmt = db.prepare(`
    INSERT INTO serial_data (port, direction, raw, text, session_id, timestamp)
    VALUES (@port, @direction, @raw, @text, @session_id, @timestamp)
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
