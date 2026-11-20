#!/usr/bin/env bash
# 一键部署 / 更新到远程 Linux 主机（只拉镜像，不在目标机本地构建）
#
# 镜像由 GitHub Actions 构建并推送到 ghcr.io/<owner>/xinqing-ledger，
# 目标机只执行 docker compose pull + up，因此不会再堆积 <none> 中间层镜像。
#
# 用法：
#   ./deploy.sh [主机IP] [SSH用户名]
#   SSH_KEY=/path/to/key.pem SSH_USER=root ./deploy.sh 192.168.2.50
#   REMOTE_DIR=/mnt/docker/compose/peiwan-ledger ./deploy.sh
# 前提：本机到目标机可 SSH（建议配置免密）；目标机已装 Docker + Compose v2，且能访问 ghcr.io。
# 说明：文件上传走 SSH stdin，不依赖 scp/sftp，兼容 dropbear（OpenWrt / iStoreOS）。
set -euo pipefail

HOST="${1:-192.168.2.50}"
SSH_USER="${SSH_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-/opt/peiwan-ledger}"
IMAGE="${IMAGE:-ghcr.io/ratoy/xinqing-ledger:latest}"
TARGET="${SSH_USER}@${HOST}"
cd "$(dirname "$0")"

OPTS=(-o BatchMode=yes -o ConnectTimeout=10)
if [ -n "${SSH_KEY:-}" ]; then OPTS+=(-i "$SSH_KEY"); fi
# SSH_STRICT=0 仅用于可信内网且主机指纹变更的场景：不校验、也不写入本机 known_hosts
if [ "${SSH_STRICT:-1}" = "0" ]; then
  OPTS+=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o GlobalKnownHostsFile=/dev/null)
fi
ssh_cmd() { ssh "${OPTS[@]}" "$TARGET" "$@"; }

if [ ! -f .env ]; then
  # 不要自动生成无密码 .env：它会被上传到远端并覆盖已有的访问密码
  echo "[错误] 缺少 .env（含 ACCESS_PASSWORD）。请先执行 cp .env.example .env 并填好密码再运行。" >&2
  exit 1
fi
PORT="$(grep -E '^HOST_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d '\r\n' || true)"
PORT="${PORT:-8080}"

echo "==> 检查目标机 Docker：${TARGET}"
ssh_cmd "command -v docker >/dev/null && docker compose version" \
  || { echo "目标机缺少 Docker 或 Compose v2，部署中止"; exit 1; }

echo "==> 检查端口 ${PORT} 是否被其它容器占用"
OWNER="$(ssh_cmd "docker ps --format '{{.Names}} {{.Ports}}' | grep ':${PORT}->' | head -1 || true")"
if [ -n "${OWNER}" ] && [[ "${OWNER}" != peiwan-ledger* ]]; then
  echo "端口 ${PORT} 已被占用：${OWNER}"
  echo "请修改 .env 中的 HOST_PORT 后重试"; exit 1
fi

echo "==> 上传部署文件到 ${REMOTE_DIR}"
ssh_cmd "mkdir -p '${REMOTE_DIR}'"
for f in docker-compose.yml .env; do
  ssh "${OPTS[@]}" "$TARGET" "cat > '${REMOTE_DIR}/${f}'" < "$f"
  echo "  $f"
done

echo "==> 拉取镜像并启动：${IMAGE}"
ssh_cmd "cd '${REMOTE_DIR}' && docker compose pull && docker compose up -d && docker compose ps"

echo "==> 清理无 tag 的旧镜像（不动在用镜像）"
ssh_cmd "docker image prune -f | tail -2 || true"

echo "==> 健康检查"
ssh_cmd "echo -n 'health: '; wget -qO- http://127.0.0.1:${PORT}/api/health; echo"

echo "部署完成： http://${HOST}:${PORT}"
