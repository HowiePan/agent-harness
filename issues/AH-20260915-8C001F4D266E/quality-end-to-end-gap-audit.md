# AH-20260915-8C001F4D266E：质量审查全链路深度审计

## 结论

截至 2026-09-15，不能认定 Agent Harness 已达到“可用”。现有 `npm test`、clean-room、pack dry-run 与 residue 检查通过，只证明局部实现和包结构自洽；它们没有证明一次真实 Codex conversation-visible Engine 质量审查能够从命令入口连续运行至可信关闭。

以 `h:engine quality V3.8.4 full` 的完整链路为唯一当前目标，保守确认有 **16 项缺口**：

- **13 项功能或契约缺陷**：会阻止启动、续跑、可信提交、修复闭环、Gate 恢复或关闭。
- **2 项关键验证空白**：现有测试无法证明真实宿主链路和当前发布制品可用。
- **1 项运行态治理缺陷**：历史 Run 增殖且没有唯一 continuation/supersede 规则。

这个数字是代码、已安装插件、Registry、Authority 和现有测试可直接证明的下限，不包含尚未通过真实故障注入才能发现的问题，也不把同一根因引发的多次重启重复计数。

## “完整跑完”的验收定义

一次质量审查只有同时满足以下条件，才算完整结束：

1. 当前不可变 Release、插件、Extension、Project Descriptor、Plan 和 workspace 身份一次性预检通过。
2. 原生命令入口创建唯一 Run；真实 Codex 可见 Agent 被宿主创建、检查和可信绑定。
3. 每个 Dispatch 都有及时 heartbeat，结构化结果由宿主传回并通过 schema 校验。
4. 审查阶段只读；发现项形成独立修复 Feature，修复证据包含强制检查点和命令 Receipt。
5. 所有修复完成后重新做一次全量只读审查，确认没有新增或遗漏发现项。
6. 所有最终 Gate 带 live observer 运行；失败返回可恢复状态，修复后能继续，而不是异常终止。
7. 关闭时绑定最终源码摘要、全部 Finding、Submission、Evidence、Gate Receipt 和 Closure Receipt。
8. Codex/桌面在至少三个阶段被重启后，能够按同一 Run、Epoch、Dispatch/Lease 身份继续或明确 hard-recover，不产生孤儿 Run。

## Engine quality/full：16 项确认缺口

### A. 发布、就绪与入口（5 项功能缺陷）

| ID | 缺口 | 直接后果 | 当前证据 |
| --- | --- | --- | --- |
| Q01 | 没有已激活、隔离源码工作树的不可变 Runtime | 源码摘要变化会再次触发制品不匹配和 Bootstrap；Apply 活动 Registry 也不能冻结实际入口字节 | `.agent-harness-data/registry/active-release.json` 不存在；Extension entry 仍解析到 `controlRoot/src/**` |
| Q02 | `lifecycleReady` 是安装级假阳性，不是 action-scoped execution readiness | Host、Runtime、Gate 或写能力缺失时仍可报告 ready，用户只能逐次撞到下一缺件 | `src/readiness.mjs` 只用 release/storage/projects 三项计算，且同时报告 `writeCapability=not-probed` |
| Q03 | 命令 Skill 指向当前不可隐式调用的 Operator Skill | 路由完成后没有可执行的连续操作器 | command Skill 要求 `$agent-harness-operator`，但 operator 的 `allow_implicit_invocation=false`，当前任务暴露的 Skill 列表也不含 operator |
| Q04 | 当前 Codex 宿主没有 Harness 所需的原生 Agent inspection/attestation 契约 | 无法产生不可由模型伪造、绑定 Agent/Dispatch/Packet/Prompt 的 assertion | 当前宿主工具没有返回 `assertionId`、`observedAt` 和绑定摘要的 `inspectVisibleAgent` 能力 |
| Q05 | CLI/插件没有向 Harness 注入 Host Adapter 的桥接入口 | 即便宿主以后提供能力，`lifecycle start` 仍必然在 Run 创建前返回 attention-required | `src/cli.mjs` 两处 `createHarness()` 均未传 `agentAdapter`；`src/app/harness.mjs` 对 visible Plan 返回 `visible-agent-host-adapter-unavailable` |

### B. 调度、重启与结果传输（3 项功能缺陷）

| ID | 缺口 | 直接后果 | 当前证据 |
| --- | --- | --- | --- |
| Q06 | 没有持久化的 conversation-visible Host Coordinator 循环 | schedule、spawn、bind、heartbeat、wait、submit、repair、Gate、close 依赖会话模型手工串联；会话结束即断链 | `executeLifecyclePlan` 只适用于 headless；visible 路径直接返回 `user-visible-runtime-requires-host-orchestration`，仓库内没有等价 coordinator executor |
| Q07 | 没有可验证的重启重连协议 | 重启后不能从 `inspectRef`、Agent、Lease 和 Dispatch 的持久映射重连原任务，只能留下活动 Lease/孤儿 Run 或另起 Run | 现有 visible adapter 只校验即时 observation；没有宿主持久映射与 reattach receipt；现有 Authority 已出现多个未闭环 Run |
| Q08 | visible 提交没有在 Harness 边界强制执行 `codex-runtime-result.schema.json` | 对话文本或手工 JSON 可绕过必须字段、checkpoint 和 Finding 结构，仍进入 Evidence/Kernel | CLI headless Runtime 使用该 schema；`recordResult()`/Kernel visible 路径未做同等 schema 校验 |

### C. 审查与修复正确性（3 项功能缺陷）

| ID | 缺口 | 直接后果 | 当前证据 |
| --- | --- | --- | --- |
| Q09 | 审查 Feature 不是只读，review 与 repair 权限未分离 | “审查”Agent 可以边审边改，破坏发现项基线和独立复核 | Engine quality Feature 使用完整 `CARDWORLD_QUALITY_ALLOWED_PATHS`，不是空 `allowedPaths` |
| Q10 | 修复 Feature 可以用自报提交证据自动关闭 Finding | 没有强制 focused check、测试 Receipt 或独立验证，也可能把 Finding 标为 resolved | `engine-delivery` 会生成 follow-up；Kernel 在 repair completed 且存在内容寻址 Submission Evidence 时自动 resolve，schema 允许空 checkpoints/空 Finding evidence |
| Q11 | 修复完成后不会自动重新执行全量只读质量审查 | 修复引入的新缺陷和交叉影响不会被发现，所有旧 Finding resolved 后即可进入最终 Gate | profile 只生成 repair Feature，没有 post-repair full-review/recheck Feature 或固定点循环 |

### D. Gate 与关闭（2 项功能缺陷）

| ID | 缺口 | 直接后果 | 当前证据 |
| --- | --- | --- | --- |
| Q12 | 启动前不聚合检查全部 Gate 的命令、工具、sandbox 和 live observer | 缺 cargo/pnpm/powershell/observer 等只会在长流程末端逐个暴露 | `ProjectGateRunner` 运行时才要求 progress observer；源代码没有 action-scoped Gate capability preflight |
| Q13 | Gate 失败没有被 lifecycle executor转换成结构化、可恢复的停止状态 | 任一 Gate 失败后仍尝试 close，最终抛 `GATES_NOT_PASSED`；不能形成明确的 attention/resume receipt | `executeLifecyclePlan()` 运行 Gate 后无条件调用 `closeRun()`；Kernel 要求全部 Gate passed |

### E. 验证空白（2 项）

| ID | 缺口 | 直接后果 | 当前证据 |
| --- | --- | --- | --- |
| Q14 | 没有一条成功的 conversation-visible 质量审查 E2E 测试 | 现有 135 项测试全绿不能证明真实主链任何一次走到 close | visible policy 测试只覆盖 bind/heartbeat/拒绝提交；canary 是通用内存 Feature；Gate runner 独立测试单个 Gate，没有 Plan→visible Agent→repair→re-review→Gate→close |
| Q15 | 没有绑定当前实现的不可变 RC、安装后插件握手和真实宿主 Canary | 开发工作树通过测试仍不能作为发布可用证据 | 当前工作树有未提交修改；已有 RC 属于旧提交/旧摘要；没有真实 visible-Agent Closure Receipt |

### F. 运行态治理（1 项）

| ID | 缺口 | 直接后果 | 当前证据 |
| --- | --- | --- | --- |
| Q16 | 同一逻辑质量任务没有唯一 active Run 和自动 supersede/continuation 规则 | 每次制品或 Plan 摘要变化可生成新 Run，重启后无法可靠判断应该续哪个 | `cardworld-engine` 已有 7 个 V3.8.4 quality Run：4 个 `ready/running`、3 个 `all-remaining-blocked`，绑定不同历史制品或 Plan |

## 向其他 Engine 环节外推后的确定结论

这不是“quality 修好后其余动作自然可用”。当前编译器对 `full`、`requirements`、`plan`、`implement`、`scope`、`docs`、`review`、`deliver` 八个非 quality 状态变更动作都只生成一个通用 Feature；现有测试只验证命令路由或 quality 编译，不验证这些动作的生命周期语义。

至少还有 5 个系统性缺口，未计入上面的 16 项：

1. 8/8 非 quality 动作没有各自完整的 Feature/Step/DAG 与 Gate 语义。
2. `full` 没有编译 requirements→plan→implementation→quality→docs/deliver 的完整图，只是单 Feature。
3. `deliver` 被映射为 `docs-closeout`，并不执行独立交付协议。
4. 各动作复用 quality 的宽泛可写路径和 `quality-run-complete` 停止条件，权限与终止语义错误。
5. 没有按 action 的成功 E2E、重启恢复和故障矩阵测试。

因此在 quality 主链验收前，不应宣称 Engine 其他环节可用；验收后也必须逐 action 单独准出。

## 第二条 Harness（Collection）审计结论

Collection 当前不是“可能有同类问题”，而是可直接确认尚未达到可启动基线。至少有 **8 项独立缺口**，同样未计入 Engine quality 的 16 项：

1. `tabletop-collection` Project Descriptor 未注册，doctor 明确返回 `PROJECT_NOT_REGISTERED`。
2. Extension Registry 只有 Engine Profile 与 Codex Runtime，没有 `tabletop-collection-profile`。
3. 插件 bindings 顶层 `workspaceRoot` 固定为 `F:\CardWorld`，Engine 与 Collection 没有各自 workspace root，Collection 别名会落到错误业务根。
4. `full/rules/launch/produce/quality/review/accept/close` 八个 action 都只生成一个 `gameId` 可为空的通用 Feature，没有十游戏/共享能力依赖图。
5. lifecycle compiler 没有使用已有的 Collection feature-graph compiler，批次与游戏 DAG 没有进入真实 Run Plan。
6. quality preset 关闭批次的六项关键安全约束，不能证明规则、代码、测试与验收 Barrier。
7. `collection-batch` 从 `metadata.gameId` 推导游戏；通用 Feature 的 `gameId=null` 会让逐游戏 approval 检查出现空集合式通过。
8. Collection Profile 没有 `createFollowUpFeatures`，发现项会阻断关闭，却没有自动修复路径；也没有真实 Collection E2E/Canary。

Collection 必须在 Engine quality 主链闭环后单独做 Project/Extension/binding 修复与全动作审计，不能复制 Engine 的准出结论。

## 修复顺序：只围绕质量审查完整闭环

### GQ0：冻结错误“可用”结论

- 将本 Issue 作为 `AH-20260915-68116284F352` 的 regression/successor；后者的 synthetic-test resolved 结论不再作为可用证据。
- 在 Q01-Q16 完成前，状态只能是 `implementation candidate / not operationally ready`。
- 暂停创建新的真实 CardWorld quality Run；保留 7 个历史 Run 只读，等待用户批准精确 supersede 目标。

### GQ1：先造可失败且一次报全的预检

- 实现 versioned `ExecutionReadinessReport`，一次聚合 Release、插件、Extension、Project、Plan、Host、Runtime、Result transport、Gate、write probe。
- `lifecycle start` 只接受绑定同一 Plan/Release/Project revision 且未过期的成功 Preflight Receipt。
- 在 Host API/bridge 未完成时，预检应稳定返回全部 blockers，且不创建 Run。

### GQ2：补真实宿主 Coordinator 与重启协议

- 先确认 Codex 产品是否能提供受信 spawn/inspect/attest/heartbeat/wait/result API；不能提供时明确标记 conversation-visible unsupported，不能用模型 JSON 伪造。
- 若可提供，实现宿主侧 Coordinator，持久保存 Run↔Dispatch↔Agent↔inspectRef↔Lease 映射及 heartbeat/result cursor。
- 定义 restart reattach、lease expiry、hard recovery、新 Epoch 和旧 Agent 隔离 Receipt。

### GQ3：重写质量闭环语义

- full review Feature 强制只读；Finding 成为唯一 repair 输入。
- repair Feature 只允许 Finding 影响路径；完成必须绑定非空 checkpoint、focused test/Gate Receipt 和变更摘要。
- repair 波次结束后自动生成新的全量只读 re-review；直到某一轮零新 Finding 才允许最终 Gate。
- visible 结果必须在宿主传输和 Harness 边界双重 schema 校验。

### GQ4：Gate 与关闭改为可恢复状态机

- 启动前预检所有 Gate 工具、命令、权限、工作目录、live observer。
- Gate 失败写入稳定 Failure/Attention Receipt，不调用 close；修复后从指定 Gate/新源码摘要继续。
- close 只接受零开放 Finding、最终 re-review Receipt、当前源码摘要下全部 Gate passed 和完整 Evidence lineage。

### GQ5：建立真实验收梯度

1. 合成单元：覆盖新状态机和所有拒绝路径。
2. packaged E2E：从不可变 tarball/安装根完成完整质量链，包括 Finding→repair→re-review→Gate→close。
3. desktop E2E：用真实 Codex 可见 Agent 在独立合成仓完成同一链路。
4. restart matrix：分别在 start 后、bind 后、repair 中、Gate 失败后重启，证明 reattach/hard recovery。
5. 只有上述全部通过、当前实现形成干净 commit/RC、插件重新安装并握手成功，才向用户申请一次真实 CardWorld quality Canary。

## 准出 Gate

在以下证据齐全前，质量审查不得标记 operationally ready：

- 16 项缺口逐项关闭并有对应测试或 Receipt；
- packaged 与真实 desktop visible E2E 均产生最终 Closure Receipt；
- 三类以上中途重启均续跑成功且没有新增孤儿 Run；
- Gate 故障可恢复，修复后产生新源码摘要下的新 Gate Receipt；
- 当前 RC 与已安装插件/Extension/Project/Plan digest 完全一致；
- 用户批准后，唯一新的 CardWorld Canary 从 preflight 运行到 close；
- 历史 7 个 Run 的任何 supersede、归档、恢复或删除另行获得准确目标授权。

## 本轮边界

本审计未启动任何 CardWorld 或 Collection 真实 Run，未运行 CardWorld Gate，未修改 `F:\CardWorld`，未改写、恢复、归档或删除历史 Authority。新增内容仅为本 Issue 的只读分析与修复/验收方案。

## 2026-09-15 一次性交付实施结果

本次已完成仓库权限范围内的实现修复，并保持真实业务仓与历史 Authority 只读。当前不再把“Registry 一致”宣称成 operationally ready；仓库候选与产品宿主/部署准出明确分层。

| 缺口 | 仓库实施状态 | 仍需外部 Gate |
| --- | --- | --- |
| Q01 | 已实现内容寻址不可变 Runtime 复制、复验、活动 pointer/runtimeRoot 与安装标记切换；活动 Extension 从 Runtime 根解析 | 干净 commit/RC 后才可真实 activation |
| Q02 | 已拆分 `installationReady`、`registryReady`、`executionReady`；`doctor.lifecycleReady` 固定不再假阳性 | 无 |
| Q03 | Operator Skill 已允许隐式调用，Command/Operator 契约已更新 | 已安装 Codex 插件需同版本 remove/add 后在新任务握手 |
| Q04 | Harness 保持受信 inspector fail-closed | 当前 Codex 产品宿主仍未提供可调用的原生 attestation API，仓库不能伪造 |
| Q05-Q07 | 已新增完整 Host Adapter capability handshake、`executeVisibleLifecyclePlan()` Coordinator、Authority active-Lease reattach 与重启测试 | 产品宿主必须实际注入 spawn/inspect/wait/result 回调 |
| Q08 | Application 与 Kernel 双边强制 visible 严格结果 Schema | 无 |
| Q09-Q11 | review 强制只读；repair 仅限 affectedPaths，必须 checkpoint+verification Receipt；自动 full re-review，重复 Finding 进入新 round | 无 |
| Q12-Q13 | Preflight 聚合 Gate observer/executable/script/package-script/sandbox；失败结构化 attention，同一 Run 可 fresh 重试 | 真实 CardWorld Gate 只在用户批准 Canary 后运行 |
| Q14 | 合成 visible E2E 已完整产生 review/repair/re-review/closure，并覆盖 bind 后重启 | 真实 desktop/product Host E2E 尚不可执行 |
| Q15 | release manifest/SBOM 已绑定当前工作树字节，clean-room/pack 通过 | commit、RC、真实 activation、插件重装和 Host Canary 由相应 Gate/用户决定 |
| Q16 | 新 Plan 会列出全部同 action/target 活动冲突并在 Run 创建前拒绝 | 既有 7 个历史 Run 未经精确目标授权不做 supersede/归档/删除 |

额外深挖并修复了审计表外的五项缺陷：Collection 过去只要一个游戏质量根干净即可误关；复审重复 Finding 会复用旧 repair ID 而卡死；共享 workspace 的 visible Coordinator 未收紧物理并发；Engine full 在质量后修改 docs 会使 clean review 失效；Gate 预检只看 executable、不看脚本/package script/required sandbox。

验证结果：`npm test` 147/147、Conformance 3/3、零驻留 Canary 3/3、`npm run check`、clean-room（真实 tarball 内 147/147 与跨进程恢复）、pack dry-run、residue 全部通过。该结果证明 Repository/Packaged implementation candidate，不代替当前缺失的真实 Codex Host 能力，也不构成真实 CardWorld Run、发布、commit、activation、历史 Run 处置或旧 Harness 删除授权。
