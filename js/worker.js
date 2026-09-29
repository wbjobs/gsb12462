/* Web Worker：审批状态机引擎
 * 职责：
 *  - 所有状态变更在此串行执行（多实例互不干扰，按 instanceId 隔离）
 *  - 校验流转合法性，非法流转返回错误，不落库
 *  - 事件追加后整体持久化到 IndexedDB（状态可序列化、可回放）
 */
importScripts('machine.js', 'db.js');

var M = self.ApprovalMachine;
var DB = self.ApprovalDB;

/* 内存缓存：实例状态。以 id 为 key，实例间完全隔离。 */
var cache = {};

function loadState(id) {
  if (cache[id]) return Promise.resolve(cache[id]);
  return DB.getInstance(id).then(function (raw) {
    if (!raw) return null;
    var r = M.migrate(raw, null);
    cache[id] = r.state;
    return cache[id];
  });
}

function persist(state) {
  // 存的是可 JSON 序列化的纯对象
  return DB.putInstance(JSON.parse(JSON.stringify(state)));
}

function reply(msg, extra) {
  var out = { reqId: msg.reqId, op: msg.op };
  for (var k in extra) out[k] = extra[k];
  self.postMessage(out);
}

self.onmessage = function (ev) {
  var msg = ev.data;
  var p;

  switch (msg.op) {
    case 'init':
      p = DB.allInstances().then(function (rows) {
        var list = rows.map(function (raw) {
          var r = M.migrate(raw, null);
          cache[r.state.id] = r.state;
          return { state: r.state, degraded: r.degraded, migrated: !!r.migrated };
        });
        // 迁移成功的记录回写新版本
        list.forEach(function (item) {
          if (item.migrated && !item.degraded) persist(item.state);
        });
        return DB.getMeta('definition').then(function (def) {
          reply(msg, { ok: true, instances: list, definition: def || M.DEFAULT_DEFINITION });
        });
      });
      break;

    case 'create':
      p = DB.getMeta('definition').then(function (def) {
        var d = def || M.DEFAULT_DEFINITION;
        var id = 'inst-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
        var state = M.createInstance(d, id, msg.title);
        cache[id] = state;
        return persist(state).then(function () {
          reply(msg, { ok: true, state: state });
        });
      });
      break;

    case 'saveDefinition':
      p = DB.setMeta('definition', msg.definition).then(function () {
        reply(msg, { ok: true });
      });
      break;

    case 'action': {
      // 状态变更：SUBMIT / APPROVE / REJECT / TRANSFER / WITHDRAW
      p = loadState(msg.instanceId).then(function (state) {
        if (!state) throw new Error('实例不存在: ' + msg.instanceId);
        if (state.v !== M.STATE_VERSION) throw new Error('该实例为只读（版本不兼容），不能执行操作');
        var e = {
          type: msg.action,
          actor: msg.actor,
          payload: msg.payload || {},
          time: new Date().toISOString()
        };
        M.applyEvent(state, e); // 校验失败会抛错，不会落库
        return persist(state).then(function () {
          reply(msg, { ok: true, state: state, event: e });
        });
      });
      break;
    }

    case 'get':
      p = loadState(msg.instanceId).then(function (state) {
        reply(msg, { ok: !!state, state: state });
      });
      break;

    case 'delete':
      delete cache[msg.instanceId];
      p = DB.deleteInstance(msg.instanceId).then(function () {
        reply(msg, { ok: true });
      });
      break;

    case 'seedLegacy':
      // 注入一条 v1 旧数据 + 一条未来版本数据，用于验证版本迁移与降级
      p = (function () {
        var t = new Date().toISOString();
        var legacy = {
          v: 1, id: 'legacy-v1-' + Date.now().toString(36), title: '旧版单据(v1)',
          status: 'running', stepIndex: 1,
          data: { item: '差旅费', amount: 1200 },
          events: [], createdAt: t, updatedAt: t
        };
        var future = {
          v: 99, id: 'future-v99-' + Date.now().toString(36), title: '未来版本单据(v99)',
          status: 'running', data: { item: '未知格式' }, createdAt: t, updatedAt: t
        };
        return DB.putInstance(legacy).then(function () {
          return DB.putInstance(future);
        }).then(function () {
          reply(msg, { ok: true });
        });
      })();
      break;

    case 'clearAll':
      cache = {};
      p = DB.clearAll().then(function () {
        reply(msg, { ok: true });
      });
      break;

    default:
      reply(msg, { ok: false, error: '未知操作: ' + msg.op });
  }

  if (p && p.catch) {
    p.catch(function (err) {
      reply(msg, { ok: false, error: err && err.message ? err.message : String(err) });
    });
  }
};
