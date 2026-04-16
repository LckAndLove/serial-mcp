const fs = require('fs');
const path = require('path');
const { SerialPort } = require('serialport');

// 生成统一格式时间戳：[YYYY-MM-DD HH:mm:ss]
function getTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');
  return `[${year}-${month}-${day} ${hour}:${minute}:${second}]`;
}

// 控制台日志统一带时间戳，方便排查串口交互
function logWithTimestamp(message) {
  console.log(`${getTimestamp()} ${message}`);
}

// 列出当前可用串口
async function listAvailablePorts() {
  try {
    const ports = await SerialPort.list();
    if (ports.length === 0) {
      console.log('未发现可用串口');
    } else {
      console.log('当前可用串口：');
      ports.forEach((p) => {
        console.log(`  - ${p.path} (${p.friendlyName || 'unknown'})`);
      });
    }
  } catch (err) {
    console.log('枚举串口失败:', err.message);
  }
}

// 从同目录读取配置
function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);

  if (!config.virtualPort || !config.virtualPort.portA) {
    throw new Error('config.json 缺少 virtualPort.portA 配置');
  }

  return {
    portA: config.virtualPort.portA,
    baudRate: config.virtualPort.baudRate || 115200,
    autoOutputInterval: config.virtualPort.autoOutputInterval || 1000,
  };
}

// 统一串口输出函数：所有输出都自动加时间戳前缀
function createSerialWriter(port) {
  return function writeLine(payload) {
    const line = `${getTimestamp()} ${payload}`;
    port.write(line, (err) => {
      if (err) {
        logWithTimestamp(`串口写入失败: ${err.message}`);
      }
    });
  };
}

async function main() {
  const { portA, baudRate, autoOutputInterval } = loadConfig();

  // 直接尝试打开串口，不再检测驱动
  const port = new SerialPort({
    path: portA,
    baudRate,
    autoOpen: false,
  });

  const writeLine = createSerialWriter(port);
  let inputBuffer = '';
  let timer = null;

  port.on('open', () => {
    logWithTimestamp(`虚拟设备已连接 ${portA}，波特率 ${baudRate}`);

    // 每秒自动输出传感器数据（带时间戳）
    timer = setInterval(() => {
      writeLine('SENSOR temp=25.3 humidity=60.1\r\n');
    }, autoOutputInterval);
  });

  // 接收指令并返回对应响应
  port.on('data', (chunk) => {
    inputBuffer += chunk.toString('utf8');

    let idx = inputBuffer.indexOf('\r\n');
    while (idx !== -1) {
      const cmd = inputBuffer.slice(0, idx).trim();
      inputBuffer = inputBuffer.slice(idx + 2);

      switch (cmd) {
        case 'GET_STATUS':
          writeLine('STATUS OK voltage=3.3v\r\n');
          break;
        case 'GET_TEMP':
          writeLine('TEMP 25.3\r\n');
          break;
        case 'RESET':
          writeLine('RESETTING...\r\n');
          writeLine('BOOT OK\r\n');
          break;
        default:
          if (cmd.length > 0) {
            writeLine('UNKNOWN CMD\r\n');
          }
          break;
      }

      idx = inputBuffer.indexOf('\r\n');
    }
  });

  port.on('error', (err) => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    logWithTimestamp(`串口错误: ${err.message}`);
  });

  port.on('close', () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });

  // 尝试打开串口，失败时列出可用串口
  try {
    await new Promise((resolve, reject) => {
      port.open((err) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    console.error(`${getTimestamp()} 打开串口 ${portA} 失败: ${err.message}`);
    await listAvailablePorts();
    process.exit(1);
  }
}

try {
  main();
} catch (err) {
  console.error(`${getTimestamp()} 启动失败: ${err.message}`);
  process.exit(1);
}
