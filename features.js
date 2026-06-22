/* ============================================================
   新增功能模块 - features.js
   依赖：app.js 中的全局变量 DATA, today, fmt, fmtDecimal, fmtPct, dayjs,
         safeRender, saveData, showToast, renderSummaryBanner, renderBankCards,
         getNetDebt, isCashOut, sbFetch, loadData
   初始化方式：hook app.js 的 init() 函数，在原有渲染完成后追加新功能渲染
   ============================================================ */

// ===== 深色模式（立即执行，不等 DATA）=====
(function initDarkMode() {
  const saved = localStorage.getItem('debt_dark_mode');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (saved === 'true' || (!saved && prefersDark)) {
    document.documentElement.classList.add('dark-mode');
  }
})();

function toggleDarkMode() {
  const isDark = document.documentElement.classList.toggle('dark-mode');
  localStorage.setItem('debt_dark_mode', isDark);
  showToast(isDark ? '🌙 已切换深色模式' : '☀️ 已切换浅色模式');
}

// ===== Hook init() 函数 =====
const _originalInit = init;
init = function() {
  // 先执行原始 init
  _originalInit();

  // 月初自动重置（必须在渲染前执行）
  autoResetMonthlyStatus();
  // 分期自动递减
  autoDecrementInstallments();
  // 账单日滚动提示
  checkBillRollover();
  // 保存当月负债快照
  saveDebtSnapshot();

  // 渲染新增面板
  safeRender('RepaymentProgress', renderRepaymentProgress);
  safeRender('RepaymentPlan', renderRepaymentPlan);
  safeRender('LargeDueWarning', renderLargeDueWarning);
  safeRender('BudgetPanel', renderBudgetPanel);
  safeRender('BalanceView', renderBalanceView);
  safeRender('PrepayCalc', renderPrepayCalculator);
  safeRender('DebtTrend', renderDebtTrend);
  safeRender('RepaymentLog', renderRepaymentLog);
  safeRender('RepayPriority', renderRepayPriority);
  safeRender('YearlyCalendar', renderYearlyCalendar);
  safeRender('IncomePanel', renderIncomePanel);

  // 应用模块配置（排序/隐藏）
  applyModuleConfig();

  // 启动同步冲突检测
  startSyncConflictCheck();
};

// ===== 功能1: 月初自动重置还款状态 =====
function autoResetMonthlyStatus() {
  if (!DATA) return;
  const lastReset = localStorage.getItem('debt_last_reset_month');
  const currentMonth = today.format('YYYY-MM');

  if (lastReset === currentMonth) return; // 本月已重置过

  let changed = false;
  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      if (acc.type === 'loan' && acc.paidThisMonth) {
        acc.paidThisMonth = false;
        changed = true;
      }
      if (acc.type === 'credit' && (acc.paidAmount || 0) > 0) {
        acc.paidAmount = 0;
        changed = true;
      }
    });
  });

  localStorage.setItem('debt_last_reset_month', currentMonth);

  if (changed) {
    DATA.meta.lastUpdated = today.format('YYYY-MM-DD');
    saveData();
    console.log('[AutoReset] 月初自动重置还款状态完成');
  }
}

// ===== 功能2: 分期自动递减 =====
function autoDecrementInstallments() {
  if (!DATA) return;
  const currentMonth = today.format('YYYY-MM');
  const lastDecrement = localStorage.getItem('debt_last_decrement_month');
  if (lastDecrement === currentMonth) return;

  let changed = false;

  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      // 贷款递减
      if (acc.type === 'loan' && (acc.remainingMonths || 0) > 0) {
        const lastMonth = lastDecrement ? dayjs(lastDecrement + '-01') : today.subtract(1, 'month');
        const monthsDiff = today.startOf('month').diff(lastMonth.startOf('month'), 'month');
        if (monthsDiff > 0) {
          const decrement = Math.min(monthsDiff, acc.remainingMonths);
          acc.remainingMonths = Math.max(0, acc.remainingMonths - decrement);
          // 简单等额本息近似：按比例减少本金
          if (acc.totalDebt > 0 && acc.monthlyPayment > 0) {
            const monthRate = (acc.interestRate || 0) / 12;
            for (let m = 0; m < decrement; m++) {
              const interest = acc.totalDebt * monthRate;
              const principal = Math.max(0, acc.monthlyPayment - interest);
              acc.totalDebt = Math.max(0, acc.totalDebt - principal);
            }
          }
          changed = true;
        }
      }

      // 信用卡分期递减
      if (acc.type === 'credit' && acc.installments) {
        acc.installments.forEach(inst => {
          if ((inst.remainingMonths || 0) > 0) {
            const lastMonth = lastDecrement ? dayjs(lastDecrement + '-01') : today.subtract(1, 'month');
            const monthsDiff = today.startOf('month').diff(lastMonth.startOf('month'), 'month');
            if (monthsDiff > 0) {
              const decrement = Math.min(monthsDiff, inst.remainingMonths);
              inst.remainingMonths = Math.max(0, inst.remainingMonths - decrement);
              // 更新剩余金额
              if (inst.monthlyPayment) {
                const principalPerMonth = inst.principalPerMonth || (inst.monthlyPayment - (inst.interestPerMonth || 0));
                inst.remainingAmount = Math.max(0, (inst.remainingAmount || 0) - principalPerMonth * decrement);
                if (inst.remainingPrincipal != null) {
                  inst.remainingPrincipal = Math.max(0, inst.remainingPrincipal - principalPerMonth * decrement);
                }
                if (inst.remainingInterest != null && inst.interestPerMonth) {
                  inst.remainingInterest = Math.max(0, inst.remainingInterest - inst.interestPerMonth * decrement);
                }
              }
              changed = true;
            }
          }
        });
      }
    });
  });

  localStorage.setItem('debt_last_decrement_month', currentMonth);

  if (changed) {
    DATA.meta.lastUpdated = today.format('YYYY-MM-DD');
    saveData();
    console.log('[AutoDecrement] 分期自动递减完成');
  }
}

// ===== 功能3: 账单日自动滚动提示 =====
function checkBillRollover() {
  if (!DATA) return;
  const warnings = [];
  const now = today;

  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      if (acc.type !== 'credit') return;
      const billDay = acc.billDay;
      if (!billDay) return;

      // 如果今天已过账单日，且数据最后更新在账单日之前
      const lastUpdated = dayjs(DATA.meta.lastUpdated || '2020-01-01');
      const thisBillDate = now.date() >= billDay ? now.date(billDay) : now.subtract(1, 'month').date(billDay);

      if (now.date() >= billDay && lastUpdated.isBefore(thisBillDate, 'day')) {
        warnings.push(`${bank.shortName}·${acc.name} 已过账单日(${billDay}号)，当前账单数据可能需要更新`);
      }
    });
  });

  if (warnings.length > 0) {
    const todayKey = 'bill_rollover_warned_' + now.format('YYYY-MM-DD');
    if (!localStorage.getItem(todayKey)) {
      localStorage.setItem(todayKey, '1');
      showToast('📋 ' + warnings[0], 6000);
    }
  }
}

// ===== 功能4: 还款计划面板 =====
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
        if (acc.paidThisMonth) status = 'paid';
      } else if (acc.type === 'credit') {
        const billAmount = (acc.currentBillAmount != null ? acc.currentBillAmount : acc.minPayment) || 0;
        const paidAmount = acc.paidAmount || 0;
        amount = Math.max(0, billAmount - paidAmount);
        if (amount === 0 && billAmount > 0) status = 'paid';
        if (billAmount === 0) return; // 无账单不显示
      }

      if (amount <= 0 && status !== 'paid') return;

      // 计算本月还款日
      let dueDate = now.date(dueDay);
      if (acc.dueDayNextMonth) {
        dueDate = now.add(1, 'month').date(dueDay);
      }

      const daysLeft = dueDate.diff(now, 'day');
      if (daysLeft < 0 && status === 'pending') status = 'overdue';

      items.push({
        accId: acc.id,
        accType: acc.type,
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
    const markBtn = item.status !== 'paid' ? `<button class="plan-pay-btn" onclick="markAccountPaid('${item.accId}','${item.accType}')">✅ 标记已还</button>` : '';

    html += `
      <div class="repayment-plan-item ${statusClass}" data-acc-id="${item.accId}">
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
          ${markBtn}
        </div>
      </div>`;
  });

  container.innerHTML = html;
}

// ===== 功能5: 标记已还（含还款日志）=====
async function markAccountPaid(accId, accType) {
  if (!DATA) return;
  if (!confirm('确认标记该笔为已还？')) return;

  let found = false;
  let accName = '';
  let amount = 0;

  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      if (acc.id === accId) {
        accName = bank.shortName + '·' + acc.name;
        if (acc.type === 'credit') {
          amount = (acc.currentBillAmount != null ? acc.currentBillAmount : acc.minPayment) || 0;
          acc.paidAmount = amount;
          found = true;
        } else if (acc.type === 'loan') {
          amount = acc.monthlyPayment || 0;
          acc.paidThisMonth = true;
          found = true;
        }
      }
    });
  });

  if (found) {
    // 记录还款日志
    addRepaymentLog(accId, accName, amount, accType);

    DATA.meta.lastUpdated = today.format('YYYY-MM-DD');
    await saveData();
    renderSummaryBanner();
    renderRepaymentPlan();
    renderRepaymentProgress();
    renderBankCards();
    renderRepaymentLog();
    showToast('已标记还清 ✅');
  }
}

// ===== 功能6: 大额到期预警 =====
function renderLargeDueWarning() {
  const container = document.getElementById('largeDueWarning');
  if (!container || !DATA) return;

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

// ===== 功能7: 月度还款进度条 =====
function renderRepaymentProgress() {
  const container = document.getElementById('repaymentProgress');
  if (!container || !DATA) return;

  let totalDue = 0;
  let totalPaid = 0;

  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      if (acc.type === 'loan') {
        totalDue += acc.monthlyPayment || 0;
        if (acc.paidThisMonth) totalPaid += acc.monthlyPayment || 0;
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

// ===== 功能8: 负债趋势图 =====
let debtTrendChart = null;

function getDebtSnapshots() {
  try {
    const raw = localStorage.getItem('debt_snapshots');
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function saveDebtSnapshot() {
  if (!DATA) return;
  const snapshots = getDebtSnapshots();
  const monthKey = today.format('YYYY-MM');

  let totalDebt = 0;
  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      if (acc.type === 'loan') totalDebt += acc.totalDebt || 0;
      else if (acc.type === 'credit') totalDebt += getNetDebt(acc);
    });
  });

  const existing = snapshots.findIndex(s => s.month === monthKey);
  const entry = { month: monthKey, totalDebt, date: today.format('YYYY-MM-DD') };
  if (existing >= 0) snapshots[existing] = entry;
  else snapshots.push(entry);

  snapshots.sort((a, b) => a.month.localeCompare(b.month));
  while (snapshots.length > 24) snapshots.shift();

  localStorage.setItem('debt_snapshots', JSON.stringify(snapshots));
}

function renderDebtTrend() {
  const canvas = document.getElementById('debtTrendChart');
  if (!canvas || typeof Chart === 'undefined') return;

  const snapshots = getDebtSnapshots();
  if (snapshots.length < 2) {
    const wrap = canvas.parentElement;
    if (wrap) wrap.innerHTML = '<div class="empty-tip">数据不足，至少需要2个月的记录才能显示趋势</div>';
    return;
  }

  const labels = snapshots.map(s => dayjs(s.month + '-01').format('M月'));
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
            label: (ctx) => '总负债: ' + fmt(ctx.raw)
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

// ===== 功能9: 日常消费预算 =====
function getBudgetConfig() {
  try {
    const raw = localStorage.getItem('budget_config');
    return raw ? JSON.parse(raw) : { monthlyLimit: 3000 };
  } catch (e) { return { monthlyLimit: 3000 }; }
}

function saveBudgetConfig(config) {
  localStorage.setItem('budget_config', JSON.stringify(config));
}

function renderBudgetPanel() {
  const container = document.getElementById('budgetPanel');
  if (!container || !DATA) return;

  const config = getBudgetConfig();
  const limit = config.monthlyLimit;

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
  if (isNaN(val) || val <= 0) { showToast('请输入有效金额'); return; }
  config.monthlyLimit = val;
  saveBudgetConfig(config);
  renderBudgetPanel();
  showToast('预算已更新为 ' + fmt(val));
}

// ===== 功能10: 提前还款收益计算器 =====
function renderPrepayCalculator() {
  const container = document.getElementById('prepayCalcPanel');
  if (!container || !DATA) return;

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

  if (!options) {
    container.innerHTML = '<div class="empty-tip">无可提前还款的账户</div>';
    return;
  }

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

  let target = null;
  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      if (acc.id === targetId) target = { type: 'loan', data: acc };
      if (acc.installments) {
        acc.installments.forEach(inst => {
          if (inst.id === targetId) target = { type: 'installment', data: inst };
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

  if (target.type === 'loan') {
    const loan = target.data;
    const monthly = loan.monthlyPayment || 0;
    const remaining = loan.remainingMonths || 0;
    const rate = (loan.interestRate || 0) / 12;
    originalTotal = monthly * remaining;
    const originalInterest = originalTotal - loan.totalDebt;

    // 提前还款后本金减少
    const newPrincipal = Math.max(0, loan.totalDebt - amount);
    // 新的剩余期数（月供不变）
    let newMonths = remaining;
    if (rate > 0 && monthly > newPrincipal * rate) {
      newMonths = Math.ceil(-Math.log(1 - newPrincipal * rate / monthly) / Math.log(1 + rate));
    } else if (monthly > 0) {
      newMonths = Math.ceil(newPrincipal / monthly);
    }
    newMonths = Math.min(newMonths, remaining);
    const newTotal = monthly * newMonths;
    const newInterest = newTotal - newPrincipal;

    savedInterest = Math.max(0, originalInterest - newInterest);
    savedMonths = Math.max(0, remaining - newMonths);
  } else {
    const inst = target.data;
    const monthly = inst.monthlyPayment || 0;
    const remaining = inst.remainingMonths || 0;
    const interestPerMonth = inst.interestPerMonth || 0;
    originalTotal = monthly * remaining;

    const principalPerMonth = inst.principalPerMonth || (monthly - interestPerMonth);
    const currentPrincipal = inst.remainingPrincipal || inst.remainingAmount || 0;
    const newPrincipal = Math.max(0, currentPrincipal - amount);
    const newMonths = principalPerMonth > 0 ? Math.ceil(newPrincipal / principalPerMonth) : remaining;

    savedMonths = Math.max(0, remaining - newMonths);
    savedInterest = interestPerMonth * savedMonths;
  }

  const newTotal = Math.max(0, originalTotal - savedInterest - amount);

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
        <span>${fmt(newTotal)}</span>
      </div>
    </div>`;
}

// ===== 功能11: 收入-支出-还款平衡视图 =====
function renderBalanceView() {
  const container = document.getElementById('balanceViewPanel');
  if (!container || !DATA) return;

  // 本月实际收入
  const incomes = DATA.meta.incomes || [];
  const monthStart = today.startOf('month');
  const monthEnd = today.endOf('month');
  let actualIncome = 0;
  incomes.forEach(inc => {
    const d = dayjs(inc.date);
    if (!d.isBefore(monthStart) && !d.isAfter(monthEnd)) {
      actualIncome += inc.amount || 0;
    }
  });
  const income = actualIncome > 0 ? actualIncome : (DATA.meta.monthlyIncome || DATA.meta.baseIncome || 8000);
  const incomeLabel = actualIncome > 0 ? '本月实际收入' : '月收入(预设)';

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

  container.innerHTML = `
    <div class="balance-grid">
      <div class="balance-item income">
        <div class="balance-item-label">${incomeLabel}</div>
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
    </div>`;
}

// ===== 功能12: 还款记录日志 =====
function getRepaymentLog() {
  try {
    const raw = localStorage.getItem('debt_repayment_log');
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function addRepaymentLog(accId, accName, amount, type) {
  const log = getRepaymentLog();
  log.push({
    id: Date.now().toString(36),
    date: today.format('YYYY-MM-DD HH:mm'),
    accId,
    accName,
    amount,
    type
  });
  while (log.length > 100) log.shift();
  localStorage.setItem('debt_repayment_log', JSON.stringify(log));
}

function renderRepaymentLog() {
  const container = document.getElementById('repaymentLogPanel');
  if (!container) return;

  const log = getRepaymentLog();
  if (log.length === 0) {
    container.innerHTML = '<div class="empty-tip">暂无还款记录，标记已还后自动记录</div>';
    return;
  }

  const recent = log.slice(-20).reverse();
  let html = '<div class="repay-log-list">';
  recent.forEach(entry => {
    html += `<div class="repay-log-item">
      <span class="repay-log-date">${entry.date}</span>
      <span class="repay-log-name">${entry.accName}</span>
      <span class="repay-log-amount">${fmt(entry.amount)}</span>
    </div>`;
  });
  html += '</div>';
  container.innerHTML = html;
}

// ===== 功能13: 还款优先级建议 =====
function renderRepayPriority() {
  const container = document.getElementById('repayPriorityPanel');
  if (!container || !DATA) return;

  const debts = [];
  DATA.banks.forEach(bank => {
    bank.accounts.forEach(acc => {
      if (acc.type === 'loan' && (acc.totalDebt || 0) > 0) {
        debts.push({
          name: `${bank.shortName}·${acc.name}`,
          balance: acc.totalDebt,
          rate: acc.interestRate || 0,
          monthly: acc.monthlyPayment || 0,
          months: acc.remainingMonths || 0
        });
      }
      if (acc.type === 'credit' && acc.installments) {
        acc.installments.forEach(inst => {
          if ((inst.remainingAmount || 0) > 0) {
            const monthlyInterest = inst.interestPerMonth || 0;
            const principal = inst.remainingPrincipal || inst.remainingAmount || 0;
            const annualRate = principal > 0 ? (monthlyInterest * 12 / principal) : 0;
            debts.push({
              name: `${bank.shortName}·${inst.name}`,
              balance: inst.remainingAmount || 0,
              rate: annualRate,
              monthly: inst.monthlyPayment || 0,
              months: inst.remainingMonths || 0
            });
          }
        });
      }
    });
  });

  if (debts.length === 0) {
    container.innerHTML = '<div class="empty-tip">无分期/贷款数据</div>';
    return;
  }

  // 雪崩法：按利率从高到低
  const avalanche = [...debts].sort((a, b) => b.rate - a.rate);
  // 雪球法：按余额从小到大
  const snowball = [...debts].sort((a, b) => a.balance - b.balance);

  let html = `<div class="priority-tabs">
    <button class="priority-tab active" onclick="switchPriorityTab('avalanche')">🏔️ 雪崩法（省利息）</button>
    <button class="priority-tab" onclick="switchPriorityTab('snowball')">⛄ 雪球法（快成就）</button>
  </div>`;

  html += '<div class="priority-list" id="priorityAvalanche">';
  avalanche.forEach((d, i) => {
    const rateText = d.rate > 0 ? (d.rate * 100).toFixed(2) + '%' : '免息';
    html += `<div class="priority-item ${i === 0 ? 'priority-first' : ''}">
      <span class="priority-rank">${i + 1}</span>
      <span class="priority-name">${d.name}</span>
      <span class="priority-rate">${rateText}</span>
      <span class="priority-balance">${fmt(d.balance)}</span>
    </div>`;
  });
  html += '</div>';

  html += '<div class="priority-list" id="prioritySnowball" style="display:none">';
  snowball.forEach((d, i) => {
    html += `<div class="priority-item ${i === 0 ? 'priority-first' : ''}">
      <span class="priority-rank">${i + 1}</span>
      <span class="priority-name">${d.name}</span>
      <span class="priority-rate">${fmt(d.balance)}</span>
      <span class="priority-balance">${d.months}期</span>
    </div>`;
  });
  html += '</div>';

  html += '<div class="priority-tip">💡 雪崩法优先还利率最高的，总利息最少；雪球法优先还金额最小的，更快获得成就感</div>';
  container.innerHTML = html;
}

function switchPriorityTab(type) {
  const tabs = document.querySelectorAll('.priority-tab');
  tabs.forEach(t => t.classList.remove('active'));
  if (type === 'avalanche') {
    tabs[0]?.classList.add('active');
    document.getElementById('priorityAvalanche').style.display = '';
    document.getElementById('prioritySnowball').style.display = 'none';
  } else {
    tabs[1]?.classList.add('active');
    document.getElementById('priorityAvalanche').style.display = 'none';
    document.getElementById('prioritySnowball').style.display = '';
  }
}

// ===== 功能14: 年度还款日历 =====
function renderYearlyCalendar() {
  const container = document.getElementById('yearlyCalendarPanel');
  if (!container || !DATA) return;

  const months = [];
  for (let i = 0; i < 12; i++) {
    const month = today.add(i, 'month');
    const monthKey = month.format('YYYY-MM');
    let total = 0;
    const items = [];

    DATA.banks.forEach(bank => {
      bank.accounts.forEach(acc => {
        if (acc.type === 'loan') {
          if ((acc.remainingMonths || 0) > i) {
            total += acc.monthlyPayment || 0;
            items.push({ name: `${bank.shortName}·${acc.name}`, amount: acc.monthlyPayment || 0 });
          }
          // 到期还本
          if (acc.endDate && dayjs(acc.endDate).format('YYYY-MM') === monthKey) {
            total += acc.totalDebt || 0;
            items.push({ name: `${bank.shortName}·${acc.name}(到期)`, amount: acc.totalDebt || 0 });
          }
        }
        if (acc.type === 'credit' && acc.installments) {
          acc.installments.forEach(inst => {
            if ((inst.remainingMonths || 0) > i) {
              total += inst.monthlyPayment || 0;
              items.push({ name: `${bank.shortName}·${inst.name}`, amount: inst.monthlyPayment || 0 });
            }
          });
        }
      });
    });

    months.push({ month, monthKey, total, items });
  }

  const maxTotal = Math.max(...months.map(m => m.total), 1);

  let html = '<div class="yearly-calendar">';
  months.forEach(m => {
    const pct = (m.total / maxTotal * 100).toFixed(0);
    const isHigh = m.total > maxTotal * 0.8;
    const tooltip = m.items.map(it => it.name + ' ' + fmt(it.amount)).join('&#10;');
    html += `<div class="yearly-month ${isHigh ? 'yearly-high' : ''}" title="${tooltip}">
      <div class="yearly-month-label">${m.month.format('M月')}</div>
      <div class="yearly-bar-wrap"><div class="yearly-bar" style="height:${pct}%"></div></div>
      <div class="yearly-amount">${m.total >= 10000 ? (m.total / 10000).toFixed(1) + 'w' : fmt(m.total)}</div>
    </div>`;
  });
  html += '</div>';

  container.innerHTML = html;
}

// ===== 功能15: 收入录入 =====
function renderIncomePanel() {
  const container = document.getElementById('incomePanelBody');
  if (!container || !DATA) return;

  const incomes = DATA.meta.incomes || [];
  const currentMonth = today.format('YYYY-MM');
  const thisMonthIncomes = incomes.filter(inc => inc.date && inc.date.startsWith(currentMonth));
  const totalThisMonth = thisMonthIncomes.reduce((s, inc) => s + (inc.amount || 0), 0);
  const baseIncome = DATA.meta.baseIncome || DATA.meta.monthlyIncome || 8000;

  let html = `<div class="income-summary">
    <span>本月实际收入: <strong>${fmt(totalThisMonth || baseIncome)}</strong></span>
    <button class="budget-edit-btn" onclick="openAddIncome()">＋ 记录收入</button>
  </div>`;

  if (thisMonthIncomes.length > 0) {
    html += '<div class="income-list">';
    thisMonthIncomes.forEach(inc => {
      html += `<div class="income-item">
        <span>${inc.date}</span>
        <span>${inc.note || '收入'}</span>
        <span class="income-amount">+${fmt(inc.amount)}</span>
      </div>`;
    });
    html += '</div>';
  }

  container.innerHTML = html;
}

function openAddIncome() {
  const amount = prompt('收入金额（元）：');
  if (!amount) return;
  const val = parseFloat(amount);
  if (isNaN(val) || val <= 0) { showToast('请输入有效金额'); return; }

  const note = prompt('备注（如：工资、奖金、副业）：', '工资') || '收入';

  if (!DATA.meta.incomes) DATA.meta.incomes = [];
  DATA.meta.incomes.push({
    id: Date.now().toString(36),
    date: today.format('YYYY-MM-DD'),
    amount: val,
    note
  });

  // 更新 monthlyIncome
  const currentMonth = today.format('YYYY-MM');
  const thisMonthTotal = DATA.meta.incomes
    .filter(inc => inc.date && inc.date.startsWith(currentMonth))
    .reduce((s, inc) => s + (inc.amount || 0), 0);
  if (thisMonthTotal > 0) DATA.meta.monthlyIncome = thisMonthTotal;

  DATA.meta.lastUpdated = today.format('YYYY-MM-DD');
  saveData();
  renderIncomePanel();
  renderBalanceView();
  showToast('收入已记录 ✅');
}

// ===== 功能16: 模块排序/隐藏 =====
function getModuleConfig() {
  try {
    const raw = localStorage.getItem('debt_module_config');
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function saveModuleConfig(config) {
  localStorage.setItem('debt_module_config', JSON.stringify(config));
}

const DEFAULT_MODULES = [
  { id: 'largeDueWarning', label: '大额到期预警', visible: true },
  { id: 'repaymentProgress', label: '本月还款进度', visible: true },
  { id: 'repaymentPlanList', label: '还款计划', visible: true },
  { id: 'budgetPanel', label: '本月消费预算', visible: true },
  { id: 'walletSection', label: '钱包余额', visible: true },
  { id: 'expenseOverviewPanel', label: '本月消费概览', visible: true },
  { id: 'billingStatusPanel', label: '信用卡账单状态', visible: true },
  { id: 'bankCards', label: '各银行负债详情', visible: true },
  { id: 'balanceViewPanel', label: '收支平衡分析', visible: true },
  { id: 'prepayCalcPanel', label: '提前还款计算', visible: true },
  { id: 'repaymentLogPanel', label: '还款记录', visible: true },
  { id: 'repayPriorityPanel', label: '还款优先级', visible: true },
  { id: 'yearlyCalendarPanel', label: '年度还款日历', visible: true },
  { id: 'incomePanelBody', label: '收入管理', visible: true }
];

function applyModuleConfig() {
  const config = getModuleConfig() || DEFAULT_MODULES;
  config.forEach(mod => {
    const el = document.getElementById(mod.id);
    if (!el) return;
    el.style.display = mod.visible ? '' : 'none';
    // 隐藏对应的 section-title
    const prev = el.previousElementSibling;
    if (prev && prev.classList && prev.classList.contains('section-title')) {
      prev.style.display = mod.visible ? '' : 'none';
    }
  });
}

function openModuleSettings() {
  const config = getModuleConfig() || DEFAULT_MODULES;
  let html = '<div class="module-settings-list">';
  config.forEach((mod, i) => {
    html += `<div class="module-setting-item">
      <label class="module-toggle">
        <input type="checkbox" ${mod.visible ? 'checked' : ''} onchange="toggleModuleVisibility(${i}, this.checked)" />
        <span>${mod.label}</span>
      </label>
    </div>`;
  });
  html += '</div><button class="btn-primary" style="width:100%;margin-top:12px" onclick="closeModuleSettings()">完成</button>';

  let overlay = document.getElementById('moduleSettingsOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'moduleSettingsOverlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal"><div class="modal-header"><span>⚙️ 模块管理</span><button class="modal-close" onclick="closeModuleSettings()">✕</button></div><div class="modal-body" id="moduleSettingsBody"></div></div>`;
    document.body.appendChild(overlay);
  }
  document.getElementById('moduleSettingsBody').innerHTML = html;
  overlay.classList.add('active');
}

function toggleModuleVisibility(idx, visible) {
  const config = getModuleConfig() || [...DEFAULT_MODULES];
  if (config[idx]) config[idx].visible = visible;
  saveModuleConfig(config);
  applyModuleConfig();
}

function closeModuleSettings() {
  const overlay = document.getElementById('moduleSettingsOverlay');
  if (overlay) overlay.classList.remove('active');
}

// ===== 功能17: 多设备同步冲突处理 =====
let lastKnownVersion = null;

async function checkSyncConflict() {
  if (!DATA) return;
  try {
    const rows = await sbFetch(DEBT_TABLE + '?id=eq.' + DATA_ROW_ID + '&select=updated_at');
    if (rows && rows.length > 0) {
      const cloudUpdated = rows[0].updated_at;
      if (lastKnownVersion && cloudUpdated !== lastKnownVersion) {
        const reload = confirm('检测到其他设备更新了数据，是否重新加载最新数据？\n\n点击"确定"加载云端数据，点击"取消"保留当前数据。');
        if (reload) {
          await loadData();
          showToast('✅ 已同步最新数据');
        }
      }
      lastKnownVersion = cloudUpdated;
    }
  } catch (e) {
    // 网络错误，静默忽略
  }
}

function startSyncConflictCheck() {
  checkSyncConflict();
  setInterval(checkSyncConflict, 60000);
}
