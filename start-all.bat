@echo off
echo 启动虚拟单片机...
start "serial-virtual" cmd /k "cd /d D:\LCK\COM\serial-virtual && npm run device"

timeout /t 2 /nobreak >nul

echo 启动串口监听...
start "serial-db" cmd /k "cd /d D:\LCK\COM\serial-db && npm run start"

echo.
echo ✅ 所有服务已启动
echo    - 虚拟单片机: COM2
echo    - 串口监听+HTTP: COM3 / localhost:7070
echo.
pause
