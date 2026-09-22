# Source Brief 示例 Flow

`source-brief@1.0.0` 是独立定义、随本 Harness 包分发的示例流程，用于演示新业务方如何在不改 Kernel 的情况下接入。动作 `summarize` 只有 `brief` 节点：输入为 Workspace 授权的多项目 Source Manifest 和 `outputPaths.brief`，输出为带路径和摘要的 `document-ref-v1`。节点声明完整的 Node Task Contract（角色、目标、指令、类型化输入、步骤、约束、验收与证据），由 Prompt Codec 1.3 编译成 Agent 可执行任务；节点只读固定来源并向执行目标写一份简报。Planner 纯函数编译 Plan，质量 Gate 和关闭由 `composable-workflow` Profile 处理。

工作区可配置项目、来源、执行目标、Runtime、输出路径及资源，不能修改该节点的输出合同。`npm run workspace:canary` 使用 `h:alpha flow source-brief summarize audit-trail` 通过命令解析、Plan、预检、Dispatch/Submission 与关闭；断言生成文档且 Run 为 `closed`。
