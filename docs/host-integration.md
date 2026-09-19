# 可见 Agent 宿主接入合同（V1.0.0）

Harness Core 负责 Feature 调度、Authority、Dispatch、Lease、Evidence 和恢复。项目 Extension 定义业务流程；Agent Runtime 声明执行能力；可信宿主适配器把当前工具的原生子 Agent 生命周期接到同一个可见执行合同。Codex 是一个宿主实现，不定义通用业务类型或 Kernel 状态机。

## Runtime 与宿主绑定

交互式项目在 Project Descriptor 中选择 `agentExecutionMode: conversation-visible`、`defaultRuntimePlugin` 或 action-scoped Runtime，以及 Prompt Codec。Runtime manifest 必须声明 `user-visible`、`host-orchestrated` 和 `agent.conversation`，不能申请 `process.spawn`。宿主在 `createHarness()` 中按完整 Runtime ID 注入可信适配器：

```js
const harness = await createHarness({
  controlRoot,
  dataRoot,
  extensions,
  agentAdapters: {
    'example-visible-runtime': createVisibleHostAdapter({
      provider: 'example-host',
      adapterVersion: '1.0.0',
      inspectVisibleAgent,
      spawnVisibleAgent,
      waitVisibleAgent,
      readVisibleResult,
      reconcileVisibleHostEffects,
      confirmVisibleLease,
      containVisibleAgent,
    }),
  },
});
```

`agentAdapters` 的 key 必须是已安装的可见 Agent Runtime ID；每个 Runtime 插件工厂只收到与自己 ID 匹配的 `agentAdapter`。缺失绑定时 preflight 返回不可执行，不会选用其他 Runtime 或回退到隐藏进程。旧 `agentAdapter` 单值入口仅保留给现有嵌入方；它与 `agentAdapters` 不能同时使用。生产 Extension 仍按完整制品摘要注册和固定，宿主注入不是 Extension 安装或 Authority 批准的替代品。

## 通用 Host Adapter v1.0.0

`createVisibleHostAdapter()` 实现 `agent-harness-visible-host@1.0.0`。可信宿主必须提供 inspect、spawn、wait、result、reconcile、confirm 和 contain；send 与 interrupt 可选。适配器的职责是：

1. 把 Harness 生成的完整 `prompt.text` 原样交给宿主原生可见子 Agent；原生任务引用必须可检查。
2. 在原生 spawn 前持久记录可恢复的 Host Effect；重启时先 reconciliation。未绑定 Lease 的失败 Agent 必须收容并重新观察，已绑定 Lease 的 Agent 必须重附着。
3. 把原生任务身份、状态、等待和终态输出转换为通用 observation、Lease Receipt、Result 与 Evidence。原生协议解析、字段名和错误码留在宿主适配器内。
4. 在绑定和 heartbeat 前从当前宿主重新观察 Agent，证明 `agentId`、`dispatchId`、`packetDigest`、`promptDigest`、surface 与 inspect reference 一致。恢复中的 Lease 还必须匹配原宿主的 provider 和 adapter version。

Preflight 必须核验完整能力与宿主原生合同 ID、版本、摘要。任何能力、证明、Prompt 编译或新鲜 heartbeat 缺失都 fail closed。适配器只能返回数据与回执，不能修改 Authority；Core 以 expected revision 和幂等 command ID 提交状态。

## 子 Agent 结果

Core 的 `visible-agent-result.schema.json` 是工具无关的 Result v1.0 合同，至少包含 `status`、`summary` 和准确的 `changedFiles`。质量 repair 完成时还必须带通过且有证据的 checkpoint，并由宿主保存对应 verification Receipt。Profile 可选实现纯 `validateResult({ state, feature, result })` 并返回 `{ ok: true }` 或 `{ ok: false, reason }`，对现有 findings、follow-up、检查等字段增加业务约束；Core 在写 Evidence 前及提交 Authority 时复验。Core 还会用工作区快照核对 `changedFiles`，不会信任 Agent 的单方声明。

宿主原生输出应在适配器中解码。例如 Codex 适配器解析 collaboration 的 `{ completed: string }`，先按 Codex 严格输出 schema 校验，再交给 Core 的通用 Result 合同。其他宿主可以使用不同的原生输出，只要转换后满足通用合同和对应 Profile 的要求。

## 分发边界

Harness Extension Registry 负责安装和固定项目、Runtime 等可信扩展。宿主安装入口属于各自集成包：Codex 的 Hook、Skill、Multi-Agent V2 检查和 `codex plugin` 流程位于 `integrations/codex`，根目录 `scripts/plugin-release-workflow.mjs` 仅保留兼容导出。新宿主应提供自己的命令入口和安装流程，不需要改 Kernel 或复用 Codex 安装命令。

## 2026-09-19 渠道与 VS Code 决策快照

**当前决定：暂不启动 VS Code 智能体插件开发。**本节记录可行性判断和现有命令，供后续重启时参考；它不授权新建 VS Code 接入包、运行智能体或执行发布。

### VS Code 接入结论

- Harness 的调度、Authority、Lease、Evidence、Result 和项目 Profile 可以复用。实现 VS Code 插件仍需编写扩展界面/命令入口、VS Code 宿主适配器及其 Runtime Extension；不能把 Codex 插件直接换成 VSIX。
- VS Code 的 [Chat Participant API](https://code.visualstudio.com/api/extension-guides/ai/chat) 和 [Language Model Tool API](https://code.visualstudio.com/api/extension-guides/ai/tools) 能承载聊天入口和工具调用。官方也提供[子智能体功能](https://code.visualstudio.com/docs/agents/run/subagents)，但“用户能使用子智能体”不等于稳定 Extension API 已暴露本合同要求的创建、观察、等待、中断、收容和重启重附着能力。[会话集成文档](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions)将 `chatSessionsProvider` 标为 proposed；完整 `conversation-visible` 接入须先核实具体 VS Code 版本与 API，再做宿主合同验证。
- 若只能实现命令、状态展示或工具入口，可先做受限插件；不能把它宣称为具备完整可见子 Agent 调度的 Runtime，也不能在可见能力缺失时自动回退到隐藏进程。

### 现有打包与安装命令

| 命令 | 当前实际作用 | 渠道属性 |
|:---|:---|:---|
| `npm run build:release-metadata` | 更新本仓库内容摘要清单和 SBOM | Harness 仓库制品元数据 |
| `npm run pack:dry-run` | 预览 `agent-harness` npm 包；当前包内也包含 Codex 集成目录 | 本地打包预演，不发布 |
| `npm run build:release-candidate` | 从干净且已提交的源码生成 npm tarball、独立安装探针与候选 Receipt；当前候选检查还包含 Codex 插件 | 当前 V1.0.0 候选制品，不是 VS Code 渠道 |
| `npm run release:plugin:check` | 检查本地 Codex marketplace、插件绑定、候选与已安装状态 | Codex 专属，只读预检 |
| `npm run release:plugin` | 完整验证、构建候选，然后执行 Codex 插件 remove/add 与安装后核验 | Codex 专属安装流程，会改变本机插件状态 |

命令名称 `release:plugin` 没写 Codex，但其实现是 `integrations/codex/agent-harness-codex/scripts/plugin-release-workflow.mjs`。目前没有 `--channel` 选择器、`package:vscode`/`release:vscode` 命令或 VSIX 产物。将来若用户启动 VS Code 开发，应为该渠道建立独立入口，同时明确通用 Harness 制品与各宿主安装包的关系；不能让 `release:plugin` 根据环境隐式切换渠道。

本轮已完成前述通用宿主边界与 Codex 接线的源码及测试，工作树尚未由用户决定提交、打 tag 或发布。VS Code 产品宿主 API 验证、插件实现、打包和实际 Canary 均未开始。
