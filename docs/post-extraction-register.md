# 仓库抽离后修复与验证台账

**建立日期**：2026-09-13  
**当前判定**：Local Clean-start Cutover Ready；RCV、本地候选制品和两类制品绑定 Canary 完成；远端发布延期，Production hard recovery 不可补做
**适用边界**：本台账中的“迁移后”指 `agent-harness` 源码进入独立上游仓库之后、任何业务入口切换和旧 Harness 删除之前。

## 一、已经满足的仓库抽离条件

- 运行时、测试、打包和 Skill 不读取 CardWorld 或 tabletop-collection 的旧 Harness 源码、文档或 Skill；
- CardWorld 与 Collection 的兼容知识已经冻结为独立仓库内的脱敏 Characterization Fixture、Importer 合同和 G0 审计制品；
- 默认组合不加载业务 Consumer、供应商 Runtime 或 Legacy Importer；差异能力通过 Extension/Profile/Descriptor 显式装载；
- npm tarball 可在独立 Standalone Control Root 安装、自举、登记 Extension，并跨进程恢复安装回执；
- 全量测试、clean-room、pack dry-run 和残留扫描已有本地通过记录；旧 Harness 目录没有因本项目开发被修改。

这些条件足以把源码提交到独立仓库。后续修复只能在独立 `agent-harness` 上游完成，不得重新复制或参考业务仓中的旧 Harness 实现。

## 二、仓库抽离后已完成的 Recovery 修复

以下项目已在独立仓库使用合成 Fixture 完成，不依赖旧 Harness；它们仍是正式 V1.0.0 发布和真实 hard recovery 的持续回归条件。

| ID | 级别 | 状态 | 问题 | 关闭条件 |
|:---|:---|:---|:---|:---|
| RCV-001 | P0 | Complete | Recovery Capsule 先复制到受管 staging，assessment 与 manifest 只读取 staging，并复核复制前、staging 和复制后摘要 | `test/recovery-capsule.test.mjs` 源变化和 staging 一致性测试 |
| RCV-002 | P0 | Complete | Capsule 验证严格校验 Schema、顶层布局、assessment、逐文件记录、计数、大小和全部摘要 | manifest/assessment/payload/totalBytes 篡改负向测试 |
| RCV-003 | P0 | Complete | `hardRecover()` 只接受内容寻址 verification Evidence；Receipt 绑定 Capsule、Importer、source/assessment digest、project/run 和目标 epoch，执行前再次完整验证 Capsule | Recovery verification Schema、Evidence 与 Coordinator 测试 |
| RCV-004 | P0 | Complete | live hard recovery 只能经 Coordinator 调用，并强制已记录的 approved Decision、有效期、上下文、expected revision 和稳定 command ID | 缺失、否决、过期、错配及幂等测试 |
| RCV-005 | P1 | Complete | Legacy inventory 遇到 symlink、Windows junction 或不支持的文件系统节点时显式 fail-closed | 跨平台 link/junction 测试 |
| RCV-006 | P1 | Complete | 已覆盖链接、并发变化、三类篡改、严格 Schema、Decision、command 重用和上下文校验 | `npm test` 88/88 通过；最终全套准出结果见验收记录 |

RCV 修复已重新生成 `release-manifest.json` 与 `sbom.spdx.json`；正式 G6 候选仍须按验收记录重跑全部准出命令并取得远端证据。

## 三、独立上游仓库建立后的发布验证

| ID | Gate | 状态 | 验证项 | 证据 |
|:---|:---|:---|:---|:---|
| PUB-001 | G6 | Complete | 在独立仓库形成首个提交并配置 `https://github.com/HowiePan/agent-harness.git` | 首次 Repository Extraction 基线提交推送至 `origin/main`；提交摘要由远端分支记录 |
| PUB-002 | G6 | Complete | 项目所有者于 2026-09-13 选择 `UNLICENSED / all rights reserved` | `LICENSE`、`package.json`、release manifest 与 SBOM 一致；公开可见性或包分发不授予公共许可证 |
| PUB-003 | G6 | Deferred by Owner | GitHub Actions 在 Windows 与 Ubuntu、Node 22 上通过 check、全量测试、clean-room、pack 和 residue | 最新远端 run 仍失败；项目所有者决定暂不处理远端 CI/发布，不得标记 Complete |
| PUB-004 | G6 | Local Complete | 干净提交上的 `build:release-candidate` 构建真实 tarball，校验 release manifest、SBOM、包内容与完整性摘要 | 提交 `1961e578...` 的 archive SHA-256 为 `85c3e39a...`，Release Candidate Receipt 为 `f3fe8233...` |
| PUB-005 | G6 | Local Complete | 从实际候选制品安装 Codex 插件和两个 Skills，并验证引用只落在制品内 | 候选构建器的隔离安装、插件结构、两个 Skill 入口及相对引用探针全部通过 |
| PUB-006 | G6 | Local Complete | 在独立控制根复验路径政策：不写 `%TEMP%`、`tmpdir()`、C 盘绝对输出，不遗留 `.tmp`、缓存、EXE 或 PDB | clean-room、path/residue 测试本地通过；远端双平台证据并入 PUB-003 |
| PUB-007 | G6 | Local Complete | 复验受管输出容量、失败清理 Receipt、required OS Sandbox fail-closed 和 Collection 10 Feature 物理并发 | Harness Conformance/Canary 已通过；CardWorld engine-verify 与 Collection check:ci/cleanroom 通过且业务树保持干净 |
| PUB-008 | G6 | Local Candidate Complete | 以 Recovery Capsule 可变源缺陷完成脱敏 Defect Bundle、独立复现、上游修复、Descriptor/Run 制品升级、原 Run 续跑及失败回滚；Collection 复用协议执行回归 Canary | 固定 Bundle、升级/回滚测试、提交绑定候选 Receipt 与两类制品 Canary 已通过；仅远端 CI/发布部分延期 |

## 四、真实业务切换前后的现场验证

| ID | Gate | 状态 | 验证项 | 通过条件 |
|:---|:---|:---|:---|:---|
| CUT-001 | G7 | Disposition Complete | 对 CardWorld 和 Collection 的指定旧状态根执行最后一次只读 assessment | 两个根均确认不存在；项目所有者已承认旧事实不可恢复，历史 dry-run 不作为新现场 Evidence |
| CUT-002 | G7 | Hard Recovery Unavailable | 分别创建真实 Recovery Capsule | 源缺失后不可补造 Capsule；两份内容寻址 `legacy-source-unavailable` Receipt 已固化并强制 clean-start |
| CUT-003 | G7 | Complete | 在隔离 Data Root 建立新 Authority | 项目所有者确认放弃两类旧 Authority；提交绑定候选制品已在独立控制根建立 Project Registry 与两套全新 Authority |
| CUT-004 | G7 | Complete | CardWorld 与 Collection 分别执行目标 Profile Canary；Collection 验证批间 Barrier、Feature 并发和安全合并 | 原生检查已通过；候选制品上的 `engine-delivery` 与 `collection-batch` clean-start Run 均关闭，业务摘要前后一致 |
| CUT-005 | G7 | Protocol Complete / Site N/A | 使用封存快照演练 rollback，再回到可继续验证的新 epoch/generation | 合成 hard-recovery rollback 与 PUB-008 artifact rollback 已通过；现场无 Capsule，不能生成真实 rollback Receipt |
| CUT-006 | G8 | Local Candidate Complete / Publish Deferred | 业务入口改为调用独立制品和外部 Project Registry，业务仓不保存 Harness 实现、状态、Prompt、Skill 或技术文档 | 候选 tarball 已在外部控制根实际安装并调用，状态零驻留；已发布 Registry 制品入口按所有者决定延期 |
| CUT-007 | G8 | Local Complete | 旧目录不可访问后继续运行和维护 | 两个旧根缺失时原生检查通过，且独立候选制品已完成两类 Harness Run Canary；Receipt `0bdd46c2...` |
| CUT-008 | G8 | Not Retroactively Verifiable | 经过观察期后只判断旧 Harness 是否具备删除资格 | 目标已先行不存在，无法补做删除前 Capsule/rollback 资格判断；不得事后标记 Approved |
| CUT-009 | G8 | User Only | 删除、移动、归档或清理旧 Harness | 用户已报告 CardWorld 旧 Harness 由其自行移除；这不自动覆盖 Collection 或其他目标，也不替代 CUT-006～008 的运行验证 |

## 五、运行入口与维护闭环修复

| ID | 级别 | 状态 | 问题 | 关闭条件 |
|:---|:---|:---|:---|:---|
| OPS-001 | P1 | Complete | 全局 Registry 数量被误当作绑定项目 readiness | `doctor` 对准确 Project/Profile/Extension/workspace 做纯读取校验，其他项目不能造成假阳性 |
| OPS-002 | P1 | Complete | 绑定成功但活动数据根未受控投产 | 零写入 Bootstrap Plan、approved/idempotent/recoverable Apply 和最终项目级 readiness Receipt |
| OPS-003 | P1 | Complete | 多项目别名共享单一 workspaceRoot | 每个别名独立保存并验证 workspace/common-directory identity，兼容旧四段绑定 |
| OPS-004 | P2 | Complete | `project list`/`run status` 可能加载 Extension；Gate cache metrics 隐式建目录 | Core 读路径不导入 Extension，missing cache 返回 0 且零写入，负向 Extension 记录回归通过 |
| OPS-005 | P2 | Complete | Issue Intake 无关联、分诊和关单协议 | 稳定 incident fingerprint；独立 revisioned Triage 状态支持 duplicate/successor/fixed-by 与 resolution Evidence |

`AH-20260913-AB2DBEDCE37B` 与 `AH-20260913-DA8CA73021DB` 属于同一首次观察，前者已标记为 duplicate；`68a9e4c` 关闭了只读命令隐式初始化的代码根因。`AH-20260913-6747BDDA11DB` 作为后继部署 Incident，在活动数据根完成受批准 Bootstrap、精确项目级 readiness 通过且确认未创建 Run 后关闭。全量 108/108、clean-room、pack 和 residue 均已通过；真实业务 Run 仍须单独启动并通过对应 Gate。

## 六、状态词汇

- **Repository Extraction Ready**：允许把 `agent-harness` 提交到独立仓库；当前已达到。
- **Local Release Candidate Ready**：RCV、PUB-004～008 的本地部分与提交绑定候选 Receipt 已关闭；当前已达到。
- **Release Candidate Ready**：还要求 PUB-003 远端双平台 CI 通过；项目所有者已明确延期，当前未达到。
- **Production Cutover Ready**：真实 Capsule、隔离恢复、Canary 和 rollback 均通过且获得用户切换批准；现场源已不存在，因此该 hard-recovery 状态无法达到。
- **Local Clean-start Cutover Ready**：源不可用 Receipt、所有者状态损失确认、本地候选制品绑定、全新 Run Canary 和外部入口 Evidence 全部完成；当前已达到，内容寻址 Receipt 为 `0bdd46c261dfb939daccf9fa7bde404a79882a58ea3a21a4ebe4e9894581bc51`，完整证据只保存在外部 `.agent-harness-data`，避免把制品摘要回灌制品本身。
- **Clean-start Cutover Ready**：若以 Registry/Release 作为正式分发入口，仍须恢复 PUB-003 并完成签名、tag、Release/Registry 发布；当前按所有者决定延期。
- **Legacy Deletion Approved**：用户对准确目标另行明确授权；当前未达到，也不能由 Harness 自动推导。

本台账是仓库抽离后的继续工作 Authority。若新增问题，必须追加稳定 ID、级别、关闭条件和证据，不得用“迁移后再看”替代可验证条目。
