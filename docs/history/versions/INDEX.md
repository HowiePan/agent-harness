# Agent Harness 版本索引

> 历史记录：以下状态记录 V1.0.0 初期迁移阶段，不用于判断当前工作树是否准出。当前能力见[项目说明](../../overview/project.md)，当前验收须重新执行命令级闭环。

**目标版本**：V1.0.0  
**状态**：Migration Code Ready 候选；RCV、UNLICENSED 已完成，旧候选/Canary 是历史证据；可见子 Agent Runtime 修订后的候选制品和宿主 Canary 待重建，远端 CI/发布延期
**中间发布**：无

| 版本 | 状态 | 主题 |
|:---|:---|:---|
| [V1.0.0](./v1.0.0.md) | 🛠 实现候选 | 独立、零驻留、Extension/Skills、插件化与双 Legacy Hard Recovery 能力 |

V1.0.0 内部使用 W0-W9 组织实施、依赖和阶段验证，但 Wave 不是版本，也不能独立准出。W0 与 W1 之间设有正式的 [G0 双轨差异审计 Gate](../gates/dual-track-differential-audit.md)，未通过时不得冻结通用协议或定型 Kernel/Profile。完整范围见 [V1.0.0 完整版本方案](../legacy-root/project-plan.md)。

当前基线已完成独立性、只读 Legacy assessment、Conformance、Canary、clean-room 和本地发布元数据，可以提交到独立仓库。抽离后的代码修复、发布与现场验证见[仓库抽离后修复与验证台账](../legacy-root/post-extraction-register.md)；真实业务 Run cutover 与旧实现清理由用户另行批准。
