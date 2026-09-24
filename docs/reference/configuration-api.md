# Agent Harness 配置 API 参考

本文是 V1.0.0 配置面的完整契约。它面向只有安装包、没有源码的接入方，说明“是什么、有什么、能做什么、怎么做、不能做什么”。Schema 是机器契约，本文是字段语义、默认值、运行原理和操作边界的规范说明。

## 1. 配置对象与生效顺序

Agent Harness 有五层配置，不能互相替代：

1. 项目仓的 `harness.json`：声明项目需要哪些 Extension、由谁生成 Project Descriptor、绑定哪个 Profile 和工作区。
2. Extension 的 `projectConfiguration.schema`：校验 `project.input`，防止生成器私有参数无契约地藏在代码里。
3. Project Descriptor：初始化后登记到 Registry 的运行策略快照，包含 Runtime、并发、Gate、恢复和路径策略。
4. Workflow Definition 与 Profile 配置：把命令编译成 Node，再把 Node 编译成 Feature DAG；Profile 决定派发与关闭条件。
5. Run Authority：冻结某次运行的 Feature、Profile、制品、来源、Decision、Gate、Lease 和 Evidence。修改项目配置不会回写既有 Run。

数据流如下：

```text
harness.json
  -> 配置 Schema 校验
  -> Extension 制品校验与注册
  -> project.input 专属 Schema 校验
  -> Project Descriptor 纯函数生成
  -> Registry 原子提交
  -> 命令/Intent 选择 Workflow route
  -> Node template 编译 Feature DAG
  -> Profile 派发约束
  -> Dispatch / Lease / Result
  -> Gate / Decision / Finding
  -> Profile 关闭判断与 Receipt
```

优先级不是“后写覆盖前写”。初始化时由 `harness.json` 产生一个新 Descriptor 修订；Run 启动时从该修订冻结必要字段；运行中的 Authority 高于后来修改的文件。相同 `commandId` 幂等，修改过的 Plan、配置摘要或 expected revision 会被拒绝。

## 2. `harness.json`

### 2.1 顶层字段

| 字段 | 必填 | 类型/约束 | 含义 |
|---|---:|---|---|
| `$schema` | 否 | URI 字符串 | 编辑器提示地址，不参与运行授权。 |
| `schemaVersion` | 是 | 固定 `1.0` | 项目配置协议版本。 |
| `kind` | 是 | 固定 `agent-harness-project` | 文档类型。 |
| `extensions` | 是 | 非空数组 | 初始化所需 Extension 列表。Extension ID 不得重复。 |
| `project` | 是 | 对象 | Project Descriptor 生成器及其输入。 |
| `binding` | 是 | 对象 | 宿主可见别名、项目、Profile、Extension 和工作区绑定。 |

### 2.2 `extensions[]`

| 字段 | 必填 | 约束 | 含义 |
|---|---:|---|---|
| `id` | 是 | 小写字母/数字开头，可含 `.`、`-` | Extension 稳定 ID。 |
| `version` | 是 | `x.y.z` | 必须与加载后 Extension 版本一致。 |
| `module` | 是 | 非空模块说明符 | 安装包导出路径或经批准的 Extension 入口；生产模式必须被制品清单完整覆盖。 |

`project.generatorExtensionId` 与 `binding.extensionId` 都必须出现在 `extensions[]`。Runtime Extension 也必须显式列出，不能靠目录扫描或登录用户推断。

### 2.3 `project`

| 字段 | 必填 | 含义 |
|---|---:|---|
| `generatorExtensionId` | 是 | 实现 `createProjectDescriptor` 的 Extension ID。 |
| `input` | 是 | 该 Extension 的版本化项目输入；字段见第 3 节。 |

Core 会把 `binding.projectId` 和解析后的绝对 `binding.workspaceRoot` 注入 `input.id`、`input.workspaceRoot`。如果配置中也写了这两个字段，值必须一致。生成器必须是 `pure-planner`，只能返回数据，不能写 Registry、Authority 或业务仓。

Extension 身份对象的字段是 `id`、`version`、可选或注册后必需的 `digest`；`digest` 是 64 位制品 SHA-256，不是由项目自行填写的信任声明。

### 2.4 `binding`

| 字段 | 必填 | 约束/默认 | 含义 |
|---|---:|---|---|
| `alias` | 否 | 小写字母开头，最长 32；默认 `projectId` | 宿主命令中的短名称。 |
| `projectId` | 是 | 1–128 字符 | Registry 项目身份。 |
| `profileId` | 是 | 非空字符串 | 默认运行 Profile。必须由绑定 Extension 提供。 |
| `extensionId` | 是 | 非空字符串 | 提供 Profile、Workflow 和命令清单的 Extension。 |
| `workspaceRoot` | 是 | 相对或绝对路径 | 相对 `--project-root` 解析；推荐项目根写 `.`。 |

完整中立示例：

```json
{
  "$schema": "https://agent-harness.local/schemas/project-harness-config.schema.json",
  "schemaVersion": "1.0",
  "kind": "agent-harness-project",
  "extensions": [
    { "id": "delivery-lifecycle-profile", "version": "1.0.0", "module": "agent-harness/consumers/delivery-lifecycle" },
    { "id": "codex-runtime", "version": "1.0.0", "module": "agent-harness/extensions/codex-runtime" }
  ],
  "project": {
    "generatorExtensionId": "delivery-lifecycle-profile",
    "input": { "maxConcurrency": "auto", "gateRecipes": [] }
  },
  "binding": {
    "alias": "my-project",
    "projectId": "my-project",
    "profileId": "delivery-lifecycle",
    "extensionId": "delivery-lifecycle-profile",
    "workspaceRoot": "."
  }
}
```

## 3. `project.input` 生成器 API

所有生成器都接受一组公共字段。未写 `id`、`workspaceRoot` 时由 Core 从 `binding` 注入。

### 3.1 公共 Runtime 与 Extension 字段

| 字段 | 默认值 | 说明 |
|---|---|---|
| `id` | `binding.projectId` | Project ID。 |
| `harness` | 当前已验证 Release | `{version, artifactDigest}`；一般不手写。 |
| `workspaceRoot` | 解析后的 `binding.workspaceRoot` | 必须为绝对路径进入生成器。 |
| `remote` | 无 | 工作区远端标识；不用于自动 clone。 |
| `runtimePluginId` | `codex-conversation-runtime` | 默认 Runtime。 |
| `runtimePluginIds` | `[runtimePluginId]` | 允许使用的 Runtime 白名单，必须包含默认值。 |
| `agentExecutionMode` | `conversation-visible` | `conversation-visible` 或 `headless`。非默认 Runtime 时必须显式填写，绝不按名字推断。 |
| `runtimeExtension` | Codex 可见 Runtime Extension | 默认 Runtime 的 Extension 身份；设为 `null` 表示不自动加入。 |
| `headlessRuntimeExtension` | Codex headless Extension | CLI/隔离 Runtime 的 Extension 身份；设为 `null` 表示不自动加入。 |
| `runtimeConfigs` | `{}` | 以 Runtime ID 为键的配置对象。进程 Runtime 默认补 `sandbox: workspace-write`、`ephemeral: true`。 |
| `extensions` | `[]` | 额外 Project Extension 身份数组 `{id,version,digest?}`。注册时摘要必须来自已验证制品。 |
| `model` | 无 | 写入每个 Runtime 配置的模型选择；不构成 Runtime 或执行授权。 |

`runtimeConfigs` 是 Runtime 插件自己的版本化配置，Core 不把任意键解释为授权。执行仍需 Project 白名单、Profile/Workflow 选择、用户约束和命令级 Execution Grant 同时成立。

### 3.2 `delivery-lifecycle-profile`

模块：`agent-harness/consumers/delivery-lifecycle`。Profile：`delivery-lifecycle`。

除公共字段外支持：

| 字段 | 默认值 | 约束/含义 |
|---|---|---|
| `gateRecipes` | `[]` | 第 6 节的 Gate Recipe 数组。 |
| `maxConcurrency` | `auto` | 正整数或 `auto`；是物理并发上限，不绕过依赖/冲突。 |
| `actionExecution` | `{}` | 按 action 绑定 `{agentExecutionMode,runtimePluginId}`；Runtime 必须在 `runtimePluginIds`。 |
| `knownFindingInventories` | 无 | 以质量目标为键的权威 Finding inventory 快照。 |
| `actionPaths` | 内置默认路径 | action 到允许写路径数组的映射。支持 `requirements`、`plan`、`implement`、`scope`、`docs`、`review`、`deliver` 等动作键。 |
| `excluded` | `.git`、`.agent-harness-data`、`node_modules` | 工作区排除/禁止路径。 |

内置 action：`full`、`requirements`/`req`、`plan`、`implement`/`impl`、`scope`、`quality`/`qa`、`docs`、`review`、`deliver`、`status`、`resume`、`recover`。质量 preset 为 `full`、`review-only`、`recheck`；需求 preset 为 `full`（默认，`intake → expansion → canonical`）、`expand-to-plan`（`intake → expansion → canonical → plan`）、`direct`（不扩展，`intake → canonical → plan`）、`plan-only`（`plan`）。

初始化：

```text
agent-harness init execute --config ./harness.json --project-root . --command-id init-delivery-001 --decision ./decision.json
```

### 3.3 `batch-production-profile`

模块：`agent-harness/consumers/batch-production`。Profile：`batch-production`。

| 字段 | 默认值 | 约束/含义 |
|---|---|---|
| `gateRecipes` | `[]` | Gate Recipe 数组。 |
| `maxConcurrency` | `10` | 正整数。实际派发还受 Feature 依赖、路径和冲突键限制。 |
| `maxLogicalItems` | `10` | 1–100；每批逻辑项上限。 |
| `batches` | `[]` | 每项含 `id`、可选 `ruleStatus`、可选 `itemIds`；兼容键 `items` 也是字符串 ID 数组。 |
| `itemKey` | `itemId` | 写入 Feature metadata 的业务项键名。 |
| `itemPaths` | 按项回退到 `items/<id>` | item ID 到允许写路径数组的映射。 |
| `excluded` | `.git`、`.agent-harness-data`、`node_modules` | 工作区排除/禁止路径。 |

内置 action：`full`、`rules`、`launch`、`produce`、`quality`、`review`、`accept`、`close`、`status`、`resume`、`recover`。`quality`、`review`、`accept` 支持 `all` 与 `item` preset。

```text
agent-harness init execute --config ./harness.json --project-root . --command-id init-batch-001 --decision ./decision.json
```

### 3.4 业务 Extension 的配置自描述契约

通用配置 API 不枚举任何具体业务的字段、门禁、路径或初始化命令。提供 `createProjectDescriptor` 操作的 Extension 必须在自身发布制品中提供完整的 `projectConfiguration`：

| 字段 | 必填 | 含义 |
|---|---:|---|
| `schema` | 是 | 该 Extension 接受的完整 Project Input JSON Schema；必须能独立校验全部公开字段。 |
| `schemas` | 否 | `schema` 引用的命名依赖 Schema 映射。 |
| `example` | 是 | 通过上述 Schema 校验的最小可运行示例。 |

Extension 注册时会验证 Schema 定义和示例；初始化时会先按该 Schema 校验 `project.input`，再调用纯规划操作生成 Project Descriptor。业务项目的 `harness.json` 是该项目的配置事实来源；业务字段说明、固定 Gate 清单和项目初始化命令必须由相应 Extension/项目文档随版本发布，不得写入本通用 API。

## 4. Project Descriptor API

Project Descriptor 是 Registry 中的规范化结果，通常由生成器产生，不建议手写。

| 字段 | 含义 |
|---|---|
| `id` | Project ID。 |
| `harness.version`、`harness.artifactDigest` | 精确 Core 制品身份。 |
| `workspace.root` | 绝对工作区根。 |
| `workspace.remote` | 可选远端标识。 |
| `workspace.rootSelector` | 当前固定 `git-worktree`。 |
| `workspace.excluded` | 排除/禁止路径数组。 |
| `profiles` | 允许的 Profile ID 数组。 |
| `workflows` | 固定的 `{id,version,artifactDigest,extensionId}` 数组。 |
| `extensions` | 固定的 `{id,version,digest}` 数组。 |
| `policy.agentExecutionMode` | 默认执行模式。 |
| `policy.defaultRuntimePlugin` | 默认 Runtime ID。 |
| `policy.runtimePlugins` | Runtime 白名单。 |
| `policy.promptCodecPlugin` | Prompt Codec ID。 |
| `policy.runtimeConfigs` | Runtime 插件配置。 |
| `policy.profileConfigs` | Profile ID 到 Profile 配置。 |
| `policy.actionExecution` | action 级执行策略。 |
| `policy.actionPaths` | action 级路径范围。 |
| `policy.gateBindings` | action 到 Gate ID 数组，或 `{pre,post,final}` 的映射。 |
| `policy.knownFindingInventories` | 质量 Finding inventory。 |
| `policy.maxConcurrency` | 物理并发上限。 |
| `policy.maxLogicalItems` | 批次逻辑项上限。 |
| `policy.batches` | 批次声明。 |
| `policy.itemKey`、`policy.itemPaths` | 通用批处理项键与路径。 |
| `policy.recovery` | 恢复策略。 |
| `gateRecipes` | 可执行 Gate 声明。 |
| `artifactProviders` | Artifact Provider ID 数组。 |

`policy.recovery` 的字段是 `automaticLineageResolution`、`automaticOrdinaryResume`、`automaticVerifiedHardRecovery` 和固定为 `true` 的 `preserveSupersededRuns`。自动恢复仍需通过对应验证，不等于自动批准硬恢复。

## 5. Workflow、Node、Feature 与循环

### 5.1 Workflow Definition

| 字段 | 必填 | 含义 |
|---|---:|---|
| `schemaVersion` | 生成 | 固定 `1.0`。 |
| `artifactDigest` | 生成 | 对定义正文的稳定摘要。 |
| `id` | 是 | Workflow ID。 |
| `version` | 是 | 语义版本。 |
| `profileId` | 是 | 运行 Profile。 |
| `routes` | 是 | action/route ID 到非空 Node 数组的映射。 |

Node 依赖必须指向同一路由中更早出现的 Node；不能前向引用或形成环。`forEach` 指向 `items` 中的命名集合，集合必须非空、唯一且最多 100 项。

### 5.2 Node 全字段

| 字段 | 必填 | 含义 |
|---|---:|---|
| `id` | 是 | 路由内唯一 Node ID。 |
| `template` | 是 | Extension 中注册的纯 Node template ID。 |
| `task` | 是 | 第 5.3 节的完整 Node Task Contract；缺失时 Workflow 不能注册。 |
| `dependsOn` | 否 | 前置 Node ID 数组。fan-out 对同一集合按索引依赖，否则依赖前置 Node 的全部实例。 |
| `forEach` | 否 | 命名集合；每个 item 生成一个 Feature。 |
| `action` | 模板相关 | 业务动作，交付/批处理模板会写入 Feature `kind`。 |
| `stage` | 模板相关 | 交付阶段。 |
| `readOnly` | 否 | 生成空 `allowedPaths` 和只读 source policy。 |
| `qualityReview` | 否 | 生成 reviewer、质量上下文和 Finding 闭环要求。 |
| `portKey` | 否 | 选择 Node 的 typed output 端口键；默认 `id`。 |
| `outputPorts` | 否 | `portId -> schemaId`，声明完成结果必须携带的 typed output。 |
| `outputValueSchemas` | 否 | `schemaId -> JSON Schema`，Dispatch 前冻结值结构。 |
| `outputChecks` | 否 | 最多 16 项，字段为 `portId`、`path`、`operator`、可选 `value`。 |
| `expectedHit` | 否 | 知识检索节点对 `match.value.hit` 的预期。 |
| `outputPath` | 否 | `output-path` 检查运算符使用的权威路径。 |

`outputChecks.operator` 支持：`equals`（值严格等于 `value`）、`non-empty`（非空）、`output-path`（值等于 Node/Feature 的 `outputPath`）。Node 的其他字段只能由对应 template 明确解释；Core 不把未知 Node 字段自动变成权限。Workflow 编译器会把 `task`、`acceptance`、`steps`、`ownerRole` 和输出合同统一投影到 Feature，模板不能静默丢弃它们。

### 5.3 Node Task Contract

每个 Agent Node 必须完整声明任务语义；不允许依靠“完成当前 action”之类的生产默认 Prompt。

| 字段 | 必填 | 含义 |
|---|---:|---|
| `schemaVersion` | 生成 | 当前固定 `1.0`。 |
| `taskDigest` | 生成 | 对规范化 Task 正文的 SHA-256 摘要。 |
| `role` | 是 | `{id,description}`；稳定责任角色及其职责。 |
| `objective` | 是 | 节点必须解决的唯一目标。 |
| `instructions` | 是 | 非空、唯一的工作方法数组。 |
| `inputs` | 是 | 输入绑定数组；可以为空。 |
| `steps` | 是 | 有序步骤数组；每项包含 `id` 和非空 `instruction`，至少一项。 |
| `constraints` | 是 | 非空、唯一的禁止项和边界数组。 |
| `acceptance` | 是 | 非空、唯一、可核验的完成条件数组。 |
| `evidenceRequirements` | 是 | 非空、唯一的证据要求数组。 |

每个 `inputs[]` 包含 `id`、`source`、`required`、`description`。非上游输入还必须有 `path`；`source` 支持 `intent`、`feature`、`workspace`、`source-manifest`、`memory`、`quality-target`。`path` 是点号字段路径，`$` 表示整个根对象。`upstream` 输入包含 `nodeId`、`portId`、`schemaId`，由编译器根据实际直接依赖和端口合同生成；分支/repeat 根据触发端口生成。必填输入在 Dispatch 前无法解析、或者上游 `schemaId` 不匹配时，运行失败关闭而不是把缺失上下文交给 Agent 猜测。

Prompt Contract 1.3 按四层组合：不可覆盖的 Core Contract、Node Task Contract、已解析的 Dispatch Context、Runtime 输出方言。项目 `harness.json` 不能注入自由文本 Prompt；改变节点任务语义必须发布新的 Flow/Extension 制品摘要。Prompt 固定并报告 `taskDigest`、Dispatch `packetDigest` 与最终 `promptDigest`。历史 1.0/1.2 Dispatch 仍按原合同重放，不升级为 1.3。

固定结果 Schema 的 Runtime 若要执行含 typed outputs 的 Feature，必须在 Manifest 声明兼容方言。参考 Codex CLI Runtime 使用 `typed-output-envelope-v1`：Provider 最终 JSON 中的 `typedOutputs[]` 每项含 `portId`、`schemaId`、`valueJson`、`evidenceRefs`；`valueJson` 是输出值对象的 JSON 字符串。Runtime 在提交前将其无损解码为标准 `outputs.<portId>`，随后 Core 逐端口检查端口全集、Schema ID、值 Schema、证据和 256 KiB 总预算。重复端口、非法 JSON、非对象值或未声明端口都会失败；该方言不是逃逸 Schema 校验的通道。

### 5.4 Feature 全字段

| 字段 | 默认/约束 | 含义 |
|---|---|---|
| `id` | 必填、Run 内唯一 | 调度身份。 |
| `executionClass` | 必须 `agent-reasoning` | Agent Feature 与确定性进程 Gate 严格分开。 |
| `kind` | `implementation` | 动作/类型。 |
| `ownerRole` | `worker` | 责任角色，不是用户身份。 |
| `logicalRoot` | 默认 `id`，必须非空 | 跨重试稳定逻辑根。 |
| `laneId` | 默认 owner role | round-robin 调度 lane。 |
| `task` | Flow Node 编译时必填 | 已规范化、摘要绑定的 Node Task Contract。低层 Legacy Feature 可读取，但不能使用 Prompt Contract 1.3 派发。 |
| `acceptance` | 必填非空数组 | 验收条件。 |
| `steps` | `[]` | 每步包含 `id` 与可选 `title`；Step 默认不拆成独立 Agent。 |
| `dependsOn` | `[]` | Feature DAG 依赖。 |
| `allowedPaths` | `[]` | 可写相对路径范围。 |
| `forbiddenPaths` | `[]` | 显式禁止路径。 |
| `symbols` | `[]` | 符号冲突集合。 |
| `contracts` | `[]` | 契约冲突集合。 |
| `generatedOutputs` | `[]` | 生成路径，也参与路径冲突。 |
| `artifactInputs` | `[]` | Artifact 读依赖。 |
| `artifactOutputs` | `[]` | Artifact 写集合。 |
| `conflictKeys` | `[]` | 相同键不能并发。 |
| `conflictsWith` | `[]` | 显式冲突 Feature ID。 |
| `gatePlan` | `[]` | Feature 绑定的 Gate ID。 |
| `attemptLimit` | `3` | 正整数重试上限。 |
| `metadata` | `{}` | Profile/Extension 的版本化元数据。 |
| `state` | `pending` | Authority 状态；输入通常不手写。 |

调度同时检查 `dependsOn`、`conflictsWith`、`conflictKeys`、`symbols`、`contracts`、Artifact 读写冲突，以及 `allowedPaths`/`generatedOutputs` 的父子路径重叠。`maxConcurrency` 只是上述约束之后的上限。

### 5.5 条件分支 `branches`

Composable Profile 的每条分支包含：

| 字段 | 含义 |
|---|---|
| `nodeId` | 触发分支的已完成 Node。 |
| `portId` | 读取的 typed output 端口。 |
| `schemaId` | 端口必须匹配的 Schema ID。 |
| `path` | 在 output value 中按点号读取的路径。 |
| `equals` | 严格相等的匹配值。 |
| `features` | 命中后追加的 1–20 个完整 Feature。 |

最多 32 条分支。同一 Node 的规则必须恰好命中一条：零命中返回 `WORKFLOW_BRANCH_UNMATCHED`，多命中返回 `WORKFLOW_BRANCH_AMBIGUOUS`。追加 Feature 自动依赖触发 Feature，总 Feature 数不得超过 100。

### 5.6 循环 `repeats`

循环不是回边，而是有界地追加新 Feature 实例：

| 字段 | 约束/含义 |
|---|---|
| `id` | 循环规则唯一 ID。 |
| `nodeId` | 触发 Node；每个 Node 最多一条循环规则。 |
| `portId`、`schemaId`、`path` | typed stop selector。 |
| `until` | `path` 的值严格等于它时停止。 |
| `maxIterations` | 1–20。 |
| `onExhausted` | 当前固定 `attention-required`。 |
| `features` | 每轮追加的 1–20 个 Feature；必须是有效无环 DAG。 |

最多 16 条 repeat 规则。新实例 ID 为 `<原ID>--repeat-<ruleId>-<iteration>`；内部依赖同步改写，没有内部前置的 Feature 自动依赖触发 Feature。超过次数不会假装完成，而是返回 `WORKFLOW_REPEAT_EXHAUSTED`。

### 5.7 Profile 关闭参数

通用 Composable Profile 支持 `requiredFinalGates`、`requiredDecisions`、`branches`、`repeats`。

Delivery Profile 还使用 `requireCanonicalDecision`、`requireUserCodeReview`、`requireFinalQualityReview`。Batch Profile 使用 `activeBatch`、`batches`（含 `id`、`order`、`status`）、`maxLogicalItems`、`requireRuleReady`、`requireHarnessAcceptance`、`requireIndependentReview`、`requireUserItemAcceptance`、`requireBatchCloseDecision`、`requireBatchLaunchDecision`、`requireFinalQualityReview`。这些值通常由 Lifecycle Planner 根据 action 生成，不建议项目配置直接伪造关闭条件。

## 6. Gate Recipe API

| 字段 | 必填 | 默认/约束 | 含义 |
|---|---:|---|---|
| `id` | 是 | 非空 | Gate ID。 |
| `executionClass` | 是 | 固定 `deterministic-process` | 不允许用 Agent 推理冒充可复现 Gate。 |
| `executorPluginId` | 否 | 已安装的 Gate Executor ID | 省略时使用内置进程执行器。 |
| `command` | 是 | 非空字符串数组 | 可执行文件与参数；不经过 shell 拼接。 |
| `scope` | 否 | `feature`、`stable`、`final` | Gate 生命周期范围。 |
| `required` | 否 | 默认由 Planner 解释为 required | 是否进入必过集合。 |
| `forceFresh` | 否 | boolean | 要求当前来源上重新执行；final Gate 通常为 `true`。 |
| `cwd` | 否 | 相对工作区路径 | 执行目录。 |
| `timeoutMs` | 否 | 正整数 | 超时毫秒数。 |
| `environment` | 否 | 字符串映射 | 明确环境变量；不是继承全部宿主环境的开关。 |
| `outputs` | 否 | Managed Output 数组 | 声明临时、Evidence、Cache 或 Artifact 输出预算。 |
| `sandboxMode` | 否 | `optional` 或 `required` | OS sandbox 要求；`required` 且无 Provider 时失败。 |
| `sandboxPluginId` | 否 | 非空 | 指定 sandbox Provider。 |
| `toolchainDigest` | 否 | 64 位 SHA-256 | 固定工具链身份。 |

每个 `outputs[]` 项包含 `id`、`retention`、`maxBytes`、`maxFiles`，以及可选 `environment` 数组。`retention` 支持 `ephemeral`、`evidence-then-delete`、`cache`、`artifact`。命令参数可用 `{{output:<id>}}` 引用受管路径；未声明端口、超字节或超文件数都会失败。

Gate 通过至少绑定 Run/Epoch、recipe/spec、`sourceDigest`、实测工具链、执行插件、Evidence 与 fresh 状态。Feature Gate 按 `gatePlan` 在对应 Feature 完成后执行，并阻断依赖 Feature 发车；必需的 stable Gate 在最终关闭前执行。缓存命中必须产生当前 Run 的派生 Evidence，不能把旧 Run 的引用直接升级为当前 fresh 结论。正式质量关闭要求当前周期 P0–P3 Finding 全部关闭。

## 7. 初始化、校验与宿主绑定

只校验，不写 Registry：

```text
agent-harness config schema
agent-harness config validate --config ./harness.json --project-root .
agent-harness init plan --config ./harness.json --project-root .
```

批准后应用：

```text
agent-harness init apply --plan ./init-plan.json --command-id init-001 --decision ./decision.json
```

或者一次执行计划与应用：

```text
agent-harness init execute --config ./harness.json --project-root . --command-id init-001 --decision ./decision.json
```

输出 `project-initialization-receipt`，其中 `hostBinding` 包含 `alias`、`projectId`、`profileId`、`extensionId`、`workspaceRoot` 和精确 Workflow 身份。Codex、OpenCode、VS Code 适配器都必须消费该绑定或等价的已验证 Registry 数据，不能在业务仓搜索源码来猜配置。

## 8. 本地源码调试与热更新

建立 source-link：

```text
node <Harness源码根>/bin/agent-harness.mjs dev execute --config ./harness.json --project-root . --binding-id my-project
```

检查变化：

```text
agent-harness dev patch status --manifest <manifest.json>
agent-harness dev watch --manifest <manifest.json>
```

分级规则：

| 级别 | 典型变化 | 当前 Run | 操作 |
|---|---|---|---|
| `H0` | `docs/`、`examples/`、`test/`、根 README | 立即继续 | 无 Runtime rebind；记录新 manifest/receipt。 |
| `H1` | Flow `graph/`、`nodes/`，只影响未来编译出的 Plan/Feature | 当前已冻结 Run 继续 | 批准后 rebind；当前进程保持原已加载代码，新 Run 使用新摘要。 |
| `H2` | Profile、Planner、Workflow 平台、Gate 脚本、业务变体 | 不复用 | 重启协调器并新建 Run。 |
| `H3` | Application、CLI、Runtime/插件宿主、集成入口、`package.json` | 不复用 | 重启协调器并新建 Run。 |
| `H4` | Kernel、Authority、持久化、关键 command/result schema、Registry/Recovery | 禁止热应用 | 显式状态迁移方案或新 Release、新 Run。 |

应用 H0/H1/H2/H3 补丁：

```text
agent-harness dev patch plan --manifest <manifest.json> > patch-plan.json
agent-harness dev sync --manifest <manifest.json>
```

从项目 checkout 主动执行 `dev execute`、`dev apply`、`dev sync` 或 `dev patch apply/rollback`，调用本身授权 source-link 绑定和 H0–H3 同步；应用层据此生成带 `local-development-invocation` 来源、固定计划摘要和命令 ID 的 Authority Decision，不要求人工另行签发。从 Harness 侧代项目执行时仍需 `--decision`。命令返回 `development-patch-receipt`、变更文件、前后摘要、受影响 Run 和明确的 `continuation`。H1 的“同 Run 继续”仅指当前 Run 已冻结的 Feature/Plan 不受影响；不能用新 Node 定义重写已派发 Feature。H2/H3 不允许把运行逻辑变化偷偷注入旧 Run。

每个 Runtime generation 都快照到控制根：

```text
agent-harness dev generations --manifest <manifest.json>
agent-harness dev patch rollback --manifest <manifest.json> --target-manifest <old-generation-manifest.json>
```

Rollback 要求工作树已经恢复到目标 Runtime 摘要；它不会替用户改源码。source-link Receipt 只用于开发验证，不能充当发布、签名或生产切换证据。

## 9. 错误与诊断约定

CLI 失败输出 `{ok:false, code, message, details}`。常见错误：

- `PROJECT_HARNESS_CONFIG_INVALID`：`harness.json` 顶层结构错误；
- `BOOTSTRAP_PROJECT_INPUT_INVALID`：`project.input` 不符合生成器专属 Schema；
- `PROJECT_CONFIG_ID_MISMATCH`、`PROJECT_CONFIG_WORKSPACE_MISMATCH`：`project.input` 与 `binding` 身份冲突；
- `PROJECT_CONFIG_GENERATOR_EXTENSION_REQUIRED`、`PROJECT_CONFIG_BOUND_EXTENSION_REQUIRED`：绑定 Extension 未声明；
- `PROJECT_EXTENSION_ARTIFACT_REQUIRED`：Extension 没有已验证摘要；
- `PROJECT_INIT_CONFIG_CHANGED`：Plan 后配置变化；
- `DEVELOPMENT_PATCH_PLAN_STALE`、`DEVELOPMENT_PATCH_SOURCE_CHANGED`：补丁计划已过期；
- `DEVELOPMENT_PATCH_DECISION_REQUIRED`：运行时代码补丁缺少批准；
- `DEVELOPMENT_PATCH_INCOMPATIBLE`：H4 不可热应用；
- `WORKFLOW_BRANCH_UNMATCHED`、`WORKFLOW_BRANCH_AMBIGUOUS`、`WORKFLOW_REPEAT_EXHAUSTED`：分支/循环无法安全继续；
- `OUTPUT_*_BUDGET_INVALID`、`OUTPUT_TOKEN_UNKNOWN`：Gate 输出声明或预算错误。

诊断命令：

```text
agent-harness doctor --control-root <Harness控制根> --data-root <数据根>
agent-harness dev doctor --manifest <manifest.json>
agent-harness workflow list --project <projectId>
agent-harness run status --project <projectId> --run <runId>
```

## 10. 明确不能做什么

- `harness.json` 不能授予用户批准、提交、发布、push、删除旧 Harness、外部 cutover 或不可逆迁移权限。
- 项目配置不能把 Authority、Evidence、Cache、Recovery 或 Harness 源码写进业务仓。
- `module` 不能绕过制品清单从任意本机文件执行生产 Extension。
- `headless` 不能通过 Runtime 名称、模型名或登录用户自动推断。
- Node 未知字段、Feature `metadata`、Runtime 配置不能自动扩大写路径或工具权限。
- `maxConcurrency` 不能绕过 Feature 依赖、冲突图或批次 Barrier。
- Gate 缓存、旧 Evidence、旧 Review 不能直接升级为当前来源的 fresh 结论。
- 修改配置、源码 rebind 或 Gate 通过都不能改写既有 Run 历史，也不构成删除 Legacy 资产的授权。
- source-link 不能冒充不可变 `1.0.0` 发布制品。

对应的中立机器契约随包位于 `schemas/project-harness-config.schema.json`、内置通用 Flow 的 `*-project-input.schema.json`、`schemas/project-descriptor-input.schema.json`、`schemas/node-task-contract.schema.json`、`schemas/workflow-definition.schema.json`、`schemas/feature.schema.json` 与 `schemas/composable-workflow-profile.schema.json`。业务 Extension 的 Project Input 契约由其 `projectConfiguration.schema` 随 Extension 制品发布，不属于本通用 API 的字段目录。
