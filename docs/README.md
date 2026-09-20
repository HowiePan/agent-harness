# 文档导航

## 现行文档

- [项目说明](./overview/project.md)：面向外部读者的完整介绍，不依赖其他文档。
- [整体设计](./architecture/system-design.md)：当前架构、权威边界、Workspace、资源、Flow 包规范。
- [接入指南](./guides/consumer-quickstart.md)、[Flow 开发](./guides/flow-authoring.md)、[Workspace 配置](./guides/workspace-configuration.md)。
- 流程设计：[版本交付](./flows/delivery-lifecycle/design.md)、[批次生产](./flows/batch-production/design.md)、[需求与设计整理](./flows/requirements-design/design.md)、[知识问答](./flows/knowledge-qa/design.md)。
- 参考：[协议](./reference/protocol.md)、[SDK](./reference/sdk.md)、[命令](./reference/commands.md)、[渠道打包](./reference/packaging.md)、[Legacy 兼容基线](./reference/legacy-compatibility.md)。
- [运行与恢复](./operations/README.md)。

## 历史与证据

[历史与证据索引](./history/README.md)集中保存旧方案、业务接入说明、版本记录、决策、审计、验收和恢复演练。它们记录各时间点的事实，不与上述现行文档共同定义当前架构。现行 Flow 的业务变体以各 Flow 设计页为入口。

迁移和真实业务切换仍受各自 Gate 约束。本轮目录整改不迁移旧 Run，也不改变已固定 Run 的制品身份。
