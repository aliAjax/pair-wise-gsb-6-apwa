// 测试夹具：导出引擎全部动作，并提供共享内存 KV 的双 Store（模拟两个窗口）
export * from '../engine';
export { MemoryKV, Store } from '../store';

import { MemoryKV, Store } from '../store';

export function connectStore() {
  const kv = new MemoryKV();
  const rootKey = 'type-pairer.workbench.v2';
  const legacyKey = 'type-pairs';
  const store = new Store(kv, rootKey, legacyKey);
  const storeA = new Store(kv, rootKey, legacyKey);
  const storeB = new Store(kv, rootKey, legacyKey);
  return { kv, rootKey, legacyKey, store, storeA, storeB };
}
