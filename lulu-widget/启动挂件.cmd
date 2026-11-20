@echo off
chcp 65001 >nul
rem Portable launcher: prefer pythonw from PATH, fall back to this machine's Python 3.14
cd /d "%~dp0"

where pythonw >nul 2>nul
if not errorlevel 1 (
    start "" pythonw "%~dp0widget.py"
    exit /b
)

if exist "C:\Python314\pythonw.exe" (
    start "" "C:\Python314\pythonw.exe" "%~dp0widget.py"
    exit /b
)

echo pythonw not found. Install Python or edit the interpreter path in this file.
pause
