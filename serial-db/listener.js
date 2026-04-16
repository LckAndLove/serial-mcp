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

  // 端口参数按需求默认 COM3 / 115200，且支持从配置覆盖
  const portName = serialCfg.port || 'COM3';
  const baudRate = Number(serialCfg.baudRate || 115200);
  const delimiter = serialCfg.delimiter || '\r\n';
  const cleanupInterval = Number(dbCfg.cleanupInterval || 60000);
  const dbPath = dbCfg.path || './serial.db';
  const maxRows = Number(dbCfg.maxRows || 10000);

  // 实例化数据库
  const serialDb = new SerialDB(dbPath);

  // 启动时自动创建新 session，并打印 session_id
  const sessionId = serialDb.newSession();
  console.log(`current session_id: ${sessionId}`);

  // 建立串口连接
  const port = new SerialPort({ path: portName, baudRate });

  port.on('open', () => {
    console.log(`[${formatTimestamp()}] 串口已连接: ${portName} @ ${baudRate}`);
  });

  port.on('error', (err) => {
    console.error(`[${formatTimestamp()}] 串口错误:`, err.message || err);
  });

  // HTTP 服务：转发指令到串口
  const HTTP_PORT = 7070;
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
          const { data, encoding = 'text' } = JSON.parse(body);
          if (!data) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'data is required' }));
            return;
          }

          // 写入串口
          const payload = encoding === 'hex'
            ? Buffer.from(data.replace(/0x/gi, ''), 'hex')
            : Buffer.from(data, 'utf8');

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
                  session_id: sessionId
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

    // GET /status
    if (req.method === 'GET' && url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        port: portName,
        baudRate,
        isOpen: port.isOpen,
        sessionId
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  httpServer.listen(HTTP_PORT, () => {
    console.log(`[${formatTimestamp()}] HTTP 服务已启动: http://localhost:${HTTP_PORT}`);
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
          session_id: sessionId
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
