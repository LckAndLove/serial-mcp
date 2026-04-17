import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { SerialPort } from 'serialport';
import SerialDB from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(os.homedir(), '.serial-mcp');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'serial.db');
const LOCK_FILE = path.join(DATA_DIR, 'listener.lock');
const READY_FILE = path.join(DATA_DIR, 'listener.ready');

let config = {};
try {
  const configPath = fileURLToPath(new URL('../config.json', import.meta.url));
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch {
  // 使用默认配置
}

// 统一格式化日志时间戳：[YYYY-MM-DD HH:mm:ss]
function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function logInfo(message) {
  process.stdout.write(`${message}\n`);
}

function readJsonBody(req, res) {
  return new Promise((resolve, reject) => {
    const MAX_BODY_SIZE = 1024 * 1024;
    let body = '';
    let settled = false;

    const doneResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const doneReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_SIZE) {
        req.pause();
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request too large' }));
        doneResolve(null);
      }
    });

    req.on('end', () => {
      if (settled) return;
      try {
        doneResolve(JSON.parse(body || '{}'));
      } catch (err) {
        doneReject(err);
      }
    });

    req.on('error', doneReject);
  });
}

function sendJson(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function main() {
  const serialCfg = config.serial || {};
  const dbCfg = config.db || {};

  const delimiter = serialCfg.delimiter || '\r\n';
  const baudRate = Number(serialCfg.baudRate || 115200);
  const idleFrameMs = Number(serialCfg.idleFrameMs ?? 30);
  const CLEANUP_INTERVAL = Number(dbCfg.cleanupInterval || 60000);
  const MAX_ROWS = Number(dbCfg.maxRows || 10000);
  const HTTP_PORT = Number(config?.http?.port || 7070);

  fs.writeFileSync(LOCK_FILE, String(process.pid));
  try {
    fs.unlinkSync(READY_FILE);
  } catch {}
  const cleanupLock = () => {
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {}
  };
  const cleanupReady = () => {
    try {
      fs.unlinkSync(READY_FILE);
    } catch {}
  };
  process.on('exit', cleanupLock);
  process.on('exit', cleanupReady);
  process.on('SIGINT', () => {
    cleanupLock();
    cleanupReady();
    process.exit();
  });
  process.on('SIGTERM', () => {
    cleanupLock();
    cleanupReady();
    process.exit();
  });

  const serialDb = new SerialDB(DB_PATH);

  // key: portName, value: { port: SerialPort, sessionId, baudRate, rxBuffer, ...handlers }
  const connectedPorts = new Map();
  const delimiterBuffer = Buffer.from(delimiter, 'utf8');
  const useDelimiter = delimiterBuffer.length > 0;
  const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

  function formatHex(buffer) {
    return `[HEX] ${buffer.toString('hex').toUpperCase().match(/.{1,2}/g).join(' ')}`;
  }

  function decodeFrame(buffer) {
    if (!buffer.length) return '';

    try {
      const decoded = utf8Decoder.decode(buffer);
      if (decoded.includes('\uFFFD')) {
        return formatHex(buffer);
      }
      return decoded;
    } catch {
      return formatHex(buffer);
    }
  }

  function getStatus() {
    const ports = [...connectedPorts.entries()].map(([portName, state]) => ({
      port: portName,
      baudRate: state.baudRate,
      sessionId: state.sessionId,
    }));

    return {
      connected: ports.length > 0,
      ports,
    };
  }

  async function closePortState(portName) {
    const state = connectedPorts.get(portName);
    if (!state) return false;

    const serialPort = state.port;
    flushPendingRxFrame(portName, state);

    if (state.dataHandler) serialPort.off('data', state.dataHandler);
    if (state.errorHandler) serialPort.off('error', state.errorHandler);
    if (state.closeHandler) serialPort.off('close', state.closeHandler);

    connectedPorts.delete(portName);

    if (serialPort.isOpen) {
      await new Promise((resolve, reject) => {
        serialPort.close((err) => (err ? reject(err) : resolve()));
      });
    }

    return true;
  }

  function clearRxFlushTimer(state) {
    if (state.rxFlushTimer) {
      clearTimeout(state.rxFlushTimer);
      state.rxFlushTimer = null;
    }
  }

  function insertRxRow(portName, state, frame) {
    const text = decodeFrame(frame);
    logInfo(`[${formatTimestamp()}] [${portName}] ${text}`);

    try {
      serialDb.insertRow({
        port: portName,
        timestamp: Date.now(),
        direction: 'rx',
        raw: frame,
        text,
        session_id: state.sessionId,
      });
    } catch (err) {
      console.error(`[${formatTimestamp()}] [${portName}] 写库失败:`, err.message || err);
    }
  }

  function flushPendingRxFrame(portName, state) {
    clearRxFlushTimer(state);

    if (!state.rxBuffer || state.rxBuffer.length === 0) {
      return;
    }

    const frame = state.rxBuffer;
    state.rxBuffer = Buffer.alloc(0);
    insertRxRow(portName, state, frame);
  }

  function scheduleRxFlush(portName, state) {
    clearRxFlushTimer(state);
    if (!Number.isFinite(idleFrameMs) || idleFrameMs <= 0) {
      return;
    }
    if (!state.rxBuffer || state.rxBuffer.length === 0) {
      return;
    }

    state.rxFlushTimer = setTimeout(() => {
      state.rxFlushTimer = null;
      flushPendingRxFrame(portName, state);
    }, idleFrameMs);
  }

  function attachHandlers(portName, state) {
    const serialPort = state.port;

    state.dataHandler = (chunk) => {
      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      state.rxBuffer = Buffer.concat([state.rxBuffer, chunkBuffer]);

      if (useDelimiter) {
        let idx;
        while ((idx = state.rxBuffer.indexOf(delimiterBuffer)) !== -1) {
          const frame = state.rxBuffer.slice(0, idx);
          state.rxBuffer = state.rxBuffer.slice(idx + delimiterBuffer.length);
          insertRxRow(portName, state, frame);
        }
      }

      scheduleRxFlush(portName, state);
    };

    state.errorHandler = (err) => {
      console.error(`[${formatTimestamp()}] [${portName}] 串口错误:`, err.message || err);
    };

    state.closeHandler = () => {
      flushPendingRxFrame(portName, state);
      const current = connectedPorts.get(portName);
      if (current && current.port === serialPort) {
        connectedPorts.delete(portName);
      }
      logInfo(`[${formatTimestamp()}] [${portName}] 串口已断开`);
    };

    serialPort.on('data', state.dataHandler);
    serialPort.on('error', state.errorHandler);
    serialPort.on('close', state.closeHandler);
  }

  async function connectPort(options) {
    const portName = typeof options.port === 'string' ? options.port.trim() : '';
    if (!portName) {
      throw new Error('port is required');
    }

    const baudRate = Number(options.baudRate || serialCfg.baudRate || 115200);
    const dataBits = Number(options.dataBits || 8);
    const stopBits = Number(options.stopBits || 1);
    const parity = typeof options.parity === 'string' ? options.parity : 'none';

    if (![5, 6, 7, 8].includes(dataBits)) {
      throw new Error('dataBits 必须是 5/6/7/8');
    }
    if (![1, 1.5, 2].includes(stopBits)) {
      throw new Error('stopBits 必须是 1/1.5/2');
    }
    if (!['none', 'even', 'odd', 'mark', 'space'].includes(parity)) {
      throw new Error('parity 必须是 none/even/odd/mark/space');
    }

    const serialPort = new SerialPort({
      path: portName,
      baudRate,
      dataBits,
      stopBits,
      parity,
      autoOpen: false,
    });

    await new Promise((resolve, reject) => {
      serialPort.open((err) => (err ? reject(err) : resolve()));
    });

    if (connectedPorts.has(portName)) {
      await closePortState(portName);
    }

    const state = {
      port: serialPort,
      sessionId: serialDb.newSession(),
      baudRate,
      dataBits,
      stopBits,
      parity,
      rxBuffer: Buffer.alloc(0),
      rxFlushTimer: null,
      dataHandler: null,
      errorHandler: null,
      closeHandler: null,
    };

    attachHandlers(portName, state);
    connectedPorts.set(portName, state);

    logInfo(`[${formatTimestamp()}] 串口已连接: ${portName} @ ${baudRate}, session: ${state.sessionId}`);

    return {
      success: true,
      port: portName,
      baudRate,
      sessionId: state.sessionId,
    };
  }

  const httpServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);

    try {
      // POST /connect
      if (req.method === 'POST' && url.pathname === '/connect') {
        const payload = await readJsonBody(req, res);
        if (payload === null) return;
        const result = await connectPort(payload);
        sendJson(res, 200, result);
        return;
      }

      // POST /disconnect { port }
      if (req.method === 'POST' && url.pathname === '/disconnect') {
        const payload = await readJsonBody(req, res);
        if (payload === null) return;

        const portName = typeof payload.port === 'string' ? payload.port.trim() : '';
        if (!portName) {
          sendJson(res, 400, { success: false, error: 'port is required' });
          return;
        }

        const existed = await closePortState(portName);
        if (!existed) {
          sendJson(res, 404, { success: false, error: '端口未连接' });
          return;
        }

        sendJson(res, 200, { success: true, port: portName });
        return;
      }

      // POST /send { port, data, encoding, session_id }
      if (req.method === 'POST' && url.pathname === '/send') {
        const payload = await readJsonBody(req, res);
        if (payload === null) return;

        const portName = typeof payload.port === 'string' ? payload.port.trim() : '';
        const data = payload.data;
        const encoding = typeof payload.encoding === 'string' ? payload.encoding : 'text';
        const sessionIdInput = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';

        if (!portName) {
          sendJson(res, 400, { success: false, error: 'port is required' });
          return;
        }
        if (!data) {
          sendJson(res, 400, { success: false, error: 'data is required' });
          return;
        }

        const state = connectedPorts.get(portName);
        if (!state || !state.port?.isOpen) {
          sendJson(res, 404, { success: false, error: '端口未连接' });
          return;
        }

        const escaped = String(data).replace(/\\r/g, '\r').replace(/\\n/g, '\n');
        const effectiveSessionId = sessionIdInput || state.sessionId;

        const serialPayload = encoding === 'hex'
          ? Buffer.from(escaped.replace(/0x/gi, ''), 'hex')
          : Buffer.from(escaped, 'utf8');

        state.port.write(serialPayload, (err) => {
          if (err) {
            sendJson(res, 500, { success: false, error: err.message });
            return;
          }

          state.port.drain(() => {
            try {
              serialDb.insertRow({
                port: portName,
                timestamp: Date.now(),
                direction: 'tx',
                raw: serialPayload,
                text: serialPayload.toString('utf8'),
                session_id: effectiveSessionId,
              });
            } catch (dbErr) {
              console.error(`[${formatTimestamp()}] [${portName}] HTTP /send 写库失败:`, dbErr.message || dbErr);
            }

            sendJson(res, 200, { success: true, bytesSent: serialPayload.length, port: portName });
          });
        });

        return;
      }

      // POST /session { port, session_id }
      if (req.method === 'POST' && url.pathname === '/session') {
        const payload = await readJsonBody(req, res);
        if (payload === null) return;

        const portName = typeof payload.port === 'string' ? payload.port.trim() : '';
        const nextSessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';

        if (!portName) {
          sendJson(res, 400, { success: false, error: 'port is required' });
          return;
        }

        if (!nextSessionId) {
          sendJson(res, 400, { success: false, error: 'session_id is required' });
          return;
        }

        const state = connectedPorts.get(portName);
        if (!state) {
          sendJson(res, 404, { success: false, error: '端口未连接' });
          return;
        }

        state.sessionId = nextSessionId;
        logInfo(`[${formatTimestamp()}] [${portName}] session 切换: ${state.sessionId}`);
        sendJson(res, 200, { success: true, port: portName, session_id: state.sessionId });
        return;
      }

      // GET /status
      if (req.method === 'GET' && url.pathname === '/status') {
        sendJson(res, 200, getStatus());
        return;
      }

      sendJson(res, 404, { error: 'Not Found' });
    } catch (err) {
      sendJson(res, 400, { error: err.message || String(err) });
    }
  });

  httpServer.on('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      console.error(`[${formatTimestamp()}] HTTP 端口 ${HTTP_PORT} 已被占用，请先停止已有 listener 进程`);
    } else {
      console.error(`[${formatTimestamp()}] HTTP 服务启动失败:`, err.message || err);
    }
    process.exit(1);
  });

  httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
    try {
      fs.writeFileSync(READY_FILE, String(Date.now()));
    } catch {}
    logInfo(`[${formatTimestamp()}] HTTP 服务已启动: http://127.0.0.1:${HTTP_PORT}，等待连接串口...`);
  });

  setInterval(() => {
    try {
      const deleted = serialDb.cleanup(MAX_ROWS);
      if (deleted > 0) {
        logInfo(`[${formatTimestamp()}] cleanup 删除 ${deleted} 条旧数据`);
      }
    } catch (err) {
      console.error(`[${formatTimestamp()}] cleanup 执行失败:`, err.message || err);
    }
  }, CLEANUP_INTERVAL);
}

main().catch((err) => {
  console.error(`[${formatTimestamp()}] listener 启动失败:`, err.message || err);
  process.exit(1);
});
