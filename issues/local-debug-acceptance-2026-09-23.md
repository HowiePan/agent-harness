# V1.0.0 本地源码调试验收口径（2026-09-23）

## 范围

本轮把 `source-link` 开发态的可用性与 Codex 插件真实宿主验收分开记录。G2 仍是不可变安装制品的真实 Codex collaboration 质量 Canary，未通过；其现场故障已登记为 `AH-20260923-19EAAB8C220E`，留待需要验证打包插件时继续定位。此调整不把 G2 改写为已通过，也不允许恢复 CardWorld/V3.8.4/Collection 真实 Run。

本地调试验收只覆盖当前 Harness checkout、隔离合成项目和开发态制品身份；不代表真实 Codex Agent、业务质量或发布准出。

## 本地调试通过条件

1. `dev execute` 在 Git 工作区上生成可验证的 development manifest、Runtime generation、source-link Extension 注册和 Project Descriptor，返回绑定摘要与 Init Receipt；缺少 Git 元数据应在 Registry 写入前拒绝。
2. `dev verify`、`dev doctor` 和显式 `--development-manifest` 的 `workflow list`、`lifecycle plan` 可读取同一源码身份。源码、控制根或数据根漂移必须拒绝。
3. 对合成质量 Plan 执行动作级预检；没有可信可见 Host Adapter 时，应给出明确能力缺失，且不创建 Run。CLI 不借开发态标志取得 Agent 执行权。
4. 同一源码的合成可见 Host 测试完成已知 Finding 的评审、验证型修复、全量复审、最终 Gate 和 Authority Closure，并覆盖重启续接。合成 Host 结果只证明 Harness 协议路径。
5. `npm run check`、相关回归测试、完整测试和工作区 Canary 通过；报告分别列出 source-link、合成闭环和真实宿主证据，不将某一层替代另一层。

## 当前宿主待办

本机已安装并信任 `agent-harness-codex@agent-harness-local` 的 Hook，`list_agents` 原生调用也正常返回，但没有新的 `PostToolUse` 阶段或 Host 响应，交换以 `CODEX_HOST_HOOK_RESPONSE_TIMEOUT` 停止。现有证据不能区分 Desktop Hook 配置刷新、会话装载和宿主专用工具路由。后续打包插件验收须先复现最短原生请求/响应，再执行 G2 的完整合成质量闭环；不得用人工响应填充或本地调试合成结果代替。

## 本轮验收结果

- 本地 `source-link` 功能按上述口径通过。隔离合成项目的 `dev execute`、`dev verify`、`dev doctor`、`workflow list`、质量 `lifecycle plan` 均成功；错误数据根被 `DEVELOPMENT_MANIFEST_ROOT_MISMATCH` 拒绝。绑定的 Runtime 制品摘要为 `34a90460d6e159613ac0b3756be821ac0b58d5c1bac632c62bf317d3c2247e05`，源码摘要为 `b9b65024e560dea7c1221b13d0c8d7aea1ed0c48131f6a9ddd2db1da3265506a`。Init Receipt 摘要为 `ba14f4737ebf66dc6a7e77b96fbf8f5d6af782b90f08d8857c1b05b3f0258a6f`。
- 同一质量 Plan 的动作预检返回 `executionReady=false`，仅 `visible-host` 与 `visible-host-contract` 两项未就绪，分别为 `VISIBLE_AGENT_HOST_COORDINATOR_UNAVAILABLE` 和 `VISIBLE_AGENT_HOST_CONTRACT_UNAVAILABLE`；未启动 Authority Run。CLI 对带 `--development-manifest` 的 `lifecycle start` 明确拒绝。
- 合成可见 Host 质量闭环及重启回归 10/10 通过；完整测试 314/314、`npm run check` 与 `npm run workspace:canary` 通过。最后的源码命名与文档调整后，重新生成 release metadata，并再次通过 `npm run check` 和 source-link / project initialization 定向测试 5/5。
- 真实 Codex 宿主 G2 **未通过**，问题保持 `Pending Triage`。上述结果只准出 Harness 本地源码调试能力，不构成真实 Agent 执行、打包插件或业务质量准出。
