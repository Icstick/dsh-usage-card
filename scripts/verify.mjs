#!/usr/bin/env node
/** scripts/verify.mjs —— 重启 dsh web 后的自检：路由是否活着、payload 是否成型 */
const url = process.argv[2] || 'http://127.0.0.1:3080/usage-card/current.json'
const res = await fetch(url, { cache: 'no-store' })
const text = await res.text()
console.log('HTTP ' + res.status + ' ' + (res.headers.get('content-type') || ''))
let json = null
try { json = JSON.parse(text) } catch { /* 非 JSON，下面原样打印 */ }
if (json === null) { console.log('不是 JSON，前 300 字：\n' + text.slice(0, 300)); process.exit(1) }
console.log('ok           ' + json.ok)
if (json.ok !== true) {
  // 非 ok 是失败，退出码必须非 0 —— 否则脚本在 CI/自检里永远「通过」
  console.log('reason       ' + json.reason + (json.detail ? ' (' + json.detail + ')' : ''))
  process.exit(1)
}
console.log('session      ' + json.session.id + '  模型 ' + json.session.model + ' / 档位 ' + json.session.peakTier)
console.log('measured     未命中 ' + json.measured.uncachedInputTokens + '  命中 ' + json.measured.cacheReadTokens +
            '  输出 ' + json.measured.outputTokens + '  命中率 ' + (json.measured.cacheHitRate * 100).toFixed(1) + '%')
console.log('cost         ¥' + json.cost.totalCny.toFixed(4) + '  (USD ' + json.cost.totalUsd.toFixed(6) + ', 汇率 ' + json.cost.fx.rate + ' ' + json.cost.fx.status + ')')
if (json.attribution) {
  const sum = json.attribution.rows.reduce((s, r) => s + (r.costCny || 0), 0)
  const expect = json.cost.inputUsd * json.cost.fx.rate
  console.log('attribution  ' + json.attribution.rows.map((r) => r.label + ' ' + (r.share * 100).toFixed(1) + '%').join(' · '))
  console.log('闭合校验     逐项和 ¥' + sum.toFixed(6) + ' vs 输入侧 ¥' + expect.toFixed(6) + ' → ' + (Math.abs(sum - expect) < 1e-9 ? '一致' : '不一致'))
}
console.log('\n卡片应出现在左侧栏「设置」按钮正上方；未出现就先看 F12 控制台有没有报错。')
