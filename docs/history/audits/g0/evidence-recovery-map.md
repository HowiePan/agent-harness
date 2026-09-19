# G0 Evidence、质量与恢复映射

## Evidence 统一合同

V1.0.0 Evidence 至少绑定：

- project/run/epoch/generation/feature/dispatch/lease；
- source snapshot、changed files、允许路径与实际路径；
- artifact、policy、plugin set、toolchain 和 Gate specification digest；
- 内容 SHA-256、媒体类型、大小、创建者和保留策略；
- 可复用范围与失效原因。

旧 Engine Harness 的受管路径、workspace digest 和 Gate cache 采用 `adapt`；Collection 的纯路径 evidence 采用 `legacy-only`，必须在当前源码上重新验证后才能成为当前 Evidence。

## 质量收敛

两条 Profile 都使用：

```text
initial full sweep → P0-P3 triage → repair Feature waves
→ focused gates → fresh final full sweep
```

最终全扫仍存在任何 P0-P3 时，当前 Epoch 进入 `review-blocked`。known debt 只保存历史或非当前观察，不是准出通道。

## 恢复映射

| 旧来源 | 解析器 | 可继承内容 | 不可继承内容 |
|:---|:---|:---|:---|
| Engine T1/T2 | CardWorld Legacy Importer | 来源摘要、稳定问题根、审计事件、可重验线索 | 活动 Lease、Agent 身份、Packet、未重验完成结论 |
| Collection M2/B1 | Collection Legacy Importer | batch/game/item 线索、artifact identity、阻塞依据、运行日志 | Round Lease、path-only evidence、旧 approved/complete |

统一流程：

```text
read-only inventory → source digest → current facts
→ disposition → new epoch/generation → shadow → isolated canary
→ user-approved cutover
```

Disposition 仅允许 `verified-current`、`stale-revalidate`、`log-only`、`invalid`、`superseded`。即使分类为 `verified-current`，也必须生成 V1 Evidence/Decision，而不能复制旧状态字符串。

## B1-R001 判定

- Round/Report `0.2`：`legacy-only`；
- 52 个 completed：默认 `stale-revalidate`，不直接提升；
- 16 个 blocked 及 ECR 引用：`log-only` 或经当前 artifact 验证后重新分类；
- 3 个 Lease：`invalid`；
- maxAgents=3：历史运行参数，不限制 V1 的十游戏逻辑并行；
- 旧 evidence 路径：存在性仅作 inventory，内容重新寻址后才可注册。
