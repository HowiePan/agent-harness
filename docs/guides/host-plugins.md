# 宿主插件与初始化入口

所有宿主初始化都调用同一个 Core InitPlan/InitReceipt；宿主不得重写注册逻辑或自行批准。

| 宿主 | 初始化入口 | 生命周期执行 |
|---|---|---|
| CLI | `agent-harness init ...` / `dev ...` | 独立 CLI 禁止 Agent 执行 |
| Codex | `h:init --decision ... (--source ...|--entrypoint ...)` | 完整可信可见宿主可执行 |
| OpenCode | `/h:init <decision-file>` 或 `harness_init` | 当前缺完整原生合同，fail closed |
| VS Code | `Agent Harness: Initialize Project` 或 `@harness /init <decision-file>` | 当前缺完整原生合同，fail closed |

初始化输入来自当前项目的 `harness.json`。输出至少包含模式、项目 ID、别名、Descriptor/Extension 修订、配置摘要和 `hostBinding`。Codex 将绑定写入插件拥有的 `.plugin-data/bindings.json`；source-link 还必须保存并逐次验证 development manifest。OpenCode 和 VS Code 可以初始化、查看状态与运行确定性工具，但在没有 spawn、inspect、wait、result、contain、Host Effect reconciliation 和 Lease confirmation 的原生证明时，不得创建生命周期 Run 或伪造成功。

宿主命令必须明确显示 unsupported、attention-required 或失败码；不得退回隐藏 Agent 进程、其他任务 API 或自由拼接 Prompt。
