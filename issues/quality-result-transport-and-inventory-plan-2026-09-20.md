# V1.0.0 质量结果传输与 Finding 完整性联合修复方案

> 对应 `AH-20260920-D5F65D00699B`、`AH-20260920-A79DB71DEA40`；同时承接 `AH-20260920-AB121AD18464` 的结果契约方案。2026-09-20 审查结论与实施方案。本文不表示问题已修复、真实 Run 已恢复或质量流程已准出。

## 1. 当前结论

**真实 `h:engine quality V3.8.4` 尚未完成一次可信闭环，不能准出。** 两个新问题属于连续阻断链：Host 响应先在 Coordinator 的 JSON 行或请求绑定校验中失败，质量结果无法形成 Authority Submission；即使传输恢复，当前提交路径也没有把已知开放 Finding 清单作为完整性义务，可能接受遗漏问题的评审结果。两项须一起修复和验收，修复一个错误码不能宣布质量流程可用。

截至 `2026-09-20T14:22:38Z`，只读检查 `.agent-harness-data/authority/cardworld-engine/v3.8.4-quality-69b43609437505f3/run.json`：Run 为 `running`、revision 15，唯一 Feature `quality/V3.8.4` 为 `dispatched`，`sourcePolicy=read-only`、`qualityFindingPolicy=repair-and-rereview`；有 4 个 Dispatch，其中 3 个已 superseded、1 个 requested；已有 Lease 为 superseded；**Submission 0、Authority Finding 0、修复 Feature 0、Closure Receipt 0**。另一条 `v3.8.4-quality-e740f05e0d363218` 已 superseded，亦为 Submission 0。故本次未进入修复，不是 `review-only` 选项使然，也不能从对话中“评审已完成”推断 Authority 已接收。

`AH-20260920-A79DB71DEA40` intake 列出 9 个已知项：`R008-FSW-001`～`006` 与 `V384-R06`～`R08`；所述 Agent 结果仅返回两个带后缀的 P2 ID，遗漏 7 项。该清单及结果目前是问题输入和对话证据，尚未通过业务文档快照、原生 Agent 输出和 Authority 逐项核对；不能将这 9 项直接写成已迁入当前 Run 的权威 Finding。

后续只读核对 `F:\CardWorld\docs\versions\v3\v3.8.4.md` 第 1139～1149 行，还发现 `V384-R01`～`R05` 五个 P1 被标为“历史关闭结论；当前未收口”。因此上述 9 项仅是已报告问题的最低集合，G3 前须把这 5 项也纳入候选对账；若与 `R008-FSW-001`～`006` 重合，必须给出逐项证据和显式 alias 映射，不能按名称猜测或直接略去。该业务文档当前 SHA-256 为 `ef8a263eaef894f14534a4e8a132113ceecb3756ca35bea4a0321cae10d07b6a`。

## 2. 源码审查与证据界限

| 层 | 已证实 | 尚未证实 |
| --- | --- | --- |
| Host 传输 | `stdio-host-exchange.mjs` 将 stdin 的下一整行按 JSON 解析，随后要求 `sessionId`、`requestId`、`requestDigest`、`operation`、`tool` 与当前请求逐字段相等；两个报错分别来自这两道校验。 | 缺少故障当时的原始请求/响应帧、Host 调用结果及字段差异记录，不能断言是 PTY 折行、手工转录、旧响应串入或 Coordinator 缺陷中的哪一种。 |
| 结果提交 | `codex-collaboration-host-adapter.mjs` 对 Agent 输出 JSON/Schema 失败已有 `result-rejected-receipt`；但 Host 响应帧在 `exchange()` 失败时尚未进入该分支。当前真实 Run 没有 Submission。 | 该次 Host 失败后的原生 Agent 是否仍可观察、哪次请求失败、是否可安全重附着。 |
| Finding 完整性 | `validateBusinessResult()` 检查结果形状和修复 checkpoint；`Kernel.submit()` 检查新 Finding 的证据与路径，但未比较已知开放项和本轮逐项处置。`state.findings` 当前为空；`hasCurrentCleanQualityReview()` 只看当前源摘要和结果的空 `findings`。 | 9 项在业务文档中的当前状态、规范 ID 与 Agent 所用后缀 ID 的映射、对应代码是否已经独立修复。 |
| 既有 Finding | `Kernel.submit()` 对同 ID 的开放 Authority Finding 按重复项拒绝，仅允许已 resolved 项在复审中 reopen；因此不能直接让评审原样重复返回开放项来满足完整性。 | 需要定义并验证“确认仍开放、证据更新、独立修复后确认关闭、范围外”各处置的权威语义。 |
| 测试与历史准出 | 本次运行 22 个 Host bridge/质量生命周期测试均通过；它们使用合成宿主和预置结果。2026-09-19 的命令级验收也明确使用合成 Runtime 与临时控制数据。 | 同一已安装不可变制品经真实 Codex 原生工具完成评审、修复、复审、Gate、关闭的证据。 |

## 3. 实施顺序

### A. 先固化可复现的失败基线

1. 只读保存当前 active Release/插件/Project Descriptor 摘要、Run ID/revision、Dispatch/Lease/Host Effect 状态。所有诊断文件仅写入独立 Control Root；不修改旧 Harness 或业务仓。
2. 为 Coordinator 的每个 Host 请求和响应增加有限大小、脱敏的诊断 Receipt：请求 ID/摘要、操作、期望绑定、实际字段差异、原始帧摘要、解析阶段、原生任务观察摘要。敏感原文只保留在受控证据存储中；不能靠对话转述定位根因。
3. 在夹具中复现无效 JSON、额外日志/折行、错误请求摘要、跨请求响应、超时后迟到响应、Coordinator 重启。每种情况须证明拒绝准确、无误提交、无重复 spawn、Lease/Host Effect 可恢复或明确 `attention-required`。

### B. 修复 Host 传输与终态协调

1. 由可信 Host bridge 根据**当前待处理请求**自动构造响应 envelope，原样嵌入对应原生 collaboration 工具结果；保持一请求一响应、严格序列、摘要和重放校验。若产品宿主无法提供可靠机器传输，预检须报能力缺失，不能让模型手抄 JSON 后声称可用。
2. 明确区分 Host 协议拒绝、Agent 输出 Schema 拒绝和业务结果失败。Host 协议拒绝不得伪装成 Agent `completed`，应产生绑定请求/Dispatch 的拒绝证据；重新观察原生 Agent 与 Lease 后，由协调器选择安全重试、重附着或 `attention-required`。任何无法确认身份的响应不得提交。
3. 对已完成原生 Agent 的传输失败，确保不会永远保留活动 Lease 或通过 hard recovery 反复发出同一评审；恢复必须遵循既有 expected revision、幂等 command ID、Epoch 和 Host Effect 约束。

### C. 建立 Finding 清单完整性义务

1. 为质量 Plan 定义版本化 `KnownFindingInventory` 输入：来源文档/Authority 引用、目标版本和范围、规范 ID、严重度、开放状态、来源摘要与截取时间。业务文档只是经验证的输入证据，历史状态不得按字符串直接升级为当前 Authority 结论。Plan/Dispatch 固定清单摘要；清单变化需新 Plan 或明确 lineage 处置。
2. 扩展质量结果契约，要求对每个规范 ID 给出明确、证据支持的 disposition：仍开放、已由本轮修复并验证、经新鲜检查不再复现、或经批准的范围判定。后缀别名须有显式映射，不允许模糊字符串匹配。遗漏、重复、未知 ID 或无证据处置返回确定性 `QUALITY_FINDING_INVENTORY_INCOMPLETE` 类错误；不提交“看起来干净”的结果。
3. 修改 Kernel 的原子提交语义：现有开放 Finding 可以被本轮评审确认并更新证据，而不当作重复新 Finding；已解决项复发应 reopen；真正重复结果仍拒绝。关闭开放项须绑定当前源码摘要、独立验证 Evidence 与决策，不能仅凭 Agent 的状态字段。
4. `hasCurrentCleanQualityReview()` 与最终关闭条件同时核对当前源摘要、Plan 固定清单逐项处置、Authority 中全部 P0–P3 Finding、修复 Submission/验证 Receipt 及复审结果。清单缺失或来源漂移必须阻断修复调度或关闭，绝不默认为 0 Finding。

### D. 恢复完整质量循环

1. 仅在评审 Submission 原子提交、Finding 清单对账通过后，由 `repair-and-rereview` 策略生成逐项修复 Feature；每个修复限定路径、要求聚焦检查和宿主保存的验证 Receipt。
2. 全部修复完成后对**修复后源摘要**执行全量只读复审；新问题或复发项继续修复，直到 P0–P3 全部关闭。随后运行带 live observer 的最终 Gate，并产生绑定所有证据的 Closure Receipt。
3. 当前遗留 Run 先按 `RunLineageResolution` 和 Host Effect Journal 做只读评估；不得直接改 `run.json`、手工补 Submission、复用旧对话输出或未经 Gate 启动真实 V3.8.4 Run。

## 4. 验收与准出口径

### 唯一准出目标

对 `h:engine quality V3.8.4 full`，准出是一条**同一不可变制品、同一真实宿主、同一权威 Run 谱系上的完整业务闭环**，须同时证明：

1. 当前业务源码、已知开放 Finding 清单、Release/Extension/Project/Plan 摘要在预检中固定；真实 Codex 可见 Agent 完成只读全量评审，结果经 Host 传输和完整性校验，原子提交为 Authority Submission。
2. 至少 9 项已报告问题逐项有可追溯处置，另对 `V384-R01`～`R05` 五个“当前未收口”P1 建立显式映射或独立处置；新增 P0–P3 不遗漏。开放项生成并执行修复 Feature。每项修复有实际源码差异、聚焦检查、宿主保存的验证 Receipt 与 Authority Finding 状态变化。
3. 修复后在新的源码摘要上再次运行全量只读评审；新问题和复发项继续进入修复，直至当前周期 P0–P3 全部关闭，且没有未处置的清单项。
4. 对最终源码摘要执行全部必需 Gate，保留 live observer 与 Gate Receipt；Run 由 Authority 正常关闭，Closure Receipt 绑定评审、修复、复审、Finding、Gate 和最终源码摘要。全程没有越权写入或孤儿 Lease。
5. 同一制品另有真实宿主传输失败与重启续接演练，证明失败可定位、可恢复且不会重复发车；演练本身不替代第 1～4 项的成功闭环。

以上任一项缺失，结论就是**未准出**，并标出准确停点。单元测试全绿、合成 Run `closed`、短时探针成功、只读评审完成、检查命令通过，均只是进入下一阶段的证据，不能称为质量流程准出。其他 Project/Profile 的质量动作也需分别完成自己的真实闭环，不能借用 Engine 结果。

### 4.1 短反馈梯队：停止用半小时真实 Run 探测接口错误

在 A～C 修复及下列梯队通过前，不再发起新的 V3.8.4 全量质量 Run。每次出现新失败，先保存最小脱敏请求/响应或 Authority 快照，增加能在本地复现的回归用例；该用例由红转绿后才进入下一层。一次真实失败只允许作为**新夹具的来源**，不能靠反复启动真实 Run 猜下一种错误。

| 层级 | 执行内容与时间目标 | 失败时的处理 |
| --- | --- | --- |
| L0，秒级 | Schema、Prompt、结果契约、Host 请求/响应 envelope 的表驱动测试；覆盖两个当前传输错误码和 9 项清单遗漏。现有测试可从 `node --test --test-isolation=none test/codex-visible-host-bridge.test.mjs test/result-contract.test.mjs` 起步，但这些测试目前**没有**覆盖真实故障帧及清单完整性。 | 停在本地测试，修协议或数据映射；不启动 Agent。 |
| L1，分钟级 | 合成可见 Host 完整质量循环、失败注入、重启续接。现有入口为 `node --test --test-isolation=none test/quality-lifecycle-e2e.test.mjs`；新增夹具须使用与 L0 相同的结果契约和 Finding 义务。 | 保存最早失败的 Dispatch/Lease/Submission/Host Effect 摘要，在合成环境修复。 |
| L2，短时真实宿主探针 | 在**独立合成仓**用已安装制品调用真实 Codex 原生 collaboration：先做单次请求/响应与结构化结果探针，再做含 1 个已知 Finding 的最小 review→repair→re-review。探针有明确超时、清理和证据 Receipt；不使用 CardWorld 工作树。 | 立即停止；将原生工具形状、帧摘要及失败码回放到 L0/L1。没有稳定探针就不进入 L3。 |
| L3，真实业务全量 | 仅在 L0～L2 通过、已知 Finding 清单与当前源码摘要绑定，并取得真实业务 Gate 的相应授权后执行。 | 一旦失败，记录唯一首发失败并回到对应短层；不得再以另开 Run 代替定位。 |

每层输出机器可核对的 `pass/fail/blocked`、制品与契约摘要、首个失败码和证据位置。L0/L1 通过只能解除进入 L2 的限制；**只有 L3 的完整 Authority 闭环才支持 V3.8.4 业务准出**。时间目标用于控制反馈成本，超时本身判为阻断，不能被解读为通过。

| Gate | 必须提交的证据 | 结论上限 |
| --- | --- | --- |
| G1 代码回归 | 上述传输故障注入；已知 9 项中故意漏 1 项、错 ID、重复项、无证据处置、来源漂移的拒绝测试；开放 Finding 再确认/已解决复发测试；质量循环合成 E2E；Conformance、clean-room、pack/residue 结果。 | 仅允许进入真实宿主探针；不是准出。 |
| G2 真实宿主 Canary | 同一已安装不可变 V1.0.0 制品，在独立合成仓调用真实 Codex collaboration，种入可核对的开放 Finding 清单，完成 review → Authority Submission → repair dispatch → verified repair → full re-review → final Gates → Closure Receipt；另跑一次传输故障与重启续接。保存 Release/插件/Plan/Prompt/Host 请求/Authority 摘要。 | 仅允许进入真实业务验收；不是 V3.8.4 质量准出。 |
| G3 完整真实业务闭环 | 在用户对准确业务目标另行授权后，核对 V3.8.4 已报告的 9 项以及文档中另 5 个“当前未收口”P1 的来源、规范 ID、状态和显式映射；在同一 Run 谱系上逐项满足本节 1～5 条，提交最终 Authority Closure Receipt 与证据索引。 | 只有全部满足时，才可称 V3.8.4 质量流程准出；不构成发布、切换或删除旧 Harness 的授权。 |

每次报告同时列出**测试通过、合成闭环、真实宿主闭环、真实业务闭环**四种不同证据级别，以及未完成 Gate 和具体阻断码。没有 Closure Receipt 时统一报告“未准出”；不得以 `npm test` 绿、只读审查完成、Agent 口头结果或错误码消失替代。
