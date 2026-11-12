#!/usr/bin/env bash
# 心情の · 一键 Docker 部署脚本
#
# 在任意已安装 Docker + Compose v2 的 Linux / macOS 上执行：
#   curl -fsSL https://raw.githubusercontent.com/ratoy/xinqing-ledger/main/install.sh | bash
# 已在源码目录内时直接执行：
#   ./install.sh
#
# 可选环境变量：
#   REPO_URL              源码仓库地址（curl 方式必填，或替换下方 DEFAULT_REPO）
#   INSTALL_DIR           源码安装目录，默认 ~/peiwan-ledger
#   HOST_PORT             宿主机端口，默认 8080
#   ACCESS_USER           登录账号，默认 admin
#   ACCESS_PASSWORD       访问密码，默认自动生成 16 位随机密码
#   SKIP_PULL             设为 1 时不重新拉取源码
#   COMPOSE_PROJECT_NAME  Compose 项目名，默认 peiwan-ledger（决定数据卷名，勿随意改）
set -euo pipefail

DEFAULT_REPO="https://github.com/ratoy/xinqing-ledger.git"
REPO_URL="${REPO_URL:-$DEFAULT_REPO}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/peiwan-ledger}"
HOST_PORT="${HOST_PORT:-8080}"
ACCESS_USER="${ACCESS_USER:-admin}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-peiwan-ledger}"

log()  { printf '\n==> %s\n' "$*"; }
die()  { printf '\n[错误] %s\n' "$*" >&2; exit 1; }
env_get() {
  local key="$1" fallback="$2" val
  val="$(grep -E "^${key}=" .env 2>/dev/null | head -1 | cut -d= -f2- || true)"
  printf '%s' "${val:-$fallback}"
}
http_get() {
  if command -v curl >/dev/null 2>&1; then curl -fsS "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"
  else return 1
  fi
}

log "检查 Docker 环境"
command -v docker >/dev/null 2>&1        || die "未安装 Docker，请先安装 Docker Engine"
docker compose version >/dev/null 2>&1   || die "缺少 Compose v2（docker compose），请升级 Docker"
docker info >/dev/null 2>&1              || die "当前用户无法访问 Docker 守护进程，请用 root / sudo 运行或加入 docker 组"

# 定位源码：当前目录已是项目则直接用，否则从 GitHub 拉取
if [ -f server.js ] && [ -f Dockerfile ] && [ -f docker-compose.yml ]; then
  SRC="$(pwd)"
  log "使用当前目录源码：$SRC"
else
  [ "$REPO_URL" != "$DEFAULT_REPO" ] || die "请设置 REPO_URL 为你的 GitHub 仓库地址，例如 REPO_URL=https://github.com/你的用户名/仓库名.git"
  command -v git >/dev/null 2>&1 || die "需要 git 才能拉取源码，请先安装 git"
  if [ -d "$INSTALL_DIR/.git" ]; then
    if [ "${SKIP_PULL:-0}" != "1" ]; then
      log "更新源码：$INSTALL_DIR"
      git -C "$INSTALL_DIR" pull --ff-only
    fi
  else
    log "拉取源码到 $INSTALL_DIR"
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi
  SRC="$INSTALL_DIR"
fi
cd "$SRC"

# 端口占用检查（仅检查容器占用；宿主进程占用由 compose 启动时报错）
OWNER="$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep ":${HOST_PORT}->" | head -1 || true)"
if [ -n "$OWNER" ] && [[ "$OWNER" != *"${COMPOSE_PROJECT_NAME}"* ]]; then
  die "端口 ${HOST_PORT} 已被其它容器占用：$OWNER （可改 HOST_PORT 后重试）"
fi

# 生成 / 复用 .env（该文件已被 .gitignore 排除，不会进仓库）
if [ ! -f .env ]; then
  PASSWORD="${ACCESS_PASSWORD:-}"
  if [ -z "$PASSWORD" ]; then
    if command -v openssl >/dev/null 2>&1; then
      PASSWORD="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 16)"
    else
      PASSWORD="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)"
    fi
  fi
  {
    printf 'HOST_PORT=%s\n' "$HOST_PORT"
    printf 'ACCESS_USER=%s\n' "$ACCESS_USER"
    printf 'ACCESS_PASSWORD=%s\n' "$PASSWORD"
  } > .env
  chmod 600 .env
  log "已生成 .env（权限 600），访问密码为随机强密码"
else
  log "复用已有 .env（不覆盖现有密码与端口）"
  HOST_PORT="$(env_get HOST_PORT 8080)"
  ACCESS_USER="$(env_get ACCESS_USER admin)"
  PASSWORD="$(env_get ACCESS_PASSWORD '')"
fi

# 部分系统（如 OpenWrt / iStoreOS）的 Docker RootDir/tmp 缺失会导致构建失败，尽量补上
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
if [ -n "$DOCKER_ROOT" ] && [ ! -d "$DOCKER_ROOT/tmp" ]; then
  mkdir -p "$DOCKER_ROOT/tmp" 2>/dev/null && chmod 700 "$DOCKER_ROOT/tmp" 2>/dev/null || true
fi

log "构建并启动容器（项目名 ${COMPOSE_PROJECT_NAME}）"
docker compose up -d --build

log "等待健康检查 http://127.0.0.1:${HOST_PORT}/api/health"
OK=0
for _ in $(seq 1 30); do
  if http_get "http://127.0.0.1:${HOST_PORT}/api/health" >/dev/null 2>&1; then OK=1; break; fi
  sleep 1
done
if [ "$OK" != 1 ]; then
  docker compose logs --tail 60 >&2 || true
  die "健康检查未通过，请查看上方容器日志"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
[ -n "$IP" ] || IP="127.0.0.1"
printf '\n================ 部署完成 ================\n'
printf '  访问地址：http://%s:%s\n' "$IP" "$HOST_PORT"
printf '  登录账号：%s\n' "$ACCESS_USER"
printf '  登录密码：%s\n' "${PASSWORD:-（.env 中未设置，未启用密码）}"
printf '  源码目录：%s\n' "$SRC"
printf '  数据卷：%s_ledger-data（停止容器不会删除）\n' "$COMPOSE_PROJECT_NAME"
printf '\n常用命令（在 %s 下执行）：\n' "$SRC"
printf '  更新：./install.sh     或     git pull && docker compose up -d --build\n'
printf '  日志：docker compose logs -f\n'
printf '  停止：docker compose down        （保留数据）\n'
printf '  卸载：docker compose down -v     （会删除账本数据，慎用）\n'
printf '==========================================\n'
