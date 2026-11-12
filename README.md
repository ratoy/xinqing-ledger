# 心情の · 陪玩收入台账

自托管的接单收入台账。按单录入「老板付的金额」，按散单 / 预存的到手比例自动折算，支持本期汇总、按日期自由统计、结算划期与历史、CSV 导出、JSON 备份。

- 服务端：零第三方依赖的 Node.js HTTP 服务，数据写入 Docker 命名卷
- 前端：服务器版 `public/`，另有免 Docker 的单机版 `index.html`（浏览器 localStorage）
- 登录：页面内登录卡片 + HttpOnly Cookie 会话，非浏览器原生认证弹窗

## 一键部署到 Docker

脚本：`install.sh`。在任意已安装 Docker + Compose v2 的 Linux / macOS 上执行一条命令即可完成「拉源码 → 生成配置 → 构建 → 启动 → 健康检查」：

```bash
curl -fsSL https://raw.githubusercontent.com/ratoy/xinqing-ledger/main/install.sh | bash
```

脚本内已写入默认仓库地址，直接执行即可；`publish.sh` 结束也会打印同一条命令。也可以先 clone 再执行：

```bash
git clone https://github.com/ratoy/xinqing-ledger.git
cd xinqing-ledger
./install.sh
```

自定义端口与密码：

```bash
export HOST_PORT=18080 ACCESS_PASSWORD='换成你的强密码'
./install.sh
```

脚本会自动：检查 Docker / Compose、检测端口占用、生成权限 600 的 `.env`（未指定密码时生成 16 位随机强密码）、补齐部分系统缺失的 `DockerRootDir/tmp`、`docker compose up -d --build`、轮询 `/api/health` 直到通过，最后打印访问地址、账号、密码和常用运维命令。重复执行即为更新，数据卷保留。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `REPO_URL` | 见脚本内 `DEFAULT_REPO` | 源码仓库地址，`curl \| bash` 方式需要设置 |
| `INSTALL_DIR` | `~/peiwan-ledger` | 源码安装目录 |
| `HOST_PORT` | `8080` | 宿主机访问端口 |
| `ACCESS_USER` | `admin` | 登录账号 |
| `ACCESS_PASSWORD` | 随机生成 | 访问密码，留空表示不启用密码 |
| `SKIP_PULL` | `0` | 设为 `1` 时不重新拉取源码 |
| `COMPOSE_PROJECT_NAME` | `peiwan-ledger` | 决定数据卷名，改动会导致读不到旧数据 |

### 常用运维命令

```bash
docker compose logs -f          # 查看日志
docker compose down             # 停止容器（保留账本数据）
docker compose down -v          # 删除容器与数据卷（会清空账本，慎用）
```

数据落在 Docker 命名卷 `<项目名>_ledger-data`，文件为 `ledger.json`，服务端每次写入会保留 `ledger.json.bak`。建议在页面内定期用「导出 JSON 备份」另存一份。

## 发布到 GitHub

脚本：`publish.sh`（创建仓库 + 推送当前提交，一条命令）：

```bash
GITHUB_TOKEN=ghp_xxx ./publish.sh                  # 默认仓库名 xinqing-ledger，私有
GITHUB_TOKEN=ghp_xxx ./publish.sh my-repo public  # 指定仓库名、公开
```

Token 需要 `repo` 权限。脚本推送前会校验 `.env` / `ledger.json` 已被 `.gitignore` 排除且未被 git 跟踪，避免密码和真实账本进入仓库；Token 只在内存中使用，不写入项目文件。

## 安全说明

- `.env`、`.env.local`、`ledger.json*`、`data/` 已被 `.gitignore` 排除，`.env.example` 是无密码模板，可以提交。
- 暴露到公网时务必设置强密码，并建议再加一层 HTTPS 反向代理；`.env` 文件权限为 600。
- 单机版 `index.html` 的数据只存在当前浏览器，换设备或清缓存会丢失。

## 其它文件

| 文件 | 用途 |
| --- | --- |
| `Dockerfile` / `docker-compose.yml` | 镜像构建与容器编排，命名卷持久化 |
| `server.js` | HTTP 服务与数据接口，原子写入 `ledger.json` |
| `public/` | 服务器版前端与 logo |
| `index.html` | 免 Docker 的单机版 |
| `deploy.sh` | SSH 到指定远程主机部署 / 更新（与 `install.sh` 的区别：`deploy.sh` 面向已固定的目标机，`install.sh` 面向任意装了 Docker 的机器） |
| `.env.example` | 配置模板 |
