# Agent Harness 目标架构

**状态**：V1.0.0 已实现架构；真实 Consumer cutover 尚未执行  
**约束**：公共 Kernel 与项目差异边界已冻结；迁移仍需单独批准

## 一、系统定位

Agent Harness 是业务项目之外的控制面。它不实现业务功能，也不把某个 Agent 工具、模型、语言、构建系统或代码仓库视为固定前提。

```text
User / API / CLI / MCP
          │
          ▼
Application Service
          │
   ┌──────┴──────────────────────────────┐
   ▼                                     ▼
Harness Kernel                    Project Registry
   │                                     │
   ├─ Authority / Transaction            ├─ Project Descriptor
   ├─ Run / Stage / Work Graph            ├─ Profile Composition
   ├─ Dispatch / Lease / Attempt          ├─ Gate Recipes
   ├─ Submission / Evidence               └─ Approval Policy
   ├─ Recovery / Migration
   └─ Receipt / Projection
          │
          ▼
Plugin Host
   ├─ Scheduler Strategy
   ├─ Agent Runtime
   ├─ Model Router
   ├─ Tool Broker
   ├─ Prompt / Result Codec
   ├─ Gate Executor
   ├─ Artifact Provider
   └─ Storage Provider
          │
          ▼
Business Repository / CI / Artifact Store / Agent Provider
```

## 二、零驻留模式

默认模式下，业务仓只包含业务源码、测试和产品文档。Project Registry 与 State Root 位于独立 Standalone Control Root 内、业务仓之外；不可变 Runtime 可以是源码 checkout 或该控制根内安装的包。Harness 控制的任何状态、调试、打包或临时写入都不得越过控制根。

```text
<agent-harness-data>/
├─ registry/extensions.json
├─ registry/projects/<project-id>.json
├─ authority/<project-id>/<run-id>/
├─ evidence/<project-id>/
├─ receipts/<project-id>/
├─ recovery/<project-id>/
└─ cache/
```

业务仓的绝对路径只是一次 Workspace Attachment。稳定项目身份至少由项目 ID、仓库 remote、可选 root selector 和用户批准的注册记录组成。

允许提供可选的项目内薄入口，但它不是默认要求，也不能成为 Authority。

## 三、Kernel 权威对象

Kernel 只认识通用对象：

| 对象 | 职责 |
|:---|:---|
| ProjectAttachment | 把一次本地或远程工作区绑定到稳定项目身份 |
| Run | 一次流程实例及其 generation、epoch 和协议版本 |
| Stage | 阶段、依赖、角色和处置状态 |
| WorkItem | 最小调度单元、授权范围和验收条件 |
| Dispatch | Kernel 批准的执行请求和唯一输出位置 |
| Lease | Runtime 回执、真实执行者、心跳和生命周期 |
| Attempt | 按稳定 logical root 累计的失败与预算 |
| Submission | 原始结果、规范化业务结果和提交身份 |
| Evidence | 内容寻址证据、来源、保留策略和有效范围 |
| Gate | 确定性检查、执行环境、缓存键和结果 |
| Finding | 问题来源、严重级别、处置和后继关系 |
| Decision | 用户或外部 Authority 的结构化决定 |
| Receipt | 不可变阶段或终态回执 |

所有 Project/Profile 对外状态都是这些对象的投影，不能形成第二套权威生命周期。

## 四、插件边界

### Scheduler Strategy

读取只读调度快照，返回工作优先级、候选并发和 Runtime 偏好。Kernel 重新校验依赖、冲突、授权和预算后才创建 Dispatch。

### Agent Runtime

负责 `spawn/wait/send/heartbeat/interrupt`。Runtime 不得写 Authority 或宣告阶段准出。Project Descriptor 必须显式选择以下模式：

- `conversation-visible`：交互式默认。Runtime 同时声明 `user-visible` 与 `host-orchestrated`、使用宿主原生子 Agent/委派界面、返回可检查任务引用，并且不得申请 `process.spawn`。可信宿主证明必须绑定 Agent、Dispatch 与 Packet，提交前要求新鲜 heartbeat。缺少任一能力时 fail closed，不允许回退到 CLI 或隐藏进程。
- `headless`：仅供用户请求和 Descriptor 双重明确选择的 CI、无人值守或兼容执行，不能按 Runtime ID 自动推断。Runtime 声明 `headless`；若启动进程，还必须满足受管输出与 OS sandbox 合同。

Codex、HTTP Agent、Local Model 和 Human Worker 都可以实现同一 Runtime 接口，但“对话可见”是可验证能力，不是供应商名称推断。交互式 Harness 的 Host Coordinator 负责把 Dispatch 投影为可见子 Agent、持续发布状态并记录 heartbeat；阻塞式 Coordinator 不得接管 `host-orchestrated` Runtime。

### Model Router

根据角色、能力、风险、上下文和预算返回模型选择。Work Item 使用能力标签，不写死供应商模型名。

### Tool Broker

把 `workspace.read`、`code.edit`、`shell.test`、`browser.read` 等通用能力映射到具体工具，并返回可验证 Tool Receipt。

### Prompt / Result Codec

把通用 Business Packet 转换为供应商格式，再把供应商输出规范化为业务 Result。身份、Packet hash、changed files 和 Evidence 由 Kernel 补齐。

### Gate Executor

执行构建、测试、审计和发布合同等确定性检查。AI Runtime 与 Gate Executor 是不同信任域。Gate 可以启动受管进程，但启动前必须存在实时观察器，并投影 started、output/progress、finished/interrupted 状态；缺少观察器时拒绝启动，且不得在 Gate 进程中执行 Agent 推理。

### Storage Provider

提供 expected revision、原子写入、事务、锁、内容寻址和恢复。首个正式实现为本地文件存储；其他后端以后按同一合同接入。

## 五、Profile 与 Project Descriptor

Profile 是可复用业务流程组合，例如：

- Requirement Review；
- Single Agent Delivery；
- Multi-agent Development；
- Quality Convergence；
- Batch Production；
- Artifact Upgrade；
- Documentation Closeout。

Project Descriptor 只组合 Profile、技术栈 Gate、受保护路径、Artifact Provider 和审批策略。若一个项目需要专用代码，必须先证明现有 Policy Primitive 无法表达，并把插件安装在 Standalone Control Root 而非业务仓。

Descriptor 分为两个合同：配置输入只包含业务工作区、Profile、Policy、Gate 和精确 Harness/Extension 身份；Registry 记录再增加 protocol、revision、commands、更新时间与内容摘要。二者使用不同 Schema，禁止把持久字段回灌到配置输入或覆盖 Registry 管理的协议字段。

## 六、可靠性不变量

1. Agent、模型、Prompt、聊天记录和插件内部状态都不是 Authority。
2. 插件只返回 Intent、Event 或 Receipt；Kernel 校验后提交。
3. 每次写入携带 expected revision 和 command ID；重复调用幂等。
4. Authority 最后提交；中途失败可从事务记录恢复。
5. Dispatch 只接受唯一受管输出路径，调用者不能覆盖。
6. ordinary resume 提升 generation 并废止旧 Transport。
7. hard recovery 建立新 Epoch，旧完成结论不会自动继承。
8. source、policy、plugin set、artifact 和 toolchain 摘要发生漂移时旧证据按影响集失效。
9. 失败预算按稳定 logical root 累计，不能通过改 ID 或恢复刷新。
10. 最终自然语言报告只能从不可变 Receipt 渲染。
11. 交互式 Agent 执行必须绑定可见任务引用；缺失可见宿主能力时停止，不得切换为进程 Runtime。

## 七、Gate 模型

```text
Focused Gate        每个 Work Item 的最小相关验证
      ↓
Stable/Wave Gate    同一源码摘要的一次共享验证
      ↓
Fresh Final Gate    最后源码状态的完整验证
      ↓
Review / Decision / Closure
```

缓存只保存成功结果，并绑定源码、命令、工作目录、工具链、锁文件、环境、插件和 Gate 规格。环境失败与产品失败必须分流。

## 八、恢复与旧系统兼容

旧系统通过 Legacy Importer 接入，而不是进入 Kernel 条件分支：

- CardWorld T1/T2 Importer；
- Collection M2/B1 Importer。

Importer 先生成只读 Inventory 和 Migration Report。旧事实分类为 `verified-current`、`stale-revalidate`、`log-only`、`invalid` 或 `superseded`，再由 Hard Recovery 建立新 Epoch。迁移支持摘要确认、重复提交幂等和回滚。

## 九、信任边界

- Scheduler 不能越过 Kernel 创建 Lease。
- Runtime 不能选择额外路径或修改 Work Graph。
- Model 不能声明自己的真实身份和权限。
- Tool Broker 不能把工具成功等价为业务完成。
- Gate Executor 不能替用户批准。
- Project Registry 的高影响变更需要显式 Authority Decision。
- Extension 安装、升级和移除是可信控制面代码变更，必须使用 expected revision、幂等 command ID 和显式 Authority Decision；完整制品清单在 import 前验证。
- 所有受管写路径同时校验词法路径和真实路径，拒绝 symlink/junction 穿越。
- Legacy Importer 永远不能把旧状态字符串直接升级为当前结论。

## 十、G0 双轨差异审计 Gate

> 冻结声明：本节记录 V1.0.0 建模前已经完成的历史审计。其输入摘要和处置结果已经冻结为本仓库制品；后续实现、测试与 Skill 不重新读取旧 Harness 源码。只有真实 cutover 才允许把现场状态作为一次性只读迁移输入。

V1.0.0 在 W0 建立独立项目边界后、W1 冻结通用协议前，必须通过正式的 G0 双轨差异审计。审计同时对照：

1. CardWorld Engine Harness 的实际实现与有效事实；
2. tabletop-collection Harness 的实际实现与有效事实；
3. Agent Harness V1.0.0 的目标能力模型。

G0 必须核对代码、Schema、文档和代表性运行事实，不能只比较设计文档。每个行为先标记为 `preserve`、`adapt`、`legacy-only`、`supersede`、`reject-defect` 或 `unresolved`，再唯一归入 Kernel、Workflow Primitive、Profile/Policy、Plugin/Descriptor、Legacy Importer 或 Retired。

G0 输出差异矩阵、状态迁移图、调度并发图、Evidence/Quality 图、Legacy Recovery 图、拒绝继承清单和 Golden Scenario。未解决差异、无来源结论或无法归属的行为都会阻断 W1。后续发现问题时只能基于冻结制品、公共协议和合成复现评估；不得把旧源码重新升级为规范来源。

详细合同见 [G0 双轨差异审计 Gate](gates/dual-track-differential-audit.md)。

## 十一、公共内核与差异流程

CardWorld Engine Harness 与 tabletop-collection Harness 不是同一条业务流水线，也不应被强行合并成万能状态机。两者只复用可靠性机制和流程原语，再由不同 Profile/Policy 组合出各自状态图。

### 11.1 CardWorld Engine Delivery Profile

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

主要政策：

- 多来源需求先单线归并，形成 canonical requirement 前不 fan-out；
- Feature 是 Agent 调度单元，Feature 内步骤由同一执行者连续完成；
- 依赖、路径、符号、契约和生成物冲突决定 Wave 并发；
- Scope drift 通过独立处置流程处理；
- Engine Quality Policy 要求当前 Epoch 的 P0-P3 全部闭环；
- Docs Agent 与最终用户代码审核是独立门禁；
- Rust、WASM 和发布合同由技术栈 Gate Recipe 提供，不属于 Kernel。

### 11.2 Collection Batch Production Profile

```text
Rule Readiness
  → Batch Launch Decision
  → Game/Scenario Work Graph
  → Round Dispatch
  → Shared Capability Ownership
  → Game Harness Acceptance
  → Independent Release Review
  → User Game/Batch Acceptance
  → Batch Close
  → Collection Release Receipt
```

主要政策：

- Rule Readiness 是 Harness 前置 Authority，规则不完整时禁止实现；
- 批间以显式关闭和用户发车形成 Barrier；批内不是默认全并行，而是按 Feature 图调度；
- Feature 是 Agent 调度单元，可以承载 Game、Scenario、Shared Capability、Review、Docs 或 Artifact Rebase 工作；
- Feature 内 Step 默认由同一 Agent 串行完成；只有某个 Step 明确解锁跨 Feature 并发时，才将其提升为独立 Feature；
- Feature 之间根据 dependsOn、allowed paths、symbols、contracts、generated outputs、shared capability 和 artifact impact 决定并行 Wave；
- 单款阻塞释放执行槽，不扩大为整批阻塞；
- Engine Artifact Identity 是外部依赖，变化时按影响集失效旧证据；
- Harness Acceptance、Reviewer approval 和 User acceptance 是三个不同权限层；
- Collection Review Policy 与 Engine 一致要求当前质量周期 P0-P3 全部关闭；known debt 只保留历史和审计用途，不能作为准出延期通道；
- Batch Close 和 Collection Release 使用项目专属闭合条件，不进入 Kernel 硬编码。

### 11.3 两条流程复用什么

| 层级 | 复用内容 | 不复用内容 |
|:---|:---|:---|
| Kernel | Authority、事务、状态迁移、Feature Work Graph、Lease、Attempt、Submission、Evidence、Recovery、Receipt | 需求阶段名、批次状态、项目闭合条件 |
| Plugin Host | Runtime、Model Router、Tool Broker、Gate Executor、Storage | 项目审批和业务完成定义 |
| Workflow Primitives | Work Graph、Barrier、Approval Gate、Artifact Pin、Review Epoch、Docs Closeout | 固定流程顺序和项目专名 |
| Profile | 通用的 Requirement、Delivery、Quality、Batch 组合能力 | 具体版本、游戏名单和命令 |
| Project Descriptor | 技术栈、路径、Artifact、Profile 和 Policy 参数 | Kernel 实现 |
| Legacy Importer | 通用迁移框架、事实分类和新 Epoch 建立 | 两套旧磁盘 Schema 的解析细节 |

复用的单位不是整条流程，而是可靠性 Kernel、插件合同和可组合流程原语。Profile 只返回合法 Transition Intent，由 Kernel 提交；CardWorld 和 Collection 不会直接读取或修改对方状态。

### 11.4 Runtime 与流程正交

Profile 不选择具体 Agent 工具。相同的 CardWorld 或 Collection Profile 可以使用 Codex Runtime，也可以在 Project Policy 允许时切换为其他 Runtime/Model Plugin。更换工具和模型不改变 Work Graph、审批、Evidence 或 Recovery 语义。

### 11.5 统一 Feature 调度模型

两条流程都使用同一个 Feature Work Graph：

```text
Feature
├─ id / kind / ownerRole
├─ acceptance
├─ steps[]                 # 同一 Agent 内顺序检查点
├─ dependsOn[]
├─ allowedPaths / forbiddenPaths
├─ symbols / contracts / generatedOutputs
├─ artifactInputs / artifactOutputs
├─ conflictKeys[]
└─ gatePlan
```

Scheduler 只在 Feature 之间建立并行 Wave。Step 不单独领取 Lease，也不能用拆 Step 的方式刷新 Attempt Budget。若 Step 完成后会解锁其他独立工作，规划阶段必须把该 Step 提升为 Feature，并明确依赖和验收。

Collection 的 Batch Barrier 位于 Feature Graph 外层：当前批次未关闭时，下一批 Feature 不进入 eligible 集合；当前批次内部仍按 Feature 图进行并行、串行、阻塞释放和重新调度。

## 十二、物理独立性

V1.0.0 W1 开始前，本项目必须具备独立仓库、独立 SemVer、独立发布制品和独立状态根。CardWorld 和 Collection 只能消费正式版本或带 checksum 的本地发布包，禁止父目录源码、workspace、symlink 或隐式环境耦合。
