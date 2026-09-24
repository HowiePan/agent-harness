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
agent-harness run status|schedule|dispatch|submit|gates|decision|close|recover
agent-harness source capture|read|search
agent-harness memory query|propose|stage|promote|revoke|reject|recover|export|import
agent-harness issue record|status|list|triage
```

项目初始化默认读取项目仓内 `harness.json`。`init plan` 只读，`init apply` 应用固定计划；安装态 `init execute` 要求外部 `--decision`、唯一 `--command-id` 和当前 Registry 修订。从项目 checkout 执行的 `dev execute` 直接绑定当前 Harness source checkout，无需另行签发 Decision；`dev sync` 一步完成源码变更分类、H0–H3 应用、按需重新绑定与本地 Codex 绑定刷新。从 Harness 侧代项目执行写命令仍需外部 Decision。后续只读 `workflow list`、`lifecycle plan/preflight` 可带 `--development-manifest <json>` 使用该绑定；它不会启用 CLI Agent 执行。H0/H1 可按规则继续当前 Run，H2/H3 要求新 Run，H4 禁止热应用。详细命令、等级与回滚语义见[完整配置 API](./configuration-api.md#8-本地源码调试与热更新)。

写命令使用唯一 `--command-id`；本地 `dev` 命令可自动生成。Project/Workspace 的安装态注册必须通过 `--decision <json-file>` 提供外部 Authority Decision；source-link 项目内调用由应用层生成带 `local-development-invocation` 来源的精确 Decision。新 Workspace 命令包含 `--workspace-id` 或由输入 Plan 固定。多 Flow 的工作区必须明确选择 Workflow。安装态 Codex 使用 `h:<workspace> flow <workflow> <action> <target>`；本地源码模式使用 `h:local <别名> <动作> <目标>` 或 `h:local <别名> flow <流程> <动作> <目标>`。两种 Hook 互不接管对方前缀。`where`、`flows` 和 `report` 的本地命令同样加 `h:local` 前缀。命令绑定只是定位，最终以 Registry 当前精确身份和执行预检为准。

制品和本机插件命令按渠道命名：`npm run pack:core`、`npm run pack:codex`、`npm run pack:opencode`、`npm run pack:vscode`、`npm run check:opencode`、`npm run check:vscode`、`npm run check:codex-host-fast`、`npm run deploy:codex`、`npm run release:codex:check`、`npm run release:codex:prepare`、`npm run release:codex:local -- --prepared <receipt.json>`。OpenCode 与 VS Code 包当前是实验制品：初始化和只读状态可用，生命周期命令在没有完整原生宿主回调时返回 unsupported，不创建 Run 或伪造成功。具体产物和“先准备、后安装”的 Gate 见[渠道打包](./packaging.md)。

升级中若已注册 Extension 的入口迁移，使用 `release activation-plan --extension-replacements <json>` 在激活方案中声明替换。JSON 是 `[{"id":"扩展ID","entry":"控制根内相对入口"}]`；入口须属于已验证的候选制品，并与原 ID、版本一致。`release activation-apply` 仍要求绑定方案摘要的批准 Decision，且会在提交前重新核验入口。
