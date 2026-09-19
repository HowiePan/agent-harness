# Legacy Recovery 与零驻留切换

## 过程

```text
read-only inventory
→ source/assessment digest
→ disposition classification
→ isolated new epoch
→ shadow projection
→ canary and rollback exercise
→ user decision
→ cutover
```

Importer 只负责理解一种旧格式。CardWorld 和 Collection 不共享解析器；它们共享事实分类、Evidence、事务、新 epoch/generation、Receipt 和 rollback 机制。

V1.0.0 的日常兼容基线已冻结为 [Legacy Characterization](../../reference/legacy-compatibility.md)。旧实现不再是规范来源；现场旧目录只在真实 cutover 前作为一次性只读 assessment 输入。

Capsule 一致性 staging、完整复算、链接拒绝、verification Evidence 和 Recovery Coordinator 已实现并通过负向测试。`AH-20260915-7007E9BFAFD4` 后，Core 以 `RecoveryResolutionReceipt` 自动授权仅发生在 Standalone Control Root 内、带 rollback snapshot 和完成态重验的 hard recovery；不再要求用户重复选择恢复机制。真实发布、外部 cutover、不可逆迁移或删除仍必须经过对应效果 Gate。

真实旧状态在删除旧源码前必须生成 Recovery Capsule。Capsule 位于 Harness 自身 `dataRoot/migrations/capsules/`，包含原始状态 payload、只读 assessment、文件清单、容量与内容摘要，不包含源码、脚本、EXE、DLL 或 PDB。Capsule 的保留与销毁由用户决定；Harness 不自动删除。

截至 2026-09-13 的现场复核中，冻结文档指定的 `CardWorld/.harness/engine` 与 `tabletop-collection/runs` 均已不存在。因此 CUT-001/002 不能再按原计划执行，任何真实 hard recovery 结论都必须保持阻断。V1.0.0 提供 `legacy-source-unavailable` Receipt 来记录这一不可逆事实，但它不是 Capsule、不能恢复旧 Authority，也不提升 hard-recovery Gate；Harness 在只读确认精确路径缺失后自动限定为全新 Run，旧版所有者 acknowledgement 仅作兼容证据。

允许分类为 `verified-current`、`stale-revalidate`、`log-only`、`invalid`、`superseded`。旧完成标志、Lease、Packet、Agent 身份和预算计数不会直接变成新 Authority。`stale-revalidate` 必须在当前源码与 Gate 上重新验证。

## 当前只读结果

- [CardWorld T1/T2 dry-run](../recovery/cardworld-t1-t2-dry-run.md)
- [Collection M2/B1 dry-run](../recovery/collection-m2-b1-dry-run.md)

这些记录证明 Importer 能解释现场，不代表真实 Run 已恢复。当前没有改写旧状态、创建真实新 Epoch、替换入口或删除业务仓文件。

## 切换 Gate

真实切换前必须冻结源事实、复跑 assessment、核对摘要、在隔离 `dataRoot` 创建新 epoch、完成目标 Profile Canary 并演练 rollback。Harness 根据验证 Evidence 自主选择 reattach、ordinary resume、hard recovery 或 clean start；只有最终 external cutover 及其外部效果需要用户批准。hard recovery 前自动封存 Authority Evidence；rollback 进入更高 epoch/generation、作废活动 Transport，并把恢复出的 Feature 标记为重新验证。切换后先保留旧 Harness 只读；删除必须另行批准。

零驻留的含义是业务仓不保存 Harness 实现、Prompt、Authority 或技术文档。业务仓仍可保留业务自身的 CI 配置或薄调用入口；默认由外部 Project Registry 记录仓路径、Profile 与插件选择。
