# 本地源码调试模式

`source-link` 让项目直接使用当前 Agent Harness checkout，无需每次打包、卸载、重装。从项目 checkout 主动运行 `dev` 命令或发送 `h:local` 命令即授权本地源码绑定及 H0–H3 同步；应用层根据这次调用生成绑定具体计划和命令的 Authority Decision，无需人工另行签发。从 Harness checkout 指向项目执行相同写入时仍需外部 Decision。路径、Gate、宿主证明和运行期保护操作继续按原合同检查。完整字段和命令见[配置 API](../reference/configuration-api.md#8-本地源码调试与热更新)。

项目工作区必须已有可解析的 `.git` 元数据。`dev execute` 在写入 Registry 前检查工作区身份；没有 `.git` 时返回 `WORKSPACE_GIT_METADATA_REQUIRED`。

## 建立绑定

在业务项目目录执行：

```text
node <Harness源码根>/bin/agent-harness.mjs dev execute \
  --config ./harness.json \
  --project-root . \
  --binding-id <项目别名>
```

命令检查当前目录是项目 checkout，生成 `development-source-manifest`，分别固定 Runtime 文件摘要与文档/测试支持文件摘要，在 Harness 控制根保存 Runtime generation 快照，注册 source-link Extension 和 Project Descriptor，并返回 Init Receipt。若从 Harness 侧代项目执行，显式传 `--decision <文件>`。本机源码绝对路径只存在控制根，不写入项目配置。

## 只读计划与动作预检

完成绑定后，用同一个 manifest 读取 source-link Extension，并固定当前源码身份：

```text
agent-harness workflow list --project <project-id> --development-manifest <manifest.json>
agent-harness lifecycle plan --input <request.json> --development-manifest <manifest.json>
agent-harness lifecycle preflight --plan <plan.json> --development-manifest <manifest.json>
```

`--development-manifest` 仅用于只读检查、计划和预检；控制根、数据根和源码摘要必须与 manifest 一致。预检会单独验证当前动作所需的可见宿主能力。缺少可信 Host Adapter 时，返回 `executionReady=false` 和 `VISIBLE_AGENT_HOST_COORDINATOR_UNAVAILABLE`，不会创建 Run。独立 CLI 不能用此参数启动 Agent；实际执行仍需满足 Operator Contract 的可信宿主回调。
预检默认会在独立控制根内做原子写入探针；需要纯只读诊断时可加 `--no-write-probe`，但这样的报告不能用于启动 Run。

本地调试的源码绑定、计划和合成闭环可以独立验收；真实 Codex 插件安装另行验收。原生 Agent 的 Host 回执属于本地执行准出条件，不能因跳过打包而省略。合成闭环不构成真实业务质量准出。

## Codex 本地源码执行入口

`source-link` 的计划命令不注入 Host Adapter。真实 Codex Agent 执行由当前任务直接运行源码 Coordinator；项目 Hook 的命令前缀是 `h:local`，与安装态 `h:<别名>` 区分。开发态 Host 交换从当前 Codex session 的宿主 rollout 中读取原生 `function_call` 和 `function_call_output`，按 session、工作目录、工具名、参数摘要、调用 ID 与 Turn ID 绑定请求和结果。该路径不依赖项目 Hook 投递。rollout 与 `state_5.sqlite` 属于 Codex 当前宿主的内部格式；格式变更时交换层应拒绝执行，重新验证适配器后才能继续。

先用 `dev execute` 的 `hostBinding` 回执和 development manifest 配置本地绑定。以下路径全部是绝对路径；`--plugin-root` 仅是控制根内的本地绑定目录，不是插件安装目录：

```text
node <Harness源码根>/integrations/codex/agent-harness-codex/scripts/configure-bindings.mjs \
  --plugin-root <Harness数据根>/development/local-codex \
  --control-root <Harness源码根> \
  --entrypoint bin/agent-harness.mjs \
  --data-root <Harness数据根> \
  --development-manifest <development-manifest.json> \
  --project '<alias>|<projectId>|<profileId>|<extensionId>|<项目绝对根>' \
  --workflow '<alias>|<workflowId>|<version>|<artifactDigest>|<profileId>|<extensionId>'

node <Harness源码根>/integrations/codex/agent-harness-codex/scripts/local-source-host-probe.mjs \
  --bindings-dir <Harness数据根>/development/local-codex/.plugin-data
```

短探针发出一次 `codex-visible-host-request`，由当前 Codex 任务调用其中指定的原生 `collaboration.list_agents`。Coordinator 自动读取宿主 rollout 中匹配的调用和输出，写入带摘要的 Host Receipt，探针返回 `ok: true` 才算通过。不要手写 Host response，也不要把终端输出转录成回执。短探针不创建 Run。

开发 Harness 本身时，可复用已经登记的 Harness 桌面项目做只读短探针，并在独立合成项目上验证生命周期。Harness 根任务不启动 Harness 对自身的 Run。业务项目只需保持已审核的 Project Descriptor 与源码绑定；不必为本地源码执行复制 Harness 文件到业务仓。

探针通过后，用明确的别名、动作和目标生成当前 session 的执行意图：

```text
node <Harness源码根>/integrations/codex/agent-harness-codex/scripts/local-source-lifecycle-intent.mjs \
  --bindings-dir <Harness数据根>/development/local-codex/.plugin-data \
  --alias <项目别名> --action quality --target <版本> [--preset repair-known]
```

入口核验绑定、Git 工作区身份、Workflow 与当前源码摘要，返回 `coordinatorEntrypoint` 和 `coordinationIntent`。在同一 Codex 任务中先调用 `node <coordinatorEntrypoint> --intent <coordinationIntent> --preflight-only` 可执行完整计划和动作预检，不创建 Run；需要按终端请求调用原生 collaboration 工具。确认预检通过并决定启动后，再用新生成的意图调用 `node <coordinatorEntrypoint> --intent <coordinationIntent>` 一次，保持终端可观察，并依次执行 Coordinator 发出的原生 collaboration 请求。流程切换、复审和恢复通过当前 Coordinator 与 Run Authority 推进，不重复发送 `h:...` 或再次启动生命周期 Coordinator。`spawn_agent` 的 `message` 必须逐字使用请求中的完整生成 Prompt；不要缩写或用路径引用代替。仅在动作预检返回 `executionReady: true` 后 Coordinator 才创建 Run。审查发现问题时，按配置的复审预算处理修复、复审和 Gate，直到 `closed` 或明确的 `attention-required`。

也可以在业务项目的 `.codex/hooks.json` 中配置由 `local-source-hook.mjs --print-config <绑定目录>` 生成的 `UserPromptSubmit` Hook。项目 Hook 只保存指向 Harness 源码和外部数据根的命令，项目仓库不保存 Harness 实现或运行状态。经 Codex 审核并信任该项目 Hook 后，在绑定的项目任务中发送 `h:local engine quality V3.8.4`。Hook 校验到 source-link 源码或绑定摘要过期时，只在进程实际工作目录与已绑定项目 checkout 一致的情况下自动执行 `dev sync`，重新验证绑定后继续解析原命令；H4 或同步失败时返回 Codex `decision:block`，不生成执行意图。已识别的本地质量命令若无法生成可信 Coordinator 意图，也会被阻断，不得用手动构建命令代替。`h:local where engine` 平时只读，但绑定过期时也会触发这次同步。安装态 Hook 忽略 `h:local`，本地 Hook 忽略安装态的 `h:engine`，安装态命令不自动同步。源码模式的原生工具回执由当前 Codex session rollout 核验，不依赖安装态 `PostToolUse` Hook。新建任务或变更 Hook 定义后需重新核对信任状态；旧 Hook 配置的 `timeout: 15` 应使用 `--print-config` 生成的 `timeout: 120` 更新。

可见 Agent Prompt 1.4 将完整的 Dispatch packet 写到控制根下的摘要绑定文件。Agent 必须读取该文件并校验精确字节的 SHA-256。读取 Coordinator 的终端请求时要给足输出预算；若输出出现截断标记，不能据此调用 `spawn_agent`。Codex 当前宿主会加密长 `spawn_agent.message`；有些宿主版本也不会在工具输出附带 `executed_tool_calls`。本地 Host 通过确定性任务名、原生调用/输出的 `call_id` 与 `turn_id`、返回的任务名和后续 Agent 可见性核验派发；若宿主提供截断元数据，则额外严格核对。Host Receipt 将证明强度标为 `host-redacted-message`，不宣称能独立复算实际 Prompt 字节；操作人仍须逐字传递生成 Prompt。字段存在但冲突、任务名错配或 Agent 不可观察时，继续拒绝绑定。

常规质量命令默认初审后最多复审两次。已有权威问题需要一次性修复时，使用 `h:local engine quality <版本> repair-known`；它只修复当前开放问题、跑最终 Gate，并在 `routine-version-exit` 决定后生成注明未做全面复审的常规准出凭证。已知问题解决但原 Run 在最终 Gate 或收口阶段中断时，使用 `h:local engine quality <版本> closeout` 独立接续。它要求当前源码与最新质量 Run 一致、所有 Finding 已解决且有审查证据，不新增全面复审，不消耗复审预算；同一命令已有未完成 Run 时应继续该 Run，不能重复启动。只有 Project Descriptor 将目标列入 `majorReleaseTargets` 时，才可显式使用 `h:local engine quality <大版本> release-exhaustive`。

开发准出后使用 `h:local engine prerelease <版本>` 准备候选：版本元数据、CardWorld 自有 `release/docs-scope.json` 中全部主文档与目录的存量审计、fresh 最终 Gate 和真实 WASM 制品打包都在此阶段完成。`prerelease` 不消耗质量复审预算。候选封存并经用户审核后，从已绑定的 CardWorld checkout 提交 `h:local engine release <版本>`：Hook 将当前候选摘要和修订号固定到本次命令，Coordinator 复核并晋升状态，不创建另一个 Run，也不要求用户组合 `status` 与 `promote` CLI 脚本。Harness 源码同步引起的 Project Descriptor 重新绑定不改变已封存候选；晋升仍逐字节核对业务源码快照与封存制品。当前 V3.8.4 的开发准出凭证可以直接被入口读取；新增的项目侧文档配置作为允许的发布元数据差异记录。

### 本地故障的分级与接续

所有 source-link Workflow 共用故障处置规则，先区分问题来源和 P0–P3 严重度，再根据**实际补丁文件**判定下表的 H0–H4 影响等级。Host 回执失配属于 Harness 宿主集成故障，初判 P1；涉及 `integrations/codex/` 的修复为 H3。未知错误标为来源未定，P1 只是待复核的保守初判；先核查证据，不能自动登记为 Harness 缺陷。Gate 失败属于项目结果，也不能自动登记为 Harness 缺陷。

“单次启动”只约束生命周期命令和 Coordinator 的启动次数；当前 Coordinator 必须通过 Authority 内部处理可恢复的结果拒绝、续接和 Gate 重试。可信 Host 观察到的 Profile 结果拒绝应作为失败 Submission 记录，并按 Feature 预算重新派发。收口只读取 Feature 当前绑定的 Submission，不把较早的失败尝试当作最终结果。若 Coordinator 因 Harness 缺陷退出，按下述 P/H 分级执行内部恢复；不能以再次请求用户发 `h:local` 或逐步授权代替恢复操作。

| 严重度 | 初判处置 |
|:---|:---|
| P0 | Authority 完整性异常：保留现场，先核验状态与迁移方案。 |
| P1 | 宿主调用/Host Effect 异常，或来源未定的保守初判：有未决 Effect 时先隔离和核验，再查明来源。 |
| P2 | 绑定、环境、Gate 或不兼容补丁：按具体来源修复；Gate 失败仍是项目结果。 |
| P3 | 本地命令语法或初始化用法：更正命令后重新提交。 |

本地 Coordinator 在异常时保留 `codex-visible-lifecycle-error` 事件并附加 `incident`；`attention-required` 则额外输出 `codex-visible-lifecycle-incident`。两者携带错误码、阶段、Project/Workflow/目标/Run、故障 ID、初判等级、隔离状态和接续动作。活动 Host Effect 若失去可信证明，先按原 Host Adapter 合同隔离并核验；该隔离不是整个用户任务的最终结论。维护者在独立 Harness checkout 修复并验证源码，随后运行 `dev patch plan`/`dev sync`，依据 H0–H4 的处置恢复原目标。原项目 Run 不获得 Harness 源码写权限；H2/H3 不复用旧 Plan、预检或 Lease。当前用户若要求先审核实现，审核完成前不得启动替代质量 Run。

Hook 在绑定、同步或路由失败时仍用 `decision:block` 阻止无可信意图的业务命令，并在原因中输出故障等级、ID 和维护方向。这个阻断仅针对本次不可信命令；收到原因后应处理 Harness 故障，再按补丁级别完成内部接续或安全退出。不能用普通对话或业务脚本绕过 Hook。

源码 Coordinator 在创建 Run 前检查确定性进程 Gate 所需的带输出捕获子进程能力。启动前先做最小子进程探针；沙箱返回 `EPERM` 时，针对已绑定 Coordinator 的精确命令申请沙箱外执行，再以原意图启动。若预检仍返回 `LOCAL_PROCESS_GATE_HOST_UNAVAILABLE`，仅在错误事件明确给出 `retry.mode=same-intent-once`、匹配本次 `planned` 的 command/intent/plan 摘要、没有 Host 请求及预检事件且意图仍有效时，可在获准权限下一次性重启同一入口、传入原样意图。不得重新模拟用户提交 `h:...`、生成新意图、绕过 Gate 或手写 Gate 结果；权限仍不可用则停止并报告具体阻断。

隔离合成项目已通过真实 Codex Agent 的审查、P1 修复、独立复审和固定最终 Gate，并由 Authority 关闭 Run。该证据证明当前本地源码路径可完成合成质量闭环。下游项目 checkout 的对话主动发起已绑定的本地命令，不适用 Harness 对话跨项目调用下游的授权禁令；Harness 对话要调用 CardWorld 等下游真实 Run，仍需用户针对目标和动作明确授权。Coordinator 重启后的真实宿主恢复与加密 Prompt 字节级证明仍是单独的可靠性跟踪项。

## 变化检测与应用

```text
agent-harness dev verify --manifest <manifest.json>
agent-harness dev doctor --manifest <manifest.json>
agent-harness dev patch status --manifest <manifest.json>
agent-harness dev watch --manifest <manifest.json>
agent-harness dev sync --manifest <manifest.json>
agent-harness dev recover-run --manifest <manifest.json> --run <run-id>
```

不再采用“任何变化都停止并从头开始”的绝对规则：

| 级别 | 范围 | 处置 |
|---|---|---|
| `H0` | 文档、样例、测试 | 立即记录并继续当前 Run，无需 rebind/Decision。 |
| `H1` | 只影响未来计划的 Flow graph/Node template | 本地同步后 rebind；当前 Run 的已冻结 Feature/Plan 继续，新 Run 使用新摘要。 |
| `H2` | Profile、Planner、Gate、Workflow 平台、业务变体 | 不能安全注入旧 Run；重启并新建 Run。 |
| `H3` | Application、CLI、Runtime、宿主集成 | 重启并新建 Run。 |
| `H4` | Kernel、Authority、持久化、关键 Schema、Registry/Recovery | 禁止热应用，必须显式迁移或走新 Release。 |

`dev sync` 在一个命令内生成补丁计划、应用 H0–H3 变更、按需重新绑定 Project，并刷新默认本地 Codex 绑定。它保留 expected revision、命令 ID、制品摘要和 Receipt；H4 仍禁止热应用。需要审查固定计划时，仍可使用 `dev patch plan` 与 `dev patch apply`。H1 不允许重写已派发任务；当前协调进程保持原先已加载模块，新制品摘要用于后续编译和新 Run。

H2/H3 导致 Coordinator 已退出时，`dev recover-run` 仅在项目 checkout 中使用当前 source-link 绑定。它核验覆盖原 Run 和活动 Lease 的补丁 Receipt、每个 Lease 对应的终态 Host Effect、原命令意图，以及同一逻辑任务的新 Plan；随后以预期 revision 将旧 Run 标记为 `superseded`。若有未决 Host Effect 或任一身份不符，它保持旧 Run 原状并返回错误。成功后由用户下一次 `h:local` 命令启动新 Plan；恢复命令本身不启动生命周期。

## generation 与回滚

```text
agent-harness dev generations --manifest <manifest.json>
agent-harness dev patch rollback --manifest <manifest.json> --target-manifest <generation-manifest.json> --command-id rollback-001 --decision ./decision.json
```

Runtime generation 位于 Harness 控制根。Rollback 只切换已验证绑定，要求 checkout 已恢复到目标摘要；工具不会擅自改业务代码或 Harness 源码。

## 修复权限边界

项目 Run 始终只能写其执行目标，不能同时获得 Harness 源码写权限。维护者可以在独立 Harness maintenance 上下文修复源码，再生成 patch plan；H0/H1 按上表继续，H2–H4 必须停止旧执行路径。不得沿用已经失效的 Plan、预检、Lease 或 Runtime Receipt。

source-link Receipt 带开发态标记，不能作为正式发布、签名或生产 cutover 证据；也不能自动提交、发布、删除或迁移旧 Harness。
