# 实施预算与追加额度

预算用于阻止无上限自动重试。预算耗尽不代表任务边界错误，不要求重新规划。
任务范围、依赖、责任人或验收合同确需变更时才使用 Replan；不通过改 Feature ID、重启或拆 Step 刷新预算。

新建、已批准的实施 Run 使用 `attemptAccounting: separate-progress-v1`。
交付 Profile 将项目内未完成提交作为进展候选；Kernel 仍检查源码摘要确实前进、有变更文件和已绑定 Evidence，且没有回到同一逻辑任务已出现的源码摘要。
候选通过检查才进入 `budgetKind: progress` 账本，使用 `used` 计数，`failures` 保持零；无进展或执行失败进入原失败类别账本。
进展默认最多 21 次未完成提交，真实失败默认每类别 3 次；两者独立且都有上限。
源码前进不等于任务完成，全部原合同、独立审查和最终 Gate 仍必须通过。

旧 Run 保留其固定计数语义，不追溯把旧失败记录改成成功。
重复 `implement`、ordinary resume 以及经验证的完成证据 carry-over 都保留预算及追加历史。
新建替代 Run 也继承原 Run 的计数方式，不能通过换 Run 清零。

## 追加过程

1. 在注册的业务 checkout 使用绑定的 CLI 执行 `run budget-plan --project <id> --run <id> --request <json|->`。
   本地源码模式还须提供验证通过的 `--development-manifest <json>` 与精确控制根。
   请求包含 `featureId`、`attemptKey`、`additional`、`reason`、非空 `remainingWork` 数组。
2. 只读预览绑定 Run、Feature、稳定 logical root、Authority revision/digest、源码、计划、最新 Submission、旧额度、新额度与原因，返回 `proposalDigest`。
   向用户展示具体追加数额及剩余工作，再取得明确批准；对机制的原则性同意不能替代具体额度批准。
3. 使用 `run budget-extend --project <id> --run <id> --proposal <json|-> --approval <json|-> --expected-revision <n> --command-id <id>`。
   批准内容包含 `id`、`actor: human-user`（或 `user`）、`decision: approved`、`action: extend-attempt-budget`，以及精确的 `projectId`、`runId`、`featureId`、`proposalDigest`。
4. Kernel 在单个 expected-revision、幂等事务内重新验证预览，记录批准与 `attempt.budget-extended` 事件，只增加预算，不修改失败/进展次数、已完成状态、计划、路径或验收条件。
   原 `failed-budget` 转为 `blocked`，由下次显式 `implement` 重新检查续接条件；追加不会发车。

每次可追加 1–20 次，累计上限 1000。后续追加需重新给出理由、剩余工作及新的精确批准。
不允许活动 Lease/Dispatch、终结 Run、源码漂移、过期预览、错误 Run/Feature、无用户批准或重复消费同一批准。
上下文容量交回若已进入 progress 账本，只能凭原已提交 Dispatch 的批准义务、全新完成证据或已验证目标实现生成追加提案。单纯使用 context-limit/context-capacity 标签、重复证据或后续外部回执缺失不能放行；仍须逐项保留受保护动作的前置条件。
若 H2/H3 修复后才追加预算，恢复器只接受补丁记录的同一 idle Run 后紧接的一笔真实批准事务，逐项验证原 Authority/源码/事件序号、提案、人工 Decision、Kernel 命令及额度差异。它仍创建替代 Plan/Run，不注入旧 Lease，也不自动实施。
公开实施入口还拒绝将追加用来绕过外部依赖或审批阻断。
源码补丁须独立通过 H0–H4 分类；追加预算不豁免源码绑定、迁移或 Host Effect 检查。

## 未完成实施的恢复与收口

显式重新执行 `implement` 可以续接有已绑定 Evidence 的项目内 `implementation-incomplete`，
上轮没有源码变化不再单独禁止恢复。剩余额度、唯一 Run、工作区/来源身份及权限检查仍须通过。
这不触发自动实施，也不重置任何计数；没有新进展的自动循环仍然停止。

新的批准计划 Dispatch 在 `execution.implementationContinuation` 中携带摘要固定的展开计划和库存、
本包合同、实际验证命令、分配的聚合/成员/断言、最后退出源路径以及最近提交和预算。
引用内容必须由原计划 SHA-256 验证，缺失、漂移或越界直接阻断；不替换已批准图、owner 或验收。
历史通过项仅作基线，不能直接升级为最终证书。

执行顺序为最终目标实现、一个真实端到端迁移闭环、本包全部行为证据、获准旧源退出、最终源码复验。
旧制品回放及独立接收方执行必须有实际证据，不能用当前旧实现的观察或合成通过文本代替。
部分提交以现有 `checkpoints` 返回确实关闭的精确 obligation ID、`completed` 和具体证据；
`notMade` 列剩余项，`blocker.resumeWhen` 给出下一项具体实现。
新策略的自动续跑须有此前未报告关闭的批准义务及新证据，或获准最终目标的真实源码变化、
对应 implementation-step 和 focused-verification 两个已完成证据项。源码变化、测试数量、
重复绿灯、给历史检查改名均不足以续跑。它只决定是否继续工作，不认证行为正确性；完整 typed output、
生产者验收、独立审查和最终 Gates 仍是准出条件。账本保持原语义，纯证据进展也不会获得免费额度。

## 提前交回的有界纠正

新的续接包从原库存与退出合同生成 `implementationSteps`，不增加 Feature、路径或准出权限。
步骤记录获准最终文件的当前 SHA-256、所属父义务以及首个缺失目标；先落实目标及调用方，
再认证和退出。步骤证据仅代表部分开发完成，不表示父义务或聚合证书完成。

如果 Agent 只以 `implementation-incomplete / implementation` 交回尚未完成的本项目工作，
且既无新验收进展也无经聚焦验证的目标代码进展，同一次显式实施调用最多纠正一次。
Coordinator 原样保存该 Submission，通过 Kernel 的幂等 reopen 事务记录精确目标及纠正原因。
纠正重试仍消耗同一个既有预算，不新建失败类别、不清零、不追加额度；连续交回则停止。
权限、审批、外部、环境、范围阻断、缺少绑定 Evidence、来源循环和耗尽预算均不能进入该纠正分支。
旧 Dispatch 不追溯套用新策略；已批准工作区、图、合同与最终 Gates 不变。

## 与 H4 迁移一同接入

若预算功能本身需要 H4 迁移，原 Run 的具体预算提案可以先获用户批准，再以
`dev migrate --manifest <json> --run <原 Run> --command-id <id> --budget-extension <json|->`
接入。该 JSON 包含原始 `proposal` 和精确的 `approval`；迁移前验证它们与原 Authority、当前源码及用户批准一致。
H4 Patch Receipt 封存这份批准；绑定更新后，Kernel 在原 Run 追加额度，再由恢复流程验证这唯一一笔事务并封存完成证据承接计划。
恢复不接受额外的源码、Lease 或预算变更，也不启动替代 Run 的实施。
替代 Run 在后续显式 `implement` 时继承原账本和追加记录，无需再次申请同一笔额度。
若进程在绑定更新后中断，先读取 Patch Receipt 与原 Run；仅用其同一提案、批准及稳定 command ID 完成预算事务，再通过 `dev recover-run` 续接。不得清零或重新批准不同额度。
