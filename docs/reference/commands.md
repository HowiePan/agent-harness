# 命令与问题归属

CLI 主入口：`node bin/agent-harness.mjs`；`--help` 输出所有当前参数。常用入口如下：

```text
agent-harness init create-config|validate|plan|apply|execute
agent-harness dev attach|rebind|execute|verify|doctor|watch|generations|sync
agent-harness dev patch plan|status|apply|rollback
agent-harness config schema|validate
agent-harness docs list|show
agent-harness extension register|list|remove
agent-harness workspace register|list|show|rollback
agent-harness workflow list --project <id>
agent-harness lifecycle plan|preflight|start
agent-harness run status|plan-artifact|schedule|dispatch|submit|gates|decision|close|recover

版本规划的独立审查结束后，Harness 在 Control Root 的 `outputs/<project>/<run>/plan-review.md` 生成审阅稿，并返回路径、规划摘要及文件摘要。此时 `plan` Run 停在 `implementation-plan-user-approval-required`，须先向用户展示 Markdown。用户明确同意该稿后，向同一 Run 写入 `implementation-plan-approved` Decision，字段包括 `actor: "user"`、`decision: "approved"` 及返回的 `projectId`、`runId`、`planDigest`、`artifactDigest`，再关闭规划 Run。独立审查拒绝的稿件不能批准。`implement` 仅接受同项目、目标、Workflow 下当前谱系中已关闭且获用户批准的规划 Run，并核对当前项目源码摘要。聚合仓库中的独立子项目应从拥有者 Project 的工作区快照排除。计划后的源码差异须按计划 Run 的快照证据计算：若所有变化文件均同时位于 Project 明确配置的 `planSourceAutoCompatiblePaths`、已批准的本项目工作包路径和当前实施 Feature 路径内，实施 Run 自动记录前后源码摘要、差异路径及策略摘要；其余差异须经操作员审阅后，使用项目 checkout 中的 `dev plan-source-compatible --manifest <绑定> --run <Plan Run> --decision <review.json> --command-id <唯一 ID>` 写入绑定计划、审阅稿及精确来源摘要的 Decision。Decision ID 为 `implementation-plan-source-compatible/<toSourceDigest>`；旧版固定 ID 仍可读取，新源码差异追加新 Decision，不覆盖旧审阅。后续源码再变化会重新对账，最终 Gate 在当前项目源码上重新执行。

`h:local engine replan <版本>` 修订该项目、Workflow 和目标的现行计划。它读取上一版完整计划及独立审查发现，产出完整替代计划和工作包差异，再走独立审查与新的用户批准。已有计划审查被拒且项目源码已修正时，重新提交普通 `plan` 也可安全替换被拒 Run；旧审查作为审计证据保留。已批准但尚未实施的计划、待批准计划、以及处于空闲边界且无开放 Finding 的实施 Run 可通过显式 `replan` 修订；存在活动 Lease、待处理 Dispatch 或开放 Finding 时分别返回 `REPLAN_IMPLEMENTATION_BUSY` 或 `REPLAN_OPEN_FINDINGS`，不会撤销正在执行或待修复的工作。新计划进入审查后，旧计划批准不得用于启动 `implement`。已发布的版本不能原地 `replan`。

`implement` 遇到验证路径越界时，实施 Agent 先检查构建或测试脚本的输出路由；若修复文件已在本次 `allowedPaths` 内，则在同一 Feature 中改正路由并重跑验证。项目可声明最多两次同 Run 自动重派，重派沿用原有路径、计划及 Gate 绑定。确需写入另一项目、扩大权限、改变需求或进行受保护发布时才停下；不能把验证产物目录直接扩到另一项目来绕过边界。

新增、修改、移除、延期或转移需求时，在项目 `harness.json` 的 `project.input.planChangeRequests` 中登记结构化变更并同步项目绑定，再执行 `h:local engine replan <版本> change:<ID>`。每项包含匹配的 `target`、`kind`（`add|modify|remove|defer|dependency|technical`）、`summary`、`requirements` 和 `acceptance`。变更内容和摘要固定到新 Plan，审阅稿展示变更及与上一版的差异。跨项目需求只作为依赖提案；此命令不会授予另一项目写权限。无变更单的 `replan` 仅用于项目源码变化或修复上次被拒审查，不从聊天历史猜测新需求。首次规划仍使用 `plan`。
agent-harness version-release status|promote
agent-harness source capture|read|search
agent-harness memory query|propose|stage|promote|revoke|reject|recover|export|import
agent-harness issue record|status|list|triage
```

项目初始化默认读取项目仓内 `harness.json`。`init plan` 只读，`init apply` 应用固定计划；安装态 `init execute` 要求外部 `--decision`、唯一 `--command-id` 和当前 Registry 修订。从项目 checkout 执行的 `dev execute` 直接绑定当前 Harness source checkout，无需另行签发 Decision；`dev sync` 一步完成源码变更分类、H0–H3 应用、按需重新绑定与本地 Codex 绑定刷新。从 Harness 侧代项目执行写命令仍需外部 Decision。后续只读 `workflow list`、`lifecycle plan/preflight` 可带 `--development-manifest <json>` 使用该绑定；它不会启用 CLI Agent 执行。H0/H1 可按规则继续当前 Run，H2/H3 要求新 Run，H4 禁止热应用。详细命令、等级与回滚语义见[完整配置 API](./configuration-api.md#8-本地源码调试与热更新)。

写命令使用唯一 `--command-id`；本地 `dev` 命令可自动生成。Project/Workspace 的安装态注册必须通过 `--decision <json-file>` 提供外部 Authority Decision；source-link 项目内调用由应用层生成带 `local-development-invocation` 来源的精确 Decision。新 Workspace 命令包含 `--workspace-id` 或由输入 Plan 固定。多 Flow 的工作区必须明确选择 Workflow。安装态 Codex 使用 `h:<workspace> flow <workflow> <action> <target>`；本地源码模式使用 `h:local <别名> <动作> <目标>` 或 `h:local <别名> flow <流程> <动作> <目标>`。两种 Hook 互不接管对方前缀。`where`、`flows` 和 `report` 的本地命令同样加 `h:local` 前缀。命令绑定只是定位，最终以 Registry 当前精确身份和执行预检为准。

制品和本机插件命令按渠道命名：`npm run pack:core`、`npm run pack:codex`、`npm run pack:opencode`、`npm run pack:vscode`、`npm run check:opencode`、`npm run check:vscode`、`npm run check:codex-host-fast`、`npm run deploy:codex`、`npm run release:codex:check`、`npm run release:codex:prepare`、`npm run release:codex:local -- --prepared <receipt.json>`。OpenCode 与 VS Code 包当前是实验制品：初始化和只读状态可用，生命周期命令在没有完整原生宿主回调时返回 unsupported，不创建 Run 或伪造成功。具体产物和“先准备、后安装”的 Gate 见[渠道打包](./packaging.md)。

升级中若已注册 Extension 的入口迁移，使用 `release activation-plan --extension-replacements <json>` 在激活方案中声明替换。JSON 是 `[{"id":"扩展ID","entry":"控制根内相对入口"}]`；入口须属于已验证的候选制品，并与原 ID、版本一致。`release activation-apply` 仍要求绑定方案摘要的批准 Decision，且会在提交前重新核验入口。

Engine 的开发准出后运行 `h:local engine prerelease <版本>`：该命令读取已批准的 `version-clearance`，按项目仓中的文档范围清单盘点和修复所有现存文档，完成版本身份更新、fresh 最终 Gate 与实际制品构建，并封存候选摘要。用户审核候选后，在已绑定项目 checkout 中提交 `h:local engine release <版本>`；Hook 固定本次候选摘要和修订号，Coordinator 只将该候选状态晋升为 `released`。`version-release status|promote` 保留为底层状态 API，用户无需组合 CLI 脚本或自行构造批准 JSON。晋升不修改源码、文档或制品，也不自动执行 Git push 或对外分发。这里的 `release` 是业务版本状态，区别于 Harness 自身的 `release activation-*`。
