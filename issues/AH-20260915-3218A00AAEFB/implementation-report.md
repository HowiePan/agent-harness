# AH-20260915-3218A00AAEFB 实施与验证报告

## 结论

- 源码、Schema、Consumer、Codex 插件源、文档、拒绝路径测试和发布元数据已一次性完成修复。
- Descriptor 中的长期执行批准已拆除；历史 `actionExecution.*.authorization`、policy 级 execution grant 以及 release activation 携带这类字段都会在写入前拒绝。
- 普通交互命令仍以原始命令一次授权其 Manifest 普通范围直至 stop condition；repair、re-review、普通重试和同一 Run 恢复不新增逐步批准点。
- Standalone CLI 的 `lifecycle execute` 和 `run execute` 已关闭，稳定返回 `AGENT_CLI_EXECUTION_DISABLED`。交互式可见宿主失败时不会回退到 Codex CLI、隐藏进程或独立任务。
- Headless 仅保留为受信宿主嵌入 API：Descriptor allow-policy、版本化 deny-wins `UserExecutionConstraints`、原始 CI/无人值守请求生成的 command-scoped `LifecycleExecutionGrant` 必须同时通过。

## 关键实现

1. 新增 `LifecycleExecutionGrant` 与 `UserExecutionConstraints` Schema；Grant 精确绑定 Project revision/digest、Intent、action/target/scope、Run、Runtime ID/version、workspace、初始 source、Harness/Extension 制品和 constraint digest，并带过期时间和宿主 attestation。
2. Plan、Preflight、start、resume、RunCoordinator、Dispatch、Runtime invoke 与 spawn 全链复验；策略或 constraint revision 变化后旧 Grant 立即失效。
3. Plugin Host 与进程 Runtime 双层要求 Core 私有、不可 JSON 伪造的 per-launch capability，绑定 Grant、Runtime、Dispatch 和 Packet。
4. `codex-runtime` 只注册 conversation-visible Runtime；Codex CLI/isolated Runtime 移到独立 `codex-headless-runtime` Extension。`createHarness()` 默认 permission set 不含 Agent `process.spawn`。
5. CardWorld/Collection Consumer 不再自动加入 CLI Runtime，也不再自动生成 `approveForMe`；进程 Runtime、Extension、allowlist 和配置必须分别显式提供。
6. Project Registry 对新增或改变 headless 策略要求有有效期的精确 Decision，绑定 Project、expected revision 与变更前后 policy digest；通用 approved Decision 不再足够。
7. Operator/Command/Extension Author 契约同步改为“一次普通生命周期授权 + 禁止后台 CLI + Headless command grant”，删除持久批准的旧指导。

## 关键拒绝证据

- 缺失、过期、宿主拒绝、跨 Run 重放的 Grant：拒绝。
- action、target、Runtime ID/version、workspace、source、Harness artifact、Extension digest 任一错配：拒绝。
- trusted constraint 为 deny 或 revision/digest 变化：拒绝，Descriptor/action/release 配置不能覆盖。
- 旧 Descriptor authorization 或 execution grant（包括开发模式和 release activation 输入）：拒绝。
- 非精确或过期的 headless policy Decision：拒绝。
- 未持有 Core launch capability 直接调用 Codex CLI Runtime：`AGENT_RUNTIME_LAUNCH_CAPABILITY_REQUIRED`，`spawnProcessCallCount=0`。
- Standalone CLI 的两条 Agent execute 入口：`AGENT_CLI_EXECUTION_DISABLED`。

## 验证结果

- `npm run check`：通过。
- `npm test`：159/159 通过。
- `npm run test:conformance`：3/3 通过。
- `npm run test:canary`：3/3 通过。
- `npm run check:clean-room`：真实 npm tarball 下 159/159 通过，独立安装与跨进程 Extension 恢复通过。
- `npm run pack:dry-run`：通过。
- `npm run check:residue`：通过。
- 发布元数据已重建；包版本与 Codex 插件版本保持 `1.0.0`。

## 未越权执行

- 未启动 Codex/Agent 后台 CLI，未创建、恢复或迁移真实业务 Run。
- 未修改冻结的旧 Harness 路径，未删除/移动旧 Harness 或业务数据。
- 未 commit、tag、push、发布、激活 release 或重装 Codex 插件。

## 关闭边界

本 Issue 的代码修复与本地/clean-room 验证已完成。正式关闭仍应保留两个外部 Gate：基于提交后不可变 RC 的安装后插件握手，以及真实 Codex conversation-visible Host Canary。后者若宿主 bridge 不可用，应保持 `attention-required`，不能再用 Headless 替代。上述 Gate 不代表仍有已知源码旁路，也不授权发布、插件重装、真实 Run 或旧 Harness 清理。
