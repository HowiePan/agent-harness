# 流程节点、分支、扇出与循环

Workflow Definition 是版本化不可变数据。Workspace 和项目配置只能选择它开放的动作与参数槽，不能在接入时改写图。

Node、Feature、typed output、分支和 repeat 的逐字段定义见[配置 API](../reference/configuration-api.md#5-workflownodefeature-与循环)。

## 路线和节点

`routes.<route-id>` 是按声明顺序排列的节点数组。节点至少包含：

- `id`：路线内唯一节点 ID；
- `template`：已批准 Extension 提供的 Feature 模板；
- `dependsOn`：可选，只能引用当前节点之前的节点；
- `forEach`：可选，引用 Planner 提供的命名集合。

编译结果是 Feature DAG。一个 Feature 内的 Step 默认由同一 Agent 串行执行；Feature 之间同时满足依赖、冲突键、Lane 和并发预算后才可并发。`forEach` 集合必须非空、元素唯一，单集合最多 100 项。上游和下游使用相同集合时按索引依赖；否则下游汇合到上游全部展开项。

## 类型化输出与分支

节点通过 `metadata.outputPorts` 声明 `portId → schemaId`，Submission 必须返回完全匹配的端口。分支规则包含 `nodeId`、`portId`、`schemaId`、`path`、`equals` 和待追加 Features。一次结果至多匹配一条规则；无匹配或多匹配都失败。每个 Run 最多 32 条分支规则，每条最多追加 20 个 Feature，整个 Run 最多 100 个 Feature。

## 有界循环

一般循环使用 Profile 的 `repeats`，而不是建立环形 `dependsOn`：

```json
{
  "id": "refine-until-ready",
  "nodeId": "review",
  "portId": "review",
  "schemaId": "document-review-v1",
  "path": "passed",
  "until": true,
  "maxIterations": 3,
  "onExhausted": "attention-required",
  "features": ["<版本化 Feature 定义>"]
}
```

每轮 Body 会得到新的 Feature ID，并依赖上一轮终点，因此 Authority 内始终是可审计 DAG。限制为最多 16 条 repeat rule、每条 1–20 轮、每轮最多 20 个 Feature，且总 Feature 数仍不得超过 100。达到 `until` 后才继续普通分支；耗尽预算返回 `WORKFLOW_REPEAT_EXHAUSTED`，不得静默继续。

质量修复循环是专用策略：只读质量检查提交 Finding，Core 追加路径受限的修复 Feature；修复完成后追加新的全量只读复审。旧 clean review 在 Source digest 变化后失效。它不是图中的静态回边，也不能用自然语言状态代替 Finding 和 Submission。

## 不支持的配置

- 节点依赖后续节点或形成 `A → B → A`；
- 无最大轮数的 `while`；
- 以模型自由文本选择分支；
- 在 Workspace 中替换节点模板或关闭规则；
- 让 Extension 或节点直接写 Kernel Authority。
