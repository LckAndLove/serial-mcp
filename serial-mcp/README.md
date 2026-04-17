# serial-mcp

嵌入式 AI 调试串口 MCP 服务，让 Claude Code / Codex CLI 直接读写串口数据，实现编码→烧录→调试的完整闭环。

[![npm](https://img.shields.io/npm/v/serial-mcp)](https://www.npmjs.com/package/serial-mcp)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows-blue)]()

## 安装

### Claude Code
```bash
claude mcp add -s user serial -- cmd /c npx -y serial-mcp
```

### Codex CLI
```bash
codex mcp add serial -- npx -y serial-mcp
```

### Mac / Linux
```bash
claude mcp add -s user serial -- npx -y serial-mcp
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

## 功能

| 功能 | 状态 |
|------|------|
| 串口连接/断开 | ✅ 稳定 |
| 数据收发 | ✅ 稳定 |
| SQLite 数据持久化 | ✅ 稳定 |
| 多串口并发 | ✅ 稳定 |
| 设备自动检测 | ✅ 稳定 |
| TUI 监控窗口 | ✅ 稳定 |
| 定时发送 | ✅ 稳定 |
| Modbus RTU | 🚧 开发中 |

## MCP 工具列表

| 工具 | 说明 |
|------|------|
| `list_ports` | 扫描系统所有可用串口 |
| `list_connected` | 查看当前已接管的串口 |
| `connect_port` | 接管指定串口 |
| `disconnect_port` | 释放指定串口 |
| `detect_device` | 自动检测新插入的串口设备 |
| `get_status` | 所有串口连接状态 |
| `send_data` | 向指定串口发送数据 |
| `send_and_wait` | 发送指令并等待响应 |
| `read_latest` | 读取最新 N 条数据 |
| `read_since` | 读取某时间点后的数据 |
| `new_session` | 烧录后创建新会话 |
| `open_monitor` | 弹出 TUI 监控窗口 |

## 监控窗口

AI 调用 `open_monitor` 工具后会弹出独立的终端监控窗口：

- 实时显示 TX/RX 数据，带时间戳
- 支持直接输入发送（文本/HEX 双模式）
- 定时发送：`/timer 1000 hello\r\n`
- 斜杠命令：`/hex` `/text` `/timers` `/stop` `/clear`

## 真实硬件接入

插上设备后告诉 AI：
> 帮我检测新插入的串口设备

AI 会自动调用 `detect_device` 识别并连接。

## 系统要求

- Node.js >= 18
- Windows / Mac / Linux
- 真实硬件或虚拟串口驱动

## License

MIT © lckandyou

## 相关链接

- [GitHub](https://github.com/LckAndLove/serial-mcp)
- [npm](https://www.npmjs.com/package/serial-mcp)
- [Issues](https://github.com/LckAndLove/serial-mcp/issues)

