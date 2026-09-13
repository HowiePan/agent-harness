# CardWorld Engine 接入

CardWorld 只作为一个 Consumer，不向公共 Kernel 注入业务分支。外部控制面使用 `createCardWorldProjectDescriptor()` 生成 Project Descriptor，使用 `compileCardWorldFeatureGraph()` 把单一 canonical requirement 与后续版本规划、实现、质量、文档和审核工作编译为通用 Feature Graph。

默认最终 Gate 是 `context-budget`、`rust-format`、`rust-tests-all-targets`、`rust-clippy-deny-warnings` 和 `wasm-release-boundary`。其中上下文预算检查器随 `agent-harness` 包发布，业务仓无需保存 Harness 脚本；Rust/WASM 命令只存在于 CardWorld Consumer Descriptor，不进入 Kernel。

```js
import { compileCardWorldFeatureGraph, createCardWorldProjectDescriptor } from 'agent-harness/consumers/cardworld-engine';

// 生产运行先由 Extension Registry 批准并安装 Consumer/Runtime 制品；
// Programmatic API 只能传入 loadExtensionPack(..., { requireArtifactManifest: true }) 的结果。

const descriptor = createCardWorldProjectDescriptor({
  workspaceRoot: 'F:\\CardWorld',
  remote: 'https://github.com/HowiePan/CardWorld.git',
});

const features = compileCardWorldFeatureGraph({
  requirement: { id: 'v-next', acceptance: ['权威需求已形成并获批准'] },
  features: [
    { id: 'plan', stage: 'version-planning', acceptance: ['计划通过'], allowedPaths: ['docs/versions'] },
    { id: 'engine-change', stage: 'implementation', dependsOn: ['plan'], acceptance: ['测试通过'], allowedPaths: ['card_world_engine/src'] },
  ],
});
```

迁移前只把旧 Engine 的运行状态作为一次性 Recovery Capsule 输入，不读取或执行旧 Harness 源码与 Skill。迁移后，冻结的 Characterization Fixture、Capsule 与 Importer 合同成为兼容基线。
