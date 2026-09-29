'use strict';

const CURRENT_VERSION = 2;
const DB_NAME = 'approval-flow-simulator';
const DB_VERSION = 2;
const STORE = 'instances';

const ROLES = {
  applicant: { id: 'applicant', name: '申请人' },
  manager: { id: 'manager', name: '直属经理' },
  director: { id: 'director', name: '部门总监' },
  finance: { id: 'finance', name: '财务' }
};

const USERS = [
  { id: 'u_zhang', name: '张三', roleId: 'applicant' },
  { id: 'u_li', name: '李四', roleId: 'applicant' },
  { id: 'm_chen', name: '陈经理', roleId: 'manager' },
  { id: 'm_zhou', name: '周经理', roleId: 'manager' },
  { id: 'd_wang', name: '王总监', roleId: 'director' },
  { id: 'f_zhao', name: '赵财务', roleId: 'finance' },
  { id: 'f_qian', name: '钱财务', roleId: 'finance' }
];

const STEPS = [
  { id: 'draft', name: '草稿填写', roleId: 'applicant', order: 0 },
  { id: 'manager', name: '经理审批', roleId: 'manager', order: 1 },
  { id: 'director', name: '总监审批', roleId: 'director', order: 2 },
  { id: 'finance', name: '财务复核', roleId: 'finance', order: 3 }
];

const STEP_BY_ID = Object.fromEntries(STEPS.map((step) => [step.id, step]));
const USERS_BY_ID = Object.fromEntries(USERS.map((user) => [user.id, user]));
const TERMINAL_STATES = new Set(['approved', 'rejected', 'withdrawn']);

class StateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StateError';
    this.code = code;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function required(value, message) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new StateError('VALIDATION_ERROR', message);
  }
}

function getUser(userId) {
  return USERS_BY_ID[userId] || null;
}

function step(stepId) {
  const found = STEP_BY_ID[stepId];
  if (!found) throw new StateError('INVALID_STEP', `未知步骤：${stepId}`);
  return found;
}

function nextApprovalStepId(stepId) {
  const current = step(stepId);
  return current.order < STEPS.length - 1 ? STEPS[current.order + 1].id : null;
}

function previousApprovalStepId(stepId) {
  const current = step(stepId);
  return current.order > 1 ? STEPS[current.order - 1].id : 'draft';
}

function nowIso() {
  return new Date().toISOString();
}

function eventBase(instanceId, actorId, type, payload = {}) {
  const actor = getUser(actorId);
  if (!actor) throw new StateError('INVALID_USER', `未知处理人：${actorId}`);
  return {
    id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
    instanceId,
    type,
    actorId,
    actorName: actor.name,
    at: nowIso(),
    schemaVersion: CURRENT_VERSION,
    payload: clone(payload)
  };
}

function initialSteps() {
  return STEPS.map((item) => ({
    id: item.id,
    name: item.name,
    roleId: item.roleId,
    status: item.id === 'draft' ? 'current' : 'pending',
    assigneeId: item.id === 'draft' ? null : null,
    assignedAt: null,
    processedAt: null,
    processedBy: null,
    returnCount: 0,
    note: ''
  }));
}

function initialState(instanceId, actorId, form) {
  const actor = getUser(actorId);
  return {
    id: instanceId,
    schemaVersion: CURRENT_VERSION,
    title: form.title,
    form: {
      title: form.title,
      amount: form.amount || '',
      reason: form.reason || ''
    },
    applicantId: actorId,
    applicantName: actor.name,
    status: 'draft',
    currentStep: 'draft',
    steps: initialSteps(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastEventId: null
  };
}

function stepIndex(state, stepId) {
  const index = state.steps.findIndex((item) => item.id === stepId);
  if (index < 0) throw new StateError('INVALID_STATE', `状态中缺少步骤：${stepId}`);
  return index;
}

function markCurrent(state, stepId, assigneeId = null, at = state.updatedAt) {
  state.steps.forEach((item) => {
    if (item.status === 'current') {
      item.status = 'pending';
      item.processedAt = at;
    }
  });
  const target = state.steps[stepIndex(state, stepId)];
  target.status = 'current';
  target.assigneeId = assigneeId;
  target.assignedAt = at;
}

function markApproved(state, stepId, event) {
  const target = state.steps[stepIndex(state, stepId)];
  target.status = 'approved';
  target.assigneeId = event.actorId;
  target.processedBy = event.actorId;
  target.processedAt = event.at;
  target.note = event.payload.comment || '';
}

function markReturned(state, stepId, event, toStepId) {
  state.steps.forEach((item) => {
    if (item.status === 'approved' && STEP_BY_ID[item.id]?.order > STEP_BY_ID[toStepId]?.order) {
      item.status = 'pending';
      item.processedAt = null;
      item.processedBy = null;
      item.note = '';
    }
  });
  markCurrent(state, toStepId, toStepId === 'draft' ? state.applicantId : null, event.at);
  const target = state.steps[stepIndex(state, stepId)];
  target.status = 'returned';
  target.returnCount += 1;
  target.processedBy = event.actorId;
  target.processedAt = event.at;
  target.note = event.payload.comment || '';
}

function setForm(state, form) {
  if (form.title !== undefined) {
    state.form.title = form.title;
    state.title = form.title;
  }
  if (form.amount !== undefined) state.form.amount = form.amount;
  if (form.reason !== undefined) state.form.reason = form.reason;
}

function assertApplicant(state, actorId, allowedStatuses) {
  const actor = getUser(actorId);
  if (!actor || actor.roleId !== 'applicant' || state.applicantId !== actorId) {
    throw new StateError('FORBIDDEN', '只有本实例申请人可以执行该操作');
  }
  if (!allowedStatuses.includes(state.status)) {
    throw new StateError('ILLEGAL_TRANSITION', '当前状态不允许该操作');
  }
}

function assertCurrentApprover(state, actorId) {
  const actor = getUser(actorId);
  const stepInfo = step(state.currentStep);
  const current = state.steps[stepIndex(state, state.currentStep)];
  if (!actor || actor.roleId !== stepInfo.roleId) {
    throw new StateError('FORBIDDEN', '当前步骤不属于该角色');
  }
  if (current.assigneeId && current.assigneeId !== actorId) {
    throw new StateError('FORBIDDEN', '该步骤已转交给其他处理人');
  }
}

function assertOpen(state) {
  if (TERMINAL_STATES.has(state.status)) {
    throw new StateError('TERMINAL_STATE', '实例已结束，不能继续流转');
  }
}

function validateForm(form, { partial = false } = {}) {
  const clean = {
    title: String(form.title || '').trim(),
    amount: String(form.amount || '').trim(),
    reason: String(form.reason || '').trim()
  };
  if (!partial || clean.title) {
    required(clean.title, '标题不能为空');
    if (clean.title.length > 80) throw new StateError('VALIDATION_ERROR', '标题不能超过 80 字');
  }
  if (clean.amount) {
    if (!/^\d+(\.\d{1,2})?$/.test(clean.amount)) {
      throw new StateError('VALIDATION_ERROR', '金额必须是最多两位小数的非负数字');
    }
  }
  if (clean.reason.length > 300) {
    throw new StateError('VALIDATION_ERROR', '事由不能超过 300 字');
  }
  return clean;
}

function validateCommand(command, state) {
  if (command.type === 'submit') {
    assertOpen(state);
    assertApplicant(state, command.actorId, ['draft', 'returned']);
    validateForm(state.form);
    return;
  }
  if (command.type === 'save_draft') {
    assertOpen(state);
    assertApplicant(state, command.actorId, ['draft', 'returned']);
    validateForm(command.form || {}, { partial: true });
    return;
  }
  if (command.type === 'approve' || command.type === 'reject') {
    assertOpen(state);
    if (!['pending', 'returned'].includes(state.status)) {
      throw new StateError('ILLEGAL_TRANSITION', '只有待审批或退回后的审批节点可以审批或驳回');
    }
    assertCurrentApprover(state, command.actorId);
    if (command.type === 'reject') required(command.comment, '驳回必须填写意见');
    return;
  }
  if (command.type === 'transfer') {
    assertOpen(state);
    if (!['pending', 'returned'].includes(state.status)) {
      throw new StateError('ILLEGAL_TRANSITION', '只有待审批步骤可以转交');
    }
    assertCurrentApprover(state, command.actorId);
    const target = getUser(command.targetUserId);
    const current = step(state.currentStep);
    if (!target || target.roleId !== current.roleId) {
      throw new StateError('INVALID_TRANSFEREE', '只能转交给同角色的其他处理人');
    }
    if (target.id === command.actorId) {
      throw new StateError('INVALID_TRANSFEREE', '不能转交给自己');
    }
    const assigned = state.steps[stepIndex(state, state.currentStep)].assigneeId;
    if (assigned && assigned !== command.actorId) {
      throw new StateError('FORBIDDEN', '当前处理人才能转交');
    }
    return;
  }
  if (command.type === 'withdraw') {
    assertOpen(state);
    assertApplicant(state, command.actorId, ['pending', 'returned']);
    if (state.status === 'returned' && state.currentStep !== 'draft') {
      throw new StateError('ILLEGAL_TRANSITION', '退回审批节点时只能由该节点处理，回到草稿后申请人才能撤回');
    }
    return;
  }
  throw new StateError('UNKNOWN_COMMAND', `未知命令：${command.type}`);
}

function commandToEvent(state, command) {
  validateCommand(command, state);
  const instanceId = state.id;
  if (command.type === 'save_draft') {
    return eventBase(instanceId, command.actorId, 'form_saved', { form: command.form });
  }
  if (command.type === 'submit') {
    return eventBase(instanceId, command.actorId, state.status === 'returned' ? 'resubmitted' : 'submitted', {});
  }
  if (command.type === 'approve') {
    return eventBase(instanceId, command.actorId, 'approved', { stepId: state.currentStep, comment: command.comment || '' });
  }
  if (command.type === 'reject') {
    return eventBase(instanceId, command.actorId, 'rejected', {
      stepId: state.currentStep,
      toStepId: previousApprovalStepId(state.currentStep),
      comment: command.comment
    });
  }
  if (command.type === 'transfer') {
    return eventBase(instanceId, command.actorId, 'transferred', {
      stepId: state.currentStep,
      fromUserId: command.actorId,
      toUserId: command.targetUserId,
      comment: command.comment || ''
    });
  }
  return eventBase(instanceId, command.actorId, 'withdrawn', {
    fromStepId: state.currentStep,
    comment: command.comment || ''
  });
}

function applyEvent(state, event) {
  const next = state ? clone(state) : null;
  if (event.type === 'created') {
    const created = initialState(event.instanceId, event.actorId, event.payload.form);
    created.createdAt = event.at;
    created.updatedAt = event.at;
    created.lastEventId = event.id;
    return created;
  }
  if (!next) throw new StateError('INVALID_EVENT', `事件 ${event.type} 缺少初始状态`);
  next.updatedAt = event.at;
  next.lastEventId = event.id;

  if (event.type === 'form_saved') {
    setForm(next, event.payload.form);
    return next;
  }
  if (event.type === 'submitted') {
    setForm(next, event.payload.form || {});
    next.status = 'pending';
    next.currentStep = 'manager';
    markCurrent(next, 'manager', null, event.at);
    return next;
  }
  if (event.type === 'resubmitted') {
    const target = event.payload.toStepId || nextApprovalStepId(next.currentStep);
    next.status = 'pending';
    next.currentStep = target;
    markCurrent(next, target, null, event.at);
    next.steps.forEach((item) => {
      if (item.status === 'returned') {
        item.status = STEP_BY_ID[item.id]?.order < STEP_BY_ID[target]?.order ? 'approved' : 'pending';
        if (item.status === 'approved') item.processedAt = event.at;
      }
    });
    return next;
  }
  if (event.type === 'approved') {
    const approvedStep = event.payload.stepId;
    markApproved(next, approvedStep, event);
    const target = nextApprovalStepId(approvedStep);
    if (target) {
      next.status = 'pending';
      next.currentStep = target;
      markCurrent(next, target, null, event.at);
    } else {
      next.status = 'approved';
      next.currentStep = null;
    }
    return next;
  }
  if (event.type === 'rejected') {
    markReturned(next, event.payload.stepId, event, event.payload.toStepId);
    next.status = 'returned';
    next.currentStep = event.payload.toStepId;
    return next;
  }
  if (event.type === 'transferred') {
    const targetStep = next.steps[stepIndex(next, event.payload.stepId)];
    targetStep.assigneeId = event.payload.toUserId;
    targetStep.assignedAt = event.at;
    targetStep.note = `由 ${event.actorName} 转交`;
    return next;
  }
  if (event.type === 'withdrawn') {
    next.steps.forEach((item) => {
      if (item.status === 'current') {
        item.status = 'withdrawn';
        item.processedBy = event.actorId;
        item.processedAt = event.at;
      }
    });
    next.status = 'withdrawn';
    next.currentStep = null;
    return next;
  }
  throw new StateError('INVALID_EVENT', `未知事件：${event.type}`);
}

function replayEvents(events, baseState = null) {
  return events.reduce((state, event) => applyEvent(state, event), baseState);
}

function makeCreateEvent(command) {
  const actor = getUser(command.actorId);
  if (!actor || actor.roleId !== 'applicant') {
    throw new StateError('FORBIDDEN', '只有申请人角色可以创建申请');
  }
  const form = validateForm(command.form || {});
  const event = eventBase(`inst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, command.actorId, 'created', { form });
  event.payload.form = form;
  return event;
}

function recordSummary(record) {
  const version = record?.schemaVersion ?? record?.version;
  if (!record || version > CURRENT_VERSION) {
    return {
      id: record?.id || 'unknown',
      title: record?.snapshot?.title || record?.title || '未知版本实例',
      status: 'unknown',
      currentStep: null,
      applicantName: record?.snapshot?.applicantName || '未知',
      updatedAt: record?.snapshot?.updatedAt || '',
      compatibility: 'future'
    };
  }
  const state = record.snapshot;
  if (!state || state.id !== record.id) {
    return {
      id: record.id,
      title: record.title || '损坏实例',
      status: 'unknown',
      currentStep: null,
      applicantName: '未知',
      updatedAt: record.snapshot?.updatedAt || '',
      compatibility: 'broken'
    };
  }
  return {
    id: state.id,
    title: state.title,
    status: state.status,
    currentStep: state.currentStep,
    applicantName: state.applicantName,
    updatedAt: state.updatedAt,
    compatibility: 'current'
  };
}

const OLD_USERS = {
   zhang_san: 'u_zhang',
   li_si: 'u_li',
   chen_jingli: 'm_chen',
   zhou_jingli: 'm_zhou',
   wang_zongjian: 'd_wang',
   zhao_caiwu: 'f_zhao',
   qian_caiwu: 'f_qian'
};

const OLD_STEPS = {
  draft: 'draft',
  manager: 'manager',
  director: 'director',
  finance: 'finance',
  '草稿': 'draft',
  '经理': 'manager',
  '经理审批': 'manager',
  '总监': 'director',
  '总监审批': 'director',
  '财务': 'finance',
  '财务复核': 'finance'
};

const OLD_ACTIONS = {
  create: 'created',
  created: 'created',
  draft: 'created',
  submit: 'submitted',
  submitted: 'submitted',
  approve: 'approved',
  approved: 'approved',
  approval: 'approved',
  reject: 'rejected',
  rejected: 'rejected',
  return: 'rejected',
  transfer: 'transferred',
  transferred: 'transferred',
  withdraw: 'withdrawn',
  withdrawn: 'withdrawn',
  resubmit: 'resubmitted',
  resubmitted: 'resubmitted'
};

function mapOldUser(id, roleId) {
  if (USERS_BY_ID[id]) return id;
  if (OLD_USERS[id]) return OLD_USERS[id];
  if (roleId) {
    const fallback = USERS.find((user) => user.roleId === roleId);
    if (fallback) return fallback.id;
  }
  return null;
}

function mapOldStep(id) {
  if (!id) return null;
  return OLD_STEPS[id] || OLD_STEPS[String(id).trim()] || null;
}

function oldEventId(oldRecord, index) {
  return `migrated_${oldRecord.id}_${index}`;
}

function migrationBaseEvent(oldRecord, oldEvent, index, type, payload) {
  const roleId = oldEvent.byRole || oldEvent.actorRole || null;
  const actorId = mapOldUser(oldEvent.by || oldEvent.actorId || oldEvent.userId, roleId);
  if (!actorId) return null;
  return {
    id: oldEventId(oldRecord, index),
    instanceId: oldRecord.id,
    type,
    actorId,
    actorName: getUser(actorId).name,
    at: oldEvent.at || new Date(2024, 0, 1 + index).toISOString(),
    schemaVersion: CURRENT_VERSION,
    migratedFrom: 1,
    payload
  };
}

function migrateV1Record(oldRecord) {
  if (!oldRecord || oldRecord.version !== 1 || !Array.isArray(oldRecord.history)) {
    throw new StateError('INVALID_RECORD', 'v1 记录缺少 version 或 history 字段');
  }
  const form = {
    title: String(oldRecord.data?.title || oldRecord.title || '迁移的审批').trim(),
    amount: String(oldRecord.data?.amount ?? '').trim(),
    reason: String(oldRecord.data?.reason ?? '').trim()
  };
  const applicantId = mapOldUser(oldRecord.applicant || oldRecord.data?.applicant, 'applicant');
  if (!applicantId) throw new StateError('INVALID_RECORD', 'v1 记录缺少有效申请人');
  const events = [];
  let state = null;

  oldRecord.history.forEach((rawEvent, index) => {
    const action = OLD_ACTIONS[String(rawEvent.action || rawEvent.type || '').toLowerCase()];
    if (!action) return;
    let event = null;
    if (action === 'created') {
      event = migrationBaseEvent(oldRecord, rawEvent, index, 'created', { form });
      if (event && event.actorId !== applicantId) {
        event.actorId = applicantId;
        event.actorName = getUser(applicantId).name;
      }
    } else if (!state) {
      return;
    } else if (action === 'submitted') {
      event = migrationBaseEvent(oldRecord, rawEvent, index, 'submitted', {});
    } else if (action === 'resubmitted') {
      event = migrationBaseEvent(oldRecord, rawEvent, index, 'resubmitted', {
        toStepId: nextApprovalStepId(state.currentStep)
      });
    } else if (action === 'approved') {
      event = migrationBaseEvent(oldRecord, rawEvent, index, 'approved', {
        stepId: mapOldStep(rawEvent.step || rawEvent.stepId) || state.currentStep,
        comment: rawEvent.comment || ''
      });
    } else if (action === 'rejected') {
      const fromStep = mapOldStep(rawEvent.step || rawEvent.stepId) || state.currentStep;
      event = migrationBaseEvent(oldRecord, rawEvent, index, 'rejected', {
        stepId: fromStep,
        toStepId: mapOldStep(rawEvent.toStep || rawEvent.toStepId) || previousApprovalStepId(fromStep),
        comment: rawEvent.comment || 'v1 数据迁移：驳回'
      });
    } else if (action === 'transferred') {
      const fromStep = mapOldStep(rawEvent.step || rawEvent.stepId) || state.currentStep;
      const stepRole = step(fromStep).roleId;
      const toUserId = mapOldUser(rawEvent.toUser || rawEvent.assignee || rawEvent.toUserId, stepRole);
      if (!toUserId || toUserId === state.steps.find((item) => item.id === fromStep)?.assigneeId) return;
      const actorId = mapOldUser(rawEvent.by || rawEvent.actorId || rawEvent.userId, stepRole);
      if (!actorId) return;
      event = migrationBaseEvent(oldRecord, rawEvent, index, 'transferred', {
        stepId: fromStep,
        fromUserId: actorId,
        toUserId,
        comment: rawEvent.comment || ''
      });
    } else if (action === 'withdrawn') {
      event = migrationBaseEvent(oldRecord, rawEvent, index, 'withdrawn', {
        fromStepId: state.currentStep,
        comment: rawEvent.comment || ''
      });
    }
    if (!event) return;
    state = applyEvent(state, event);
    events.push(event);
  });

  if (!state) throw new StateError('INVALID_RECORD', 'v1 历史事件无法还原为有效状态');
  return {
    id: oldRecord.id,
    schemaVersion: CURRENT_VERSION,
    snapshot: state,
    events,
    migratedFrom: 1,
    migratedAt: nowIso()
  };
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('schemaVersion', 'schemaVersion', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let dbPromise = null;
function db() {
  if (!dbPromise) dbPromise = openDB();
  return dbPromise;
}

function tx(storeName, mode) {
  return db().then((database) => database.transaction(storeName, mode).objectStore(storeName));
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getAllRecords() {
  return tx(STORE, 'readonly').then((store) => idbRequest(store.getAll()));
}

function getRecord(id) {
  return tx(STORE, 'readonly').then((store) => idbRequest(store.get(id)));
}

function putRecord(record) {
  return tx(STORE, 'readwrite').then((store) => idbRequest(store.put(clone(record))));
}

function clearRecords() {
  return tx(STORE, 'readwrite').then((store) => idbRequest(store.clear()));
}

function getMeta(key) {
  return tx('meta', 'readonly').then((store) => idbRequest(store.get(key)));
}

function putMeta(key, value) {
  return tx('meta', 'readwrite').then((store) => idbRequest(store.put({ key, value })));
}

function deleteMeta(key) {
  return tx('meta', 'readwrite').then((store) => idbRequest(store.delete(key)));
}

function seedEvent(id, instanceId, type, actorId, at, payload) {
  const event = eventBase(instanceId, actorId, type, payload);
  event.id = id;
  event.at = at;
  return event;
}

function makeSeeds() {
  const records = [];
  const first = {
    id: 'inst-seed-pending-manager',
    title: '差旅报销：北京客户拜访'
  };
  let events = [
    seedEvent('evt-seed-1', first.id, 'created', 'u_zhang', '2026-09-20T01:00:00.000Z', {
      form: { title: first.title, amount: '1280.50', reason: '往返高铁和住宿费用' }
    }),
    seedEvent('evt-seed-2', first.id, 'submitted', 'u_zhang', '2026-09-20T01:10:00.000Z', {})
  ];
  records.push({ id: first.id, schemaVersion: CURRENT_VERSION, snapshot: replayEvents(events), events });

  const second = { id: 'inst-seed-finance-transfer', title: '设备采购：测试平板' };
  events = [
    seedEvent('evt-seed-3', second.id, 'created', 'u_li', '2026-09-21T02:00:00.000Z', {
      form: { title: second.title, amount: '8999', reason: '研发测试设备' }
    }),
    seedEvent('evt-seed-4', second.id, 'submitted', 'u_li', '2026-09-21T02:05:00.000Z', {}),
    seedEvent('evt-seed-5', second.id, 'approved', 'm_chen', '2026-09-21T03:00:00.000Z', {
      stepId: 'manager', comment: '预算内，同意'
    }),
    seedEvent('evt-seed-6', second.id, 'approved', 'd_wang', '2026-09-21T05:00:00.000Z', {
      stepId: 'director', comment: '同意采购'
    }),
    seedEvent('evt-seed-7', second.id, 'transferred', 'f_zhao', '2026-09-21T06:00:00.000Z', {
      stepId: 'finance', fromUserId: 'f_zhao', toUserId: 'f_qian', comment: '请钱财务复核发票信息'
    })
  ];
  records.push({ id: second.id, schemaVersion: CURRENT_VERSION, snapshot: replayEvents(events), events });

  const third = { id: 'inst-seed-returned-draft', title: '团建费用申请' };
  events = [
    seedEvent('evt-seed-8', third.id, 'created', 'u_zhang', '2026-09-22T08:00:00.000Z', {
      form: { title: third.title, amount: '6000', reason: '季度团建' }
    }),
    seedEvent('evt-seed-9', third.id, 'submitted', 'u_zhang', '2026-09-22T08:10:00.000Z', {}),
    seedEvent('evt-seed-10', third.id, 'rejected', 'm_zhou', '2026-09-22T09:00:00.000Z', {
      stepId: 'manager', toStepId: 'draft', comment: '请补充参与人员和预算明细'
    })
  ];
  records.push({ id: third.id, schemaVersion: CURRENT_VERSION, snapshot: replayEvents(events), events });

  const fourth = { id: 'inst-seed-approved', title: '在线课程订阅' };
  events = [
    seedEvent('evt-seed-11', fourth.id, 'created', 'u_li', '2026-09-18T01:00:00.000Z', {
      form: { title: fourth.title, amount: '299', reason: '前端安全课程' }
    }),
    seedEvent('evt-seed-12', fourth.id, 'submitted', 'u_li', '2026-09-18T01:10:00.000Z', {}),
    seedEvent('evt-seed-13', fourth.id, 'approved', 'm_chen', '2026-09-18T02:00:00.000Z', {
      stepId: 'manager', comment: '同意'
    }),
    seedEvent('evt-seed-14', fourth.id, 'approved', 'd_wang', '2026-09-18T03:00:00.000Z', {
      stepId: 'director', comment: '同意'
    }),
    seedEvent('evt-seed-15', fourth.id, 'approved', 'f_zhao', '2026-09-18T04:00:00.000Z', {
      stepId: 'finance', comment: '付款完成'
    })
  ];
  records.push({ id: fourth.id, schemaVersion: CURRENT_VERSION, snapshot: replayEvents(events), events });
  return records;
}

function decorateRecord(record) {
  if (!record) return null;
  const version = record.schemaVersion ?? record.version;
  if (version > CURRENT_VERSION) {
    return clone({ ...record, compatibility: 'future', warnings: ['该实例来自更新版本，当前版本仅只读展示，不会写入或执行状态流转。'] });
  }
  if (version < 1) {
    return clone({ ...record, compatibility: 'unsupported', warnings: ['未知的旧版本数据，当前版本无法安全迁移。'] });
  }
  if (version === 1) {
    return clone({ ...record, compatibility: 'needs-migration' });
  }
  try {
    if (!Array.isArray(record.events) || !record.events.length) {
      return clone({ ...record, compatibility: 'broken', warnings: ['事件日志缺失，无法验证快照。'] });
    }
    const rebuilt = replayEvents(record.events);
    const same = JSON.stringify(rebuilt) === JSON.stringify(record.snapshot);
    return clone({
      ...record,
      compatibility: same ? 'current' : 'rebuilt',
      warnings: same ? [] : ['快照与事件日志不一致，已以事件日志为准重建。']
    });
  } catch (error) {
    return clone({ ...record, compatibility: 'broken', warnings: [`事件日志损坏：${error.message}`] });
  }
}

function assertWritableRecord(record) {
  if (!record) throw new StateError('NOT_FOUND', '实例不存在');
  const version = record.schemaVersion ?? record.version;
  if (version > CURRENT_VERSION) {
    throw new StateError('FUTURE_VERSION', '未来版本实例已降级为只读，不能在当前版本执行操作');
  }
  if (version === 1) {
    throw new StateError('NEEDS_MIGRATION', 'v1 实例尚未迁移');
  }
  if (version !== CURRENT_VERSION) {
    throw new StateError('UNSUPPORTED_VERSION', '不支持的实例版本');
  }
  if (!Array.isArray(record.events) || !record.events.length) {
    throw new StateError('BROKEN_EVENT_LOG', '事件日志缺失，拒绝写入');
  }
  replayEvents(record.events);
}

async function bootstrap() {
  let records = await getAllRecords();
  const migrated = [];

  for (const record of records) {
    const version = record.schemaVersion ?? record.version;
    if (version === 1) {
      const migratedRecord = migrateV1Record(record);
      await putRecord(migratedRecord);
      migrated.push(migratedRecord.id);
    } else if (version === CURRENT_VERSION && Array.isArray(record.events)?.length) {
      try {
        const rebuilt = replayEvents(record.events);
        if (JSON.stringify(rebuilt) !== JSON.stringify(record.snapshot)) {
          await putRecord({ ...record, snapshot: rebuilt });
        }
      } catch (_) {
        // 损坏的事件日志保留原样，decorateRecord 会提示风险。
      }
    }
  }

  if (records.length === 0) {
    const seededMeta = await getMeta('seededAt');
    if (!seededMeta) {
      const seeds = makeSeeds();
      await Promise.all(seeds.map(putRecord));
      await putMeta('seededAt', nowIso());
      records = seeds;
    }
  }

  const fresh = await getAllRecords();
  return {
    config: { currentVersion: CURRENT_VERSION, roles: ROLES, users: USERS, steps: STEPS },
    instances: fresh.map(recordSummary),
    details: Object.fromEntries(fresh.map((record) => [record.id, decorateRecord(record)])),
    migrated
  };
}

async function listInstances() {
  const records = await getAllRecords();
  return {
    instances: records.map(recordSummary),
    details: Object.fromEntries(records.map((record) => [record.id, decorateRecord(record)]))
  };
}

async function createInstance(command) {
  const created = makeCreateEvent(command);
  const snapshot = applyEvent(null, created);
  const record = { id: created.instanceId, schemaVersion: CURRENT_VERSION, snapshot, events: [created] };
  await putRecord(record);
  return { record: decorateRecord(record) };
}

async function executeCommand(command) {
  const stored = await getRecord(command.instanceId);
  assertWritableRecord(stored);
  let state = replayEvents(stored.events);
  const event = commandToEvent(state, command);
  state = applyEvent(state, event);
  const record = {
    ...stored,
    schemaVersion: CURRENT_VERSION,
    snapshot: state,
    events: [...stored.events, event]
  };
  await putRecord(record);
  return { record: decorateRecord(record), event };
}

async function replayInstance(instanceId) {
  const stored = await getRecord(instanceId);
  if (!stored) throw new StateError('NOT_FOUND', '实例不存在');
  const version = stored.schemaVersion ?? stored.version;
  if (version !== CURRENT_VERSION) {
    throw new StateError('UNSUPPORTED_REPLAY', '只有当前版本实例可以从事件日志回放');
  }
  let state = null;
  const frames = stored.events.map((event) => {
    state = applyEvent(state, event);
    return { eventId: event.id, event, state: clone(state) };
  });
  const current = replayEvents(stored.events);
  return {
    frames,
    snapshotMatches: JSON.stringify(current) === JSON.stringify(stored.snapshot),
    storedSnapshot: stored.snapshot,
    rebuiltSnapshot: current
  };
}

async function importRaw(record) {
  const existing = await getRecord(record.id);
  if (existing) throw new StateError('DUPLICATE_ID', '已存在相同 ID 的实例');
  if ((record.schemaVersion ?? record.version) === 1) {
    const migrated = migrateV1Record(record);
    await putRecord(migrated);
    return { record: decorateRecord(migrated) };
  }
  await putRecord(record);
  const stored = await getRecord(record.id);
  return { record: decorateRecord(stored) };
}

self.onmessage = async (message) => {
  const data = message.data || {};
  const reqId = data.reqId;
  try {
    let payload;
    switch (data.type) {
      case 'bootstrap':
        payload = await bootstrap();
        break;
      case 'list':
        payload = await listInstances();
        break;
      case 'get':
        payload = { record: decorateRecord(await getRecord(data.instanceId)) };
        break;
      case 'create':
        payload = await createInstance(data.command);
        break;
      case 'execute':
        payload = await executeCommand(data.command);
        break;
      case 'replay':
        payload = await replayInstance(data.instanceId);
        break;
      case 'export':
        payload = { records: await getAllRecords() };
        break;
      case 'import-raw':
        payload = await importRaw(data.record);
        break;
      case 'clear':
        await clearRecords();
        await deleteMeta('seededAt');
        payload = { cleared: true };
        break;
      default:
        throw new StateError('UNKNOWN_MESSAGE', `未知消息：${data.type}`);
    }
    self.postMessage({ reqId, ok: true, payload });
  } catch (error) {
    self.postMessage({
      reqId,
      ok: false,
      error: { code: error.code || 'WORKER_ERROR', message: error.message || String(error) }
    });
  }
};
