'use strict';
/**
 * 心情の · 服务器版前端
 * 计算仍在本机完成，所有写入通过 /api/mutate 落到服务器 data/ledger.json。
 */
(function () {
  const SETTING_KEYS = ['casualRate', 'depositRate'];
  const DEFAULT_SETTINGS = { casualRate: 100, depositRate: 100 };
  const $ = function (id) { return document.getElementById(id); };

  let state = { settings: Object.assign({}, DEFAULT_SETTINGS), current: [], periods: [] };
  let pickedType = 'casual';
  let busy = false;
  let queue = Promise.resolve(true);
  let authEnabled = false;

  // 同步状态条
  const style = document.createElement('style');
  style.textContent = '.sync{position:fixed;right:14px;bottom:14px;z-index:99;max-width:82vw;' +
    'background:#fff;border:1px solid #e6e9ef;border-radius:20px;padding:7px 14px;font-size:12px;' +
    'color:#0f7b53;box-shadow:0 2px 10px rgba(20,35,60,.12)}' +
    '.sync.bad{color:#c8402f;border-color:#f0c0b8}.sync.wait{color:#7b8494}';
  document.head.appendChild(style);
  const bar = document.createElement('div');
  bar.className = 'sync wait';
  bar.textContent = '连接服务器…';
  document.body.appendChild(bar);
  function status(msg, kind) {
    bar.textContent = msg;
    bar.className = 'sync' + (kind ? ' ' + kind : '');
  }

  function showLogin(msg) {
    $('loginGate').classList.remove('hide');
    document.querySelector('.app').style.display = 'none';
    bar.style.display = 'none';
    $('loginError').textContent = msg || '';
    $('loginUser').focus();
  }
  function hideLogin() {
    $('loginGate').classList.add('hide');
    document.querySelector('.app').style.display = '';
    bar.style.display = '';
    $('loginError').textContent = '';
  }

  async function api(url, opt) {
    const r = await fetch(url, Object.assign({
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    }, opt || {}));
    if (r.status === 401) {
      showLogin('登录已过期，请重新登录');
      throw new Error('未登录');
    }
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const j = await r.json(); if (j.error) msg = j.error; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    return r.json();
  }

  function fillSettings() {
    SETTING_KEYS.forEach(function (k) { $(k).value = state.settings[k]; });
  }

  async function refresh(syncSettings) {
    const s = await api('/api/state');
    state = {
      settings: Object.assign({}, DEFAULT_SETTINGS, s.settings || {}),
      current: Array.isArray(s.current) ? s.current : [],
      periods: Array.isArray(s.periods) ? s.periods : []
    };
    authEnabled = !!s.authEnabled;
    $('logoutBtn').style.display = authEnabled ? '' : 'none';
    render();
    if (syncSettings) fillSettings();
  }

  // 串行队列：连续快速录入不会互相覆盖，也不会丢单
  function mutate(op, payload) {
    queue = queue.catch(function () { return false; }).then(async function () {
      busy = true;
      status('保存中…', 'wait');
      try {
        await api('/api/mutate', {
          method: 'POST',
          body: JSON.stringify({ op: op, payload: payload || {} })
        });
        await refresh();
        status('已保存 · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }));
        return true;
      } catch (e) {
        status('保存失败：' + e.message + '（未写入服务器）', 'bad');
        render();
        return false;
      } finally {
        busy = false;
      }
    });
    return queue;
  }

  function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
  function fmt(n) { return (Math.round(Number(n) * 100) / 100).toFixed(2); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // 到手只读：始终按①区规则折算，不接受单笔手动覆盖
  function netOf(r) {
    const s = state.settings, dep = r.type === 'deposit';
    let rate = Number(dep ? s.depositRate : s.casualRate);
    if (!Number.isFinite(rate)) rate = 100;
    return round2(Number(r.amount) * rate / 100);
  }
  function calc(records) {
    const out = { count: records.length, paid: 0, net: 0, casual: { count: 0, paid: 0, net: 0 }, deposit: { count: 0, paid: 0, net: 0 } };
    records.forEach(function (r) {
      const n = netOf(r), a = Number(r.amount) || 0;
      out.paid += a; out.net += n;
      const g = r.type === 'deposit' ? out.deposit : out.casual;
      g.count++; g.paid += a; g.net += n;
    });
    out.paid = round2(out.paid); out.net = round2(out.net);
    out.casual.paid = round2(out.casual.paid); out.casual.net = round2(out.casual.net);
    out.deposit.paid = round2(out.deposit.paid); out.deposit.net = round2(out.deposit.net);
    return out;
  }
  function allRecords() {
    const out = [];
    state.periods.forEach(function (p) {
      (p.records || []).forEach(function (r) { out.push({ r: r, period: '第' + p.no + '期' }); });
    });
    state.current.forEach(function (r) { out.push({ r: r, period: '本期' }); });
    return out;
  }

  function renderStats() {
    const s = calc(state.current);
    $('stats').innerHTML =
      '<div class="stat"><div class="k">本期单数</div><div class="v">' + s.count + '</div></div>' +
      '<div class="stat"><div class="k">老板付款合计 (元)</div><div class="v">' + fmt(s.paid) + '</div></div>' +
      '<div class="stat"><div class="k">到手合计 (元)</div><div class="v income">' + fmt(s.net) + '</div></div>' +
      '<div class="stat"><div class="k">差额 / 抽成 (元)</div><div class="v">' + fmt(round2(s.paid - s.net)) + '</div></div>';
    $('split').innerHTML =
      '<span><span class="pill casual">散单</span> ' + s.casual.count + ' 单 · 老板付 <b>' + fmt(s.casual.paid) +
      '</b> · 到手 <b>' + fmt(s.casual.net) + '</b></span>' +
      '<span><span class="pill deposit">预存</span> ' + s.deposit.count + ' 单 · 老板付 <b>' + fmt(s.deposit.paid) +
      '</b> · 到手 <b>' + fmt(s.deposit.net) + '</b></span>';
  }

  function calcLabel(r) {
    if (r.rate === null || r.rate === undefined || r.rate === '') return '';
    if (r.hours === null || r.hours === undefined || r.hours === '') return '';
    const a = Number(r.rate), b = Number(r.hours);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
    return '<small class="calc">' + String(round2(a)) + ' × ' + String(round2(b)) + ' h</small>';
  }

  function itemHTML(r, editable) {
    const n = netOf(r);
    const netCell = '<span class="net' + (n < 0 ? ' neg' : '') + '">' + fmt(n) + '</span>';
    return '<div class="item">' +
      '<span>' + esc(r.date) + '</span>' +
      '<span><span class="pill ' + (r.type === 'deposit' ? 'deposit">预存' : 'casual">散单') + '</span></span>' +
      '<span class="amount">' + fmt(r.amount) + calcLabel(r) + '</span>' +
      '<span>' + netCell + '</span>' +
      '<span class="note">' + esc(r.note) + '</span>' +
      (editable ? '<span class="del"><button type="button" class="ghost" data-id="' + esc(r.id) + '" data-act="del" title="删除这笔">✕</button></span>' : '') +
      '</div>';
  }

  function renderList() {
    const box = $('list');
    if (!state.current.length) { box.innerHTML = '<div class="empty">还没有记录，在上面记第一笔吧。</div>'; return; }
    box.innerHTML = state.current.slice().reverse().map(function (r) { return itemHTML(r, true); }).join('');
  }

  function renderHistory() {
    const box = $('history');
    if (!state.periods.length) { box.innerHTML = '<div class="empty">暂无已结算期次。</div>'; return; }
    box.innerHTML = state.periods.slice().reverse().map(function (p) {
      const s = calc(p.records || []);
      const rows = (p.records || []).map(function (r) { return itemHTML(r, false); }).join('');
      return '<details class="period">' +
        '<summary><strong>第 ' + p.no + ' 期</strong>' +
        '<span>' + esc(p.dateFrom || '') + ' ~ ' + esc(p.dateTo || '') + '</span>' +
        '<span>' + s.count + ' 单</span>' +
        '<span>老板付 <b>' + fmt(s.paid) + '</b></span>' +
        '<span style="color:var(--income)">到手 <b>' + fmt(s.net) + '</b></span>' +
        '<span class="pill casual">散 ' + fmt(s.casual.net) + '</span>' +
        '<span class="pill deposit">预 ' + fmt(s.deposit.net) + '</span>' +
        '<span style="color:var(--muted);font-size:12px">结于 ' + esc(p.closedAt || '') + '</span></summary>' +
        '<div class="body"><div class="list-head hist-head">' +
        '<span>日期</span><span>类型</span><span>老板付</span><span>到手</span><span>备注</span></div>' +
        rows +
        '<div class="toolbar"><button type="button" class="mini" data-act="export-period" data-no="' + p.no + '">导出本期 CSV</button></div>' +
        '</div></details>';
    }).join('');
  }

  function renderNotice() {
    const s = state.settings;
    const untouched = Number(s.casualRate) === 100 && Number(s.depositRate) === 100;
    $('notice').classList.toggle('hide', !untouched);
  }

  function render() { renderStats(); renderList(); renderHistory(); renderNotice(); }

  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    document.body.removeChild(a); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function toCSV(rows) {
    return '\ufeff' + rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
  }
  function csvRows(list) {
    const rows = [['期次', '日期', '类型', '单价(元/小时)', '时长(小时)', '老板付(元)', '到手(元)', '备注']];
    list.forEach(function (x) {
      const rate = (x.r.rate === null || x.r.rate === undefined) ? '' : x.r.rate;
      const hours = (x.r.hours === null || x.r.hours === undefined) ? '' : x.r.hours;
      rows.push([x.period, x.r.date, x.r.type === 'deposit' ? '预存' : '散单',
        rate, hours, fmt(x.r.amount), fmt(netOf(x.r)), x.r.note || '']);
    });
    return rows;
  }
  function exportCSV(list, name) {
    if (!list.length) { alert('没有可导出的记录。'); return; }
    download(name, toCSV(csvRows(list)), 'text/csv;charset=utf-8');
  }

  // ---------- 订单类型下拉 ----------
  const typePicker = $('typePicker'), typeBtn = $('typeBtn'), typeMenu = $('typeMenu'), typeValue = $('typeValue');
  const typeOpts = typeMenu.querySelectorAll('.picker-opt');
  function setType(v) {
    pickedType = v;
    typeValue.textContent = v === 'deposit' ? '预存' : '散单';
    Array.prototype.forEach.call(typeOpts, function (o) {
      const on = o.getAttribute('data-type') === v;
      o.classList.toggle('on', on);
      o.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }
  function toggleTypeMenu(force) {
    const open = force === undefined ? !typePicker.classList.contains('open') : force;
    typePicker.classList.toggle('open', open);
    typeMenu.classList.toggle('hide', !open);
    typeBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  typeBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleTypeMenu(); });
  Array.prototype.forEach.call(typeOpts, function (opt) {
    opt.addEventListener('click', function () { setType(opt.getAttribute('data-type')); toggleTypeMenu(false); });
    opt.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opt.click(); }
    });
  });
  document.addEventListener('click', function (e) { if (!typePicker.contains(e.target)) toggleTypeMenu(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') toggleTypeMenu(false); });

  let autoAmount = null;
  function syncAmount() {
    const rRaw = $('rate').value.trim(), hRaw = $('hours').value.trim();
    if (rRaw === '' || hRaw === '') return;
    const r = Number(rRaw), h = Number(hRaw);
    if (!Number.isFinite(r) || !Number.isFinite(h)) return;
    const v = round2(r * h), cur = $('amount').value.trim();
    if (cur === '' || (autoAmount !== null && Number(cur) === autoAmount)) {
      $('amount').value = v;
      autoAmount = v;
    }
  }
  $('rate').addEventListener('input', syncAmount);
  $('hours').addEventListener('input', syncAmount);
  $('amount').addEventListener('input', function () { if ($('amount').value.trim() === '') autoAmount = null; });

  function addRecord() {
    const raw = $('amount').value.trim();
    const rRaw = $('rate').value.trim(), hRaw = $('hours').value.trim();
    const rate = rRaw === '' ? null : (Number.isFinite(Number(rRaw)) ? round2(Number(rRaw)) : null);
    const hours = hRaw === '' ? null : (Number.isFinite(Number(hRaw)) ? round2(Number(hRaw)) : null);
    let amount = raw === '' ? NaN : Number(raw);
    if (!Number.isFinite(amount) && rate !== null && hours !== null) amount = round2(rate * hours);
    if (!Number.isFinite(amount)) { $('amount').focus(); return; }
    const rec = {
      id: uid(), date: $('date').value || today(), amount: round2(amount),
      type: pickedType, note: $('note').value.trim(), override: null,
      rate: rate, hours: hours
    };
    $('amount').value = ''; $('rate').value = ''; $('hours').value = ''; $('note').value = '';
    autoAmount = null;
    $('amount').focus();
    mutate('add', { record: rec }).then(function (ok) {
      if (!ok && $('amount').value.trim() === '') {
        $('amount').value = String(rec.amount);
        $('rate').value = rate === null ? '' : String(rate);
        $('hours').value = hours === null ? '' : String(hours);
        $('note').value = rec.note;
      }
    });
  }
  $('addBtn').addEventListener('click', addRecord);
  ['amount', 'rate', 'hours', 'note'].forEach(function (id) {
    $(id).addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addRecord(); }
    });
  });

  SETTING_KEYS.forEach(function (id) {
    $(id).addEventListener('change', function () {
      const v = $(id).value.trim();
      const def = 100;
      let n = Number(v);
      if (v === '' || !Number.isFinite(n) || n < 0) { n = def; $(id).value = n; }
      const next = {};
      SETTING_KEYS.forEach(function (k) { next[k] = k === id ? round2(n) : Number(state.settings[k]); });
      mutate('settings', { settings: next }).then(function (ok) { if (!ok) fillSettings(); });
    });
  });

  $('list').addEventListener('click', function (e) {
    const btn = e.target.closest('[data-act="del"]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const r = state.current.filter(function (x) { return x.id === id; })[0];
    if (!r) return;
    if (!confirm('删除这一笔？\n' + r.date + ' · ' + fmt(r.amount) + ' 元')) return;
    mutate('delete', { id: id });
  });
  $('closeBtn').addEventListener('click', function () {
    if (!state.current.length) { alert('本期还没有记录。'); return; }
    const s = calc(state.current);
    if (!confirm('结算本期？\n共 ' + s.count + ' 单，老板付 ' + fmt(s.paid) + ' 元，到手 ' + fmt(s.net) + ' 元。\n结算后这些单会归档，开始新的一期。')) return;
    mutate('close');
  });
  $('undoBtn').addEventListener('click', function () {
    if (!state.periods.length) { alert('没有可撤销的结算。'); return; }
    const p = state.periods[state.periods.length - 1];
    if (!confirm('撤销第 ' + p.no + ' 期的结算？该期记录会回到本期明细。')) return;
    mutate('undo');
  });

  function runRange() {
    const from = $('from').value, to2 = $('to').value;
    if (!from || !to2) { alert('请选择起始和结束日期。'); return; }
    if (from > to2) { alert('起始日期不能晚于结束日期。'); return; }
    const list = allRecords().filter(function (x) { return x.r.date >= from && x.r.date <= to2; });
    if (!list.length) { $('rangeOut').textContent = from + ' ~ ' + to2 + '：没有记录。'; return; }
    const s = calc(list.map(function (x) { return x.r; }));
    $('rangeOut').innerHTML = '<b>' + esc(from) + ' ~ ' + esc(to2) + '</b>：' + s.count + ' 单 · 老板付 <b>' +
      fmt(s.paid) + '</b> 元 · 到手 <b style="color:var(--income)">' + fmt(s.net) + '</b> 元 · ' +
      '<span class="pill casual">散单 ' + fmt(s.casual.net) + '</span> ' +
      '<span class="pill deposit">预存 ' + fmt(s.deposit.net) + '</span> · 差额 <b>' + fmt(round2(s.paid - s.net)) + '</b> 元';
  }
  $('rangeBtn').addEventListener('click', runRange);
  $('thisMonthBtn').addEventListener('click', function () {
    const d = new Date();
    $('from').value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
    $('to').value = today(); runRange();
  });

  $('exportCurrentBtn').addEventListener('click', function () {
    exportCSV(state.current.map(function (r) { return { r: r, period: '本期' }; }), '本期明细_' + today() + '.csv');
  });
  $('exportAllBtn').addEventListener('click', function () { exportCSV(allRecords(), '全部明细_' + today() + '.csv'); });
  $('history').addEventListener('click', function (e) {
    const btn = e.target.closest('[data-act="export-period"]');
    if (!btn) return;
    const no = Number(btn.getAttribute('data-no'));
    const p = state.periods.filter(function (x) { return x.no === no; })[0];
    if (!p) return;
    exportCSV((p.records || []).map(function (r) { return { r: r, period: '第' + no + '期' }; }), '第' + no + '期明细.csv');
  });
  $('backupBtn').addEventListener('click', function () {
    download('心情の备份_' + today() + '.json', JSON.stringify({
      version: 1, settings: state.settings, current: state.current, periods: state.periods
    }, null, 2), 'application/json;charset=utf-8');
  });
  $('importBtn').addEventListener('click', function () { $('fileInput').click(); });
  $('fileInput').addEventListener('change', function (e) {
    const f = e.target.files[0]; if (!f) return;
    f.text().then(function (txt) {
      const o = JSON.parse(txt);
      if (!o || !Array.isArray(o.current) || !Array.isArray(o.periods)) throw new Error('格式不符');
      if (!confirm('导入会覆盖服务器上的全部数据，确定继续？')) return;
      mutate('import', { state: o }).then(function (ok) { if (ok) alert('导入完成。'); });
    }).catch(function () { alert('导入失败：文件不是有效的台账备份。'); });
    e.target.value = '';
  });
  $('clearBtn').addEventListener('click', function () {
    if (!confirm('清空全部记录（含历史期次）？此操作不可恢复，建议先导出备份。')) return;
    if (!confirm('再确认一次：真的清空？')) return;
    mutate('clear');
  });

  // 多端同步：切回页面立即刷新，之后每 30 秒刷新一次
  function sync() {
    if (busy || document.visibilityState !== 'visible' || !$('loginGate').classList.contains('hide')) return;
    refresh().then(function () {
      if (!bar.className.includes('bad')) status('已连接 · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    }).catch(function () { /* 401 时由 api() 显示登录页 */ });
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') sync(); });
  setInterval(sync, 30000);

  // 页面内登录
  async function doLogin() {
    const u = $('loginUser').value.trim(), p = $('loginPassword').value;
    $('loginError').textContent = '';
    if (!u || !p) { $('loginError').textContent = '请输入用户名和密码'; return; }
    $('loginBtn').disabled = true;
    try {
      const r = await fetch('/api/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: u, password: p })
      });
      const j = await r.json();
      if (!r.ok) { $('loginError').textContent = j.error || '登录失败'; return; }
      $('loginPassword').value = '';
      await boot();
    } catch (e) {
      $('loginError').textContent = '无法连接服务器：' + e.message;
    } finally {
      $('loginBtn').disabled = false;
    }
  }
  $('loginBtn').addEventListener('click', doLogin);
  ['loginUser', 'loginPassword'].forEach(function (id) {
    $(id).addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doLogin(); }
    });
  });
  $('logoutBtn').addEventListener('click', async function () {
    if (!authEnabled) return;
    if (!confirm('退出登录？')) return;
    try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) { /* ignore */ }
    showLogin('已退出登录');
  });

  async function boot() {
    try {
      await refresh(true);
      hideLogin();
      status('已连接服务器 · 数据实时保存');
    } catch (e) {
      if (e.message !== '未登录') showLogin('无法连接服务器：' + e.message);
    }
  }

  // 初始化
  $('date').value = today();
  $('to').value = today();
  const d = new Date();
  $('from').value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
  boot();
})();
