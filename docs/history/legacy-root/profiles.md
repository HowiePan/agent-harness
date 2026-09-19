# V1.0.0 Profiles

Profile 组合通用 Workflow Primitive，不拥有 Authority，也不向 Kernel 注入业务分支。Project Descriptor 选择 Profile、参数与插件绑定。

## Feature Delivery

中性参考流程：Feature DAG → conflict waves → Gate → review findings → delivery receipt。用于证明非 CardWorld 项目可以零驻留接入。

## CardWorld Engine Delivery

Canonical Requirement 是 fan-out 前置；随后是版本规划、Feature Work Graph、实现 Wave、Scope Resolution、Quality Epoch、Docs Closeout、用户代码审核和 Delivery Receipt。Rust/WASM/release-contract 只是 Gate Recipe 数据，不属于 Kernel。

## Collection Batch Production

Rule Readiness → Batch Barrier → 批内 Feature Graph → Game Harness Acceptance → Independent Release Review → User Acceptance → Batch Close。

- 批间串行只由 Barrier 控制；
- 批内按 Feature 依赖、路径/符号/契约冲突决定并行；
- 10 个游戏可以同时保持逻辑 active，并受运行容量约束逐轮 Dispatch；
- 单游戏阻塞释放槽位，不阻止其他 eligible Feature；
- 共享能力由唯一 Capability Owner Feature 修改；
- 游戏完成不等于批次完成；所有游戏、P0-P3、Reviewer 与用户 Gate 均闭合后才能关闭批次。

## 复用边界

共享：Authority、Evidence、Feature/Lease/Attempt、DAG/冲突调度、Barrier、Approval、Review Epoch、Artifact Pin/Rebase、Docs Closeout、Receipt 与恢复框架。

差异：状态机顺序、角色、Gate Recipe、批次/游戏投影、共享能力 ownership、Artifact 影响策略和用户报告。差异保留在 Profile/Policy/Descriptor；只有旧格式解析留在各自 Legacy Importer。

流程节点与实例配置化的原始设计见 [可组合流程抽象方案](./workflow-composition-proposal.md)。现有实现、命令级闭环和适用边界见 [可组合流程与记忆平台实现记录](./workflow-platform-implementation.md)。
