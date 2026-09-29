/* 审批流状态机核心（纯逻辑，无 DOM/IDB 依赖）
 * 同时被 Web Worker（js/worker.js）与主线程（状态回放）使用。
 * 采用事件溯源：实例的 events 数组是唯一事实来源，任意时刻状态可由事件折叠重建。
 */
(function (global) {
  'use strict';

  var STATE_VERSION = 2; // 当前状态结构版本

  /* ---------- 默认流程定义 ---------- */
  var DEFAULT_DEFINITION = {
    name: '费用报销审批',
    steps: [
      { id: 'submit',  name: '提交申请', role: 'applicant' },
      { id: 'dept',    name: '部门审批', role: 'dept_manager' },
      { id: 'finance', name: '财务审批', role: 'finance' },
      { id: 'ceo',     name: '总经理审批', role: 'ceo' }
    ],
    roles: {
      applicant:    ['张三', '李四'],
      dept_manager: ['王经理'],
      finance:      ['赵会计'],
      ceo:          ['钱总']
    }
  };

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
  function now() { return new Date().toISOString(); }

  /* ---------- 实例创建 ---------- */
  function createInstance(def, id, title) {
    var t = now();
    return {
      v: STATE_VERSION,
      id: id,
      title: title || ('审批单 ' + id.slice(-4)),
      def: clone(def),               // 定义快照：多实例互不干扰，定义修改不影响在途实例
      stepIndex: 0,                  // 当前所在步骤（0 = 提交步骤）
      status: 'draft',               // draft | running | completed | withdrawn
      data: {},                      // 业务表单数据（驳回后保留）
      steps: def.steps.map(function (s) {
        return { id: s.id, name: s.name, role: s.role, status: 'pending', handler: null, time: null };
      }),
      events: [],                    // 事件日志（回放依据）
      createdAt: t,
      updatedAt: t
    };
  }

  /* ---------- 流转规则表 ----------
   * 每个动作声明：允许的前置状态 + 校验 + 应用。
   * 校验失败抛 Error，Worker 捕获后返回非法流转错误。 */
  function roleUsers(state, stepIdx) {
    var role = state.def.steps[stepIdx].role;
    return (state.def.roles[role] || []).slice();
  }

  function assert(cond, msg) { if (!cond) throw new Error(msg); }

  var ACTIONS = {
    SUBMIT: {
      // 提交 / 驳回后重新提交 / 撤回后重新提交
      validate: function (state, e) {
        assert(state.status === 'draft' || state.status === 'withdrawn' ||
               (state.status === 'running' && state.stepIndex === 0),
               '当前状态不允许提交');
        assert(roleUsers(state, 0).indexOf(e.actor) >= 0, e.actor + ' 不是「提交申请」步骤的角色成员');
        assert(e.payload && e.payload.data && Object.keys(e.payload.data).length > 0, '提交数据不能为空');
      },
      apply: function (state, e) {
        state.data = clone(e.payload.data);   // 重新提交会覆盖表单，但历史事件保留
        state.status = 'running';
        state.steps[0].status = 'done';
        state.steps[0].handler = e.actor;
        state.steps[0].time = e.time;
        moveTo(state, 1, e.time);
      }
    },
    APPROVE: {
      validate: function (state, e) {
        assert(state.status === 'running', '流程未在审批中，无法通过');
        assert(state.stepIndex > 0, '提交步骤无需审批');
        assert(state.steps[state.stepIndex].handler === e.actor,
               '当前处理人是 ' + state.steps[state.stepIndex].handler + '，' + e.actor + ' 无权审批');
      },
      apply: function (state, e) {
        var i = state.stepIndex;
        state.steps[i].status = 'approved';
        state.steps[i].time = e.time;
        if (i === state.steps.length - 1) {
          state.status = 'completed';
          state.stepIndex = i; // 停留末步
        } else {
          moveTo(state, i + 1, e.time);
        }
      }
    },
    REJECT: {
      validate: function (state, e) {
        assert(state.status === 'running', '流程未在审批中，无法驳回');
        assert(state.stepIndex > 0, '提交步骤不能驳回');
        assert(state.steps[state.stepIndex].handler === e.actor,
               '当前处理人是 ' + state.steps[state.stepIndex].handler + '，' + e.actor + ' 无权驳回');
        assert(e.payload && e.payload.comment, '驳回必须填写意见');
      },
      apply: function (state, e) {
        var i = state.stepIndex;
        state.steps[i].status = 'rejected';
        state.steps[i].time = e.time;
        // 回到上一步；表单数据 state.data 原样保留
        var prev = i - 1;
        state.stepIndex = prev;
        state.steps[prev].status = prev === 0 ? 'returned' : 'returned';
        // 上一步处理人恢复为历史处理人（数据保留：不清空 handler）
      }
    },
    TRANSFER: {
      validate: function (state, e) {
        assert(state.status === 'running', '流程未在审批中，无法转交');
        assert(state.stepIndex > 0, '提交步骤不能转交');
        assert(state.steps[state.stepIndex].handler === e.actor, '只有当前处理人可以转交');
        var to = e.payload && e.payload.to;
        assert(to, '必须指定转交对象');
        assert(roleUsers(state, state.stepIndex).indexOf(to) >= 0,
               to + ' 不是当前步骤角色的成员，不能转交');
        assert(to !== e.actor, '不能转交给自己');
      },
      apply: function (state, e) {
        // 只换处理人，步骤状态/数据/时间均不变 —— 转交不破坏状态
        state.steps[state.stepIndex].handler = e.payload.to;
      }
    },
    WITHDRAW: {
      validate: function (state, e) {
        assert(state.status === 'running', '只有审批中的流程可以撤回');
        assert(roleUsers(state, 0).indexOf(e.actor) >= 0, '只有申请人可以撤回');
      },
      apply: function (state, e) {
        // 撤回到草稿：步骤进度保留在事件日志中，当前步骤重置为待提交
        state.status = 'withdrawn';
        state.stepIndex = 0;
        state.steps[0].status = 'pending';
        // 数据 state.data 保留，重新提交时可修改
      }
    }
  };

  function moveTo(state, idx, time) {
    state.stepIndex = idx;
    var st = state.steps[idx];
    st.status = 'active';
    st.handler = roleUsers(state, idx)[0] || null; // 默认指派角色第一人，可转交
    st.time = time;
  }

  /* ---------- 应用单个事件（校验 + 迁移） ---------- */
  function applyEvent(state, e) {
    var action = ACTIONS[e.type];
    if (!action) throw new Error('未知动作: ' + e.type);
    action.validate(state, e);
    var from = state.stepIndex;
    action.apply(state, e);
    e.fromStep = from;
    e.toStep = state.stepIndex;
    e.seq = state.events.length;
    state.events.push(e);
    state.updatedAt = e.time;
    return state;
  }

  /* ---------- 回放：从初始状态折叠前 n 个事件 ---------- */
  function replay(instance, upto) {
    var state = createInstance(instance.def, instance.id, instance.title);
    var n = Math.min(upto == null ? instance.events.length : upto, instance.events.length);
    for (var k = 0; k < n; k++) {
      var e = instance.events[k];
      var action = ACTIONS[e.type];
      if (!action) throw new Error('回放失败：未知动作 ' + e.type);
      // 回放时不重复校验角色动态数据（定义可能已改），直接 apply
      action.apply(state, clone(e));
      state.events.push(e);
    }
    state.updatedAt = n > 0 ? instance.events[n - 1].time : state.createdAt;
    return state;
  }

  /* ---------- 版本迁移 ----------
   * v1 -> v2：v1 没有 steps 快照与 def 快照，只有 stepIndex/status/data/history。
   * 更高版本：无法识别，返回降级只读视图。 */
  function migrate(record, currentDef) {
    if (record.v === STATE_VERSION) return { state: record, degraded: false };
    if (record.v === 1) {
      var def = record.def || currentDef || DEFAULT_DEFINITION;
      var state = createInstance(def, record.id, record.title);
      state.status = record.status || 'draft';
      state.stepIndex = typeof record.stepIndex === 'number' ? record.stepIndex : 0;
      state.data = record.data || {};
      state.events = record.events || [];
      state.createdAt = record.createdAt || now();
      state.updatedAt = record.updatedAt || state.createdAt;
      // 尽力恢复步骤状态
      state.steps.forEach(function (s, i) {
        if (state.status === 'completed' || i < state.stepIndex) s.status = 'done';
        else if (i === state.stepIndex && state.status === 'running') s.status = 'active';
      });
      state.v = STATE_VERSION;
      state.migratedFrom = 1;
      return { state: state, degraded: false, migrated: true };
    }
    // 未知更高版本：降级为只读视图，不丢数据
    return {
      state: {
        v: record.v, id: record.id, title: (record.title || record.id) + '（只读）',
        status: record.status || 'unknown', stepIndex: -1, data: record.data || {},
        steps: [], events: [], def: currentDef || DEFAULT_DEFINITION,
        createdAt: record.createdAt || now(), updatedAt: record.updatedAt || now()
      },
      degraded: true
    };
  }

  global.ApprovalMachine = {
    STATE_VERSION: STATE_VERSION,
    DEFAULT_DEFINITION: DEFAULT_DEFINITION,
    createInstance: createInstance,
    applyEvent: applyEvent,
    replay: replay,
    migrate: migrate,
    roleUsers: roleUsers
  };
})(typeof self !== 'undefined' ? self : this);
