/* ============================================================
   新增功能模块 - features.js
   依赖：app.js 中的全局变量 DATA, today, fmt, fmtDecimal, fmtPct, dayjs
   不修改任何现有函数，仅新增功能
   ============================================================ */

// ===== 功能1: 还款计划面板（本月还款日历列表）=====
function renderRepaymentPlan() {
  const container = document.getElementById('repaymentPlanList');
  if (!container || !DATA) return;

  const now = today;
  const items = [];

  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      if (acc.type === 'savings') return;
      const dueDay = acc.dueDay;
      if (!dueDay) return;

      let amount = 0;
      let status = 'pending'; // pending | paid | overdue

      if (acc.type === 'loan') {
        amount = acc.monthlyPayment || 0;
      } else if (acc.type === 'credit') {
        const billAmount = (acc.currentBillAmount != null ? acc.currentBillAmount : acc.minPayment) || 0;
        const paidAmount = acc.paidAmount || 0;
        amount = Math.max(0, billAmount - paidAmount);
        if (amount === 0 && billAmount > 0) status = 'paid';
      }

      if (amount <= 0 && status !== 'paid') return;

      // 计算本月还款日
      let dueDate = now.date(dueDay);
      // 如果还款日在下月（如广州银行：账单日13号，还款日下月2号）
      if (acc.dueDayNextMonth) {
        dueDate = dueDate.add(1, 'month');
      }

      const daysLeft = dueDate.diff(now, 'day');
      if (daysLeft < 0 && status === 'pending') status = 'overdue';
      if (daysLeft < 0 && amount === 0) return; // 已过期且已还清，不显示

      items.push({
        bankName: bank.shortName,
        bankIcon: bank.icon,
        bankColor: bank.color,
        accountName: acc.name,
        amount,
        dueDay,
        dueDate,
        daysLeft,
        status
      });
    });
  });

  // 按还款日排序
  items.sort((a, b) => a.dueDate.valueOf() - b.dueDate.valueOf());

  if (items.length === 0) {
    container.innerHTML = '<div class="empty-tip">本月无待还款项 🎉</div>';
    return;
  }

  let html = '';
  items.forEach(item => {
    const statusClass = item.status === 'paid' ? 'plan-paid' : item.status === 'overdue' ? 'plan-overdue' : (item.daysLeft <= 3 ? 'plan-urgent' : '');
    const statusText = item.status === 'paid' ? '✅ 已还清' : item.status === 'overdue' ? '⚠️ 已逾期' : `${item.daysLeft}天后`;
    const amountText = item.status === 'paid' ? '<s>' + fmt(item.amount) + '</s>' : fmt(item.amount);

    html += `
      <div class="repayment-plan-item ${statusClass}">
        <div class="plan-left">
          <span class="plan-icon" style="color:${item.bankColor}">${item.bankIcon}</span>
          <div class="plan-info">
            <div class="plan-bank">${item.bankName}</div>
            <div class="plan-account">${item.accountName}</div>
          </div>
        </div>
        <div class="plan-right">
          <div class="plan-amount">${amountText}</div>
          <div class="plan-due">${item.dueDate.format('MM/DD')} · ${statusText}</div>
        </div>
      </div>`;
  });

  container.innerHTML = html;
}

// ===== 功能2: 标记已还按钮（在还款计划中）=====
function renderMarkPaidButtons() {
  const container = document.getElementById('repaymentPlanList');
  if (!container || !DATA) return;

  // 在每个未还清的 plan-item 上添加点击事件
  container.querySelectorAll('.repayment-plan-item:not(.plan-paid)').forEach(item => {
    item.style.cursor = 'pointer';
    item.title = '点击标记为已还';
  });
}

async function markAccountPaid(accId) {
  if (!DATA) return;
  let found = false;
  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      if (acc.id === accId && acc.type === 'credit') {
        const billAmount = (acc.currentBillAmount != null ? acc.currentBillAmount : acc.minPayment) || 0;
        acc.paidAmount = billAmount;
        found = true;
      }
    });
  });
  if (found) {
    DATA.meta.lastUpdated = today.format('YYYY-MM-DD');
    await saveData();
    // 刷新相关面板
    renderSummaryBanner();
    renderRepaymentPlan();
    renderRepaymentProgress();
    renderBankCards();
    showToast('已标记还清 ✅');
  }
}

// ===== 功能3: 大额到期预警卡片 =====
function renderLargeDueWarning() {
  const container = document.getElementById('largeDueWarning');
  if (!container || !DATA) return;

  // 查找所有有 endDate 且金额较大的贷款
  const warnings = [];
  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      if (acc.type === 'loan' && acc.endDate) {
        const endDate = dayjs(acc.endDate);
        const daysLeft = endDate.diff(today, 'day');
        if (daysLeft > 0 && daysLeft <= 120 && (acc.totalDebt || 0) >= 10000) {
          warnings.push({
            bankName: bank.shortName,
            bankIcon: bank.icon,
            accountName: acc.name,
            amount: acc.totalDebt,
            endDate,
            daysLeft,
            note: acc.note || ''
          });
        }
      }
    });
  });

  if (warnings.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  let html = '';
  warnings.forEach(w => {
    const urgency = w.daysLeft <= 30 ? 'critical' : w.daysLeft <= 60 ? 'warning' : 'info';
    const dailySave = Math.ceil(w.amount / w.daysLeft);
    html += `
      <div class="large-due-card ${urgency}">
        <div class="large-due-header">
          <span class="large-due-icon">🚨</span>
          <span class="large-due-title">${w.bankName} · ${w.accountName}</span>
        </div>
        <div class="large-due-body">
          <div class="large-due-amount">${fmt(w.amount)}</div>
          <div class="large-due-meta">
            <span>到期日 ${w.endDate.format('YYYY-MM-DD')}</span>
            <span class="large-due-countdown">倒计时 <strong>${w.daysLeft}</strong> 天</span>
          </div>
          <div class="large-due-tip">💡 每天需攒 ${fmt(dailySave)} 才能按时还清</div>
        </div>
      </div>`;
  });

  container.innerHTML = html;
}

// ===== 功能4: 月度还款进度条 =====
function renderRepaymentProgress() {
  const container = document.getElementById('repaymentProgress');
  if (!container || !DATA) return;

  // 计算本月总应还和已还
  let totalDue = 0;
  let totalPaid = 0;

  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      if (acc.type === 'loan') {
        totalDue += acc.monthlyPayment || 0;
        // 贷款没有 paidAmount 概念，假设未到还款日就是未还
        const dueDay = acc.dueDay;
        if (dueDay && today.date() > dueDay) {
          totalPaid += acc.monthlyPayment || 0; // 已过还款日，视为已还
        }
      } else if (acc.type === 'credit') {
        const billAmount = (acc.currentBillAmount != null ? acc.currentBillAmount : acc.minPayment) || 0;
        const paidAmount = acc.paidAmount || 0;
        totalDue += billAmount;
        totalPaid += Math.min(paidAmount, billAmount);
      }
    });
  });

  if (totalDue === 0) {
    container.innerHTML = '<div class="empty-tip">本月无还款任务</div>';
    return;
  }

  const pct = Math.min(totalPaid / totalDue, 1);
  const remaining = Math.max(0, totalDue - totalPaid);
  const pctText = (pct * 100).toFixed(0);

  container.innerHTML = `
    <div class="progress-info">
      <span>已还 ${fmt(totalPaid)}</span>
      <span>剩余 ${fmt(remaining)}</span>
    </div>
    <div class="progress-bar-wrap">
      <div class="progress-bar-fill" style="width:${pctText}%"></div>
    </div>
    <div class="progress-pct">${pctText}% 完成</div>`;
}

// ===== 功能5: 历史趋势图（月度负债快照）=====
let debtTrendChart = null;

function getDebtSnapshots() {
  // 从 localStorage 读取历史快照
  try {
    const raw = localStorage.getItem('debt_snapshots');
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveDebtSnapshot() {
  if (!DATA) return;
  const snapshots = getDebtSnapshots();
  const monthKey = today.format('YYYY-MM');

  // 计算当前总负债
  let totalDebt = 0;
  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      if (acc.type === 'loan') totalDebt += acc.totalDebt || 0;
      else if (acc.type === 'credit') totalDebt += getNetDebt(acc);
    });
  });

  // 更新或新增当月快照
  const existing = snapshots.findIndex(s => s.month === monthKey);
  const entry = { month: monthKey, totalDebt, date: today.format('YYYY-MM-DD') };
  if (existing >= 0) {
    snapshots[existing] = entry;
  } else {
    snapshots.push(entry);
  }

  // 只保留最近24个月
  snapshots.sort((a, b) => a.month.localeCompare(b.month));
  while (snapshots.length > 24) snapshots.shift();

  localStorage.setItem('debt_snapshots', JSON.stringify(snapshots));
}

function renderDebtTrend() {
  const canvas = document.getElementById('debtTrendChart');
  if (!canvas || typeof Chart === 'undefined') return;

  const snapshots = getDebtSnapshots();
  if (snapshots.length < 2) {
    canvas.parentElement.innerHTML = '<div class="empty-tip">数据不足，至少需要2个月的记录才能显示趋势</div>';
    return;
  }

  const labels = snapshots.map(s => {
    const d = dayjs(s.month + '-01');
    return d.format('M月');
  });
  const values = snapshots.map(s => s.totalDebt);

  const ctx = canvas.getContext('2d');
  if (debtTrendChart) debtTrendChart.destroy();

  debtTrendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '总负债',
        data: values,
        borderColor: '#6c63ff',
        backgroundColor: 'rgba(108,99,255,0.1)',
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointRadius: 4,
        pointBackgroundColor: '#6c63ff'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `总负债: ${fmt(ctx.raw)}`
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#8892b0', font: { size: 11 } },
          grid: { color: 'rgba(46,50,80,0.5)' }
        },
        y: {
          ticks: {
            color: '#8892b0',
            callback: (v) => v >= 10000 ? '¥' + (v / 10000).toFixed(1) + 'w' : fmt(v)
          },
          grid: { color: 'rgba(46,50,80,0.5)' }
        }
      }
    }
  });
}

// ===== 功能6: 日常消费预算 =====
function getBudgetConfig() {
  try {
    const raw = localStorage.getItem('budget_config');
    return raw ? JSON.parse(raw) : { monthlyLimit: 3000 };
  } catch (e) {
    return { monthlyLimit: 3000 };
  }
}

function saveBudgetConfig(config) {
  localStorage.setItem('budget_config', JSON.stringify(config));
}

function renderBudgetPanel() {
  const container = document.getElementById('budgetPanel');
  if (!container || !DATA) return;

  const config = getBudgetConfig();
  const limit = config.monthlyLimit;

  // 计算本月日常消费（排除套现和转账还款）
  const monthStart = today.startOf('month');
  const monthEnd = today.endOf('month');
  let spent = 0;

  (DATA.expenses || []).forEach(exp => {
    const d = dayjs(exp.date);
    if (d.isBefore(monthStart) || d.isAfter(monthEnd)) return;
    if (isCashOut(exp)) return;
    if ((exp.category || '').includes('还款')) return;
    if (exp.amount > 0) spent += exp.amount;
  });

  const remaining = Math.max(0, limit - spent);
  const pct = Math.min(spent / limit, 1);
  const pctText = (pct * 100).toFixed(0);
  const daysLeft = monthEnd.diff(today, 'day') + 1;
  const dailyBudget = daysLeft > 0 ? Math.floor(remaining / daysLeft) : 0;

  const barColor = pct >= 1 ? '#ff4d6d' : pct >= 0.8 ? '#ffa94d' : '#00d4aa';

  container.innerHTML = `
    <div class="budget-header">
      <span class="budget-title">本月消费预算</span>
      <button class="budget-edit-btn" onclick="editBudget()">⚙️</button>
    </div>
    <div class="budget-body">
      <div class="budget-numbers">
        <div class="budget-spent">
          <span class="budget-label">已花</span>
          <span class="budget-value" style="color:${barColor}">${fmt(spent)}</span>
        </div>
        <div class="budget-remaining">
          <span class="budget-label">剩余</span>
          <span class="budget-value">${fmt(remaining)}</span>
        </div>
        <div class="budget-daily">
          <span class="budget-label">日均可花</span>
          <span class="budget-value">${fmt(dailyBudget)}</span>
        </div>
      </div>
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill" style="width:${pctText}%;background:${barColor}"></div>
      </div>
      <div class="budget-footer">${pctText}% · 预算 ${fmt(limit)}/月 · 剩余${daysLeft}天</div>
    </div>`;
}

function editBudget() {
  const config = getBudgetConfig();
  const input = prompt('设置每月消费预算（元）：', config.monthlyLimit);
  if (input === null) return;
  const val = parseFloat(input);
  if (isNaN(val) || val <= 0) {
    showToast('请输入有效金额');
    return;
  }
  config.monthlyLimit = val;
  saveBudgetConfig(config);
  renderBudgetPanel();
  showToast('预算已更新为 ' + fmt(val));
}

// ===== 功能7: 提前还款收益计算器（增强版 What-if）=====
function renderPrepayCalculator() {
  const container = document.getElementById('prepayCalcPanel');
  if (!container || !DATA) return;

  // 收集所有有分期的账户
  let options = '';
  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      if (acc.type === 'loan' && (acc.totalDebt || 0) > 0) {
        options += `<option value="${acc.id}">${bank.shortName} · ${acc.name} (${fmt(acc.totalDebt)})</option>`;
      }
      if (acc.type === 'credit' && acc.installments) {
        acc.installments.forEach(inst => {
          if ((inst.remainingAmount || 0) > 0) {
            options += `<option value="${inst.id}">${bank.shortName} · ${inst.name} (${fmt(inst.remainingAmount)})</option>`;
          }
        });
      }
    });
  });

  container.innerHTML = `
    <div class="prepay-form">
      <div class="form-group">
        <label>选择要提前还的账户/分期</label>
        <select id="prepayTarget">${options}</select>
      </div>
      <div class="form-group">
        <label>提前还款金额（元）</label>
        <input type="number" id="prepayAmount" value="5000" min="0" step="1000" />
      </div>
      <button class="btn-primary" onclick="calcPrepayBenefit()">📊 计算收益</button>
    </div>
    <div class="prepay-result" id="prepayResult">
      <div class="result-placeholder">设置参数后点击计算，查看提前还款能省多少利息</div>
    </div>`;
}

function calcPrepayBenefit() {
  const targetId = document.getElementById('prepayTarget')?.value;
  const amount = parseFloat(document.getElementById('prepayAmount')?.value) || 0;
  const resultEl = document.getElementById('prepayResult');
  if (!targetId || !amount || !resultEl) return;

  // 查找目标
  let target = null;
  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      if (acc.id === targetId) {
        target = { type: 'loan', data: acc };
      }
      if (acc.installments) {
        acc.installments.forEach(inst => {
          if (inst.id === targetId) {
            target = { type: 'installment', data: inst, account: acc };
          }
        });
      }
    });
  });

  if (!target) {
    resultEl.innerHTML = '<div class="result-placeholder">未找到目标账户</div>';
    return;
  }

  let savedInterest = 0;
  let savedMonths = 0;
  let originalTotal = 0;
  let newTotal = 0;

  if (target.type === 'loan') {
    const loan = target.data;
    const monthly = loan.monthlyPayment;
    const remaining = loan.remainingMonths;
    originalTotal = monthly * remaining;
    const originalInterest = originalTotal - loan.totalDebt;

    // 提前还款后：本金减少，月供不变，期数减少
    const newPrincipal = Math.max(0, loan.totalDebt - amount);
    const newMonths = Math.ceil(newPrincipal / (monthly - (loan.interestRate / 12 * newPrincipal)));
    const newInterest = Math.max(0, originalInterest * (newPrincipal / loan.totalDebt));

    savedInterest = originalInterest - newInterest;
    savedMonths = remaining - Math.min(newMonths, remaining);
    newTotal = originalTotal - savedInterest - amount;
  } else {
    const inst = target.data;
    const monthly = inst.monthlyPayment;
    const remaining = inst.remainingMonths;
    const interestPerMonth = inst.interestPerMonth || 0;
    originalTotal = monthly * remaining;
    const originalInterest = interestPerMonth * remaining;

    // 提前还本金，减少期数
    const principalPerMonth = inst.principalPerMonth || (monthly - interestPerMonth);
    const newRemainingPrincipal = Math.max(0, (inst.remainingPrincipal || inst.remainingAmount || 0) - amount);
    const newMonths = principalPerMonth > 0 ? Math.ceil(newRemainingPrincipal / principalPerMonth) : remaining;

    savedMonths = remaining - newMonths;
    savedInterest = interestPerMonth * savedMonths;
    newTotal = originalTotal - savedInterest - amount;
  }

  savedInterest = Math.max(0, savedInterest);
  savedMonths = Math.max(0, savedMonths);

  resultEl.innerHTML = `
    <div class="prepay-result-card">
      <div class="prepay-result-row">
        <span>💰 可节省利息</span>
        <strong style="color:#00d4aa">${fmt(savedInterest)}</strong>
      </div>
      <div class="prepay-result-row">
        <span>📅 提前结清</span>
        <strong style="color:#6c63ff">${savedMonths} 个月</strong>
      </div>
      <div class="prepay-result-row">
        <span>📊 原总还款</span>
        <span>${fmt(originalTotal)}</span>
      </div>
      <div class="prepay-result-row">
        <span>📊 提前还后总还款</span>
        <span>${fmt(Math.max(0, newTotal))}</span>
      </div>
    </div>`;
}

// ===== 功能8: 收入-支出-还款平衡视图 =====
function renderBalanceView() {
  const container = document.getElementById('balanceViewPanel');
  if (!container || !DATA) return;

  const income = DATA.meta.monthlyIncome || DATA.meta.baseIncome || 8000;

  // 本月分期月供总额
  let monthlyInstallments = 0;
  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      if (acc.type === 'loan') {
        monthlyInstallments += acc.monthlyPayment || 0;
      } else if (acc.type === 'credit') {
        (acc.installments || []).forEach(inst => {
          monthlyInstallments += inst.monthlyPayment || 0;
        });
      }
    });
  });

  // 本月日常消费
  const monthStart = today.startOf('month');
  const monthEnd = today.endOf('month');
  let dailySpent = 0;
  (DATA.expenses || []).forEach(exp => {
    const d = dayjs(exp.date);
    if (d.isBefore(monthStart) || d.isAfter(monthEnd)) return;
    if (isCashOut(exp)) return;
    if ((exp.category || '').includes('还款')) return;
    if (exp.amount > 0) dailySpent += exp.amount;
  });

  const surplus = income - monthlyInstallments - dailySpent;
  const surplusClass = surplus >= 0 ? 'positive' : 'negative';

  // 9月大额到期需要攒的钱
  let largeDueAmount = 0;
  let largeDueDays = 0;
  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      if (acc.type === 'loan' && acc.endDate) {
        const endDate = dayjs(acc.endDate);
        const daysLeft = endDate.diff(today, 'day');
        if (daysLeft > 0 && daysLeft <= 120 && (acc.totalDebt || 0) >= 10000) {
          largeDueAmount += acc.totalDebt;
          largeDueDays = Math.max(largeDueDays, daysLeft);
        }
      }
    });
  });

  const monthsToSave = largeDueDays > 0 ? Math.ceil(largeDueDays / 30) : 0;
  const monthlySaveNeeded = monthsToSave > 0 ? Math.ceil(largeDueAmount / monthsToSave) : 0;

  container.innerHTML = `
    <div class="balance-grid">
      <div class="balance-item income">
        <div class="balance-item-label">月收入</div>
        <div class="balance-item-value">${fmt(income)}</div>
      </div>
      <div class="balance-item expense">
        <div class="balance-item-label">分期月供</div>
        <div class="balance-item-value">-${fmt(monthlyInstallments)}</div>
      </div>
      <div class="balance-item expense">
        <div class="balance-item-label">日常消费</div>
        <div class="balance-item-value">-${fmt(dailySpent)}</div>
      </div>
      <div class="balance-item ${surplusClass}">
        <div class="balance-item-label">本月结余</div>
        <div class="balance-item-value">${surplus >= 0 ? '+' : ''}${fmt(surplus)}</div>
      </div>
    </div>
    ${monthlySaveNeeded > 0 ? `
    <div class="balance-warning">
      <span>⚠️ 大额到期需每月攒 <strong>${fmt(monthlySaveNeeded)}</strong>（${monthsToSave}个月内需备齐 ${fmt(largeDueAmount)}）</span>
      <span class="balance-feasible ${surplus >= monthlySaveNeeded ? 'ok' : 'danger'}">
        ${surplus >= monthlySaveNeeded ? '✅ 当前结余可覆盖' : '❌ 结余不足，需压缩支出'}
      </span>
    </div>` : ''}`;
}

// ===== 初始化所有新功能 =====
function initNewFeatures() {
  // 保存当月负债快照
  saveDebtSnapshot();

  // 渲染所有新面板
  safeRender('RepaymentPlan', renderRepaymentPlan);
  safeRender('LargeDueWarning', renderLargeDueWarning);
  safeRender('RepaymentProgress', renderRepaymentProgress);
  safeRender('DebtTrend', renderDebtTrend);
  safeRender('BudgetPanel', renderBudgetPanel);
  safeRender('PrepayCalc', renderPrepayCalculator);
  safeRender('BalanceView', renderBalanceView);
}

// 在 app.js 的 init() 完成后调用
// 使用 MutationObserver 或 setTimeout 确保 DATA 已加载
(function waitForDataAndInit() {
  const check = setInterval(() => {
    if (DATA && document.getElementById('repaymentPlanList')) {
      clearInterval(check);
      initNewFeatures();
    }
  }, 200);
  // 最多等10秒
  setTimeout(() => clearInterval(check), 10000);
})();
