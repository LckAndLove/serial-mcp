# serial-virtual 使用说明

## 1. com0com 安装步骤

1. 打开官网：https://com0com.sourceforge.net  
2. 下载 com0com 安装包。  
3. 运行安装程序并按默认步骤完成安装。  
4. 安装完成后，确认虚拟串口对已创建（如需可在系统设备管理器中查看）。

## 2. 启动方式

请按以下顺序启动：

1. 先运行设备模拟程序：
```bash
npm run device
```

2. 再运行监控程序：
```bash
npm run monitor
```

## 3. 验证方式

启动后，`monitor` 应能够看到 `device` 输出的传感器数据。  
如果监控端持续收到传感器数据输出，则说明串口通信链路工作正常。

## 4. 支持命令

当前支持以下命令：

- `GET_STATUS`
- `GET_TEMP`
- `RESET`
