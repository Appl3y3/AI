@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 拾光影院 ...
echo 启动后请用浏览器打开 http://127.0.0.1:8787
echo 关闭这个窗口即可停止服务。
echo.
start "" http://127.0.0.1:8787
node server.js
pause
