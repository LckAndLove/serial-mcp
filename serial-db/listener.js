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

async function main() {
  const serialCfg = config.serial || {};
  const dbCfg = config.db || {};
  const httpCfg = config.http || {};

  const configuredPort = typeof serialCfg.port === 'string' ? serialCfg.port.trim() : '';
  if (!configuredPort) {
    console.error(`[${formatTimestamp()}] 配置错误: config.json 缺少 serial.port`);
    process.exit(1);
    return;
  }

  // 串口参数从配置读取，未配置波特率时使用默认值
  const portName = configuredPort;
  const baudRate = Number(serialCfg.baudRate || 115200);
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

  // 当前活动会话，支持通过 HTTP /session 动态切换
  let activeSessionId = serialDb.newSession();
  console.log(`current session_id: ${activeSessionId}`);

  // 建立串口连接
  const port = new SerialPort({ path: portName, baudRate });

  port.on('open', () => {
    console.log(`[${formatTimestamp()}] 串口已连接: ${portName} @ ${baudRate}`);
  });

  port.on('error', (err) => {
    console.error(`[${formatTimestamp()}] 串口错误:`, err.message || err);
  });

  // HTTP 服务：转发指令到串口
  const httpServer = http.createServer((req, res) => {
    // CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);

    // POST /send
    if (req.method === 'POST' && url.pathname === '/send') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { data, encoding = 'text', session_id } = JSON.parse(body);
          if (!data) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'data is required' }));
            return;
          }

          // 转义 \r\n 为真实回车换行符
          const escaped = data.replace(/\\r/g, '\r').replace(/\\n/g, '\n');

          const effectiveSessionId =
            typeof session_id === 'string' && session_id.trim()
              ? session_id.trim()
              : activeSessionId;

          // 写入串口
          const payload = encoding === 'hex'
            ? Buffer.from(escaped.replace(/0x/gi, ''), 'hex')
            : Buffer.from(escaped, 'utf8');

          port.write(payload, (err) => {
            if (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
              return;
            }

            port.drain(() => {
              // 写入数据库 direction=tx
              try {
                serialDb.insertRow({
                  port: portName,
                  timestamp: Date.now(),
                  direction: 'tx',
                  raw: payload,
                  text: payload.toString('utf8'),
                  session_id: effectiveSessionId
                });
              } catch (dbErr) {
                console.error(`[${formatTimestamp()}] HTTP /send 写库失败:`, dbErr.message);
              }

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, bytesSent: payload.length }));
            });
          });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // POST /session
    if (req.method === 'POST' && url.pathname === '/session') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          const nextSessionId =
            typeof payload.session_id === 'string' ? payload.session_id.trim() : '';

          if (!nextSessionId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'session_id is required' }));
            return;
          }

          activeSessionId = nextSessionId;
          console.log(`[${formatTimestamp()}] session 切换: ${activeSessionId}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, session_id: activeSessionId }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message || String(err) }));
        }
      });
      return;
    }

    // GET /status
    if (req.method === 'GET' && url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        port: portName,
        baudRate,
        isOpen: port.isOpen,
        sessionId: activeSessionId
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
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
    console.log(`[${formatTimestamp()}] HTTP 服务已启动: http://127.0.0.1:${HTTP_PORT}`);
  });

  // 使用 \r\n 分隔解析数据（按配置可覆盖）
  let buffer = '';
  port.on('data', (chunk) => {
    buffer += chunk.toString('utf8');

    const parts = buffer.split(delimiter);
    buffer = parts.pop() || '';

    for (const item of parts) {
      const raw = item;
      const ts = formatTimestamp();

      // 控制台打印收到的数据，带时间戳前缀
      console.log(`[${ts}] ${raw}`);

      // 所有接收数据写入 SQLite，direction=rx
      try {
        serialDb.insertRow({
          port: portName,
          timestamp: Date.now(),
          direction: 'rx',
          raw: Buffer.from(raw, 'utf8'),
          text: raw,
          session_id: activeSessionId
        });
      } catch (err) {
        console.error(`[${formatTimestamp()}] 写库失败:`, err.message || err);
      }
    }
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
