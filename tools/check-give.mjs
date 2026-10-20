#!/usr/bin/env node
/**
 * check-give.mjs —— 创造取物「静默顶掉别人东西」的回归检查（2026-10-19 实机）
 *
 * 用户那天让我建房子，我一口气 `mc_give` 取了十几种建材，回来发现背包里
 * **2 把弓、1 把钻石剑、2 颗末影之眼**没了 —— 因为 `slot` 显式指定时是直接覆盖，
 * 而回执里那句"被顶掉了"混在一堆字段里，我根本没读。
 *
 * 现在的规矩：
 *   ① 不传 slot      → 自动挑（同款先叠 → 快捷栏空位 → 主背包空位 → 实在满了才用手上那格）
 *   ② 传 slot 且那格**装着别的东西** → **拒绝**（要顶必须 force:true）
 *   ③ 传 slot 且那格是**同款/空的** → 照放
 *   ④ 全满自动兜底顶掉时 → 结果里必须带 `clobbered`（照实说丢了什么）
 */
import { giveItem } from '../src/inventory.mjs'

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)

/** 假 bot：36 格背包（9-44），slot 数组按真 mineflayer 的形状摆 */
function makeBot (fill = {}) {
  const slots = new Array(46).fill(null)
  for (const [s, it] of Object.entries(fill)) slots[Number(s)] = { ...it }
  return {
    game: { gameMode: 'creative' },
    registry: { itemsByName: { cobblestone: { name: 'cobblestone', stackSize: 64 }, diamond_sword: { name: 'diamond_sword', stackSize: 1 }, bow: { name: 'bow', stackSize: 1 }, oak_planks: { name: 'oak_planks', stackSize: 64 } } },
    inventory: { slots, emptySlotCount: () => slots.slice(9, 45).filter((x) => !x).length },
    quickBarSlot: 0,
    creative: {
      async setInventorySlot (slot, item) { slots[slot] = item ? { name: item.name, count: item.count } : null },
    },
  }
}
const ctx = { t: (p) => p, makeItem: (type, n) => ({ name: type.name, count: n }) }

section('① 不传 slot ⇒ 自动挑空位，不动别人的东西')
{
  const b = makeBot({ 9: { name: 'bow', count: 1 }, 36: { name: 'cobblestone', count: 64 } })
  const r = await giveItem(b, { name: 'oak_planks', count: 16 }, ctx)
  ok(r.slot === 37, '落到第一个空快捷栏格（37）', String(r.slot))
  ok(!r.clobbered, '没有顶掉任何东西', JSON.stringify(r.clobbered))
  ok(b.inventory.slots[9].name === 'bow', '第 9 格那把弓还在', JSON.stringify(b.inventory.slots[9]))
}

section('② 显式 slot 那格装着别的东西 ⇒ 拒绝（实机那把弓/钻剑就是这么没的）')
{
  const b = makeBot({ 40: { name: 'diamond_sword', count: 1 } })
  let err = null
  try { await giveItem(b, { name: 'cobblestone', count: 64, slot: 40 }, ctx) } catch (e) { err = e }
  ok(err instanceof Error, '抛错了（不是静默覆盖）')
  ok(/第 40 格已经有 diamond_sword/.test(String(err?.message)), '错误里点名了那一格原来是什么', String(err?.message).slice(0, 50))
  ok(/force:true/.test(String(err?.message)), '告诉它要顶就传 force:true', String(err?.message).slice(-24))
  ok(b.inventory.slots[40].name === 'diamond_sword', '钻剑原地未动', JSON.stringify(b.inventory.slots[40]))
}

section('③ force:true ⇒ 照顶，并且照实报 clobbered')
{
  const b = makeBot({ 40: { name: 'diamond_sword', count: 1 } })
  const r = await giveItem(b, { name: 'cobblestone', count: 64, slot: 40, force: true }, ctx)
  ok(r.slot === 40, '放进了第 40 格', String(r.slot))
  ok(r.clobbered === 'diamond_swordx1', '结果里带 clobbered', JSON.stringify(r.clobbered))
  ok(/你指定的第 40 格/.test(String(r.note)), '文案说是"你指定的那格"（不是"背包满了"）', String(r.note).slice(0, 40))
}

section('④ 显式 slot 那格是空的 / 同款 ⇒ 照放，不算顶掉')
{
  const b = makeBot()
  const r1 = await giveItem(b, { name: 'cobblestone', count: 64, slot: 20 }, ctx)
  ok(r1.slot === 20 && !r1.clobbered, '空格子照放', JSON.stringify(r1.clobbered))
  const r2 = await giveItem(b, { name: 'cobblestone', count: 32, slot: 20 }, ctx)
  ok(r2.slot === 20 && !r2.clobbered, '同款再叠也不算顶掉', JSON.stringify(r2.clobbered))
}

section('⑤ 36 格全满 ⇒ 兜底顶掉手上那格，但必须报出来')
{
  const fill = {}
  for (let s = 9; s <= 44; s++) fill[s] = { name: 'bow', count: 1 }
  fill[36] = { name: 'oak_planks', count: 12 }
  const b = makeBot(fill)
  const r = await giveItem(b, { name: 'cobblestone', count: 64 }, ctx)
  ok(r.slot === 36, '落到手上那格（36）', String(r.slot))
  ok(r.clobbered === 'oak_planksx12', '照实报被顶掉的是 oak_planksx12', JSON.stringify(r.clobbered))
}

section('⑥ 非创造模式 / 未知物品 ⇒ 明确报错')
{
  const b = makeBot()
  b.game.gameMode = 'survival'
  let e1 = null
  try { await giveItem(b, { name: 'cobblestone' }, ctx) } catch (e) { e1 = e }
  ok(/只在创造模式可用/.test(String(e1?.message)), '生存模式取物报"只在创造模式可用"', String(e1?.message).slice(0, 30))
  const b2 = makeBot()
  let e2 = null
  try { await giveItem(b2, { name: 'not_a_real_item' }, ctx) } catch (e) { e2 = e }
  ok(/未知物品/.test(String(e2?.message)), '未知物品报"未知物品"', String(e2?.message).slice(0, 30))
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
