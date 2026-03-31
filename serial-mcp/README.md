# serial-mcp

嵌入式 AI 调试串口 MCP 服务，让 Claude Code / Codex CLI 直接读写串口数据，实现编码→烧录→调试的完整闭环。当前版本使用 MCP TypeScript SDK v2，并兼容 legacy MCP 客户端。

[![npm](https://img.shields.io/npm/v/serial-mcp)](https://www.npmjs.com/package/serial-mcp)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)]()

## 安装

### 直接运行（推荐）

无需全局安装，直接运行最新版：

```bash
npx -y serial-mcp@latest
```

也可以全局安装：

```bash
npm install -g serial-mcp
serial-mcp
```

### Claude Code（Windows）
```bash
claude mcp add -s user serial -- cmd /c npx -y serial-mcp@latest
```

### Claude Code（macOS / Linux）
```bash
claude mcp add -s user serial -- npx -y serial-mcp@latest
```

### Codex CLI
```bash
codex mcp add serial -- npx -y serial-mcp@latest
```

### 验证安装
```bash
claude mcp list
# 看到 serial · ✔ connected 即成功
```

## 使用方式

安装完成后，直接告诉 AI：

> 我的设备接在 COM5，波特率 115200，帮我连接并开始调试

AI 会自动完成连接，无需任何额外配置。

### 手动启动

如果不通过 MCP 客户端启动，也可以直接运行：

```bash
node server.js
```

listener 通常由 MCP Server 自动管理，也可以手动运行：

```bash
node lib/listener.js
```

## 功能

| 功能 | 状态 |
|------|------|
| 串口连接/断开 | ✅ 稳定 |
| 数据收发 | ✅ 稳定 |
| SQLite 数据持久化 | ✅ 稳定 |
| 多串口并发 | ✅ 稳定 |
| 设备自动检测 | ✅ 稳定 |
| Modbus RTU | 🚧 开发中 |

## MCP 工具列表（11 个）

| 工具 | 说明 |
|------|------|
| `list_ports` | 扫描系统所有可用串口 |
| `list_connected` | 查看当前已接管的串口 |
| `connect_port` | 接管指定串口并创建新会话 |
| `disconnect_port` | 释放指定串口 |
| `detect_device` | 自动检测新插入的串口设备（支持 `auto_connect`） |
| `get_status` | 所有串口连接状态 |
| `send_data` | 向指定串口发送数据（支持 `text` / `hex`，写入 `direction=tx`） |
| `send_and_wait` | 发送指令并等待响应（支持 `timeout` / `delimiter` 模式） |
| `read_latest` | 读取最新 N 条数据（默认 `rx`，可通过 `direction` 查询 `tx` 或 `all`） |
| `read_since` | 读取某时间点后的数据（默认 `rx`，可通过 `direction` 查询 `tx` 或 `all`） |
| `new_session` | 烧录后创建新会话 |

## 安全与存储说明

- listener 的 HTTP 接口仅监听 `127.0.0.1` 且默认校验本次启动生成的随机 bearer token，未授权请求返回 `401`。
- 串口端口名会按操作系统校验；Windows 使用 `COM1`、`COM12` 等格式，Linux / macOS 使用受控的 `/dev/tty*` 或 `/dev/cu.*` 格式。
- token、运行日志（`mcp.log`）与 SQLite 数据库（`serial.db`，启用 WAL 与 `busy_timeout`）均保存在用户目录下的 `~/.serial-mcp` 文件夹中，请勿将其中的 token 文件提交到仓库或日志。

## 真实硬件接入

插上设备后告诉 AI：
> 帮我检测新插入的串口设备

AI 会自动调用 `detect_device` 识别并连接。

## 系统要求

- Node.js >= 22（推荐 Node.js 24 LTS x64，兼容 Node.js 22 LTS）
- Windows / macOS / Linux
- 真实硬件或虚拟串口驱动

项目使用 Node.js + npm 运行，不再需要项目级 Visual Studio Build Tools 或 exe/pkg 打包工具。`serialport` 和 `better-sqlite3` 在受支持的 Node 22/24 环境优先使用预编译原生包；若使用不受支持的 Node/平台组合，npm 仍可能回退到本地原生编译。

### 更新到最新版

查看 npm 最新版本：

```bash
npm view serial-mcp version
```

使用最新版运行：

```bash
npx -y serial-mcp@latest
```

## License

MIT © lckandyou

## 作者

- lckandyou
- GitHub: https://github.com/LckAndLove

## 相关链接

- [GitHub](https://github.com/LckAndLove/serial-mcp)
- [npm](https://www.npmjs.com/package/serial-mcp)
- [Issues](https://github.com/LckAndLove/serial-mcp/issues)
