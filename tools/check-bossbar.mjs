/**
 * Boss 血条（末影龙 / 凋灵）—— 2026-10-19 用户点的坑"读不到末影龙血量"。
 *
 * 打龙那一个多小时里，`mc_observe` 的实体列表对 `ender_dragon` **永远没有血量**
 * （我甚至一度以为是自己没装 `bot.util`），只能靠玩家在公屏报"一半了""还有六分之一"。
 * 真相：龙/凋灵的血**不进实体元数据**，只走 Boss Bar 包（`boss_bar`），
 * mineflayer 已经把这条包解析好挂在 `bot.bossBars` 上，`health` 是 **0~1 的比例**。
 *
 * 这里测的就是这一层：比例 → 百分比 / 点数、各种 title 形状、缺字段、越界、读不到。
 */
import { readBossBars, formatBossBars, bossTitleText, bossMaxHp } from '../src/bossbar.mjs'

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)

/* 假 prismarine-chat 对象：只有 toString() */
const chatLike = (text) => ({ toString: () => text })

section('① 末影龙：0~1 的比例换算成"还剩几成 / 多少点"')
{
  const b = { bossBars: [{ title: chatLike('Ender Dragon'), health: 0.62, isDragonBar: true }] }
  const r = readBossBars(b)
  ok(r.length === 1, '读到 1 条血条', String(r.length))
  ok(r[0].title === 'Ender Dragon', 'title 从 ChatMessage 里取出来', r[0].title)
  ok(r[0].pct === 62, 'pct = 62（百分比，不是 0.62）', String(r[0].pct))
  ok(r[0].maxHp === 200, '末影龙上限 200', String(r[0].maxHp))
  ok(r[0].hp === 124, 'hp = 124 点', String(r[0].hp))
  ok(/Ender Dragon 62% ≈ 124\/200 血/.test(formatBossBars(r)), '一行话读得懂', formatBossBars(r))
}

section('② 凋灵：上限 300，中文/英文标题都认')
{
  ok(bossMaxHp('凋灵') === 300, '中文"凋灵" → 300', String(bossMaxHp('凋灵')))
  ok(bossMaxHp('Wither') === 300, '英文 Wither → 300', String(bossMaxHp('Wither')))
  ok(bossMaxHp('末影龙') === 200, '中文"末影龙" → 200', String(bossMaxHp('末影龙')))
  const r = readBossBars({ bossBars: [{ title: chatLike('凋灵'), health: 0.5 }] })
  ok(r[0].hp === 150, '凋灵半血 = 150/300', String(r[0].hp))
}

section('③ title 的几种形状（字符串 / {value} / {text} / 认不出的对象）')
{
  ok(bossTitleText('Ender Dragon') === 'Ender Dragon', '裸字符串')
  ok(bossTitleText({ type: 'string', value: 'Ender Dragon' }) === 'Ender Dragon', '{type:"string",value}')
  ok(bossTitleText({ text: 'Ender Dragon' }) === 'Ender Dragon', '{text}')
  ok(bossTitleText(null) === '', 'null → 空串')
  ok(bossTitleText({}) === '', '认不出的对象 → 空串（不崩）')
}

section('④ health 缺失 / 越界 / 不是数字 ⇒ 别瞎报')
{
  const miss = readBossBars({ bossBars: [{ title: chatLike('Ender Dragon') }] })
  ok(miss[0].percent === null && miss[0].hp === null, '没给 health ⇒ percent/hp 都是 null')
  ok(/读不到血量/.test(formatBossBars(miss)), '一行话说"读不到血量"', formatBossBars(miss))

  const over = readBossBars({ bossBars: [{ title: chatLike('Ender Dragon'), health: 1.8 }] })
  ok(over[0].percent === 1, '超过 1 夹到 1', String(over[0].percent))
  const under = readBossBars({ bossBars: [{ title: chatLike('Ender Dragon'), health: -0.5 }] })
  ok(under[0].percent === 0, '小于 0 夹到 0', String(under[0].percent))
  const nan = readBossBars({ bossBars: [{ title: chatLike('Ender Dragon'), health: 'abc' }] })
  ok(nan[0].percent === null, '不是数字 ⇒ null', String(nan[0].percent))
}

section('⑤ 认不出的 Boss：只报百分比，不猜上限')
{
  const r = readBossBars({ bossBars: [{ title: chatLike('某个模组 Boss'), health: 0.33 }] })
  ok(r[0].pct === 33, 'pct 照报', String(r[0].pct))
  ok(r[0].hp === null && r[0].maxHp === null, 'hp / maxHp 都是 null')
  ok(!/血$/.test(formatBossBars(r).replace('读不到血量', '')), '一行话里不出现点数')
}

section('⑥ 没有 Boss / 根本没有 bossBars / getter 抛异常 ⇒ 空数组，不崩')
{
  ok(readBossBars({}).length === 0, '没有 bossBars 属性 → []')
  ok(readBossBars(null).length === 0, 'null bot → []')
  ok(readBossBars({ bossBars: [] }).length === 0, '空数组 → []')
  ok(readBossBars({ get bossBars () { throw new Error('boom') } }).length === 0, 'getter 抛错 → []')
  ok(formatBossBars([]) === '', 'formatBossBars([]) → 空串')
  ok(formatBossBars(null) === '', 'formatBossBars(null) → 空串')
}

section('⑦ McBot 代理形状：自己没 bossBars 时退回 _bot')
{
  const b = { _bot: { bossBars: [{ title: chatLike('Ender Dragon'), health: 0.1 }] } }
  const r = readBossBars(b)
  ok(r.length === 1 && r[0].hp === 20, '从 _bot 上读到 20/200', JSON.stringify(r[0]))
}

section('⑧ isDragonBar 标志优先于标题（名字被本地化/改名也认得出）')
{
  const r = readBossBars({ bossBars: [{ title: chatLike('???'), health: 0.25, isDragonBar: true }] })
  ok(r[0].maxHp === 200, 'isDragonBar=true ⇒ 按末影龙 200 算', String(r[0].maxHp))
  ok(r[0].hp === 50, '0.25 × 200 = 50', String(r[0].hp))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
