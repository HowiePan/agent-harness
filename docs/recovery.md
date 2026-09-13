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

V1.0.0 的日常兼容基线已冻结为 [Legacy Characterization](compatibility/legacy-characterization.md)。旧实现不再是规范来源；现场旧目录只在真实 cutover 前作为一次性只读 assessment 输入。

当前实现已经足够随源码抽离到独立仓库，但 Capsule 一致性、完整验证、链接处理和 live hard recovery 审批链仍须在业务切换前修复。权威问题与关闭条件见[仓库抽离后修复与验证台账](post-extraction-register.md)的 RCV-001～RCV-006；在这些项目关闭前不得创建用于正式切换的真实 Capsule，也不得执行 live hard recovery。

真实旧状态在删除旧源码前必须生成 Recovery Capsule。Capsule 位于 Harness 自身 `dataRoot/migrations/capsules/`，包含原始状态 payload、只读 assessment、文件清单、容量与内容摘要，不包含源码、脚本、EXE、DLL 或 PDB。Capsule 的保留与销毁由用户决定；Harness 不自动删除。

允许分类为 `verified-current`、`stale-revalidate`、`log-only`、`invalid`、`superseded`。旧完成标志、Lease、Packet、Agent 身份和预算计数不会直接变成新 Authority。`stale-revalidate` 必须在当前源码与 Gate 上重新验证。

## 当前只读结果

- [CardWorld T1/T2 dry-run](recovery/cardworld-t1-t2-dry-run.md)
- [Collection M2/B1 dry-run](recovery/collection-m2-b1-dry-run.md)

这些记录证明 Importer 能解释现场，不代表真实 Run 已恢复。当前没有改写旧状态、创建真实新 Epoch、替换入口或删除业务仓文件。

## 切换 Gate

真实切换前必须冻结源事实、复跑 assessment、核对摘要、在隔离 `dataRoot` 创建新 epoch、完成目标 Profile Canary、演练 rollback，并由用户批准准确的 Project/Run/epoch。hard recovery 前自动封存 Authority Evidence；rollback 进入更高 epoch/generation、作废活动 Transport，并把恢复出的 Feature 标记为重新验证。切换后先保留旧 Harness 只读；删除必须另行批准。

零驻留的含义是业务仓不保存 Harness 实现、Prompt、Authority 或技术文档。业务仓仍可保留业务自身的 CI 配置或薄调用入口；默认由外部 Project Registry 记录仓路径、Profile 与插件选择。
