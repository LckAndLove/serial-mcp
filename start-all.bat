@echo off
start "virtual-device" cmd /k "cd /d %~dp0serial-virtual && node virtual-device.js"
timeout /t 2 /nobreak >nul
start "serial-db" cmd /k "cd /d %~dp0serial-db && node listener.js"
