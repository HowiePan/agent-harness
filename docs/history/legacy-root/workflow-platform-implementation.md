# 可组合流程与记忆平台：实现及准出记录

> 2026-09-19。本文记录本次代码改造和合成命令级验证。真实业务 Run、真实 Codex/其他 Agent 的端到端执行、远端发布及旧 Harness 切换仍是独立 Gate。

下一阶段的顶层工作区归属与多项目资源设计见[Harness Workspace 顶层边界设计](./workspace-platform-design.md)；其中的 Workspace 命令和 Schema 尚未实现。

## 实现边界

| 能力 | 当前实现 |
| --- | --- |
| 流程身份与选择 | Extension Pack 声明版本化 Workflow Definition；Project Descriptor 可精确绑定 ID、版本、摘要和 Extension。一个项目有多条流程时，启动必须指定 Workflow ID；Plan、Run、Dispatch 和问题上报保留流程身份。 |
| 编排 | 通用编译器展开有界节点扇出、依赖和汇合，验证 Feature DAG。Engine 与 Collection 各有独立定义，新 Run 均通过此编译器；业务 Profile 继续负责各自 Gate、Decision、质量和关闭规则。 |
| 新流程 | `requirements-design`：按文档采集、归并、按仓库检索、影响映射、需求/设计文档、复核。`knowledge-qa`：解析、记忆匹配、命中回答或查来源；证据不足时澄清。分支依据带 Schema 的已提交节点输出有界追加 Feature；声明式输出检查会拒绝失败复核、空答案或空澄清。 |
| 多来源 | Source Manifest 固定每个文档和仓库的文件摘要、revision 和允许接收的 Runtime；Dispatch 限定可读来源，提供只读 `source read/search`；计划、启动和 Dispatch 前核查来源漂移。多仓库是各自固定的快照集合。 |
| 记忆 | Control Root 内持久 Memory Space 支持 common/project/workflow/source/session；common 需显式列出成员项目。候选与已验证记录分离，提升绑定已完成 Submission/Evidence、验证者、expected revision、幂等命令及可恢复 Effect；来源变化标记待重验，冲突需用户决议，会话否定记忆有 TTL。Run 固定查询快照。 |
| 多实例 | 同一流程定义可启动独立 Run 集合；持久准入队列和 Lease 控制工作区、输出和 Provider 冲突；每个实例各自持有 Plan、Authority、Evidence 和关闭状态。 |
| Git 知识交换 | 可把明确标记 `visibility: shared` 的已验证记录导出为带摘要 JSON 包，路径须在 Control Root 内，可由用户自管 Git 仓库。导入一律为 `imported-unverified`，须由新的 Submission 重新取证、提升后才能命中。命令不会自动 commit/push；导出不是 Authority/Evidence 的备份。 |

节点模板来自受批准的 Extension；流程定义只配置节点参数，不执行任意脚本。Agent 推理仍由宿主 Runtime 承担。新样板复用 `reference-feature` 模板、通用编译器、Composable Workflow Profile、Source Provider 和 Memory Store；新接入主要提供定义、输入接线和对应的结果合同。

## 入口与操作

安装 Extension 并由 Authority 批准 Project Descriptor 绑定后，可以发现流程：

```powershell
node bin/agent-harness.mjs workflow list --project <project-id> --control-root <control-root>
```

Codex 伪命令使用 `h:flows <项目别名>` 查看绑定流程，使用 `h:<项目别名> flow <workflow-id> <action> <target> [preset]` 显式启动；`h:report <项目别名> --workflow <workflow-id>` 给问题标注流程。只有一条已绑定流程的项目仍可使用原短命令。程序化宿主调用 `createLifecyclePlan({ projectId, workflowId, action, target, workflowInput, ... })`，再预检、启动、调度和关闭；宿主仍须提供真实 Runtime 能力与适当的执行授权。`workflowInput` 包含已固定 Source Manifest，以及适用的 Memory Spaces 和输出路径；记忆快照由 Harness 查询并固定，调用方不能伪造。

来源和记忆的 CLI 入口见 `node bin/agent-harness.mjs --help`。常用操作如下：

```powershell
node bin/agent-harness.mjs source capture --input <sources.json>
node bin/agent-harness.mjs source search --project <id> --run <id> --dispatch <id> --query <literal>
node bin/agent-harness.mjs memory query --input <query.json> --control-root <control-root>
node bin/agent-harness.mjs memory export --input <export.json> --control-root <control-root>
node bin/agent-harness.mjs memory import --input <import.json> --expected-revision <n> --command-id <id> --control-root <control-root>
```

`export.json` 指定 `space`、Control Root 内的 `exportRoot` 和明确选择的 `recordIds`。`import.json` 指定同一 `space` 与 `bundleFile`。导出前需由调用者审查共享范围；内置检查会拒绝常见凭据文本。跨设备导入后，缺少原始 Evidence 的知识不会自动取得可信状态。

## 命令级准出验证

最终核心 Gate 是以下命令返回 `ok: true`，并且输出中的每个 Run 与 Instance Set 都为 `closed`，而非只看单元测试：

```powershell
npm run workflow:canary
```

该命令在独立临时 Control Root 和输出目录中，用显式授权的合成 Runtime **实际创建计划、预检、启动、调度节点、提交带类型的结果和 Evidence、执行 Gate/Decision，并走到 Run 关闭**。覆盖：

1. Engine 全流程、Collection 批次全流程；
2. 两份需求文档和两个代码仓库输入，产出需求与设计文档并复核；
3. 两个额外需求实例独立关闭，复用前一 Run 已验证的 common 记忆；
4. 问答未命中检索、命中后跳过检索、否定反馈后重新检索且不重复旧答案、证据不足转澄清；
5. 每个运行输出 `workflowId/runId/planDigest/status`，并断言 Authority 状态为 `closed`。

**本次结果（2026-09-19）**：`npm run workflow:canary` 返回 `ok: true`；7 条直接启动的 Run 和 2 条 Instance Set Run 均为 `closed`。`npm test` 为 209/209，`npm run test:conformance` 为 3/3；`npm run check`、净室打包验证、残留检查均通过。验证使用合成输入与合成 Runtime，不涉及真实业务 Run。

合同/回归检查继续使用 `npm test`、`npm run check`、`npm run test:conformance`、`npm run check:clean-room` 和 `npm run check:residue`。这些检查不能替代上述命令级闭环。

## 当前限制与后续 Gate

- Canary Runtime 是确定性的合成执行器，验证 Harness 的命令启动和完整状态机闭环；它不证明真实模型回答质量、真实 Codex Agent 执行、多仓库语义兼容或生产环境吞吐。接入真实宿主时须按同一 Workflow/Source/Memory 合同再做现场验收。
- Engine/Collection 的 Feature 编排已迁到通用编译器；各自复杂 Gate、Decision、质量策略仍在版本化业务 Profile/Extension 中。通用 Profile 支持所需 Gate/Decision 的关闭检查，但尚未将任意 Gate/Decision 都建模为可配置的图节点。这是扩展通用流程时的边界。
- Git 包仅用于已审核知识的交换，不包含 Authority、原始 Evidence、索引、安装绑定或恢复 Capsule；完整灾难恢复沿用受管恢复机制。
- 不触碰旧 Harness 和真实业务 Run；commit、tag、发布、插件重装、旧文件清理和最终切换由用户另行决定。
