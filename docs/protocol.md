# V1.0.0 Authority Protocol

## 权威边界

Kernel 是唯一可以改变 Run Authority 的组件。Application、Profile、插件、Agent 与模型只能提交命令、Intent、业务 Result 或外部 Receipt；它们不能直接改写状态文件。

每个变更命令必须包含：

- 全局唯一且可重试的 `commandId`；
- 调用方读取到的 `expectedRevision`；
- 命令类型与规范化 payload；
- 需要时绑定 `runId`、`epoch`、`generation`、`featureId`、`leaseId` 和摘要。

相同 `commandId` 与相同 payload 返回第一次结果；相同 ID 携带不同 payload 被拒绝。revision 不匹配返回冲突，调用方必须重新读取 Authority 后决定是否重试。

## 核心对象

- `ProjectDescriptor`：业务仓路径、Profile、插件绑定与数据根，不进入业务仓。
- `Run`：一个可恢复的权威执行实例，包含 epoch、generation 和 source digest。
- `Feature`：Agent Lease 的最小调度单元；内部 Step 串行，Feature 间按依赖和冲突并行。
- `Dispatch`：Feature 在某一 source digest 上的不可变输入快照。
- `Lease`：有期限、有 owner、占用执行槽的执行许可。
- `Attempt`：稳定预算键上的一次逻辑尝试；重派或恢复不会刷新逻辑预算。
- `Submission`：Agent 业务结果，只是待验证输入。
- `Evidence`：内容和元数据双摘要寻址的不可变证据。
- `Gate` / `Finding`：确定性验证与 P0-P3 质量事实；所有级别都阻断准出。
- `Decision`：需要人类 Authority 的显式选择。
- `Receipt`：一次已提交 Authority 变化或最终交付的可审计结果。

## 提交顺序

状态写入使用目录锁、事务 journal、临时文件、fsync 和原子 rename。Evidence 与事务数据先落盘，Authority 最后提交；启动时可以从 journal 恢复未完成事务。任何插件异常都不得形成半权威状态。

## 摘要与路径

Dispatch 固定创建时的 source digest。Result 必须提供该输入摘要、结果摘要、changed-files 和 Evidence；跨 generation、迟到 Lease、越权路径、缺失或不匹配 Evidence 均被拒绝。受管生成物只能由声明 owner 写入。

## 恢复

- Core 以稳定 `logicalTaskKey` 维护唯一 active Run；不可变 Plan 与易变 `RunLineageResolution` 分离。进程重启、Run 复用、reattach、ordinary resume、hard recovery 和保留审计的 replacement 由版本化策略自动选择，用户不负责选择恢复机制。
- ordinary resume：保留 epoch 和逻辑预算，废止旧 Transport/Lease。
- hard recovery：只有验证过的 Capsule 和 Core `RecoveryResolutionReceipt` 才能触发；以旧事实为只读输入建立新 epoch/generation，保存 rollback snapshot，旧 Lease、Packet、Agent 身份和状态字符串不升级为 Authority。
- artifact rebase：根据 Artifact 身份与影响集使相关 Feature 失效并重新验证，不全局无差别重跑。

兼容性以 Schema、Plugin API major、Profile version 和 Recovery Manifest 共同判断；不兼容输入必须显式迁移，禁止静默降级。
