# AH-20260915-8C001F4D266E 审查与系统性修复方案

## 审查结论

- 建议分级：`P1`
- 建议分类：`defect / integration-and-readiness`
- 建议状态：`accepted`，但本文件不代替经批准的 `issue triage` 写入。
- 本 Issue 不是新的 Bootstrap 初始化故障。计划摘要 `801b6a7f57158f811f10e47e0a431b4aa2c82f5d59e79c21ff4a4dd4aa2d3ba1` 已于 `2026-09-15T03:56:54.651Z` 成功 Apply；Receipt 摘要为 `79479f3ed8edc20d00f208457572975bc578fc51e0d9b7f2fc8bd216a22f567b`，当时以及本次只读复验均为 `lifecycleReady=true`。
- 实际根因是：当前 Codex 插件/CLI 执行链没有把宿主原生的可见 Agent 观察能力注入 `createHarness({ agentAdapter })`。CLI 的 `lifecycle start` 总是无 `agentAdapter` 创建 Harness，因此 conversation-visible Plan 在 Run 创建前必然返回 `visible-agent-host-adapter-unavailable`。
- 当前新增的 `createVisibleHostAdapter()` 只实现了适配器内的身份、摘要、新鲜度校验；现有测试使用合成 `inspectVisibleAgent` 回调，未证明真实 Codex 宿主提供了该能力，也未证明插件能够把该能力传入 CLI/API。
- `doctor` 在宿主适配器不可用、无活动发布 generation、写能力未探测的情况下仍报告 `lifecycleReady=true`，说明当前 readiness 名称和语义存在假阳性。
- `AH-20260915-68116284F352` 在没有不可变实现制品和真实宿主 Canary 的情况下被标为 `resolved`，随后 16 分钟即由本 Issue 复发。建议把本 Issue 记录为其 `regression-of` 或 `successor-of`，并关联仍待处置的 `AH-20260915-4EC6FD529BAA`、`AH-20260914-E31036D1068A` 与 `AH-20260915-F9C3FC2090F4`。

## 系统性排查结果

### 历史范围

当前仓库共有 11 份“启动或就绪阻断”类 Intake，其中 1 份已标记 duplicate，合并后为 10 个独立事件，分属 4 个根因族：

1. 首次安装、数据根、Registry 与只读路径副作用：2 个独立事件。
2. 制品摘要轮换、Descriptor schema 与重复 Bootstrap：2 个独立事件。
3. headless Codex CLI Runtime 的参数、输出文件和 Provider Schema：3 个独立事件。
4. conversation-visible 宿主委派、证明和 heartbeat：3 个独立事件。

活动数据根在约 37 小时内已有 9 份 Bootstrap/摘要同步 Receipt；Extension Registry revision 已到 18，Project Descriptor revision 已到 9，并出现 9 个不同 Harness 制品摘要。这不是正常首次初始化，而是把持续变化的源码工作树反复重新登记为生产身份。

### 当前仍未闭环的同类缺口

可确认有 6 个当前缺口，另有 1 个运行残留问题：

1. **真实宿主能力缺失**：当前会话没有能返回宿主生成 `assertionId`、`observedAt`、可检查任务引用，并绑定 Agent/Dispatch/Packet/Prompt 摘要的原生 `inspectVisibleAgent` 能力。
2. **宿主桥接通道缺失**：即使宿主未来提供该能力，现有 Hook/Skill/CLI 之间也没有受信 IPC、SDK 或 Host Coordinator 入口把它注入 Harness。把模型生成 JSON 传给 `run bind` 不构成可信证明。
3. **readiness 假阳性**：`inspectLifecycleReadiness()` 只覆盖发布清单、存储、Registry、Descriptor、Extension 与 workspace；不覆盖 action/preset 编译、Host Adapter、Runtime Provider、Prompt transport、Gate observer 和写能力，所以当前 `lifecycleReady=true` 不能推出生命周期可启动。
4. **活动发布未真正建立**：`.agent-harness-data/registry/active-release.json` 与 generation 均不存在。当前仍走 legacy Registry；每次源码摘要变化都可能再次要求 Bootstrap。
5. **现有 release activation 仍引用可变源码**：generation 只快照 Registry JSON，Extension `entry` 仍解析到 `controlRoot/src/**`。即使现在 Apply 活动指针，后续源码变化仍会使已激活摘要与入口字节不一致；必须把活动身份绑定到安装后的不可变 tarball/runtime root，而不是开发工作树。
6. **关闭 Gate 与部署证据不足**：当前修复仍是脏工作树，HEAD 为 `758377c809a5cfdc1bd16a8bf65f2511c0b13218`；最新 Release Candidate 属于更早提交 `cf1257a793a911a30f2a97ef3ba203c1453382e0`，没有绑定当前 `2dbbac6f...` 制品的干净提交、RC Receipt、安装后插件握手或真实 visible-Agent Canary。`681162…` 的 resolved 状态因此不能作为关闭证据。

运行残留：`cardworld-engine` 现有 7 个 V3.8.4 quality Run，其中 4 个仍处于 `ready/running`，3 个为 `all-remaining-blocked`；它们绑定不同的历史制品或 Lifecycle Plan。它们不是本次缺件根因，但会使后续 resume、supersede 和“当前 Run”选择产生歧义。未经用户单独批准不得恢复、改写、归档或删除。

## 目标契约

一次状态变更伪命令在创建 Run 前必须获得一份 action-scoped、聚合式的 `ExecutionReadinessReport`。它应同时证明：

- 运行的是已安装、不可变、已激活的 Release Candidate，而非可变源码 checkout；
- Plugin build、Harness release、Extension set、Project Descriptor、Profile、Prompt Codec 和 Lifecycle Command Plan 身份完全一致；
- 目标 action/preset 能确定性编译，所有 protected operation 已列出；
- 所选 Runtime 的真实 Provider 能力可用；conversation-visible 模式下宿主能 spawn、inspect、attest、heartbeat、wait 和返回结构化结果；
- 所有计划 Gate 的工具、sandbox 和 live observer 在启动前可用；
- Authority 的原子写能力已由显式可恢复探针证明；
- 所有缺口一次性聚合返回，不再每修一个就暴露下一个。

`lifecycleReady` 只有在上述 action-scoped 条件全部满足时才可为 true。现有只读检查应更名或拆分为 `installationReady`、`registryReady`、`projectReady`、`executionReady`，避免把 Registry 一致误称为生命周期就绪。

## 修复方案

### W1：纠正 Issue 与关闭语义

1. 将本 Issue 关联为 `regression-of: AH-20260915-68116284F352`、`related-to: AH-20260915-4EC6FD529BAA`、`related-to: AH-20260914-E31036D1068A`、`related-to: AH-20260915-F9C3FC2090F4`。
2. 将 `681162…` 从“已解决”重新审计为“实现候选/等待真实 Host Canary”，或以本 Issue 的 successor 状态明确撤销其关闭结论。
3. 为 `resolved/closed` 增加 Evidence policy：P1 集成缺陷至少要求不可变 commit/RC、安装/激活 Receipt、真实宿主 E2E Canary；纯合成测试不得单独关闭。

### W2：引入聚合式 action-scoped Preflight

1. 新增版本化 `ExecutionReadinessReport` schema 与稳定失败码；由 `lifecycle preflight --plan ...` 零业务写入地产生。
2. Preflight 一次检查 release/registry/project/plan/runtime/host/prompt/gate/write 七层依赖，按层列出全部 blockers，不以第一个异常提前返回。
3. `doctor` 保留零写入安装诊断，但不再单独输出可误解的 `lifecycleReady=true`；写能力使用单独的 `doctor --probe-write`，只在受管临时路径执行原子写、fsync/rename、删除并产生清理 Receipt。
4. `lifecycle start` 只接受同一 Plan、Project revision、Release digest 和短 TTL 下的成功 Preflight Receipt；过期或任一身份变化都重新预检，仍不得创建半成品 Run。

### W3：建立真实 Codex Host Coordinator

1. 先确认 Codex 宿主是否提供可受信的原生 API，用于创建并检查当前任务树中的可见子 Agent，并返回宿主生成、不可由模型伪造的 assertion。没有该产品能力时，应明确声明 `conversation-visible unsupported`，不能在仓库内伪造适配器。
2. 若宿主 API 可用，增加一个宿主侧 Coordinator/SDK 集成入口，而不是让普通 CLI 进程自行猜测 Agent 状态。入口负责：spawn exact prompt、取得 inspect reference、向 Harness 提供受信 observation、周期 heartbeat、wait/interrupt/send、结构化 result transport。
3. Harness 与宿主桥接使用版本化 capability handshake，绑定宿主 provider/version/session、Project、Plan、Dispatch、Packet/Prompt digest 和 TTL；CLI 文件参数、环境变量或模型文本不能充当证明。
4. Codex 插件必须声明并验证该 Host capability；插件只在握手成功后调用 `lifecycle start`。当前仅含 Hook/Skill 的包应在 preflight 中明确报告 `HOST_COORDINATOR_NOT_INSTALLED`。

### W4：改造不可变发布与激活

1. 开发 checkout 只能生成候选，不能作为生产活动 Runtime。先由用户决定提交当前修复，再从干净 commit 构建 Release Candidate。
2. Release activation Plan 必须绑定 RC Receipt、archive SHA-256、安装根与每个实际 Extension 文件摘要；Apply 在新的不可变安装目录中展开并验证 tarball。
3. generation 中的 Extension entry 应相对该 immutable runtime root 解析；活动指针同时绑定 Registry generation 与 runtime root。源码 checkout 后续变化不得影响活动发布。
4. 已存在数据根首次迁入 generation 使用一次显式 activation；Bootstrap 只允许空数据根。业务命令检测到 legacy mutable Registry 时返回 `INSTALLATION_RELEASE_NOT_ACTIVATED`，不得继续循环请求 Bootstrap。
5. 同版本 Codex 插件按既有约束执行 remove/add 清缓存，并在新任务中做 build digest handshake；不得用版本后缀规避缓存。

### W5：Canary 梯度与失败注入

按以下顺序验证，前一层失败不得进入后一层：

1. 单元：合成 Host Adapter 的身份、摘要、TTL、heartbeat 与拒绝路径。
2. Packaged：从真实 tarball 的独立安装根启动 Host Coordinator stub，跨进程完成 Plan → start → schedule → bind → heartbeat → submit → Gate。
3. Desktop integration：在独立合成项目中用真实 Codex 可见子 Agent 完成同一链路，重启桌面后重复一次；证明插件缓存、Hook 环境回退和 inspect reference 均有效。
4. 故障矩阵：缺插件、旧插件、无 Host API、Provider schema 不兼容、Gate 工具缺失、无 observer、数据根只读、Descriptor 旧 schema、摘要漂移、进程重启；每次必须在 Run 创建前聚合报告。
5. 只有以上通过且用户另行批准，才允许真实 CardWorld Engine Canary。该 Gate 不授权发布、commit/push、旧 Harness 删除或恢复历史 Run。

### W6：历史 Run 处置

1. 生成只读 inventory，按 artifact/plan/status 列出 7 个 Run，并选出唯一可由新计划 supersede 的逻辑前身。
2. 修复后的首次真实 quality Plan 使用受 expected revision 和 command ID 保护的 `run supersede` 关系；不复用旧 Lease、Dispatch、Gate 或 completion。
3. 归档、删除或恢复任何旧 Run 均需用户对准确目标单独批准。

## 验收标准

- 在 Host Coordinator 缺失时，`lifecycle preflight` 一次返回全部缺口，`executionReady=false`，且不创建 Run。
- 在 Registry 完整但 Host 不可用时，任何命令不得再报告 `lifecycleReady=true`。
- 激活后修改开发 checkout 不影响活动 Runtime 字节或活动 Extension 验证；业务命令不再要求 Bootstrap。
- 从干净 commit 构建的 RC 在独立安装根通过全量测试、clean-room、pack dry-run、residue 与宿主集成 Canary。
- 真实 Codex Canary 产生可检查子 Agent、可信 attestation、至少一个新鲜 heartbeat、结构化 Submission、Evidence 和 Gate Receipt；重启后复验通过。
- Issue 关闭证据包含 commit/RC/activation/plugin handshake/真实 Host Canary，不再以合成测试或工作树摘要关闭。

## 当前处置建议

1. 不再执行计划 `801b6a...`：它已成功 Apply，重复执行没有修复价值。
2. 不 Apply 本次只读生成的 release activation 计划：当前工作树仍脏、没有对应 RC，而且现有 activation 尚未隔离 runtime 字节。
3. 暂停新的 V3.8.4 quality Run，先完成 W1-W5；历史 Run 维持只读。
4. 当前可复验的实现级证据为 `npm test` 135/135、`npm run check` 通过、clean-room 通过、pack dry-run 通过、residue 通过；这些只证明代码与打包自洽，不证明真实 Codex Host Coordinator 可用。

