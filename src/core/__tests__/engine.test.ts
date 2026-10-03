import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bumpSchemaVersion,
  confirmSnapshot,
  connectStore,
  contentHash,
  createRecord,
  decideApproval,
  emptyState,
  goOffline,
  licenseFingerprint,
  migrateRecord,
  migrateState,
  offlineEdit,
  offlineSetLicense,
  publish,
  reconnect,
  remoteEdit,
  resolveConflict,
  setLicense,
  submitApproval,
  tick,
  updateDraftField,
} from './harness';
import { MemoryKV } from '../store';
import { Store } from '../store';
import { License, PairingRecord, WorkbenchState } from '../types';

const DAY = 86400_000;
const T0 = Date.parse('2026-10-02T09:00:00Z');

function license(over: Partial<License> = {}): License {
  return {
    holder: 'Acme Type Foundry',
    tier: 'web',
    validFrom: T0 - 30 * DAY,
    validUntil: T0 + 30 * DAY,
    ...over,
  };
}

function seedRecord(state: WorkbenchState, withLicense = true): PairingRecord {
  return createRecord(
    state,
    { id: 1, title: 'Editorial calm', license: withLicense ? license() : null },
    T0,
  );
}

function approveFlow(state: WorkbenchState, id = 1, now = T0, actor = 'Yuki'): void {
  assert.ok(submitApproval(state, id, now, actor).ok);
  assert.ok(decideApproval(state, id, 'approved', now, 'Boss').ok);
}

// ---------- 1. 草稿与确认快照分开放 ----------

test('草稿与确认快照分开放：确认后覆盖草稿不影响已确认版本', () => {
  const state = emptyState();
  seedRecord(state);
  approveFlow(state);
  const c = confirmSnapshot(state, 1, T0, 'Yuki', 'confirm-1');
  assert.ok(c.ok);
  const key = c.value!.snapshot.key;
  const snapHash = contentHash(c.value!.snapshot.content);

  // 草稿随后被改得面目全非
  assert.ok(updateDraftField(state, 1, 'size', 72, T0 + 1000).ok);
  assert.ok(updateDraftField(state, 1, 'headingFont', 'Playfair Display', T0 + 2000).ok);

  const snap = state.snapshots[key];
  assert.ok(snap, '快照独立存放于 snapshots 桶');
  assert.equal(contentHash(snap.content), snapHash, '快照内容不可变');
  assert.equal(snap.content.size, 46);
  assert.notEqual(contentHash(state.records[1].draft), snapHash);
});

// ---------- 2. 离线补丁回连核对基准；冲突保留双方值并挡住发布 ----------

test('离线补丁：基准一致时干净合并；旧审批因内容变化失效', () => {
  const state = emptyState();
  seedRecord(state);
  approveFlow(state);
  assert.ok(goOffline(state, 1, 'Yuki', T0).ok);
  assert.ok(offlineEdit(state, 1, 'size', 58).ok);
  // 无同事改动 → 基准修订号一致
  const r = reconnect(state, 1, T0 + DAY);
  assert.ok(r.ok);
  assert.deepEqual(r.value!.applied, ['size']);
  assert.equal(r.value!.conflicts.length, 0);
  assert.equal(state.records[1].draft.size, 58);
  // 旧审批不再放行
  assert.equal(state.records[1].approval!.state, 'approved');
  const confirm = confirmSnapshot(state, 1, T0 + DAY, 'Yuki', 'c2');
  assert.equal(confirm.ok, false);
  assert.match(confirm.error!, /content-changed/);
});

test('离线冲突：双方都改字号且不同，保留双方值，发布被挡住', () => {
  const state = emptyState();
  seedRecord(state);
  approveFlow(state);
  assert.ok(goOffline(state, 1, 'Yuki', T0).ok);
  assert.ok(offlineEdit(state, 1, 'size', 64).ok);
  assert.ok(remoteEdit(state, 1, 'size', 40, 'Lin', T0 + 3600_000).ok);

  const r = reconnect(state, 1, T0 + DAY);
  assert.ok(r.ok);
  assert.equal(r.value!.conflicts.length, 1);
  const conflict = r.value!.conflicts[0];
  assert.equal(conflict.field, 'size');
  assert.equal(conflict.base, 46);
  assert.equal(conflict.local, 64);
  assert.equal(conflict.remote, 40);
  // 草稿保留同事值；冲突清单保留双方值
  assert.equal(state.records[1].draft.size, 40);

  // 冲突在身：审批无法提交，确认/发布全部被挡住
  assert.equal(submitApproval(state, 1, T0 + 3 * DAY).ok, false);
  const blocked = confirmSnapshot(state, 1, T0 + 3 * DAY, 'Yuki', 'c4');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error!, /冲突/);

  // 解决冲突（保留离线值）后解除阻挡
  assert.ok(resolveConflict(state, 1, 'size', 'local', T0 + 3 * DAY).ok);
  assert.equal(state.records[1].draft.size, 64);
  approveFlow(state, 1, T0 + 4 * DAY);
  assert.ok(confirmSnapshot(state, 1, T0 + 4 * DAY, 'Yuki', 'c5').ok);
  assert.ok(publish(state, 1, T0 + 4 * DAY, 'Yuki', 'p1').ok);
});

test('授权也参与三路合并：离线换授权 + 在线续期 → license 冲突挡住发布', () => {
  const state = emptyState();
  seedRecord(state);
  assert.ok(goOffline(state, 1, 'Yuki', T0).ok);
  assert.ok(offlineSetLicense(state, 1, license({ holder: 'Offline Foundry' })).ok);
  assert.ok(
    setLicense(state, 1, license({ validUntil: T0 + 90 * DAY }), T0 + 3600_000, 'Lin').ok,
  );
  const r = reconnect(state, 1, T0 + DAY);
  assert.ok(r.ok);
  assert.equal(r.value!.conflicts.some((c) => c.field === 'license'), true);
  assert.equal(confirmSnapshot(state, 1, T0 + DAY, 'Y', 'c').ok, false);
});

// ---------- 3. 授权到期 / 换版后审批和候选失效重算 ----------

test('授权到期：已批准的审批不能确认；已确认的候选不能发布', () => {
  const state = emptyState();
  seedRecord(state);
  approveFlow(state, 1, T0);
  const later = T0 + 40 * DAY; // 超过 validUntil
  const confirm = confirmSnapshot(state, 1, later, 'Yuki', 'cexp');
  assert.equal(confirm.ok, false);
  assert.match(confirm.error!, /license-expired/);

  // 另一条：先确认再到期 → 候选失效
  const s2 = emptyState();
  createRecord(s2, { id: 2, title: 'B', license: license() }, T0);
  approveFlow(s2, 2, T0);
  assert.ok(confirmSnapshot(s2, 2, T0, 'Yuki', 'c2').ok);
  const expired = tick(s2, T0, T0 + 40 * DAY);
  assert.ok(expired.includes(2));
  const pub = publish(s2, 2, T0 + 40 * DAY, 'Yuki', 'p2');
  assert.equal(pub.ok, false);
  assert.match(pub.error!, /license-expired/);
});

test('续期/更换授权后必须重算：旧审批失效，重新审批后才能走通', () => {
  const state = emptyState();
  seedRecord(state);
  approveFlow(state);
  assert.ok(setLicense(state, 1, license({ validUntil: T0 + 120 * DAY }), T0 + 1000).ok);
  assert.equal(confirmSnapshot(state, 1, T0 + 2000, 'Y', 'c').ok, false);
  approveFlow(state, 1, T0 + 2000);
  assert.ok(confirmSnapshot(state, 1, T0 + 2000, 'Y', 'c2').ok);
});

test('换版：schema 升级后旧审批与发布候选作废', () => {
  const state = emptyState();
  seedRecord(state);
  approveFlow(state);
  assert.ok(confirmSnapshot(state, 1, T0, 'Y', 'c1').ok);
  assert.ok(bumpSchemaVersion(state, 1, T0 + 1000).ok);
  // 候选绑定旧版 → 不能发布
  const pub = publish(state, 1, T0 + 1000, 'Y', 'p');
  assert.equal(pub.ok, false);
  assert.match(pub.error!, /version-changed/);
  // 旧审批也失效
  assert.equal(confirmSnapshot(state, 1, T0 + 1000, 'Y', 'c2').ok, false);
});

// ---------- 4. 幂等：重试不重复生成 ----------

test('确认与发布幂等：同一幂等键重试只产生一条快照 / 一条发布', () => {
  const state = emptyState();
  seedRecord(state);
  approveFlow(state);
  const first = confirmSnapshot(state, 1, T0, 'Y', 'idem-x');
  assert.ok(first.ok);
  assert.equal(first.value!.reused, false);
  const retry = confirmSnapshot(state, 1, T0 + 5000, 'Y', 'idem-x');
  assert.ok(retry.ok);
  assert.equal(retry.value!.reused, true);
  assert.equal(retry.value!.snapshot.key, first.value!.snapshot.key);
  assert.equal(Object.keys(state.snapshots).length, 1);
  assert.equal(state.records[1].candidate!.snapshotKey, '1@1');

  const p1 = publish(state, 1, T0 + 6000, 'Y', 'pub-x');
  assert.ok(p1.ok);
  const p2 = publish(state, 1, T0 + 7000, 'Y', 'pub-x');
  assert.ok(p2.ok);
  assert.equal(p2.value!.id, p1.value!.id);
  assert.equal(state.records[1].releases.length, 1);
});

test('两个窗口同时确认：先到版本生效，后到窗口拿到同一条快照', () => {
  // 两个 Store 共享同一个内存 KV，模拟两个窗口
  const { storeA, storeB } = connectStore();
  const now = T0;
  storeA.mutate((s) => {
    seedRecord(s);
    return { ok: true };
  });
  storeA.mutate((s) => {
    submitApproval(s, 1, now, 'A');
    return { ok: true };
  });
  storeB.reload();
  storeA.mutate((s) => decideApproval(s, 1, 'approved', now, 'Boss'));
  storeB.reload();

  // 两个窗口几乎同时点确认，用各自幂等键
  const a = storeA.mutate((s) => confirmSnapshot(s, 1, now, 'A', 'win-a'));
  const b = storeB.mutate((s) => confirmSnapshot(s, 1, now, 'B', 'win-b'));
  assert.ok(a.result.ok);
  assert.ok(b.result.ok);
  assert.equal(a.result.value!.snapshot.key, b.result.value!.snapshot.key);
  assert.equal(a.result.value!.snapshot.confirmedBy, 'A', '先到窗口 A 的版本生效');
  // 快照只有一条；审批只绑定一条快照
  const finalState = storeA.reload();
  assert.equal(Object.keys(finalState.snapshots).length, 1);
  assert.equal(finalState.records[1].approval!.confirmedSnapshotKey, '1@1');
});

test('后到窗口在本地先改草稿再确认：CAS 重试后旧审批失效，确认被拒', () => {
  const { storeA, storeB } = connectStore();
  storeA.mutate((s) => {
    seedRecord(s);
    approveFlow(s);
    return { ok: true };
  });
  storeB.reload();
  // B 窗口陈旧视图上点确认，同时 A 已改字号
  storeA.mutate((s) => updateDraftField(s, 1, 'size', 52, T0 + 1000, 'A'));
  const b = storeB.mutate((s) => confirmSnapshot(s, 1, T0 + 2000, 'B', 'stale-b'));
  assert.equal(b.result.ok, false);
  assert.match(b.result.error!, /content-changed|审批/);
});

// ---------- 5. 写入失败：从完整快照恢复 ----------

test('写入失败后回滚：草稿、快照、候选、活动全部回到写前完整状态', () => {
  const { store, kv } = connectStore();
  store.mutate((s) => {
    seedRecord(s);
    approveFlow(s);
    return { ok: true };
  });
  const before = JSON.stringify(store.read());

  kv.faultOnNextSet = true;
  const out = store.mutate((s) => updateDraftField(s, 1, 'size', 70, T0 + 100));
  assert.equal(out.result.ok, false);
  assert.equal(out.restored, true);

  const reloaded = store.reload();
  assert.equal(JSON.stringify(reloaded), before, '整份状态与写前完全一致');
  assert.equal(reloaded.records[1].draft.size, 46);
});

test('落盘数据损坏时启动自动从备份恢复', () => {
  const { kv, rootKey } = connectStore();
  const store = new Store(kv, rootKey);
  store.mutate((s) => {
    seedRecord(s);
    return { ok: true };
  });
  // 再做一次提交，使写前备份包含完整记录
  store.mutate((s) => updateDraftField(s, 1, 'weight', 500, T0 + 1000));
  kv.set(rootKey, '{这不是完整数据');
  const repaired = store.reload();
  assert.ok(repaired.records[1], '从完整快照备份恢复');
  assert.equal(repaired.records[1].draft.weight, 500, '恢复到最后成功写入的版本');
});

// ---------- 6. 旧数据升级 ----------

test('旧数据只有草稿 → 带授权信息的记录；缺授权停在待补', () => {
  const legacy = [
    {
      id: 7,
      title: 'Old pairing',
      heading: 'Legacy headline',
      body: 'legacy body',
      category: 'Editorial',
    },
  ];
  const state = migrateState(legacy);
  const rec = state.records[7];
  assert.ok(rec, '迁移出记录');
  assert.equal(rec.draft.headingText, 'Legacy headline');
  assert.equal(rec.draftLicense, null);
  assert.equal(rec.approval, null);
  assert.equal(rec.candidate, null);
  const submit = submitApproval(state, 7, T0);
  assert.equal(submit.ok, false);
  assert.match(submit.error!, /授权/);
  // 补上授权后放行
  assert.ok(setLicense(state, 7, license(), T0).ok);
  assert.ok(submitApproval(state, 7, T0).ok);
});

test('Store 首次加载自动迁移旧 type-pairs 草稿并落成 v2 结构', () => {
  const kv = new MemoryKV();
  const rootKey = 'type-pairer.workbench.v2';
  const legacyKey = 'type-pairs';
  kv.set(
    legacyKey,
    JSON.stringify([
      { id: 3, title: 'Legacy', heading: 'H', body: 'B', category: 'Brand' },
    ]),
  );
  const store = new Store(kv, rootKey, legacyKey);
  const state = store.read();
  assert.equal(state.storageVersion, 2);
  assert.ok(state.snapshots);
  assert.equal(state.records[3].draftLicense, null);
  assert.match(state.records[3].activity[0].message, /待补授权/);
});

test('migrateRecord 单元：默认内容补齐', () => {
  const rec = migrateRecord({ id: 9, title: 'X', draft: { size: 30 } }, T0);
  assert.equal(rec.draft.size, 30);
  assert.equal(rec.draft.bodyFont, 'DM Sans');
  assert.equal(rec.draftLicense, null);
  assert.equal(rec.schemaVersion, 2);
});

// ---------- 其它护栏 ----------

test('缺授权：停在 awaiting-license，不能提交审批/确认', () => {
  const state = emptyState();
  seedRecord(state, false);
  assert.equal(submitApproval(state, 1, T0).ok, false);
  assert.equal(confirmSnapshot(state, 1, T0, 'Y', 'c').ok, false);
});

test('授权未生效（未来日期）也不能审批', () => {
  const state = emptyState();
  createRecord(
    state,
    { id: 1, title: 'future', license: license({ validFrom: T0 + 10 * DAY }) },
    T0,
  );
  assert.equal(submitApproval(state, 1, T0).ok, false);
});

test('驳回后不能确认；重新提交审批后可走通', () => {
  const state = emptyState();
  seedRecord(state);
  assert.ok(submitApproval(state, 1, T0).ok);
  assert.ok(decideApproval(state, 1, 'rejected', T0, 'Boss', '太挤').ok);
  assert.equal(confirmSnapshot(state, 1, T0, 'Y', 'c').ok, false);
  assert.ok(submitApproval(state, 1, T0 + 1000).ok);
  assert.ok(decideApproval(state, 1, 'approved', T0 + 1000, 'Boss').ok);
  assert.ok(confirmSnapshot(state, 1, T0 + 1000, 'Y', 'c2').ok);
});

test('双方改成相同值自动收敛，不算冲突', () => {
  const state = emptyState();
  seedRecord(state);
  assert.ok(goOffline(state, 1, 'Yuki', T0).ok);
  assert.ok(offlineEdit(state, 1, 'weight', 700).ok);
  assert.ok(remoteEdit(state, 1, 'weight', 700, 'Lin', T0 + 1000).ok);
  const r = reconnect(state, 1, T0 + 2000);
  assert.ok(r.ok);
  assert.equal(r.value!.conflicts.length, 0);
  assert.equal(state.records[1].draft.weight, 700);
});
