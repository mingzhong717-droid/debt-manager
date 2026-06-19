# 个人负债管理 PWA — 开发全记录

> 最后更新：2026-06-18  
> 线上地址：https://mingzhong717-droid.github.io/debt-manager/  
> 代码仓库：https://github.com/mingzhong717-droid/debt-manager  
> 本地路径：/mnt/openclaw/catdesk/home/.catpaw/desk_default_workspace/debt-manager/

---

## 一、项目背景与目标

市场上现有的记账/负债管理 App 对中国特色负债结构支持很差，比如：
- 多银行信用卡 + 贷款混合管理
- 信用卡分期（账单分期、大额分期）逐期展示期数/利息/贴息
- 花呗、美团月付等互联网信贷
- 提前还款 What-if 模拟

因此从零搭建了这个专属 PWA，核心目标：
1. 一眼看清总负债、本月应还、结余
2. 多银行分期精细追踪（每笔分期的进度、剩余期数、月供）
3. 消费录入 + 分类分析
4. AI 助手直接读取负债数据回答问题
5. 手机可安装为 PWA，离线可用

---

## 二、技术栈

| 层次 | 选型 | 原因 |
|------|------|------|
| 前端 | 纯原生 HTML/CSS/JS | 无需构建工具，部署简单 |
| 图表 | Chart.js 4.4.0 | 轻量，饼图/柱状图够用 |
| 日期 | Day.js 1.11.10 | 轻量替代 moment |
| 云端存储 | Supabase（REST API）| 免费，无需后端 |
| 离线缓存 | Service Worker + Cache API | PWA 标准方案 |
| 部署 | GitHub Pages | 免费，git push 即上线 |
| AI 对话 | DeepSeek API（外网）/ Friday API（内网）| 内网仅公司网络可用 |

**核心文件：**
```
debt-manager/
├── index.html      # 所有页面 HTML 结构
├── app.js          # 全部业务逻辑（~2400行）
├── style.css       # 样式（~1900行）
├── sw.js           # Service Worker
├── data.json       # 负债数据结构模板（已迁移到 Supabase）
└── manifest.json   # PWA 配置
```

---

## 三、数据结构

### 3.1 负债数据（Supabase: debt_data 表）

```json
{
  "meta": { "lastUpdated": "2026-06-18" },
  "banks": [
    {
      "id": "cmb",
      "name": "招商银行",
      "icon": "🏦",
      "accounts": [
        {
          "id": "cmb-credit-1",
          "type": "credit",
          "name": "招商信用卡",
          "currentBillAmount": 3954.79,
          "paidAmount": 3954.79,      // 本期已还金额（净负债 = currentBillAmount - paidAmount）
          "minPayment": 0,
          "dueDay": 21,
          "totalDebt": 0,
          "installments": [...]       // 分期列表
        },
        {
          "id": "cmb-loan-1",
          "type": "loan",
          "subType": "bullet",        // bullet=到期还本, equal_installment=等额本息
          "name": "闪电贷",
          "totalDebt": 43538,
          "monthlyPayment": 179,      // 仅利息
          "dueDay": 15
        }
      ]
    }
  ],
  "wallets": [
    { "id": "wechat", "name": "微信零钱", "balance": 0 }
  ]
}
```

### 3.2 分期数据结构

```json
{
  "id": "gz-install-1",
  "name": "消费分期一",
  "originalAmount": 8693,
  "remainingAmount": 6742,
  "monthlyPayment": 261,
  "totalMonths": 36,
  "paidMonths": 8,           // 优先读取此字段，没有则用 originalAmount/monthlyPayment 推算
  "principalPerMonth": 241,  // 等额本息专用
  "interestPerMonth": 20,
  "startDate": "2025-09-02",
  "endDate": "2028-11-02",
  "cardId": "gz-credit-1"
}
```

### 3.3 消费记录（Supabase: expenses 表）

```json
{
  "id": 1718700000000,
  "date": "2026-06-18",
  "amount": 28,
  "category": "外卖",
  "payment": "招商信用卡",
  "note": "奶茶",
  "cardId": "cmb-credit-1",
  "billMonth": "2026-06",
  "dueDate": "2026-07-21",
  "isCashAdvance": false
}
```

---

## 四、页面结构（5栏导航）

| 页面 | ID | 主要功能 |
|------|----|---------|
| 总览 | page-overview | 汇总横幅、钱包余额、本月消费概览、账单状态、银行卡片+What-if、图表、还款日历 |
| 消费分析 | page-analysis | ＋记一笔弹窗、月份切换、统计卡片、饼图、排行榜、支付方式分布、AI分析、消费明细表 |
| 分期追踪 | page-installments | 多银行分期精细追踪（进度条、剩余期数、月供） |
| 结清时间线 | page-timeline | 各账户按结清日期排序的时间线 |
| AI助手 | page-ai | 全屏对话页，底部固定输入框，AI自动注入负债数据上下文 |

**导航实现：**
- 桌面端：顶部 `.topbar-nav`（`.nav-btn`），CSS 媒体查询 >600px 显示
- 移动端：底部 `.bottom-nav`（`.bottom-nav-btn`），CSS 媒体查询 ≤600px 显示
- 切换函数：`switchPage(pageId)`，页面 id 格式为 `page-{pageId}`

---

## 五、关键业务逻辑

### 5.1 总负债计算

**坑：** 早期只统计 `currentBillAmount`，漏掉了信用卡分期中银行已垫付的剩余本金，导致显示 ~13万 而实际应为 ~17万。

**正确逻辑：**
```js
// 信用卡净负债 = 当期账单 - 已还金额
netDebt = acc.currentBillAmount - (acc.paidAmount || 0)

// 分期剩余本金单独累加（不与账单重复计算）
acc.installments?.forEach(inst => {
  totalDebt += inst.remainingAmount || 0
})
```

**信用卡分期与账单不重叠原则：** 当期账单中已包含本期分期月供，分期剩余本金是银行已垫付但未出账的部分，两者不重复计算。

### 5.2 分期进度计算

**坑：** 早期对"到期还本"类型贷款（如招商闪电贷）错误使用月利息模拟还款，导致进度溢出为负数。

**正确逻辑：**
```js
// 优先读取 paidMonths 字段
const paid = inst.paidMonths ?? Math.round((inst.originalAmount - inst.remainingAmount) / inst.principalPerMonth)
const progress = paid / inst.totalMonths

// 到期还本类型（subType: 'bullet'）：本金未归还，进度显示 0%
if (acc.subType === 'bullet') progress = 0
```

### 5.3 账单周期过滤

招商信用卡账单日为每月3号，还款日21号，账单周期为上月4日至本月3日。"本月消费概览"按账单周期过滤（方案B），而非自然月，与"本期未出账"状态面板逻辑一致。

### 5.4 本月结余

```
本月结余 = 可用余额（所有钱包之和）- 本月应还
```
结余为负时显示红色，表示钱包余额不够还本月账单。

### 5.5 消费录入流程

1. 点击消费分析页右上角"＋ 记一笔"按钮 → `openAddExpense()`
2. 弹窗填写：日期（默认今天）/ 金额 / 分类 / 支付方式 / 备注
3. 点击"保存消费" → `addExpense()`
4. 自动计算账单周期（`getBillingCycle()`）
5. 套现/大额检测（≥5000且整百 → 弹确认框）
6. 写入 localStorage → 异步同步 Supabase
7. 关闭弹窗，刷新消费分析页所有模块

---

## 六、坑点汇总（重点）

### 坑1：Service Worker 缓存导致新代码不生效 ⭐⭐⭐

**现象：** git push 后等了 60 秒，页面还是旧版本，新函数 `typeof xxx === 'undefined'`。

**根本原因：** SW 缓存了旧版 JS/CSS，浏览器优先从缓存加载，不走网络。手机 Chrome 默认 24 小时内不检测 SW 更新。

**解决方案：**
```js
// sw.js 中升级 CACHE_VERSION，强制所有用户清除旧缓存
const CACHE_VERSION = 'v17'; // 每次有破坏性更新时递增

// index.html 中主动调用 reg.update()
navigator.serviceWorker.register('./sw.js').then(reg => {
  reg.update(); // 强制检查更新
});
```

**调试时手动清除（浏览器控制台）：**
```js
navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister()));
caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
location.reload(true);
```

**手机 PWA 彻底重置：** 长按主屏幕图标删除 → Safari 重新访问 → 添加到主屏幕。

### 坑2：renderExpenseStats() 引用已删除的 DOM 元素 ⭐⭐

**现象：** 录入消费后，消费分析页统计数据不刷新（还显示 ¥0 / 0笔）。

**根本原因：** `addExpense()` 调用链：`renderBillingStatus()` → `renderExpenseTable()` → `renderExpenseStats()` → **报错** → `renderAnalysisPage()` 没有执行。

`renderExpenseStats()` 是旧版遗留函数，引用了已从 HTML 中删除的 `#expenseStats` 和 `#expensePieChart` 元素，`null.innerHTML = ...` 直接抛异常。

**修复：**
```js
function renderExpenseStats() {
  const statsEl = document.getElementById('expenseStats');
  if (!statsEl) return; // 加这一行，安全退出
  // ...
}
```

**教训：** 重构 HTML 删除元素时，必须同步检查所有引用该元素 id 的 JS 代码。

### 坑3：Supabase 数据优先级高于本地 data.json ⭐⭐

**现象：** 修改了 data.json 并 push，但页面显示的还是旧数据。

**根本原因：** `loadData()` 强制云端优先，Supabase 里存的是旧数据，data.json 只是本地模板/备份，不会自动同步到云端。

**正确更新流程：**
```js
// 方法1：浏览器控制台直接修改内存数据并保存
DATA.banks[0].accounts[0].currentBillAmount = 3954.79;
saveData(); // 同步到 Supabase

// 方法2：点击页面右上角"⚙️ 高级"按钮，直接编辑 JSON
```

### 坑4：AI API 在外网不可用 ⭐⭐

**现象：** 手机打开 PWA，AI 助手报 "Load failed"。

**根本原因：** 早期使用了美团内网 API `aigc.sankuai.com`，手机连外网时无法访问。

**修复：** 改用 DeepSeek 公开 API（`api.deepseek.com`），或在内网环境下使用 Friday API。AI 助手会自动将负债数据序列化注入 system message，无需手动粘贴。

### 坑5：totalDebt 计算漏掉分期剩余本金 ⭐⭐

**现象：** 系统显示总负债 ~13万，实际应为 ~17万。

**根本原因：** 只统计了信用卡当期账单余额，没有把各分期的 `remainingAmount` 累加进去。

**修复：** 见"五、关键业务逻辑 5.1"。

### 坑6：分析页 analysisMonth 变量位置 ⭐

**现象：** 消费分析页统计显示 ¥0，手动调用 `renderAnalysisPage()` 却正常。

**根本原因：** `analysisMonth` 用 `let` 声明在 app.js 第 2204 行，是文件级变量，正常情况下全局可访问。但如果某个函数在声明前的执行链中报错，会导致后续代码（包括 `renderAnalysisPage()`）不执行。

**定位方法：** 在控制台逐个调用调用链中的函数，找到第一个报错的。

### 坑7：等额本息分期进度计算误差 ⭐

**现象：** 分期进度条显示不准确。

**根本原因：** 用 `originalAmount / monthlyPayment` 推算已还期数时，等额本息每期含利息，导致推算结果偏小。

**修复：** data.json 中直接存 `paidMonths` 字段，代码优先读取，不再推算：
```js
const paid = inst.paidMonths ?? Math.round(...)
```

### 坑8：GitHub Pages CDN 缓存旧版 app.js ⭐⭐

**现象：** git push 后 SW 缓存已清除，但页面仍加载旧版 app.js，新功能不生效。

**根本原因：** GitHub Pages 背后有 CDN，即使 SW 缓存清了，CDN 层还可能缓存旧文件，导致 `fetch` 拿到的仍是旧版本。

**修复：** 在 `index.html` 引用 `app.js` 时加版本号参数，强制 CDN 视为新资源：
```html
<script src="app.js?v=20260619"></script>
```
每次有重要更新时手动递增版本号（或用时间戳）。

### 坑9：billStart 变量声明顺序错误导致 ReferenceError ⭐⭐

**现象：** 账单状态区域渲染报错，控制台显示 `ReferenceError: Cannot access 'billStart' before initialization`。

**根本原因：** `app.js` 中 `billedExpenseList` 的计算（约第 2033 行）提前使用了 `billStart` 变量，但该变量的 `const` 声明在第 2053 行才出现。`let/const` 不会提升，在声明前访问直接报错。

**修复：** 将 `billStart`/`billEnd` 的声明移到使用位置之前。

**教训：** 重构函数时如果移动了代码块，必须检查变量声明顺序，尤其是 `const/let`。

### 坑10：账单展开明细 CSS 动画失效 ⭐⭐

**现象：** 点击"已出账待还"/"本期未出账"的下三角按钮，明细列表不展开。

**根本原因：** 旧 CSS 规则 `.billing-detail { display: none }` 优先级过高，覆盖了用 `max-height` 实现的展开动画，导致元素始终隐藏。

**修复：** 移除 `display: none` 依赖，改用 `toggleBillingDetail()` 函数直接操作 `inline style`：
```js
function toggleBillingDetail(el) {
  if (el.style.display === 'block') {
    el.style.display = 'none';
  } else {
    el.style.display = 'block';
  }
}
```

**教训：** CSS 动画（`max-height` 过渡）与 `display: none` 不兼容，二选一。用 JS 直接操作 `style` 可绕过 CSS 优先级问题。

### 坑11：getNetDebt() 重复扣除分期月供 ⭐⭐

**现象：** 银行卡片显示的净负债数值偏低，与实际不符。

**根本原因：** `getNetDebt()` 公式错误，对分期月供做了重复扣除：
- 账单金额中已包含本期分期月供
- `remainingAmount` 又包含了当期已在账单中的部分
- 两者相加导致重复计算

**正确公式：**
```
净负债 = (账单金额 - 已还金额) + 未来分期待还总额 + 未出账消费
```
其中 `remainingAmount` 不应包含当期已在账单中的月供部分。

### 坑12：未出账消费是否计入总负债的口径问题 ⭐

**背景：** 系统显示总负债约 15.4 万，用户 Excel 表格显示约 14.7 万，差了约 7,076 元。

**原因：** 未出账消费（已刷卡但尚未生成账单）虽然没有账单，但资金已支出、额度已占用，属于真实负债。Excel 表格未包含这部分，导致低估。

**结论：** 系统口径正确，应以系统数据为准。未出账消费计入总负债统计，账单卡片显示顺序为：账单金额 → 已还金额 → 账单剩余 → 分期待还 → 本期未出账 → **总剩余需还**。

---

## 七、部署流程

```bash
cd /mnt/openclaw/catdesk/home/.catpaw/desk_default_workspace/debt-manager
git add -A
git commit -m "描述改动"
git push
# 等待 30-60 秒 GitHub Pages 生效
```

**每次有破坏性更新（删除 DOM 元素、改数据结构）时，必须同步做以下两件事：**

1. 升级 `sw.js` 中的 `CACHE_VERSION`（强制用户清除 SW 缓存）
2. 升级 `index.html` 中 `app.js` 的版本号参数（强制 CDN 刷新）：
```html
<script src="app.js?v=20260619"></script>
```

**为什么废弃 ngrok：** 美团内网屏蔽了外部隧道服务，ngrok 在手机外网环境下不可靠。统一使用 GitHub Pages，git push 即上线，稳定可靠。

---

## 八、调试技巧

### 用 catdesk browser-action 自动化测试

```bash
# 截图
catdesk browser-action '{"action":"screenshot","path":"/tmp/test.png"}'

# 执行 JS
catdesk browser-action '{"action":"evaluate","script":"typeof openAddExpense"}'

# 点击元素
catdesk browser-action '{"action":"click","selector":"#openAddExpenseBtn"}'

# 导航
catdesk browser-action '{"action":"navigate","url":"https://mingzhong717-droid.github.io/debt-manager/"}'
```

### 清除 SW 缓存（一键脚本）

```js
// 浏览器控制台执行
navigator.serviceWorker.getRegistrations()
  .then(regs => regs.forEach(r => r.unregister()));
caches.keys()
  .then(keys => Promise.all(keys.map(k => caches.delete(k))));
setTimeout(() => location.reload(true), 500);
```

### 直接修改云端数据

```js
// 浏览器控制台
DATA.banks[0].accounts[0].currentBillAmount = 1234;
saveData(); // 自动同步到 Supabase
```

---

## 九、16类消费分类

餐饮堂食 / 外卖 / 买菜生鲜 / 烟酒零食 / 交通出行 / 购物数码 / 购物服装 / 日用百货 / 娱乐休闲 / 订阅会员 / 医疗健康 / 教育学习 / 居家大件 / 转账还款 / 宠物 / 其他

---

## 十、银行账户配置

| 银行 | ID | 账户类型 |
|------|----|---------|
| 招商银行 | cmb | 信用卡 + 闪电贷（到期还本）+ 贷款一/二（等额本息）|
| 广州银行 | gzbank | 信用卡 + 3笔消费分期 + 账单分期 |
| 浦发银行 | spd | 信用卡 + 现金分期 + 商户分期 |
| 农业银行 | abc | 信用卡 + 消费分期 |
| 民生银行 | cmbc | 信用卡 + 账单分期 |
| 花呗 | alipay-huabei | 信用类 |
| 美团月付 | meituan-yuepay | 信用类 |

**账单周期配置（CARD_BILLING）：**

| 账户 | 账单日 | 还款日 | 还款月 |
|------|--------|--------|--------|
| 招商信用卡 | 3日 | 21日 | 当月 |
| 广州银行信用卡 | 13日 | 2日 | 次月 |
| 浦发信用卡 | 29日 | 17日 | 次月 |
| 农行信用卡 | 17日 | 6日 | 次月 |
| 民生信用卡 | 19日 | 9日 | 次月 |
| 花呗 | 1日 | 8日 | 当月 |
| 美团月付 | 24日 | 3日 | 次月 |

---

## 十一、待优化项

- [ ] AI API 切换逻辑：内网自动用 Friday，外网自动用 DeepSeek
- [ ] 消费数据跨月同步优化（当前 saveExpenses 只同步当月）
- [ ] 移动端适配细节（部分卡片在小屏幕上文字溢出）
- [ ] 清理 `renderExpenseStats()` 僵尸函数（当前加了 null 检查，但函数本身已无用）
- [ ] 数据备份/导出功能（当前完全依赖 Supabase，无本地导出）
