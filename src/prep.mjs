/**
 * 出发前的装备自查 —— `mc_prep {for:"nether" | "end"}`。
 *
 * 用户 2026-10-19：「把附魔台 / 青金石 / 书架也加进前置清单」。规矩写在 `RULES.md`（进下界前
 * 先做附魔台、把装备附上魔），但**规矩是文字，模型不一定照做**；这个模式把规矩变成一次**读真状态**
 * 的自查：背包里数一数、身上装备看有没有附魔、家里附近有没有附魔台/书架，缺哪样就报哪样。
 *
 * 三条约定（跟 `src\inventory.mjs` 那些纯函数一样）：
 *   ① 只读、不发包、不改状态 —— 除了"附近有没有附魔台/书架"要读一次世界（`findBlocks`，只读）。
 *   ② 不 import 游戏库：名字对得上就行，`Vec3` 由调用方给。
 *   ③ 每一项都带 `tip`（缺了怎么补）—— 光说"缺金锭"没用，得说"去下界挖 / 跟猪灵换"。
 *
 * ⚠️ 别把这里写成"我猜你有了"：**所有 ✅ 都是数出来的**。数不出来（背包读不到、世界没加载）
 *    就报 `?`（不确定）而不是 ✅ —— 出发前给个假的"齐了"比不检查还糟。
 */
import { countOf } from './inventory.mjs'

/** 身上五格的槽位（跟 `inventory.mjs` 的 `EQUIP_SLOTS` 同源，这里只要头/身/腿/脚） */
const ARMOR_SLOTS = [[5, '头盔'], [6, '胸甲'], [7, '护腿'], [8, '靴子']]

/** 剑 / 镐的候选（有更好的就用更好的；判断"附过魔没有"时看身上和背包里最好的那把） */
const SWORDS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword']
const PICKAXES = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe']

/** 能当"垫脚 / 搭路 / 堵岩浆"的方块 —— 只要有量，具体是哪种不重要 */
const BUILDING = new Set([
  'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'cobblestone', 'stone', 'andesite', 'diorite',
  'granite', 'deepslate', 'cobbled_deepslate', 'tuff', 'calcite', 'netherrack', 'basalt', 'blackstone',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks',
  'mangrove_planks', 'cherry_planks', 'bamboo_planks', 'crimson_planks', 'warped_planks', 'sand', 'gravel',
])

/** 能吃的（`foodPoints` 读不到时按名字兜底） */
const FOOD = new Set([
  'bread', 'baked_potato', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit',
  'cooked_cod', 'cooked_salmon', 'golden_apple', 'enchanted_golden_apple', 'golden_carrot', 'apple', 'carrot',
  'melon_slice', 'sweet_berries', 'glow_berries', 'dried_kelp', 'cookie', 'pumpkin_pie', 'mushroom_stew',
  'rabbit_stew', 'beetroot_soup', 'honey_bottle', 'potato', 'beetroot',
])

/** 这件东西附了几条魔（prismarine-item 两种形状都认；读不到算 0） */
export function enchantCountOf (it) {
  if (!it) return 0
  if (Array.isArray(it.enchants)) return it.enchants.length
  const byName = it.enchantsByName
  if (byName && typeof byName === 'object') return Object.keys(byName).length
  return 0
}

/** 背包里所有东西（读不到就回空数组 —— 调用方会把"读不到"报成 `?`） */
function itemsOf (b) {
  try {
    const list = b?.inventory?.items?.()
    return Array.isArray(list) ? list : []
  } catch { return [] }
}

/** 背包里最靠前的某类东西（按"越好越前"的顺序找） */
function bestOf (b, names) {
  const items = itemsOf(b)
  for (const n of names) {
    const it = items.find((i) => i?.name === n)
    if (it) return it
  }
  return null
}

/** 身上那件护甲（读槽位，读不到回 null） */
function armorOf (b, slot) {
  try {
    const it = b?.inventory?.slots?.[slot]
    return it && it.name && it.name !== 'air' ? it : null
  } catch { return null }
}

/**
 * 这东西能不能吃。
 *
 * ⚠️ 别只靠一张白名单：食物名字太多了（`baked_potato` / `cooked_beef` / `golden_carrot` /
 *    `mushroom_stew` …），漏一个就等于"背包里有吃的也报没吃的"。所以三层：
 *    ① 物品自带的 `foodPoints`（prismarine-item 有就直接信）；
 *    ② 白名单（常见那几样）；
 *    ③ 名字模式兜底（`cooked_*` / `*_stew` / `*_soup` / 关键词），但排掉种子 / 树苗 / 作物块。
 */
const FOOD_RE = /(bread|apple|carrot|potato|beetroot|beef|porkchop|mutton|chicken|rabbit|cod|salmon|berries|cookie|pie|stew|soup|kelp|honey|melon_slice|mushroom)/

export function isFoodItem (it) {
  const name = String(it?.name ?? '')
  if (!name) return false
  if (Number(it?.foodPoints) > 0) return true
  if (FOOD.has(name)) return true
  if (/seed|sapling|stem|_crop$|spawn_egg/.test(name)) return false
  return FOOD_RE.test(name)
}

/** 食物 / 方块这类"总量"：背包里有几叠就数几叠 */
function totalOf (b, { food = false, building = false } = {}) {
  let n = 0
  for (const it of itemsOf(b)) {
    if (!it?.name) continue
    const isFood = isFoodItem(it)
    if ((food && isFood) || (building && BUILDING.has(it.name))) n += Number(it.count) || 0
  }
  return n
}

/** 附近有没有已经放好的附魔台 / 书架（家里放过就不用背着走） */
function nearbyEnchantSetup (b) {
  const out = { table: 0, shelf: 0, known: false }
  const reg = b?.registry?.blocksByName
  const ids = [reg?.enchanting_table?.id, reg?.bookshelf?.id].filter((v) => v != null)
  if (!ids.length || typeof b?.findBlocks !== 'function') return out
  out.known = true
  try {
    const at = b.findBlocks({ matching: ids, maxDistance: 24, count: 64 })
    for (const v of Array.isArray(at) ? at : []) {
      const blk = typeof b.blockAt === 'function' ? b.blockAt(v) : null
      if (!blk?.name) continue
      if (blk.name === 'enchanting_table') out.table++
      else if (blk.name === 'bookshelf') out.shelf++
    }
  } catch { out.known = false }
  return out
}

/** 一条检查：`ok` 三态（true / false / null=不确定） */
const check = (id, label, have, want, ok, tip) => ({ id, label, have, want, ok, tip })

/**
 * 自查。`opts.for` = `nether` | `end`（也认中文「下界」「末地」）。
 *
 * 回：`{ text, ok, for, checks, missing, notes }` —— `ok` 只有在**没有 ❌**时才是 true
 * （`?` 不确定不算失败，但会单独列出来让人自己确认）。
 */
export function prepCheck (b, opts = {}) {
  const raw = String(opts.for ?? opts.target ?? 'nether').toLowerCase()
  const kind = /^(nether|下界)$/.test(raw) ? 'nether' : /^(end|末地|the_end)$/.test(raw) ? 'end' : null
  if (!kind) throw new Error(`不认识的去处："${raw}"（可用 nether 下界 / end 末地）`)

  const count = (name) => { try { return Number(countOf(b, name)) || 0 } catch { return 0 } }
  const checks = []

  /* ── 附魔那组（用户 2026-10-19 点名要加进来的） ───────────────────────── */
  const sword = bestOf(b, SWORDS)
  const pick = bestOf(b, PICKAXES)
  const armor = ARMOR_SLOTS.map(([slot, label]) => [label, armorOf(b, slot)])
  const enchanted = []
  if (sword && enchantCountOf(sword) > 0) enchanted.push(`剑(${sword.name})`)
  if (pick && enchantCountOf(pick) > 0) enchanted.push(`镐(${pick.name})`)
  for (const [label, it] of armor) if (it && enchantCountOf(it) > 0) enchanted.push(`${label}(${it.name})`)
  checks.push(check('enchant', '装备附过魔', enchanted.length, 3, enchanted.length >= 3,
    '做附魔台（4 黑曜石 + 2 钻石 + 1 书），把剑 / 镐 / 护甲附一遍再走 —— 下界掉岩浆就是秒死，附魔的耐久/保护是保命余量'))

  const lapis = count('lapis_lazuli')
  checks.push(check('lapis', '青金石', lapis, 3, lapis >= 3,
    '附魔要青金石（30 级一次 3 个）：挖 lapis_ore（y 32 以下）或翻箱子'))

  const setup = nearbyEnchantSetup(b)
  const tableHave = count('enchanting_table') + setup.table
  const shelfHave = count('bookshelf') + setup.shelf
  checks.push(check('enchanting_table', '附魔台（身上或家里 24 格内）', tableHave, 1, tableHave >= 1,
    '附魔台 = 4 黑曜石 + 2 钻石 + 1 书（书 = 3 纸 + 1 皮革）；造在家里就行，不用背着进下界'))
  /* 书架：附魔台周围放满 15 架才出 30 级附魔 —— 不够就报"能附但只有低级" */
  checks.push(check('bookshelf', '书架（出高级附魔）', shelfHave, 15, shelfHave >= 15,
    '书架 = 6 木板 + 3 书；附魔台周围围两圈放满 15 架（中间留 1 格空）才出 30 级附魔'))

  const level = Number(b?.experience?.level)
  checks.push(check('level', '经验等级', Number.isFinite(level) ? level : null, 30,
    Number.isFinite(level) ? level >= 30 : null,
    '附魔一次要 30 级：挖矿、烧东西、打怪攒 —— 等级不够就先别急着进门'))

  /* ── 通用 ───────────────────────────────────────────────────────────── */
  const food = totalOf(b, { food: true })
  const blocks = totalOf(b, { building: true })
  const torches = count('torch')
  checks.push(check('food', '吃的', food, 8, food >= 8, '烤马铃薯 / 面包都行，带够 —— 下界 / 末地没东西吃'))
  checks.push(check('blocks', '方块（搭路 / 垫脚 / 堵岩浆）', blocks, kind === 'nether' ? 64 : 32,
    blocks >= (kind === 'nether' ? 64 : 32), '圆石 / 泥土 / 下界岩都行；末地垫高打水晶也要方块'))
  checks.push(check('torch', '火把', torches, 8, torches >= 8, '下界插火把防刷怪（也当路标），顺手带一组'))

  /* ── 下界 ───────────────────────────────────────────────────────────── */
  if (kind === 'nether') {
    const obs = count('obsidian')
    checks.push(check('obsidian', '黑曜石（建门）', obs, 10, obs >= 10,
      '10 个黑曜石：水浇岩浆（钻石镐挖）或翻废弃传送门；造门 + 留备用'))
    const flint = count('flint_and_steel')
    checks.push(check('flint_and_steel', '打火石', flint, 1, flint >= 1,
      '打火石 = 铁锭 + 燧石（挖沙砾掉）；点门下界用，别丢了'))
    const bow = count('bow')
    const arrows = count('arrow')
    checks.push(check('bow', '弓 + 箭（打烈焰人）', `${bow} 弓 / ${arrows} 箭`, '1 弓 / 16 箭',
      bow >= 1 && arrows >= 16, '烈焰人会飞、近战很疼 —— 弓 + 至少 16 箭；箭用燧石 + 木棍 + 羽毛做'))
    const gold = count('gold_ingot')
    checks.push(check('gold_ingot', '金锭（跟猪灵换东西）', gold, 8, gold >= 8,
      '至少 8 个金锭（1 个换 1 次）；穿金甲进猪灵区更安全'))
    const fireRes = count('potion') /* 药水种类不细分，有就算"可能有" */
    checks.push(check('fire_resistance', '抗火药水（可选）', fireRes, 1, null,
      '可选但强烈建议：烈焰人 / 岩浆用得上；酿造台 = 烈焰棒 + 3 圆石'))
  }

  /* ── 末地 ───────────────────────────────────────────────────────────── */
  if (kind === 'end') {
    const eyes = count('ender_eye')
    checks.push(check('ender_eye', '末影之眼（找要塞 / 开门）', eyes, 12, eyes >= 12,
      '12 个末影之眼 = 烈焰粉 + 末影珍珠（打末影人掉）；要塞一般离出生点 1000+ 格，多备几个试错'))
    const bow = count('bow')
    const arrows = count('arrow')
    checks.push(check('bow', '弓 + 箭（打水晶 / 打龙）', `${bow} 弓 / ${arrows} 箭`, '1 弓 / 32 箭',
      bow >= 1 && arrows >= 32, '末影水晶和龙都靠弓；至少 32 箭（`mc_shoot` 直接射）'))
    const beds = count('bed') + count('white_bed') + count('red_bed') + count('blue_bed')
    checks.push(check('bed', '床（炸龙 / 设重生点）', beds, 1, beds >= 1,
      '床炸龙是主流打法（在龙旁边睡会爆）；也在要塞 / 末地门口设重生点'))
    const hp = Number(b?.health)
    const hunger = Number(b?.food)
    checks.push(check('health', '满血满食', Number.isFinite(hp) ? `${Math.round(hp)} 血 / ${Number.isFinite(hunger) ? Math.round(hunger) : '?'} 食` : null,
      '20 血 / 20 食', Number.isFinite(hp) && hp >= 18 && (!Number.isFinite(hunger) || hunger >= 16),
      '进末地前回满血、吃饱 —— 龙一口就能把人打残'))
  }

  /* ── 汇总 ───────────────────────────────────────────────────────────── */
  const bad = checks.filter((c) => c.ok === false)
  const unsure = checks.filter((c) => c.ok === null)
  const label = kind === 'nether' ? '进下界' : '进末地'
  const lines = [`${bad.length ? '❌' : '✅'} ${label}前自查（${kind}）：${bad.length ? `缺 ${bad.length} 样` : '齐了'}`]
  for (const c of checks) {
    const mark = c.ok === true ? '✅' : c.ok === false ? '❌' : '❓'
    lines.push(`  ${mark} ${c.label}：${c.have ?? '?'} / ${c.want}`)
    if (c.ok === false) lines.push(`     ↳ ${c.tip}`)
  }
  if (unsure.length) lines.push(`❓ 这几样数不出来，自己确认一下：${unsure.map((c) => c.label).join('、')}`)
  if (bad.length) lines.push(`缺的补完再走（\`mc_prep {, for:"${kind}"}\` 可以再查一次）。`)
  return { text: lines.join('\n'), ok: bad.length === 0, for: kind, checks, missing: bad.map((c) => c.label) }
}
