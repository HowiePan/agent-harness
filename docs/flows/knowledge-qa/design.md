# 知识问答流程设计

**Workflow：** `knowledge-qa@1.0.0`；**Profile：** `composable-workflow`；**动作：** `ask`。适用于同一 Workspace 内按项目权限复用知识、必要时检索代码和文档回答问题。

## 节点、分支和结果

```text
parse → lookup ─命中→ answer
               未命中→ search ─证据充分→ answer
                              证据不足→ clarify
```

`parse` 返回 `question-v1`；`lookup` 返回 `memory-match-v1`。`search` 返回带证据的候选；`answer` 返回有非空结论和证据的 `qa-answer-v1`；`clarify` 返回具体问题的 `qa-clarification-v1`。分支条件由 `graph/branches.mjs` 的结果端口决定，不能由自然语言状态暗示。错误答案反馈使该会话的候选临时排除，再以新问题修订重新运行；经核验的正确答案才可提议进入持久知识。

Workspace 通用、项目、流程、来源和会话记忆分层，前后端专有知识不跨项目泄漏。记忆命中也要检验来源覆盖摘要；来源增仓或变更可触发复核。来源读取和资源访问每次受当前授权检查。没有答案且证据不足时走澄清分支，不编造结论。失败重试保留会话/问题修订身份；Run 恢复遵守原快照与 Epoch 规则。

Workspace 可选项目范围、来源和资源绑定、会话与问题修订，不能更改分支谓词或端口合同。同一流程可在多个工作区运行，记忆按工作区隔离。

## 命令级验收

`npm run workspace:canary` 解析 `h:alpha flow knowledge-qa ask audit-trail --project alpha-front` 及另一工作区的相同流程命令，覆盖记忆命中/检索、项目隔离、增仓覆盖失效、撤权和回滚，并要求每条正向 Run `closed`。`npm run workflow:canary` 覆盖回答与澄清路径。
