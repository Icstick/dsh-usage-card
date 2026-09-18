# dsh-usage-card

侧栏「设置」按钮**正上方**的一张常驻小卡片：本会话的 token 用量、费用（RMB）、以及**按来源拆分的上下文占比**。

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web 界面设计。

```
┌─ 本会话用量 ──────────── 7.1M tok  ¥0.55 ─┐
│ 输入未命中 96,266     输出 67,618         │
│ 缓存命中 6,955,648    命中率 99.0%        │
├───────────────────────────────────────────┤
│ 上下文占比 · 221.3k                [估算] │
│ █████████████████████████████████████████ │
│ ● 系统提示                    14.2%  ¥0.04│
│ ● 工具 schema                  0.2% <¥0.01│
│ ● 用户消息                     0.1% <¥0.01│
│ ● 环境注入                    17.0%  ¥0.04│
│ ● 工具结果                    33.3%  ¥0.08│
│ ● AI 历史回复                 35.2%  ¥0.09│
├───────────────────────────────────────────┤
│ subagent  3 个 · 5,500 tok · ¥0.02 [实测] │
└───────────────────────────────────────────┘
```

## 它解决什么

DSH 内核已经内置了「Token 用量」对话框（四个桶）和轨迹视图。本插件补的是内核没有的三件事：

1. **金额** —— 内核里没有任何「钱」的概念。本插件按 DeepSeek 官方价目（含**峰谷**与**缓存命中/未命中差价**）把 token 折算成人民币。
2. **按来源的归因** —— 上下文里到底是谁占的：系统提示、工具定义、你打的字、**宿主注入**、工具返回、还是 AI 自己之前的回复。
3. **常驻可见** —— 不用点开对话框，侧栏一直看得到；切换会话自动跟随。

## 装

```powershell
dsh plugin --profile web add github:Icstick/dsh-usage-card
```

装完**重启 `dsh web`**，刷新页面。卡片出现在左侧栏「设置」正上方。

本地开发 / 离线安装：

```powershell
node scripts/install-local.mjs              # 链接进 web profile（不走 pnpm）
node scripts/install-local.mjs --uninstall  # 可逆
```

## 口径纪律（本插件最在意的部分）

1. **实测与估算永不相加。** 四桶来自 provider 上报（实测）；占比是按 surface 逐节点定价的**估算**。两者在接口里就是两组字段，界面分区显示、各带标签。
2. **未定价返回 `null`，不是 0，也不回退默认价。**
3. **占比与金额解耦。** 占比是 token 比例，与定价无关 —— 算不出钱不该把占比一起抹掉。
4. **金额变量名带币种后缀**，换算只在记账时发生一次。
5. **峰谷按 UTC + ISO 星期判定**，禁用本机时区方法。
6. **价目只由官方页面驱动**，不按「预期下线/预期调价」提前改价。
7. **降级要说出来。** 投影不可用、会话未加载、价表退回内核三元……都走明确原因码，不静默显示 0 或别人的数字。

## 数据来源

| 数据 | 来源 |
|---|---|
| 四桶用量 | `ctx.sessionProjections.snapshot(s).values.tokenUsage` |
| 上下文三元 | `...values.contextBreakdown` |
| 本会话模型 | `...values.modelSelection.lastUsed.model` |
| 逐节点定价 | `ctx.tokenMeter.measure(session).nodes[]` |
| 节点分类 | `session.eventAt(node.seq)` → 事件类型 |
| 子代理 | `session.header.parentSession` + 子会话自己的四桶 |

> 两个实测踩出来的坑，写在这里省得别人再踩：**真人消息在 `agent/inbox/spliced`（`source.kind === 'user'`），不在 `user/message`**（后者绝大多数是宿主注入）；**工具内容散在多种事件里且有重叠**，按事件体积直接相加会重复计数。

## 开发

```powershell
node scripts/build-client.mjs   # 改了 client/index.js 必须重建 lib/client.js 并提交
node test/m0-check.mjs          # 纯函数与 payload 验收
node test/wiring-check.mjs      # 接线验证（假 ctx 跑 apply）
node test/subagent-check.mjs    # 子代理归集（实测四桶 + 已释放的诚实处理）
node scripts/verify.mjs         # 起服务后自检路由与 payload
```

宿主半改动要重启 `dsh web`；客户端改动要重建 + 刷新页面。

## 本地路由的安全姿态

`/usage-card/current.json` 走**两级栅栏**：优先用宿主的 `connection.requestRejection`（Host/Origin + 浏览器 cookie 认证）；该服务在当前上下文不可达时（插件挂在 bundle 作用域）退到本地栅栏 —— **对端必须是回环**（挡局域网/外网直连）且 **Host 必须是回环或 localhost**（挡 DNS rebinding）。每个响应带 `x-usage-card-fence` 说明走的哪一级。

本地兜底弱于宿主完整栅栏（没有 cookie 认证），且**不返回跨源可读的 CORS 头**，因此网页无法读取响应体；数据本身是本机 token 与费用数字。

## 已知限制

- 归因是**估算**，启发式会低估 CJK 与 JSON schema
- 金额**按轮计价**（每轮用它自己的时刻判峰谷）。插件重启前已产生的轮次没有时间戳，那部分按当前档位线性估算，卡片上打「含估算」并给出覆盖率；新会话从第一轮起就是精确的
- 「环境注入」与「用户消息」的区分依赖事件形态，宿主改了格式可能要跟
- 汇率目前是手动兜底值（设置页里可改）
- subagent 汇总尚未接入

## 路线图

| 期 | 内容 | 状态 |
|---|---|---|
| M0 | 骨架 + 路由 + 卡片 + 四桶计价 | ✅ |
| M1 | 六类归因 + 会话跟随 + 模型解析 | ✅ |
| M2 | 六类归因（**已并入 M1**） | ✅ |
| M3 | subagent 归集（子会话四桶，实测） | ✅ |
| M4 | 设置页（汇率 / 显示开关） | ✅ |
| M5 | 逐轮账本落盘 + 导出报告 + 汇率自动更新 | |
| M5 | A/B 机验证 | |

## 许可

MIT
