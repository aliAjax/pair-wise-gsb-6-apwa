// 存储层：
// - CAS 乐观锁：两个窗口同时确认时，后提交者修订号对不上，必须重读重试
// - 写前完整快照：落盘前把整份状态（草稿 + 快照桶 + 幂等表）备份，写入失败即回滚
// - 旧数据（只有草稿的 storageVersion=1）首次加载时迁移
import { fnv1a, migrateState } from './engine';
import { WorkbenchState } from './types';

export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** 注册外部变更（其他标签页 / 其他 Store 实例） */
  observe?(cb: (key: string) => void): () => void;
}

export class CasMismatch extends Error {
  constructor() {
    super('CAS_MISMATCH');
    this.name = 'CasMismatch';
  }
}
export class WriteFailed extends Error {
  constructor(public restored: boolean) {
    super('WRITE_FAILED');
    this.name = 'WriteFailed';
  }
}

const etagOf = (raw: string): string => fnv1a(raw);

/** 内存 KV，供双窗口模拟使用；faultOnNextSet 用于演示写入失败（先破坏再抛错） */
export class MemoryKV implements KV {
  private data = new Map<string, string>();
  private listeners = new Set<(key: string) => void>();
  faultOnNextSet = false;

  get(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) as string) : null;
  }
  set(key: string, value: string): void {
    if (this.faultOnNextSet) {
      this.faultOnNextSet = false;
      this.data.delete(key); // 模拟半写入：数据已损坏
      this.emit(key);
      throw new Error('模拟写入失败：存储设备不可用');
    }
    this.data.set(key, value);
    this.emit(key);
  }
  remove(key: string): void {
    this.data.delete(key);
    this.emit(key);
  }
  observe(cb: (key: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit(key: string): void {
    this.listeners.forEach((cb) => cb(key));
  }
}

export class LocalStorageKV implements KV {
  constructor(private ns = 'window') {}
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  set(key: string, value: string): void {
    localStorage.setItem(key, value);
  }
  remove(key: string): void {
    localStorage.removeItem(key);
  }
  observe(cb: (key: string) => void): () => void {
    const handler = (e: StorageEvent): void => {
      if (e.key) cb(e.key);
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }
}

export interface MutateOutcome<T> {
  result: { ok: boolean; error?: string; value?: T };
  restored: boolean;
  attempts: number;
}

export class Store {
  private state: WorkbenchState;
  private unobserve: (() => void) | null = null;

  constructor(
    private kv: KV,
    private rootKey = 'type-pairer.workbench.v2',
    private legacyKey = 'type-pairs',
    private backupKey = 'type-pairer.workbench.backup',
    onExternalChange?: () => void,
  ) {
    this.state = this.bootstrap();
    if (kv.observe) {
      this.unobserve = kv.observe((key) => {
        if (key === rootKey || key === backupKey) {
          this.state = this.bootstrap();
          onExternalChange?.();
        }
      });
    }
  }

  dispose(): void {
    this.unobserve?.();
  }

  /** 读取完整快照；损坏时从备份恢复；无新版数据时从旧草稿迁移 */
  private bootstrap(): WorkbenchState {
    const raw = this.kv.get(this.rootKey);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as WorkbenchState;
        if (parsed && parsed.storageVersion === 2 && parsed.snapshots) return parsed;
        throw new Error('结构不完整');
      } catch {
        // 落盘数据损坏 → 从写入前的完整快照恢复
        const backup = this.kv.get(this.backupKey);
        if (backup !== null) {
          try {
            const restored = JSON.parse(backup) as WorkbenchState;
            this.kv.set(this.rootKey, backup);
            return restored;
          } catch {
            /* fallthrough */
          }
        }
        throw new Error('工作区数据损坏且无可用备份');
      }
    }
    // 旧数据：只有草稿（localStorage['type-pairs']）→ 迁移成带授权槽位的记录
    const legacyRaw = this.kv.get(this.legacyKey);
    if (legacyRaw !== null) {
      let legacy: unknown;
      try {
        legacy = JSON.parse(legacyRaw);
      } catch {
        legacy = null;
      }
      const migrated = migrateState(Array.isArray(legacy) ? Object.fromEntries(
        legacy.map((p) => [(p as { id: number }).id, p]),
      ) : legacy);
      this.persist(migrated);
      return migrated;
    }
    const fresh: WorkbenchState = { storageVersion: 2, records: {}, snapshots: {} };
    this.persist(fresh);
    return fresh;
  }

  read(): WorkbenchState {
    return this.state;
  }

  /** 从持久层强制重读（模拟另一个窗口提交后本窗口刷新视图） */
  reload(): WorkbenchState {
    this.state = this.bootstrap();
    return this.state;
  }

  /** 测试用：模拟冷启动重新引导（含迁移 / 备份恢复） */
  reloadBootstrapForTest(): WorkbenchState {
    return this.reload();
  }

  private persist(state: WorkbenchState): string {
    const raw = JSON.stringify(state);
    this.kv.set(this.rootKey, raw);
    // 回读校验，防止静默半写入
    if (this.kv.get(this.rootKey) !== raw) throw new Error('写入校验失败');
    return raw;
  }

  /**
   * 在状态草稿上执行修改并提交。
   * - 修改函数返回 ok:false → 中止，不落盘
   * - 提交时 etag 对不上（其他窗口抢先）→ 重读后重试
   * - 写入抛错/校验失败 → 从写前完整快照恢复
   */
  mutate<T>(
    fn: (state: WorkbenchState) => { ok: boolean; error?: string; value?: T },
    opts: { maxAttempts?: number } = {},
  ): MutateOutcome<T> {
    const maxAttempts = opts.maxAttempts ?? 5;
    let restored = false;
    let attempts = 0;
    // 写前完整快照：成功读取到的上一版整份状态
    let backupRaw: string | null = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempts += 1;
      const baseRaw = this.kv.get(this.rootKey);
      if (baseRaw === null) throw new Error('根数据缺失');
      const baseEtag = etagOf(baseRaw);
      backupRaw = baseRaw;

      const working = JSON.parse(baseRaw) as WorkbenchState;
      const result = fn(working);
      if (!result.ok) {
        return { result, restored, attempts };
      }

      const newRaw = JSON.stringify(working);
      if (etagOf(this.kv.get(this.rootKey) ?? '') !== baseEtag) {
        if (attempts >= maxAttempts) throw new CasMismatch();
        continue; // 其他窗口已提交，重读重试（确认操作会命中幂等/唯一约束）
      }

      try {
        // 1) 先写完整备份（上一版整份状态），再写新值
        this.kv.set(this.backupKey, backupRaw);
        this.kv.set(this.rootKey, newRaw);
        if (this.kv.get(this.rootKey) !== newRaw) throw new Error('写入校验失败');
        // 2) 提交确认成功后，把备份推进为最新已提交版本（仍是一份完整快照）
        this.kv.set(this.backupKey, newRaw);
        this.state = working;
        return { result, restored, attempts };
      } catch (err) {
        // 2) 写入失败：从完整快照恢复，并校验恢复结果
        try {
          this.kv.set(this.rootKey, backupRaw);
          if (this.kv.get(this.rootKey) !== backupRaw) {
            throw new Error('恢复校验失败');
          }
          this.state = JSON.parse(backupRaw) as WorkbenchState;
          restored = true;
          const failure = new WriteFailed(true);
          Object.defineProperty(failure, 'cause', {value: err});
          return {
            result: { ok: false, error: `写入失败，已从完整快照恢复：${(err as Error).message}` },
            restored,
            attempts,
          };
        } catch (restoreErr) {
          const failure = new WriteFailed(false);
          Object.defineProperty(failure, 'cause', {value: restoreErr});
          throw failure;
        }
      }
    }
  }
}
