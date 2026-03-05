#!/usr/bin/env node
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { render, Box, Text, useApp, useInput, useStdout } from 'ink';
import Database from 'better-sqlite3';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const portName = process.argv[2] || 'COM3';
const baudRate = process.argv[3] || '115200';
const dbPath = path.resolve(__dirname, '../serial-db/serial.db');

const COMMANDS = [
  { cmd: '/text', desc: '切换文本模式' },
  { cmd: '/hex', desc: '切换 HEX 模式' },
  { cmd: '/eol', desc: '自动追加 CRLF  /eol <on|off>' },
  { cmd: '/timer', desc: '定时发送  /timer <ms> <data>' },
  { cmd: '/timers', desc: '查看定时任务' },
  { cmd: '/stop', desc: '停止定时任务  /stop <id|all>' },
  { cmd: '/clear', desc: '清空日志' },
  { cmd: '/help', desc: '显示帮助' },
  { cmd: '/exit', desc: '退出' }
];

const MAX_LOGS = 200;
const isInputActive = Boolean(process.stdin?.isTTY);
const CLAUDE_ACCENT = '#D97757';
const MAX_HINT_VISIBLE = 6;
const h = React.createElement;

function sendToPort(port, data, encoding) {
  return new Promise((resolve, reject) => {
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
        res.on('data', (d) => {
          raw += d;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve({ success: false, error: '响应解析失败' });
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });

    req.write(body);
    req.end();
  });
}

function ensureTextFrame(data) {
  if (data.includes('\r') || data.includes('\n')) {
    return data;
  }

  return `${data}\r\n`;
}

function normalizeHexPayload(value) {
  const cleaned = String(value ?? '')
    .replace(/0x/gi, '')
    .replace(/\s+/g, '')
    .trim();

  if (!cleaned) {
    return { ok: false, error: 'HEX 不能为空' };
  }

  if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
    return { ok: false, error: 'HEX 只能包含 0-9 A-F（可带空格或0x前缀）' };
  }

  if (cleaned.length % 2 !== 0) {
    return { ok: false, error: 'HEX 长度必须为偶数（每2位为1字节）' };
  }

  return { ok: true, hex: cleaned.toUpperCase() };
}

function ensureHexFrame(hex) {
  return hex.endsWith('0D0A') ? hex : `${hex}0D0A`;
}

function formatDisplayText(value) {
  return String(value ?? '')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (!cp) return 0;

  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  ) {
    return 2;
  }

  return 1;
}

function textWidth(str) {
  let width = 0;
  for (const ch of String(str ?? '')) {
    width += charWidth(ch);
  }
  return width;
}

function sliceEndByWidth(str, maxWidth) {
  if (maxWidth <= 0) return '';
  const chars = Array.from(String(str ?? ''));
  let used = 0;
  const out = [];

  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const w = charWidth(chars[i]);
    if (used + w > maxWidth) break;
    out.push(chars[i]);
    used += w;
  }

  return out.reverse().join('');
}

function Monitor() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows || 24;
  const termWidth = stdout?.columns || 80;

  const [logs, setLogs] = useState([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState('text');
  const [autoEol, setAutoEol] = useState(false);
  const [hints, setHints] = useState([]);
  const [hintIndex, setHintIndex] = useState(0);

  const dbRef = useRef(null);
  const pollRef = useRef(null);
  const timersRef = useRef(new Map());
  const nextIdRef = useRef(1);
  const lastIdRef = useRef(0);
  const msgSeqRef = useRef(1);

  const mapDbEntry = (entry) => {
    const d = new Date(entry.timestamp);
    const time = d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
    return {
      ...entry,
      key: `db-${entry.id}`,
      time,
      text: formatDisplayText(entry.text)
    };
  };

  const pushDbRows = (rows) => {
    if (!rows || rows.length === 0) {
      return;
    }

    const mapped = rows.map(mapDbEntry);
    setLogs((prev) => {
      const next = [...prev, ...mapped];
      return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
    });
  };

  const addMsg = (text, color = 'gray') => {
    const key = `msg-${Date.now()}-${msgSeqRef.current++}`;
    setLogs((prev) => {
      const next = [...prev, { key, type: 'msg', text: formatDisplayText(text), color }];
      return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
    });
  };

  const cleanup = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    timersRef.current.forEach((t) => clearInterval(t.handle));
    timersRef.current.clear();

    if (dbRef.current) {
      try {
        dbRef.current.close();
      } catch {
        // ignore close errors
      }
      dbRef.current = null;
    }
  };

  useEffect(() => {
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
      } catch {
        // ignore raw mode setup errors
      }
    }

    process.stdin.resume();

    return () => {
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(false);
        } catch {
          // ignore raw mode reset errors
        }
      }
    };
  }, []);

  useEffect(() => {
    const db = new Database(dbPath);
    dbRef.current = db;

    const history = db
      .prepare(
        'SELECT id, port, direction, text, timestamp FROM serial_data WHERE port = ? ORDER BY id DESC LIMIT 20'
      )
      .all(portName)
      .reverse();

    if (history.length > 0) {
      lastIdRef.current = history[history.length - 1].id;
      pushDbRows(history);
    }

    const stmt = db.prepare(
      'SELECT id, port, direction, text, timestamp FROM serial_data WHERE port = ? AND id > ? ORDER BY id ASC'
    );

    pollRef.current = setInterval(() => {
      try {
        const rows = stmt.all(portName, lastIdRef.current);
        if (rows.length > 0) {
          lastIdRef.current = rows[rows.length - 1].id;
          pushDbRows(rows);
        }
      } catch (err) {
        addMsg(`✗ 读取数据库失败：${err.message}`, 'red');
      }
    }, 200);

    return () => {
      cleanup();
    };
  }, []);

  useEffect(() => {
    if (input.startsWith('/')) {
      const matched = input === '/'
        ? COMMANDS
        : COMMANDS.filter((c) => c.cmd.startsWith(input.split(' ')[0]));
      setHints(matched);
      setHintIndex(0);
    } else {
      setHints([]);
      setHintIndex(0);
    }
  }, [input]);

  const handleSubmit = async (val) => {
    if (!val.trim()) {
      return;
    }

    setInput('');
    setHints([]);
    setHintIndex(0);

    if (!val.startsWith('/')) {
      let data;

      if (mode === 'text') {
        const rawText = val
          .replace(/\\r/g, '\r')
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t');
        data = autoEol ? ensureTextFrame(rawText) : rawText;
      } else {
        const parsed = normalizeHexPayload(val);
        if (!parsed.ok) {
          addMsg(`✗ ${parsed.error}`, 'red');
          return;
        }
        data = autoEol ? ensureHexFrame(parsed.hex) : parsed.hex;
      }

      try {
        const result = await sendToPort(portName, data, mode);
        if (!result.success) {
          addMsg(`✗ 发送失败：${result.error || '未知错误'}`, 'red');
        }
      } catch (err) {
        addMsg(`✗ 连接失败：${err.message}`, 'red');
      }
      return;
    }

    const parts = val.trim().split(/\s+/);
    const cmd = parts[0];

    switch (cmd) {
      case '/text':
        setMode('text');
        addMsg('── 已切换到文本模式 ──');
        break;
      case '/hex':
        setMode('hex');
        addMsg('── 已切换到 HEX 模式 ──');
        break;
      case '/eol': {
        const arg = String(parts[1] || '').toLowerCase();
        if (arg === 'on') {
          setAutoEol(true);
          addMsg('── 自动追加 CRLF：ON ──');
        } else if (arg === 'off') {
          setAutoEol(false);
          addMsg('── 自动追加 CRLF：OFF ──');
        } else {
          addMsg(`当前自动追加 CRLF：${autoEol ? 'ON' : 'OFF'}，用法：/eol <on|off>`, 'gray');
        }
        break;
      }
      case '/timer': {
        const ms = parseInt(parts[1], 10);
        let data = parts.slice(2).join(' ');
        if (!ms || !data) {
          addMsg('✗ 用法：/timer <ms> <data>', 'red');
          break;
        }

        if (mode === 'hex') {
          const parsed = normalizeHexPayload(data);
          if (!parsed.ok) {
            addMsg(`✗ ${parsed.error}`, 'red');
            break;
          }
          data = autoEol ? ensureHexFrame(parsed.hex) : parsed.hex;
        } else if (mode === 'text' && autoEol) {
          data = ensureTextFrame(data);
        }

        const id = nextIdRef.current++;
        const timerMode = mode;
        const handle = setInterval(() => {
          sendToPort(portName, data, timerMode).catch(() => {
            // keep timer alive, omit spam
          });
        }, ms);
        timersRef.current.set(id, { ms, data, mode: timerMode, handle });
        addMsg(`── 定时任务 [${id}] 已启动，每 ${ms}ms 发送 ──`);
        break;
      }
      case '/timers': {
        if (timersRef.current.size === 0) {
          addMsg('── 没有运行中的定时任务 ──');
          break;
        }
        timersRef.current.forEach((timer, id) => {
          addMsg(`  [${id}]  ${timer.ms}ms  [${timer.mode}]  ${timer.data}`);
        });
        break;
      }
      case '/stop': {
        const arg = parts[1];
        if (arg === 'all') {
          timersRef.current.forEach((t) => clearInterval(t.handle));
          timersRef.current.clear();
          addMsg('── 所有定时任务已停止 ──');
          break;
        }

        const id = parseInt(arg, 10);
        if (timersRef.current.has(id)) {
          clearInterval(timersRef.current.get(id).handle);
          timersRef.current.delete(id);
          addMsg(`── 定时任务 [${id}] 已停止 ──`);
        } else {
          addMsg(`✗ 找不到定时任务 [${arg}]`, 'red');
        }
        break;
      }
      case '/clear':
        setLogs([]);
        break;
      case '/help':
        COMMANDS.forEach((c) => addMsg(`  ${c.cmd.padEnd(10)}  ${c.desc}`));
        break;
      case '/exit':
        cleanup();
        exit();
        process.exit(0);
        break;
      default:
        addMsg(`✗ 未知命令：${cmd}`, 'red');
        break;
    }
  };

  useInput((ch, key) => {
    if (key.ctrl && ch === 'c') {
      cleanup();
      exit();
      process.exit(0);
      return;
    }

    if (key.return) {
      if (hints.length > 0 && input.startsWith('/') && !input.includes(' ')) {
        const selected = hints[hintIndex];
        if (selected) {
          handleSubmit(selected.cmd);
          return;
        }
      }

      handleSubmit(input);
      return;
    }

    if (key.escape) {
      setHints([]);
      return;
    }

    if (key.upArrow) {
      if (hints.length > 0) {
        setHintIndex((prev) => (prev - 1 + hints.length) % hints.length);
      }
      return;
    }

    if (key.downArrow) {
      if (hints.length > 0) {
        setHintIndex((prev) => (prev + 1) % hints.length);
      }
      return;
    }

    if (key.tab) {
      if (hints.length > 0) {
        setInput(`${hints[hintIndex].cmd} `);
      }
      return;
    }

    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }

    if (ch && !key.ctrl && !key.meta) {
      setInput((prev) => prev + ch);
    }
  }, { isActive: isInputActive });

  const visibleHintCount = Math.min(hints.length, MAX_HINT_VISIBLE);
  const maxHintStart = Math.max(0, hints.length - MAX_HINT_VISIBLE);
  const hintStart = Math.min(Math.max(0, hintIndex - (MAX_HINT_VISIBLE - 1)), maxHintStart);
  const visibleHints = hints.slice(hintStart, hintStart + MAX_HINT_VISIBLE);
  const hintHeight = visibleHintCount > 0 ? visibleHintCount + 1 : 0;
  const logHeight = Math.max(5, termHeight - 5 - hintHeight);
  const visibleLogs = useMemo(() => logs.slice(-Math.max(1, logHeight)), [logs, logHeight]);
  const separator = '─'.repeat(Math.max(10, termWidth));
  const rightCorner = `${baudRate} baud`;
  const promptPrefix = `${portName} [${mode}${autoEol ? ',eol' : ''}] ❯ `;
  const inputRoom = Math.max(0, termWidth - textWidth(promptPrefix) - 1);
  const inputPreview = sliceEndByWidth(input, inputRoom);
  const rightPad = Math.max(0, termWidth - textWidth(rightCorner));

  const logRows = visibleLogs.map((entry, i) => {
    if (entry.type === 'msg') {
      return h(Text, { key: entry.key || `msg-${i}`, color: entry.color || 'gray' }, entry.text);
    }

    const isHex = entry.text?.startsWith('[HEX]');
    if (entry.direction === 'tx') {
      return h(
        Text,
        { key: entry.key || `tx-${i}` },
        h(Text, { color: 'gray' }, `${entry.time}  `),
        h(Text, { color: 'yellow' }, '▶  '),
        h(Text, { color: 'white' }, entry.text)
      );
    }

    return h(
      Text,
      { key: entry.key || `rx-${i}` },
      h(Text, { color: 'gray' }, `${entry.time}  `),
      h(Text, { color: isHex ? 'cyan' : CLAUDE_ACCENT }, '◀  '),
      h(Text, { color: isHex ? 'cyan' : CLAUDE_ACCENT }, entry.text)
    );
  });

  const hintRows = visibleHints.map((c, i) => {
    const actualIndex = hintStart + i;
    return (
    h(
      Text,
      { key: `hint-${c.cmd}` },
      h(
        Text,
        {
          color: actualIndex === hintIndex ? 'black' : CLAUDE_ACCENT,
          bold: actualIndex === hintIndex,
          backgroundColor: actualIndex === hintIndex ? 'white' : undefined
        },
        c.cmd.padEnd(10, ' ')
      ),
      h(Text, { color: 'gray' }, `  ${c.desc}`)
    )
  );
  });

  return h(
    Box,
    { flexDirection: 'column', height: termHeight },
    h(Text, { color: 'cyan', bold: true }, `serial-monitor  ${portName}  ${baudRate} baud`),
    h(Text, { color: 'gray' }, separator),
    h(
      Box,
      {
        flexDirection: 'column',
        height: logHeight,
        overflow: 'hidden',
        paddingX: 0
      },
      ...logRows
    ),
    h(Text, { color: 'gray' }, separator),
    h(Text, { color: 'gray' }, `${' '.repeat(rightPad)}${rightCorner}`),
    h(
      Text,
      null,
      h(Text, { color: CLAUDE_ACCENT, bold: true }, promptPrefix),
      h(Text, { color: 'white' }, inputPreview),
      h(Text, { color: 'white', bold: true }, '█')
    ),
    visibleHintCount > 0
      ? h(
          Box,
          {
            flexDirection: 'column',
            paddingX: 0,
            height: hintHeight
          },
          h(Text, { color: 'gray' }, 'commands'),
          ...hintRows
        )
      : null
  );
}

render(h(Monitor), {
  stdin: process.stdin,
  stdout: process.stdout,
  exitOnCtrlC: false
});
