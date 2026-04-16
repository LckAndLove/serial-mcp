# Serial MCP Server

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows-blue)
![License](https://img.shields.io/badge/license-MIT-green)

嵌入式 AI 调试串口 MCP 服务，让 Claude Code / Codex CLI 等 AI 工具能够直接读写串口数据，实现编码→烧录→调试的完整闭环。

## 架构

```
AI (Claude Code / Codex CLI)
        │ MCP Protocol
        ▼
┌─────────────────┐
│  serial-mcp     │  MCP Server (9 tools)
│  server.js      │
└────────┬────────┘
         │ HTTP POST localhost:7070
         ▼
┌─────────────────┐        ┌──────────────────┐
│  serial-db      │◄──────►│  SQLite          │
│  listener.js    │  读写   │  serial.db       │
└────────┬────────┘        └──────────────────┘
         │ UART COM3
         ▼
┌─────────────────┐
│  单片机 / 虚拟  │  COM2 ↔ COM3
│  serial-virtual │
└─────────────────┘
```

## 功能

- 实时接收串口数据，持久化到 SQLite
- AI 主动查询历史数据，按 session / 时间范围检索
- AI 发送指令并等待响应，120ms 内响应
- 支持多种响应边界模式（timeout / delimiter / length）
- 虚拟串口模拟器，无需真实硬件即可开发调试
- 一键启动/停止脚本

## 项目结构

```
serial-mcp/
├── serial-virtual/     虚拟单片机模拟器
├── serial-db/          串口监听 + SQLite 数据池 + HTTP 转发服务
├── serial-mcp/         MCP Server
├── start-all.bat       一键启动
├── stop-all.bat        一键停止
└── .mcp.json           Claude Code MCP 配置
```

## 依赖

- Node.js v18+
- Windows 系统
- 虚拟串口驱动（开发调试用）：[ELTIMA VSP](https://www.eltima.com/products/vspdxp/) 或 [com0com](https://com0com.sourceforge.net)

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/LckAndLove/serial-mcp.git
cd serial-mcp
```

### 2. 安装依赖

```bash
cd serial-virtual && npm install
cd ../serial-db && npm install
cd ../serial-mcp && npm install
```

### 3. 配置虚拟串口

使用 ELTIMA VSP 或 com0com 创建一对虚拟串口：
- COM2 — 模拟单片机端
- COM3 — MCP 服务端

如需修改端口号，编辑各项目下的 `config.json`。

### 4. 启动服务

双击 `start-all.bat`，会自动弹出两个窗口：
- 窗口1：虚拟单片机，每秒输出传感器数据
- 窗口2：串口监听 + HTTP 服务

### 5. 配置 Claude Code

安装 Claude Code：
```bash
npm install -g @anthropic-ai/claude-code
```

项目根目录已包含 `.mcp.json`，重启 Claude Code 自动连接。

手动添加：
```bash
claude mcp add serial -- node "项目路径\serial-mcp\server.js"
```

验证：
```bash
claude mcp list
# 看到 serial · ✔ connected 即成功
```

添加 MCP：
```bash
codex mcp add serial -- node "项目路径\serial-mcp\server.js"
```

验证：
```bash
codex mcp list
```

## MCP 工具列表

| 工具 | 说明 |
|------|------|
| `list_ports` | 扫描可用串口 |
| `open_port` | 打开串口 |
| `close_port` | 关闭串口 |
| `send_data` | 发送数据 |
| `read_latest` | 读取最新 N 条数据 |
| `read_since` | 读取指定时间后的数据 |
| `send_and_wait` | 发送指令并等待响应 |
| `new_session` | 创建新会话（烧录后调用） |
| `get_status` | 获取当前串口状态 |

## 真实硬件接入

1. 停止运行 `serial-virtual`
2. 把 `serial-db/config.json` 的 `port` 改为实际串口号
3. 重启 `serial-db`

无需修改 MCP Server，AI 调试方式完全一致。

## FAQ

**Q: 为什么 list_ports 看不到 COM2/COM3？**  
A: ELTIMA VSP 的虚拟端口不走标准 WMI 枚举，但实际通信正常，不影响使用。

**Q: 支持 Linux/Mac 吗？**  
A: 串口通信部分支持，但 start-all.bat 仅限 Windows，Linux/Mac 需手动启动各服务。

**Q: 数据库会无限增长吗？**  
A: 不会，超过 10000 条自动清理最老的数据，可在 `serial-db/config.json` 的 `maxRows` 调整。

**Q: 如何判断烧录前后的数据？**  
A: 烧录完成后调用 `new_session` 创建新会话，后续用 `session_id` 过滤数据即可。

## License

MIT
