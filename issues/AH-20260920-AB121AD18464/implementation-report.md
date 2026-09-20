# AH-20260920-AB121AD18464 修复交付记录

日期：2026-09-20。状态：**代码候选通过；真实 Codex 宿主及真实业务准出未执行**。本报告记录当前工作区的修复和本地验证，不将合成闭环等同真实宿主闭环，也不改变 Issue Triage Authority。

## 修复范围

1. Dispatch 由 Feature、可见/非可见结果 Schema、类型化端口和值 Schema 生成 `agent-harness-dispatch-result@1.0` 摘要；Prompt Contract 升为 `1.1`，给出完整结果形状、状态分支和端口约束。历史 `1.0` Prompt 可按原版本重编译。
2. Codex 可见适配器使用可见结果 Schema 传输 `outputs`，不再误用 CLI provider 的固定 Schema。原生非法 JSON/Schema 生成版本化拒绝 Receipt，绑定 Agent、Dispatch、Packet、Prompt、结果契约及原生输出摘要；Host Effect 记为 `result-rejected`，Authority 收束为失败结果。可信拒绝 Receipt 下若 Agent 已改文件，Harness 使用快照计算的实际变更记录失败，避免因宿主生成的空 `changedFiles` 留下活动 Lease。正常 Agent 的变更声明仍需与快照严格一致。
3. 组合流程的 `failed`/`blocked` 终态不再要求完成态端口；完成态严格核对端口名、Schema ID 和值 Schema。需求设计、知识问答及 onboarding 示例均声明端口值 Schema。
4. Readiness 过期时针对同一 Plan 重新预检；新 blocker 会返回 attention，不延长旧报告。预检增加每个 Feature 的结果契约检查。固定结果 Schema 的 Codex CLI 无法承载类型化端口时，在 spawn 前以 `RUNTIME_TYPED_OUTPUT_CONTRACT_UNSUPPORTED` 明确阻断。
5. 显式 `candidateFeatureIds` Dispatch 也绑定可见 Runtime 模式和结果契约，避免另一条共享发车路径选错 Schema。

## 验证结果

| Gate | 结果 |
| --- | --- |
| `npm test` | 227/227 通过；包含非法原生结果、端口值错误、失败终态、过期 Readiness、可见候选 Dispatch，以及修复阶段已改文件后结果被拒绝的 Lease 收束 |
| `npm run check` | 通过 |
| `npm run workflow:canary` | Engine、Collection、需求设计、知识问答合成流程均关闭；知识问答覆盖记忆命中、检索、证据不足澄清 |
| `npm run test:conformance` | 3/3 通过；已包含在全测中 |
| `npm run check:clean-room` | 通过；独立临时安装、Extension 注册及重启加载均通过 |
| Core/Codex 本地候选包组合 | 通过；Hook 加载与 active Core 摘要绑定通过 |
| `npm run check:residue`、`git diff --check` | 通过；无临时目录残留或 diff 格式问题 |

最终本地候选摘要：Core `b05bb7510a46c534889904ec834971456d1ecaff40a65d63a598b2fd68aa8339`；Codex Channel `9c642dbe41f0834d97ea3c87887e8407daf0ef7963e2b6b472da21d37a16b0fa`。Receipt 位于 `.agent-harness-data/channel-packages/{core,codex}/<摘要>/`。两个包只在受管本地目录构建并在临时目录组合验证，未安装、激活、发布或切换。

## 尚未取得的准出证据

- 本次没有用当前候选包在真实 Codex 原生宿主逐动作执行 Engine、Collection、需求设计、知识问答的完整可见 Agent 闭环。现有 adapter 测试使用原生形状夹具，工作流 Canary 使用合成 Runtime。因此**不得将任一流程标为 operationally ready**，也不能据此认定所有类似问题已经找完。
- 固定输出 Schema 的 Codex CLI 对类型化工作流目前是明确的 preflight unsupported；若要支持该组合，需要另行实现由 Dispatch 生成的 provider 方言并做真机兼容验证。可见 Runtime 的类型化输出已在本地测试通过。
- 没有启动或恢复 CardWorld、V3.8.4、Collection B1 等真实 Run；未触碰冻结旧仓，未提交 Git、打 tag、安装插件、激活或发布。真实业务 Canary 与最终切换仍按独立 Gate 和用户对准确目标的授权执行。

本次修复满足方案中的代码候选 Gate。真实宿主及真实业务 Gate 所需的原生观察、Closure/Attention Receipt 仍需在获准的独立环境收集，不能以本报告替代。
