# G0 禁止继承的旧行为

| ID | 行为 | 判定 | V1.0.0 替代 |
|:---|:---|:---|:---|
| G0-R01 | Collection 入口硬编码 B1 | `reject-defect` | Project Descriptor 动态 active batch |
| G0-R02 | JS/TS 两套 Round Authority | `reject-defect` | 单一 Kernel Authority，Round 仅为投影 |
| G0-R03 | 普通 `writeFile` 覆盖 Round | `reject-defect` | expected revision + command ID + 原子事务 |
| G0-R04 | CLI `--output-file` 覆盖受管路径 | `reject-defect` | Dispatch 唯一 output reference |
| G0-R05 | 以 evidence 路径存在作为当前证据 | `reject-defect` | 内容寻址 Evidence + source/artifact/policy 绑定 |
| G0-R06 | Step/scenario 通过换 ID 刷新预算 | `reject-defect` | 稳定 logical root 的 Feature Attempt Budget |
| G0-R07 | 固定 Codex/对话 transport 写入 Kernel | `supersede` | 版本化 Agent Runtime Plugin |
| G0-R08 | P2/P3 owned debt 绕过当前版本 | `supersede` | 当前 Epoch P0-P3 全量关闭 |
| G0-R09 | 旧 completed/approved 直接恢复 | `reject-defect` | Hard Recovery disposition + 当前重验 |
| G0-R10 | `serial` 标签充当全局锁 | `supersede` | 真实依赖与 conflict graph |
| G0-R11 | 一个游戏阻塞导致整批停止 | `reject-defect` | 依赖影响集传播并释放槽 |
| G0-R12 | 批内所有任务无条件并行 | `reject-defect` | Feature eligibility + conflict graph |
| G0-R13 | Runtime heartbeat 合同与 CLI 不一致 | `reject-defect` | Plugin conformance 强制能力一致 |
| G0-R14 | Engine/Collection 业务状态进入 Kernel 分支 | `reject-defect` | 独立 Profile/Policy 状态机 |
| G0-R15 | Harness 状态和技术文档必须驻留业务仓 | `supersede` | 外部 Registry/State/Evidence Root |
