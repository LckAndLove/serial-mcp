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

const TOP = "┌─────────────────────────────────────┐";
const BOTTOM = "└─────────────────────────────────────┘";

const COMMANDS = [
  { cmd: "/text", desc: "切换文本模式" },
  { cmd: "/hex", desc: "切换 HEX 模式" },
  { cmd: "/timer", desc: "添加定时发送  /timer <ms> <data>" },
  { cmd: "/timers", desc: "查看定时任务列表" },
  { cmd: "/stop", desc: "停止定时任务  /stop <id|all>" },
  { cmd: "/clear", desc: "清屏" },
  { cmd: "/help", desc: "显示帮助" },
  { cmd: "/exit", desc: "退出" },
];

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
let renderPending = false;
let submitting = false;

const logs = [];
const MAX_LOGS = 2000;

let inputBuffer = "";
let inputCursor = 0;

const hints = {
  visible: false,
  suppressed: false,
  matches: [],
  selectedIndex: 0,
  maxVisible: 6,
};

const tabState = {
  active: false,
  basePrefix: "",
  candidates: [],
  cycleIndex: -1,
};

const timers = new Map();
let nextTimerId = 1;

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

function getPrompt() {
  return mode === "hex"
    ? `${port}  [hex]  ❯ `
    : `${port}  [text] ❯ `;
}

function appendLog(line) {
  logs.push(line);
  if (logs.length > MAX_LOGS) {
    logs.splice(0, logs.length - MAX_LOGS);
  }
  scheduleRender();
}

function resetTabState() {
  tabState.active = false;
  tabState.basePrefix = "";
  tabState.candidates = [];
  tabState.cycleIndex = -1;
}

function hideHints() {
  hints.visible = false;
  hints.matches = [];
  hints.selectedIndex = 0;
}

function getCommandPrefix() {
  if (!inputBuffer.startsWith("/")) return null;
  if (inputBuffer.includes(" ")) return null;
  return inputBuffer;
}

function commandMatches(prefix) {
  return COMMANDS.filter((item) => item.cmd.startsWith(prefix));
}

function updateHints() {
  const prefix = getCommandPrefix();
  if (!prefix || hints.suppressed) {
    hideHints();
    return;
  }

  const matched = commandMatches(prefix);
  if (matched.length === 0) {
    hideHints();
    return;
  }

  hints.visible = true;
  hints.matches = matched;
  if (hints.selectedIndex >= matched.length) {
    hints.selectedIndex = 0;
  }
}

function longestCommonPrefix(values) {
  if (!values.length) return "";
  let prefix = values[0];
  for (let i = 1; i < values.length; i += 1) {
    while (!values[i].startsWith(prefix) && prefix.length > 0) {
      prefix = prefix.slice(0, -1);
    }
    if (!prefix) break;
  }
  return prefix;
}

function replacePrefix(nextPrefix) {
  inputBuffer = nextPrefix;
  inputCursor = Array.from(inputBuffer).length;
}

function tabComplete() {
  const prefix = getCommandPrefix();
  if (!prefix) return;

  hints.suppressed = false;
  const matched = commandMatches(prefix);
  if (matched.length === 0) return;

  const candidates = matched.map((item) => item.cmd);

  if (candidates.length === 1) {
    replacePrefix(candidates[0]);
    resetTabState();
    updateHints();
    hints.selectedIndex = 0;
    return;
  }

  const common = longestCommonPrefix(candidates);
  if (!tabState.active || tabState.basePrefix !== prefix || tabState.candidates.join("|") !== candidates.join("|")) {
    if (common.length > prefix.length) {
      replacePrefix(common);
      tabState.active = true;
      tabState.basePrefix = common;
      tabState.candidates = candidates;
      tabState.cycleIndex = candidates.findIndex((cmd) => cmd === common);
    } else {
      replacePrefix(candidates[0]);
      tabState.active = true;
      tabState.basePrefix = prefix;
      tabState.candidates = candidates;
      tabState.cycleIndex = 0;
    }

    updateHints();
    const selectedCmd = tabState.cycleIndex >= 0
      ? tabState.candidates[tabState.cycleIndex]
      : getCommandPrefix();
    const selectedIndex = hints.matches.findIndex((item) => item.cmd === selectedCmd);
    hints.selectedIndex = selectedIndex >= 0 ? selectedIndex : 0;
    return;
  }

  if (!tabState.candidates.length) {
    tabState.candidates = candidates;
  }

  tabState.cycleIndex = (tabState.cycleIndex + 1) % tabState.candidates.length;
  const next = tabState.candidates[tabState.cycleIndex];
  replacePrefix(next);

  updateHints();
  const selectedIndex = hints.matches.findIndex((item) => item.cmd === next);
  hints.selectedIndex = selectedIndex >= 0 ? selectedIndex : 0;
}

function systemMessage(text) {
  appendLog(`${GR}── ${text} ──${R}`);
}

function errorMessage(text) {
  appendLog(`${RE}✗ ${text}${R}`);
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
  appendLog(dataLine(direction, text, timestamp));
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
  for (const item of COMMANDS) {
    if (item.cmd === "/timer") {
      appendLog(`${GR}/timer <ms> <data>   添加定时任务${R}`);
      continue;
    }

    if (item.cmd === "/stop") {
      appendLog(`${GR}/stop <id>|all       停止定时任务${R}`);
      continue;
    }

    if (item.cmd === "/timers") {
      appendLog(`${GR}/timers              查看定时任务${R}`);
      continue;
    }

    if (item.cmd === "/text") {
      appendLog(`${GR}/text                切换到文本模式${R}`);
      continue;
    }

    if (item.cmd === "/hex") {
      appendLog(`${GR}/hex                 切换到 HEX 模式${R}`);
      continue;
    }

    if (item.cmd === "/clear") {
      appendLog(`${GR}/clear               清屏并重绘头部${R}`);
      continue;
    }

    if (item.cmd === "/help") {
      appendLog(`${GR}/help                显示帮助${R}`);
      continue;
    }

    if (item.cmd === "/exit") {
      appendLog(`${GR}/exit                退出窗口${R}`);
    }
  }
}

function showTimers() {
  if (timers.size === 0) {
    systemMessage("当前没有定时任务");
    return;
  }

  appendLog(`${GR}定时任务列表：${R}`);
  const ordered = [...timers.entries()].sort((a, b) => a[0] - b[0]);
  for (const [id, task] of ordered) {
    const modeTag = task.encoding === "hex" ? "[hex] " : "[text]";
    appendLog(`${GR}[${id}]  ${String(task.intervalMs).padStart(4, " ")}ms  ${modeTag}  ${escapeForDisplay(task.display)}${R}`);
  }
  appendLog(`${GR}共 ${timers.size} 个任务运行中${R}`);
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
    logs.length = 0;
    scheduleRender();
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

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function visibleLength(text) {
  return Array.from(stripAnsi(text)).length;
}

function truncateAnsi(text, maxVisible) {
  if (maxVisible <= 0) return "";

  const source = String(text);
  let out = "";
  let count = 0;
  let i = 0;

  while (i < source.length && count < maxVisible) {
    if (source[i] === "\x1b") {
      const seq = source.slice(i).match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/);
      if (seq) {
        out += seq[0];
        i += seq[0].length;
        continue;
      }
    }

    const codePoint = source.codePointAt(i);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    out += char;
    i += char.length;
    count += 1;
  }

  if (i < source.length && out.includes("\x1b[")) {
    out += R;
  }

  return out;
}

function headerLines() {
  const compact = `${B}串口监控  ${port}  ${baudRate} baud${R}`;
  const rows = process.stdout.rows || 24;
  if (rows < 8) {
    return [compact];
  }

  const midRaw = `  串口监控  ${port}  │  ${baudRate} baud`;
  const mid = midRaw.padEnd(35, " ").slice(0, 35);

  return [
    `${B}${TOP}${R}`,
    `${B}│${mid}│${R}`,
    `${B}${BOTTOM}${R}`,
    `${GR}输入 /help 查看命令，直接输入内容发送到串口${R}`,
  ];
}

function hintLines() {
  if (!hints.visible) return [];

  const list = hints.matches.slice(0, hints.maxVisible);
  const lines = [];

  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (i === hints.selectedIndex) {
      lines.push(`${Y}› ${item.cmd.padEnd(8, " ")} ${item.desc}${R}`);
    } else {
      lines.push(`${GR}  ${item.cmd.padEnd(8, " ")} ${item.desc}${R}`);
    }
  }

  return lines;
}

function buildInputLine(cols) {
  const prompt = getPrompt();
  const promptWidth = visibleLength(prompt);
  const chars = Array.from(inputBuffer);
  const available = Math.max(0, cols - promptWidth);

  let windowStart = 0;
  if (chars.length > available) {
    windowStart = Math.max(0, inputCursor - available);
    const maxStart = Math.max(0, chars.length - available);
    windowStart = Math.min(windowStart, maxStart);
  }

  const visibleChars = available > 0
    ? chars.slice(windowStart, windowStart + available)
    : [];

  const line = `${prompt}${visibleChars.join("")}`;
  const cursorVisible = Math.max(0, inputCursor - windowStart);
  const cursorCol = Math.max(1, Math.min(cols, promptWidth + cursorVisible + 1));

  return { line, cursorCol };
}

function scheduleRender() {
  if (stopping || renderPending) return;
  renderPending = true;
  setImmediate(() => {
    renderPending = false;
    renderFrame();
  });
}

function renderFrame() {
  if (stopping) return;

  const cols = Math.max(process.stdout.columns || 80, 20);
  const rows = Math.max(process.stdout.rows || 24, 8);

  const header = headerLines();
  const dividerLine = `${GR}${"─".repeat(cols)}${R}`;
  const input = buildInputLine(cols);

  const fixedRows = header.length + 2;
  const availableForHintAndLog = Math.max(0, rows - fixedRows);

  let hint = hintLines();
  if (hint.length > availableForHintAndLog) {
    hint = hint.slice(0, availableForHintAndLog);
  }

  const logRows = Math.max(0, rows - fixedRows - hint.length);
  const tailLogs = logs.slice(-logRows);
  const fillBlank = Math.max(0, logRows - tailLogs.length);

  const frame = [
    ...header,
    ...Array.from({ length: fillBlank }, () => ""),
    ...tailLogs,
    ...hint,
    dividerLine,
    input.line,
  ];

  const output = frame
    .map((line) => truncateAnsi(line, cols))
    .join("\n");

  process.stdout.write("\x1b[?25l");
  process.stdout.write("\x1b[H\x1b[2J");
  process.stdout.write(output);

  const cursorRow = frame.length;
  process.stdout.write(`\x1b[${cursorRow};${input.cursorCol}H`);
  process.stdout.write("\x1b[?25h");
}

function setInput(nextChars, nextCursor) {
  inputBuffer = nextChars.join("");
  inputCursor = Math.max(0, Math.min(nextCursor, nextChars.length));
}

function insertText(text) {
  const chars = Array.from(inputBuffer);
  const insertChars = Array.from(text);
  chars.splice(inputCursor, 0, ...insertChars);
  setInput(chars, inputCursor + insertChars.length);
}

function deleteBeforeCursor() {
  if (inputCursor <= 0) return;
  const chars = Array.from(inputBuffer);
  chars.splice(inputCursor - 1, 1);
  setInput(chars, inputCursor - 1);
}

function deleteAtCursor() {
  const chars = Array.from(inputBuffer);
  if (inputCursor >= chars.length) return;
  chars.splice(inputCursor, 1);
  setInput(chars, inputCursor);
}

function onInputChanged() {
  hints.suppressed = false;
  resetTabState();
  updateHints();
  scheduleRender();
}

async function submitCurrentInput() {
  if (submitting) return;

  const input = inputBuffer.trim();
  inputBuffer = "";
  inputCursor = 0;
  hints.suppressed = false;
  hideHints();
  resetTabState();
  scheduleRender();

  if (!input) return;

  submitting = true;
  try {
    if (!handleCommand(input)) {
      await handleSend(input);
    }
  } catch (err) {
    errorMessage(err?.message || String(err));
  } finally {
    submitting = false;
    scheduleRender();
  }
}

function handleKeypress(str, key) {
  if (stopping) return;

  if (key?.ctrl && key.name === "c") {
    shutdown();
    process.exit(0);
    return;
  }

  if (key?.name === "return") {
    resetTabState();
    submitCurrentInput();
    return;
  }

  if (key?.name === "tab") {
    tabComplete();
    scheduleRender();
    return;
  }

  if (key?.name === "escape") {
    hints.suppressed = true;
    hideHints();
    resetTabState();
    scheduleRender();
    return;
  }

  if (key?.name === "backspace") {
    deleteBeforeCursor();
    onInputChanged();
    return;
  }

  if (key?.name === "delete") {
    deleteAtCursor();
    onInputChanged();
    return;
  }

  if (key?.name === "left") {
    inputCursor = Math.max(0, inputCursor - 1);
    resetTabState();
    scheduleRender();
    return;
  }

  if (key?.name === "right") {
    inputCursor = Math.min(Array.from(inputBuffer).length, inputCursor + 1);
    resetTabState();
    scheduleRender();
    return;
  }

  if (key?.name === "home") {
    inputCursor = 0;
    resetTabState();
    scheduleRender();
    return;
  }

  if (key?.name === "end") {
    inputCursor = Array.from(inputBuffer).length;
    resetTabState();
    scheduleRender();
    return;
  }

  if (!key?.ctrl && !key?.meta && str) {
    insertText(str);
    onInputChanged();
  }
}

function startPolling() {
  pollHandle = setInterval(() => {
    try {
      const rows = pollStmt.all(port, lastId);
      if (!rows.length) return;

      for (const row of rows) {
        lastId = row.id;
        if (row.direction === "tx") continue;
        appendLog(dataLine("rx", row.text ?? "", row.timestamp));
      }
    } catch (err) {
      errorMessage(`轮询失败：${err?.message || String(err)}`);
    }
  }, 200);
}

function renderHistory() {
  const rows = historyStmt.all(port).reverse();
  for (const row of rows) {
    logs.push(dataLine(row.direction, row.text ?? "", row.timestamp));
    if (logs.length > MAX_LOGS) {
      logs.splice(0, logs.length - MAX_LOGS);
    }
    lastId = Math.max(lastId, row.id);
  }
}

function setupInput() {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
  }
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.on("keypress", handleKeypress);
}

function restoreTerminal() {
  try {
    process.stdout.write("\x1b[?25h");
  } catch {
  }

  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    try {
      process.stdin.setRawMode(false);
    } catch {
    }
  }
}

function shutdown() {
  if (stopping) return;
  stopping = true;

  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }

  stopAllTimers(false);

  try {
    process.stdin.off("keypress", handleKeypress);
  } catch {
  }

  restoreTerminal();

  try {
    db.close();
  } catch {
  }
}

renderHistory();
updateHints();
setupInput();
startPolling();
scheduleRender();

process.stdout.on("resize", () => {
  scheduleRender();
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
