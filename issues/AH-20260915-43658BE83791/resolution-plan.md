# AH-20260915-43658BE83791 深度审查与修复方案

## 审查结论

- 建议级别：`P1`。
- 建议分类：`regression / deployed-runtime-skew / execution-boundary-bypass / closure-gate-failure`。
- 建议状态：`accepted`；当前不能标记 resolved。
- 用户的怀疑成立：**问题没有在实际运行链上修好**。`8f95ba8` 与 `5c98cea` 已修复当前源码和已安装 Skill，但 Codex 插件绑定的生命周期入口、活动 Runtime 和活动 Registry generation 仍停留在回归提交 `5eeba78`。实际 `quality` 因而继续按持久化的 action-scoped headless 策略启动 `codex-cli-runtime`。
- 这不是 UI 误判。Authority 中的 `v3.8.4-quality-a24579307d99ff93` 明确记录 `agentExecutionMode=headless`、`runtimePluginId=codex-cli-runtime`，没有 `LifecycleExecutionGrant`，并实际创建了两个无 visibility 的 Codex CLI Lease。
- 当前问题是部署与 Authority 的双轨漂移，不应再归因于“用户授权了 headless”或“可见 Host 暂不可用”。交互式命令缺 Host bridge 时的正确结果是建 Run 前 `attention-required`，不是回退后台 CLI。
- 本 Issue 是 `AH-20260915-3218A00AAEFB` 的直接复发，同时暴露 `AH-20260915-8C001F4D266E` 的关闭 Gate 仍然无效：仓库候选和插件外壳更新不能替代活动 Runtime/Descriptor 切换与真实部署验证。

## 已核验证据

### 1. 真实质量 Run 确实走了后台 CLI

- Run：`.agent-harness-data/authority/cardworld-engine/v3.8.4-quality-a24579307d99ff93/run.json`。
- 创建时间：`2026-09-15T07:27:59.907Z`（北京时间 15:27:59）。
- Runtime policy：`headless / codex-cli-runtime`。
- `metadata.lifecycleExecution` 没有 `executionGrant`。
- 第一个 CLI Lease 于 `2026-09-15T07:28:00.748Z` 启动，后被 supersede。
- 第二个 CLI Lease 于 `2026-09-15T11:27:35.557Z` 启动；Issue 于 `2026-09-15T11:32:07.722Z` 记录，时间线完全吻合。
- 第二个 Lease 的 `visibility=null`，Authority 仍标记 `active`；对应 OS 进程现已不存在，因此还留下了失联 active Lease。

### 2. 插件绑定仍指向回归版本 Runtime

- 已安装插件的 `.plugin-data/bindings.json` 把 entrypoint 固定到：
  `.agent-harness-data/runtimes/1.0.0/e296443b.../bin/agent-harness.mjs`。
- 活动指针 `.agent-harness-data/registry/active-release.json` 同样选择 package digest `e296443b...` 和 generation `g-1c3b330ea33b3b876ed88662`。
- `e296443b...` 与提交 `5eeba78` 的 `release-manifest.json.packageDigest` 完全一致。该提交正是引入 action-scoped headless quality 的回归提交。
- 该 Runtime 不包含当前新增的 `src/execution-authorization.mjs`，其 Schema 仍要求 `actionExecution.*.authorization`，独立 CLI 仍公开并执行 `lifecycle execute` 与 `run execute`。

### 3. 活动 Descriptor 仍保存长期 headless 授权

- 活动 generation 的 `cardworld-engine` Descriptor revision 12 仍包含：
  `quality -> headless -> codex-cli-runtime -> persisted authorization`。
- 活动 generation 还允许 `codex-cli-runtime`，并保留 `approveForMe=true`。
- 与此同时，非活动的 `.agent-harness-data/registry/projects/cardworld-engine.json` revision 9 是 `conversation-visible` 且仅允许 `codex-conversation-runtime`。
- 运行时会通过 active-release pointer 解析 generation root，因此 revision 9 的安全 Descriptor 并不是当前执行 Authority。这里形成了“表面 Registry 安全、活动 generation 仍危险”的双轨状态。

### 4. 最新源码修复没有进入活动执行面

- `8f95ba8` 已新增 command-scoped `LifecycleExecutionGrant`、deny-wins constraints、私有 launch capability，并拆分 visible/headless Extension。
- 当前 `src/cli.mjs` 已在入口处拒绝 standalone `run execute` 和 `lifecycle execute`，返回 `AGENT_CLI_EXECUTION_DISABLED`。
- 当前 `codex-runtime` Extension 只注册 conversation-visible Runtime；CLI Runtime 已移入独立 `codex-headless-runtime` Extension。
- `5c98cea` 的本地发布工作流于 `2026-09-15T11:17:53.815Z` 完成插件重装，包摘要为 `749eccb5...`，但 Receipt 中的绑定 entrypoint 仍是 `e296443b...`。
- 因此 19:17 重装的是新 Skill/Hook 外壳，19:27 真正执行 lifecycle 的仍是旧 Runtime；第二个后台 CLI 正是在“修复并重装完成”之后启动。

### 5. 发布工作流存在可重复的验收漏洞

- `validatePluginBindings()` 只检查 entrypoint 位于 control root、文件存在、data root 和 workspace 合法。
- 它不读取 active-release pointer，不校验 entrypoint 所属 Runtime 的 package digest，也不要求其与当前 Release Candidate/源提交一致。
- 插件安装验证只校验同版本 `1.0.0`、启用状态和本地 source path；同版本缓存更新成功会掩盖实际绑定 Runtime 仍旧。
- `test/plugin-release-workflow.test.mjs` 的正向 fixture 只给一个“存在的 entrypoint”，没有“新插件 + 旧 Runtime”“安全 mutable Registry + 危险 active generation”等拒绝用例。
- 这解释了为什么 check、测试、clean-room、pack 和插件重装都可以全绿，而真实质量 Run 仍使用旧后台 CLI。

## 用户记得的“三类”执行边界

当前目标契约确实应区分三类职责，而不是把“子进程”一概而论：

| 类别 | 用途 | 合法执行面 | 核心约束 |
| --- | --- | --- | --- |
| 交互式 Agent 推理 | 普通 Codex 会话内的 review、repair、re-review | `conversation-visible` 可见子 Agent | 宿主原生 spawn/inspect/wait/result；无 `process.spawn`；可检查引用、attestation、heartbeat；缺能力即 fail closed |
| 显式无人值守 Agent 推理 | 用户原始请求明确要求 CI/unattended 的 Agent 工作 | `headless` Agent Runtime | Descriptor allow-policy、可信 deny-wins constraints、command-scoped Host Grant 三者同时成立；不得由普通交互命令或泛化“授权”推导 |
| 确定性进程 | Gate、build、test、pack、短 Harness 控制命令 | 受管进程/CLI | 不能承载 Agent 推理；启动前必须有 live observer；输出、完成和中断均可见 |

本次回归把第一类误切到了第二类；修复时又把“源码/插件更新”和“活动 Runtime/Authority 切换”混成一次成功发布，导致错误执行面继续存活。第三类确定性 Gate 仍可使用 CLI，但不能据此为后台 Agent CLI 开口子。

## 根因模型

1. **直接根因：活动 Runtime 未升级。** 插件绑定和 active-release pointer 都继续指向 `5eeba78 / e296443b...`。
2. **策略根因：活动 generation 未迁移。** 当前执行 Descriptor 仍把 quality 固定为长期 headless，并持久化旧 authorization。
3. **发布根因：插件发布和 Harness Runtime activation 解耦但未做一致性 Gate。** 发布工作流允许新插件绑定旧 Runtime，并将结果报告为 completed。
4. **验证根因：验收只证明候选包自洽，没有验证安装后真实命令解析到哪组 Runtime/Descriptor。** 缺少 deployment-skew 负向矩阵和从已安装 entrypoint 发起的安全 Canary。
5. **关闭根因：代码修复被当成实际问题关闭。** `AH-20260915-3218A00AAEFB` 已明确保留 activation/Host Canary Gate，但后续插件重装并未满足 Runtime activation，实际运行仍被放行。
6. **运行态后果：旧 Run 留下不可信 lineage。** `a245...` 的 active Lease 已失联，其结果、Lease、Dispatch 和后续 resume 均不能升级为当前修复后的可信状态。

## 修复方案

### G0：立即冻结错误路径

1. 在修复部署前，不再对 Engine 执行 `h:engine quality ...`、standalone `lifecycle execute` 或 `run execute`。
2. `v3.8.4-quality-a24579307d99ff93` 保持只读；不 resume、不 reattach、不把其后台 CLI 输出升级为新权威证据。
3. 不直接编辑 active-release、generation、Descriptor 或 Run JSON；所有切换必须走新的 release activation/Registry Authority 命令。
4. 本 Gate 不授权终止、supersede、归档或删除任何历史 Run，也不授权修改 CardWorld。

### W1：补发布一致性 Fail-closed Gate

1. 扩展 `validatePluginBindings()`：读取 data root 的 active-release pointer、实际 runtime entrypoint 和 runtime `release-manifest.json`，绑定 `generationId`、pointer digest、runtime package digest。
2. 在插件 remove/add 之前强制：绑定 Runtime package digest = 活动 Release digest = 当前不可变 Candidate package digest；任一不等返回稳定错误 `LOCAL_RELEASE_ACTIVE_RUNTIME_STALE`，不得报告插件发布完成。
3. 绑定文件增加 `activeReleasePointerDigest`、`generationId`、`runtimePackageDigest`；Hook 每次解析命令时复验，防止安装后 pointer 被更换而插件继续静默运行。
4. 发布工作流不得自动越权 activation。若 Candidate 未激活，应返回 `activation-required` 和精确 Activation Plan，而不是继续重装插件。
5. 插件 verify 必须校验已安装 cache 内绑定摘要和 Skill/Hook 制品摘要，不只校验版本号与 source path。

### W2：构建新的不可变修复候选

1. 在 W1 完成后生成新的干净 commit 与 Release Candidate；不能直接沿用 `5c98cea / 749eccb5...` 作为最终候选，因为它仍缺发布一致性 Gate。
2. RC 必须包含 `8f95ba8` 后的执行授权修复、`5c98cea` 后的中断/lineage 修复，以及 W1 的部署一致性修复。
3. 在源码与真实 tarball 中重复验证 standalone Agent execute 入口返回 `AGENT_CLI_EXECUTION_DISABLED`，且无进程启动。

### W3：原子迁移活动 Runtime 与 Descriptor

1. 由新 Runtime 生成 release activation plan，绑定新 RC Receipt、archive/package digest、Runtime root 和新的 Registry generation。
2. 新活动 Engine Descriptor 必须：
   - 默认 `conversation-visible / codex-conversation-runtime`；
   - 删除 `actionExecution.quality` 的 headless override 与全部 persisted authorization；
   - 删除 `codex-cli-runtime` allowlist、runtime config 和 `approveForMe`；
   - 只绑定 visible `codex-runtime` Extension；不安装 `codex-headless-runtime`。
3. Apply 后原子切换 active-release pointer；不得只更新 mutable Registry，也不得只复制 Runtime 而保留旧 generation。
4. 切换后重新生成插件 binding，使 entrypoint 精确指向新内容寻址 Runtime，再按 V1.0.0 约束 remove/add 同版本插件。
5. 这是实际控制根切换，需要用户在实施阶段对精确 Activation Plan 单独批准；本审查不构成该批准。

### W4：隔离旧 Run lineage

1. 对 `a245...` 生成只读 legacy/unauthorized assessment：记录旧 Runtime digest、无 grant、后台 Lease、失联进程和当前 active Lease 状态。
2. 新 Core 必须拒绝把该 Run作为 ordinary resume/reattach 候选；旧 Dispatch、Lease、Submission、Gate 和 Evidence 只作审计输入。
3. 首次新 Canary 只能创建或选择绑定新 Plan/Runtime/Descriptor/constraint digest 的 lineage。
4. supersede、归档、恢复或删除 `a245...` 及其他历史 Run，必须由用户对准确目标另行授权；安全激活本身不隐含处置授权。

### W5：补部署与执行回归矩阵

至少增加以下拒绝测试，并要求 `spawnProcessCallCount=0`：

1. 新插件 + 旧 Runtime entrypoint：插件发布失败。
2. 新 Runtime + 旧 active generation：Preflight 失败，Run 未创建。
3. 安全 mutable Registry + 危险 active generation：按 active generation 识别并拒绝，不能误报安全。
4. 活动 Descriptor 含 `actionExecution.*.authorization`：新 Runtime 在 Plan/Registry 加载阶段拒绝。
5. 普通交互式 quality：Plan 只能选择 visible Runtime；不能生成或接受 headless Grant。
6. visible Host 缺失：一次返回 `attention-required`，Run/Dispatch/Lease/Agent 进程均为零。
7. 已安装 entrypoint 的 `run execute` 与 `lifecycle execute`：均返回 `AGENT_CLI_EXECUTION_DISABLED`。
8. 同版本插件重装后：cache binding digest、active pointer digest、Runtime package digest 和 RC digest 完全一致。
9. 旧无 grant Run 的 resume/schedule/spawn：全部拒绝。
10. Gate/build/test/pack 仍可在 live observer 下运行，证明第三类确定性进程没有被误禁。

### W6：分层 Canary 与关闭

1. **部署安全 Canary**：从已安装插件解析 `h:engine quality V3.8.4`，验证活动 Plan 为 visible；若 Host bridge 缺失，应在 Run 创建前 attention-required，且 `.agent-harness-data/runtime/codex-cli`、Authority 和 outputs 不新增内容。
2. **合成 visible Canary**：新不可变 Runtime 完成 visible Agent 的 spawn/inspect/attest/heartbeat/result/repair/re-review/Gate/close。
3. **真实 Desktop Host Canary**：只有 Codex 产品宿主能向 Harness 注入可信 Host adapter 后，才在独立合成项目运行真实可见子 Agent。
4. **真实 CardWorld Canary**：前述 Gate 全过并由用户另行批准后，才允许唯一新的 Engine quality Run。
5. “不再启动后台 CLI”的安全缺陷可以在部署安全 Canary 通过后关闭；“质量链可用”仍必须等待真实 Desktop Host Canary，不能用 attention-required、合成 adapter 或 headless 替代。

## 关闭 Gate

本 Issue 只有满足以下证据后才可关闭：

1. 新 commit/RC 包含执行授权、CLI 禁用、Extension 拆分和发布一致性 Gate。
2. active-release pointer、活动 generation、Runtime release manifest、Extension/Project digest、插件 binding 和安装 cache 全部绑定同一不可变候选。
3. 活动 Engine Descriptor 不含 headless quality override、persisted authorization、CLI Runtime allowlist 或 `approveForMe`。
4. 已安装 entrypoint 的所有 Agent CLI 执行入口 fail closed；普通交互 quality 无 Host 时不建 Run，后台进程调用数为零。
5. deployment-skew 负向矩阵、全量测试、Conformance、clean-room、pack、residue 和安装后握手全部通过。
6. `a245...` 被明确隔离，未被 resume/reattach，且未未经授权 supersede、归档或删除。
7. 关闭报告分别说明“后台 CLI 安全边界已修复”和“真实 visible Host 是否 operationally ready”，不得把两者合并成一个绿色结论。

## 本轮边界

本轮只读取 Issue、Git 历史、已安装插件 binding、活动 Release/Registry、Authority Run 和 OS 进程状态；未启动或恢复任何 Run，未运行 CardWorld Gate，未修改 CardWorld，未改写 Authority/Registry/Release，未终止进程，未处置历史 Run，也未修改冻结的 Legacy Harness 路径。新增内容仅为本审查方案。
