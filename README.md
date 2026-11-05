# OpenViking 知识库插件

员工用已有的个人 OpenViking 账号连接公司知识库。启用工作记忆后，当前 Codex 可以把对话中确认的长期工作偏好、项目决定和规范整理成简短条目，存到本人知识库的 `memories`。本人和获授权的知识库管理员可以查看。GitHub 只分发插件代码，安装和更新可匿名完成。

## 在 Codex 里启用

已配置好个人知识库连接的员工，可以把下面这句话粘贴到 Codex。首次安装和从旧版升级都可以用。

> 请按 https://github.com/venkiliu/mcp 的说明安装或更新公司 OpenViking 插件，并启用工作记忆。我同意由当前 Codex 把我在今后对话中确认的长期工作偏好、项目决定和工作规范存到本人的公司知识库，供本人和获授权的管理员查阅。

接手的 Codex 使用当前系统用户及当前 Codex 配置，确认已安装 Node.js 18+，检出本仓库的最新 `main` 后运行：

```sh
node scripts/team-setup.mjs --confirm-work-memory --source https://github.com/venkiliu/mcp.git
```

脚本会检查已有个人身份并备份插件配置。新版本安装完成后，按 Codex 的提示审阅插件权限，重开 Codex，在新对话中使用。例如，对它说“以后我的工作交接表固定列出负责人和截止日期”。随后可以在知识库文件系统查看自己的 `memories`，也可以在新对话中问“我的交接表需要哪些字段？” 已保存的内容可以在后续对话中更正。同一条信息无需反复保存。是否值得记录由当前 Codex 判断，每轮聊天不一定产生条目。

随时可以在 Codex 里说“查看我的 OpenViking 工作记忆开关”或“停止自动保存工作记忆”。停用后，已保存的条目仍可查阅。员工各自在自己的 Codex 配置里启用；服务器沿用原有知识库和向量检索。

## 用量统计与后续更新

Codex Token 用量统计是另一个独立选项。如果也需要启用，员工可另外说明“我同意把此 Codex 配置已有和今后的输入、缓存、输出 Token 数及会话去重标识，按个人知识库账号、日期和模型上报公司知识库，供管理员查看”。只授权工作记忆时用 `--confirm-work-memory`；只授权用量统计时用 `--confirm-usage`；员工选择两项时才同时传入这两个参数。

以后对 Codex 说“帮我更新公司 OpenViking 插件”即可。对应的更新命令为 `codex plugin marketplace upgrade venki-team`。工作记忆和用量统计分别保存启用状态。插件在市场中的名称为“OpenViking 团队版”，版本基于上游 OpenViking Memory 0.11.19。
