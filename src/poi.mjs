/* ============================================================================
 * poi —— **兴趣点雷达（Point of Interest）**（2026-10-25 重构感知层）
 * ----------------------------------------------------------------------------
 * 借鉴 minecraft-access（盲人 MC 模组）的 PoI 设计：
 *   · 不返回"这一片所有方块"，而是按**类别**分组，每类只给**最近 N 个**；
 *   · 方块类别用 predicate 判定（矿石/木材/石料/功能方块/食物/危险液体…）；
 *   · 只统计**暴露在空气中**的方块（被埋的矿石不算兴趣点，反正看不见）；
 *   · 按**当前目标**（focus）动态加权：造木屋就报木材/石料/工作台，挖矿就报矿石/岩浆。
 *
 * 输出量：16 格半径、6 类各最多 3 处 ⇒ 稳定在 ~40 行以内，可以每轮注入。
 * ========================================================================== */
import Vec3 from 'vec3'

/** 类别定义：label + 方块名正则 + 基础权重（越大越先报） */
export const POI_CATEGORIES = [
  {
    key: 'hostile', label: '危险生物', kind: 'entity', weight: 100,
  },
  {
    key: 'lava', label: '岩浆', kind: 'block', weight: 95,
    re: /^(lava|flowing_lava|magma_block)$/,
  },
  {
    key: 'water', label: '水', kind: 'block', weight: 30,
    re: /^(water|flowing_water)$/,
  },
  {
    key: 'ore', label: '矿石', kind: 'block', weight: 80,
    re: /(_ore|ancient_debris|raw_iron_block|raw_gold_block|raw_copper_block)$/,
  },
  {
    key: 'wood', label: '木材', kind: 'block', weight: 60,
    re: /(_log|_wood|stripped_.*_log|_planks)$/,
  },
  {
    key: 'stone', label: '石料', kind: 'block', weight: 50,
    re: /^(stone|cobblestone|deepslate|cobbled_deepslate|granite|diorite|andesite|tuff|calcite|dripstone_block|basalt|blackstone)$/,
  },
  {
    key: 'functional', label: '功能方块', kind: 'block', weight: 70,
    re: /^(crafting_table|furnace|blast_furnace|smoker|chest|trapped_chest|barrel|anvil|enchanting_table|brewing_stand|bed|white_bed|red_bed|lodestone|beacon|spawner)$/,
  },
  {
    key: 'food', label: '食物/作物', kind: 'block', weight: 55,
    re: /^(wheat|carrots|potatoes|beetroots|melon|pumpkin|sweet_berry_bush|sugar_cane|bamboo|cocoa)$/,
  },
  {
    key: 'flower', label: '花/装饰', kind: 'block', weight: 10,
    re: /(_flower|_tulip|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony)$/,
  },
]

/** 焦点 → 哪些类别最重要（数字越大越优先，0 = 不报） */
const FOCUS_WEIGHTS = {
  auto: {},
  build: { wood: 1.4, stone: 1.3, functional: 1.2, food: 0.6, flower: 0.2 },
  wood: { wood: 1.6, stone: 0.8, functional: 1.0, food: 0.5 },
  ore: { ore: 1.8, stone: 0.7, lava: 1.5, water: 0.8 },
  combat: { hostile: 1.6, lava: 1.3, water: 0.6 },
  explore: { functional: 1.3, wood: 0.7, stone: 0.7, water: 0.9, food: 0.6, flower: 0.8 },
  farm: { food: 1.6, water: 1.2, functional: 0.8 },
  survival: { food: 1.4, water: 1.2, hostile: 1.3, functional: 1.0 },
}

/** 这个方块是不是"暴露在空气中"（至少一面挨着空气/非固体） */
function exposedToAir (b, x, y, z) {
  const dirs = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
  for (const [dx, dy, dz] of dirs) {
    const n = b.blockAt(new Vec3(x + dx, y + dy, z + dz))
    if (!n || n.boundingBox !== 'block') return true
  }
  return false
}

/**
 * 扫描兴趣点。
 * @param {object} self  { bot, _pf }
 * @param {object} opts  { radius = 16, focus = 'auto', limit = 3（每类最多几处）}
 * @returns {{ ok, focus, radius, groups, elapsedMs, text }}
 */
export function scanSurroundings (self, opts = {}) {
  const t0 = Date.now()
  const b = self?.bot
  if (!b?.entity) return { ok: false, why: '还没进服（先 mc_connect）' }
  const radius = Math.max(4, Math.min(Number(opts.radius ?? 16) || 16, 32))
  const focus = String(opts.focus ?? 'auto').toLowerCase()
  const perGroup = Math.max(1, Math.min(Number(opts.limit ?? 3) || 3, 8))
  const focusW = FOCUS_WEIGHTS[focus] ?? FOCUS_WEIGHTS.auto
  const me = b.entity.position

  const groups = []

  /* ① 敌对实体（按距离） */
  const hostileCat = POI_CATEGORIES.find((c) => c.key === 'hostile')
  const hostiles = []
  for (const e of Object.values(b.entities ?? {})) {
    if (!e?.position || e === b.entity) continue
    const d = me.distanceTo(e.position)
    if (d > radius) continue
    const n = String(e.name ?? '').toLowerCase()
    const isHostile = e.type === 'hostile' || /(zombie|skeleton|creeper|spider|witch|pillager|vindicator|evoker|ravager|slime|magma_cube|enderman|blaze|ghast|guardian|hoglin|zoglin|warden|breeze|silverfish|endermite|phantom|drowned|husk|stray|bogged|piglin_brute|wither_skeleton)/.test(n)
    if (!isHostile) continue
    hostiles.push({ name: n, x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z), d: Math.round(d * 10) / 10, hp: e.health ?? null })
  }
  hostiles.sort((a, c) => a.d - c.d)
  if (hostiles.length) {
    groups.push({ key: 'hostile', label: hostileCat.label, count: hostiles.length, items: hostiles.slice(0, perGroup) })
  }

  /* ② 方块类别：一次 findBlocks 查所有候选 id，再按类别归组 */
  const blockCats = POI_CATEGORIES.filter((c) => c.kind === 'block')
  const allIds = []
  const idToCats = new Map()
  for (const cat of blockCats) {
    for (const [name, def] of Object.entries(b.registry?.blocksByName ?? {})) {
      if (!cat.re.test(name)) continue
      allIds.push(def.id)
      if (!idToCats.has(def.id)) idToCats.set(def.id, [])
      idToCats.get(def.id).push(cat.key)
    }
  }
  let found = []
  try {
    /* 🔴 性能：一次 findBlocks 最多取 96 个，先按距离排，**只对最近的做暴露检查**
     *    —— 全量 256 个逐个查 6 面会让扫描从 150ms 涨到 400ms+。 */
    found = b.findBlocks({ matching: [...new Set(allIds)], maxDistance: radius, count: 96 }) ?? []
  } catch { found = [] }
  found.sort((a, c) => me.distanceTo(a) - me.distanceTo(c))
  const checkLimit = Math.min(found.length, Math.max(24, perGroup * 8))

  /* 按类别收集（只保留暴露在空气中的） */
  const byCat = new Map()
  for (let i = 0; i < found.length; i++) {
    const p = found[i]
    const blk = b.blockAt(p)
    if (!blk) continue
    /* 超出检查上限的、以及该类别已经够数的，直接跳过（省掉 blockAt 六面查询） */
    if (i >= checkLimit) break
    if (!exposedToAir(b, p.x, p.y, p.z)) continue
    const cats = idToCats.get(blk.type) ?? []
    for (const key of cats) {
      if (!byCat.has(key)) byCat.set(key, [])
      byCat.get(key).push({
        name: String(blk.name), x: p.x, y: p.y, z: p.z,
        d: Math.round(me.distanceTo(p) * 10) / 10,
      })
    }
  }
  for (const cat of blockCats) {
    const list = byCat.get(cat.key)
    if (!list?.length) continue
    list.sort((a, c) => a.d - c.d)
    groups.push({ key: cat.key, label: cat.label, count: list.length, items: list.slice(0, perGroup) })
  }

  /* ③ 焦点加权排序（越高越前；auto = 按基础权重） */
  const scoreOf = (g) => {
    const cat = POI_CATEGORIES.find((c) => c.key === g.key)
    const base = cat?.weight ?? 10
    const fw = focusW[g.key] ?? (focus === 'auto' ? 1 : 0.3)
    return base * fw
  }
  groups.sort((a, c) => scoreOf(c) - scoreOf(a))

  const elapsedMs = Date.now() - t0
  const lines = [`🎯 兴趣点（半径 ${radius}，焦点 ${focus}，耗时 ${elapsedMs}ms）`]
  for (const g of groups) {
    const head = `· ${g.label}（${g.count} 处）`
    const items = g.items.map((it) => it.hp != null
      ? `${it.name} ${it.d}格 血${it.hp} @${it.x},${it.y},${it.z}`
      : `${it.name} ${it.d}格 @${it.x},${it.y},${it.z}`).join('；')
    lines.push(head + '：' + items + (g.count > g.items.length ? ' …' : ''))
  }
  if (groups.length === 0) lines.push('（附近没有值得关注的兴趣点）')

  return { ok: true, focus, radius, groups, elapsedMs, text: lines.join('\n') }
}
