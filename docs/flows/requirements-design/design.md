# 需求与设计整理流程设计

**Workflow：** `requirements-design@1.0.0`；**Profile：** `composable-workflow`；**动作：** `analyze`、`analyze-code`。适用于多份需求文档与多个代码仓共同分析，或仅从代码生成架构视图；不替代业务方对需求正确性的确认。

## 节点和结果

```text
analyze:      每份文档 ingest → normalize ┐
                                         ├→ 每个仓库 search → map(impact-map-v1) → 两份文档 → review
analyze-code:                          每个仓库 search → map(code-architecture-v1) → 两份文档 → review
```

`ingest` 返回带来源位置的 `source-facts-v1`；`normalize` 返回 `requirements-v1`；`search` 返回 `code-evidence-v1`。普通 `analyze` 的 `map` 返回同时绑定代码和需求的 `impact-map-v1`；不含需求输入的 `analyze-code` 改为返回 `code-architecture-v1`，其中必须包含 `modules`、`capabilities` 和 capability-to-path `mappings`，不得伪造 requirement。两份文档节点分别写入 Workspace 允许的输出路径并返回 `document-ref-v1`。`review` 检查两份文档和固定来源，返回通过的 `document-review-v1` 与 `memory-candidates-v1`；它不能绕过文档路径、证据或 P0–P3 质量规则。合同在 `contracts/`，节点按 `intake/`、`discovery/`、`documents/`、`review/` 阶段分组。

Plan 固定文档、仓库的 Source Manifest 和输出路径；实际读取受 Workspace 项目范围、Source Binding 与 Runtime 权限约束。记忆候选按资源权限处理，不能因节点输出自行升为已核验知识。没有来源、输出路径冲突、来源漂移或资源撤权时拒绝相关操作。失败可重试受影响 Feature；恢复保留原 Run 的来源/制品快照。

Workspace 可配置成员项目、来源集合、输出路径、Runtime 和记忆绑定，不得变更已发布图。单实例分析一个功能，实例集可并行分析多个功能；每个实例独立 Plan、输出与 Run。

## 命令级验收

`npm run workspace:canary` 解析 `h:alpha flow requirements-design analyze audit-trail`，在前后端项目和共享文档来源上生成两份文档、执行复核并关闭 Run。`npm run workflow:canary` 另验证多实例、来源及输出合同。两者均要求最终 `closed` 与可核查输出，测试全绿不能代替命令闭环。
