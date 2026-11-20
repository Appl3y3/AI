@echo off
powercfg /setactive 79d386e3-3601-482d-aeb4-cc38e16c3d8f
echo Switched to: IDLE MODE
echo   CPU 5-60% ^| display off 10min ^| no sleep ^| disks always on
ping -n 2 127.0.0.1 >nul
