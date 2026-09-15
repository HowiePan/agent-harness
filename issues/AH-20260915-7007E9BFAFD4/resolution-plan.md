# AH-20260915-7007E9BFAFD4 修复方案

> 实施状态：`resolved / source-and-package verified`（2026-09-15）。正式 commit、同版本插件重装、tag、publish 与真实迁移执行仍遵循项目所有者 Gate，不属于本次代码修复。

## 审核结论

- 分级：`P1`
- 分类：`defect / lifecycle-authority-boundary`
- 状态：`accepted`
- 结论：问题成立，并且不只影响 `quality`。当前实现把 Run lineage 选择、恢复机制选择和用户授权混成一个 Gate，导致 Harness 将自己能够凭 Authority、Evidence 和策略确定的技术决策抛给用户。
- 扩展结论：进程重启后的 reattach、ordinary resume、hard recovery、旧 Run supersede 与 clean start 都应先由 Harness 按确定性策略裁决。用户不应回答“续旧 Run 还是建新 Run”“普通恢复还是硬恢复”这类内部实现问题。
- 权限结论：`hard recovery` 不应仅因机制名称而天然成为受保护操作。是否需要用户介入应由动作的实际效果决定：发布、最终 cutover、权限扩张、不可逆外部副作用、删除或覆盖旧数据仍需单独授权；仅在 Standalone Control Root 内建立新 Epoch、保存回滚快照、废止旧 Transport 并强制重新验证，不应重复请求用户批准。

本审核与方案不启动、恢复、supersede、归档或删除任何真实 Run，也不修改任何业务仓。

## 已核验证据

1. `createLifecyclePlan()` 先按 `project + intent + sourceDigest + Harness artifactDigest` 推导新 Run ID，再把同一 action/target 下所有未关闭 Run 填入 `activeRunConflicts`；它没有判断候选 Run 是否同源、同计划、可 reattach、可 ordinary resume 或只有空壳状态。
2. `createExecutionReadinessReport()` 对每个候选一律产生 `ACTIVE_LOGICAL_RUN_CONFLICT`；`startLifecyclePlan()` 再次无条件拒绝含冲突的 Plan。因此当前行为不是“信息不足后谨慎询问”，而是缺少 lineage resolver。
3. 已存在的 `run supersede` 只提供底层状态转换，没有被生命周期 Plan/Coordinator 编排，也没有唯一 active lineage Authority；调用方只能在 Harness 外自行选择旧 Run 和替代 Run。
4. `LifecycleCommandPlan.planDigest` 当前包含 `authority.expectedRevision`、`existingRunId` 和 `activeRunConflicts`。这些是易变观察值，不是不可变计划语义。Run revision 前进或冲突集合变化后，重新编译的摘要会变化，和已保存的 `metadata.lifecyclePlanDigest` 发生冲突，破坏同一 Run 的稳定续跑。
5. ordinary resume 已具备正确的基本语义：保留 Epoch 和逻辑尝试预算、提升 Generation、废止旧 Lease/Dispatch。可见 Runtime 也已有活动 Lease reattach 验证路径。这两种情况都不需要用户选择。
6. hard recovery 已具备 Capsule 全量复验、内容寻址 verification Evidence、expected revision、稳定 command ID、回滚快照、新 Epoch、旧 Transport 作废和旧完成态重新验证。真正多余的是把 `live-hard-recovery` 人工 Decision 硬编码成唯一 authority basis，而不是这些安全约束。
7. Engine 与 Collection 的 Command Manifest 仍把 `hard-recovery` 作为固定 approval/protected operation；Operator Contract、Skill、CLI 和测试也共同固化了这一机制型授权边界。

## 目标契约

一次有效的状态变更生命周期命令授权 Harness 在该 Command Manifest、Project Descriptor、workspace、target、source policy 和 stop condition 范围内，自主完成 Run 选择与安全恢复。Harness 必须给出可审计的理由和 Receipt，但不得要求用户替它选择恢复算法。

用户介入边界改为“效果型”而非“机制型”：

- Harness 内部裁决：复用现有 Run、reattach 原 Agent、ordinary resume、创建新 Generation、经验证的 hard recovery、新 Epoch、自动 supersede 空壳或不兼容旧 Run、保留旧 Run 只读、重新验证旧完成态。
- 仍需用户 Authority：扩大 action/target/workspace/path 权限，启用新的 Runtime 或进程权限，发布、push、最终 cutover，不可逆外部迁移，删除/覆盖 Capsule 或旧 Harness，以及无法由 Evidence 判定的业务语义冲突。
- 没有安全路径时返回结构化 `blocked`，说明缺少的 Evidence、能力或权限；不得把内部选项包装成“请用户决定”。用户只有在能够提供新事实、扩大权限或批准受保护效果时才需要介入。

## 术语归一

“重启”“恢复”和“重建”必须分开，避免继续用“硬重启”覆盖不同语义：

| 情形 | Authority 动作 | 默认裁决 |
| --- | --- | --- |
| Harness/宿主进程重启，原 Agent 可验证 | `reattach` | 自动重连，同 Epoch/Generation |
| Transport 丢失、Lease 过期或原 Agent 不可继续，Authority 兼容 | `ordinary-resume` | 自动提升 Generation，废止旧 Transport |
| Authority/Importer 边界变化，需要从受管 Capsule 重建可信状态 | `hard-recovery` | 验证通过后自动建立新 Epoch，并强制旧结论重验 |
| 同一逻辑任务的旧 Run 与当前不可变计划不兼容 | `supersede-and-start` | 保留旧 Run 审计，原子切换 active Run |
| 没有可导入 Authority，且安全策略允许无副作用重做 | `clean-start` | 建新 Run，旧事实只读，不宣称继承完成态 |

## 方案

### 1. 拆分不可变 Plan 与易变 Lineage Resolution

将当前 `LifecycleCommandPlan.authority` 中的易变事实移出 `planDigest`。不可变 Plan 只绑定：

- 规范化 Command Intent、action/target/preset/arguments；
- Project、Extension、Harness、Profile、Runtime、Prompt Codec 的版本与制品摘要；
- workspace identity、source digest、Feature graph、Profile config、Gate plan、stop condition；
- 允许的 mutation/effect classes 与真正受保护的效果。

新增短期、内容寻址的 `RunLineageResolution`，绑定：

- `logicalTaskKey`、`planDigest`、候选 Run 的 Authority digest/revision；
- 选中的 `activeRunId`、处置动作和稳定 reason code；
- reattach observation、Lease freshness、Capsule verification、source/plan compatibility 等 Evidence ref；
- 每个受影响 Run 的 expected revision、目标 Generation/Epoch；
- resolution TTL、policy version、`resolutionDigest`。

Preflight 同时校验不可变 Plan 和未过期的 Resolution。Authority revision 变化只使 Resolution 失效并触发内部重算，不改变 Plan identity，也不要求用户重新授权。

### 2. 建立唯一逻辑任务与唯一 active lineage

新增稳定 `logicalTaskKey`：

```text
digest(projectId, workspaceIdentity, action, target, normalizedPresetAndArguments, profileId)
```

`sourceDigest`、Harness/Extension artifact digest 和运行 revision 不进入 logical key；它们进入 compatibility fingerprint。这样同一业务目标跨源码或制品变化仍属于同一 lineage，但不会被错误地当作可直接复用的同一执行状态。

在 Project Authority 下新增单文件 `RunLineage` 记录，至少包含 `logicalTaskKey`、`activeRunId`、revision、history 和最近一次 resolution digest。Scheduler/Coordinator 只允许 lineage 指针指向的 Run 发车。首次接入已有多个 Run 时，Resolver 只读建模并按规则选主，其余保留为审计历史。

active pointer 切换使用 logical-key 级锁、expected revision、稳定 command ID 和 crash journal：先准备 replacement Run，再原子切换 lineage pointer，最后投影旧 Run 的 superseded 状态。崩溃恢复以 lineage pointer 为准，不能暴露两个可调度 active Run。

### 3. 实现 Core `RunLineageResolver`

Resolver 不由 Extension 或对话模型自由实现。Extension 只能声明版本化兼容策略；Core 读取 Authority/Evidence 后按固定优先级输出一个动作：

1. **RETURN_CLOSED**：相同 Plan 已关闭且 Receipt 完整，幂等返回，不创建 Run。
2. **CONTINUE**：相同 Plan、source 和执行策略，且无活动 Lease；继续现有 Run。
3. **REATTACH**：存在活动 Lease，原 Host/Agent/Dispatch/Packet/Prompt 证明仍新鲜；重连原 Agent。
4. **ORDINARY_RESUME**：Plan 与 Authority 兼容，但 Transport 已失效、Lease 过期或 Agent 不可继续；同 Epoch 新 Generation，逻辑预算不刷新。
5. **HARD_RECOVER**：只有跨 Authority/Importer/Epoch 边界才能恢复，且 Capsule、Importer、source、容量、链接拒绝、目标 Epoch 和回滚快照条件全部通过。
6. **SUPERSEDE_AND_START**：旧 Run 不兼容，但旧状态保留可审计，当前命令允许重新执行且不存在不可重复外部副作用；原子切换到确定性 replacement Run。
7. **BLOCK**：Evidence 损坏/歧义、存在无法隔离的实时副作用、超出命令范围、缺少必需能力或需要真正受保护效果。返回单一原因及缺失条件，不询问用户选择恢复方式。

同级候选使用确定性排序：active lineage pointer 优先，其次 compatibility 等级、可验证 Lease、Authority epoch/generation、最后更新时间和稳定 Run ID。多个候选只有在结果语义相互冲突且无法由 Evidence 消歧时才 `BLOCK/LINEAGE_EVIDENCE_AMBIGUOUS`。

### 4. 将 hard recovery 改为策略授权，而非二次人工批准

保留 Recovery Coordinator 作为唯一 hard-recovery 写入口，并保留现有所有校验；替换唯一的人工 `decisionId` 前置条件：

- 新增 Core 生成的 `RecoveryResolutionReceipt`，由 `RunLineageResolver` 产生并绑定原始 lifecycle command/Plan、recovery policy version、verification ref、project/run、expected revision、当前 epoch/generation、target epoch、effect classes 和 resolution digest。
- `RecoveryCoordinator.hardRecover()` 接受该 Receipt；Kernel 仍只接受私有 capability，拒绝直接调用。
- 自动 hard recovery 只允许 `effectClasses` 完全落在原命令授权范围内，且必须包含 rollback snapshot、旧完成态 `stale-revalidate`、旧 Lease/Dispatch 作废和迟到结果拒绝。
- `h:<project> recover <run> hard` 本身就是显式恢复命令，不再追加一次“是否真的 hard recover”的对话批准；它仍必须通过同一 Resolver 和 Capsule verification。
- 移除 Command Manifest 的 `approval: live-hard-recovery` 以及通用 `protectedOperations` 中按机制列出的 `hard-recovery`。受保护列表改为 `publication`、`external-cutover`、`privilege-expansion`、`irreversible-migration`、`legacy-destruction` 等效果类。
- 为兼容旧记录，可继续读取已有 `live-hard-recovery` Decision 作为一种 authority basis，但新流程不再生成或要求它。

### 5. 规定 source drift 与 clean start 行为

- source 与现有 Run 一致时才允许直接 CONTINUE/REATTACH/ORDINARY_RESUME。
- source 改变时，不把旧完成态升级为当前完成态；根据声明式 impact policy 选择 artifact rebase 或 replacement Run，并重新验证受影响 Feature。
- Capsule 不存在或验证失败时不得伪造 hard recovery。若 action 可安全重放、外部副作用可证明为零或幂等，则自动 clean start，并保留旧 Authority 只读。
- 如果重放可能造成不可逆外部副作用，则阻断为 `RECOVERY_SAFE_REPLAY_UNPROVEN`。此时用户可提供缺失 Evidence 或批准对应的受保护外部效果，但仍不需要替 Harness 选择 ordinary/hard/new Run。

### 6. 调整 Adapter 与用户体验

Codex Skill/Hook 只展示 Harness 已经作出的处置和证据，例如：

```text
已选择 ORDINARY_RESUME：Run r1，epoch 2，generation 4；原因是 Lease 已过期且 source/plan 相容。
```

不得再展示“恢复既有 Run 还是创建 replacement Run？”或“是否 hard recovery？”这类技术选择题。需要权限时只描述实际效果与准确目标，例如“该操作将发布制品 X”或“将删除 Capsule Y”。

## 实现切片

1. **Contract**：新增 `RunLineage`、`RunLineageResolution`、`RecoveryResolutionReceipt` schema、reason code 和 effect-class vocabulary；从 immutable Plan 移除易变 Authority 字段。
2. **Authority**：实现 logical-key 索引、唯一 active pointer、跨 Run journal、expected revision 与幂等恢复。
3. **Resolver**：实现候选收集、compatibility fingerprint、优先级与七类动作；所有决策为纯策略输出，不允许模型补齐。
4. **Coordinator**：在 preflight 前自动 resolve；原子执行 continue/reattach/resume/hard-recover/supersede-and-start；revision 冲突后读取 Authority 并重算 Resolution。
5. **Recovery**：以 `RecoveryResolutionReceipt` 替换强制 human Decision；保留 Capsule 重验、私有 capability、rollback 和新 Epoch 约束。
6. **Extensions**：Engine/Collection Manifest 声明 action 的 replayability、side-effect class、source compatibility 和 recovery policy；删除机制型 hard-recovery approval。
7. **Adapter/Docs/Skill**：删除用户 lineage 选择路径，更新 Operator Contract、protocol、operations、两个 Codex Skills 和错误文案。
8. **Migration**：只读扫描已有 Run，建立 lineage index；不恢复、不 supersede、不归档、不删除真实历史 Run，直到新实现通过合成 Gate。首次真实处置由新 Resolver 在已授权生命周期命令中完成。

## 验收矩阵

- 同 Plan 的 `ready` Run 无 Lease：自动 CONTINUE，不创建新 Run。
- 同 Plan 的可验证活动 Lease：自动 REATTACH，迟到或不匹配证明被拒绝。
- 同 Plan 的过期/丢失 Transport：自动 ORDINARY_RESUME，Generation +1、Epoch 不变、预算不刷新。
- 同 logical key、不同 Plan/source 且旧 Run 无不可重复副作用：自动 SUPERSEDE_AND_START，旧 Run 保留审计且只能有一个 active pointer。
- 已关闭的完全相同任务：幂等返回 Closure Receipt。
- 多个历史候选：结果与目录枚举顺序无关，选择稳定；无法凭 Evidence 消歧时返回明确 blocker，不询问技术选项。
- 进程在 replacement prepare、pointer switch、旧 Run 投影任一点崩溃：重启后仍只有一个可调度 active Run。
- 已验证 Capsule：无需二次人工 Decision 即可 hard recovery；新 Epoch、回滚快照、旧完成态重验全部成立。
- Capsule 缺失、篡改、过期、Importer/source/epoch 错配：fail closed，不能转成 ordinary resume 或伪 clean start。
- hard recovery 后旧 Agent 的迟到提交被 epoch/generation 校验拒绝；rollback 创建更高 Epoch，不能还原旧 Transport。
- 需要发布、cutover、权限扩张、不可逆迁移或删除时仍准确请求用户 Authority；仅控制根内部恢复不请求。
- 重复 command ID 与相同输入返回同一 Receipt；相同 ID 不同输入被拒绝；revision 冲突只触发内部重新 resolve。
- Engine 与 Collection 至少各有一条 Plan→restart/reattach→ordinary resume→hard recovery fixture→Gate→close 的完整 E2E；全量测试、Conformance、clean-room、pack dry-run 和 residue 均通过。

## 兼容与风险控制

- 这是 Authority 协议变化，应增加 schema minor 版本或明确的兼容字段，不能静默重解释旧 `planDigest`。
- 历史 Run 不补写伪造的 lifecycle Plan，也不把旧状态字符串升级为新结论。迁移索引只记录观察到的摘要和 Resolver disposition。
- supersede 是 lineage 可调度性转换，不是删除。旧 Run、Evidence、Receipt 和 Capsule 继续保留；任何删除仍严格遵守用户单独授权边界。
- hard recovery 自动化不得放松 Capsule、source、Importer、TTL、expected revision、rollback 或新 Epoch 校验；本方案只移除没有决策价值的二次人工选择。

## 关闭 Gate

本 Issue 只有在以下 Evidence 齐备后才能标记 `resolved/closed`：

1. 上述三类 schema 和 Core Resolver 的不可变实现引用；
2. lineage 唯一性、崩溃恢复、候选歧义、ordinary resume、hard recovery 与 protected effects 的完整拒绝矩阵；
3. 当前仓库全量测试、Conformance、clean-room、pack 与 residue 回执；
4. 安装后 Codex Plugin 对新 Skill/Contract 的握手证明；
5. 在合成项目完成至少一次无用户追问的 restart/recovery 全链路 Canary。

真实 Engine/Collection Run、真实 Capsule/cutover、发布、commit/tag/push 和任何旧 Harness 删除不属于本审核授权，也不是关闭本缺陷所必需的前置动作。

## 实施结果

- `LifecycleCommandPlan` 已移除 Authority revision、existing Run 和 conflict list 等易变字段；新增稳定 `logicalTaskKey`。同一计划在 Run revision 前进后仍保持 plan digest 与 Run ID 稳定。
- 新增 `RunLineageResolution`、`RunLineage` 与持久 `RunLineageStore`。Core 确定性选择 return-closed、continue、reattach、ordinary-resume、supersede-and-start、start 或结构化 block；候选顺序不影响 resolution digest。
- 生命周期启动已自动执行普通恢复、旧 Run supersede 和 active pointer 切换；调度、读包、Lease 绑定、heartbeat 与结果提交均拒绝非 active lineage Run。短期 Resolution 因 Authority 前进而失效时，Harness 内部重算，不向用户询问。
- 生命周期 command ID 已贯穿 active pointer Receipt；相同命令/相同输入幂等返回，相同命令/不同输入按 `COMMAND_ID_REUSED` 拒绝。replacement prepare、旧 Run 投影或 pointer 更新中断后的下次 preflight 可凭 Authority 与 lineage pointer 收敛，且未被 pointer 选中的新 Run 不可调度。
- hard recovery 继续强制 Capsule 完整复验、Importer/source/Epoch 绑定、expected revision、私有 Coordinator capability、rollback snapshot、旧 Transport 作废与完成态重验；新流程由 Core 生成内容寻址 `RecoveryResolutionReceipt`，不再强制第二个人工 Decision。旧 Decision 路径保留兼容。
- `source-unavailable` 在只读确认精确 legacy root 不存在后，直接生成 `verified-source-observation` 回执并限定 clean-start-only；不再要求用户选择 clean start。旧 acknowledgement Receipt 仍可验证。
- Engine/Collection Descriptor 与 Manifest 已统一为效果型保护边界；发布、external cutover、权限扩张、不可逆迁移和 legacy destruction 保留单独 Authority Gate，control-root-only 恢复不再按机制名称请求批准。
- Operator Contract、CLI、README、operations/recovery/protocol 文档和三个 Codex Skill 合同已同步；适配器只展示 Core 已作出的处置与 blocker，不再向用户抛出 Run/恢复机制选择。

## 验收回执

- `npm run check`：通过。
- `npm test`：`173/173` 通过。
- `npm run test:conformance`：`3/3` 通过。
- `npm run test:canary`：`3/3` 通过。
- `npm run check:clean-room`：实际 npm tarball 内 `173/173` 通过，独立安装与跨进程 Extension 恢复通过。
- `npm run pack:dry-run`：通过。
- `npm run check:residue`：通过，临时目录不存在，未发现 `.exe`/`.pdb` 残留。
- 最终 release manifest/SBOM：`1.0.0`，189 个受管文件，package digest `749eccb5dd627ee528932e6aab607bce846303ae009b15756f2fcacad10c04f0`。

未启动或修改真实 Engine/Collection Run，未创建真实 Capsule/cutover，未修改冻结旧 Harness 路径，未删除任何旧数据，也未执行 commit/tag/push/publish 或同版本插件重装。
