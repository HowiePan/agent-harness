# Agent Harness V1.0.0 完整版本方案

**版本**：V1.0.0  
**状态**：Repository Extraction Ready；抽离后 RCV 修复完成，发布、真实 Recovery Capsule 和切换待完成
**发布策略**：不发布中间小版本；内部 Wave 只作为实施和验证检查点  
**迁移策略**：旧实现不复制、不再作为参考；现场只读状态封装、真实迁移与切换仍关闭，旧 Harness 删除只由用户决定

## 一、版本目标

V1.0.0 一次性建立可独立安装、业务仓零驻留、工具与模型可插拔、支持多种差异化流程的 Agent Harness，并完成 CardWorld Engine Harness 与 tabletop-collection Harness 的硬恢复验证。

V1.0.0 只在以下整体目标共同满足后准出：

1. 通用协议、Authority Kernel、事务、Evidence 和 Recovery 闭环；
2. Scheduler、Runtime、Model、Tool、Codec、Gate、Artifact 和 Storage 插件体系闭环；
3. CardWorld Engine Delivery 与 Collection Batch Production 两条差异流程由同一 Kernel 上的不同 Profile/Policy 表达；
4. 两条流程都以 Feature 为 Agent 调度单元，并按依赖与冲突图决定并行或串行；
5. 两条流程的当前质量周期都要求 P0-P3 全量关闭；
6. 两个旧 Harness 都能从当前事实建立新 Epoch；
7. 至少一个非 Codex Runtime 通过同一 Conformance Suite；
8. 业务仓零 Harness 驻留模式完成 Canary；
9. W1 前通过 G0 双轨差异审计，所有有效行为都有来源、处置和架构归属；
10. 用户批准最终切换候选；
11. 交互式 Agent 执行全部通过可见子 Agent，宿主委派不可用时 fail closed；进程 Agent Runtime 仅允许显式 headless/CI。

## 二、已满足前置条件

用户已于 2026-09-12 确认现有 Harness 问题收口，`SOURCE-HARNESS-CLOSURE` 已满足，记录见 [`decisions/0001-source-harness-closure.md`](../decisions/0001-source-harness-closure.md)。

该决定不等于自动启动代码或迁移。V1.0.0 W1、Legacy Inventory、Hard Recovery、真实 Canary 和旧内容清理仍分别需要相应实施步骤和权限。

### 2.1 G0 双轨差异审计前置门

W0 完成后、W1 启动前，必须执行正式的 G0 双轨差异审计。它同时比较 CardWorld Engine Harness、tabletop-collection Harness 和 V1.0.0 目标模型，并以实际代码、Schema、文档和获准读取的运行事实为依据。

G0 不是迁移步骤，不启动或恢复真实 Run。它必须产出：

- 实现清单和来源摘要；
- 能力差异矩阵及 `preserve/adapt/legacy-only/supersede/reject-defect/unresolved` 处置；
- Kernel、Workflow Primitive、Profile/Policy、Plugin/Descriptor、Legacy Importer、Retired 唯一归属；
- 两条状态机、调度并发、Evidence/Quality 和 Legacy Recovery 映射；
- 禁止继承的旧缺陷清单；
- 覆盖 Engine 差异流程和 Collection 10 游戏逻辑并行的 Golden Scenario；
- 独立 Reviewer 结论和 G0 Gate Receipt。

任何 `unresolved`、无来源结论、Kernel 业务专名泄漏或未被场景覆盖的关键差异都会阻断 W1。完整合同见 [G0 双轨差异审计 Gate](../gates/dual-track-differential-audit.md)。

## 三、架构分层

```text
Application / CLI / API / MCP
             │
             ▼
Authority Kernel
  Run / Stage / Feature / Dispatch / Lease / Attempt
  Submission / Evidence / Gate / Finding / Decision / Receipt
             │
             ▼
Plugin Host
  Scheduler / Runtime / Model / Tool / Codec / Gate / Artifact / Storage
             │
             ▼
Workflow Primitives
  Work Graph / Barrier / Approval / Review Epoch / Artifact Pin / Docs Closeout
             │
       ┌─────┴─────────────────┐
       ▼                       ▼
CardWorld Profile       Collection Profile
```

Kernel 不认识 CardWorld、Collection、Codex、Rust、WASM、Game、Batch 或具体模型名。项目专名只允许存在于 Project Descriptor、Profile 参数、Legacy Importer 和用户报告投影中。

## 四、统一 Feature 调度合同

Engine 与 Collection 都使用 Feature 作为 Agent Lease 的最小单位：

```json
{
  "featureId": "stable-id",
  "kind": "implementation",
  "ownerRole": "implementation",
  "acceptance": [],
  "steps": [],
  "dependsOn": [],
  "allowedPaths": [],
  "forbiddenPaths": [],
  "symbols": [],
  "contracts": [],
  "generatedOutputs": [],
  "artifactInputs": [],
  "artifactOutputs": [],
  "conflictKeys": [],
  "gatePlan": []
}
```

调度不变量：

- Feature 内 Steps 由同一 Agent 按序完成，不拆成多个 Lease；
- Step 不单独计预算，不能通过拆 Step 刷新 Attempt；
- 若一个 Step 会解锁其他独立工作，必须在规划阶段提升为独立 Feature；
- Feature 之间按 dependsOn 和真实冲突图生成 Wave；
- `serial` 标签不是全局锁，只有实际冲突或依赖才串行；
- 调度器可以提出并发 Intent，但 Kernel 决定是否合法；
- 单个 Feature 阻塞时，其他无依赖且无冲突的 Feature 继续；
- Collection 的“批间串行”是外层 Batch Barrier，不替代批内 Feature 图。

## 五、两条差异流程

### 5.1 CardWorld Engine Delivery

```text
Requirement Intake
→ Canonical Requirement
→ Version Planning
→ Feature Work Graph
→ Implementation Waves
→ Scope Resolution
→ Quality Epoch
→ Docs Closeout
→ User Code Review
→ Delivery Receipt
```

特有 Policy：

- canonical requirement 形成前保持单线；
- Feature 按源码、符号、公共契约和生成物冲突分 Wave；
- Scope drift 独立处置；
- Quality Epoch 对 P0-P3 全量修复，最终 full-sweep 仍有 finding 时终止当前 Epoch；
- Rust、WASM 和 release-contract 由 Gate Recipe 组合；
- Docs Closeout 后才进入用户代码审核。

### 5.2 Collection Batch Production

```text
Rule Readiness
→ Batch Launch
→ Batch Feature Graph
→ Round Dispatch
→ Shared Capability Ownership
→ Game Harness Acceptance
→ Independent Release Review
→ User Game/Batch Acceptance
→ Batch Close
→ Collection Release Receipt
```

特有 Policy：

- Rule Readiness 是实现前置 Authority；
- 当前批次 Feature 可以并行，下一批由 Batch Barrier 锁定；
- Feature 可以对应游戏、场景、共享能力、Review、Docs 或 Artifact Rebase；
- 同游戏内存在依赖或共享文件冲突的 Feature 串行，不冲突 Feature 才并行；
- 跨游戏共享能力只能由唯一 Capability Owner Feature 修改；
- 单款阻塞释放执行槽，但未关闭游戏仍阻止批次关闭；
- Engine Artifact Identity 变化按能力影响集失效；
- Harness Acceptance、Reviewer approval 和 User acceptance 权限分离；
- Review/Quality 对 P0-P3 全量修复，不允许通过 P2/P3 owned debt 准出；
- known-debt 只保留历史、审计和非当前版本观察项，不是 V1.0.0 准出通道。

## 六、V1.0.0 内部实施 Wave

Wave 是内部工作分解，不是独立版本。任何 Wave 通过都不能对外宣称 Agent Harness 已准出。

正式顺序为：

```text
W0 独立项目与冻结基线
→ G0 双轨差异审计 Gate
→ W1 协议与 Conformance Foundation
→ W2-W9 实施与准出
```

G0 是 W1 的硬前置，不是可跳过的调研任务，也不新增公开版本号。

### W0：独立项目与冻结基线

目标：确定物理独立性和后续开发 Authority。

交付：

- 独立仓库、包命名、许可证和发布边界；
- 外部 State Root、Project Registry 和 Evidence Root；
- V1.0.0 方案、术语和决策记录；
- 现有 Harness 收口声明；
- 迁移和真实运行继续保持关闭。

Gate：项目不依赖 CardWorld 父目录、workspace、symlink 或隐式环境。

W0 通过后进入 G0。G0 负责根据两套现有 Harness 的真实差异校正 W1 输入；G0 未通过时不得启动 W1。

### W1：协议与 Conformance Foundation

目标：冻结跨项目、跨 Runtime 的通用协议。

交付：

- Project、Run、Stage、Feature、Dispatch、Lease、Attempt、Submission、Evidence、Gate、Finding、Decision、Receipt Schema；
- Business Result 与 Authority Envelope 分离；
- canonical serialization、digest、错误分类和 stable budget key；
- Intent/Event/Receipt 插件输出合同；
- 协议兼容、弃用和 Migration Manifest；
- 参数化 Conformance Test Harness。

Gate：G0 Receipt 有效；Schema 能表达两条目标流程和全部 Golden Scenario，且没有项目或供应商专名。

### W2：Authority Kernel 与外部 Storage

目标：完成唯一可靠性内核。

交付：

- Run/Stage/Feature Work Graph；
- Dispatch/Lease/Attempt/Submission 生命周期；
- expected revision、command ID 和幂等；
- 原子写、锁、事务、Authority-last commit；
- 受管路径和内容寻址 Evidence；
- ordinary resume、hard recovery、generation 和 Epoch；
- Receipt、查询投影和一致性审计；
- crash-point fault injection。

Gate：任一故障点不产生半权威状态；业务仓内不产生 Harness 状态。

### W3：Plugin SDK 与信任边界

目标：把执行工具和策略从 Kernel 完全移除。

交付：

- Scheduler Strategy；
- Agent Runtime；
- Model Router；
- Tool Broker；
- Prompt/Result Codec；
- Gate Executor；
- Artifact Provider；
- Storage Provider；
- Plugin Manifest、capabilities、permissions、生命周期和版本冻结；
- 恶意、异常和不兼容插件测试。

Gate：插件不能写 Authority、提升权限、重置预算或伪造用户决定；交互式 Runtime 不能持有 `process.spawn` 或回退到后台 Agent CLI。

### W4：参考控制面与 Runtime

目标：完成可执行的通用控制面。

交付：

- CLI、Programmatic API 和可选本地服务；
- Codex Runtime Plugin；
- conversation-visible Host Coordinator、可检查 Lease Receipt 和进度 heartbeat；
- conflict-graph Scheduler；
- capability-based Model Router；
- local workspace Tool Broker；
- shell Gate Executor；
- reference Prompt/Result Codec；
- heartbeat、soft warning、interrupt 和 Transport Receipt；
- current epoch/lifetime 指标。

Gate：合成项目可完成 start、dispatch、record、review、stop、resume 和 hard recovery。

### W5：Workflow Primitives 与通用 Profile

目标：建立两条项目流程都能复用的组合层。

交付：

- Feature Work Graph；
- Dependency/Conflict Wave；
- Batch Barrier；
- Approval Gate；
- Review/Quality Epoch；
- Artifact Pin/Rebase；
- Documentation Closeout；
- Requirement、Delivery、Quality、Batch Profile；
- Project Registry、技术栈 Profile 和 repository attachment。

Gate：合成 Engine Delivery 与 Batch Production 都只通过 Profile/Policy 组合，不新增 Kernel 分支。

### W6：CardWorld Profile 与 Hard Recovery

目标：重组 Engine 流程并恢复 T1/T2 旧事实。

交付：

- CardWorld Project Descriptor；
- Engine Delivery/Quality/Docs Policy；
- 最终旧 Schema 与事件 Characterization；
- Legacy Inventory 和 Importer；
- `verified-current/stale-revalidate/log-only/invalid/superseded` 分类；
- hard-recovery dry-run、摘要确认、幂等 commit 和 rollback；
- 隔离状态副本 shadow/canary。

Gate：旧 Lease 失效、逻辑预算不刷新、全部有效 finding 可解释；用户批准前不恢复真实版本。

### W7：Collection Profile、控制面优化与 Hard Recovery

目标：完成 Collection Harness 的整体优化并恢复 M2/B1 旧事实。

交付：

- Collection Project Descriptor；
- Rule Readiness、Batch Barrier、Round、Game Acceptance、Release Review、User Acceptance 和 Collection Release Policy；
- 去除 B1 硬编码，动态发现 active Batch；
- 用单一 Kernel Authority 替代重复 Round 状态机；
- Feature 级批内依赖、冲突、并发和共享 owner 调度；
- Dispatch V2、唯一 output path、generation 和 Lease；
- workspace snapshot、changed-files、授权路径和内容寻址 Evidence；
- focused/stable/final Gate、成功缓存和环境失败通道；
- Artifact Rebase 影响集与 completed-game 回归；
- P0-P3 全量质量闭环；
- Final Receipt 驱动中文阶段报告；
- M2/B1、Round 0.2/0.4 Inventory、Importer、hard recovery 和 rollback；
- B1-R001 只读 shadow 与合成 B0 Canary。

Gate：单款阻塞不终止其他 eligible Feature；同一逻辑问题不能换 Feature/Round 刷新预算；旧完成状态不直接升级为新证据。

### W8：非 Codex Provider 与系统加固

目标：证明工具、模型和项目真正可替换。

交付：

- 至少一个非 Codex Runtime；
- 至少两种 Model Router 策略；
- Runtime 切换、能力降级和 Provider outage；可见宿主缺失时停止而不降级为 headless；
- Plugin permission/threat model；
- 大型 Feature Graph、缓存、事件和 Evidence 压力测试；
- Windows/Linux、离线安装和跨机器重附着；
- 第三个中性项目 Canary；
- 性能、时间归因和可靠性 SLO。

Gate：同一 Profile 在两个 Runtime 上保持等价 Authority 语义。

### W9：零驻留切换与 V1.0.0 准出

目标：完成整体复核并形成一个正式版本。

交付：

- Kernel、Plugin SDK、Schema、CLI 稳定面；
- 签名发布制品、checksum、SBOM 和安装说明；
- CardWorld 与 Collection 最终 Hard Recovery Receipt；
- 两个业务项目的零驻留候选；
- 旧 Harness 只读归档、删除候选和回滚方案；
- 运维、备份、恢复、升级和故障响应手册；
- 独立 Reviewer 全量审查；
- 用户最终切换审批包。

Gate：W0-W8 所有 Acceptance、P0-P3、Recovery、Conformance、Canary、Docs 和用户决定全部闭合。

## 七、质量收敛政策

V1.0.0 内所有正式 Review/Quality Epoch 统一采用：

```text
Initial full sweep / historical findings
        ↓
P0-P3 complete triage
        ↓
Feature repair waves + focused gates
        ↓
Fresh final full sweep
        ├─ 0 findings → 下一门禁
        └─ 任意 P0-P3 → review-blocked
```

- 不自动延期 P2/P3；
- 不使用 known debt 绕过当前版本问题；
- 最终 full-sweep 后仍有 finding 时，本 Epoch 终止；
- 是否开启新 Epoch 由用户决定；
- Reviewer 数量、实现预算和 Gate 次数必须有限且可解释；
- no-change 不能在相同源码摘要下触发无限重派。

## 八、Hard Recovery 合同

CardWorld 与 Collection 使用不同 Legacy Importer，但共享恢复框架：

```text
read-only discovery
→ legacy inventory
→ hash/reference validation
→ current repository facts
→ hard recovery assessment
→ legacy disposition
→ new epoch/generation
→ shadow projection
→ isolated canary
→ user-approved cutover
```

旧事实只能分类为：

- `verified-current`；
- `stale-revalidate`；
- `log-only`；
- `invalid`；
- `superseded`。

两个 Importer 的解析逻辑互不复用；事实分类、事务、Evidence、Epoch、Receipt 和回滚机制复用。旧 Packet、Lease 和 Agent 身份永远不能进入新 Epoch。

## 九、V1.0.0 整体准出标准

1. W0-W9 全部完成且没有部分版本准出声明；
2. G0 双轨差异审计通过，差异矩阵、行为处置、架构归属和 Golden Scenario 均有有效 Receipt；
3. Kernel 中没有项目、Runtime、工具或模型专名分支；
4. CardWorld 与 Collection 流程均只通过 Profile/Policy/Descriptor 表达；
5. 两条流程都以 Feature 为调度单元，Step 不单独租约或刷新预算；
6. Collection 批内 Feature 图和批间 Barrier 均通过混合进度测试；
7. 当前周期 P0-P3 全部关闭；
8. 所有状态写入原子、幂等、可恢复；
9. stale、迟到、重复、跨 generation 和越权 Result 全部有负向测试；
10. 两个 Legacy Consumer 都完成隔离 Hard Recovery 和 rollback 演练；
11. Codex 与至少一个非 Codex Runtime 通过 Conformance；
12. 三个不同类型项目完成零驻留 Canary；
13. 最终 Receipt、源码、插件、Policy、Artifact、Gate 和用户决定完全一致；
14. 独立 Reviewer 全量审核通过；
15. 用户明确批准 V1.0.0 和后续业务仓切换。

## 十、禁止项

- 不把 Wave 命名为可发布小版本；
- 不跳过 G0，或以仅阅读设计文档代替代码、Schema 和运行事实对比；
- 不把已确认的旧实现缺陷包装成兼容行为；
- 不因某个 Wave 测试通过就宣称 V1.0.0 可用；
- 不把 CardWorld 和 Collection 合并成单一业务状态机；
- 不把批内并行理解为全部游戏或任务无条件并行；
- 不让 Step 成为规避 Feature ownership、冲突或预算的调度单位；
- 不以 P2/P3 known debt 作为当前版本准出通道；
- 不允许插件、Agent 或模型直接写 Authority；
- 不在显式迁移步骤前复制、改写或删除旧 Harness；
- 不在用户批准前启动真实 Legacy Consumer 或清理业务仓内容；
- 不在 V1.0.0 前使用 Harness 自举开发自身。

## 十一、实施与 Gate 状态

| 项目 | 状态 | 交付证据 |
|:---|:---|:---|
| W0 | ✅ | 独立 `.git`、包、CI、无运行时依赖、clean-room |
| G0 | ✅ | `docs/history/audits/g0/` 清单、矩阵、Golden Scenario、Receipt |
| W1 | ✅ | Schema、canonical digest、错误与 Conformance |
| W2 | ✅ | revision/idempotency/atomic journal/Evidence/Recovery/Receipt |
| W3 | ✅ | 八类插件合同、manifest、Host 权限与恶意插件测试 |
| W4 | ✅ | CLI/API、参考 Scheduler/Codec/Router/Broker/Gate/Runtime |
| W5 | ✅ | Workflow Primitive 与三套 Profile |
| W6 | ✅ 候选 | Engine Profile、Importer、CardWorld 现场只读 dry-run |
| W7 | ✅ 候选 | Collection Profile、10 游戏逻辑/隔离物理并发、Importer 与现场只读 dry-run |
| W8 | ✅ | 显式 headless 非 Codex process Runtime、1000 Feature 压测、三类零驻留 Canary |
| W9 制品 | ✅ | checksum manifest、SPDX SBOM、运维/恢复文档、npm dry-run |
| 抽离后 RCV | ✅ | 一致性 staging、完整验证、verification Evidence、Authority Decision、链接拒绝与负向测试完成 |
| 抽离后 PUB-008 | 🧪 待演练 | Card World 发起脱敏缺陷、独立上游修复、制品/Descriptor 升级、原 Run 续跑与 rollback；Collection 回归 Canary |
| W9 真实 cutover | ⏸ 待审批 | 必须指定真实 Run、新 `dataRoot`、回滚点和切换时间 |

当前状态只表示仓库抽离所需的独立性和隔离验证完成，不表示正式发布或旧 Harness Authority 已切换。抽离后修复与验证由[仓库抽离后修复与验证台账](./post-extraction-register.md)继续跟踪；最终部署 Gate 保留，是对高影响状态迁移的权限边界。
