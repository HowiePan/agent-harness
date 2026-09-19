# Operator Contract

Operator Contract 是工具无关的 Harness 协调规范。Codex Skill、未来其他 Agent 工具适配器和人工运维都必须实现同一组可观察行为，而不能各自发明状态机。

## 权威与循环

- Authority 是唯一流程状态；对话、模型记忆、进程输出与报表都是非权威输入。
- 每个 Project 必须显式选择 Prompt Codec，每个 Dispatch 固定 Codec/Contract 版本；Codec 从不可变 Packet 确定性生成完整 Prompt，Operator 只能原样传给子 Agent，不能临时组织、摘要、改写或增删。
- 交互式 Agent 执行必须选择同时声明 `user-visible` 与 `host-orchestrated` 的 `conversation-visible` Runtime，并通过可信宿主证明把每个 Dispatch/Packet 摘要和 Prompt 摘要绑定到当前宿主创建的可见子 Agent；任务引用、状态与新鲜 heartbeat 可检查。spawn 必须先记 Host Effect，再解析 provider identity 与 canonical visible identity；未绑定 Lease 的失败 Agent 必须收容并验证，未完成收容或 Host Contract 不兼容时禁止下一次 spawn，已绑定 Lease 的 Agent 必须重附着。Prompt 生成或宿主不可用时禁止回退到即兴 Prompt、CLI/隐藏进程。Headless 不能推断：Descriptor allow-policy、版本化 deny-wins 用户约束与宿主从原始 CI/无人值守请求签发的 command-scoped Grant 必须同时通过，Descriptor 或通用批准不能充当 Grant。
- 所有写命令绑定 expected revision 和唯一 command ID。
- `start`、`resume` 或调度返回首批 Dispatch 后，Operator 必须持续消费全部 Dispatch、Lease、Runtime 结果、Gate、Decision 和 Receipt，直到 Run 关闭、失败或需要用户权限。
- 单个 Agent 完成不等于 Run 完成。
- Feature 是调度单元；Feature 内 Step 串行，不同 Feature 由依赖、冲突、lane、逻辑配额和物理容量共同决定并行。
- Feature 必须显式分类为 `agent-reasoning`，Gate Recipe 必须显式分类为 `deterministic-process`；二者不能互相承载。Authority control 只由 Core 的版本化命令路径执行。缺失或错配分类在 Run/进程创建前失败。

## 扩展解析

默认 Harness 只装载中立 Core、Feature Profile 和参考插件。已批准的 Extension Pack 位于独立控制根，通过持久安装回执自动解析。Project Descriptor 必须精确声明 Harness 制品及所需 Extension Pack 的 ID、版本与制品摘要；任一身份缺失或不符必须在 Run 创建前失败。Runtime、模型、工具和 OS 沙箱都通过 Extension/Plugin 解析，Operator 不得写死供应商。

状态变更伪命令在 Run 创建前必须生成并验证版本化 `LifecycleCommandPlan`。Plan 只绑定不可变的 Command Intent、Project/Extension/Harness 身份、确定性 Run/Feature/Profile/Gate 配置、受保护效果列表和 stop condition；Authority revision、候选 Run 与 Lease 健康度不得进入 Plan digest。Core 另行生成有有效期的 `RunLineageResolution`，自动选择 return-closed、continue、reattach、ordinary-resume、supersede-and-start、start 或 block；跨 Authority/Epoch 的 hard recovery 则由 Recovery Coordinator 根据 Capsule verification 自动生成 `RecoveryResolutionReceipt`。Extension 只能返回 Plan Intent 和声明式恢复策略，不能直接写 Kernel Authority；适配器和模型不得自行补齐或修改 Plan，也不得要求用户选择恢复算法。一次显式命令授权 Plan 声明范围内的普通状态变更，发布、commit/push、权限扩张、不可逆迁移、旧数据删除和 external cutover 仍需单独批准。

已初始化控制根的制品轮换不走 Bootstrap。发布激活先把 Registry 与 Project Descriptor 写入候选 generation，全部摘要和兼容性验证通过后再一次切换 `active-release` pointer；读路径只消费活动 generation，旧 generation 保留为审计输入。

## 路径与回执

Harness 数据、临时目录、调试输出、构建制品和缓存只能写入 Standalone Control Root 内。npm 包目录不能隐式成为数据根。进程型 Agent Runtime 仅允许通过 Descriptor allow-policy、可信用户约束、command-scoped Grant 和 Core launch capability 的显式 headless/CI 使用；默认 Harness 不开放 Agent `process.spawn`，可见 Runtime 与进程 Runtime 分属独立 Extension。确定性 Gate、构建、测试与短控制命令可用受管进程，但必须在启动前挂接实时观察器，并显示启动、进度/输出和结束状态。所有进程插件必须声明容量预算、保留策略和沙箱模式，并在成功、失败、超限与取消路径返回清理回执。未声明输出或观察器视为协议错误。

## 权限边界

真实 cutover、发布、权限扩张、不可逆外部存储迁移、Legacy Capsule 销毁以及旧 Harness 删除都要求用户在动作前单独批准。迁移计划、验收通过或旧内容已不再使用，都不构成删除授权。仅在 Standalone Control Root 内建立新 Epoch、保存回滚快照、废止旧 Transport 和强制重新验证的 hard recovery 由 Core policy 自动授权。

hard recovery 只允许走 Recovery Coordinator：先对 Capsule 执行严格完整验证并生成有有效期的内容寻址 verification Evidence，再由 Core 生成 `RecoveryResolutionReceipt`。Receipt 必须绑定原生命周期命令或显式 recover 命令、project、run、verification ref、expected revision、当前 generation、目标 epoch 与安全 effect classes；执行命令必须提供稳定 command ID。普通 assessment JSON、缺失或过期 Resolution、上下文错配和绕过 Coordinator 的 Kernel 调用一律拒绝。已有 `live-hard-recovery` Decision 仅作向后兼容 authority basis，不再是新流程前置条件。
