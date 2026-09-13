# CardWorld Engine Legacy Recovery Dry-run

**执行方式**：只读 Inventory；未启动或恢复真实 Run  
**源**：`CardWorld/.harness/engine`  
**文件数**：3,797  
**事实数**：1,438

- source digest：`32bd8be5c28b339bc54e543b69baf1dac8b8a560eadc877c7bf4e6e87451f47d`
- assessment digest：`6de24384eb228da5f706897ee7504f61621686239255bc32d3631cf91bac608c`
- `stale-revalidate`：1,362
- `log-only`：42
- `invalid`：34

结论：旧事实可以被枚举和确定性分类，但绝大多数运行事实绑定旧源码、旧 generation 或旧 Gate，因此不能升级为新 Authority。真实 Hard Recovery 必须在冻结后的源摘要上重跑评估，并由用户批准新 epoch。
