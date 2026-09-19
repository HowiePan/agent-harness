# 写入路径与清理策略

V1.0.0 的硬不变量是：Harness 自有状态和中间产物只能写入已初始化 Standalone Control Root 的后代路径。源码 checkout 可直接作为控制根；npm 包位于 `node_modules` 时必须显式指定包含 Runtime 的专用控制根，并由安装标记锁定 Runtime 相对位置。Windows C 盘不能成为控制根。路径守卫使用规范化绝对路径和相对包含关系判断；控制根本身、父目录、用户目录、系统临时目录、业务仓以及任何其他磁盘位置都会被拒绝。

## 路径分类

| 类别 | 受管位置 | 生命周期 |
|:---|:---|:---|
| Authority、Evidence、Registry、Receipt | `.agent-harness-data/` | 持久；按运行保留策略显式归档或删除 |
| Runtime 调试输出和隔离工作区 | `.agent-harness-data/runtime/` | 回执先固化为 Evidence，随后在 `finally` 清除原始目录 |
| Gate 临时文件 | `.agent-harness-data/tmp/gates/` | 每个 Gate 结束时清除，失败和超时也执行 |
| 插件声明的构建/调试输出 | `.agent-harness-data/**/<operation>/<output-id>/` | 实时受字节/文件预算约束；按声明的 retention 清理 |
| 测试与 clean-room | `.tmp/` | 每轮结束时清除，成功和失败都执行 |
| npm 缓存 | `.agent-harness-cache/` | 仅开发/打包验证使用；受管验证入口结束时清除空壳或缓存 |
| 发布包 | 项目根下的显式 `.tgz` | 只有执行真实 `npm pack` 才生成，属于用户请求的交付物，不视为临时文件 |
| 上游问题登记 | `issues/` | 用户通过 `h:report` 明确授权创建的版本化维护制品；需单独 commit/push 才能跨设备保留 |

`doctor` 是零写入命令，只验证路径。原子写失败会删除尚未 rename 的临时文件。显式 headless Runtime 与 Gate/构建/测试子进程的 `TEMP`、`TMP`、`TMPDIR` 最后覆盖为本轮受管目录，Project/Plugin 配置不能覆盖；conversation-visible Agent Runtime 不启动本地子进程。

`issues/` 是唯一额外的版本化维护写入边界：根路径固定为已绑定 `controlRoot` 的直接子目录，命令不得覆盖或配置其他位置。每次写入必须有稳定 command ID、内容摘要、原子提交和 Receipt；对话内容先脱敏，并明确不具备 Authority 效力。

## 业务输出例外

Harness 自有数据不得写入业务仓，但完成 Feature 本身必须能够修改已注册业务工作区。此类写入不是 Harness 临时产物：它只允许由 Runtime 或 Tool Broker 在 Project Descriptor 指定的工作区内执行，并继续受 Feature `allowedPaths`、`forbiddenPaths`、快照差异和提交校验约束。除此之外，不存在业务仓写入例外。

第三方 Runtime 若绕过 Harness 提供的环境变量并自行选择全局缓存目录，属于 Provider 合同违约；上线前必须通过 Runtime Conformance。需要操作系统级的绝对阻断时，应再叠加容器、ACL 或专用执行账户，防止第三方二进制无视进程环境。

进程插件现在必须声明 `managed-outputs`；不可信工具应同时把 `sandbox.mode` 设为 `required`。详细生命周期与清理 Receipt 见 [插件执行输出、预算与 OS 沙箱](./execution-control.md)。
