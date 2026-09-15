# Agent Harness

**状态**：V1.0.0 Migration Code Ready 候选；交互式 Runtime 已改为可见子 Agent，既有本地候选制品证据需基于新提交重新生成；远端 CI 与发布按所有者决定延期
**定位**：与业务项目、Agent 工具和模型供应商解耦的持久化 Agent 工作流控制面

Agent Harness 负责把需求、工作图、Agent 执行、确定性 Gate、审核、人工决定和恢复组织成可持久化、可审计、可替换执行工具的流程。业务仓默认不保存 Harness 实现、运行状态、Prompt 或 Harness 技术文档。

本项目已经具备独立 Authority Kernel、Coordinator、插件宿主、持久 Extension Registry、三套 Profile、两个 Consumer Adapter、Codex Runtime Pack、Legacy Compatibility Pack、CLI/API、Conformance 与零驻留 Canary。默认 `createHarness()` 只加载中立 Feature Profile 和参考插件，不自动加载业务、供应商或 Legacy 能力。Extension 安装回执绑定完整制品清单摘要，进程重启后从独立控制根自动恢复。真实恢复必须经过 Recovery Capsule、隔离验证和 rollback；最终外部切换仍须用户审批。

## 已交付能力

- expected revision、command ID、原子事务、崩溃恢复、Evidence 和 Receipt；
- Feature 依赖/冲突图、Lease/Attempt 预算、P0-P3 全阻断质量闭环；
- Scheduler、Runtime、Model、Tool、Codec、Gate、Artifact、Storage 插件契约；
- 默认交互式 `codex-conversation-runtime`、可见子 Agent Lease/heartbeat/inspect reference，以及仅供显式 headless/CI 使用的 Codex CLI、隔离工作区和独立进程 Runtime；
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

## 对话式流程命令

Codex 插件提供通用伪命令 Router：`h:<项目别名> <动作> <目标> [预设]`。安装数据把项目别名显式绑定到 Project、Profile、Extension，并固定 Harness `controlRoot`、入口和数据根；Router 不根据版本号、批次号或目录名猜项目，也不扫描磁盘寻找 Harness。选定项目后，再从其 Extension Pack 的 `commandManifest` 取得动作、默认预设、阶段范围和停止条件。保留命令 `h:where [项目别名]` 用于查询绑定，`h:report <项目别名>` 用于从当前对话采集脱敏问题并写入固定的 `<controlRoot>/issues` 上游目录；问题上报不创建新对话，也不依赖 Registry 或 Authority 可用。其他 Agent 工具可以实现同一解析契约，无需采用 Codex Skill。

例如：`h:engine full V3.8.4`、`h:engine req V3.8.4 expand-to-plan`、`h:engine quality V3.8.4 review-only`，以及 `h:collection quality B1 all`。`engine` 和 `collection` 只是该安装选择的别名，不进入 Kernel；`h:where` 可只读显示 Harness 路径和全部项目绑定。

Hook 只把符合语法的输入转换成 Command Intent，不直接启动流程。`$agent-harness-command` 是显式回退入口。需求审查的多个预设和两条 Harness 的完整流程都由各自 Extension 声明，Authority/Evidence、P0-P3 阻断与批准边界仍由统一 Operator Contract 保证。完整参数见 [运维手册](docs/operations.md)。

交互式 Project Descriptor 必须声明 `agentExecutionMode: conversation-visible` 和 `promptCodecPlugin`。每个 Dispatch 固定 Prompt Codec/Contract 版本，由 Codec 从不可变 Packet 确定性生成完整 Prompt；Codex 宿主只能把这段文本原样交给可见子 Agent，不能临时串联或改写。可信宿主适配器把 Agent、Dispatch、Packet 摘要、Prompt 摘要与可检查任务引用绑定后才能建立 Lease，并负责 spawn、wait、heartbeat、结构化 result transport 与重启重连。缺少任一原生能力时 action-scoped preflight 一次列出全部 blockers、`executionReady=false`，且不创建 Run；禁止即兴拼 Prompt、用原始 CLI Receipt、`codex exec` 或其他后台 Agent 进程兜底。Descriptor 的 `policy.actionExecution.<action>` 只表达允许的模式与 Runtime，不能保存或伪造用户授权。`headless` 必须同时满足可信用户约束、Descriptor allow-policy 和宿主从原始 CI/无人值守请求签发的 command-scoped `LifecycleExecutionGrant`；Grant 固定 Project、Intent、Run、Runtime、workspace 与 constraint digest，过期、跨命令/Run 重放或任一 deny 都会在创建 Run 和每次启动前拒绝。普通交互命令的原始消息一次授权 Manifest 范围内的连续生命周期；Run 复用、reattach、ordinary resume、经验证的 hard recovery 和无副作用 replacement 由 Core lineage policy 自动裁决，不逐步追加批准。发布、权限扩张、不可逆迁移、旧数据删除和最终 external cutover 仍使用独立 Decision。质量审查本身强制只读；Finding 修复必须带非空检查点和宿主保存的验证 Receipt，修复后自动按新源码摘要进行全量只读复审。测试、构建、打包和确定性 Gate 仍可使用受管子进程，但启动前必须挂接实时观察器并显示启动、进度/输出和结束状态，且不能承载 Agent 推理。

## 项目边界

本目录拥有独立 `.git`、包边界和发布清单；它当前物理上位于 CardWorld 工作区中，仅用于首次开发和合成测试，代码、测试和运行时不引用父目录。正式部署使用位于所有受管业务 workspace 之外的 Standalone Control Root。源码 checkout 可直接作为控制根；npm 制品必须位于控制根内部并先生成安装标记，禁止默认把 `node_modules/agent-harness` 当作数据根。业务项目通过外部 Project Descriptor 注册；Authority、Evidence、扩展注册表、缓存和临时目录只能写在该控制根内部。

产品需求、产品架构和产品版本文档继续属于业务项目；Harness 架构、协议、Prompt、插件说明、运行状态、技术版本和恢复记录属于本项目。

## 快速验证

```powershell
npm test
npm run check
npm run build:release-candidate
npm run release:plugin:check
# 确认预检后，一键构建候选并清缓存重装本地 Codex 插件
npm run release:plugin
node bin/agent-harness.mjs doctor --data-root .tmp/doctor
```

`build:release-candidate` 只接受干净提交，生成真实 tarball、隔离安装探针与内容寻址 Release Candidate Receipt。`release:plugin` 在完整验证和候选构建后，固定执行本地 marketplace 检查、同版本插件 remove/add 缓存清理与安装后状态核对；它不执行远端发布、Git 操作、真实切换或任何 Agent CLI。`doctor` 只报告安装、Registry 与逐项目静态就绪，不再把它们误称为可执行；具体动作必须先生成短 TTL、绑定 Plan/Project/Release 的 `ExecutionReadinessReport`。`project list` 与 `run status` 同样不加载 Extension 代码。首次投产使用零写入 `bootstrap plan` 和经批准、可恢复的 `bootstrap apply`。CLI 的所有改变状态命令都要求 `--command-id`；完整命令见 [运维手册](docs/operations.md)。
