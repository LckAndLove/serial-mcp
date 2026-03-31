# 贡献指南

感谢你对 serial-mcp 的关注！

## 提 Issue
- 描述问题时请附上操作系统、Node.js 版本、串口设备信息
- 如果是 bug，请附上复现步骤和错误日志（日志位于 `~/.serial-mcp/mcp.log`）
- 功能建议请说明使用场景

## 提 PR
1. Fork 本仓库
2. 创建功能分支：`git checkout -b feature/your-feature`
3. 安装各子包依赖：
   ```bash
   cd serial-db && npm install
   cd ../serial-mcp && npm install
   cd ../serial-virtual && npm install
   ```
4. 修改代码并运行测试：
   ```bash
   npm test
   ```
5. 提交：`git commit -m "描述你的改动"`
6. 推送并创建 PR

## 开发环境
- Node.js >= 22（推荐 Node.js 24 LTS）
- Windows / macOS / Linux
- 虚拟串口（无硬件调试用）：Windows 可用 ELTIMA VSP 或 com0com；macOS / Linux 可用 `socat`

## 本地测试
1. 启动虚拟设备与 listener：
   - Windows：运行 `start-all.bat`
   - macOS / Linux：运行 `./start-all.sh`
2. 启动 MCP Server：`npm start`（或 `cd serial-mcp && node server.js`）
3. 运行自动化测试：`npm test`

## 代码风格
- `serial-mcp/` 使用 ES Module（`import` / `export`）；`serial-db/` 与 `serial-virtual/` 使用 CommonJS（`require`）
- 中文注释
- 错误信息统一用中文
