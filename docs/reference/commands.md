# 命令与问题归属

CLI 主入口：`node bin/agent-harness.mjs`；`--help` 输出所有当前参数。常用入口如下：

```text
agent-harness extension register|list|remove
agent-harness workspace register|list|show|rollback
agent-harness workflow list --project <id>
agent-harness lifecycle plan|preflight|start
agent-harness run status|schedule|dispatch|submit|gates|decision|close|recover
agent-harness source capture|read|search
agent-harness memory query|propose|stage|promote|revoke|reject|recover|export|import
agent-harness issue record|status|list|triage
```

写命令使用唯一 `--command-id`；有当前记录时使用 `--expected-revision`。新 Workspace 命令包含 `--workspace-id` 或由输入 Plan 固定。多 Flow 的工作区必须明确选择 Workflow。Codex 适配器支持 `h:<workspace> flow <workflow> <action> <target> [--project <id>|--projects <ids>]`；旧 `h:engine`、`h:collection` 是兼容别名。`h:where` 查看绑定，`h:flows` 列出流程，`h:report <workspace> --workflow <id>` 将问题归到工作区和流程；安装级故障可无 Run 报告。命令绑定只是定位，最终以 Registry 当前精确身份和执行预检为准。
