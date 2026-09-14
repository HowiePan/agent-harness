# V1.0.0 运维手册

## 安装与数据边界

要求 Node.js 22+。业务仓 `root` 可以位于其他磁盘，但 Harness 的 `dataRoot` 必须位于 Standalone Control Root 内，默认是 `.agent-harness-data/`。显式路径如果越过控制根会以 `HARNESS_WRITE_OUTSIDE_PROJECT` 拒绝；不再使用 `%LOCALAPPDATA%`、用户主目录或系统 `%TEMP%` 作为默认写入位置。

正式部署的控制根必须位于所有受管业务 workspace 之外。源码 checkout 可直接作为控制根。npm 包部署必须放在专用目录内，并从包内 CLI 执行一次 `installation init --control-root <专用目录>`；位于 `node_modules` 的 Runtime 在没有显式控制根和匹配安装标记时会 fail-closed。当前嵌套目录只用于实现与合成测试。

```powershell
npm ci
npm test
node bin/agent-harness.mjs doctor --data-root .agent-harness-data/doctor
node scripts/check-residue.mjs
```

`doctor` 是零写入检查：只解析并验证目标路径，不初始化状态目录，也不导入 Extension 代码。输出分别标明控制根模式、安装就绪、数据根/Extension Registry/Project Registry/Authority 是否存在，以及 `storageReady`、逐项目 `projectReady` 和最终 `lifecycleReady`；`writeCapability=not-probed` 表示零写入检查不能证明当前调用方具有写权限。生产预检必须同时传入绑定的 `--project`、`--profile`、`--extension-id` 和可选 `--execution-workspace`，不得用“任意项目存在”代替目标项目就绪。

先用 `project register` 登记 Project Descriptor，再用 `run start` 创建 Run。所有写命令携带唯一 `--command-id`；更新已有 Authority 时同时携带最新 revision。使用 `node bin/agent-harness.mjs --help` 查看完整参数。

Consumer、Runtime 与 Legacy 能力通过 Extension Pack 装载。先在独立控制根注册一次，后续 CLI 进程会按安装回执自动解析，并在执行模块前验证完整制品清单 SHA-256。安装、升级、移除都是可信代码变更，必须提供当前 revision、唯一 command ID 和批准 Decision：

```powershell
node bin/agent-harness.mjs extension register --module agent-harness/consumers/cardworld-engine --expected-revision 0 --command-id install-engine --decision <approved-decision.json>
node bin/agent-harness.mjs extension register --module agent-harness/extensions/codex-runtime --expected-revision 1 --command-id install-runtime --decision <approved-decision.json>
node bin/agent-harness.mjs extension list
node bin/agent-harness.mjs project descriptor --extension agent-harness/consumers/cardworld-engine --input examples/engine-project-input.json
```

生产 Project Descriptor 必须同时记录 Harness 版本/制品摘要与每个 Extension 的 ID/版本/制品摘要，Run 创建前精确校验已安装集合。选择非 Codex Runtime 时，Consumer Descriptor 不再声明 `codex-runtime`；调用方显式提供所选 Runtime Extension 身份即可。业务仓无需保存生成器、配置、Skill 或 Harness 代码。

首次投产推荐使用两阶段 Bootstrap。`bootstrap plan` 只读取发布清单、Registry 和 Project 状态，不导入 Extension、也不创建数据根；`bootstrap apply` 必须携带审核后的原计划、批准 Decision 和唯一 command ID。Apply 使用可恢复 journal，逐项幂等登记 Extension，初始化受管 Store，生成并登记 Project Descriptor，最后强制通过项目级 readiness：

```powershell
node bin/agent-harness.mjs bootstrap plan --input <bootstrap-request.json> > <reviewed-bootstrap-plan.json>
node bin/agent-harness.mjs bootstrap apply --plan <reviewed-bootstrap-plan.json> --command-id <bootstrap-id> --decision <approved-decision.json>
node bin/agent-harness.mjs doctor --project cardworld-engine --profile engine-delivery --extension-id cardworld-engine-profile --execution-workspace <CardWorld-worktree>
```

Bootstrap 只建立新 Harness Authority 基础设施，不导入旧状态、不创建业务 Run，也不构成 cutover、发布或旧 Harness 删除授权。

已存在 `active-release` 的控制根必须使用发布激活完成制品轮换：

```text
node bin/agent-harness.mjs release activation-plan
node bin/agent-harness.mjs release activation-apply --plan <plan.json> --command-id <id> --decision <approved-decision.json>
```

激活一次性绑定候选 Harness、Extension 集合和受影响 Project；事务先提交候选 generation，最后切换活动指针。业务生命周期命令不得隐式触发 Bootstrap 或逐项请求制品升级授权。

生命周期命令先生成确定性的 `LifecycleCommandPlan`。交互式 Codex 默认只启动 Authority，再由当前宿主把 Dispatch 委派给可见子 Agent：

```text
node bin/agent-harness.mjs lifecycle plan --input <intent.json>
node bin/agent-harness.mjs lifecycle start --plan <plan.json> --command-id <command-id>
node bin/agent-harness.mjs run schedule --project <id> --run <id>
node bin/agent-harness.mjs run dispatch --project <id> --run <id> --dispatch <dispatch-id>
```

Plan 中的 Run ID、Feature graph、Profile config、Runtime、Gate plan 和 protected-operation 列表由已安装 Extension 的 compiler 产生，模型和 Hook 不得自行构造。Codex Operator 使用宿主原生 multi-agent delegation 创建可见子 Agent，并由可信宿主适配器证明 Agent、Dispatch、Packet 与 inspect reference 后绑定 Lease；原始 `run bind` JSON 不能充当证明。运行期间至少记录一次新鲜 heartbeat，最后提交结构化结果。没有可见委派或可信绑定能力时返回 `attention-required`；禁止调用 `codex exec`、后台 Agent CLI、`run execute` 或 `lifecycle execute` 兜底。

只有 Project Descriptor 明确声明 `agentExecutionMode: headless`，且用户明确请求 CI/无人值守执行时，才可使用阻塞 Coordinator：

```text
node bin/agent-harness.mjs lifecycle execute --plan <plan.json> --command-id <command-id> --progress
```

`project-descriptor-input.schema.json` 约束可提交的配置输入；`project-descriptor.schema.json` 约束 Registry 增加 revision、commands、时间和摘要后的持久记录。更新时不得把整个 Registry 记录重新作为输入，Programmatic API 使用 `projectDescriptorInput(record)` 提取配置面。CLI 生成器会把当前 Harness 和已安装 Extension 的精确摘要封入输入。静态示例是 Consumer 生成器输入，不伪造会随发布制品变化的摘要。

Codex 工具集成位于 `integrations/codex/agent-harness-codex/`，是带 `.codex-plugin/plugin.json` 的独立可安装插件。其他 Agent 工具按同一 Operator Contract 提供自己的集成插件，不进入 Harness Core。实际安装插件属于部署步骤，不会把 Skill 复制到业务仓。

仓库自带 `.agents/plugins/marketplace.json`。首次安装或本机绑定变化后，在 Standalone Control Root 执行：

```powershell
node integrations/codex/agent-harness-codex/scripts/configure-bindings.mjs --plugin-root integrations/codex/agent-harness-codex --control-root . --entrypoint bin/agent-harness.mjs --data-root .agent-harness-data --project "engine|cardworld-engine|engine-delivery|cardworld-engine-profile|<CardWorld绝对路径>" --project "collection|tabletop-collection|collection-batch|tabletop-collection-profile|<Collection绝对路径>"
codex plugin marketplace add .
codex plugin add agent-harness-codex@agent-harness-local
```

本机绑定固定写入仓库内、被 Git 忽略的 `integrations/codex/agent-harness-codex/.plugin-data/bindings.json`，安装时复制到 Codex 的受管 `PLUGIN_DATA`；不维护用户目录下的第二份插件源码。Codex 插件 manifest 的版本必须与 Harness 发布版本逐字相等，V1.0.0 固定为 `1.0.0`；禁止使用通用插件开发流程的 `+codex.<cachebuster>` 后缀。重新安装同一开发版本时，先执行 `codex plugin remove agent-harness-codex@agent-harness-local` 清除本地缓存，再执行上面的 `plugin add`，不得通过修改版本规避缓存。安装或重装后应新建任务，使 Codex 在任务启动边界重新加载 Skill 与 Hook；旧任务历史仍可读取，但不保证热加载新插件能力。

## 日常运行

### 对话式命令面

安装 `agent-harness-codex` 插件并配置绑定后，直接发送 `h:<项目别名> <动作> <目标> [预设]`。这不是 Codex 自定义斜杠命令，而是由插件 `UserPromptSubmit` Hook 识别的稳定伪命令；`$agent-harness-command` 可作为 Hook 未信任或被管理员禁用时的显式回退入口。

项目别名属于插件安装数据，不属于 Kernel 命令表。`PLUGIN_DATA/bindings.json`（本地安装回退为 `<pluginRoot>/.plugin-data/bindings.json`）显式固定 `controlRoot`、`entrypoint`、`dataRoot`，并为每个别名分别绑定 Project、Profile、Extension、`workspaceRoot` 和可选 Git common-directory identity。Router 先选择别名，再验证该项目的绑定根或 linked worktree；不同别名可以属于不同仓库。状态变更 Run 会把 Hook 验证过的实际 worktree 固定进 Authority。可用 `h:where` 或 `h:where <项目别名>` 只读检查每个项目的独立匹配结果。

使用 `h:report <项目别名>` 上报当前对话中的 Harness 问题。该保留命令只依赖绑定文件，因此即使 data root、Extension Registry、Project Descriptor 或 Authority 不可用也能登记问题。它从当前对话提取相关摘录、执行脱敏并列出缺失 Evidence，通过绑定的精确入口调用 `issue record`；不创建新对话，不启动 Run/Gate，也不修复实现。输出目录固定为 `<controlRoot>/issues`，不接受任意路径参数，不写业务仓、Codex worktree、用户目录或历史迁移目录。记录只有在用户另行决定提交并推送后才具备跨设备持久性。

绑定由插件随附的 `scripts/configure-bindings.mjs` 写入。为每个项目重复传入 `--project "<别名>|<projectId>|<profileId>|<extensionId>|<workspaceRoot>"`；旧的四段格式仍可通过顶层 `--workspace-root` 兼容。配置器逐项目固化 Git common-directory identity。绑定文件位于业务仓之外，业务仓保持零 Harness 驻留。

当前 Engine Extension 声明：

| 伪命令 | 声明范围 |
|:---|:---|
| `h:engine full <version>` | 需求到 Delivery Receipt 的全流程 |
| `h:engine req <version> [full\|expand-to-plan\|plan-only]` | 全量需求审查、从扩展到方案、或只出方案 |
| `h:engine plan <version>` | 只生成版本方案与 Feature Work Graph |
| `h:engine implement <version>` | 按批准方案执行实现 Waves；`impl` 是别名 |
| `h:engine scope <version>` | 独立处置 scope drift |
| `h:engine quality <version> [full\|review-only\|recheck]` | 全量质量闭环、只审查、或 finding 复验；`qa` 是别名 |
| `h:engine docs <version>` | Docs Closeout |
| `h:engine review <version>` | 只读用户代码审核，不代替用户批准 |
| `h:engine deliver <version>` | 最终 Gate、Run 关闭与 Delivery Receipt |
| `h:engine status <version-or-run-id>` | 只读 Authority 状态 |
| `h:engine resume <version-or-run-id>` | ordinary resume，同 Epoch 新 Generation |
| `h:engine recover <run-id> [assess\|hard]` | 只读恢复评估或带独立批准的 hard recovery |

当前 Batch Production Extension 声明 `full`、`rules`、`launch`、`produce`、`quality`、`review`、`accept`、`close`、`status`、`resume`、`recover`。若安装时选择别名 `collection`，示例为 `h:collection quality B1 all` 和 `h:collection quality B1 game:chess`。

Hook 只解析单行、最长 512 字符、至多一个预设参数的信封，不启动流程，也不把参数交给 shell。未知项目、动作或预设、绑定与 Registry 不一致、Extension 摘要不匹配、前置证据不足都会 fail closed。用户明确说“只评估”“不要启动”或 `dry-run` 时，只返回解析结果和前置条件，不写 Authority；要做 Engine 只读源码质量审查则显式使用 `h:engine quality V3.8.4 review-only`。

CLI 的底层问题登记入口为 `issue record --input <json|-> --command-id <id>`。稳定故障码可通过 `correlation` 生成与观察时间无关的 incident fingerprint。不可变 Intake 写入后，使用 `issue triage` 另行记录带 revision、批准 Decision、关系和 resolution Evidence 的分诊状态；`issue list`/`issue status` 都是零写入查询。初始化类故障归类为 `deployment-incident`，不伪造 Defect Bundle 所需的 Descriptor 或 Authority 身份。

1. `run status` 读取 revision、epoch、generation、Feature、Lease 和 finding。
2. `conversation-visible` 是交互式默认：`run schedule` 生成 Dispatch，`run dispatch` 读取不可变 Packet，当前宿主创建可见子 Agent 后通过可信宿主适配器绑定；没有适配器时禁止改用原始 `run bind`。`run execute` 仅供用户请求与 Descriptor 双重显式 headless。
3. `run gates --scope final --fresh` 从 Project Descriptor 执行确定性最终 Gate，并始终把启动、输出和结束事件显示在可观察终端；无观察器时不启动进程。
4. 可见子 Agent 运行时，Operator 持续报告任务身份和状态并定期写 heartbeat；Agent 输出先进入 Evidence，再 submit。
5. Gate、finding 和 Decision 分别记录，不用聊天文本替代 Authority。
6. 所有 P0-P3 关闭、Profile Gate 满足后生成 close Receipt。

## 备份与恢复

一致性备份至少包含 Project Registry、Authority、Evidence、transaction journal、receipts 和 artifact pins。备份前停止写入或取得 Store 锁；恢复到新路径后先运行 doctor 和只读一致性检查，再允许调度。

所有显式 headless Runtime、Gate、构建、测试和打包子进程都会把 `TEMP`、`TMP`、`TMPDIR` 强制指向控制根内的受管目录，调用方配置不能覆盖。交互式 Agent Runtime 不启动子进程，而由宿主创建可见子 Agent。Feature 隔离副本、Gate 临时目录、测试夹具和 clean-room 副本在使用结束后删除；headless Runtime/Gate stdout、stderr 与事件在删除调试文件前写入内容寻址 Evidence。npm 使用控制根内 `.agent-harness-cache/npm` 与 `.tmp/npm-logs`，不写用户级缓存目录；受管测试和打包验证结束后会删除本轮缓存及空目录。

完整路径分类、生命周期和业务 Feature 输出的唯一例外见 [写入路径与清理策略](path-policy.md)。

进程异常时重新启动会处理 journal。revision 冲突应重新读取后重放同一个 command ID；不要手工编辑 Authority JSON。普通断线使用 `run recover` 废止 Transport；格式变化或旧系统迁移使用 Legacy Recovery，不能伪装成 resume。先使用显式 `agent-harness/extensions/legacy-compat` Extension 创建带摘要和容量限制的 Recovery Capsule，再用 `recovery capsule-verify --project <id> --run <id>` 生成绑定 Capsule、Importer、Run 和目标 Epoch 的内容寻址 verification Evidence。把该 Evidence ref 写入有有效期的 `live-hard-recovery` approved Decision 后，使用显式 `--capsule-verification`、`--decision-id`、`--expected-revision` 和 `--command-id` 执行 hard recovery。Capsule 只保留状态与 Evidence，拒绝源码、脚本、EXE、DLL 与 PDB；协调式 hard recovery 会先写入 Authority 回滚快照，必要时使用 `run recovery-rollback --snapshot-ref <ref>` 建立另一个安全 Epoch，旧完成态仍须重验。

如果文档冻结的旧状态根已经不存在，禁止创建空 Capsule 或把 dry-run Fixture 当成现场事实。只有项目所有者提交 `legacy-source-unavailable-clean-start` acknowledgement 后，才可使用 `recovery source-unavailable` 生成内容寻址迁移 Receipt；该 Receipt 固定声明 Capsule、legacy Authority import 与 live hard recovery 均不可用，唯一允许的后续路径是创建全新 Run。

hard recovery Decision 的最小输入如下；`context.expectedRevision` 是记录该 Decision 后、执行 recovery 命令时预期的 Authority revision：

```json
{
  "id": "approve-recovery-001",
  "actor": "project-owner",
  "decision": "approved",
  "action": "live-hard-recovery",
  "expiresAt": "2026-09-13T12:00:00.000Z",
  "context": {
    "projectId": "project-id",
    "runId": "run-id",
    "verificationRef": "evidence:<content-digest>:<metadata-digest>",
    "targetEpoch": 2,
    "expectedRevision": 7
  }
}
```

## 故障响应

Codex CLI Runtime 仅属于显式 headless 模式。它将自动审批和显式 sandbox 作为互斥启动模式：`approveForMe: true` 只允许与 `sandbox: workspace-write` 配置配对，并只向 CLI 传递 `--approve-for-me`；`approveForMe: false` 或未配置时只传递 `--sandbox <mode>`。不兼容配置在进程启动前 fail closed。Runtime Receipt 分别记录请求的 sandbox、审批模式和由 `thread.started` 确认的实际应用状态；CLI 在会话建立前退出时记录稳定的 startup failure，不得以缺少结果文件替代根因。交互式 Project 在到达这些参数处理前就会拒绝该 Runtime。

- Provider outage：停止新绑定，保留 Authority；可切换兼容 Runtime，逻辑 Attempt 不刷新。
- Gate 环境失败：记录环境失败，不伪造业务 finding；修复环境后使用相同 source/gate key 重试。
- stale/late result：拒绝提交并保留审计记录；基于当前 generation 重新 Dispatch。
- Artifact 变化：执行 impact rebase，只失效受影响 Feature。
- 存储损坏：隔离副本，从最后一致备份恢复并核对 Evidence digest；禁止直接覆盖现场。

## 发布与升级

发布候选包含源码、Schema、Profile、Extension、Codex Skills、插件 manifest、Hook、checksum 清单和 SPDX SBOM。`npm run build:release-candidate` 拒绝脏工作树，构建真实 tarball，核对 manifest/SBOM/包内容，在隔离控制根安装并验证插件、三个 Skill 与伪命令 Hook，最终写入 `.agent-harness-data/release-candidates/<version>/<archive-sha256>/`。升级前验证 Extension/Plugin/Profile 版本和存储迁移说明；先封存状态快照并在复制的数据根执行 canary。运行中 `artifact-rebase` 必须先记录有有效期的 `artifact-rebase` Decision，绑定当前 revision、旧/新制品摘要与影响 Feature 集合。密码学签名、发布、真实切换与旧内容删除由项目所有者批准和执行。缺陷上报、不可变修复和紧急 commit 绑定见 [缺陷、升级与回滚](maintenance.md)。

当旧 Authority 的 source-unavailable clean-start disposition 已获所有者确认后，可使用提交绑定候选执行现场无写入 Canary：

```powershell
node scripts/run-clean-start-canary.mjs `
  --candidate-receipt <absolute-release-candidate-receipt.json> `
  --cardworld-root <absolute-cardworld-root> `
  --collection-root <absolute-collection-root> `
  --output-root <absolute-agent-harness-control-subdirectory>
```

该命令拒绝覆盖已有控制根；它从候选 tarball 安装独立 Runtime，登记两个完整制品 Extension，建立外部 Project Registry 与全新 Authority，分别运行 `engine-delivery` 和 `collection-batch` Canary，并以运行前后全文件摘要证明业务仓零修改。输出 Receipt 同时绑定 source-unavailable Receipt、候选提交/制品摘要、Extension Registry、Project Descriptor 与两份关闭 Run Receipt。它不能替代已不可补做的真实 hard recovery。
