/* ============================================================
   个人负债管理中心 - app.js
   ============================================================ */

// ===== Supabase 配置 =====
const SUPABASE_URL = 'https://ejqhzdckdamssligyjcq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_-8AFKDoWn61Z9uwRJQJ3AA_Cfxhkpc5';
const DATA_ROW_ID = 1; // 固定用第1行存储负债数据
const EXPENSE_TABLE = 'expenses';
const DEBT_TABLE = 'debt_data';

// ===== 各信用卡账单周期配置 =====
// billDay: 账单日, dueDay: 还款日, dueDayNextMonth: 还款日是否在下月
const CARD_BILLING = {
  'cmb-credit-1':       { name: '招商信用卡',   billDay: 3,  dueDay: 21, dueDayNextMonth: false },
  'gz-credit-1':        { name: '广州银行信用卡', billDay: 13, dueDay: 2,  dueDayNextMonth: true  },
  'spdb-credit-1':      { name: '浦发信用卡',   billDay: 28, dueDay: 17, dueDayNextMonth: true  },
  'abc-credit-1':       { name: '农业银行信用卡', billDay: 17, dueDay: 6,  dueDayNextMonth: true  },
  'cmbc-credit-1':      { name: '民生银行信用卡', billDay: 19, dueDay: 9,  dueDayNextMonth: true  },
  'alipay-huabei-1':    { name: '花呗',         billDay: 1,  dueDay: 8,  dueDayNextMonth: false },
  'meituan-yuepay-1':   { name: '美团月付',      billDay: 25, dueDay: 3,  dueDayNextMonth: true  },
};

// 支付方式名称 → 账户ID 映射（用于消费联动）
const PAYMENT_TO_CARD = {
  '招商信用卡':    'cmb-credit-1',
  '广州银行信用卡': 'gz-credit-1',
  '浦发信用卡':    'spdb-credit-1',
  '农行信用卡':    'abc-credit-1',
  '民生信用卡':    'cmbc-credit-1',
  '花呗':         'alipay-huabei-1',
  '美团月付':      'meituan-yuepay-1',
};

// 支付方式名称 → 钱包ID 映射（用于自动扣减余额）
const PAYMENT_TO_WALLET = {
  '微信零钱':     'wallet-wechat',
  '支付宝余额':   'wallet-alipay',
  '储蓄卡':       'wallet-savings',
  '微信/支付宝':  'wallet-wechat',  // 兼容旧选项，默认归微信
};

// 录入消费时自动扣减钱包余额（仅当余额 > 0 时才扣减，避免未设置余额时误扣）
function deductWalletBalance(payment, amount) {
  const walletId = PAYMENT_TO_WALLET[payment];
  if (!walletId || !DATA || !DATA.meta.wallets) return false;
  const wallet = DATA.meta.wallets.find(w => w.id === walletId);
  if (!wallet || !wallet.balance || wallet.balance <= 0) return false;
  wallet.balance = Math.max(0, wallet.balance - amount);
  return true;
}

// 信用卡尾号 → 账户ID + 支付名称（用于从备注中自动识别归属）
const CARD_TAIL_MAP = {
  '7347': { cardId: 'cmb-credit-1', payment: '招商信用卡' },
  // 如有其他卡尾号可在此添加
};

// 根据备注中的卡号尾号自动识别归属信用卡
function resolveCardFromNote(note, currentPayment) {
  // 如果 payment 已明确是信用卡，不需要修正
  if (PAYMENT_TO_CARD[currentPayment]) return null;
  if (!note) return null;
  for (const [tail, info] of Object.entries(CARD_TAIL_MAP)) {
    if (note.includes(tail)) return info;
  }
  return null;
}

// ===== 全局状态 =====
let DATA = null;
let pieChart = null;
let barChart = null;
let expensePieChart = null;
let calendarDate = dayjs();
let syncStatus = 'idle'; // idle | syncing | ok | error

// ===== 工具函数 =====
const fmt = (n) => { const v = Number(n); const dec = v % 1 === 0 ? 0 : 2; return '¥' + v.toLocaleString('zh-CN', { minimumFractionDigits: dec, maximumFractionDigits: dec }); };
const fmtDecimal = (n) => '¥' + Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n) => (n * 100).toFixed(1) + '%';
// 日历格子内简写：≥10000 → x.xw，≥1000 → x.xk，否则正常
const fmtShort = (n) => {
  if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
  if (n >= 1000)  return (n / 1000).toFixed(1) + 'k';
  return Math.round(n).toString();
};
const today = dayjs();

// ===== Supabase API 封装（带超时）=====
async function sbFetch(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000); // 10秒超时
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
      ...options,
      signal: controller.signal,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': options.prefer || 'return=representation',
        'Cache-Control': 'no-cache',
        ...(options.headers || {})
      }
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`HTTP ${res.status}: ${err}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

function setSyncStatus(status) {
  syncStatus = status;
  const el = document.getElementById('syncStatus');
  if (!el) return;
  const map = {
    syncing: { text: '⏳ 同步中...', color: '#ffa94d' },
    ok:      { text: '☁️ 已同步',   color: '#00d4aa' },
    error:   { text: '⚠️ 同步失败', color: '#ff4d6d' },
    idle:    { text: '📱 本地模式', color: '#8892b0' }
  };
  const s = map[status] || map.idle;
  el.textContent = s.text;
  el.style.color = s.color;
}

// ===== 数据加载（三层降级 + 完整性校验）=====
const CACHE_VERSION = '3';  // 升级此版本号可强制清除旧缓存

// 数据完整性校验：必须有 banks 数组且不为空
function isValidData(d) {
  return d && Array.isArray(d.banks) && d.banks.length > 0 && d.meta;
}

// 保存到 IndexedDB（localStorage 的备份层，容量更大，不会被浏览器自动清除）
async function idbSave(key, value) {
  try {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('DebtManagerDB', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
      req.onsuccess = e => res(e.target.result);
      req.onerror = rej;
    });
    await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = res;
      tx.onerror = rej;
    });
  } catch (e) {
    console.warn('[IDB] 写入失败:', e);
  }
}

async function idbLoad(key) {
  try {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('DebtManagerDB', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
      req.onsuccess = e => res(e.target.result);
      req.onerror = rej;
    });
    return await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get(key);
      req.onsuccess = e => res(e.target.result);
      req.onerror = rej;
    });
  } catch (e) {
    console.warn('[IDB] 读取失败:', e);
    return null;
  }
}

async function loadData() {
  // 清除版本不匹配的旧缓存
  if (localStorage.getItem('debtManagerCacheVer') !== CACHE_VERSION) {
    localStorage.removeItem('debtManagerData');
    localStorage.setItem('debtManagerCacheVer', CACHE_VERSION);
    console.log('[Data] 检测到旧缓存，已清除');
  }

  let cloudData = null;
  let localData = null;
  let idbData   = null;

  // === 第1层：云端 Supabase ===
  try {
    setSyncStatus('syncing');
    const rows = await sbFetch(DEBT_TABLE + '?id=eq.' + DATA_ROW_ID + '&select=payload,updated_at');
    if (rows && rows.length > 0 && rows[0].payload) {
      const candidate = rows[0].payload;
      if (isValidData(candidate)) {
        cloudData = candidate;
        // 同步写入本地两层缓存
        localStorage.setItem('debtManagerData', JSON.stringify(cloudData));
        await idbSave('debtManagerData', cloudData);
        setSyncStatus('ok');
        console.log('[Data] 云端加载成功');
      } else {
        console.error('[Data] 云端数据校验失败，拒绝使用！', candidate);
        setSyncStatus('error');
      }
    } else {
      throw new Error('云端无数据');
    }
  } catch (e) {
    console.warn('[Data] 云端加载失败:', e.message);
    setSyncStatus('error');
  }

  if (cloudData) {
    DATA = cloudData;
    init();
    return;
  }

  // === 第2层：localStorage ===
  try {
    const saved = localStorage.getItem('debtManagerData');
    if (saved) {
      const candidate = JSON.parse(saved);
      if (isValidData(candidate)) {
        localData = candidate;
        console.warn('[Data] 降级使用 localStorage 数据');
      }
    }
  } catch (e) {
    console.warn('[Data] localStorage 读取失败:', e);
  }

  if (localData) {
    DATA = localData;
    showToast('⚠️ 云端连接失败，使用本地缓存数据', 5000);
    init();
    return;
  }

  // === 第3层：IndexedDB ===
  idbData = await idbLoad('debtManagerData');
  if (idbData && isValidData(idbData)) {
    DATA = idbData;
    console.warn('[Data] 降级使用 IndexedDB 数据');
    showToast('⚠️ 云端连接失败，使用 IndexedDB 备份数据', 5000);
    init();
    return;
  }

  // === 最后降级：data.json（只读静态文件，不含用户数据）===
  try {
    const res = await fetch('data.json');
    const candidate = await res.json();
    if (isValidData(candidate)) {
      DATA = candidate;
      console.warn('[Data] 降级使用 data.json 静态文件');
      showToast('⚠️ 所有缓存失效，使用初始数据，请检查网络', 8000);
      init();
      return;
    }
  } catch (e) {
    console.error('[Data] data.json 加载失败:', e);
  }

  document.body.innerHTML = '<div style="padding:40px;color:#ff4d6d;text-align:center">⚠️ 数据加载失败，请检查网络后刷新页面</div>';
}

// ===== 保存数据（先写本地双备份，再写云端，失败加入重试队列）=====
const PENDING_SAVES_KEY = 'pendingSaves'; // 待重试的写操作队列

async function saveData() {
  // 1. 先写本地两层（确保本地数据安全）
  const snapshot = JSON.stringify(DATA);
  localStorage.setItem('debtManagerData', snapshot);
  await idbSave('debtManagerData', DATA);

  // 2. 写云端
  setSyncStatus('syncing');
  try {
    await sbFetch(DEBT_TABLE + '?id=eq.' + DATA_ROW_ID, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ payload: DATA, updated_at: new Date().toISOString() })
    });
    setSyncStatus('ok');
    // 写成功后清空重试队列里的 debt 条目
    clearPendingSave('debt');
    console.log('[Data] 云端保存成功');
  } catch (e) {
    console.warn('[Data] 云端保存失败，加入重试队列:', e.message);
    setSyncStatus('error');
    // 加入重试队列，网络恢复后自动重试
    addPendingSave('debt', DATA);
    showToast('⚠️ 网络异常，数据已保存本地，将在网络恢复后自动同步');
  }
}

// ===== 写失败重试队列 =====
function addPendingSave(type, data) {
  const queue = JSON.parse(localStorage.getItem(PENDING_SAVES_KEY) || '[]');
  // 同类型只保留最新一条
  const filtered = queue.filter(q => q.type !== type);
  filtered.push({ type, data, ts: Date.now() });
  localStorage.setItem(PENDING_SAVES_KEY, JSON.stringify(filtered));
}

function clearPendingSave(type) {
  const queue = JSON.parse(localStorage.getItem(PENDING_SAVES_KEY) || '[]');
  localStorage.setItem(PENDING_SAVES_KEY, JSON.stringify(queue.filter(q => q.type !== type)));
}

async function flushPendingSaves() {
  const queue = JSON.parse(localStorage.getItem(PENDING_SAVES_KEY) || '[]');
  if (queue.length === 0) return;
  console.log('[Retry] 检测到', queue.length, '条待重试写操作');
  const failed = [];
  for (const item of queue) {
    try {
      if (item.type === 'debt') {
        await sbFetch(DEBT_TABLE + '?id=eq.' + DATA_ROW_ID, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: JSON.stringify({ payload: item.data, updated_at: new Date().toISOString() })
        });
        console.log('[Retry] debt 重试成功');
      } else if (item.type === 'expense') {
        const rows = item.data.map(e => ({
          id: e.id, date: e.date, amount: e.amount,
          category: e.category, payment: e.payment,
          note: e.note || '', month: e.date.slice(0, 7)
        }));
        await sbFetch(EXPENSE_TABLE + '?on_conflict=id', {
          method: 'POST',
          prefer: 'resolution=merge-duplicates,return=minimal',
          body: JSON.stringify(rows)
        });
        console.log('[Retry] expense 重试成功，共', rows.length, '条');
      }
    } catch (e) {
      console.warn('[Retry] 重试失败，继续保留:', e.message);
      failed.push(item);
    }
  }
  localStorage.setItem(PENDING_SAVES_KEY, JSON.stringify(failed));
  if (failed.length === 0) {
    setSyncStatus('ok');
    showToast('✅ 离线数据已同步到云端');
  }
}

// 监听网络恢复，自动重试
window.addEventListener('online', () => {
  console.log('[Network] 网络已恢复，尝试重试待同步数据');
  setTimeout(flushPendingSaves, 1000);
});

// ===== 初始化 =====
function safeRender(name, fn) {
  try { fn(); }
  catch (e) { console.error('[Render] ' + name + ' 失败:', e); }
}

function init() {
  safeRender('SummaryBanner',      renderSummaryBanner);
  safeRender('BankCards',          renderBankCards);
  safeRender('PieChart',           renderPieChart);
  safeRender('BarChart',           renderBarChart);
  safeRender('Calendar',           () => renderCalendar(calendarDate));
  safeRender('Installments',       renderInstallments);
  safeRender('Timeline',           renderTimeline);
  safeRender('WhatIf',             initWhatIf);
  initExpenses().catch(e => console.error('[Render] Expenses 失败:', e));
  safeRender('Wallets',            renderWallets);
  safeRender('BillingStatus',      renderBillingStatus);
  safeRender('ExpenseOverview',    renderExpenseOverview);
  safeRender('PaymentReminders',   schedulePaymentReminders);
  safeRender('AutoSettle',         initAutoSettle);
  try {
    document.getElementById('lastUpdated').textContent = '更新于 ' + DATA.meta.lastUpdated;
  } catch (e) {}
  // 启动时检查并重试待同步数据
  setTimeout(flushPendingSaves, 2000);
}

// ===== 获取未出账消费总额 =====
// ===== 公共：计算指定卡的当前账单周期日期范围 =====
// 返回 { cycleStart, cycleEnd }，均为 dayjs 对象
// 规则：账单日当天的消费归入下一期（未出账）
function getBillingCycleDates(cardId) {
  const cfg = CARD_BILLING[cardId];
  if (!cfg) return null;
  const now = today;
  let cycleStart, cycleEnd;
  if (now.date() < cfg.billDay) {
    cycleStart = now.subtract(1, 'month').date(cfg.billDay).startOf('day');
    cycleEnd = now.date(cfg.billDay - 1).endOf('day');
  } else {
    cycleStart = now.date(cfg.billDay).startOf('day');
    cycleEnd = now.add(1, 'month').date(cfg.billDay - 1).endOf('day');
  }
  return { cycleStart, cycleEnd };
}

// ===== 公共：判断日期是否在周期内（含两端）=====
function isDateInCycle(dateStr, cycleStart, cycleEnd) {
  const d = dayjs(dateStr);
  return (d.isSame(cycleStart, 'day') || d.isAfter(cycleStart)) &&
         (d.isSame(cycleEnd, 'day') || d.isBefore(cycleEnd));
}

// ===== 公共：判断消费是否属于"主动还款"（不应计入未出账）=====
// 主动还款特征：category 含"还款" 且 note 不含"[退款]"/"退款"
function isRepayment(expense) {
  const cat = expense.category || '';
  const note = expense.note || '';
  if (!cat.includes('还款')) return false;
  // 如果备注里有"退款"字样，说明是商家退款，不是主动还款
  return !note.includes('退款');
}

// ===== 公共：消费变更后统一联动刷新所有相关板块 =====
function refreshAfterExpenseChange() {
  renderExpenseTable();
  renderExpenseStats();
  renderBillingStatus();
  renderExpenseOverview();
  renderAnalysisPage();
  // 以下板块依赖 getUnpaidTotal / calcUsedCredit，消费变动后需刷新
  renderSummaryBanner();
  renderBankCards();
  renderPieChart();
  renderBarChart();
}

function getUnpaidTotal(cardId) {
  const cycle = getBillingCycleDates(cardId);
  if (!cycle) return 0;
  let { cycleStart, cycleEnd } = cycle;
  const expenses = getExpenses();
  const cfg = CARD_BILLING[cardId];

  // 如果当期账单已出（currentBillAmount > 0 且 currentBillEnd <= 今天），
  // 未出账只算账单截止日之后的消费，避免已出账消费与 currentBillAmount 重复计入。
  // 如果 currentBillEnd 在今天之后，说明当前期还没出账，保持原始 cycleStart。
  let acc = null;
  if (DATA && DATA.banks) {
    DATA.banks.forEach(b => b.accounts.forEach(a => { if (a.id === cardId) acc = a; }));
  }
  if (acc && acc.currentBillAmount > 0) {
    const billEndDate = acc.currentBillEnd ? dayjs(acc.currentBillEnd) : null;
    const billAlreadyIssued = billEndDate && !billEndDate.isAfter(today, 'day'); // <= today
    if (billAlreadyIssued) {
      // 账单已出（出账日当天或之前），未出账从 currentBillEnd 当天开始
      cycleStart = billEndDate.startOf('day');
    } else if (!acc.currentBillEnd) {
      // 没有 currentBillEnd 且账单已出：按 billDay 推算
      const billDay = cfg.billDay;
      const now = today;
      if (now.date() >= billDay) {
        cycleStart = now.date(billDay).startOf('day');
      } else {
        cycleStart = cycleEnd.add(1, 'day');
      }
    }
    // else: currentBillEnd > today，当前期还没出账，保持原始 cycleStart
  }

  const cardName = cfg.name;
  const BANK_SHORT_MAP = { 'abc-credit-1': '农行' };
  const bankShort = BANK_SHORT_MAP[cardId] || cardName.replace('信用卡', '').replace('银行', '');

  const unpaidExpenses = expenses.filter(e => {
    // 排除主动还款记录
    if (isRepayment(e)) return false;
    if (!isDateInCycle(e.date, cycleStart, cycleEnd)) return false;
    return e.cardId === cardId ||
           (e.payment && (e.payment === cardName || e.payment.includes(bankShort)));
  });

  return unpaidExpenses.reduce((s, e) => s + e.amount, 0);
}

// ===== 获取账户净负债（全部剩余待还）=====
function getNetDebt(acc) {
  if (acc.type === 'credit') {
    // 账单剩余 = 当期账单 - 已还
    // 注意：currentBillAmount 可能为 0（表示本期无账单），不能用 || 判断
    const billAmount = (acc.currentBillAmount != null ? acc.currentBillAmount : acc.minPayment) || 0;
    const paidAmount = acc.paidAmount || 0;
    const billRemaining = Math.max(0, billAmount - paidAmount);

    // 未来分期待还（remainingAmount 不含当期，当期已在账单内）
    const futureInstallments = (acc.installments || []).reduce((s, i) => s + (i.remainingAmount || 0), 0);

    // 未出账消费
    const unpaidTotal = getUnpaidTotal(acc.id);

    return billRemaining + futureInstallments + unpaidTotal;
  }
  return acc.totalDebt || 0;
}

// ===== 计算信用卡已用额度（动态）=====
function calcUsedCredit(acc) {
  if (acc.type !== 'credit') return 0;

  // 如果有 totalDebt（银行提供的真实已用额度），优先使用
  // totalDebt 已包含账单、分期本金+利息等全部占用，比拼凑计算更准确
  if (acc.totalDebt > 0 && acc.creditLimit > 0) {
    return acc.totalDebt;
  }

  // 兜底：动态拼凑计算
  const billAmount = (acc.currentBillAmount != null ? acc.currentBillAmount : 0);
  const paidAmount = acc.paidAmount || 0;
  const billRemaining = Math.max(0, billAmount - paidAmount);

  // 分期剩余本金（银行按本金占额度，不含利息）
  const instPrincipal = (acc.installments || []).reduce((s, i) => s + (i.remainingPrincipal || i.remainingAmount || 0), 0);

  // 未出账净值
  const unpaidTotal = getUnpaidTotal(acc.id);

  return billRemaining + instPrincipal + unpaidTotal;
}

// ===== 计算汇总数据 =====
function calcSummary() {
  let totalDebt = 0;
  let monthlyDue = 0;
  let nextDue = null;
  const now = today;

  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      if (acc.type === 'loan') {
        // 贷款：直接用 totalDebt（本金余额）
        totalDebt += acc.totalDebt || 0;
        monthlyDue += acc.monthlyPayment || 0;
        const dueDay = acc.dueDay;
        let dueDate = now.date(dueDay);
        if (dueDate.isBefore(now, 'day')) dueDate = dueDate.add(1, 'month');
        if (!nextDue || dueDate.isBefore(nextDue)) nextDue = dueDate;

      } else if (acc.type === 'credit') {
        // 信用卡：用计算值（账单剩余 + 分期待还 + 未出账消费）
        totalDebt += getNetDebt(acc);

        // 月供：当期账单（含分期月供），减去已还部分
        const billAmount = (acc.currentBillAmount != null ? acc.currentBillAmount : acc.minPayment) || 0;
        const paidAmount = acc.paidAmount || 0;
        monthlyDue += Math.max(0, billAmount - paidAmount);

        // 还款日
        const dueDay = acc.dueDay;
        let dueDate = now.date(dueDay);
        if (dueDate.isBefore(now, 'day')) dueDate = dueDate.add(1, 'month');
        if (!nextDue || dueDate.isBefore(nextDue)) nextDue = dueDate;
      }
    });
  });

  return { totalDebt, monthlyDue, nextDue };
}

// ===== 汇总横幅 =====
function renderSummaryBanner() {
  const { totalDebt, monthlyDue, nextDue } = calcSummary();

  document.getElementById('totalDebt').textContent = fmt(totalDebt);
  document.getElementById('monthlyDue').textContent = fmt(monthlyDue);

  // 可用余额 = 所有钱包余额之和
  const wallets = DATA.meta.wallets || [];
  const totalWallet = wallets.reduce((s, w) => s + (w.balance || 0), 0);
  const walletEl = document.getElementById('totalWalletBalance');
  if (walletEl) {
    walletEl.textContent = fmtDecimal(totalWallet);
    walletEl.className = 'summary-value ' + (totalWallet >= monthlyDue ? 'success' : 'warning');
  }

  // 本月结余 = 可用余额 - 本月应还
  const balance = totalWallet - monthlyDue;
  const balanceEl = document.getElementById('monthlyBalance');
  if (balanceEl) {
    balanceEl.textContent = fmtDecimal(balance);
    balanceEl.className = 'summary-value ' + (balance >= 0 ? 'success' : 'danger');
  }

  if (nextDue) {
    const daysLeft = nextDue.diff(today, 'day');
    document.getElementById('nextDueDate').textContent =
      nextDue.format('MM月DD日') + (daysLeft <= 3 ? ` (${daysLeft}天后)` : '');
  }
}

// ===== 钱包余额面板 =====
const DEFAULT_WALLETS = [
  { id: 'wallet-savings', name: '储蓄卡',    icon: '🏦', balance: 0 },
  { id: 'wallet-wechat',  name: '微信钱包',  icon: '💚', balance: 0 },
  { id: 'wallet-alipay',  name: '支付宝余额', icon: '💙', balance: 0 }
];

function getWallets() {
  // 兜底：若云端数据没有 wallets 字段，补充默认值
  if (!DATA.meta.wallets || DATA.meta.wallets.length === 0) {
    DATA.meta.wallets = JSON.parse(JSON.stringify(DEFAULT_WALLETS));
  }
  return DATA.meta.wallets;
}

function renderWallets() {
  const panel = document.getElementById('walletPanel');
  const editPanel = document.getElementById('walletEditPanel');
  if (!panel || !DATA) return;

  const wallets = getWallets();
  const totalWallet = wallets.reduce((s, w) => s + (w.balance || 0), 0);
  const monthlyDue = calcSummary().monthlyDue;
  const canCover = totalWallet >= monthlyDue;

  // 展示面板：每个钱包单独一张卡片，显示名称+余额
  let html = `<div class="wallet-cards">`;
  wallets.forEach(w => {
    html += `
      <div class="wallet-card">
        <div class="wallet-card-icon">${w.icon}</div>
        <div class="wallet-card-name">${w.name}</div>
        <div class="wallet-card-balance">${fmtDecimal(w.balance)}</div>
      </div>`;
  });
  html += `</div>`;
  html += `<div class="wallet-cover-tip ${canCover ? 'ok' : 'warn'}">
    ${canCover
      ? `✅ 余额合计 ${fmtDecimal(totalWallet)}，可覆盖本月应还 ${fmt(monthlyDue)}`
      : `⚠️ 余额合计 ${fmtDecimal(totalWallet)}，距本月应还 ${fmt(monthlyDue)} 还差 ${fmt(monthlyDue - totalWallet)}`}
  </div>`;
  panel.innerHTML = html;

  // 编辑面板：每个钱包一行，带图标+名称标签+输入框
  let editHtml = `<div class="wallet-edit-form">`;
  wallets.forEach((w, i) => {
    editHtml += `
      <div class="wallet-edit-row">
        <label class="wallet-edit-label">${w.icon} ${w.name}</label>
        <input class="wallet-edit-input" type="number" inputmode="decimal" step="0.01" min="0"
          data-wallet-idx="${i}" value="${w.balance || 0}" placeholder="输入余额" />
      </div>`;
  });
  editHtml += `
    <div class="wallet-edit-actions">
      <button class="btn-save" onclick="saveWallets()">💾 保存</button>
      <button class="btn-cancel" onclick="toggleWalletEdit()">取消</button>
    </div>
  </div>`;
  editPanel.innerHTML = editHtml;
}

function toggleWalletEdit() {
  const ep = document.getElementById('walletEditPanel');
  const btn = document.getElementById('walletEditBtn');
  if (!ep) return;
  const isOpen = ep.style.display !== 'none';
  if (!isOpen) {
    // 展开时重新渲染，确保输入框内容最新
    renderWallets();
    ep.style.display = 'block';
    btn.textContent = '✕ 收起';
    // 自动聚焦第一个输入框
    setTimeout(() => {
      const first = ep.querySelector('.wallet-edit-input');
      if (first) first.focus();
    }, 100);
  } else {
    ep.style.display = 'none';
    btn.textContent = '✏️ 更新余额';
  }
}

async function saveWallets() {
  const inputs = document.querySelectorAll('[data-wallet-idx]');
  inputs.forEach(inp => {
    const idx = parseInt(inp.dataset.walletIdx);
    DATA.meta.wallets[idx].balance = parseFloat(inp.value) || 0;
  });
  DATA.meta.lastUpdated = today.format('YYYY-MM-DD');
  await saveData();
  renderWallets();
  renderSummaryBanner();
  toggleWalletEdit();
  showToast('钱包余额已更新');
}

// ===== 银行卡片 =====
function renderBankCards() {
  const container = document.getElementById('bankCards');
  container.innerHTML = '';

  DATA.banks.forEach((bank, i) => {
    const bankTotal = bank.accounts.reduce((s, a) => s + getNetDebt(a), 0);

    const card = document.createElement('div');
    card.className = 'bank-card';
    card.style.setProperty('--bank-color', bank.color);
    card.style.animationDelay = (i * 0.05) + 's';

    let accountsHTML = '';
    bank.accounts.forEach(acc => {
      // savings 类型没有还款日，跳过还款日计算
      if (acc.type === 'savings') return;

      const dueDay = acc.dueDay;
      const now = today;
      let dueDate = dueDay ? now.date(dueDay) : null;
      if (dueDate && dueDate.isBefore(now, 'day')) dueDate = dueDate.add(1, 'month');
      const daysLeft = dueDate ? dueDate.diff(now, 'day') : null;
      const isUrgent = daysLeft != null && daysLeft <= 5;

      let extraInfo = '';
      if (acc.type === 'credit') {
        // 已用额度：动态计算 = 账单剩余 + 分期剩余本金 + 未出账净值
        const usedCredit = calcUsedCredit(acc);
        const usedPct = usedCredit / acc.creditLimit;
        extraInfo = `
          <div class="credit-bar">
            <div class="credit-bar-fill" style="width:${Math.min(usedPct * 100, 100)}%"></div>
          </div>
          <div class="account-meta" style="margin-top:6px">
            <span>额度 ${fmt(acc.creditLimit)}</span>
            <span>已用 ${fmtPct(usedPct)}</span>
            ${acc.installments?.length ? `<span>分期 ${acc.installments.length} 笔</span>` : ''}
          </div>`;
      } else {
        extraInfo = `
          <div class="account-meta" style="margin-top:6px">
            <span>月供 ${fmt(acc.monthlyPayment)}</span>
            <span>剩余 ${acc.remainingMonths} 期</span>
            <span>利率 ${(acc.interestRate * 100).toFixed(2)}%</span>
          </div>`;
      }

      const dueTxt = dueDate
        ? `还款日 <span class="due-badge ${isUrgent ? 'urgent' : ''}">${dueDay}号 (${daysLeft}天后)</span>`
        : '';
      accountsHTML += `
        <div class="account-item">
          <div class="account-header">
            <span class="account-name">${acc.name}</span>
            <span class="account-amount">${fmt(getNetDebt(acc))}</span>
          </div>
          ${dueTxt ? `<div class="account-meta"><span>${dueTxt}</span></div>` : ''}
          ${extraInfo}
        </div>`;
    });

    // 取第一个账户 id 作为 What-if 默认目标
    const firstAcc = bank.accounts[0];
    card.innerHTML = `
      <div class="bank-card-header">
        <span class="bank-icon">${bank.icon}</span>
        <span class="bank-name">${bank.name}</span>
        <span class="bank-total">${fmt(bankTotal)}</span>
      </div>
      <div class="bank-accounts">${accountsHTML}</div>
      <button class="whatif-entry-btn" onclick="openWhatif('${bank.id}','${firstAcc?.id || ''}')">🔮 还款模拟</button>`;

    container.appendChild(card);
  });
}

// ===== 饼图 =====
function renderPieChart() {
  if (typeof Chart === 'undefined') {
    console.warn('[Chart] Chart.js 未加载，跳过饼图渲染');
    return;
  }
  const labels = [];
  const values = [];
  const colors = [];

  DATA.banks.forEach(bank => {
    const total = bank.accounts.reduce((s, a) => s + getNetDebt(a), 0);
    if (total > 0) {
      labels.push(bank.shortName);
      values.push(total);
      colors.push(bank.color);
    }
  });

  const ctx = document.getElementById('pieChart').getContext('2d');
  if (pieChart) pieChart.destroy();

  pieChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors.map(c => c + 'cc'),
        borderColor: colors,
        borderWidth: 2,
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#8892b0',
            padding: 12,
            font: { size: 12 },
            usePointStyle: true
          }
        },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.label}: ${fmt(ctx.raw)} (${fmtPct(ctx.raw / values.reduce((a, b) => a + b, 0))})`
          }
        }
      }
    }
  });
}

// ===== 柱状图（未来12个月还款压力）=====
function renderBarChart() {
  if (typeof Chart === 'undefined') {
    console.warn('[Chart] Chart.js 未加载，跳过柱状图渲染');
    return;
  }
  const months = [];
  const payments = [];

  for (let i = 0; i < 12; i++) {
    const m = today.add(i, 'month');
    months.push(m.format('YYYY年M月'));
    let total = 0;

    DATA.banks.forEach(bank => {
      bank.accounts.forEach(acc => {
        if (acc.type === 'loan') {
          // 贷款：检查是否还在还款期内
          const endDate = dayjs(acc.endDate || acc.startDate);
          if (m.isBefore(endDate) || m.isSame(endDate, 'month')) {
            total += acc.monthlyPayment || 0;
          }
        } else if (acc.type === 'credit') {
          if (i === 0) {
            // 当月：用实际账单minPayment（已含当期分期，不重复加installments）
            // minPaymentOneTime=true 表示一次性历史欠款（如浦发5月账单剩余），只计当月
            total += acc.minPayment || 0;
          } else {
            // 未来月份：用各分期月供之和估算（minPayment每月出账后才知道）
            // minPaymentOneTime的一次性欠款不计入未来月份
            acc.installments?.forEach(inst => {
              const endDate = dayjs(inst.endDate);
              if (m.isBefore(endDate) || m.isSame(endDate, 'month')) {
                total += inst.monthlyPayment || 0;
              }
            });
          }
        }
      });
    });

    payments.push(total);
  }

  const income = DATA.meta.monthlyIncome || DATA.meta.baseIncome || 10000;
  const ctx = document.getElementById('barChart').getContext('2d');
  if (barChart) barChart.destroy();

  barChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: months,
      datasets: [
        {
          label: '月还款额',
          data: payments,
          backgroundColor: payments.map(p =>
            p / income > 0.5 ? 'rgba(255,77,109,0.7)' :
            p / income > 0.35 ? 'rgba(255,169,77,0.7)' :
            'rgba(108,99,255,0.7)'
          ),
          borderColor: payments.map(p =>
            p / income > 0.5 ? '#ff4d6d' :
            p / income > 0.35 ? '#ffa94d' :
            '#6c63ff'
          ),
          borderWidth: 1,
          borderRadius: 4
        },
        {
          label: '月收入',
          data: Array(12).fill(income),
          type: 'line',
          borderColor: 'rgba(0,212,170,0.6)',
          borderDash: [6, 3],
          borderWidth: 2,
          pointRadius: 0,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: '#8892b0', font: { size: 12 }, usePointStyle: true }
        },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${fmt(ctx.raw)}`
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#8892b0', font: { size: 11 }, maxRotation: 45 },
          grid: { color: 'rgba(46,50,80,0.5)' }
        },
        y: {
          ticks: {
            color: '#8892b0',
            callback: (v) => v >= 1000 ? '¥' + (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : fmt(v)
          },
          grid: { color: 'rgba(46,50,80,0.5)' }
        }
      }
    }
  });
}

// ===== 还款日历 =====
function buildDueDays(month) {
  // 返回 { day: [{bankName, accountName, amount, color, type}] }
  const dueDays = {};

  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      const dueDay = acc.dueDay;
      if (!dueDay) return;
      if (!dueDays[dueDay]) dueDays[dueDay] = [];

      let amount = 0;
      let typeName = '';
      if (acc.type === 'loan') {
        const endDate = dayjs(acc.endDate || '2099-01-01');
        if (month.isBefore(endDate) || month.isSame(endDate, 'month')) {
          amount = acc.monthlyPayment || 0;
          typeName = '贷款';
        }
      } else if (acc.type === 'credit') {
        // 只用 minPayment，不重复加分期月供
        amount = acc.minPayment || 0;
        typeName = amount > 0 ? '信用卡账单' : '';
      }

      if (amount > 0) {
        dueDays[dueDay].push({
          bankName: bank.shortName,
          accountName: acc.name,
          amount,
          color: bank.color,
          type: typeName
        });
      }
    });
  });

  return dueDays;
}

function openCalDrawer(dateStr, dues) {
  const mask = document.getElementById('calDrawerMask');
  const drawer = document.getElementById('calDrawer');
  const title = document.getElementById('calDrawerTitle');
  const list = document.getElementById('calDrawerList');
  const totalEl = document.getElementById('calDrawerTotal');

  title.textContent = dateStr + ' 还款详情';

  let listHTML = '';
  let total = 0;
  dues.forEach(item => {
    total += item.amount;
    listHTML += `
      <div class="calendar-drawer-item">
        <div class="calendar-drawer-item-left">
          <div class="calendar-drawer-dot" style="background:${item.color}"></div>
          <div>
            <div class="calendar-drawer-bank">${item.bankName}</div>
            <div class="calendar-drawer-type">${item.accountName}${item.type ? ' · ' + item.type : ''}</div>
          </div>
        </div>
        <div class="calendar-drawer-amount">-${fmt(item.amount)}</div>
      </div>`;
  });
  list.innerHTML = listHTML;
  totalEl.innerHTML = `<span>合计应还</span><span class="calendar-drawer-total-amt">-${fmt(total)}</span>`;

  mask.classList.add('open');
  drawer.classList.add('open');
}

function closeCalDrawer() {
  document.getElementById('calDrawerMask').classList.remove('open');
  document.getElementById('calDrawer').classList.remove('open');
}

function renderCalendar(month) {
  calendarDate = month;
  const container = document.getElementById('calendarWrap');
  const dueDays = buildDueDays(month);

  const firstDay = month.startOf('month').day(); // 0=周日
  const daysInMonth = month.daysInMonth();
  const todayDay = today.isSame(month, 'month') ? today.date() : -1;
  const isCurrentMonth = today.isSame(month, 'month');

  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];

  let html = `
    <div class="calendar-header">
      <div class="calendar-header-left">
        <div class="calendar-nav">
          <button id="calPrev">‹</button>
        </div>
        <span class="calendar-month">${month.format('YYYY年M月')}</span>
        <div class="calendar-nav">
          <button id="calNext">›</button>
        </div>
      </div>
      ${!isCurrentMonth ? '<button class="calendar-today-btn" id="calToday">今天</button>' : ''}
    </div>
    <div class="calendar-grid">
      ${weekdays.map(d => `<div class="calendar-weekday">${d}</div>`).join('')}
  `;

  // 空格（周日=0，周一=1...）
  for (let i = 0; i < firstDay; i++) {
    html += '<div class="calendar-day empty"></div>';
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dues = dueDays[d] || [];
    const isToday = d === todayDay;
    const hasDue = dues.length > 0;
    const dow = (firstDay + d - 1) % 7; // 0=日,6=六
    const isSun = dow === 0;
    const isSat = dow === 6;

    let amountsHTML = '';
    if (hasDue) {
      const total = dues.reduce((s, x) => s + x.amount, 0);
      if (dues.length === 1) {
        amountsHTML = `<div class="day-amounts"><span class="day-amount-total">-${fmtShort(total)}</span></div>`;
      } else {
        // 多笔：只显示合计，避免格子太挤
        amountsHTML = `<div class="day-amounts">
          <span class="day-amount-item">${dues.length}笔</span>
          <span class="day-amount-total">-${fmtShort(total)}</span>
        </div>`;
      }
    }

    const classes = [
      'calendar-day',
      isToday ? 'today' : '',
      hasDue ? 'has-due' : '',
      isSun ? 'is-sun' : '',
      isSat ? 'is-sat' : '',
    ].filter(Boolean).join(' ');

    const dataAttr = hasDue ? `data-day="${d}"` : '';

    html += `
      <div class="${classes}" ${dataAttr}>
        <span class="day-num">${d}</span>
        ${amountsHTML}
      </div>`;
  }

  html += '</div>';
  container.innerHTML = html;

  // 导航事件
  document.getElementById('calPrev').addEventListener('click', () => renderCalendar(calendarDate.subtract(1, 'month')));
  document.getElementById('calNext').addEventListener('click', () => renderCalendar(calendarDate.add(1, 'month')));
  const todayBtn = document.getElementById('calToday');
  if (todayBtn) todayBtn.addEventListener('click', () => renderCalendar(dayjs()));

  // 点击有还款的格子 → 弹出抽屉
  container.querySelectorAll('.calendar-day.has-due').forEach(el => {
    el.addEventListener('click', () => {
      const d = parseInt(el.dataset.day);
      const dues = dueDays[d] || [];
      const dateStr = month.date(d).format('M月D日');
      openCalDrawer(dateStr, dues);
    });
  });

  // 抽屉关闭
  document.getElementById('calDrawerMask').onclick = closeCalDrawer;
}

// ===== 分期追踪 =====
function renderInstallments() {
  const container = document.getElementById('installmentList');
  container.innerHTML = '';

  DATA.banks.forEach(bank => {
    const allInsts = [];
    bank.accounts.forEach(acc => {
      if (acc.installments?.length) {
        acc.installments.forEach(inst => allInsts.push({ ...inst, accountName: acc.name }));
      }
    });

    if (allInsts.length === 0) return;

    const group = document.createElement('div');
    group.className = 'installment-bank-group';

    let cardsHTML = '';
    allInsts.forEach((inst, instIdx) => {
      const paid = inst.originalAmount - inst.remainingAmount;
      const pct = paid / inst.originalAmount;
      const endDate = dayjs(inst.endDate);
      const startDate = dayjs(inst.startDate);
      const totalMonths = inst.totalMonths || (inst.remainingMonths + Math.round(paid / inst.monthlyPayment));
      const monthsLeft = inst.remainingMonths;
      const cardId = `inst-detail-${bank.id}-${instIdx}`;

      // 生成还款计划：优先用 data.json 里的精确字段，没有时才推算
      const principalPerMonth = inst.principalPerMonth || (inst.originalAmount / totalMonths);
      const interestPerMonth = inst.interestPerMonth !== undefined ? inst.interestPerMonth : (inst.monthlyPayment - principalPerMonth);
      // 剩余本金/利息：优先用精确字段，否则用 remainingMonths × perMonth 推算
      const remainingPrincipal = inst.remainingPrincipal != null
        ? inst.remainingPrincipal
        : Math.round(principalPerMonth * monthsLeft * 100) / 100;
      const remainingInterest = inst.remainingInterest != null
        ? inst.remainingInterest
        : Math.round(interestPerMonth * monthsLeft * 100) / 100;
      let scheduleHTML = '';
      // 已还期数：优先用显式字段，否则用 totalMonths - remainingMonths
      const paidPeriods = inst.paidPeriods != null ? inst.paidPeriods : (totalMonths - monthsLeft);
      for (let i = 0; i < totalMonths; i++) {
        const periodDate = startDate.add(i, 'month');
        const isPast = i < paidPeriods;
        const isCurrent = i === paidPeriods;
        const isLast = i === totalMonths - 1;
        // 最后一期本金取尾差
        const principal = isLast
          ? Math.max(0, inst.originalAmount - principalPerMonth * (totalMonths - 1))
          : principalPerMonth;
        const interest = isLast
          ? Math.max(0, inst.monthlyPayment - principal)
          : interestPerMonth;
        const statusClass = isPast ? 'inst-period-past' : isCurrent ? 'inst-period-current' : 'inst-period-future';
        const statusDot = isPast ? '●' : isCurrent ? '●' : '○';
        scheduleHTML += `
          <div class="inst-period-row ${statusClass}">
            <span class="inst-period-dot">${statusDot}</span>
            <span class="inst-period-num">第${i + 1}期</span>
            <span class="inst-period-date">${periodDate.format('YYYY-MM-DD')}</span>
            <span class="inst-period-principal">本金 ${fmt(principal)}</span>
            <span class="inst-period-interest">利息 ${fmt(interest)}</span>
          </div>`;
      }

      cardsHTML += `
        <div class="installment-card" onclick="toggleInstDetail('${cardId}')" style="cursor:pointer">
          <div class="inst-header">
            <div>
              <div class="inst-name">${inst.name}</div>
              <div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px">${inst.accountName}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <span class="inst-status">${monthsLeft > 0 ? '还款中' : '已结清'}</span>
              <span class="inst-expand-arrow" id="arrow-${cardId}">▼</span>
            </div>
          </div>
          <div class="inst-progress-wrap">
            <div class="inst-progress-label">
              <span>已还 ${fmt(paid)}</span>
              <span>${fmtPct(pct)}</span>
            </div>
            <div class="inst-progress-bar">
              <div class="inst-progress-fill" style="width:${pct * 100}%"></div>
            </div>
          </div>
          <div class="inst-meta">
            <div class="inst-meta-item">
              <span class="inst-meta-label">原始金额</span>
              <span class="inst-meta-value">${fmt(inst.originalAmount)}</span>
            </div>
            <div class="inst-meta-item">
              <span class="inst-meta-label">剩余本金</span>
              <span class="inst-meta-value" style="color:var(--warning)">${fmt(remainingPrincipal)}</span>
            </div>
            <div class="inst-meta-item">
              <span class="inst-meta-label">剩余利息</span>
              <span class="inst-meta-value" style="color:var(--text-muted)">${fmt(remainingInterest)}</span>
            </div>
            <div class="inst-meta-item">
              <span class="inst-meta-label">月供</span>
              <span class="inst-meta-value">${fmt(inst.monthlyPayment)}</span>
            </div>
            <div class="inst-meta-item">
              <span class="inst-meta-label">剩余期数</span>
              <span class="inst-meta-value">${monthsLeft} 期</span>
            </div>
            <div class="inst-meta-item">
              <span class="inst-meta-label">开始日期</span>
              <span class="inst-meta-value">${inst.startDate}</span>
            </div>
            <div class="inst-meta-item">
              <span class="inst-meta-label">结束日期</span>
              <span class="inst-meta-value">${inst.endDate}</span>
            </div>
          </div>
          <div class="inst-detail-panel" id="${cardId}" style="display:none">
            <div class="inst-detail-title">📋 还款计划（共${totalMonths}期）</div>
            <div class="inst-schedule">${scheduleHTML}</div>
          </div>
        </div>`;
    });

    group.innerHTML = `
      <div class="installment-bank-title">
        <span>${bank.icon}</span>
        <span style="color:${bank.color}">${bank.name}</span>
        <span style="color:var(--text-muted);font-weight:400;font-size:0.82rem">${allInsts.length} 笔分期</span>
      </div>
      <div class="installment-cards">${cardsHTML}</div>`;

    container.appendChild(group);
  });

  if (container.innerHTML === '') {
    container.innerHTML = '<div class="empty-state">暂无分期记录</div>';
  }
}

// 展开/收起分期还款计划
function toggleInstDetail(cardId) {
  const panel = document.getElementById(cardId);
  const arrow = document.getElementById('arrow-' + cardId);
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';
  if (arrow) arrow.textContent = isOpen ? '▼' : '▲';
}

// ===== 结清时间线 =====
function renderTimeline() {
  const container = document.getElementById('timelineList');
  const items = [];

  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {

      if (acc.type === 'loan') {
        // ---- 贷款：一个账户一个条目 ----
        const endDate = dayjs(acc.endDate);
        let totalAmount, paidAmount, monthlyPayment, note;

        const isInterestOnly = acc.remainingMonths > 0 &&
          acc.monthlyPayment < (acc.totalDebt / acc.remainingMonths) * 0.3;

        if (isInterestOnly) {
          monthlyPayment = acc.monthlyPayment;
          totalAmount = acc.totalDebt;
          paidAmount = 0;
          note = '到期还本';
        } else {
          const remainingTotal = acc.monthlyPayment * acc.remainingMonths;
          totalAmount = remainingTotal + acc.totalDebt;
          paidAmount = totalAmount - acc.totalDebt;
          monthlyPayment = acc.monthlyPayment;
        }

        // 优先使用 remainingMonths 字段（精确），endDate.diff 会因日期截断少算
        const monthsLeft = acc.remainingMonths != null
          ? acc.remainingMonths
          : Math.max(0, endDate.diff(today, 'month'));
        const pct = totalAmount > 0 ? Math.min(Math.max(paidAmount / totalAmount, 0), 1) : 0;

        items.push({
          type: 'loan',
          endDate, monthsLeft,
          bankName: bank.name, bankIcon: bank.icon, bankColor: bank.color,
          accountName: acc.name,
          totalDebt: acc.totalDebt,
          monthlyPayment, pct,
          note: note || ''
        });

      } else if (acc.type === 'credit') {
        // ---- 信用卡：每笔分期单独一个条目 ----
        if (acc.installments && acc.installments.length > 0) {
          acc.installments.forEach(inst => {
            const endDate = dayjs(inst.endDate);
            const paid = inst.originalAmount - inst.remainingAmount;
            const pct = inst.originalAmount > 0
              ? Math.min(Math.max(paid / inst.originalAmount, 0), 1) : 0;
            // 优先使用 remainingMonths 字段
            const monthsLeft = inst.remainingMonths != null
              ? inst.remainingMonths
              : Math.max(0, endDate.diff(today, 'month'));

            items.push({
              type: 'credit-inst',
              endDate, monthsLeft,
              bankName: bank.name, bankIcon: bank.icon, bankColor: bank.color,
              accountName: acc.name,
              instName: inst.name,
              totalDebt: inst.remainingAmount,
              originalAmount: inst.originalAmount,
              monthlyPayment: inst.monthlyPayment || 0,
              pct,
              note: '信用卡分期'
            });
          });
        } else {
          // 无分期：按最低还款估算结清时间
          const rate = acc.interestRate * 30;
          const netDebt = getNetDebt(acc);
          // 净负债为 0 的信用卡无需出现在结清时间线中
          if (netDebt <= 0) return;
          const minPay = acc.minPayment || netDebt;
          let balance = netDebt;
          let months = 0;
          while (balance > 0.01 && months < 360) {
            const interest = balance * rate;
            balance = balance + interest - minPay;
            months++;
            if (minPay <= interest) { months = 1; break; }
          }
          const endDate = today.add(months, 'month');
          const monthsLeft = months;

          items.push({
            type: 'credit',
            endDate, monthsLeft,
            bankName: bank.name, bankIcon: bank.icon, bankColor: bank.color,
            accountName: acc.name,
            totalDebt: netDebt,
            monthlyPayment: minPay,
            pct: 0,
            note: '按最低还款估算'
          });
        }
      }
    });
  });

  // 按结清日期排序
  items.sort((a, b) => a.endDate.valueOf() - b.endDate.valueOf());

  let html = '<div class="timeline">';
  items.forEach(item => {
    const isDone = item.monthsLeft === 0;
    const isSoon = item.monthsLeft <= 3 && !isDone;
    const dotClass = isDone ? 'done' : isSoon ? 'soon' : '';

    // 标题行：贷款显示账户名，分期显示"账户 · 分期名"
    const titleMain = item.type === 'credit-inst'
      ? `${item.bankIcon} ${item.bankName} · ${item.accountName} · ${item.instName}`
      : `${item.bankIcon} ${item.bankName} · ${item.accountName}`;

    // 负债显示：分期显示剩余/原始，贷款显示当前负债
    const debtLabel = item.type === 'credit-inst'
      ? `剩余 ${fmt(item.totalDebt)} / 原始 ${fmt(item.originalAmount)}`
      : `当前负债 ${fmt(item.totalDebt)}`;

    html += `
      <div class="timeline-item">
        <div class="timeline-dot ${dotClass}"></div>
        <div class="timeline-card">
          <div class="timeline-date">${item.endDate.format('YYYY年M月')} 结清 · 还剩 ${item.monthsLeft} 个月</div>
          <div class="timeline-title">${titleMain}${item.note ? ` <span class="tl-note">${item.note}</span>` : ''}</div>
          <div class="timeline-bar">
            <div class="timeline-bar-fill" style="width:${item.pct * 100}%"></div>
          </div>
          <div class="timeline-meta">
            <span>${debtLabel}</span>
            <span>月供 ${fmt(item.monthlyPayment)}</span>
            <span>进度 ${fmtPct(item.pct)}</span>
          </div>
        </div>
      </div>`;
  });
  html += '</div>';

  container.innerHTML = html;
}

// ===== What-if 模拟 =====
function initWhatIf() {
  // 账户选择器由 openWhatif() 动态填充
  // 只绑定计算按钮
  const calcBtn = document.getElementById('whatifCalc');
  if (calcBtn) calcBtn.addEventListener('click', calcWhatIf);

  // 账户选择变化时更新标题
  const select = document.getElementById('whatifAccount');
  if (select) select.addEventListener('change', () => {
    try {
      const { bankId, accId } = JSON.parse(select.value);
      const bank = DATA.banks.find(b => b.id === bankId);
      const acc = bank?.accounts.find(a => a.id === accId);
      const labelEl = document.getElementById('whatifAccountLabel');
      if (labelEl && acc) labelEl.textContent = `${bank.shortName} · ${acc.name}`;
    } catch {}
  });
}

function calcWhatIf() {
  const { bankId, accId } = JSON.parse(document.getElementById('whatifAccount').value);
  const extra = parseFloat(document.getElementById('whatifExtra').value) || 0;
  const lump = parseFloat(document.getElementById('whatifLump').value) || 0;

  const bank = DATA.banks.find(b => b.id === bankId);
  const acc = bank?.accounts.find(a => a.id === accId);
  if (!acc) return;

  const rate = acc.interestRate || 0.0005;
  const monthlyRate = acc.type === 'loan' ? rate / 12 : rate * 30;

  // 基准场景
  const currentDebt = getNetDebt(acc);
  const baseResult = simulatePayoff(currentDebt, acc.monthlyPayment || acc.minPayment, monthlyRate);
  // 优化场景
  const newBalance = Math.max(0, currentDebt - lump);
  const newPayment = (acc.monthlyPayment || acc.minPayment) + extra;
  const optResult = simulatePayoff(newBalance, newPayment, monthlyRate);

  const savedMonths = baseResult.months - optResult.months;
  const savedInterest = baseResult.totalInterest - optResult.totalInterest;

  const resultEl = document.getElementById('whatifResult');
  resultEl.innerHTML = `
    <div class="result-grid">
      <div class="result-item">
        <div class="result-item-label">当前结清时间</div>
        <div class="result-item-value neutral">${baseResult.months} 个月</div>
      </div>
      <div class="result-item">
        <div class="result-item-label">优化后结清时间</div>
        <div class="result-item-value good">${optResult.months} 个月</div>
      </div>
      <div class="result-item">
        <div class="result-item-label">当前总利息</div>
        <div class="result-item-value bad">${fmt(baseResult.totalInterest)}</div>
      </div>
      <div class="result-item">
        <div class="result-item-label">优化后总利息</div>
        <div class="result-item-value good">${fmt(optResult.totalInterest)}</div>
      </div>
      <div class="result-comparison">
        🎯 <strong>优化效果：</strong>
        提前 <strong style="color:var(--success)">${savedMonths} 个月</strong> 结清，
        节省利息 <strong style="color:var(--success)">${fmt(savedInterest)}</strong>。
        ${lump > 0 ? `<br>💰 一次性还款 ${fmt(lump)} 后，剩余本金 ${fmt(newBalance)}。` : ''}
        ${extra > 0 ? `<br>📈 每月额外还款 ${fmt(extra)}，月供提升至 ${fmt(newPayment)}。` : ''}
        ${savedMonths <= 0 ? '<br>⚠️ 当前参数下效果有限，建议增加还款金额。' : ''}
      </div>
    </div>`;
}

function simulatePayoff(balance, monthlyPayment, monthlyRate) {
  let b = balance;
  let months = 0;
  let totalInterest = 0;

  while (b > 0 && months < 600) {
    const interest = b * monthlyRate;
    totalInterest += interest;
    b = b + interest - monthlyPayment;
    months++;
    if (monthlyPayment <= interest && months > 1) {
      // 还款不够覆盖利息
      return { months: 9999, totalInterest: 9999999 };
    }
  }

  return { months, totalInterest };
}

// ===== 消费记录 =====
async function initExpenses() {
  // 设置默认月份筛选
  const filterEl = document.getElementById('expFilterMonth');
  if (filterEl) filterEl.value = today.format('YYYY-MM');

  const filterChange = document.getElementById('expFilterMonth');
  if (filterChange) filterChange.addEventListener('change', () => {
    renderExpenseTable();
    renderAnalysisPage();
  });

  const clearBtn = document.getElementById('clearExpenses');
  if (clearBtn) clearBtn.addEventListener('click', clearMonthExpenses);

  // 尝试从云端加载最新消费记录
  await loadExpensesFromCloud();

  renderExpenseTable();
  renderAnalysisPage();
}

async function loadExpensesFromCloud() {
  try {
    const rows = await sbFetch(EXPENSE_TABLE + '?order=date.desc&limit=500');
    if (rows && Array.isArray(rows)) {
      // 去重：排除"备注含卡尾号但payment为微信/支付宝"的重复记录
      // 判断标准：同日/同金额/同分类已存在对应信用卡的记录
      const cardRows = new Set();
      rows.forEach(r => {
        if (PAYMENT_TO_CARD[r.payment]) {
          cardRows.add(`${r.date}|${r.amount}|${r.category}`);
        }
      });
      const deduped = rows.filter(r => {
        const resolved = resolveCardFromNote(r.note, r.payment);
        if (!resolved) return true; // 无卡尾号，保留
        // 有卡尾号且同笔已存在信用卡版本 → 重复，排除
        const key = `${r.date}|${r.amount}|${r.category}`;
        if (cardRows.has(key)) {
          console.log('[Dedup] 排除重复:', r.date, r.amount, r.payment, r.note);
          return false;
        }
        return true;
      });

      const expenses = deduped.map(r => {
        // 重新计算本地字段（云端不存储这些字段）
        const cardId = PAYMENT_TO_CARD[r.payment] || null;
        const billing = cardId ? getBillingCycle(cardId, r.date) : null;
        return {
          id: r.id, date: r.date, amount: r.amount,
          category: r.category, payment: r.payment, note: r.note,
          cardId,
          billMonth: billing?.billMonth || null,
          dueDate: billing?.dueDate?.format('YYYY-MM-DD') || null,
          isCashAdvance: checkCashAdvance(r.amount, r.note, r.payment)
        };
      });
      // 云端成功才覆盖本地，同时写 localStorage + IDB 双备份
      localStorage.setItem('expenses', JSON.stringify(expenses));
      await idbSave('expenses', expenses);
      console.log('[Expenses] 云端加载成功，共', expenses.length, '条');
      // 云端数据更新后重渲染消费概览（首页）
      renderExpenseOverview();
      // 网络恢复后顺便重试待同步数据
      await flushPendingSaves();
    }
  } catch (e) {
    // 网络失败：尝试从 IDB 恢复
    console.warn('[Expenses] 云端加载失败，尝试 IDB 备份:', e.message);
    const idbExpenses = await idbLoad('expenses');
    if (idbExpenses && Array.isArray(idbExpenses) && idbExpenses.length > 0) {
      localStorage.setItem('expenses', JSON.stringify(idbExpenses));
      console.log('[Expenses] 从 IDB 恢复', idbExpenses.length, '条');
    }
    // 否则保留 localStorage 现有数据，不清空
  }
}

function getExpenses() {
  const all = JSON.parse(localStorage.getItem('expenses') || '[]');
  // 运行时去重：排除"备注含卡尾号+payment非信用卡"且同笔已存在信用卡版本的重复记录
  const cardKeys = new Set();
  all.forEach(e => {
    if (PAYMENT_TO_CARD[e.payment]) {
      cardKeys.add(`${e.date}|${e.amount}|${e.category}`);
    }
  });
  return all.filter(e => {
    const resolved = resolveCardFromNote(e.note, e.payment);
    if (!resolved) return true;
    return !cardKeys.has(`${e.date}|${e.amount}|${e.category}`);
  });
}

async function saveExpenses(expenses) {
  // 1. 先写本地两层
  localStorage.setItem('expenses', JSON.stringify(expenses));
  await idbSave('expenses', expenses);

  // 2. upsert 到云端
  // 注意：只上传表中存在的字段（id/date/amount/category/payment/note/month）
  // cardId/billMonth/dueDate/isCashAdvance 是本地计算字段，不在云端表结构中
  try {
    if (expenses.length > 0) {
      const rows = expenses.map(e => ({
        id: e.id,
        date: e.date,
        amount: e.amount,
        category: e.category,
        payment: e.payment,
        note: e.note || '',
        month: e.date.slice(0, 7)
      }));
      await sbFetch(EXPENSE_TABLE + '?on_conflict=id', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: JSON.stringify(rows)
      });
    }
    clearPendingSave('expense');
    console.log('[Expenses] 云端 upsert 成功，共', expenses.length, '条');
  } catch (e) {
    console.warn('[Expenses] 云端同步失败，加入重试队列:', e.message);
    setSyncStatus('error');
    addPendingSave('expense', expenses);
    showToast('⚠️ 网络异常，消费记录已保存本地，将在网络恢复后自动同步');
  }
}

// ===== 判断消费属于哪个账单周期 =====
// 返回 { billMonth: 'YYYY-MM', dueDate: dayjs对象 }
function getBillingCycle(cardId, expenseDate) {
  const cfg = CARD_BILLING[cardId];
  if (!cfg) return null;
  const d = dayjs(expenseDate);
  // 账单日当天的消费归入下一期账单（即未出账）
  // 账单日之前 → 属于本月账单；账单日当天及之后 → 属于下月账单
  let billMonth;
  if (d.date() < cfg.billDay) {
    billMonth = d.format('YYYY-MM');
  } else {
    billMonth = d.add(1, 'month').format('YYYY-MM');
  }
  // 计算还款日
  const billMonthDay = dayjs(billMonth + '-01');
  let dueDate;
  if (cfg.dueDayNextMonth) {
    dueDate = billMonthDay.add(1, 'month').date(cfg.dueDay);
  } else {
    dueDate = billMonthDay.date(cfg.dueDay);
  }
  return { billMonth, dueDate };
}

// ===== 套现/大额检测 =====
function checkCashAdvance(amount, note, payment) {
  const cashKeywords = ['取现', '套现', 'pos', 'POS', '预借现金', '现金垫付'];
  const isCashNote = cashKeywords.some(k => (note || '').toLowerCase().includes(k.toLowerCase()));
  const isLargeAmount = amount >= 5000 && amount % 100 === 0; // 大额整数
  return isCashNote || isLargeAmount;
}

// ===== 快速录入消费弹窗 =====
function openAddExpense() {
  const overlay = document.getElementById('addExpenseOverlay');
  if (!overlay) return;
  // 默认日期为今天
  const dateEl = document.getElementById('expDate');
  if (dateEl && !dateEl.value) dateEl.value = today.format('YYYY-MM-DD');
  overlay.classList.add('open');
}

function closeAddExpense() {
  const overlay = document.getElementById('addExpenseOverlay');
  if (overlay) overlay.classList.remove('open');
}

function addExpense() {
  const date = document.getElementById('expDate').value;
  const amount = parseFloat(document.getElementById('expAmount').value);
  const category = document.getElementById('expCategory').value;
  const payment = document.getElementById('expPayment').value;
  const note = document.getElementById('expNote').value;

  if (!date || !amount || amount <= 0) {
    alert('请填写日期和金额');
    return;
  }

  // 检测到主动还款：自动更新对应信用卡的 paidAmount
  if (isRepayment({ category, note })) {
    const repayCardId = PAYMENT_TO_CARD[payment];
    if (repayCardId && DATA) {
      let targetAcc = null;
      DATA.banks.forEach(b => b.accounts.forEach(a => { if (a.id === repayCardId) targetAcc = a; }));
      if (targetAcc) {
        if (confirm(`检测到还款 ¥${amount}，确认更新${targetAcc.name}的已还金额？`)) {
          targetAcc.paidAmount = (targetAcc.paidAmount || 0) + amount;
          saveData();
          refreshAfterExpenseChange();
          showToast(`✅ 已更新${targetAcc.name}已还金额 +${fmt(amount)}`);
          closeAddExpense();
        }
        return;
      }
    }
    alert('⚠️ 检测到还款记录但无法匹配信用卡，请手动更新已还金额。\n如果是商家退款，请将分类改为"退款"。');
    return;
  }

  // 重复检测（同日+同金额+同支付方式）
  const existing = getExpenses();
  const dup = existing.find(e => e.date === date && Math.abs(e.amount - amount) < 0.01 && e.payment === payment);
  if (dup) {
    if (!confirm(`⚠️ 疑似重复录入\n\n已存在：${date} ¥${amount} ${payment}\n\n确定继续录入？`)) return;
  }

  // 套现/大额提醒
  if (checkCashAdvance(amount, note, payment)) {
    const confirmed = confirm(
      `⚠️ 套现/大额消费提醒\n\n金额：¥${amount.toLocaleString()}\n支付：${payment}\n备注：${note || '无'}\n\n` +
      `检测到可能的套现或大额消费，信用卡套现违规且手续费高昂。\n确认继续录入？`
    );
    if (!confirmed) return;
  }

  // 计算账单周期
  const cardId = PAYMENT_TO_CARD[payment];
  const billing = cardId ? getBillingCycle(cardId, date) : null;

  const expense = {
    id: Date.now(), date, amount, category, payment, note,
    cardId: cardId || null,
    billMonth: billing?.billMonth || null,
    dueDate: billing?.dueDate?.format('YYYY-MM-DD') || null,
    isCashAdvance: checkCashAdvance(amount, note, payment)
  };

  const expenses = getExpenses();
  expenses.push(expense);
  expenses.sort((a, b) => b.date.localeCompare(a.date));
  saveExpenses(expenses);

  // 钱包支付自动扣减余额
  if (deductWalletBalance(payment, amount)) {
    saveData();
    renderWallets();
  }

  document.getElementById('expAmount').value = '';
  document.getElementById('expNote').value = '';

  // 关闭弹窗
  closeAddExpense();

  // 联动更新所有相关板块
  refreshAfterExpenseChange();

  // 成功提示
  const billTip = billing
    ? `📋 已计入 ${billing.billMonth} 账单，还款日 ${billing.dueDate.format('M月D日')}`
    : '';
  const walletTip = PAYMENT_TO_WALLET[payment] ? ` (已扣减${payment}余额)` : '';
  showToast(`✅ 已录入 ${payment} 消费 ¥${amount}${walletTip}${billTip ? '\n' + billTip : ''}`);
}

async function deleteExpense(id) {
  const all = getExpenses();
  const target = all.find(e => String(e.id) === String(id));
  if (!target) return;
  const label = `${target.date} ${target.category} ${fmt(target.amount)}`;
  if (!confirm(`确定删除这条记录？\n${label}`)) return;
  const expenses = all.filter(e => String(e.id) !== String(id));
  setSyncStatus('syncing');
  try {
    // 直接按 id 删除云端单条记录
    await sbFetch(EXPENSE_TABLE + '?id=eq.' + id, {
      method: 'DELETE',
      prefer: 'return=minimal'
    });
    localStorage.setItem('expenses', JSON.stringify(expenses));
    setSyncStatus('ok');
    showToast('已删除');
  } catch (e) {
    console.warn('云端删除失败，仅本地删除:', e.message);
    localStorage.setItem('expenses', JSON.stringify(expenses));
    setSyncStatus('error');
    showToast('本地已删除，云端同步失败');
  }
  refreshAfterExpenseChange();
}

// 退款：复制原记录，金额取负，备注加「[退款]」前缀
async function refundExpense(id) {
  const all = getExpenses();
  const target = all.find(e => String(e.id) === String(id));
  if (!target) return;
  const label = `${target.date} ${target.category} ${fmt(target.amount)}`;
  if (!confirm(`为这条记录录入退款？\n${label}\n\n将自动添加一条 -${fmt(target.amount)} 的退款记录。`)) return;
  const refund = {
    ...target,
    id: Date.now(),
    amount: -Math.abs(target.amount),
    note: `[退款] ${target.note || target.category}`,
    date: dayjs().format('YYYY-MM-DD'),  // 退款日期用今天
    isCashAdvance: false,
  };
  const expenses = [refund, ...all];
  expenses.sort((a, b) => b.date.localeCompare(a.date));
  setSyncStatus('syncing');
  await saveExpenses(expenses);
  setSyncStatus('ok');
  showToast(`已录入退款 ${fmt(Math.abs(refund.amount))}`);
  refreshAfterExpenseChange();
}

// ===== 编辑消费记录 =====
let editingExpenseId = null;

document.getElementById('editExpenseClose').addEventListener('click', () => {
  document.getElementById('editExpenseOverlay').style.display = 'none';
  editingExpenseId = null;
});
document.getElementById('editExpenseOverlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.style.display = 'none';
    editingExpenseId = null;
  }
});
document.getElementById('editExpSave').addEventListener('click', saveEditedExpense);

function openEditExpense(id) {
  const exp = getExpenses().find(e => String(e.id) === String(id));
  if (!exp) return;
  editingExpenseId = id;
  document.getElementById('editExpDate').value    = exp.date;
  document.getElementById('editExpAmount').value  = Math.abs(exp.amount);
  document.getElementById('editExpNote').value    = exp.note || '';
  document.getElementById('editExpCategory').value = exp.category;
  document.getElementById('editExpPayment').value  = exp.payment;
  document.getElementById('editExpenseOverlay').style.display = 'flex';
}

async function saveEditedExpense() {
  if (!editingExpenseId) return;
  const expenses = getExpenses();
  const idx = expenses.findIndex(e => String(e.id) === String(editingExpenseId));
  if (idx === -1) return;

  const orig = expenses[idx];
  const newAmount = parseFloat(document.getElementById('editExpAmount').value) || 0;
  // 保留退款的负号
  const amount = orig.amount < 0 ? -Math.abs(newAmount) : newAmount;

  expenses[idx] = {
    ...orig,
    date:     document.getElementById('editExpDate').value,
    amount,
    category: document.getElementById('editExpCategory').value,
    payment:  document.getElementById('editExpPayment').value,
    note:     document.getElementById('editExpNote').value.trim(),
  };
  expenses.sort((a, b) => b.date.localeCompare(a.date));

  setSyncStatus('syncing');
  await saveExpenses(expenses);
  setSyncStatus('ok');
  showToast('已保存修改');
  document.getElementById('editExpenseOverlay').style.display = 'none';
  editingExpenseId = null;
  refreshAfterExpenseChange();
}

function clearMonthExpenses() {
  const month = document.getElementById('expFilterMonth').value;
  if (!confirm(`确定清空 ${month} 的所有消费记录？`)) return;
  const expenses = getExpenses().filter(e => !e.date.startsWith(month));
  saveExpenses(expenses);
  renderExpenseTable();
  renderExpenseStats();
}

function renderExpenseTable() {
  const month = document.getElementById('expFilterMonth').value;
  const expenses = getExpenses().filter(e => e.date.startsWith(month));
  const tbody = document.getElementById('expenseTableBody');

  if (expenses.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px">暂无记录</td></tr>';
    return;
  }

  tbody.innerHTML = expenses.map(e => {
    const isCash = e.isCashAdvance;
    const isRefund = e.amount < 0;
    const billTip = e.billMonth ? `<span class="bill-tag">${e.billMonth}账单</span>` : '';
    const rowClass = isCash ? 'cash-advance-row' : isRefund ? 'refund-row' : '';
    return `
    <tr class="${rowClass}">
      <td>${e.date}</td>
      <td>${e.category}</td>
      <td style="color:${isCash ? 'var(--danger)' : isRefund ? 'var(--success)' : 'var(--warning)'};font-weight:600">
        ${fmt(e.amount)}${isCash ? ' ⚠️' : isRefund ? ' ↩' : ''}
      </td>
      <td>${e.payment}${billTip}</td>
      <td style="color:var(--text-muted)">${e.note || '-'}</td>
      <td class="action-btns">
        <button class="edit-btn" onclick="openEditExpense('${e.id}')" title="编辑">✏️</button>
        <button class="refund-btn" onclick="refundExpense('${e.id}')" title="退款">↩️</button>
        <button class="del-btn" onclick="deleteExpense('${e.id}')" title="删除">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

function renderExpenseStats() {
  const month = today.format('YYYY-MM');
  const expenses = getExpenses().filter(e => e.date.startsWith(month));
  const total = expenses.reduce((s, e) => s + e.amount, 0);

  // 分类汇总
  const byCategory = {};
  expenses.forEach(e => {
    byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
  });

  const statsEl = document.getElementById('expenseStats');
  if (!statsEl) return; // 旧版 DOM 元素已移除，安全退出
  statsEl.innerHTML = `
    <div class="expense-stat-row">
      <span>本月总消费</span>
      <span style="color:var(--warning);font-weight:700">${fmt(total)}</span>
    </div>
    <div class="expense-stat-row">
      <span>笔数</span>
      <span>${expenses.length} 笔</span>
    </div>
    <div class="expense-stat-row">
      <span>日均消费</span>
      <span>${fmt(total / today.date())}</span>
    </div>
    ${Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([cat, amt]) =>
      `<div class="expense-stat-row">
        <span>${cat}</span>
        <span>${fmt(amt)}</span>
      </div>`
    ).join('')}`;

  // 消费饼图
  if (typeof Chart === 'undefined') return;
  const ctx = document.getElementById('expensePieChart').getContext('2d');
  if (expensePieChart) expensePieChart.destroy();

  if (Object.keys(byCategory).length === 0) return;

  const catColors = {
    '餐饮堂食': '#ff6b6b', '外卖': '#f06595', '买菜生鲜': '#51cf66',
    '烟酒零食': '#ff922b', '交通出行': '#4dabf7', '购物数码': '#9775fa',
    '购物服装': '#cc5de8', '日用百货': '#ffa94d', '娱乐休闲': '#e64980',
    '订阅会员': '#845ef7', '医疗健康': '#20c997', '教育学习': '#74c0fc',
    '居家大件': '#a9e34b', '转账还款': '#adb5bd', '宠物': '#f783ac',
    '其他': '#868e96'
  };

  expensePieChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: Object.keys(byCategory),
      datasets: [{
        data: Object.values(byCategory),
        backgroundColor: Object.keys(byCategory).map(k => (catColors[k] || '#6c63ff') + 'bb'),
        borderColor: Object.keys(byCategory).map(k => catColors[k] || '#6c63ff'),
        borderWidth: 1
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#8892b0', font: { size: 11 }, padding: 8, usePointStyle: true }
        },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.label}: ${fmt(ctx.raw)}`
          }
        }
      }
    }
  });
}

// ===== 导航切换（顶部 + 底部统一处理）=====
function switchPage(pageId) {
  document.querySelectorAll('.nav-btn, .bottom-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll(`[data-page="${pageId}"]`).forEach(b => b.classList.add('active'));
  const pageEl = document.getElementById('page-' + pageId);
  if (pageEl) pageEl.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.querySelectorAll('.nav-btn, .bottom-nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchPage(btn.dataset.page));
});

// ===== 编辑数据弹窗 =====
document.getElementById('editDataBtn').addEventListener('click', () => {
  document.getElementById('dataEditor').value = JSON.stringify(DATA, null, 2);
  document.getElementById('modalOverlay').classList.add('open');
});

document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalCancel').addEventListener('click', closeModal);
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modalOverlay')) closeModal();
});

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
}

document.getElementById('modalSave').addEventListener('click', () => {
  try {
    const newData = JSON.parse(document.getElementById('dataEditor').value);
    DATA = newData;
    saveData();
    closeModal();
    // 重新渲染所有图表
    if (pieChart) pieChart.destroy();
    if (barChart) barChart.destroy();
    init();
    alert('✅ 数据已保存并刷新');
  } catch (e) {
    alert('❌ JSON 格式错误：' + e.message);
  }
});

// ===== 快速更新余额弹窗 =====
document.getElementById('quickUpdateBtn').addEventListener('click', openQuickUpdate);
document.getElementById('quickUpdateClose').addEventListener('click', closeQuickUpdate);
document.getElementById('quickUpdateCancel').addEventListener('click', closeQuickUpdate);
document.getElementById('quickUpdateOverlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('quickUpdateOverlay')) closeQuickUpdate();
});

function openQuickUpdate() {
  if (!DATA) return;
  const container = document.getElementById('quickUpdateFields');
  let html = '';

  DATA.banks.forEach((bank, bi) => {
    html += `<div class="qu-bank-group">
      <div class="qu-bank-title" style="color:${bank.color}">${bank.icon} ${bank.name}</div>`;
    bank.accounts.forEach((acc, ai) => {
      const isCredit = acc.type === 'credit';
      html += `
      <div class="qu-row">
        <label class="qu-label">${acc.name}<span class="qu-type">${isCredit ? '信用卡' : '贷款'}</span></label>
        <div class="qu-inputs">
          <div class="qu-field">
            <span class="qu-field-label">当前余额 (元)</span>
            <input type="number" class="qu-input" step="0.01" min="0"
              data-bank="${bi}" data-acc="${ai}" data-field="totalDebt"
              value="${acc.totalDebt}" />
          </div>
          ${isCredit ? `
          <div class="qu-field">
            <span class="qu-field-label">最低还款 (元)</span>
            <input type="number" class="qu-input" step="0.01" min="0"
              data-bank="${bi}" data-acc="${ai}" data-field="minPayment"
              value="${acc.minPayment || 0}" />
          </div>` : `
          <div class="qu-field">
            <span class="qu-field-label">月供 (元)</span>
            <input type="number" class="qu-input" step="0.01" min="0"
              data-bank="${bi}" data-acc="${ai}" data-field="monthlyPayment"
              value="${acc.monthlyPayment || 0}" />
          </div>
          <div class="qu-field">
            <span class="qu-field-label">剩余期数</span>
            <input type="number" class="qu-input" step="1" min="0"
              data-bank="${bi}" data-acc="${ai}" data-field="remainingMonths"
              value="${acc.remainingMonths || 0}" />
          </div>`}
        </div>
      </div>`;
    });
    html += `</div>`;
  });

  // 钱包余额编辑区
  if (DATA.meta && DATA.meta.wallets && DATA.meta.wallets.length > 0) {
    html += `<div class="qu-bank-group">
      <div class="qu-bank-title" style="color:#00d4aa">💰 钱包余额</div>`;
    DATA.meta.wallets.forEach((w, wi) => {
      html += `
      <div class="qu-row">
        <label class="qu-label">${w.icon || '💳'} ${w.name}</label>
        <div class="qu-inputs">
          <div class="qu-field">
            <span class="qu-field-label">余额 (元)</span>
            <input type="number" class="qu-input qu-wallet-input" step="0.01" min="0"
              data-wallet="${wi}" value="${w.balance || 0}" />
          </div>
        </div>
      </div>`;
    });
    html += `</div>`;
  }

  container.innerHTML = html;
  document.getElementById('quickUpdateOverlay').classList.add('open');
}

function closeQuickUpdate() {
  document.getElementById('quickUpdateOverlay').classList.remove('open');
}

document.getElementById('quickUpdateSave').addEventListener('click', async () => {
  // 读取所有输入值写回 DATA
  document.querySelectorAll('.qu-input:not(.qu-wallet-input)').forEach(input => {
    const bi = parseInt(input.dataset.bank);
    const ai = parseInt(input.dataset.acc);
    const field = input.dataset.field;
    const val = parseFloat(input.value) || 0;
    DATA.banks[bi].accounts[ai][field] = val;
  });

  // 读取钱包余额
  document.querySelectorAll('.qu-wallet-input').forEach(input => {
    const wi = parseInt(input.dataset.wallet);
    const val = parseFloat(input.value) || 0;
    if (DATA.meta.wallets[wi]) DATA.meta.wallets[wi].balance = val;
  });

  // 更新 lastUpdated
  DATA.meta.lastUpdated = dayjs().format('YYYY-MM-DD');
  document.getElementById('lastUpdated').textContent = '更新于 ' + DATA.meta.lastUpdated;

  // 关闭弹窗，立即刷新界面
  closeQuickUpdate();
  if (pieChart) pieChart.destroy();
  if (barChart) barChart.destroy();
  init();

  // 同步到云端
  await saveData();

  // 给用户反馈
  const statusEl = document.getElementById('syncStatus');
  if (statusEl && syncStatus === 'ok') {
    statusEl.textContent = '✅ 已更新并同步';
    setTimeout(() => setSyncStatus('ok'), 2000);
  }
});

// ===== Toast 提示 =====
function showToast(msg, duration = 3000) {
  let toast = document.getElementById('globalToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'globalToast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = 'toast toast-show';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.className = 'toast', duration);
}

// ===== 本月消费概览 =====
function renderExpenseOverview() {
  const container = document.getElementById('expenseOverviewPanel');
  if (!container || !DATA) return;

  const expenses = getExpenses();
  const now = today;

  // 方案B：按账单周期统计"当前未出账单"消费
  const cardStats = {};
  Object.entries(CARD_BILLING).forEach(([cardId, cfg]) => {
    const cycle = getBillingCycleDates(cardId);
    if (!cycle) return;
    cardStats[cardId] = { name: cfg.name, total: 0, count: 0, refund: 0, ...cycle };
  });

  // 与 renderBillingStatus 一致：cardId精确匹配 OR payment名称匹配（兜底手工录入）
  const BANK_SHORT_MAP_OV = { 'abc-credit-1': '农行' };
  expenses.forEach(e => {
    if (!e.date) return;
    if (isRepayment(e)) return; // 排除主动还款
    // 找到这条消费属于哪张卡
    let matchedCardId = null;
    for (const [cardId, stat] of Object.entries(cardStats)) {
      const cfg = CARD_BILLING[cardId];
      const cardName = cfg.name;
      const bankShort = BANK_SHORT_MAP_OV[cardId] || cardName.replace('信用卡','').replace('银行','');
      const cardMatch = e.cardId === cardId ||
        (e.payment && (e.payment === cardName || e.payment.includes(bankShort)));
      if (!cardMatch) continue;
      const { cycleStart, cycleEnd } = stat;
      if (!isDateInCycle(e.date, cycleStart, cycleEnd)) continue;
      matchedCardId = cardId;
      break;
    }
    if (!matchedCardId) return;
    if (e.amount < 0) {
      cardStats[matchedCardId].refund += Math.abs(e.amount);
    } else {
      cardStats[matchedCardId].total += e.amount;
      cardStats[matchedCardId].count++;
    }
  });

  // 总消费
  const grandTotal = Object.values(cardStats).reduce((s, c) => s + c.total, 0);
  const grandRefund = Object.values(cardStats).reduce((s, c) => s + c.refund, 0);
  const grandNet = grandTotal - grandRefund;

  // 未出账为负数时显示数据异常告警
  const negWarning = grandNet < 0
    ? `<div class="exp-ov-warning" style="color:var(--danger);font-size:12px;margin-top:4px">⚠️ 未出账净值为负，可能有还款记录被误录入消费列表，请检查</div>`
    : '';

  let html = `
    <div class="exp-overview-header">
      <div class="exp-overview-total">
        <span class="exp-ov-label">本期未出账消费</span>
        <span class="exp-ov-amount">${fmt(grandNet)}</span>
      </div>
      ${grandRefund > 0 ? `<div class="exp-ov-refund">退款 ${fmt(grandRefund)}</div>` : ''}
      ${negWarning}
    </div>
    <div class="exp-overview-cards">`;

  Object.entries(cardStats).forEach(([cardId, stat]) => {
    if (stat.total === 0 && stat.refund === 0) return;

    // 找信用卡账户数据（额度 + 计算真实已用）
    let accData = null;
    DATA.banks.forEach(b => b.accounts.forEach(a => {
      if (a.id === cardId) accData = a;
    }));
    const creditLimit = accData?.creditLimit || 0;

    const net = stat.total - stat.refund;
    // 额度进度条使用完整已用额度（账单剩余+分期本金+未出账），与总览页一致
    const usedCredit = accData ? calcUsedCredit(accData) : net;
    const usedPct = creditLimit > 0 ? Math.min(usedCredit / creditLimit, 1) : 0;
    const barColor = usedPct > 0.8 ? 'var(--danger)' : usedPct > 0.5 ? 'var(--warning)' : 'var(--accent)';

    html += `
      <div class="exp-ov-card">
        <div class="exp-ov-card-name">${stat.name}</div>
        <div class="exp-ov-card-amount">${fmt(net)}
          ${stat.refund > 0 ? `<span class="exp-ov-card-refund">退 ${fmt(stat.refund)}</span>` : ''}
        </div>
        <div class="exp-ov-card-meta">${stat.count} 笔消费${creditLimit > 0 ? ` · 额度 ${fmt(creditLimit)}` : ''}</div>
        ${creditLimit > 0 ? `
        <div class="exp-ov-bar-wrap">
          <div class="exp-ov-bar-fill" style="width:${usedPct * 100}%;background:${barColor}"></div>
        </div>
        <div class="exp-ov-bar-label">${fmtPct(usedPct)} 额度已用</div>` : ''}
      </div>`;
  });

  html += '</div>';
  container.innerHTML = html;
}

// ===== 账单状态面板 =====
function renderBillingStatus() {
  const container = document.getElementById('billingStatusPanel');
  if (!container || !DATA) return;

  const expenses = getExpenses();
  const now = today;

  // 对每张信用卡计算：未出账消费、已出账待还、下次还款日
  const cards = [];
  Object.entries(CARD_BILLING).forEach(([cardId, cfg]) => {
    // 找到对应账户
    let accData = null;
    DATA.banks.forEach(b => b.accounts.forEach(a => { if (a.id === cardId) accData = a; }));
    if (!accData) return;

    // 当前账单周期
    const cycle = getBillingCycleDates(cardId);
    if (!cycle) return;
    let { cycleStart, cycleEnd } = cycle;

    // 如果当期账单已出（currentBillAmount > 0 且 currentBillEnd <= 今天），
    // 未出账只算账单截止日之后的消费，避免重复计入。
    // 如果 currentBillEnd 在今天之后，说明当前期还没出账，保持原始 cycleStart。
    if (accData && accData.currentBillAmount > 0) {
      const billEndDate = accData.currentBillEnd ? dayjs(accData.currentBillEnd) : null;
      const billAlreadyIssued = billEndDate && !billEndDate.isAfter(today, 'day'); // <= today
      if (billAlreadyIssued) {
        cycleStart = billEndDate.startOf('day');
      } else if (!accData.currentBillEnd) {
        const billDay = cfg.billDay;
        if (now.date() >= billDay) {
          cycleStart = now.date(billDay).startOf('day');
        } else {
          cycleStart = cycleEnd.add(1, 'day');
        }
      }
      // else: currentBillEnd > today，当前期还没出账，保持原始 cycleStart
    }

    // 本周期内的消费（未出账），排除主动还款
    const cardName = cfg.name;
    const BANK_SHORT_MAP = { 'abc-credit-1': '农行' };
    const bankShort = BANK_SHORT_MAP[cardId] || cardName.replace('信用卡', '').replace('银行', '');
    const unpaidExpenseList = expenses.filter(e => {
      if (isRepayment(e)) return false;
      if (!isDateInCycle(e.date, cycleStart, cycleEnd)) return false;
      return e.cardId === cardId ||
             (e.payment && (e.payment === cardName || e.payment.includes(bankShort)));
    });
    const unpaidTotal = unpaidExpenseList.reduce((s, e) => s + e.amount, 0);

    // 账单日期范围（需先声明，billedExpenseList 依赖它）
    const billStart = accData.currentBillStart ? dayjs(accData.currentBillStart) : null;
    const billEnd   = accData.currentBillEnd   ? dayjs(accData.currentBillEnd)   : null;

    // 判断当期账单是否已出：billEnd <= 今天 且 有账单金额（或有分期需展示）
    const billAlreadyIssued = billEnd && !billEnd.isAfter(today, 'day');

    // 已出账单期间的消费明细
    // 注意：billEnd 通常为出账日（如6/3），但出账日当天的消费归入下一期
    // 因此已出账明细范围为 billStart ~ billEnd前一天（不含billEnd当天）
    // 只有账单已出时才展示已出账消费，否则所有消费都在"未出账"中
    let billedExpenseList = (billStart && billEnd && billAlreadyIssued) ? expenses.filter(e => {
      const d = dayjs(e.date);
      const dateOk = d.isAfter(billStart.subtract(1, 'day')) && d.isBefore(billEnd);
      if (!dateOk) return false;
      return e.cardId === cardId ||
             (e.payment && (e.payment === cardName || e.payment.includes(bankShort)));
    }).sort((a, b) => dayjs(b.date).diff(dayjs(a.date))) : [];

    // 将分期当期月供作为虚拟条目插入已出账明细（信用卡账单里包含分期月供）
    if (accData.installments && accData.installments.length > 0 && accData.currentBillAmount > 0) {
      const instEntries = accData.installments.filter(i => i.remainingMonths > 0 || i.paidPeriods > 0).map(i => {
        const period = (i.paidPeriods || 0) + 1;
        return {
          date: accData.currentDueDate || (billEnd ? billEnd.format('YYYY-MM-DD') : now.format('YYYY-MM-DD')),
          amount: i.monthlyPayment || 0,
          note: `${i.name} 第${period}期`,
          category: '分期还款',
          _isInstallment: true
        };
      });
      billedExpenseList = [...instEntries, ...billedExpenseList];
    }

    // 下次还款日：优先读 data.json 里的 currentDueDate（真实数据），避免推算错误
    let dueDate = null;
    if (accData.currentDueDate) {
      dueDate = dayjs(accData.currentDueDate);
    } else {
      const billing = getBillingCycle(cardId, now.format('YYYY-MM-DD'));
      dueDate = billing?.dueDate || null;
    }
    const daysUntilDue = dueDate ? dueDate.diff(now, 'day') : null;
    const isUrgent = daysUntilDue !== null && daysUntilDue <= 3;
    const isOverdue = daysUntilDue !== null && daysUntilDue < 0;

    cards.push({
      cardId, cfg, accData,
      unpaidTotal, unpaidExpenseList,
      billedExpenseList,
      dueDate, daysUntilDue, isUrgent, isOverdue,
      billAmount: (accData.currentBillAmount != null ? accData.currentBillAmount : accData.minPayment) || 0,
      billStart, billEnd,
    });
  });

  // 渲染明细行的辅助函数
  function renderExpenseRows(list) {
    if (!list || list.length === 0) return '<div style="padding:8px 12px;color:var(--text-muted);font-size:0.8rem">暂无消费记录</div>';
    return list.map(e => {
      const isInst = e._isInstallment;
      const noteColor = isInst ? 'var(--warning)' : 'var(--text)';
      const amountColor = e.amount < 0 ? 'var(--success)' : isInst ? 'var(--warning)' : 'var(--text)';
      const icon = isInst ? '📋 ' : '';
      return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 12px;border-top:1px solid var(--border);font-size:0.8rem${isInst ? ';background:var(--bg-alt,rgba(255,165,0,0.05))' : ''}">
        <div style="flex:1;min-width:0">
          <span style="color:var(--text-muted);margin-right:6px">${dayjs(e.date).format('M/D')}</span>
          <span style="color:${noteColor};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;display:inline-block;vertical-align:bottom">${icon}${e.note || e.category || '-'}</span>
        </div>
        <span style="color:${amountColor};font-weight:500;margin-left:8px;white-space:nowrap">${e.amount < 0 ? '-' : ''}${fmt(Math.abs(e.amount))}</span>
      </div>`;
    }).join('');
  }

  // 渲染
  let html = '';
  cards.forEach(c => {
    const dueTxt = c.dueDate
      ? (c.isOverdue
          ? `<span style="color:var(--danger)">⚠️ 已逾期${Math.abs(c.daysUntilDue)}天</span>`
          : c.isUrgent
            ? `<span style="color:var(--danger)">🔴 ${c.dueDate.format('M月D日')} 还款（${c.daysUntilDue}天后）</span>`
            : `<span style="color:var(--text-muted)">${c.dueDate.format('M月D日')} 还款（${c.daysUntilDue}天后）</span>`)
      : '-';

    const billedId = `billed-${c.cardId}`;
    const unpaidId = `unpaid-${c.cardId}`;
    const hasBilled = c.billedExpenseList.length > 0;
    const hasUnpaid = c.unpaidExpenseList.length > 0;

    // 已还款金额（data.json 里记录的本期已还）
    const paidAmount = c.accData.paidAmount || 0;
    const netOwed = Math.max(0, c.billAmount - paidAmount);
    const hasPaid = paidAmount > 0 && c.billAmount > 0;

    // 未来分期待还金额（不含当期，当期已在账单内）
    const futureInstallments = (c.accData.installments || []).reduce((s, i) => s + (i.remainingAmount || 0), 0);
    const hasFutureInst = futureInstallments > 0;
    const totalRemaining = netOwed + futureInstallments + (hasUnpaid ? c.unpaidTotal : 0);

    html += `
      <div class="billing-card">
        <div class="billing-card-name">${c.cfg.name}</div>
        <div class="billing-card-row${hasBilled ? ' billing-row-toggle' : ''}" data-toggle-id="${billedId}" style="cursor:${hasBilled ? 'pointer' : 'default'}">
          <span class="billing-label">${hasPaid ? '账单金额' : '已出账待还'}
            ${c.billStart && c.billEnd ? `<span style="font-size:0.7rem;color:var(--text-muted);margin-left:4px">(${c.billStart.format('M/D')}~${c.billEnd.format('M/D')})</span>` : ''}
            ${hasBilled ? `<span class="billing-toggle" id="arrow-${billedId}">▼</span>` : ''}
          </span>
          <span class="billing-value">${c.billAmount > 0 ? fmt(c.billAmount) : '暂无'}</span>
        </div>
        <div class="billing-detail" id="${billedId}">
          ${renderExpenseRows(c.billedExpenseList)}
        </div>
        ${hasPaid ? `
        <div class="billing-card-row">
          <span class="billing-label" style="color:var(--success)">已还金额</span>
          <span style="color:var(--success);font-weight:500">-${fmt(paidAmount)}</span>
        </div>
        <div class="billing-card-row">
          <span class="billing-label">账单剩余</span>
          <span style="color:var(--danger);font-weight:600">${fmt(netOwed)}</span>
        </div>
        ` : ''}
        ${hasFutureInst ? `
        <div class="billing-card-row">
          <span class="billing-label">分期待还（未来${(c.accData.installments || []).length}笔）</span>
          <span style="color:var(--warning)">${fmt(futureInstallments)}</span>
        </div>
        ` : ''}
        <div class="billing-card-row${hasUnpaid ? ' billing-row-toggle' : ''}" data-toggle-id="${unpaidId}" style="cursor:${hasUnpaid ? 'pointer' : 'default'}">
          <span class="billing-label">本期未出账
            ${hasUnpaid ? `<span class="billing-toggle" id="arrow-${unpaidId}">▼</span>` : ''}
          </span>
          <span class="billing-value" style="color:var(--info)">
            ${hasUnpaid ? fmt(c.unpaidTotal) + ` (${c.unpaidExpenseList.length}笔)` : '暂无'}
          </span>
        </div>
        <div class="billing-detail" id="${unpaidId}">
          ${renderExpenseRows(c.unpaidExpenseList)}
        </div>
        ${(hasFutureInst || hasUnpaid) ? `
        <div class="billing-card-row" style="border-top:2px solid var(--border);padding-top:6px">
          <span class="billing-label" style="font-weight:600">总剩余需还</span>
          <span style="color:var(--danger);font-weight:700;font-size:1.05rem">${fmt(totalRemaining)}</span>
        </div>
        ` : (hasPaid ? `
        <div class="billing-card-row" style="border-top:2px solid var(--border);padding-top:6px">
          <span class="billing-label" style="font-weight:600">剩余需还</span>
          <span style="color:var(--danger);font-weight:700;font-size:1.05rem">${fmt(netOwed)}</span>
        </div>
        ` : '')}
        <div class="billing-card-row">
          <span class="billing-label">下次还款日</span>
          <span>${dueTxt}</span>
        </div>
      </div>`;
  });

  container.innerHTML = html || '<div style="color:var(--text-muted);padding:16px">暂无信用卡数据</div>';

  // 事件委托：点击 billing-row-toggle 展开/收起明细（避免 onclick 属性单引号冲突）
  container.querySelectorAll('.billing-row-toggle').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.getAttribute('data-toggle-id');
      toggleBillingDetail(id);
    });
  });
}

// ===== 账单明细展开/收起 =====
function toggleBillingDetail(id) {
  const el = document.getElementById(id);
  const arrow = document.getElementById('arrow-' + id);
  if (!el) return;
  const isOpen = el.classList.toggle('open');
  // 用 inline style 强制覆盖，避免旧版 CSS display:none 优先级问题
  if (isOpen) {
    el.style.cssText = 'display:block;max-height:2400px;overflow-y:auto;background:var(--bg);border-radius:6px;margin:2px 0 6px;';
  } else {
    el.style.cssText = 'display:none;max-height:0;margin:0;';
  }
  if (arrow) arrow.style.transform = isOpen ? 'rotate(180deg)' : '';
}

// ===== 还款日提醒（浏览器通知）=====
function schedulePaymentReminders() {
  if (!('Notification' in window)) return;

  const now = today;
  const reminders = [];

  Object.entries(CARD_BILLING).forEach(([cardId, cfg]) => {
    const billing = getBillingCycle(cardId, now.format('YYYY-MM-DD'));
    if (!billing) return;
    const daysLeft = billing.dueDate.diff(now, 'day');
    if (daysLeft >= 0 && daysLeft <= 3) {
      // 找最低还款额
      let minPay = 0;
      DATA.banks.forEach(b => b.accounts.forEach(a => {
        if (a.id === cardId) minPay = a.minPayment || 0;
      }));
      reminders.push({ name: cfg.name, daysLeft, dueDate: billing.dueDate, minPay });
    }
  });

  if (reminders.length === 0) return;

  // 请求通知权限并发送
  Notification.requestPermission().then(perm => {
    if (perm !== 'granted') return;
    reminders.forEach(r => {
      const title = r.daysLeft === 0 ? `🔴 今天是${r.name}还款日！` : `⏰ ${r.name}还款提醒`;
      const body = `${r.dueDate.format('M月D日')}需还款 ${fmt(r.minPay)}，还剩 ${r.daysLeft} 天`;
      // 每天只提醒一次（用localStorage记录）
      const key = `reminded_${r.name}_${r.dueDate.format('YYYY-MM-DD')}`;
      if (!localStorage.getItem(key)) {
        new Notification(title, { body, icon: './icon-192.png' });
        localStorage.setItem(key, '1');
      }
    });
  });
}

// ===== 月度结算（自动推进分期 + 确认还款）=====
// 检测已过还款日但未结算的账户，提供一键结算
function checkAndAutoSettle() {
  if (!DATA) return;
  const now = today;
  const pendingSettlements = [];

  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      if (acc.type !== 'credit') return;
      if (!acc.currentDueDate) return;
      const dueDate = dayjs(acc.currentDueDate);
      // 还款日已过 且 paidAmount < currentBillAmount（未标记全额已还）
      const billAmount = acc.currentBillAmount || 0;
      const paidAmount = acc.paidAmount || 0;
      if (billAmount > 0 && now.isAfter(dueDate, 'day') && paidAmount < billAmount) {
        pendingSettlements.push({ bank, acc, dueDate, billAmount });
      }
    });
  });

  if (pendingSettlements.length === 0) return;

  // 弹出结算提醒
  showSettlementDialog(pendingSettlements);
}

function showSettlementDialog(items) {
  // 创建弹窗
  let overlay = document.getElementById('settlementOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'settlementOverlay';
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
  }

  let html = `
    <div class="modal-content" style="max-width:420px;max-height:80vh;overflow-y:auto">
      <div class="modal-header">
        <h3 style="margin:0;font-size:1.1rem">📋 月度结算提醒</h3>
        <button class="modal-close" id="settlementClose">✕</button>
      </div>
      <div style="padding:16px;font-size:0.85rem;color:var(--text-muted)">
        以下账户已过还款日，请确认是否已还款：
      </div>
      <div style="padding:0 16px 16px">`;

  items.forEach((item, idx) => {
    const instInfo = (item.acc.installments || []).map(i =>
      `${i.name.replace(/（.*）/, '')} 第${i.totalMonths - i.remainingMonths + 1}期`
    ).join('、');
    html += `
      <div class="settlement-item" style="background:var(--card-bg);border-radius:10px;padding:12px;margin-bottom:10px;border:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span style="font-weight:600;color:var(--text)">${item.bank.icon} ${item.acc.name}</span>
          <span style="color:var(--danger);font-size:0.8rem">还款日 ${item.dueDate.format('M/D')} 已过</span>
        </div>
        <div style="font-size:0.82rem;color:var(--text-muted);margin-bottom:8px">
          账单金额：${fmt(item.billAmount)}${instInfo ? ' | 含分期：' + instInfo : ''}
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn-settle" data-idx="${idx}" data-action="full" style="flex:1;padding:8px;border:none;border-radius:6px;background:var(--success);color:#fff;font-size:0.82rem;cursor:pointer">
            ✅ 已全额还款
          </button>
          <button class="btn-settle" data-idx="${idx}" data-action="min" style="flex:1;padding:8px;border:none;border-radius:6px;background:var(--warning);color:#fff;font-size:0.82rem;cursor:pointer">
            ⚠️ 已还最低
          </button>
          <button class="btn-settle" data-idx="${idx}" data-action="skip" style="padding:8px 12px;border:none;border-radius:6px;background:var(--border);color:var(--text-muted);font-size:0.82rem;cursor:pointer">
            跳过
          </button>
        </div>
      </div>`;
  });

  html += `
      </div>
      <div style="padding:0 16px 16px;text-align:center">
        <button id="settlementDone" style="width:100%;padding:12px;border:none;border-radius:8px;background:var(--primary);color:#fff;font-size:0.9rem;font-weight:600;cursor:pointer">
          完成结算
        </button>
      </div>
    </div>`;

  overlay.innerHTML = html;
  overlay.classList.add('open');

  // 记录每个item的操作结果
  const actions = items.map(() => null);

  // 绑定按钮事件
  overlay.querySelectorAll('.btn-settle').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      const action = btn.dataset.action;
      actions[idx] = action;
      // 高亮选中按钮
      const parent = btn.closest('.settlement-item');
      parent.querySelectorAll('.btn-settle').forEach(b => b.style.opacity = '0.4');
      btn.style.opacity = '1';
    });
  });

  // 关闭
  document.getElementById('settlementClose').addEventListener('click', () => {
    overlay.classList.remove('open');
  });

  // 完成结算
  document.getElementById('settlementDone').addEventListener('click', async () => {
    let changed = false;
    items.forEach((item, idx) => {
      const action = actions[idx];
      if (!action || action === 'skip') return;

      const acc = item.acc;
      if (action === 'full') {
        // 全额还款：标记已还，推进分期
        acc.paidAmount = item.billAmount;
        changed = true;
        // 推进分期到下一期
        advanceInstallments(acc);
      } else if (action === 'min') {
        // 最低还款：只标记已还最低
        acc.paidAmount = acc.minPayment || item.billAmount;
        changed = true;
        // 分期仍然推进（分期部分已还）
        advanceInstallments(acc);
      }
    });

    if (changed) {
      DATA.meta.lastUpdated = dayjs().format('YYYY-MM-DD');
      overlay.classList.remove('open');
      // 刷新界面
      if (pieChart) pieChart.destroy();
      if (barChart) barChart.destroy();
      init();
      // 保存到云端
      await saveData();
      showToast('✅ 结算完成，数据已同步');
    } else {
      overlay.classList.remove('open');
    }
  });
}

// 推进分期到下一期：remainingMonths-1, remainingAmount减一期月供
function advanceInstallments(acc) {
  if (!acc.installments || acc.installments.length === 0) return;
  acc.installments.forEach(inst => {
    if (inst.remainingMonths <= 0) return;
    inst.remainingMonths -= 1;
    // remainingAmount 减去一期（本金+利息，即月供）
    const monthlyTotal = inst.monthlyPayment || 0;
    inst.remainingAmount = Math.max(0, (inst.remainingAmount || 0) - monthlyTotal);
    // 更新剩余本金和利息
    if (inst.remainingPrincipal != null && inst.principalPerMonth) {
      inst.remainingPrincipal = Math.max(0, inst.remainingPrincipal - inst.principalPerMonth);
    }
    if (inst.remainingInterest != null && inst.interestPerMonth != null) {
      inst.remainingInterest = Math.max(0, inst.remainingInterest - inst.interestPerMonth);
    }
    // 如果有 paidPeriods 字段，也推进
    if (inst.paidPeriods != null) {
      inst.paidPeriods += 1;
    }
  });

  // 推进账单周期：当期变为下一期
  // currentBillAmount 清零（等下期出账后再更新），或者如果是纯分期卡可以预算下期
  const nextBillAmount = acc.installments.reduce((s, i) => {
    if (i.remainingMonths <= 0) return s;
    return s + (i.monthlyPayment || 0);
  }, 0);

  // 推进还款日到下个月
  if (acc.currentDueDate) {
    const nextDue = dayjs(acc.currentDueDate).add(1, 'month');
    acc.currentDueDate = nextDue.format('YYYY-MM-DD');
  }
  if (acc.currentBillStart) {
    acc.currentBillStart = dayjs(acc.currentBillStart).add(1, 'month').format('YYYY-MM-DD');
  }
  if (acc.currentBillEnd) {
    acc.currentBillEnd = dayjs(acc.currentBillEnd).add(1, 'month').format('YYYY-MM-DD');
  }

  // 如果是纯分期卡（没有日常消费），可以预设下期账单金额
  acc.currentBillAmount = nextBillAmount > 0 ? nextBillAmount : 0;
  acc.paidAmount = 0; // 重置已还金额
  acc.minPayment = nextBillAmount > 0 ? nextBillAmount : 0;
}

// ===== 出账日自动推进账单周期 =====
// 当今天已过出账日（billDay），且 currentBillEnd 还停留在上一期，自动推进到新一期
async function checkAndAdvanceBillCycle() {
  if (!DATA) return;
  const now = today;
  let changed = false;

  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      if (acc.type !== 'credit') return;
      if (!acc.currentBillEnd) return;

      const cfg = CARD_BILLING[acc.id];
      if (!cfg) return;
      const billDay = cfg.billDay;

      // 计算当前应该的出账日：如果今天 >= billDay，本月 billDay 就是最近的出账日
      // 如果今天 < billDay，上月 billDay 是最近的出账日
      let latestBillDate;
      if (now.date() >= billDay) {
        latestBillDate = now.date(billDay).startOf('day');
      } else {
        latestBillDate = now.subtract(1, 'month').date(billDay).startOf('day');
      }

      const currentBillEnd = dayjs(acc.currentBillEnd);

      // 如果 currentBillEnd 早于最近的出账日，说明需要推进
      // 可能需要推进多期（比如很久没打开页面）
      let advanceCount = 0;
      let tempBillEnd = currentBillEnd;
      while (tempBillEnd.isBefore(latestBillDate, 'day')) {
        tempBillEnd = tempBillEnd.add(1, 'month');
        advanceCount++;
        if (advanceCount > 12) break; // 安全限制
      }

      if (advanceCount === 0) return;

      // 推进账单周期
      const newBillStart = dayjs(acc.currentBillStart).add(advanceCount, 'month').format('YYYY-MM-DD');
      const newBillEnd = currentBillEnd.add(advanceCount, 'month').format('YYYY-MM-DD');
      const newDueDate = acc.currentDueDate
        ? dayjs(acc.currentDueDate).add(advanceCount, 'month').format('YYYY-MM-DD')
        : null;

      // 计算新一期账单金额（分期月供总额 + 未出账消费不计入，因为还没出账）
      const instTotal = (acc.installments || []).reduce((s, i) => {
        if (i.remainingMonths <= 0) return s;
        return s + (i.monthlyPayment || 0);
      }, 0);

      console.log(`[AutoBill] ${acc.name}: 推进${advanceCount}期, ${acc.currentBillStart}~${acc.currentBillEnd} → ${newBillStart}~${newBillEnd}, 账单=${instTotal}`);

      acc.currentBillStart = newBillStart;
      acc.currentBillEnd = newBillEnd;
      if (newDueDate) acc.currentDueDate = newDueDate;
      acc.currentBillAmount = instTotal > 0 ? instTotal : 0;
      acc.minPayment = instTotal > 0 ? instTotal : 0;
      acc.paidAmount = 0; // 新一期未还款
      changed = true;
    });
  });

  if (changed) {
    DATA.meta.lastUpdated = dayjs().format('YYYY-MM-DD');
    await saveData();
    console.log('[AutoBill] 账单周期已自动推进并保存');
    // 刷新界面
    if (pieChart) pieChart.destroy();
    if (barChart) barChart.destroy();
    init();
    showToast('📋 账单周期已自动更新', 3000);
  }
}

// 页面加载后延迟检查结算（等数据加载完）
function initAutoSettle() {
  // 延迟3秒检查，确保数据已加载
  setTimeout(async () => {
    if (!DATA) return;
    // 先检查出账日推进
    await checkAndAdvanceBillCycle();
    // 再检查还款日结算
    checkAndAutoSettle();
  }, 3000);
}

// ===== AI 消费识别（多轮对话版）=====
const FRIDAY_API    = 'https://aigc.sankuai.com/v1/openai/native/chat/completions'; // 统一用 native 接口
const FRIDAY_VL_API = 'https://aigc.sankuai.com/v1/openai/native/chat/completions'; // VL 多模态接口（同上）
const FRIDAY_TOKEN = '22041715054660149263';
const MODEL_TEXT   = 'deepseek-v3-friday'; // 主线对话（纯文字，保持上下文）
const MODEL_VL     = 'LongCat-VL-Medium';  // 图片识别（单次调用，结果合并回主线）

// ===== 构建负债数据上下文（注入给 AI）=====
function buildDebtContext() {
  if (!DATA) return '';
  const lines = [];
  lines.push(`【我的负债数据快照 · ${DATA.meta.lastUpdated}】`);

  // 汇总
  const { totalDebt, monthlyDue } = calcSummary();
  lines.push(`总负债：¥${totalDebt.toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`);
  lines.push(`本月应还：¥${monthlyDue.toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`);

  // 钱包
  const wallets = DATA.meta.wallets || [];
  const walletTotal = wallets.reduce((s, w) => s + (w.balance || 0), 0);
  lines.push(`可用余额：¥${walletTotal.toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}（${wallets.map(w => `${w.name}¥${w.balance}`).join('、')}）`);
  lines.push('');

  // 各账户明细
  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      if (acc.type === 'savings') return;
      lines.push(`▌ ${bank.name} · ${acc.name}`);
      if (acc.type === 'loan') {
        lines.push(`  类型：贷款 | 剩余本金：¥${acc.totalDebt} | 月供：¥${acc.monthlyPayment} | 年利率：${(acc.interestRate * 100).toFixed(2)}% | 剩余${acc.remainingMonths}期 | 还款日：每月${acc.dueDay}日 | 到期：${acc.endDate}`);
        if (acc.note) lines.push(`  备注：${acc.note}`);
      } else if (acc.type === 'credit') {
        lines.push(`  类型：信用卡 | 当期账单：¥${acc.minPayment} | 还款日：每月${acc.dueDay}日 | 月利率：${(acc.interestRate * 100).toFixed(4)}%`);
        if (acc.note) lines.push(`  备注：${acc.note}`);
        if (acc.installments && acc.installments.length > 0) {
          lines.push(`  分期明细：`);
          acc.installments.forEach(inst => {
            lines.push(`    - ${inst.name}：剩余¥${inst.remainingAmount}（共${inst.remainingMonths}期，月供¥${inst.monthlyPayment}，到期${inst.endDate}）${inst.note ? ' | ' + inst.note : ''}`);
          });
        }
      }
      lines.push('');
    });
  });

  // 近期消费（最近10条）
  const expenses = (DATA.expenses || []).slice(-10).reverse();
  if (expenses.length > 0) {
    lines.push(`▌ 最近消费记录（最新${expenses.length}条）`);
    expenses.forEach(e => {
      lines.push(`  ${e.date} ¥${e.amount} ${e.category} [${e.payment}]${e.note ? ' ' + e.note : ''}`);
    });
  }

  return lines.join('\n');
}

// ===== AI 系统提示词（静态部分）=====
const AI_SYSTEM_PROMPT_STATIC = `你是一个个人负债与消费管理助手，能识别用户意图并返回结构化 JSON。

今天日期：${dayjs().format('YYYY-MM-DD')}

支持的意图（intent）：
1. add_expense    - 录入消费记录（用户描述消费、上传账单截图）
2. add_loan       - 新建贷款账户（用户说"新增贷款""借了XX钱"）
3. add_installment - 新建分期（用户说"分期""办了XX期"）
4. update_wallet  - 更新钱包余额（用户说"微信还有XX""支付宝余额XX"）
5. update_installment - 更新已有分期（用户说"还了一期""分期剩X期了""更新分期"）
6. update_bill    - 更新信用卡账单（用户说"本期账单XX""还了XX""最低还款XX"）
7. delete_installment - 结清/删除分期（用户说"分期还清了""删掉这个分期"）
8. query          - 查询/分析（用户问"我还有多少债""下次还款是哪天"等）
9. chat           - 闲聊/无法识别（友好回复，reply 字段填回复内容）

根据用户输入判断 intent，返回对应 JSON 格式：

intent=add_expense:
{"intent":"add_expense","date":"YYYY-MM-DD","amount":数字,"category":"分类","payment":"支付方式","note":"备注"}
category 只能是：餐饮堂食、外卖、买菜生鲜、烟酒零食、交通出行、购物数码、购物服装、日用百货、娱乐休闲、订阅会员、医疗健康、教育学习、居家大件、转账还款、宠物、其他
payment 只能是：招商信用卡、广州银行信用卡、浦发信用卡、农行信用卡、民生信用卡、花呗、美团月付、微信零钱、支付宝余额、储蓄卡、现金
用户说“微信”“微信支付”“微信零钱”均填“微信零钱”，说“支付宝”均填“支付宝余额”

intent=add_loan:
{"intent":"add_loan","bankName":"银行名","accountName":"账户名","totalDebt":数字,"monthlyPayment":数字,"interestRate":年利率小数,"remainingMonths":数字,"endDate":"YYYY-MM-DD","note":"备注"}

intent=add_installment:
{"intent":"add_installment","cardName":"信用卡名","instName":"分期名称","originalAmount":数字,"remainingAmount":数字,"monthlyPayment":数字,"remainingMonths":数字,"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","note":"备注"}

intent=update_wallet:
{"intent":"update_wallet","wallets":[{"name":"储蓄卡|微信钱包|支付宝余额","balance":数字}]}

intent=update_installment:
{"intent":"update_installment","cardName":"信用卡名(模糊匹配)","instName":"分期名称(模糊匹配)","action":"repay|set","periods":还了几期(action=repay时),"remainingMonths":直接设为几期(action=set时),"remainingAmount":剩余金额(可选),"note":"备注(可选)"}
说明：action=repay表示"还了N期"，自动递减；action=set表示直接设置剩余期数。cardName和instName支持模糊匹配（如"浦发""商户分期"）。

intent=update_bill:
{"intent":"update_bill","cardName":"信用卡名(模糊匹配)","currentBillAmount":本期账单金额(可选),"paidAmount":已还金额(可选),"minPayment":最低还款额(可选),"note":"备注(可选)"}
说明：只需传要更新的字段，未传的保持不变。

intent=delete_installment:
{"intent":"delete_installment","cardName":"信用卡名(模糊匹配)","instName":"分期名称(模糊匹配)"}

intent=query:
{"intent":"query","reply":"用中文回答用户的问题，可引用数据"}

intent=chat:
{"intent":"chat","reply":"友好的中文回复"}

规则：
- 用户修正上一次结果时（说"不对""改成XX"），基于上次 JSON 修改后重新返回完整 JSON
- 只返回 JSON，不要 markdown 代码块，不要任何解释文字
- 无法确定的字段用合理默认值，不要留 null
- 当用户问"我的负债""应该先还哪个""下个月还多少"等分析类问题时，直接基于下方【我的负债数据快照】中的真实数据回答，不要说"我没有你的数据"`;

// 动态生成完整系统提示词（每次对话时调用，确保数据最新）
function buildSystemPrompt() {
  return AI_SYSTEM_PROMPT_STATIC + '\n\n' + buildDebtContext();
}

// 主线对话历史（deepseek 保持上下文）
let aiConversation = [];  // [{role, content}]
// 界面气泡历史（用于渲染）
let aiChatBubbles  = [];  // [{role:'user'|'ai', text, imgSrc?, parsed?}]

let aiImageList = []; // [{base64, mime, dataUrl}]

// ---- 图片选择（支持多图）----
document.getElementById('aiImageInput').addEventListener('change', function () {
  const files = Array.from(this.files);
  if (files.length === 0) return;
  let loaded = 0;
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      const match = dataUrl.match(/^data:(.+);base64,(.+)$/);
      if (!match) return;
      aiImageList.push({ base64: match[2], mime: match[1], dataUrl });
      loaded++;
      if (loaded === files.length) renderAIImagePreview();
    };
    reader.readAsDataURL(file);
  });
  this.value = '';
});

function renderAIImagePreview() {
  const row = document.getElementById('aiImagePreviewRow');
  if (aiImageList.length === 0) { row.style.display = 'none'; return; }
  row.style.display = 'flex';
  row.innerHTML = aiImageList.map((img, i) =>
    `<div class="ai-img-thumb-wrap"><img src="${img.dataUrl}" class="ai-img-thumb" alt="预览${i+1}" /><button class="ai-remove-img" onclick="removeAIImage(${i})">✕</button></div>`
  ).join('') + `<button class="ai-clear-all-img" onclick="clearAIImage()">全部清除</button>`;
}

function removeAIImage(idx) {
  aiImageList.splice(idx, 1);
  renderAIImagePreview();
}

function clearAIImage() {
  aiImageList = [];
  renderAIImagePreview();
}

// ---- 清空对话 ----
document.getElementById('aiClearBtn').addEventListener('click', () => {
  aiConversation = [];
  aiChatBubbles  = [];
  localStorage.removeItem('aiChatBubbles');
  localStorage.removeItem('aiConversation');
  renderAIChat();
  setAIStatus('');
  clearAIImage();
  document.getElementById('aiTextInput').value = '';
});

// ---- 发送 ----
// 手机端：touchend 优先触发（比 click 早 300ms），preventDefault 阻止后续 click 重复触发
// 桌面端：touchend 不触发，走 click
const _sendBtn = document.getElementById('aiSendBtn');
let _sendTouched = false;
_sendBtn.addEventListener('touchend', (e) => {
  e.preventDefault(); // 阻止 blur + 阻止后续 click
  _sendTouched = true;
  handleAISend();
  setTimeout(() => { _sendTouched = false; }, 500);
});
_sendBtn.addEventListener('click', (e) => {
  if (_sendTouched) return; // 已由 touchend 处理，跳过
  handleAISend();
});
document.getElementById('aiTextInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAISend(); }
});

// ---- 语音输入 ----
(function initVoiceInput() {
  const btn = document.getElementById('aiVoiceBtn');
  if (!btn) return;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { btn.style.display = 'none'; return; }

  const rec = new SpeechRecognition();
  rec.lang = 'zh-CN';
  rec.continuous = false;
  rec.interimResults = true;

  let listening = false;
  btn.addEventListener('click', () => {
    if (listening) { rec.stop(); return; }
    rec.start();
  });

  rec.onstart = () => {
    listening = true;
    btn.classList.add('listening');
    btn.title = '录音中，点击停止';
  };
  rec.onend = () => {
    listening = false;
    btn.classList.remove('listening');
    btn.title = '语音输入';
  };
  rec.onresult = (e) => {
    const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
    document.getElementById('aiTextInput').value = transcript;
    if (e.results[e.results.length - 1].isFinal) {
      setTimeout(handleAISend, 300); // 最终结果自动发送
    }
  };
  rec.onerror = (e) => {
    console.warn('语音识别错误:', e.error);
    btn.classList.remove('listening');
    listening = false;
    if (e.error !== 'aborted') showToast('❌ 语音识别失败：' + e.error);
  };
})();

// ---- 加载历史对话 ----
loadAIChatHistory();
if (aiChatBubbles.length > 0) renderAIChat();

let _aiSending = false; // 防重复发送锁
async function handleAISend() {
  if (_aiSending) return; // 正在发送中，忽略重复调用
  const text   = document.getElementById('aiTextInput').value.trim();
  const hasImg = aiImageList.length > 0;
  if (!text && !hasImg) { setAIStatus('请输入消费描述或上传图片', 'error'); return; }

  _aiSending = true;
  const btn = document.getElementById('aiSendBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  document.getElementById('aiSendIcon').textContent = '⏳';
  setAIStatus('AI 识别中...', 'loading');

  // 记录用户气泡
  const imgSrc = hasImg ? aiImageList.map(i => i.dataUrl) : null;
  // 提前保存图片数据，clearAIImage 会清空全局变量
  const savedImages = aiImageList.map(i => ({ base64: i.base64, mime: i.mime }));
  aiChatBubbles.push({ role: 'user', text: text || '（图片）', imgSrc });
  renderAIChat();

  // 清空输入框（图片在 VL 调用后再清）
  document.getElementById('aiTextInput').value = '';

  try {
    // ===== 图片路径：逐张调用 VL 识别，合并结果 =====
    if (hasImg) {
      const imgCount = savedImages.length;
      setAIStatus(`图片识别中（1/${imgCount}）...`, 'loading');
      aiChatBubbles.push({ role: 'ai', text: `⏳ 图片识别中（1/${imgCount}）...`, parsed: null, streaming: true });
      renderAIChat();

      let allItems = [];
      for (let i = 0; i < savedImages.length; i++) {
        setAIStatus(`图片识别中（${i + 1}/${imgCount}）...`, 'loading');
        // 更新占位气泡文本
        aiChatBubbles[aiChatBubbles.length - 1].text = `⏳ 图片识别中（${i + 1}/${imgCount}）...`;
        renderAIChat();

        const vlRaw = await callVLModel(text, savedImages[i]);

        // 解析 VL 返回的 JSON 数组
        let items = [];
        try {
          const cleaned = vlRaw.trim()
            .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
          const parsed = JSON.parse(cleaned);
          items = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          const m = vlRaw.match(/\[[\s\S]*\]/);
          if (m) { try { items = JSON.parse(m[0]); } catch {} }
        }
        allItems = allItems.concat(items);
      }

      clearAIImage();
      aiChatBubbles.pop(); // 移除占位气泡

      if (allItems.length === 0) {
        aiChatBubbles.push({ role: 'ai', text: '❌ 未能识别到消费记录，请重试或手动描述', parsed: null });
        renderAIChat();
        setAIStatus('识别失败', 'error');
      } else {
        // 补全默认值
        const todayStr = dayjs().format('YYYY-MM-DD');
        allItems = allItems.map(it => ({
          intent: 'add_expense',
          date:     it.date     || todayStr,
          amount:   parseFloat(it.amount) || 0,
          category: it.category || '其他',
          payment:  it.payment  || '微信零钱',
          note:     it.note     || '',
        }));
        // 批量气泡：一个汇总气泡 + 每条独立卡片
        aiChatBubbles.push({
          role: 'ai', text: '', parsed: null,
          batchSummary: `📋 共识别到 ${allItems.length} 笔消费，请逐条确认或跳过：`
        });
        allItems.forEach(item => {
          aiChatBubbles.push({ role: 'ai', text: '', parsed: item, batchItem: true });
        });
        renderAIChat();
        setAIStatus(`✅ 识别到 ${allItems.length} 笔，请逐条确认`, 'success');
        saveAIChatHistory();
      }

    } else {
      // ===== 纯文字路径：走主线流式模型 =====
      aiConversation.push({ role: 'user', content: text });

      setAIStatus('AI 思考中...', 'loading');
      const streamBubble = { role: 'ai', text: '', parsed: null, streaming: true };
      aiChatBubbles.push(streamBubble);
      renderAIChat();

      const raw = await callMainModel(aiConversation, (partialText) => {
        streamBubble.text = partialText;
        const el = document.getElementById('aiChatHistory');
        const bubbles = el.querySelectorAll('.ai-bubble-ai');
        const last = bubbles[bubbles.length - 1];
        if (last) {
          const span = last.querySelector('span');
          if (span) span.textContent = partialText;
        }
        el.scrollTop = el.scrollHeight;
      });

      streamBubble.streaming = false;
      streamBubble.text = raw;
      aiConversation.push({ role: 'assistant', content: raw });

      const parsed = parseAIResult(raw);
      streamBubble.parsed = parsed;
      renderAIChat();
      await handleAIIntent(parsed, streamBubble);
      saveAIChatHistory();
    }

  } catch (err) {
    console.error('[AI]', err);
    clearAIImage(); // 出错时也清掉图片预览
    aiChatBubbles.push({ role: 'ai', text: `❌ ${err.message}`, parsed: null });
    renderAIChat();
    setAIStatus(`❌ 识别失败：${err.message}`, 'error');
  } finally {
    _aiSending = false; // 释放发送锁
    btn.disabled = false;
    btn.classList.remove('loading');
    document.getElementById('aiSendIcon').textContent = '➤';
  }
}

// 调用 LongCat-VL 识别单张图片，直接返回 JSON 数组（所有消费条目）
async function callVLModel(text, image) {
const today = dayjs().format('YYYY-MM-DD');
const prompt = `请识别图中所有消费记录，${text ? '结合用户说明："' + text + '"，' : ''}直接返回 JSON 数组，不要任何解释文字。
格式：[{"date":"YYYY-MM-DD","amount":数字,"category":"分类","payment":"支付方式","note":"备注"}, ...]
category 只能是：餐饮堂食、外卖、买菜生鲜、烟酒零食、交通出行、购物数码、购物服装、日用百货、娱乐休闲、订阅会员、医疗健康、教育学习、居家大件、转账还款、宠物、其他
payment 只能是以下之一：招商信用卡、广州银行信用卡、浦发信用卡、农行信用卡、民生信用卡、花呗、美团月付、微信零钱、支付宝余额、储蓄卡、现金
重要：如果图片来自某信用卡的账单/未出账单截图，则所有交易的 payment 都应填该信用卡名称（如招商银行未出账单截图中的交易，payment 统一填"招商信用卡"）。图中的"微信支付""云闪付扫码""美团支付"等只是交易渠道，不是 payment 字段的值。
note 填商户名称或消费描述，不要填卡尾号。
日期如图中只有月日没有年份，则默认为当前年 ${today.slice(0, 4)} 年。如图中完全没有日期则用今天 ${today}。金额为正数（收入/退款用负数）。只返回 JSON 数组，不要 markdown 代码块。`;
const userContent = [
{ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } },
{ type: 'text', text: prompt },
];
  // VL 模型使用专用接口和 max_new_tokens 参数
  const resp = await fetch(FRIDAY_VL_API, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${FRIDAY_TOKEN}`,
    },
    body: JSON.stringify({
      model: MODEL_VL,
      messages: [{ role: 'user', content: userContent }],
      max_new_tokens: 1200,
      temperature: 0.95,
      repetition_penalty: 1.1,
      top_p: 0.7,
      top_k: 4,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${t}`);
  }
  const data = await resp.json();
  if (data.status && data.status !== 200) throw new Error(data.message || `VL API 错误 ${data.status}`);
  return data.choices?.[0]?.message?.content || '';
}

// 调用主线模型（流式），onChunk(text) 每收到一段就回调
async function callMainModel(conversation, onChunk) {
const messages = [
{ role: 'system', content: buildSystemPrompt() },  // 动态注入最新负债数据
...conversation,
];
  const resp = await fetch(FRIDAY_API, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${FRIDAY_TOKEN}`,
    },
    body: JSON.stringify({
      model: MODEL_TEXT,
      messages,
      max_new_tokens: 400,
      temperature: 0.1,
      stream: true,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${t}`);
  }
  // 读取 SSE 流
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop(); // 最后一行可能不完整，留到下次
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data:')) continue;
      try {
        const json = JSON.parse(trimmed.slice(5).trim());
        // 兼容两种格式：delta.content 或 choices[0].message.content
        const chunk = json.choices?.[0]?.delta?.content
          || json.choices?.[0]?.message?.content
          || '';
        if (chunk) {
          full += chunk;
          onChunk && onChunk(full);
        }
      } catch { /* 忽略解析失败的行 */ }
    }
  }
  if (!full) throw new Error('AI 返回内容为空');
  return full;
}

// 底层 fetch 封装（非流式，用于 VL 识别、消费分析等）
async function fridayRequest(model, messages, maxTokens = 300) {
  const resp = await fetch(FRIDAY_API, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${FRIDAY_TOKEN}`,
    },
    body: JSON.stringify({ model, messages, max_new_tokens: maxTokens, temperature: 0.1 }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${t}`);
  }
  const data = await resp.json();
  if (data.status && data.status !== 200) throw new Error(data.message || `API 错误 ${data.status}`);
  return data;
}

function parseAIResult(raw) {
  let cleaned = raw.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  let obj;
  try { obj = JSON.parse(cleaned); }
  catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('无法解析 AI 返回的 JSON');
    obj = JSON.parse(m[0]);
  }
  const todayStr = dayjs().format('YYYY-MM-DD');
  // 兼容旧格式（无 intent 字段时默认为 add_expense）
  if (!obj.intent) {
    return {
      intent: 'add_expense',
      date:     obj.date     || todayStr,
      amount:   parseFloat(obj.amount) || 0,
      category: obj.category || '其他',
      payment:  obj.payment  || '微信零钱',
      note:     obj.note     || '',
    };
  }
  // 补全 add_expense 的默认值
  if (obj.intent === 'add_expense') {
    obj.date     = obj.date     || todayStr;
    obj.amount   = parseFloat(obj.amount) || 0;
    obj.category = obj.category || '其他';
    obj.payment  = obj.payment  || '微信零钱';
    obj.note     = obj.note     || '';
  }
  return obj;
}

// 根据 AI 识别的意图执行对应操作
async function handleAIIntent(parsed, bubble) {
  if (!parsed) return;
  const intent = parsed.intent || 'add_expense';

  if (intent === 'add_expense') {
    setAIStatus('✅ 已识别消费信息，点击"确认录入消费"按钮保存；如有误请继续说明', 'success');

  } else if (intent === 'add_loan') {
    setAIStatus('✅ 已识别贷款信息，点击下方"确认录入"按钮添加', 'success');
    // 气泡里有确认按钮，点击后执行录入（见 renderAIChat）

  } else if (intent === 'add_installment') {
    setAIStatus('✅ 已识别分期信息，点击下方"确认录入"按钮添加', 'success');

  } else if (intent === 'update_wallet') {
    // 直接更新钱包余额
    if (parsed.wallets && DATA?.meta?.wallets) {
      parsed.wallets.forEach(w => {
        const target = DATA.meta.wallets.find(dw =>
          dw.name === w.name || dw.name.includes(w.name) || w.name.includes(dw.name)
        );
        if (target) target.balance = w.balance;
      });
      DATA.meta.lastUpdated = today.format('YYYY-MM-DD');
      await saveData();
      renderWallets();
      renderSummaryBanner();
      setAIStatus('✅ 钱包余额已更新', 'success');
    }

  } else if (intent === 'update_installment') {
    await aiUpdateInstallment(parsed);

  } else if (intent === 'update_bill') {
    const billOk = await aiUpdateBill(parsed);
    if (!billOk && bubble) { bubble.actionFailed = true; renderAIChat(); }

  } else if (intent === 'delete_installment') {
    await aiDeleteInstallment(parsed);

  } else if (intent === 'query' || intent === 'chat') {
    setAIStatus('', '');
    // 回复内容已在气泡里渲染

  } else {
    setAIStatus('', '');
  }
}

// 从 AI 识别结果录入贷款
async function aiConfirmLoan(parsed) {
  if (!DATA || !parsed) return;
  // 找或创建对应 bank
  let bank = DATA.banks.find(b => b.name.includes(parsed.bankName) || parsed.bankName.includes(b.name));
  if (!bank) {
    bank = {
      id: 'bank-' + Date.now(),
      name: parsed.bankName, shortName: parsed.bankName.slice(0, 2),
      color: '#8892b0', icon: '🏦', accounts: []
    };
    DATA.banks.push(bank);
  }
  const newAcc = {
    id: 'loan-' + Date.now(),
    type: 'loan',
    name: parsed.accountName || '新贷款',
    totalDebt: parsed.totalDebt || 0,
    monthlyPayment: parsed.monthlyPayment || 0,
    interestRate: parsed.interestRate || 0,
    remainingMonths: parsed.remainingMonths || 0,
    dueDay: 1,
    startDate: today.format('YYYY-MM-DD'),
    endDate: parsed.endDate || today.add(parsed.remainingMonths || 12, 'month').format('YYYY-MM-DD'),
    note: parsed.note || ''
  };
  bank.accounts.push(newAcc);
  DATA.meta.lastUpdated = today.format('YYYY-MM-DD');
  await saveData();
  renderSummaryBanner();
  renderBankCards();
  showToast(`✅ 贷款"${newAcc.name}"已录入`);
}

// 从 AI 识别结果录入分期
async function aiConfirmInstallment(parsed) {
  if (!DATA || !parsed) return;
  // 找对应信用卡账户
  const targetAcc = findCreditAccount(parsed.cardName || '');
  if (!targetAcc) { showToast('❌ 未找到对应信用卡，请检查卡名'); return; }
  if (!targetAcc.installments) targetAcc.installments = [];
  targetAcc.installments.push({
    id: 'inst-' + Date.now(),
    name: parsed.instName || '新分期',
    originalAmount: parsed.originalAmount || 0,
    remainingAmount: parsed.remainingAmount || parsed.originalAmount || 0,
    monthlyPayment: parsed.monthlyPayment || 0,
    remainingMonths: parsed.remainingMonths || 0,
    startDate: parsed.startDate || today.format('YYYY-MM-DD'),
    endDate: parsed.endDate || today.add(parsed.remainingMonths || 12, 'month').format('YYYY-MM-DD'),
    note: parsed.note || ''
  });
  DATA.meta.lastUpdated = today.format('YYYY-MM-DD');
  await saveData();
  renderInstallments();
  renderTimeline();
  renderSummaryBanner();
  renderBankCards();
  showToast(`✅ 分期"${parsed.instName}"已录入到${targetAcc.name}`);
}

// AI修改分期
async function aiUpdateInstallment(parsed) {
  if (!DATA || !parsed) return;
  const cardName = parsed.cardName || '';
  const instName = parsed.instName || '';
  const targetAcc = findCreditAccount(cardName);
  let targetInst = null;
  if (targetAcc && targetAcc.installments) {
    targetInst = targetAcc.installments.find(i => i.name.includes(instName) || instName.includes(i.name));
  }
  if (!targetInst) { showToast('❌ 未找到对应分期，请检查卡名和分期名'); setAIStatus('', ''); return; }

  const action = parsed.action || 'set';
  if (action === 'repay' && parsed.periods) {
    // 还了N期
    const repaid = parseInt(parsed.periods) || 0;
    targetInst.remainingMonths = Math.max(0, (targetInst.remainingMonths || 0) - repaid);
    targetInst.remainingAmount = targetInst.monthlyPayment * targetInst.remainingMonths;
  } else if (action === 'set') {
    if (parsed.remainingMonths !== undefined) targetInst.remainingMonths = parsed.remainingMonths;
    if (parsed.remainingAmount !== undefined) targetInst.remainingAmount = parsed.remainingAmount;
    else if (parsed.remainingMonths !== undefined) targetInst.remainingAmount = targetInst.monthlyPayment * parsed.remainingMonths;
  }
  if (parsed.note) targetInst.note = parsed.note;

  DATA.meta.lastUpdated = today.format('YYYY-MM-DD');
  await saveData();
  renderInstallments();
  renderTimeline();
  renderSummaryBanner();
  renderBankCards();
  showToast(`✅ 分期"${targetInst.name}"已更新：剩余${targetInst.remainingMonths}期`);
  setAIStatus('✅ 分期已更新', 'success');
}

// 模糊匹配信用卡账户：支持"民生信用卡"匹配"民生银行信用卡"等
function findCreditAccount(cardName) {
  if (!DATA || !cardName) return null;
  let targetAcc = null;
  // 1. 先尝试通过 PAYMENT_TO_CARD 精确映射
  const cardId = PAYMENT_TO_CARD[cardName];
  if (cardId) {
    DATA.banks.forEach(b => b.accounts.forEach(a => {
      if (a.id === cardId) targetAcc = a;
    }));
    if (targetAcc) return targetAcc;
  }
  // 2. 直接 includes 匹配
  DATA.banks.forEach(b => b.accounts.forEach(a => {
    if ((a.type === 'credit' || a.type === 'huabei') && (a.name.includes(cardName) || cardName.includes(a.name))) {
      targetAcc = a;
    }
  }));
  if (targetAcc) return targetAcc;
  // 3. 去掉"银行"二字后再匹配（"民生信用卡" vs "民生银行信用卡"）
  const stripped = cardName.replace('银行', '');
  DATA.banks.forEach(b => b.accounts.forEach(a => {
    if ((a.type === 'credit' || a.type === 'huabei') && (a.name.replace('银行', '').includes(stripped) || stripped.includes(a.name.replace('银行', '')))) {
      targetAcc = a;
    }
  }));
  if (targetAcc) return targetAcc;
  // 4. 用 bank shortName 匹配（"民生" → 民生银行信用卡）
  const keywords = cardName.replace(/信用卡|银行/g, '');
  if (keywords.length >= 2) {
    DATA.banks.forEach(b => {
      if (b.shortName && (b.shortName.includes(keywords) || keywords.includes(b.shortName) || b.name.includes(keywords))) {
        b.accounts.forEach(a => {
          if (a.type === 'credit' || a.type === 'huabei') targetAcc = a;
        });
      }
    });
  }
  return targetAcc;
}

// AI修改账单（返回 true/false 表示是否成功）
async function aiUpdateBill(parsed) {
  if (!DATA || !parsed) return false;
  const cardName = parsed.cardName || '';
  const targetAcc = findCreditAccount(cardName);
  if (!targetAcc) { showToast('❌ 未找到对应账户，请检查卡名'); setAIStatus('', ''); return false; }

  if (parsed.currentBillAmount !== undefined) targetAcc.currentBillAmount = parsed.currentBillAmount;
  if (parsed.paidAmount !== undefined) targetAcc.paidAmount = parsed.paidAmount;
  if (parsed.minPayment !== undefined) targetAcc.minPayment = parsed.minPayment;
  if (parsed.note) targetAcc.billNote = parsed.note;

  DATA.meta.lastUpdated = today.format('YYYY-MM-DD');
  await saveData();
  renderSummaryBanner();
  renderBankCards();
  showToast(`✅ ${targetAcc.name}账单已更新`);
  setAIStatus('✅ 账单已更新', 'success');
  return true;
}

// AI删除分期
async function aiDeleteInstallment(parsed) {
  if (!DATA || !parsed) return;
  const cardName = parsed.cardName || '';
  const instName = parsed.instName || '';
  const targetAcc = findCreditAccount(cardName);
  let targetIdx = -1;
  if (targetAcc && targetAcc.installments) {
    targetIdx = targetAcc.installments.findIndex(i => i.name.includes(instName) || instName.includes(i.name));
  }
  if (!targetAcc || targetIdx === -1) { showToast('❌ 未找到对应分期，请检查卡名和分期名'); setAIStatus('', ''); return; }

  const removed = targetAcc.installments.splice(targetIdx, 1)[0];
  DATA.meta.lastUpdated = today.format('YYYY-MM-DD');
  await saveData();
  renderInstallments();
  renderTimeline();
  renderSummaryBanner();
  renderBankCards();
  showToast(`✅ 分期"${removed.name}"已从${targetAcc.name}删除`);
  setAIStatus('✅ 分期已删除', 'success');
}

// ---- 渲染对话气泡 ----
function renderAIChat(preserveScroll) {
  const el = document.getElementById('aiChatHistory');
  if (aiChatBubbles.length === 0) { el.innerHTML = ''; return; }

  // 保存滚动位置（确认/跳过/编辑时保持视野不变）
  const savedScrollTop = preserveScroll ? el.scrollTop : null;

  el.innerHTML = aiChatBubbles.map((b, idx) => {
    if (b.role === 'user') {
      const imgHtml = b.imgSrc
        ? (Array.isArray(b.imgSrc)
            ? b.imgSrc.map(src => `<img src="${src}" class="ai-bubble-img" alt="图片" />`).join('')
            : `<img src="${b.imgSrc}" class="ai-bubble-img" alt="图片" />`)
        : '';
      const txt = b.text && b.text !== '（图片）'
        ? `<span>${escHtml(b.text)}</span>` : '';
      return `<div class="ai-bubble ai-bubble-user">${imgHtml}${txt}</div>`;
    } else {
      // 批量汇总提示气泡
      if (b.batchSummary) {
        return `<div class="ai-bubble ai-bubble-ai"><span>${escHtml(b.batchSummary)}</span></div>`;
      }
      if (!b.parsed) {
        const streamingDots = b.streaming ? `<span class="ai-typing-dots"><span>.</span><span>.</span><span>.</span></span>` : '';
        return `<div class="ai-bubble ai-bubble-ai"><span>${escHtml(b.text)}</span>${streamingDots}</div>`;
      }
      const p = b.parsed;
      const intent = p.intent || 'add_expense';

      if (intent === 'add_expense') {
        const bubbleIdx = idx;
        // 批量条目：已录入则显示已完成状态，否则显示确认+跳过
        if (b.batchItem) {
          if (b.confirmed) {
            return `<div class="ai-bubble ai-bubble-ai ai-batch-done">
              <div class="ai-intent-tag">✅ 已录入</div>
              <div class="ai-parsed-card">
                <div class="ai-parsed-row"><span>💰 金额</span><strong style="color:var(--warning)">¥${p.amount}</strong></div>
                <div class="ai-parsed-row"><span>🏷️ 分类</span><strong>${p.category}</strong></div>
                ${p.note ? `<div class="ai-parsed-row"><span>📝 备注</span><strong>${escHtml(p.note)}</strong></div>` : ''}
              </div>
            </div>`;
          }
          if (b.skipped) {
            return `<div class="ai-bubble ai-bubble-ai ai-batch-done" style="opacity:0.45">
              <div class="ai-intent-tag">⏭️ 已跳过</div>
              <div class="ai-parsed-card">
                <div class="ai-parsed-row"><span>💰 金额</span><strong>¥${p.amount}</strong></div>
                ${p.note ? `<div class="ai-parsed-row"><span>📝 备注</span><strong>${escHtml(p.note)}</strong></div>` : ''}
              </div>
            </div>`;
          }
          // 编辑模式已改为弹窗，这里只做展示
          return `<div class="ai-bubble ai-bubble-ai">
            <div class="ai-intent-tag">🛒 录入消费</div>
            ${renderExpenseDisplayCard(p, bubbleIdx)}
            <div class="ai-batch-actions">
              <button class="ai-confirm-btn" onclick="addExpenseFromAI(aiChatBubbles[${bubbleIdx}].parsed, ${bubbleIdx})">✅ 确认录入</button>
              <button class="ai-edit-btn" onclick="editBatchItem(${bubbleIdx})">✏️ 编辑</button>
              <button class="ai-skip-btn" onclick="skipBatchItem(${bubbleIdx})">⏭️ 跳过</button>
            </div>
          </div>`;
        }
        // 单条（文字输入路径）
        if (b.confirmed) {
          return `<div class="ai-bubble ai-bubble-ai ai-batch-done">
            <div class="ai-intent-tag">✅ 已录入</div>
            <div class="ai-parsed-card">
              <div class="ai-parsed-row"><span>📅 日期</span><strong>${escHtml(p.date || '-')}</strong></div>
              <div class="ai-parsed-row"><span>💰 金额</span><strong style="color:var(--warning)">¥${p.amount}</strong></div>
              <div class="ai-parsed-row"><span>🏷️ 分类</span><strong>${escHtml(p.category || '其他')}</strong></div>
              <div class="ai-parsed-row"><span>💳 支付</span><strong>${escHtml(p.payment || '微信零钱')}</strong></div>
              ${p.note ? `<div class="ai-parsed-row"><span>📝 备注</span><strong>${escHtml(p.note)}</strong></div>` : ''}
            </div>
          </div>`;
        }
        if (b.skipped) {
          return `<div class="ai-bubble ai-bubble-ai ai-batch-done" style="opacity:0.45">
            <div class="ai-intent-tag">⏭️ 已跳过</div>
            <div class="ai-parsed-card">
              <div class="ai-parsed-row"><span>💰 金额</span><strong>¥${p.amount}</strong></div>
              ${p.note ? `<div class="ai-parsed-row"><span>📝 备注</span><strong>${escHtml(p.note)}</strong></div>` : ''}
            </div>
          </div>`;
        }
        return `<div class="ai-bubble ai-bubble-ai">
          <div class="ai-intent-tag">🛒 录入消费</div>
          ${renderExpenseDisplayCard(p, bubbleIdx)}
          <div class="ai-batch-actions">
            <button class="ai-confirm-btn" onclick="addExpenseFromAI(aiChatBubbles[${bubbleIdx}].parsed, ${bubbleIdx})">✅ 确认录入</button>
            <button class="ai-edit-btn" onclick="editBatchItem(${bubbleIdx})">✏️ 编辑</button>
          </div>
        </div>`;

      } else if (intent === 'add_loan') {
        const bubbleIdx = idx;
        return `<div class="ai-bubble ai-bubble-ai">
          <div class="ai-intent-tag">🏦 新建贷款</div>
          <div class="ai-parsed-card">
            <div class="ai-parsed-row"><span>🏦 银行</span><strong>${escHtml(p.bankName || '')}</strong></div>
            <div class="ai-parsed-row"><span>📋 账户名</span><strong>${escHtml(p.accountName || '')}</strong></div>
            <div class="ai-parsed-row"><span>💰 贷款金额</span><strong style="color:var(--danger)">¥${p.totalDebt}</strong></div>
            <div class="ai-parsed-row"><span>📆 月供</span><strong>¥${p.monthlyPayment}</strong></div>
            <div class="ai-parsed-row"><span>📅 剩余期数</span><strong>${p.remainingMonths} 期</strong></div>
            <div class="ai-parsed-row"><span>📅 结束日期</span><strong>${p.endDate || '-'}</strong></div>
            ${p.note ? `<div class="ai-parsed-row"><span>📝 备注</span><strong>${escHtml(p.note)}</strong></div>` : ''}
          </div>
          <button class="ai-confirm-btn" onclick="aiConfirmLoan(aiChatBubbles[${bubbleIdx}].parsed)">✅ 确认录入贷款</button>
        </div>`;

      } else if (intent === 'add_installment') {
        const bubbleIdx = idx;
        return `<div class="ai-bubble ai-bubble-ai">
          <div class="ai-intent-tag">💳 新建分期</div>
          <div class="ai-parsed-card">
            <div class="ai-parsed-row"><span>💳 信用卡</span><strong>${escHtml(p.cardName || '')}</strong></div>
            <div class="ai-parsed-row"><span>📋 分期名</span><strong>${escHtml(p.instName || '')}</strong></div>
            <div class="ai-parsed-row"><span>💰 原始金额</span><strong style="color:var(--danger)">¥${p.originalAmount}</strong></div>
            <div class="ai-parsed-row"><span>📆 月供</span><strong>¥${p.monthlyPayment}</strong></div>
            <div class="ai-parsed-row"><span>📅 剩余期数</span><strong>${p.remainingMonths} 期</strong></div>
            <div class="ai-parsed-row"><span>📅 结束日期</span><strong>${p.endDate || '-'}</strong></div>
            ${p.note ? `<div class="ai-parsed-row"><span>📝 备注</span><strong>${escHtml(p.note)}</strong></div>` : ''}
          </div>
          <button class="ai-confirm-btn" onclick="aiConfirmInstallment(aiChatBubbles[${bubbleIdx}].parsed)">✅ 确认录入分期</button>
        </div>`;

      } else if (intent === 'update_wallet') {
        const rows = (p.wallets || []).map(w =>
          `<div class="ai-parsed-row"><span>${w.name}</span><strong style="color:var(--success,#00d4aa)">¥${w.balance}</strong></div>`
        ).join('');
        return `<div class="ai-bubble ai-bubble-ai">
          <div class="ai-intent-tag">💰 更新余额</div>
          <div class="ai-parsed-card">${rows}</div>
          <div class="ai-bubble-hint">✅ 已自动更新钱包余额</div>
        </div>`;

      } else if (intent === 'update_installment') {
        return `<div class="ai-bubble ai-bubble-ai">
          <div class="ai-intent-tag">🔄 修改分期</div>
          <div class="ai-parsed-card">
            <div class="ai-parsed-row"><span>💳 信用卡</span><strong>${escHtml(p.cardName || '')}</strong></div>
            <div class="ai-parsed-row"><span>📋 分期名</span><strong>${escHtml(p.instName || '')}</strong></div>
            <div class="ai-parsed-row"><span>⚡ 操作</span><strong>${p.action === 'repay' ? '还款' + (p.periods || '') + '期' : '设置'}</strong></div>
            ${p.remainingMonths !== undefined ? `<div class="ai-parsed-row"><span>📅 剩余期数</span><strong>${p.remainingMonths} 期</strong></div>` : ''}
            ${p.remainingAmount !== undefined ? `<div class="ai-parsed-row"><span>💰 剩余金额</span><strong>¥${p.remainingAmount}</strong></div>` : ''}
            ${p.note ? `<div class="ai-parsed-row"><span>📝 备注</span><strong>${escHtml(p.note)}</strong></div>` : ''}
          </div>
          <div class="ai-bubble-hint">✅ 已自动更新分期</div>
        </div>`;

      } else if (intent === 'update_bill') {
        return `<div class="ai-bubble ai-bubble-ai">
          <div class="ai-intent-tag">📄 修改账单</div>
          <div class="ai-parsed-card">
            <div class="ai-parsed-row"><span>💳 账户</span><strong>${escHtml(p.cardName || '')}</strong></div>
            ${p.currentBillAmount !== undefined ? `<div class="ai-parsed-row"><span>💰 本期账单</span><strong>¥${p.currentBillAmount}</strong></div>` : ''}
            ${p.paidAmount !== undefined ? `<div class="ai-parsed-row"><span>✅ 已还金额</span><strong>¥${p.paidAmount}</strong></div>` : ''}
            ${p.minPayment !== undefined ? `<div class="ai-parsed-row"><span>⚠️ 最低还款</span><strong>¥${p.minPayment}</strong></div>` : ''}
            ${p.note ? `<div class="ai-parsed-row"><span>📝 备注</span><strong>${escHtml(p.note)}</strong></div>` : ''}
          </div>
          <div class="ai-bubble-hint">${b.actionFailed ? '❌ 更新失败：未找到对应账户' : '✅ 已自动更新账单'}</div>
        </div>`;

      } else if (intent === 'delete_installment') {
        return `<div class="ai-bubble ai-bubble-ai">
          <div class="ai-intent-tag">🗑️ 删除分期</div>
          <div class="ai-parsed-card">
            <div class="ai-parsed-row"><span>💳 信用卡</span><strong>${escHtml(p.cardName || '')}</strong></div>
            <div class="ai-parsed-row"><span>📋 分期名</span><strong>${escHtml(p.instName || '')}</strong></div>
          </div>
          <div class="ai-bubble-hint">✅ 已自动删除分期</div>
        </div>`;

      } else if (intent === 'query' || intent === 'chat') {
        return `<div class="ai-bubble ai-bubble-ai">
          <span>${escHtml(p.reply || b.text)}</span>
        </div>`;

      } else {
        return `<div class="ai-bubble ai-bubble-ai"><span>${escHtml(b.text)}</span></div>`;
      }
    }
  }).join('');

  // 滚动到底部（或恢复滚动位置）
  if (preserveScroll && savedScrollTop !== null) {
    el.scrollTop = savedScrollTop;
  } else {
    el.scrollTop = el.scrollHeight;
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// AI 识别消费后直接录入（支持 bubbleIdx 标记已确认）
async function addExpenseFromAI(data, bubbleIdx) {
if (!data || !data.amount || data.amount === 0) {
showToast('❌ 金额无效，请重新描述');
return;
}
  // 检测到主动还款：自动更新对应信用卡的 paidAmount
  if (isRepayment({ category: data.category, note: data.note })) {
    const cardId = PAYMENT_TO_CARD[data.payment];
    if (cardId && DATA) {
      let targetAcc = null;
      DATA.banks.forEach(b => b.accounts.forEach(a => { if (a.id === cardId) targetAcc = a; }));
      if (targetAcc) {
        targetAcc.paidAmount = (targetAcc.paidAmount || 0) + Math.abs(data.amount);
        await saveData();
        refreshAfterExpenseChange();
        showToast(`✅ 已自动更新${targetAcc.name}已还金额 +${fmt(Math.abs(data.amount))}`);
        if (bubbleIdx !== undefined && aiChatBubbles[bubbleIdx]) {
          aiChatBubbles[bubbleIdx].confirmed = true;
          renderAIChat(true);
        }
        return;
      }
    }
    showToast('⚠️ 检测到还款记录但无法匹配信用卡，请手动更新已还金额');
    return;
  }
// 重复检测提醒（改为拦截，不再仅提示）
const dup = checkDuplicateExpense(data, bubbleIdx);
if (dup) {
showToast(`⚠️ 重复录入已拦截：${data.date} ¥${data.amount} ${data.payment} 已存在`);
return;
}
const cardId = PAYMENT_TO_CARD[data.payment];
  const billing = cardId ? getBillingCycle(cardId, data.date) : null;
  const expense = {
    id: Date.now(),
    date: data.date,
    amount: data.amount,
    category: data.category || '其他',
    payment: data.payment || '微信零钱',
    note: data.note || '',
    cardId: cardId || null,
    billMonth: billing?.billMonth || null,
    dueDate: billing?.dueDate?.format('YYYY-MM-DD') || null,
    isCashAdvance: checkCashAdvance(data.amount, data.note, data.payment)
  };
  const expenses = getExpenses();
  expenses.push(expense);
  expenses.sort((a, b) => b.date.localeCompare(a.date));
  await saveExpenses(expenses);

  // 钱包支付自动扣减余额
  if (deductWalletBalance(data.payment, data.amount)) {
    await saveData();
    renderWallets();
  }

  refreshAfterExpenseChange();
  const billTip = billing ? `\n📋 计入 ${billing.billMonth} 账单，还款日 ${billing.dueDate.format('M月D日')}` : '';
  const walletTip = PAYMENT_TO_WALLET[data.payment] ? ` (已扣减${data.payment}余额)` : '';
  showToast(`✅ 已录入 ${data.payment} 消费 ¥${data.amount}${walletTip}${billTip}`);
  // 标记气泡为已确认
  if (bubbleIdx !== undefined && aiChatBubbles[bubbleIdx]) {
    aiChatBubbles[bubbleIdx].confirmed = true;
    renderAIChat(true);
    saveAIChatHistory();
  }
}

// 跳过批量条目
function skipBatchItem(bubbleIdx) {
  if (aiChatBubbles[bubbleIdx]) {
    aiChatBubbles[bubbleIdx].skipped = true;
    renderAIChat(true);
    saveAIChatHistory();
  }
}

// ===== AI解析消费卡片：展示 / 编辑 =====
// ===== 重复消费检测 =====
// 检查解析的消费是否与已保存的消费记录重复（日期+金额+支付方式）
function checkDuplicateExpense(p, excludeBubbleIdx) {
  const existing = getExpenses();
  // 同批次内也检查（避免多张图重复识别同一条）
  const batchParsed = aiChatBubbles
    .filter((b, i) => i !== excludeBubbleIdx && b.parsed && b.parsed.intent === 'add_expense' && b.confirmed)
    .map(b => b.parsed);
  const allExisting = [
    ...existing.map(e => ({ date: e.date, amount: e.amount, payment: e.payment })),
    ...batchParsed,
  ];
  return allExisting.find(e =>
    e.date === p.date &&
    Math.abs(e.amount - p.amount) < 0.01 &&
    e.payment === p.payment
  );
}

function renderExpenseDisplayCard(p, bubbleIdx) {
  const dup = bubbleIdx !== undefined ? checkDuplicateExpense(p, bubbleIdx) : null;
  const dupBanner = dup ? `<div class="ai-dup-warning">⚠️ 疑似重复：${p.date} ¥${p.amount} ${p.payment} 已存在，确认录入前请检查</div>` : '';
  const rows = [
    `<div class="ai-parsed-row"><span>📅 日期</span><strong>${escHtml(p.date || '-')}</strong></div>`,
    `<div class="ai-parsed-row"><span>💰 金额</span><strong style="color:var(--warning)">¥${p.amount}</strong></div>`,
    `<div class="ai-parsed-row"><span>🏷️ 分类</span><strong>${escHtml(p.category || '其他')}</strong></div>`,
    `<div class="ai-parsed-row"><span>💳 支付</span><strong>${escHtml(p.payment || '微信零钱')}</strong></div>`,
  ];
  if (p.note) rows.push(`<div class="ai-parsed-row"><span>📝 备注</span><strong>${escHtml(p.note)}</strong></div>`);
  return `${dupBanner}<div class="ai-parsed-card${dup ? ' ai-dup-card' : ''}">${rows.join('')}</div>`;
}

function editBatchItem(bubbleIdx) {
  if (!aiChatBubbles[bubbleIdx]) return;
  const p = aiChatBubbles[bubbleIdx].parsed;
  if (!p) return;
  document.getElementById('aiEditDate').value = p.date || dayjs().format('YYYY-MM-DD');
  document.getElementById('aiEditAmount').value = p.amount || '';
  document.getElementById('aiEditCategory').value = p.category || '其他';
  document.getElementById('aiEditPayment').value = p.payment || '微信零钱';
  document.getElementById('aiEditNote').value = p.note || '';
  document.getElementById('aiEditOverlay').dataset.bubbleIdx = bubbleIdx;
  document.getElementById('aiEditOverlay').classList.add('open');
}

function closeAIEditModal() {
  document.getElementById('aiEditOverlay').classList.remove('open');
}

function saveAIEditModal() {
  const overlay = document.getElementById('aiEditOverlay');
  const bubbleIdx = overlay.dataset.bubbleIdx;
  const b = aiChatBubbles[bubbleIdx];
  if (!b) return;
  const date = document.getElementById('aiEditDate').value;
  const amount = parseFloat(document.getElementById('aiEditAmount').value);
  const category = document.getElementById('aiEditCategory').value;
  const payment = document.getElementById('aiEditPayment').value;
  const note = document.getElementById('aiEditNote').value;
  if (isNaN(amount) || amount === 0) { showToast('❌ 金额无效'); return; }
  if (!date) { showToast('❌ 日期无效'); return; }
  b.parsed = { ...b.parsed, date, amount, category, payment, note: note || '' };
  closeAIEditModal();
  renderAIChat(true);
  saveAIChatHistory();
  showToast('✅ 已修改，请确认录入');
}

// ===== 对话历史持久化 =====
function saveAIChatHistory() {
  try {
    // 只保存可序列化的字段（去掉 imgSrc 大图，保留缩略标记）
    const toSave = aiChatBubbles.map(b => ({
      role: b.role,
      text: b.text,
      parsed: b.parsed,
      batchSummary: b.batchSummary,
      batchItem: b.batchItem,
      confirmed: b.confirmed,
      skipped: b.skipped,
      // imgSrc 可能很大，只保留有无标记
      hasImg: !!b.imgSrc,
    }));
    localStorage.setItem('aiChatBubbles', JSON.stringify(toSave));
    localStorage.setItem('aiConversation', JSON.stringify(aiConversation));
  } catch (e) {
    console.warn('保存对话历史失败:', e);
  }
}

function loadAIChatHistory() {
  try {
    const bubbles = localStorage.getItem('aiChatBubbles');
    const conv    = localStorage.getItem('aiConversation');
    if (bubbles) {
      aiChatBubbles = JSON.parse(bubbles).map(b => ({
        ...b,
        imgSrc: b.hasImg ? null : undefined, // 图片不恢复，只保留文字
      }));
    }
    if (conv) aiConversation = JSON.parse(conv);
  } catch (e) {
    console.warn('加载对话历史失败:', e);
  }
}

// 兼容旧调用（保留函数名）
function fillExpenseForm(data) {
  addExpenseFromAI(data);
}

function setSelectValue(id, value) {
  const sel = document.getElementById(id);
  for (const opt of sel.options) {
    if (opt.value === value) { sel.value = value; return; }
  }
  for (const opt of sel.options) {
    if (opt.value.includes(value) || value.includes(opt.value)) { sel.value = opt.value; return; }
  }
}

function setAIStatus(msg, type = '') {
  const el = document.getElementById('aiStatus');
  el.textContent = msg;
  el.className = 'ai-status' + (type ? ` ${type}` : '');
}

// ===== What-if 抽屉 =====
function openWhatif(bankId, accId) {
  // 初始化账户选择器
  const select = document.getElementById('whatifAccount');
  select.innerHTML = '';
  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ bankId: bank.id, accId: acc.id });
      opt.textContent = `${bank.shortName} · ${acc.name}`;
      if (bank.id === bankId && acc.id === accId) opt.selected = true;
      select.appendChild(opt);
    });
  });
  // 更新标题
  const bank = DATA.banks.find(b => b.id === bankId);
  const acc = bank?.accounts.find(a => a.id === accId);
  document.getElementById('whatifAccountLabel').textContent =
    acc ? `${bank.shortName} · ${acc.name}` : '选择账户';
  // 重置结果
  document.getElementById('whatifResult').innerHTML = '<div class="result-placeholder">👆 设置参数后点击计算</div>';
  // 显示抽屉
  document.getElementById('whatifOverlay').classList.add('open');
  document.getElementById('whatifDrawer').classList.add('open');
}

function closeWhatif() {
  document.getElementById('whatifOverlay').classList.remove('open');
  document.getElementById('whatifDrawer').classList.remove('open');
}

// 银行卡片上的 What-if 入口按钮（在 renderBankCards 中调用）
function addWhatifBtnToCards() {
  document.querySelectorAll('.bank-card').forEach(card => {
    // 已有按钮则跳过
    if (card.querySelector('.whatif-entry-btn')) return;
  });
}

// ===== 消费分析页 =====
let analysisMonth = dayjs().format('YYYY-MM');

const CATEGORY_COLORS = {
  '餐饮堂食': '#ff6b6b', '外卖': '#ff9f43', '买菜生鲜': '#1dd1a1',
  '烟酒零食': '#feca57', '交通出行': '#4dabf7', '购物数码': '#a29bfe',
  '购物服装': '#fd79a8', '日用百货': '#74b9ff', '娱乐休闲': '#cc5de8',
  '订阅会员': '#6c5ce7', '医疗健康': '#51cf66', '教育学习': '#74c0fc',
  '居家大件': '#a9e34b', '转账还款': '#868e96', '宠物': '#f9ca24', '其他': '#636e72'
};

function renderAnalysisPage() {
  renderAnalysisTotals();
  renderAnalysisCharts();
  renderAnalysisPaymentDist();
  renderExpenseTable();
}

function renderAnalysisTotals() {
  const el = document.getElementById('analysisTotals');
  if (!el) return;
  const expenses = getExpenses().filter(e => e.date.startsWith(analysisMonth));
  const total = expenses.reduce((s, e) => s + (e.amount > 0 ? e.amount : 0), 0);
  const refund = expenses.reduce((s, e) => s + (e.amount < 0 ? Math.abs(e.amount) : 0), 0);
  const net = total - refund;
  const count = expenses.filter(e => e.amount > 0).length;
  const dayNum = analysisMonth === dayjs().format('YYYY-MM') ? dayjs().date() : dayjs(analysisMonth + '-01').daysInMonth();
  const daily = dayNum > 0 ? net / dayNum : 0;

  el.innerHTML = `
    <div class="analysis-total-card">
      <div class="atc-label">本月总支出</div>
      <div class="atc-value" style="color:var(--warning)">${fmt(net)}</div>
      ${refund > 0 ? `<div class="atc-sub">退款 ${fmt(refund)}</div>` : ''}
    </div>
    <div class="analysis-total-card">
      <div class="atc-label">消费笔数</div>
      <div class="atc-value">${count} 笔</div>
    </div>
    <div class="analysis-total-card">
      <div class="atc-label">日均支出</div>
      <div class="atc-value" style="color:var(--info)">${fmt(daily)}</div>
    </div>`;
}

function renderAnalysisCharts() {
  if (typeof Chart === 'undefined') {
    console.warn('[Chart] Chart.js 未加载，跳过分析图表渲染');
    return;
  }
  const expenses = getExpenses().filter(e => e.date.startsWith(analysisMonth) && e.amount > 0);
  const byCategory = {};
  expenses.forEach(e => {
    byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
  });

  const sorted = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((s, [, v]) => s + v, 0);

  // 饼图
  const pieEl = document.getElementById('analysisPieChart');
  if (pieEl) {
    const ctx = pieEl.getContext('2d');
    if (window._analysisPieChart) { window._analysisPieChart.destroy(); window._analysisPieChart = null; }
    // 空数据时显示占位
    const pieWrap = pieEl.parentElement;
    const existPlaceholder = pieWrap?.querySelector('.pie-empty-placeholder');
    if (sorted.length === 0) {
      pieEl.style.display = 'none';
      if (!existPlaceholder) {
        const ph = document.createElement('div');
        ph.className = 'pie-empty-placeholder';
        ph.textContent = '本月暂无消费记录';
        pieWrap.appendChild(ph);
      }
    } else {
      pieEl.style.display = '';
      if (existPlaceholder) existPlaceholder.remove();
    }
    if (sorted.length > 0) {
      window._analysisPieChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: sorted.map(([k]) => k),
          datasets: [{
            data: sorted.map(([, v]) => v),
            backgroundColor: sorted.map(([k]) => (CATEGORY_COLORS[k] || '#6c63ff') + 'cc'),
            borderColor: sorted.map(([k]) => CATEGORY_COLORS[k] || '#6c63ff'),
            borderWidth: 2, hoverOffset: 6
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '60%',
          plugins: {
            legend: { position: 'bottom', labels: { color: '#8892b0', font: { size: 11 }, padding: 8, usePointStyle: true } },
            tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${fmt(ctx.raw)} (${fmtPct(ctx.raw / total)})` } }
          }
        }
      });
    }
  }

  // 排行榜
  const rankEl = document.getElementById('analysisCategoryRank');
  if (!rankEl) return;
  if (sorted.length === 0) {
    rankEl.innerHTML = '<div class="empty-state">本月暂无消费记录</div>';
    return;
  }
  const maxVal = sorted[0][1];
  rankEl.innerHTML = sorted.map(([cat, amt]) => `
    <div class="analysis-rank-row">
      <div class="analysis-rank-label">
        <span class="analysis-rank-dot" style="background:${CATEGORY_COLORS[cat] || '#6c63ff'}"></span>
        <span>${cat}</span>
      </div>
      <div class="analysis-rank-bar-wrap">
        <div class="analysis-rank-bar-fill" style="width:${(amt / maxVal * 100).toFixed(1)}%;background:${CATEGORY_COLORS[cat] || '#6c63ff'}"></div>
      </div>
      <div class="analysis-rank-amount">${fmt(amt)}</div>
      <div class="analysis-rank-pct">${fmtPct(amt / total)}</div>
    </div>`).join('');
}

function renderAnalysisPaymentDist() {
  const el = document.getElementById('analysisPaymentDist');
  if (!el) return;
  const expenses = getExpenses().filter(e => e.date.startsWith(analysisMonth) && e.amount > 0);
  const byPayment = {};
  expenses.forEach(e => {
    // 如果备注中含有已知信用卡尾号，归入对应信用卡显示
    const resolved = resolveCardFromNote(e.note, e.payment);
    const displayPayment = resolved ? resolved.payment : e.payment;
    byPayment[displayPayment] = (byPayment[displayPayment] || 0) + e.amount;
  });
  const sorted = Object.entries(byPayment).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((s, [, v]) => s + v, 0);
  if (sorted.length === 0) {
    el.innerHTML = '<div style="color:var(--text-muted);padding:12px">暂无数据</div>';
    return;
  }
  el.innerHTML = `<div class="payment-dist-list">${sorted.map(([name, amt]) => `
    <div class="payment-dist-row">
      <span class="payment-dist-name">${name}</span>
      <div class="payment-dist-bar-wrap">
        <div class="payment-dist-bar-fill" style="width:${(amt / total * 100).toFixed(1)}%"></div>
      </div>
      <span class="payment-dist-amount">${fmt(amt)}</span>
      <span class="payment-dist-pct">${fmtPct(amt / total)}</span>
    </div>`).join('')}</div>`;
}

async function runAIAnalysis() {
  const btn = document.getElementById('aiAnalysisBtn');
  const resultEl = document.getElementById('aiAnalysisResult');
  if (!btn || !resultEl) return;

  btn.disabled = true;
  btn.textContent = '⏳ 分析中...';
  resultEl.innerHTML = '<div class="ai-analysis-loading">🤖 AI 正在分析本月消费数据...</div>';

  const expenses = getExpenses().filter(e => e.date.startsWith(analysisMonth) && e.amount > 0);
  const total = expenses.reduce((s, e) => s + e.amount, 0);
  const byCategory = {};
  expenses.forEach(e => { byCategory[e.category] = (byCategory[e.category] || 0) + e.amount; });
  const topCats = Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([k, v]) => `${k}: ¥${v.toFixed(2)}`).join('、');

  const prompt = `用户 ${analysisMonth} 月消费数据：总支出 ¥${total.toFixed(2)}，共 ${expenses.length} 笔。
主要分类：${topCats || '暂无'}。
请用 3-4 句话给出消费分析和节省建议，语气友好，重点突出。`;

  try {
    const data = await fridayRequest(MODEL_TEXT, [
      { role: 'system', content: '你是一个个人财务顾问，给出简洁实用的消费分析建议。' },
      { role: 'user', content: prompt }
    ], 300);
    const reply = data.choices?.[0]?.message?.content || '暂时无法生成分析';
    resultEl.innerHTML = `<div class="ai-analysis-text">${escHtml(reply)}</div>`;
  } catch (e) {
    resultEl.innerHTML = `<div class="ai-analysis-error">❌ 分析失败：${e.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🤖 生成分析';
  }
}

// 分析页月份导航
document.addEventListener('DOMContentLoaded', () => {
  const labelEl = document.getElementById('analysisMonthLabel');
  const prevBtn = document.getElementById('analysisPrevMonth');
  const nextBtn = document.getElementById('analysisNextMonth');
  const filterEl = document.getElementById('expFilterMonth');

  function updateAnalysisMonth(m) {
    analysisMonth = m;
    if (labelEl) labelEl.textContent = dayjs(m + '-01').format('YYYY年M月');
    if (filterEl) filterEl.value = m;
    renderAnalysisPage();
  }

  if (labelEl) labelEl.textContent = dayjs(analysisMonth + '-01').format('YYYY年M月');

  if (prevBtn) prevBtn.addEventListener('click', () => {
    updateAnalysisMonth(dayjs(analysisMonth + '-01').subtract(1, 'month').format('YYYY-MM'));
  });
  if (nextBtn) nextBtn.addEventListener('click', () => {
    const next = dayjs(analysisMonth + '-01').add(1, 'month').format('YYYY-MM');
    if (next <= dayjs().format('YYYY-MM')) updateAnalysisMonth(next);
  });
});

// ===== 启动 =====
loadData();

// ===== 下拉刷新 =====
(function initPullRefresh() {
  const indicator = document.getElementById('pullRefreshIndicator');
  const arrow = document.getElementById('pullRefreshArrow');
  const text = document.getElementById('pullRefreshText');
  if (!indicator) return;

  const THRESHOLD = 70;   // 触发刷新所需下拉距离（px）
  const MAX_PULL = 110;   // 最大下拉距离（px）
  let startY = 0;
  let pulling = false;
  let refreshing = false;

  function setSpinner() {
    arrow.style.display = 'none';
    // 动态插入 spinner（避免重复）
    if (!document.getElementById('pullSpinner')) {
      const s = document.createElement('span');
      s.id = 'pullSpinner';
      s.className = 'pull-refresh-spinner';
      indicator.insertBefore(s, text);
    }
    text.textContent = '刷新中...';
    indicator.classList.add('refreshing');
    indicator.classList.remove('visible');
  }

  function resetIndicator() {
    indicator.classList.remove('visible', 'refreshing');
    arrow.style.display = '';
    arrow.classList.remove('ready');
    text.textContent = '下拉刷新';
    const s = document.getElementById('pullSpinner');
    if (s) s.remove();
    pulling = false;
    refreshing = false;
  }

  document.addEventListener('touchstart', (e) => {
    // 只在页面滚动到顶部时才允许触发
    if (window.scrollY > 0) return;
    // AI 页面内部有独立滚动区域，跳过
    const aiPage = document.getElementById('page-ai');
    if (aiPage && aiPage.classList.contains('active')) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!pulling || refreshing) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) { pulling = false; return; }

    const ratio = Math.min(dy / MAX_PULL, 1);
    // 用 translateY 让指示器跟随手指
    indicator.style.transition = 'none';
    indicator.style.transform = `translateY(${-100 + ratio * 100}%)`;
    indicator.classList.add('visible');

    if (dy >= THRESHOLD) {
      arrow.classList.add('ready');
      text.textContent = '松开立即刷新';
    } else {
      arrow.classList.remove('ready');
      text.textContent = '下拉刷新';
    }
  }, { passive: true });

  document.addEventListener('touchend', async (e) => {
    if (!pulling || refreshing) return;
    const dy = e.changedTouches[0].clientY - startY;
    indicator.style.transition = '';
    indicator.style.transform = '';

    if (dy >= THRESHOLD) {
      refreshing = true;
      setSpinner();
      try {
        await loadData();
      } finally {
        setTimeout(resetIndicator, 600);
      }
    } else {
      resetIndicator();
    }
  }, { passive: true });
})();

// ===== 回到顶部按钮 =====
(function initBackToTop() {
  const btn = document.getElementById('backToTopBtn');
  if (!btn) return;

  window.addEventListener('scroll', () => {
    if (window.scrollY > 300) {
      btn.classList.add('visible');
    } else {
      btn.classList.remove('visible');
    }
  }, { passive: true });

  btn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();
