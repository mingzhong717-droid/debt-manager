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
  'cmb-credit-1':  { name: '招商信用卡',   billDay: 21, dueDay: 21, dueDayNextMonth: false },
  'gz-credit-1':   { name: '广州银行信用卡', billDay: 13, dueDay: 2,  dueDayNextMonth: true  },
  'spd-credit-1':  { name: '浦发信用卡',   billDay: 29, dueDay: 17, dueDayNextMonth: true  },
  'abc-credit-1':  { name: '农业银行信用卡', billDay: 17, dueDay: 6,  dueDayNextMonth: true  },
  'cmbc-credit-1': { name: '民生银行信用卡', billDay: 19, dueDay: 9,  dueDayNextMonth: true  },
};

// 支付方式名称 → 账户ID 映射（用于消费联动）
const PAYMENT_TO_CARD = {
  '招商信用卡':    'cmb-credit-1',
  '广州银行信用卡': 'gz-credit-1',
  '浦发信用卡':    'spd-credit-1',
  '农行信用卡':    'abc-credit-1',
  '民生信用卡':    'cmbc-credit-1',
};

// ===== 全局状态 =====
let DATA = null;
let pieChart = null;
let barChart = null;
let expensePieChart = null;
let calendarDate = dayjs();
let syncStatus = 'idle'; // idle | syncing | ok | error

// ===== 工具函数 =====
const fmt = (n) => '¥' + Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtPct = (n) => (n * 100).toFixed(1) + '%';
const today = dayjs();

// ===== Supabase API 封装 =====
async function sbFetch(path, options = {}) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...options,
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
    throw new Error(err);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
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

// ===== 数据加载（强制云端优先，localStorage 仅作离线降级）=====
const CACHE_VERSION = '2';  // 升级此版本号可强制清除旧缓存
async function loadData() {
  // 清除版本不匹配的旧缓存
  if (localStorage.getItem('debtManagerCacheVer') !== CACHE_VERSION) {
    localStorage.removeItem('debtManagerData');
    localStorage.setItem('debtManagerCacheVer', CACHE_VERSION);
    console.log('检测到旧缓存，已清除，将从云端重新加载');
  }

  try {
    setSyncStatus('syncing');
    // 强制从 Supabase 读取（不走缓存）
    const rows = await sbFetch(DEBT_TABLE + '?id=eq.' + DATA_ROW_ID + '&select=payload');
    if (rows && rows.length > 0 && rows[0].payload) {
      DATA = rows[0].payload;
      localStorage.setItem('debtManagerData', JSON.stringify(DATA));
      setSyncStatus('ok');
    } else {
      throw new Error('云端无数据');
    }
  } catch (e) {
    console.warn('云端加载失败，降级本地:', e.message);
    // 降级：本地 localStorage
    const saved = localStorage.getItem('debtManagerData');
    if (saved) {
      DATA = JSON.parse(saved);
    } else {
      // 最后降级：data.json
      const res = await fetch('data.json');
      DATA = await res.json();
    }
    setSyncStatus('error');
  }

  if (!DATA) {
    document.body.innerHTML = '<div style="padding:40px;color:#ff4d6d">⚠️ 数据加载失败</div>';
    return;
  }
  init();
}

// ===== 保存数据（同时写云端 + 本地）=====
async function saveData() {
  localStorage.setItem('debtManagerData', JSON.stringify(DATA));
  try {
    setSyncStatus('syncing');
    await sbFetch(DEBT_TABLE + '?id=eq.' + DATA_ROW_ID, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ payload: DATA, updated_at: new Date().toISOString() })
    });
    setSyncStatus('ok');
  } catch (e) {
    console.warn('云端保存失败:', e.message);
    setSyncStatus('error');
  }
}

// ===== 初始化 =====
function init() {
  renderSummaryBanner();
  renderBankCards();
  renderPieChart();
  renderBarChart();
  renderCalendar(calendarDate);
  renderInstallments();
  renderTimeline();
  initWhatIf();
  initExpenses();
  renderBillingStatus();
  renderExpenseOverview();
  schedulePaymentReminders();
  document.getElementById('lastUpdated').textContent = '更新于 ' + DATA.meta.lastUpdated;
}

// ===== 计算汇总数据 =====
function calcSummary() {
  let totalDebt = 0;
  let monthlyDue = 0;
  let nextDue = null;
  const now = today;

  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      totalDebt += acc.totalDebt || 0;

      if (acc.type === 'credit') {
        // 信用卡：最低还款 + 分期月供
        monthlyDue += acc.minPayment || 0;
        acc.installments?.forEach(inst => {
          monthlyDue += inst.monthlyPayment || 0;
        });
        // 还款日
        const dueDay = acc.dueDay;
        let dueDate = now.date(dueDay);
        if (dueDate.isBefore(now, 'day')) dueDate = dueDate.add(1, 'month');
        if (!nextDue || dueDate.isBefore(nextDue)) nextDue = dueDate;
      } else if (acc.type === 'loan') {
        monthlyDue += acc.monthlyPayment || 0;
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
  const income = DATA.meta.monthlyIncome;
  const ratio = monthlyDue / income;

  document.getElementById('totalDebt').textContent = fmt(totalDebt);
  document.getElementById('monthlyDue').textContent = fmt(monthlyDue);
  document.getElementById('monthlyIncome').textContent = fmt(income);

  const ratioEl = document.getElementById('debtRatio');
  ratioEl.textContent = fmtPct(ratio);
  ratioEl.className = 'summary-value ' + (ratio > 0.5 ? 'danger' : ratio > 0.35 ? 'warning' : 'info');

  if (nextDue) {
    const daysLeft = nextDue.diff(today, 'day');
    document.getElementById('nextDueDate').textContent =
      nextDue.format('MM月DD日') + (daysLeft <= 3 ? ` (${daysLeft}天后)` : '');
  }
}

// ===== 银行卡片 =====
function renderBankCards() {
  const container = document.getElementById('bankCards');
  container.innerHTML = '';

  DATA.banks.forEach((bank, i) => {
    const bankTotal = bank.accounts.reduce((s, a) => s + (a.totalDebt || 0), 0);

    const card = document.createElement('div');
    card.className = 'bank-card';
    card.style.setProperty('--bank-color', bank.color);
    card.style.animationDelay = (i * 0.05) + 's';

    let accountsHTML = '';
    bank.accounts.forEach(acc => {
      const dueDay = acc.dueDay;
      const now = today;
      let dueDate = now.date(dueDay);
      if (dueDate.isBefore(now, 'day')) dueDate = dueDate.add(1, 'month');
      const daysLeft = dueDate.diff(now, 'day');
      const isUrgent = daysLeft <= 5;

      let extraInfo = '';
      if (acc.type === 'credit') {
        const usedPct = acc.totalDebt / acc.creditLimit;
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

      accountsHTML += `
        <div class="account-item">
          <div class="account-header">
            <span class="account-name">${acc.name}</span>
            <span class="account-amount">${fmt(acc.totalDebt)}</span>
          </div>
          <div class="account-meta">
            <span>还款日 <span class="due-badge ${isUrgent ? 'urgent' : ''}">${dueDay}号 (${daysLeft}天后)</span></span>
          </div>
          ${extraInfo}
        </div>`;
    });

    card.innerHTML = `
      <div class="bank-card-header">
        <span class="bank-icon">${bank.icon}</span>
        <span class="bank-name">${bank.name}</span>
        <span class="bank-total">${fmt(bankTotal)}</span>
      </div>
      <div class="bank-accounts">${accountsHTML}</div>`;

    container.appendChild(card);
  });
}

// ===== 饼图 =====
function renderPieChart() {
  const labels = [];
  const values = [];
  const colors = [];

  DATA.banks.forEach(bank => {
    const total = bank.accounts.reduce((s, a) => s + (a.totalDebt || 0), 0);
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
          total += acc.minPayment || 0;
          acc.installments?.forEach(inst => {
            const endDate = dayjs(inst.endDate);
            if (m.isBefore(endDate) || m.isSame(endDate, 'month')) {
              total += inst.monthlyPayment || 0;
            }
          });
        }
      });
    });

    payments.push(total);
  }

  const income = DATA.meta.monthlyIncome;
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
            callback: (v) => '¥' + (v / 1000).toFixed(0) + 'k'
          },
          grid: { color: 'rgba(46,50,80,0.5)' }
        }
      }
    }
  });
}

// ===== 还款日历 =====
function buildDueDays(month) {
  // 返回 { day: [{bankName, accountName, amount, color}] }
  const dueDays = {};

  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      const dueDay = acc.dueDay;
      if (!dueDays[dueDay]) dueDays[dueDay] = [];

      let amount = 0;
      if (acc.type === 'credit') {
        amount = acc.minPayment || 0;
        acc.installments?.forEach(inst => {
          const endDate = dayjs(inst.endDate);
          if (month.isBefore(endDate) || month.isSame(endDate, 'month')) {
            amount += inst.monthlyPayment || 0;
          }
        });
      } else {
        const endDate = dayjs(acc.endDate || '2099-01-01');
        if (month.isBefore(endDate) || month.isSame(endDate, 'month')) {
          amount = acc.monthlyPayment || 0;
        }
      }

      if (amount > 0) {
        dueDays[dueDay].push({
          bankName: bank.shortName,
          accountName: acc.name,
          amount,
          color: bank.color
        });
      }
    });
  });

  return dueDays;
}

function renderCalendar(month) {
  calendarDate = month;
  const container = document.getElementById('calendarWrap');
  const dueDays = buildDueDays(month);

  const firstDay = month.startOf('month').day(); // 0=周日
  const daysInMonth = month.daysInMonth();
  const todayDay = today.isSame(month, 'month') ? today.date() : -1;

  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];

  let html = `
    <div class="calendar-header">
      <span class="calendar-month">${month.format('YYYY年M月')}</span>
      <div class="calendar-nav">
        <button id="calPrev">‹</button>
        <button id="calNext">›</button>
      </div>
    </div>
    <div class="calendar-grid">
      ${weekdays.map(d => `<div class="calendar-weekday">${d}</div>`).join('')}
  `;

  // 空格
  for (let i = 0; i < firstDay; i++) {
    html += '<div class="calendar-day empty"></div>';
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dues = dueDays[d] || [];
    const isToday = d === todayDay;
    const hasDue = dues.length > 0;

    let tooltipHTML = '';
    let dotsHTML = '';
    if (hasDue) {
      tooltipHTML = dues.map(item =>
        `<div style="color:${item.color}">${item.bankName} ${item.accountName}: ${fmt(item.amount)}</div>`
      ).join('');
      dotsHTML = dues.map(item =>
        `<div class="day-dot" style="background:${item.color}"></div>`
      ).join('');
    }

    html += `
      <div class="calendar-day ${isToday ? 'today' : ''} ${hasDue ? 'has-due' : ''}">
        <span class="day-num">${d}</span>
        ${dotsHTML ? `<div class="day-dots">${dotsHTML}</div>` : ''}
        ${tooltipHTML ? `<div class="calendar-tooltip">${tooltipHTML}</div>` : ''}
      </div>`;
  }

  html += '</div>';
  container.innerHTML = html;

  document.getElementById('calPrev').addEventListener('click', () => renderCalendar(calendarDate.subtract(1, 'month')));
  document.getElementById('calNext').addEventListener('click', () => renderCalendar(calendarDate.add(1, 'month')));
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
    allInsts.forEach(inst => {
      const paid = inst.originalAmount - inst.remainingAmount;
      const pct = paid / inst.originalAmount;
      const endDate = dayjs(inst.endDate);
      const monthsLeft = Math.max(0, endDate.diff(today, 'month'));

      cardsHTML += `
        <div class="installment-card">
          <div class="inst-header">
            <div>
              <div class="inst-name">${inst.name}</div>
              <div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px">${inst.accountName}</div>
            </div>
            <span class="inst-status">${monthsLeft > 0 ? '还款中' : '已结清'}</span>
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
              <span class="inst-meta-label">剩余金额</span>
              <span class="inst-meta-value" style="color:var(--warning)">${fmt(inst.remainingAmount)}</span>
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

        const monthsLeft = Math.max(0, endDate.diff(today, 'month'));
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
            const monthsLeft = Math.max(0, endDate.diff(today, 'month'));

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
          const minPay = acc.minPayment || acc.totalDebt;
          let balance = acc.totalDebt;
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
            totalDebt: acc.totalDebt,
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
  const select = document.getElementById('whatifAccount');
  select.innerHTML = '';

  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ bankId: bank.id, accId: acc.id });
      opt.textContent = `${bank.shortName} · ${acc.name}`;
      select.appendChild(opt);
    });
  });

  document.getElementById('whatifCalc').addEventListener('click', calcWhatIf);
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
  const baseResult = simulatePayoff(acc.totalDebt, acc.monthlyPayment || acc.minPayment, monthlyRate);
  // 优化场景
  const newBalance = Math.max(0, acc.totalDebt - lump);
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
  // 设置默认日期
  document.getElementById('expDate').value = today.format('YYYY-MM-DD');
  document.getElementById('expFilterMonth').value = today.format('YYYY-MM');

  document.getElementById('addExpense').addEventListener('click', addExpense);
  document.getElementById('expFilterMonth').addEventListener('change', renderExpenseTable);
  document.getElementById('clearExpenses').addEventListener('click', clearMonthExpenses);

  // 尝试从云端加载最新消费记录
  await loadExpensesFromCloud();

  renderExpenseTable();
  renderExpenseStats();
}

async function loadExpensesFromCloud() {
  try {
    const rows = await sbFetch(EXPENSE_TABLE + '?order=date.desc&limit=500');
    if (rows && rows.length > 0) {
      const expenses = rows.map(r => ({ id: r.id, date: r.date, amount: r.amount, category: r.category, payment: r.payment, note: r.note }));
      localStorage.setItem('expenses', JSON.stringify(expenses));
    }
  } catch (e) {
    console.warn('消费记录云端加载失败:', e.message);
  }
}

function getExpenses() {
  return JSON.parse(localStorage.getItem('expenses') || '[]');
}

async function saveExpenses(expenses) {
  localStorage.setItem('expenses', JSON.stringify(expenses));
  // 同步到 Supabase（全量覆盖当月）
  try {
    // 先删除再插入，简单粗暴但可靠
    const month = today.format('YYYY-MM');
    await sbFetch(EXPENSE_TABLE + '?month=eq.' + month, {
      method: 'DELETE',
      prefer: 'return=minimal'
    });
    if (expenses.length > 0) {
      const rows = expenses.map(e => ({ ...e, month: e.date.slice(0, 7) }));
      await sbFetch(EXPENSE_TABLE, {
        method: 'POST',
        prefer: 'return=minimal',
        body: JSON.stringify(rows)
      });
    }
  } catch (e) {
    console.warn('消费记录云端同步失败:', e.message);
  }
}

// ===== 判断消费属于哪个账单周期 =====
// 返回 { billMonth: 'YYYY-MM', dueDate: dayjs对象 }
function getBillingCycle(cardId, expenseDate) {
  const cfg = CARD_BILLING[cardId];
  if (!cfg) return null;
  const d = dayjs(expenseDate);
  // 账单日当天及之前 → 属于本月账单；账单日之后 → 属于下月账单
  let billMonth;
  if (d.date() <= cfg.billDay) {
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

  document.getElementById('expAmount').value = '';
  document.getElementById('expNote').value = '';

  // 联动更新对应信用卡的未出账单显示
  renderBillingStatus();
  renderExpenseTable();
  renderExpenseStats();

  // 成功提示
  const billTip = billing
    ? `📋 已计入 ${billing.billMonth} 账单，还款日 ${billing.dueDate.format('M月D日')}`
    : '';
  showToast(`✅ 已录入 ${payment} 消费 ¥${amount}${billTip ? '\n' + billTip : ''}`);
}

async function deleteExpense(id) {
  const all = getExpenses();
  const target = all.find(e => e.id === id);
  if (!target) return;
  const label = `${target.date} ${target.category} ${fmt(target.amount)}`;
  if (!confirm(`确定删除这条记录？\n${label}`)) return;
  const expenses = all.filter(e => e.id !== id);
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
  renderExpenseTable();
  renderExpenseStats();
}

// 退款：复制原记录，金额取负，备注加「[退款]」前缀
async function refundExpense(id) {
  const all = getExpenses();
  const target = all.find(e => e.id === id);
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
  renderExpenseTable();
  renderExpenseStats();
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
  const exp = getExpenses().find(e => e.id === id);
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
  const idx = expenses.findIndex(e => e.id === editingExpenseId);
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
  renderExpenseTable();
  renderExpenseStats();
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
        <button class="edit-btn" onclick="openEditExpense(${e.id})" title="编辑">✏️</button>
        <button class="refund-btn" onclick="refundExpense(${e.id})" title="退款">↩️</button>
        <button class="del-btn" onclick="deleteExpense(${e.id})" title="删除">🗑️</button>
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
  const ctx = document.getElementById('expensePieChart').getContext('2d');
  if (expensePieChart) expensePieChart.destroy();

  if (Object.keys(byCategory).length === 0) return;

  const catColors = {
    '餐饮': '#ff6b6b', '交通': '#4dabf7', '购物': '#ffa94d',
    '娱乐': '#cc5de8', '医疗': '#51cf66', '教育': '#74c0fc',
    '居家': '#a9e34b', '其他': '#868e96'
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

  container.innerHTML = html;
  document.getElementById('quickUpdateOverlay').classList.add('open');
}

function closeQuickUpdate() {
  document.getElementById('quickUpdateOverlay').classList.remove('open');
}

document.getElementById('quickUpdateSave').addEventListener('click', async () => {
  // 读取所有输入值写回 DATA
  document.querySelectorAll('.qu-input').forEach(input => {
    const bi = parseInt(input.dataset.bank);
    const ai = parseInt(input.dataset.acc);
    const field = input.dataset.field;
    const val = parseFloat(input.value) || 0;
    DATA.banks[bi].accounts[ai][field] = val;
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
function showToast(msg) {
  let toast = document.getElementById('globalToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'globalToast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = 'toast toast-show';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.className = 'toast', 3000);
}

// ===== 本月消费概览 =====
function renderExpenseOverview() {
  const container = document.getElementById('expenseOverviewPanel');
  if (!container || !DATA) return;

  const expenses = getExpenses();
  const now = today;
  const thisMonth = now.format('YYYY-MM');

  // 按信用卡分组统计本月消费
  const cardStats = {};
  Object.entries(CARD_BILLING).forEach(([cardId, cfg]) => {
    cardStats[cardId] = { name: cfg.name, total: 0, count: 0, refund: 0 };
  });

  expenses.forEach(e => {
    if (!e.date || e.date.slice(0, 7) !== thisMonth) return;
    const cardId = e.cardId;
    if (!cardStats[cardId]) return;
    if (e.amount < 0) {
      cardStats[cardId].refund += Math.abs(e.amount);
    } else {
      cardStats[cardId].total += e.amount;
      cardStats[cardId].count++;
    }
  });

  // 总消费
  const grandTotal = Object.values(cardStats).reduce((s, c) => s + c.total, 0);
  const grandRefund = Object.values(cardStats).reduce((s, c) => s + c.refund, 0);
  const grandNet = grandTotal - grandRefund;

  let html = `
    <div class="exp-overview-header">
      <div class="exp-overview-total">
        <span class="exp-ov-label">本月总消费</span>
        <span class="exp-ov-amount">${fmt(grandNet)}</span>
      </div>
      ${grandRefund > 0 ? `<div class="exp-ov-refund">退款 ${fmt(grandRefund)}</div>` : ''}
    </div>
    <div class="exp-overview-cards">`;

  Object.entries(cardStats).forEach(([cardId, stat]) => {
    if (stat.total === 0 && stat.refund === 0) return;

    // 找信用卡额度
    let creditLimit = 0;
    DATA.banks.forEach(b => b.accounts.forEach(a => {
      if (a.id === cardId) creditLimit = a.creditLimit || 0;
    }));

    const net = stat.total - stat.refund;
    const usedPct = creditLimit > 0 ? Math.min(net / creditLimit, 1) : 0;
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

    // 当前账单周期：上个账单日 ~ 本账单日
    let cycleStart, cycleEnd;
    if (now.date() <= cfg.billDay) {
      cycleEnd = now.date(cfg.billDay);
      cycleStart = now.subtract(1, 'month').date(cfg.billDay + 1);
    } else {
      cycleStart = now.date(cfg.billDay + 1);
      cycleEnd = now.add(1, 'month').date(cfg.billDay);
    }

    // 本周期内的消费（未出账）
    const unpaidExpenses = expenses.filter(e =>
      e.cardId === cardId &&
      dayjs(e.date).isAfter(cycleStart.subtract(1, 'day')) &&
      dayjs(e.date).isBefore(cycleEnd.add(1, 'day'))
    );
    const unpaidTotal = unpaidExpenses.reduce((s, e) => s + e.amount, 0);

    // 下次还款日
    const billing = getBillingCycle(cardId, now.format('YYYY-MM-DD'));
    const dueDate = billing?.dueDate;
    const daysUntilDue = dueDate ? dueDate.diff(now, 'day') : null;
    const isUrgent = daysUntilDue !== null && daysUntilDue <= 3;
    const isOverdue = daysUntilDue !== null && daysUntilDue < 0;

    cards.push({
      cardId, cfg, accData,
      unpaidTotal, unpaidExpenses: unpaidExpenses.length,
      dueDate, daysUntilDue, isUrgent, isOverdue,
      minPayment: accData.minPayment || 0,
    });
  });

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

    html += `
      <div class="billing-card">
        <div class="billing-card-name">${c.cfg.name}</div>
        <div class="billing-card-row">
          <span class="billing-label">已出账待还</span>
          <span class="billing-value ${c.isUrgent || c.isOverdue ? 'urgent' : ''}">${fmt(c.minPayment)}</span>
        </div>
        <div class="billing-card-row">
          <span class="billing-label">本期未出账</span>
          <span class="billing-value" style="color:var(--info)">
            ${c.unpaidTotal > 0 ? fmt(c.unpaidTotal) + ` (${c.unpaidExpenses}笔)` : '暂无'}
          </span>
        </div>
        <div class="billing-card-row">
          <span class="billing-label">下次还款日</span>
          <span>${dueTxt}</span>
        </div>
      </div>`;
  });

  container.innerHTML = html || '<div style="color:var(--text-muted);padding:16px">暂无信用卡数据</div>';
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

// ===== AI 消费识别（多轮对话版）=====
const FRIDAY_API   = 'https://aigc.sankuai.com/v1/chat/completions';
const FRIDAY_TOKEN = '22041715054660149263';
const MODEL_TEXT   = 'deepseek-v4-flash';  // 主线对话（纯文字，保持上下文）
const MODEL_VL     = 'LongCat-VL-Medium';  // 图片识别（单次调用，结果合并回主线）

const AI_SYSTEM_PROMPT = `你是一个消费记录解析助手。用户会发给你消费信息（文字描述或账单截图的文字提取结果），请从中提取以下字段并以 JSON 格式返回：
{
  "date": "YYYY-MM-DD",
  "amount": 数字,
  "category": "分类",
  "payment": "支付方式",
  "note": "备注"
}
category 只能是：餐饮、交通、购物、娱乐、医疗、教育、居家、其他。
payment 只能是：招商信用卡、广州银行信用卡、浦发信用卡、农行信用卡、民生信用卡、微信/支付宝、现金。
date 无法确定则用今天（${dayjs().format('YYYY-MM-DD')}）。
用户如果说"不对""改一下""支付方式改成XX"等修正指令，请基于上一次结果修改后重新返回完整 JSON。
只返回 JSON，不要 markdown 代码块，不要解释。`;

// 主线对话历史（deepseek 保持上下文）
let aiConversation = [];  // [{role, content}]
// 界面气泡历史（用于渲染）
let aiChatBubbles  = [];  // [{role:'user'|'ai', text, imgSrc?, parsed?}]

let aiImageBase64 = null;
let aiImageMime   = null;

// ---- 图片选择 ----
document.getElementById('aiImageInput').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    const match = dataUrl.match(/^data:(.+);base64,(.+)$/);
    if (!match) return;
    aiImageMime   = match[1];
    aiImageBase64 = match[2];
    document.getElementById('aiImagePreview').src = dataUrl;
    document.getElementById('aiImagePreviewRow').style.display = 'flex';
  };
  reader.readAsDataURL(file);
  this.value = '';
});

document.getElementById('aiRemoveImg').addEventListener('click', clearAIImage);
function clearAIImage() {
  aiImageBase64 = null;
  aiImageMime   = null;
  document.getElementById('aiImagePreviewRow').style.display = 'none';
  document.getElementById('aiImagePreview').src = '';
}

// ---- 清空对话 ----
document.getElementById('aiClearBtn').addEventListener('click', () => {
  aiConversation = [];
  aiChatBubbles  = [];
  renderAIChat();
  setAIStatus('');
  clearAIImage();
  document.getElementById('aiTextInput').value = '';
});

// ---- 发送 ----
document.getElementById('aiSendBtn').addEventListener('click', handleAISend);
document.getElementById('aiTextInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAISend(); }
});

async function handleAISend() {
  const text   = document.getElementById('aiTextInput').value.trim();
  const hasImg = !!aiImageBase64;
  if (!text && !hasImg) { setAIStatus('请输入消费描述或上传图片', 'error'); return; }

  const btn = document.getElementById('aiSendBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  document.getElementById('aiSendIcon').textContent = '⏳';
  setAIStatus('AI 识别中...', 'loading');

  // 记录用户气泡
  const imgSrc = hasImg ? document.getElementById('aiImagePreview').src : null;
  aiChatBubbles.push({ role: 'user', text: text || '（图片）', imgSrc });
  renderAIChat();

  // 清空输入
  document.getElementById('aiTextInput').value = '';
  clearAIImage();

  try {
    let userMsgForMain = text; // 最终加入主线的文字内容

    // 如果有图片：先用 LongCat-VL 单独识别，把结果转成文字合并进主线
    if (hasImg) {
      setAIStatus('图片识别中（LongCat-VL）...', 'loading');
      const vlResult = await callVLModel(text, { base64: aiImageBase64, mime: aiImageMime });
      // 把图片识别结果作为用户消息的补充文字，注入主线
      userMsgForMain = `[图片识别结果] ${vlResult}\n${text ? '用户补充：' + text : ''}`.trim();
    }

    // 加入主线对话历史
    aiConversation.push({ role: 'user', content: userMsgForMain });

    // 用 deepseek 主线推理，带完整上下文
    setAIStatus('AI 解析中（DeepSeek）...', 'loading');
    const raw = await callMainModel(aiConversation);

    // 把 AI 回复加入主线历史
    aiConversation.push({ role: 'assistant', content: raw });

    // 解析 JSON
    const parsed = parseAIResult(raw);

    // 渲染 AI 气泡
    aiChatBubbles.push({ role: 'ai', text: raw, parsed });
    renderAIChat();

    // 自动填表
    fillExpenseForm(parsed);
    setAIStatus('✅ 已填写表单，确认后点"添加记录"；如有误可继续说明修正', 'success');

  } catch (err) {
    console.error('[AI]', err);
    aiChatBubbles.push({ role: 'ai', text: `❌ ${err.message}`, parsed: null });
    renderAIChat();
    setAIStatus(`❌ 识别失败：${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
    document.getElementById('aiSendIcon').textContent = '➤';
  }
}

// 调用 LongCat-VL 识别图片，返回文字描述（不保留上下文）
async function callVLModel(text, image) {
  const userContent = [
    { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } },
    { type: 'text', text: text
        ? `请识别图中的消费信息，并结合用户说明"${text}"，用文字描述消费的日期、金额、商家/分类、支付方式。`
        : '请识别图中的消费信息，用文字描述消费的日期、金额、商家/分类、支付方式。' },
  ];
  const data = await fridayRequest(MODEL_VL, [
    { role: 'user', content: userContent }
  ], 400);
  return data.choices?.[0]?.message?.content || '';
}

// 调用 deepseek 主线，带完整对话历史
async function callMainModel(conversation) {
  const messages = [
    { role: 'system', content: AI_SYSTEM_PROMPT },
    ...conversation,
  ];
  const data = await fridayRequest(MODEL_TEXT, messages, 300);
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error('AI 返回内容为空');
  return raw;
}

// 底层 fetch 封装
async function fridayRequest(model, messages, maxTokens = 300) {
  const resp = await fetch(FRIDAY_API, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${FRIDAY_TOKEN}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.1 }),
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
  return {
    date:     obj.date     || todayStr,
    amount:   parseFloat(obj.amount) || 0,
    category: obj.category || '其他',
    payment:  obj.payment  || '微信/支付宝',
    note:     obj.note     || '',
  };
}

// ---- 渲染对话气泡 ----
function renderAIChat() {
  const el = document.getElementById('aiChatHistory');
  if (aiChatBubbles.length === 0) { el.innerHTML = ''; return; }

  el.innerHTML = aiChatBubbles.map(b => {
    if (b.role === 'user') {
      const imgHtml = b.imgSrc
        ? `<img src="${b.imgSrc}" class="ai-bubble-img" alt="图片" />`  : '';
      const txt = b.text && b.text !== '（图片）'
        ? `<span>${escHtml(b.text)}</span>` : '';
      return `<div class="ai-bubble ai-bubble-user">${imgHtml}${txt}</div>`;
    } else {
      // AI 回复：如果能解析出 JSON 就显示结构化卡片，否则显示原文
      if (b.parsed) {
        return `<div class="ai-bubble ai-bubble-ai">
          <div class="ai-parsed-card">
            <div class="ai-parsed-row"><span>📅 日期</span><strong>${b.parsed.date}</strong></div>
            <div class="ai-parsed-row"><span>💰 金额</span><strong style="color:var(--warning)">¥${b.parsed.amount}</strong></div>
            <div class="ai-parsed-row"><span>🏷️ 分类</span><strong>${b.parsed.category}</strong></div>
            <div class="ai-parsed-row"><span>💳 支付</span><strong>${b.parsed.payment}</strong></div>
            ${b.parsed.note ? `<div class="ai-parsed-row"><span>📝 备注</span><strong>${escHtml(b.parsed.note)}</strong></div>` : ''}
          </div>
          <div class="ai-bubble-hint">↑ 已填入表单，如有误请继续说明</div>
        </div>`;
      } else {
        return `<div class="ai-bubble ai-bubble-ai"><span>${escHtml(b.text)}</span></div>`;
      }
    }
  }).join('');

  // 滚动到底部
  el.scrollTop = el.scrollHeight;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fillExpenseForm(data) {
  document.getElementById('expDate').value   = data.date;
  document.getElementById('expAmount').value = data.amount;
  document.getElementById('expNote').value   = data.note;
  setSelectValue('expCategory', data.category);
  setSelectValue('expPayment',  data.payment);
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

// ===== 启动 =====
loadData();
