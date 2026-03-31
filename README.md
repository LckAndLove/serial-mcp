# Serial MCP Server

![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/license-MIT-green)

嵌入式 AI 调试串口 MCP 服务，让 Claude Code / Codex CLI 等 AI 工具能够直接读写串口数据，实现编码→烧录→调试的完整闭环。当前版本使用 MCP TypeScript SDK v2，并兼容 legacy MCP 客户端。

## 功能状态

| 功能 | 状态 |
|------|------|
| 串口连接/断开 | ✅ 稳定 |
| 数据收发 | ✅ 稳定 |
| SQLite 数据持久化 | ✅ 稳定 |
| 多串口并发 | ✅ 稳定 |
| 设备自动检测 | ✅ 稳定 |
| Modbus RTU | 🚧 开发中 |
| Web 监控面板 | 🚧 规划中 |

## 架构

```
AI (Claude Code / Codex CLI)
        │ MCP Protocol (stdio)
        ▼
┌─────────────────┐
│  serial-mcp     │  MCP Server (11 tools)
│  server.js      │
└────────┬────────┘
         │ HTTP (127.0.0.1:7070, Bearer Token)
         ▼
┌─────────────────┐        ┌──────────────────────────────┐
│  listener.js    │◄──────►│  SQLite (WAL + busy_timeout) │
│  (自动拉起)      │  读写   │  ~/.serial-mcp/serial.db     │
└────────┬────────┘        └──────────────────────────────┘
         │ UART (COMx / /dev/tty* / /dev/cu.*)
         ▼
┌─────────────────┐
│  单片机 / 虚拟  │  真实硬件或 serial-virtual
│  serial-virtual │
└─────────────────┘
```

## 核心能力

- 实时接收串口数据，持久化到 `~/.serial-mcp/serial.db`（WAL 模式 + 5000ms `busy_timeout`），超量自动清理
- AI 主动查询历史数据，支持按 `session_id`、时间范围与方向（`rx` / `tx` / `all`）检索
- AI 发送指令并等待响应，支持 `timeout` 与 `delimiter` 两种响应边界模式
- 多串口并发接管，按端口隔离会话（`session_id`）
- 新插入串口设备自动检测（`snapshot` → `detect`，可选自动连接）
- 虚拟串口模拟器，无需真实硬件即可本地开发调试
- Windows（`.bat`）与 macOS / Linux（`.sh`）一键启动/停止脚本

## 项目结构

```
serial-mcp/
├── serial-mcp/         npm 发布包（MCP Server + 内置 listener.js / db.js）
├── serial-db/          独立串口监听 + SQLite 数据池 + HTTP 转发服务
├── serial-virtual/     虚拟单片机模拟器（用于无硬件调试）
├── tests/              自动化测试套件（node:test）
├── start-all.bat       Windows 一键启动虚拟设备与 listener
├── stop-all.bat        Windows 一键停止
├── start-all.sh        macOS / Linux 一键启动虚拟设备与 listener
└── stop-all.sh         macOS / Linux 一键停止
```

## 系统要求

- Node.js >= 22（推荐 Node.js 24 LTS x64，兼容 Node.js 22 LTS）
- Windows / macOS / Linux
- 运行时使用 Node.js + npm，不再需要项目级 Visual Studio Build Tools 或 pkg 打包工具
- 虚拟串口驱动（仅无硬件开发调试用）：Windows 可用 [ELTIMA VSP](https://www.eltima.com/products/vspdxp/) 或 [com0com](https://com0com.sourceforge.net)，macOS / Linux 可用 `socat`

## 安装

### Windows

#### Claude Code（用户级别，所有项目可用）
```bash
claude mcp add -s user serial -- cmd /c npx -y serial-mcp@latest
```

#### Codex CLI
```bash
codex mcp add serial -- npx -y serial-mcp@latest
```

### macOS / Linux

#### Claude Code
```bash
claude mcp add -s user serial -- npx -y serial-mcp@latest
```

#### Codex CLI
```bash
codex mcp add serial -- npx -y serial-mcp@latest
```

### 验证安装
```bash
# Claude Code
claude mcp list

# Codex CLI
codex mcp list
```

看到 `serial` 状态为 connected 即成功。

### 卸载
```bash
# Claude Code
claude mcp remove -s user serial

# Codex CLI
codex mcp remove serial
```

## 使用方式

连接好设备后，直接告诉 AI：

> 我的设备接在 COM5，波特率 115200，帮我连接并开始调试

AI 会自动拉起后台 listener 并完成连接，无需任何额外配置。

## MCP 工具列表（11 个）

| 工具 | 说明 |
|------|------|
| `list_ports` | 扫描系统所有可用串口 |
| `connect_port` | 连接指定串口并自动创建新会话 |
| `disconnect_port` | 断开指定串口连接 |
| `list_connected` | 查看当前已连接的串口列表 |
| `detect_device` | 通过 `snapshot` / `detect` 识别新插入的串口设备（支持 `auto_connect`） |
| `get_status` | 获取当前 listener 串口连接状态 |
| `send_data` | 向指定串口发送数据（支持 `text` / `hex`，写入 `direction=tx`） |
| `send_and_wait` | 发送指令并等待响应（支持 `timeout` / `delimiter` 模式） |
| `read_latest` | 读取最新 N 条数据（默认 `rx`，支持按 `session_id` 和 `direction` 过滤） |
| `read_since` | 读取指定时间点后的数据（默认 `rx`，支持按 `session_id` 和 `direction` 过滤） |
| `new_session` | 创建新会话（烧录后调用，用于隔离前后数据） |

## 真实硬件接入

1. 连接好真实设备到电脑
2. 在 AI 中调用 `list_ports` 或 `detect_device` 识别目标端口并连接
3. 直接开始发送/接收调试数据

无需手动修改任何配置文件，AI 调试方式完全一致。

## FAQ

**Q: 为什么 `list_ports` 看不到 COM2/COM3？**

A: ELTIMA VSP 的虚拟端口不走标准 WMI 枚举，但实际通信正常，直接传入端口号连接即可。

**Q: 支持 Linux / macOS 吗？**

A: 完全支持。串口路径校验同时支持 Windows（`COMx`）和 Linux / macOS（`/dev/tty*`、`/dev/cu.*`），项目也提供了 `start-all.sh` / `stop-all.sh` 脚本。

**Q: 数据和日志存在哪里？数据库会无限增长吗？**

A: SQLite 数据库（`serial.db`）、运行日志（`mcp.log`）以及 listener 鉴权 token 均保存在用户目录 `~/.serial-mcp/` 下。数据库默认超过 10000 条自动清理最老的数据，可在配置项 `db.maxRows` 调整。

**Q: 如何区分烧录前后的数据？**

A: 烧录完成后调用 `new_session` 创建新会话，后续查询时传入 `session_id` 过滤即可。

## License

MIT
