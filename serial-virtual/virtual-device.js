const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
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

// 检测 Windows 下 com0com 是否已安装
function isCom0comInstalled() {
  const checks = [
    // 常见注册表位置（64 位）
    'reg query "HKLM\\SOFTWARE\\com0com"',
    // 常见注册表位置（32 位兼容）
    'reg query "HKLM\\SOFTWARE\\WOW6432Node\\com0com"',
    // 若 setupc 在 PATH 中，也可视为已安装
    'where setupc.exe',
  ];

  for (const cmd of checks) {
    try {
      execSync(cmd, { stdio: 'ignore' });
      return true;
    } catch (err) {
      // 单项检查失败继续下一项
    }
  }

  // 再尝试检测默认安装目录
  const commonPaths = [
    'C:\\Program Files\\com0com\\setupc.exe',
    'C:\\Program Files (x86)\\com0com\\setupc.exe',
  ];

  return commonPaths.some((filePath) => fs.existsSync(filePath));
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

function main() {
  // 1) 启动先检查 com0com
  if (!isCom0comInstalled()) {
    console.error('未检测到 com0com，请先安装：https://com0com.sourceforge.net');
    process.exit(1);
  }

  const { portA, baudRate, autoOutputInterval } = loadConfig();

  // 2) 根据 config.json 连接 portA（当前配置应为 COM55）
  const port = new SerialPort({
    path: portA,
    baudRate,
    autoOpen: false,
  });

  const writeLine = createSerialWriter(port);

  // 用于按 \r\n 组包解析指令
  let inputBuffer = '';

  port.on('open', () => {
    logWithTimestamp(`虚拟设备已连接 ${portA}，波特率 ${baudRate}`);

    // 3) 每秒自动输出传感器数据（带时间戳）
    setInterval(() => {
      writeLine('SENSOR temp=25.3 humidity=60.1\r\n');
    }, autoOutputInterval);
  });

  // 4) 接收指令并返回对应响应
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
    logWithTimestamp(`串口错误: ${err.message}`);
  });

  port.open((err) => {
    if (err) {
      console.error(`${getTimestamp()} 打开串口 ${portA} 失败: ${err.message}`);
      process.exit(1);
    }
  });
}

try {
  main();
} catch (err) {
  console.error(`${getTimestamp()} 启动失败: ${err.message}`);
  process.exit(1);
}
