# G0 能力差异与架构归属矩阵

| 能力 | Engine 实际语义 | Collection 实际语义 | 处置 | V1.0.0 归属 |
|:---|:---|:---|:---|:---|
| 权威写入 | Run/Stage/Lease/Submission 持久化 | Round/Item/Lease/Dispatch 持久化 | `adapt` | Kernel + Storage Provider |
| 原子性 | 临时文件、rename、稳定 JSON | 普通 `writeFile` | `adapt` / `reject-defect` | Kernel Storage Transaction |
| 调度单元 | Feature Work Unit | 当前常为 scenario/work item | `supersede` | 统一 Feature；scenario/step 不单独刷新 Lease |
| Feature 内步骤 | 同一 Agent 串行 | 未形成统一合同 | `preserve` / `adapt` | Work Graph Primitive |
| 并发 | Feature DAG + conflict graph | 游戏轮转 + maxAgents | `adapt` | Conflict Scheduler + Profile Policy |
| 十游戏推进 | 不适用 | 同批约十款并行，阻塞释放槽 | `preserve` | Collection Policy |
| 批次 Barrier | 不适用 | Bn closed 且用户发车后才允许 Bn+1 | `preserve` | Batch Barrier Primitive + Collection Policy |
| 共享能力 owner | 契约/路径冲突隔离 | 跨游戏唯一 capability owner | `preserve` | Ownership Primitive + Collection Policy |
| Artifact pin | source/artifact digest | Engine version/API/ABI/checksum/lock revision | `adapt` | Artifact Provider + Artifact Pin Primitive |
| Evidence | 受管路径、workspace digest、Gate | 多数为路径数组 | `adapt` | Content-addressed Evidence Registry |
| Output path | Dispatch 唯一管理路径 | 可由 CLI 覆盖 | `reject-defect` | Kernel Path Authority |
| 质量 | 当前 Epoch P0-P3 全阻断 | 历史允许 debt；目标已改为全阻断 | `supersede` | Review Epoch Primitive + Profile Policy |
| User decision | 代码审核/准出 | Game/Batch 用户验收与发车 | `preserve` | Decision + Profile Policy |
| 恢复 | generation/Epoch/Attempt budget | Round resume 回收 lease | `adapt` | Kernel Recovery；专用 Importer |
| Legacy Schema | T1/T2 | M2/B1，Round 0.2/0.4 | `legacy-only` | 两个 Legacy Importer |
| Agent transport | 固定 Codex 对话 transport | 固定对话内子 Agent | `supersede` | Agent Runtime Plugin |
| 模型选择 | 隐含于外部调度 | 隐含于外部调度 | `adapt` | Model Router Plugin |
| 工具能力 | Engine CLI/Gate 直接组合 | pnpm/黑盒脚本直接组合 | `adapt` | Tool Broker + Gate Executor Plugin |
| 最终报告 | Authority/Receipt 投影 | Round 中文阶段报告 | `preserve` | Receipt Renderer；Profile 投影 |
| 业务仓状态 | `.harness/engine` 默认驻留 | `runs/`、review/evidence 驻留 | `supersede` | 外部 State/Evidence Root |

## 结论

1. 两条流程共享可靠性 Kernel、插件合同和流程原语，不共享业务状态机。
2. Engine Harness 是 Kernel 行为的主要参考实现，但其 CardWorld/Codex/本地目录假设不能进入公共合同。
3. Collection Harness 是 Batch/Game/Artifact/用户验收语义的主要来源，但其 Round 存储和调度实现不作为兼容基线。
4. `Game`、`Batch`、`Rule Readiness` 等术语只能存在于 Collection Profile/Policy、Descriptor、Importer 和报告投影。
5. 第三个中性项目不需要的能力不得进入 Kernel。
