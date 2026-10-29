# 适中批次规划与原生执行

`bounded-delivery/2` 是可复用的 Delivery Lifecycle 策略。项目通过 `policy.deliveryBatchPolicy` 启用新计划校验；Engine 新生成的 Descriptor 默认启用。已有不可变计划继续保持原策略，只有经过审查和人工批准的 Plan/Amend 才启用新语义。该策略不要求一次派发完成某个百分比。

## 规划合同

业务 Feature 声明 `deliveryPolicy: "bounded-delivery/2"`、`deliveryBatchReserve` 和 `deliveryBatches`。计划批次与至少一个修复/集成预留合计不超过 20；放不下就提出有界 Feature 拆分，不能把大包改名为一个批次。每批的工作量以合理会话容量评估，超过容量拒绝；估计不足容量四分之一时必须给出独立隔离的具体原因，不得填充工作。数值是审查依据，不能替代审查人的源代码与完整交付成本评估。

每批声明 `id`、`phase`、`objective`、`dependsOn`、`allowedPaths`、`writePaths`、`obligationIds`、`acceptance`、`verification`、`sizing`、`checks`。`sizing` 包含 `basis/cohesion/estimatedUnits/capacityUnits/reserve`，必要时补 `smallBatchReason`。`phase` 为 development、acceptance、source-exit、verification 或 convergence。

`obligationIds` 对应摘要固定输入产生的合同、验证、聚合证书、最后源码退出四类义务。物化时验证精确覆盖、唯一批次 owner、完整依赖及检查覆盖。普通项目没有迁移库存时仍按实际合同/验证产生义务，不需要伪造证书。拆分子 Feature 用 `deliveryObligationIds` 选择原生产者的真实义务，同时保留自身合同/验证；原库存生产者和声明身份不改写，原 Feature 仍是全部原验收的汇合点。

固定输入中的完全相同义务使用同一稳定 ID 和一个执行 owner，`sourceOccurrences` 保留原提案、解析后的集合位置及合同引用；原合同数组和文档摘要保持不变。相同 ID 的语义内容不同则拒绝，不能用去重隐藏不同证书或退出要求。此归一化仅用于有界批次，旧计划继续保持原义务投影。

若 Amend 草稿因范围阻断停下，经过可信重新绑定的 Harness 运行制品发生变化时，同一命令可创建新的规划 Run：精确绑定旧草稿 Authority、原请求、原范围、批准基底和新制品摘要，复核已提交草稿文件及实施来源链。支持文件变化不触发替换，活动 Agent、已接受结果或未声明文件变化仍阻断；修复不自动发起 Amend 或转移人工批准。

实施基线若来自最后一次已提交输出，重试沿用并复验已固定的输出快照和原 Submission/Evidence，不从含有草稿文件的当前目录重建。草稿文件只接受已提交的精确字节；额外文件或实现来源漂移继续阻断。

`checks` 每项声明 `id`、`executionClass: "deterministic-process"`、`command: [executable,...args]`、完整 `inputs`、`outputs`、`covers`、`environment`、`cacheable`。缓存还要求 `toolchainFiles` 列出实际工具链文件；版本标签或启动代理文件不能代替真实编译器/解释器。不能证明完整输入或工具链时设 `cacheable:false`。检查只能运行确定性构建/测试/验证，不能借此启动 Agent CLI。所有修改证明输入的批次必须先于该证明。唯一 convergence 依赖其余全部批次，自己的检查强制新验。

## 执行与证据

编译器把计划批次降为独立的原生 Agent Feature，稳定原 Feature 的最终收口 ID、预算根和下游依赖。未依赖且无路径/合同/资源冲突的单元才可能并行，并且受 Descriptor 和宿主的限制；共享工作区不授予隔离工作树权限。完整批次可正常交接给下一原生 Agent；同一批内仍要交付连贯目标，不能逐个文件或证书退回。失败、中断和修复留在相应批次，沿用有界预算。

同一批准批次连续三次主动返回 `implementation-incomplete` 的零散交付，会保留源码/证据并要求有界的规模或执行策略复核，阻止再次盲目续发。真实 Host 检查失败、外部阻断、provider 中断和旧计划历史不计入这项碎片交付判断，继续使用各自的修复、恢复和预算规则；不因普通失败强迫 Replan。

派发包只展开本批义务和开发目标，完整批准数据通过固定引用与集合摘要保留，避免每个 Agent 反复读取全库存。部分批次完成不记为原 Feature 完成，也不进入原提案的完成继承集合。后续修订保留同一预算根的已完成批次检查点及实际 Submission/Evidence。

Agent 声称完成后，Application 按批准命令执行真实检查并封存 Host 回执。检查失败会保留原生报告，派生为未完成结果并移除失败检查覆盖的完成声明；环境失败单独阻断。执行过程保持原 Lease 的心跳并输出检查进展。检查改写来源源码时拒绝接受，不能把污染后的结果当作通过。

成功缓存同时绑定命令、完整输入、输出、脚本、真实工具链文件、环境、策略和制品。相关变化使缓存失效；无关来源变化可复用已验证输入的成功回执。收口再次核对上游所有义务的当前证明，复跑失效检查并运行新鲜的收口检查；版本最终 Gate 继续保留。

预算从摘要固定的真实 Authority 读取并转移实际计数、记录和原始未完成 Submission，拒绝活动来源、过期来源、根错配和更新后的历史回退。拆分子单元共享额度，耗尽时全部停止；增额必须另行绑定精确预算提案和人工批准。历史元数据不能代替计数承接，完成批次也不产生免费重试。

## 通用场景验收范围

“约 90%”是面向后续开发场景的适用性目标；有限场景目录不能证明未来真实项目的统计覆盖率，也不能用于压缩批次。当前可执行回归与边界目录如下，回归入口为 `node scripts/run-tests.mjs all`，聚焦用 `node --test test/delivery-batch*.test.mjs test/attempt-carryover.test.mjs`（支持通配的宿主也可逐文件传入）。

| 场景 | 机制与回归 |
|---|---|
| 新能力、接收端与消费者 | `delivery-batch-results` 真实源修改与行为执行 |
| 多批次完整交付 | `delivery-batch-visible` 原生可见适配器分批派发及真实检查 |
| 跨模块/共享接收文件 | `delivery-batch-scenarios` 固定义务组，不因共享文件合成大包 |
| 聚合证明、成员与来源继承 | `delivery-batch-scenarios` 子提案选择原生产者的精确证书 |
| 旧源码退出与跨边界前置条件 | `implementation-continuation` 固定生命周期与 requiredBefore，独立本地工作不被外部条件整体阻断 |
| 合同/验证收口 | `delivery-batch-results` 原合同保持、缺项拒绝、上游当前证据与强制新验 |
| 过大 Feature、预留不足 | `delivery-batches` 总批次含预留上界拒绝 |
| 大包、小包与隔离例外 | `delivery-batches` 容量上界、过小理由与完整目标 |
| 依赖环、缺失生产者 | `delivery-batches` 图与证明输入顺序拒绝 |
| 独立并发、路径冲突 | `delivery-batch-scenarios` 调度图并发与重叠串行；受宿主能力约束 |
| 重复通过、配置变化 | `delivery-batches` / `delivery-batch-scenarios` 真实缓存命中与失效 |
| 脚本、输出、工具链变化 | `delivery-batch-scenarios` 输入指纹失效与复验 |
| 检查失败、范围内修复 | `delivery-batch-results` 拒绝虚假完成、同批修复及预算保留 |
| 缺失环境、外部等待 | `delivery-batch-scenarios` 环境失败回执；`implementation-continuation` 外部作用域 |
| 长时间检查 | `delivery-batch-scenarios` 实际 Lease 续心跳，检查结束前不提交 |
| 网络/上下文/宿主中断 | `implementation-continuation` / `development-run-recovery-progress` 原回执和进度保全、受控续接 |
| 修订后预算继承 | `attempt-carryover` 实际计数、原 Submission、耗尽阻断及独立增额 |
| 后续版本 | `delivery-batch-scenarios` 同策略编译不同版本，无版本分支 |
| 性能矩阵、整体验证 | 作为批准的 deterministic-process 检查和最终 Gate；本次不运行下游业务性能矩阵、不宣称其通过 |
| 跨项目消费者、权限与批准 | 只调度本项目，保留外部回执和独立授权；不能借拆分扩大 allowedPaths |

新增工具链的深层动态输入、必须同时改写同一工作区的并行任务、跨项目原子提交等场景需要适配或采用串行/外部交接。无法证明证据复用条件时重验，不能用覆盖率目标取消保护。现有真实 Run 在用户批准新计划前保持原合同，不因本次框架测试而声称业务验收完成。

## H4 后只准备修订

旧实施 Run 闲置且接下来应 Amend 时，使用 `dev migrate --manifest <manifest> --run <old-run> --for-amend <registered-change> --command-id <id>`。先只读核查未来策略、精确登记范围、批准基底、旧成果和允许的规划准备差异；随后通过 Kernel 的 `freeze-execution` Decision 冻结旧 Run，再按其新 revision 应用 H4 绑定。源码、提交和预算不变，不创建生命周期 Run、不启动实施。失败后保持冻结，不回退为旧策略执行。重新只读检查 Amend 后，仍由用户发送正式命令。
