@echo off
powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c
echo 已切换：开黑模式（高性能、CPU 100%%、睿频开）
ping -n 2 127.0.0.1 >nul
