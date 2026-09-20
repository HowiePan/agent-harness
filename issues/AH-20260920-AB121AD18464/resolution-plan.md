# 共享生命周期结果契约与跨流程准出修复方案

> 2026-09-20 方案。以 `AH-20260920-AB121AD18464` 为触发事件，覆盖 Engine、Collection、需求设计、知识问答及复用共享执行层的流程。本文件是修复与验收计划，不代表 Issue 已分诊、真实 Run 已恢复或任何流程已准出。V1.0.0 仍为唯一交付版本。

## 1. 已确认事实与范围

| 范围 | 已确认的问题 | 证据入口 |
| --- | --- | --- |
| Codex 可见评审 | Prompt 未给出完整结果形状；Codex Host Adapter 要求 11 个顶层字段及完整 Finding/Follow-up 形状，实际评审结果被 `CODEX_COLLABORATION_RESULT_SCHEMA_INVALID` 拒绝 | `src/platform/plugins/codec/agent-prompt-codec.mjs`、`schemas/codex-runtime-result.schema.json`、`integrations/codex/agent-harness-codex/lib/codex-collaboration-host-adapter.mjs`、本 Issue `intake.json` |
| 需求设计、知识问答 | 这些流程的完成结果必须有类型化 `outputs`；通用结果 Schema 允许 `outputs`，Codex Runtime 结果 Schema 却未定义该字段且禁止额外字段。因此 Codex 可见适配器会拒绝含 `outputs` 的完成结果；省略它又会被 `composable-workflow` Profile 拒绝 | `schemas/visible-agent-result.schema.json`、`schemas/codex-runtime-result.schema.json`、`src/platform/workflow/profiles/composable-workflow.mjs`、两条流程的节点定义 |
| 组合流程失败终态 | `composable-workflow.validateResult()` 对 `failed`/`blocked` 仍要求完成态的 `outputs`；宿主产生的失败终态没有这些端口，因此无法正常提交失败结果 | `src/platform/workflow/profiles/composable-workflow.mjs`、`codex-collaboration-host-adapter.mjs` |
| 重试 | Readiness Report 默认 60 秒有效；使用已过期报告重试被 `EXECUTION_READINESS_EXPIRED` 拒绝。过期校验本身有必要，协调器缺少可靠的自动刷新和续接路径 | `src/application/harness.mjs`、`src/application/execution-readiness.mjs`、本 Issue `intake.json` |
| 准出证据 | 现有跨流程 `closed` 记录使用合成 Runtime/独立临时数据；合成可见质量 E2E 的 Host 直接返回预置合法对象，未检验真实 Codex 原生结果 | `docs/history/acceptance/project-structure-refactor-2026-09-19.md`、`test/quality-lifecycle-e2e.test.mjs`、`scripts/workflow-canary.mjs` |

本轮尚未取得各业务流程的真实宿主完整运行证据，也未检查真实 V3.8.4 Run Authority。以下方案不把对话摘录中的检查通过或 Finding 数量当作已提交结论。不能因修好当前几个报错就宣称所有潜在问题已经找齐。

## 2. 目标与边界

1. 每个 Dispatch 在发车前有唯一、版本化、内容摘要绑定的结果契约；Prompt、Runtime/Host 传输和 Harness 提交校验使用同一契约来源。
2. 完成、失败、阻断及宿主传输失败都能形成明确、可恢复的 Authority 结果或拒绝记录；不会把终态 Agent 留成无限重附着的活动 Lease。
3. 修复必须覆盖 Engine、Collection、需求设计、知识问答和其他声明类型化输出端口的流程，不能只针对 Engine quality 加特例。
4. 失败结果不得伪装为完成结果；原生输出不得由协调器猜测、补写事实字段或手工提升为 Authority Submission。
5. 保留 expected revision、幂等 command ID、原子提交、源摘要、权限边界、可见宿主 attestation、修复验证 Receipt 与 P0–P3 全关闭要求。
6. 不启动或恢复 CardWorld、V3.8.4、Collection B1 等真实 Run，不触碰冻结的旧 Harness/业务仓状态。Commit、tag、发布、激活、插件重装、真实业务 Canary、旧文件清理由用户决定；准出不构成删除授权。

## 3. 结果契约改造

### 3.1 单一结果契约来源

新增中立 `ResultContract`，由不可变 Plan/Dispatch 的 Feature kind、stage、`outputPorts`、端口值 Schema、质量策略和 Runtime 能力确定。至少包含 contract ID、版本、内容摘要、基本结果分支、完成态端口约束及业务校验引用。把 ID/版本/摘要钉入 Dispatch packet、编译 Prompt、Lease/Runtime Receipt、结果 Evidence 和 Submission；任何端点上的摘要漂移都在发车前或提交前拒绝。

结果分为三个语义分支：

- `completed`：必需 `status`、非空 `summary`、准确 `changedFiles`；按 Feature 要求类型化 `outputs`、质量 Finding、验证 checkpoint。只读评审的 `changedFiles` 必须为空；修复完成必须有通过且有证据的 checkpoint 和宿主保存的验证 Receipt。
- `blocked` / `failed`：必需 `status`、非空 `summary`、准确 `changedFiles`、稳定的 `failureClass`/`blocker`；不要求成功端口、成功 checkpoint、Finding 或 Follow-up Feature。
- 宿主传输拒绝：不是 Agent 的业务完成结果。保存原生终态观察、原始输出摘要和字段级错误，生成版本化 `ResultRejectedReceipt`；由 Core 以 expected revision 和幂等命令将本次 Dispatch/Lease 转为可恢复的终态，按既有 attempt policy 决定新 Dispatch 或 attention-required。不得改写原生输出后补交。

`made`、`notMade`、`observations` 等描述性字段不再对所有成功结果强制要求；无业务意义的 `followUpFeatures: []` 也不再作为通用传输门槛。质量 Finding 的非空证据与影响路径、修复 checkpoint、类型化端口值和变更路径仍由相应阶段严格验证。Engine/Collection 的修复 Feature 继续从已提交 Finding 生成，不能从未经提交的模型文本生成。

### 3.2 类型化输出端口

当前 `outputPorts` 只存 schema ID。为每个端口补充由获批准 Extension 提供的版本化值 Schema 与制品摘要，Plan 编译时验证端口名、schema ID、值 Schema 和 Profile 检查一致。需求设计、知识问答的首个节点以及分支节点都要能生成可验证的端口契约；外部来源引用仍必须遵守 Source Manifest 和证据边界。

Codex 可见适配器按该 Dispatch 契约验证实际 JSON，允许且只允许声明的 `outputs.<portId>`。Codex CLI 的 provider Schema 另由同一契约编译为其支持的受限方言，明确列出端口和值对象字段；`uniqueItems` 等 provider 不支持的约束只在 provider Schema 中剥离，Harness 本地仍复验。若端口值 Schema 无法编译为所选 provider 方言，**preflight 必须报不兼容并阻止 spawn**，不能等 Agent 完成后再拒绝。不得把 Codex provider 的限制放进中立 Kernel。

### 3.3 Prompt 与校验同步

Prompt Codec 从同一 `ResultContract` 确定性渲染完整、可执行的结果格式：本次状态分支、必需字段、精确端口及值结构、Finding 所需证据和路径、修复验证要求。删除“遵循宿主提供的 Schema”但实际未提供 Schema 的模糊句子。合同文字和数据进入 `promptDigest`；适配器必须原样传输生成的 Prompt。Prompt Contract/Runtime Result Contract 需要显式版本升级；不能静默重解释旧 Dispatch。

## 4. 协调、失败和恢复

1. 在 Plan/preflight 检查 Extension、Prompt Codec、Runtime 及 Host 对该结果契约的能力，包括 Codex provider Schema 可表示性和真实宿主原生工具形状；一次列出全部可预知 blockers。
2. Native Agent 完成后先保存原始终态引用与输出摘要，再按绑定契约解析、传输校验、业务校验、工作区快照核对并提交；各层给出字段路径、预期契约摘要、Agent/Dispatch 绑定和可操作失败码。只有完整通过才能进入 Submission/Finding/后续 Feature。
3. 原生 Agent 已终态而 JSON/Schema 不合格时，使用 `ResultRejectedReceipt` 收束该尝试并使同一 Run 可重试；无法证明原生终态或收容状态时保持 `attention-required`，不启动替代 Agent。重试必须遵守 attempt budget，防止无限重复发车。
4. Readiness 过期时，由协调器针对同一不可变 Plan 重新生成报告、重新核验 Project/Release/Source/Lineage 和 active Lease，再继续；不延长旧报告、不复用旧命令输入、不手工选择 Run。若 Plan 身份或源码已变，返回明确的重新规划原因。
5. 恢复测试覆盖 spawn 前、Lease 绑定后、结果拒绝后、修复中、Gate 失败后重启；保持原 Run/Epoch 语义，只有现有 Recovery Contract 需要时才建新 Epoch。

## 5. 校验减负规则

| 保留并严格执行 | 调整方式 |
| --- | --- |
| Authority revision/幂等命令、Dispatch/Agent/Prompt/Packet 摘要、宿主可见性与 Lease 观察、路径与源摘要、P0–P3 Finding、修复验证 Receipt、最终 Gate | 在各自信任边界核验一次并保留 Core 防篡改复验；同一事实由共享契约派生，避免维护多份不一致的字段表 |
| 完成态所需的端口值、Finding 证据、质量复审 | 按 Feature/阶段要求，不强加给所有 Agent 结果或失败终态 |
| Readiness 新鲜度 | 协调器自动刷新并重核绑定；用户只处理真实授权或无法安全恢复的状态 |
| Provider Schema 兼容性 | 在 spawn 前编译并验证；不在长流程结束后才暴露可预知不兼容 |

任何宽松化都不能把缺失证据变成已通过，也不能把旧对话或旧状态字符串升级为新 Authority 结论。

## 6. 实施顺序

1. **建立失败基线。**用最小夹具复现四个已确认问题：质量评审字段不匹配、类型化 `outputs` 被 Codex Schema 拒绝、组合流程失败结果被 Profile 拒绝、Readiness 过期重试。保存测试对应的失败码与契约摘要；不接触真实业务 Run。
2. **契约与版本。**实现 `ResultContract`、端口值 Schema 注册/摘要绑定、阶段分支与 Prompt/Provider Schema 编译；更新 Plan/Dispatch/Receipt schema 和版本迁移规则。
3. **传输与 Authority。**改造 Codex 可见适配器、显式 headless Codex CLI 方言编译、Application/Profile/Core 校验和 `ResultRejectedReceipt` 状态转换；保持原生输出与 Evidence 的可审计性。
4. **续接。**修复 Readiness 过期自动刷新、终态拒绝后的 bounded retry、活动 Lease 重附着及重复 spawn 防护。
5. **流程逐项复核。**Engine/Collection 各动作、需求设计每类节点、知识问答命中/检索/澄清/回答分支及其他声明 `outputPorts` 的流程，核对 Plan 权限、成功/失败结果、Follow-up、Gate/Decision、停止条件。
6. **打包和准出。**源码测试、Conformance、clean-room、pack/residue 后，使用同一不可变制品与已安装插件在独立合成仓执行真实 Codex 宿主 Canary。最后才按用户单独授权进入真实业务 Canary、激活或发布。

## 7. 验收矩阵与硬 Gate

| 用例 | 必须拿到的证据 |
| --- | --- |
| Engine quality/full | 真实可见 Agent 的 review→Finding→repair→全量 re-review→最终 Gate→Closure Receipt；9 条对话摘录中的 Finding 不作输入，现场结果重新评审获得 |
| Engine 其他状态变更动作 | 每个 action 的真实命令入口、Plan、至少一条成功和一条失败/阻断路径；所需 Decision/Gate 后产生闭环或明确 attention Receipt |
| Collection full/quality 与其余状态变更动作 | 批次 Barrier、逐游戏/共享能力、Finding 修复、复审、验收 Decision、最终 Gate 和 Closure Receipt；逐 action 记录，不沿用 Engine 结论 |
| 需求设计 | 每一类 `outputs` 端口由真实适配器接收，写文档节点核对实际变更，review 输出通过 Profile 并闭环；失败终态能提交且无卡死 Lease |
| 知识问答 | 记忆命中、检索、证据不足澄清和回答四条分支各有真实端口与 Evidence；失败终态可恢复 |
| 共享协议负例 | 缺字段、额外字段、错误端口 Schema、provider 不兼容、原生终态非法 JSON、摘要错配、源码漂移、过期 Readiness、重启与重复结果；均无虚假 Submission、无重复 spawn、无孤儿 active Lease |

准出分三级记录，不能混用：

1. **代码候选**：单元、集成、合成 E2E、Conformance、clean-room、pack/residue 全通过，仅证明实现和包结构。
2. **真实宿主可用**：当前同一制品的 Codex 原生工具和原生 Agent 在独立合成仓完成上述各流程正向闭环及失败恢复；记录 Contract/Prompt/Adapter/Release 摘要与 Authority Closure/Attention Receipt。任一流程缺证据即该流程未准出。
3. **真实业务准出**：在前两级完成后，按用户对准确目标的授权执行新业务 Canary，并核对源码摘要、零越权写入、全部 Gate 与最终 Authority 状态。未授权的真实 Run、外部切换、发布和旧文件清理不属于本方案自动步骤。

## 8. 完成判定

所有已确认跨契约缺陷都有回归测试；全部声明支持的状态变更流程通过对应真实宿主闭环和失败恢复；未准出的动作在命令入口明确标为 unsupported/attention-required，不报告 ready；没有以人工补写 JSON、绕过校验或重复批准替代修复。最终交付附问题清单、改动与协议版本、测试/Canary Receipt、未覆盖范围和剩余风险。仅在这些证据齐全时才把对应流程标为 operationally ready。
