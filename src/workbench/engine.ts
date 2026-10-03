// 发布工作台 · 纯函数领域引擎
// 设计要点：
// 1. 草稿(draft)与确认快照(snapshot)分开放，快照不可变，草稿可继续编辑。
// 2. 离线补丁携带断连时的基准字段(baseFields/baseLicense/baseRevision)，
//    回连先核对基准：基准一致快进；基准落后按字段三方合并，
//    双方都改且不同的字段保留 base/local/remote 双方值并挡住发布。
// 3. 授权到期 / 全局换版：审批与发布候选失效并重算（回到待审批）。
// 4. 写入失败后：先把完整快照落到恢复区，再从完整快照恢复。
// 5. 两个窗口同时确认：候选单赢家 CAS，先到版本生效；
//    重试凭操作幂等键返回首次结果，不重复生成记录。
// 6. 旧数据只有草稿时升级为带授权信息的记录；缺授权停在“待补授权”。

import {
  ActionResult,
  Approval,
  AuditEvent,
  AuditType,
  ConfirmedSnapshot,
  DEFAULT_FIELDS,
  FONT_CHOICES,
  LegacyPair,
  License,
  OfflinePatch,
  PairingFields,
  PairingRecord,
  PairingStatus,
  PublishCandidate,
  WorkbenchState,
} from './types';

export const STORAGE_KEY = 'type-pairer-workbench-v2';
export const RECOVERY_KEY = 'type-pairer-workbench-v2-recovery';
/** 已完成的写操作（确认/发布等），重试时凭幂等键返回原结果，不重复生成记录 */
export const IDEMPOTENCY_KEY = 'type-pairer-idempotency-v2';

const FIELD_KEYS = ['headingFont', 'bodyFont', 'size', 'weight', 'leading', 'tracking'] as const;

// ---------- 基础工具 ----------

export function clone<T>(v: T): T {
  return structuredClone(v);
}

let seqCounter = 0;
export function uid(prefix: string): string {
  seqCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${seqCounter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/** 稳定序列化，供指纹与快照比对 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export function fieldsHash(f: PairingFields): string {
  let h = 5381;
  const s = stableStringify(f);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `fh${(h >>> 0).toString(36)}`;
}

export function licenseValid(lic: License | null, now: number, assetVersion: number): boolean {
  return !!lic && lic.assetVersion === assetVersion && lic.expiresAt > now && lic.seats > 0;
}

function log(
  state: WorkbenchState,
  type: AuditType,
  recordId: string | null,
  detail?: string,
  window?: string,
): AuditEvent {
  state.seq += 1;
  const ev: AuditEvent = { id: uid('evt'), seq: state.seq, time: state.now, type, recordId, detail, window };
  state.audit.unshift(ev);
  if (state.audit.length > 200) state.audit.length = 200;
  return ev;
}

function find(state: WorkbenchState, id: string): PairingRecord {
  const r = state.records.find((x) => x.id === id);
  if (!r) throw new Error(`record not found: ${id}`);
  return r;
}

// ---------- 状态推导：审批/候选失效与重算 ----------

/**
 * 重新推导单条记录状态。
 * 优先级：已发布(终态) > 未裁决冲突(挡住发布) > 已确认快照 > 授权 > 审批 > 候选。
 * 快照路径独立按快照自身的授权/版本校验，与草稿分离。
 */
export function reconcileRecord(rec: PairingRecord, state: WorkbenchState): PairingRecord {
  const { now, assetVersion } = state;
  const hash = fieldsHash(rec.draft.fields);

  if (rec.status === 'published') {
    rec.statusDetail = '已发布';
    return rec;
  }

  if (rec.conflicts.length > 0) {
    rec.status = 'conflict';
    rec.statusDetail = `${rec.conflicts.length} 个字段双方都改过，已保留双方值，裁决前挡住发布`;
    return rec;
  }

  // 已确认但未发布的快照：发布资格只看快照冻结的授权与版本
  if (rec.snapshot && !rec.snapshot.publishedAt) {
    if (rec.snapshot.license.expiresAt <= now) {
      invalidateApprovalAndCandidate(rec, state, 'license-expired');
      rec.status = 'awaiting-approval';
      rec.statusDetail = '确认快照的授权已到期：审批与发布候选失效，需重新审批确认';
      return rec;
    }
    if (rec.snapshot.assetVersion !== assetVersion) {
      invalidateApprovalAndCandidate(rec, state, 'version-bumped');
      rec.status = 'awaiting-approval';
      rec.statusDetail = `素材已换版 v${assetVersion}：确认快照与候选失效，需重新审批确认`;
      return rec;
    }
    rec.status = 'confirmed';
    rec.statusDetail = `确认快照待发布（${rec.snapshot.winnerWindow ?? '先到窗口'} 的版本先生效）`;
    return rec;
  }

  // —— 以下为无快照的草稿链路 ——

  // 1) 授权层：缺授权停在待补
  if (!rec.license) {
    invalidateApprovalAndCandidate(rec, state, null);
    rec.status = 'awaiting-license';
    rec.statusDetail = '缺少字体授权信息，停在待补';
    return rec;
  }

  // 2) 授权到期 / 全局换版：审批与候选失效重算
  if (rec.license.expiresAt <= now) {
    invalidateApprovalAndCandidate(rec, state, 'license-expired');
    rec.status = 'awaiting-approval';
    rec.statusDetail = '授权已到期，旧审批与候选失效，需重新授权并审批';
    return rec;
  }
  if (rec.license.assetVersion !== assetVersion) {
    invalidateApprovalAndCandidate(rec, state, 'version-bumped');
    rec.status = 'awaiting-approval';
    rec.statusDetail = `素材已换版 v${assetVersion}，旧审批与候选失效，需重新审批`;
    return rec;
  }

  // 3) 审批层：无审批 / 被驳回 / 字段漂移 → 待审批
  if (!rec.approval || rec.approval.status !== 'approved') {
    invalidateApprovalAndCandidate(rec, state, null);
    rec.status = 'awaiting-approval';
    rec.statusDetail = rec.approval?.status === 'rejected' ? '审批被驳回，请调整后重新送审' : '等待审批';
    return rec;
  }
  if (rec.approval.fieldsHash !== hash) {
    invalidateApprovalAndCandidate(rec, state, 'fields-changed');
    rec.status = 'awaiting-approval';
    rec.statusDetail = '字段在审批后被修改，原审批失效，需重新审批';
    return rec;
  }

  // 4) 审批有效：确保存在有效候选（失效则重算）
  if (!rec.candidate || rec.candidate.invalid || rec.candidate.fieldsHash !== hash) {
    if (rec.candidate) {
      rec.candidate = { ...rec.candidate, invalid: true, invalidReason: 'fields-changed' };
      log(state, 'candidate-invalidated', rec.id, '候选与当前草稿不一致而失效');
    }
    rec.candidate = makeCandidate(rec, state);
    log(state, 'candidate-rebuilt', rec.id, '按有效审批重新生成发布候选');
  }

  rec.status = 'ready';
  rec.statusDetail = '审批通过、候选有效，可确认';
  return rec;
}

function invalidateApprovalAndCandidate(
  rec: PairingRecord,
  state: WorkbenchState,
  reason: 'license-expired' | 'version-bumped' | 'fields-changed' | null,
): void {
  // 已通过审批一律随前置条件失效；pending 审批仅在有明确原因时才降级，
  // 通用的“等待审批”推导不能把进行中的审批误作废。
  if (
    rec.approval &&
    (rec.approval.status === 'approved' || (rec.approval.status === 'pending' && reason !== null))
  ) {
    const why =
      reason === 'license-expired'
        ? '授权到期'
        : reason === 'version-bumped'
        ? '换版'
        : reason === 'fields-changed'
        ? '字段变更'
        : '授权失效';
    rec.approval = {
      ...rec.approval,
      status: reason === 'license-expired' ? 'expired' : 'superseded',
    };
    log(state, 'approval-invalidated', rec.id, `审批失效：${why}`);
  }
  if (rec.candidate && !rec.candidate.invalid) {
    rec.candidate = { ...rec.candidate, invalid: true, invalidReason: reason ?? undefined };
    log(state, 'candidate-invalidated', rec.id, `发布候选失效：${reason ?? '前置条件变化'}`);
  }
}

function makeCandidate(rec: PairingRecord, state: WorkbenchState): PublishCandidate {
  return {
    id: uid('cand'),
    approvalId: rec.approval!.id,
    fieldsHash: fieldsHash(rec.draft.fields),
    assetVersion: state.assetVersion,
    licenseExpiresAt: rec.license!.expiresAt,
    createdAt: state.now,
    invalid: false,
  };
}

export function reconcileAll(state: WorkbenchState): WorkbenchState {
  state.records.forEach((r) => reconcileRecord(r, state));
  return state;
}

// ---------- 初始数据与旧数据升级 ----------

const LEGACY_KEY = 'type-pairs';

/** 旧数据只有草稿 → 升级为带授权信息的记录；缺授权停在待补 */
export function migrateLegacy(raw: unknown, state: WorkbenchState): number {
  const list: LegacyPair[] = Array.isArray(raw) ? (raw as LegacyPair[]) : [];
  let upgraded = 0;
  for (const p of list) {
    if (typeof p?.id !== 'number') continue;
    state.seq += 1;
    const rec: PairingRecord = {
      id: uid('rec'),
      seq: state.seq,
      draft: {
        title: p.title || `Pairing ${p.id}`,
        category: p.category || 'Untitled',
        fields: { ...DEFAULT_FIELDS },
        baseRevision: state.rev,
        updatedAt: state.now,
      },
      // 旧记录没有授权信息：留空，由 reconcile 停在“待补授权”
      license: null,
      approval: null,
      candidate: null,
      snapshot: null,
      conflicts: [],
      status: 'draft',
    };
    reconcileRecord(rec, state);
    state.records.push(rec);
    log(state, 'legacy-upgraded', rec.id, `旧草稿「${rec.draft.title}」升级为带授权记录，缺授权停在待补`, '系统');
    upgraded += 1;
  }
  return upgraded;
}

export function createInitialState(now: number, legacyRaw?: unknown): WorkbenchState {
  const state: WorkbenchState = {
    schemaVersion: 2,
    rev: 1,
    seq: 0,
    assetVersion: 1,
    now,
    records: [],
    offlinePatches: [],
    audit: [],
  };

  const validLicense = (days: number, holder: string, opts?: Partial<License>): License => ({
    holder,
    assetVersion: opts?.assetVersion ?? 1,
    expiresAt: opts?.expiresAt ?? now + days * 86400_000,
    seats: opts?.seats ?? 5,
  });

  const mk = (
    title: string,
    category: string,
    fields: PairingFields,
    license: License | null,
  ): PairingRecord => {
    state.seq += 1;
    const rec: PairingRecord = {
      id: uid('rec'),
      seq: state.seq,
      draft: { title, category, fields: clone(fields), baseRevision: state.rev, updatedAt: now },
      license,
      approval: null,
      candidate: null,
      snapshot: null,
      conflicts: [],
      status: 'draft',
    };
    state.records.push(rec);
    return rec;
  };

  // 一条审批通过、可确认
  const ready = mk('Editorial calm', 'Editorial', { ...DEFAULT_FIELDS }, validLicense(30, 'Yuki Lin'));
  state.seq += 1;
  ready.approval = {
    id: uid('appr'),
    seq: state.seq,
    status: 'approved',
    reviewer: '品牌负责人',
    fieldsHash: fieldsHash(ready.draft.fields),
    assetVersion: 1,
    createdAt: now - 3600_000,
  };
  reconcileRecord(ready, state);

  // 一条待审批
  mk(
    'Studio notes',
    'Portfolio',
    { ...DEFAULT_FIELDS, headingFont: 'Newsreader', size: 40 },
    validLicense(12, 'Mo Chen'),
  );

  // 一条缺授权 → 待补
  mk('Field guide', 'Brand', { ...DEFAULT_FIELDS, bodyFont: 'Space Grotesk' }, null);

  if (legacyRaw !== undefined) migrateLegacy(legacyRaw, state);

  log(state, 'legacy-upgraded', null, '工作台初始化：草稿与确认快照分离存储', '系统');
  return reconcileAll(state);
}

// ---------- 动作 ----------

function ok(state: WorkbenchState, extra?: Partial<ActionResult>): ActionResult {
  return { ok: true, state: reconcileAll(state), ...extra };
}
function fail(state: WorkbenchState, error: string, extra?: Partial<ActionResult>): ActionResult {
  return { ok: false, state, error, ...extra };
}

/** 在线编辑草稿（确认后的草稿仍可独立编辑，不影响已留档快照） */
export function editDraft(
  prev: WorkbenchState,
  recordId: string,
  patch: Partial<PairingFields>,
  window = '窗口 A',
): ActionResult {
  const state = clone(prev);
  const rec = find(state, recordId);
  if (rec.conflicts.length > 0) return fail(state, '存在未裁决冲突，请先解决冲突再编辑');
  rec.draft.fields = { ...rec.draft.fields, ...patch };
  rec.draft.updatedAt = state.now;
  state.rev += 1;
  rec.draft.baseRevision = state.rev;
  log(state, 'draft-edited', recordId, `在线修改 ${Object.keys(patch).join('、') || '草稿'}`, window);
  return ok(state);
}

/** 补登/更换授权；之后按链路重算（缺审批则回到待审批） */
export function setLicense(
  prev: WorkbenchState,
  recordId: string,
  license: License,
  window = '窗口 A',
): ActionResult {
  const state = clone(prev);
  const rec = find(state, recordId);
  rec.license = clone(license);
  log(
    state,
    'license-set',
    recordId,
    `授权主体 ${license.holder}，覆盖素材 v${license.assetVersion}，${license.seats} 席`,
    window,
  );
  return ok(state);
}

/** 送审 */
export function requestApproval(prev: WorkbenchState, recordId: string, window = '窗口 A'): ActionResult {
  const state = clone(prev);
  const rec = find(state, recordId);
  if (!licenseValid(rec.license, state.now, state.assetVersion))
    return fail(state, '授权缺失或已失效，无法送审');
  if (rec.conflicts.length > 0) return fail(state, '冲突未解决，不能送审');
  state.seq += 1;
  rec.approval = {
    id: uid('appr'),
    seq: state.seq,
    status: 'pending',
    reviewer: '品牌负责人',
    fieldsHash: fieldsHash(rec.draft.fields),
    assetVersion: state.assetVersion,
    createdAt: state.now,
  };
  log(state, 'approval-requested', recordId, '提交审批', window);
  return ok(state);
}

/** 审批结论（演示用即时裁决） */
export function decideApproval(
  prev: WorkbenchState,
  recordId: string,
  approved: boolean,
  reason?: string,
  window = '审批人',
): ActionResult {
  const state = clone(prev);
  const rec = find(state, recordId);
  if (!rec.approval || rec.approval.status !== 'pending') return fail(state, '没有待裁决的审批');
  rec.approval = { ...rec.approval, status: approved ? 'approved' : 'rejected', reason, reviewer: window };
  log(state, 'approval-decided', recordId, approved ? '审批通过' : `审批驳回：${reason ?? ''}`, window);
  return ok(state);
}

// ---------- 离线补丁：基准核对 + 三方合并 ----------

/** 成员离线：拍一个带基准修订号与基准字段/授权的补丁 */
export function makeOfflinePatch(
  prev: WorkbenchState,
  recordId: string,
  window: string,
  fields?: Partial<PairingFields>,
  license?: License | null,
): { state: WorkbenchState; patch: OfflinePatch } {
  const state = clone(prev);
  const rec = find(state, recordId);
  const patch: OfflinePatch = {
    id: uid('patch'),
    recordId,
    window,
    baseRevision: rec.draft.baseRevision,
    baseFields: clone(rec.draft.fields),
    baseLicense: rec.license ? clone(rec.license) : null,
    fields: fields ? clone(fields) : undefined,
    license: license === undefined ? undefined : clone(license),
    createdAt: state.now,
    applied: false,
  };
  state.offlinePatches.push(patch);
  log(
    state,
    'offline-edited',
    recordId,
    `${window} 断连离线${fields ? '改字段' : ''}${license !== undefined ? '改授权' : ''}，基准 rev ${patch.baseRevision}`,
    window,
  );
  return { state: reconcileAll(state), patch };
}

/**
 * 回连：先核对基准再合并。
 * - 基准修订号未变：快进，直接落补丁值。
 * - 基准落后（同事期间改过）：按字段三方合并。
 *   只一方改 → 取改动方；双方都改且相同 → 同值；双方都改且不同 →
 *   冲突槽保留 base/local(离线)/remote(同事) 三方值，状态置冲突并挡住发布。
 */
export function reconnectPatch(prev: WorkbenchState, patchId: string): ActionResult {
  const state = clone(prev);
  const patch = state.offlinePatches.find((p) => p.id === patchId);
  if (!patch) return fail(state, '找不到离线补丁');
  if (patch.applied) return fail(state, '该补丁已应用，请勿重复回连');
  const rec = find(state, patch.recordId);
  patch.applied = true;

  // —— 快进路径：基准一致，离线补丁直接生效 ——
  if (patch.baseRevision === rec.draft.baseRevision) {
    if (patch.fields) rec.draft.fields = { ...rec.draft.fields, ...patch.fields };
    if (patch.license !== undefined) rec.license = patch.license;
    state.rev += 1;
    rec.draft.baseRevision = state.rev;
    rec.draft.updatedAt = state.now;
    log(state, 'patch-merged', rec.id, `基准一致（rev ${patch.baseRevision}），快进合并 ${patch.window} 的离线修改`, patch.window);
    return ok(state);
  }

  // —— 分叉路径：逐字段三方合并 ——
  const conflicts = rec.conflicts.filter((c) => {
    // 保留与本补丁字段不重叠的旧冲突（理论上冲突状态下不允许新离线编辑）
    return !(patch.fields && c.field in patch.fields) && !(patch.license !== undefined && c.field === 'license');
  });

  for (const k of FIELD_KEYS) {
    const baseVal = patch.baseFields[k];
    const remoteVal = rec.draft.fields[k];
    const localChanged = !!patch.fields && k in patch.fields;
    const localVal = localChanged ? (patch.fields as Partial<PairingFields>)[k]! : baseVal;
    const remoteChanged = !Object.is(remoteVal, baseVal);

    if (!localChanged && !remoteChanged) continue;
    if (localChanged && !remoteChanged) {
      rec.draft.fields[k] = localVal as never;
      continue;
    }
    if (!localChanged && remoteChanged) continue; // 保留同事值
    if (Object.is(localVal, remoteVal)) {
      rec.draft.fields[k] = localVal as never; // 双方改成同值
    } else {
      conflicts.push({ field: k, base: baseVal, local: localVal as string | number, remote: remoteVal });
    }
  }

  // 授权同样三方合并
  if (patch.license !== undefined) {
    const base = patch.baseLicense;
    const local = patch.license;
    const remote = rec.license;
    const localChanged = stableStringify(local) !== stableStringify(base);
    const remoteChanged = stableStringify(remote) !== stableStringify(base);
    if (localChanged && !remoteChanged) {
      rec.license = local;
    } else if (localChanged && remoteChanged && stableStringify(local) !== stableStringify(remote)) {
      conflicts.push({ field: 'license', base, local, remote });
    }
  }

  rec.conflicts = conflicts;
  state.rev += 1;
  rec.draft.baseRevision = state.rev;
  rec.draft.updatedAt = state.now;

  if (conflicts.length > 0) {
    log(
      state,
      'patch-conflict',
      rec.id,
      `基准落后（${patch.baseRevision} → ${rec.draft.baseRevision}）：${conflicts
        .map((c) => c.field)
        .join('、')} 双方都改过，已保留双方值并挡住发布`,
      patch.window,
    );
    return fail(reconcileAll(state), 'merge-conflict', { recordId: rec.id });
  }

  log(
    state,
    'patch-merged',
    rec.id,
    `基准落后（rev ${patch.baseRevision} → ${rec.draft.baseRevision}），字段级三方合并成功`,
    patch.window,
  );
  return ok(state);
}

/** 解决单个冲突字段：取离线值 / 同事值 / 指定值；全部解决后自动解除拦截 */
export function resolveConflict(
  prev: WorkbenchState,
  recordId: string,
  field: string,
  pick: 'local' | 'remote' | { value: string | number | License | null },
  window = '窗口 A',
): ActionResult {
  const state = clone(prev);
  const rec = find(state, recordId);
  const idx = rec.conflicts.findIndex((c) => c.field === field);
  if (idx < 0) return fail(state, '没有该冲突字段');
  const slot = rec.conflicts[idx];
  const chosen = pick === 'local' ? slot.local : pick === 'remote' ? slot.remote : pick.value;

  if (field === 'license') rec.license = (chosen as License | null) ?? rec.license;
  else rec.draft.fields[field as keyof PairingFields] = chosen as never;

  rec.conflicts.splice(idx, 1);
  state.rev += 1;
  rec.draft.baseRevision = state.rev;
  log(
    state,
    'conflict-resolved',
    recordId,
    `字段 ${field} 裁决为${pick === 'local' ? '离线值' : pick === 'remote' ? '同事值' : '指定值'}`,
    window,
  );
  return ok(state);
}

// ---------- 确认（两窗口竞争 + 幂等 + 快照留档） ----------

export type IdempotencyTable = Record<
  string,
  { ok: boolean; recordId: string; result: 'confirmed' | 'published' }
>;

/**
 * 确认：把当前草稿冻结为不可变确认快照（与草稿分开放）。
 * - 候选单赢家 CAS：同一字段版本已被其他窗口确认时，后到窗口输掉（先到版本生效）。
 * - 幂等：相同 idempotencyKey 的重试返回首次结果，不重复生成快照记录。
 */
export function confirmSnapshot(
  prev: WorkbenchState,
  recordId: string,
  window: string,
  idempotencyKey: string,
  idem: IdempotencyTable,
): ActionResult & { snapshot?: ConfirmedSnapshot } {
  // 幂等命中：重试不重复生成记录
  const prior = idem[idempotencyKey];
  if (prior) {
    const state = reconcileAll(clone(prev));
    const rec = state.records.find((r) => r.id === prior.recordId);
    log(state, 'confirm-deduped', prior.recordId, `${window} 重试确认，命中幂等键，返回首次结果（不重复生成）`, window);
    return {
      ok: prior.ok,
      state,
      deduped: true,
      recordId: prior.recordId,
      snapshot: rec?.snapshot ?? undefined,
    };
  }

  const state = clone(prev);
  const rec = find(state, recordId);

  if (rec.conflicts.length > 0) return fail(state, '冲突未裁决，已挡住确认/发布');
  if (!licenseValid(rec.license, state.now, state.assetVersion))
    return fail(state, '授权缺失/到期/版本不符，无法确认');

  // CAS：同一字段版本的快照已存在 → 后到窗口输掉竞争。
  // （先到窗口确认后已把候选作废，所以竞争检查必须先于候选有效性检查）
  if (rec.snapshot && !rec.snapshot.publishedAt && rec.candidate && rec.snapshot.fieldsHash === rec.candidate.fieldsHash) {
    log(
      state,
      'confirm-lost-race',
      recordId,
      `${window} 确认失败：${rec.snapshot.winnerWindow ?? '另一窗口'} 的同版本快照已先生效`,
      window,
    );
    return fail(state, `先到版本已生效（${rec.snapshot.winnerWindow} 已确认），后到请求被拒绝`);
  }

  if (!rec.candidate || rec.candidate.invalid) return fail(state, '发布候选已失效，请等待重算后再确认');
  if (rec.approval?.status !== 'approved' || rec.approval.fieldsHash !== fieldsHash(rec.draft.fields))
    return fail(state, '审批已失效或字段已变化，无法确认');

  const snapshot: ConfirmedSnapshot = {
    id: uid('snap'),
    approvalId: rec.approval.id,
    candidateId: rec.candidate.id,
    title: rec.draft.title,
    fields: clone(rec.draft.fields),
    license: clone(rec.license!),
    assetVersion: state.assetVersion,
    fieldsHash: rec.candidate.fieldsHash,
    baseRevision: rec.draft.baseRevision,
    createdAt: state.now,
    winnerWindow: window,
  };
  // 草稿与快照分开放：草稿原样保留可继续编辑，快照独立留档
  rec.snapshot = snapshot;
  // 候选单赢家：确认后候选立即作废，持旧候选的其他窗口无法再确认
  rec.candidate = { ...rec.candidate, invalid: true };

  log(state, 'confirmed', recordId, `${window} 确认生效，快照 ${snapshot.id} 已留档（草稿独立保留）`, window);
  idem[idempotencyKey] = { ok: true, recordId, result: 'confirmed' };

  return { ok: true, state: reconcileAll(state), recordId, snapshot };
}

// ---------- 发布（幂等 + 写入失败从完整快照恢复） ----------

/**
 * 发布确认快照。发布幂等；写入失败(writeOk=false)时：
 * 先把整个工作台的完整快照写入恢复区，再从恢复区还原（本次发布不生效）。
 */
export function publishSnapshot(
  prev: WorkbenchState,
  recordId: string,
  window: string,
  idempotencyKey: string,
  idem: IdempotencyTable,
  writeOk: boolean,
  saveRecovery: (snapshot: string) => void,
  loadRecovery: () => string | null,
  clearRecovery: () => void,
): ActionResult {
  const prior = idem[idempotencyKey];
  if (prior) {
    const state = reconcileAll(clone(prev));
    log(state, 'publish-deduped', prior.recordId, `${window} 重试发布，命中幂等键（不重复生成）`, window);
    return { ok: prior.ok, state, deduped: true, recordId: prior.recordId };
  }

  const state = clone(prev);
  const rec = find(state, recordId);
  if (!rec.snapshot) return fail(state, '没有确认快照，不能发布');
  if (rec.snapshot.publishedAt) return fail(state, '该快照已发布');
  if (rec.snapshot.license.expiresAt <= state.now)
    return fail(state, '确认快照的授权已到期，发布候选失效，已挡住发布');
  if (rec.snapshot.assetVersion !== state.assetVersion)
    return fail(state, `素材已换版 v${state.assetVersion}，旧快照失效，已挡住发布`);

  if (!writeOk) {
    // 写入失败：先把“完整快照”（整个工作台状态）落到恢复区
    saveRecovery(JSON.stringify(state));
    log(state, 'write-failed', recordId, `${window} 发布写入失败，完整工作台快照已写入恢复区`, window);

    // 再从完整快照恢复（本次发布不生效，数据回到写入前）
    const backup = loadRecovery();
    clearRecovery();
    if (!backup) return fail(state, '写入失败且恢复区无快照');
    const recovered = reconcileAll(clone(JSON.parse(backup) as WorkbenchState));
    log(recovered, 'restored', recordId, `${window} 已从完整快照恢复，本次失败发布未落库`, window);
    return { ok: false, state: recovered, error: 'write-failed-restored', recordId };
  }

  rec.status = 'published';
  rec.snapshot = { ...rec.snapshot, publishedAt: state.now };
  log(state, 'published', recordId, `${window} 发布成功，终态已锁定`, window);
  idem[idempotencyKey] = { ok: true, recordId, result: 'published' };
  return { ok: true, state: reconcileAll(state), recordId };
}

// ---------- 全局换版 / 时间推进 ----------

/** 全局素材换版：所有审批与候选失效，重算 */
export function bumpAssetVersion(prev: WorkbenchState, window = '管理员'): ActionResult {
  const state = clone(prev);
  state.assetVersion += 1;
  log(state, 'version-bumped', null, `素材换版至 v${state.assetVersion}：审批与发布候选全部失效重算`, window);
  return ok(state);
}

/** 推进时钟（模拟授权到期） */
export function advanceTime(prev: WorkbenchState, ms: number): ActionResult {
  const state = clone(prev);
  state.now += ms;
  return ok(state);
}

// ---------- 持久化（写入失败 → 完整快照恢复） ----------

/**
 * 带恢复保护的持久化：写主存储前先把完整快照放恢复区，
 * 主写入成功才清恢复区；forceFail 时从恢复区完整快照还原。
 */
export function persistWithRecovery(
  prev: WorkbenchState,
  save: (raw: string) => void,
  load: () => string | null,
  saveRecovery: (raw: string) => void,
  loadRecovery: () => string | null,
  clearRecovery: () => void,
  forceFail = false,
): { state: WorkbenchState; restored: boolean } {
  void load;
  const raw = JSON.stringify(prev);
  saveRecovery(raw);
  let failed = forceFail;
  if (!forceFail) {
    try {
      save(raw);
    } catch {
      failed = true;
    }
  }
  if (failed) {
    const backup = loadRecovery();
    const restored: WorkbenchState = backup
      ? reconcileAll(clone(JSON.parse(backup) as WorkbenchState))
      : clone(prev);
    log(restored, 'restored', null, '主存储写入失败，已从恢复区完整快照恢复', '系统');
    return { state: restored, restored: true };
  }
  clearRecovery();
  return { state: prev, restored: false };
}

export function loadState(
  load: () => string | null,
  now: number,
  legacyLoad?: () => string | null,
): WorkbenchState {
  const raw = load();
  if (raw) {
    const parsed = JSON.parse(raw) as WorkbenchState;
    parsed.now = now;
    return reconcileAll(parsed);
  }
  let legacy: unknown;
  if (legacyLoad) {
    try {
      legacy = JSON.parse(legacyLoad() || 'null');
    } catch {
      legacy = undefined;
    }
  }
  return createInitialState(now, legacy);
}

export { LEGACY_KEY };

// ---------- 展示辅助 ----------

export function fieldLabel(k: keyof PairingFields | 'license'): string {
  switch (k) {
    case 'headingFont':
      return '标题字体';
    case 'bodyFont':
      return '正文字体';
    case 'size':
      return '字号';
    case 'weight':
      return '字重';
    case 'leading':
      return '行高';
    case 'tracking':
      return '字间距';
    case 'license':
      return '授权';
  }
}

export function fmtValue(v: unknown): string {
  if (v === null) return '—';
  if (typeof v === 'object') {
    const l = v as License;
    return `${l.holder} · v${l.assetVersion} · ${l.seats}席`;
  }
  return String(v);
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function daysLeft(lic: License | null, now: number): number | null {
  if (!lic) return null;
  return Math.max(0, Math.round((lic.expiresAt - now) / 86400_000));
}

export { FONT_CHOICES };

export type { Approval, PairingStatus };
