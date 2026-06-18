/* ============================================================
   个人负债管理中心 - app.js
   ============================================================ */

// ===== Supabase 配置 =====
const SUPABASE_URL = 'https://ejqhzdckdamssligyjcq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_-8AFKDoWn61Z9uwRJQJ3AA_Cfxhkpc5';
const DATA_ROW_ID = 1; // 固定用第1行存储负债数据
const EXPENSE_TABLE = 'expenses';
const DEBT_TABLE = 'debt_data';

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
      let endDate, totalAmount, paidAmount, monthlyPayment;

      if (acc.type === 'loan') {
        endDate = dayjs(acc.endDate);
        totalAmount = acc.totalDebt + (acc.monthlyPayment * acc.remainingMonths - acc.totalDebt);
        paidAmount = totalAmount - acc.totalDebt;
        monthlyPayment = acc.monthlyPayment;
      } else if (acc.type === 'credit') {
        // 信用卡：按最低还款估算
        const rate = acc.interestRate * 30;
        const minPay = acc.minPayment;
        let balance = acc.totalDebt;
        let months = 0;
        while (balance > 0 && months < 360) {
          balance = balance * (1 + rate) - minPay;
          months++;
        }
        endDate = today.add(months, 'month');
        totalAmount = acc.totalDebt;
        paidAmount = 0;
        monthlyPayment = minPay;
      }

      const monthsLeft = Math.max(0, endDate.diff(today, 'month'));
      const pct = totalAmount > 0 ? Math.min(paidAmount / totalAmount, 1) : 0;

      items.push({
        endDate,
        monthsLeft,
        bankName: bank.name,
        bankIcon: bank.icon,
        bankColor: bank.color,
        accountName: acc.name,
        totalDebt: acc.totalDebt,
        monthlyPayment,
        pct
      });
    });
  });

  // 按结清日期排序
  items.sort((a, b) => a.endDate.valueOf() - b.endDate.valueOf());

  let html = '<div class="timeline">';
  items.forEach(item => {
    const isDone = item.monthsLeft === 0;
    const isSoon = item.monthsLeft <= 3 && !isDone;
    const dotClass = isDone ? 'done' : isSoon ? 'soon' : '';

    html += `
      <div class="timeline-item">
        <div class="timeline-dot ${dotClass}"></div>
        <div class="timeline-card">
          <div class="timeline-date">${item.endDate.format('YYYY年M月')} 结清 · 还剩 ${item.monthsLeft} 个月</div>
          <div class="timeline-title">${item.bankIcon} ${item.bankName} · ${item.accountName}</div>
          <div class="timeline-bar">
            <div class="timeline-bar-fill" style="width:${item.pct * 100}%"></div>
          </div>
          <div class="timeline-meta">
            <span>当前负债 ${fmt(item.totalDebt)}</span>
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

  const expenses = getExpenses();
  expenses.push({ id: Date.now(), date, amount, category, payment, note });
  expenses.sort((a, b) => b.date.localeCompare(a.date));
  saveExpenses(expenses);

  document.getElementById('expAmount').value = '';
  document.getElementById('expNote').value = '';

  renderExpenseTable();
  renderExpenseStats();
}

function deleteExpense(id) {
  const expenses = getExpenses().filter(e => e.id !== id);
  saveExpenses(expenses);
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

  tbody.innerHTML = expenses.map(e => `
    <tr>
      <td>${e.date}</td>
      <td>${e.category}</td>
      <td style="color:var(--warning);font-weight:600">${fmt(e.amount)}</td>
      <td>${e.payment}</td>
      <td style="color:var(--text-muted)">${e.note || '-'}</td>
      <td><button class="del-btn" onclick="deleteExpense(${e.id})">🗑️</button></td>
    </tr>`).join('');
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

// ===== 启动 =====
loadData();
