// 发布工作台纯逻辑引擎：不依赖 React / localStorage，可独立单测。
import {
  ActivityEntry,
  Approval,
  ConfirmedSnapshot,
  ContentField,
  DerivedStatus,
  FieldConflict,
  InvalidReason,
  License,
  MergeKey,
  OfflineSession,
  PairingContent,
  PairingRecord,
  RecordStatus,
  RECORD_SCHEMA_VERSION,
  Release,
  STORAGE_VERSION,
  WorkbenchState,
} from './types';

// ---------- 工具 ----------

let counter = 0;
export function uid(prefix = 'id'): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/** 对象键排序后序列化，保证同样数据指纹一致 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/** FNV-1a 32 位内容指纹，用于核对审批/候选绑定的基准是否被改写 */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export const contentHash = (c: PairingContent): string => fnv1a(stableStringify(c));

/** 授权指纹：持有人/档位/有效期任一变化即改变 */
export function licenseFingerprint(license: License | null): string {
  if (!license) return 'none';
  return fnv1a(stableStringify(license));
}

export function licenseStatus(
  license: License | null,
  now: number,
): 'missing' | 'active' | 'expired' | 'future' {
  if (!license) return 'missing';
  if (now > license.validUntil) return 'expired';
  if (now < license.validFrom) return 'future';
  return 'active';
}

export function logActivity(
  record: PairingRecord,
  message: string,
  tone: ActivityEntry['tone'],
  now: number,
): void {
  const entry: ActivityEntry = { id: uid('log'), at: now, message, tone };
  record.activity = [entry, ...record.activity].slice(0, 60);
}

// ---------- 审批 / 候选有效性核对 ----------

/** 旧审批为何不再放行；null 表示仍然有效 */
export function approvalInvalidReason(
  record: PairingRecord,
  now: number,
): InvalidReason | null {
  const a = record.approval;
  if (!a || a.state !== 'approved') return null;
  if (a.baseContentHash !== contentHash(record.draft)) return 'content-changed';
  if (a.licenseFingerprint !== licenseFingerprint(record.draftLicense))
    return 'license-changed';
  if (a.schemaVersion !== record.schemaVersion) return 'version-changed';
  const ls = licenseStatus(record.draftLicense, now);
  if (ls === 'expired') return 'license-expired';
  if (ls === 'future') return 'license-not-yet-valid';
  return null;
}

/** 发布候选为何失效（授权到期或换版后必须重算）；null 表示仍可发布 */
export function candidateInvalidReason(
  state: WorkbenchState,
  record: PairingRecord,
  now: number,
): InvalidReason | null {
  const c = record.candidate;
  if (!c) return null;
  const snap = state.snapshots[c.snapshotKey];
  if (!snap) return 'content-changed';
  if (snap.schemaVersion !== record.schemaVersion) return 'version-changed';
  // 候选快照内容是不可变的；授权以“快照内授权”为准核对有效期
  const ls = licenseStatus(snap.license, now);
  if (ls === 'expired') return 'license-expired';
  if (ls === 'future') return 'license-not-yet-valid';
  // 当前记录上的授权若被换成另一份授权（指纹不同），快照所基于的授权链路作废
  if (snap.licenseFingerprint !== licenseFingerprint(record.draftLicense))
    return 'license-changed';
  return null;
}

export function deriveStatus(
  state: WorkbenchState,
  record: PairingRecord,
  now: number,
): DerivedStatus {
  const approvalValid =
    !!record.approval &&
    record.approval.state === 'approved' &&
    approvalInvalidReason(record, now) === null;
  const candidateValid =
    !!record.candidate && candidateInvalidReason(state, record, now) === null;
  let status: RecordStatus;
  if (!record.draftLicense) status = 'awaiting-license';
  else if (record.conflicts.length > 0) status = 'conflict';
  else if (candidateValid) status = 'confirmed';
  else if (record.candidate && !candidateValid) status = 'candidate-invalid';
  else if (approvalValid) status = 'approved';
  else if (record.approval?.state === 'pending') status = 'awaiting-approval';
  else if (record.approval?.state === 'rejected') status = 'rejected';
  else if (record.approval) status = 'stale';
  else status = 'draft';
  // 已发布版本始终可见，但只要有更新/冲突就回到待发布状态；
  // 发布记录与草稿同版本且无任何未发布变化时显示 published。
  const latest = record.releases[0];
  if (
    latest &&
    record.conflicts.length === 0 &&
    record.draftRevision === latest.revision &&
    !record.candidate
  ) {
    status = 'published';
  }
  return {
    status,
    approvalReason: approvalValid ? undefined : approvalInvalidReason(record, now) ?? undefined,
    candidateReason: candidateValid
      ? undefined
      : candidateInvalidReason(state, record, now) ?? undefined,
    approvalValid,
    candidateValid,
  };
}

// ---------- 记录构造 / 旧数据迁移 ----------

export const DEFAULT_CONTENT: PairingContent = {
  headingFont: 'Fraunces',
  bodyFont: 'DM Sans',
  size: 46,
  weight: 600,
  lineHeight: 1.25,
  tracking: 0,
  headingText: 'Your headline',
  bodyText:
    'Good typography creates space for ideas to breathe. Pair a confident display face with a quiet, generous text face.',
  category: 'Untitled',
};

/** 旧数据只有草稿时，升级成“带授权信息槽位”的记录；缺授权则停在待补 */
export function migrateRecord(
  legacy: { id: number; title: string; draft: Partial<PairingContent> },
  now: number,
): PairingRecord {
  return {
    id: legacy.id,
    title: legacy.title,
    schemaVersion: RECORD_SCHEMA_VERSION,
    draftRevision: 1,
    draft: { ...DEFAULT_CONTENT, ...legacy.draft },
    draftLicense: null, // 旧草稿无授权信息 → awaiting-license
    approval: null,
    confirmedSnapshotKey: null,
    candidate: null,
    releases: [],
    offline: null,
    conflicts: [],
    idem: {},
    activity: [
      {
        id: uid('log'),
        at: now,
        message: '旧版草稿已升级为带授权信息的记录，缺少授权，停在“待补授权”',
        tone: 'warn',
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

export function emptyState(): WorkbenchState {
  return { storageVersion: STORAGE_VERSION, records: {}, snapshots: {} };
}

/** 读取旧存储（storageVersion=1，只有草稿）时整体升级 */
export function migrateState(raw: unknown): WorkbenchState {
  if (
    raw &&
    typeof raw === 'object' &&
    (raw as WorkbenchState).storageVersion === STORAGE_VERSION &&
    (raw as WorkbenchState).snapshots
  ) {
    return raw as WorkbenchState;
  }
  const state = emptyState();
  // 旧结构：{ id: {id,title,heading,body,...} } 或 Pair[]
  const legacyMap = (raw ?? {}) as Record<string, unknown>;
  Object.values(legacyMap).forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'number' ? e.id : Number(e.id) || Math.floor(Math.random() * 1e6);
    const draft: Partial<PairingContent> = {};
    if (typeof e.heading === 'string') draft.headingText = e.heading as string;
    if (typeof e.body === 'string') draft.bodyText = e.body as string;
    if (typeof e.category === 'string') draft.category = e.category as string;
    const record = migrateRecord(
      { id, title: (e.title as string) || `Pairing ${id}`, draft },
      Date.now(),
    );
    state.records[id] = record;
  });
  return state;
}

export function createRecord(
  state: WorkbenchState,
  input: { id?: number; title: string; content?: Partial<PairingContent>; license?: License | null },
  now: number,
): PairingRecord {
  const id = input.id ?? Date.now();
  const record: PairingRecord = {
    id,
    title: input.title,
    schemaVersion: RECORD_SCHEMA_VERSION,
    draftRevision: 1,
    draft: { ...DEFAULT_CONTENT, ...input.content },
    draftLicense: input.license ?? null,
    approval: null,
    confirmedSnapshotKey: null,
    candidate: null,
    releases: [],
    offline: null,
    conflicts: [],
    idem: {},
    activity: [
      {
        id: uid('log'),
        at: now,
        message: input.license ? '已创建，授权就绪' : '已创建，等待补充授权',
        tone: input.license ? 'good' : 'warn',
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  state.records[id] = record;
  return record;
}

// ---------- 动作结果 ----------

export interface ActionResult<T = undefined> {
  ok: boolean;
  error?: string;
  value?: T;
}

const fail = (error: string): ActionResult<never> => ({ ok: false, error });
const ok = <T>(value: T): ActionResult<T> => ({ ok: true, value });

function getRecord(state: WorkbenchState, recordId: number): PairingRecord | null {
  return state.records[recordId] ?? null;
}

/** 草稿任何实质修改都会让旧审批/候选的基准失效（由指纹核对体现） */
function bumpRevision(record: PairingRecord): void {
  record.draftRevision += 1;
}

// ---------- 草稿编辑 ----------

export function updateDraftField<K extends keyof PairingContent>(
  state: WorkbenchState,
  recordId: number,
  field: K,
  value: PairingContent[K],
  now: number,
  actor = '我',
): ActionResult {
  const record = getRecord(state, recordId);
  if (!record) return fail('记录不存在');
  if (record.offline) return fail('离线补丁尚未回连，不能直接覆盖草稿');
  if (stableStringify(record.draft[field]) === stableStringify(value)) return ok(undefined);
  const beforeApproval = approvalInvalidReason(record, now);
  record.draft[field] = value;
  bumpRevision(record);
  record.updatedAt = now;
  if (beforeApproval === null && record.approval?.state === 'approved') {
    logActivity(record, `${actor} 改动草稿，原审批基准已失效，需重新审批`, 'warn', now);
  } else {
    logActivity(record, `${actor} 更新了草稿字段「${field}」（rev ${record.draftRevision}）`, 'info', now);
  }
  return ok(undefined);
}

export function setLicense(
  state: WorkbenchState,
  recordId: number,
  license: License | null,
  now: number,
  actor = '我',
): ActionResult {
  const record = getRecord(state, recordId);
  if (!record) return fail('记录不存在');
  const fpBefore = licenseFingerprint(record.draftLicense);
  record.draftLicense = license;
  record.updatedAt = now;
  if (fpBefore !== licenseFingerprint(license)) {
    bumpRevision(record);
    logActivity(
      record,
      license
        ? `${actor} 更新了授权（${license.tier}/${license.holder}），审批与发布候选失效重算`
        : `${actor} 移除了授权，停在“待补授权”`,
      'warn',
      now,
    );
  }
  return ok(undefined);
}

/** 换版：内容结构 schema 升版，审批与候选立即失效 */
export function bumpSchemaVersion(
  state: WorkbenchState,
  recordId: number,
  now: number,
  actor = '我',
): ActionResult {
  const record = getRecord(state, recordId);
  if (!record) return fail('记录不存在');
  record.schemaVersion += 1;
  record.updatedAt = now;
  logActivity(
    record,
    `${actor} 将排版结构升级到 v${record.schemaVersion}，旧审批与发布候选作废，需重新走流程`,
    'warn',
    now,
  );
  return ok(undefined);
}

// ---------- 审批 ----------

export function submitApproval(
  state: WorkbenchState,
  recordId: number,
  now: number,
  actor = '我',
): ActionResult<Approval> {
  const record = getRecord(state, recordId);
  if (!record) return fail('记录不存在');
  if (!record.draftLicense) return fail('缺少授权，不能提交审批');
  if (licenseStatus(record.draftLicense, now) !== 'active')
    return fail('授权不在有效期内，不能提交审批');
  if (record.conflicts.length > 0) return fail('存在未解决冲突，先合并双方版本');
  const approval: Approval = {
    id: uid('apv'),
    state: 'pending',
    requestedBy: actor,
    requestedAt: now,
    baseContentHash: contentHash(record.draft),
    licenseFingerprint: licenseFingerprint(record.draftLicense),
    schemaVersion: record.schemaVersion,
  };
  record.approval = approval;
  record.updatedAt = now;
  logActivity(record, `${actor} 提交审批（rev ${record.draftRevision}）`, 'info', now);
  return ok(approval);
}

export function decideApproval(
  state: WorkbenchState,
  recordId: number,
  decision: 'approved' | 'rejected',
  now: number,
  approver = '审批人',
  reason?: string,
): ActionResult {
  const record = getRecord(state, recordId);
  if (!record) return fail('记录不存在');
  if (record.approval?.state !== 'pending') return fail('没有待决审批');
  // 审批人决策时再核对一次基准，防止等待期间被离线补丁覆盖
  const invalid = approvalInvalidReason(record, now);
  if (invalid) return fail(`审批基准已变化（${invalid}），请重新提交`);
  record.approval.state = decision;
  record.approval.decidedAt = now;
  record.approval.approver = approver;
  record.approval.reason = reason;
  record.updatedAt = now;
  logActivity(
    record,
    decision === 'approved'
      ? `${approver} 批准（绑定 rev ${record.draftRevision}）`
      : `${approver} 驳回：${reason ?? ''}`,
    decision === 'approved' ? 'good' : 'bad',
    now,
  );
  return ok(undefined);
}

// ---------- 确认：生成不可变快照（草稿与快照分开放） ----------

export interface ConfirmOutcome {
  snapshot: ConfirmedSnapshot;
  reused: boolean; // true = 命中幂等/业务唯一约束，未重复生成
}

export function confirmSnapshot(
  state: WorkbenchState,
  recordId: number,
  now: number,
  actor: string,
  idempotencyKey: string,
): ActionResult<ConfirmOutcome> {
  const record = getRecord(state, recordId);
  if (!record) return fail('记录不存在');
  if (!record.draftLicense) return fail('缺少授权，不能确认');
  if (record.conflicts.length > 0) return fail('存在冲突，发布已被挡住，先解决冲突');

  // 1) 幂等：同一确认动作重试，返回同一条快照，不重复生成记录
  const existingKey = record.idem[idempotencyKey];
  if (existingKey && state.snapshots[existingKey]) {
    return ok({ snapshot: state.snapshots[existingKey], reused: true });
  }

  // 2) 审批必须仍然有效（内容/授权指纹、版本、有效期全部核对）
  const invalid = approvalInvalidReason(record, now);
  if (invalid) return fail(`审批已失效（${invalid}），请重新审批`);
  if (record.approval!.state !== 'approved') return fail('审批尚未通过');

  // 3) 业务唯一：一次审批只能产生一个确认快照（两个窗口同时确认 → 先到版本生效）
  const boundKey = record.approval!.confirmedSnapshotKey;
  if (boundKey && state.snapshots[boundKey]) {
    record.idem[idempotencyKey] = boundKey; // 后到窗口的重试也锚定到先到版本
    return ok({ snapshot: state.snapshots[boundKey], reused: true });
  }

  const key = `${recordId}@${record.draftRevision}`;
  // 同修订号的快照若已独立存在（历史残留），复用而不是新建
  const prior = state.snapshots[key];
  if (prior) {
    record.idem[idempotencyKey] = key;
    record.approval!.confirmedSnapshotKey = key;
    record.confirmedSnapshotKey = key;
    return ok({ snapshot: prior, reused: true });
  }

  const snapshot: ConfirmedSnapshot = {
    key,
    recordId,
    revision: record.draftRevision,
    content: structuredClone(record.draft),
    license: record.draftLicense ? structuredClone(record.draftLicense) : null,
    licenseFingerprint: licenseFingerprint(record.draftLicense),
    schemaVersion: record.schemaVersion,
    approvalId: record.approval!.id,
    confirmedAt: now,
    confirmedBy: actor,
    idempotencyKey,
  };
  state.snapshots[key] = snapshot;
  record.idem[idempotencyKey] = key;
  record.approval!.confirmedSnapshotKey = key;
  record.confirmedSnapshotKey = key;
  record.candidate = { id: uid('cand'), snapshotKey: key, createdAt: now };
  record.updatedAt = now;
  logActivity(
    record,
    `${actor} 确认快照 ${key}，生成发布候选（草稿与快照分开放）`,
    'good',
    now,
  );
  return ok({ snapshot, reused: false });
}

// ---------- 发布 ----------

export function publish(
  state: WorkbenchState,
  recordId: number,
  now: number,
  actor: string,
  idempotencyKey: string,
): ActionResult<Release> {
  const record = getRecord(state, recordId);
  if (!record) return fail('记录不存在');

  const existingReleaseId = record.idem[idempotencyKey];
  if (existingReleaseId) {
    const found = record.releases.find((r) => r.id === existingReleaseId);
    if (found) return ok(found);
  }

  if (record.conflicts.length > 0) return fail('存在冲突，发布被挡住');
  if (!record.candidate) return fail('没有发布候选，请先确认快照');
  const invalid = candidateInvalidReason(state, record, now);
  if (invalid) return fail(`发布候选已失效（${invalid}），请重新确认`);

  const snapshot = state.snapshots[record.candidate.snapshotKey];
  const release: Release = {
    id: uid('rel'),
    snapshotKey: snapshot.key,
    revision: snapshot.revision,
    contentHash: contentHash(snapshot.content),
    schemaVersion: snapshot.schemaVersion,
    licenseFingerprint: snapshot.licenseFingerprint,
    publishedAt: now,
    publishedBy: actor,
    idempotencyKey,
  };
  record.releases = [release, ...record.releases];
  record.idem[idempotencyKey] = release.id;
  record.candidate = null;
  record.updatedAt = now;
  logActivity(record, `${actor} 发布 ${snapshot.key}`, 'good', now);
  return ok(release);
}

// ---------- 离线：补丁与三路合并 ----------

export function goOffline(
  state: WorkbenchState,
  recordId: number,
  member: string,
  now: number,
): ActionResult<OfflineSession> {
  const record = getRecord(state, recordId);
  if (!record) return fail('记录不存在');
  if (record.offline) return fail('已在离线会话中');
  if (record.conflicts.length > 0) return fail('请先解决现有冲突再离线');
  const session: OfflineSession = {
    id: uid('off'),
    member,
    startedAt: now,
    baseRevision: record.draftRevision,
    baseContent: structuredClone(record.draft),
    baseLicense: record.draftLicense ? structuredClone(record.draftLicense) : null,
    contentPatch: {},
    licenseTouched: false,
    licensePatch: null,
  };
  record.offline = session;
  logActivity(record, `${member} 进入离线编辑（基准 rev ${session.baseRevision}）`, 'info', now);
  return ok(session);
}

export function offlineEdit<K extends keyof PairingContent>(
  state: WorkbenchState,
  recordId: number,
  field: K,
  value: PairingContent[K],
): ActionResult {
  const record = getRecord(state, recordId);
  if (!record?.offline) return fail('没有进行中的离线会话');
  record.offline.contentPatch[field] = value;
  return ok(undefined);
}

export function offlineSetLicense(
  state: WorkbenchState,
  recordId: number,
  license: License,
): ActionResult {
  const record = getRecord(state, recordId);
  if (!record?.offline) return fail('没有进行中的离线会话');
  record.offline.licenseTouched = true;
  record.offline.licensePatch = structuredClone(license);
  return ok(undefined);
}

/** 同事在线上改动（与离线补丁并行发生） */
export function remoteEdit<K extends keyof PairingContent>(
  state: WorkbenchState,
  recordId: number,
  field: K,
  value: PairingContent[K],
  member: string,
  now: number,
): ActionResult {
  const record = getRecord(state, recordId);
  if (!record) return fail('记录不存在');
  if (!record.offline) return fail('没有进行中的离线会话，无法模拟同事改动');
  if (stableStringify(record.draft[field]) === stableStringify(value)) return ok(undefined);
  record.draft[field] = value;
  bumpRevision(record);
  record.updatedAt = now;
  logActivity(record, `${member} 在你离线期间改动了「${field}」（rev ${record.draftRevision}）`, 'warn', now);
  return ok(undefined);
}

export interface ReconnectOutcome {
  applied: MergeKey[];
  conflicts: FieldConflict[];
}

/**
 * 回连：先核对基准修订号。
 * - 基准一致：补丁直接落草稿
 * - 基准落后：逐字段三路合并（base/local/remote），
 *   双方都改且不同 → 冲突字段保留双方值并挡住发布
 */
export function reconnect(
  state: WorkbenchState,
  recordId: number,
  now: number,
): ActionResult<ReconnectOutcome> {
  const record = getRecord(state, recordId);
  if (!record) return fail('记录不存在');
  const session = record.offline;
  if (!session) return fail('没有进行中的离线会话');

  const applied: MergeKey[] = [];
  const conflicts: FieldConflict[] = [];

  if (session.baseRevision > record.draftRevision) {
    return fail('基准修订号高于当前记录，状态异常，已拒绝回连');
  }

  const sameBase = session.baseRevision === record.draftRevision;

  // —— 内容字段逐个合并 ——
  const patchEntries = Object.entries(session.contentPatch) as [ContentField, unknown][];
  const merged = structuredClone(record.draft) as PairingContent;
  for (const [field, localValue] of patchEntries) {
    const baseValue = session.baseContent[field];
    const remoteValue = record.draft[field];
    const localChanged = stableStringify(baseValue) !== stableStringify(localValue);
    const remoteChanged =
      sameBase ? false : stableStringify(baseValue) !== stableStringify(remoteValue);

    if (!localChanged) continue;
    if (!remoteChanged) {
      // 同事没动，采用本地补丁
      (merged[field] as unknown) = localValue;
      applied.push(field);
    } else if (stableStringify(localValue) === stableStringify(remoteValue)) {
      // 双方改成同一个值，自动收敛
      applied.push(field);
    } else {
      // 双方都改且不同：保留双方值（remote 落草稿，local 进冲突清单），挡住发布
      (merged[field] as unknown) = remoteValue;
      conflicts.push({ field, base: baseValue, local: localValue, remote: remoteValue });
    }
  }

  // —— 授权合并 ——
  if (session.licenseTouched) {
    const localLicense = session.licensePatch;
    const baseFp = licenseFingerprint(session.baseLicense);
    const localChanged = licenseFingerprint(localLicense) !== baseFp;
    const remoteChanged =
      !sameBase && licenseFingerprint(record.draftLicense) !== baseFp;
    if (localChanged && !remoteChanged) {
      record.draftLicense = structuredLicense(localLicense);
      applied.push('license');
    } else if (
      localChanged &&
      remoteChanged &&
      licenseFingerprint(localLicense) !== licenseFingerprint(record.draftLicense)
    ) {
      conflicts.push({
        field: 'license',
        base: session.baseLicense,
        local: localLicense,
        remote: record.draftLicense,
      });
    } else if (localChanged) {
      applied.push('license');
    }
  }

  record.draft = merged;
  // 无论干净合并还是冲突，离线补丁可能引入了变化；冲突时也要 bump 让审批基准彻底失效
  if (applied.length > 0 || conflicts.length > 0) bumpRevision(record);
  record.conflicts = [...record.conflicts, ...conflicts];
  record.offline = null;
  record.updatedAt = now;

  if (conflicts.length > 0) {
    logActivity(
      record,
      `离线补丁回连：${applied.length} 个字段已合并，${conflicts.length} 个字段冲突，已挡住发布`,
      'bad',
      now,
    );
    // 冲突后旧审批绝不能放行
    if (record.approval?.state === 'approved') {
      logActivity(record, '因合并冲突，已通过的审批停止放行', 'bad', now);
    }
  } else {
    logActivity(
      record,
      applied.length > 0
        ? `离线补丁回连：基准核对一致，${applied.length} 个字段干净合并（rev ${record.draftRevision}）`
        : '离线补丁回连：无实质改动',
      applied.length > 0 ? 'good' : 'info',
      now,
    );
  }
  return ok({ applied, conflicts });
}

function structuredLicense(license: License | null): License | null {
  return license ? structuredClone(license) : null;
}

/** 解决冲突：选择保留本地（离线）值或同事值；冲突清空后挡发布解除，旧审批仍需重走 */
export function resolveConflict(
  state: WorkbenchState,
  recordId: number,
  field: MergeKey,
  pick: 'local' | 'remote',
  now: number,
  actor = '我',
): ActionResult {
  const record = getRecord(state, recordId);
  if (!record) return fail('记录不存在');
  const idx = record.conflicts.findIndex((c) => c.field === field);
  if (idx < 0) return fail('该字段没有冲突');
  const conflict = record.conflicts[idx];
  const chosen = pick === 'local' ? conflict.local : conflict.remote;
  if (field === 'license') {
    record.draftLicense = (chosen as License | null) ? structuredClone(chosen as License) : null;
  } else {
    (record.draft[field as ContentField] as unknown) = chosen;
  }
  record.conflicts = record.conflicts.filter((c) => c.field !== field);
  bumpRevision(record);
  record.updatedAt = now;
  logActivity(
    record,
    `${actor} 解决「${field}」冲突，保留${pick === 'local' ? '离线' : '同事'}版本（rev ${record.draftRevision}）`,
    'info',
    now,
  );
  return ok(undefined);
}

// ---------- 时间推进：授权到期自动重算 ----------

/** 时钟跳动（演示用）：返回因到期而失效的记录 id 列表 */
export function tick(
  state: WorkbenchState,
  before: number,
  now: number,
): number[] {
  const expired: number[] = [];
  for (const record of Object.values(state.records)) {
    const checkLicense = (license: License | null): boolean =>
      !!license && before <= license.validUntil && now > license.validUntil;
    const draftExpired = checkLicense(record.draftLicense);
    let snapExpired = false;
    if (record.candidate) {
      const snap = state.snapshots[record.candidate.snapshotKey];
      snapExpired = checkLicense(snap?.license ?? null);
    }
    if (draftExpired || snapExpired) {
      expired.push(record.id);
      logActivity(
        record,
        '授权已到期：审批 / 发布候选标记失效，需续期后重算',
        'bad',
        now,
      );
    }
  }
  return expired;
}
