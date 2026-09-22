# 配置多项目 Workspace

Workspace 把多条已发布 Flow 与多个项目、来源、执行目标和资源组合起来。项目仓内的 `harness.json` 用于单项目初始化；多项目 Workspace Descriptor 也应由拥有它的集成项目保存，再注册到业务仓之外的 Registry。

## 身份与 Flow

为工作区分配稳定 `workspaceId` 和唯一 `alias`。每条 Workflow Binding 固定 ID、版本、artifact digest、Extension、Profile、允许的项目、默认项目范围和执行目标。一个 Workspace 可绑定多条 Flow；命令歧义时必须显式选择 Workflow。Workspace 不能改变 Flow 节点、分支、repeat、Gate 或关闭规则。

## 项目、来源和执行目标

成员项目声明可见 Source 和可用 Execution Target。Source 固定类型、根目录、所有者、共享项目、允许接收者、路径和修订；实际读取还要通过 Run 内固定的 Source Manifest。Execution Target 明确可写项目，目标之间不得形成未声明的重叠写区域。控制根、Registry、Authority 和 Evidence 不得位于任一业务执行目标内。

## 资源

Resource Binding 固定 Provider ID/版本/摘要、作用域和项目读写列表。工作区资源只放跨项目概念；项目实现细节进入项目资源；流程、来源和会话资源继续限域。导入知识先是未核验候选，来源增加、变化或撤权会使覆盖摘要失效并触发复核。

## 注册与变更

```text
agent-harness workspace register --input ./workspace.json --expected-revision 0 --command-id ws-001 --decision ./decision.json
agent-harness workspace show --workspace-id <id>
```

Decision 必须未过期并精确绑定 `workspace-register` 上下文。增仓、来源授权、执行目标、资源或 Workflow 变化创建新修订；Plan 固定修订，旧 Run 不被改写。撤权立即阻断后续 Dispatch/读取；回滚使用 `workspace rollback` 创建新修订，不能编辑 Registry 文件。

## 验收

验证命令解析到唯一 Workspace/Flow，默认项目范围正确，跨项目 Source/Resource 未越权，执行目标不冲突，Provider 摘要匹配，增仓使知识覆盖失效，撤权阻断后续访问，旧 Plan 被拒绝，回滚产生新修订，并用合成 Runtime 到达 `closed`。真实业务运行、外部写入和 cutover 仍需对应 Gate。
