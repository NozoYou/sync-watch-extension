#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then npm install; fi
npm start
printf '\n服务已停止。按回车关闭此窗口。'
read _
