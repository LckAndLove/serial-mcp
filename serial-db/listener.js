const fs = require('fs');
const path = require('path');
const http = require('http');
const { SerialPort } = require('serialport');

// 读取同目录配置文件
const configPath = path.join(__dirname, 'config.json');
const rawConfig = fs.readFileSync(configPath, 'utf8');
const config = JSON.parse(rawConfig);

// 加载数据库模块（SerialDB 类）
const SerialDB = require('./db');

// 统一格式化日志时间戳：[YYYY-MM-DD HH:mm:ss]
function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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
  const httpCfg = config.http || {};

  const delimiter = serialCfg.delimiter || '\r\n';
  const cleanupInterval = Number(dbCfg.cleanupInterval || 60000);
  const dbPath = dbCfg.path || './serial.db';
  const maxRows = Number(dbCfg.maxRows || 10000);
  const HTTP_PORT = Number(httpCfg.port);

  if (!Number.isInteger(HTTP_PORT) || HTTP_PORT <= 0) {
    console.error(`[${formatTimestamp()}] 配置错误: config.json 缺少有效的 http.port`);
    process.exit(1);
    return;
  }

  // 实例化数据库
  const serialDb = new SerialDB(dbPath);

  let activeSessionId = serialDb.newSession();
  let serialPort = null;
  let currentPort = null;
  let currentBaudRate = null;
  let dataHandler = null;
  let errorHandler = null;
  let closeHandler = null;
  let buffer = '';

  function isConnected() {
    return Boolean(serialPort?.isOpen);
  }

  function detachPortHandlers() {
    if (!serialPort) return;
    if (dataHandler) serialPort.off('data', dataHandler);
    if (errorHandler) serialPort.off('error', errorHandler);
    if (closeHandler) serialPort.off('close', closeHandler);
    dataHandler = null;
    errorHandler = null;
    closeHandler = null;
  }

  async function disconnectCurrentPort() {
    if (!serialPort) {
      currentPort = null;
      currentBaudRate = null;
      return;
    }

    const target = serialPort;
    detachPortHandlers();

    if (target.isOpen) {
      await new Promise((resolve, reject) => {
        target.close((err) => (err ? reject(err) : resolve()));
      });
    }

    serialPort = null;
    currentPort = null;
    currentBaudRate = null;
    buffer = '';
  }

  function installPortHandlers(portName) {
    dataHandler = (chunk) => {
      buffer += chunk.toString('utf8');

      const parts = buffer.split(delimiter);
      buffer = parts.pop() || '';

      for (const item of parts) {
        const raw = item;
        const ts = formatTimestamp();
        console.log(`[${ts}] ${raw}`);

        try {
          serialDb.insertRow({
            port: portName,
            timestamp: Date.now(),
            direction: 'rx',
            raw: Buffer.from(raw, 'utf8'),
            text: raw,
            session_id: activeSessionId,
          });
        } catch (err) {
          console.error(`[${formatTimestamp()}] 写库失败:`, err.message || err);
        }
      }
    };

    errorHandler = (err) => {
      console.error(`[${formatTimestamp()}] 串口错误:`, err.message || err);
    };

    closeHandler = () => {
      if (serialPort) {
        console.log(`[${formatTimestamp()}] 串口已断开: ${currentPort || portName}`);
      }
      serialPort = null;
      currentPort = null;
      currentBaudRate = null;
      buffer = '';
    };

    serialPort.on('data', dataHandler);
    serialPort.on('error', errorHandler);
    serialPort.on('close', closeHandler);
  }

  async function connectPort(options) {
    const port = typeof options.port === 'string' ? options.port.trim() : '';
    if (!port) {
      throw new Error('port is required');
    }

    const baudRate = Number(options.baudRate || 115200);
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

    if (isConnected()) {
      await disconnectCurrentPort();
    }

    const nextPort = new SerialPort({
      path: port,
      baudRate,
      dataBits,
      stopBits,
      parity,
      autoOpen: false,
    });

    await new Promise((resolve, reject) => {
      nextPort.open((err) => (err ? reject(err) : resolve()));
    });

    serialPort = nextPort;
    currentPort = port;
    currentBaudRate = baudRate;
    activeSessionId = serialDb.newSession();
    buffer = '';

    installPortHandlers(port);
    console.log(`[${formatTimestamp()}] 串口已连接: ${port} @ ${baudRate}, session: ${activeSessionId}`);

    return {
      success: true,
      port,
      baudRate,
      sessionId: activeSessionId,
    };
  }

  // HTTP 服务：转发指令到串口
  const httpServer = http.createServer(async (req, res) => {
    // CORS 头
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

      // POST /disconnect
      if (req.method === 'POST' && url.pathname === '/disconnect') {
        await disconnectCurrentPort();
        sendJson(res, 200, { success: true });
        return;
      }

      // POST /send
      if (req.method === 'POST' && url.pathname === '/send') {
        if (!isConnected()) {
          sendJson(res, 409, { error: 'serial port is not connected' });
          return;
        }

        const requestBody = await readJsonBody(req, res);
        if (requestBody === null) return;
        const { data, encoding = 'text', session_id } = requestBody;
        if (!data) {
          sendJson(res, 400, { error: 'data is required' });
          return;
        }

        const escaped = data.replace(/\\r/g, '\r').replace(/\\n/g, '\n');
        const effectiveSessionId =
          typeof session_id === 'string' && session_id.trim()
            ? session_id.trim()
            : activeSessionId;

        const serialPayload = encoding === 'hex'
          ? Buffer.from(escaped.replace(/0x/gi, ''), 'hex')
          : Buffer.from(escaped, 'utf8');

        serialPort.write(serialPayload, (err) => {
          if (err) {
            sendJson(res, 500, { error: err.message });
            return;
          }

          serialPort.drain(() => {
            try {
                serialDb.insertRow({
                  port: currentPort,
                  timestamp: Date.now(),
                  direction: 'tx',
                  raw: serialPayload,
                  text: serialPayload.toString('utf8'),
                  session_id: effectiveSessionId,
                });
            } catch (dbErr) {
              console.error(`[${formatTimestamp()}] HTTP /send 写库失败:`, dbErr.message || dbErr);
            }

            sendJson(res, 200, { success: true, bytesSent: serialPayload.length });
          });
        });
        return;
      }

      // POST /session
      if (req.method === 'POST' && url.pathname === '/session') {
        const payload = await readJsonBody(req, res);
        if (payload === null) return;
        const nextSessionId =
          typeof payload.session_id === 'string' ? payload.session_id.trim() : '';

        if (!nextSessionId) {
          sendJson(res, 400, { error: 'session_id is required' });
          return;
        }

        activeSessionId = nextSessionId;
        console.log(`[${formatTimestamp()}] session 切换: ${activeSessionId}`);
        sendJson(res, 200, { success: true, session_id: activeSessionId });
        return;
      }

      // GET /status
      if (req.method === 'GET' && url.pathname === '/status') {
        sendJson(res, 200, {
          connected: isConnected(),
          port: currentPort,
          baudRate: currentBaudRate,
          sessionId: activeSessionId,
        });
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
    console.log(`[${formatTimestamp()}] HTTP 服务已启动: http://127.0.0.1:${HTTP_PORT}，等待连接串口...`);
  });

  // 定时执行 cleanup()
  setInterval(() => {
    try {
      const deleted = serialDb.cleanup(maxRows);
      if (deleted > 0) {
        console.log(`[${formatTimestamp()}] cleanup 删除 ${deleted} 条旧数据`);
      }
    } catch (err) {
      console.error(`[${formatTimestamp()}] cleanup 执行失败:`, err.message || err);
    }
  }, cleanupInterval);
}

main().catch((err) => {
  console.error(`[${formatTimestamp()}] listener 启动失败:`, err.message || err);
  process.exit(1);
});
