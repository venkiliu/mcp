# OpenViking 官方 Codex 插件接入

员工继续使用自己电脑上已配置的 OpenViking 服务地址和个人密钥。这个公开仓库仅作为旧安装地址的兼容入口，插件从[火山引擎官方 OpenViking 仓库](https://github.com/volcengine/OpenViking/tree/main/examples/codex-memory-plugin)获取。

已配置知识库的员工，在 Codex 中粘贴一句话即可：

> 请将我的 OpenViking 插件切换到 volcengine/OpenViking 的官方更新源，沿用现有知识库地址和个人身份。先验证官方插件可用，再停用原公司插件，让我知道是否需要重开 Codex 和审阅官方钩子。

## 切回官方源

Codex 可以使用以下命令。安装并核对官方插件后，只保留官方实例启用，避免重复同步。保留员工现有的个人 OpenViking 配置。

```sh
codex plugin marketplace add https://github.com/volcengine/OpenViking.git --ref main --sparse .agents/plugins --sparse examples/codex-memory-plugin
codex plugin add openviking-memory@openviking
codex plugin list --json
```

如果先前安装过 `openviking-memory@venki-team`，在官方实例启用后，从插件页停用它。重新打开 Codex，按提示审阅与知识库同步有关的官方钩子。

以后在 Codex 中说“更新官方 OpenViking 插件”，或运行：

```sh
codex plugin marketplace upgrade openviking
```

仍订阅此兼容入口的设备可先刷新 `venki-team` 源，获取官方插件内容；直接使用官方源的设备无需保留此入口。安装插件和打开知识库是两步，员工使用原来的个人密钥连接公司的知识库。
