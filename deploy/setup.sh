#!/bin/bash
# 本地执行：把 infinite-gantt 部署到指定服务器
# 用法: bash deploy/setup.sh
#
# 服务器地址从以下任一来源读取（按优先级），本文件不含任何敏感信息：
#   1. 环境变量 GANTT_HOST
#   2. deploy/config.local.sh（已被 gitignore，不会提交）
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REMOTE_SCRIPT=/tmp/gantt-remote.sh

# 读取本地私有配置
if [ -f "$HERE/config.local.sh" ]; then
  # shellcheck disable=SC1091
  . "$HERE/config.local.sh"
fi

HOST="${GANTT_HOST:-}"
SSH_PORT="${GANTT_SSH_PORT:-22}"

if [ -z "$HOST" ]; then
  cat >&2 <<MSG
未配置服务器地址。二选一：

  a) 创建 deploy/config.local.sh（不会被提交）：
       echo 'GANTT_HOST=root@<你的服务器IP>' > deploy/config.local.sh

  b) 直接传环境变量：
       GANTT_HOST=root@<你的服务器IP> bash deploy/setup.sh
MSG
  exit 1
fi

echo "==> 目标服务器: $HOST:$SSH_PORT"
echo "==> 测试 SSH 连接（会提示输入 root 密码）"
if ! ssh -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "$HOST" \
     'echo "    连接成功: $(hostname)"'; then
  echo "SSH 连接失败：请检查 IP / 端口 / 密码，或云厂商安全组是否放行 22" >&2
  exit 1
fi

echo "==> 上传部署脚本"
scp -P "$SSH_PORT" "$HERE/remote.sh" "$HOST:$REMOTE_SCRIPT"

echo "==> 远程执行部署"
ssh -p "$SSH_PORT" "$HOST" "chmod +x $REMOTE_SCRIPT && bash $REMOTE_SCRIPT; rm -f $REMOTE_SCRIPT"

echo ""
echo "==> 完成。访问 https://${GANTT_DOMAIN:-status.hcrx.ltd}/"
