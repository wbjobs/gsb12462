/* 主线程 UI：实例列表 / 详情 / 操作 / 回放 / 定义编辑
 * 所有状态变更通过 Worker 执行；回放使用主线程的 machine.js 纯函数折叠事件。
 */
(function () {
  'use strict';

  var M = window.ApprovalMachine;
  var diagram = window.ApprovalDiagram;

  /* ---------- Worker RPC ---------- */
  var worker = new Worker('js/worker.js');
  var reqSeq = 0;
  var pending = {};

  worker.onmessage = function (ev) {
    var msg = ev.data;
    var cb = pending[msg.reqId];
    if (cb) { delete pending[msg.reqId]; cb(msg); }
  };

  function call(op, data) {
    return new Promise(function (resolve, reject) {
      var reqId = ++reqSeq;
      pending[reqId] = function (msg) {
        if (msg.ok) resolve(msg);
        else reject(new Error(msg.error || '操作失败'));
      };
      worker.postMessage(Object.assign({ op: op, reqId: reqId }, data || {}));
    });
  }

  /* ---------- 全局 UI 状态 ---------- */
  var ui = {
    definition: null,        // 当前流程定义（新实例使用）
    instances: new Map(),    // id -> { state, degraded }
    selectedId: null,
    actor: null,             // 当前操作人
    replayAt: null           // null = 实时；数字 = 回放到第 N 个事件
  };

  var $ = function (sel) { return document.querySelector(sel); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtTime(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
  }

  function toast(msg, isErr) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.className = ''; }, 2600);
  }

  /* ---------- 渲染：实例列表 ---------- */
  function renderList() {
    var box = $('#instance-list');
    var items = Array.from(ui.instances.values())
      .sort(function (a, b) { return a.state.createdAt < b.state.createdAt ? 1 : -1; });
    if (!items.length) {
      box.innerHTML = '<div class="empty">暂无实例，点击「新建实例」开始</div>';
      return;
    }
    box.innerHTML = items.map(function (it) {
      var s = it.state;
      var cls = s.id === ui.selectedId ? 'item sel' : 'item';
      var badge = it.degraded ? '<span class="tag ro">只读</span>'
        : '<span class="tag st-' + esc(s.status) + '">' + statusText(s.status) + '</span>';
      return '<div class="' + cls + '" data-id="' + esc(s.id) + '">' +
        '<div class="t">' + esc(s.title) + '</div>' +
        '<div class="m">' + badge + '<span class="id">' + esc(s.id.slice(-8)) + '</span></div>' +
        '</div>';
    }).join('');
    box.querySelectorAll('.item').forEach(function (el) {
      el.onclick = function () { select(el.dataset.id); };
    });
  }

  function statusText(s) {
    return { draft: '草稿', running: '审批中', completed: '已完成', withdrawn: '已撤回', unknown: '未知' }[s] || s;
  }

  /* ---------- 渲染：详情（步骤 / 数据 / 时间线） ---------- */
  function currentEntry() { return ui.instances.get(ui.selectedId) || null; }

  function viewState() {
    var entry = currentEntry();
    if (!entry) return null;
    if (ui.replayAt == null || entry.degraded) return entry.state;
    return M.replay(entry.state, ui.replayAt);
  }

  function renderDetail() {
    var entry = currentEntry();
    var box = $('#detail');
    if (!entry) {
      box.innerHTML = '<div class="empty">请选择或新建一个审批实例</div>';
      $('#diagram-wrap').style.display = 'none';
      return;
    }
    $('#diagram-wrap').style.display = '';
    var s = viewState();
    var ro = entry.degraded;
    var replaying = ui.replayAt != null && !ro;

    var html = '';
    html += '<div class="detail-head">' +
      '<h2>' + esc(s.title) + (ro ? ' <span class="tag ro">版本不兼容·只读</span>' : '') +
      (replaying ? ' <span class="tag replay">回放中 #' + ui.replayAt + '</span>' : '') + '</h2>' +
      '<span class="tag st-' + esc(s.status) + '">' + statusText(s.status) + '</span></div>';

    // 步骤表
    html += '<table class="steps"><thead><tr><th>步骤</th><th>角色</th><th>状态</th><th>处理人</th><th>时间</th></tr></thead><tbody>';
    s.steps.forEach(function (st, i) {
      var cur = s.status === 'running' && i === s.stepIndex;
      html += '<tr class="' + (cur ? 'cur' : '') + '">' +
        '<td>' + esc(st.name) + '</td><td>' + esc(st.role) + '</td>' +
        '<td>' + stepStatusText(st.status) + '</td>' +
        '<td>' + esc(st.handler || '-') + '</td>' +
        '<td>' + fmtTime(st.time) + '</td></tr>';
    });
    html += '</tbody></table>';

    // 表单数据（驳回/撤回后保留）
    html += '<div class="data-block"><h3>表单数据</h3><pre>' +
      esc(Object.keys(s.data).length ? JSON.stringify(s.data, null, 2) : '（空）') + '</pre></div>';

    // 事件时间线
    html += '<div class="timeline"><h3>流转记录（' + s.events.length + '）</h3>';
    if (!s.events.length) html += '<div class="empty">暂无记录</div>';
    s.events.slice().reverse().forEach(function (e) {
      html += '<div class="ev"><span class="ev-act a-' + esc(e.type) + '">' + actionText(e.type) + '</span>' +
        '<span class="ev-actor">' + esc(e.actor) + '</span>' +
        '<span class="ev-time">' + fmtTime(e.time) + '</span>' +
        (e.payload && e.payload.comment ? '<div class="ev-c">“' + esc(e.payload.comment) + '”</div>' : '') +
        (e.payload && e.payload.to ? '<div class="ev-c">→ 转交给 ' + esc(e.payload.to) + '</div>' : '') +
        '</div>';
    });
    html += '</div>';
    box.innerHTML = html;

    renderActions(entry, s, ro || replaying);
    renderReplay(entry);
    diagram.draw($('#diagram'), s);
  }

  function stepStatusText(s) {
    return { pending: '待处理', active: '处理中', done: '已完成', approved: '已通过', rejected: '已驳回', returned: '被退回' }[s] || s;
  }

  function actionText(t) {
    return { SUBMIT: '提交', APPROVE: '通过', REJECT: '驳回', TRANSFER: '转交', WITHDRAW: '撤回' }[t] || t;
  }

  /* ---------- 渲染：操作区 ---------- */
  function renderActions(entry, s, locked) {
    var box = $('#actions');
    if (locked) {
      box.innerHTML = '<div class="empty">' +
        (entry.degraded ? '只读实例：状态版本高于当前支持的 v' + M.STATE_VERSION + '，已降级展示，数据未丢失。'
                        : '回放模式下不可操作，退出回放后可继续操作。') + '</div>';
      return;
    }
    var actor = ui.actor;
    var html = '';
    var canSubmit = (s.status === 'draft' || s.status === 'withdrawn' ||
      (s.status === 'running' && s.stepIndex === 0)) &&
      M.roleUsers(s, 0).indexOf(actor) >= 0;
    var isHandler = s.status === 'running' && s.stepIndex > 0 && s.steps[s.stepIndex].handler === actor;
    var canWithdraw = s.status === 'running' && M.roleUsers(s, 0).indexOf(actor) >= 0;

    if (canSubmit) {
      html += '<div class="act-row"><input id="f-item" placeholder="事项" value="差旅费报销">' +
        '<input id="f-amount" placeholder="金额" type="number" value="1000">' +
        '<button data-act="SUBMIT" class="primary">提交</button></div>';
    }
    if (isHandler) {
      html += '<div class="act-row"><input id="f-comment" placeholder="审批意见（驳回必填）">' +
        '<button data-act="APPROVE" class="ok">通过</button>' +
        '<button data-act="REJECT" class="danger">驳回</button>';
      var others = M.roleUsers(s, s.stepIndex).filter(function (u) { return u !== actor; });
      if (others.length) {
        html += '<select id="f-transfer">' + others.map(function (u) {
          return '<option>' + esc(u) + '</option>';
        }).join('') + '</select><button data-act="TRANSFER">转交</button>';
      }
      html += '</div>';
    }
    if (canWithdraw && s.stepIndex > 0) {
      html += '<div class="act-row"><button data-act="WITHDRAW" class="warn">撤回（申请人）</button></div>';
    }
    if (!html) html = '<div class="empty">当前用户「' + esc(actor) + '」在此状态下无可执行操作，请切换用户。</div>';
    box.innerHTML = html;

    box.querySelectorAll('button[data-act]').forEach(function (btn) {
      btn.onclick = function () { doAction(btn.dataset.act); };
    });
  }

  function doAction(type) {
    var payload = {};
    if (type === 'SUBMIT') {
      var item = $('#f-item').value.trim();
      var amount = Number($('#f-amount').value);
      if (!item || !(amount > 0)) { toast('请填写完整的事项与金额', true); return; }
      payload.data = { item: item, amount: amount };
    } else if (type === 'APPROVE' || type === 'REJECT') {
      payload.comment = ($('#f-comment').value || '').trim();
    } else if (type === 'TRANSFER') {
      payload.to = $('#f-transfer').value;
    }
    call('action', { instanceId: ui.selectedId, action: type, actor: ui.actor, payload: payload })
      .then(function (msg) {
        ui.instances.set(msg.state.id, { state: msg.state, degraded: false });
        ui.replayAt = null;
        renderAll();
        toast(actionText(type) + ' 成功');
      })
      .catch(function (err) { toast('非法流转：' + err.message, true); });
  }

  /* ---------- 渲染：回放控制 ---------- */
  function renderReplay(entry) {
    var box = $('#replay');
    var n = entry.state.events.length;
    if (!n || entry.degraded) { box.innerHTML = ''; return; }
    var at = ui.replayAt == null ? n : ui.replayAt;
    box.innerHTML = '<label>状态回放</label>' +
      '<input type="range" id="replay-slider" min="0" max="' + n + '" value="' + at + '">' +
      '<span id="replay-label">' + (ui.replayAt == null ? '实时' : at + ' / ' + n) + '</span>' +
      (ui.replayAt != null ? '<button id="replay-exit">退出回放</button>' : '');
    var slider = $('#replay-slider');
    slider.oninput = function () {
      var v = Number(slider.value);
      ui.replayAt = v >= n ? null : v;
      renderDetail();
    };
    var exit = $('#replay-exit');
    if (exit) exit.onclick = function () { ui.replayAt = null; renderDetail(); };
  }

  /* ---------- 渲染：用户切换 ---------- */
  function renderActors() {
    var sel = $('#actor');
    var users = [];
    Object.keys(ui.definition.roles).forEach(function (r) {
      ui.definition.roles[r].forEach(function (u) {
        if (users.indexOf(u) < 0) users.push(u);
      });
    });
    sel.innerHTML = users.map(function (u) {
      return '<option' + (u === ui.actor ? ' selected' : '') + '>' + esc(u) + '</option>';
    }).join('');
    if (!ui.actor || users.indexOf(ui.actor) < 0) ui.actor = users[0];
    sel.value = ui.actor;
  }

  function renderAll() { renderList(); renderDetail(); }

  function select(id) {
    ui.selectedId = id;
    ui.replayAt = null;
    renderAll();
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    $('#btn-new').onclick = function () {
      call('create', { title: '审批单-' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) })
        .then(function (msg) {
          ui.instances.set(msg.state.id, { state: msg.state, degraded: false });
          select(msg.state.id);
          toast('已创建实例');
        })
        .catch(function (e) { toast(e.message, true); });
    };

    $('#actor').onchange = function () {
      ui.actor = $('#actor').value;
      renderDetail();
    };

    $('#btn-apply-def').onclick = function () {
      try {
        var def = JSON.parse($('#def-editor').value);
        if (!Array.isArray(def.steps) || def.steps.length < 2) throw new Error('steps 至少需要 2 步');
        def.steps.forEach(function (s) {
          if (!s.id || !s.name || !s.role) throw new Error('每个 step 需要 id/name/role');
          if (!def.roles || !Array.isArray(def.roles[s.role]) || !def.roles[s.role].length) {
            throw new Error('角色 ' + s.role + ' 缺少成员（roles.' + s.role + '）');
          }
        });
        call('saveDefinition', { definition: def }).then(function () {
          ui.definition = def;
          renderActors();
          toast('流程定义已保存，新实例将使用新定义');
        });
      } catch (e) { toast('定义无效：' + e.message, true); }
    };

    $('#btn-reset-def').onclick = function () {
      $('#def-editor').value = JSON.stringify(M.DEFAULT_DEFINITION, null, 2);
    };

    $('#btn-seed-legacy').onclick = function () {
      call('seedLegacy').then(boot).then(function () {
        toast('已注入 v1 旧数据与 v99 未来数据（验证迁移/降级）');
      });
    };

    $('#btn-clear').onclick = function () {
      if (!confirm('确定清空所有本地数据？')) return;
      call('clearAll').then(function () {
        ui.instances.clear();
        ui.selectedId = null;
        ui.replayAt = null;
        return boot();
      }).then(function () { toast('存储已清空'); });
    };
  }

  /* ---------- 启动 ---------- */
  function boot() {
    return call('init').then(function (msg) {
      ui.definition = msg.definition;
      ui.instances.clear();
      msg.instances.forEach(function (it) {
        ui.instances.set(it.state.id, { state: it.state, degraded: it.degraded });
        if (it.migrated) toast('实例「' + it.state.title + '」已从 v1 迁移到 v' + M.STATE_VERSION);
      });
      $('#def-editor').value = JSON.stringify(ui.definition, null, 2);
      renderActors();
      if (!ui.selectedId && msg.instances.length) {
        ui.selectedId = msg.instances[0].state.id;
      }
      renderAll();
    });
  }

  bind();
  boot().catch(function (e) { toast('初始化失败：' + e.message, true); });
})();
