# AH-20260914-E31036D1068A 修复方案

## 审核结论

- 分级：`P1`
- 分类：`defect`
- 状态：`accepted`
- 结论：问题可复现，且由两个独立但相互放大的上游缺口构成：发布制品轮换没有独立的激活事务；伪命令只解析 Intent，没有生成并执行确定性的 Lifecycle Command Plan。
- 非结论：这不是用户缺少授权、Engine 配置错误或先前初始化问题的简单重复，也不应通过为遗留 Run 补录 `canonical-requirement-approved` 来绕过。

## 已核验证据

1. Issue Intake 与 `issue.record` 回执摘要一致，当前无既有 Triage。
2. 当前 Engine 项目级 readiness 已恢复为 `lifecycleReady=true`；Harness、Project Descriptor 和两个 Extension 的活动摘要一致。
3. `v3-8-4-quality-20260914-r2` 为 revision 2、status `ready`，只有一个 `quality` Feature，`dispatches=[]`、`decisions=[]`、`gates=[]`。
4. 该 Run 的 Profile 配置为 `requireCanonicalDecision=true`、`requireUserCodeReview=true`。`engine-delivery` 会阻止 canonical-requirement 之后的 Feature 发车，因此当前 quality Feature 无法 Dispatch。
5. `cardWorldCommandManifest` 只声明 `scope`、`stateChanging` 和 `sourcePolicy`；现有 CLI 仍要求调用方分别提供 Run ID、Features 和 Profile config。适配器或模型必须补齐这些权威输入，违反确定性命令边界。
6. Bootstrap 能在一次 apply 中重新登记 Extension 和 Project Descriptor，但它仍是初始化语义，并要求每次 apply 携带批准 Decision；当前没有“验证候选制品—批量更新绑定—原子激活”的发布升级语义。

## 目标契约

一次 `h:<project> <action> <target> [preset]` 明确授权该已安装 Command Manifest 所声明范围内的普通状态变更，包括确定性建 Run、调度、Runtime 执行、review-and-repair、Finding 闭环和必需 Gate。只有超出 Manifest 范围或属于受保护操作时才再次请求批准，例如发布、commit/push、权限扩张、live hard recovery、不可逆迁移、删除和最终 cutover。

业务生命周期命令不得顺带安装、信任或激活新的 Harness/Extension 制品。制品身份变化必须在安装或发布阶段完成一次显式激活；激活成功后的业务命令只消费活动身份，不再重复 bootstrap 授权。

## 方案

### 1. 引入版本化 Lifecycle Command Plan

新增中立的 `LifecycleCommandPlan` schema 与摘要校验。它至少绑定：

- 原始 Intent、Command Manifest/Extension/Profile 身份及摘要；
- Project Descriptor revision/digest、Harness 活动发布身份和 Authority expected revision；
- 确定性 Run ID/幂等键、Feature graph、Profile config、Runtime、Gate plan；
- `sourcePolicy`、允许的 mutation classes、stop condition；
- 需要额外批准的 protected operations，默认空数组。

Extension 只返回 Plan Intent，不直接修改 Kernel Authority，继续满足插件不得修改 Kernel Authority 的边界。Core 负责 schema 校验、摘要绑定、expected revision、幂等提交和执行。

为 CLI 增加两段式但不增加用户对话授权点的入口：

- `lifecycle plan`：零写入，从已验证的 Extension `commandManifest` 和 plan compiler 生成确定性 Plan；
- `lifecycle execute`：以伪命令自带的 command ID 提交并持续执行到 Plan stop condition；失败、重试和进程重启保持幂等。

Codex Hook/Skill 只负责传递绑定和展示最终结果，不再构造 Feature、Profile config 或逐步决定调度策略。

### 2. 为 Engine quality/full 固化动作规范

`quality/full` 的 Plan 必须由 `cardworld-engine-profile` 确定性生成，固定包含：

- 单一 `quality/<target>` Feature 或经版本化模板声明的等价图；
- `stage=quality`、`sourcePolicy=review-and-repair`；
- `requireCanonicalDecision=false`：本动作以已存在的版本契约和当前源码为审核输入，不创建或批准 canonical requirement；
- `requireUserCodeReview=false`：用户代码审核属于完整交付流程的独立 stage，不是独立 quality Run 的关闭前置；
- Project Descriptor 中的必需 final Gates；
- stop condition 为 quality Feature、当前周期 P0-P3、必需 Gates 全部闭环后关闭该 quality Run。

这不是关闭全局 safeguard，而是按动作作用域选择正确的 Profile 配置。`full`、`requirements`、`deliver` 等动作仍可保留各自的 canonical/user-review 约束。

### 3. 引入发布激活事务，替代业务命令中的重复 Bootstrap

新增 `release activation plan/apply`（名称可在实现时统一为 installation/maintenance 子命令），使用 staged generation + 单一 active pointer：

1. 只读生成候选计划，验证 Harness release manifest、Extension 完整制品摘要、兼容性和所有受影响 Project Descriptor。
2. 一次 approved Decision 精确绑定旧/新 release identity、Extension 集合、受影响 Project、计划摘要和 expected revisions。
3. Apply 在暂存 generation 内写入 Extension Registry 与 Project Descriptor；全部验证通过后原子切换 active pointer。
4. 崩溃前未切换时继续使用旧 generation；切换后所有读取只能看到完整的新 generation。重复 command ID 返回同一 Receipt。
5. 生命周期 readiness 只校验 active generation。检测到工作树或安装目录存在未激活摘要时返回稳定码 `INSTALLATION_RELEASE_NOT_ACTIVATED`，不得自动 bootstrap，也不得在业务命令中请求逐项授权。

Bootstrap 保留为首次初始化入口；已初始化控制根的制品轮换走 release activation，不复用 Bootstrap 语义。

### 4. 明确遗留 Run 处置

- 当前 `v3-8-4-quality-20260914-r2` 保持只读审计状态，不恢复、不补 Decision、不执行 Gate。
- 增加受 expected revision 和 command ID 保护的 `run supersede` 状态转换；由修复后的首次 quality Plan 将旧 Run 作为 `supersedesRunId` 关联，或在用户单独批准后显式处置。
- 新实现不得复用配置错误的 r2；应创建绑定新 Command Plan digest 的新 Run。

## 实现切片

1. Contract：新增 Command Plan schema、稳定失败码、Plan digest 和 Extension plan-compiler contract。
2. Engine Extension：为 `quality/full` 及其余已发布动作补齐声明式/版本化 Plan 模板。
3. Core/CLI：实现 `lifecycle plan/execute`、幂等执行循环、Gate stop condition 与 `run supersede`。
4. Installation：实现 staged release activation、active pointer、journal/Receipt 与 readiness 切换。
5. Codex Adapter：删除模型构造 Run 的路径，改为调用 packaged lifecycle entrypoint；更新 Operator Contract 与 Skill。
6. Canary：先用合成 workspace 验证；真实 CardWorld quality Run、发布、签名、cutover 均保留现有 Gate，不在本 Issue 审核中执行。

## 验收标准

- 同一绑定、目标和活动制品生成字节级稳定的 Command Plan digest；篡改、过期 revision 或身份错配均 fail closed。
- 从已激活发布执行一次 `h:engine quality V3.8.4`，无需额外 bootstrap/canonical/user-review 批准即可产生首个 Dispatch，并自动推进 review-and-repair 与必需 Gates。
- 命令重放、进程崩溃恢复和重复 command ID 不创建重复 Run、Dispatch、Submission 或 Gate。
- `review-only` 不修改业务源码；`quality/full` 只能修改 Plan 声明的路径和 mutation classes。
- 发布、commit/push、权限扩张、hard recovery、删除和 cutover 仍被单独拦截。
- 制品升级只在一次 release activation 中请求批准；激活后的连续业务命令不再因同一摘要轮换中断。
- 升级事务在任意故障点只能暴露完整旧 generation 或完整新 generation，不得出现 Registry/Descriptor 混合身份。
- 全量测试、clean-room、pack dry-run、residue 和本地安装 Canary 全部通过；随后才可请求真实 Engine Canary Gate。

## 关闭 Gate

本 Issue 只有在以下 Evidence 齐备后才能从 `accepted` 更新为 `resolved/closed`：实现 commit 或等价不可变制品引用、上述自动化测试回执、release activation Receipt、安装后 readiness Evidence、合成 quality 单命令 Canary，以及经用户单独批准的真实 Engine quality 成功回执。当前审核与本方案本身不构成关闭、发布或真实 Run 授权。
