/* Canvas 状态机图：步骤节点 + 流转边
 * 实线绿箭头 = 通过(前进)，红色虚线弧 = 驳回(回退)，灰色点线 = 撤回(回提交)
 * 当前步骤高亮，驳回/撤回经过的边在状态匹配时强调。
 */
(function (global) {
  'use strict';

  var NODE_W = 128, NODE_H = 52, GAP = 64, PAD = 40, TOP = 90;

  function nodePos(i) {
    return { x: PAD + i * (NODE_W + GAP), y: TOP };
  }

  function requiredWidth(stepCount) {
    return PAD * 2 + stepCount * NODE_W + (stepCount - 1) * GAP;
  }

  function arrow(ctx, x1, y1, x2, y2) {
    var a = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - 9 * Math.cos(a - 0.42), y2 - 9 * Math.sin(a - 0.42));
    ctx.lineTo(x2 - 9 * Math.cos(a + 0.42), y2 - 9 * Math.sin(a + 0.42));
    ctx.closePath();
    ctx.fill();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  var STATUS_STYLE = {
    pending:  { fill: '#f1f5f9', stroke: '#94a3b8', text: '#475569' },
    active:   { fill: '#dbeafe', stroke: '#2563eb', text: '#1d4ed8' },
    done:     { fill: '#dcfce7', stroke: '#16a34a', text: '#15803d' },
    approved: { fill: '#dcfce7', stroke: '#16a34a', text: '#15803d' },
    rejected: { fill: '#fee2e2', stroke: '#dc2626', text: '#b91c1c' },
    returned: { fill: '#fef9c3', stroke: '#ca8a04', text: '#a16207' }
  };

  var STATUS_LABEL = {
    pending: '待处理', active: '处理中', done: '已完成',
    approved: '已通过', rejected: '已驳回', returned: '被退回'
  };

  /**
   * @param canvas  目标 canvas
   * @param state   实例状态（含 def.steps 与 steps 运行时状态）
   */
  function draw(canvas, state) {
    var dpr = window.devicePixelRatio || 1;
    var steps = state.def.steps;
    var w = Math.max(requiredWidth(steps.length), canvas.parentElement.clientWidth - 4);
    var h = 260;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '12px system-ui, sans-serif';

    var cy = TOP + NODE_H / 2;

    /* ---- 边：驳回（红色虚线弧，从 i 回到 i-1） ---- */
    for (var i = 1; i < steps.length; i++) {
      var p1 = nodePos(i), p0 = nodePos(i - 1);
      ctx.strokeStyle = '#ef4444';
      ctx.fillStyle = '#ef4444';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = state.steps[i] && state.steps[i].status === 'rejected' ? 2.5 : 1.2;
      ctx.beginPath();
      ctx.moveTo(p1.x + NODE_W / 2, p1.y + NODE_H);
      ctx.bezierCurveTo(
        p1.x + NODE_W / 2, p1.y + NODE_H + 46,
        p0.x + NODE_W / 2, p0.y + NODE_H + 46,
        p0.x + NODE_W / 2, p0.y + NODE_H + 4
      );
      ctx.stroke();
      ctx.setLineDash([]);
      arrow(ctx, p0.x + NODE_W / 2 + 4, p0.y + NODE_H + 2, p0.x + NODE_W / 2, p0.y + NODE_H + 2);
      ctx.fillStyle = '#b91c1c';
      ctx.fillText('驳回', (p0.x + p1.x) / 2 + NODE_W / 2 - 8, p0.y + NODE_H + 42);
    }

    /* ---- 边：撤回（灰色点线，从各审批步骤回到提交） ---- */
    for (var j = 2; j < steps.length; j++) {
      var pj = nodePos(j), ps = nodePos(0);
      ctx.strokeStyle = '#94a3b8';
      ctx.fillStyle = '#94a3b8';
      ctx.setLineDash([2, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pj.x + NODE_W / 2, pj.y - 4);
      ctx.bezierCurveTo(
        pj.x + NODE_W / 2, pj.y - 58,
        ps.x + NODE_W / 2, ps.y - 58,
        ps.x + NODE_W / 2, ps.y - 4
      );
      ctx.stroke();
      ctx.setLineDash([]);
      if (j === 2) {
        ctx.fillStyle = '#64748b';
        ctx.fillText('撤回', (ps.x + pj.x) / 2 + NODE_W / 2 - 8, ps.y - 52);
      }
    }

    /* ---- 边：通过（绿色实线前进） ---- */
    for (var k = 0; k < steps.length - 1; k++) {
      var a = nodePos(k), b = nodePos(k + 1);
      var passed = state.steps[k].status === 'done' || state.steps[k].status === 'approved';
      ctx.strokeStyle = passed ? '#16a34a' : '#cbd5e1';
      ctx.fillStyle = passed ? '#16a34a' : '#cbd5e1';
      ctx.lineWidth = passed ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(a.x + NODE_W, cy);
      ctx.lineTo(b.x - 2, cy);
      ctx.stroke();
      arrow(ctx, b.x - 12, cy, b.x - 2, cy);
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = passed ? '#15803d' : '#94a3b8';
      ctx.fillText(k === 0 ? '提交' : '通过', a.x + NODE_W + GAP / 2 - 12, cy - 8);
      ctx.font = '12px system-ui, sans-serif';
    }

    /* ---- 节点 ---- */
    steps.forEach(function (def, idx) {
      var run = state.steps[idx] || { status: 'pending' };
      var st = STATUS_STYLE[run.status] || STATUS_STYLE.pending;
      var p = nodePos(idx);
      var isCurrent = state.status === 'running' && idx === state.stepIndex;

      if (isCurrent) {
        ctx.shadowColor = 'rgba(37, 99, 235, 0.55)';
        ctx.shadowBlur = 16;
      }
      roundRect(ctx, p.x, p.y, NODE_W, NODE_H, 9);
      ctx.fillStyle = st.fill;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = isCurrent ? 2.5 : 1.5;
      ctx.strokeStyle = st.stroke;
      ctx.stroke();

      ctx.fillStyle = st.text;
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(def.name, p.x + NODE_W / 2, p.y + 21);
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = '#64748b';
      var roleLabel = def.role;
      var sub = roleLabel + ' · ' + (STATUS_LABEL[run.status] || run.status);
      ctx.fillText(sub, p.x + NODE_W / 2, p.y + 38);
      ctx.textAlign = 'left';
    });

    /* ---- 终态标记 ---- */
    if (state.status === 'completed') {
      ctx.fillStyle = '#15803d';
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.fillText('✓ 流程已完成', PAD, 30);
    } else if (state.status === 'withdrawn') {
      ctx.fillStyle = '#a16207';
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.fillText('⚠ 已撤回（可修改后重新提交）', PAD, 30);
    } else if (state.status === 'draft') {
      ctx.fillStyle = '#64748b';
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.fillText('草稿（待提交）', PAD, 30);
    }
  }

  global.ApprovalDiagram = { draw: draw };
})(window);
