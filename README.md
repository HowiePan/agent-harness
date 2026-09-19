# Agent Harness

Agent Harness 是业务仓库之外的持久化 Agent 流程控制面。它用 Workspace 绑定项目、来源、资源与版本化 Workflow，由 Kernel 管理调度、证据、Gate、人工决定和恢复。业务方可以实现自己的流程和 Runtime，而无需改动 Kernel。

当前 V1.0.0 为 Migration Code Ready 候选；真实业务 Run 切换、远端发布、签名和旧文件清理由各自 Gate 与所有者决定。

## 已实现流程

| 能力 | Workflow ID | 当前范围 |
| --- | --- | --- |
| 版本交付 | `engine-delivery` | 生命周期闭环；参考变体仍含 CardWorld 绑定 |
| 批次生产 | `collection-batch-production` | Barrier、逐项验收；参考变体仍含 Collection 绑定 |
| 需求与设计整理 | `requirements-design` | 多文档、多仓检索、两份文档和复核 |
| 知识问答 | `knowledge-qa` | 记忆命中或来源检索、回答或澄清 |

## 开始使用

要求 Node.js 22+。从源码根运行：

```powershell
npm run check
npm test
npm run workspace:canary
node bin/agent-harness.mjs --help
```

`workspace:canary` 通过命令入口启动四条流程的合成 Run，并要求最终 `closed`。它不启动真实业务 Run。

完整项目介绍见 [对外说明](docs/overview/project.md)，架构与 Flow 包规范见 [整体设计](docs/architecture/system-design.md)。[文档导航](docs/README.md) 包含四条流程设计、业务接入、Workspace 配置、协议、SDK 与运维入口。
