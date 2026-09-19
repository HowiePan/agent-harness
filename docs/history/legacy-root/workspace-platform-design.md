# Harness Workspace 顶层边界设计（2026-09-19）

> 状态：已确认的下一阶段设计，尚未实现。本文修正此前把“工作区”仅用于知识库的表述；现有 Project Descriptor 和 `h:<项目别名>` 仍按旧合同运行。开发顺序与最终 Gate 见[最终开发方案](./workspace-platform-development-plan.md)，现有命令见[流程平台实现记录](./workflow-platform-implementation.md)。

## 一、核心决定

**Harness Workspace 是业务与运行的顶层归属、隔离和配置边界。** 工作区选择可用流程，可以包含一个或多个逻辑项目；同一流程定义可以被不同工作区独立绑定。工作区拥有来源、执行目标、策略、运行记录、问题归属，以及包括知识库在内的可扩展资源。知识不是单独平行于 Project 的第二套工作区。

现有 `Project Descriptor` 已经承担了部分工作区职责：它绑定 Profile/Extension/Workflow、策略、Gate 和单个 `workspace.root`。新模型应将其提升为 Workspace Descriptor，并把物理目录从顶层身份中拆出。长期维持语义重叠的 `Project ID` 与 `Workspace ID` 两个顶层命名空间，会让启动、共享与恢复产生歧义；旧 `projectId` 仅作为迁移兼容身份，不成为新模型的第二个顶层入口。

### 流程配置与工作区配置分离

两者必须是**独立制品、独立版本和独立审批对象**，通过工作区中的 Workflow Binding 组合，不能把某个工作区的仓库路径、知识地址或项目名单写进通用流程定义。

| 配置 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| Workflow Definition / Extension | 节点与控制图、输入输出端口、动作、模板和 Profile 引用、所需能力及可配置参数 Schema；固定版本和制品摘要 | 具体工作区别名、仓库路径、成员项目、记忆库地址和某次 Run 的输入 |
| Workspace Descriptor | 稳定 Workspace ID、项目/来源/执行目标、资源绑定、权限、允许使用的流程版本及工作区策略；通过 Binding 填写流程允许的参数 | 修改所绑定流程的节点语义，或以同名动作暗中替换流程制品 |
| Run Plan | 固定本次 Workspace Descriptor 摘要、Workflow Definition/Extension 摘要、项目范围、Source Manifest、资源快照和输入 | 静默跟随任一配置的后续更新 |

Workflow Binding 使用 `workflowId + version + artifactDigest` 精确引用已批准流程，并校验该流程声明的能力要求和参数 Schema。流程定义更新不自动改工作区绑定；工作区增仓库、增项目或调整资源也不改变流程制品。仅当绑定修订获批准后，新 Run 才使用新组合。工作区参数只能填入流程显式开放的槽位；若改变节点顺序、分支、Gate 或关闭语义，必须发布新的流程定义/Extension 摘要。两个工作区可固定同一流程版本而使用不同项目和来源；同一工作区也可同时绑定旧流程和新流程。

```text
WorkspaceAlias → WorkspaceId@DescriptorRevision#Digest
                        ├─ MemberProjectId[]
                        │    ├─ SourceId[]（仓库、文档等）
                        │    └─ ExecutionTargetId[]（受管输出/执行目录）
                        ├─ WorkflowId@Version#Digest[]
                        ├─ ResourceBinding[]（知识、索引、制品目录等）
                        └─ RunId → Feature/Dispatch/Submission/Gate/Decision/Evidence
```

这里的 **Workspace** 是逻辑业务边界；**Member Project** 是该边界内有独立来源、实现和项目级资源的子域；**Source** 是一份可固定摘要的仓库或文档；**Execution Target** 是实际运行或写输出的路径。`workspace.root` 与 Git worktree 仍是物理执行目标，不能继续用它们的路径充当逻辑 Workspace ID。一个项目只能归属一个 Workspace；同一只读仓库若供多个 Workspace 使用，需要在各自工作区建立独立、获授权的 Source 绑定。跨 Workspace 写入仍受全局输出准入控制。

## 二、配置合同草图

```yaml
schemaVersion: '1.0'
workspaceId: product-a              # 稳定身份；重命名别名或新增仓库不改变它
revision: 7                         # expected revision + command ID 原子更新
alias: product-a
projects:
  - projectId: frontend
    sources: [web-repo, ui-spec]
    executionTargets: [web-output]
  - projectId: backend
    sources: [api-repo, service-spec]
    executionTargets: [api-output]
sources:                            # 每项绑定类型、根、revision、允许路径/接收方
  - sourceId: web-repo
    ownerProjectId: frontend
    type: repository
  - sourceId: api-repo
    ownerProjectId: backend
    type: repository
workflows:
  - workflowId: requirements-design
    version: 1.0.0
    artifactDigest: '<approved digest>'
    allowedProjectIds: [frontend, backend]
    defaultProjectScope: [frontend, backend]
  - workflowId: knowledge-qa
    version: 1.0.0
    artifactDigest: '<approved digest>'
    allowedProjectIds: [frontend, backend]
resources:
  - resourceId: business-knowledge
    kind: knowledge
    scope: workspace
    providerRef: '<approved provider>'
  - resourceId: frontend-knowledge
    kind: knowledge
    scope: project
    projectId: frontend
    providerRef: '<approved provider>'
  - resourceId: backend-knowledge
    kind: knowledge
    scope: project
    projectId: backend
    providerRef: '<approved provider>'
```

这是**合同草图，不是当前 Schema**。实际 Descriptor 还须固定 Extension/Profile、Runtime、Model/Tool 接收权限、Gate Recipe、输出冲突键、保留与 Git 导出策略，并绑定完整制品摘要。工作区变更经 Authority 批准并以 expected revision、幂等 command ID 和原子写入提交。安装别名指向 Workspace ID，不靠当前目录或仓库名猜工作区。

工作区可以配置多条流程；流程绑定声明允许的项目集合、默认项目范围、所需来源和资源能力。一个 Run 必须明确固定 `workspaceId`、Workspace Descriptor 摘要、Workflow Ref、目标 `projectIds`、Source Manifest、资源快照与输出目标。跨项目前后端流程在一个 Workspace 内读取共享知识以及获授权的前后端项目知识；只针对前端的流程默认只读共享知识与前端项目知识。没有无条件“读取工作区所有项目”的隐式规则。

## 三、统一资源边界

为将来增加知识库之外的能力，在 Workspace Descriptor 中引入版本化 **Resource Binding**，而非在 Kernel 为每一种业务资源增加专用字段。绑定的最小合同为 `resourceId/kind/scope/owner/providerRef/schemaVersion/artifactDigest/accessPolicy/lifecyclePolicy`；scope 首先有 `workspace`、`project`、`workflow`、`run/session`，来源专属资源再绑定 `sourceId`。具体 Provider 通过已批准 Extension 注册自己的 Schema、快照、查询、写入 Effect 与恢复规则；Core 只统一身份、作用域、授权、版本固定、审计和生命周期，不执行任意资源内部代码。

知识库是第一种资源：一个 Workspace 可有一份业务通用知识，多个 Member Project 各有实现知识，必要时另设流程/来源/会话知识。项目知识不会自动提升到工作区通用知识；提升必须检查出处、访问范围、验证状态和冲突。索引、制品目录、需求条目库等未来资源可复用同一归属/授权机制，但 Authority、Evidence、Decision 等核心权威对象仍由 Kernel 管理，不能交给可插拔资源 Provider 改写。资源和索引物理上仍位于 Standalone Control Root 的受管地址内；可配置的 Git 地址只是获准数据的导出/交换目标，不决定身份或权限。

**默认跨工作区拒绝共享。** 即使两个工作区绑定同一 Workflow Definition、同一模型或同一物理 Git 仓库，也不能相互查询资源。确需复用知识时使用显式导出、导入、重新验证与授权；不能把多个工作区加入一个隐含的全局 common 空间。资源查询必须从 Workspace Registry 解析获准绑定，不能接受调用方自由传入 `memorySpaces` 来绕过工作区配置。派生内容继承来源中最严格的可见范围。

## 四、增量变化与旧 Run

新增项目、仓库、文档或资源只增加 Workspace Descriptor 修订，保持 Workspace ID。新 Run 固定新修订并采集新的 Source Manifest；旧 Run 继续以其原定义和来源快照审计，不能因新配置而静默换来源、流程或记忆。新仓库可单独建索引和提取候选知识，无须重读所有未变化文件。

失效规则须区分两类知识：

1. **精确依赖事实**：记录引用的文件摘要未变时，仍可保持“来源未变”；若依赖文件变化，标记待重验。
2. **覆盖范围结论**：例如“所有仓库都没有此功能”“仅后端实现了 X”。这类记录除文件依赖外，还必须固定检索过的 `sourceSetDigest`、路径范围和查询策略。新增仓库或扩大可读路径时，即使旧文件都没变，也必须重验覆盖结论。

删除项目、撤销来源权限和跨工作区移动不是普通新增：新 Dispatch 必须重新检查有效权限；已发给 Agent 的内容需记录披露范围并按策略收容活跃 Lease。不能因为旧 Run 固定快照就继续向已撤权的 Runtime 外发内容。项目从一个 Workspace 转到另一个 Workspace 走显式迁移/导入，不直接搬运项目记忆和旧准出结论。

## 五、入口与归属

命令前缀中的别名改为 **Workspace Alias**。若某别名仅有一条适用流程和唯一默认项目范围，保留 `h:engine full V3.8.4`、`h:collection quality B1 all`。多流程仍显式选流程；多项目目标若没有唯一默认范围，也须显式选项目，不能由 cwd 或目标字符串猜测。

```text
h:engine full V3.8.4                                   # 兼容：engine Workspace 的默认流程/项目范围
h:product-a flow knowledge-qa ask Q123                 # 明确 Workspace 与 Workflow
h:product-a flow requirements-design analyze F123 --projects frontend,backend
h:report product-a --workflow knowledge-qa [--run <run-id>]
```

以上是**拟议语法，不是当前可执行命令**。程序化入口对应显式 `workspaceId/workflowId/projectIds/action/target` 字段。`h:where`/流程列表须展示别名、Workspace ID、可用流程、项目范围与配置修订；Issue Intake、状态、Receipt、日志和运维检索均至少可按 `workspaceId/workflowId/runId` 定位，项目级故障再带 `projectId`。绑定或 Registry 损坏时，安装级维护入口仍应能记录带验证状态的归属线索，不能扫描磁盘猜工作区。

## 六、与现状的迁移

1. 新增 Workspace Registry、Descriptor 和资源绑定合同，先为每个现有 Project 建 **一对一兼容 Workspace**；旧别名和命令行为保持。Engine、Collection 各自映射到独立 Workspace，默认没有共同资源。
2. 新 Run 使用 `workspaceId + workflowId + projectIds + descriptorDigest` 派生逻辑任务键和授权上下文；旧 Run 保留原 `projectId` Authority 路径、Plan/Receipt 与固定 Extension，按旧协议恢复/审计，不原地重写身份。
3. 将来源、执行目标与项目级策略从原 Project Descriptor 拆入 Workspace 下的 Member Project；已有单仓项目成为含一个 Member Project、一个 Execution Target 的特例。项目/来源增删走 Workspace 修订和差异预检。
4. 现有 Memory Space 做只读 Inventory 和显式映射，确认来源与可见性后迁到 Workspace Resource Binding；不因名称相似或同一用户自动合并。旧 Git 知识包导入继续保持未验证状态。
5. Codex 绑定、CLI/API、报告和恢复逐步改用 Workspace 身份；兼容层只负责旧命令解析和旧 Run 续跑。切换、清理、commit、发布与真实 Run 恢复遵守各自 Gate，不能因新模型通过而自动执行。

## 七、准出场景

最终验证必须**通过命令启动并跑完整条流程到关闭**，不能只看配置 Schema 或单元测试：

1. 两个 Workspace 使用同一知识问答 Workflow，各自包含前后端项目；问题、记忆、来源、输出、Run 和 Issue 不串域。
2. 同一 Workspace 的前后端项目共享已验证业务知识，各自实现知识仅在授权项目范围内可见；跨项目流程可按显式范围联合检索。
3. 给运行一段时间的 Workspace 新增仓库：旧 Run 保持旧来源快照，新 Run 纳入新仓库；精确依赖事实选择性复用，覆盖范围结论重新验证。
4. 同一 Workspace 绑定旧流程和新流程，Workflow ID 决定执行规则；多流程/多项目目标含糊时命令在创建 Run 前拒绝。
5. Engine 与 Collection 按现有短命令分别启动并完整关闭，工作区和资源隔离；旧 Run 不迁移 Authority。
6. 工作区配置变更、撤权、并发写入、崩溃恢复和资源 Provider 更换均保留 expected revision、幂等、来源摘要、Evidence 与准出边界。
