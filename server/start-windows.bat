@echo off

REM Run the server from the directory containing this script.
cd /d "%~dp0"

REM Install dependencies on the first run, then start the server.
if not exist node_modules call npm install
call npm start

REM Keep the window open so the user can read the server output.
pause
