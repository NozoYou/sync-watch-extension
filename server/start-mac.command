#!/bin/sh
set -eu

# Run the server from the directory containing this script.
cd "$(dirname "$0")"

# Install dependencies on the first run, then keep the server in the foreground.
if [ ! -d node_modules ]; then npm install; fi
npm start

# Keep the Terminal window open long enough to show that the server stopped.
printf '\n服务已停止。按回车关闭此窗口。'
read _
