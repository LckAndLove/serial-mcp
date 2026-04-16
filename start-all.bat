@echo off
start "virtual-device" cmd /k "cd /d D:\LCK\COM\serial-virtual && node virtual-device.js"
timeout /t 2 /nobreak >nul
start "serial-db" cmd /k "cd /d D:\LCK\COM\serial-db && node listener.js"
