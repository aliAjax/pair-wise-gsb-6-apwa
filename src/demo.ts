// 演示场景：直接操作 localStorage / 内存 KV，便于在界面上演练各类一致性问题
import {MemoryKV, Store} from './core/store';
import {
  confirmSnapshot,
  createRecord,
  decideApproval,
  goOffline,
  offlineEdit,
  reconnect,
  remoteEdit,
  submitApproval,
  updateDraftField,
} from './core/engine';
import { License, WorkbenchState } from './core/types';

const ROOT_KEY = 'type-pairer.workbench.v2';
const LEGACY_KEY = 'type-pairs';
const BACKUP_KEY = 'type-pairer.workbench.backup';
const DAY = 86400_000;

export function demoLicense(over: Partial<License> = {}): License {
  const now = Date.now();
  return {
    holder: 'Acme 字库',
    tier: 'web',
    validFrom: now - 30 * DAY,
    validUntil: now + 30 * DAY,
    ...over,
  };
}

function act<T>(store: Store, fn: (s: WorkbenchState) => { ok: boolean; value?: T }): T | undefined {
  const out = store.mutate(fn);
  return out.result.ok ? out.result.value : undefined;
}

/** 首次访问播种一组覆盖各状态的演示记录 */
let seeded = false;
export function seedDemoIfEmpty(): void {
  if (seeded) return;
  seeded = true;
  const raw = localStorage.getItem(ROOT_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as WorkbenchState;
      if (parsed.storageVersion === 2 && Object.keys(parsed.records).length > 0) return;
    } catch {
      /* 损坏数据交给 Store 恢复，不播种 */
      return;
    }
  }
  if (localStorage.getItem(LEGACY_KEY)) return; // 有旧草稿，留给迁移流程
  // 播种用无监听的裸 KV，避免遗留 storage 监听器
  const bareKV = {
    get: (k: string) => localStorage.getItem(k),
    set: (k: string, v: string) => localStorage.setItem(k, v),
    remove: (k: string) => localStorage.removeItem(k),
  };
  const store = new Store(bareKV, ROOT_KEY, LEGACY_KEY, BACKUP_KEY);
  const now = Date.now();

  // 1) 走完审批、已确认待发布
  act(store, (s) => {
    const r = createRecord(s, { id: 101, title: '编辑周刊 · 十月刊', license: demoLicense() }, now);
    return { ok: true, value: r };
  });
  act(store, (s) => submitApproval(s, 101, now));
  act(store, (s) => decideApproval(s, 101, 'approved', now, '审批主管'));
  act(store, (s) => confirmSnapshot(s, 101, now, 'Yuki', 'seed-101'));

  // 2) 缺授权，停在待补
  act(store, (s) =>
    createRecord(
      s,
      { id: 102, title: '品牌手册 · 新视觉', content: { category: 'Brand', size: 54 }, license: null },
      now,
    ) && { ok: true },
  );

  // 3) 审批已通过，但草稿随后被改（旧审批失效）
  act(store, (s) =>
    createRecord(s, { id: 103, title: '落地页 Hero 排版', license: demoLicense() }, now) && {
      ok: true,
    },
  );
  act(store, (s) => submitApproval(s, 103, now));
  act(store, (s) => decideApproval(s, 103, 'approved', now, '审批主管'));
  act(store, (s) => updateDraftField(s, 103, 'size', 62, now, '同事 Lin'));

  // 4) 离线补丁与同事改动冲突，挡住发布
  act(store, (s) =>
    createRecord(s, { id: 104, title: '移动端弹窗 · 活动', license: demoLicense() }, now) && {
      ok: true,
    },
  );
  act(store, (s) => goOffline(s, 104, 'Yuki', now));
  // 离线补丁写入会话并持久化，随后同事在线改草稿
  act(store, (s) => offlineEdit(s, 104, 'size', 66));
  act(store, (s) => remoteEdit(s, 104, 'size', 38, '同事 Lin', now));
  act(store, (s) => reconnect(s, 104, now));

  // 5) 授权 5 天后到期的已确认候选（供快进演示）
  act(store, (s) =>
    createRecord(
      s,
      { id: 105, title: '年报封面 · 紧急发布', license: demoLicense({ validUntil: now + 5 * DAY }) },
      now,
    ) && { ok: true },
  );
  act(store, (s) => submitApproval(s, 105, now));
  act(store, (s) => decideApproval(s, 105, 'approved', now, '审批主管'));
  act(store, (s) => confirmSnapshot(s, 105, now, 'Yuki', 'seed-105'));
}

/** 故障 1：下一次提交写入失败（先破坏再抛错），验证从完整快照恢复 */
export function armWriteFault(): void {
  // 通过直接破坏根键模拟“下次写入设备故障”：这里改为预置一个不完整备份场景，
  // 真正的写失败由 MemoryKV 无法触达，localStorage 下用配额/异常近似：
  // 实现方式：在根数据中放入无法 JSON 序列化的结构做不到，因此改用“篡改根键为半写入”。
  const current = localStorage.getItem(ROOT_KEY);
  if (current) {
    // 备份完好，根键损坏 → 下次 Store 引导时从完整快照恢复
    localStorage.setItem(ROOT_KEY, current.slice(0, Math.floor(current.length / 2)));
  }
}

/** 故障 2：根键与备份同时演示根损坏（备份为上次成功提交，仍可恢复） */
export function corruptRoot(): void {
  localStorage.setItem(ROOT_KEY, '{损坏:' + Date.now());
}

/** 旧数据：写入只有草稿的 v1 结构，刷新后触发迁移 */
export function installLegacyDraft(): void {
  localStorage.removeItem(ROOT_KEY);
  localStorage.removeItem(BACKUP_KEY);
  localStorage.setItem(
    LEGACY_KEY,
    JSON.stringify([
      {
        id: 901,
        title: '旧版首页搭配',
        heading: '来自去年的草稿',
        body: '这条记录只有草稿内容，没有授权信息。迁移后应停在“待补授权”。',
        category: 'Editorial',
        favorite: true,
      },
    ]),
  );
}

/** 双窗口同时确认：两个 Store 共享内存 KV，先到版本生效 */
export function simulateConcurrentConfirm(): {
  winner: 'A' | 'B';
  snapshotCount: number;
  aError?: string;
  bError?: string;
} {
  const kv = new MemoryKV();
  const storeA = new Store(kv, ROOT_KEY, LEGACY_KEY, BACKUP_KEY);
  const storeB = new Store(kv, ROOT_KEY, LEGACY_KEY, BACKUP_KEY);
  const now = Date.now();

  act(storeA, (s) =>
    createRecord(s, { id: 1, title: '双窗口竞争演示', license: demoLicense() }, now) && {
      ok: true,
    },
  );
  act(storeA, (s) => submitApproval(s, 1, now));
  storeB.reload();
  act(storeA, (s) => decideApproval(s, 1, 'approved', now, '审批主管'));
  storeB.reload();

  const a = storeA.mutate((s) => confirmSnapshot(s, 1, now, '窗口A', 'win-a'));
  const b = storeB.mutate((s) => confirmSnapshot(s, 1, now, '窗口B', 'win-b'));
  const finalState = storeA.reload();
  const snapshot = finalState.snapshots[finalState.records[1].confirmedSnapshotKey ?? ''];
  return {
    winner: (snapshot?.confirmedBy === '窗口A' ? 'A' : 'B') as 'A' | 'B',
    snapshotCount: Object.keys(finalState.snapshots).length,
    aError: a.result.ok ? undefined : a.result.error,
    bError: b.result.ok ? undefined : b.result.error,
  };
}

/** 重试幂等：同一幂等键连续确认两次，快照只生成一条 */
export function simulateIdempotentRetry(): { reused: boolean; snapshotCount: number } {
  const kv = new MemoryKV();
  const store = new Store(kv, ROOT_KEY, LEGACY_KEY, BACKUP_KEY);
  const now = Date.now();
  act(store, (s) =>
    createRecord(s, { id: 1, title: '幂等重试演示', license: demoLicense() }, now) && { ok: true },
  );
  act(store, (s) => submitApproval(s, 1, now));
  act(store, (s) => decideApproval(s, 1, 'approved', now, '审批主管'));
  const first = store.mutate((s) => confirmSnapshot(s, 1, now, '我', 'retry-key'));
  const retry = store.mutate((s) => confirmSnapshot(s, 1, now + 1000, '我', 'retry-key'));
  return {
    reused: !!retry.result.value?.reused,
    snapshotCount: Object.keys(store.reload().snapshots).length,
  };
}

/** 离线冲突全程（内存）：回连后冲突清单保留双方值并挡住发布 */
export function simulateOfflineConflict(): {
  conflictField: string;
  local: unknown;
  remote: unknown;
  publishBlocked: boolean;
} {
  const kv = new MemoryKV();
  const store = new Store(kv, ROOT_KEY, LEGACY_KEY, BACKUP_KEY);
  const now = Date.now();
  act(store, (s) =>
    createRecord(s, { id: 1, title: '离线冲突演示', license: demoLicense() }, now) && {
      ok: true,
    },
  );
  act(store, (s) => goOffline(s, 1, 'Yuki', now));
  act(store, (s2) => offlineEdit(s2, 1, 'size', 66));
  act(store, (s) => remoteEdit(s, 1, 'size', 38, 'Lin', now + 1000));
  const r = act(store, (s) => reconnect(s, 1, now + 2000));
  const conflict = r?.conflicts[0];
  // 冲突在身：提交审批/确认都会被挡
  const blocked = !store.mutate((s) => submitApproval(s, 1, now + 3000)).result.ok;
  return {
    conflictField: conflict?.field ?? '',
    local: conflict?.local,
    remote: conflict?.remote,
    publishBlocked: blocked,
  };
}
