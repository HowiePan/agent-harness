# V1.0.0 本地源码真实宿主接入进度（2026-09-24）

## 目标与边界

目标是先让 CardWorld 通过 `source-link` 使用当前 Harness 源码完成真实 Codex Agent 质量审查和开发；可安装插件的 G2 独立留待后续。当前工作仅修改 Harness 仓并验证隔离合成项目；没有启动、恢复或修改 CardWorld/V3.8.4 真实 Run。

## 已完成

- 新增 `local-source-hook.mjs`：项目级 Codex Hook 从明确的控制根绑定目录加载 `source-link`，核验当前 Hook、Coordinator 和 Host bridge 属于同一源码身份；`UserPromptSubmit` 指向当前源码中的命令说明，`PostToolUse` 复用既有 session、工具参数摘要、调用 ID 与请求摘要校验。它拒绝不可变安装绑定、源码漂移和控制根外的绑定目录。
- `--print-config` 生成可放入明确选用本地开发模式的项目 `.codex/hooks.json` 的配置；`h:probe` 会给出绑定当前 Codex session 的只读短探针，只请求一次原生 `collaboration.list_agents`，不创建 Run。该模式不要求重新打包或安装 Codex 插件。项目 Hook 的信任审核仍由 Codex 宿主执行。
- 在隔离合成项目验证源码绑定、Hook 配置生成、伪命令意图、`h:probe` 入口，以及模拟原生 `PostToolUse` 事件到 pending Host 请求的端到端往返。合成项目位于 `F:\agent-harness\.agent-harness-data\local-debug-acceptance\2026-09-23\consumer`，配置为其 `.codex\hooks.json`；最终绑定与回执位于 `F:\agent-harness\.agent-harness-data\local-source-host\2026-09-24\data-probe`，源码摘要为 `a404ffcdaa9045159c04eef01914b0ed2073b36a173f12a3881b1ebd96ff76bc`。这些目录均为忽略的调试数据，不是 CardWorld 仓。
- `npm run check`、完整测试 315/315 和 `npm run workspace:canary` 通过。

## 当前停点

**真实 Codex Desktop 项目 Hook 投递仍未通过。** 2026-09-24 获用户授权后，在已登记的 Harness 项目根临时放置与合成项目相同的 `.codex/hooks.json`，并分别使用同目录派生任务 `01a0d0ef-b3cd-71e0-8c81-4a45d7aaabcc` 和直接绑定该项目的独立本地任务 `01a0d0f6-0b20-7623-b9f6-984aea0c2094` 做短探针。派生任务两次发出只读 `collaboration.list_agents` pending 请求（`host_probe_31c1ac84-cd80-4413-adc1-27a5fe78ba4d`、`host_probe_5e357876-9381-4771-a5c4-b7ebad2f2c3c`），到期前均未观察到对应 Host response；这只能证明探针请求已发出，不能证明原生工具调用或 `PostToolUse` 投递。独立任务收到精确 `h:probe` 后按已安装 Skill 把它判为无效命令，未获得项目 Hook 应注入的探针说明。因此项目级 `UserPromptSubmit` 在这次桌面任务中没有可观察投递；尚不能区分 Hook 未被信任、未加载或宿主路由未触发。初次探针结束后曾清理临时 Hook；根据用户要求复用现有 Harness 桌面项目，已在相同根目录重新生成本地配置，合成项目数据与绑定继续保留。

复用**现有 agent-harness 桌面项目**做短探针。合成项目仍是独立 Git 工作区和 Harness 绑定对象；Harness 根任务只承担宿主 Hook 短探针，不启动自我调度或业务 Run。只有 Host response 与请求 ID、session、摘要一致，才继续真实 Agent 的合成质量闭环与重启恢复。

### 同日追加：项目 Hook 信任已完成，桌面任务消息未投递

按用户继续授权，通过 `codex -C F:\agent-harness` 的交互式 `/hooks` 审核界面，分别核对来源、命令、事件、matcher 和超时后，信任项目级 `PostToolUse` 与 `UserPromptSubmit`。Codex 用户配置已记录两个项目 Hook 的精确 `trusted_hash`；已有插件 Hook 的信任记录未改动。CLI 仅用于 Hook 信任管理，未执行 Harness Run。

在现有 Harness 项目新建 Local 任务 `01a0d10d-ac57-7cf3-b496-54ac2611d2b8`，先通过任务创建消息、再通过 `send_message_to_thread` 跟进消息发送精确 `h:probe`。两次都被任务按已安装插件 Skill 解析为无效命令，均未得到项目 `UserPromptSubmit` 应注入的短探针上下文，也未创建新的 Host probe 请求。任务创建/发送 API 是否绕过 Hook 与桌面宿主是否未加载 Hook 仍待区分；不能把 CLI 的信任成功算作桌面 Hook 投递通过。下一步需要从该项目任务的实际桌面输入框手动提交一次 `h:probe`，并检查 Hook 状态或启动警告；当前任务消息 API 与交互式 CLI 都不能替代这个桌面输入路径的证据。

### 同日追加：桌面原始输入与源码修复

用户在该任务的实际桌面输入框提交后，原始消息为 `` `h:probe` ``（带反引号）；随后 `` `h:where` `` 也带反引号。此前本地源码 Hook 只精确识别裸 `h:probe`，通用伪命令解析器也只接受以 `h:` 开头的原始消息；因此这两条 Markdown 行内代码形式都不会生成 Hook 上下文。`h:where` 的可见结果是任务自行调用已安装插件的路由器得到的，不能当作项目 Hook 投递证明。

源码 Hook 现已仅对“整条消息是一层行内代码包裹的 `h:` 命令”去除反引号，保留解释文字和代码块不触发的边界；集成测试覆盖包装后的 `h:probe`、`h:where` 和非整条命令。手动直接调用 Hook 返回有效探针上下文，目标测试通过。仍需重新固定 source-link manifest 和本地绑定，再让桌面宿主重新提交并观察真实 `UserPromptSubmit` 与 `PostToolUse`。同时，交互式 CLI 对照尝试因模型流连接失败而未形成有效宿主结论。

本次修复后，已对合成项目执行 `dev rebind` 并重配本地 source-link Host 绑定；当前 manifest、绑定摘要均为 `ece86d6d71d1814aab30f2f496928a94717e4990d039b4d6c7612c8b523d9175`，`dev verify` 成功。当前 Hook 进程处理 `` `h:probe` `` 可返回带 session ID 的短探针说明；目标集成测试与 `npm run check` 通过。此前的两个 pending 请求没有因 rebind 被冒充为成功回执。**桌面真实 Hook 投递和原生 `PostToolUse` 仍未通过**，必须在同一受信项目任务中重试后按实际宿主证据判断。

### 同日追加：第二次真实桌面复测

用户从同一项目任务 `01a0d10d-ac57-7cf3-b496-54ac2611d2b8` 的实际输入框再次提交 `` `h:probe` ``，任务仍按已安装插件绑定回答“只有 `engine` 别名，缺少动作和目标”，没有执行短探针。宿主日志在该次 Turn（`01a0d120-cf12-7382-a62a-da6204f2acec`）开始时记录两次 `hook/started` 和两次 `hook/completed`；交互式 CLI `/hooks` 显示 `UserPromptSubmit` 两个 Hook 均为 Active。可确定 Hook 调度入口已触发，但现有线程投影和日志不提供每条 Hook 的退出状态或输出，尚不能把“完成”解读为源码 Hook 结果成功进入模型上下文。

为阻断静默回退，源码 Hook 现在对 `h:probe` 成功识别返回可见 `systemMessage`，并在绑定校验失败时返回 `decision:block` 与错误码；提示明确该命令不按已安装插件别名解析。目标测试覆盖成功和失效绑定两条路径。下一次真实桌面复测应先看可见提示或阻止原因，再看原生请求与自动回执；没有这些证据仍保持 `attention-required`。

本次源码与测试更新后的 source-link manifest 摘要为 `2b338f02ee573ba56a7aaa9d3ee120053fbe867dc71de1bf15ddd1349b52be24`，本地 Host 绑定指针已同步；`dev verify` 返回 `ok: true`。直接执行当前项目 Hook 并输入 `` `h:probe` ``，确认其返回上述可见提示以及包含探针脚本和当前 session ID 的上下文。`npm run check`、目标 Hook 测试和 `git diff --check` 均通过。以上是进程级验证，不代表桌面宿主已交付 Hook 输出。

### 同日追加：第三次真实桌面输入含转义空格

用户新建 Local 任务 `01a0d12f-ae4d-73e2-b8e2-63db3b9cd451`，工作目录仍为 `F:\agent-harness`。该任务的原始宿主记录显示提交内容是字面文本 `&#x20;h:probe`，不是以普通空格开头的 `h:probe`；任务因此继续按已安装插件命令格式拒绝。该 Turn 同样出现两组 Hook started/completed 事件，但日志没有输出正文或退出状态。源码 Hook 之前只消除普通空白与整条行内代码包装，不能识别前导 HTML 空格实体。现在只在消息边缘消除已观察到的 HTML 空格实体；测试覆盖该输入与带解释文字的不触发边界。此修复仍需重新固定 source-link 摘要并在真实宿主复测；目前不能宣布本地 Host 路径准出。

修复后的 source-link manifest 与本地 Host 绑定指针均为 `c9f857df87158bd00de36d0c79863973ad1c365c7b0ba72f2aa0307cda2d426a`；`dev verify` 返回 `ok: true`。直接向当前 Hook 进程提交宿主记录中的精确输入 `&#x20;h:probe`，返回“本地源码 Hook 已识别”提示和探针上下文；目标测试、`npm run check` 与 `git diff --check` 通过。桌面真实投递与 `PostToolUse` 自动回执仍需单独观察。

随后经 `send_message_to_thread` 向现有探针任务发送相同文本作只读对照，目标任务仍按已安装插件格式拒绝。该次续发在任务记录中表现为 `send_message_to_thread` 的工具输出，宿主日志没有对应 `hook/started` 事件；因此跨任务消息 API 会绕开这里需要验证的桌面 `UserPromptSubmit` 路径，不能据此判定修复失败或成功。后续必须由实际桌面任务输入框提交，且无需再创建新任务。

用户随后在当前长期任务 `01a0ce30-fa01-78a1-902c-c7616a2a3b51` 直接提交裸 `h:probe`。该任务创建于项目 `.codex/hooks.json` 放置之前；本轮宿主日志只记录一组 `hook/started`/`hook/completed`，而配置后的探针任务记录两组。结合本轮没有源码 Hook 的可见提示或上下文，当前任务不能作为源码项目 Hook 投递验证场所。此处“一组对应已安装插件、缺少的另一组对应项目 Hook”是基于时序和数量的推断，日志没有逐条 Hook 身份，不能据此宣布宿主缺陷。实际下一步是在配置后创建的现有探针任务输入框提交；跨任务消息 API 不可替代。

### 同日追加：取消 `h:probe` 路由，直接源码验证暴露真实阻塞

用户指出本地模式无需依赖打包插件的伪命令，这一方向纠偏成立。`h:probe` 是此前为本地调试另加的快捷入口，不属于已安装插件的命令契约；已安装解析器拒绝它是预期行为，不能作为本地模式失败或成功的判据。源码项目 Hook 现在只配置 `PostToolUse`；只读探针直接运行 `local-source-host-probe.mjs --bindings-dir <绝对目录>`，从 `CODEX_SESSION_ID` 获取当前 session，显式 ID 与环境不一致时拒绝。项目 `.codex/hooks.json` 已更新为单一 `PostToolUse` 配置；不再要求 `UserPromptSubmit` 或 `h:` 命令。

在现有配置后创建的任务 `01a0d12f-ae4d-73e2-b8e2-63db3b9cd451` 中，直接源码短探针发出 `host_probe_cba32f23-741c-4d8c-999f-69d7b9f46569`。任务原生调用记录在 2026-09-24T02:39:06Z 显示 `collaboration.list_agents`，参数 `{}`，返回 `{"agents":[{"agent_name":"/root","agent_status":"running"}]}`。同期宿主日志没有 `hook/started` 或 `hook/completed` 事件；探针到 60 秒报 `CODEX_HOST_HOOK_RESPONSE_TIMEOUT`，诊断 `rawFrameBytes=0`，没有自动 Host response。与前面“可能是命令没解析”的假设不同，当前可确认原生调用已发生、Hook 回执路径未发生。文档将真实 Agent Host 回执明确列为本地执行准出条件；源码绑定、只读计划和合成测试仍可推进，但真实 Agent Run 维持 `attention-required`。Codex 官方 Hooks 文档说明专用工具路径可能跳过默认 Hook 路径，当前结果与该限制相符；具体属于宿主覆盖范围还是 Hook 配置问题仍需独立验证。

本轮最终 source-link manifest 与本地绑定指针摘要为 `a4cc06808f3ffd296b0cf09672a5df2ca370ef3d06a4ee6d79ed78520031918f`，`dev verify`、目标测试、`npm run check` 和 `git diff --check` 通过。下一步应先用可审计的受信 Host 结果接口替代对伪命令及未证实的 `PostToolUse` 覆盖的依赖；至少区分当前 matcher 未覆盖实际工具名与专用工具路径绕过 Hook 两种情况，再决定 Host Adapter 实现。不能通过手写、转录或从模型输出恢复工具结果来消除该 Gate。

### 同日追加：宽匹配诊断未形成有效宿主结论

按用户继续授权，曾暂时将项目 `PostToolUse` matcher 改为 `*` 并在交互式 Codex CLI 中审核、信任该单条诊断 Hook；配置中的 Hook 命令、绑定路径和事件类型未改。新 CLI 会话随后在模型流阶段反复连接超时，没有形成原生 `collaboration.list_agents` 调用，因此不能从该会话推断通配 matcher 是否收到协作工具事件。对既有桌面探针任务用跨任务消息触发一次原生 `list_agents({})`，返回正常，但该任务使用创建时加载的旧配置；同期无新 Hook trace，仍不能比较新旧 matcher。诊断后已把项目 `.codex/hooks.json` 恢复为原来的窄匹配 `PostToolUse` 配置，未留下全工具监听。下一步仍需在新加载诊断配置的真实宿主会话完成一次受控调用；该证据取得前不能把“专用工具路径绕过 Hook”当作定论，也不能准出真实 Agent 路径。

尝试续用上述 CLI 创建的既有任务并暂时恢复已信任的通配配置，桌面宿主的该任务本轮耗时约 119 秒后结束，记录中没有模型答复或原生工具调用；它同样不能形成 Hook 覆盖结论。通配配置随后再次恢复为窄匹配。需要一个**在通配配置生效后新建、模型连接正常**的本地诊断任务，才可做判别；当前现有任务不能在其已冻结 Hook 集合上证明通配覆盖。

若项目 Hook 对该原生工具也不投递，保持 `attention-required`，记录与插件 G2 是否共享宿主路由根因；不得手写 Host response、使用 headless Agent 或让合成结果冒充真实宿主证据。CardWorld 真实 Run 仍等用户审核实现并作出单独决定。

### 同日追加：本地源码 Host 交换与真实预检

项目 Hook 在全匹配对照后恢复窄匹配，并通过交互式 `/hooks` 保持受信且启用。此前发现用户配置中的项目 Hook 曾为 `enabled = false`；启用后仍未取得原生 `collaboration.list_agents` 的项目 `PostToolUse` 投递。此结果不能把 Hook 的具体缺口归因于 matcher 或专用工具路由。项目级 Hook 仍可留作打包插件问题的后续调查，本地源码路径已改用 Codex 当前 session 的宿主 rollout 读取原生工具调用与结果，不再依赖 `h:probe` 或 Hook 回执。

新增开发态 `codex-rollout-host-exchange.mjs`，从只读 `state_5.sqlite` 定位当前 session 的 JSONL，校验当前工作目录和 rollout 路径，并仅接受请求发出后出现、工具名和参数摘要相同、调用 ID 与 Turn ID 配对的原生调用与输出。返回前写入摘要绑定的 Host Receipt；模型消息或终端转录不能充当结果。宿主内部格式变化时按错误码拒绝，不能静默回退。安装模式仍使用原有 Hook 交换。

当前任务的真实只读探针 `host_probe_e0d138ad-ce25-4afe-a655-46c031b6e830` 发出 `collaboration.list_agents({})`，原生输出包含 `/root`，自动写入 `rollout-receipts`，返回 `ok: true`。随后对隔离合成项目重新固定源码并用专用 Authority Decision 更新 Project Descriptor。Coordinator 为 `quality synthetic-v1` 生成计划，真实宿主 `list_agents` 回执使动作预检 17/17 项通过，随后创建了合成 Run 并发出原生 `spawn_agent` 请求。没有调用 `spawn_agent`：该请求的生成 Prompt 很长，当前终端结果被截断，而 Operator Contract 要求逐字传递 `prompt.text`。进程已停止；Host Effect 处于待协调状态，合成 Run 须由 Authority 恢复逻辑处理，不得直接修改状态文件。这不是 CardWorld Run。

为消除本地入口阻塞，新增直接源码意图生成器 `local-source-lifecycle-intent.mjs`，按明确别名、动作、目标和当前 Codex session 生成受摘要约束的 Coordinator 意图；`visible-lifecycle-coordinator.mjs` 在 source-link 模式绑定相同 session，并对没有显式 Workflow 列表的旧式 Project Descriptor 遵循 Core 的 Workflow 选择规则，再核对计划中最终 Workflow 的 ID、版本和摘要。下一步仍需证明原生 `spawn_agent` 的**完整生成 Prompt**可无损传入并完成合成审查、修复、复审、Gate 与 Closure，包含 Coordinator 重启恢复；通过前不得宣布 CardWorld 本地真实 Agent 路径准出。

### 同日追加：新建桌面任务完成宽匹配对照

经用户明确授权，在既有 `agent-harness` 项目、原工作目录 `F:\agent-harness` 新建只读诊断任务 `01a0d163-0038-7522-be7f-a3055423ffc4`。创建时项目 `PostToolUse` matcher 临时为 `*`；Codex 官方 Hooks 文档确认 `*` 是合法的全匹配值。任务的原始 rollout 记录了且只记录了一次原生 `collaboration.list_agents({})` 调用，调用 ID 为 `call_QuMQnwZJoXIAdewQ9a1X7kPf`，原生输出为 `{"agents":[{"agent_name":"/root","agent_status":"running"}]}`。宿主工具日志将此次调用记为 `collaborationlist_agents`（无分隔符），这与现有窄匹配正则接受的 `list_agents` / `collaboration.list_agents` 不同；但日志中的调度名不一定等于 Hook 输入的 `tool_name`，不能只据此修改正式匹配语义。

此次调用附近宿主日志出现一组 `hook/started` 和 `hook/completed`，但项目源码 Hook 在绑定控制根下没有新增 bootstrap trace；该组事件没有逐条 Hook 身份、退出码或输出，无法证明是项目 Hook。此前 CLI 通配配置对 `Bash` 曾生成 `hook_103aa969c78745269f6621aba7e86d66` trace，说明该配置至少在 CLI 的普通工具路径可执行。新桌面任务的原生协作调用仍未取得项目 Hook 投递证据，因此“项目 Hook 未加载/未信任”和“协作工具专用路径绕过项目 Hook”尚未区分；不能以这次宽匹配试验认定任何一种根因，更不能准出真实 Agent。

诊断后已从源码 `--print-config` 恢复项目 `.codex/hooks.json` 为原窄匹配、仅 `PostToolUse` 的配置。由于修改 matcher 会改变 Codex 信任摘要，随后在交互式 `/hooks` 中复核到该项目 Hook 显示 `modified`、`PostToolUse` 为 2 installed / 1 active / 1 review；按此前用户对当前本地 Hook 的授权重新审核并信任，窄匹配项目 Hook 已恢复为 Active。没有启动 Harness Run、创建 Host response 或更改 CardWorld。下一步应在能显示每条 Hook 的来源和执行结果的宿主通道核查该桌面任务的项目 Hook 加载状态；在获得原生 Host 自动回执前，维持 `attention-required`。

### 同日追加：原生合成闭环与 CardWorld 只读准备

`source-link` 现在使用 1.4 Prompt：完整 Dispatch packet 落盘并按精确 SHA-256 核验，生成 Prompt 保留 Authority 边界、Node Task 和结果契约，实际合成 Prompt 约 8–9 KB。`codex-rollout-host-exchange.mjs` 读取当前 session 的原生工具调用及输出并生成摘要绑定回执。Codex 对长 `spawn_agent.message` 在父 rollout 中加密，回执明确记录 `argumentAttestation: host-redacted-message`；原生 Agent、任务名、调用与输出可证明，传入 Agent 的 Prompt 字节不能从父 rollout 独立复算。

隔离合成 `synthetic-v4` Run `synthetic-v4-quality-a4a616315c1f2e9d` 完成了原生审查发现 1 个 P1、授权路径 `calc.mjs` 修复、不同 Agent 全范围复审零发现、固定最终 Gate `synthetic-v3-check` 通过，并以 Authority Receipt `152a66216d1142d8c764007cf5f817a4b3a4db129ef963dae93ef70cacb6335d` 关闭。该 Run 的 Gate 首次在受限进程环境中启动带输出捕获的子进程时报 `spawn EPERM`，状态进入 `closure-blocked`；随后通过同一 Run 的固定 Recipe 和 `ProjectGateRunner` 在获准进程权限下重新执行，Gate 退出码 0，才调用 Kernel 的闭环检查。没有手写 Gate 结果或修改 Authority 文件。新增本地 Coordinator 的带输出捕获进程预检，今后在创建 Run 前报告 `LOCAL_PROCESS_GATE_HOST_UNAVAILABLE`。

真实 `F:\CardWorld\harness.json` 和 Git 工作区已只读核对；独立数据根中的 `dev attach` 零 Registry/Run 写入计划及 `dev verify` 通过。计划保存在 `F:\agent-harness\.agent-harness-data\cardworld-readiness\2026-09-24\attach-plan.json`。本地 Gate 子进程预检在当前受限权限下返回 `LOCAL_PROCESS_GATE_HOST_UNAVAILABLE`，Synthetic Authority Run 目录前后均为 5 个，证明错误发生在建 Run 之前；获准进程权限下的实际合成 Gate 已通过。重启恢复的真实宿主演练与加密 Prompt 字节级证明仍待进一步解决，不能由合成闭环冒充。

### 同日追加：CardWorld 本地源码准入预检

隔离合成 `synthetic-v5` Run `synthetic-v5-quality-eb8bc7c80eb5a087` 在获准进程权限下从原生只读审查走到最终 Gate `synthetic-v3-check`，Authority 状态为 `closed`、revision 8，Gate 为 `passed`。这补足了前述 `synthetic-v4` 修复闭环的干净起跑证据。

根据用户“推进到 CardWorld 可用本地模式完成质量审查，但不要主动启动 CardWorld 审查”的授权，已在独立数据根 `F:\agent-harness\.agent-harness-data\cardworld-readiness\2026-09-24` 执行 `dev apply`，只登记 `cardworld-engine` 项目及 source-link Extension，不触及已有真实 CardWorld Authority。随后加入 Coordinator 的 `--preflight-only`，它只做计划和完整动作预检，在 `executionReady: true` 时也不创建 Run。此次 Runtime 变更按 H3 执行开发态 patch/rebind，当前 Runtime 摘要为 `46f89c0b6e79b975eb06e0ca17c17d5afd4742117b56d100bfe1e5a35658802d`；`dev verify`、`dev doctor` 均通过。

真实 CardWorld `quality V3.8.4` 计划生成 1 个 Feature，要求 5 个最终 Gate。普通 CLI 的只读预检因没有注入可见 Host Adapter 和未做写探针而显示预期阻项；同一 Codex session 中使用 source-link Coordinator 的 `--preflight-only`，原生 `collaboration.list_agents` 回执完成 Host 协议核验，17/17 项动作预检通过，`executionReady: true`、`writeProbe.cleaned: true`、lineage 为 `start/NO_EXISTING_LOGICAL_RUN`。计划摘要 `f3266c196700d2ce4b6214f9562cc546b57062e65c1e86f71a40907ac59c9fb4`，预检报告摘要 `1faae8f42bab344ce414ccde30b0a1ab4164b535a69fa49dedf4af66d0bb918b`。未启动或恢复 CardWorld 质量 Run，未修改 CardWorld 文件；实际项目审查与 Gate 结果仍须用户审核后决定启动才能取得。
