# AH-20260913-AB2DBEDCE37B：绑定的数据根未初始化或不可写，导致 h:engine quality V3.8.4 无法启动

- 状态：Intake / Pending Triage
- 级别：P1
- 观察时间：2026-09-13T13:00:00.000Z
- 项目别名：engine
- Project：cardworld-engine
- Profile：engine-delivery
- Extension：cardworld-engine-profile
- Intake 摘要：ab2dbedce37b90e58da771eb5e3a93224dec0923bf4c397caf30ba2f434141a1

## 期望

```json
{
  "result": "绑定安装完成只读预检后，可解析 Project Descriptor、Extension Pack 与 Authority，再决定是否启动 quality Gate"
}
```

## 实际

```json
{
  "result": "project list 在创建 dataRoot 下 authority 目录时返回 EPERM；未读取 Registry、未核对 Authority、未执行 quality Gate"
}
```

## 复现

1. 对绑定的 controlRoot 与 dataRoot 执行 doctor，观察 ok=true、releaseVerified=true、initialized=false、extensions=[]。
2. 对同一绑定执行 project list。
3. 观察 F:\agent-harness\.agent-harness-data\authority 创建失败并返回 EPERM。

## 缺失证据

- Harness artifact digest
- Extension installation receipt
- Project Descriptor digest
- Authority revision
- data root ACL 与有效写权限检查结果

## 对话上下文

完整的已脱敏上下文保存在同目录的 `intake.json`；对话只作为问题输入，不是 Harness Authority。共记录 2 条摘录。

## 脱敏

确认：是

移除项：无关对话；完整工具输出；账户与凭据信息
