#!/bin/sh
set -eu

# Run the server from the directory containing this script.
cd "$(dirname "$0")"

# Install dependencies on the first run, then start the server.
if [ ! -d node_modules ]; then npm install; fi
npm start
