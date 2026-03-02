import blessed from 'blessed';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = process.argv[2] || 'COM12';
const baudRate = process.argv[3] || '115200';

const COMMANDS = [
  { cmd: '/text', desc: '切换文本模式' },
  { cmd: '/hex', desc: '切换 HEX 模式' },
  { cmd: '/timer', desc: '定时发送  用法: /timer <ms> <data>' },
  { cmd: '/timers', desc: '查看所有定时任务' },
  { cmd: '/stop', desc: '停止定时任务  用法: /stop <id|all>' },
  { cmd: '/clear', desc: '清空日志区' },
  { cmd: '/help', desc: '显示帮助信息' },
  { cmd: '/exit', desc: '退出监控窗口' }
];

const INPUT_HEIGHT = 3;
const MAX_HINT_ITEMS = 8;

let currentMode = 'text';
let lastId = 0;
let exiting = false;
let pollHandle = null;

const timers = new Map();
let nextTimerId = 1;
let currentHints = [];

const screen = blessed.screen({
  smartCSR: true,
  title: `串口监控 ${port}`,
  fullUnicode: true,
  dockBorders: true
});

const logBox = blessed.log({
  top: 0,
  left: 0,
  width: '100%',
  height: screen.height - INPUT_HEIGHT,
  label: `  串口监控  ${port}  │  ${baudRate} baud  `,
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  scrollbar: { ch: '█', style: { fg: 'gray' } },
  mouse: true,
  border: { type: 'line' },
  style: {
    border: { fg: 'gray' },
    label: { fg: 'cyan', bold: true }
  }
});

const inputBox = blessed.textbox({
  bottom: 0,
  left: 0,
  width: '100%',
  height: INPUT_HEIGHT,
  label: `  ${port}  [text] ❯  `,
  tags: true,
  inputOnFocus: true,
  border: { type: 'line' },
  style: {
    border: { fg: 'cyan' },
    label: { fg: 'green', bold: true },
    focus: { border: { fg: 'white' } }
  }
});

const hintBox = blessed.list({
  bottom: 0,
  left: 0,
  width: '100%',
  height: 0,
  hidden: true,
  tags: true,
  keys: true,
  mouse: true,
  border: { type: 'line' },
  style: {
    border: { fg: 'gray' },
    selected: { bg: 'blue', fg: 'white', bold: true },
    item: { fg: 'white' },
    label: { fg: 'gray' }
  },
  label: '  命令  '
});

function escapeTags(text) {
  return String(text ?? '').replace(/[{}]/g, (ch) => (ch === '{' ? '\\{' : '\\}'));
}

function getTimestamp(ts) {
  const d = new Date(ts);
  const hhmmss = d.toTimeString().slice(0, 8);
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hhmmss}.${ms}`;
}

function applyLayout() {
  if (hintBox.hidden) {
    hintBox.height = 0;
    inputBox.bottom = 0;
    logBox.height = screen.height - INPUT_HEIGHT;
  } else {
    inputBox.bottom = hintBox.height;
    logBox.height = screen.height - INPUT_HEIGHT - hintBox.height;
  }
  screen.render();
}

function showHint(matched) {
  currentHints = matched;
  const items = matched.map((c) =>
    `{green-fg}${c.cmd.padEnd(10)}{/green-fg}  {gray-fg}${c.desc}{/gray-fg}`
  );

  hintBox.setItems(items);
  const h = Math.min(matched.length, MAX_HINT_ITEMS) + 2;
  hintBox.height = h;
  hintBox.bottom = 0;
  hintBox.hidden = false;
  hintBox.select(0);

  inputBox.bottom = h;
  logBox.height = screen.height - INPUT_HEIGHT - h;
  screen.render();
}

function hideHint() {
  currentHints = [];
  hintBox.hidden = true;
  hintBox.height = 0;
  inputBox.bottom = 0;
  logBox.height = screen.height - INPUT_HEIGHT;
  screen.render();
}

function appendLog(entry) {
  const time = getTimestamp(entry.timestamp);
  const text = escapeTags(entry.text);

  if (entry.direction === 'tx') {
    logBox.log(`{gray-fg}${time}{/gray-fg}  {yellow-fg}▶{/yellow-fg}  {white-fg}${text}{/white-fg}`);
  } else {
    const isHex = text.startsWith('[HEX]');
    const color = isHex ? 'cyan' : 'green';
    logBox.log(`{gray-fg}${time}{/gray-fg}  {${color}-fg}◀{/${color}-fg}  {${color}-fg}${text}{/${color}-fg}`);
  }
  screen.render();
}

function sendToPort(data, encoding) {
  const body = JSON.stringify({ port, data, encoding });
  const req = http.request({
    hostname: '127.0.0.1',
    port: 7070,
    path: '/send',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
    timeout: 5000
  }, (res) => {
    let raw = '';
    res.on('data', (d) => {
      raw += d;
    });
    res.on('end', () => {
      try {
        const r = JSON.parse(raw);
        if (!r.success) {
          logBox.log(`{red-fg}✗ 发送失败：${escapeTags(r.error || '未知错误')}{/red-fg}`);
          screen.render();
        }
      } catch {
        // ignore parse error
      }
    });
  });

  req.on('error', (e) => {
    logBox.log(`{red-fg}✗ 连接失败：${escapeTags(e.message)}{/red-fg}`);
    screen.render();
  });

  req.on('timeout', () => {
    req.destroy();
    logBox.log('{red-fg}✗ 发送超时{/red-fg}');
    screen.render();
  });

  req.write(body);
  req.end();
}

function addTimer(ms, data, encoding) {
  const id = nextTimerId++;
  const handle = setInterval(() => sendToPort(data, encoding), ms);
  timers.set(id, { ms, data, encoding, handle });
  logBox.log(`{gray-fg}── 定时任务 [${id}] 已启动，每 ${ms}ms 发送 ──{/gray-fg}`);
  screen.render();
}

function listTimers() {
  if (timers.size === 0) {
    logBox.log('{gray-fg}── 没有运行中的定时任务 ──{/gray-fg}');
    screen.render();
    return;
  }

  timers.forEach((t, id) => {
    logBox.log(`  {white-fg}[${id}]{/white-fg}  {yellow-fg}${t.ms}ms{/yellow-fg}  [${t.encoding}]  ${escapeTags(t.data)}`);
  });
  screen.render();
}

function stopTimer(arg) {
  if (arg === 'all') {
    timers.forEach((t) => clearInterval(t.handle));
    timers.clear();
    logBox.log('{gray-fg}── 所有定时任务已停止 ──{/gray-fg}');
    screen.render();
    return;
  }

  const id = parseInt(arg, 10);
  if (timers.has(id)) {
    clearInterval(timers.get(id).handle);
    timers.delete(id);
    logBox.log(`{gray-fg}── 定时任务 [${id}] 已停止 ──{/gray-fg}`);
  } else {
    logBox.log(`{red-fg}✗ 找不到定时任务 [${escapeTags(arg)}]{/red-fg}`);
  }
  screen.render();
}

function showHelp() {
  COMMANDS.forEach((c) => {
    logBox.log(`{green-fg}${c.cmd.padEnd(10)}{/green-fg}  {white-fg}${c.desc}{/white-fg}`);
  });
  screen.render();
}

function handleInput(val) {
  if (!val.startsWith('/')) {
    const data = currentMode === 'text'
      ? val.replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
      : val;
    sendToPort(data, currentMode);
    return;
  }

  const parts = val.trim().split(/\s+/);
  const cmd = parts[0];

  switch (cmd) {
    case '/text':
      currentMode = 'text';
      inputBox.setLabel(`  ${port}  [text] ❯  `);
      logBox.log('{gray-fg}── 已切换到文本模式 ──{/gray-fg}');
      break;
    case '/hex':
      currentMode = 'hex';
      inputBox.setLabel(`  ${port}  [hex]  ❯  `);
      logBox.log('{gray-fg}── 已切换到 HEX 模式 ──{/gray-fg}');
      break;
    case '/timer': {
      const ms = parseInt(parts[1], 10);
      const data = parts.slice(2).join(' ');
      if (!ms || !data) {
        logBox.log('{red-fg}✗ 用法：/timer <ms> <data>{/red-fg}');
        break;
      }
      addTimer(ms, data, currentMode);
      break;
    }
    case '/timers':
      listTimers();
      break;
    case '/stop':
      stopTimer(parts[1]);
      break;
    case '/clear':
      logBox.setContent('');
      screen.render();
      break;
    case '/help':
      showHelp();
      break;
    case '/exit':
      cleanup();
      process.exit(0);
      return;
    default:
      logBox.log(`{red-fg}✗ 未知命令：${escapeTags(cmd)}，输入 /help 查看帮助{/red-fg}`);
      screen.render();
  }

  screen.render();
}

const dbPath = path.resolve(__dirname, '../serial-db/serial.db');
const db = new Database(dbPath);

const historyStmt = db.prepare(
  'SELECT id, port, direction, text, timestamp FROM serial_data WHERE port = ? ORDER BY id DESC LIMIT 20'
);

const pollStmt = db.prepare(
  'SELECT id, port, direction, text, timestamp FROM serial_data WHERE port = ? AND id > ? ORDER BY id ASC'
);

function cleanup() {
  if (exiting) {
    return;
  }
  exiting = true;

  timers.forEach((t) => clearInterval(t.handle));
  timers.clear();

  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }

  try {
    db.close();
  } catch {
    // ignore db close error
  }

  try {
    screen.destroy();
  } catch {
    // ignore screen destroy error
  }
}

inputBox.on('keypress', () => {
  setImmediate(() => {
    const val = inputBox.getValue();
    if (val.startsWith('/')) {
      const matched = COMMANDS.filter((c) =>
        val === '/' ? true : c.cmd.startsWith(val.split(' ')[0])
      );
      if (matched.length > 0) {
        showHint(matched);
      } else {
        hideHint();
      }
    } else {
      hideHint();
    }
  });
});

inputBox.key(['up'], () => {
  if (!hintBox.hidden) {
    hintBox.up(1);
    screen.render();
  }
});

inputBox.key(['down'], () => {
  if (!hintBox.hidden) {
    hintBox.down(1);
    screen.render();
  }
});

inputBox.key(['enter'], () => {
  const raw = inputBox.getValue().trim();

  if (!hintBox.hidden && currentHints.length > 0) {
    const idx = hintBox.selected;
    const selected = currentHints[idx] || currentHints[0];
    if (selected) {
      inputBox.setValue(`${selected.cmd} `);
      hideHint();
      screen.render();
      inputBox.focus();
      return;
    }
  }

  inputBox.clearValue();
  hideHint();

  if (raw) {
    handleInput(raw);
  }

  screen.render();
  inputBox.focus();
});

inputBox.key(['escape'], () => {
  hideHint();
  inputBox.focus();
});

screen.key(['C-c'], () => {
  cleanup();
  process.exit(0);
});

screen.on('resize', () => {
  applyLayout();
});

process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});

screen.append(logBox);
screen.append(inputBox);
screen.append(hintBox);

inputBox.focus();
hideHint();

const history = historyStmt.all(port).reverse();
lastId = history.length > 0 ? history[history.length - 1].id : 0;
history.forEach(appendLog);

pollHandle = setInterval(() => {
  const rows = pollStmt.all(port, lastId);
  rows.forEach((row) => {
    lastId = row.id;
    appendLog(row);
  });
}, 200);
