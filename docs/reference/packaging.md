# 渠道打包与本机安装

通用 Harness npm 包与 Codex 宿主插件现在使用独立的打包入口和制品身份。渠道由命令显式选定；命令不根据当前目录、已安装插件或环境变量猜测渠道。

| 命令 | 制品或动作 |
| --- | --- |
| `npm run build:release-metadata` | 重建通用 Harness 包的文件摘要清单与 SBOM |
| `npm run pack:core` | 生成通用 Harness npm 包及 Core 回执 |
| `npm run pack:codex` | 生成 Codex 插件渠道包及回执，绑定精确 Core 版本和 `packageDigest` |
| `npm run pack:opencode` | 生成实验性 OpenCode 渠道归档；不表示已具备可验证的原生生命周期宿主 |
| `npm run pack:vscode` | 生成实验性 VS Code 渠道归档；不表示已具备可验证的原生生命周期宿主或 VSIX 发布资格 |
| `npm run check:opencode` / `npm run check:vscode` | 校验各渠道清单、包结构和 fail-closed 宿主边界 |
| `npm run check:codex-host-fast` | 不安装插件，直接验证 Hook bootstrap、绑定、发布工作流与 Runtime composition 协议 |
| `npm run check:channels -- --core <tgz> --codex <tgz>` | 在临时目录安装两个包、按清单组合插件、隔离加载 Hook，并完成一次原生 `PostToolUse` 往返 |
| `npm run deploy:codex -- --archive <codex.tgz>` | 从当前已核验 Core 和 Codex 渠道创建不可变 Runtime composition，并保存组合部署回执；不修改活动指针 |
| `npm run release:codex:check` | 只读检查干净提交、活动 Core、插件绑定和本机 Codex 能力 |
| `npm run release:codex:prepare` | 在安装前完成快速检查、完整测试、Clean Room、两个渠道包、组合校验和 Core Release Candidate，并封存准备回执 |
| `npm run release:codex:local -- --prepared <receipt.json>` | 只接受准备回执中的精确制品；复核活动组合身份后执行一次重装并核验本机 Codex 插件 |

制品放在 `.agent-harness-data/channel-packages/<channel>/<identity>/`。Core 包不再包含 `.agents/` marketplace 或 `integrations/codex/agent-harness-codex/` 宿主插件；原有公开 Codex Runtime/Extension 子路径仍由通用包提供，以维持 V1.0.0 接口。Codex 渠道包包含插件、Skills、Hook、脚本、marketplace 和 `codex-channel-manifest.json`，其 `requiresCore.packageDigest` 必须匹配 Core 包。它是绑定该 Core 布局的渠道包，不是可脱离 Core 单独运行的插件。

部署命令不会再向活动 Core 目录叠加文件，而是在 `.agent-harness-data/compositions/<version>/<compositionDigest>/` 创建同时固定 Core `packageDigest`、Codex `artifactDigest` 与逐文件摘要的不可变组合。需要使用该组合时，先把部署回执传给 `release activation-plan --runtime-composition-receipt <receipt.json>`，再走既有 Authority activation Gate；激活计划、活动指针和插件绑定都会保留同一 `compositionDigest`。生成组合本身不构成激活授权。

准备与安装严格分离。`prepare` 失败只修源码或协议并重跑无安装阶段；`local --prepared` 不再重跑构建和测试，也不能接受另一个 commit、Core、Codex 渠道或被修改的归档。安装完成后只执行一次最长五秒的有界缓存 Hook bootstrap 探针，验证已安装 Hook、bindings 与 active Runtime bridge 能被实际加载；没有 pending Host request 时立即以精确 reason code 收束，不再等待二十秒超时。这样真实安装只承担最终宿主缓存与加载验证，不承担逐个发现源码缺陷的职责。

OpenCode 与 VS Code 归档当前只验证渠道结构和适配边界。两者的 adapter 都要求宿主注入完整的 spawn、inspect、wait、result、cancel、Host Effect reconciliation 与 Lease confirmation 原生能力；缺一项即拒绝执行。OpenCode 只开放初始化/状态/Gate 工具和受管写保护，VS Code 只开放状态、空态树与 diff 查看；`full`/`quality` 明确返回 unsupported 且不创建 Run。这些归档不进入 Codex 组合、安装或发布 Gate。

`npm run pack:dry-run` 保留为通用包预览。`npm run build:release-candidate` 仍要求干净且已提交的源码，生成 Core 候选包及验证回执。本机安装流程不会执行 Git commit/tag/push、npm publish、签名或真实业务 Run 切换；对外发布仍由所有者另行决定。当前没有 VSIX 安装/发布流程。
