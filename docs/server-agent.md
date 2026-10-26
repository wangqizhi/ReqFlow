# Server Agent · 远程同步服务端部署指南

ReqFlow 2.12 起提供可独立部署的同步服务端（Server Agent），用于在 NAS、云主机或常开设备上存放各设备的需求流数据。服务端与桌面端使用同一 Go 代码库，以独立入口命令运行；首版仅服务单用户（一个访问令牌），不做多租户。

## 获取可执行文件

- Windows：安装目录下的 `ReqFlow.exe` 本身就是入口，`ReqFlow.exe server ...` 即可运行服务端。
- Linux amd64 / arm64：安装包自带 `reqflow-server-linux-amd64` / `reqflow-server-linux-arm64`（位于 ReqFlow 安装目录），复制到服务器并改名为 `reqflow-server` 即可；也可自行交叉编译：`GOOS=linux GOARCH=amd64 go build -o reqflow-server ./server`（在 `src/mygo` 下执行）。

## 快速启动

```sh
reqflow-server server run --port 8787 --data-dir /srv/reqflow --config /srv/reqflow/server-config.json
```

- `--port` 监听端口（默认 8787），`--data-dir` 数据目录（默认用户配置目录下的 `reqflow-server`），`--config` 配置文件路径；也可用 `--host` 指定监听地址（默认 `0.0.0.0`）、`--token` 指定访问令牌、`--cert / --key` 指定受信任 CA 签发的证书。
- 首次启动自动生成自签证书（数据目录 `certs/`，长期复用）与访问令牌，并在日志中打印**实际监听地址**、访问令牌与证书 SHA-256 指纹。
- 数据目录结构与桌面客户端完全隔离（只包含 `projects/`、`certs/` 等），误指向客户端数据目录会拒绝启动。

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
4. 「SSH 自动安装」：对已配置免密（公钥）登录的 Linux 服务器，填入 `user@host` 与端口即可自动上传二进制、生成配置与令牌并设置开机自启，完成后自动生成配置草稿。

## 项目关联与同步

- 「项目设置 → 远程同步」中选择已连接的 Server Agent 保存即完成关联。
- 关联后该项目的需求、批次与全部步骤在每次变更时自动推送服务端，本地始终保留一份；发布、提交等操作仍在本地进行，服务端只保存 flow 数据（图片附件仅同步标识，不上传原图）。
- 支持「立即推送」与「从服务端拉取」（拉取会覆盖本项目的 flow 字段，本地目录、发布与草稿设置保留）；解除关联后继续使用本地数据。

## 接口概览

服务端全部走 HTTPS。`GET /api/ping` 为公开健康检查；其余同步接口需 `Authorization: Bearer <令牌>`：`GET /api/info`、`GET /api/sync/projects`、`GET /api/sync/project?id=`、`POST /api/sync/project`、`POST /api/sync/events`。未携带有效令牌返回 HTTP 401 与 `UNAUTHORIZED` 错误码。
