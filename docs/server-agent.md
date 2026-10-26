# Server Agent · 远程同步服务端部署指南

ReqFlow 2.12 起提供可独立部署的同步服务端（Server Agent），用于在 NAS、云主机或常开设备上存放各设备的需求流数据。服务端与桌面端使用同一 Go 代码库，以独立入口命令运行；首版仅服务单用户（一个访问令牌），不做多租户。

## 获取可执行文件

- Windows：安装目录下的 `ReqFlow.exe` 本身就是入口，`ReqFlow.exe server ...` 即可运行服务端。
- Linux amd64 / arm64：安装包自带 `reqflow-server-linux-amd64` / `reqflow-server-linux-arm64`（位于 ReqFlow 安装目录），复制到服务器并改名为 `reqflow-server` 即可；也可自行交叉编译：`GOOS=linux GOARCH=amd64 go build -o reqflow-server ./server`（在 `src/mygo` 下执行）。

## 快速启动

```sh
reqflow-server server run --port 8787 --data-dir /srv/reqflow --config /srv/reqflow/server-config.sqlite
```

- `--port` 监听端口（默认 8787），`--data-dir` 数据目录（默认用户配置目录下的 `reqflow-server`），`--config` 配置文件路径；也可用 `--host` 指定监听地址（默认 `0.0.0.0`）、`--token` 指定访问令牌、`--cert / --key` 指定受信任 CA 签发的证书。
- 首次启动自动生成自签证书（数据目录 `certs/`，长期复用）与访问令牌，并在日志中打印**实际监听地址**、访问令牌与证书 SHA-256 指纹。
- 数据目录结构与桌面客户端完全隔离：`server.sqlite` 保存项目、需求与操作记录，`deployment.sqlite` 保存部署标记与配置，`certs/` 保存证书。误指向客户端数据目录会拒绝启动。
- 配置使用 SQLite；指定旧 `server-config.json` 时会读取并迁移至同目录的 `server-config.sqlite`，原 JSON 留作迁移备份。旧 `projects/*.json` 与步骤记录也会首次迁移至 SQLite，之后不会用旧 JSON 覆盖数据库。

## 注册为系统服务

```sh
reqflow-server server install --port 8787 --data-dir /srv/reqflow   # 安装并启动
reqflow-server server status                                        # 查看状态
reqflow-server server stop / start                                  # 停止 / 启动
reqflow-server server uninstall                                     # 注销
reqflow-server server token                                         # 查看令牌
reqflow-server server token --rotate                                # 轮换令牌（客户端需更新）
```

- Windows：注册为真正的 Windows 服务（需要管理员权限；失败时自动回退为计划任务，登录时自动启动）。
- Linux：生成 systemd 用户单元 `~/.config/systemd/user/reqflow-server.service` 并尝试 `systemctl --user enable --now`；无 systemd 环境时按提示使用生成的启动脚本或 crontab。

## 客户端接入

1. 桌面端「设置 → Server Agent → 新增服务端」：填写名称、地址、端口，证书模式选「自签 + 指纹确认」（默认）或「受信任 CA」，粘贴访问令牌。
2. 首次连接会展示服务端证书指纹，与服务端启动日志中的指纹核对一致后点击「信任并连接」。已信任的服务端指纹变化时会阻断连接，确认服务器重签证书后可在列表中「重置信任」重新确认。
3. 访问令牌与证书指纹在本机经 Windows DPAPI 加密保存，不会出现在工作区导出、Git 备份或同步数据中。
4. 「SSH 自动安装」：对已配置免密（公钥）登录的 Linux 服务器，填入 `user@host`、服务端端口和数据目录即可自动上传二进制、生成 SQLite 配置与令牌并设置开机自启，完成后自动生成配置草稿。数据目录支持 `/srv/reqflow/data` 等绝对路径及 `~/...`，完成提示会显示实际目录；程序与部署配置仍安装于 SSH 用户的 `~/reqflow-server`。

修改数据目录不会自动搬迁旧目录中的数据。已有部署需要先备份并搬迁数据，再切换目录；不更换数据目录时，启动会原地迁移旧 JSON 数据。

## 项目关联与同步

- 「项目设置 → 远程同步」中选择已连接的 Server Agent 保存即完成关联。
- 首次关联时，远程没有该项目则自动迁移本地 flow；已有远程项目时以远程数据为准，不会用本地快照覆盖。
- 关联后，需求、草稿、排期、领取任务、完成、验证、回归及归档等 flow 操作在服务端执行；桌面端与 CLI 都使用远程业务规则和并发版本检查。图片内容随 flow 保存，本机路径不上传。
- 本地仅更新服务端已确认结果的备份。读取时自动更新备份；远程不可用时可查看备份，但不允许继续本地修改关联 flow。界面不再提供手动推送或拉取。
- 点击「中断远程同步」后，项目继续使用最后一次确认的本地备份，远程数据保留。跨本地与远程或跨不同服务器移动需求前，需要先中断关联。
- 发布、Git、项目目录与验证程序等本机操作仍在本地执行。

## 远程卸载

- 「设置 → Server Agent → 远程卸载」填写原 SSH 目标，点击「检查卸载范围」查看实际数据目录。
- 默认「确认卸载并保留数据」：停止服务进程，移除 systemd / crontab 自启、程序、部署配置和安装日志，保留数据目录与证书。
- 选中「同时清理远程数据目录」后，再确认卸载，会永久删除显示的数据目录；程序会核对部署标记，并拒绝根目录、主目录、程序目录和符号链接目录。
- 卸载不会自动中断项目关联；需要继续本地编辑时，先在项目设置中中断远程同步。

## 接口概览

服务端全部走 HTTPS。`GET /api/ping` 为公开健康检查；其余接口需 `Authorization: Bearer <令牌>`：`GET /api/info`、`GET /api/sync/projects`、`GET /api/sync/project?id=`、`POST /api/flow/associate`、`POST /api/flow/mutate`。flow 操作在 SQLite 事务内执行，版本不一致返回 HTTP 409，未携带有效令牌返回 HTTP 401。
