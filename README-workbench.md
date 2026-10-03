# 字体搭配 · 发布工作台

在原有 Type Pairer 草稿编辑器之上，构建了一套「草稿 → 审批 → 确认快照 → 发布」一致性工作台，
解决成员离线改字号/授权后回连覆盖同事版本、旧审批仍放行等问题。

## 需求与实现对照

| 需求 | 实现 |
| --- | --- |
| 草稿和确认快照分开放 | `WorkbenchState.records[*].draft`（可反复改、rev 单调递增）与独立不可变桶 `WorkbenchState.snapshots[key]` 分离；确认后再覆盖草稿，不影响已确认版本 |
| 离线补丁回来先核对基准 | 离线时冻结 `OfflineSession.baseRevision/baseContent`；`reconnect()` 先比 rev，基准落后则逐字段三路合并（base/local/remote） |
| 冲突字段保留双方值并挡住发布 | 双方都改且不同 → 草稿落同事值，`conflicts[]` 同时保留 base/local/remote；冲突在身时提交审批、确认、发布全部拒绝；逐字段选择保留一方后才解除（且仍需重新审批） |
| 授权到期或换版后，审批和发布候选失效重算 | 审批绑定 `baseContentHash + licenseFingerprint + schemaVersion + 授权有效期`，确认/发布前实时核对；`bumpSchemaVersion` 换版即作废；虚拟时钟快进可演示到期 |
| 写入失败后从完整快照恢复 | `Store.mutate` 写前先备份上一版整份状态，成功后备份推进到最新版；写失败/回读校验失败立即回滚；启动时根数据损坏也从备份引导恢复 |
| 两个窗口同时确认，先到版本生效 | CAS 乐观锁（etag 比对）+ 审批「一次只能绑定一个快照」的业务唯一约束；后到窗口重试锚定到先到版本 |
| 重试不重复生成记录 | 确认与发布都带幂等键 `idem[key]`；同键重试返回同一条快照/发布记录，不新建 |
| 旧数据只有草稿时升级，缺授权停在待补 | `storageVersion=1` 的旧 `type-pairs` 首次加载经 `migrateState/migrateRecord` 升级为带授权槽位的 v2 记录；无授权即 `awaiting-license`，审批/确认被挡 |

## 目录结构

```
src/core/types.ts   领域模型（草稿、授权、审批、快照、候选、发布、离线会话、冲突）
src/core/engine.ts  纯逻辑引擎：指纹、状态重算、审批/确认/发布、三路合并、迁移、到期重算
src/core/store.ts   存储层：CAS 提交、写前完整快照备份与恢复、内存/localStorage KV
src/useWorkbench.ts React 适配（统一 mutate 入口、虚拟时钟、Toast）
src/demo.ts         场景演练（双窗口、幂等、离线冲突、损坏恢复、旧数据迁移、播种）
src/App.tsx         工作台界面
src/core/__tests__/ engine.test.ts —— 19 个 node:test 用例覆盖上述全部场景
```

## 命令

```bash
npm run dev     # 本地开发
npm test        # 编译并运行 19 个引擎/存储一致性测试
npm run build   # 类型检查 + 生产构建
```

## 界面内可演练

- 顶部「快进 7/45 天」：让授权到期，观察审批/候选即时失效；
- 记录详情「离线补丁与三路合并」：开始离线 → 离线改字号/授权 → 模拟同事在线改动 → 回连，
  冲突字段保留双方值并挡住发布，选择保留一方后重新走审批；
- 右上「场景演练」：双窗口同时确认、幂等重试、离线冲突、根数据损坏后恢复、旧草稿迁移。
