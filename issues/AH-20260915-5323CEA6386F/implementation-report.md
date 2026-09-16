# AH-20260915-5323CEA6386F 实施与验收报告

日期：2026-09-15  
结论：P1 Defect 已完成本地代码修复和全套交付验证；Issue 保持 `accepted`，等待用户另行授权 commit、发布、active Release 切换、同版本插件重装与真实产品 Host canary 后再转 `resolved`。

## 根因

1. Codex Host Adapter 误把 `collaboration.spawn_agent` 的原生返回定义为 `{ task_name }`，而真实宿主返回 `{ agent_id, nickname }`。旧 mock 复刻了错误假设，因此形成假绿。
2. native spawn 是 Authority 外部副作用，但旧流程在 spawn 之后才校验返回、观察可见任务并绑定 Lease。任一步骤失败都会留下 Authority 不知道的 Agent。
3. 失败路径没有持久身份、没有 `interrupt_agent`、没有终态复核。下一次 ordinary resume 因 Authority 中没有 active Lease，会继续调度新 Dispatch。
4. Engine 与 Collection 的 state-changing conversation-visible 动作共享同一 Host Adapter 和 lifecycle executor，因此这是共性边界缺陷，不是 quality 单流程缺陷。

## 一次性修复

- 定义 `codex-collaboration-native@1.1.0` 精确契约：spawn `{ agent_id, nickname }`、list `{ agents: [{ agent_name, agent_status }] }`、wait `{ message, timed_out }`、interrupt `{ target }`。
- provider `agent_id` 与 visible tree 的 canonical `agent_name` 分离保存；spawn 后必须通过 `list_agents` 唯一解析并绑定 canonical identity。
- 新增持久 `Codex Host Effect Journal`：`spawn-requested -> spawn-responded -> agent-observed -> lease-bound -> settled`，失败仅进入 `contained`；所有更新使用 expected revision、幂等 command ID、内容摘要和原子提交。
- preflight 新增共享 `visible-host-contract` reconciliation：新 spawn 前先扫描未决 Effect。非 active Lease Agent 必须 interrupt 并再次观察到 absent/idle/terminal；无法证明时 fail closed。
- spawn 后 attestation 或 Lease 绑定失败时，executor 先收容当前 Agent，再抛出原错误，循环不会进入下一 spawn。
- Authority Lease 已提交但 Host Effect 确认中断时，错误标记 `leaseBound=true`，禁止误杀 Agent；下次 preflight 保留该 Effect 并按 active Lease 重附着。
- wait/result 现在携带完整持久 Runtime Receipt，result 终态把 Effect 置为 `settled`。
- Codex command skill 加入 `interrupt_agent` 服务规则和“未收容不得下一发车”的操作约束。

## 共性影响审计

| 范围 | 动作 | 结论 |
| --- | --- | --- |
| Engine | full, requirements, plan, implement, scope, quality, docs, review, deliver, resume, recover/hard | 默认 state-changing 路径统一选择 `conversation-visible` / `codex-conversation-runtime`，全部受共享 contract Gate 保护 |
| Collection | full, rules, launch, produce, quality, review, accept, close, resume, recover/hard | 默认 state-changing 路径统一选择 `conversation-visible` / `codex-conversation-runtime`，全部受共享 contract Gate 保护 |
| 只读命令 | status, recover/assess, doctor, project/extension/issue 查询 | 不创建 Agent，不受本次 spawn 协议缺陷影响 |
| 显式 headless | 仅 Descriptor allow-policy、deny-wins constraints 和 command-scoped Grant 同时满足时 | 不使用 Codex collaboration Host Adapter；不允许作为本缺陷的隐式回退 |

## 专项证据

- 真实 spawn envelope、canonical task、Lease、wait/result 闭环通过。
- 旧 `{ task_name }` envelope 被拒绝，同时已创建 Agent 在返回错误前被 interrupt 并验证为 contained。
- 模拟 spawn 与持久响应之间崩溃：重启 preflight 先收容 crash-window Agent，未决 Effect 清零后才 ready。
- 模拟 interrupt 后仍 running：preflight 返回 not ready，Effect 保持 unresolved，禁止下一 spawn。
- 模拟 spawn 后 attestation 失败：spawn count=1、contain count=1、Agent count=0、active Lease=0、requested Dispatch=1。
- 模拟 Authority Lease 提交后确认失败：active Lease 保留、contain count=0、重启 preflight 可重附着。
- Engine/Collection 的每个 state-changing action 均验证为共享 `conversation-visible` Host Contract 路径。

## 交付 Gate

| Gate | 结果 |
| --- | --- |
| `npm test` | 190/190 passed |
| `npm run check` | passed；13 类项目约束通过 |
| `npm run test:conformance` | 3/3 passed |
| `npm run test:canary` | 3/3 passed（neutral-library/service/docs） |
| `npm run check:clean-room` | passed；独立打包、安装、重启加载验证通过 |
| `npm run pack:dry-run` | passed；199 files，package `1.0.0` |
| `npm run check:residue` | passed；transient directories absent |
| Release metadata | regenerated；197 manifest files，package digest `fb82bfa2767dada8eeaf1279b6df197be4bbeef619a97f5cab67ac1024bab5b2` |
| 版本一致性 | `package.json` 与 `.codex-plugin/plugin.json` 均为 `1.0.0` |

## 未执行的受保护操作

- 未启动、恢复、迁移或重建任何 CardWorld、V3.8.4、Collection B1 真实 Run。
- 未修改冻结的旧 Harness、旧文档或 tabletop-collection 运行状态。
- 未 commit、tag、push、发布、激活 Release、切换 active pointer 或重装 Codex 插件。
- 未删除、移动或归档任何旧 Harness。

这些步骤需要用户对准确目标另行授权，并且真实产品 Host canary 只能在新 active Release 和新插件安装完成后执行。

## 2026-09-16 宿主兼容性回归补充

首次本地发布后，真实 CardWorld 新任务在 Coordinator 发出首个 `collaboration.list_agents` 请求时停止。任务留存元数据确认该任务运行在 `multi_agent_version: "v1"`，而 Harness Host Effect Journal 的观察、收容和重附着契约要求 V2 的 `list_agents` 与 `interrupt_agent`；这不是 `spawn_agent` 返回包修复回退，也没有创建 Run 或残留 Host Effect。

本次补充修复把宿主前置条件明确冻结为 Codex Multi-Agent V2：

- 已通过官方 `codex features enable multi_agent_v2` 命令启用本机 V2，`codex features list` 显示 `multi_agent=true`、`multi_agent_v2=true`。该设置只对新任务生效。
- Command Skill 和 Hook 在启动 Coordinator 前检查 `collaboration.spawn_agent/list_agents/wait_agent/interrupt_agent` 四项实际工具；缺任一项以 `CODEX_MULTI_AGENT_V2_REQUIRED` 提前停止，不再先启动长驻进程。
- 禁止将 `multi_agent_v1`、独立任务 API 或其他 Agent 接口当作兼容回退；V1 无法提供本 Issue 要求的列举观察与中断后终态证明。
- 本地插件发布检查新增宿主能力 Gate；未启用 V2 时拒绝安装/重装，并给出官方启用命令。

补充验证：`npm test` 191/191、`npm run check`、clean-room、pack dry-run、residue、Skill validator 和 plugin validator 均通过。补充源码仍需由用户提交后，才能按干净提交约束重建 active Release 并同版本重装插件；当前已安装插件在新任务中可先使用已启用的 V2 宿主能力进行真实 canary。
