# AH-20260915-43658BE83791 实施报告

## 结论

问题不是单一的 Runtime 选择错误，而是源码、活动不可变 Runtime、活动 Registry generation、插件源 binding、已安装插件缓存 binding 和遗留 Run Authority 六层发生了版本分裂。源码中的交互式/显式 headless 分离已经存在，但活动指针仍指向引入 action-scoped headless quality 的旧制品，旧 Descriptor 还持久化了 authorization，插件重装流程又只核对版本和路径，所以产生了“修复已发布、实际仍跑后台 CLI”的假阳性。

完成第一轮修复、激活和插件重装后，真实 `h:engine quality V3.8.4` 又暴露出第二层缺口：插件只声明了 `createCodexVisibleHostAdapter()` 合同，却没有实现 Codex 当前任务 native collaboration tree 到 Harness Node 进程的 Host Coordinator。Skill 仍调用不带 `agentAdapter` 的独立 `lifecycle preflight` CLI，因此 `visible-host` 检查必然失败；“换到提供 Host Adapter 的 Codex 会话”在现有插件实现中并不存在，是不可执行的建议，不是环境偶发故障。

## 已实施的源码修复

1. 新增统一执行分类：Feature 只能是 `agent-reasoning`，Gate Recipe 只能是 `deterministic-process`，Authority control 保留给 Core；缺失或错配均在 Authority 写入和进程启动前失败。
2. Lifecycle Plan Schema 直接引用 Feature Schema；Plan 创建和外部 Plan 验证都会重新校验完整 Work Graph。
3. Extension operations 必须由 key 集合完全一致的 `operationManifest` 声明为 `pure-planner`，并冻结 operations、manifest 和注册数组，禁止运行期追加功能节点。
4. Project Descriptor 输入/记录 Schema 与 Registry 合同强制 Gate 分类。
5. 插件使用单一共享模块，每次伪命令重新验证 active release pointer、pointer digest、不可变 Runtime 入口/manifest、入口文件摘要和完整 Registry generation；binding 必须钉住 version、artifact digest、generation ID 和 pointer digest。
6. binding 配置时执行活动 Runtime 全文件摘要验证；配置结果记录精确 release identity。
7. 本地插件发布工作流同时验证源码 binding 与已安装缓存 binding；活动 Runtime 与源码/候选制品摘要不一致时以 `LOCAL_RELEASE_ACTIVE_RUNTIME_STALE` 拒绝，缓存 binding 不一致时以 `LOCAL_RELEASE_INSTALLED_BINDINGS_STALE` 拒绝，不能再只凭插件版本报告成功。
8. release activation 增加 generation optimistic conflict 检查；对于旧合同 Descriptor，只允许读取 ID、revision 和 descriptor digest，并要求计划逐项提供显式替换 Descriptor。正常读取仍严格拒绝旧合同，未提供替换时以 `RELEASE_ACTIVATION_PROJECT_REPLACEMENT_REQUIRED` 失败。
9. 插件共享校验模块已加入 npm 包白名单；clean-room 真实 tarball 安装验证覆盖该文件。
10. 新增 active Release manifest 逐文件验证的 `visible-lifecycle-coordinator.mjs`。Hook 只签发最长十分钟、全字段摘要绑定的 base64url 执行意图；同一 Coordinator 进程重新验证 Release、生成 Plan、执行 preflight、启动/续跑 lifecycle，消除“无 Adapter 预检、另一个进程执行”的断裂。
11. 新增 Codex native collaboration Host bridge：Harness 每次只发出一个 digest-bound `spawn_agent`、`list_agents` 或 `wait_agent` 请求；Codex 当前任务按原参数调用原生工具，并把工具结果逐字封装回同一进程。响应缺字段、额外字段、session/request/digest/tool 不一致或重放全部失败关闭。
12. `spawn_agent` 强制 `fork_turns=none`，Harness 生成的完整 Prompt 必须逐字作为唯一 message；禁止继承父对话、改写 Prompt、指定临时模型或用 `create_thread`/独立任务替代。
13. spawn Receipt 绑定 session、request、Agent、Dispatch、packet、prompt 和 collaboration-tree inspect reference，并写入 Lease。绑定与 heartbeat 都重新调用 native `list_agents` 观察；跨 Dispatch Receipt、任务身份漂移、Prompt 摘要漂移和 Coordinator 文件漂移均拒绝。
14. 最终结果只从目标 child Agent 的 native completed 状态读取一个严格 JSON 对象；checkpoints 与结果摘要绑定后作为 host-preserved verification Receipts。任何 prose/Markdown、错误任务或非 completed 状态不得提交 Authority。
15. 新增集成测试覆盖精确 Prompt、无父上下文、意图篡改/过期、Coordinator 文件摘要、Host 响应串线、spawn Receipt 伪造以及可见 quality review/repair/recheck/closure 全链路。所有后续 state-changing command action 和动态 Feature 继续经过同一 Hook→Plan→preflight→Coordinator→Authority 路径；新增节点若缺 `executionClass` 或试图绕过 Host Adapter 会在现有合同层失败。

## 当前部署事实

- 第一轮修复已经提交为 `dcde51ce15d0efbeb3a028ff085e5d55f503b0e1`，活动 release digest 为 `b4fd0e5f3a89c5bb57c3bf837d81f3547fd146bf65e5a62cb6ccc4bf6ecbe33a`，活动 generation 为 `g-23cdb1e31d9d0b0927d24385`。
- Project `cardworld-engine` revision 13 已只允许 `conversation-visible` / `codex-conversation-runtime`；插件源与已安装缓存 binding digest 均为 `1be98e9740595f3568013b0cc3e3223460b04ca8e3eb4892a7a436d5a0fbfede`。
- 遗留 Run `v3.8.4-quality-a24579307d99ff93` 已按单独批准执行 ordinary recovery：revision 7、generation 3、status `ready`，active Lease/Dispatch 均为 0；未删除旧 Run 或旧 Harness。
- 本报告新增的 Host Coordinator 修复仍在工作树，尚未提交、激活或重装插件；当前活动插件因此仍会复现 `VISIBLE_AGENT_HOST_COORDINATOR_UNAVAILABLE`。

## 验证

- `npm run check`：通过。
- `npm test`：完整矩阵通过（新增 Host bridge 后共 184 项；以最终交付复跑结果为准）。
- `npm run test:conformance`：3/3 通过。
- `npm run test:canary`：3/3 通过。
- `npm run check:clean-room`：通过；真实 tarball 包含插件共享校验模块，独立安装与跨进程 Extension 恢复通过。
- `npm run pack:dry-run`：通过，197 个包文件；包含 manifest 验证的 Coordinator、Host bridge、stdio exchange 与 intent codec。
- `npm run check:residue`：通过，无瞬态目录和禁止二进制残留。

## 待批准的精确部署计划

当前候选 artifact digest 为 `dd8c1c2b1f46b221fd70ec335e1b8e9aadc7fb218f3452f9960b383811a87425`。已冻结 activation plan `3b8932ea4989f31d7624e12423b68963891cf5bc17b9bbf2f38eb3fd8c4c968e`：从 `g-23cdb1e31d9d0b0927d24385` 切换到 `g-d220a72b687b6335314fe71a`，Extension Registry expected revision 22，Project `cardworld-engine` expected revision 13 / descriptor digest `06525d8014ab55055c64e5f10d88be8f46aba599eaa84fe5e6a7162c726af74f`。策略保持仅 `conversation-visible` / `codex-conversation-runtime`，没有 headless 回退，也不删除任何旧制品或 Run。

部署顺序必须是：用户批准并提交精确源码 → 构建 commit-bound Release Candidate → 生成并批准绑定新 artifact digest 的 activation plan → 原子激活 Runtime/Registry generation → 用新活动入口重新配置源码 binding → 同版本 remove/add 插件清缓存 → 校验已安装缓存 binding 与 Coordinator 文件摘要 → 从新的 CardWorld 任务执行真实 `h:engine quality V3.8.4`。不得删除旧 Harness、旧 Runtime、旧 generation 或旧 Run。
