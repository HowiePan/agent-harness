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

Collection Descriptor 默认选择 `agentExecutionMode: conversation-visible` 和 `codex-conversation-runtime`。当前 Codex 宿主为每个 Dispatch 创建可见子 Agent，Lease Receipt 固定任务引用，Operator 持续显示状态并记录 heartbeat；原生委派不可用时停止，绝不回退到 CLI。该 Runtime 保守声明共享工作区，因此物理并发收紧为 1，直到宿主提供带基线校验和安全合并的可见隔离工作区能力。

`codex-isolated-runtime` 与 `codex-cli-runtime` 仍作为显式 `headless`/CI 选项保留。前者可以在独立目录中执行并进行 changed-files 对账和乐观合并，后者共享目录并收紧为单物理槽；二者都不是交互式默认值，也不能在可见宿主缺失时自动启用。

最终 Gate 来自 Collection Descriptor：typecheck、test、Web build、mobile、desktop、registry、game packs、acceptance ledgers、engine boundary、release contract 和 cleanroom。P0-P3 都必须在当前质量周期关闭，不存在 P2/P3 owned-debt 延期准出。
