# 局部计划修订

`amend <target> change:<id>` 用于已批准计划的有限依赖、职责、退出时点或验证接线调整。普通实现修复继续 implement；最终架构、需求、提案身份或跨项目归属变化使用 replan。

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

planPointers 是原 typed plan 的 JSON pointer 修改上界。外置计划/库存使用 documents，每项固定 id、source 的 path/sha256、新 outputPath 和 allowedPointers；文档来源必须由原批准计划固定摘要。每个替换带原 JSON 值的 expectedDigest。禁止根替换、原型路径、重叠/无操作补丁、提案增删或归属变化，以及最终 targetLayout/target/protectedOperations 改动。完整补丁上限 2 MiB，超限或越界明确要求 Replan。

大范围清单可以独立保存为项目 JSON 文件，在变更单登记 `amendmentScopeRef: {path, sha256}`，与内联 amendmentScope 二选一。Application 从当前项目读取并核对固定摘要，再将解析后的范围固定到本次 Plan；文件漂移即拒绝。清单自身如属新准备文件，也须列入 baselineCompatibilityPaths。

## 节点、合成和批准

流程为 amend → plan-review → user approval。规划节点只输出 `delivery-plan-amendment-v1` 增量，不接收 Agent 重写的完整计划。独立审查只读，检查补丁和受影响的生产者、消费者、类型、生命周期、公开 API 与验收，结果固定 basePlanDigest、deltaDigest 及完整 reviewedFeatureIds。

登记检查命令为 `node <entrypoint> dev amendment-inspect --manifest <manifest> --change <id>`。它只读登记范围、批准基线和闲置实施 Run，不编译生命周期 Plan，不创建 Run；commandReady 不代表 executionReady。

规划 Agent 在活动 Dispatch 内执行 `node <entrypoint> dev amendment-materialize --manifest <manifest> --run <amend-run> --patch <draft.json>`。草稿只能位于登记输出根。工具固定原文档 hash、应用受限替换、核查完整依赖图与 JSON 引用，生成内容定址的新文档、amendment.json 和完整 plan.json，并返回每项结果 hash。原计划、原库存、业务源码和 Authority 均不修改。既有不同字节制品不覆盖；审查退回后的新补丁生成新目录。

Application 接收原生结果前再次计算制品，拒绝内容、原始来源声明、引用或 hash 不一致。用户审阅稿展示原批准摘要、补丁摘要、影响范围和完整制品位置；新批准绑定原计划、精确补丁、合成结果与审查。旧批准不能复用，新批准也不启动实施。

原生 Agent 最终返回物化工具的紧凑 outputValue，其中 deltaRef 固定 amendment.json 的项目内路径和 SHA-256；完整补丁不通过最终对话转录。Application 读取并校验补丁、重新合成，保留原生结果与引用解析 Receipt，再保存派生的 typed plan。审查输入也是引用和合成后的计划，不展开长补丁。物化器保留库存中超出 IEEE-754 的整数和精确小数原 token；不要用普通 JSON.parse/stringify 重写库存。需计算此类值的原值摘要时使用 `amendment-json.mjs` 的 lossless parser 与 digestAmendmentJson。

## 成果承接和恢复

规划因登记范围缺项返回 scope-blocker 且没有任何 completed Submission 时，可先补正变更登记及 scope hash，再由用户发起同一 selector 的新 amend。新 Plan 固定旧草稿的 revision/Authority/Plan/source 摘要，保留原批准基线、受影响 Feature、制品根、固定输入和既有 pointer 上界；活动 Lease、已接收输出、未解决 Finding、范围缩减或身份改变均阻断替换。通过新命令预检后，Kernel 才退役旧草稿并创建新 Run。此前已封存的实施成果按完整退役链、原 Submission/Evidence 和当前源码重新核验后承接；旧阻断和计数不清空。登记补正与只读 inspect 本身不创建或退役任何 Run。

启动前必须无活动实施 Lease/Dispatch 和未解决 Finding；旧实施 Run 经 Kernel 安全退役，原完成状态、Submission、Evidence 及计数历史保留。未受影响的已完成提案只有在提案内容、原 Submission/Evidence 和可信源码快照均核验通过后，才作为新实施图的已满足前置，避免重复开发。受影响项重新验证，未完成项的历史检查点与计数只作基线，不冒充新鲜认证。

承接仅允许登记的精确准备文件、受限修订制品及本次精确审阅归档改变；业务源码漂移、Evidence 缺失或歧义均拒绝承接。没有可信快照时不猜测完成，按正常增量复验处理。中断与补丁恢复沿用原 Host Receipt、H0–H4 和单命令规则。

范围阻断时已提交的规划审计文件可以随退役链保留，但不能把整个制品目录列为自动兼容。Application 逐项核对原 committed Dispatch、Submission 摘要及 Evidence，再将现场被声明文件重建到原输入快照，要求得到原 outputSourceDigest。文件被修改、证据缺失或目录内出现未声明制品均拒绝承接；连续多轮范围补正沿整条退役链复验。

## 验证

`node --test --test-isolation=none --test-concurrency=1 test/plan-amendment-e2e.test.mjs` 使用合成项目，分别覆盖内存 Runtime 和 Codex 原生可见宿主适配协议：解析、Plan/预检、Dispatch/Submission、独立审查退回和修订、新批准、closed Receipt、连续两次选择性实施承接，以及原生紧凑引用的解析 Receipt。不启动真实业务或 CLI Agent。专项单测覆盖越界、原值漂移、依赖环、身份变化、制品篡改和批准重放；真实业务仍须原生宿主预检和新的用户批准。
