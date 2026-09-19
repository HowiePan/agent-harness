# Workspace 平台实施与操作记录

> 2026-09-19。适用于 V1.0.0 当前工作树。开发方案见 [Workspace 平台最终开发方案](./workspace-platform-development-plan.md)。本记录描述代码能力与合成验证；真实业务 Run、旧状态迁移、Git 提交和发布不由合成 Canary 代替。

## 已实现的边界

`Workspace Descriptor` 是新工作区的唯一配置来源，`Workflow Definition` 仍由独立 Extension Pack 提供。Descriptor 精确绑定 Workflow ID、版本、制品摘要、Extension、Profile、允许的成员项目、默认项目范围与执行目标。一个 Workspace 可绑定多条流程；不同 Workspace 可复用同一 Workflow Definition。

Workspace Registry 位于全局 `dataRoot/registry/workspaces/<workspaceId>`，采用不可变修订文件和原子活动指针。写入需要 `expectedRevision`、幂等 `commandId` 和与前后 Descriptor 摘要匹配的未过期 `workspace-register` Authority Decision。别名和成员项目在全局唯一；不同 Workspace 的执行目标不得重叠。来源与执行目标拒绝符号链接或 Windows junction。回滚把已保存的旧 Descriptor 内容作为新修订激活，不改旧 Run。

新运行状态位于 `dataRoot/workspaces/<workspaceId>`。`ws.<workspaceId>.<executionTargetId>` 是只读 Project 兼容投影，旧 Project Registry 文件不被搬动或改写。`workspaceFromProjectDescriptor()` 可以把单 Profile、单 Workflow 的旧 Descriptor 显式转换成一对一 Workspace Descriptor；Engine、Collection 在命令级 Canary 中分别这样运行。

`createWorkspaceLifecyclePlan()` 从 Registry 解析别名、Workflow、成员项目、执行目标、Source Manifest 和 Resource Binding；调用方不能注入 `sourceManifest`、`memorySpaces` 或 `memorySnapshot`。Plan、Authority 元数据、Dispatch Packet、Evidence 和 Run Closure Receipt 固定 Workspace 修订、Workflow 和项目范围。逻辑任务键纳入 Workspace 和项目范围。Plan 创建后 Workspace 变更会阻断旧 Plan 启动；已创建 Run 保留旧快照，但每次 Dispatch、来源读取及 Runtime 控制前检查当前来源、资源、项目和 Runtime 权限。

首个 Resource Provider 是版本化 `reference-memory-store@1.0.0`。新 Provider 可由已验证的 Extension Pack 注册。Workspace 模式公开的记忆 API 经 Resource Broker 检查绑定和 Run 身份；工作区通用、项目、流程、来源与会话资源使用不同空间。知识记录可声明 `coverageSourceIds` 和 `coverageDigest`，来源集合或其绑定内容变化后，全范围结论成为 `recheck-required`，未变文件事实仍可复用。持久知识的候选、证据、核验、撤销、Effect 恢复和 Git 导出沿用 MemoryStore 合同。

## 命令与 SDK

CLI：

```text
agent-harness workspace register --input descriptor.json --expected-revision 0 --command-id <id> --decision decision.json
agent-harness workspace list
agent-harness workspace show --workspace-id <id>
agent-harness workspace rollback --workspace-id <id> --revision <old-revision> --command-id <id> --decision decision.json
agent-harness lifecycle plan --input workspace-command.json
agent-harness lifecycle preflight --workspace-id <id> --plan plan.json
agent-harness lifecycle start --workspace-id <id> --plan plan.json --preflight preflight.json --command-id <id>
```

SDK 调用：`createHarness({ controlRoot, dataRoot, workspaceId, extensions })`，然后 `harness.createWorkspaceLifecyclePlan({ workspaceId, workflowId, projectIds, action, target, workflowInput })`。`projectIds` 省略时使用绑定的 `defaultProjectScope`；无唯一 Workflow 或空默认范围会在创建 Run 前拒绝。`workflowInput` 只携带流程参数，例如问题会话与修订、需求文档输出路径。

Codex 插件绑定增加 `--workspace <alias>|<workspace-id>|<execution-target-id>|<absolute-root>`，并用现有 `--workflow <alias>|<workflow-id>|<version>|<artifact-digest>|<profile-id>|<extension-id>` 绑定精确流程。旧 `--project` 绑定继续有效。命令格式：

```text
h:engine full V3.8.4
h:collection full B1
h:alpha flow requirements-design analyze audit-trail
h:alpha flow knowledge-qa ask audit-trail --project alpha-front
h:alpha flow knowledge-qa ask audit-trail --projects alpha-front,alpha-back
h:flows alpha
h:where alpha
h:report alpha --workflow knowledge-qa
```

安装绑定只用于定位和预选；Coordinator 再核对当前 Workspace Registry 的别名、目标、Workflow 版本与摘要。`h:report` Issue Intake 支持 Workspace ID、别名、成员项目范围及可核实的修订摘要；安装级故障仍能在不启动 Run 的情况下报告。

## 显式迁移与变更

1. 对旧 Project/记忆做只读 Inventory，记录 Project Descriptor 修订、Run、Source、记忆空间及证据。不得自动合并不同 `domainId` 或自然语言同名知识。
2. 安装并批准精确 Extension/Workflow 制品；用 `workspaceFromProjectDescriptor()` 或人工 Descriptor 注册新 Workspace。为每个项目列出 Source、执行目标和 Resource 的读写范围。
3. 用新的 Workspace 绑定配置命令入口，先在合成来源运行 `npm run workspace:canary`，再对目标 Workspace 做只读预检。旧 Authority 路径保持审计可读，不自动迁移或删除。
4. 增仓、改权限或切换流程只提交新的 Workspace 修订。已启动 Run 固定旧修订；撤权在下一次 Dispatch 生效。回滚使用 `workspace rollback`，产生新修订；不能靠修改活动 JSON 或覆盖旧修订实现。
5. 需要导入旧知识时，明确指定源空间、目标 Resource、项目范围及证据；Git 导入一律为未核验状态，再由当前 Run 的 Submission 和核验者提升。

## 验证准出

`npm run workspace:canary` 先运行既有 Workflow Canary，再通过 `parsePseudoCommand → Workspace Registry/Workflow Binding → Plan → 预检 → Run → Dispatch/Submission → Gate/Decision → close` 跑两个 Workspace 的同一知识问答流程、前后端需求设计，以及 Engine/Collection 的 Workspace 兼容映射。所有正向合成 Run 必须为 `closed`。Canary 还检查命令歧义、跨域记忆拒绝、项目知识隔离、增仓覆盖失效、旧 Run 来源快照、来源漂移、Provider 摘要不匹配、资源撤权、配置竞态、Effect 恢复和回滚继续执行。

回归准出还需 `npm test`、`npm run test:conformance`、`npm run check`、`npm run check:clean-room`、`npm run check:residue`、`npm run pack:dry-run` 与 `git diff --check`。合成闭环只说明 Harness 协议、状态机及打包代码可运行；真实 Codex Host 对真实仓库的执行质量、真实业务 Gate、外部发布和旧 Run cutover 仍须现场验证。

### 2026-09-19 代码 Gate 结果

| 检查 | 结果 |
| --- | --- |
| `npm run workspace:canary` | 8 条 Workspace 命令 Run 全部 `closed`：Engine、Collection、Alpha 需求设计、Alpha 前端问答、Beta 问答、Alpha 后端问答、Alpha 增仓问答、Alpha 撤权后回滚续跑。脚本先运行的既有 Workflow Canary 另有 7 条直接 Run 和 2 条并行实例 Run，均为 `closed`。 |
| `npm test` | 212/212 通过。 |
| `npm run test:conformance` | 3/3 通过；进程型 Runtime 需允许子进程的执行环境。 |
| `npm run check`、`npm run check:clean-room` | 均通过；净室从本地 tarball 安装，验证独立 Control Root 与 Extension 重启后的制品绑定。 |
| `npm run pack:dry-run`、`npm run check:residue`、`git diff --check` | 均通过；无临时目录残留。 |

以上为合成数据上的代码准出。没有启动或改写真实 CardWorld、Collection 及其他业务 Run，也没有执行旧状态 cutover、Git commit/tag、插件重装或外部发布。
