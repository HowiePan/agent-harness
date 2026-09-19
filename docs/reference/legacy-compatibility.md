# Legacy Characterization 冻结基线

**状态：** Legacy Importer 的现行兼容参考。以下来源名称和摘要是冻结测试样本的身份，不代表真实业务 Run 已恢复。

V1.0.0 将旧 Harness 的兼容输入冻结为公开、脱敏、合成 Fixture。Importer 测试直接读取这些文件并锁定目录摘要，因此后续维护不需要再次读取 CardWorld 或 Collection 的旧 Harness 源码来推断格式。

| 来源 | Fixture | 冻结目录 SHA-256 | 必须保持的解释 |
|:---|:---|:---|:---|
| CardWorld T1/T2 | `test/fixtures/legacy/cardworld/` | `f83038261585fd878d07ca3eb9799aa140bce1a188fe8163215a1939f4caaaf5` | Lease/Dispatch 无效；旧完成态需重验；Attempt 只作稳定预算输入 |
| Collection M2/B1 | `test/fixtures/legacy/collection/` | `f2d85a6964634860c60d4a03a306c1dc9c38ca56fb2c477febd9a30f3ebed7b5` | Round 0.2/Report 0.4 仅是旧投影；Lease 无效；完成态需重验；阻塞只作历史 |

冻结基线不声称复制了旧系统全部运行数据。它锁定的是 V1.0.0 明确支持的恢复协议表面：旧 Schema 识别、事实分类、Transport 作废、预算不刷新、新 Epoch 和回滚安全性。发现新的旧格式时，必须以新增脱敏 Fixture、Importer 用例和兼容说明显式扩展，不能临时读取旧实现后在 Kernel 增加条件分支。

在真实切换前，旧目录仍需保留只读，用于对具体现场执行一次 assessment 和摘要核对；切换完成并过稳定期后，旧实现不再是开发或设计参考，只作为用户批准的历史归档。删除旧目录仍是单独的破坏性操作。
