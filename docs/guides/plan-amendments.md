# 局部计划修订

`amend <target> change:<id>` 用于已批准计划的有限依赖、职责、退出时点、验证接线或显式受限的规模拆分调整。普通实现修复继续 implement；最终架构、需求、原提案身份或跨项目归属变化使用 replan。

## 原生入口和登记范围

本地入口：`h:local <alias> amend <version> change:<id>`。仍须经过当前项目 Hook、原生 Host 和 Coordinator，不能在普通对话中重建执行意图或启动 CLI Agent。

Project 的 `policy.planChangeRequests[id]` 必须在原有 target/kind/summary/requirements/acceptance 之外登记 amendmentScope。例如：

```json
{
  "version": "plan-amendment/1",
  "artifactRoot": "docs/versions/amendments/boundary",
  "featureIds": ["A-02", "A-05"],
  "planPointers": ["/proposedFeatures/1/dependsOn"],
  "documents": [],
  "baselineCompatibilityPaths": ["harness.json", "docs/versions/boundary-change.md"]
}
```

planPointers 是原 typed plan 的 JSON pointer 修改上界。外置计划/库存使用 documents，每项固定 id、source 的 path/sha256、新 outputPath 和 allowedPointers；文档来源必须由原批准计划固定摘要。每个替换带原 JSON 值的 expectedDigest。禁止根替换、原型路径、重叠/无操作补丁、未登记提案增删或归属变化，以及最终 targetLayout/target/protectedOperations 改动。完整补丁上限 2 MiB，超限或越界明确要求 Replan。

新增成员使用 `{op:"add", path, expectedDigest, value}`：对象键在原始基底与当前结果中均须不存在；数组只允许按数字索引依次追加末尾，不允许插入、稀疏索引或 `-`。expectedDigest 固定**原父值**，同一原数组的多个追加共享原父摘要。替换格式保持兼容，原有范围、提案身份、受限拆分、图、冻结源码和精确数字校验全部继续执行。

若整个数组/对象替换重复携带未变合同，可在活动规划 Dispatch 的 `dev amendment-materialize` 命令加 `--compact`。工具只从固定摘要的原值推导等价的细粒度替换/新增，逐文档复算内容摘要相等后，再经过完整物化流程；不改原草稿或基底。每份输入 changes 及最终完整增量仍各受 2 MiB 限制，变化数量仍最多 1000；实际新增内容过大仍拒绝。完整计划、合同与验收留在生成制品中，原生结果继续返回紧凑引用。

规模修订可额外登记 `featureSplits: [{featureId, prefix, maxNewFeatures}]` 和 `batchPolicy: {maxBatchesPerFeature: 20}`。prefix 必须是原 Feature ID 加 `-`，每个原 Feature 最多追加 20 个同项目子提案，总 owned 提案最多 100。原提案顺序和身份不变，保留全部合同/验证并作为子提案的验收汇合点；子提案使用 `splitFrom` 绑定原 ID、继承原前置条件、保留禁止路径且不扩大源码路径。已完成提案禁止拆分。typed 和 expanded 均重新执行同一校验；默认未登记的 Amend 继续拒绝新增提案。

启用 batchPolicy 后，每个受影响 owned 提案及新子提案必须有 1–20 个 `deliveryBatches`；每项含 id、objective、acceptance、verification、sizing 的 basis/reserve。机器检查数量和字段，独立审查检查完整义务覆盖、真实成本和容量余量，不能以数量合规替代估算。90% 是常见开发场景适用性目标，不是单次派发完成率或工作量指标。拆分继承原逻辑预算根及部分历史，不产生免费额度，也不启动实施。

末次源码变更提交后尚未再次派发的 Run，可用原已提交结果 Evidence 绑定输出快照。准备文件按原输入快照还原后，必须逐字节重算到 Authority 已记录的最终源码摘要；未知源码变化、修改过的结果、快照或错误绑定均拒绝。检查入口不写 Evidence/Authority，后续承接复验同一结果和快照，避免静默跳过完成项与预算历史。

大范围清单可以独立保存为项目 JSON 文件，在变更单登记 `amendmentScopeRef: {path, sha256}`，与内联 amendmentScope 二选一。Application 从当前项目读取并核对固定摘要，再将解析后的范围固定到本次 Plan；文件漂移即拒绝。清单自身如属新准备文件，也须列入 baselineCompatibilityPaths。

## 节点、合成和批准

流程为 amend → plan-review → user approval。规划节点只输出 `delivery-plan-amendment-v1` 增量，不接收 Agent 重写的完整计划。独立审查只读，检查补丁和受影响的生产者、消费者、类型、生命周期、公开 API 与验收，结果固定 basePlanDigest、deltaDigest 及完整 reviewedFeatureIds。

登记检查命令为 `node <entrypoint> dev amendment-inspect --manifest <manifest> --change <id>`。它只读登记范围、批准基线和闲置实施 Run，不编译生命周期 Plan，不创建 Run；commandReady 不代表 executionReady。

规划 Agent 在活动 Dispatch 内执行 `node <entrypoint> dev amendment-materialize --manifest <manifest> --run <amend-run> --patch <draft.json>`。草稿只能位于登记输出根。工具固定原文档 hash、应用受限替换、核查完整依赖图与 JSON 引用，生成内容定址的新文档、amendment.json 和完整 plan.json，并返回每项结果 hash。原计划、原库存、业务源码和 Authority 均不修改。既有不同字节制品不覆盖；审查退回后的新补丁生成新目录。

Application 接收原生结果前再次计算制品，拒绝内容、原始来源声明、引用或 hash 不一致。用户审阅稿展示原批准摘要、补丁摘要、影响范围和完整制品位置；新批准绑定原计划、精确补丁、合成结果与审查。旧批准不能复用，新批准也不启动实施。

原生 Agent 最终返回物化工具的紧凑 outputValue，其中 deltaRef 固定 amendment.json 的项目内路径和 SHA-256；完整补丁不通过最终对话转录。Application 读取并校验补丁、重新合成，保留原生结果与引用解析 Receipt，提交结果仍保存紧凑引用，审查和批准按需核验引用并重建完整计划，不把展开数据塞回结果端口。物化器保留库存中超出 IEEE-754 的整数和精确小数原 token；不要用普通 JSON.parse/stringify 重写库存。需计算此类值的原值摘要时使用 `amendment-json.mjs` 的 lossless parser 与 digestAmendmentJson。

## 成果承接和恢复

结果传输与制品容量分别受限：Agent 和 Kernel 提交的 `outputs` 均保持紧凑 `deltaRef`，保留 256 KiB 上限。Profile、审查与批准按项目边界读取固定摘要的增量并确定性重建计划；增量紧凑语义序列化最多 2 MiB，格式化制品文件读取上限与既有物化器一致为 128 MiB；读取期间大小变化、摘要漂移、越界路径或缺失文件均拒绝。完整计划保留在已核验制品中，不能塞回 typed output。旧版已经封存的内联计划继续兼容读取。

若旧协调器在原生结果已观测后因内部展开超过输出上限退出，可在可信 H2/H3 修复及重新绑定后，从项目 checkout 执行 `dev preserve-planning-result --manifest <manifest> --run <exact-run> --command-id <stable-id>`。该维护操作仅核验原 Host journal/rollout、原 Dispatch Schema、精确变更集合、原生结果与物化文件，复现旧上限问题后封存未接受结果和完整快照，通过原子事务撤销旧 Transport。它不提交 completed、不改变预算或来源归属、不创建 Run 或派发 Agent。再次 Amend 仍由新的用户命令、预检、规划、独立审查和新批准完成；旧候选只能作为未接受输入复用。

适中批次的新策略为 [`bounded-delivery/2`](bounded-delivery.md)。登记 `batchPolicy.policy` 后，物化器验证完整批次合同、精确义务覆盖、容量/预留与证明依赖；执行器将批次编译为独立原生调度单元并运行真实检查。旧版只有 `maxBatchesPerFeature` 的登记是兼容输入，不能据此宣称通用批次执行已启用。局部批次完成不得继承为原提案完成，实际预算计数必须从 Authority 承接。

规划因登记范围缺项返回 scope-blocker 且没有任何 completed Submission 时，可先补正变更登记及 scope hash，再由用户发起同一 selector 的新 amend。新 Plan 固定旧草稿的 revision/Authority/Plan/source 摘要，保留原批准基线、受影响 Feature、制品根、固定输入和既有 pointer 上界；活动 Lease、已接收输出、未解决 Finding、范围缩减或身份改变均阻断替换。通过新命令预检后，Kernel 才退役旧草稿并创建新 Run。此前已封存的实施成果按完整退役链、原 Submission/Evidence 和当前源码重新核验后承接；旧阻断和计数不清空。登记补正与只读 inspect 本身不创建或退役任何 Run。

另一条窄恢复分支处理已接收候选、独立审查拒绝、随后修订被 `PLAN_AMENDMENT_TOO_LARGE` 阻断的闲置 Amend：仅当绑定 Runtime 经修复发生变化、登记请求与范围完全相同、没有批准时，下一次用户命令可固定替换旧 Run。候选、被拒审查及修订 Submission 必须有原摘要、已提交 Dispatch/Evidence 和精确文件快照；审查结果仍为未通过，修订稿只作待核验输入。仅这次被拒审查原样登记的 open Findings 可承接：Application 核验原封存审查，经 Kernel 在新 Run 保持 open；其他未解决 Finding 阻断替换。新独立只读审查须逐 ID 返回 resolvedFindings、具体 checkpoint 及证据，核验原审查与新审查封存字节后才由 Kernel 关闭新 Run 中对应问题；approved 本身不能关闭问题，旧 Run 的原问题和拒绝结论不修改。新 Run 重新规划与独立审查，不继承规划完成或批准；原实施完成项、预算记录及整条退役链继续逐项复验。候选/草稿漂移、额外未声明制品、活动工作、不同请求或任何已通过审查均拒绝此分支。

启动前必须无活动实施 Lease/Dispatch 和未解决 Finding；旧实施 Run 经 Kernel 安全退役，原完成状态、Submission、Evidence 及计数历史保留。未受影响的已完成提案只有在提案内容、原 Submission/Evidence 和可信源码快照均核验通过后，才作为新实施图的已满足前置，避免重复开发。受影响项重新验证，未完成项的历史检查点与计数只作基线，不冒充新鲜认证。

承接仅允许登记的精确准备文件、受限修订制品及本次精确审阅归档改变；业务源码漂移、Evidence 缺失或歧义均拒绝承接。没有可信快照时不猜测完成，按正常增量复验处理。中断与补丁恢复沿用原 Host Receipt、H0–H4 和单命令规则。

范围阻断时已提交的规划审计文件可以随退役链保留，但不能把整个制品目录列为自动兼容。Application 逐项核对原 committed Dispatch、Submission 摘要及 Evidence，再将现场被声明文件重建到原输入快照，要求得到原 outputSourceDigest。文件被修改、证据缺失或目录内出现未声明制品均拒绝承接；连续多轮范围补正沿整条退役链复验。

## 验证

`node --test --test-isolation=none --test-concurrency=1 test/plan-amendment-e2e.test.mjs` 使用合成项目，分别覆盖内存 Runtime 和 Codex 原生可见宿主适配协议：解析、Plan/预检、Dispatch/Submission、独立审查退回和修订、新批准、closed Receipt、连续两次选择性实施承接，以及原生紧凑引用的解析 Receipt。不启动真实业务或 CLI Agent。专项单测覆盖越界、原值漂移、依赖环、身份变化、制品篡改和批准重放；真实业务仍须原生宿主预检和新的用户批准。
