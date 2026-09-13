# 缺陷、升级与回滚

## 单一上游

Harness Core、官方 Profile、插件、工具适配 Skill 和 Legacy Compatibility 只在独立 `agent-harness` 仓库修改。业务仓不得复制、热改或保存 Harness 源码。必要的业务二次封装应成为独立 Extension Pack；通用缺陷仍必须回到上游修复。

## 缺陷包

缺陷报告使用 `schemas/defect-bundle.schema.json`，至少绑定 Harness 版本与制品摘要、Extension/Plugin 版本、脱敏 Descriptor 摘要、失败命令、Authority 修订、相关 Dispatch/Evidence、期望与实际结果，以及最小合成复现。不得附带凭据、原始 Prompt、未脱敏业务数据或系统临时目录内容。

## 对话问题受理

操作员在出现问题的原对话中发送 `h:report <项目别名>`。Codex 适配器只使用已配置绑定，采集与问题有关的对话摘录并生成 `issue-intake.schema.json` 输入，再由绑定的 Harness 入口将记录原子写入固定的 `<controlRoot>/issues/<issue-id>/`。不得为上报另建对话、扫描磁盘、接受任意输出路径，或把记录写入 Consumer 仓库和 Codex 临时 worktree。

Issue Intake 允许明确记录“Descriptor/Authority/Registry 当前不可用”，用于处理初始化和安装类故障；缺失字段进入 `missingEvidence`，不得伪造摘要。它只是进入上游维护队列的版本化输入，不是 Authority 或完整 Defect Bundle。写入后必须向用户返回准确路径和 Git 未提交状态；是否 commit/push 仍由用户决定，未推送记录不能声称已跨设备留档。

同一故障的多次观察应携带结构化 `correlation`，由 Recorder 生成稳定 `incidentFingerprint`。Intake 本身保持不可变；分级、`duplicate-of`、`successor-of`、`fixed-by`、接受、解决和关闭都进入独立 `triage.json`，通过 expected revision、唯一 command ID 和批准 Decision 更新。`resolved`/`closed` 必须绑定 resolution Evidence。部署初始化失败使用 `deployment-incident`，只有具备完整 Harness/Extension/Descriptor/Authority 身份的实现缺陷才升级为 Defect Bundle。

## 修复流程

1. 按 Kernel、Profile、Plugin、Integration Skill 或 Legacy Compatibility 确定唯一 owner。
2. 在上游分支增加最小复现和回归测试。
3. 运行全量、Conformance、Canary、打包安装、路径边界和残留扫描。
4. 生成新的不可变制品、manifest、SBOM 和摘要。
5. 在 Harness Project Registry 更新项目绑定；业务仓无文件变化。

V1.0.0 正式发布前以 commit 和制品摘要区分候选构建，不拆内部版本。V1.0.0 发布后不得覆盖同名制品，兼容 Bug 修复使用 V1.0.1；破坏性协议变更必须进入新的主版本。

## Consumer-to-Upstream Defect Rehearsal

正式 V1.0.0 发布前必须完成一次从 Card World 发起的跨仓维护闭环演练，编号为 `PUB-008`。这不是直接向公开仓库发送真实业务数据，也不是在 Card World 内修改 Harness；Consumer 只负责产生经过审查的脱敏问题输入。

演练流程：

```text
Card World 发现 Harness 行为异常
→ 固化失败 Run 的 Harness/Extension/Descriptor/Authority/Evidence 摘要
→ 生成并人工审查脱敏 Defect Bundle
→ 在独立 agent-harness 仓库登记问题
→ 在旧 Harness 和 Card World 均不可访问的 clean-room 中复现
→ 在唯一上游 owner 层增加失败测试并修复
→ 生成新的不可变 commit/制品摘要
→ 在隔离 Project Registry 更新 Card World Descriptor 绑定
→ 从原 Authority 修订继续失败场景并完成 Gate
→ 演练升级失败时恢复旧绑定和升级前快照
```

必须保存的证据：

- 原缺陷包摘要，以及明确的敏感字段审查结果；
- 上游 issue/任务、owner 分类、失败测试、修复 commit 和代码审核结果；
- 修复前后 Harness、Extension、Plugin、Descriptor 和 release manifest 摘要；
- 新制品的全量、Conformance、Canary、clean-room、路径与残留检查；
- Project Registry 变更的 Authority Decision、expected revision、command ID 和 Receipt；
- 原 Run 续跑后的 Authority/Evidence/Gate，以及失败升级的 rollback Receipt；
- Card World 业务仓零 Harness 源码、补丁、状态、Prompt、Skill 和技术文档的扫描结果。

演练通过条件：问题可以只凭脱敏 Defect Bundle 在独立仓库复现；修复仅发生在上游；Consumer 通过版本和制品摘要升级；原 Run 不重置 Attempt Budget、不伪造完成态，并能够从升级失败中回滚。不得把访问旧 Harness 源码作为复现步骤。

Card World 完成完整演练后，Collection 必须使用同一协议做一次 Consumer 回归 Canary，至少验证其 Profile、Extension 身份、10 Feature 并发、批间 Barrier 和升级/回滚兼容性。若 Collection 暴露通用缺陷，仍回到同一上游；若只是 Collection 业务差异，则修改对应 Profile/Extension，不向 Kernel 添加项目分支。

本次抽离后审计识别出的 Capsule 可变源竞态作为 PUB-008 输入，见[脱敏缺陷包](acceptance/evidence/pub-008-cardworld-recovery-defect.json)。本地测试覆盖独立复现、制品重绑、原 Authority 与 Attempt Budget 续用、影响集 rebase，以及失败升级恢复旧绑定。正式关闭仍要求干净修复提交、该提交的 Release Candidate Receipt 和远端 CI。

## 升级与回滚

升级前封存 Authority、Evidence 索引、Project Registry 和存储 Schema 快照。迁移必须幂等并记录 Receipt。可逆迁移可执行 down migration；不可逆迁移只能恢复升级前快照，并重新建立更高 Epoch/Generation，禁止手工回写 Authority。

紧急验证可让 Project Registry 指向经过审核的 commit 制品摘要，但不得把临时补丁复制到消费者仓库。正式修复发布后必须移除该临时绑定。
