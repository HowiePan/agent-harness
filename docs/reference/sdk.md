# 扩展与插件 SDK

公开 API 由 `package.json` 的 `exports` 保持稳定。`createHarness({ controlRoot, dataRoot, workspaceId, extensions })` 装配中立 Core 和显式扩展。`defineExtensionPack()` 声明 ID、SemVer、Workflow/Profile、命令清单、插件工厂与 operation；每个 operation 在 `operationManifest` 中精确声明执行类别。需要 Authority 派生质量快照的 Extension 使用受限的 `planningCapabilities: ['quality-target']`，不得要求 Application 识别业务 ID。Planner 只能生成确定性 Plan，不直接产生外部副作用。

插件 manifest 声明 kind、API 版本、capabilities、permissions 和入口。Scheduler 返回候选 Intent；Agent Runtime 负责执行载体；Model Router 选择模型；Tool Broker 限制文件/命令；Codec 从不可变 Dispatch 生成完整 Prompt；Gate Executor 返回确定性结果；Artifact/Storage Provider 提供外部内容与存储。Plugin Host 对权限与版本再次校验，Kernel 对结果再校验。进程型插件声明受管输出预算；交互式 Runtime 必须提供可信可见宿主证明。

Flow Author 使用 `defineNodeTaskContract()` 创建版本化节点任务。Workflow Definition 注册时拒绝缺少 Task Contract 的 Agent Node，并根据真实 `dependsOn + outputPorts` 自动生成类型化上游输入。编译出的 Feature 固定 Task、角色、步骤、验收和输出合同；Prompt Contract 1.3 由 Codec 按 Core Contract、Node Task、已解析 Dispatch Context、Runtime 方言四层渲染，并记录 `taskDigest`、`packetDigest` 和 `promptDigest`。自定义 Codec 可以改变渲染方式，但不能绕过 Task、Authority、结果合同或项目固定的 Codec 身份。

可安装 Extension 制品提供 `agent-harness-extension.json`，列出入口和全部运行时文件。Registry 在执行代码前验证内容摘要，安装/升级/移除需要预期修订、命令 ID 与 Authority Decision。Workspace 以精确 ID、版本、摘要绑定 Workflow；新的制品需要新的绑定修订。自定义 Flow 应按整体设计的统一包结构建立，并提供自己的设计页、结果端口合同、Conformance 和命令级 `closed` 验收。

执行宿主须以 `createLifecycleCommandHost({ provider, verifyCommand, verifyActive })` 核验本次用户原始命令及持续有效性，再传入 `createHarness({ lifecycleCommandHost, ... })`。在 `harness.withUserLifecycleCommand(request, operation)` 回调内完成预检及执行。需要先登记再准备 Harness 的可信宿主，可先创建 `createLifecycleCommandBoundary({root, host})`，在其 `run` 回调中把同一对象传入 `createHarness({lifecycleCommandBoundary, ...})`；根必须等于实际 Authority 根，不能同时传另一 host。回调之外、已结束回调的异步任务和普通 JSON 授权字段都不能启动 Run、预检、派发或业务 Gate。默认不配置宿主时拒绝执行；规划、只读状态和独立维护能力仍可使用。宿主适配器属于可信嵌入层，不能从 Agent 结果反序列化，也不是对能改写宿主代码的本机进程的隔离沙箱。

`harness.continueVisibleLifecyclePlan` 仅接受当前命令内、已核验的封存替代计划；原命令 ID、合同及恢复次数必须连续。独立恢复脚本只支持准备/退休，不再执行生命周期或预检。命令上下文在回调结束后失效；普通进程中断后等待用户命令。唯一跨进程例外是可信宿主确认的 Run 创建前 EPERM 探测失败：同一原生用户事件、同一意图只重试一次，额度持久登记。历史状态、回执和新 Run 都不授予新命令权限，详见[协调闭环合同](../guides/coordination-continuity.md)。

停止后重新发起时，宿主证明须含原生 `userIssuedAt`，且晚于原停止时间。`prepareUserRequestedRestart` 仅在这个当前命令内收束同身份的已绑定旧效果、保护草稿并保留停止；`createLifecycleResumePlan` 只做规划投影。通过新鲜预检后，`startLifecyclePlan` 才记录当前用户的 `resume-execution` Decision。H2/H3/H4 不兼容身份先作正式承接，维护不能代替用户恢复。历史停止 Decision 不删除，也不能在当前停止状态已经正式解除后继续阻断派发。
