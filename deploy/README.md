# 在新机器部署定制 Karakeep

这套部署包含网页中文翻译功能。首次运行会生成独立密钥和管理员账号，保留数据卷，并默认关闭公开注册、自动 AI 标签、自动摘要及自动向量索引。

需要 Git、Python 3.9+、Docker Engine 和 Docker Compose v2.24+。支持 Linux amd64/arm64；构建和首次拉取镜像需要联网。本机已有 Docker Desktop 时也可以用默认的 localhost 地址运行。

## 首次部署

```sh
git clone --branch codex/customizations https://github.com/rensixuan/karakeep.git
cd karakeep
python3 deploy/deploy.py
```

默认从当前源码构建包含翻译功能的应用镜像，然后启动应用、Chrome 和 Meilisearch。首次构建较慢；完成后打开 `http://localhost:3000`。

默认管理员是 `admin@example.com`，随机密码保存在 `deploy/admin-credentials.json`，文件权限为 `600`。脚本不把密码打印到日志。登录后可以修改密码。

要从其他设备通过服务器 IP 访问，在第一次运行时指定地址和管理员邮箱：

```sh
python3 deploy/deploy.py --url http://192.0.2.10:3000 --email you@example.com
```

把示例 IP 换成实际服务器 IP，并开放对应端口。该模式使用 HTTP；有域名的公网部署使用下面的 HTTPS 方式。

## 域名和 HTTPS

将域名的 DNS 指向新服务器，开放 TCP 80/443，然后第一次运行：

```sh
python3 deploy/deploy.py --url https://reader.example.com --email you@example.com
```

该模式会同时启动 Caddy，自动申请 HTTPS 证书；应用的 3000 端口只绑定本机。脚本验证本机应用健康和账号登录，域名证书签发仍要求 DNS 和公网 80/443 可达。部署不包含旧服务器的域名或证书。

## 使用 GitHub 构建的镜像

`Portable deployment image` 工作流在 `codex/customizations` 分支更新后构建 amd64 和 arm64 镜像。每个平台先完成全新安装、账号登录、正文和翻译配置、重复启动与数据持久化测试，通过后才推送 GHCR 并合并多平台镜像。

工作流成功后，新机器可以跳过源码构建：

```sh
python3 deploy/deploy.py \
  --image ghcr.io/rensixuan/karakeep:custom \
  --url https://reader.example.com \
  --email you@example.com
```

也可以使用固定提交的 `ghcr.io/rensixuan/karakeep:sha-完整提交SHA`。镜像发布使用 Actions 自带的 `GITHUB_TOKEN`，不需要在源码里配置 GitHub 密钥。GHCR 包首次发布可能为私有：拥有者需将包可见性设为 Public，或者新机器先执行 `docker login ghcr.io`。默认源码构建方式不依赖 GHCR 中的定制镜像或旧服务器本地镜像。

## AI 配置

不配置模型密钥也能登录、保存收藏、抓取正文及搜索。

- 网页中文翻译：登录后，在设置中的阅读器翻译配置填写自己的模型 API key。
- 原生中文摘要：在 `deploy/.env` 中填写 `OPENAI_API_KEY` 后重新运行启动脚本；默认模型 `gpt-5.4-mini`，语言为简体中文。
- 自动 AI 处理保持关闭，按需手动触发。新实例不会继承旧服务器的模型密钥。

`NEXTAUTH_SECRET`、`MEILI_MASTER_KEY` 和 `TRANSLATION_ENCRYPTION_KEY` 自动生成。保留 `.env`，重复运行不会重新生成这些值。

## 重启、更新和数据

重复启动：

```sh
python3 deploy/deploy.py
```

使用源码镜像时，先备份数据和 `.env`，再更新分支并重建：

```sh
git pull --ff-only
python3 deploy/deploy.py --build
```

使用远程镜像时，先备份；需要固定新版本时修改 `.env` 中的 `KARAKEEP_IMAGE`，再执行 `python3 deploy/deploy.py --pull`。

数据位于 Docker 命名卷：`<项目名>_data`、`<项目名>_meilisearch`，HTTPS 模式还使用 Caddy 数据卷。默认项目名为 `karakeep`。同机部署第二套时，使用独立克隆目录、不同端口，并在首次运行传入 `--project-name karakeep-second`。

以下文件不进入 Git，也不进入镜像构建上下文：`deploy/.env`、`deploy/admin-credentials.json`、备份和数据。更新或重新克隆前，单独备份 `.env` 和数据卷；不要用 `docker compose down --volumes` 删除需要保留的数据。修改域名可编辑 `.env` 中的 `NEXTAUTH_URL`、`WEB_BIND`、`WEB_PORT`、`COMPOSE_PROFILES` 和 `CADDY_SITE` 后重新启动。

这是一套新实例部署工具，不包含个人文章或旧数据库。要迁移现有实例，需要另行转移数据库、资产及原有 `.env`，尤其是翻译加密密钥；不要对已有数据生成新的密钥。

## 验证

```sh
python3 -m unittest discover -s deploy -p 'test_*.py' -v
```

首次启动自动验证健康接口、管理员登录和翻译加密配置。`smoke_test.py` 仅允许 `portable-test-` 或 `portable-ci-` 前缀的临时项目，会创建并删除一条测试收藏，并验证重跑后数据仍在；不要对正式实例执行。

Compose 的相对构建路径、可选服务配置和镜像发布方式分别参考 [Docker 构建规范](https://docs.docker.com/reference/compose-file/build/)、[Compose profiles](https://docs.docker.com/compose/how-tos/profiles/) 和 [GitHub 镜像发布文档](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)。
