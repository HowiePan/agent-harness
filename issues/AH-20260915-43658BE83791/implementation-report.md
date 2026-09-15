# AH-20260915-43658BE83791 实施报告

## 结论

问题不是单一的 Runtime 选择错误，而是源码、活动不可变 Runtime、活动 Registry generation、插件源 binding、已安装插件缓存 binding 和遗留 Run Authority 六层发生了版本分裂。源码中的交互式/显式 headless 分离已经存在，但活动指针仍指向引入 action-scoped headless quality 的旧制品，旧 Descriptor 还持久化了 authorization，插件重装流程又只核对版本和路径，所以产生了“修复已发布、实际仍跑后台 CLI”的假阳性。

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

## 当前部署事实

- 当前源码 release artifact digest：`b4fd0e5f3a89c5bb57c3bf837d81f3547fd146bf65e5a62cb6ccc4bf6ecbe33a`。
- 当前活动 release 仍是旧 digest：`e296443b68f6947bc5fe700ad7663ff62239ee919f6f56e4a0a9a50f99d03a09`。
- 当前源码校验会把现有 plugin binding 拒绝为 `LOCAL_RELEASE_BINDING_RELEASE_STALE`。
- 遗留 Run `v3.8.4-quality-a24579307d99ff93` 仍在 Authority 中标记 `running` 且存在 `active` CLI Lease；对应 PID 1656 已退出。未修改、删除或伪造该 Run。

## 验证

- `npm run check`：通过。
- `npm test`：179/179 通过。
- `npm run test:conformance`：3/3 通过。
- `npm run test:canary`：3/3 通过。
- `npm run check:clean-room`：通过；真实 tarball 包含插件共享校验模块，独立安装与跨进程 Extension 恢复通过。
- `npm run pack:dry-run`：通过，193 个包文件。
- `npm run check:residue`：通过，无瞬态目录和禁止二进制残留。

## 待批准的精确部署计划

候选 release activation plan：

- plan digest：`b72b6a5bf9e64b094c15d60f0d27701be07f844d6a125fc5b11850d7a8f3aa79`
- current generation：`g-1c3b330ea33b3b876ed88662`
- next generation：`g-23cdb1e31d9d0b0927d24385`
- Project：仅 `cardworld-engine`
- expected Project revision：12
- expected Descriptor digest：`9f09789bfe37da61e4d8aff60750af90ae30f75299a707cdf56f3c8f4b21eaea`
- 目标策略：仅 `conversation-visible` / `codex-conversation-runtime`
- 删除：quality action 的 headless override、持久 authorization、CLI Runtime allowlist/config
- Gate：全部显式 `deterministic-process`

部署顺序必须是：提交精确源码（用户决定）→ 构建 commit-bound Release Candidate → 复算并批准精确 activation plan → 原子激活 Runtime/Registry generation → 用新活动入口重新配置源码 binding → 同版本 remove/add 插件 → 校验已安装缓存 binding → 只读 host handshake。遗留 Run 的 Authority 处置必须作为独立、可审计的 replacement/recovery 动作批准；不得删除旧 Harness、旧 Runtime、旧 generation 或旧 Run。
