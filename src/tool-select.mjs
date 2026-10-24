/* ============================================================================
 * tool-select —— **被动工具：自动更换合适工具**（用户 2026-10-25）
 * ----------------------------------------------------------------------------
 * 在 collect / dig 这类"要挖"的动作**之前**自动做三件事：
 *   ① 背包里有合适的工具 → 换到手上（按方块类型 + 等级 + 耐久挑）；
 *   ② 没有 → 如果背包有足够**铁锭**，直接 craft 一把铁工具（铁锭以上不自动收集）；
 *   ③ 连铁锭都不够 → 降级：有圆石做石工具，没有就做木工具（材料由 collect 自动补齐）。
 *
 * 这一步是整条链的**齿轮**：
 *   挖铁矿 → 换工具 → 没铁镐（不做铁锭收集）→ 做石镐 → 缺圆石 → collect 圆石
 *   → 又触发换工具 → 没镐子 → 做木镐 → 缺木板 → collect 原木（箱子）…
 * ========================================================================== */

/** 方块类型 → 用什么工具（按名字判，覆盖原版绝大多数） */
const KIND_RE = [
  ['pickaxe', /(_ore$|^stone$|cobblestone|deepslate|netherrack|obsidian|^bedrock$|_block$|brick|terracotta|concrete|basalt|blackstone|ancient_debris|amethyst|dripstone|^glowstone$|^magma_block$|^furnace$|^blast_furnace$|^smoker$|^anvil$|^iron_bars$|^rail$|^lantern$|^pointed_dripstone$)/],
  ['axe', /(_log$|_wood$|_planks$|_fence$|_fence_gate$|_door$|_trapdoor$|^crafting_table$|^bookshelf$|^chest$|^barrel$|^lectern$|^composter$|_stairs$|_slab$|^pumpkin$|^melon$|^bamboo$)/],
  ['shovel', /(^dirt$|^grass_block$|^sand$|^gravel$|^clay$|^snow|soul_sand|soul_soil|mycelium|podzol|^mud$|^farmland$|^dirt_path$)/],
  ['hoe', /(^wheat$|^carrots$|^potatoes$|^beetroots$|^nether_wart$|^hay_block$|^target$)/],
  ['shears', /(^cobweb$|_leaves$|^short_grass$|^tall_grass$|^fern$|^vine$)/],
]

/** 工具等级（越大越好用；金虽然快但耐久低，排在木后面） */
const TIERS = [
  { key: 'netherite', re: /^netherite_/ },
  { key: 'diamond', re: /^diamond_/ },
  { key: 'iron', re: /^iron_/ },
  { key: 'stone', re: /^stone_/ },
  { key: 'wooden', re: /^wooden_/ },
  { key: 'golden', re: /^golden_/ },
]

/** 这个方块该用什么工具（返回 pickaxe/axe/shovel/hoe/shears/null） */
export function kindFor (blockName) {
  const n = String(blockName ?? '').toLowerCase()
  for (const [kind, re] of KIND_RE) if (re.test(n)) return kind
  return null
}

/**
 * 背包里这个类型**最合适**的工具：等级最高 + 耐久还有。
 * @returns {{item:Object, tier:string, slot:number}|null}
 */
export function bestTool (b, kind, { minDurability = 5, allowedIds = null } = {}) {
  if (!kind) return null
  const items = []
  try { for (const it of b.inventory.items()) items.push(it) } catch { return null }
  const cands = []
  for (const it of items) {
    const name = String(it.name ?? '')
    if (!name.endsWith('_' + kind) && !(kind === 'shears' && name === 'shears')) continue
    /* 🔴 只有 harvestTools 里列出的工具才挖得出掉落（木镐挖铁矿 = 白挖） */
    if (allowedIds && !allowedIds.has(it.type)) continue
    const tier = TIERS.findIndex((t) => t.re.test(name))
    const rank = tier < 0 ? 99 : tier
    const dur = Number(it.durabilityUsed ?? 0)
    const max = Number(it.maxDurability ?? 0)
    const left = max > 0 ? max - dur : Infinity
    if (left < minDurability) continue          // 快坏了，换下一把
    cands.push({ item: it, tier: TIERS[tier]?.key ?? '?', rank, left })
  }
  if (!cands.length) return null
  cands.sort((a, c) => (a.rank - c.rank) || (c.left - a.left))
  return cands[0]
}

/** 换到手上（已经拿着就不动） */
export async function equipTool (b, entry) {
  if (!entry?.item) return { ok: false, why: '没有工具' }
  try {
    if (b.heldItem?.name === entry.item.name && b.heldItem?.count === entry.item.count) {
      return { ok: true, already: true, name: entry.item.name }
    }
    await b.equip(entry.item, 'hand')
    return { ok: true, name: entry.item.name }
  } catch (e) {
    return { ok: false, why: e.message }
  }
}

/** 背包里某物品几个（数字 id 或名字） */
const countOf = (b, nameOrId) => {
  let n = 0
  try {
    for (const it of b.inventory.items()) {
      if (typeof nameOrId === 'number' ? it.type === nameOrId : it.name === nameOrId) n += it.count
    }
  } catch { /* 没背包 */ }
  return n
}

/**
 * 缺工具时该 craft 什么（用户规则）：
 *   · 有足够**铁锭**（≥3）→ 直接做铁工具（**不去收集铁锭以上**）
 *   · 没有铁锭、有圆石（≥3）→ 做石工具
 *   · 都没有 → 做木工具（材料由 collect 自动补：木板→原木）
 * @returns {string|null} 工具名
 */
export function toolPlanFor (b, kind, { needTier = null } = {}) {
  if (!kind) return null
  const suffix = kind === 'shears' ? null : kind
  if (!suffix) return countOf(b, 'iron_ingot') >= 8 ? 'shears' : null
  const iron = countOf(b, 'iron_ingot')
  const cobble = countOf(b, 'cobblestone')
  /* 需要石镐以上（铁矿石/金矿石等）：木镐不够，别做木的 */
  const stoneUp = needTier === 'stone' || needTier === 'iron'
  if (iron >= 3) return `iron_${suffix}`
  if (cobble >= 3 || stoneUp) return `stone_${suffix}`
  return `wooden_${suffix}`
}

/**
 * **入口**：挖之前调用。要么换好工具（返回 {ready:true}），
 * 要么告诉调用方"该插哪个 craft"（返回 {needCraft:'stone_pickaxe'}）。
 */
export async function ensureToolFor (b, block) {
  const blockName = typeof block === 'string' ? block : block?.name
  const kind = kindFor(blockName)
  if (!kind) return { ready: true, kind: null, note: '这个方块不需要工具' }
  /* harvestTools 是 {itemId: true}，只有这些工具挖得出掉落物 */
  let allowedIds = null
  try {
    const ht = typeof block === 'object' ? block?.harvestTools : null
    if (ht && typeof ht === 'object') allowedIds = new Set(Object.keys(ht).map(Number))
  } catch { /* 读不到就按名字挑 */ }
  const best = bestTool(b, kind, { allowedIds })
  if (best) {
    const eq = await equipTool(b, best)
    return eq.ok
      ? { ready: true, kind, tool: best.item.name, tier: best.tier, note: `换上 ${best.item.name}` }
      : { ready: false, kind, why: `换工具失败：${eq.why}` }
  }
  /* 需要什么等级：harvestTools 里没有木工具就说明至少石级（粗糙但够用） */
  let needTier = null
  try {
    const ht = typeof block === 'object' ? block?.harvestTools : null
    if (ht) {
      const ids = Object.keys(ht).map(Number)
      const woodenId = b.registry?.itemsByName?.['wooden_' + kind]?.id
      if (woodenId != null && !ids.includes(woodenId)) needTier = 'stone'
    }
  } catch { /* 忽略 */ }
  const plan = toolPlanFor(b, kind, { needTier })
  if (!plan) return { ready: false, kind, why: `没有可用的 ${kind}，也没有材料现做` }
  return { ready: false, kind, needCraft: plan, note: `缺 ${kind}，需要先做 ${plan}` }
}

/** 武器选择：单个怪用斧（伤害高），多怪用剑（横扫） */
export function bestWeapon (b, { multipleEnemies = false } = {}) {
  const want = multipleEnemies ? 'sword' : 'axe'
  const pick = (k) => {
    const c = []
    try {
      for (const it of b.inventory.items()) {
        const n = String(it.name ?? '')
        if (!n.endsWith('_' + k)) continue
        const tier = TIERS.findIndex((t) => t.re.test(n))
        c.push({ item: it, rank: tier < 0 ? 99 : tier })
      }
    } catch { return null }
    c.sort((a, x) => a.rank - x.rank)
    return c[0] ?? null
  }
  return pick(want) ?? pick(want === 'sword' ? 'axe' : 'sword') ?? null
}
