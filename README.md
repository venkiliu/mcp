# OpenViking 团队插件

本仓库提供 Codex 插件源 `venki-team`，插件名为「OpenViking 团队版」，使用 Node.js 18 及以上。

员工可以直接从这个公开仓库安装和更新插件，无需登录 GitHub。已配置个人 OpenViking 连接的员工，在 Codex 中粘贴下面这句话即可。

> 请按 https://github.com/venkiliu/mcp.git 的团队接入说明，把我的 OpenViking 切换到团队版。我同意按个人知识库账号、日期和模型将此 Codex 配置现有和今后的输入、缓存、输出 Token 数及会话去重标识上报到公司知识库，供管理员查看。

接手的 Codex 应读取本说明，确认现有个人 OpenViking 配置和当前运行环境，检出管理员提供的 Git 仓库，在仓库根目录运行 `node scripts/team-setup.mjs --confirm-usage --source https://github.com/venkiliu/mcp.git`。脚本沿用本人的知识库连接，备份 Codex 配置，安装团队版并登记用量统计，成功后停用官方版，检查实际插件状态。员工按 Codex 实际提示允许团队 hooks，完全退出并重开 Codex 后完成一次日常会话。

若当前 Codex 已登记 `venki-team` 插件源，可以省略 `--source`。这个参数只接受 Git URL。配置切换失败会恢复原有两个插件开关并说明原因，其他程序同时修改的配置会保留。若提示残留锁，接手的 Codex 应确认锁内 PID 已退出、检查两个插件当前状态，删除指明的锁文件再重试。

管理员发布新版本后，员工可以在 Codex 中说「帮我更新公司的 OpenViking 团队插件」。对应命令为 `codex plugin marketplace upgrade venki-team`，随后重新启动 Codex 加载新版，并按实际提示审阅 hooks。

安装后可对 Codex 说「查看团队 Codex 用量上报状态」或「停止团队 Codex 用量统计」。统计报告包含上面列出的字段，管理员可在知识库首页查看。查询状态中的 `lastRun: null` 表示尚未观察到真实 hook 成功上报。

当前版本基于 OpenViking 0.11.19，具体改动与上游许可证保存在插件目录。仓库不包含员工凭据。
