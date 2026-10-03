// 工作台 React 适配：唯一状态源是 Store；每次操作走 mutate 并强制刷新视图
import { useCallback, useEffect, useRef, useState } from 'react';
import { LocalStorageKV, Store } from './core/store';
import {
  bumpSchemaVersion,
  confirmSnapshot,
  createRecord,
  decideApproval,
  deriveStatus,
  goOffline,
  licenseStatus,
  offlineEdit,
  offlineSetLicense,
  publish,
  reconnect,
  remoteEdit,
  resolveConflict,
  setLicense,
  submitApproval,
  updateDraftField,
} from './core/engine';
import {
  ConfirmedSnapshot,
  InvalidReason,
  License,
  LicenseTier,
  MergeKey,
  PairingContent,
  PairingRecord,
  WorkbenchState,
} from './core/types';

const ROOT_KEY = 'type-pairer.workbench.v2';
const LEGACY_KEY = 'type-pairs';
const BACKUP_KEY = 'type-pairer.workbench.backup';
const DAY_MS = 86400_000;

export interface Toast {
  id: number;
  text: string;
  tone: 'good' | 'bad' | 'info' | 'warn';
}

export function useWorkbench() {
  const storeRef = useRef<Store | null>(null);
  const refreshRef = useRef<() => void>(() => {});
  if (!storeRef.current) {
    storeRef.current = new Store(
      new LocalStorageKV('main'),
      ROOT_KEY,
      LEGACY_KEY,
      BACKUP_KEY,
      () => refreshRef.current(),
    );
  }
  const store = storeRef.current;
  const [state, setState] = useState<WorkbenchState>(() => store.read());
  const [toasts, setToasts] = useState<Toast[]>([]);
  // 虚拟时钟：用于演示授权到期 / 未生效
  const [offset, setOffset] = useState(0);
  const [, force] = useState(0);
  const nowRef = useRef(0);
  nowRef.current = Date.now() + offset;

  useEffect(() => {
    const timer = window.setInterval(() => force((t) => t + 1), 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => store.dispose(), [store]);

  const refresh = useCallback(() => {
    setState(structuredClone(store.reload()));
  }, [store]);
  refreshRef.current = refresh;

  const toast = useCallback((text: string, tone: Toast['tone']) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, text, tone }]);
    window.setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4200);
  }, []);

  /** 所有写操作的统一入口；时间戳取虚拟时钟 */
  const run = useCallback(
    <T,>(
      label: string | null,
      fn: (s: WorkbenchState, at: number) => { ok: boolean; error?: string; value?: T },
    ): T | undefined => {
      const at = nowRef.current;
      const out = store.mutate((s) => fn(s, at));
      refresh();
      if (out.restored) {
        toast('写入失败，已从完整快照恢复', 'bad');
      }
      if (out.result.ok) {
        if (label) toast(label, 'good');
        return out.result.value;
      }
      toast(out.result.error ?? label ?? '操作被拒绝', 'bad');
      return undefined;
    },
    [refresh, store, toast],
  );

  const idemSeq = useRef(0);
  const idemKey = (prefix: string) => {
    idemSeq.current += 1;
    return `${prefix}-${idemSeq.current}-${Math.random().toString(36).slice(2, 7)}`;
  };

  const actions = {
    create: (title: string, id?: number) =>
      run('已创建草稿（缺授权，待补）', (s, at) =>
        createRecord(s, {id, title: title || '未命名搭配', license: null}, at) && {
          ok: true as const,
        },
      ),
    edit: <K extends keyof PairingContent>(id: number, field: K, value: PairingContent[K]) =>
      run(`草稿「${field}」已更新`, (s, at) => updateDraftField(s, id, field, value, at)),
    saveLicense: (id: number, license: License | null) =>
      run(license ? '授权已更新，审批/候选失效重算' : '授权已移除，停在待补', (s, at) =>
        setLicense(s, id, license, at),
      ),
    upgradeVersion: (id: number) =>
      run('已换版：旧审批与候选作废', (s, at) => bumpSchemaVersion(s, id, at)),
    submit: (id: number) => run('已提交审批', (s, at) => submitApproval(s, id, at)),
    approve: (id: number, pass: boolean) =>
      run(pass ? '审批通过' : '已驳回', (s, at) =>
        decideApproval(
          s,
          id,
          pass ? 'approved' : 'rejected',
          at,
          '审批主管',
          pass ? undefined : '排版需调整',
        ),
      ),
    confirm: (id: number) => {
      const key = idemKey('confirm');
      const out = run(null, (s, at) => confirmSnapshot(s, id, at, '我', key));
      if (out) toast(`已确认快照（幂等键 ${key.slice(0, 14)}…），重试不会重复生成`, 'good');
      return out;
    },
    publish: (id: number) => {
      const key = idemKey('publish');
      const out = run(null, (s, at) => publish(s, id, at, '我', key));
      if (out) toast(`发布成功 ${out.snapshotKey}`, 'good');
      return out;
    },
    goOffline: (id: number, member: string) =>
      run(`${member} 已离线编辑（记录基准修订号）`, (s, at) => goOffline(s, id, member, at)),
    // 离线补丁只写入本地会话，静默持久化（不产生同步动作）
    offlineEdit: <K extends keyof PairingContent>(id: number, field: K, value: PairingContent[K]) => {
      store.mutate((s) => offlineEdit(s, id, field, value));
      refresh();
    },
    offlineLicense: (id: number, license: License) => {
      store.mutate((s) => offlineSetLicense(s, id, license));
      refresh();
    },
    remoteEdit: <K extends keyof PairingContent>(
      id: number,
      field: K,
      value: PairingContent[K],
      member: string,
    ) =>
      run(`同事 ${member} 已在线改动`, (s, at) => remoteEdit(s, id, field, value, member, at)),
    reconnect: (id: number) => {
      const out = run(null, (s, at) => reconnect(s, id, at));
      if (out) {
        if (out.conflicts.length > 0) {
          toast(`回连：${out.conflicts.length} 个字段冲突，已挡住发布`, 'bad');
        } else {
          toast(`回连成功：${out.applied.length} 个字段干净合并`, 'good');
        }
      }
      return out;
    },
    resolve: (id: number, field: MergeKey, pick: 'local' | 'remote') =>
      run(`冲突已解决（保留${pick === 'local' ? '离线' : '同事'}值），需重新审批`, (s, at) =>
        resolveConflict(s, id, field, pick, at),
      ),
  };

  const travel = (days: number) => {
    setOffset((o) => o + days * DAY_MS);
    toast(days >= 0 ? `时间快进 ${days} 天` : `时间回拨 ${-days} 天`, 'info');
  };

  const now = nowRef.current;
  const statusOf = (r: PairingRecord) => deriveStatus(state, r, now);
  const licenseOf = (l: License | null) => licenseStatus(l, now);
  const snapshotOf = (key: string | null): ConfirmedSnapshot | null =>
    key ? state.snapshots[key] ?? null : null;

  return {
    state,
    now,
    toasts,
    statusOf,
    licenseOf,
    snapshotOf,
    actions,
    travel,
    refresh,
  };
}

export const REASON_TEXT: Record<InvalidReason, string> = {
  'content-changed': '内容已被改动',
  'license-changed': '授权已更换',
  'license-expired': '授权已到期',
  'license-not-yet-valid': '授权尚未生效',
  'version-changed': '排版已换版',
  rejected: '审批被驳回',
  pending: '审批中',
};

export const STATUS_TEXT: Record<string, { label: string; tone: string }> = {
  'awaiting-license': { label: '待补授权', tone: 'warn' },
  draft: { label: '草稿', tone: 'muted' },
  'awaiting-approval': { label: '待审批', tone: 'info' },
  rejected: { label: '已驳回', tone: 'bad' },
  stale: { label: '旧审批失效', tone: 'warn' },
  approved: { label: '审批通过', tone: 'good' },
  'candidate-invalid': { label: '候选已失效', tone: 'warn' },
  confirmed: { label: '已确认·待发布', tone: 'good' },
  conflict: { label: '冲突挡发', tone: 'bad' },
  published: { label: '已发布', tone: 'good' },
};

export const TIERS: LicenseTier[] = ['standard', 'extended', 'web'];
