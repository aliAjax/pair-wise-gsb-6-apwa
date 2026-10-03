import {useState, type ReactNode} from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  CloudOff,
  DatabaseBackup,
  FileLock2,
  Files,
  GitMerge,
  History,
  Layers,
  LockKeyhole,
  MonitorSmartphone,
  Plus,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Sparkles,
  Type as TypeIcon,
  UploadCloud,
  Users,
  XCircle,
} from 'lucide-react';
import {REASON_TEXT, STATUS_TEXT, TIERS, useWorkbench} from './useWorkbench';
import {
  armWriteFault,
  corruptRoot,
  installLegacyDraft,
  seedDemoIfEmpty,
  simulateConcurrentConfirm,
  simulateIdempotentRetry,
  simulateOfflineConflict,
} from './demo';
import {License, MergeKey, PairingRecord} from './core/types';

const DAY_MS = 86400_000;
const FONTS = ['Fraunces', 'DM Sans', 'Space Grotesk', 'Newsreader', 'IBM Plex Sans', 'Playfair Display'];

const toDateInput = (t: number) => {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const fromDateInput = (s: string, end = false) => {
  const t = new Date(s + (end ? 'T23:59:59' : 'T00:00:00')).getTime();
  return Number.isNaN(t) ? Date.now() : t;
};

export default function App() {
  seedDemoIfEmpty();
  const wb = useWorkbench();
  const {state, statusOf, licenseOf, snapshotOf, actions, now, toasts, travel} = wb;
  const records = Object.values(state.records).sort((a, b) => a.id - b.id);
  const [selectedId, setSelectedId] = useState<number | null>(records[0]?.id ?? null);
  const [showScenarios, setShowScenarios] = useState(false);
  const [scenarioResult, setScenarioResult] = useState<string | null>(null);
  const selected = records.find((r) => r.id === selectedId) ?? records[0] ?? null;

  const reload = () => window.location.reload();

  return (
    <div className="wb">
      <header className="wb-top">
        <div className="wb-brand">
          <span className="wb-logo"><TypeIcon size={16} /></span>
          <div>
            <b>字体搭配 · 发布工作台</b>
            <small>草稿 / 确认快照分离 · 基准核对 · 授权与版本门禁</small>
          </div>
        </div>
        <div className="wb-clock">
          <Clock3 size={14} />
          <span>工作台时钟 {new Date(now).toLocaleString('zh-CN', {hour12: false})}</span>
          <button onClick={() => travel(7)}>快进 7 天</button>
          <button onClick={() => travel(45)}>快进 45 天</button>
          <button onClick={() => travel(-7)}>回拨 7 天</button>
          <button className="ghost" onClick={() => setShowScenarios(true)} title="一致性演练">
            <Sparkles size={14} /> 场景演练
          </button>
        </div>
      </header>

      <div className="wb-body">
        <aside className="wb-list">
          <button
            className="wb-new"
            onClick={() => {
              const id = Date.now();
              const title = `新建搭配 ${records.length + 1}`;
              actions.create(title, id);
              setSelectedId(id);
            }}
          >
            <Plus size={15} /> 新建草稿（默认缺授权）
          </button>
          <div className="wb-list-items">
            {records.map((r) => {
              const st = statusOf(r);
              const meta = STATUS_TEXT[st.status] ?? {label: st.status, tone: 'muted'};
              return (
                <button
                  key={r.id}
                  className={`wb-item ${selected?.id === r.id ? 'on' : ''}`}
                  onClick={() => setSelectedId(r.id)}
                >
                  <div className="wb-item-top">
                    <span className={`pill ${meta.tone}`}>{meta.label}</span>
                    <small>v{r.schemaVersion} · rev {r.draftRevision}</small>
                  </div>
                  <strong>{r.title}</strong>
                  <small className="wb-item-sub">
                    {r.draftLicense ? `${r.draftLicense.holder} · ${r.draftLicense.tier}` : '无授权'}
                    {r.offline ? ` · ${r.offline.member}离线中` : ''}
                    {r.conflicts.length > 0 ? ` · ${r.conflicts.length} 冲突` : ''}
                  </small>
                </button>
              );
            })}
            {records.length === 0 && <p className="wb-empty">暂无记录，点击上方新建</p>}
          </div>
        </aside>

        <main className="wb-main">{selected ? <Detail key={selected.id} r={selected} /> : <EmptyHint />}</main>
      </div>

      <div className="wb-toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.tone === 'good' ? <CheckCircle2 size={15} /> : t.tone === 'bad' ? <XCircle size={15} /> : <AlertTriangle size={15} />}
            {t.text}
          </div>
        ))}
      </div>

      {showScenarios && (
        <Scenarios
          onClose={() => setShowScenarios(false)}
          onResult={(msg) => setScenarioResult(msg)}
          result={scenarioResult}
          reload={reload}
        />
      )}
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="empty-hint">
      <Layers size={28} />
      <p>选择左侧记录，或新建一份草稿。</p>
    </div>
  );
}

// ---------- 记录详情 ----------

function Detail({r}: {r: PairingRecord}) {
  const wb = useWorkbench();
  const {actions, statusOf, licenseOf, snapshotOf, state, now} = wb;
  const st = statusOf(r);
  const meta = STATUS_TEXT[st.status];
  const ls = licenseOf(r.draftLicense);
  const snap = snapshotOf(r.confirmedSnapshotKey);
  const candidateSnap = r.candidate ? state.snapshots[r.candidate.snapshotKey] : null;

  return (
    <div className="detail">
      <div className="detail-head">
        <div>
          <h2>{r.title}</h2>
          <div className="detail-meta">
            <span className={`pill ${meta.tone}`}>{meta.label}</span>
            <span>结构 v{r.schemaVersion}</span>
            <span>草稿修订 rev {r.draftRevision}</span>
            <span>记录 ID {r.id}</span>
          </div>
          {(st.approvalReason || st.candidateReason) && (
            <div className="invalid-banner">
              <AlertTriangle size={14} />
              {st.approvalReason ? `审批失效：${REASON_TEXT[st.approvalReason]}` : null}
              {st.approvalReason && st.candidateReason ? '；' : ''}
              {st.candidateReason ? `候选失效：${REASON_TEXT[st.candidateReason]}` : null}
            </div>
          )}
        </div>
        <button className="btn ghost" onClick={() => actions.upgradeVersion(r.id)}>
          <RefreshCw size={14} /> 换版（结构升级）
        </button>
      </div>

      <div className="detail-grid">
        <section className="card">
          <CardTitle icon={<Files size={15} />} title="草稿区（可反复编辑）" hint="改动会抬高 rev，并使旧审批基准失效" />
          <DraftEditor r={r} />
        </section>

        <section className="card">
          <CardTitle
            icon={<FileLock2 size={15} />}
            title="授权信息"
            hint={
              ls === 'missing'
                ? '缺授权：停在待补'
                : ls === 'expired'
                  ? '已到期'
                  : ls === 'future'
                    ? '尚未生效'
                    : '有效期内'
            }
          />
          <LicenseEditor r={r} />
        </section>

        <section className="card span2">
          <CardTitle icon={<GitMerge size={15} />} title="离线补丁与三路合并" hint="回连先核对基准修订号；冲突字段保留双方值并挡住发布" />
          <OfflinePanel r={r} />
        </section>

        {r.conflicts.length > 0 && (
          <section className="card span2 danger">
            <CardTitle icon={<AlertTriangle size={15} />} title={`冲突清单（${r.conflicts.length}）—— 发布已被挡住`} hint="双方值都已保留，逐字段选择保留哪一方" />
            <ConflictList r={r} />
          </section>
        )}

        <section className="card span2">
          <CardTitle icon={<ShieldCheck size={15} />} title="审批 → 确认快照 → 发布" hint="审批绑定内容指纹/授权指纹/版本/有效期；确认快照独立不可变" />
          <Pipeline r={r} />
        </section>

        <section className="card">
          <CardTitle icon={<LockKeyhole size={15} />} title="确认快照（独立桶）" hint="草稿被覆盖也不影响已确认版本" />
          {candidateSnap || snap ? (
            <SnapshotView snap={(candidateSnap ?? snap)!} current={r} />
          ) : (
            <p className="muted">尚无确认快照。审批通过后点“确认快照”。</p>
          )}
        </section>

        <section className="card">
          <CardTitle icon={<History size={15} />} title={`发布记录（${r.releases.length}）`} hint="幂等发布，重试不会重复生成" />
          {r.releases.length === 0 ? (
            <p className="muted">尚未发布。</p>
          ) : (
            <ul className="releases">
              {r.releases.map((rel) => (
                <li key={rel.id}>
                  <Rocket size={13} />
                  <div>
                    <b>{rel.snapshotKey}</b>
                    <small>
                      {new Date(rel.publishedAt).toLocaleString('zh-CN', {hour12: false})} · {rel.publishedBy} ·
                      结构 v{rel.schemaVersion}
                    </small>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card span2">
          <CardTitle icon={<History size={15} />} title="活动流水" hint="基准变化、授权变更、冲突挡发均有审计记录" />
          <ul className="activity">
            {r.activity.map((a) => (
              <li key={a.id} className={a.tone}>
                <span className="dot" />
                <small>{new Date(a.at).toLocaleString('zh-CN', {hour12: false})}</small>
                <span>{a.message}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function CardTitle({icon, title, hint}: {icon: ReactNode; title: string; hint?: string}) {
  return (
    <div className="card-title">
      <span className="card-icon">{icon}</span>
      <div>
        <h3>{title}</h3>
        {hint && <small>{hint}</small>}
      </div>
    </div>
  );
}

function DraftEditor({r}: {r: PairingRecord}) {
  const {actions} = useWorkbench();
  const d = r.draft;
  const disabled = !!r.offline;
  return (
    <div className="draft-editor">
      <label>
        分类
        <input disabled={disabled} value={d.category} onChange={(e) => actions.edit(r.id, 'category', e.target.value)} />
      </label>
      <label>
        标题字体
        <select disabled={disabled} value={d.headingFont} onChange={(e) => actions.edit(r.id, 'headingFont', e.target.value)}>
          {FONTS.map((f) => <option key={f}>{f}</option>)}
        </select>
      </label>
      <label>
        正文字体
        <select disabled={disabled} value={d.bodyFont} onChange={(e) => actions.edit(r.id, 'bodyFont', e.target.value)}>
          {FONTS.map((f) => <option key={f}>{f}</option>)}
        </select>
      </label>
      <Range label="字号" unit="px" min={28} max={76} value={d.size} disabled={disabled} onChange={(v) => actions.edit(r.id, 'size', v)} />
      <Range label="字重" min={300} max={800} step={100} value={d.weight} disabled={disabled} onChange={(v) => actions.edit(r.id, 'weight', v)} />
      <Range label="行高" min={1} max={1.8} step={0.05} fixed={2} value={d.lineHeight} disabled={disabled} onChange={(v) => actions.edit(r.id, 'lineHeight', v)} />
      <label className="span2">
        标题文案
        <input disabled={disabled} value={d.headingText} onChange={(e) => actions.edit(r.id, 'headingText', e.target.value)} />
      </label>
      <label className="span2">
        正文文案
        <textarea disabled={disabled} rows={2} value={d.bodyText} onChange={(e) => actions.edit(r.id, 'bodyText', e.target.value)} />
      </label>
      {disabled && <p className="warn-text">离线会话进行中：草稿锁定，改动请在离线面板做成补丁。</p>}
    </div>
  );
}

function Range(props: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string;
  fixed?: number; disabled?: boolean; onChange: (v: number) => void;
}) {
  return (
    <label className="range">
      {props.label} <b>{props.value.toFixed(props.fixed ?? 0)}{props.unit ?? ''}</b>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

function LicenseEditor({r}: {r: PairingRecord}) {
  const {actions} = useWorkbench();
  const l = r.draftLicense;
  const [draft, setDraft] = useState<License>(
    l ?? {
      holder: '',
      tier: 'web',
      validFrom: Date.now() - DAY_MS,
      validUntil: Date.now() + 30 * DAY_MS,
    },
  );
  // 记录切换或外部授权变更时同步表单
  const syncKey = `${r.id}:${l?.holder}:${l?.validUntil}`;
  const [lastKey, setLastKey] = useState(syncKey);
  if (syncKey !== lastKey) {
    setLastKey(syncKey);
    if (l) setDraft(l);
  }

  return (
    <div className="license-editor">
      <label>
        授权方
        <input value={draft.holder} placeholder="如：Acme 字库" onChange={(e) => setDraft({...draft, holder: e.target.value})} />
      </label>
      <label>
        档位
        <select value={draft.tier} onChange={(e) => setDraft({...draft, tier: e.target.value as License['tier']})}>
          {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      <label>
        生效日
        <input type="date" value={toDateInput(draft.validFrom)} onChange={(e) => setDraft({...draft, validFrom: fromDateInput(e.target.value)})} />
      </label>
      <label>
        到期日
        <input type="date" value={toDateInput(draft.validUntil)} onChange={(e) => setDraft({...draft, validUntil: fromDateInput(e.target.value, true)})} />
      </label>
      <div className="span2 btn-row">
        <button className="btn primary" disabled={!draft.holder.trim()} onClick={() => actions.saveLicense(r.id, {...draft, holder: draft.holder.trim()})}>
          保存授权（更换后审批/候选失效重算）
        </button>
        {l && <button className="btn ghost danger-text" onClick={() => actions.saveLicense(r.id, null)}>移除授权</button>}
      </div>
    </div>
  );
}

function OfflinePanel({r}: {r: PairingRecord}) {
  const {actions} = useWorkbench();
  const off = r.offline;
  const [member, setMember] = useState('Yuki');
  const [offSize, setOffSize] = useState(66);
  const [remoteSize, setRemoteSize] = useState(38);
  const [remoteMember, setRemoteMember] = useState('Lin');

  if (!off) {
    return (
      <div className="offline-row">
        <input value={member} onChange={(e) => setMember(e.target.value)} placeholder="离线成员" />
        <button className="btn" onClick={() => actions.goOffline(r.id, member || '成员')}>
          <CloudOff size={14} /> 开始离线编辑（冻结基准 rev {r.draftRevision}）
        </button>
        <p className="muted span2">离线期间：草稿锁定；补丁基于离开时的基准累积，回连时再与同事版本逐字段核对。</p>
      </div>
    );
  }

  const patchFields = Object.keys(off.contentPatch);
  return (
    <div className="offline-live">
      <div className="offline-banner">
        <CloudOff size={15} />
        <b>{off.member} 离线中</b>
        <span>基准 rev {off.baseRevision}（当前线上 rev {r.draftRevision}）</span>
        {off.baseRevision < r.draftRevision && <span className="pill warn">基准已落后</span>}
      </div>
      <div className="offline-cols">
        <div>
          <h4>离线补丁（本地）</h4>
          <label>
            把字号改成
            <input type="number" value={offSize} onChange={(e) => setOffSize(Number(e.target.value))} />
          </label>
          <button className="btn" onClick={() => actions.offlineEdit(r.id, 'size', offSize)}>
            离线改字号 → {offSize}px
          </button>
          <button
            className="btn"
            onClick={() =>
              actions.offlineLicense(r.id, {
                holder: '离线换的字库',
                tier: 'extended',
                validFrom: Date.now() - DAY_MS,
                validUntil: Date.now() + 60 * DAY_MS,
              })
            }
          >
            离线更换授权
          </button>
          <small className="muted">补丁字段：{patchFields.length ? patchFields.join('、') : '无'}</small>
        </div>
        <div>
          <h4>模拟同事在线改动</h4>
          <label>
            同事
            <input value={remoteMember} onChange={(e) => setRemoteMember(e.target.value)} />
          </label>
          <label>
            把字号改成
            <input type="number" value={remoteSize} onChange={(e) => setRemoteSize(Number(e.target.value))} />
          </label>
          <button className="btn" onClick={() => actions.remoteEdit(r.id, 'size', remoteSize, remoteMember || '同事')}>
            <Users size={14} /> 同事在线改字号 → {remoteSize}px
          </button>
          <button
            className="btn"
            onClick={() =>
              actions.remoteEdit(r.id, 'weight', 700, remoteMember || '同事')
            }
          >
            同事只改字重（不冲突，可干净合并）
          </button>
        </div>
      </div>
      <button className="btn primary" onClick={() => actions.reconnect(r.id)}>
        <UploadCloud size={14} /> 回连：核对基准并三路合并
      </button>
    </div>
  );
}

function ConflictList({r}: {r: PairingRecord}) {
  const {actions} = useWorkbench();
  return (
    <div className="conflicts">
      {r.conflicts.map((c) => (
        <div key={c.field} className="conflict-row">
          <code>{c.field}</code>
          <span className="val base">基准：{displayVal(c.field, c.base)}</span>
          <span className="val local">离线：{displayVal(c.field, c.local)}</span>
          <span className="val remote">同事：{displayVal(c.field, c.remote)}</span>
          <div className="btn-row">
            <button className="btn" onClick={() => actions.resolve(r.id, c.field as MergeKey, 'local')}>保留离线值</button>
            <button className="btn" onClick={() => actions.resolve(r.id, c.field as MergeKey, 'remote')}>保留同事值</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function displayVal(field: string, v: unknown): string {
  if (field === 'license' && v && typeof v === 'object') {
    const l = v as License;
    return `${l.holder}/${l.tier} 至 ${toDateInput(l.validUntil)}`;
  }
  return String(v);
}

function Pipeline({r}: {r: PairingRecord}) {
  const {actions, statusOf} = useWorkbench();
  const st = statusOf(r);
  const a = r.approval;
  const blocked = r.conflicts.length > 0;
  return (
    <div className="pipeline">
      <Step n={1} title="补授权" state={r.draftLicense ? 'done' : 'todo'} />
      <Arrow />
      <Step
        n={2}
        title="提交审批"
        state={a ? (a.state === 'rejected' ? 'fail' : 'done') : 'todo'}
        note={a ? `状态：${a.state}` : undefined}
      />
      <Arrow />
      <Step
        n={3}
        title="主管审批"
        state={
          !a
            ? 'todo'
            : a.state === 'approved'
              ? st.approvalValid
                ? 'done'
                : 'fail'
              : a.state === 'rejected'
                ? 'fail'
                : 'wait'
        }
        note={
          a?.state === 'approved' && !st.approvalValid && st.approvalReason
            ? REASON_TEXT[st.approvalReason]
            : a?.approver
        }
      />
      <Arrow />
      <Step
        n={4}
        title="确认快照"
        state={
          r.candidate
            ? st.candidateValid
              ? 'done'
              : 'fail'
            : r.confirmedSnapshotKey
              ? 'done'
              : 'todo'
        }
        note={
          r.candidate && !st.candidateValid && st.candidateReason
            ? REASON_TEXT[st.candidateReason]
            : r.confirmedSnapshotKey ?? undefined
        }
      />
      <Arrow />
      <Step n={5} title="发布" state={r.releases.length > 0 ? 'done' : r.candidate && st.candidateValid ? 'wait' : 'todo'} />
      <div className="pipeline-actions">
        <button className="btn" disabled={!!a?.state || blocked} onClick={() => actions.submit(r.id)}>
          提交审批
        </button>
        <button className="btn good" disabled={a?.state !== 'pending'} onClick={() => actions.approve(r.id, true)}>
          批准
        </button>
        <button className="btn danger-text" disabled={a?.state !== 'pending'} onClick={() => actions.approve(r.id, false)}>
          驳回
        </button>
        <button className="btn primary" disabled={blocked} onClick={() => actions.confirm(r.id)}>
          确认快照（幂等重试）
        </button>
        <button className="btn primary" disabled={blocked || !r.candidate} onClick={() => actions.publish(r.id)}>
          <Rocket size={14} /> 发布（幂等重试）
        </button>
        {blocked && <span className="warn-text">冲突未解决，确认/发布按钮被挡住</span>}
      </div>
    </div>
  );
}

function Step({n, title, state, note}: {n: number; title: string; state: 'todo' | 'wait' | 'done' | 'fail'; note?: string}) {
  return (
    <div className={`step ${state}`}>
      <span className="step-n">{n}</span>
      <div>
        <b>{title}</b>
        {note && <small>{note}</small>}
      </div>
    </div>
  );
}
function Arrow() {
  return <span className="arrow">→</span>;
}

function SnapshotView({snap, current}: {snap: NonNullable<ReturnType<ReturnType<typeof useWorkbench>['snapshotOf']>>; current: PairingRecord}) {
  const drift = snap.content.size !== current.draft.size || snap.revision !== current.draftRevision;
  return (
    <div className="snapshot">
      <div className="snap-key"><code>{snap.key}</code>{drift && <span className="pill warn">草稿已漂移，快照不受影响</span>}</div>
      <ul>
        <li>结构版本 v{snap.schemaVersion} · rev {snap.revision}</li>
        <li>{snap.content.headingFont} / {snap.content.bodyFont} · {snap.content.size}px/{snap.content.weight}</li>
        <li>授权：{snap.license ? `${snap.license.holder} · ${snap.license.tier}` : '无'}</li>
        <li>{snap.license ? `有效期至 ${toDateInput(snap.license.validUntil)}` : ''}</li>
        <li>确认人 {snap.confirmedBy} · {new Date(snap.confirmedAt).toLocaleString('zh-CN', {hour12: false})}</li>
        <li className="muted">幂等键 {snap.idempotencyKey}</li>
      </ul>
    </div>
  );
}

// ---------- 场景演练弹窗 ----------

function Scenarios({onClose, onResult, result, reload}: {
  onClose: () => void;
  onResult: (msg: string) => void;
  result: string | null;
  reload: () => void;
}) {
  const runConcurrent = () => {
    const r = simulateConcurrentConfirm();
    onResult(
      `双窗口同时确认 → 窗口${r.winner}先到生效；snapshots 桶中快照数 = ${r.snapshotCount}（应为 1）` +
        `${r.aError ? `；A 返回：${r.aError}` : ''}${r.bError ? `；B 返回：${r.bError}` : ''}`,
    );
  };
  const runIdem = () => {
    const r = simulateIdempotentRetry();
    onResult(`同幂等键重试第二次 reused=${r.reused}；快照数 = ${r.snapshotCount}（应为 1），未重复生成记录。`);
  };
  const runConflict = () => {
    const r = simulateOfflineConflict();
    onResult(
      `离线回连冲突字段「${r.conflictField}」：离线=${r.local}px / 同事=${r.remote}px，双方值保留；提交审批被挡 = ${r.publishBlocked}。`,
    );
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2><MonitorSmartphone size={18} /> 一致性场景演练</h2>
          <button className="ghost btn" onClick={onClose}>关闭</button>
        </div>
        <div className="scenario-grid">
          <Scenario
            icon={<MonitorSmartphone size={16} />}
            title="两个窗口同时确认"
            desc="两个 Store 共享同一份存储，同时提交确认；先到版本生效，后到窗口拿到同一条快照，不重复生成。"
            actionLabel="模拟双确认"
            onClick={runConcurrent}
          />
          <Scenario
            icon={<RefreshCw size={16} />}
            title="重试不重复生成"
            desc="网络抖动后同一幂等键重试确认，第二次直接复用快照；发布同理。"
            actionLabel="模拟幂等重试"
            onClick={runIdem}
          />
          <Scenario
            icon={<GitMerge size={16} />}
            title="离线补丁冲突挡发"
            desc="离线改字号期间同事也改字号，回连核对基准后逐字段三路合并，冲突保留双方值并挡住发布。"
            actionLabel="模拟离线冲突"
            onClick={runConflict}
          />
          <Scenario
            icon={<DatabaseBackup size={16} />}
            title="写入失败 → 完整快照恢复"
            desc="把根数据破坏成“半写入”状态（写前完整备份完好），刷新后工作台自动从备份恢复。"
            actionLabel="破坏根数据并刷新"
            onClick={() => {
              armWriteFault();
              reload();
            }}
          />
          <Scenario
            icon={<DatabaseBackup size={16} />}
            title="启动时检测损坏并恢复"
            desc="直接写入无法解析的根数据，下次加载走备份恢复路径。"
            actionLabel="注入损坏数据并刷新"
            onClick={() => {
              corruptRoot();
              reload();
            }}
          />
          <Scenario
            icon={<Files size={16} />}
            title="旧草稿升级（只有草稿）"
            desc="写入 storageVersion=1 的旧 type-pairs 草稿（无授权），刷新后自动迁移成带授权槽位的记录，缺授权停在待补。"
            actionLabel="安装旧草稿并刷新"
            onClick={() => {
              installLegacyDraft();
              reload();
            }}
          />
        </div>
        {result && (
          <div className="scenario-result">
            <CheckCircle2 size={15} /> {result}
          </div>
        )}
      </div>
    </div>
  );
}

function Scenario({icon, title, desc, actionLabel, onClick}: {
  icon: ReactNode; title: string; desc: string; actionLabel: string; onClick: () => void;
}) {
  return (
    <div className="scenario">
      <div className="scenario-icon">{icon}</div>
      <h4>{title}</h4>
      <p>{desc}</p>
      <button className="btn primary" onClick={onClick}>{actionLabel}</button>
    </div>
  );
}
