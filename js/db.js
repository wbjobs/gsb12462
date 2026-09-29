/* IndexedDB 持久层（主线程与 Worker 共用）
 * DB 版本 2：
 *   v1 -> 只有 instances 仓库
 *   v2 -> 新增 meta 仓库（存放流程定义、schema 版本标记）
 */
(function (global) {
  'use strict';

  var DB_NAME = 'approval-flow-sim';
  var DB_VERSION = 2;
  var _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (ev) {
        var db = req.result;
        var oldV = ev.oldVersion;
        if (oldV < 1) {
          db.createObjectStore('instances', { keyPath: 'id' });
        }
        if (oldV < 2) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = function () { _db = req.result; resolve(_db); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('数据库被其他标签页占用，请关闭后重试')); };
    });
  }

  function reqToPromise(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  var DB = {
    putInstance: function (state) {
      return open().then(function (db) {
        return reqToPromise(
          db.transaction('instances', 'readwrite').objectStore('instances').put(state)
        );
      });
    },
    getInstance: function (id) {
      return open().then(function (db) {
        return reqToPromise(db.transaction('instances').objectStore('instances').get(id));
      });
    },
    allInstances: function () {
      return open().then(function (db) {
        return reqToPromise(db.transaction('instances').objectStore('instances').getAll());
      });
    },
    deleteInstance: function (id) {
      return open().then(function (db) {
        return reqToPromise(
          db.transaction('instances', 'readwrite').objectStore('instances').delete(id)
        );
      });
    },
    setMeta: function (key, value) {
      return open().then(function (db) {
        return reqToPromise(
          db.transaction('meta', 'readwrite').objectStore('meta').put({ key: key, value: value })
        );
      });
    },
    getMeta: function (key) {
      return open().then(function (db) {
        return reqToPromise(db.transaction('meta').objectStore('meta').get(key));
      }).then(function (row) { return row ? row.value : undefined; });
    },
    clearAll: function () {
      return open().then(function (db) {
        return Promise.all(['instances', 'meta'].map(function (name) {
          return reqToPromise(db.transaction(name, 'readwrite').objectStore(name).clear());
        }));
      });
    }
  };

  global.ApprovalDB = DB;
})(typeof self !== 'undefined' ? self : this);
