@echo off
rem Anix in browser: local server + opens http://127.0.0.1:8371/
cd /d "%~dp0"
node server\index.js --open
