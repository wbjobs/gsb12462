# 审批流状态机模拟器

纯前端（无框架）：IndexedDB + DOM + Web Worker（状态机）+ Canvas（状态图）。

## 运行

Web Worker 与 IndexedDB 需要 HTTP 环境，不能直接双击打开：

```bash
cd 本目录
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000
```

## 功能

- **流程定义**：左侧面板编辑 JSON（步骤 / 角色 / 角色成员），新实例生效；在途实例持有定义快照，互不影响。
- **流转操作**：提交、通过、驳回（回上一步、数据保留）、转交（仅换处理人）、撤回（申请人撤回至草稿）。非法流转在 Worker 内校验并拒绝，不落库。
- **多实例并行**：实例按 id 完全隔离，可并行推进。
- **状态回放**：拖动回放滑块，按事件日志重建任意时刻状态（事件溯源）。
- **状态机图**：Canvas 绘制，绿实线=通过、红虚线=驳回、灰点线=撤回，当前步骤高亮。
- **持久化与版本兼容**：状态整体可 JSON 序列化存入 IndexedDB；`注入旧版本数据` 可生成 v1（自动迁移到 v2）与 v99（降级为只读，不丢数据）测试记录；`清空存储` 一键重置。

## 结构

- `js/machine.js` — 纯状态机（流转规则 / 回放 / 版本迁移），主线程与 Worker 共用
- `js/worker.js` — Worker 引擎：串行处理所有状态变更并落库
- `js/db.js` — IndexedDB 封装（DB v2，含升级路径）
- `js/diagram.js` — Canvas 状态机图
- `js/app.js` — UI 与 Worker RPC

## 测试

```bash
node /tmp/test-machine.js   # 16 项状态机逻辑测试
```
