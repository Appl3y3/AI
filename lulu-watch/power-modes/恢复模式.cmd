@echo off
powercfg /setactive 381b4222-f694-41f0-9685-ff5bb260df2e
echo Switched to: BALANCED (normal use, CPU up to 100%%)
ping -n 2 127.0.0.1 >nul
