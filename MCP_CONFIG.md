# MCP 安装与使用

本项目无需手动编辑任何配置文件，直接通过命令安装即可。

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

## 验证安装

```bash
# Claude Code
claude mcp list

# Codex CLI
codex mcp list
```

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

