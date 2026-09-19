# 开发一条 Flow

先确认需求确实需要新的节点图；若只是换 Workspace 的来源、项目或执行目标，保留原 Flow。Flow ID、版本和制品摘要是运行身份的一部分，已启动 Run 不能静默改绑。

1. 在 `src/flows/<flow-id>/` 建立 `index.mjs`、`extension.mjs`、`planner.mjs`、`graph/definition.mjs`、按阶段组织的 `nodes/`、`contracts/index.mjs`、`policy/index.mjs`；有条件分支再建 `graph/branches.mjs`，有命令入口再建 `commands.mjs`。按整体设计的 Flow 包章节确定依赖方向。
2. 为每个节点定义输入来源、结果端口 Schema、证据和输出检查。Planner 只生成确定性 Plan，不启动进程、不写 Authority。Agent 推理交 Runtime，确定性检查交 Gate，人工确认交 Decision。
3. 使用版本化 Extension Pack 导出 Workflow、命令清单及 `pure-planner` operation。只能通过公开平台/flow-kit 合同复用能力；不得导入另一 Flow 的私有 `graph/`、`nodes/` 或 `policy/`。
4. 编写 `docs/flows/<flow-id>/design.md`，说明用途、动作、节点/分支、端口合同、权限、Gate/关闭、失败恢复、Workspace 参数及命令到 `closed` 的场景。
5. 做正反向验证：正确输入、重复命令、缺来源/结果合同、错误分支、越权路径和不兼容版本。`npm run check` 检查骨架/边界，`npm run test:conformance` 检查扩展合同，最后通过命令从 Plan 跑到 `closed`。更新公开导出、发行文件清单和对外流程介绍。

发布新制品后，先批准安装，再更新 Workspace Binding；旧 Run 使用其创建时固定的 Workflow 和来源快照。流程专属业务 Gate 应留在接入变体，不进入中性流程或 Kernel。
