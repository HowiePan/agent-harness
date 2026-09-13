# Operator Contract

Operator Contract 是工具无关的 Harness 协调规范。Codex Skill、未来其他 Agent 工具适配器和人工运维都必须实现同一组可观察行为，而不能各自发明状态机。

## 权威与循环

- Authority 是唯一流程状态；对话、模型记忆、进程输出与报表都是非权威输入。
- 所有写命令绑定 expected revision 和唯一 command ID。
- `start`、`resume` 或调度返回首批 Dispatch 后，Operator 必须持续消费全部 Dispatch、Lease、Runtime 结果、Gate、Decision 和 Receipt，直到 Run 关闭、失败或需要用户权限。
- 单个 Agent 完成不等于 Run 完成。
- Feature 是调度单元；Feature 内 Step 串行，不同 Feature 由依赖、冲突、lane、逻辑配额和物理容量共同决定并行。

## 扩展解析

默认 Harness 只装载中立 Core、Feature Profile 和参考插件。已批准的 Extension Pack 位于独立控制根，通过持久安装回执自动解析。Project Descriptor 必须精确声明 Harness 制品及所需 Extension Pack 的 ID、版本与制品摘要；任一身份缺失或不符必须在 Run 创建前失败。Runtime、模型、工具和 OS 沙箱都通过 Extension/Plugin 解析，Operator 不得写死供应商。

## 路径与回执

Harness 数据、临时目录、调试输出、构建制品和缓存只能写入 Standalone Control Root 内。npm 包目录不能隐式成为数据根。进程插件必须声明容量预算、保留策略和沙箱模式，并在成功、失败、超限与取消路径返回清理回执。未声明输出视为协议错误。

## 权限边界

真实 cutover、live hard recovery、发布、不可逆存储迁移、Legacy Capsule 销毁以及旧 Harness 删除都要求用户在动作前单独批准。迁移计划、验收通过或旧内容已不再使用，都不构成删除授权。

live hard recovery 只允许走 Recovery Coordinator：先对 Capsule 执行严格完整验证并生成有有效期的内容寻址 verification Evidence，再记录 `live-hard-recovery` approved Decision。Decision 上下文必须绑定 project、run、verification ref、命令使用的 expected revision 和目标 epoch；执行命令必须提供稳定 command ID。普通 assessment JSON、缺失或过期 Decision、上下文错配和绕过 Coordinator 的 Kernel 调用一律拒绝。
