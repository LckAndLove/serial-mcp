import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

import initSqlJs from "sql.js";
import { SerialPort } from "serialport";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// 解析当前文件目录，用于放置本地 SQLite 数据库文件
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 维护已打开串口：key=串口路径，value=状态对象
const openPorts = new Map();

// 当前活动会话 ID；调用 new_session 后更新
let activeSessionId = null;

// 数据库相关状态
let db = null;
let insertLogStmt = null;

function jsonResult(payload, isError = false) {
  return {
    isError,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function normalizeTimestamp(input) {
  if (typeof input === "number") {
    const t = new Date(input);
    if (!Number.isNaN(t.getTime())) return t.toISOString();
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (/^\d+$/.test(trimmed)) {
      const t = new Date(Number(trimmed));
      if (!Number.isNaN(t.getTime())) return t.toISOString();
    }
    const t = new Date(trimmed);
    if (!Number.isNaN(t.getTime())) return t.toISOString();
  }
  throw new Error("timestamp 格式无效，请传 ISO 时间字符串或毫秒时间戳");
}

function parseHexToBuffer(text) {
  const clean = String(text).replace(/0x/gi, "").replace(/[^0-9a-fA-F]/g, "");
  if (!clean || clean.length % 2 !== 0) {
    throw new Error("hex 数据格式无效，必须是偶数字节十六进制");
  }
  return Buffer.from(clean, "hex");
}

function toBuffer(data, encoding = "text") {
  if (encoding === "hex") return parseHexToBuffer(data);
  return Buffer.from(String(data), "utf8");
}

function writeLog({ port, direction, buffer, sessionId }) {
  if (!db || !insertLogStmt) return;
  try {
    insertLogStmt.run({
      port,
      direction,
      data: buffer.toString("utf8"),
      data_text: buffer.toString("utf8"),
      data_hex: buffer.toString("hex"),
      session_id: sessionId ?? activeSessionId,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[serial-mcp] 写入日志失败(${port})`, err);
  }
}

function getOpenedPort(port) {
  const state = openPorts.get(port);
  if (!state || !state.serialPort?.isOpen) {
    throw new Error(`串口未打开: ${port}`);
  }
  return state;
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

  const dataHandler = (chunk) => {
    try {
      writeLog({
        port,
        direction: "rx",
        buffer: Buffer.from(chunk),
      });
    } catch (err) {
      console.error(`[serial-mcp] 写入 rx 失败(${port})`, err);
    }
  };

  serialPort.on("data", dataHandler);
  serialPort.on("error", (err) => {
    console.error(`[serial-mcp] 串口异常(${port})`, err);
  });
  serialPort.on("close", () => {
    const st = openPorts.get(port);
    if (st) st.isOpen = false;
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

async function writeAndDrain(serialPort, payload) {
  await new Promise((resolve, reject) => {
    serialPort.write(payload, (err) => (err ? reject(err) : resolve()));
  });
  await new Promise((resolve, reject) => {
    serialPort.drain((err) => (err ? reject(err) : resolve()));
  });
}

function hasDelimiter(buffer, delimiterBuffer) {
  if (!delimiterBuffer || delimiterBuffer.length === 0) return false;
  return buffer.indexOf(delimiterBuffer) >= 0;
}

async function waitResponse(serialPort, { mode, delimiter, timeout }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let all = Buffer.alloc(0);

    const delimiterBuffer =
      mode === "delimiter" && typeof delimiter === "string" && delimiter.length > 0
        ? Buffer.from(delimiter, "utf8")
        : null;

    const finish = () => {
      cleanup();
      resolve({
        response: all.toString("utf8"),
        duration: Date.now() - startedAt,
      });
    };

    const onData = (chunk) => {
      all = Buffer.concat([all, Buffer.from(chunk)]);
      if (mode === "delimiter" && delimiterBuffer && hasDelimiter(all, delimiterBuffer)) {
        finish();
      }
    };

    const onError = (err) => {
      cleanup();
      reject(err);
    };

    const timer = setTimeout(finish, Number(timeout) > 0 ? Number(timeout) : 1000);

    const cleanup = () => {
      clearTimeout(timer);
      serialPort.off("data", onData);
      serialPort.off("error", onError);
    };

    serialPort.on("data", onData);
    serialPort.on("error", onError);
  });
}

const tools = [
  {
    name: "list_ports",
    description: "扫描并返回所有可用串口列表",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "open_port",
    description: "打开指定串口",
    inputSchema: {
      type: "object",
      properties: { port: { type: "string" }, baudRate: { type: "integer", minimum: 1 } },
      required: ["port", "baudRate"],
      additionalProperties: false,
    },
  },
  {
    name: "close_port",
    description: "关闭指定串口",
    inputSchema: {
      type: "object",
      properties: { port: { type: "string" } },
      required: ["port"],
      additionalProperties: false,
    },
  },
  {
    name: "send_data",
    description: "向串口发送数据，写入数据库 direction=tx",
    inputSchema: {
      type: "object",
      properties: { port: { type: "string" }, data: { type: "string" }, encoding: { type: "string", enum: ["text", "hex"] } },
      required: ["port", "data", "encoding"],
      additionalProperties: false,
    },
  },
  {
    name: "read_latest",
    description: "读取最新 N 条收到的数据",
    inputSchema: {
      type: "object",
      properties: { port: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10000 }, session_id: { type: "string" } },
      required: ["port", "limit"],
      additionalProperties: false,
    },
  },
  {
    name: "read_since",
    description: "读取某个时间点之后的所有数据",
    inputSchema: {
      type: "object",
      properties: { port: { type: "string" }, timestamp: { type: "string" }, session_id: { type: "string" } },
      required: ["port", "timestamp"],
      additionalProperties: false,
    },
  },
  {
    name: "send_and_wait",
    description: "发送指令并等待响应",
    inputSchema: {
      type: "object",
      properties: { port: { type: "string" }, data: { type: "string" }, mode: { type: "string", enum: ["timeout", "delimiter"] }, delimiter: { type: "string" }, timeout: { type: "integer", minimum: 1 } },
      required: ["port", "data", "mode", "timeout"],
      additionalProperties: false,
    },
  },
  {
    name: "new_session",
    description: "创建新 session_id",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_status",
    description: "返回当前所有已打开串口的状态",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const server = new Server(
  { name: "serial-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
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
          ports: ports.map((p) => ({
            name: p.friendlyName ?? p.path,
            path: p.path,
            manufacturer: p.manufacturer ?? null,
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
        const port = String(args.port);
        const payload = toBuffer(args.data, String(args.encoding));
        const state = getOpenedPort(port);
        await writeAndDrain(state.serialPort, payload);
        writeLog({ port, direction: "tx", buffer: payload });
        return jsonResult({ success: true, bytesSent: payload.length });
      }

      case "read_latest": {
        const port = String(args.port);
        const limit = Number(args.limit);
        const sessionId = args.session_id ? String(args.session_id) : null;

        let rows = [];
        if (db) {
          const sql = sessionId
            ? `SELECT id, port, direction, data_text, data_hex, session_id, timestamp FROM serial_logs WHERE port = ? AND direction = 'rx' AND session_id = ? ORDER BY id DESC LIMIT ?`
            : `SELECT id, port, direction, data_text, data_hex, session_id, timestamp FROM serial_logs WHERE port = ? AND direction = 'rx' ORDER BY id DESC LIMIT ?`;
          const stmt = db.prepare(sql);
          if (sessionId) {
            stmt.bind([port, sessionId, limit]);
          } else {
            stmt.bind([port, limit]);
          }
          while (stmt.step()) {
            rows.push(stmt.getAsObject());
          }
          stmt.free();
        }
        return jsonResult({ rows, count: rows.length });
      }

      case "read_since": {
        const port = String(args.port);
        const ts = normalizeTimestamp(args.timestamp);
        const sessionId = args.session_id ? String(args.session_id) : null;

        let rows = [];
        if (db) {
          const sql = sessionId
            ? `SELECT id, port, direction, data_text, data_hex, session_id, timestamp FROM serial_logs WHERE port = ? AND direction = 'rx' AND timestamp > ? AND session_id = ? ORDER BY id ASC`
            : `SELECT id, port, direction, data_text, data_hex, session_id, timestamp FROM serial_logs WHERE port = ? AND direction = 'rx' AND timestamp > ? ORDER BY id ASC`;
          const stmt = db.prepare(sql);
          if (sessionId) {
            stmt.bind([port, ts, sessionId]);
          } else {
            stmt.bind([port, ts]);
          }
          while (stmt.step()) {
            rows.push(stmt.getAsObject());
          }
          stmt.free();
        }
        return jsonResult({ rows, count: rows.length });
      }

      case "send_and_wait": {
        const port = String(args.port);
        const data = String(args.data);
        const mode = String(args.mode);
        const delimiter = args.delimiter != null ? String(args.delimiter) : undefined;
        const timeout = Number(args.timeout);
        const state = getOpenedPort(port);
        const payload = Buffer.from(data, "utf8");
        await writeAndDrain(state.serialPort, payload);
        writeLog({ port, direction: "tx", buffer: payload });
        const result = await waitResponse(state.serialPort, { mode, delimiter, timeout });
        return jsonResult(result);
      }

      case "new_session": {
        activeSessionId = randomUUID();
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
      { success: false, error: error instanceof Error ? error.message : String(error) },
      true,
    );
  }
});

async function shutdown() {
  const closeJobs = [...openPorts.values()].map((state) => {
    if (!state.serialPort?.isOpen) return Promise.resolve();
    return new Promise((resolve) => {
      state.serialPort.close(() => resolve());
    });
  });
  await Promise.allSettled(closeJobs);
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
    db.close();
  }
}

async function initDatabase() {
  const SQL = await initSqlJs();
  const configPath = path.join(__dirname, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const dbPath = path.resolve(__dirname, config.db?.path || "../serial-db/serial.db");

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS serial_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      port TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('tx','rx')),
      data TEXT NOT NULL,
      data_text TEXT,
      data_hex TEXT NOT NULL,
      session_id TEXT,
      timestamp TEXT NOT NULL
    )
  `);

  insertLogStmt = db.prepare(`
    INSERT INTO serial_logs (port, direction, data, data_text, data_hex, session_id, timestamp)
    VALUES (@port, @direction, @data, @data_text, @data_hex, @session_id, @timestamp)
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
  await initDatabase();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[serial-mcp] 启动失败:", err);
  process.exit(1);
});
