#!/usr/bin/env node
/**
 * check-armor-compare.mjs —— "换这件甲是赚还是亏"（armorCompare / armorRankOf）
 *
 * 背景：2026-10-22 实机，我的钻石胸甲只剩 36%、护腿 32%，箱子里有满耐久铁甲。
 *   以前 `mc_act {mode:"equip"}` 只会闷头换掉、把换亏了这件事藏起来；而参考实现
 *   mineflayer-armor-manager 的判据只有 `rank(新) > rank(旧)` —— **完全不看耐久和附魔**，
 *   结果是"快碎的合金顶掉满耐久钻石"。
 *
 * 这里钉死的是**事实口径**（换不换仍由 AI 决定，所以只测输出，不测副作用）：
 *   ① 材质优先：钻石（快碎）> 铁（满耐久）—— 与参考实现一致；
 *   ② 同材质才比耐久，且差距 <15% 不算赢（抖动空间）；
 *   ③ 同材质同耐久才比附魔总等级；
 *   ④ 三样都打平 ⇒ tie（不要瞎判出个赢家）；
 *   ⑤ 那格本来是空 ⇒ next；
 *   ⑥ 读不到 durabilityUsed / maxDurability 不许崩，也不许变成"更差"。
 *
 * 用法：node tools/check-armor-compare.mjs（**必须从包目录跑**）
 */
import { armorCompare, armorRankOf } from '../src/world-use.mjs'

let pass = 0, fail = 0
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label + (extra ? '  → ' + extra : '')) } }

const it = (name, used, max, enchants) => ({
  name,
  ...(used === undefined ? {} : { durabilityUsed: used }),
  ...(max === undefined ? {} : { maxDurability: max }),
  ...(enchants === undefined ? {} : { enchants }),
})

console.log('\n── 材质等级 ──')
ok(armorRankOf('netherite_chestplate') === 6, 'netherite 最高（6）')
ok(armorRankOf('diamond_helmet') === 5, 'diamond = 5')
ok(armorRankOf('iron_boots') === 3, 'iron = 3')
ok(armorRankOf('leather_leggings') === 0, 'leather = 0')
ok(armorRankOf('shield') === -1, 'shield 不算材质（-1，别让它跟钻甲比等级）')

console.log('\n── 判序：材质 > 耐久 > 附魔 ──')
{
  const r = armorCompare(it('diamond_chestplate', 300, 528), it('iron_chestplate', 0, 240))
  ok(r.better === 'next', '钻石（剩 43%）仍然 > 铁（满）—— 材质优先')
  ok(!/耐久/.test(r.why), '既然材质已经分出胜负，就不该再拿耐久说事', r.why)
}
{
  const r = armorCompare(it('diamond_chestplate', 338, 528), it('diamond_chestplate', 0, 528))
  ok(r.better === 'cur', '同材质：36% < 100% ⇒ 身上那件更好')
  ok(/36%/.test(r.why) && /100%/.test(r.why), 'why 里要把两个百分比都写出来', r.why)
}
{
  const r = armorCompare(it('diamond_chestplate', 0, 528), it('diamond_chestplate', 40, 528))
  ok(r.better === 'tie', '同材质差 7.6%（<15%）算打平，不判输赢', r.why)
}
{
  const r = armorCompare(it('diamond_helmet', 0, 363, [{ lvl: 3 }]), it('diamond_helmet', 0, 363, []))
  ok(r.better === 'next', '同材质同耐久：有附魔的那件更好')
  ok(/附魔/.test(r.why), 'why 要说明是附魔分出的胜负', r.why)
}
{
  const r = armorCompare(it('diamond_boots', 0, 429), it('diamond_boots', 0, 429))
  ok(r.better === 'tie', '三样全平 ⇒ tie')
}

console.log('\n── 边界 ──')
{
  const r = armorCompare(it('iron_helmet', 0, 165), null)
  ok(r.better === 'next', '身上那格是空 ⇒ next')
  ok(r.cur === '空', 'cur 要显示"空"', r.cur)
}
{
  let threw = null
  let r = null
  try { r = armorCompare(it('diamond_helmet'), it('diamond_helmet')) } catch (e) { threw = e }
  ok(!threw, '没有 durabilityUsed / maxDurability 时不许抛', threw && threw.message)
  ok(r && r.better === 'tie', '读不到耐久 ⇒ 读不到就当打平（不能变成"更差"）', r && r.better)
}
{
  const r = armorCompare(it('diamond_helmet', 0, 363, null), it('diamond_helmet', 0, 363, null))
  ok(r.better === 'tie', 'enchants 为 null 也不崩')
}

console.log(`\ncheck-armor-compare：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
