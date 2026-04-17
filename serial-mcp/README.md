# serial-mcp

嵌入式 AI 调试串口 MCP 服务，让 Claude Code / Codex CLI 直接读写串口数据。

## 安装

### Windows

#### Claude Code（用户级别，所有项目可用）
```bash
claude mcp add -s user serial -- cmd /c npx -y @lckandyou/serial-mcp
```

#### Codex CLI
```bash
codex mcp add serial -- npx -y @lckandyou/serial-mcp
```

### Mac/Linux

#### Claude Code
```bash
claude mcp add -s user serial -- npx -y @lckandyou/serial-mcp
```

#### Codex CLI
```bash
codex mcp add serial -- npx -y @lckandyou/serial-mcp
```

## 验证安装

```bash
# Claude Code
claude mcp list

# Codex CLI
codex mcp list
```

看到 `serial` 状态为 `connected` 即表示安装成功。

## 卸载

```bash
# Claude Code
claude mcp remove -s user serial

# Codex CLI
codex mcp remove serial
```

## 使用方式

连接好设备后，直接告诉 AI：

`我的设备接在 COM5，波特率 115200，帮我连接并开始调试`
