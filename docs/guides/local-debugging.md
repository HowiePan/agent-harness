# 本地源码调试模式

`source-link` 让项目直接使用当前 Agent Harness checkout，无需每次打包、卸载、重装。从项目 checkout 主动运行 `dev` 命令即授权本地源码绑定及 H0–H3 同步；应用层根据这次调用生成绑定具体计划和命令的 Authority Decision，无需人工另行签发。从 Harness checkout 指向项目执行相同写入时仍需外部 Decision。路径、Gate、宿主证明和运行期保护操作继续按原合同检查。完整字段和命令见[配置 API](../reference/configuration-api.md#8-本地源码调试与热更新)。

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
  --alias <项目别名> --action quality --target <版本>
```

入口核验绑定、Git 工作区身份、Workflow 与当前源码摘要，返回 `coordinatorEntrypoint` 和 `coordinationIntent`。在同一 Codex 任务中先调用 `node <coordinatorEntrypoint> --intent <coordinationIntent> --preflight-only` 可执行完整计划和动作预检，不创建 Run；需要按终端请求调用原生 collaboration 工具。确认预检通过并决定启动后，再用新生成的意图调用 `node <coordinatorEntrypoint> --intent <coordinationIntent>`，保持终端可观察，并依次执行 Coordinator 发出的原生 collaboration 请求。`spawn_agent` 的 `message` 必须逐字使用请求中的完整生成 Prompt；不要缩写或用路径引用代替。仅在动作预检返回 `executionReady: true` 后 Coordinator 才创建 Run。审查发现问题时，继续处理修复、复审和 Gate，直到 `closed` 或明确的 `attention-required`。

也可以在业务项目的 `.codex/hooks.json` 中配置由 `local-source-hook.mjs --print-config --bindings-dir <绑定目录>` 生成的 `UserPromptSubmit` Hook。项目 Hook 只保存指向 Harness 源码和外部数据根的命令，项目仓库不保存 Harness 实现或运行状态。经 Codex 审核并信任该项目 Hook 后，在绑定的项目任务中发送 `h:local engine quality V3.8.4`；`h:local where engine` 是只读绑定检查。安装态 Hook 忽略 `h:local`，本地 Hook 忽略安装态的 `h:engine`。源码模式的原生工具回执由当前 Codex session rollout 核验，不依赖安装态 `PostToolUse` Hook。新建任务或变更 Hook 定义后需重新核对信任状态。

可见 Agent Prompt 1.4 将完整的 Dispatch packet 写到控制根下的摘要绑定文件。Agent 必须读取该文件并校验精确字节的 SHA-256。读取 Coordinator 的终端请求时要给足输出预算；若输出出现截断标记，不能据此调用 `spawn_agent`。Codex 当前宿主会加密长 `spawn_agent.message`，父任务 rollout 只能证明原生调用、确定性的任务名及宿主截断元数据，不能独立复算实际传给 Agent 的完整 Prompt 字节；Host Receipt 将此标为 `host-redacted-message`，操作人仍须逐字传递生成 Prompt。

源码 Coordinator 在创建 Run 前检查确定性进程 Gate 所需的带输出捕获子进程能力；若当前任务的进程权限返回 `LOCAL_PROCESS_GATE_HOST_UNAVAILABLE`，应在获准的进程权限下重新执行同一入口。不要绕过 Gate 或手写 Gate 结果。

隔离合成项目已通过真实 Codex Agent 的审查、P1 修复、独立复审和固定最终 Gate，并由 Authority 关闭 Run。该证据证明当前本地源码路径可完成合成质量闭环；CardWorld 真实 Run 仍由用户审核实现后另行决定。Coordinator 重启后的真实宿主恢复与加密 Prompt 字节级证明仍是单独的可靠性跟踪项。

## 变化检测与应用

```text
agent-harness dev verify --manifest <manifest.json>
agent-harness dev doctor --manifest <manifest.json>
agent-harness dev patch status --manifest <manifest.json>
agent-harness dev watch --manifest <manifest.json>
agent-harness dev sync --manifest <manifest.json>
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

## generation 与回滚

```text
agent-harness dev generations --manifest <manifest.json>
agent-harness dev patch rollback --manifest <manifest.json> --target-manifest <generation-manifest.json> --command-id rollback-001 --decision ./decision.json
```

Runtime generation 位于 Harness 控制根。Rollback 只切换已验证绑定，要求 checkout 已恢复到目标摘要；工具不会擅自改业务代码或 Harness 源码。

## 修复权限边界

项目 Run 始终只能写其执行目标，不能同时获得 Harness 源码写权限。维护者可以在独立 Harness maintenance 上下文修复源码，再生成 patch plan；H0/H1 按上表继续，H2–H4 必须停止旧执行路径。不得沿用已经失效的 Plan、预检、Lease 或 Runtime Receipt。

source-link Receipt 带开发态标记，不能作为正式发布、签名或生产 cutover 证据；也不能自动提交、发布、删除或迁移旧 Harness。
