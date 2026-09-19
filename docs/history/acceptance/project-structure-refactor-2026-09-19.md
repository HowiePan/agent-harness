# 项目结构整改命令级验收

> 历史验收记录：以下 Run ID 和结果对应 2026-09-19 工作树。后续文档和源码变化须重新验证。

**范围：** 2026-09-19 工作树，V1.0.0 候选。验收使用合成来源、合成 Runtime 与独立临时控制数据；未启动真实 CardWorld、Collection 或其他业务 Run。`npm run workspace:canary` 先执行 Workflow Canary，再经伪命令解析、Workspace Registry/Workflow Binding、Plan、预检、Run、Dispatch/Submission、Gate/Decision 与关闭。所有下列正向 Run 均为 `closed`。

| 命令 | Workspace / Workflow | Run ID | 状态 |
| --- | --- | --- | --- |
| `h:engine full v1` | `engine` / `engine-delivery` | `v1-full-230b5b3948b70f9b` | `closed` |
| `h:collection full B1` | `collection` / `collection-batch-production` | `b1-full-681296f23fe12e73` | `closed` |
| `h:alpha flow requirements-design analyze audit-trail` | `alpha` / `requirements-design` | `audit-trail-analyze-44032cacf82a2bb0` | `closed` |
| `h:alpha flow source-brief summarize audit-trail` | `alpha` / 示例 `source-brief` | `audit-trail-summarize-0a78810ea9aa3352` | `closed` |
| `h:alpha flow knowledge-qa ask audit-trail --project alpha-front` | `alpha` / `knowledge-qa` | `audit-trail-ask-601f97e3799842df` | `closed` |
| `h:beta ask audit-trail` | `beta` / `knowledge-qa` | `audit-trail-ask-0a057e65dbd9f43b` | `closed` |
| `h:alpha flow knowledge-qa ask backend-audit --project alpha-back` | `alpha` / `knowledge-qa` | `backend-audit-ask-3bc648d2d8742e35` | `closed` |
| `h:alpha flow knowledge-qa ask expanded --projects alpha-front,alpha-back,alpha-analytics` | `alpha` / `knowledge-qa` | `expanded-ask-faf988d31437236b` | `closed` |
| `h:alpha flow knowledge-qa ask revocation-check` | `alpha` / `knowledge-qa` | `revocation-check-ask-5850712b54a5b49e` | `closed`，撤权后回滚继续 |

Workflow Canary 另有 7 个直接 Run 和 2 个并行需求整理实例，全部 `closed`；知识问答覆盖来源检索、记忆命中和证据不足时澄清。Workspace Canary 还确认工作区通用与项目记忆隔离、增仓使覆盖记忆失效、旧 Run 保持来源快照、撤权阻断后续 Dispatch、Provider 摘要不匹配拒绝、来源漂移拒绝、未决 Effect 无重复恢复以及回滚新修订。

以上是协议与参考路径的命令级准出证据。真实宿主在真实业务仓的工作质量、旧 Run 迁移与外部发布仍由各自 Gate 决定。
