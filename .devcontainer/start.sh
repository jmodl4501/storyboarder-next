#!/usr/bin/env bash
set -eu
if pgrep -f "node server/index.js" >/dev/null 2>&1; then exit 0; fi
mkdir -p /tmp/storyboarder-next
nohup npm start >/tmp/storyboarder-next/server.log 2>&1 &
