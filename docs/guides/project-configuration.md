# 项目配置指南

项目在仓库根保存 `harness.json`。它是项目拥有、可评审的接入意图；Registry、Run、Evidence、Cache 和 Recovery 仍位于业务仓之外。完整字段、默认值、Node、Feature、循环、Gate、Runtime 和错误码统一见[配置 API 参考](../reference/configuration-api.md)。本页只保留接入步骤。

## 创建和校验

```text
agent-harness init create-config --config ./harness.json
agent-harness config validate --config ./harness.json --project-root .
agent-harness config schema
```

`binding.workspaceRoot` 相对 `--project-root` 解析，推荐写 `.`。`project.input` 由对应 Extension 的 `projectConfiguration.schema` 校验，Core 再注入并核对 `id` 和绝对 `workspaceRoot`。接入方不需要也不应通过阅读源码猜私有参数。

## 初始化

```text
agent-harness init plan --config ./harness.json --project-root .
agent-harness init apply --plan ./init-plan.json --command-id init-001 --decision ./decision.json
```

或：

```text
agent-harness init execute --config ./harness.json --project-root . --command-id init-001 --decision ./decision.json
```

输出包含 `project-initialization-receipt` 和 `hostBinding`。修改配置后重新初始化会创建新 Project 修订，不会改写旧 Run。

## 归属与边界

业务流程参数必须留在各自项目的 `harness.json`，通过 Extension 注册；Agent Harness 包只提供中立样例和版本化 Schema。生产模式只加载制品清单覆盖的 Extension。项目配置不能生成批准，不能把 Authority 指回业务仓，也不能重排某个已发布 Extension 不允许覆盖的门禁和关闭规则。
