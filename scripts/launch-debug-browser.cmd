@echo off
chcp 65001 >nul
rem 启动一个带调试端口的专用 Edge（135 编辑器登录态存在独立 profile 里，只登一次）。
rem 用法：双击运行。macOS/Linux 用 scripts/launch-debug-browser.sh
rem
rem 端口 9333 与 dsh-wechat-135 插件默认一致；profile 放在 %USERPROFILE%\.dsh\wechat-135\browser

setlocal
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%EDGE%" (
  echo [错误] 找不到 Edge/Chrome，请修改本脚本里的 EDGE 路径
  pause
  exit /b 1
)

set "PROFILE=%USERPROFILE%\.dsh\wechat-135\browser"
if not exist "%PROFILE%" mkdir "%PROFILE%"

echo 正在启动调试浏览器（端口 9333）……
start "" "%EDGE%" --remote-debugging-port=9333 --user-data-dir="%PROFILE%" --remote-allow-origins=* --no-first-run "https://www.135editor.com/beautify_editor.html"
echo 已启动。这个窗口请一直开着；第一次需要在里面扫码登录 135 账号。
timeout /t 3 >nul
