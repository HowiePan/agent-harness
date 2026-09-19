# Harness Workspace 平台最终开发方案

> 2026-09-19。状态：按本方案实施，代码与合成命令级 Canary 已完成；最终回归及打包结果见[Workspace 平台实施与操作记录](./workspace-platform-implementation.md)。目标是一次性交付 Workspace 顶层边界；文中阶段仅为内部实施顺序，不是独立发布版本或中途准出。具体领域模型见[Workspace 设计](./workspace-platform-design.md)，既有流程能力见[流程平台实现记录](./workflow-platform-implementation.md)。

## 1. 交付目标与范围

把现有以 `Project Descriptor + 单个 workspace.root` 为中心的归属模型，改为 `Harness Workspace → Member Project/Source/Execution Target → Workflow Binding → Run`。Workflow Definition 与 Workspace Descriptor 分开存放、安装、版本化和批准。两个不同 Workspace 能复用同一流程；一个 Workspace 能容纳多个项目、来源、流程和分层资源。Engine、Collection 作为各自独立的 Workspace 保持原短命令可用。

本次同时落地第一种资源 Provider：知识库。工作区通用知识与项目级知识按配置共享或隔离；未来的索引、制品目录等资源仅需实现版本化 Provider 合同，不改 Kernel 的归属和授权规则。本次不启动、恢复或迁移真实 CardWorld/Collection Run，不修改冻结的旧 Harness；Git commit/tag、发布、插件重装和旧文件清理由用户另行决定。

**一次性交付的含义**：开发期间可按下述阶段提交工作树改动和执行内部检查；最终只在全部合同、兼容迁移、四条现有/新样板流程及命令级闭环通过后报告代码准出。不把某个阶段的单元测试通过当作最终完成。

## 2. 必须冻结的合同

| 合同 | 必须有的字段或行为 | 准出不变量 |
| --- | --- | --- |
| Workspace Descriptor/Registry | 稳定 `workspaceId`、别名、Schema 版本、修订/摘要、项目成员、来源、执行目标、流程绑定、资源绑定、策略；expected revision、幂等 command ID、批准回执和原子激活 | 别名/物理路径不充当身份；同一成员项目只归属一个 Workspace；旧修订可审计，不能原地覆盖旧 Run 的依据 |
| Workflow Definition/Binding | 独立的 `workflowId/version/artifactDigest` 与参数/能力 Schema；Workspace Binding 精确引用并声明允许项目、默认项目范围和参数 | 换工作区不改流程制品；工作区参数不能改变节点、分支、Gate/Decision 或关闭语义；绑定切换只影响新 Run |
| Run Identity/Plan | `workspaceId/workspaceRevision/workspaceDigest`、Workflow/Extension/Profile Ref、`projectIds`、Source Manifest、资源快照、输出目标和实例键 | Plan、Authority、Dispatch、Grant、Evidence、Receipt、Lineage 与 Issue 使用同一身份链；不能跨 Workspace 续跑或复用 Receipt |
| Member Project/Source/Target | 项目稳定 ID、来源 ID、独立 revision/摘要、读/接收范围、受管执行/输出目标与全局冲突键 | 多仓库是各自固定快照；跨 Workspace 只读复用需分别授权，写目标全局互斥或明确隔离 |
| Resource Binding/Provider | `resourceId/kind/scope/owner/providerRef/schemaVersion/artifactDigest/access/lifecycle`；受管快照、Effect、Receipt、恢复与撤权接口 | 资源 Provider 不写 Kernel Authority；请求只能选择 Workspace Registry 授权的资源；跨 Workspace 默认拒绝 |
| Knowledge Record | Workspace/项目/流程/来源范围、证据、依赖文件与覆盖集合、候选/已验证/撤销状态、验证者、可见性 | 通用知识仅在同一 Workspace 的获准项目共享；新增仓库使“全范围未找到”等覆盖结论待重验，不能只按旧文件摘要判断 |
| 命令与问题归属 | Workspace Alias、Workflow Ref、项目范围、Run Ref；安装级故障回退 | `h:engine` 等兼容入口保持唯一映射；流程或项目范围含糊时创建 Run 前拒绝；报告可按 Workspace/Workflow/Run 追溯 |

存储物理路径保持在 Standalone Control Root 内，拒绝 symlink/junction 越界。Workspace ID 是逻辑命名空间；目录布局可以改变而不改变身份。Authority、Evidence、Decision 和 Lease 仍由 Kernel 管理，不改造成普通 Resource Provider。Source/Resource 授权需同时检查 Agent Runtime、模型与工具接收方；已固定 Run 遇到撤权时在下一次 Dispatch 前阻断并处理活跃 Lease。

## 3. 开发阶段与交付检查

| 阶段 | 实施内容 | 阶段检查 |
| --- | --- | --- |
| A：基线与协议 | 固定当前 Project/Workflow/Memory/Command/Run 的脱敏基线；冻结新 Schema、复合身份、兼容映射、资源作用域及错误码；补充跨 Workspace/项目的拒绝样本 | 两工作区同流程、同工作区两项目、同名项目/动作、配置歧义、越权资源等非法输入在零 Run 写入前失败 |
| B：Workspace Registry | 实现 Descriptor 校验、版本/摘要、原子修订与活动指针、别名唯一性、成员归属、批准和回滚；旧 Project Registry 转为一对一兼容视图/写入适配，不形成双重权威 | 重启后身份和版本一致；CAS/幂等/崩溃恢复成立；旧 Project 注册和旧短命令仍有确定映射 |
| C：编排与运行身份 | Workflow Binding 解析能力/参数，计划编译只读取固定 Workspace 修订；Plan、Grant、Authority、Dispatch、Lineage、Gate/Decision、Receipt、全局准入都固定 Workspace 和项目范围 | 同动作/目标跨 Workspace 生成不同 Run；旧 Run 原样恢复；绑定更新或撤销不让旧 Receipt 升级为新准出 |
| D：来源与通用资源 | Workspace 内多项目 Source Manifest；可注册的 Resource Binding/Provider 合同与授权解析；知识库迁为工作区通用、项目、流程、来源、会话空间；覆盖集合失效、Effect/Outbox、撤权和 Git 导出边界 | 相同工作区可共享经核验知识，项目实现知识隔离；跨 Workspace 查询拒绝；增仓后局部事实复用、覆盖结论待重验；Effect 崩溃重放不重复提升 |
| E：入口与迁移 | CLI/API/Codex 绑定使用 Workspace Alias；`h:where`、流程发现、启动、状态与 `h:report` 保留旧短命令兼容；Engine/Collection 一对一映射；现有记忆只读 Inventory 后显式映射 | 命令和 Issue 准确带 Workspace/Workflow/Project/Run；Registry/Authority 故障仍可用可信安装绑定上报；旧 Run、旧记忆与旧业务仓不被自动搬动或清理 |
| F：整体闭环与制品 | 新增真正经过命令 Router/Coordinator 的 Workspace Canary，跑 Engine、Collection、需求设计、知识问答以及多 Workspace/多项目/增仓场景；回归、净室安装、打包和残留核查 | 下节最终 Gate 全部通过后才报告代码准出；不以 `npm test` 单独通过准出 |

阶段 B 以后，新 Workspace Descriptor 是唯一新写入来源；兼容适配负责旧输入到一对一 Workspace 的受检翻译。阶段 D 的知识迁移不按 `domainId` 或自然语言名称自动合并，必须有源空间、目标资源、权限和证据的显式映射。复杂控制节点、模型/工具外发限制和宿主接入所需的通用合同若在阶段 A 的能力盘点中仍有缺口，必须作为本次阻断项补齐，不能记为“后续优化”。

## 4. 启动、变更与回滚规则

命令以 Workspace Alias 为首段：`h:engine full V3.8.4` 走唯一默认绑定；多流程用 `h:<alias> flow <workflow-id> <action> <target>`；项目范围无唯一默认时加显式 `--project/--projects`。这些语法已在合成命令级 Canary 中执行并关闭 Run。CLI/API 则使用独立 `workspaceId`、`workflowId`、`projectIds` 字段，不拼接成一个字符串。工作区别名的安装绑定与 Registry 记录都固定版本/摘要，损坏时不能扫描磁盘猜测。

新增项目/仓库/资源只产生新的 Workspace Descriptor 修订；新增流程版本先安装精确制品，再经批准切换 Workspace Binding。已创建 Run 永远固定旧组合。撤权是安全例外：旧 Run 仍保留审计快照，但新 Dispatch 重新执行当前权限检查，必要时进入 attention/recovery；不能以“快照固定”为由继续外发。回滚通过活动 Workspace 修订/Workflow Binding 指针选择以前已批准的制品，不能回写旧 Run 或把新结论按状态字符串降级/升级。

旧 `authority/<projectId>` 和其他运行状态不原地改写。新状态统一放在 Control Root 下的 `dataRoot/workspaces/<workspaceId>/` 命名空间；其下 Authority、Evidence 与 Resource Store 仍按各自事务合同管理，路径不充当逻辑身份。真实 cutover、旧文件归档/删除、对外 Git push 和发布不属于这次代码 Gate 的自动动作。

## 5. 最终命令级准出 Gate

新增 `npm run workspace:canary`，经与用户命令相同的 **Router → Intent → Workspace/Workflow 解析 → Plan → 预检 → Run 启动 → Dispatch/Submission → Gate/Decision → close** 路径；可使用合成来源和明确授权的合成 Runtime，但不能直接调用内部 Planner 绕过命令入口。运行输出记录每条命令、Workspace/Workflow/Run/Plan 摘要、最终状态和 Evidence 引用；所有正向 Run 必须为 `closed`，负向场景必须在预期边界拒绝且没有越权 Run。

至少覆盖以下场景：

1. 两个各含前端、后端项目的 Workspace 运行**同一**知识问答流程，独立关闭；来源、通用/项目知识、Issue 和输出互不串域。
2. 一个 Workspace 的前后端运行需求/设计流程并产出两份文档；后续问答命中通用业务知识，前端/后端实现知识仅在允许的项目范围命中。
3. 在同一 Workspace 增加第三个仓库后重新从命令启动：旧 Run 保持旧来源快照，未变文件事实可复用，先前“全仓库不存在”的结论必须转为待重验。
4. 同一 Workspace 使用一条旧流程和一条新流程；含糊流程或项目选择在 Run 创建前拒绝。同名动作、目标、资源与实例输出不串线。
5. `h:engine` 和 `h:collection` 的原短命令分别经兼容 Workspace 启动**完整流程并关闭**；二者没有默认共享记忆，旧 Authority 保持可审计。
6. 资源撤权、跨 Workspace 查询、来源漂移、Provider 容量/输出冲突、配置更新竞态、Effect 崩溃恢复和配置回滚分别产生可核验的拒绝或恢复回执。

`npm test`、合同/Conformance、静态边界、净室安装、打包、残留检查和 `git diff --check` 是必要的回归 Gate；它们不能替代命令级闭环。合成 Canary 通过只证明代码与 Harness 状态机准出。真实 Codex/其他 Agent 对真实业务来源的执行质量、外部发布和旧 Run cutover 仍需各自现场 Gate；不得用合成回答声称完成真实业务验收。

## 6. 完成定义与交付物

交付时应同时提供：版本化 Workspace/Resource Schema 与 SDK、Registry/兼容适配器、命令和 Issue 合同、Engine/Collection 与两个样板工作区配置、增仓迁移/回滚手册、可复现命令级 Canary、测试与打包结果、明确的未覆盖生产 Gate。文档中的示例命令须与实现一致；若合同发生变更，先更新此方案的决策记录再执行相应验证。最终报告列出每条命令是否到达 `closed`，以及旧 Run/真实业务/发布未触碰的事实。
