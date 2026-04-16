const { SerialPort } = require('serialport');
const fs = require('fs');
const path = require('path');

// 格式化当前时间为 [YYYY-MM-DD HH:mm:ss]
function getTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  return `[${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}]`;
}

// 从 config.json 读取配置
function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  return {
    port: config.virtualPort.portB,
    baudRate: config.virtualPort.baudRate || 115200
  };
}

const { port: portPath, baudRate } = loadConfig();

// 连接虚拟串口（portB = COM44）
const port = new SerialPort({
  path: portPath,
  baudRate: baudRate,
  autoOpen: true
});

// 串口打开成功提示
port.on('open', () => {
  console.log(`${getTimestamp()} 已连接到 ${portPath}，开始监听数据...`);
});

// 打印所有收到的数据，带时间戳前缀
port.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  process.stdout.write(`${getTimestamp()} ${text}`);
});

// 错误处理，便于排查串口占用或端口不存在等问题
port.on('error', (err) => {
  console.error(`${getTimestamp()} 串口错误: ${err.message}`);
});

// 串口关闭提示
port.on('close', () => {
  console.log(`${getTimestamp()} 串口已关闭`);
});
