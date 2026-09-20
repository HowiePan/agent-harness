# V1.0.0 质量修复执行状态（更新于 2026-09-21）

## 结论

**V3.8.4 质量流程未准出。** G1 代码与本地发布流程已通过；G2 真实 Codex 宿主 Canary 在 PostToolUse 原生结果回传处超时，尚未形成合成质量闭环。G3 CardWorld 真实业务评审→修复→复审→Gate→Authority Closure 未启动；不得用本报告的测试或插件安装成功替代业务 Closure Receipt。

## 本次变更

- Engine `quality/full/deliver` Plan 要求经当前 workspace snapshot 验证、摘要固定的 `KnownFindingInventory`。完成的质量结果必须对每个规范 ID 返回有证据的 `open` 或 `not-reproduced`；遗漏、别名代替、重复、无证据和来源漂移均拒绝提交。旧 Engine quality Run 缺清单时不能靠空 Finding 结果关闭。
- 质量复审继承原始清单；确认仍开放的 Finding 更新证据并保留同一 Authority ID，已解决项复发仍按 reopen。修复后复审须对当前源码摘要确认全部清单项，Authority 开放 P0–P3 阻断关闭。
- 原 stdio 传输保留了有限大小的协议拒绝诊断、超时和迟到帧隔离回归。Codex 插件新增 `PostToolUse` Hook 文件桥：Hook 按父 Codex session、工具名、精确参数摘要、请求摘要与工具调用 ID 将原生结果写回 Control Root；Coordinator 不再从人工转录的 stdin 读取质量结果。合成 Hook 桥测试通过，真实当前任务及新启动子任务的原生探针均未得到 Hook 响应，故真实宿主传输仍未准出。
- Prompt Contract 提升到 1.2，Result Contract 提升到 1.1；Codex 固定输出 Schema 的新增字段列入必填。历史 1.1 Prompt 不由新 Codec 重新编译；已绑定 Lease 应使用原存 Prompt 字节和原 Authority 续接约束。
- 重新生成 `release-manifest.json` 与 `sbom.spdx.json`，保持 `1.0.0` 版本字面值。发布工作流第一次在 `workspace:canary` 因旧夹具缺 `KnownFindingInventory` 失败；已修正两个合成 Canary 脚本并提交，再跑完整工作流通过。

## 验证证据

| 层级 | 结果 |
| --- | --- |
| 本地短回归 | 最新全套 242/242 通过；包括 Hook 文件桥的父 session/请求/参数绑定及超时诊断、9 个 ID 各漏 1 项的拒绝、开放 Finding 确认、旧 Run 缺清单阻断、原 stdio 协议故障回归、合成评审→修复→复审→关闭。 |
| Conformance | 3/3 通过。 |
| clean-room | 从本次最新源码打包、安装、重启、注册 Extension 的检查通过。 |
| `npm run check`、`workspace:canary`、`check:residue`、渠道组合 | 通过；包版本 1.0.0，未发现临时目录或禁止残留。 |
| 本地插件发布 | 提交 `d469a339e4c4d1652dc3f8fab8d0b86e2cad62bb` 的 `release:codex:local` 完成：Core `d30fd89d…`、Codex 渠道 `6e4797e9…`；同版本 remove/add 清缓存、安装绑定校验和后续 `release:codex:check` 均通过。 |
| G2 真实宿主 | **阻断。** 当前任务与安装后新启动的子任务各调用一次原生 `collaboration.list_agents`；原生工具正常返回，但没有 `.response.json`，分别在 60 秒和 20 秒以 `CODEX_HOST_HOOK_RESPONSE_TIMEOUT` 停止。没有手工填充响应，也没有创建合成质量 Run。 |
| G3 真实业务 | 未执行；只读复核现有 Run `v3.8.4-quality-69b43609437505f3` 仍为 running、revision 15、Submission 0、Finding 0、Closure Receipt 0。 |

初次沙箱运行产生 `spawn EPERM`，未计为通过；完整回归、Conformance、clean-room 与打包检查均在允许本地测试子进程的环境重跑并通过。

本地发布回执：`.agent-harness-data/release-workflows/2026-09-20T161143-808Z-d469a339e4c4/local-plugin-release-receipt.json`，列出 `check`、242 项测试、`workspace:canary`、clean-room、Core/Codex 打包、residue、渠道组合、Release Candidate、插件 remove/add/verify 全部通过。真实短探针的两个请求 ID 为 `host_request_17f8ef75-7169-41f4-bb76-bd6ea8b05ef4` 与 `host_request_g2_384bd775e2db41718431c0768f804d05`；两者在 `.agent-harness-data/host-bridge/pending/` 有请求文件、无响应文件。不能由此单独断言是 Hook 未加载、matcher 未命中、事件字段不符或 Hook 写入失败。

## 继续执行的门槛

1. G2 须先在**新建的 Codex 任务**中验证安装后的 `PostToolUse` Hook 能捕获原生 `collaboration.list_agents` 响应。现有任务和由其启动的子任务均超时；插件在任务启动边界加载的行为尚待产品宿主验证。若新任务仍失败，保存原生 Hook 事件/日志与绑定字段，回放到 L0 后修正 matcher、事件解析或权限，不能靠重复启动质量 Run 猜测。
2. 原生短探针通过后，在独立合成仓种入 1 个已知 Finding，用同一安装制品完成 review→Authority Submission→repair dispatch→verified repair→full re-review→final Gates→Closure Receipt，再做传输故障和重启续接。未通过前不启动 CardWorld 真实质量 Run，也不恢复人工转录。
3. G3 清单至少含已报告的 `R008-FSW-001`～`006`、`V384-R06`～`R08`。只读业务文档又标出 `V384-R01`～`R05` 五个 P1 为“历史关闭结论；当前未收口”；它们必须独立处置或与前六项建立证据支持的显式 alias 映射。不得以原 9 项清单推断全部 P0–P3 已关闭。
   `issues/cardworld-v3.8.4-known-finding-inventory.proposed.json` 已列出 14 个候选 ID 和两个当前匹配的文档 SHA-256，仅供 G3 注册前审查，尚未写入 Project Registry 或提升为 Authority Finding。
4. 完成 G2 后，再按准确业务目标、Registry/Release/Extension/Plan/Run 谱系和写入授权执行 G3。每次新故障先回放到短层回归；只有真实 Authority Closure Receipt 和全部最终 Gate 证据才能报告准出。
