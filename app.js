'use strict';

const worker = new Worker('worker.js');

const els = {
  identitySelect: document.getElementById('identitySelect'),
  refreshBtn: document.getElementById('refreshBtn'),
  exportBtn: document.getElementById('exportBtn'),
  seedV1Btn: document.getElementById('seedV1Btn'),
  seedFutureBtn: document.getElementById('seedFutureBtn'),
  clearBtn: document.getElementById('clearBtn'),
  createForm: document.getElementById('createForm'),
  createTitle: document.getElementById('createTitle'),
  createAmount: document.getElementById('createAmount'),
  createReason: document.getElementById('createReason'),
  instanceCount: document.getElementById('instanceCount'),
  instanceList: document.getElementById('instanceList'),
  detail: document.getElementById('detail'),
  canvas: document.getElementById('flowCanvas'),
  replayBtn: document.getElementById('replayBtn'),
  playReplayBtn: document.getElementById('playReplayBtn'),
  exitReplayBtn: document.getElementById('exitReplayBtn'),
  replayRange: document.getElementById('replayRange'),
  replayMeta: document.getElementById('replayMeta'),
  replayJson: document.getElementById('replayJson'),
  toastHost: document.getElementById('toastHost')
};

const state = {
  config: null,
  instances: [],
  details: {},
  selectedId: null,
  currentIdentity: localStorage.getItem('approval.currentIdentity') || 'u_zhang',
  replay: null,
  replayIndex: 0,
  playingTimer: null
};

let reqSeq = 0;
const pending = new Map();

worker.onmessage = (message) => {
  const { reqId, ok, payload, error } = message.data;
  const resolver = pending.get(reqId);
  if (!resolver) return;
  pending.delete(reqId);
  if (ok) resolver.resolve(payload);
  else resolver.reject(Object.assign(new Error(error.message), { code: error.code }));
};

function send(type, extra = {}) {
  const reqId = `req_${++reqSeq}`;
  return new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject });
    worker.postMessage({ reqId, type, ...extra });
  });
}

function toast(message, kind = 'info') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  els.toastHost.appendChild(node);
  setTimeout(() => node.remove(), 3600);
}

function handleError(error) {
  console.error(error);
  toast(error.message || '操作失败', 'error');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(date);
}

function currentUser() {
  return state.config.users.find((user) => user.id === state.currentIdentity);
}

function selectedRecord() {
  return state.details[state.selectedId] || null;
}

function roleName(roleId) {
  return state.config.roles[roleId]?.name || roleId || '—';
}

function userName(userId) {
  if (!userId) return '未指定';
  return state.config.users.find((user) => user.id === userId)?.name || userId;
}

function stepName(stepId) {
  if (!stepId) return '已结束';
  return state.config.steps.find((step) => step.id === stepId)?.name || stepId;
}

const STATUS_TEXT = {
  draft: '草稿',
  pending: '审批中',
  returned: '已退回',
  approved: '已通过',
  rejected: '已驳回',
  withdrawn: '已撤回',
  unknown: '版本只读'
};

function statusText(status) {
  return STATUS_TEXT[status] || status;
}

function eventText(event) {
  const stepId = event.payload?.stepId || event.payload?.fromStepId;
  const stepLabel = stepId ? ` · ${stepName(stepId)}` : '';
  const map = {
    created: '创建草稿',
    form_saved: '保存草稿',
    submitted: '提交申请',
    resubmitted: '重新提交',
    approved: `审批通过${stepLabel}`,
    rejected: `驳回退回${stepLabel}`,
    transferred: `转交给 ${userName(event.payload?.toUserId)}`,
    withdrawn: '撤回申请'
  };
  return map[event.type] || event.type;
}

function renderIdentity() {
  const groups = state.config.users.reduce((acc, user) => {
    (acc[user.roleId] ||= []).push(user);
    return acc;
  }, {});
  els.identitySelect.innerHTML = Object.entries(groups).map(([roleId, users]) => {
    const options = users.map((user) => (
      `<option value="${user.id}" ${user.id === state.currentIdentity ? 'selected' : ''}>${escapeHtml(user.name)}（${roleName(roleId)}）</option>`
    )).join('');
    return `<optgroup label="${roleName(roleId)}">${options}</optgroup>`;
  }).join('');
}

function renderInstanceList() {
  els.instanceCount.textContent = state.instances.length;
  if (!state.instances.length) {
    els.instanceList.innerHTML = '<div class="notice">暂无实例。清空存储后可新建。</div>';
    return;
  }
  const sorted = [...state.instances].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  els.instanceList.innerHTML = sorted.map((item) => {
    const current = item.id === state.selectedId ? ' active' : '';
    return `
      <button type="button" class="instance-card${current}" data-id="${item.id}">
        <h3>${escapeHtml(item.title)}</h3>
        <div class="instance-meta">
          <span class="badge ${item.status}">${statusText(item.status)}</span>
          <span>${escapeHtml(stepName(item.currentStep))}</span>
        </div>
        <div class="instance-meta">
          <span>${escapeHtml(item.applicantName)}</span>
          <span>${formatTime(item.updatedAt)}</span>
        </div>
      </button>
    `;
  }).join('');
}

function currentStepInfo(snapshot) {
  if (!snapshot?.currentStep) return null;
  const definition = state.config.steps.find((item) => item.id === snapshot.currentStep);
  const runtime = snapshot.steps?.find((item) => item.id === snapshot.currentStep);
  return definition && runtime ? { ...definition, runtime } : null;
}

function availableActions(snapshot, user) {
  const applicant = snapshot.applicantId === user.id;
  const stepInfo = currentStepInfo(snapshot);
  const sameRole = stepInfo && user.roleId === stepInfo.roleId;
  const assignedToUser = stepInfo && (!stepInfo.runtime.assigneeId || stepInfo.runtime.assigneeId === user.id);
  const approver = sameRole && assignedToUser;
  const transferTargets = stepInfo
    ? state.config.users.filter((candidate) => candidate.roleId === user.roleId && candidate.id !== user.id)
    : [];
  return {
    canEdit: applicant && ['draft', 'returned'].includes(snapshot.status) && snapshot.currentStep === 'draft',
    canSubmit: applicant && ['draft', 'returned'].includes(snapshot.status) && snapshot.currentStep === 'draft',
    canApprove: approver && ['pending', 'returned'].includes(snapshot.status),
    canReject: approver && ['pending', 'returned'].includes(snapshot.status),
    canTransfer: approver && ['pending', 'returned'].includes(snapshot.status) && transferTargets.length > 0,
    canWithdraw: applicant && (snapshot.status === 'pending' || (snapshot.status === 'returned' && snapshot.currentStep === 'draft')),
    transferTargets
  };
}

function renderWarnings(record) {
  if (!record.warnings?.length) return '';
  return record.warnings.map((warning) => `<div class="notice">${escapeHtml(warning)}</div>`).join('');
}

function renderFields(snapshot, editable) {
  if (!editable) {
    return `
      <div class="field-grid">
        <div><label>标题</label><div class="readonly-field">${escapeHtml(snapshot.form.title)}</div></div>
        <div><label>金额</label><div class="readonly-field">${escapeHtml(snapshot.form.amount || '未填写')}</div></div>
      </div>
      <label>事由</label><div class="readonly-field">${escapeHtml(snapshot.form.reason || '未填写')}</div>
    `;
  }
  return `
    <div class="form-grid">
      <label>标题<input data-field="title" value="${escapeHtml(snapshot.form.title)}"></label>
      <label>金额<input data-field="amount" value="${escapeHtml(snapshot.form.amount)}" inputmode="decimal"></label>
    </div>
    <label>事由<textarea data-field="reason" rows="3">${escapeHtml(snapshot.form.reason)}</textarea></label>
    <div class="action-bar">
      <button type="button" data-action="save-draft" class="secondary">保存草稿</button>
      <button type="button" data-action="submit" class="success">提交申请</button>
    </div>
  `;
}

function renderApprovalBar(actions) {
  if (!actions.canApprove && !actions.canReject && !actions.canTransfer && !actions.canWithdraw) return '';
  const targets = actions.transferTargets.map((user) => (
    `<option value="${user.id}">${escapeHtml(user.name)}</option>`
  )).join('');
  return `
    <div class="comment-form">
      <label>处理意见<textarea data-field="comment" rows="2" placeholder="审批、驳回或转交说明（驳回必填）"></textarea></label>
      <div class="action-bar">
        ${actions.canApprove ? '<button type="button" data-action="approve" class="success">审批通过</button>' : ''}
        ${actions.canReject ? '<button type="button" data-action="reject" class="danger">驳回到上一步</button>' : ''}
        ${actions.canTransfer ? `
          <select data-field="targetUserId" title="转交目标">${targets}</select>
          <button type="button" data-action="transfer" class="warning">转交</button>
        ` : ''}
        ${actions.canWithdraw ? '<button type="button" data-action="withdraw" class="secondary">撤回申请</button>' : ''}
      </div>
    </div>
  `;
}

function renderSteps(snapshot) {
  const rows = (snapshot.steps || []).map((item) => {
    const statusMap = {
      current: '当前处理', pending: '未到达', approved: '已通过',
      returned: '退回', withdrawn: '已撤回'
    };
    return `
      <div class="step-row ${item.status === 'current' ? 'current' : ''}">
        <div>
          <div class="step-name">${escapeHtml(item.name)}</div>
          <div class="step-role">${escapeHtml(roleName(item.roleId))}</div>
        </div>
        <div class="step-info">
          <strong>${statusMap[item.status] || item.status}</strong>
          <span>处理人：${escapeHtml(item.assigneeId ? userName(item.assigneeId) : item.roleId === 'applicant' ? escapeHtml(snapshot.applicantName) : '该角色待领取')}</span>
          <span>指派时间：${formatTime(item.assignedAt)}</span>
          <span>处理时间：${formatTime(item.processedAt)}</span>
          ${item.note ? `<span>备注：${escapeHtml(item.note)}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
  return `<div class="steps">${rows}</div>`;
}

function renderTimeline(events) {
  const list = [...(events || [])].reverse();
  if (!list.length) return '<div class="notice">暂无事件。</div>';
  return list.map((event) => `
    <div class="event ${event.type}">
      <div class="event-title">${escapeHtml(eventText(event))}</div>
      ${event.payload?.comment ? `<div class="event-comment">${escapeHtml(event.payload.comment)}</div>` : ''}
      <div class="event-meta">${escapeHtml(event.actorName)} · ${formatTime(event.at)}</div>
    </div>
  `).join('');
}

function renderDetail() {
  const record = selectedRecord();
  if (!record) {
    els.detail.innerHTML = `
      <div class="detail-empty">
        <strong>请选择或创建一个审批实例</strong>
        <span>可以同时创建多个实例，状态按实例 ID 完全隔离。</span>
      </div>
    `;
    els.replayBtn.disabled = true;
    drawGraph(null);
    return;
  }

  const compatibility = record.compatibility || 'current';
  if (['future', 'unsupported', 'broken'].includes(compatibility)) {
    const snapshot = record.snapshot || record;
    els.detail.innerHTML = `
      <div class="detail-head">
        <div><h2>${escapeHtml(snapshot.title || record.title || '未知实例')}</h2>
          <div class="detail-meta"><span class="badge unknown">${compatibility === 'broken' ? '数据损坏' : '只读降级'}</span><span>schema ${record.schemaVersion ?? record.version}</span></div>
        </div>
      </div>
      ${renderWarnings(record)}
      <pre class="json-small">${escapeHtml(JSON.stringify(snapshot, null, 2))}</pre>
    `;
    els.replayBtn.disabled = true;
    drawGraph(snapshot);
    return;
  }

  const snapshot = record.snapshot;
  const user = currentUser();
  const actions = availableActions(snapshot, user);
  const approvalBar = renderApprovalBar(actions);
  els.detail.innerHTML = `
    <div class="detail-head">
      <div>
        <h2>${escapeHtml(snapshot.title)}</h2>
        <div class="detail-meta">
          <span class="badge ${snapshot.status}">${statusText(snapshot.status)}</span>
          <span>当前：${escapeHtml(stepName(snapshot.currentStep))}</span>
          <span>申请人：${escapeHtml(snapshot.applicantName)}</span>
          <span>更新：${formatTime(snapshot.updatedAt)}</span>
        </div>
      </div>
    </div>
    ${renderWarnings(record)}
    <section class="section-block">
      <h3>申请数据（驳回与转交时保留）</h3>
      ${renderFields(snapshot, actions.canEdit)}
    </section>
    <section class="section-block">
      <h3>审批处理</h3>
      ${approvalBar}
      ${approvalBar ? '' : `<div class="notice">当前身份：${escapeHtml(user.name)}（${roleName(user.roleId)}），在当前节点无可执行动作。切换身份可模拟不同角色。</div>`}
    </section>
    <section class="section-block">
      <h3>步骤状态 / 处理人 / 时间</h3>
      ${renderSteps(snapshot)}
    </section>
    <section class="section-block">
      <h3>事件日志</h3>
      <div class="timeline">${renderTimeline(record.events)}</div>
    </section>
  `;
  els.replayBtn.disabled = false;
  drawGraph(snapshot);
}

function drawRoundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function drawArrow(ctx, fromX, fromY, toX, toY, color, curve = 0, dashed = false) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash(dashed ? [7, 5] : []);
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  if (curve === 0) {
    ctx.lineTo(toX, toY);
  } else {
    const controlX = (fromX + toX) / 2;
    const controlY = Math.min(fromY, toY) - curve;
    ctx.quadraticCurveTo(controlX, controlY, toX, toY);
  }
  ctx.stroke();

  const angle = Math.atan2(toY - (curve === 0 ? fromY : Math.min(fromY, toY) - curve), toX - (curve === 0 ? fromX : (fromX + toX) / 2));
  const size = 9;
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - size * Math.cos(angle - Math.PI / 6), toY - size * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(toX - size * Math.cos(angle + Math.PI / 6), toY - size * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawEdgeLabel(ctx, text, x, y, color) {
  ctx.save();
  ctx.font = '12px sans-serif';
  const width = ctx.measureText(text).width + 12;
  drawRoundRect(ctx, x - width / 2, y - 12, width, 22, 8);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawGraph(snapshot) {
  const ctx = els.canvas.getContext('2d');
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  ctx.fillStyle = '#fbfdff';
  ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);

  const width = 154;
  const height = 72;
  const y = 88;
  const positions = [70, 282, 494, 706];
  const nodes = state.config.steps.map((definition, index) => {
    const runtime = snapshot?.steps?.find((item) => item.id === definition.id);
    return { ...definition, x: positions[index], y, width, height, runtime };
  });

  for (let index = 0; index < nodes.length - 1; index += 1) {
    drawArrow(ctx, nodes[index].x + width, y + height / 2, nodes[index + 1].x, y + height / 2, '#64748b');
    drawEdgeLabel(ctx, '通过 / 提交', (nodes[index].x + width + nodes[index + 1].x) / 2, y + height / 2 - 13, '#475569');
  }

  for (let index = 1; index < nodes.length; index += 1) {
    drawArrow(ctx, nodes[index].x + 20, y + height, nodes[index - 1].x + width - 20, y + height, '#ea580c', 58, true);
    drawEdgeLabel(ctx, index === 1 ? '驳回/撤回' : '驳回', (nodes[index].x + nodes[index - 1].x + width) / 2, y + height + 47, '#ea580c');
  }

  drawArrow(ctx, 790, 174, 840, 220, '#7c3aed', 0, true);
  drawArrow(ctx, 790, 220, 706 + width / 2, y + height, '#7c3aed', 22, true);
  drawEdgeLabel(ctx, '同角色转交（状态节点不变）', 744, 206, '#7c3aed');

  nodes.forEach((node) => {
    const runtimeStatus = node.runtime?.status;
    const isCurrent = snapshot?.currentStep === node.id;
    let fill = '#ffffff';
    let border = '#94a3b8';
    if (runtimeStatus === 'approved') {
      fill = '#dcfce7';
      border = '#22c55e';
    } else if (runtimeStatus === 'returned') {
      fill = '#ffedd5';
      border = '#f97316';
    } else if (runtimeStatus === 'withdrawn') {
      fill = '#e0e7ff';
      border = '#818cf8';
    } else if (isCurrent) {
      fill = '#dbeafe';
      border = '#2563eb';
    }
    ctx.save();
    ctx.lineWidth = isCurrent ? 3 : 2;
    drawRoundRect(ctx, node.x, node.y, node.width, node.height, 14);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = border;
    ctx.stroke();
    ctx.fillStyle = '#0f172a';
    ctx.textAlign = 'center';
    ctx.font = '700 15px sans-serif';
    ctx.fillText(node.name, node.x + node.width / 2, node.y + 27);
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#475569';
    ctx.fillText(roleName(node.roleId), node.x + node.width / 2, node.y + 50);
    ctx.restore();
  });

  ctx.save();
  ctx.textAlign = 'left';
  ctx.font = '700 13px sans-serif';
  ctx.fillStyle = '#334155';
  const status = snapshot?.status ? `实例状态：${statusText(snapshot.status)}` : '实例状态：未选择';
  ctx.fillText(status, 70, 34);
  ctx.font = '12px sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.fillText('驳回只回到相邻上一步；申请数据和事件日志不会被覆盖。', 70, 56);
  ctx.restore();

  if (snapshot?.status === 'approved') {
    drawRoundRect(ctx, 70, 215, 790, 42, 12);
    ctx.fillStyle = '#dcfce7';
    ctx.fill();
    ctx.strokeStyle = '#22c55e';
    ctx.stroke();
    ctx.fillStyle = '#166534';
    ctx.font = '700 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('终态：全部步骤通过', 465, 242);
  }
  if (snapshot?.status === 'withdrawn') {
    drawRoundRect(ctx, 70, 215, 790, 42, 12);
    ctx.fillStyle = '#e0e7ff';
    ctx.fill();
    ctx.strokeStyle = '#818cf8';
    ctx.stroke();
    ctx.fillStyle = '#3730a3';
    ctx.font = '700 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('终态：申请人已撤回', 465, 242);
  }
}

function readFormValues() {
  return {
    title: els.detail.querySelector('[data-field="title"]')?.value.trim(),
    amount: els.detail.querySelector('[data-field="amount"]')?.value.trim(),
    reason: els.detail.querySelector('[data-field="reason"]')?.value.trim()
  };
}

async function refreshAll(showToast = false) {
  const payload = await send('list');
  state.instances = payload.instances;
  state.details = payload.details;
  if (state.selectedId && !state.details[state.selectedId]) {
    state.selectedId = null;
    exitReplay();
  }
  renderInstanceList();
  renderDetail();
  if (showToast) toast('数据已刷新', 'success');
}

async function runAction(action) {
  const record = selectedRecord();
  if (!record) return;
  const comment = els.detail.querySelector('[data-field="comment"]')?.value.trim() || '';
  const targetUserId = els.detail.querySelector('[data-field="targetUserId"]')?.value;
  if (action === 'save-draft') {
    const form = readFormValues();
    await send('execute', { command: { instanceId: record.id, type: 'save_draft', actorId: state.currentIdentity, form } });
    toast('草稿已保存，数据保留', 'success');
  } else if (action === 'submit') {
    const form = readFormValues();
    if (record.snapshot.currentStep === 'draft') {
      await send('execute', { command: { instanceId: record.id, type: 'save_draft', actorId: state.currentIdentity, form } });
    }
    await send('execute', { command: { instanceId: record.id, type: 'submit', actorId: state.currentIdentity } });
    toast('申请已提交', 'success');
  } else {
    const command = { instanceId: record.id, type: action, actorId: state.currentIdentity, comment };
    if (action === 'transfer') command.targetUserId = targetUserId;
    await send('execute', { command });
    toast(`操作已完成：${eventText({ type: action, payload: { stepId: record.snapshot.currentStep, toUserId: targetUserId } })}`, 'success');
  }
  exitReplay();
  await refreshAll();
}

function showReplayFrame(index) {
  if (!state.replay) return;
  const frame = state.replay.frames[index];
  state.replayIndex = index;
  els.replayRange.value = String(index);
  els.replayMeta.textContent = `第 ${index + 1} / ${state.replay.frames.length} 帧 · ${eventText(frame.event)} · ${formatTime(frame.event.at)}`;
  els.replayJson.hidden = false;
  els.replayJson.textContent = JSON.stringify(frame.state, null, 2);
  drawGraph(frame.state);
}

function stopPlaying() {
  if (state.playingTimer) {
    clearInterval(state.playingTimer);
    state.playingTimer = null;
    els.playReplayBtn.textContent = '播放';
  }
}

function exitReplay() {
  stopPlaying();
  state.replay = null;
  state.replayIndex = 0;
  els.replayRange.disabled = true;
  els.playReplayBtn.disabled = true;
  els.exitReplayBtn.disabled = true;
  els.replayRange.value = '0';
  els.replayMeta.textContent = '选择实例后可重放全部事件。';
  els.replayJson.hidden = true;
  els.replayJson.textContent = '';
}

async function startReplay() {
  const record = selectedRecord();
  if (!record) return;
  stopPlaying();
  try {
    const replay = await send('replay', { instanceId: record.id });
    state.replay = replay;
    state.replayIndex = replay.frames.length - 1;
    els.replayRange.disabled = false;
    els.replayRange.max = String(replay.frames.length - 1);
    els.playReplayBtn.disabled = false;
    els.exitReplayBtn.disabled = false;
    showReplayFrame(state.replayIndex);
    toast(replay.snapshotMatches ? '事件重放结果与存储快照一致' : '快照不一致，已以事件重放为准', replay.snapshotMatches ? 'success' : 'warning');
  } catch (error) {
    handleError(error);
  }
}

function togglePlay() {
  if (!state.replay) return;
  if (state.playingTimer) {
    stopPlaying();
    return;
  }
  if (state.replayIndex >= state.replay.frames.length - 1) showReplayFrame(0);
  els.playReplayBtn.textContent = '暂停';
  state.playingTimer = setInterval(() => {
    if (state.replayIndex >= state.replay.frames.length - 1) {
      stopPlaying();
      return;
    }
    showReplayFrame(state.replayIndex + 1);
  }, 900);
}

async function downloadExport() {
  const { records } = await send('export');
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), currentSchemaVersion: 2, records }, null, 2)], {
    type: 'application/json'
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `approval-instances-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importRawSample(kind) {
  const record = kind === 'v1'
    ? {
      id: `inst-legacy-v1-${Date.now().toString(36)}`,
      version: 1,
      title: 'v1 历史报销单',
      applicant: 'li_si',
      data: { title: 'v1 历史报销单', amount: '430.00', reason: '客户接待餐费' },
      current: '经理审批',
      state: 'returned',
      history: [
        { action: 'create', by: 'li_si', byRole: 'applicant', at: new Date(Date.now() - 86400000 * 3).toISOString() },
        { action: 'submit', by: 'li_si', byRole: 'applicant', at: new Date(Date.now() - 86400000 * 3 + 600000).toISOString() },
        { action: 'approve', by: 'chen_jingli', byRole: 'manager', step: '经理审批', comment: '收到' },
        { action: 'reject', by: 'wang_zongjian', byRole: 'director', step: '总监审批', toStep: '经理审批', comment: '发票抬头需核实' }
      ]
    }
    : {
      id: `inst-future-v99-${Date.now().toString(36)}`,
      schemaVersion: 99,
      title: '来自未来版本的实例',
      snapshot: {
        id: `inst-future-v99-${Date.now().toString(36)}`,
        schemaVersion: 99,
        title: '来自未来版本的实例',
        applicantName: '未知用户',
        status: 'pending',
        currentStep: 'future-ai-review',
        updatedAt: new Date().toISOString(),
        steps: [],
        unknownFutureData: true
      },
      events: []
    };
  await send('import-raw', { record });
  toast(kind === 'v1' ? 'v1 记录已迁移到当前版本' : '未来版本已以只读降级模式导入', 'success');
  await refreshAll();
  state.selectedId = record.id;
  renderInstanceList();
  renderDetail();
}

async function clearStorage() {
  if (!window.confirm('确认清空全部审批实例？IndexedDB 数据会被删除。')) return;
  await send('clear');
  state.selectedId = null;
  exitReplay();
  await refreshAll();
  toast('存储已清空', 'success');
}

async function createInstance(event) {
  event.preventDefault();
  try {
    const command = {
      actorId: state.currentIdentity,
      form: {
        title: els.createTitle.value.trim(),
        amount: els.createAmount.value.trim(),
        reason: els.createReason.value.trim()
      }
    };
    const payload = await send('create', { command });
    els.createForm.reset();
    state.selectedId = payload.record.snapshot.id;
    exitReplay();
    await refreshAll();
    toast('草稿实例已创建', 'success');
  } catch (error) {
    handleError(error);
  }
}

async function onDetailClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  try {
    await runAction(button.dataset.action);
  } catch (error) {
    handleError(error);
  }
}

async function onListClick(event) {
  const card = event.target.closest('.instance-card[data-id]');
  if (!card) return;
  state.selectedId = card.dataset.id;
  exitReplay();
  renderInstanceList();
  renderDetail();
}

function bindEvents() {
  els.identitySelect.addEventListener('change', () => {
    state.currentIdentity = els.identitySelect.value;
    localStorage.setItem('approval.currentIdentity', state.currentIdentity);
    exitReplay();
    renderDetail();
  });
  els.createForm.addEventListener('submit', createInstance);
  els.instanceList.addEventListener('click', onListClick);
  els.detail.addEventListener('click', onDetailClick);
  els.refreshBtn.addEventListener('click', () => refreshAll(true).catch(handleError));
  els.exportBtn.addEventListener('click', () => downloadExport().catch(handleError));
  els.seedV1Btn.addEventListener('click', () => importRawSample('v1').catch(handleError));
  els.seedFutureBtn.addEventListener('click', () => importRawSample('future').catch(handleError));
  els.clearBtn.addEventListener('click', () => clearStorage().catch(handleError));
  els.replayBtn.addEventListener('click', startReplay);
  els.playReplayBtn.addEventListener('click', togglePlay);
  els.exitReplayBtn.addEventListener('click', () => {
    exitReplay();
    renderDetail();
  });
  els.replayRange.addEventListener('input', () => {
    stopPlaying();
    showReplayFrame(Number(els.replayRange.value));
  });
}

async function init() {
  bindEvents();
  try {
    const payload = await send('bootstrap');
    state.config = payload.config;
    state.instances = payload.instances;
    state.details = payload.details;
    if (!state.config.users.some((user) => user.id === state.currentIdentity)) {
      state.currentIdentity = state.config.users[0].id;
    }
    renderIdentity();
    renderInstanceList();
    renderDetail();
    if (payload.migrated.length) {
      toast(`已自动迁移 ${payload.migrated.length} 个 v1 实例`, 'success');
    }
  } catch (error) {
    handleError(error);
    els.detail.innerHTML = '<div class="notice">Worker 或 IndexedDB 初始化失败，请检查浏览器支持。</div>';
  }
}

init();
