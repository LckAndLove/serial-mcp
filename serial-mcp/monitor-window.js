import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";

import Database from "better-sqlite3";

const R = "\x1b[0m";
const Y = "\x1b[33m";
const G = "\x1b[32m";
const C = "\x1b[36m";
const RE = "\x1b[31m";
const GR = "\x1b[90m";
const W = "\x1b[97m";
const B = "\x1b[1m";

const DIVIDER = "─────────────────────────────────────";
const TOP = "┌─────────────────────────────────────┐";
const BOTTOM = "└─────────────────────────────────────┘";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const port = typeof process.argv[2] === "string" ? process.argv[2].trim() : "";
const baudArg = Number(process.argv[3]);
const baudRate = Number.isFinite(baudArg) && baudArg > 0 ? baudArg : 115200;

if (!port) {
  process.stderr.write(`${RE}✗ 启动失败：缺少串口参数。用法: node monitor-window.js <port> [baudRate]${R}\n`);
  process.exit(1);
}

const dbPath = path.resolve(__dirname, "../serial-db/serial.db");
const db = new Database(dbPath, { readonly: true });

const historyStmt = db.prepare(`
  SELECT id, port, direction, text, timestamp
  FROM serial_data
  WHERE port = ?
  ORDER BY id DESC
  LIMIT 20
`);

const pollStmt = db.prepare(`
  SELECT id, port, direction, text, timestamp
  FROM serial_data
  WHERE port = ? AND id > ?
  ORDER BY id ASC
`);

const latestStmt = db.prepare("SELECT id FROM serial_data WHERE port = ? ORDER BY id DESC LIMIT 1");

let lastId = latestStmt.get(port)?.id ?? 0;
let mode = "text";
let stopping = false;
let pollHandle = null;

const timers = new Map();
let nextTimerId = 1;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

function formatTimestamp(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "00:00:00.000";
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const mmm = String(date.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${mmm}`;
}

function escapeForDisplay(value) {
  return String(value ?? "")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

function renderPrompt() {
  const prompt = mode === "hex"
    ? `${port}  [hex]  ❯ `
    : `${port}  [text] ❯ `;
  rl.setPrompt(prompt);
  rl.prompt(true);
}

function renderFooter() {
  process.stdout.write(`${GR}${DIVIDER}${R}\n`);
  renderPrompt();
}

function writeLines(lines) {
  const pending = rl.line;
  const cursor = rl.cursor;

  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write("\x1b[1A");
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);

  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }

  renderFooter();

  if (pending) {
    rl.write(pending);
    const shift = pending.length - cursor;
    if (shift > 0) {
      readline.moveCursor(process.stdout, -shift, 0);
    }
  }
}

function systemMessage(text) {
  writeLines([`${GR}── ${text} ──${R}`]);
}

function errorMessage(text) {
  writeLines([`${RE}✗ ${text}${R}`]);
}

function lineStyle(direction, text) {
  if (direction === "tx") {
    return {
      symbol: `${Y}▶${R}`,
      contentColor: W,
    };
  }

  if (String(text).startsWith("[HEX]")) {
    return {
      symbol: `${C}◀${R}`,
      contentColor: C,
    };
  }

  return {
    symbol: `${G}◀${R}`,
    contentColor: G,
  };
}

function dataLine(direction, text, timestamp) {
  const ts = `${GR}${formatTimestamp(timestamp)}${R}`;
  const style = lineStyle(direction, text);
  return `${ts}  ${style.symbol}  ${style.contentColor}${escapeForDisplay(text)}${R}`;
}

function printData(direction, text, timestamp = Date.now()) {
  writeLines([dataLine(direction, text, timestamp)]);
}

function renderHeader() {
  process.stdout.write("\x1b[2J\x1b[H");
  const midRaw = `  串口监控  ${port}  │  ${baudRate} baud`;
  const mid = midRaw.padEnd(35, " ").slice(0, 35);
  process.stdout.write(`${B}${TOP}${R}\n`);
  process.stdout.write(`${B}│${mid}│${R}\n`);
  process.stdout.write(`${B}${BOTTOM}${R}\n`);
  process.stdout.write(`${GR}输入 /help 查看命令，直接输入内容发送到串口${R}\n`);
}

function renderHistory() {
  const rows = historyStmt.all(port).reverse();
  for (const row of rows) {
    const line = dataLine(row.direction, row.text ?? "", row.timestamp);
    process.stdout.write(`${line}\n`);
    lastId = Math.max(lastId, row.id);
  }
}

function parseHexInput(input) {
  const compact = input.replace(/0x/gi, "").replace(/\s+/g, "").trim();
  if (!compact) throw new Error("HEX 输入不能为空");
  if (/[^0-9a-fA-F]/.test(compact)) throw new Error("HEX 格式错误，只允许 0-9/A-F");
  if (compact.length % 2 !== 0) throw new Error("HEX 长度必须为偶数");
  const grouped = compact.toUpperCase().match(/.{1,2}/g)?.join(" ") || compact.toUpperCase();
  return {
    encoding: "hex",
    data: compact.toUpperCase(),
    display: grouped,
  };
}

function parseTextInput(input) {
  return {
    encoding: "text",
    data: input
      .replace(/\\r/g, "\r")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t"),
    display: input,
  };
}

function parseByMode(input, useMode) {
  return useMode === "hex" ? parseHexInput(input) : parseTextInput(input);
}

function sendToPort(data, encoding) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ port, data, encoding });
    const req = http.request({
      hostname: "127.0.0.1",
      port: 7070,
      path: "/send",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 5000,
    }, (res) => {
      let raw = "";
      res.on("data", (d) => { raw += d; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({ success: false });
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(body);
    req.end();
  });
}

function addTimer(intervalMs, parsed) {
  const id = nextTimerId++;
  const handle = setInterval(async () => {
    try {
      const result = await sendToPort(parsed.data, parsed.encoding);
      if (!result?.success) {
        errorMessage(`定时任务 [${id}] 发送失败`);
        return;
      }
      printData("tx", parsed.display);
    } catch (err) {
      errorMessage(`定时任务 [${id}] 发送失败：${err?.message || String(err)}`);
    }
  }, intervalMs);

  timers.set(id, {
    intervalMs,
    data: parsed.data,
    encoding: parsed.encoding,
    display: parsed.display,
    handle,
  });

  systemMessage(`定时任务 [${id}] 已启动，每 ${intervalMs}ms`);
}

function stopTimer(id) {
  const task = timers.get(id);
  if (!task) {
    errorMessage(`未找到定时任务 [${id}]`);
    return;
  }
  clearInterval(task.handle);
  timers.delete(id);
  systemMessage(`定时任务 [${id}] 已停止`);
}

function stopAllTimers(showMessage = false) {
  for (const task of timers.values()) {
    clearInterval(task.handle);
  }
  const count = timers.size;
  timers.clear();
  if (showMessage) {
    systemMessage(`已停止全部定时任务（${count} 个）`);
  }
}

function showHelp() {
  const lines = [
    `${GR}/help                显示帮助${R}`,
    `${GR}/text                切换到文本模式${R}`,
    `${GR}/hex                 切换到 HEX 模式${R}`,
    `${GR}/timer <ms> <data>   添加定时任务${R}`,
    `${GR}/timers              查看定时任务${R}`,
    `${GR}/stop <id>|all       停止定时任务${R}`,
    `${GR}/clear               清屏并重绘头部${R}`,
    `${GR}/exit                退出窗口${R}`,
  ];
  writeLines(lines);
}

function showTimers() {
  if (timers.size === 0) {
    systemMessage("当前没有定时任务");
    return;
  }

  const lines = [`${GR}定时任务列表：${R}`];
  const ordered = [...timers.entries()].sort((a, b) => a[0] - b[0]);
  for (const [id, task] of ordered) {
    const modeTag = task.encoding === "hex" ? "[hex] " : "[text]";
    lines.push(`${GR}[${id}]  ${String(task.intervalMs).padStart(4, " ")}ms  ${modeTag}  ${escapeForDisplay(task.display)}${R}`);
  }
  lines.push(`${GR}共 ${timers.size} 个任务运行中${R}`);
  writeLines(lines);
}

function handleCommand(input) {
  if (input === "/help") {
    showHelp();
    return true;
  }

  if (input === "/text") {
    mode = "text";
    systemMessage("已切换到文本模式");
    return true;
  }

  if (input === "/hex") {
    mode = "hex";
    systemMessage("已切换到 HEX 模式");
    return true;
  }

  if (input === "/timers") {
    showTimers();
    return true;
  }

  if (input === "/stop all") {
    stopAllTimers(true);
    return true;
  }

  const stopMatch = input.match(/^\/stop\s+(\d+)$/);
  if (stopMatch) {
    stopTimer(Number(stopMatch[1]));
    return true;
  }

  const timerMatch = input.match(/^\/timer\s+(\d+)\s+(.+)$/);
  if (timerMatch) {
    const intervalMs = Number(timerMatch[1]);
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      throw new Error("timer 间隔必须是正整数毫秒");
    }
    const parsed = parseByMode(timerMatch[2].trim(), mode);
    addTimer(intervalMs, parsed);
    return true;
  }

  if (input === "/clear") {
    renderHeader();
    renderFooter();
    return true;
  }

  if (input === "/exit") {
    shutdown();
    process.exit(0);
    return true;
  }

  if (input.startsWith("/")) {
    throw new Error("未知命令，输入 /help 查看可用命令");
  }

  return false;
}

async function handleSend(input) {
  const parsed = parseByMode(input, mode);
  const result = await sendToPort(parsed.data, parsed.encoding);
  if (!result?.success) {
    throw new Error("发送失败：连接已断开或 listener 未响应");
  }
  printData("tx", parsed.display);
}

function startPolling() {
  pollHandle = setInterval(() => {
    try {
      const rows = pollStmt.all(port, lastId);
      if (!rows.length) return;

      const out = [];
      for (const row of rows) {
        lastId = row.id;
        if (row.direction === "tx") continue;
        out.push(dataLine("rx", row.text ?? "", row.timestamp));
      }

      if (out.length > 0) {
        writeLines(out);
      }
    } catch (err) {
      errorMessage(`轮询失败：${err?.message || String(err)}`);
    }
  }, 200);
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  if (pollHandle) clearInterval(pollHandle);
  stopAllTimers(false);
  rl.close();
  try {
    db.close();
  } catch {
  }
}

renderHeader();
renderHistory();
renderFooter();
startPolling();

rl.on("line", async (raw) => {
  const input = raw.trim();

  if (!input) {
    renderFooter();
    return;
  }

  try {
    if (!handleCommand(input)) {
      await handleSend(input);
    }
  } catch (err) {
    errorMessage(err?.message || String(err));
  }
});

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

process.on("exit", shutdown);
