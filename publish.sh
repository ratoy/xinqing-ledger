#!/usr/bin/env bash
# 心情の · 一键发布到 GitHub（创建仓库 + 推送当前提交）
#
# 用法：
#   GITHUB_TOKEN=ghp_xxx ./publish.sh                 # 默认仓库名 xinqing-ledger，私有
#   GITHUB_TOKEN=ghp_xxx ./publish.sh my-repo public # 指定仓库名、公开
#
# Token 需要 repo 权限（在 GitHub → Settings → Developer settings → Personal access tokens 生成）。
# Token 只用于本次 API 调用与推送，不写入任何项目文件、不打印到日志。
set -euo pipefail

REPO_NAME="${1:-xinqing-ledger}"
VISIBILITY="${2:-private}"
: "${GITHUB_TOKEN:?请先设置 GITHUB_TOKEN 环境变量（需要 repo 权限）}"

command -v curl >/dev/null 2>&1 || { echo "[错误] 缺少 curl" >&2; exit 1; }
command -v git  >/dev/null 2>&1 || { echo "[错误] 缺少 git"  >&2; exit 1; }

cd "$(dirname "$0")"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "[错误] 当前目录不是 git 仓库，请先 git init" >&2; exit 1; }
git rev-parse HEAD >/dev/null 2>&1 || { echo "[错误] 还没有任何提交，请先 git commit" >&2; exit 1; }

# 安全闸门：真实密码与账本数据绝不能进仓库
for f in .env ledger.json ledger.json.bak; do
  if [ -f "$f" ] && ! git check-ignore -q "$f" 2>/dev/null; then
    echo "[错误] $f 尚未被 .gitignore 排除，已中止推送" >&2
    exit 1
  fi
done
if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  echo "[错误] .env 已被 git 跟踪，请先执行 git rm --cached .env" >&2
  exit 1
fi

api() {
  curl -fsSL \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

echo "==> 获取 GitHub 账号信息"
LOGIN="$(api https://api.github.com/user | grep -o '"login"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
[ -n "$LOGIN" ] || { echo "[错误] 无法读取账号信息，请检查 GITHUB_TOKEN" >&2; exit 1; }
echo "    账号：$LOGIN"

echo "==> 创建仓库 ${LOGIN}/${REPO_NAME}（${VISIBILITY}）"
RESP="$(api -X POST https://api.github.com/user/repos \
  -d "{\"name\":\"${REPO_NAME}\",\"private\":$([ "$VISIBILITY" = "public" ] && echo false || echo true),\"description\":\"心情の · 陪玩收入台账（自托管 / 一键 Docker 部署）\"}" \
  -w '\n%{http_code}' || true)"
CODE="$(printf '%s' "$RESP" | tail -1)"
case "$CODE" in
  201) echo "    已创建" ;;
  422) echo "    仓库已存在，直接推送" ;;
  *)   echo "[错误] 创建仓库失败（HTTP $CODE）" >&2; exit 1 ;;
esac

REMOTE="https://github.com/${LOGIN}/${REPO_NAME}.git"
BRANCH="$(git branch --show-current)"
[ -n "$BRANCH" ] || { echo "[错误] 当前处于 detached HEAD" >&2; exit 1; }

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE"
else
  git remote add origin "$REMOTE"
fi

echo "==> 推送分支 ${BRANCH}"
# 用带凭据的临时 URL 推送；凭据不写入 .git/config
PUSH_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${LOGIN}/${REPO_NAME}.git"
trap 'git remote set-url origin "$REMOTE" 2>/dev/null || true' EXIT
git push -u "$PUSH_URL" "${BRANCH}:main"
git remote set-url origin "$REMOTE"

printf '\n发布完成： https://github.com/%s/%s\n' "$LOGIN" "$REPO_NAME"
printf '一键部署： curl -fsSL https://raw.githubusercontent.com/%s/%s/main/install.sh | bash\n' "$LOGIN" "$REPO_NAME"
