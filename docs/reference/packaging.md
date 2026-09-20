# 渠道打包与本机安装

通用 Harness npm 包与 Codex 宿主插件现在使用独立的打包入口和制品身份。渠道由命令显式选定；命令不根据当前目录、已安装插件或环境变量猜测渠道。

| 命令 | 制品或动作 |
| --- | --- |
| `npm run build:release-metadata` | 重建通用 Harness 包的文件摘要清单与 SBOM |
| `npm run pack:core` | 生成通用 Harness npm 包及 Core 回执 |
| `npm run pack:codex` | 生成 Codex 插件渠道包及回执，绑定精确 Core 版本和 `packageDigest` |
| `npm run check:channels -- --core <tgz> --codex <tgz>` | 在临时目录安装两个包、按清单组合插件并加载 Hook |
| `npm run deploy:codex -- --archive <codex.tgz>` | 将已核验的 Codex 渠道文件部署到当前激活的 Core Runtime，并保存渠道部署回执 |
| `npm run release:codex:check` | 只读检查干净提交、活动 Core、插件绑定和本机 Codex 能力 |
| `npm run release:codex:local` | 全量验证、生成两个渠道包和 Core Release Candidate，再重装并核验本机 Codex 插件 |

制品放在 `.agent-harness-data/channel-packages/<channel>/<identity>/`。Core 包不再包含 `.agents/` marketplace 或 `integrations/codex/agent-harness-codex/` 宿主插件；原有公开 Codex Runtime/Extension 子路径仍由通用包提供，以维持 V1.0.0 接口。Codex 渠道包包含插件、Skills、Hook、脚本、marketplace 和 `codex-channel-manifest.json`，其 `requiresCore.packageDigest` 必须匹配 Core 包。它是绑定该 Core 布局的渠道包，不是可脱离 Core 单独运行的插件。部署命令只安装渠道清单列出的文件并单独核验渠道摘要，不用渠道包内的 npm `package.json` 覆盖 Core 包或修改 Core 发布清单。

`npm run pack:dry-run` 保留为通用包预览。`npm run build:release-candidate` 仍要求干净且已提交的源码，生成 Core 候选包及验证回执。本机安装流程不会执行 Git commit/tag/push、npm publish、签名或真实业务 Run 切换；对外发布仍由所有者另行决定。当前没有 VS Code 渠道命令或 VSIX 制品。
