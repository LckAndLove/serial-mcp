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
  { cmd: '/timer', desc: '定时发送  /timer <ms> <data>' },
  { cmd: '/timers', desc: '查看定时任务' },
  { cmd: '/stop', desc: '停止定时任务  /stop <id|all>' },
  { cmd: '/clear', desc: '清空日志' },
  { cmd: '/help', desc: '显示帮助' },
  { cmd: '/exit', desc: '退出' }
];

const MAX_LOGS = 200;
const isInputActive = Boolean(process.stdin?.isTTY);
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

function Monitor() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows || 24;

  const [logs, setLogs] = useState([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState('text');
  const [hints, setHints] = useState([]);
  const [hintIndex, setHintIndex] = useState(0);

  const dbRef = useRef(null);
  const pollRef = useRef(null);
  const timersRef = useRef(new Map());
  const nextIdRef = useRef(1);
  const lastIdRef = useRef(0);

  const addLog = (entry) => {
    const d = new Date(entry.timestamp);
    const time = d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
    setLogs((prev) => {
      const next = [...prev, { ...entry, time }];
      return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
    });
  };

  const addMsg = (text, color = 'gray') => {
    setLogs((prev) => {
      const next = [...prev, { type: 'msg', text, color }];
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
      history.forEach(addLog);
    }

    const stmt = db.prepare(
      'SELECT id, port, direction, text, timestamp FROM serial_data WHERE port = ? AND id > ? ORDER BY id ASC'
    );

    pollRef.current = setInterval(() => {
      try {
        const rows = stmt.all(portName, lastIdRef.current);
        rows.forEach((row) => {
          lastIdRef.current = row.id;
          addLog(row);
        });
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

    if (hints.length > 0 && val.startsWith('/') && !val.includes(' ')) {
      const selected = hints[hintIndex];
      if (selected) {
        setInput(`${selected.cmd} `);
        return;
      }
    }

    setInput('');
    setHints([]);
    setHintIndex(0);

    if (!val.startsWith('/')) {
      const data = mode === 'text'
        ? val.replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
        : val;
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
      case '/timer': {
        const ms = parseInt(parts[1], 10);
        const data = parts.slice(2).join(' ');
        if (!ms || !data) {
          addMsg('✗ 用法：/timer <ms> <data>', 'red');
          break;
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
      handleSubmit(input);
      return;
    }

    if (key.escape) {
      setHints([]);
      return;
    }

    if (key.upArrow) {
      if (hints.length > 0) {
        setHintIndex((prev) => Math.max(0, prev - 1));
      }
      return;
    }

    if (key.downArrow) {
      if (hints.length > 0) {
        setHintIndex((prev) => Math.min(hints.length - 1, prev + 1));
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

  const hintHeight = hints.length > 0 ? Math.min(hints.length, 8) + 2 : 0;
  const logHeight = Math.max(5, termHeight - 2 - 3 - hintHeight);
  const visibleLogs = useMemo(() => logs.slice(-Math.max(1, logHeight - 2)), [logs, logHeight]);

  const logRows = visibleLogs.map((entry, i) => {
    if (entry.type === 'msg') {
      return h(Text, { key: i, color: entry.color || 'gray' }, entry.text);
    }

    const isHex = entry.text?.startsWith('[HEX]');
    if (entry.direction === 'tx') {
      return h(
        Text,
        { key: i },
        h(Text, { color: 'gray' }, `${entry.time}  `),
        h(Text, { color: 'yellow' }, '▶  '),
        h(Text, { color: 'white' }, entry.text)
      );
    }

    return h(
      Text,
      { key: i },
      h(Text, { color: 'gray' }, `${entry.time}  `),
      h(Text, { color: isHex ? 'cyan' : 'green' }, '◀  '),
      h(Text, { color: isHex ? 'cyan' : 'green' }, entry.text)
    );
  });

  const hintRows = hints.slice(0, 8).map((c, i) =>
    h(
      Box,
      { key: i },
      h(
        Text,
        {
          color: i === hintIndex ? 'white' : 'green',
          bold: i === hintIndex,
          backgroundColor: i === hintIndex ? 'blue' : undefined
        },
        c.cmd.padEnd(10)
      ),
      h(Text, { color: 'gray' }, `  ${c.desc}`)
    )
  );

  return h(
    Box,
    { flexDirection: 'column', height: termHeight },
    h(
      Box,
      { borderStyle: 'single', borderColor: 'gray', paddingX: 1 },
      h(Text, { color: 'cyan', bold: true }, `串口监控  ${portName}`),
      h(Text, { color: 'gray' }, `  │  ${baudRate} baud`)
    ),
    h(
      Box,
      {
        flexDirection: 'column',
        height: logHeight,
        borderStyle: 'single',
        borderColor: 'gray',
        overflow: 'hidden',
        paddingX: 1
      },
      ...logRows
    ),
    h(
      Box,
      { borderStyle: 'single', borderColor: 'cyan', paddingX: 1, height: 3 },
      h(Text, { color: 'green', bold: true }, `${portName}  [${mode}] ❯ `),
      h(Text, { color: 'white' }, input),
      h(Text, { color: 'white', bold: true }, '█')
    ),
    hints.length > 0
      ? h(
          Box,
          {
            flexDirection: 'column',
            borderStyle: 'single',
            borderColor: 'gray',
            paddingX: 1,
            height: hintHeight
          },
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
