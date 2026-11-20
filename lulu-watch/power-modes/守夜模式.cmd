@echo off
powercfg /setactive e1d5e609-ee6d-4de7-af06-490791308617
echo 已切换：守夜模式（CPU 40%%、睿频关、不睡眠）
ping -n 2 127.0.0.1 >nul
