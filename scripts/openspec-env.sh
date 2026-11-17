#!/usr/bin/env bash
# 在目前 shell 載入雲端工具路徑；保留既有明確指定的設定目錄。
export PATH="/workspace/.tools/bin:$PATH"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/workspace/.config}"
export OPENSPEC_TELEMETRY=0
