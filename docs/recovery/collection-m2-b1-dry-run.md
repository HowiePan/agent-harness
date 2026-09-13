# Collection M2/B1 Legacy Recovery Dry-run

**执行方式**：只读 Inventory；未启动或恢复 B1  
**源**：`tabletop-collection/runs`  
**文件数**：2  
**事实数**：6

- source digest：`b5a78c3d815803e4307f43f1b7155a284245a86a22505e6a65821f94717f352b`
- assessment digest：`7f8a76ce7c742879007f77e226019aff98823aff62d33aece3d575d2c8a1f47c`
- `legacy-only`：2
- `invalid`：2
- `stale-revalidate`：1
- `log-only`：1

现场补充：B1-R001 为 Round 0.2，68 个条目中 52 complete、16 blocked，存在 3 个旧 Lease；这些只用于恢复评估。新 Profile 不继承 Round 硬编码，也不把旧 Lease 或完成字符串带入新 epoch。
