# Gate、Decision 与执行预检

Gate 是可重放的确定性检查；Decision 是外部 Authority 对受保护动作的批准或拒绝。两者不能互相伪造，也不能用 Agent 的“完成”文本替代。

## 注册门禁

Extension 注册核对完整制品清单、入口、版本和摘要；Project/Workspace 注册核对当前修订、唯一 command ID、配置摘要、路径及外部 Decision。高影响变更和 headless 策略有自己的精确 Decision 上下文。注册成功只说明配置进入 Registry，不代表允许启动 Run。

## 执行预检

每个 Lifecycle Plan 在创建 Run 前生成短时有效的 Execution Readiness Report：

| ID | 检查内容 | 常见恢复 |
|---|---|---|
| `plan` | Plan Schema 与摘要 | 重新生成 Plan |
| `project` | Descriptor 修订和摘要仍是当前值 | 重新规划 |
| `release` | Harness 制品或 source-link 摘要匹配 | 激活发布或 dev rebind |
| `run-lineage` | 继续、重附着、恢复或新建选择安全 | 处理阻断 Run/Lease |
| `workspace-source` | 工作区 Source digest 未漂移 | 重新规划或完成活动 Lease |
| `extension` | Extension 安装身份精确匹配 | 重新安装/注册并更新 Descriptor |
| `runtime` | Runtime 模式、权限和项目策略兼容 | 修改批准配置 |
| `result-transport` | Runtime 能承载类型化端口 | 选择兼容 Runtime |
| `result-contract` | 每个 Feature 结果合同可生成 | 修正 Flow 合同 |
| `prompt-transport` | Prompt Codec 提供完整 Agent Prompt | 安装/绑定 Codec |
| `user-constraint` | 用户约束允许显式无人值守模式 | 保持交互式或更新可信约束 |
| `command-grant` | headless 命令级 Grant 有效 | 由可信宿主重新签发 |
| `visible-host` | 可见宿主具备 inspect/spawn/wait/result/reconcile/confirm/contain | 安装完整宿主适配器 |
| `visible-host-contract` | 宿主 Effect 已对账并绑定合同 | 恢复宿主通道 |
| `active-leases` | 活动 Lease 可由原宿主安全重附着 | 重新连接或进入恢复 |
| `gates` | 所需 Gate 命令、目录、脚本、Sandbox 可用 | 修复项目工具链 |
| `write-capability` | 控制根原子写与清理成功 | 修复控制根权限 |

任一项失败均不创建 Run。报告过期后必须重新预检。

## Gate Recipe

Recipe 必填 `id`、`executionClass: deterministic-process` 和非空 `command`。可选字段为 `scope`（`feature`、`stable`、`final`）、`required`、`forceFresh`、`cwd`、`timeoutMs`、字符串环境变量、受管 `outputs`、`sandboxMode`、`sandboxPluginId`、`executorPluginId` 和 `toolchainDigest`。省略 `executorPluginId` 时使用内置进程执行器；指定时必须绑定已安装的 Gate Executor 插件。工作目录必须留在执行工作区；进程必须有实时进度观察器；Gate 前后 Source digest 不一致会失败。

`feature` Gate 由 Feature 的 `gatePlan` 绑定，在该 Feature 完成后执行；其依赖 Feature 必须等待检查通过。必需的 `stable` Gate 在全部 Feature 完成后、final Gate 前执行。成功缓存绑定 Gate spec、Source、实际可执行文件摘要、环境、Policy 和插件摘要；跨 Run 命中缓存仍须为当前 Run 写入派生 Evidence，并保留原始 Evidence 引用。关闭策略要求当前 Source 上的 fresh final Receipt；原始 Gate 结果不能通过任意 JSON 直接提交。

## Run 关闭条件

关闭至少要求图完成、结果合同通过、当前周期 P0–P3 Finding 全部关闭、必需 Gate 通过、必需 Decision 已批准且 Receipt 完整。发布激活、Recovery Capsule、真实 cutover、不可逆外部效果和旧文件删除是独立门禁；任何其他 Gate 通过都不自动授权这些动作。
