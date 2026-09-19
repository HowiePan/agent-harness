# Agent Harness 项目结构与文档体系整体改造方案

> 状态：2026-09-19 已获用户批准并实施。本文保留原批准方案与准出条件，实施结果以当前代码、现行设计和最终 Gate 记录为准；内部阶段不是独立发布版本。

## 1. 结论与目标

现有项目已具备 Workspace、版本化 Workflow、Extension、调度、证据、恢复、来源与记忆能力，但代码与文档仍保留多次演进的组织方式。`src/` 中平台合同、应用封装、具体流程和兼容业务代码分散；`docs/architecture.md` 仍以 Project 为顶层模型，而 Workspace 的现状散落在后续文档。现有插件 SDK 也不足以指导业务方从零开发一条流程并配置工作区。

整改后应让读者从目录直接分辨：**底座实现什么、通用流程能力是什么、每条流程自己实现什么、业务项目如何绑定、宿主工具如何接入**。文档需要一份自足的对外项目说明、一份现行整体设计、每条流程的设计文档、可执行的业务接入指南，以及与代码相符的参考手册。Skills 指导开发动作；Schema、静态检查和命令级闭环执行硬约束。

本次是结构、边界和接入体验整改，不借搬迁目录改变 Kernel Authority、Run、Workflow、Workspace、Extension 的既有语义。真实业务 Run、旧 Harness 状态、Git commit/tag、外部发布和旧文件清理由各自的既有 Gate 决定。

## 2. 目标架构与代码目录

建议目标如下。名称表达职责，不以当前业务项目或 Codex 命名通用流程；具体文件划分应以依赖盘点为依据，避免机械移动造成新的“大杂烩”目录。

```text
src/
  kernel/                 Authority、事务、Evidence、Receipt、通用状态机
  platform/
    workflow/             定义校验、编译、实例准入、调度协调
    workspace/            Registry、成员项目、来源和执行目标绑定
    resources/            资源 Provider 合同与受管访问；memory 为首个实现
    extensions/           Pack 合同、安装与版本身份
    plugins/              插件 Host、合同与参考 Provider
    recovery/             通用恢复协议与协调
  flow-kit/               经证明跨流程复用的节点模板和策略原语
  flows/
    delivery-lifecycle/   交付生命周期能力
    batch-production/     批次生产能力
    requirements-design/  需求与设计整理
    knowledge-qa/         知识问答
  application/            createHarness、Plan、预检、执行服务的装配
  interfaces/cli/         workspace、workflow、run、source、memory 等命令处理

integrations/
  codex/                  Codex 命令、可见宿主与插件适配
  legacy-consumers/       现有业务专属绑定与兼容实现
```

依赖方向为 `interfaces/integrations → application → platform/flows → kernel 公共合同`；Kernel 不反向导入流程、供应商、模型或业务项目。Flow 通过公开的平台合同使用编译、来源、资源和 Runtime 能力，不直接写 Authority。`src/app/harness.mjs` 与 `src/cli.mjs` 按服务/命令职责拆开，但 `createHarness()` 和现有 CLI/包导出先保留兼容入口。

`delivery-lifecycle`、`batch-production` 是拟议的中性目标目录名，不等于现有业务代码已通用化。现有 CardWorld Gate/脚本、Collection 游戏/批次专属规则须先逐项分类：真正通用的语义进入流程包；专属规则留在接入包。提取不成立时保留业务兼容实现，不能只改文件名便宣称通用。当前公开 Workflow ID、Profile ID、Extension 摘要及 `h:engine`、`h:collection` 命令绑定不因目录迁移而静默更名；未来若引入新 ID，按新制品和显式 Workspace Binding 切换，新旧 Run 分开。

## 3. Flow 包统一骨架

**统一骨架与依赖规则写入现行整体设计文档的“Flow 包”章节，不另建一份并列的规范文档。** 每条流程在此骨架上增加自己的阶段和节点：

```text
src/flows/<flow-id>/
  index.mjs                稳定公开入口，不承载实现
  extension.mjs            版本化 Extension Pack 组装
  planner.mjs              动作及输入到确定性 Plan 的接线
  graph/
    definition.mjs         节点、依赖、扇出、汇合
    branches.mjs           仅在存在条件分支时添加
  nodes/
    <stage>/               本流程自定的阶段分组
      <node>.mjs            节点声明、输入映射、结果约束
  contracts/
    index.mjs              输入、节点结果、输出合同出口
  policy/
    index.mjs              Profile、Gate、Decision 与关闭策略
  commands.mjs             仅在暴露命令入口时添加

docs/flows/<flow-id>/design.md
test/flows/<flow-id>/
```

`graph/` 只组合声明式节点图；`nodes/` 按阶段组织个性化节点，不把整条流程写进一个文件，也不把全部节点平铺。复杂节点可在所属阶段下再拆定义、映射和校验。小流程不建立空目录或无职责的占位文件。节点只返回可验证的 Intent/Feature/结果合同；Agent 推理由 Runtime 执行，Gate 与用户 Decision 仍按各自执行类别处理。

流程包不得导入另一流程包的 `nodes/`、`graph/` 或 `policy/`。语义和合同确实一致、已被至少两个流程使用的能力才进入 `flow-kit/`；名称相似或代码行数相同不是提取理由。Workspace 配置只能填写 Workflow 已开放的参数槽，不能改已发布制品的节点顺序、分支、Gate 或关闭语义。

每条流程的 `design.md` 必须说明：用途和不适用场景、ID/版本/制品、动作和输入输出、节点及分支图、节点结果合同、来源与资源权限、Profile/Gate/Decision/关闭条件、失败恢复、Workspace 可配置项，以及从命令启动到 `closed` 的验收场景。整体设计文档定义共同规则，流程设计文档只记录该流程的具体选择，不复制公共协议。

## 4. 已实现流程的迁移清单

对外材料必须介绍已经实现的流程，同时如实区分当前能力与目标中性结构：

| 对外能力名称 | 当前 Workflow ID | 当前实现及迁移要点 |
| --- | --- | --- |
| 版本交付 | `engine-delivery` | 需求、规划、实现、质量、文档、审核与交付的闭环；当前包含 CardWorld 专属 Gate/脚本。拆分通用生命周期与业务绑定，不把业务脚本带入中性包。 |
| 批次生产 | `collection-batch-production` | 批次 Barrier、批内依赖/冲突、共享能力归属、逐项验收与批次关闭；当前包含 Collection 游戏领域规则。通用 Barrier 与批次语义和具体游戏验收分开。 |
| 需求与设计整理 | `requirements-design` | 多需求文档和代码来源采集、检索、影响映射、需求/设计文档生成和复核。按采集、检索、文档、复核阶段拆节点。 |
| 知识问答 | `knowledge-qa` | 问题解析、记忆命中或来源检索、回答/澄清及反馈后的记忆处理。按解析、检索、回答、反馈阶段拆节点与结果合同。 |

中性 `feature-delivery` 和 `composable-workflow` 是 Profile/平台组合能力，不计作上述四条已实现的独立 Workflow。迁移每条流程前固定动作、Feature 图、Gate/Decision、输出与关闭行为的对照基线；新目录中的流程必须复现这些语义。旧 Run 固定的制品与 Authority 快照只用于恢复和审计，不能按新状态字符串自动升级。

## 5. 文档体系

目标是减少“现行方案、历史方案、实现记录”并列而状态矛盾的文档。先建立文档清单，标注唯一权威来源、仍有审计价值的历史记录、重复内容及过时说法；再迁移和修正引用，不按文件名直接批量删除。

```text
docs/
  README.md                       内部文档地图与现行/历史状态
  overview/
    project.md                    自足的对外项目说明
  architecture/
    system-design.md              唯一的现行整体设计；含 Flow 包统一规范
  guides/
    consumer-quickstart.md        从零接入业务项目的最短闭环
    flow-authoring.md             设计、开发、安装和验证 Flow
    workspace-configuration.md    多项目/来源/资源配置、增仓、回滚
  flows/
    <flow-id>/design.md           每条流程的独立设计说明
  reference/
    protocol.md                   版本化协议与不变量
    sdk.md                        Extension/Plugin/Resource Provider 合同
    commands.md                   CLI、宿主命令、状态和问题上报
  operations/                     安装、运行、故障、恢复与发布操作
  history/                        旧方案、审计、迁移、验收及决策证据
  plans/
    project-structure-refactor.md 本次待审核方案；完成后转历史记录
```

### 5.1 自足的对外项目说明

`docs/overview/project.md` 面向第一次接触项目的业务方、工具接入方和评审者。正文不包含“参见某文档”、关联文档链接或依赖其他资料才能读懂的缩写；`docs/README.md` 可以链接到它，但它本身保持独立。建议正文顺序：

1. 项目是什么、解决什么问题、适用与不适用的场景；
2. 已实现的公共能力：Workspace、Workflow、调度/失败重试、Evidence、Gate/Decision、恢复、插件、来源、记忆和实例；
3. **已实现的四条流程**：逐条给出用途、典型输入、主要阶段、输出、运行形态和当前业务绑定程度；显示当前真实 Workflow ID，不用拟议目录名伪装已完成的通用化；
4. 工作方式：Workspace 选择流程与资源，命令解析到 Plan，再经预检、Dispatch/Submission、Gate/Decision 到 Run 关闭；用一张图和一个完整示例解释；
5. 业务方如何接入：最小流程、工作区、来源、资源、安装绑定与启动步骤，给出可理解的命令样例；
6. 已实现与已验证的边界：区分合成 Canary 完整关闭、净室制品验证、真实宿主/业务现场尚未验收和未发布事项。

对外说明是若干现行文档的事实提炼，不承担详细协议、迁移日志或开发规范的职责。每次流程增删、公共能力变化或发布状态变化，必须同步更新它并核对示例命令，避免出现“未来设计”冒充“已实现”。

### 5.2 接入指南与历史文档

接入指南必须使用**仓库外的合成业务项目**完成完整示例：定义并安装 Extension/Workflow、编写节点结果合同和 Flow 设计文档、注册含多项目和来源的 Workspace、配置通用/项目资源、绑定宿主或合成 Runtime、通过命令启动并运行到 `closed`，随后演示增仓和版本更新。读者仅按指南操作应能复现，不需要从 Engine/Collection 的业务代码反推。

当前 `docs/architecture.md`、Workspace/Workflow 设计与实现记录中的**现行事实**合并进整体设计和参考文档；旧 `project-plan`、阶段性改造方案、设计审查及已完成 Gate 记录转入 `history/` 并标明时间与状态。审计证据、决策记录和迁移记录保留可追溯身份。`README.md` 缩为项目简介、状态、快速入口和文档地图，不再承担多份设计文档的全文摘要。迁移时更新包清单和内部引用，不留同时宣称“尚未实现”与“已实现”的现行页面。

## 6. Skills 与机器可执行约束

现有 `agent-harness-extension-author` 继续负责 Extension Pack、Runtime、Plugin 和 Provider 的版本与信任边界。增加两个边界明确的 Skill：

| Skill | 触发条件与工作程序 | 必须交付/验证 |
| --- | --- | --- |
| `agent-harness-flow-author` | 新建、修改、拆分 Flow；先确认是否需要新 Flow，再按整体设计的骨架建立阶段节点、合同、策略和 Extension；禁止跨 Flow 私有导入或在节点中写 Authority。 | Flow `design.md`、版本/摘要、正反向合同测试、命令级完整运行。 |
| `agent-harness-workspace-author` | 新建或变更 Workspace；检查 Workflow 精确绑定、成员项目、来源、执行目标、知识与其他 Resource 的权限、修订和回滚。 | Descriptor 与 Decision、无歧义启动、越权拒绝、增仓/撤权/回滚验证。 |

Skill 引用整体设计和可执行脚本，不另存一份会漂移的架构真相。跨宿主的硬约束不能只靠 Codex Skill：`AGENTS.md` 负责仓库级不变量，Schema 与 `npm run check` 校验目录/合同/公开导出/依赖方向/设计文档存在性，Conformance 和 Canary 验证行为。Skill 负责让使用它的 Agent 按正确顺序生成、检查和解释；机器检查负责使未使用 Skill 的改动也不能绕过可验证边界。对业务命名和“是否值得提取到 flow-kit”这类语义判断保留人工设计审查。

Skills 自身也要做正反样例演练：新建含自定义节点的 Flow 与含前后端项目的 Workspace 能按指引准出；跨 Flow 私有导入、缺结果合同、缺设计文档、越权资源绑定等反例在对应 Gate 失败。Skill、整体设计和检查器的版本/适用范围在交付时一致。

## 7. 实施顺序与兼容迁移

| 阶段 | 具体交付 | 阶段核对 |
| --- | --- | --- |
| A. 基线与映射 | 固定冻结提交、公开 `exports`/CLI/Workflow/Extension 身份、四条流程的命令及 Plan/关闭投影；给现有文档做“现行/历史/重复/保留证据”清单。 | 迁移前有可复现的四流程命令级闭环和无歧义的文件去向表。 |
| B. 权威设计与文档骨架 | 编写整体设计（含统一 Flow 骨架）、自足对外说明、文档首页与四条流程设计文档初稿；确定接入指南样例。 | 没有并列的现行架构权威；对外说明不依赖外链且准确区分已实现/待验收。 |
| C. 平台与接口分层 | 拆应用装配、CLI、通用 Workflow/Workspace/Resource/Plugin 能力；保留现有包子路径和 SDK facade。 | 公开 API/命令和错误边界兼容；Kernel 无业务或宿主反向依赖。 |
| D. Flow 包拆分 | 依次拆需求设计、知识问答、交付、批次流程；将业务专属绑定移至接入包，仅把证明可复用的能力放入 `flow-kit/`。 | 每条流程独立设计/升级，依赖规则通过；旧命令与已固定 Run 身份不静默变化。 |
| E. 接入与 Skills | 完成业务接入指南、仓库外合成样例、Flow/Workspace Skills 和对应机器检查；测试发现器支持 `test/flows/<flow-id>/`，不遗漏迁移后的用例。 | 新使用方不改 Kernel 即可接入；违反骨架/合同/权限的负样例失败。 |
| F. 文档收口与整体准出 | 将过时方案转历史、修复引用与发布清单；执行下述全套 Gate。 | 文档、代码、Skill 和制品描述的是同一现行架构；全部正向命令 Run `closed`。 |

阶段是内部实施顺序，最终一次性交付验收。不要先批量移动文件再补映射。目录变化会改变 Extension 制品摘要和发布清单：新制品须经正常安装/批准与 Workspace Binding 切换；旧 Run 保留原摘要。`package.json` 既有子路径、旧 CLI 参数和兼容别名使用 facade 或明确版本迁移，不能因内部重排直接消失。`scripts/run-tests.mjs` 目前仅发现 `test/` 顶层测试，阶段 E 必须调整发现范围并证明没有漏测。

## 8. 最终准出 Gate

1. **文档可用**：不打开其他文档也能从对外说明准确理解项目与四条已实现流程；业务方仅依接入指南建立新 Flow/Workspace；每条流程有与实现一致的独立设计文档。现行文档不存在相互矛盾的状态描述。
2. **结构与合同**：Flow 骨架、依赖方向、公开导出、Schema、Extension 摘要和 Workspace Binding 检查通过；证明旧 Workflow ID、命令别名、Run 快照和 Receipt 不被静默改写。反例检查能拒绝缺合同、跨流程私有导入、越权资源和流程选择歧义。
3. **命令级完整运行**：通过真实命令解析/绑定入口启动四条现有流程和新接入样例，经历 Plan、预检、Run、Dispatch/Submission、Gate/Decision 到 `closed`；覆盖单例/多实例、两个 Workspace 同一流程、同一 Workspace 多项目、通用/项目知识隔离、增仓覆盖失效、撤权与回滚。报告每条命令、Workflow/Workspace/Run、最终状态及关键证据。测试全绿不能替代此项。
4. **发布制品与边界**：`npm test`、Conformance、静态边界、净室安装、打包、残留及 `git diff --check` 通过；发行清单与文档/代码一致。真实 Codex Host 对真实业务仓的质量、真实旧 Run cutover、远端发布、Git 提交及旧文件清理仍按各自独立 Gate 处理。

**审核重点**：目录职责与四条流程的中性能力边界、对外说明是否足够自足、Flow 统一骨架与例外条件、Skills/机器检查分工，以及兼容旧身份的迁移顺序。审核通过后才按阶段开始整改。
