import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";

import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const portArg = typeof process.argv[2] === "string" ? process.argv[2].trim() : "";
const portName = portArg || null;
const baudArg = Number(process.argv[3]);
const baudRate = Number.isFinite(baudArg) && baudArg > 0 ? baudArg : 115200;
const displayPort = portName || "ALL";

const dbPath = path.resolve(__dirname, "../serial-db/serial.db");
const db = new Database(dbPath, { readonly: true });

const historyQueryByPort = db.prepare(`
  SELECT id, port, direction, text, raw, timestamp
  FROM serial_data
  WHERE port = ?
  ORDER BY id DESC
  LIMIT 20
`);

const historyQueryAll = db.prepare(`
  SELECT id, port, direction, text, raw, timestamp
  FROM serial_data
  ORDER BY id DESC
  LIMIT 20
`);

const latestIdByPort = db.prepare("SELECT id FROM serial_data WHERE port = ? ORDER BY id DESC LIMIT 1");
const latestIdAll = db.prepare("SELECT id FROM serial_data ORDER BY id DESC LIMIT 1");

const liveRxQueryByPort = db.prepare(`
  SELECT id, port, direction, text, raw, timestamp
  FROM serial_data
  WHERE id > ? AND port = ? AND direction = 'rx'
  ORDER BY id ASC
`);

const liveRxQueryAll = db.prepare(`
  SELECT id, port, direction, text, raw, timestamp
  FROM serial_data
  WHERE id > ? AND direction = 'rx'
  ORDER BY id ASC
`);

const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const GRAY = "\x1b[90m";
const BOLD = "\x1b[1m";

const TOP_BORDER = "════════════════════════════════════════";
const DIVIDER = "────────────────────────────────────────";

let inputMode = "text";
let shuttingDown = false;
let lastId = portName
  ? latestIdByPort.get(portName)?.id ?? 0
  : latestIdAll.get()?.id ?? 0;

const timers = new Map();
let nextTimerId = 1;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function formatTime(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "00:00:00.000";
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const mmm = String(date.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${mmm}`;
}

function escapeDisplayText(text) {
  return String(text ?? "")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

function formatHexFromBuffer(raw) {
  if (!Buffer.isBuffer(raw) || raw.length === 0) return "[HEX]";
  const body = raw.toString("hex").toUpperCase().match(/.{1,2}/g)?.join(" ") || "";
  return `[HEX] ${body}`;
}

function rowText(row) {
  const text = String(row.text ?? "");
  if (text.startsWith("[HEX]")) return text;

  if (row.direction === "tx" && Buffer.isBuffer(row.raw) && text.includes("\uFFFD")) {
    return formatHexFromBuffer(row.raw);
  }

  return escapeDisplayText(text);
}

function rowColor(direction, text) {
  if (String(text).startsWith("[HEX]")) return CYAN;
  return direction === "tx" ? YELLOW : GREEN;
}

function formatRowLine(direction, text, timestamp) {
  const ts = formatTime(timestamp).padStart(12, " ");
  const tag = direction === "tx" ? "→TX" : "←RX";
  return `${ts}  ${tag}  ${text}`;
}

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H");
}

function setPrompt() {
  rl.setPrompt(`[${inputMode}] ${displayPort} > `);
}

function renderInputZone() {
  process.stdout.write(`${GRAY}${DIVIDER}${RESET}\n`);
  rl.prompt(true);
}

function writeRuntimeLines(lines) {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);

  for (const line of lines) {
    if (line.color) {
      process.stdout.write(`${line.color}${line.text}${RESET}\n`);
    } else {
      process.stdout.write(`${line.text}\n`);
    }
  }

  renderInputZone();
}

function printSystem(message) {
  writeRuntimeLines([{ text: message, color: GRAY }]);
}

function printError(message) {
  writeRuntimeLines([{ text: message, color: RED }]);
}

function printDataRow(direction, text, timestamp = Date.now()) {
  const line = formatRowLine(direction, text, timestamp);
  writeRuntimeLines([{ text: line, color: rowColor(direction, text) }]);
}

function printHistoryRows(rows) {
  for (const row of rows) {
    const text = rowText(row);
    const line = formatRowLine(row.direction, text, row.timestamp);
    process.stdout.write(`${rowColor(row.direction, text)}${line}${RESET}\n`);
  }
}

function normalizeHexInput(value) {
  const normalized = value.replace(/0x/gi, "").replace(/\s+/g, "").trim();
  if (!normalized) {
    throw new Error("HEX 输入不能为空");
  }
  if (/[^0-9a-fA-F]/.test(normalized)) {
    throw new Error("HEX 输入格式无效");
  }
  if (normalized.length % 2 !== 0) {
    throw new Error("HEX 字节数必须为偶数");
  }
  return normalized.toUpperCase();
}

function escapeTextInput(value) {
  return value
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}

function parseByMode(input, mode) {
  if (mode === "hex") {
    const payloadHex = normalizeHexInput(input);
    const grouped = payloadHex.match(/.{1,2}/g)?.join(" ") || payloadHex;
    return {
      data: payloadHex,
      encoding: "hex",
      display: `[HEX] ${grouped}`,
    };
  }

  return {
    data: escapeTextInput(input),
    encoding: "text",
    display: input,
  };
}

function sendData(data, encoding) {
  return new Promise((resolve, reject) => {
    if (!portName) {
      reject(new Error("未指定端口，无法发送"));
      return;
    }

    const body = JSON.stringify({
      port: portName,
      data,
      encoding,
    });

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: 7070,
        path: "/send",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let response = "";
        res.on("data", (chunk) => {
          response += chunk;
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(response || "{}");
            if (res.statusCode >= 200 && res.statusCode < 300 && json.success) {
              resolve(json);
              return;
            }
            reject(new Error(json.error || `HTTP ${res.statusCode}`));
          } catch {
            reject(new Error(`Invalid response: ${response}`));
          }
        });
      }
    );

    req.setTimeout(5000, () => {
      req.destroy(new Error("send timeout"));
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function listTimers() {
  if (timers.size === 0) {
    printSystem("当前没有定时任务");
    return;
  }

  const ordered = [...timers.entries()].sort((a, b) => a[0] - b[0]);
  const lines = ordered.map(([id, task]) => ({
    text: `  [${id}] ${task.interval}ms  ${task.display}`,
    color: GRAY,
  }));
  writeRuntimeLines(lines);
}

function stopTimer(id) {
  const task = timers.get(id);
  if (!task) {
    printSystem(`未找到定时任务 [${id}]`);
    return;
  }
  clearInterval(task.timer);
  timers.delete(id);
  printSystem(`定时任务 [${id}] 已停止`);
}

function stopAllTimers(showMessage = false) {
  for (const task of timers.values()) {
    clearInterval(task.timer);
  }
  timers.clear();
  if (showMessage) {
    printSystem("所有定时任务已停止");
  }
}

function addTimer(intervalMs, parsed) {
  const id = nextTimerId++;
  const timer = setInterval(async () => {
    try {
      await sendData(parsed.data, parsed.encoding);
      printDataRow("tx", parsed.display);
    } catch (err) {
      printError(`[timer ${id}] ${err?.message || String(err)}`);
    }
  }, intervalMs);

  timers.set(id, {
    interval: intervalMs,
    data: parsed.data,
    encoding: parsed.encoding,
    display: parsed.display,
    timer,
  });

  printSystem(`定时任务 [${id}] 已启动，每 ${intervalMs}ms 发送一次`);
}

function handleTimerCommand(input) {
  const timerAddMatch = input.match(/^timer\s+add\s+(\d+)\s+(.+)$/);
  if (timerAddMatch) {
    const intervalMs = Number(timerAddMatch[1]);
    const payloadRaw = timerAddMatch[2].trim();

    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      throw new Error("间隔必须是正整数毫秒");
    }

    const parsed = parseByMode(payloadRaw, inputMode);
    addTimer(intervalMs, parsed);
    return true;
  }

  if (input === "timer list") {
    listTimers();
    return true;
  }

  if (input === "timer stop all") {
    stopAllTimers(true);
    return true;
  }

  const timerStopMatch = input.match(/^timer\s+stop\s+(\d+)$/);
  if (timerStopMatch) {
    const id = Number(timerStopMatch[1]);
    stopTimer(id);
    return true;
  }

  return false;
}

function renderHeader() {
  clearScreen();
  process.stdout.write(`${BOLD}${TOP_BORDER}${RESET}\n`);
  process.stdout.write(`${BOLD}  串口监控  ${displayPort}  |  ${baudRate} baud${RESET}\n`);
  process.stdout.write(`${BOLD}${TOP_BORDER}${RESET}\n`);
  process.stdout.write(`${GRAY}命令: mode text/hex | timer add/list/stop | exit${RESET}\n`);
  process.stdout.write(`${GRAY}${DIVIDER}${RESET}\n`);
}

function renderStartupHistory() {
  const rows = portName
    ? historyQueryByPort.all(portName)
    : historyQueryAll.all();

  const ordered = rows.reverse();
  printHistoryRows(ordered);
}

renderHeader();
renderStartupHistory();
setPrompt();
renderInputZone();

const pollTimer = setInterval(() => {
  try {
    const rows = portName
      ? liveRxQueryByPort.all(lastId, portName)
      : liveRxQueryAll.all(lastId);

    if (!rows.length) return;

    const lines = [];
    for (const row of rows) {
      lastId = row.id;
      const text = rowText(row);
      lines.push({
        text: formatRowLine(row.direction, text, row.timestamp),
        color: rowColor(row.direction, text),
      });
    }

    writeRuntimeLines(lines);
  } catch (err) {
    printError(`[monitor error] ${err?.message || String(err)}`);
  }
}, 200);

rl.on("line", async (rawInput) => {
  const input = rawInput.trim();

  if (input === "exit" || input === "quit") {
    shutdown();
    process.exit(0);
    return;
  }

  if (input === "mode hex") {
    inputMode = "hex";
    setPrompt();
    printSystem("已切换到 HEX 模式");
    return;
  }

  if (input === "mode text") {
    inputMode = "text";
    setPrompt();
    printSystem("已切换到文本模式");
    return;
  }

  if (!input) {
    renderInputZone();
    return;
  }

  try {
    const handledTimer = handleTimerCommand(input);
    if (handledTimer) return;

    const parsed = parseByMode(input, inputMode);
    await sendData(parsed.data, parsed.encoding);
    printDataRow("tx", parsed.display);
  } catch (err) {
    printError(`[send error] ${err?.message || String(err)}`);
  }
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(pollTimer);
  stopAllTimers();
  rl.close();
  try {
    db.close();
  } catch {
  }
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

process.on("exit", shutdown);
