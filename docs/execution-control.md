# 插件执行输出、预算与 OS 沙箱

V1.0.0 把外部进程的中间产物纳入统一 Execution Controller。任何申请 `process.spawn` 的 Agent Runtime，以及声明 `process` capability 的 Gate Executor，都必须同时声明 `managed-outputs` 和 `execution.outputs`；缺失时 Plugin Host 以 `PLUGIN_MANAGED_OUTPUTS_REQUIRED` 或 `PLUGIN_OUTPUT_DECLARATIONS_REQUIRED` 拒绝加载。

## 输出声明

```json
{
  "capabilities": ["process", "managed-outputs"],
  "execution": {
    "outputs": [
      {
        "id": "build",
        "retention": "ephemeral",
        "environment": ["TOOL_BUILD_DIR"],
        "maxBytes": 1073741824,
        "maxFiles": 50000
      }
    ],
    "sandbox": { "mode": "required" }
  }
}
```

每项输出拥有稳定 ID、保留策略、环境变量映射、字节上限和文件数上限。Controller 在 Standalone Control Root 内为每次操作分配独立目录，并在合并调用方环境之后最后写入声明的环境变量。命令参数可用 `{{output:build}}` 引用实际目录；未知 ID 会在启动前拒绝。

保留策略只有四种：

- `ephemeral`：进程结束立即删除；
- `evidence-then-delete`：先读取并固化证据，再删除原始文件；
- `cache`：明确作为可复用缓存保留，仍受单次目录预算约束；
- `artifact`：明确作为交付制品保留，不作为临时文件清理。

默认 Process/Gate 临时输出上限为 64 MiB、10,000 文件。Codex Runtime 分别限制 temporary、debug 和隔离 workspace；Project 或 Plugin 可以收紧预算。并发最坏占用由“每目录预算 × 物理并发数”确定，不能依靠磁盘写满后再失败。

## 执行与清理闭环

生命周期固定为：声明校验 → 项目内目录分配 → 可选沙箱包装 → 进程启动 → 周期扫描 → 超限终止 → 最终核算 → 按保留策略清理 → 生成 Receipt。

容量扫描同时核算普通文件、符号链接数量和普通文件字节数。运行中首次超限会终止子进程；最终结果变为 `budget-exceeded`/`output-budget`。无论正常退出、超限、启动失败还是 Coordinator 后续提交失败，均进入清理路径。

清理 Receipt 记录每个输出的预算、周期扫描观测峰值、结束时用量、违规项、删除决定、删除后剩余文件/字节、Sandbox Receipt、时间和内容摘要。Gate Receipt 直接包含它；Runtime Coordinator 在删除调试目录后将 wait 与 cleanup Receipt 一并写入 Evidence。若需要不可瞬时突破的硬配额，必须由 `required` OS Sandbox Provider 提供配额卷、Job/容器限制或等价操作系统机制。

## 可选 OS 沙箱

`os-sandbox` 是独立插件类型，必须实现 `prepare(launch)`，将原始 executable/args/cwd/environment 包装成受隔离的启动定义并返回 Receipt。执行策略支持：

- `disabled`：明确不使用；
- `optional`：有 Provider 就应用，否则 Receipt 记录未应用；
- `required`：没有 Provider 时以 `OS_SANDBOX_REQUIRED` 启动前失败。

参考 Command Wrapper 负责合同与 Receipt，不冒充具体操作系统隔离。Windows AppContainer、Windows Sandbox、容器、受限账户或远端执行器应各自实现 `os-sandbox` Plugin。仅覆盖 `TEMP/TMP/TMPDIR` 无法阻止恶意第三方程序主动写绝对 C 盘路径；此类不可信进程必须配置 `required`，并由 Provider 在操作系统层限制可写根。

Sandbox Provider 可以添加包装命令或环境变量，但不能修改 Controller 已锁定的任何环境变量；尝试把已声明输出重新指向其他目录会以 `OS_SANDBOX_ENV_OVERRIDE` 在启动前拒绝。

Project Gate Recipe 可以声明 `outputs`、`sandboxMode` 和 `sandboxPluginId`。这使业务项目只提供策略和工具适配，不把具体工具链逻辑放进 Kernel。
