const $ = (id) => document.getElementById(id);
const STATUS_LABEL = { new: '新客户', following: '跟进中', won: '已成交', lost: '已流失' };

const fmtPhone = (p) => (p ? '+' + p : '');
const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const accLabel = (a) => {
  const alias = a.accountAlias ?? a.alias;
  const phone = a.accountPhone ?? a.phone;
  return alias ? `${alias} ${fmtPhone(phone)}` : fmtPhone(phone) || a.wid || '未知';
};

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json();
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function loadStats() {
  const s = await api('GET', '/api/stats');
  for (const k of ['accounts', 'customers', 'duplicates', 'fansToday']) $('st-' + k).textContent = s[k];
  $('st-fansTodayDup').textContent = s.fansTodayDup ? ` · 重 ${s.fansTodayDup}` : '';
}

function dailyCell(tag, c, cls) {
  const td = el(tag, 'num ' + (cls || ''));
  if (!c.total) {
    td.appendChild(el('span', 'zero', '0'));
    return td;
  }
  td.appendChild(el('span', 'fans', c.total));
  if (c.dup) td.appendChild(el('span', 'dup-tag', `重 ${c.dup}`));
  return td;
}

async function loadDaily() {
  const days = $('d-days').value;
  $('btn-daily-export').href = '/api/daily.csv?days=' + days;
  const { days: dayList, accounts, cells, totals } = await api('GET', '/api/daily?days=' + days);
  const cols = [...dayList].reverse(); // 新 → 旧，今天在最左
  const today = dayList[dayList.length - 1];
  const sum = (list) => list.reduce((s, c) => ({ total: s.total + c.total, dup: s.dup + c.dup }), { total: 0, dup: 0 });

  const htr = el('tr');
  htr.appendChild(el('th', 'acc', '账号'));
  htr.appendChild(el('th', 'num sum', '合计'));
  for (const d of cols) {
    const th = el('th', 'num' + (d === today ? ' today' : ''), d === today ? '今天' : d.slice(5));
    th.title = d;
    htr.appendChild(th);
  }
  $('daily-head').replaceChildren(htr);

  const totalRow = el('tr', 'total-row');
  const tdT = el('td', 'acc');
  tdT.appendChild(el('div', 'name', '全部账号'));
  tdT.appendChild(el('div', 'muted small-inline', '净新客'));
  totalRow.appendChild(tdT);
  const allTotal = sum(cols.map((d) => totals[d]));
  const sumCell = dailyCell('td', allTotal, 'sum');
  sumCell.appendChild(el('div', 'unique', allTotal.total - allTotal.dup));
  totalRow.appendChild(sumCell);
  for (const d of cols) {
    const td = dailyCell('td', totals[d], d === today ? 'today' : '');
    td.appendChild(el('div', 'unique', totals[d].unique));
    totalRow.appendChild(td);
  }

  const rows = accounts.map((a) => {
    const tr = el('tr');
    const tdA = el('td', 'acc');
    tdA.appendChild(el('div', 'name', a.alias || fmtPhone(a.phone) || a.wid));
    if (a.alias && a.phone) tdA.appendChild(el('div', 'phone', fmtPhone(a.phone)));
    tr.appendChild(tdA);
    tr.appendChild(dailyCell('td', sum(cols.map((d) => cells[a.id][d])), 'sum'));
    for (const d of cols) tr.appendChild(dailyCell('td', cells[a.id][d], d === today ? 'today' : ''));
    return tr;
  });
  $('daily-rows').replaceChildren(totalRow, ...rows);
}

async function loadAccounts() {
  const list = await api('GET', '/api/accounts');
  const sel = $('f-account');
  const cur = sel.value;
  sel.replaceChildren(new Option('全部账号', ''));
  for (const a of list) sel.add(new Option(accLabel(a), a.id));
  sel.value = cur;

  const tb = $('acc-rows');
  tb.replaceChildren();
  for (const a of list) {
    const tr = el('tr');
    tr.appendChild(el('td', 'phone', fmtPhone(a.phone) || a.wid));
    const tdAlias = el('td');
    const inp = el('input', 'alias');
    inp.type = 'text';
    inp.placeholder = '别名';
    inp.value = a.alias ?? '';
    inp.addEventListener('change', async () => {
      await api('PATCH', `/api/accounts/${a.id}`, { alias: inp.value.trim() || null });
      toast('别名已保存');
      loadAccounts();
      loadCustomers();
    });
    tdAlias.appendChild(inp);
    tr.appendChild(tdAlias);
    tr.appendChild(el('td', 'num', a.customer_count));
    const dup = el('td', 'num', a.duplicate_count);
    if (a.duplicate_count) dup.classList.add('dupcount');
    tr.appendChild(dup);
    tr.appendChild(el('td', 'date', fmtDate(a.last_sync_at) || '从未'));
    tb.appendChild(tr);
  }
}

function customerRow(c) {
  const tr = el('tr');

  const tdName = el('td');
  tdName.appendChild(el('div', 'name', c.displayName || fmtPhone(c.phone) || '（无名称）'));
  if (c.phone) tdName.appendChild(el('div', 'phone', fmtPhone(c.phone)));
  if (c.lid) tdName.appendChild(el('div', 'lid', 'LID ' + c.lid));
  tr.appendChild(tdName);

  const tdAcc = el('td');
  for (const a of c.accounts) {
    const chip = el('span', 'chip', accLabel(a));
    chip.title = `首次 ${fmtDate(a.firstSeen)}${a.lastMsgAt ? ' · 最后消息 ' + fmtDate(a.lastMsgAt) : ''}${a.pushname ? ' · ' + a.pushname : ''}`;
    tdAcc.appendChild(chip);
  }
  tr.appendChild(tdAcc);

  const tdCount = el('td', 'num', c.accountCount);
  if (c.accountCount > 1) tdCount.classList.add('dupcount');
  tr.appendChild(tdCount);
  tr.appendChild(el('td', 'date', fmtDate(c.firstSeen)));
  tr.appendChild(el('td', 'date', fmtDate(c.lastMsgAt)));

  const tdStatus = el('td');
  const sel = el('select', 'status ' + c.status);
  for (const [v, l] of Object.entries(STATUS_LABEL)) sel.add(new Option(l, v));
  sel.value = c.status;
  sel.addEventListener('change', async () => {
    await api('PATCH', `/api/customers/${c.id}`, { status: sel.value });
    sel.className = 'status ' + sel.value;
    toast('状态已更新');
  });
  tdStatus.appendChild(sel);
  tr.appendChild(tdStatus);

  const tdNote = el('td');
  const note = el('input', 'note');
  note.type = 'text';
  note.placeholder = '点击添加备注';
  note.value = c.note ?? '';
  note.addEventListener('change', async () => {
    await api('PATCH', `/api/customers/${c.id}`, { note: note.value.trim() || null });
    toast('备注已保存');
  });
  tdNote.appendChild(note);
  tr.appendChild(tdNote);
  return tr;
}

let loadSeq = 0;
async function loadCustomers() {
  const seq = ++loadSeq;
  const params = new URLSearchParams();
  const dup = $('f-dup').checked;
  if (dup) params.set('dup', '1');
  if ($('f-account').value) params.set('account', $('f-account').value);
  if ($('f-status').value) params.set('status', $('f-status').value);
  const q = $('f-q').value.trim();
  if (q) params.set('q', q);
  params.set('limit', '500');
  $('btn-export').href = '/api/export.csv' + (dup ? '?dup=1' : '');

  const { total, items } = await api('GET', '/api/customers?' + params);
  if (seq !== loadSeq) return;
  const tb = $('rows');
  tb.replaceChildren(...items.map(customerRow));
  $('empty').hidden = items.length > 0;
  $('count').textContent = `共 ${total} 位客户${items.length < total ? `，显示前 ${items.length}` : ''}`;
}

async function refreshAll() {
  try {
    await Promise.all([loadStats(), loadDaily(), loadAccounts(), loadCustomers()]);
  } catch (e) {
    toast('加载失败：' + e.message);
  }
}

$('f-dup').addEventListener('change', loadCustomers);
$('f-account').addEventListener('change', loadCustomers);
$('f-status').addEventListener('change', loadCustomers);
let qTimer;
$('f-q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(loadCustomers, 250); });
$('btn-refresh').addEventListener('click', refreshAll);
try { const d = localStorage.getItem('wab.dailyDays'); if (d) $('d-days').value = d; } catch {}
$('d-days').addEventListener('change', () => {
  try { localStorage.setItem('wab.dailyDays', $('d-days').value); } catch {}
  loadDaily().catch((e) => toast('加载失败：' + e.message));
});

refreshAll();
setInterval(() => { if (document.visibilityState === 'visible') { loadStats(); loadDaily(); loadCustomers(); } }, 30000);
