#!/usr/bin/env bash
# 启动一个带调试端口的专用 Edge/Chrome（135 编辑器登录态存在独立 profile 里，只登一次）。
# 用法：bash scripts/launch-debug-browser.sh
# 端口 9333 与 dsh-wechat-135 插件默认一致；profile 在 ~/.dsh/wechat-135/browser

set -e
PROFILE="$HOME/.dsh/wechat-135/browser"
mkdir -p "$PROFILE"

CANDIDATES=(
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  "/usr/bin/google-chrome"
  "/usr/bin/chromium"
  "/usr/bin/chromium-browser"
)
BROWSER="${WX135_BROWSER_PATH:-}"
if [ -z "$BROWSER" ]; then
  for c in "${CANDIDATES[@]}"; do
    if [ -x "$c" ]; then BROWSER="$c"; break; fi
  done
fi
if [ -z "$BROWSER" ]; then
  echo "[错误] 找不到 Edge/Chrome，请用 WX135_BROWSER_PATH 指定可执行文件路径" >&2
  exit 1
fi

echo "正在启动调试浏览器（端口 9333）：$BROWSER"
"$BROWSER" \
  --remote-debugging-port=9333 \
  --user-data-dir="$PROFILE" \
  --remote-allow-origins='*' \
  --no-first-run \
  "https://www.135editor.com/beautify_editor.html" \
  >/dev/null 2>&1 &

echo "已启动。这个窗口请一直开着；第一次需要在里面扫码登录 135 账号。"
