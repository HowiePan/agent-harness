# V1.0.0 质量修复执行状态（2026-09-20）

## 结论

**V3.8.4 质量流程未准出。** 当前交付的是代码修复和本地 G1 回归证据。G2 真实 Codex 宿主 Canary、G3 CardWorld 真实业务评审→修复→复审→Gate→Authority Closure 均未完成；不得用本报告的测试通过替代业务 Closure Receipt。

## 本次变更

- Engine `quality/full/deliver` Plan 要求经当前 workspace snapshot 验证、摘要固定的 `KnownFindingInventory`。完成的质量结果必须对每个规范 ID 返回有证据的 `open` 或 `not-reproduced`；遗漏、别名代替、重复、无证据和来源漂移均拒绝提交。旧 Engine quality Run 缺清单时不能靠空 Finding 结果关闭。
- 质量复审继承原始清单；确认仍开放的 Finding 更新证据并保留同一 Authority ID，已解决项复发仍按 reopen。修复后复审须对当前源码摘要确认全部清单项，Authority 开放 P0–P3 阻断关闭。
- 原 stdio 传输保留了有限大小的协议拒绝诊断、超时和迟到帧隔离回归。Codex 插件工作树新增 `PostToolUse` Hook 文件桥候选：Hook 按父 Codex session、工具名、精确参数摘要、请求摘要与工具调用 ID 将原生结果写回 Control Root；Coordinator 不再从人工转录的 stdin 读取质量结果。合成 Hook 桥测试通过。当前已安装插件未包含该 Hook，且真实桌面宿主的事件字段和写入权限尚未验证，所以真实宿主传输仍未准出。
- Prompt Contract 提升到 1.2，Result Contract 提升到 1.1；Codex 固定输出 Schema 的新增字段列入必填。历史 1.1 Prompt 不由新 Codec 重新编译；已绑定 Lease 应使用原存 Prompt 字节和原 Authority 续接约束。
- 重新生成 `release-manifest.json` 与 `sbom.spdx.json`，保持 `1.0.0` 版本字面值。

## 验证证据

| 层级 | 结果 |
| --- | --- |
| 本地短回归 | 最新全套 242/242 通过；包括 Hook 文件桥的父 session/请求/参数绑定及超时诊断、9 个 ID 各漏 1 项的拒绝、开放 Finding 确认、旧 Run 缺清单阻断、原 stdio 协议故障回归、合成评审→修复→复审→关闭。 |
| Conformance | 3/3 通过。 |
| clean-room | 从本次最新源码打包、安装、重启、注册 Extension 的检查通过。 |
| `npm run check`、`pack:dry-run`、`check:residue` | 通过；包版本 1.0.0，未发现临时目录或禁止残留。 |
| G2 真实宿主 | 未执行；Hook 桥只经过合成测试，本次插件候选已在本地打包但未安装，尚无真实 Codex 原生工具的机器直传/失败恢复证据。 |
| G3 真实业务 | 未执行；现有 Run `v3.8.4-quality-69b43609437505f3` 仍为 running、revision 15、Submission 0、Finding 0、Closure Receipt 0。 |

初次沙箱运行产生 `spawn EPERM`，未计为通过；完整回归、Conformance、clean-room 与打包检查均在允许本地测试子进程的环境重跑并通过。

Codex channel 本地打包通过：`artifactDigest=0ecddf2b5766ebb2e0452d5b06e81fcfa307772ffb402c66b4123a845588b092`，归档 SHA-256 为 `3e2720c3a2929f6e18fc67821467ffb0d2f8eceafd04ff19d69f8166033375e9`；归档已确认包含 `hooks.json`、`post-tool-host-bridge.mjs` 和 `hook-host-exchange.mjs`。该文件是未安装的本地候选，不是 G2 真实宿主证据。

## 继续执行的门槛

1. `npm run release:codex:check` 对当前工作树返回 `LOCAL_RELEASE_SOURCE_DIRTY`。项目约束将 Git commit 留给用户决定；目前没有提交、tag、插件重装或发布。先对本次 diff 完成审查并获得明确 commit 决定，才可按同版本卸载清缓存再安装流程形成 G2 的不可变制品。
2. G2 须用已安装插件的 `PostToolUse` Hook 在独立合成仓做短时真实宿主探针，证明当前桌面宿主实际提供 `tool_name`、`tool_input`、`tool_response`、`session_id`，Hook 能写入准确 Control Root，Coordinator 能消费同一请求的原生结果；随后再跑成功闭环、传输故障和重启续接。合成 Hook 测试不足以通过 G2；若任何字段、权限或 Hook 触发不成立，停在 `attention-required`，不得恢复人工转录。
3. G3 清单至少含已报告的 `R008-FSW-001`～`006`、`V384-R06`～`R08`。只读业务文档又标出 `V384-R01`～`R05` 五个 P1 为“历史关闭结论；当前未收口”；它们必须独立处置或与前六项建立证据支持的显式 alias 映射。不得以原 9 项清单推断全部 P0–P3 已关闭。
   `issues/cardworld-v3.8.4-known-finding-inventory.proposed.json` 已列出 14 个候选 ID 和两个当前匹配的文档 SHA-256，仅供 G3 注册前审查，尚未写入 Project Registry 或提升为 Authority Finding。
4. 完成 G2 后，再按准确业务目标、Registry/Release/Extension/Plan/Run 谱系和写入授权执行 G3。每次新故障先回放到短层回归；只有真实 Authority Closure Receipt 和全部最终 Gate 证据才能报告准出。
