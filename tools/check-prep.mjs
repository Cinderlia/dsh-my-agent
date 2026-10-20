#!/usr/bin/env node
/**
 * 出发前自查自检 —— `src/prep.mjs` / `mc_act {mode:"prep", for:"nether"|"end"}`
 *
 * 用户 2026-10-19：「把附魔台 / 青金石 / 书架也加进前置清单」。规矩写进 `RULES.md` 只是文字，
 * 这个模式把它变成**数真状态**的自查。这一套钉死八件事：
 *   ① 空背包自查 ⇒ `ok:false` 且把缺的逐条列出来（附魔 / 附魔台 / 书架 / 青金石 / 等级 都在里面）；
 *   ② 齐了 ⇒ `ok:true`；**只要有一项 ❌ 就不是齐了**（不许"差不多算齐"）；
 *   ③ 附魔台 / 书架**放家里也算**（附近 24 格 findBlocks 找得到就行，不用背着走）；
 *   ④ 附魔数不出来 / 世界读不到 ⇒ 报 ❓（不确定），**不许当成 ✅**；
 *   ⑤ 附魔两种形状都认（`enchants` 数组 / `enchantsByName` 对象）；
 *   ⑥ 不认识的去处 ⇒ 明确报错，不许默认成"下界"就查；
 *   ⑦ `end` 那套跟 `nether` 不一样（末影之眼 / 床 / 32 箭 / 满血）；
 *   ⑧ 每条 ❌ 都带"怎么补"（tip），光说缺没用。
 *
 * 用法：node tools/check-prep.mjs
 */
const { prepCheck, enchantCountOf } = await import(new URL('../src/prep.mjs', import.meta.url))

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? `  → ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)
const throws = (fn, re, label) => {
  try { fn(); ok(false, label, '没报错') } catch (e) { ok(re.test(String(e?.message ?? e)), label, String(e?.message ?? e)) }
}

/**
 * 假 bot：只实现 prep 真正碰到的东西。
 * `slots` 是身上五格（5/6/7/8 = 头/身/腿/脚），`near` 是"附近已经放好的方块"。
 */
const makeBot = ({
  items = [], slots = {}, near = [], level = 0, health = 20, food = 20,
  worldBroken = false, itemsBroken = false,
} = {}) => {
  const inv = items.map(([name, count, extra]) => ({ name, count, ...(extra ?? {}) }))
  const slotArr = []
  for (const [i, it] of Object.entries(slots)) slotArr[Number(i)] = it
  return {
    __inv: inv,
    inventory: {
      items: () => { if (itemsBroken) throw new Error('背包读不到'); return inv },
      slots: slotArr,
    },
    experience: { level },
    health,
    food,
    ...(worldBroken
      ? {}
      : {
          registry: { blocksByName: { enchanting_table: { id: 116 }, bookshelf: { id: 47 } } },
          findBlocks: ({ matching }) => (matching.includes(116) && near.includes('enchanting_table'))
            ? [{ x: 1, y: 64, z: 1 }] : (matching.includes(47) && near.includes('bookshelf') ? [{ x: 2, y: 64, z: 1 }] : []),
          blockAt: (v) => (v.x === 1 ? { name: 'enchanting_table' } : v.x === 2 ? { name: 'bookshelf' } : null),
        }),
  }
}

/** 一套"齐了"的下界装备 */
const NETHER_READY = [
  ['obsidian', 12], ['flint_and_steel', 1], ['bow', 1], ['arrow', 32], ['gold_ingot', 10],
  ['enchanting_table', 1], ['bookshelf', 16], ['lapis_lazuli', 8], ['baked_potato', 16],
  ['cobblestone', 96], ['torch', 16],
  ['diamond_sword', 1, { enchants: [{ name: 'sharpness', lvl: 3 }] }],
  ['diamond_pickaxe', 1, { enchants: [{ name: 'efficiency', lvl: 3 }] }],
]
const ARMOR_ENCH = {
  5: { name: 'diamond_helmet', count: 1, enchantsByName: { protection: 3 } },
  6: { name: 'diamond_chestplate', count: 1, enchantsByName: { protection: 3 } },
  7: { name: 'diamond_leggings', count: 1, enchantsByName: { protection: 3 } },
  8: { name: 'diamond_boots', count: 1, enchantsByName: { protection: 3 } },
}

section('① 空背包自查：ok:false，缺的逐条列出来')
{
  const r = prepCheck(makeBot(), { for: 'nether' })
  ok(r.ok === false, '不齐就是 ok:false', String(r.ok))
  ok(r.for === 'nether', '报是下界那套', r.for)
  ok(/缺 \d+ 样/.test(r.text), '标题写缺几样', r.text.split('\n')[0])
  ok(r.missing.includes('装备附过魔'), '缺"装备附过魔"', r.missing.join(','))
  ok(r.missing.includes('附魔台（身上或家里 24 格内）'), '缺附魔台', r.missing.join(','))
  ok(r.missing.includes('书架（出高级附魔）'), '缺书架', r.missing.join(','))
  ok(r.missing.includes('青金石'), '缺青金石', r.missing.join(','))
  ok(r.missing.includes('经验等级'), '缺经验等级', r.missing.join(','))
  ok(r.text.includes('↳'), '缺的项带"怎么补"', '')
  ok(/附魔台 = 4 黑曜石/.test(r.text), '补法里写了附魔台配方', '')
}

section('② 齐了：ok:true')
{
  const r = prepCheck(makeBot({ items: NETHER_READY, slots: ARMOR_ENCH, level: 30 }), { for: 'nether' })
  ok(r.ok === true, '全齐 ok:true', JSON.stringify(r.missing))
  ok(r.missing.length === 0, 'missing 空', JSON.stringify(r.missing))
  ok(/✅ 进下界前自查/.test(r.text), '标题 ✅', r.text.split('\n')[0])
  const ench = r.checks.find((c) => c.id === 'enchant')
  ok(ench.ok === true && ench.have >= 5, '附魔数到了（剑+镐+四件甲）', String(ench.have))
}

section('③ 附魔台 / 书架放家里也算')
{
  const items = NETHER_READY.filter(([n]) => n !== 'enchanting_table' && n !== 'bookshelf')
  const r = prepCheck(makeBot({ items, slots: ARMOR_ENCH, level: 30, near: ['enchanting_table', 'bookshelf'] }), { for: 'nether' })
  const t = r.checks.find((c) => c.id === 'enchanting_table')
  ok(t.ok === true && t.have >= 1, '附近有附魔台就算有', JSON.stringify(t))
  const s = r.checks.find((c) => c.id === 'bookshelf')
  ok(s.ok === false, '附近只有 1 架书架仍不够 15', String(s.have))
  ok(/书架 = 6 木板/.test(r.text), '书架补法写了配方', '')
}

section('④ 世界读不到：报 ❓ 而不是 ✅')
{
  const items = NETHER_READY.filter(([n]) => n !== 'enchanting_table' && n !== 'bookshelf')
  const r = prepCheck(makeBot({ items, slots: ARMOR_ENCH, level: 30, worldBroken: true }), { for: 'nether' })
  const t = r.checks.find((c) => c.id === 'enchanting_table')
  ok(t.ok === false, '背包也没有、世界也读不到 ⇒ 不算有', JSON.stringify(t))
  const b = prepCheck(makeBot({ items, slots: ARMOR_ENCH, level: 30, worldBroken: true }), { for: 'nether' })
  ok(b.checks.find((c) => c.id === 'bookshelf').ok === false, '书架同样不算', '')
}

section('⑤ 附魔两种形状都认 + 数不出来不算 ✅')
{
  ok(enchantCountOf({ enchants: [{ name: 'sharpness', lvl: 3 }] }) === 1, 'enchants 数组', '')
  ok(enchantCountOf({ enchantsByName: { protection: 3, unbreaking: 2 } }) === 2, 'enchantsByName 对象', '')
  ok(enchantCountOf({}) === 0 && enchantCountOf(null) === 0, '没有/空手 = 0', '')
  const r = prepCheck(makeBot({ items: NETHER_READY, slots: {}, level: 30 }), { for: 'nether' })
  const e = r.checks.find((c) => c.id === 'enchant')
  ok(e.ok === false && e.have === 2, '只有剑+镐附过魔 ⇒ 不够 3 件', String(e.have))
  const r2 = prepCheck(makeBot({ items: NETHER_READY, slots: {}, level: NaN }), { for: 'nether' })
  ok(r2.checks.find((c) => c.id === 'level').ok === null, '等级读不到 ⇒ ❓', '')
  ok(/❓ 这几样数不出来/.test(r2.text), '单独列出"数不出来"的', '')
}

section('⑥ 不认识的去处：明确报错')
{
  throws(() => prepCheck(makeBot(), { for: 'overworld' }), /不认识的去处/, 'overworld 报错')
  throws(() => prepCheck(makeBot(), { for: '' }), /不认识的去处/, '空字符串报错')
}

section('⑦ end 那套跟 nether 不一样')
{
  const r = prepCheck(makeBot({ items: NETHER_READY, slots: ARMOR_ENCH, level: 30 }), { for: 'end' })
  ok(r.for === 'end', 'for 归一到 end', r.for)
  ok(r.missing.includes('末影之眼（找要塞 / 开门）'), '末地要末影之眼', r.missing.join(','))
  ok(r.missing.includes('床（炸龙 / 设重生点）'), '末地要床', r.missing.join(','))
  ok(!r.missing.includes('黑曜石（建门）'), '末地不查黑曜石', r.missing.join(','))
  const ready = [...NETHER_READY, ['ender_eye', 12], ['bed', 1], ['arrow', 32]]
  const r2 = prepCheck(makeBot({ items: ready, slots: ARMOR_ENCH, level: 30, health: 20, food: 20 }), { for: 'end' })
  ok(r2.ok === true, '末地齐了 ok:true', JSON.stringify(r2.missing))
  const r3 = prepCheck(makeBot({ items: ready, slots: ARMOR_ENCH, level: 30, health: 8, food: 6 }), { for: 'end' })
  ok(r3.missing.includes('满血满食'), '血少 ⇒ 报"满血满食"', r3.missing.join(','))
}

section('⑧ 背包读不到：不崩，报 ❌/❓')
{
  let r = null
  let threw = false
  try { r = prepCheck(makeBot({ itemsBroken: true }), { for: 'nether' }) } catch { threw = true }
  ok(!threw, '不抛错', '')
  ok(r && r.ok === false, '读不到就是"不齐"（宁可拦下）', String(r?.ok))
  ok(r && /黑曜石/.test(r.text), '照样列条目', '')
}

section('⑨ 食物判据：白名单漏了也不许报"没吃的"')
{
  const { isFoodItem } = await import(new URL('../src/prep.mjs', import.meta.url))
  ok(isFoodItem({ name: 'baked_potato' }) === true, 'baked_potato 算吃的', '')
  ok(isFoodItem({ name: 'cooked_beef' }) === true, 'cooked_beef 算吃的', '')
  ok(isFoodItem({ name: 'golden_carrot' }) === true, 'golden_carrot 算吃的', '')
  ok(isFoodItem({ name: 'mushroom_stew' }) === true, 'mushroom_stew 算吃的', '')
  ok(isFoodItem({ name: 'whatever_berry_pie' }) === true, '名字带 pie 的也算（兜底）', '')
  ok(isFoodItem({ name: 'wheat_seeds' }) === false, '种子不算', '')
  ok(isFoodItem({ name: 'oak_sapling' }) === false, '树苗不算', '')
  ok(isFoodItem({ name: 'cobblestone' }) === false, '圆石不算', '')
  ok(isFoodItem({ name: 'mystery_thing', foodPoints: 4 }) === true, '物品自带 foodPoints 就信它', '')
  const r = prepCheck(makeBot({ items: [['cooked_beef', 12]] }), { for: 'nether' })
  ok(r.checks.find((c) => c.id === 'food').ok === true, '背包里 12 块熟牛肉 ⇒ 吃的够', '')
}

section('⑩ 静态：mc_act 接了 prep')
{
  const { readFileSync } = await import('node:fs')
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  ok(/import \{ prepCheck \} from '\.\/src\/prep\.mjs'/.test(idx), 'index.js 导入了 prepCheck', '')
  ok(/case 'prep':\s+return withOutcome\(\{ mode, \.\.\.\(prepCheck\(bot\.requireBot\(\)/.test(idx), 'case prep 走 requireBot + prepCheck', '')
  ok(/· prep\s+出发前自查/.test(idx), 'mc_act 描述里有 prep 一行', '')
  ok(/for: \{ type: 'string', description: 'prep 查哪/.test(idx), '参数表有 for', '')
  ok(/smithing\/prep\/toss/.test(idx), '未知 mode 的提示里带上 prep', '')
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
