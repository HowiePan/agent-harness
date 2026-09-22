# 运行与恢复

控制根位于业务仓外，保存 Extension Registry、Workspace Registry、Authority、Evidence、Cache 和 Recovery。生产制品安装须有完整文件清单摘要和批准回执；进程重启后按回执恢复绑定。使用 `node bin/agent-harness.mjs doctor` 检查安装和存储，但具体动作仍须对确定的 Plan 预检。

执行失败先读取 Run 状态、Dispatch/Lease、Evidence 和 Gate Receipt。普通继续废止旧 Transport；硬恢复需经过 Capsule、验证、Resolution Receipt 与新 Epoch。不要从旧状态字符串直接推断新权威结论，也不要因迁移 Gate 通过删除旧业务仓文件。发布、真实 cutover、Git commit/tag 和旧文件清理分别按所有者授权执行。

本地代码准出命令：`npm test`、`npm run test:conformance`、`npm run check`、`npm run workflow:canary`、`npm run workspace:canary`、`npm run check:clean-room`、`npm run pack:core`、`npm run pack:codex`、对两个正式包运行 `npm run check:channels`、`npm run check:opencode`、`npm run check:vscode`、`npm run check:residue`。OpenCode/VS Code 仅验证实验渠道结构与 fail-closed 行为，不构成发布或宿主执行准出。四条流程必须在命令级 Canary 中各有 `closed` Run；单元测试全绿不能替代。Core 与 Codex 渠道产物及本机安装入口见[渠道打包](../reference/packaging.md)。
