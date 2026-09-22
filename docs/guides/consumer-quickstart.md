# 业务项目接入：从 `harness.json` 到关闭 Run

本指南只使用发布包提供的 CLI、Schema 和文档，不要求查看 Harness 源码。需要 Node.js 22+、一个位于业务仓之外的 Harness 控制根、已安装的 Extension 制品，以及外部签发的 Authority Decision。

## 1. 创建项目配置

在业务项目根执行：

```text
agent-harness init create-config --config ./harness.json
agent-harness config validate --config ./harness.json --project-root .
```

编辑 `harness.json`，固定项目 ID/别名、Extension ID/版本/模块、Descriptor 生成器、Profile 和 `workspaceRoot`。项目专属 Gate、排除目录、Runtime 和 Flow 参数属于该文件，不得放回 Harness 发布仓。简要步骤见 `agent-harness docs show configuration`，完整字段见 `agent-harness docs show configuration-api`。

## 2. 生成初始化计划

```text
agent-harness init plan --config ./harness.json --project-root . --control-root <Harness控制根> --data-root <Harness数据根>
```

计划只读检查配置、Harness release、Extension manifest、现有 Registry 修订和工作区身份。检查输出中的 `planDigest`、Extension 动作和预期修订，再由外部 Authority 为该计划签发 Decision。CLI 和宿主不能把当前用户或参数转换成批准。

## 3. 注册并检查

```text
agent-harness init apply --plan ./init-plan.json --command-id project-init-001 --decision ./decision.json
agent-harness doctor --project <project-id> --profile <profile-id> --extension-id <extension-id>
agent-harness workflow list --project <project-id>
```

成功结果是带摘要的 Init Receipt；它同时给出宿主 `hostBinding`。项目配置留在项目仓，Sealed Descriptor、Extension Registry、Authority 和 Evidence 留在控制根。

## 4. 通过宿主运行

Codex 使用 `h:<alias> flow <workflow-id> <action> <target>`；只有一条绑定流程时可用 Extension 声明的短命令。OpenCode 和 VS Code 当前可以初始化和只读检查，但缺完整可信可见宿主合同时会明确返回 unsupported，不创建 Run。独立 CLI 也不直接执行 Agent。

宿主先解析唯一项目与 Workflow，再生成 Lifecycle Plan，执行短时预检，最后才创建 Run。运行依次经过 Dispatch、Lease、Submission、Finding、Gate/Decision 和关闭 Receipt。任何摘要漂移、权限缺失或宿主能力缺失都会在创建 Run 前失败。

## 5. 更新与本地调试

修改 `harness.json` 后重新计划并注册，产生新 Descriptor 修订；旧 Run 保持原身份。开发 Harness 自身时使用 `agent-harness dev execute` 和 development manifest，详见 `agent-harness docs show debug`。source-link 变化先经 H0–H4 分类：文档/测试与只影响未来编译结果的 H1 可以留 Receipt 后继续当前已冻结 Run；Profile、Gate、Runtime、Kernel 或 Authority 变化不能注入旧 Run。

发布包自带 `examples/project-harness.json` 作为中立配置示例，`npm run workspace:canary` 仅供 Harness 开发者做合成闭环验证，不是消费者接入前置条件。
