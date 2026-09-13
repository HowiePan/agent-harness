# tabletop-collection 接入

Collection 使用独立的 `collection-batch` Profile：Rule Readiness、批次发车、Game/Scenario Feature Graph、共享能力 owner、三层验收与批次关闭都留在 Profile/Policy；Authority、Lease、Attempt、Evidence、Gate 和 Recovery 复用公共 Kernel。

`compileTabletopCollectionFeatureGraph()` 最多接受 10 个逻辑游戏 lane。每个游戏内部仍拆成有验收、依赖和路径边界的 Feature；Feature 内 Step 串行，Feature 之间由真实依赖与冲突决定并行。共享能力由一个 owner Feature 修改，消费者会自动依赖 owner。批间保持 Barrier，单款阻塞释放执行槽。

```js
import { compileTabletopCollectionFeatureGraph, createTabletopCollectionProjectDescriptor } from 'agent-harness/consumers/tabletop-collection';

// 生产运行先由 Extension Registry 批准并安装 Consumer/Runtime 制品；
// Programmatic API 只能传入 loadExtensionPack(..., { requireArtifactManifest: true }) 的结果。

const descriptor = createTabletopCollectionProjectDescriptor({
  workspaceRoot: 'F:\\CardWorld\\tabletop-collection',
  remote: 'https://github.com/HowiePan/CardWorld.git',
  maxConcurrency: 10,
});

const features = compileTabletopCollectionFeatureGraph({
  batchId: 'B1',
  games: [{
    id: 'game-a',
    ruleStatus: 'rule-ready',
    features: [{ id: 'implementation', acceptance: ['黑盒验收通过'], allowedPaths: ['packages/games/game-a'] }],
  }],
});
```

Collection Descriptor 默认选择 `codex-isolated-runtime`，可以让 10 个执行器分别在 Harness 数据根下的独立工作区同时运行。每个结果先与自己的初始快照核对 changed files，再按目标文件的原始摘要做乐观合并；任一文件在 Dispatch 后被其他执行修改，就以 integration conflict 阻断，不能覆盖。根级 `node_modules` 默认以目录链接复用，也可通过 `runtimeConfigs.codex-isolated-runtime.linkedDirectories` 调整。若显式改用 `codex-cli-runtime` 共享目录，Coordinator 会把物理并发安全收紧为 1。

最终 Gate 来自 Collection Descriptor：typecheck、test、Web build、mobile、desktop、registry、game packs、acceptance ledgers、engine boundary、release contract 和 cleanroom。P0-P3 都必须在当前质量周期关闭，不存在 P2/P3 owned-debt 延期准出。
