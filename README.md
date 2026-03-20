# Serial MCP Server

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows-blue)
![License](https://img.shields.io/badge/license-MIT-green)

嵌入式 AI 调试串口 MCP 服务，让 Claude Code / Codex CLI 等 AI 工具能够直接读写串口数据，实现编码→烧录→调试的完整闭环。

## 功能状态

| 功能 | 状态 |
|------|------|
| 串口连接/断开 | ✅ 稳定 |
| 数据收发 | ✅ 稳定 |
| SQLite 数据持久化 | ✅ 稳定 |
| 多串口并发 | ✅ 稳定 |
| 设备自动检测 | ✅ 稳定 |
| 监控窗口 TUI | ✅ 稳定 |
| 定时发送 | ✅ 稳定 |
| Modbus RTU | 🚧 开发中 |
| Web 监控面板 | 🚧 规划中 |

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
└── docs/               项目文档
```

## 依赖

- Node.js v18+
- Windows 系统
- 虚拟串口驱动（开发调试用）：[ELTIMA VSP](https://www.eltima.com/products/vspdxp/) 或 [com0com](https://com0com.sourceforge.net)

## 安装

### Windows

#### Claude Code（用户级别，所有项目可用）
```bash
claude mcp add -s user serial -- cmd /c npx -y serial-mcp
```

#### Codex CLI
```bash
codex mcp add serial -- npx -y serial-mcp
```

### Mac/Linux

#### Claude Code
```bash
claude mcp add -s user serial -- npx -y serial-mcp
```

#### Codex CLI
```bash
codex mcp add serial -- npx -y serial-mcp
```

### 验证是否安装成功
```bash
# Claude Code
claude mcp list

# Codex CLI  
codex mcp list
```

看到 serial 状态为 connected 即成功。

### 卸载
```bash
# Claude Code
claude mcp remove -s user serial

# Codex CLI
codex mcp remove serial
```

## 使用方式
连接好设备后，直接告诉 AI：
"我的设备接在 COM5，波特率 115200，帮我连接并开始调试"

AI 会自动完成连接，无需任何额外配置。

## MCP 工具列表

| 工具 | 说明 |
|------|------|
| `list_ports` | 扫描可用串口 |
| `connect_port` | 连接指定串口并创建新会话 |
| `disconnect_port` | 断开当前串口 |
| `send_data` | 发送数据 |
| `read_latest` | 读取最新 N 条数据 |
| `read_since` | 读取指定时间后的数据 |
| `send_and_wait` | 发送指令并等待响应 |
| `new_session` | 创建新会话（烧录后调用） |
| `get_status` | 获取当前串口状态 |

## 真实硬件接入

1. 连接好真实设备到电脑
2. 在 AI 中执行串口扫描并连接目标端口
3. 直接开始发送/接收调试数据

无需手动修改任何配置文件，AI 调试方式完全一致。

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

