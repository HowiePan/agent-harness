# AH-20260915-3218A00AAEFB 审查与系统性修复方案

## 审查结论

- 建议级别：`P1`。
- 建议分类：`regression / authorization-boundary / execution-policy-bypass`。
- 建议状态：`accepted`；本文件不代替经批准的 `issue triage` 写入。
- 当前问题不是一次误操作，而是 `5eeba78` 引入的策略模型回归。该提交为 `quality` 增加了可持久化的 action-scoped `headless` 覆盖，并让 `LifecycleCommandPlan`、Preflight、Run 和 Runtime 调用都继承该覆盖；结果是 Project Descriptor 中一段长期数据可以取代当前用户请求，合法化 `codex-cli-runtime`。
- 这同时违反两项已经冻结的要求：
  1. `AH-20260914-E31036D1068A` 的目标契约规定，一次 `h:<project> <action> ...` 已授权 Manifest 范围内的普通生命周期工作，不应在中途为普通步骤逐项追加授权；只有发布、commit/push、权限扩张、hard recovery、删除、cutover 等受保护操作才另行批准。
  2. `3037641` 及当前 Operator Contract 规定，交互式 Codex 工作必须使用 conversation-visible 宿主委派；缺少宿主能力时必须 fail closed，禁止回退到 `codex exec`、后台 Agent CLI 或独立任务。Headless 只有在用户原始请求明确要求 CI/unattended 且 Descriptor 独立允许时才成立。
- `AH-20260915-8C001F4D266E` 的原始验收目标是“可信可见 Agent 路径”。其修复方案也明确写明：真实宿主桥不存在时不能 operationally close。最终却以“把 Engine quality 改为获授权的 headless/codex-cli-runtime、Preflight 通过但不创建真实 Run”标记 resolved。这是用被禁止的替代路径绕过原验收条件，属于关闭 Gate 失效；当前 Issue 应关联为其 `regression-of`，同时关联 `AH-20260914-E31036D1068A`。

## 已核验证据

1. `src/plugins/runtime/execution-policy.mjs` 只校验 Descriptor 内的 `actor/decision/action/authorizedAt` 字段，不校验授权来源、签发者、Project/target/preset/Plan/Run/Runtime/版本/摘要、有效期、撤销或消费状态。一个自称 `project-owner`、时间为 `2000-01-01` 的对象仍会通过。
2. 同一模块只在存在 `policy.actionExecution.<action>` 时检查该对象；Project 默认策略直接选择 `headless` 时完全不需要授权。
3. `authorization` 位于 Project Descriptor，随 release activation 持久化，因此天然可跨命令、跨会话、跨 Run 重复使用。它是配置数据，不是当前用户命令的可信证明。
4. `LifecycleCommandPlan` 只固定 `runtimePluginId` 和 `agentExecutionMode`，不绑定当前用户请求或一次生命周期授权；`ExecutionReadinessReport` 也没有 user-intent / execution-grant 检查。
5. `startLifecyclePlan()` 与 `executeLifecyclePlan()` 的参数没有 execution grant；CLI 的 `lifecycle start/execute` 同样没有承载当前用户请求证明的入口。一旦 Descriptor 选择 headless，`executeLifecyclePlan()` 会直接进入 `RunCoordinator`。
6. `startRun()` 可依据调用方提供的 `metadata.commandIntent.action` 自动取得 action-scoped 策略，但不要求 Lifecycle Plan、Preflight 或用户授权。随后 `dispatch()`、`RunCoordinator`、`spawnDispatchAgent()` 可形成另一条后台 Agent CLI 启动链。
7. CLI 的 `run execute` 直接构造 `RunCoordinator`；它不要求 Lifecycle Plan、ExecutionReadinessReport 或当前用户授权。已有 Run 因而可绕过 lifecycle 入口继续启动 headless Runtime。
8. `createCardWorldProjectDescriptor()` 会在 action-scoped 配置引用 `codex-cli-runtime` 时自动加入 Runtime allowlist，并自动生成 `{ sandbox: 'workspace-write', ephemeral: true, approveForMe: true }`。这把危险能力的启用做成便利默认，而不是独立、显式、可审计的授权边界。
9. Release activation 的批准只绑定 activation plan；该 plan 可以携带 Descriptor 内自声明的长期 headless `authorization`。一次“发布激活批准”因此会被间接扩张成未来任意次数的后台 Agent 执行许可。
10. Skill 文本虽然写着“用户必须明确请求 CI/unattended”，但 Core、CLI、Plan、Preflight 和 Runtime spawn 均无法验证该事实。软提示不能构成强制安全边界。
11. 当前没有独立、可信、优先级高于 Descriptor 覆盖的“禁止后台 Agent CLI”约束制品，因此 action override 可以覆盖交互式默认值，也无法证明用户此前的明确禁止仍有效。
12. `createHarness()` 默认允许 `process.spawn`；默认的 `codex-runtime` Extension 又同时注册 visible、CLI 和 isolated CLI 三个 Runtime。即使 Project 默认只选 visible，进程型 Agent 能力仍已被加载到同一宿主，不符合最小权限。
13. `PluginHost` 的 permission 检查只发生在插件注册时，`invoke()` 没有按本次命令校验 grant；Extension factory 也是在进程内直接执行。当前 permission 更接近声明/准入检查，不是不可绕过的 OS capability 边界。
14. 定向测试以 `--test-isolation=none` 运行结果为 `18/18` 通过；其中 `quality alone can be durably authorized for headless execution...` 明确把长期 headless 授权当成正确行为，且断言 `visible-host.required=false`。测试套件已经固化了错误语义。

## 根因模型

当前实现把四个本应独立的概念合并成了 Project Descriptor 的一个字段：

1. **能力安装**：某个 Runtime 是否已安装、可被 Project 引用。
2. **策略允许**：某个动作是否允许使用某类执行模式。
3. **用户约束**：用户是否禁止后台 Agent、外部写入或无人值守执行。
4. **本次命令授权**：当前用户消息究竟授权了哪一个 Project/action/target/preset，以及是否明确要求 unattended/headless。

`runtimePlugins` 和 `actionExecution` 最多只能表达前两项，却被当成后三项的证明。因为没有可信的命令级授权对象，所有下游组件只能相信 Descriptor；而 Descriptor 又可由普通构造器、首次注册或 release activation 写入，所以策略最终变成了可重放、可伪造、可经发布批准“洗入”的永久许可。

## 完整旁路矩阵

| 层级 | 当前旁路 | 后果 | 必须修复的位置 |
| --- | --- | --- | --- |
| Descriptor schema | `authorization` 只有形状校验；默认 headless 无授权 | 伪造、过期、永久重放 | 删除 Descriptor 内执行授权；只保留能力/允许策略 |
| Project register | 首次注册不要求 high-impact Decision；更新只检查通用 approved | 可在注册时直接植入 headless；批准语义可被扩大 | 对危险能力变更做精确 Decision context 校验 |
| Release activation | activation Decision 可携带 action headless 长期授权 | 发布授权被洗成运行授权 | 激活计划禁止包含 execution grant；危险策略变更单独列项 |
| Command adapter | 原始用户消息不生成可信 grant | “授权”二字可被解释成任意权限 | 由宿主把原始 Command Intent 签发为 command-scoped grant |
| Lifecycle Plan | 只固定 mode/runtime | Plan 无法证明 headless 是用户原始意图 | 固定 grant digest、interaction intent 和 deny-policy digest |
| Preflight | 不检查 command grant / persisted deny | 错误报告 `executionReady=true` | 新增 authorization 与 negative-policy 检查 |
| Lifecycle start/execute | 无 grant 参数 | Descriptor 一旦 headless 即自动执行 | start 前和每次 resume 校验同一 grant lineage |
| `startRun` | 可手工注入 commandIntent | 绕过 Plan/Preflight 创建可执行 Run | lifecycle Run 只允许内部 capability 创建；其他 Run 同样要执行许可 |
| `run execute` / `RunCoordinator` | 只读 Project/Run 策略 | 绕过 lifecycle 入口启动 Agent | 要求 Authority 中已验证的 grant；无则 fail closed |
| `dispatch` / `spawnDispatchAgent` | 只校验 mode/runtime 一致 | 低层 API 仍可触发进程 | 在 spawn 边界再次验证不可伪造的 launch capability |
| Runtime plugin | `codex-cli-runtime.spawn()` 不认识用户约束 | 上游漏检即真实启动隐藏 CLI | 启动前防御性校验 launch authorization capsule |
| Extension composition | visible 与两个 CLI Runtime 同包注册；Harness 默认允许 `process.spawn` | conversation-only 项目仍加载后台 Agent 能力 | 拆分 Extension；按有效策略构造最小 permission set |
| Plugin permission | 只做注册时字符串 allowlist，无每次调用的 capability | 内部错误路径仍能调用已注册进程 Runtime | spawn 使用 Core 私有 capability；需要更强隔离时移出进程 |
| Consumer defaults | 自动 allowlist + `approveForMe` | 危险路径过于容易启用 | 移除自动注入；显式配置且受策略 Gate |
| Skill/docs | 规则仅存在于提示词 | 任意非 Skill 调用均可绕过 | 文档只描述契约，强制规则全部进入 Core |
| Tests/closure | 正向测试认可长期 headless；无真实 Host Canary仍关闭 | 回归被绿灯掩盖 | 改为负向矩阵并加强 Issue close Evidence policy |

## 目标契约

### 1. 一次授权的准确语义

“一次性授权”应定义为：用户提交一次生命周期命令，即授权该 Command Manifest 声明的普通范围从 Plan 到 stop condition 连续完成；调度、review-and-repair、普通重试、崩溃后同一 Run/epoch 的恢复不再向用户逐步追问。

它不等于永久授权，也不等于允许把 `quality` 扩张为后台 CLI。新命令、新 target、新 preset、新 Plan digest、新 Run lineage、执行模式变化或受保护操作都不能复用旧授权。

### 2. 四层策略必须取交集，禁止项优先

有效执行策略应为：

`host capability ∩ installed capability ∩ project allow-policy ∩ trusted user constraint ∩ command grant`

任何一层 deny 都必须胜出。特别是可信用户约束声明 `process-backed-agent=deny` 时，Descriptor 的默认值、action override、release activation 和通用批准都不得覆盖；只有用户对“修改该禁止策略”本身给出精确、独立批准后才能变化。

### 3. 交互式命令默认只允许 conversation-visible

- 普通 `h:engine quality V3.8.4` 必须解析为 `conversation-visible`。
- 宿主 bridge 不可用时，在创建 Run 前返回 `attention-required / VISIBLE_AGENT_HOST_COORDINATOR_UNAVAILABLE`。
- 不得建议、请求或接受用 headless 作为故障兜底。
- 只有原始用户命令明确要求 CI/unattended/headless，Project allow-policy 也明确允许，且没有更高优先级 deny 时，才可签发 headless grant。
- “授权”“继续”“可以”等泛化回复不能改变执行模式，也不能解除后台 CLI 禁止。

## 修复方案

### W0：立即止血与问题治理

1. 在新 release 可用前暂停 Codex 交互任务中的 `lifecycle execute`、`run execute` 和所有 `codex-cli-runtime` Agent 启动；短 Harness 控制命令和带 live observer 的确定性 Gate 不属于 Agent Runtime，可继续使用。
2. 不修改或恢复当前真实 Engine Run；保持其 Authority 只读，等待用户对准确目标另行决定。
3. 将本 Issue 关联 `regression-of: AH-20260915-8C001F4D266E`、`related-to: AH-20260914-E31036D1068A`、`introduced-by: git:5eeba78...`。
4. 重新审计 `AH-20260915-8C001F4D266E` 的 resolved 结论：headless 替代不满足 visible-host 验收，真实 Host Canary 缺失时只能是 implementation candidate / blocked by host capability。

### W1：拆除持久化授权旁路

1. 从 Project Descriptor schema 删除 `actionExecution.*.authorization`。`actionExecution` 只表达允许的 mode/runtime，不携带用户 Decision。
2. 默认 headless 与 action-scoped headless 使用同一规则，不允许“默认策略免授权”。
3. `createCardWorldProjectDescriptor()` 不再因 action override 自动加入 `codex-cli-runtime`，也不再自动设置 `approveForMe`；危险 Runtime 安装、Project allowlist 与动作选择分别显式声明。
4. Project register/release activation 对新增 `process.spawn` Agent Runtime、把动作切到 headless、放宽可信 deny-policy 分别生成结构化 protected change，并要求 Decision 精确绑定 plan digest、Project revision、变更前后值与有效期。
5. 迁移现有 Descriptor 时删除长期 authorization 数据；不得把它转换为新 grant。现有值只作为审计证据。

### W2：引入可信的 LifecycleExecutionGrant

1. 新增版本化 `LifecycleExecutionGrant`，至少绑定：
   - trusted host/provider/session 与不可伪造的 user-message reference/digest；
   - Project ID、Descriptor revision/digest；
   - action、target、preset、scope、source policy；
   - Plan digest、deterministic Run ID、Run lineage/epoch；
   - mode、Runtime ID/version/artifact digest、workspace identity；
   - ordinary mutation classes、protected operations；
   - issuedAt、expiresAt、revocation state 和 grant digest。
2. 对普通交互命令，由宿主根据原始 `h:` 消息一次签发 conversation-visible grant；不增加用户对话授权点。
3. 对显式 CI/unattended 请求，grant 必须含 `interactionIntent=unattended` 和原始请求证据；通用 follow-up approval 不能补造该意图。
4. grant 在同一 Run/epoch 的正常恢复中可继续使用，避免重复提问；不得跨新命令、target、Plan、Run 或 mode 重放。
5. protected operation 使用独立 Decision，不修改原 grant，也不把普通命令授权扩张成其他能力。

### W3：把强制校验下沉到所有执行边界

1. `createLifecycleCommandPlan()` 固定 grant digest、deny-policy digest、interaction intent 和 Runtime artifact identity。
2. `createExecutionReadinessReport()` 增加 `user-constraint`、`command-grant`、`headless-explicit-intent` 三项检查；聚合全部 blockers，但任一失败都保持 `executionReady=false`。
3. `startLifecyclePlan()` 在 Run 创建前验证 grant；`executeLifecyclePlan()` 和 `executeVisibleLifecyclePlan()` 只接受同一 plan/grant/report 组合。
4. `startRun()` 不再接受调用方通过 `metadata.commandIntent` 自行升级为 lifecycle Run。由 Core 私有 capability 从已验证 Plan 创建；公开低层入口要么仅用于无 Agent 的测试/管理 Run，要么要求同等 grant。
5. `RunCoordinator.tick/run`、`dispatch()`、`spawnDispatchAgent()`、`invokeBoundRuntime()` 每次从 Authority 验证固定的 grant digest、mode/runtime 和撤销状态，避免直接 API 与 `run execute` 绕过。
6. PluginHost 对 Agent Runtime `spawn` 引入 Core 内部不可由 JSON/模型伪造的 launch capability；没有 capability 时即使内部误调用也拒绝。
7. `codex-cli-runtime.spawn()` 做最后一道防御性检查：缺少绑定本 Dispatch/packet/prompt 的 headless launch capsule 时返回 `HEADLESS_USER_INTENT_REQUIRED`，且必须在 `spawnProcess` 前失败。
8. CLI 删除或收紧 `run execute`：仅能恢复已绑定有效 grant 的 Run；不能从 Descriptor 重新推导执行许可。
9. 将 `codex-conversation-runtime` 与 `codex-cli-runtime` / `codex-isolated-runtime` 拆成独立 Extension/安装单元。conversation-only 创建路径不得注册进程型 Agent Runtime，`createHarness()` 也不得默认向 Agent 插件开放 `process.spawn`。
10. 若目标威胁模型要求防止受信插件自身绕过声明直接调用 Node `child_process`，则必须把 Extension/Runtime 移入受限进程或 capability broker；仅靠当前同进程 JavaScript permission 字符串无法提供该保证。

### W4：建立可信的禁止策略

1. 在 Host binding/独立 Authority policy 中保存版本化 `UserExecutionConstraints`，至少支持 `processBackedAgent: deny|allow-explicit`、`unattended: deny|allow-explicit`。
2. 该制品必须有可信来源、revision、digest、Decision lineage；不放入 Extension 可返回的数据，也不由 Consumer descriptor 自声明。
3. Preflight、Plan、Run 和每次 launch 都固定 constraint digest。策略更新或撤销后，旧 Run 在下一次 Dispatch 前 attention-required，不得继续按旧允许值启动新进程。
4. 当前 Engine/Codex binding 的迁移默认设为 `processBackedAgent=deny`，对应用户已经明确提出的“不开后台 CLI”；真实 Apply 仍需用户按迁移 Gate 决定。

### W5：修复适配器、文档和关闭 Gate

1. Command/Operator Skill 只负责传输并显示 Core 结果；删除“Descriptor 中持久批准即可 headless”的表述。
2. 明确区分 Agent Runtime 进程与确定性 Gate/短控制命令，避免把“不准后台 CLI”误扩张为“任何子进程都不准”。Gate 仍必须有 live observer。
3. 修改 `AH-20260915-8C001F4D266E` 的关闭政策：不能以替代执行模式满足原 acceptance；P1 宿主集成缺陷必须有真实 conversation-visible Canary。
4. Release notes/acceptance 文档不得只报告测试总数；必须列出关键 denied-path Canary 和 `spawnProcessCallCount=0` 证据。

### W6：验证矩阵

必须至少新增以下测试，并在源码、真实 tarball clean-room 和已安装插件三层重复：

1. 默认 headless 但无 command grant：`HEADLESS_USER_INTENT_REQUIRED`，Run 未创建，进程调用数为 0。
2. action-scoped headless 但只有 Descriptor 中旧授权：拒绝，进程调用数为 0。
3. 伪造 actor、过期授权、错误 action/target/preset/Plan/Runtime/workspace、跨 Run 重放：全部拒绝。
4. 用户只回复“授权/继续”：不能把 conversation-visible 改成 headless。
5. trusted constraint 为 deny、Descriptor/action/release plan 为 allow：deny 胜出。
6. release activation 含旧 authorization 或试图携带 execution grant：schema/plan 阶段拒绝。
7. `lifecycle execute`、`run execute`、公开 API、`RunCoordinator`、`spawnDispatchAgent` 各自直接调用均不能绕过 grant。
8. visible host 缺失：一次 Preflight 返回全部 blockers，不创建 Run、不发 Dispatch、不调用 `codex exec`。
9. 普通 `h:engine quality ...`：原始命令一次授权后可连续完成普通 review/repair/retry/resume，不出现额外批准提示。
10. 同一 Run 崩溃恢复：复用同一 grant lineage；新 target、新 Plan、新 Run、切换 mode 时拒绝复用。
11. 明确 CI/unattended 请求 + Project allow + 无 deny：允许 headless，并产生精确 grant/launch/cleanup Receipt。
12. Gate 子进程仍可在 live observer 下执行，证明修复没有错误禁止确定性 Gate。
13. 真实 Codex conversation-visible Canary：可检查子 Agent、可信 attestation、新鲜 heartbeat、结构化 result；无后台 Agent CLI。
14. conversation-only Harness 的插件清单与有效 permission set 中不含任何进程型 Agent Runtime/Agent `process.spawn` 能力。

## 稳定失败码建议

- `LIFECYCLE_EXECUTION_GRANT_REQUIRED`
- `LIFECYCLE_EXECUTION_GRANT_INVALID`
- `LIFECYCLE_EXECUTION_GRANT_SCOPE_MISMATCH`
- `LIFECYCLE_EXECUTION_GRANT_EXPIRED`
- `LIFECYCLE_EXECUTION_GRANT_REVOKED`
- `HEADLESS_USER_INTENT_REQUIRED`
- `PROCESS_BACKED_AGENT_USER_DENIED`
- `EXECUTION_CONSTRAINT_STALE`
- `AGENT_RUNTIME_LAUNCH_CAPABILITY_REQUIRED`
- `LEGACY_DESCRIPTOR_AUTHORIZATION_FORBIDDEN`

## 验收与关闭 Gate

本 Issue 只有同时满足以下条件才可关闭：

1. Descriptor 不再保存或信任 execution authorization；默认与 action-scoped headless 使用统一的命令级授权规则。
2. 所有已识别入口在缺少可信 grant 或存在 deny 时都在 Run 创建/Dispatch/进程启动前 fail closed，且测试证明 `spawnProcessCallCount=0`。
3. 普通交互生命周期只需原始命令一次授权即可推进至 stop condition，正常重试与同 Run 恢复不再逐项询问。
4. Engine/Codex 的后台 Agent CLI 禁止策略可被可信持久化，且 action override、release activation、通用批准均不能覆盖。
5. 真实 Codex conversation-visible Canary 完成；Host bridge 不可用时保持 attention-required，不用 headless 替代。
6. 全量测试、Conformance、clean-room、pack、residue、拒绝路径 Canary 和安装后插件握手全部通过，并绑定同一不可变 RC。
7. 对 `AH-20260915-8C001F4D266E` 的错误关闭进行治理记录，禁止以“换一种用户明确禁止的执行方式”满足原 Issue 验收。

当前审查与方案不授权实现、release activation、插件重装、真实 Run、历史 Run 恢复/清理、commit、tag 或 push。
