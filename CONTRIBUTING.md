# 贡献指南

感谢你对 serial-mcp 的关注！

## 提 Issue
- 描述问题时请附上操作系统、Node.js 版本、串口设备信息
- 如果是 bug，请附上复现步骤和错误日志
- 功能建议请说明使用场景

## 提 PR
1. Fork 本仓库
2. 创建功能分支：git checkout -b feature/your-feature
3. 安装依赖：
   cd serial-db && npm install
   cd ../serial-mcp && npm install
4. 修改代码并测试
5. 提交：git commit -m "描述你的改动"
6. 推送并创建 PR

## 开发环境
- Node.js >= 18
- Windows（串口功能依赖 Windows 驱动）
- 虚拟串口：ELTIMA VSP 或 com0com

## 本地测试
1. 双击 start-all.bat 启动虚拟设备
2. cd serial-mcp && node server.js
3. 在另一个终端测试 MCP 工具

## 代码风格
- ES Module（import/export）
- 中文注释
- 错误信息统一用中文
