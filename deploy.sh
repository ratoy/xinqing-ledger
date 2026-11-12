#!/usr/bin/env bash
# 一键部署 / 更新到远程 Linux 主机
# 用法：
#   ./deploy.sh [主机IP] [SSH用户名]
#   SSH_KEY=/path/to/key.pem SSH_USER=root ./deploy.sh 192.168.2.50
# 前提：本机到目标机可 SSH（建议配置免密）；目标机已装 Docker + Compose v2。
# 说明：文件上传走 SSH stdin，不依赖 scp/sftp，兼容 dropbear（OpenWrt / iStoreOS）。
set -euo pipefail

HOST="${1:-192.168.2.50}"
SSH_USER="${SSH_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-/opt/peiwan-ledger}"
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
  cp .env.example .env
  echo "[提示] 已生成 .env（默认无密码）。若非可信内网，请先填写 ACCESS_PASSWORD 再重新运行。"
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

echo "==> 确保 Docker 构建临时目录存在"
DOCKER_ROOT="$(ssh_cmd "docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker" | tail -1 | tr -d '\r')"
ssh_cmd "mkdir -p '${DOCKER_ROOT}/tmp' && chmod 700 '${DOCKER_ROOT}/tmp'"

echo "==> 上传项目文件到 ${REMOTE_DIR}"
ssh_cmd "mkdir -p '${REMOTE_DIR}/public'"
for f in Dockerfile docker-compose.yml package.json server.js .env public/index.html public/app.js public/logo.png; do
  ssh "${OPTS[@]}" "$TARGET" "cat > '${REMOTE_DIR}/${f}'" < "$f"
  echo "  $f"
done

echo "==> 构建并启动"
ssh_cmd "cd '${REMOTE_DIR}' && docker compose up -d --build && docker compose ps"

echo "==> 健康检查"
ssh_cmd "echo -n 'health: '; wget -qO- http://127.0.0.1:${PORT}/api/health; echo"

echo "部署完成： http://${HOST}:${PORT}"
