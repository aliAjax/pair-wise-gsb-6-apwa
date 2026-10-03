import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  BadgeCheck,
  Ban,
  Clock3,
  CloudOff,
  FileClock,
  FileLock2,
  Gavel,
  History,
  KeyRound,
  Layers,
  Radio,
  RefreshCcw,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  Split,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  advanceTime,
  bumpAssetVersion,
  confirmSnapshot,
  daysLeft,
  decideApproval,
  editDraft,
  fieldLabel,
  fieldsHash,
  fmtTime,
  fmtValue,
  FONT_CHOICES,
  IDEMPOTENCY_KEY,
  loadState,
  makeOfflinePatch,
  persistWithRecovery,
  publishSnapshot,
  reconnectPatch,
  requestApproval,
  resolveConflict,
  setLicense,
  STORAGE_KEY,
  RECOVERY_KEY,
} from './engine';
import {
  AuditType,
  License,
  OfflinePatch,
  PairingFields,
  PairingRecord,
  PairingStatus,
  STATUS_LABEL,
  WorkbenchState,
} from './types';

// ---------- 存储适配 ----------

const lsSave = (k: string) => (raw: string) => localStorage.setItem(k, raw);
const lsLoad = (k: string) => () => localStorage.getItem(k);
const lsClear = (k: string) => () => localStorage.removeItem(k);

const AUDIT_LABEL: Record<AuditType, string> = {
  'draft-edited': '在线编辑草稿',
  'offline-edited': '离线修改（已暂存补丁）',
  'patch-merged': '离线补丁合并',
  'patch-conflict': '合并冲突（挡住发布）',
  'conflict-resolved': '冲突裁决',
  'license-set': '登记/更换授权',
  'approval-requested': '提交审批',
  'approval-decided': '审批裁决',
  'approval-invalidated': '审批失效',
  'candidate-invalidated': '候选失效',
  'candidate-rebuilt': '候选重算',
  confirmed: '确认生效（快照留档）',
  'confirm-deduped': '确认重试命中幂等',
  'confirm-lost-race': '确认输掉竞争',
  published: '发布成功',
  'publish-deduped': '发布重试命中幂等',
  'version-bumped': '全局换版',
  restored: '从完整快照恢复',
  'write-failed': '写入失败',
  'legacy-upgraded': '旧数据升级/初始化',
};

const STATUS_STYLE: Record<PairingStatus, string> = {
  draft: 'st-draft',
  'awaiting-license': 'st-license',
  'awaiting-approval': 'st-approval',
  ready: 'st-ready',
  conflict: 'st-conflict',
  confirmed: 'st-confirmed',
  published: 'st-published',
};

function loadIdem(): Record<string, {ok: boolean; recordId: string; result: 'confirmed' | 'published'}> {
  try {
    return JSON.parse(localStorage.getItem(IDEMPOTENCY_KEY) || '{}');
  } catch {
    return {};
  }
}

export function Workbench() {
  const [state, setState] = useState<WorkbenchState>(() =>
    loadState(lsLoad(STORAGE_KEY), Date.now(), lsLoad('type-pairs')),
  );
  const [idem, setIdem] = useState(loadIdem);
  const [selectedId, setSelectedId] = useState<string>(() => state.records[0]?.id ?? '');
  const [toast, setToast] = useState<{kind: 'ok' | 'err' | 'info'; text: string} | null>(null);
  const [failNextWrite, setFailNextWrite] = useState(false);
  const [offline, setOffline] = useState(false);
  const idemRef = useRef(idem);
  idemRef.current = idem;

  const selected = state.records.find((r) => r.id === selectedId) ?? state.records[0];

  // 持久化（写前先落恢复区完整快照）
  const persist = useCallback(
    (next: WorkbenchState) => {
      const {state: persisted, restored} = persistWithRecovery(
        next,
        lsSave(STORAGE_KEY),
        lsLoad(STORAGE_KEY),
        lsSave(RECOVERY_KEY),
        lsLoad(RECOVERY_KEY),
        lsClear(RECOVERY_KEY),
        failNextWrite,
      );
      if (failNextWrite) {
        setFailNextWrite(false);
        if (restored) notify('err', '主存储写入失败：已从恢复区完整快照恢复');
      }
      setState(persisted);
    },
    [failNextWrite],
  );

  useEffect(() => {
    localStorage.setItem(IDEMPOTENCY_KEY, JSON.stringify(idem));
  }, [idem]);

  const notify = (kind: 'ok' | 'err' | 'info', text: string) => {
    setToast({kind, text});
    window.setTimeout(() => setToast(null), 3600);
  };

  const apply = useCallback(
    (res: {ok: boolean; state: WorkbenchState; error?: string; deduped?: boolean}, okText?: string) => {
      persist(res.state);
      if (res.ok) notify('ok', okText ?? '操作完成');
      else if (res.error === 'merge-conflict')
        notify('err', '回连冲突：冲突字段已保留双方值，裁决前挡住发布');
      else notify('err', res.error ?? '操作失败');
    },
    [persist],
  );

  // —— 草稿编辑 ——
  const editField = (k: keyof PairingFields, value: string | number) => {
    const v = typeof value === 'string' && k !== 'headingFont' && k !== 'bodyFont' ? Number(value) : value;
    apply(editDraft(state, selected.id, {[k]: v}, '窗口 A'));
  };

  // —— 授权 ——
  const quickLicense = (days: number, seats = 5, version = state.assetVersion) => {
    const lic: License = {
      holder: selected.license?.holder || 'Yuki Lin',
      assetVersion: version,
      expiresAt: state.now + days * 86400_000,
      seats,
    };
    apply(setLicense(state, selected.id, lic, '窗口 A'), `已登记授权（${days} 天 / ${seats} 席 / v${version}）`);
  };

  // —— 审批 ——
  const askApproval = () => apply(requestApproval(state, selected.id, '窗口 A'), '已提交审批');
  const ruleApproval = (approved: boolean) =>
    apply(
      decideApproval(state, selected.id, approved, approved ? undefined : '排版节奏需再收紧', '品牌负责人'),
      approved ? '审批通过，发布候选已就绪' : '审批已驳回',
    );

  // —— 离线补丁模拟 ——
  const stageOfflineEdit = (fields?: Partial<PairingFields>, license?: License | null) => {
    if (!offline) setOffline(true);
    const {state: next, patch} = makeOfflinePatch(state, selected.id, '窗口 B（离线）', fields, license);
    persist(next);
    notify(
      'info',
      `窗口 B 已断连，离线补丁 ${patch.id.slice(-4)} 暂存（基准 rev ${patch.baseRevision}）`,
    );
  };

  const reconnect = (patch: OfflinePatch) => {
    const res = reconnectPatch(state, patch.id);
    setOffline(false);
    apply(res, `窗口 B 回连：补丁已合并（基准一致快进）`);
  };

  // —— 冲突裁决 ——
  const resolveSlot = (field: string, pick: 'local' | 'remote') =>
    apply(resolveConflict(state, selected.id, field, pick, '窗口 A'), `冲突字段 ${fieldLabel(field as never)} 已裁决`);

  // —— 确认：单窗口 / 重试幂等 / 两窗口同时 ——
  const doConfirm = (window: string, key: string) => {
    const res = confirmSnapshot(state, selected.id, window, key, idemRef.current);
    setIdem({...idemRef.current});
    apply(res, res.deduped ? '重试命中幂等：未重复生成快照' : `${window} 确认生效，快照已留档`);
  };

  const raceConfirm = () => {
    // “两个窗口同时确认”：同一份状态、同一个候选、不同幂等键，按 A→B 顺序裁决
    const keyA = `race-${selected.id}-${fieldsHash(selected.draft.fields)}-A`;
    const keyB = `race-${selected.id}-${fieldsHash(selected.draft.fields)}-B`;
    const a = confirmSnapshot(state, selected.id, '窗口 A', keyA, idemRef.current);
    let next = a.state;
    if (a.ok) {
      const b = confirmSnapshot(next, selected.id, '窗口 B', keyB, idemRef.current);
      next = b.state;
      notify(b.ok ? 'ok' : 'err', `两个窗口同时确认：A 先到生效，B ${b.ok ? '也成功（异常）' : `被拒：${b.error}`}`);
    } else {
      notify('err', `窗口 A 确认失败：${a.error}`);
    }
    setIdem({...idemRef.current});
    persist(next);
  };

  // —— 发布（可注入写入失败） ——
  const doPublish = (simulateFailure: boolean) => {
    const key = `publish-${selected.snapshot?.id ?? selected.id}`;
    const res = publishSnapshot(
      state,
      selected.id,
      '窗口 A',
      key,
      idemRef.current,
      !simulateFailure,
      lsSave(RECOVERY_KEY),
      lsLoad(RECOVERY_KEY),
      lsClear(RECOVERY_KEY),
    );
    setIdem({...idemRef.current});
    if (simulateFailure) {
      setState(res.state);
      notify('err', '写入失败：完整快照已落恢复区并完成恢复，本次发布未落库，可重试');
    } else {
      persist(res.state);
      if (res.ok) notify('ok', res.deduped ? '重试命中幂等：未重复发布' : '发布成功，终态锁定');
      else notify('err', res.error ?? '发布失败');
    }
  };

  const doBump = () => apply(bumpAssetVersion(state), '素材已换版：审批与发布候选全部失效重算');
  const doAdvance = (days: number) =>
    apply(advanceTime(state, days * 86400_000), `时钟推进 ${days} 天（模拟授权到期）`);

  const pendingPatches = state.offlinePatches.filter((p) => !p.applied);
  const remaining = selected ? daysLeft(selected.license, state.now) : null;

  const statusCounts = useMemo(() => {
    const c = {} as Record<PairingStatus, number>;
    state.records.forEach((r) => (c[r.status] = (c[r.status] ?? 0) + 1));
    return c;
  }, [state.records]);

  return (
    <div className="wb">
      {/* 顶栏 */}
      <header className="wb-top">
        <div className="wb-brand">
          <Layers size={17} />
          <div>
            <b>字体搭配 · 发布工作台</b>
            <small>草稿 / 确认快照分离 · 离线三方合并 · 授权与审批联动</small>
          </div>
        </div>
        <div className="wb-top-meta">
          <span className="chip">
            <Clock3 size={13} /> {fmtTime(state.now)}
          </span>
          <span className="chip">素材版本 v{state.assetVersion}</span>
          <span className={`chip ${offline ? 'chip-off' : 'chip-on'}`}>
            {offline ? <WifiOff size={13} /> : <Wifi size={13} />}
            {offline ? '窗口 B 离线中' : '全员在线'}
          </span>
          <button className="btn ghost" onClick={() => doAdvance(7)}>
            <Clock3 size={13} /> 快进 7 天
          </button>
          <button className="btn ghost warn" onClick={doBump}>
            <RefreshCcw size={13} /> 全局换版
          </button>
          <label className={`btn ghost ${failNextWrite ? 'danger-on' : ''}`} title="下一次写存储/发布会失败，用于演示恢复">
            <input
              type="checkbox"
              checked={failNextWrite}
              onChange={(e) => setFailNextWrite(e.target.checked)}
            />
            模拟下次写入失败
          </label>
        </div>
      </header>

      <div className="wb-body">
        {/* 左：记录队列 */}
        <aside className="wb-left">
          <div className="wb-counts">
            {(Object.keys(STATUS_LABEL) as PairingStatus[]).map((st) =>
              statusCounts[st] ? (
                <span key={st} className={`mini-st ${STATUS_STYLE[st]}`}>
                  {STATUS_LABEL[st]} {statusCounts[st]}
                </span>
              ) : null,
            )}
          </div>
          <div className="wb-list">
            {state.records.map((r) => (
              <button
                key={r.id}
                className={`wb-card ${selected?.id === r.id ? 'on' : ''} ${STATUS_STYLE[r.status]}`}
                onClick={() => setSelectedId(r.id)}
              >
                <div className="wb-card-top">
                  <span className={`st ${STATUS_STYLE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                  {r.conflicts.length > 0 && (
                    <span className="conflict-dot">
                      <AlertTriangle size={12} /> {r.conflicts.length}
                    </span>
                  )}
                </div>
                <b>{r.draft.title}</b>
                <small>
                  {r.draft.category} · 字号 {r.draft.fields.size} · rev {r.draft.baseRevision}
                </small>
                <div className="wb-card-sub">
                  {r.license ? (
                    <>
                      <FileLock2 size={11} /> {r.license.holder} · {daysLeft(r.license, state.now)} 天
                      {r.license.assetVersion !== state.assetVersion && <em className="ver-warn"> 版本不符</em>}
                    </>
                  ) : (
                    <>
                      <ShieldAlert size={11} /> 缺授权
                    </>
                  )}
                </div>
              </button>
            ))}
          </div>

          {/* 离线补丁队列 */}
          <div className="wb-patches">
            <div className="wb-section-title">
              <CloudOff size={13} /> 离线补丁队列（{pendingPatches.length}）
            </div>
            {pendingPatches.length === 0 && <p className="muted">暂无离线补丁。在详情面板让窗口 B 断连改字号/授权。</p>}
            {pendingPatches.map((p) => (
              <div key={p.id} className="patch-item">
                <div>
                  <b>{p.window}</b>
                  <small>
                    {state.records.find((r) => r.id === p.recordId)?.draft.title} · 基准 rev {p.baseRevision}
                  </small>
                  <small className="patch-diff">
                    {p.fields ? `字段: ${Object.keys(p.fields).join('/')}` : ''}
                    {p.license !== undefined ? `${p.fields ? ' · ' : ''}授权改动` : ''}
                  </small>
                </div>
                <button className="btn tiny" onClick={() => reconnect(p)}>
                  <Radio size={12} /> 回连核对
                </button>
              </div>
            ))}
          </div>
        </aside>

        {/* 中：详情 */}
        <main className="wb-main">
          {selected && (
            <RecordDetail
              rec={selected}
              assetVersion={state.assetVersion}
              now={state.now}
              daysLeft={remaining}
              offline={offline}
              onEdit={editField}
              onLicense={quickLicense}
              onAskApproval={askApproval}
              onRule={ruleApproval}
              onOffline={stageOfflineEdit}
              onResolve={resolveSlot}
              onConfirm={doConfirm}
              onRace={raceConfirm}
              onPublish={doPublish}
            />
          )}
        </main>

        {/* 右：审计流 */}
        <aside className="wb-right">
          <div className="wb-section-title">
            <History size={13} /> 操作审计（{state.audit.length}）
          </div>
          <div className="audit-list">
            {state.audit.slice(0, 60).map((e) => (
              <div key={e.id} className={`audit-item aud-${e.type}`}>
                <div className="audit-head">
                  <span>{AUDIT_LABEL[e.type]}</span>
                  <time>{fmtTime(e.time).slice(6)}</time>
                </div>
                {e.detail && <p>{e.detail}</p>}
                {e.window && <small>{e.window}</small>}
              </div>
            ))}
          </div>
        </aside>
      </div>

      {toast && (
        <div className={`toast toast-${toast.kind}`}>
          {toast.kind === 'err' ? <ShieldAlert size={15} /> : toast.kind === 'ok' ? <BadgeCheck size={15} /> : <CloudOff size={15} />}
          {toast.text}
        </div>
      )}
    </div>
  );
}

// ---------- 记录详情 ----------

function RecordDetail(props: {
  rec: PairingRecord;
  assetVersion: number;
  now: number;
  daysLeft: number | null;
  offline: boolean;
  onEdit: (k: keyof PairingFields, v: string | number) => void;
  onLicense: (days: number, seats?: number, version?: number) => void;
  onAskApproval: () => void;
  onRule: (approved: boolean) => void;
  onOffline: (fields?: Partial<PairingFields>, license?: License | null) => void;
  onResolve: (field: string, pick: 'local' | 'remote') => void;
  onConfirm: (window: string, key: string) => void;
  onRace: () => void;
  onPublish: (simulateFailure: boolean) => void;
}) {
  const {rec, assetVersion, now, daysLeft} = props;
  const hash = fieldsHash(rec.draft.fields);
  const approvalBadge = rec.approval
    ? {approved: '已通过', rejected: '已驳回', pending: '待裁决', expired: '已过期', superseded: '已作废'}[
        rec.approval.status
      ]
    : '无审批';

  return (
    <div className="detail">
      {/* 头部状态 */}
      <div className="detail-head">
        <div>
          <div className="crumb">发布队列 / {rec.draft.category}</div>
          <h2>{rec.draft.title}</h2>
          <p>{rec.statusDetail}</p>
        </div>
        <div className="head-badges">
          <span className={`st big ${STATUS_STYLE[rec.status]}`}>{STATUS_LABEL[rec.status]}</span>
          <span className={`kv-badge ${rec.approval?.status === 'approved' ? 'good' : rec.approval ? 'bad' : ''}`}>
            <Gavel size={13} /> 审批：{approvalBadge}
          </span>
          <span className="kv-badge">
            <Split size={13} /> 字段指纹 <code>{hash}</code>
          </span>
        </div>
      </div>

      {/* 冲突面板 */}
      {rec.conflicts.length > 0 && (
        <section className="panel panel-conflict">
          <h3>
            <AlertTriangle size={15} /> 离线补丁与同事版本冲突 · {rec.conflicts.length} 项待裁决（发布已挡住）
          </h3>
          <p className="muted">
            补丁基准 rev 落后，下列字段双方都改过且取值不同。双方值均已保留，逐字段选择后解除拦截。
          </p>
          <div className="conflict-table">
            <div className="ct-row ct-head">
              <span>字段</span>
              <span>基准 base</span>
              <span>离线值（窗口 B）</span>
              <span>同事值（在线）</span>
              <span>裁决</span>
            </div>
            {rec.conflicts.map((c) => (
              <div key={c.field} className="ct-row">
                <span className="ct-field">{fieldLabel(c.field as never)}</span>
                <span className="ct-base">{fmtValue(c.base)}</span>
                <span className="ct-local">{fmtValue(c.local)}</span>
                <span className="ct-remote">{fmtValue(c.remote)}</span>
                <span className="ct-actions">
                  <button className="btn tiny" onClick={() => props.onResolve(c.field, 'local')}>
                    取离线
                  </button>
                  <button className="btn tiny" onClick={() => props.onResolve(c.field, 'remote')}>
                    取同事
                  </button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="detail-grid">
        {/* 草稿区 */}
        <section className="panel">
          <h3>
            <FileClock size={15} /> 草稿（可继续编辑）
            <em className="panel-tag">rev {rec.draft.baseRevision}</em>
          </h3>
          <div className="field-grid">
            <label>
              标题字体
              <select value={rec.draft.fields.headingFont} onChange={(e) => props.onEdit('headingFont', e.target.value)}>
                {FONT_CHOICES.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </label>
            <label>
              正文字体
              <select value={rec.draft.fields.bodyFont} onChange={(e) => props.onEdit('bodyFont', e.target.value)}>
                {FONT_CHOICES.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </label>
            <RangeField label="字号" k="size" value={rec.draft.fields.size} min={28} max={76} unit="px" onEdit={props.onEdit} />
            <RangeField label="字重" k="weight" value={rec.draft.fields.weight} min={300} max={800} step={100} onEdit={props.onEdit} />
            <RangeField label="行高" k="leading" value={rec.draft.fields.leading} min={1} max={1.8} step={0.05} digits={2} onEdit={props.onEdit} />
            <RangeField label="字间距" k="tracking" value={rec.draft.fields.tracking} min={-1} max={3} step={0.5} unit="px" digits={1} onEdit={props.onEdit} />
          </div>

          <div className="preview-box">
            <span className="preview-kicker">PREVIEW · 草稿实时预览</span>
            <h4
              style={{
                fontFamily: rec.draft.fields.headingFont,
                fontSize: Math.min(rec.draft.fields.size, 44),
                fontWeight: rec.draft.fields.weight,
                lineHeight: 1.1,
                letterSpacing: rec.draft.fields.tracking,
              }}
            >
              A slower way to see
            </h4>
            <p style={{fontFamily: rec.draft.fields.bodyFont, lineHeight: rec.draft.fields.leading}}>
              Good typography creates space for ideas to breathe.
            </p>
          </div>
        </section>

        {/* 授权 + 审批区 */}
        <section className="panel">
          <h3>
            <FileLock2 size={15} /> 授权与审批
          </h3>
          <div className={`license-box ${!rec.license ? 'missing' : rec.license.assetVersion !== assetVersion || (daysLeft ?? 0) <= 0 ? 'invalid' : ''}`}>
            {rec.license ? (
              <>
                <div className="lic-row"><span>授权主体</span><b>{rec.license.holder}</b></div>
                <div className="lic-row">
                  <span>状态</span>
                  <b>
                    {rec.license.assetVersion !== assetVersion
                      ? '版本不符（需重新授权）'
                      : daysLeft! <= 0
                      ? '已到期'
                      : `有效 · 剩余 ${daysLeft} 天`}
                  </b>
                </div>
                <div className="lic-row"><span>覆盖版本</span><b>v{rec.license.assetVersion}（当前素材 v{assetVersion}）</b></div>
                <div className="lic-row"><span>到期时间</span><b>{fmtTime(rec.license.expiresAt)}</b></div>
                <div className="lic-row"><span>席位数</span><b>{rec.license.seats}</b></div>
              </>
            ) : (
              <div className="lic-missing">
                <ShieldAlert size={20} />
                <b>缺少授权信息</b>
                <span>旧草稿升级后无授权，流程停在“待补授权”，不能送审/确认。</span>
              </div>
            )}
          </div>
          <div className="btn-row wrap">
            <button className="btn tiny" onClick={() => props.onLicense(30, 5)}>
              <KeyRound size={12} /> 补/换 30 天 · 5 席（v{assetVersion}）
            </button>
            <button className="btn tiny" onClick={() => props.onLicense(2, 2)}>
              <Clock3 size={12} /> 给 2 天短期授权
            </button>
            <button className="btn tiny" onClick={() => props.onLicense(30, 5, Math.max(1, assetVersion - 1))}>
              <ShieldAlert size={12} /> 登记旧版 v{Math.max(1, assetVersion - 1)} 授权
            </button>
          </div>

          <hr />

          <div className="approval-box">
            <div className="approval-state">
              <span>当前审批</span>
              <b>{approvalBadge}</b>
              {rec.approval && rec.approval.fieldsHash !== hash && rec.approval.status === 'approved' && (
                <em className="ver-warn">审批锁定的字段已变化 → 自动失效</em>
              )}
            </div>
            {rec.approval?.status === 'pending' ? (
              <div className="btn-row">
                <button className="btn tiny good" onClick={() => props.onRule(true)}>
                  <BadgeCheck size={12} /> 裁决通过
                </button>
                <button className="btn tiny bad" onClick={() => props.onRule(false)}>
                  <Ban size={12} /> 裁决驳回
                </button>
              </div>
            ) : (
              <button
                className="btn"
                disabled={!rec.license || rec.conflicts.length > 0}
                onClick={props.onAskApproval}
              >
                <Gavel size={13} /> 提交审批
              </button>
            )}
          </div>

          <div className="candidate-box">
            <div className="wb-section-title">
              <Rocket size={12} /> 发布候选
            </div>
            {rec.candidate ? (
              <div className={rec.candidate.invalid ? 'cand-invalid' : 'cand-valid'}>
                <span>{rec.candidate.invalid ? '已失效' : '有效'}</span>
                <small>
                  候选 {rec.candidate.id.slice(-6)} · 指纹 {rec.candidate.fieldsHash} · v{rec.candidate.assetVersion}
                </small>
                {rec.candidate.invalid && rec.candidate.invalidReason && (
                  <em>
                    原因：
                    {rec.candidate.invalidReason === 'license-expired'
                      ? '授权到期'
                      : rec.candidate.invalidReason === 'version-bumped'
                      ? '换版'
                      : '字段变更'}
                    ，审批通过后自动重算
                  </em>
                )}
              </div>
            ) : (
              <p className="muted">尚无候选（审批通过后生成）</p>
            )}
          </div>
        </section>
      </div>

      {/* 离线模拟 + 快照 + 发布操作 */}
      <div className="detail-grid bottom">
        <section className="panel">
          <h3>
            <CloudOff size={15} /> 离线协作模拟（窗口 B）
          </h3>
          <p className="muted">
            让窗口 B 带着当前基准断连修改；随后你（窗口 A / 同事）在线改动，再让 B 回连，即可观察基准核对、三方合并与冲突保留。
          </p>
          <div className="btn-row wrap">
            <button className="btn tiny" disabled={rec.conflicts.length > 0} onClick={() => props.onOffline({size: rec.draft.fields.size + 8})}>
              <WifiOff size={12} /> B 离线改字号 +8
            </button>
            <button className="btn tiny" disabled={rec.conflicts.length > 0} onClick={() => props.onOffline({weight: 400})}>
              <WifiOff size={12} /> B 离线改字重 400
            </button>
            <button
              className="btn tiny"
              disabled={rec.conflicts.length > 0 || !rec.license}
              onClick={() =>
                props.onOffline(undefined, {
                  holder: rec.license?.holder ?? 'Yuki Lin',
                  assetVersion: assetVersion,
                  expiresAt: now + 5 * 86400_000,
                  seats: 8,
                })
              }
            >
              <FileLock2 size={12} /> B 离线改授权（5 天 / 8 席）
            </button>
          </div>
          <ol className="hint">
            <li>B 离线后，用上方草稿控件以窗口 A 身份改同一字段（模拟同事先改）。</li>
            <li>在左侧补丁队列点「回连核对」：基准一致快进；基准落后逐字段合并，同字段不同值即冲突。</li>
          </ol>
        </section>

        <section className="panel panel-snapshot">
          <h3>
            <ShieldCheck size={15} /> 确认快照与发布
          </h3>
          {rec.snapshot ? (
            <div className={`snapshot-box ${rec.snapshot.publishedAt ? 'done' : ''}`}>
              <div className="snap-head">
                <b>快照 {rec.snapshot.id.slice(-8)}</b>
                {rec.snapshot.winnerWindow && <span className="winner">先到：{rec.snapshot.winnerWindow}</span>}
                {rec.snapshot.publishedAt && <span className="pub-flag">已发布 {fmtTime(rec.snapshot.publishedAt)}</span>}
              </div>
              <div className="lic-row"><span>冻结字号/字重</span><b>{rec.snapshot.fields.size}px / {rec.snapshot.fields.weight}</b></div>
              <div className="lic-row"><span>冻结授权</span><b>{rec.snapshot.license.holder} · {fmtTime(rec.snapshot.license.expiresAt)}</b></div>
              <div className="lic-row"><span>快照版本/指纹</span><b>v{rec.snapshot.assetVersion} · {rec.snapshot.fieldsHash}</b></div>
              <div className="lic-row"><span>快照时间</span><b>{fmtTime(rec.snapshot.createdAt)}</b></div>
            </div>
          ) : (
            <p className="muted">尚无确认快照。审批通过且候选有效时可确认；确认后草稿独立保留、快照冻结留档。</p>
          )}

          <div className="btn-row wrap">
            <button className="btn primary" disabled={rec.status !== 'ready'} onClick={() => props.onConfirm('窗口 A', `confirm-${rec.id}-${hash}-manual-A`)}>
              <BadgeCheck size={13} /> 窗口 A 确认
            </button>
            <button className="btn" disabled={rec.status !== 'ready'} onClick={props.onRace}>
              <ArrowRightLeft size={13} /> 两个窗口同时确认
            </button>
            <button
              className="btn"
              disabled={rec.status !== 'confirmed'}
              onClick={() => props.onConfirm('窗口 A', `confirm-${rec.id}-${hash}-manual-A`)}
              title="用与窗口 A 相同的幂等键重试"
            >
              <RefreshCcw size={13} /> 重试确认（同幂等键）
            </button>
          </div>
          <div className="btn-row wrap">
            <button className="btn good" disabled={rec.status !== 'confirmed'} onClick={() => props.onPublish(false)}>
              <Rocket size={13} /> 发布快照
            </button>
            <button className="btn bad" disabled={rec.status !== 'confirmed'} onClick={() => props.onPublish(true)}>
              <ShieldAlert size={13} /> 发布（注入写入失败）
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function RangeField(props: {
  label: string;
  k: keyof PairingFields;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  digits?: number;
  onEdit: (k: keyof PairingFields, v: number) => void;
}) {
  return (
    <label>
      {props.label}
      <b className="range-val">
        {props.digits ? props.value.toFixed(props.digits) : props.value}
        {props.unit ?? ''}
      </b>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onEdit(props.k, Number(e.target.value))}
      />
    </label>
  );
}
