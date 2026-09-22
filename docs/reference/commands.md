# 命令与问题归属

CLI 主入口：`node bin/agent-harness.mjs`；`--help` 输出所有当前参数。常用入口如下：

```text
agent-harness init create-config|validate|plan|apply|execute
agent-harness dev attach|rebind|execute|verify|doctor|watch|generations
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

项目初始化默认读取项目仓内 `harness.json`。`init plan` 只读，`init apply` 应用固定计划；`init execute` 在同一进程顺序完成两者，但仍要求外部 `--decision`、唯一 `--command-id` 和当前 Registry 修订。`dev execute` 直接绑定准确的 Harness source checkout，生成 development source manifest 和 Runtime generation。源码变化后先用 `dev patch status/plan` 分类：H0/H1 可按规则继续当前 Run，H2/H3 要求新 Run，H4 禁止热应用。详细命令、等级与回滚语义见[完整配置 API](./configuration-api.md#8-本地源码调试与热更新)。

写命令使用唯一 `--command-id`；有当前记录时使用 `--expected-revision`。Project/Workspace 注册必须通过 `--decision <json-file>` 提供外部生成、未过期且绑定准确动作上下文的 Authority Decision；CLI 或宿主不得从 `--actor`、当前用户名或默认身份自行生成批准。新 Workspace 命令包含 `--workspace-id` 或由输入 Plan 固定。多 Flow 的工作区必须明确选择 Workflow。Codex 适配器支持 `h:init --decision <file> [--config <file>] (--source <root>|--entrypoint <cli>)` 和 `h:<workspace> flow <workflow> <action> <target> [--project <id>|--projects <ids>]`；`h:engine`、`h:collection` 分别绑定 Legacy CardWorld/Collection Extension，不是中立 Flow 的别名。`h:where` 查看绑定，`h:flows` 列出流程，`h:report <workspace> --workflow <id>` 将问题归到工作区和流程；安装级故障可无 Run 报告。命令绑定只是定位，最终以 Registry 当前精确身份和执行预检为准。

制品和本机插件命令按渠道命名：`npm run pack:core`、`npm run pack:codex`、`npm run pack:opencode`、`npm run pack:vscode`、`npm run check:opencode`、`npm run check:vscode`、`npm run check:codex-host-fast`、`npm run deploy:codex`、`npm run release:codex:check`、`npm run release:codex:prepare`、`npm run release:codex:local -- --prepared <receipt.json>`。OpenCode 与 VS Code 包当前是实验制品：初始化和只读状态可用，生命周期命令在没有完整原生宿主回调时返回 unsupported，不创建 Run 或伪造成功。具体产物和“先准备、后安装”的 Gate 见[渠道打包](./packaging.md)。

升级中若已注册 Extension 的入口迁移，使用 `release activation-plan --extension-replacements <json>` 在激活方案中声明替换。JSON 是 `[{"id":"扩展ID","entry":"控制根内相对入口"}]`；入口须属于已验证的候选制品，并与原 ID、版本一致。`release activation-apply` 仍要求绑定方案摘要的批准 Decision，且会在提交前重新核验入口。
