# 扩展与插件 SDK

公开 API 由 `package.json` 的 `exports` 保持稳定。`createHarness({ controlRoot, dataRoot, workspaceId, extensions })` 装配中立 Core 和显式扩展。`defineExtensionPack()` 声明 ID、SemVer、Workflow/Profile、命令清单、插件工厂与 operation；每个 operation 在 `operationManifest` 中精确声明执行类别。Planner 只能生成确定性 Plan，不直接产生外部副作用。

插件 manifest 声明 kind、API 版本、capabilities、permissions 和入口。Scheduler 返回候选 Intent；Agent Runtime 负责执行载体；Model Router 选择模型；Tool Broker 限制文件/命令；Codec 从不可变 Dispatch 生成完整 Prompt；Gate Executor 返回确定性结果；Artifact/Storage Provider 提供外部内容与存储。Plugin Host 对权限与版本再次校验，Kernel 对结果再校验。进程型插件声明受管输出预算；交互式 Runtime 必须提供可信可见宿主证明。

可安装 Extension 制品提供 `agent-harness-extension.json`，列出入口和全部运行时文件。Registry 在执行代码前验证内容摘要，安装/升级/移除需要预期修订、命令 ID 与 Authority Decision。Workspace 以精确 ID、版本、摘要绑定 Workflow；新的制品需要新的绑定修订。自定义 Flow 应按整体设计的统一包结构建立，并提供自己的设计页、结果端口合同、Conformance 和命令级 `closed` 验收。
