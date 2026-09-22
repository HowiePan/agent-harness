# 本地源码调试模式

`source-link` 让真实项目直接使用当前 Agent Harness checkout，无需每次打包、卸载、重装。它只放宽开发态制品来源，不放宽 Authority、路径、Gate、宿主证明或执行授权。完整字段和命令见[配置 API](../reference/configuration-api.md#8-本地源码调试与热更新)。

## 建立绑定

在业务项目目录执行：

```text
node <Harness源码根>/bin/agent-harness.mjs dev execute \
  --config ./harness.json \
  --project-root . \
  --binding-id <项目别名> \
  --command-id dev-init-001 \
  --decision ./decision.json
```

命令生成 `development-source-manifest`，分别固定 Runtime 文件摘要与文档/测试支持文件摘要，在 Harness 控制根保存 Runtime generation 快照，注册 source-link Extension 和 Project Descriptor，并返回 Init Receipt。本机源码绝对路径只存在控制根，不写入项目配置。

## 变化检测与应用

```text
agent-harness dev verify --manifest <manifest.json>
agent-harness dev doctor --manifest <manifest.json>
agent-harness dev patch status --manifest <manifest.json>
agent-harness dev watch --manifest <manifest.json>
agent-harness dev patch plan --manifest <manifest.json> > patch-plan.json
agent-harness dev patch apply --manifest <manifest.json> --plan patch-plan.json --command-id patch-001 --decision ./decision.json
```

不再采用“任何变化都停止并从头开始”的绝对规则：

| 级别 | 范围 | 处置 |
|---|---|---|
| `H0` | 文档、样例、测试 | 立即记录并继续当前 Run，无需 rebind/Decision。 |
| `H1` | 只影响未来计划的 Flow graph/Node template | 批准 rebind；当前 Run 的已冻结 Feature/Plan 继续，新 Run 使用新摘要。 |
| `H2` | Profile、Planner、Gate、Workflow 平台、业务变体 | 不能安全注入旧 Run；重启并新建 Run。 |
| `H3` | Application、CLI、Runtime、宿主集成 | 重启并新建 Run。 |
| `H4` | Kernel、Authority、持久化、关键 Schema、Registry/Recovery | 禁止热应用，必须显式迁移或走新 Release。 |

H1 可以提升日常调试速度，但不允许重写已派发任务。当前协调进程保持原先已加载模块；补丁只为后续编译和新 Run 注册新制品摘要。补丁计划列出活动 Run、Lease、Dispatch、每个文件的等级和明确 continuation，应用后写 `development-patch-receipt`。

## generation 与回滚

```text
agent-harness dev generations --manifest <manifest.json>
agent-harness dev patch rollback --manifest <manifest.json> --target-manifest <generation-manifest.json> --command-id rollback-001 --decision ./decision.json
```

Runtime generation 位于 Harness 控制根。Rollback 只切换已验证绑定，要求 checkout 已恢复到目标摘要；工具不会擅自改业务代码或 Harness 源码。

## 修复权限边界

项目 Run 始终只能写其执行目标，不能同时获得 Harness 源码写权限。维护者可以在独立 Harness maintenance 上下文修复源码，再生成 patch plan；H0/H1 按上表继续，H2–H4 必须停止旧执行路径。不得沿用已经失效的 Plan、预检、Lease 或 Runtime Receipt。

source-link Receipt 带开发态标记，不能作为正式发布、签名或生产 cutover 证据；也不能自动提交、发布、删除或迁移旧 Harness。
