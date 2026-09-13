# ADR-0002：独立项目与零驻留边界

**状态**：Accepted  
**日期**：2026-09-12

## 决定

`agent-harness` 使用独立 Git、`package.json`、版本、Schema、文档和发布制品。它当前可位于 CardWorld 工作区内开发，但不得在运行或构建时引用父目录。业务项目以 Project Descriptor 外部注册；Authority、Evidence、Cache 与 Recovery 位于显式外部数据根。

CardWorld 与 Collection 不保存 Harness 实现和技术文档。项目差异由 Profile/Policy/Descriptor 表达；旧格式知识只存在于独立 Legacy Importer。

## 后果

- Harness 可以迁移到单独远端仓库或用于非 CardWorld 项目；
- 工具和模型通过插件替换，不改变 Kernel；
- 业务仓路径变化只需重新附着 Registry；
- 真实旧 Harness 切换、只读归档和删除是高影响操作，必须由用户单独批准；
- 项目所有者于 2026-09-13 选择 MIT License；`LICENSE`、`package.json`、release manifest 与 SBOM 必须保持一致。
