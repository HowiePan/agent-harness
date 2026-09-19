# 业务方接入：从工作区到关闭的 Run

仓库中的独立示例 Flow 位于 `examples/onboarding/source-brief/`。它以自己的 Extension、Planner、图、节点、合同和策略接入；命令 `h:alpha flow source-brief summarize audit-trail` 读取工作区允许的多项目来源，写出 `docs/brief.md`，返回 `document-ref-v1`，并在同一 Canary 中关闭 Run。业务方可据此替换节点与合同，无需修改 Kernel。

本指南用前端、后端、共享需求文档三个合成来源演示当前协议。Node.js 22+，在 Harness 项目根执行命令。合成执行由内存 Runtime 返回符合合同的结果，不调用真实业务仓或模型。

## 1. 运行完整样例

```powershell
npm run workspace:canary
```

脚本在临时控制范围内创建 `alpha`、`beta` 两个工作区。`alpha` 含前后端两个项目、三种 Source Binding、共享与项目级记忆、需求设计和知识问答两条精确 Workflow Binding；`beta` 使用同一知识问答流程但拥有独立来源和记忆。它还把两条旧业务流程显式转换成独立 Workspace。每条正向命令从 `parsePseudoCommand` 开始，经 `createWorkspaceLifecyclePlan`、执行预检、Runtime、Gate/Decision 到 `closed`。末尾 JSON 的 `runs` 数组给出命令、工作区、Workflow、项目范围、Run ID、Plan 摘要及最终状态；任何断言失败都会使命令失败。

最小读法：先看 `scripts/workspace-canary.mjs` 的 `makeWorkspace()`。Descriptor 必须声明 Workspace ID/别名、`extensions` 的精确摘要、`workflows` 的 ID/版本/制品摘要、`projects`、`sources`、`executionTargets`、`resources` 与 `policy`。`WorkspaceRegistry.register()` 需要注册 Decision 和 command ID。然后看 `runCommand()`：命令解析后从 Registry 取 Workspace，创建 Plan、执行预检，最后调用 `executeLifecyclePlan()` 并断言 `closed`。

## 2. 接入自己的流程

在 `src/flows/<flow-id>/` 或独立 Extension 包中创建公开入口、Extension、Planner、Graph、阶段节点、合同和 Policy；提供自己的 `docs/flows/<flow-id>/design.md`。节点结果端口必须有 Schema ID，输出路径和来源证据要由 Planner/合同核验。使用 `defineExtensionPack()` 声明版本、Workflow、命令清单与 `pure-planner` operation。安装制品时提供完整文件清单并使用批准的 Extension Registry 回执；Workspace 只绑定精确摘要。一个新流程样例可以从 `requirements-design` 复制组织方式，但业务节点、输入和合同应由自己的需求重新定义。

## 3. 配置工作区并启动

用业务仓之外的控制根保存 Descriptor 和状态。先注册 Extension，再创建含前后端项目的 Workspace，分别授权共享文档和项目仓库来源；执行目标只授权写文档的项目。记忆资源声明工作区通用空间与前后端项目空间，读写项目列表明确填写。将已安装 Flow 绑定到 Workspace，指定默认项目范围。多条 Flow 可同时绑定，命令必须显式选择其中一条。

```text
h:alpha flow requirements-design analyze audit-trail
h:alpha flow knowledge-qa ask audit-trail --project alpha-front
```

生产宿主应把命令解析结果传给 `createWorkspaceLifecyclePlan()`，要求真实执行预检，再交由已授权 Runtime 执行；合成样例的 `headless` Grant 仅用于 Canary。新增后端仓库时提交新的 Workspace 修订和批准 Decision，重新固定来源覆盖范围，再运行受影响的知识复核。回滚产生新修订，不能编辑 Registry 活动文件。`npm run check`、`npm run test:conformance` 与命令闭环同时通过后，才说明新接入满足结构、合同和跨层运行边界。
