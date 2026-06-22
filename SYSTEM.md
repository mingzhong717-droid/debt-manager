# 个人负债管理系统 - 系统说明书

> 本文档供 AI 模型阅读，以便快速理解并操作本系统。

## 一、项目概览

- **类型**：纯前端 PWA（HTML + CSS + JS + Chart.js）
- **部署**：GitHub Pages → https://mingzhong717-droid.github.io/debt-manager/
- **后端**：Supabase（PostgreSQL）
- **仓库**：https://github.com/mingzhong717-droid/debt-manager
- **核心文件**：`index.html`、`app.js`（4600+行）、`features.js`、`style.css`、`sw.js`

## 二、数据存储架构

### 2.1 Supabase 配置
```
URL: https://ejqhzdckdamssligyjcq.supabase.co
KEY: sb_publishable_-8AFKDoWn61Z9uwRJQJ3AA_Cfxhkpc5
```

### 2.2 两张核心表

| 表名 | 用途 | 结构 |
|------|------|------|
| `debt_data` | 负债主数据（单行，id=1） | `id`, `payload`(JSONB) |
| `expenses` | 消费记录（多行） | `id`(bigint时间戳), `date`, `amount`, `category`, `payment`, `note`, `month` |

**重要**：消费记录存在独立的 `expenses` 表，不在 `debt_data.payload` 里。

### 2.3 payload 数据结构
```json
{
  "meta": {
    "wallets": [
      {"id": "wallet-savings", "name": "储蓄卡", "icon": "🏦", "balance": 数字},
      {"id": "wallet-wechat", "name": "微信钱包", "icon": "💚", "balance": 数字},
      {"id": "wallet-alipay", "name": "支付宝余额", "icon": "💙", "balance": 数字}
    ],
    "baseIncome": 8000,
    "lastUpdated": "YYYY-MM-DD"
  },
  "banks": [
    {
      "id": "cmb",
      "name": "招商银行",
      "accounts": [
        // 贷款账户
        {
          "id": "cmb-loan-1",
          "type": "loan",
          "name": "贷款一·闪电贷（等额本息）",
          "totalDebt": 本金余额,
          "monthlyPayment": 月供,
          "interestRate": 年利率小数,
          "remainingMonths": 剩余期数,
          "dueDay": 还款日(每月几号),
          "paidThisMonth": bool,
          "lastAutoMonth": "YYYY-MM"
        },
        // 信用卡账户
        {
          "id": "cmb-credit-1",
          "type": "credit",
          "name": "招商信用卡",
          "totalDebt": 分期remainingAmount合计 + 未出账消费,
          "creditLimit": 额度,
          "billDay": 账单日,
          "dueDay": 还款日,
          "currentBillAmount": 本期账单金额,
          "paidAmount": 已还金额,
          "installments": [
            {
              "id": "cmb-inst-old",
              "name": "分期名称",
              "totalMonths": 总期数,
              "paidPeriods": 已还期数,
              "remainingMonths": 剩余期数(不含当期),
              "originalAmount": 原始总额(本金+利息),
              "remainingAmount": 剩余总额(不含当期的本金+利息),
              "monthlyPayment": 每期月供,
              "principalPerMonth": 每期本金,
              "interestPerMonth": 每期利息,
              "remainingPrincipal": 剩余本金,
              "remainingInterest": 剩余利息,
              "interestRate": 利率,
              "startDate": "YYYY-MM-DD",
              "endDate": "YYYY-MM-DD"
            }
          ]
        }
      ]
    }
  ],
  "expenses": []  // ⚠️ 历史遗留字段，实际消费记录在独立的 expenses 表
}
```

### 2.4 关键数据规则

1. **totalDebt（信用卡）** = 所有分期 `remainingAmount` 合计 + 未出账消费金额
2. **remainingAmount** = 不含当期的未来待还金额（本金+利息）
3. **remainingMonths** = 不含当期的剩余期数
4. **paidPeriods** = 已还期数（含当期已出账的那期）
5. **贷款 totalDebt** = 当前本金余额（不含利息）

## 三、银行账户清单

| 银行 | 账户ID | 类型 | 账单日 | 还款日 |
|------|--------|------|--------|--------|
| 招商银行 | cmb-loan-1 | 等额本息贷款 | - | 6号 |
| 招商银行 | cmb-loan-2 | 到期还本贷款 | - | 6号 |
| 招商银行 | cmb-credit-1 | 信用卡 | 3号 | 21号 |
| 广州银行 | gz-credit-1 | 信用卡 | 13号 | 次月2号 |
| 浦发银行 | spdb-credit-1 | 信用卡 | 28号 | 次月17号 |
| 农业银行 | abc-credit-1 | 信用卡 | 17号 | 次月6号 |
| 民生银行 | cmbc-credit-1 | 信用卡 | 19号 | 次月9号 |
| 支付宝 | alipay-huabei-1 | 花呗 | 1号 | 8号 |
| 美团 | meituan-yuepay-1 | 月付 | 25号 | 次月3号 |

## 四、核心功能模块

### 4.1 五个页面
1. **总览**：负债总额、月供压力、钱包余额、还款日历
2. **消费分析**：月度消费统计、分类饼图、支付方式分布
3. **分期追踪**：所有分期进度、剩余金额、到期时间
4. **结清时间线**：各笔债务预计结清日期可视化
5. **AI 助手**：自然语言对话录入消费、查询数据

### 4.2 自动化逻辑
- **贷款自动月度扣减**（`autoUpdateLoans()`）：每月还款日后首次打开网站自动执行
  - 等额本息：扣减本金，remainingMonths-1
  - 到期还本：只减 remainingMonths，本金不动
  - 防重复：`lastAutoMonth` 字段记录
- **消费联动**：录入消费时自动扣减对应钱包余额
- **账单周期计算**：根据消费日期自动归入对应账单月

### 4.3 AI 助手支持的意图
| intent | 说明 |
|--------|------|
| add_expense | 录入消费 |
| add_loan | 新建贷款 |
| add_installment | 新建分期 |
| update_wallet | 更新钱包余额 |
| update_installment | 更新分期（还了N期/设置剩余期数） |
| update_bill | 更新信用卡账单 |
| delete_installment | 删除/结清分期 |
| query | 查询分析 |
| chat | 闲聊 |

## 五、操作 API 示例

### 5.1 读取负债数据
```
GET /rest/v1/debt_data?id=eq.1&select=payload
Headers: apikey + Authorization: Bearer <KEY>
```

### 5.2 更新负债数据
```
PATCH /rest/v1/debt_data?id=eq.1
Body: {"payload": <完整JSON>}
Headers: apikey + Authorization + Content-Type: application/json
```

### 5.3 读取消费记录
```
GET /rest/v1/expenses?order=date.desc&limit=500
```

### 5.4 写入消费记录
```
POST /rest/v1/expenses
Body: {"id": 时间戳毫秒, "date": "YYYY-MM-DD", "amount": 数字, "category": "分类", "payment": "支付方式", "note": "备注", "month": "YYYY-MM"}
```

### 5.5 支付方式枚举
招商信用卡、广州银行信用卡、浦发信用卡、农行信用卡、民生信用卡、花呗、美团月付、微信零钱、支付宝余额、储蓄卡、现金

### 5.6 消费分类枚举
餐饮堂食、外卖、买菜生鲜、烟酒零食、交通出行、购物数码、购物服装、日用百货、娱乐休闲、订阅会员、医疗健康、教育学习、居家大件、转账还款、套现、宠物、其他

## 六、注意事项

1. **消费记录写 `expenses` 表**，不要写到 `debt_data.payload.expenses`
2. **expenses 表的 id 是 bigint 时间戳**（`Date.now()` 毫秒级），不是 UUID
3. **修改 payload 时必须先 GET 完整数据再 PATCH 回去**，不支持局部更新
4. **钱包余额在 payload.meta.wallets 里**，修改余额需要更新 debt_data
5. **totalDebt 更新时要同步考虑**：分期 remainingAmount 变化、未出账消费变化
6. **贷款自动扣减已内置在前端**，外部操作贷款数据时注意 `lastAutoMonth` 防重复

## 七、当前负债快照（截至 2026-06-22）

| 项目 | 金额 |
|------|------|
| 总负债 | ¥165,750.88 |
| 贷款合计 | ¥52,926.23 |
| 信用卡合计 | ¥112,824.65 |
| 信用卡总额度 | ¥199,000 |
| 月基本收入 | ¥8,000 |
| 微信钱包 | ¥104.81 |
| 储蓄卡 | ¥15.00 |
