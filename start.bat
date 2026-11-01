@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo 서초구 부동산 대시보드를 시작합니다...
start "" http://localhost:8650
python server.py
pause
