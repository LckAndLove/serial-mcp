# Serial MCP Server

嵌入式 AI 调试串口 MCP 服务，让 Claude Code / Codex CLI 等 AI 工具能够直接读写串口数据。

## 功能
- 实时接收串口数据，持久化到 SQLite
- AI 主动查询历史数据
- AI 发送指令并等待响应
- 支持多种响应边界模式（timeout / delimiter / length）
- 虚拟串口模拟器，无需真实硬件即可开发调试

## 项目结构
- serial-virtual/   虚拟单片机模拟器
- serial-db/        串口监听 + SQLite 数据池 + HTTP 转发服务
- serial-mcp/       MCP Server
- start-all.bat     一键启动
- stop-all.bat      一键停止

## 依赖
- Node.js v18+
- Windows 系统
- ELTIMA Virtual Serial Port 或其他虚拟串口驱动（开发调试用）

## 快速开始

### 1. 安装依赖
```bash
cd serial-virtual && npm install
cd ../serial-db && npm install
cd ../serial-mcp && npm install
```

### 2. 配置虚拟串口
使用 ELTIMA VSP 或 com0com 创建一对虚拟串口，
默认配置：COM2（模拟单片机）↔ COM3（MCP服务端）
如需修改，编辑各项目下的 config.json

### 3. 启动服务
双击 start-all.bat

### 4. 配置 Claude Code
项目根目录已包含 .mcp.json，重启 Claude Code 即可自动连接。

### 5. 配置 Codex CLI
```bash
codex mcp add serial -- node "项目路径\serial-mcp\server.js"
```

## MCP 工具列表
- list_ports        扫描可用串口
- open_port         打开串口
- close_port        关闭串口
- send_data         发送数据
- read_latest       读取最新 N 条数据
- read_since        读取指定时间后的数据
- send_and_wait     发送指令并等待响应
- new_session       创建新会话（烧录后调用）
- get_status        获取当前串口状态

## 真实硬件接入
把 serial-virtual/config.json 的 portA 改为你的单片机串口号，
把 serial-db/config.json 的 port 改为对应的接收端口，
停止运行 serial-virtual，直接用真实硬件即可。
