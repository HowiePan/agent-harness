# V1.0.0 迁移准出 Gate

V1.0.0 将“仓库抽离就绪”“发布候选就绪”和“生产切换就绪”分开。仓库抽离只判断独立 Harness 是否已经不依赖旧源码并具备自举能力；抽离后仍须关闭 Recovery 完整性问题、形成远端发布证据，再执行真实 Capsule、现场切换和旧内容处置。详细台账见[仓库抽离后修复与验证台账](post-extraction-register.md)。

| 阶段 | Gate | 准出条件 |
|:---|:---|:---|
| 代码收口 | G0 差异基线 | 双轨审计冻结为历史、非规范性输入；后续开发不读取旧 Harness 源码或 Skill |
| 代码收口 | G1 默认去耦 | 默认入口无业务、模型供应商或 Legacy 注册；Extension Registry 校验 ID、版本和完整制品摘要，并由 Authority Decision 管理变更 |
| 代码收口 | G2 Operator/Skills | 工具无关 Operator Contract 与可安装 Codex 插件进入制品并通过结构验证 |
| 代码收口 | G3 Standalone Bootstrap | 源码和 npm 制品都从业务仓外的控制根启动；状态、扩展注册、临时文件和缓存不进入包目录或业务仓 |
| 代码收口 | G4 维护协议 | 缺陷包、版本绑定、存储迁移、升级快照和回滚规则有 Schema 与测试 |
| 代码收口 | G5 Cleanroom | 只复制 `agent-harness`，旧业务 Harness 不可访问；全量测试、打包安装、路径和残留检查通过 |
| 抽离后修复 | RCV Recovery 完整性 | 修复一致性快照、完整验证、Capsule 绑定、Authority Decision、链接拒绝和负向测试 |
| 迁移执行 | G6 上游发布与维护闭环 | 配置独立远端、许可证、CI、签名与不可变发布，并完成 Card World 发起的 PUB-008 跨仓缺陷修复演练和 Collection 回归 Canary |
| 迁移执行 | G7 现场硬恢复 | 两类真实旧状态生成 Recovery Capsule，在隔离 Data Root 恢复新 Epoch 并演练 rollback |
| 迁移执行 | G8 切换与删除资格 | 业务入口切换后验证旧源码不可用仍可运行；删除动作必须由用户另行明确批准 |

G0-G5 全部通过只能标记为 **Repository Extraction Ready**，即允许把源码提交到独立仓库。RCV 与 G6 完成后才是 **Release Candidate Ready**；G7 完成并获得用户批准后才是 **Production Cutover Ready**。G8 只验证删除资格，不自动删除。旧 Harness 的删除、移动、归档或清理始终属于用户决定。
