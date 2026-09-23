# V1.0.0 本地源码真实宿主接入进度（2026-09-24）

## 目标与边界

目标是先让 CardWorld 通过 `source-link` 使用当前 Harness 源码完成真实 Codex Agent 质量审查和开发；可安装插件的 G2 独立留待后续。当前工作仅修改 Harness 仓并验证隔离合成项目；没有启动、恢复或修改 CardWorld/V3.8.4 真实 Run。

## 已完成

- 新增 `local-source-hook.mjs`：项目级 Codex Hook 从明确的控制根绑定目录加载 `source-link`，核验当前 Hook、Coordinator 和 Host bridge 属于同一源码身份；`UserPromptSubmit` 指向当前源码中的命令说明，`PostToolUse` 复用既有 session、工具参数摘要、调用 ID 与请求摘要校验。它拒绝不可变安装绑定、源码漂移和控制根外的绑定目录。
- `--print-config` 生成可放入明确选用本地开发模式的项目 `.codex/hooks.json` 的配置；`h:probe` 会给出绑定当前 Codex session 的只读短探针，只请求一次原生 `collaboration.list_agents`，不创建 Run。该模式不要求重新打包或安装 Codex 插件。项目 Hook 的信任审核仍由 Codex 宿主执行。
- 在隔离合成项目验证源码绑定、Hook 配置生成、伪命令意图、`h:probe` 入口，以及模拟原生 `PostToolUse` 事件到 pending Host 请求的端到端往返。合成项目位于 `F:\agent-harness\.agent-harness-data\local-debug-acceptance\2026-09-23\consumer`，配置为其 `.codex\hooks.json`；最终绑定与回执位于 `F:\agent-harness\.agent-harness-data\local-source-host\2026-09-24\data-probe`，源码摘要为 `a404ffcdaa9045159c04eef01914b0ed2073b36a173f12a3881b1ebd96ff76bc`。这些目录均为忽略的调试数据，不是 CardWorld 仓。
- `npm run check`、完整测试 315/315 和 `npm run workspace:canary` 通过。

## 当前停点

**真实 Codex Desktop 项目 Hook 投递仍未验证。** 当前任务是在 Harness 根目录启动的，Codex 只在可信项目任务中加载该项目的 `.codex/hooks.json`；合成项目配置不能在当前任务中充当已加载的 Hook。下一步必须在上述合成项目根新开 Codex 任务，在 `/hooks` 审核并信任新 Hook，输入 `h:probe` 并按其精确请求调用一次原生 `collaboration.list_agents`。只在观察到对应 `PostToolUse` 阶段和 Host response 后，继续真实 Agent 的合成质量闭环与重启恢复。

若项目 Hook 对该原生工具也不投递，保持 `attention-required`，记录与插件 G2 是否共享宿主路由根因；不得手写 Host response、使用 headless Agent 或让合成结果冒充真实宿主证据。CardWorld 真实 Run 仍等用户审核实现并作出单独决定。
