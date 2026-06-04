@echo off
title omp-acp-bridge
set PATH=C:\Users\Namikaz\AppData\Roaming\npm;C:\Users\Namikaz\.bun;C:\Program Files\nodejs;%PATH%
set DEEPSEEK_API_KEY=sk-b2563422f1a945f2a7e6eaeba41bb16f
echo [%TIME%] Starting omp-acp-bridge on http://127.0.0.1:7654
echo [%TIME%] Starting omp-acp-bridge on http://127.0.0.1:7654 > C:\dev\bridge.log 2>&1
node.exe C:\dev\bridge.mjs >> C:\dev\bridge.log 2>&1
