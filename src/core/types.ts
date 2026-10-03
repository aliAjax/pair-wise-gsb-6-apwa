// 发布工作台领域模型
// 核心原则：草稿（可反复改）与确认快照（不可变、独立存放）严格分离；
// 审批与发布候选只在“内容指纹 + 授权指纹 + 版本号 + 授权有效期”全部匹配时才有效。

/** 草稿中可被修改、可参与离线三路合并的字段 */
export type ContentField =
  | 'headingFont'
  | 'bodyFont'
  | 'size'
  | 'weight'
  | 'lineHeight'
  | 'tracking'
  | 'headingText'
  | 'bodyText'
  | 'category';

/** 合并键：内容字段 + 授权整体 */
export type MergeKey = ContentField | 'license';

export interface PairingContent {
  headingFont: string;
  bodyFont: string;
  size: number;
  weight: number;
  lineHeight: number;
  tracking: number;
  headingText: string;
  bodyText: string;
  category: string;
}

export type LicenseTier = 'standard' | 'extended' | 'web';

export interface License {
  holder: string;
  tier: LicenseTier;
  validFrom: number; // epoch ms
  validUntil: number; // epoch ms
}

export type ApprovalState = 'none' | 'pending' | 'approved' | 'rejected';

/** 审批在“通过”那一刻绑定的基准，任何一项对不上即失效 */
export interface Approval {
  id: string;
  state: ApprovalState;
  requestedBy: string;
  requestedAt: number;
  decidedAt?: number;
  approver?: string;
  reason?: string;
  baseContentHash: string;
  licenseFingerprint: string;
  schemaVersion: number;
  /** 一次审批最多产生一个确认快照（先到先得的业务唯一约束） */
  confirmedSnapshotKey?: string;
}

export interface FieldConflict {
  field: MergeKey;
  base: unknown;
  local: unknown;
  remote: unknown;
}

/** 离线会话：离线时记下基准修订号与基准内容，补丁只在本地累积 */
export interface OfflineSession {
  id: string;
  member: string;
  startedAt: number;
  baseRevision: number;
  baseContent: PairingContent;
  baseLicense: License | null;
  contentPatch: Partial<PairingContent>;
  licenseTouched: boolean;
  licensePatch: License | null;
}

/** 确认快照：一旦生成即不可变，独立于草稿存放 */
export interface ConfirmedSnapshot {
  key: string; // `${recordId}@${revision}`
  recordId: number;
  revision: number;
  content: PairingContent;
  license: License | null;
  licenseFingerprint: string;
  schemaVersion: number;
  approvalId: string;
  confirmedAt: number;
  confirmedBy: string;
  /** 发起确认时带的幂等键，重试直接返回同一条快照 */
  idempotencyKey: string;
}

export interface PublishCandidate {
  id: string;
  snapshotKey: string;
  createdAt: number;
}

export interface Release {
  id: string;
  snapshotKey: string;
  revision: number;
  contentHash: string;
  schemaVersion: number;
  licenseFingerprint: string | null;
  publishedAt: number;
  publishedBy: string;
  idempotencyKey: string;
}

export interface ActivityEntry {
  id: string;
  at: number;
  message: string;
  tone: 'info' | 'good' | 'warn' | 'bad';
}

/**
 * 记录状态（由 deriveStatus 实时重算，不持久化）：
 * awaiting-license 缺授权，停在待补
 * conflict          离线补丁与同事版本冲突，挡住发布
 * stale             审批绑定的内容/授权/版本已变，旧审批失效
 */
export type RecordStatus =
  | 'awaiting-license'
  | 'draft'
  | 'awaiting-approval'
  | 'rejected'
  | 'stale'
  | 'approved'
  | 'candidate-invalid'
  | 'confirmed'
  | 'conflict'
  | 'published';

export type InvalidReason =
  | 'content-changed'
  | 'license-changed'
  | 'license-expired'
  | 'license-not-yet-valid'
  | 'version-changed'
  | 'rejected'
  | 'pending';

export interface PairingRecord {
  id: number;
  title: string;
  schemaVersion: number;

  // —— 草稿区（可反复编辑，revision 单调递增）——
  draftRevision: number;
  draft: PairingContent;
  draftLicense: License | null;

  // —— 审批 / 候选 / 发布（均为对“某次草稿状态”的引用）——
  approval: Approval | null;
  confirmedSnapshotKey: string | null;
  candidate: PublishCandidate | null;
  releases: Release[];

  // —— 离线与冲突 ——
  offline: OfflineSession | null;
  conflicts: FieldConflict[];

  /** 幂等键 -> 快照/发布记录，保证重试不重复生成 */
  idem: Record<string, string>;

  activity: ActivityEntry[];
  createdAt: number;
  updatedAt: number;
}

/** 持久化根状态；snapshots 与草稿分区独立存放 */
export interface WorkbenchState {
  /** 工作台存储结构版本；旧版（只有草稿）= 1 */
  storageVersion: number;
  records: Record<number, PairingRecord>;
  /** 确认快照独立桶，草稿被覆盖也不影响已确认版本 */
  snapshots: Record<string, ConfirmedSnapshot>;
}

export interface DerivedStatus {
  status: RecordStatus;
  approvalReason?: InvalidReason;
  candidateReason?: InvalidReason;
  approvalValid: boolean;
  candidateValid: boolean;
}

export const STORAGE_VERSION = 2;
export const RECORD_SCHEMA_VERSION = 2;
