# 仓库抽离后修复与验证台账

**建立日期**：2026-09-13  
**当前判定**：Repository Extraction Ready；Production Cutover Not Ready  
**适用边界**：本台账中的“迁移后”指 `agent-harness` 源码进入独立上游仓库之后、任何业务入口切换和旧 Harness 删除之前。

## 一、已经满足的仓库抽离条件

- 运行时、测试、打包和 Skill 不读取 CardWorld 或 tabletop-collection 的旧 Harness 源码、文档或 Skill；
- CardWorld 与 Collection 的兼容知识已经冻结为独立仓库内的脱敏 Characterization Fixture、Importer 合同和 G0 审计制品；
- 默认组合不加载业务 Consumer、供应商 Runtime 或 Legacy Importer；差异能力通过 Extension/Profile/Descriptor 显式装载；
- npm tarball 可在独立 Standalone Control Root 安装、自举、登记 Extension，并跨进程恢复安装回执；
- 全量测试、clean-room、pack dry-run 和残留扫描已有本地通过记录；旧 Harness 目录没有因本项目开发被修改。

这些条件足以把源码提交到独立仓库。后续修复只能在独立 `agent-harness` 上游完成，不得重新复制或参考业务仓中的旧 Harness 实现。

## 二、仓库抽离后必须先修复的问题

以下项目可以在独立仓库使用合成 Fixture 完成，不依赖旧 Harness；但必须在正式 V1.0.0 发布和真实 hard recovery 前关闭。

| ID | 级别 | 状态 | 问题 | 关闭条件 |
|:---|:---|:---|:---|:---|
| RCV-001 | P0 | Open | Recovery Capsule 对可变源目录分别执行 inventory、assessment 和 copy，缺少单一一致性快照与复制后复核，可能混合不同时间点的事实 | 先复制到受管 staging，再以 staging 为唯一 assessment/manifest 输入；复制前后源变化必须检测并 fail-closed |
| RCV-002 | P0 | Open | Capsule 验证只核对部分摘要，没有重新计算 assessment 摘要，也没有严格比较 `manifest.files`、`totalBytes` 和实际 payload | 对 manifest、assessment 和逐文件记录执行完整 Schema 与摘要复算；任何未知字段、计数、大小、路径或摘要不一致都拒绝 |
| RCV-003 | P0 | Open | `hardRecover()` 接受普通 assessment JSON，没有强制绑定刚刚验证过的 Capsule/Assessment Receipt | hard recovery 输入必须引用已验证且与 importer、source digest、project/run 和目标 epoch 绑定的不可伪造验证结果 |
| RCV-004 | P0 | Open | live hard recovery 的 API/CLI 没有强制批准的 Authority Decision，和 Operator Contract 的用户审批边界不一致 | API 和 CLI 都要求批准 Decision、expected revision、稳定 command ID；拒绝缺失、否决、过期或上下文不匹配的 Decision |
| RCV-005 | P1 | Open | Legacy inventory 对 symlink/Windows junction 静默跳过，可能让 Capsule 被误认为覆盖完整现场 | 源清单遇到任何链接节点必须显式记录并 fail-closed；不得跟随或静默遗漏 |
| RCV-006 | P1 | Open | 当前测试只有 Capsule happy path 和可执行文件拒绝，没有覆盖以上完整性与授权故障 | 增加链接、并发变更、manifest/assessment/payload 篡改、Schema、Decision、重复 command 和 Capsule 上下文错配负向测试 |

修复完成后必须重新生成 `release-manifest.json` 与 `sbom.spdx.json`，重跑全部准出命令，并更新 V1.0.0 验收记录。当前 70/70 通过只能证明既有测试通过，不能关闭 RCV-001～RCV-006。

## 三、独立上游仓库建立后的发布验证

| ID | Gate | 状态 | 验证项 | 证据 |
|:---|:---|:---|:---|:---|
| PUB-001 | G6 | Complete | 在独立仓库形成首个提交并配置 `https://github.com/HowiePan/agent-harness.git` | 首次 Repository Extraction 基线提交推送至 `origin/main`；提交摘要由远端分支记录 |
| PUB-002 | G6 | Pending | 由项目所有者确定公开仓库许可证；当前 all-rights-reserved 文件不等同于开源授权 | 最终 `LICENSE` 与 `package.json` 一致 |
| PUB-003 | G6 | Pending | GitHub Actions 在 Windows 与 Ubuntu、Node 22 上通过 check、全量测试、clean-room、pack 和 residue | 远端 CI run 链接/摘要 |
| PUB-004 | G6 | Pending | 发布候选 tarball 从独立仓库构建，校验 release manifest、SBOM、包内容、完整性摘要和可选签名 | 不可变制品摘要与发布 Receipt |
| PUB-005 | G6 | Pending | 从实际发布制品安装 Codex 插件和两个 Skills，并验证引用只落在制品内 | 插件/Skill 验证与安装探针 |
| PUB-006 | G6 | Pending | 在独立控制根复验路径政策：不写 `%TEMP%`、`tmpdir()`、C 盘绝对输出，不遗留 `.tmp`、缓存、EXE 或 PDB | path/residue Receipt |
| PUB-007 | G6 | Pending | 复验受管输出容量、失败清理 Receipt、required OS Sandbox fail-closed 和 Collection 10 Feature 物理并发 | Conformance/Canary Evidence |
| PUB-008 | G6 | Pending | 完成 Consumer-to-Upstream Defect Rehearsal：由 Card World 发现 Harness 缺陷，经脱敏上报、独立复现、上游修复、不可变制品升级、原 Run 续跑和失败回滚形成闭环；Collection 复用同一协议执行 Consumer 回归 Canary | Defect Bundle、上游 issue/commit、回归测试、release/Descriptor 摘要、升级与回滚 Receipt；详细合同见[缺陷、升级与回滚](maintenance.md) |

## 四、真实业务切换前后的现场验证

| ID | Gate | 状态 | 验证项 | 通过条件 |
|:---|:---|:---|:---|:---|
| CUT-001 | G7 | Pending Approval | 对 CardWorld 和 Collection 的指定旧状态根执行最后一次只读 assessment | 根路径、文件清单、摘要、时间点和操作者进入 Receipt；不读取旧源码/Skill |
| CUT-002 | G7 | Pending Approval | 分别创建真实 Recovery Capsule | RCV-001～RCV-006 已关闭；Capsule 完整验证并由用户控制保留 |
| CUT-003 | G7 | Pending Approval | 在隔离 Data Root 建立新 Epoch，旧 Lease/Dispatch/Agent 身份失效，旧完成态重新验证 | 新 Authority、Evidence 和 disposition 可追溯 |
| CUT-004 | G7 | Pending Approval | CardWorld 与 Collection 分别执行目标 Profile Canary；Collection 验证批间 Barrier、Feature 并发和安全合并 | 所有 P0-P3 关闭，最终 Gate 通过 |
| CUT-005 | G7 | Pending Approval | 使用封存快照演练 rollback，再回到可继续验证的新 epoch/generation | rollback Receipt 与后续一致性检查通过 |
| CUT-006 | G8 | Pending Approval | 业务入口改为调用独立发布制品和外部 Project Registry，业务仓不保存 Harness 实现、状态、Prompt、Skill 或技术文档 | 零驻留扫描与实际调用 Evidence |
| CUT-007 | G8 | Pending Approval | 暂停旧入口但不删除旧 Harness，模拟旧目录不可访问后继续运行、恢复和维护 | CardWorld/Collection 各自完成无旧依赖 Canary |
| CUT-008 | G8 | Pending Approval | 经过观察期后只判断旧 Harness 是否具备删除资格 | 无回滚依赖、Capsule 与新制品可恢复、用户收到准确目标清单 |
| CUT-009 | G8 | User Only | 删除、移动、归档或清理旧 Harness | 只能由用户另行明确决定；任何 Gate 通过都不会自动授权 |

## 五、状态词汇

- **Repository Extraction Ready**：允许把 `agent-harness` 提交到独立仓库；当前已达到。
- **Release Candidate Ready**：RCV 与 PUB 项（包括 PUB-008 跨仓维护演练）全部关闭，能够生成正式 V1.0.0 候选；当前未达到。
- **Production Cutover Ready**：真实 Capsule、隔离恢复、Canary 和 rollback 均通过且获得用户切换批准；当前未达到。
- **Legacy Deletion Approved**：用户对准确目标另行明确授权；当前未达到，也不能由 Harness 自动推导。

本台账是仓库抽离后的继续工作 Authority。若新增问题，必须追加稳定 ID、级别、关闭条件和证据，不得用“迁移后再看”替代可验证条目。
