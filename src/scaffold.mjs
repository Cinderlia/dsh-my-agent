/* ============================================================================
 * scaffold —— **被动工具：方块选择**（用户 2026-10-25）
 * ----------------------------------------------------------------------------
 * 垫方块 / 搭方块 / 搭桥之前自动挑一种方块并换到手上，规则（按优先级）：
 *   ① **三废石**（花岗岩/闪长岩/安山岩）+ 圆石/石头/深板岩/凝灰岩 —— 玩家最常见、最不值钱
 *   ② **地狱岩**
 *   ③ 普通石头类和木板里，**背包里哪种多就先用哪种**
 * 手上的那种用完了，自动换下一种。
 * ========================================================================== */

/** 优先级分组（组内按数量挑多的） */
const TIERS = [
  {
    key: 'waste',
    label: '三废石',
    re: /^(cobblestone|cobbled_deepslate|stone|deepslate|granite|diorite|andesite|tuff)$/,
  },
  { key: 'netherrack', label: '地狱岩', re: /^netherrack$/ },
  {
    key: 'common',
    label: '石料/木板',
    re: /^(_?dirt|sand|gravel|clay|.*_planks|bricks|mud|soul_soil|blackstone|basalt|calcite|dripstone_block|smooth_stone|stone_bricks)$/,
  },
]

/** 这个物品能不能当垫脚方块（可放置的完整方块） */
function placeable (b, it) {
  try {
    const blk = b.registry?.blocksByName?.[it.name]
    return Boolean(blk) && blk.boundingBox === 'block' && !blk.name.includes('water')
  } catch { return false }
}

/**
 * 按优先级返回背包里所有可当垫脚的方块：
 * `[{ name, id, count, tier, tierLabel }]`，已经排好序（tier 优先，其次数量多）。
 */
export function scaffoldCandidates (b) {
  const items = []
  try { for (const it of b.inventory.items()) items.push(it) } catch { return [] }
  const out = []
  for (const it of items) {
    if (!placeable(b, it)) continue
    const idx = TIERS.findIndex((t) => t.re.test(it.name))
    if (idx < 0) continue
    out.push({
      name: it.name, id: it.type, count: it.count,
      tier: idx, tierLabel: TIERS[idx].label,
    })
  }
  out.sort((a, c) => (a.tier - c.tier) || (c.count - a.count))
  return out
}

/** 当前最适合的垫脚方块（没有就 null） */
export function bestScaffold (b) {
  return scaffoldCandidates(b)[0] ?? null
}

/** 换到手上（已经拿着就不动）；返回用哪个方块 */
export async function ensureScaffoldInHand (b) {
  const best = bestScaffold(b)
  if (!best) return { ok: false, why: '背包里没有可当垫脚的方块（三废石/圆石/泥土/木板都行）' }
  if (b.heldItem?.name === best.name) return { ok: true, name: best.name, count: best.count, already: true }
  const it = b.inventory.items().find((x) => x.type === best.id)
  if (!it) return { ok: false, why: `背包里找不到 ${best.name}` }
  try {
    await b.equip(it, 'hand')
    return { ok: true, name: best.name, count: best.count }
  } catch (e) {
    return { ok: false, why: e.message }
  }
}

/** 给 pathfinder 的 scafoldingBlocks（要 item id） */
export function scaffoldItemIds (b) {
  return scaffoldCandidates(b).map((c) => c.id)
}

/** 背包预警：空格子 <= 2 时提示清理（用户 2026-10-25） */
export const BAG_WARN_FREE = 2

export function bagWarning (b) {
  try {
    const items = b.inventory.items()
    const used = items.filter((i) => i.count > 0).length
    const free = 36 - used
    if (free <= BAG_WARN_FREE) {
      return `⚠️ 背包只剩 ${free} 个空格（${used}/36 已用）—— 捡不起掉落物了，建议先清理背包（丢掉/存箱子）`
    }
    return null
  } catch { return null }
}
