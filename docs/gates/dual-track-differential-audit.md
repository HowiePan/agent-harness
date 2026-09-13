# G0 双轨差异审计 Gate

**所属版本**：V1.0.0  
**位置**：W0 完成之后、W1 启动之前  
**性质**：正式前置 Gate，不是独立版本或迁移步骤  
**状态**：已通过并冻结；审计制品见 [`../audits/g0/`](../audits/g0/)，后续缺陷使用冻结制品与合成复现，不重新读取旧 Harness 源码

> 本文中的“当前实现”均指 2026-09-12 审计时的历史快照，不是持续参考源或运行时依赖。

## 一、目标

在冻结通用协议、Kernel、Workflow Primitive 和项目 Profile 之前，对 CardWorld Engine Harness 与 tabletop-collection Harness 做一次可追溯的差异审计，防止：

- 把某一项目的历史实现误当作公共协议；
- 为追求复用而合并两条不同的业务状态机；
- 把旧 Harness 缺陷当成必须兼容的行为；
- 在抽离时遗漏已经验证有效的恢复、调度、质量或证据语义；
- 只比较文档，没有核对实际代码、状态 Schema 和运行记录。

G0 比较的不是两套目录结构，而是三方能力模型：

1. 当前 CardWorld Engine Harness 的实际实现与有效运行事实；
2. 当前 tabletop-collection Harness 的实际实现与有效运行事实；
3. 独立 Agent Harness V1.0.0 的目标能力与边界。

## 二、输入

G0 只做只读发现、Characterization 和方案判定，不启动、恢复或迁移真实 Run。

最少输入包括：

- 两套 Harness 的入口、协议、状态 Schema、调度器、验证器和恢复逻辑；
- 当前有效的设计文档、操作文档和流程约束；
- 代表性的脱敏或只读运行记录、失败样本和恢复样本；
- 已确认的缺陷、历史兼容分支和淘汰行为；
- V1.0.0 的零驻留、插件化、Feature 调度、全量质量闭环和硬恢复目标。

读取旧运行状态仍受迁移冻结约束；具体清单和允许读取的样本必须在 G0 执行时获得对应权限。

## 三、强制对比维度

| 维度 | 必须回答的问题 |
|:---|:---|
| 生命周期与状态机 | 两条流程有哪些阶段、状态、终态、回退和人工决定？ |
| Authority 与事务 | 谁能写权威状态，如何处理 revision、幂等、崩溃和迟到结果？ |
| 调度与并发 | Feature、Step、Wave、Round、Batch、冲突图和执行槽如何作用？ |
| 权限与所有权 | allowed paths、共享能力 owner、Reviewer 和用户决定如何隔离？ |
| Evidence 与 Gate | 证据绑定什么源码、制品、命令、工具链和质量周期？ |
| 质量闭环 | P0-P3 如何发现、修复、复审、终止和重新开启 Epoch？ |
| Artifact 影响 | Engine Artifact 变化如何失效 Collection 的相关证据？ |
| 阻塞传播 | 单 Feature、单游戏、共享能力和整个批次的阻塞边界是什么？ |
| 恢复与预算 | ordinary resume、hard recovery、generation、Epoch 和 Attempt 如何处理？ |
| 插件依赖 | 哪些行为来自 Codex、模型、工具、Prompt 或存储实现？ |
| 项目驻留 | 哪些路径、状态和入口仍隐式依赖业务仓？ |
| 可观察性与回执 | 当前状态、历史指标和最终报告从哪些事实投影？ |

## 四、差异基线

G0 至少要验证并细化以下已知差异：

| 主题 | CardWorld Engine Harness | tabletop-collection Harness |
|:---|:---|:---|
| 主流程 | Requirement、Development、Quality、Docs、Delivery | Rule Readiness、Batch、Game、Review、Batch Close、Collection Release |
| 调度作用域 | 版本内 Feature Work Graph | Batch 外层 Barrier + 批内 Feature Work Graph |
| 并发目标 | 按依赖和冲突形成实施 Wave | 最多 10 个游戏保持逻辑活跃，物理并发受执行容量和冲突图约束 |
| 共享能力 | 普通跨 Feature 依赖和契约冲突 | 跨游戏能力必须有唯一 Capability Owner Feature |
| 阻塞传播 | Feature、Wave、Quality Epoch | Feature、Game、共享能力、Batch 多级传播；单款阻塞释放执行槽 |
| Artifact | 当前项目源码和发布制品 | 依赖外部 Engine Artifact Identity，并按影响集失效 |
| 验收层级 | Feature、Quality、Docs、用户代码审核、Delivery | Feature、Game Harness、独立 Review、用户 Game/Batch、Collection Release |
| Legacy 来源 | T1/T2 | M2/B1、Round 0.2/0.4 |

该表只是审计起点，不是审计结论。最终结果必须由实际实现和有效事实反向校正。

## 五、行为归属与处置

每个识别出的行为都必须先做处置，再决定架构归属。

### 5.1 行为处置

- `preserve`：已验证有效，V1.0.0 必须保持其语义；
- `adapt`：目标仍有效，但实现或协议需要重构；
- `legacy-only`：仅由对应 Legacy Importer 识别，不进入当前流程；
- `supersede`：由明确的新语义替代，并记录替代关系；
- `reject-defect`：确认是旧实现缺陷，禁止作为兼容行为继承；
- `unresolved`：事实或意图不足，阻断 G0 通过。

### 5.2 架构归属

- `Kernel`：Authority、事务、Lease、Attempt、Evidence、Gate、Recovery、Receipt 等项目无关机制；
- `Workflow Primitive`：Work Graph、Barrier、Approval、Review Epoch、Artifact Pin、Docs Closeout 等可组合原语；
- `Profile/Policy`：CardWorld 或 Collection 的流程顺序、阻塞传播和准出规则；
- `Plugin/Descriptor`：Runtime、Model、Tool、Codec、Storage、技术栈、路径和项目参数；
- `Legacy Importer`：旧 Schema 解析和旧事实映射；
- `Retired`：不进入 V1.0.0。

Kernel 归属必须通过“第三个中性项目是否仍合理需要该能力”的反事实检查。不能通过该检查的行为不得进入 Kernel。

## 六、正式交付物

G0 必须生成并评审以下可追溯制品：

1. `implementation-inventory`：两套实现、文档、Schema 和运行样本清单及摘要；
2. `capability-difference-matrix`：逐能力三方对照、行为处置和架构归属；
3. `state-transition-map`：两条状态机、Authority、阻塞传播和人工决定；
4. `scheduling-concurrency-map`：Feature、Step、Wave、Round、Batch、冲突和槽位语义；
5. `evidence-quality-map`：Evidence、Gate、Artifact、P0-P3 和 Receipt 关系；
6. `legacy-recovery-map`：两套旧事实到 Legacy Importer/新 Epoch 的边界；
7. `rejected-legacy-behaviors`：明确禁止继承的缺陷和历史捷径；
8. `golden-scenarios`：供 W1 Conformance 与后续 Profile 测试使用的行为场景；
9. `open-decisions`：需要用户或 Authority 决定的未决差异；
10. `G0-gate-receipt`：输入摘要、评审结论、未决项和是否允许进入 W1。

每一项结论都必须能追溯到源代码、Schema、文档、运行事实或用户决定；不能只记录口头判断。

## 七、Golden Scenario 最小集合

至少覆盖：

- Engine canonical requirement 形成前不 fan-out；
- Engine Feature 依赖、冲突、Scope Resolution 和 Quality Epoch；
- Collection 同批 10 个游戏保持逻辑活跃；
- Collection 物理执行槽不足时的公平推进和阻塞槽释放；
- 同游戏内冲突 Feature 串行、无冲突 Feature 并行；
- 跨游戏共享能力只有一个 Owner，非依赖游戏继续；
- B1 未关闭时 B2 Feature 不进入 eligible 集合；
- Engine Artifact 变化只失效受影响游戏和 Feature；
- 两条流程当前质量周期 P0-P3 全量闭环；
- stale、迟到、重复、越权和跨 generation 结果被拒绝；
- CardWorld T1/T2 与 Collection M2/B1 分别建立新 Epoch，旧 Lease 和预算不复活。

## 八、通过条件

只有同时满足以下条件，G0 才能签发通过 Receipt：

1. 两套 Harness 的全部已观察有效行为均有来源、处置和唯一架构归属；
2. 所有 `unresolved` 项已解决，或由用户明确决定不纳入 V1.0.0；
3. 已确认缺陷全部进入 `reject-defect` 或 `Retired`，没有被包装为兼容要求；
4. Kernel 候选中不存在 CardWorld、Collection、Game、Batch、Codex、Rust、WASM 或供应商专名语义；
5. CardWorld 与 Collection 保持独立业务状态机，差异不依赖 Kernel 条件分支表达；
6. Feature 调度、P0-P3 全量闭环和硬恢复不变量在两条流程上都有明确映射；
7. Collection 的 10 游戏逻辑并行、共享能力 owner、批次 Barrier 和阻塞释放都有 Golden Scenario；
8. 两套 Legacy Importer 的共享框架与专用解析边界清晰；
9. W1 的 Schema 和 Conformance 输入已由 Golden Scenario 覆盖；
10. 独立 Reviewer 确认差异矩阵和归属没有重大遗漏。

G0 未通过时，W1 不得冻结协议，W2-W9 不得以目标架构已确定为前提推进。后续若发现未纳入基线的重大差异，必须重新打开 G0，评估已冻结协议和测试的影响。

## 九、非目标

G0 不负责：

- 复制、迁移、删除或代理旧 Harness；
- 把旧状态提交为新 Authority；
- 启动或恢复 CardWorld、Collection 的真实 Run；
- 实现 Kernel、插件、Profile 或 Legacy Importer；
- 为了兼容旧目录结构而提前冻结新项目的物理布局。
