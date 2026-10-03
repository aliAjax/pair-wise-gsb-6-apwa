// 发布工作台端到端场景验证（Node + esbuild 编译运行）
import {
  advanceTime,
  bumpAssetVersion,
  confirmSnapshot,
  createInitialState,
  decideApproval,
  editDraft,
  fieldsHash,
  IdempotencyTable,
  makeOfflinePatch,
  migrateLegacy,
  publishSnapshot,
  reconnectPatch,
  requestApproval,
  resolveConflict,
  setLicense,
} from '../src/workbench/engine';
import { License, WorkbenchState } from '../src/workbench/types';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

const T0 = Date.UTC(2026, 8, 1, 8, 0, 0);
const idem = (): IdempotencyTable => ({});
const mem = () => {
  let v: string | null = null;
  return {
    save: (s: string) => {
      v = s;
    },
    load: () => v,
    clear: () => {
      v = null;
    },
  };
};
const recovery = mem();
const noopRecovery = {
  save: recovery.save,
  load: recovery.load,
  clear: recovery.clear,
};

// ─────────────────────────────────────────────────────────
console.log('场景 0：初始化 —— 草稿与确认快照分开放');
{
  const s = createInitialState(T0);
  const ready = s.records.find((r) => r.draft.title === 'Editorial calm')!;
  check('存在可确认记录', ready.status === 'ready', ready.status);
  check('草稿与快照是两个字段（draft / snapshot 分离）', !!ready.draft && ready.snapshot === null);
  check('候选已生成且有效', !!ready.candidate && !ready.candidate.invalid);
  const noLic = s.records.find((r) => r.draft.title === 'Field guide')!;
  check('缺授权记录停在待补', noLic.status === 'awaiting-license', noLic.status);
}

// ─────────────────────────────────────────────────────────
console.log('场景 1：离线改字号 → 同事期间也改 → 回连核对基准 → 冲突字段保留双方值并挡住发布');
{
  let s = createInitialState(T0);
  const rec = s.records.find((r) => r.draft.title === 'Editorial calm')!;
  const baseSize = rec.draft.fields.size;

  // 窗口 B 断连，拿着基准离线改字号 60
  const offline = makeOfflinePatch(s, rec.id, '窗口 B', { size: 60 });
  s = offline.state;
  const patch = offline.patch;
  check('补丁记录了基准修订号', patch.baseRevision === rec.draft.baseRevision);
  check('补丁携带基准字段快照', patch.baseFields.size === baseSize);

  // 窗口 A 在线（同事）改字号 52，并改了正文字体
  s = editDraft(s, rec.id, { size: 52, bodyFont: 'Newsreader' }, '窗口 A').state;

  // 窗口 B 回连
  const res = reconnectPatch(s, patch.id);
  s = res.state;
  const merged = s.records.find((r) => r.id === rec.id)!;
  check('回连报告冲突', res.ok === false && res.error === 'merge-conflict');
  check('记录进入冲突状态挡住发布', merged.status === 'conflict', merged.status);
  const sizeConflict = merged.conflicts.find((c) => c.field === 'size')!;
  check('冲突槽保留 base / 离线 / 同事 三方值',
    sizeConflict.base === baseSize && sizeConflict.local === 60 && sizeConflict.remote === 52,
    JSON.stringify(sizeConflict));
  const onlyRemote = merged.conflicts.find((c) => c.field === 'bodyFont');
  check('只有同事改的字段不冲突，直接采用同事值', !onlyRemote && merged.draft.fields.bodyFont === 'Newsreader');

  // 冲突未解决时确认/送审/再编辑都被挡
  const blocked = confirmSnapshot(s, rec.id, '窗口 A', 'k1', idem());
  check('冲突未裁决挡住确认', blocked.ok === false);
  const blockedApproval = requestApproval(s, rec.id);
  check('冲突未裁决挡住送审', blockedApproval.ok === false);

  // 裁决字号取离线值 60
  s = resolveConflict(s, rec.id, 'size', 'local', '窗口 B').state;
  const after = s.records.find((r) => r.id === rec.id)!;
  check('裁决后冲突解除', after.conflicts.length === 0);
  check('字号采用离线值 60', after.draft.fields.size === 60);
  check('冲突解除后因字段变化回到待审批', after.status === 'awaiting-approval', after.status);
}

// ─────────────────────────────────────────────────────────
console.log('场景 1b：基准一致时离线补丁快进，不产生冲突');
{
  let s = createInitialState(T0);
  const rec = s.records.find((r) => r.draft.title === 'Editorial calm')!;
  const offline = makeOfflinePatch(s, rec.id, '窗口 B', { size: 64 });
  s = offline.state;
  // 期间没人在线改
  const res = reconnectPatch(s, offline.patch.id);
  s = res.state;
  const r = s.records.find((x) => x.id === rec.id)!;
  check('基准一致快进合并成功', res.ok && r.draft.fields.size === 64);
  check('无冲突', r.conflicts.length === 0 && r.status !== 'conflict');
}

// ─────────────────────────────────────────────────────────
console.log('场景 2：授权到期 / 换版 → 审批与发布候选失效重算');
{
  let s = createInitialState(T0);
  const rec = s.records.find((r) => r.draft.title === 'Editorial calm')!;
  const oldApprovalId = rec.approval!.id;
  const oldCandidateId = rec.candidate!.id;

  // 授权到期
  s = advanceTime(s, 31 * 86400_000).state;
  let r = s.records.find((x) => x.id === rec.id)!;
  check('授权到期后状态回到待审批', r.status === 'awaiting-approval', r.status);
  check('旧审批标记为 expired', r.approval?.status === 'expired', r.approval?.status ?? '');
  check('旧候选失效', !!r.candidate?.invalid);
  check('到期状态不能确认', !confirmSnapshot(s, rec.id, '窗口 A', 'k', idem()).ok);

  // 补新授权（再给 30 天）→ 仍需重新审批
  const newLic: License = { holder: 'Yuki Lin', assetVersion: 1, expiresAt: s.now + 30 * 86400_000, seats: 5 };
  s = setLicense(s, rec.id, newLic).state;
  s = requestApproval(s, rec.id).state;
  s = decideApproval(s, rec.id, true).state;
  r = s.records.find((x) => x.id === rec.id)!;
  check('重新授权+审批后候选重算并回到可确认', r.status === 'ready', r.status);
  check('重算生成了新候选', r.candidate!.id !== oldCandidateId && !r.candidate.invalid);
  check('审批记录已更新', r.approval!.id !== oldApprovalId);

  // 全局换版
  s = bumpAssetVersion(s).state;
  r = s.records.find((x) => x.id === rec.id)!;
  check('换版后状态回到待审批', r.status === 'awaiting-approval', r.status);
  check('换版后候选失效', !!r.candidate?.invalid);
  // 换版后的新授权
  const v2Lic: License = { holder: 'Yuki Lin', assetVersion: 2, expiresAt: s.now + 30 * 86400_000, seats: 5 };
  s = setLicense(s, rec.id, v2Lic).state;
  s = requestApproval(s, rec.id).state;
  s = decideApproval(s, rec.id, true).state;
  r = s.records.find((x) => x.id === rec.id)!;
  check('v2 授权+审批后恢复可确认', r.status === 'ready', r.status);
}

// ─────────────────────────────────────────────────────────
console.log('场景 3：写入失败后从完整快照恢复');
{
  let s = createInitialState(T0);
  const rec = s.records.find((r) => r.draft.title === 'Editorial calm')!;
  // 先确认
  const c = confirmSnapshot(s, rec.id, '窗口 A', 'confirm-1', idem());
  s = c.state;
  check('确认后快照独立存在', !!s.records.find((r) => r.id === rec.id)!.snapshot);

  // 发布写入失败
  const res = publishSnapshot(s, rec.id, '窗口 A', 'pub-1', idem(), false, recovery.save, recovery.load, recovery.clear);
  check('发布失败结果 ok=false', !res.ok && res.error === 'write-failed-restored');
  const restored = res.state.records.find((r) => r.id === rec.id)!;
  check('从完整快照恢复后发布未落库（仍为已确认）', restored.status === 'confirmed' && !restored.snapshot.publishedAt);

  // 恢复后重试发布成功
  const res2 = publishSnapshot(res.state, rec.id, '窗口 A', 'pub-2', idem(), true, recovery.save, recovery.load, recovery.clear);
  check('恢复后重新发布成功', res2.ok);
  check('状态为已发布终态', res2.state.records.find((r) => r.id === rec.id)!.status === 'published');
}

// ─────────────────────────────────────────────────────────
console.log('场景 4：两个窗口同时确认 → 先到版本生效，重试幂等不重复生成');
{
  let s = createInitialState(T0);
  const rec = s.records.find((r) => r.draft.title === 'Editorial calm')!;
  const candidateIdBefore = rec.candidate!.id;
  const table = idem();

  // 窗口 A 先确认
  const a = confirmSnapshot(s, rec.id, '窗口 A', 'confirm-A', table);
  check('窗口 A 先到确认成功', a.ok && !!a.snapshot);
  const snapAId = a.snapshot!.id;
  s = a.state;

  // 窗口 B 几乎同时确认同一版本：先到窗口已把候选作废，后到窗口必须明确输掉
  const b = confirmSnapshot(s, rec.id, '窗口 B', 'confirm-B', table);
  check('窗口 B 输掉竞争（先到版本生效）', !b.ok && b.error!.includes('先到版本已生效'), b.error ?? '');
  // 失败方的确认不产生第二条快照记录
  const after = b.state.records.find((r) => r.id === rec.id)!;
  check('只生成了一条快照记录（先到窗口 A）', after.snapshot!.id === snapAId && after.snapshot.winnerWindow === '窗口 A');
  check('候选已被先到窗口作废（单赢家 CAS）', after.candidate?.id === candidateIdBefore && after.candidate.invalid);

  // 窗口 A 网络抖动重试，用同一个幂等键
  const retry = confirmSnapshot(s, rec.id, '窗口 A', 'confirm-A', table);
  check('重试命中幂等返回成功', retry.ok && retry.deduped === true);
  check('重试没有重复生成快照', retry.state.records.find((r) => r.id === rec.id)!.snapshot!.id === snapAId);

  // 窗口 B 若在 A 之前点了确认但请求晚到（用独立状态模拟顺序）：
  // 两个独立状态副本各自拿到同一候选，先应用 A 再应用 B，B 必输 —— 已由上面覆盖。
  const auditConfirm = s.audit.filter((e) => e.type === 'confirmed').length;
  check('审计中确认生效只有一次', auditConfirm === 1, String(auditConfirm));
}

// ─────────────────────────────────────────────────────────
console.log('场景 5：旧数据只有草稿 → 升级为带授权信息的记录，缺授权停在待补');
{
  const s = createInitialState(T0, undefined);
  const before = s.records.length;
  const legacy = [
    { id: 101, title: '旧搭配 Alpha', heading: 'H', body: 'B', category: 'Editorial', favorite: false },
    { id: 102, title: '旧搭配 Beta', heading: 'H2', body: 'B2', category: 'Brand', favorite: true },
  ];
  const n = migrateLegacy(legacy, s);
  const upgraded = s.records.slice(s.records.length - n);
  check('两条旧草稿被升级', n === 2 && s.records.length === before + 2);
  check('升级记录带授权字段（null）且无旧审批', upgraded.every((r) => r.license === null && r.approval === null && r.candidate === null));
  check('缺授权停在待补授权', upgraded.every((r) => r.status === 'awaiting-license'), upgraded.map((r) => r.status).join(','));

  // 补上授权后流转到待审批
  const alpha = upgraded[0];
  const lic: License = { holder: '旧数据补授权', assetVersion: 1, expiresAt: s.now + 10 * 86400_000, seats: 2 };
  const next = setLicense(s, alpha.id, lic).state;
  const a2 = next.records.find((r) => r.id === alpha.id)!;
  check('补授权后进入待审批', a2.status === 'awaiting-approval', a2.status);
}

// ─────────────────────────────────────────────────────────
console.log('场景 6：确认后草稿仍可独立编辑，快照不受影响（草稿/快照分离）');
{
  let s = createInitialState(T0);
  const rec = s.records.find((r) => r.draft.title === 'Editorial calm')!;
  const snapHash = fieldsHash(rec.draft.fields);
  s = confirmSnapshot(s, rec.id, '窗口 A', 'cf', idem()).state;
  const confirmed = s.records.find((r) => r.id === rec.id)!;
  // 确认后继续改草稿
  s = editDraft(s, rec.id, { size: 70 }, '窗口 A').state;
  const edited = s.records.find((r) => r.id === rec.id)!;
  check('草稿字号已变为 70', edited.draft.fields.size === 70);
  check('快照冻结值仍是 46', edited.snapshot!.fields.size === 46);
  check('快照指纹与确认时一致', edited.snapshot!.fieldsHash === snapHash);
}

// ─────────────────────────────────────────────────────────
console.log('场景 7：离线改授权，同事也改了授权（并改字号）→ 授权冲突保留双方值');
{
  let s = createInitialState(T0);
  const rec = s.records.find((r) => r.draft.title === 'Studio notes')!;
  // 先让它审批通过
  s = decideApproval(s, rec.id, true).state;
  const baseLicSeats = s.records.find((x) => x.id === rec.id)!.license!.seats;
  // 窗口 B 断连离线改授权（8 席）
  const offline = makeOfflinePatch(
    s,
    rec.id,
    '窗口 B',
    { weight: 500 },
    { holder: 'Mo Chen', assetVersion: 1, expiresAt: T0 + 5 * 86400_000, seats: 8 },
  );
  s = offline.state;
  // 同事同时改了授权（3 席）和字号
  s = setLicense(s, rec.id, { holder: 'Mo Chen', assetVersion: 1, expiresAt: T0 + 20 * 86400_000, seats: 3 }, '窗口 A').state;
  s = editDraft(s, rec.id, { size: 33 }, '窗口 A').state;
  const res = reconnectPatch(s, offline.patch.id);
  s = res.state;
  const r = s.records.find((x) => x.id === rec.id)!;
  check('授权冲突被检出', !res.ok && r.conflicts.some((c) => c.field === 'license'), res.error ?? 'ok');
  check('离线独占改的字重并入草稿', r.draft.fields.weight === 500);
  check('同事的字号改动保留', r.draft.fields.size === 33);
  check('基准授权席位数正确', baseLicSeats === 5, String(baseLicSeats));
  const licSlot = r.conflicts.find((c) => c.field === 'license')!;
  check(
    '授权冲突保留双方值（离线 8 席 / 同事 3 席）',
    !!licSlot && (licSlot.local as License).seats === 8 && (licSlot.remote as License).seats === 3,
    licSlot ? `local=${(licSlot.local as License).seats} remote=${(licSlot.remote as License).seats}` : 'no slot',
  );
  // 取同事授权解决
  s = resolveConflict(s, rec.id, 'license', 'remote').state;
  const r2 = s.records.find((x) => x.id === rec.id)!;
  check('授权冲突解决后解除拦截', r2.conflicts.length === 0);
}

// ─────────────────────────────────────────────────────────
console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
