# Agent Harness

**状态**：Repository Extraction Ready；Recovery、本地 G6 候选工具链、MIT 与 clean-start 决定已完成，远端 CI/发布和正式制品 Run Canary 尚未完成
**定位**：与业务项目、Agent 工具和模型供应商解耦的持久化 Agent 工作流控制面

Agent Harness 负责把需求、工作图、Agent 执行、确定性 Gate、审核、人工决定和恢复组织成可持久化、可审计、可替换执行工具的流程。业务仓默认不保存 Harness 实现、运行状态、Prompt 或 Harness 技术文档。

本项目已经具备独立 Authority Kernel、Coordinator、插件宿主、持久 Extension Registry、三套 Profile、两个 Consumer Adapter、Codex Runtime Pack、Legacy Compatibility Pack、CLI/API、Conformance 与零驻留 Canary。默认 `createHarness()` 只加载中立 Feature Profile 和参考插件，不自动加载业务、供应商或 Legacy 能力。Extension 安装回执绑定完整制品清单摘要，进程重启后从独立控制根自动恢复。真实恢复与切换必须经过 Recovery Capsule、隔离 Canary、rollback 和用户审批。

## 已交付能力

- expected revision、command ID、原子事务、崩溃恢复、Evidence 和 Receipt；
- Feature 依赖/冲突图、Lease/Attempt 预算、P0-P3 全阻断质量闭环；
- Scheduler、Runtime、Model、Tool、Codec、Gate、Artifact、Storage 插件契约；
- 非交互 Codex CLI Runtime、10 路隔离工作区 Codex Runtime、callback Runtime 与独立进程 Runtime；
- 可替换 Model Router 决定写入不可变 Dispatch，Gate Recipe 由 Project Descriptor 执行；
- 中性 Feature Delivery、CardWorld Engine Delivery、Collection Batch Production Profile；
- CardWorld 与 Collection 旧状态只读评估和新 Epoch 导入；
- 三类业务项目零驻留 Canary，包含 Collection 10 游戏逻辑并行与隔离工作区物理并发。

V1.0.0 不迁移旧源码，也不让业务仓保存 Harness 运行状态。旧 Harness 的真实恢复、入口切换与归档是独立高影响 Gate；删除资格可以由 Harness 验证，但删除动作只能由用户明确决定和批准。

旧 Harness 的兼容协议已经冻结为本项目内的脱敏 Characterization Fixture 和摘要测试。除真实 cutover 前对具体现场做最后一次只读 assessment 外，V1.0.0 后续设计、开发和验证不再把 CardWorld 或 Collection 的旧 Harness 源码当作参考依赖。

## 核心目标

1. **业务仓零驻留**：Harness 从外部注册、附着和调度项目。
2. **工具与模型可插拔**：Codex 只是一个 Runtime Plugin，不进入 Kernel。
3. **可靠性统一**：状态、事务、预算、恢复、证据和回执只在 Kernel 实现一次。
4. **项目差异声明化**：通过 Profile、Policy 和 Project Descriptor 组合项目流程。
5. **差异流程复用**：CardWorld Delivery 与 Collection Batch Production 使用不同 Profile/Policy，共用 Kernel、插件和 Feature 调度原语。
6. **差异先审计**：W1 前通过 G0 双轨差异审计，以实际实现和事实决定公共化边界。
7. **硬恢复兼容**：CardWorld Engine Harness 与 Collection Harness 至少能恢复到新 Epoch。
8. **可独立发布**：版本、包、状态目录和文档不依赖 CardWorld 主干版本。

## 文档

- [目标架构](docs/architecture.md)
- [协议与不变量](docs/protocol.md)
- [插件 SDK](docs/plugin-sdk.md)
- [Profile 设计](docs/profiles.md)
- [CardWorld Consumer](docs/consumers/cardworld.md)
- [Collection Consumer](docs/consumers/tabletop-collection.md)
- [Legacy Characterization](docs/compatibility/legacy-characterization.md)
- [运维手册](docs/operations.md)
- [Operator Contract](docs/operator-contract.md)
- [缺陷、升级与回滚](docs/maintenance.md)
- [V1.0.0 迁移准出 Gate](docs/migration-gates.md)
- [仓库抽离后修复与验证台账](docs/post-extraction-register.md)
- [写入路径与清理策略](docs/path-policy.md)
- [插件输出、预算与 OS 沙箱](docs/execution-control.md)
- [恢复与切换](docs/recovery.md)
- [完整版本方案](docs/project-plan.md)
- [G0 双轨差异审计 Gate](docs/gates/dual-track-differential-audit.md)
- [V1.0.0 验收记录](docs/acceptance/v1.0.0.md)
- [版本索引](docs/versions/INDEX.md)

## 项目边界

本目录拥有独立 `.git`、包边界和发布清单；它当前物理上位于 CardWorld 工作区中，仅用于首次开发和合成测试，代码、测试和运行时不引用父目录。正式部署使用位于所有受管业务 workspace 之外的 Standalone Control Root。源码 checkout 可直接作为控制根；npm 制品必须位于控制根内部并先生成安装标记，禁止默认把 `node_modules/agent-harness` 当作数据根。业务项目通过外部 Project Descriptor 注册；Authority、Evidence、扩展注册表、缓存和临时目录只能写在该控制根内部。

产品需求、产品架构和产品版本文档继续属于业务项目；Harness 架构、协议、Prompt、插件说明、运行状态、技术版本和恢复记录属于本项目。

## 快速验证

```powershell
npm test
npm run check
npm run build:release-candidate
node bin/agent-harness.mjs doctor --data-root .tmp/doctor
```

`build:release-candidate` 只接受干净提交，生成真实 tarball、隔离安装探针与内容寻址 Release Candidate Receipt。`doctor` 只验证路径、发布摘要和扩展安装回执，不执行 Extension，也不创建目录或文件。CLI 的所有改变状态命令都要求 `--command-id`；`dataRoot` 默认是 Standalone Control Root 下的 `.agent-harness-data/`。完整命令见 [运维手册](docs/operations.md)。
