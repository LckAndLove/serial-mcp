import { execSync } from 'child_process';
import fs from 'fs';

if (!fs.existsSync('dist')) fs.mkdirSync('dist');

console.log('打包 serial-mcp-server.exe ...');
execSync('npm run build:server', { stdio: 'inherit' });

console.log('打包 serial-monitor.exe ...');
execSync('npm run build:monitor', { stdio: 'inherit' });

fs.copyFileSync('serial-mcp/config.json', 'dist/config.json');

console.log('✅ 打包完成，输出目录：dist/');
console.log('文件列表：');
fs.readdirSync('dist').forEach((f) => console.log(' -', f));
