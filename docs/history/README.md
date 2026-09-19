# 历史与证据索引

此目录保存各阶段的原始判断与证据。文中的“当前”“待实现”和准出状态均以原记录日期为准。现行架构、Flow 合同和接入方式分别以[整体设计](../architecture/system-design.md)、[流程设计](../flows/delivery-lifecycle/design.md)和[接入指南](../guides/consumer-quickstart.md)为准。

| 目录 | 用途 | 使用边界 |
| --- | --- | --- |
| [legacy-root](./legacy-root/project-plan.md) | 原根目录中的方案、旧架构与实施记录 | 设计演进记录，不定义当前合同 |
| [consumers](./consumers/cardworld.md) | 旧 CardWorld/Collection 接入示例 | 使用旧 Consumer/Profile 术语，仅供兼容追溯；现行变体见各 Flow 设计 |
| [versions](./versions/INDEX.md) | V1.0.0 原版本计划及当时的状态 | 版本身份与历史里程碑，不代表当前准出结论 |
| [decisions](./decisions/0001-source-harness-closure.md) | 用户决定与架构决策原文 | 保留决定发生时的范围和授权边界 |
| [gates](./gates/dual-track-differential-audit.md)、[audits/g0](./audits/g0/implementation-inventory.md) | G0 条件、差异审计与冻结回执 | 已通过 Gate 的历史证据 |
| [acceptance](./acceptance/v1.0.0.md) | 历次自动验收、目录整改命令级记录及证据 JSON | 测试数量和 Run ID 均绑定记录时的源码 |
| [recovery](./recovery/cardworld-t1-t2-dry-run.md) | 旧业务状态只读恢复演练 | 只读评估，不表示真实 Run 已恢复 |

[目录整改批准方案](./project-structure-refactor.md)也保留在此。仍用于 Legacy Importer 的冻结样本合同见[Legacy 兼容基线](../reference/legacy-compatibility.md)。原始证据内容未因归档而改写；路径变化须同步发布清单、代码引用和文档链接。
