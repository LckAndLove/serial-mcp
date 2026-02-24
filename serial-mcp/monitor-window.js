import blessed from 'blessed';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = process.argv[2] || 'COM3';
const baudRate = process.argv[3] || '115200';

const COMMANDS = [
  { cmd: '/text', desc: '切换文本模式' },
  { cmd: '/hex', desc: '切换 HEX 模式' },
  { cmd: '/timer', desc: '定时发送  /timer <ms> <data>' },
  { cmd: '/timers', desc: '查看定时任务列表' },
  { cmd: '/stop', desc: '停止定时任务  /stop <id|all>' },
  { cmd: '/clear', desc: '清空日志区' },
  { cmd: '/help', desc: '显示帮助' },
  { cmd: '/exit', desc: '退出监控' }
];

const INPUT_HEIGHT = 3;
const MAX_HINT_ROWS = 8;
let currentMode = 'text';
let matchedCommands = [];

const timers = new Map();
let nextTimerId = 1;
let lastId = 0;

const screen = blessed.screen({
  smartCSR: true,
  fullUnicode: true,
  title: `串口监控 ${port}`,
  dockBorders: true,
  autoPadding: false
});

const logBox = blessed.log({
  parent: screen,
  top: 0,
  left: 0,
  width: '100%',
  height: `100%-${INPUT_HEIGHT}`,
  border: 'line',
  label: ` 串口监控  ${port}  |  ${baudRate} baud `,
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  keys: true,
  vi: true,
  mouse: true,
  scrollbar: {
    ch: ' ',
    track: { bg: 'black' },
    style: { bg: 'gray' }
  },
  style: {
    border: { fg: 'gray' },
    label: { fg: 'cyan', bold: true }
  }
});

const hintBox = blessed.list({
  parent: screen,
  bottom: 0,
  left: 0,
  width: '100%',
  height: 0,
  hidden: true,
  border: 'line',
  tags: true,
  keys: true,
  mouse: true,
  interactive: true,
  style: {
    border: { fg: 'gray' },
    selected: { bg: 'blue', fg: 'white', bold: true },
    item: { fg: 'white' }
  }
});

const inputBox = blessed.textbox({
  parent: screen,
  bottom: 0,
  left: 0,
  width: '100%',
  height: INPUT_HEIGHT,
  border: 'line',
  label: ` ${port}  [${currentMode}] `,
  inputOnFocus: true,
  keys: true,
  mouse: true,
  style: {
    border: { fg: 'cyan' },
    focus: { border: { fg: 'white' } },
    label: { fg: 'green' }
  }
});

function refreshLayout() {
  const hintHeight = hintBox.hidden ? 0 : hintBox.height;
  hintBox.bottom = 0;
  inputBox.bottom = hintHeight;
  logBox.top = 0;
  logBox.height = screen.height - INPUT_HEIGHT - hintHeight;
  screen.render();
}

function setModeLabel() {
  inputBox.setLabel(` ${port}  [${currentMode}] `);
}

function hideHint() {
  matchedCommands = [];
  hintBox.hidden = true;
  hintBox.height = 0;
  hintBox.clearItems();
  refreshLayout();
}

function showHint(input) {
  const matched = input === '/'
    ? COMMANDS
    : COMMANDS.filter((item) => item.cmd.startsWith(input));

  if (!matched.length) {
    hideHint();
    return;
  }

  matchedCommands = matched;
  const items = matched.map((item) => {
    const padCmd = item.cmd.padEnd(12, ' ');
    return `{green-fg}${padCmd}{/green-fg}  {gray-fg}${item.desc}{/gray-fg}`;
  });

  hintBox.setItems(items);
  hintBox.select(0);
  hintBox.hidden = false;
  hintBox.height = Math.min(matched.length, MAX_HINT_ROWS) + 2;
  refreshLayout();
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '00:00:00.000';
  }
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function escapeTags(value) {
  return String(value ?? '').replace(/[{}]/g, (ch) => (ch === '{' ? '\\{' : '\\}'));
}

function appendLog(entry) {
  const time = formatTime(entry.timestamp);
  const text = escapeTags(entry.text);

  let line;
  if (entry.direction === 'tx') {
    line = `{gray-fg}${time}{/gray-fg}  {yellow-fg}▶{/yellow-fg}  {white-fg}${text}{/white-fg}`;
  } else {
    const isHex = text.startsWith('[HEX]');
    const color = isHex ? 'cyan' : 'green';
    line = `{gray-fg}${time}{/gray-fg}  {${color}-fg}◀{/${color}-fg}  {${color}-fg}${text}{/${color}-fg}`;
  }

  logBox.log(line);
  screen.render();
}

function appendSystemLog(line, color = 'gray') {
  logBox.log(`{${color}-fg}${escapeTags(line)}{/${color}-fg}`);
  screen.render();
}

function sendToPort(data, encoding) {
  const body = JSON.stringify({ port, data, encoding });

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: 7070,
      path: '/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 5000
    },
    (res) => {
      let raw = '';
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        try {
          const result = JSON.parse(raw);
          if (!result.success) {
            appendSystemLog(`✗ 发送失败：${result.error || '未知错误'}`, 'red');
          }
        } catch {
          // ignore invalid payload
        }
      });
    }
  );

  req.on('timeout', () => {
    req.destroy(new Error('请求超时'));
  });

  req.on('error', (err) => {
    appendSystemLog(`✗ 连接失败：${err.message}`, 'red');
  });

  req.write(body);
  req.end();
}

function addTimer(ms, data, encoding) {
  const id = nextTimerId;
  nextTimerId += 1;

  const handle = setInterval(() => {
    sendToPort(data, encoding);
  }, ms);

  timers.set(id, { ms, data, encoding, handle });
  appendSystemLog(`── 定时任务 [${id}] 已启动，每 ${ms}ms 发送 ──`, 'gray');
}

function listTimers() {
  if (timers.size === 0) {
    appendSystemLog('── 没有运行中的定时任务 ──', 'gray');
    return;
  }

  appendSystemLog('定时任务列表：', 'cyan');
  timers.forEach((timer, id) => {
    appendSystemLog(`  [${id}]  ${timer.ms}ms  [${timer.encoding}]  ${timer.data}`, 'white');
  });
}

function stopTimer(arg) {
  if (arg === 'all') {
    timers.forEach((timer) => {
      clearInterval(timer.handle);
    });
    timers.clear();
    appendSystemLog('── 所有定时任务已停止 ──', 'gray');
    return;
  }

  const id = Number.parseInt(arg, 10);
  if (!Number.isInteger(id) || !timers.has(id)) {
    appendSystemLog(`✗ 找不到定时任务 [${arg ?? ''}]`, 'red');
    return;
  }

  clearInterval(timers.get(id).handle);
  timers.delete(id);
  appendSystemLog(`── 定时任务 [${id}] 已停止 ──`, 'gray');
}

function showHelp() {
  appendSystemLog('可用命令：', 'cyan');
  COMMANDS.forEach((item) => {
    appendSystemLog(`  ${item.cmd.padEnd(12, ' ')}  ${item.desc}`, 'white');
  });
}

function handleInput(val) {
  if (val.startsWith('/')) {
    const parts = val.trim().split(/\s+/);
    const cmd = parts[0];

    switch (cmd) {
      case '/text': {
        currentMode = 'text';
        setModeLabel();
        appendSystemLog('── 已切换到文本模式 ──', 'gray');
        break;
      }
      case '/hex': {
        currentMode = 'hex';
        setModeLabel();
        appendSystemLog('── 已切换到 HEX 模式 ──', 'gray');
        break;
      }
      case '/timer': {
        const ms = Number.parseInt(parts[1], 10);
        const data = parts.slice(2).join(' ');
        if (!Number.isInteger(ms) || ms <= 0 || !data) {
          appendSystemLog('✗ 用法：/timer <ms> <data>', 'red');
          break;
        }
        addTimer(ms, data, currentMode);
        break;
      }
      case '/timers': {
        listTimers();
        break;
      }
      case '/stop': {
        stopTimer(parts[1]);
        break;
      }
      case '/clear': {
        logBox.setContent('');
        break;
      }
      case '/help': {
        showHelp();
        break;
      }
      case '/exit': {
        shutdown(0);
        return;
      }
      default: {
        appendSystemLog(`✗ 未知命令：${cmd}，输入 /help 查看帮助`, 'red');
      }
    }
  } else {
    const data = currentMode === 'text'
      ? val.replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
      : val;

    sendToPort(data, currentMode);
  }

  screen.render();
}

const dbPath = path.resolve(__dirname, '../serial-db/serial.db');
const db = new Database(dbPath, { readonly: true });

const historyStmt = db.prepare(
  'SELECT id, port, direction, text, timestamp FROM serial_data WHERE port = ? ORDER BY id DESC LIMIT 20'
);
const pollStmt = db.prepare(
  'SELECT id, port, direction, text, timestamp FROM serial_data WHERE port = ? AND id > ? ORDER BY id ASC'
);

function loadHistory() {
  const history = historyStmt.all(port).reverse();
  if (history.length > 0) {
    lastId = history[history.length - 1].id;
  }
  history.forEach((row) => appendLog(row));
}

const pollHandle = setInterval(() => {
  try {
    const rows = pollStmt.all(port, lastId);
    rows.forEach((row) => {
      lastId = row.id;
      appendLog(row);
    });
  } catch (err) {
    appendSystemLog(`✗ 读取数据库失败：${err.message}`, 'red');
  }
}, 200);

let exiting = false;

function shutdown(code = 0) {
  if (exiting) {
    return;
  }
  exiting = true;

  clearInterval(pollHandle);
  timers.forEach((timer) => {
    clearInterval(timer.handle);
  });
  timers.clear();

  try {
    db.close();
  } catch {
    // ignore close errors
  }

  screen.destroy();
  process.exit(code);
}

inputBox.key(['up', 'down'], (_, key) => {
  if (hintBox.hidden) {
    return;
  }

  if (key.name === 'up') {
    hintBox.up(1);
  } else if (key.name === 'down') {
    hintBox.down(1);
  }
  screen.render();
});

inputBox.key('enter', () => {
  const val = inputBox.getValue().trim();

  if (!hintBox.hidden && matchedCommands.length > 0) {
    const index = hintBox.selected;
    const selected = matchedCommands[index] || matchedCommands[0];
    if (selected) {
      inputBox.setValue(`${selected.cmd} `);
      hideHint();
      inputBox.focus();
      screen.render();
      return;
    }
  }

  inputBox.clearValue();

  if (val) {
    handleInput(val);
  }

  hideHint();
  inputBox.focus();
  screen.render();
});

inputBox.key('escape', () => {
  hideHint();
  inputBox.focus();
});

inputBox.on('keypress', () => {
  setImmediate(() => {
    const val = inputBox.getValue();
    if (val.startsWith('/')) {
      showHint(val);
    } else {
      hideHint();
    }
  });
});

hintBox.on('select', (_, index) => {
  const selected = matchedCommands[index];
  if (!selected) {
    return;
  }
  inputBox.setValue(`${selected.cmd} `);
  hideHint();
  inputBox.focus();
  screen.render();
});

logBox.on('mouse', (data) => {
  if (data.action === 'wheelup') {
    logBox.scroll(-2);
    screen.render();
  }
  if (data.action === 'wheeldown') {
    logBox.scroll(2);
    screen.render();
  }
});

screen.on('resize', () => {
  refreshLayout();
});

screen.key(['C-c'], () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

loadHistory();
showHelp();
refreshLayout();
inputBox.focus();
