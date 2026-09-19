# G0 实现清单与来源摘要

**审计日期**：2026-09-12  
**模式**：只读 Characterization；未启动、恢复或迁移任何真实 Run

> 本清单是不可变历史证据。列出的旧目录及摘要不构成后续源码依赖；V1.0.0 的维护只使用本仓库协议、测试 Fixture、Gate Receipt 和合成缺陷包。

## 输入快照

聚合摘要按“相对路径 + 单文件 SHA-256”的有序清单再次计算 SHA-256，用于标识本次审计输入，不代表 Git 提交身份。

| 输入根 | 文件数 | 字节数 | 聚合 SHA-256 |
|:---|---:|---:|:---|
| `tools/agent-harness` | 94 | 1,125,394 | `1D24BAF0216FA15CCD5017524A70C5A4FF2C155B0736A79531A650EA1E42229B` |
| `tabletop-collection/scripts` | 11 | 87,824 | `D8402E0916D05386531EF3B318D41588051F81484795E65EB7E85A1BAF17CD21` |
| `tabletop-collection/packages/game-harness` | 9 | 64,959 | `C7402B0AB6DC0E44F4D4491A42E9F51DBCB91F853C19ACEEF0B6C2676C0645F3` |
| `tabletop-collection/docs/harness.md` | 1 | 21,010 | `00137734BD3732293AB3A624E5403C79C5110F4ACBD39DF9F2BC36F8656FCB6F` |
| `tabletop-collection/docs/batch-development.md` | 1 | 27,306 | `6D4B5C2ACF0D00B1792E3A42925A03C953D9FB5F7F144175029F64F9E27989F7` |
| `tabletop-collection/runs/B1/rounds/B1-R001` | 2 | 128,753 | `8476F8ADC7FFFBC8FCD5036B99CC51EB0352B69CF1501D9B023E7FEE838113B9` |

## Engine Harness Characterization

实际实现已具备可复用的可靠性经验：

- Execution Kernel 统一 Requirement、Development、Quality 的 Run/Stage/Lease/Submission/Attempt；
- Packet hash、generation、agent identity 和 transport receipt 共同绑定 Lease；
- ordinary resume 废止活动 Lease，hard recovery 建立新 authority 并保留稳定预算；
- 原子文件替换、稳定 JSON、workspace source digest、受管输出路径和 Gate cache；
- Feature 依赖与路径/符号/契约/生成物冲突图；
- 当前 Quality Epoch 的 P0-P3 全量阻断；
- 最终报告从持久化状态与 Receipt 投影。

同时存在必须解除的项目耦合：

- 协议名、错误消息、目录和默认状态根仍以 Engine/CardWorld 为中心；
- Kernel 直接依赖固定的对话内 Agent transport 白名单；
- Pipeline Adapter、业务工作流与 CLI 在同一包内紧密组合；
- 本地文件存储合同没有形成可替换 Storage Provider SDK；
- 运行时、模型、工具、Prompt Codec 尚未成为完整的版本化插件集合。

## Collection Harness Characterization

实际实现表达了独有业务语义：

- Rule Readiness、Game Pack、Batch、Round、Game Acceptance、独立 Review、用户验收和 Collection Release；
- 单款阻塞不终止同批其他工作；
- 游戏 worker、共享 capability owner 和中央 integration owner 的所有权隔离；
- Engine artifact identity 绑定 version/API/ABI/checksum/lock revision；
- Round 按游戏轮转选择可执行工作，并保存中文阶段报告。

确认的实现缺口：

- `scripts/harness.mjs` 在读取、校验和报告路径中硬编码 B1；
- `scripts/harness-round.mjs` 与 `packages/game-harness/src/round.ts` 维护重复 Round 状态机；
- Round 写入直接使用 `writeFile`，缺少 expected revision、command ID 和原子事务；
- Result 命令允许 `--output-file` 覆盖 Dispatch 管理路径；
- TypeScript Runtime 声明 heartbeat，但命令面明确拒绝 heartbeat；
- 现存 B1-R001 为 Round `0.2`，当前代码创建 `0.4`，需要 Legacy Importer 分类；
- Round 调度按游戏公平轮转，但尚未使用完整 Feature conflict graph；
- Evidence 以路径为主，缺少统一内容寻址、源码快照和权限回执。

## 代表性运行事实

只读解析 `B1-R001` 得到：

- Round/Report 版本：`0.2`；
- 终态：`all-remaining-blocked`；
- 工作项：68；完成 52；阻塞 16；
- Lease：3；`maxAgents=3`；
- Report evidence 路径记录：55；
- 该记录证明混合完成/阻塞和局部继续语义，但不能直接作为 V1.0.0 当前完成证据。

## 审计边界

- 没有修改两套旧 Harness；
- 没有运行 B1、V3.8.4 或任何旧 Run；
- 没有把旧 `completed`、`approved` 或 evidence path 升级为新 Authority；
- 源输入发生变化时，后续 Recovery Inventory 必须重新计算摘要。
