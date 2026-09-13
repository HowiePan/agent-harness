# V1.0.0 Plugin SDK

插件通过 manifest 声明 `kind`、API version、capabilities、permissions 和入口。Plugin Host 在加载时冻结版本与权限；Kernel 不按供应商或模型名分支。

Profile、一个或多个插件工厂、声明式 `commandManifest`、Legacy Importer 与构建期 operation 通过 Extension Pack 组合。工具适配器先从外部安装数据解析 `h:<项目别名> <动作> <目标> [预设]` 的项目别名，随后由 `commandManifest` 把通用动作解析到该 Profile 的阶段范围和变更属性；Core 不保存项目别名或项目命令表。`createHarness()` 默认只加载中立 Feature Profile 和参考插件；任何消费者、Runtime 供应商或 Legacy 能力都必须通过 Extension Registry 安装或由 API 显式传入。Project Descriptor 的 Extension ID、版本或摘要不满足时，Run 在写入 Authority 前失败。

## 插件类型

| 类型 | 职责 | 参考实现 |
|:---|:---|:---|
| Scheduler Strategy | 产生候选调度 Intent | conflict graph |
| Agent Runtime | 启动、等待、心跳、中断执行载体 | Codex CLI、isolated Codex、callback、local process、in-memory |
| Model Router | 基于 capability 选择模型 | static capability router |
| Tool Broker | 在授权根内执行受限工具 | local workspace broker |
| Prompt/Result Codec | 编码 Dispatch、解码业务 Result | JSON codec |
| Gate Executor | 执行确定性检查并返回 Receipt | process gate |
| Artifact Provider | 解析并固定外部 Artifact 身份 | local artifact |
| Storage Provider | 提供外部 Authority/Evidence 存储 | local atomic storage |
| OS Sandbox | 在操作系统边界包装进程启动 | command-wrapper contract / AppContainer、容器等外部实现 |

## 信任模型

Extension Pack 与其中的插件代码会在 Harness 进程内执行，因此它们是经人工批准、完整制品摘要固定的**可信控制面代码**，不是任意第三方脚本。Runtime、模型、工具和插件返回的数据仍是不受信任输入：

- 只能返回经过合同校验的 Intent、Event 或 Receipt；
- 不获得 Authority Store 写权限；
- Tool Broker 对 workspace root、allowed paths、命令和 capability 再授权；
- Runtime 不得伪造用户 Decision、Gate 或 Evidence；
- 插件失败、超时和输出不兼容形成可诊断失败，不消耗或重置不相关逻辑预算；
- manifest 的 major API、capability 和 permission 不满足时拒绝加载。

安装、升级或移除 Extension 都要求 expected revision、command ID 与显式 Authority Decision；重试同一 command ID 保持幂等。未经代码审查的 Provider 必须放在进程外，通过最小协议代理并由 `required` OS Sandbox 隔离，不能直接作为 in-process Extension 安装。

## 编写插件

1. 创建 ESM 入口并导出 manifest 对应工厂。
2. 只实现一个明确插件 kind；跨 kind 协作经 Host 合成。
3. 使用稳定 ID 和可规范化 JSON，不在 payload 中放进程对象或供应商私有状态。
4. 为正常、重复、超时、恶意越权和不兼容输出编写 Conformance 用例。
5. 用同一 Profile 在参考 Runtime 与新 Runtime 上比较 Authority 语义，而不是比较自然语言输出。

Model Router 的 `route` Intent 会连同插件 ID、版本和请求摘要固化进 Dispatch Packet；Runtime 消费路由结果，Kernel 不识别供应商模型名。Tool Broker 适用于由 Harness 托管工具调用的 Runtime；像 Codex CLI 这类自带工具面的 Runtime 仍必须声明权限并受 workspace sandbox 与 Feature 路径复核约束。

Runtime 必须准确声明工作区能力：`workspace-shared` 会被参考 Coordinator 收紧为单物理执行槽；只有能提供独立 workspace，并在合并时验证基线的 Runtime 才能声明 `workspace-isolated`。参考 `codex-isolated-runtime` 使用独立目录、完整 changed-files 对账和逐文件乐观合并；其他 worktree、容器或远端 Runtime 必须满足同样的不变量。不得仅为提高并发数伪报隔离能力。

所有启动本地进程的 Runtime/Gate 还必须声明 `managed-outputs`、每个输出目录的字节/文件预算及保留策略。Host 会拒绝未声明输出的进程插件；Controller 负责目录分配、运行中超限终止和摘要绑定的清理 Receipt。`os-sandbox` 可作为独立 Provider 插入；策略为 `required` 时缺少 Provider 必须 fail-closed。完整合同见 [插件执行输出、预算与 OS 沙箱](execution-control.md)。

参考 manifest 位于 `plugins/`，公共契约位于 `src/plugins/contracts.mjs`，加载与权限边界位于 `src/plugins/host.mjs`。

Extension Pack 使用 `defineExtensionPack()` 声明稳定 ID、SemVer、Profiles、plugin factories、`commandManifest`、recovery importers 与 operations。命令清单通过 `defineCommandManifest()` 校验，使用 `resolveCommandIntent()` 解析动作别名、默认预设和参数化 selector。外部模块默认导出 `extensionPack`。可安装制品必须在根目录提供 `agent-harness-extension.json`，列出入口及全部运行时文件；依赖必须打包进该根并进入清单，禁止依赖未固定的外部 bare package。Harness 发布包可复用 `release-manifest.json`。`extension register` 只接受控制根内、无 symlink/junction 穿越的入口，并在执行代码前核验完整清单摘要。`--extension <module>` 只保留为显式的一次性装载入口，不维护消费者名称分支。详细作者约束随 Codex 插件发布在 `integrations/codex/agent-harness-codex/skills/agent-harness-extension-author/`。

Legacy Importer 必须是只读且确定性的：只接受明确的 `legacyRoot`，返回满足 `migration-manifest.schema.json` 的严格 assessment，不返回未声明字段，也不跟随链接。创建 Capsule 时 Harness 会把 assessment 的逻辑根规范化为 `payload`，并要求 Importer 的 ID、版本、source digest 和文件数与受管 staging 完全一致；Importer 不得把源码、执行内容或私有运行状态带入自身插件状态。
