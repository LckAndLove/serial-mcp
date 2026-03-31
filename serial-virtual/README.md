# serial-virtual 使用说明

用于在没有真实单片机硬件的情况下，本地模拟串口设备与收发调试。要求 **Node.js >= 22**。

## 1. 创建虚拟串口对

- **Windows（com0com）**：
  1. 打开官网：https://com0com.sourceforge.net
  2. 下载并按默认步骤安装 com0com。
  3. 确认已创建虚拟串口对（如 `COM2` ↔ `COM3`，可在设备管理器中查看），并在 `config.json` 中配置对应端口。
- **macOS / Linux（socat）**：
  ```bash
  socat -d -d pty,raw,echo=0 pty,raw,echo=0
  ```
  将生成的两个 `/dev/ttys*` 或 `/dev/pts/*` 路径填入 `config.json`。

## 2. 启动方式

请按以下顺序启动：

1. 先运行设备模拟程序：
```bash
npm run device
```

2. 再运行本地调试监控程序：
```bash
npm run monitor
```

## 3. 验证方式

启动后，`monitor` 应能够看到 `device` 每秒输出的传感器数据（`SENSOR temp=25.3 humidity=60.1`），说明虚拟串口通信链路工作正常。

## 4. 支持命令（需以 `\r\n` 结尾）

当前支持以下命令：

- `GET_STATUS` → 返回 `STATUS OK voltage=3.3v`
- `GET_TEMP` → 返回 `TEMP 25.3`
- `RESET` → 返回 `RESETTING...` 和 `BOOT OK`
