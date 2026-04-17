import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";

import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const portFilterRaw = process.argv[2];
const portFilter = typeof portFilterRaw === "string" && portFilterRaw.trim() !== ""
  ? portFilterRaw.trim()
  : null;

const dbPath = path.resolve(__dirname, "../serial-db/serial.db");
const db = new Database(dbPath, { readonly: true });

const latest = db.prepare("SELECT id FROM serial_data ORDER BY id DESC LIMIT 1").get();
let lastId = latest?.id ?? 0;
let inputMode = "text";
let shuttingDown = false;

const timers = new Map();
let nextTimerId = 1;

const query = db.prepare(`
  SELECT id, port, direction, text, timestamp
  FROM serial_data
  WHERE id > ?
    AND (port = ? OR ? IS NULL)
  ORDER BY id ASC
`);

const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function setPrompt() {
  rl.setPrompt(`[${inputMode}] > `);
}

function formatTime(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(ms);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function printColored(direction, port, text, timestamp = Date.now()) {
  const isTx = direction === "tx";
  const prefix = isTx ? "→" : "←";
  const isHexRx = !isTx && typeof text === "string" && text.startsWith("[HEX]");
  const color = isTx ? YELLOW : (isHexRx ? CYAN : GREEN);
  const line = `[${formatTime(timestamp)}] [${port}] ${prefix} ${text}`;
  process.stdout.write(`${color}${line}${RESET}\n`);
}

function printError(message) {
  process.stderr.write(`${RED}${message}${RESET}\n`);
}

function printRow(row) {
  const text = row.text ?? "";
  printColored(row.direction, row.port, text, row.timestamp);
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
    const display = payloadHex.match(/.{1,2}/g)?.join(" ") || payloadHex;
    return {
      data: payloadHex,
      encoding: "hex",
      display,
    };
  }

  const data = escapeTextInput(input);
  return {
    data,
    encoding: "text",
    display: input,
  };
}

function sendData(data, encoding) {
  return new Promise((resolve, reject) => {
    if (!portFilter) {
      reject(new Error("未指定端口，无法发送"));
      return;
    }

    const body = JSON.stringify({
      port: portFilter,
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
    process.stdout.write("当前没有定时任务\n");
    return;
  }

  const ordered = [...timers.entries()].sort((a, b) => a[0] - b[0]);
  for (const [id, task] of ordered) {
    process.stdout.write(`  [${id}] ${task.interval}ms  ${task.display}\n`);
  }
}

function stopTimer(id) {
  const task = timers.get(id);
  if (!task) {
    process.stdout.write(`未找到定时任务 [${id}]\n`);
    return;
  }
  clearInterval(task.timer);
  timers.delete(id);
  process.stdout.write(`定时任务 [${id}] 已停止\n`);
}

function stopAllTimers() {
  for (const task of timers.values()) {
    clearInterval(task.timer);
  }
  timers.clear();
}

function addTimer(intervalMs, parsed) {
  const id = nextTimerId++;
  const timer = setInterval(async () => {
    try {
      await sendData(parsed.data, parsed.encoding);
      printColored("tx", portFilter || "UNKNOWN", parsed.display);
      rl.prompt(true);
    } catch (err) {
      printError(`[timer ${id}] ${err?.message || String(err)}`);
      rl.prompt(true);
    }
  }, intervalMs);

  timers.set(id, {
    interval: intervalMs,
    data: parsed.data,
    encoding: parsed.encoding,
    display: parsed.display,
    timer,
  });

  process.stdout.write(`定时任务 [${id}] 已启动，每 ${intervalMs}ms 发送一次\n`);
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
    stopAllTimers();
    process.stdout.write("所有定时任务已停止\n");
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

process.stdout.write(`串口监控已启动，${portFilter ? `显示 ${portFilter}` : "显示所有串口"}\n`);
process.stdout.write("输入数据回车发送，关闭窗口即停止监控\n");
process.stdout.write("命令：mode text / mode hex / exit\n");
process.stdout.write("定时发送：timer add <间隔ms> <数据> / timer list / timer stop <编号>\n");
setPrompt();
rl.prompt();

const timer = setInterval(() => {
  try {
    const rows = query.all(lastId, portFilter, portFilter);
    if (!rows.length) return;
    for (const row of rows) {
      lastId = row.id;
      printRow(row);
    }
    rl.prompt(true);
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
    process.stdout.write("已切换到 HEX 模式\n");
    rl.prompt();
    return;
  }

  if (input === "mode text") {
    inputMode = "text";
    setPrompt();
    process.stdout.write("已切换到文本模式\n");
    rl.prompt();
    return;
  }

  if (!input) {
    rl.prompt();
    return;
  }

  try {
    const handledTimer = handleTimerCommand(input);
    if (handledTimer) {
      rl.prompt();
      return;
    }

    const parsed = parseByMode(input, inputMode);
    await sendData(parsed.data, parsed.encoding);
    printColored("tx", portFilter || "UNKNOWN", parsed.display);
  } catch (err) {
    printError(`[send error] ${err?.message || String(err)}`);
  }

  rl.prompt();
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);
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
