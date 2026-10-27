# ReqFlow 2.13.2

## 主要更新

- 启动时先读取本地备份显示项目，不再等待 Server Agent 联网；远程同步在后台进行。
- 后台连接 Server Agent 期间顶部显示“正在连接 Server Agent…”加载提示；此时操作关联远程的项目会先等待连接完成再保存。
