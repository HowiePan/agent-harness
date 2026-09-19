# G0 状态机与调度并发图

## Engine Profile

```text
Requirement Intake → Canonical Requirement → Version Planning
→ Feature Work Graph → Implementation Waves → Scope Resolution
→ Quality Epoch → Docs Closeout → User Code Review → Delivery Receipt
```

Authority 边界：需求归并、版本批准、用户代码审核属于 Decision；Feature、Lease、Submission、Gate、Finding 属于 Kernel 对象。

## Collection Profile

```text
Rule Readiness → Batch Launch → Batch Feature Graph → Round Dispatch
→ Shared Capability Ownership → Game Harness Acceptance
→ Independent Release Review → User Game/Batch Acceptance
→ Batch Close → Collection Release Receipt
```

Authority 边界：Game、Batch 和 Round 是 Profile 投影；Feature/Dispatch/Lease/Attempt 才是 Kernel 调度事实。下一批是否 eligible 同时要求前批 closed 与用户 launch Decision。

## 统一调度算法

1. 只选择依赖全部满足且当前 Profile Barrier 放行的 Feature；
2. 排除与活动 Feature 在路径、符号、契约、生成物、artifact 或显式 conflict key 上冲突的候选；
3. Scheduler 返回有序候选 Intent，Kernel 再校验容量、权限、预算和 revision；
4. 一个 Lease 只拥有一个 Feature；Feature 内 Steps 由同一 Agent 顺序执行；
5. 阻塞 Feature 释放物理槽，只阻塞其依赖后继；
6. shared capability 由唯一 owner Feature 修改，消费者通过 dependsOn 等待；
7. 中央 registry/generated output 是独立 fan-in Feature；
8. ordinary Game fairness 只影响候选优先级，不能越过真实依赖或冲突。

## Collection 十游戏并行口径

- “十游戏并行”指当前批最多十个游戏可以同时保持逻辑活跃；
- 物理 Agent 数由用户上限、Runtime 容量和无冲突 eligible Feature 数的最小值决定；
- 同一游戏可以有多个互不冲突的 Feature，但不能以拆 Step 方式制造虚假并发；
- 单款 `awaiting-artifact` 不占槽；不依赖该 artifact 的游戏与 Feature 继续；
- B1 未关闭时，B2 Feature 不进入候选集合。

## 终态传播

| 事件 | Engine | Collection |
|:---|:---|:---|
| Feature completed | 解锁后继 Feature | 解锁同游戏/跨游戏依赖 |
| Feature blocked | 只传播到依赖后继 | 只传播到依赖 Feature；游戏可能部分可继续 |
| Quality finding | 当前 Epoch 修复图 | 当前 Review/Quality 修复图 |
| P0-P3 未清零 | 阻止 Delivery | 阻止 Game/Batch/Collection 准出 |
| User stop | Run 可恢复中断 | 当前 Round/Run 可恢复中断，不发下一批 |
| Hard recovery | 新 Epoch，旧 Lease 全失效 | 新 Epoch，旧 Round/Lease 全失效 |
