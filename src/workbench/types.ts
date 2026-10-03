// 发布工作台 · 领域类型
// 所有持久化数据都在 WorkbenchState 内，可整体序列化为一条快照。

/** 草稿字段：成员真正编辑的排版参数 */
export type PairingFields = {
  headingFont: string;
  bodyFont: string;
  size: number;
  weight: number;
  leading: number;
  tracking: number;
};

/** 授权信息：随字体/素材版本走，到期或换版后旧审批与发布候选失效 */
export type License = {
  /** 授权主体（被授权方） */
  holder: string;
  /** 授权覆盖的素材版本；全局换版后需重新授权 */
  assetVersion: number;
  /** 到期时间（epoch ms） */
  expiresAt: number;
  seats: number;
};

/** 审批结论 */
export type ApprovalStatus = 'approved' | 'rejected' | 'pending' | 'expired' | 'superseded';

export type Approval = {
  id: string;
  seq: number;
  status: ApprovalStatus;
  reviewer: string;
  /** 审批时锁定的字段指纹，字段被改动后审批作废 */
  fieldsHash: string;
  assetVersion: number;
  createdAt: number;
  reason?: string;
};

/**
 * 发布候选：审批通过后生成。
 * 授权到期 / 全局换版 / 字段再编辑都会让候选失效，需要重算。
 */
export type PublishCandidate = {
  id: string;
  approvalId: string;
  fieldsHash: string;
  assetVersion: number;
  licenseExpiresAt: number;
  createdAt: number;
  invalid: boolean;
  /** 失效原因，便于工作台提示为什么被挡住 */
  invalidReason?: 'license-expired' | 'version-bumped' | 'fields-changed';
};

/** 已确认快照：确认时的不可变留档，与草稿分开存放 */
export type ConfirmedSnapshot = {
  id: string;
  approvalId: string;
  candidateId: string;
  title: string;
  fields: PairingFields;
  license: License;
  assetVersion: number;
  fieldsHash: string;
  baseRevision: number;
  createdAt: number;
  /** 先到窗口：两个窗口同时确认时记录获胜方 */
  winnerWindow?: string;
  /** 实际发布时间（未发布为空） */
  publishedAt?: number;
};

/** 冲突槽位：离线补丁按字段三方合并，同字段双方都改则保留双方值 */
export type ConflictSlot =
  | { field: keyof PairingFields; base: string | number; local: string | number; remote: string | number }
  | { field: 'license'; base: License | null; local: License | null; remote: License | null };

export type PairingStatus =
  | 'draft' // 普通草稿
  | 'awaiting-license' // 缺少有效授权：旧数据升级后或授权被移除，停在待补
  | 'awaiting-approval' // 有授权，等待审批（含授权到期、换版后旧审批失效重算）
  | 'ready' // 审批通过、候选有效，可确认
  | 'conflict' // 离线补丁与同事版本冲突：挡住发布
  | 'confirmed' // 已确认快照、尚未发布
  | 'published'; // 已发布（终态）

export type AuditType =
  | 'draft-edited'
  | 'offline-edited'
  | 'patch-merged'
  | 'patch-conflict'
  | 'conflict-resolved'
  | 'license-set'
  | 'approval-requested'
  | 'approval-decided'
  | 'approval-invalidated'
  | 'candidate-invalidated'
  | 'candidate-rebuilt'
  | 'confirmed'
  | 'confirm-deduped'
  | 'confirm-lost-race'
  | 'published'
  | 'publish-deduped'
  | 'version-bumped'
  | 'restored'
  | 'write-failed'
  | 'legacy-upgraded';

export type AuditEvent = {
  id: string;
  seq: number;
  time: number;
  recordId: string | null;
  type: AuditType;
  detail?: string;
  /** 触发窗口，便于演示“两个窗口”的来源 */
  window?: string;
};

export type RecordDraft = {
  title: string;
  category: string;
  fields: PairingFields;
  /** 草稿基于的服务端修订号；离线补丁回来先核对基准 */
  baseRevision: number;
  updatedAt: number;
};

export type PairingRecord = {
  id: string;
  seq: number;
  draft: RecordDraft;
  /** 授权可能缺失（待补） */
  license: License | null;
  approval: Approval | null;
  candidate: PublishCandidate | null;
  snapshot: ConfirmedSnapshot | null;
  conflicts: ConflictSlot[];
  status: PairingStatus;
  statusDetail?: string;
};

/** 离线期间暂存的补丁 */
export type OfflinePatch = {
  id: string;
  recordId: string;
  window: string;
  /** 断连瞬间记录所基于的修订号（基准） */
  baseRevision: number;
  /** 断连瞬间的完整字段值（三方合并的基准 base） */
  baseFields: PairingFields;
  /** 断连瞬间的授权（三方合并的基准） */
  baseLicense: License | null;
  /** 离线期间改动的字段；未改字段不在补丁里 */
  fields?: Partial<PairingFields>;
  license?: License | null;
  createdAt: number;
  applied: boolean;
};

export type WorkbenchState = {
  /** schema 版本：旧数据（只有草稿）升级到带授权信息的记录 */
  schemaVersion: 2;
  rev: number;
  seq: number;
  assetVersion: number;
  now: number;
  records: PairingRecord[];
  offlinePatches: OfflinePatch[];
  audit: AuditEvent[];
};

/** 旧数据形态：只有草稿、没有授权信息 */
export type LegacyPair = {
  id: number;
  title: string;
  heading: string;
  body: string;
  category: string;
  favorite: boolean;
};

/** 引擎动作的统一返回 */
export type ActionResult = {
  ok: boolean;
  state: WorkbenchState;
  error?: string;
  /** 幂等命中时返回已生成的记录 id，重试不重复生成 */
  deduped?: boolean;
  recordId?: string;
};

export const STATUS_LABEL: Record<PairingStatus, string> = {
  draft: '草稿',
  'awaiting-license': '待补授权',
  'awaiting-approval': '待审批',
  ready: '可确认',
  conflict: '冲突',
  confirmed: '已确认',
  published: '已发布',
};

export const DEFAULT_FIELDS: PairingFields = {
  headingFont: 'Fraunces',
  bodyFont: 'DM Sans',
  size: 46,
  weight: 600,
  leading: 1.25,
  tracking: 0,
};

export const FONT_CHOICES = [
  'Fraunces',
  'DM Sans',
  'Space Grotesk',
  'Newsreader',
  'IBM Plex Sans',
  'Playfair Display',
];
