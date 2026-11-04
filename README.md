# OpenViking 团队插件

此 Git 仓库提供 Codex 插件源 `venki-team`，使用 Node.js 18 及以上。员工沿用配置好的个人 OpenViking 连接。

首次使用，在 Codex 里添加管理员提供的公司 Git 插件源，选择「Venki 团队插件」中的「OpenViking 团队版」。已有官方版的员工先确认团队源能看到新版，切换时关闭官方版，只保留团队版启用，避免两份记忆钩子同时同步。完全退出并重开 Codex，按提示信任团队插件需执行的钩子。

要启用用量统计，在 Codex 对话中说「我同意公司按我的个人知识库账号、日期、模型统计这个 Codex 配置中现有及以后的会话 Token 用量，包括输入、缓存、输出和去重标识。帮我用团队插件启用。」输入「查看团队 Codex 用量上报状态」或「停止团队 Codex 用量统计」可以检查或撤销登记。用量报告仅发送统计字段。管理员可在知识库首页查看。

管理员发布新版本后可在 Codex 中刷新公司源。CLI 对应命令为 `codex plugin marketplace upgrade venki-team`。重新启动 Codex 加载新版，按实际提示审阅钩子。首次配置公司 Git 源使用 `codex plugin marketplace add <公司 Git 地址> --ref main` 和 `codex plugin add openviking-memory@venki-team`。Git 地址应由管理员通过可信渠道提供。

当前版本基于 OpenViking 0.11.19，具体改动与上游许可证保存在插件目录。
