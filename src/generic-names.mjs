/**
 * 泛名（`planks` / `log` / `bed` / `wool`…）→ 具体方块名 + "这一格已经对不对"的判定。
 *
 * 来历：2026-10-23 用户 m01160「1档和2档做一下」，一档第 ⑤ 条。抄的是
 * mindcraft `src/agent/npc/utils.js`（`getTypeOfGeneric` / `blockSatisfied` / `rotateXZ`，
 * 本地参考件在 `备份/mindcraft-参考/src_agent_npc_utils.js`、`src_utils_mcdata.js`）。
 *
 * 为什么需要它：AI 说「用木板把这圈围起来」时写的是 `planks`，而游戏里没有叫 `planks` 的方块 ——
 *   得按**手上/脚下真有的那种木材**落成 `oak_planks` / `birch_planks`。蓝图建造、缺料统计、
 *   「这格是不是已经放对了」全都靠这一层，否则每次都要 AI 自己把 11 种木材猜一遍。
 *
 * 与 mindcraft 的差异（都记在这里，别当成抄错）：
 *   1. 它的 `MATCHING_WOOD_BLOCKS` 叫法容易误会（里面的 `slab`/`stairs` 实际指木质的），
 *      我们改名 `GENERIC_WOOD_PARTS`，并且**只在"泛词是它"时**才做 `endsWith` 匹配 ——
 *      `blockSatisfied('stairs', 'cobblestone_stairs')` 仍然为 **false**，别把石楼梯当木板楼梯。
 *   2. `getTypeOfGeneric` 依赖它自己的 `world.getInventoryCounts` / `getNearestBlocks`；
 *      这里用 mineflayer 原生的 `bot.inventory.items()` 与 `bot.findBlocks()`，没有额外依赖。
 *   3. 补了 `wool`（它只在 `bed` 分支里挑颜色，蓝图里直接写 `wool` 会落空）。
 *
 * 全是纯函数 / 只读查询：不写世界、不发包、不改状态，方便离线单测。
 */
import { countOf } from './inventory.mjs'

/** 11 种木材（1.20+ 含 cherry / bamboo / crimson / warped / pale_oak；顺序按"常见度"排，兜底用 oak） */
export const WOOD_TYPES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped', 'pale_oak']

/** 能跟木材种类拼起来的"泛词"部件（`<wood>_<part>`） */
export const GENERIC_WOOD_PARTS = ['log', 'wood', 'planks', 'sign', 'boat', 'raft', 'fence_gate', 'door', 'fence', 'slab', 'stairs', 'button', 'pressure_plate', 'trapdoor', 'leaves', 'sapling']

/** 16 种羊毛色（床/地毯也用它） */
export const WOOL_COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']

/** 这个泛词是不是"某种木材做的"（`planks` / `log` / `stairs`…） */
export const isGenericWood = (name) => GENERIC_WOOD_PARTS.includes(String(name ?? '').trim().toLowerCase())

/** 归一：去 `minecraft:` 前缀、空白转下划线、转小写 */
export const normName = (s) => String(s ?? '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')

/**
 * 挑一种木材：先看背包里哪种最多（含原木/木板/木棍…凡是名字里带那种木材的都算），
 * 背包里没有就看附近 16 格内的原木，再没有就用 `oak`。
 *
 * @returns {{wood: string, from: 'inventory'|'nearby'|'default', count: number, note: string|null}}
 */
export function woodTypeOf (b, { distance = 16 } = {}) {
  const counts = {}
  /* `bot.inventory.items()` 在"背包还没初始化 / 刚进服"时会直接抛（不是返回空数组），
   * 而这里只是"挑个木材种类"，抛出去会把调用方整条蓝图建造带崩 —— 所以吞掉走兜底。 */
  try {
    for (const it of (b?.inventory?.items?.() ?? [])) {
      const n = String(it?.name ?? '')
      for (const w of WOOD_TYPES) {
        if (n.includes(w)) counts[w] = (counts[w] ?? 0) + (Number(it?.count) || 0)
      }
    }
  } catch { /* 没背包：按"背包里没有"处理 */ }
  let best = null
  let bestN = 0
  for (const [w, n] of Object.entries(counts)) {
    if (n > bestN) { best = w; bestN = n }
  }
  if (best) return { wood: best, from: 'inventory', count: bestN, note: null }

  /* 背包里一块木头都没有时，看脚下这片林子是什么树 —— 蓝图建造多半就在这片林子里取材 */
  try {
    const byName = b?.registry?.blocksByName ?? {}
    const ids = Object.keys(byName).filter((n) => /_log$/.test(n)).map((n) => byName[n]?.id).filter((v) => v !== undefined)
    if (ids.length && typeof b?.findBlocks === 'function') {
      const found = b.findBlocks({ matching: ids, maxDistance: distance, count: 1 })
      const blk = Array.isArray(found) && found.length ? b.blockAt(found[0]) : null
      const wood = String(blk?.name ?? '').split('_')[0]
      if (wood && WOOD_TYPES.includes(wood)) return { wood, from: 'nearby', count: 0, note: `背包里没有木头，按附近那种（${blk.name}）算` }
    }
  } catch { /* 离线假世界 / 没加载区块：走兜底 */ }
  return { wood: 'oak', from: 'default', count: 0, note: null }
}

/**
 * 泛名 → 具体方块/物品名。不是泛名就原样返回（只做归一）。
 *
 * - `planks` → `oak_planks`（木材种类按背包 / 附近 / oak 依次兜底）
 * - `bed`    → `white_bed`（按背包里最多的羊毛色）
 * - `wool`   → `white_wool`
 * - `stairs` → `oak_stairs`
 */
export function concreteNameOf (b, query, opts = {}) {
  const q = normName(query)
  if (!q) return q
  if (q === 'bed' || q === 'wool' || q === 'carpet') {
    /* 床/羊毛/地毯：挑背包里最多的那种颜色；一块都没有就用白色（mindcraft 也是这个兜底） */
    let best = null
    let bestN = 0
    for (const color of WOOL_COLORS) {
      const n = countOf(b, `${color}_wool`)
      if (n > bestN) { best = color; bestN = n }
    }
    return `${best ?? 'white'}_${q}`
  }
  if (isGenericWood(q)) {
    const { wood } = woodTypeOf(b, opts)
    /* `wood` 这个部件特殊：`oak_wood` 是"六面树皮"，`oak_log` 是原木，两者不能互换；
     * AI 写 `log` 时它想要的就是原木，写 `wood` 才是六面树皮 —— 这里不替它改。 */
    return `${wood}_${q}`
  }
  return q
}

/**
 * 蓝图里"这格的目标是 `target`，眼前这格是 `blockName`，算不算已经放对了"。
 *
 * 判据（对应 mindcraft `blockSatisfied`，只放宽了 `dirt`）：
 * - `dirt`  → dirt / grass_block / coarse_dirt / rooted_dirt / podzol / mycelium 都算（土就是土）
 * - 木质泛词 → `endsWith('_' + target)`：`stairs` 只认 `_stairs`，但 `cobblestone_stairs`
 *   这类石头楼梯仍会被 `endsWith` 命中 —— 所以**先过一遍木材种类**再判，见下面的实现。
 * - `bed`   → `endsWith('_bed')`；`torch` → 名字里含 `torch`
 * - 其它     → 全等
 */
export function blockSatisfied (target, blockName) {
  const t = normName(target)
  const n = normName(blockName)
  if (!t || !n) return false
  if (t === n) return true
  if (t === 'dirt') return /^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium)$/.test(n)
  if (t === 'bed') return n.endsWith('_bed')
  if (t === 'torch') return n.includes('torch')
  if (isGenericWood(t)) {
    if (!n.endsWith('_' + t)) return false
    /* `planks` / `log` / `wood` / `leaves` / `sapling` 这些只有木材做的，
     * 而 `slab` / `stairs` / `fence` / `door` / `trapdoor` / `sign` / `boat` / `button` /
     * `pressure_plate` / `fence_gate` / `raft` 里有石头/金属版本 ⇒ 必须首段是木材种类。
     * 🔴 判据用"**肯定列表**"（木材种类 / `stripped_` 去皮 / `*_mosaic` 竹拼），
     *    不用"排除石头"的黑名单 —— 黑名单永远少一条（`nether_brick_fence`、
     *    `cobbled_deepslate_slab`、`iron_door` 都会漏）。 */
    const SOFT = ['planks', 'log', 'wood', 'leaves', 'sapling']
    if (SOFT.includes(t)) return true
    const seg = n.slice(0, n.length - t.length - 1)
    return WOOD_TYPES.includes(seg.split('_')[0]) ||
      /^stripped_/.test(seg) ||
      /_mosaic$/.test(seg) ||
      /^(bamboo|bamboo_block|stripped_bamboo_block)$/.test(seg)
  }
  return false
}

/**
 * 蓝图绕竖轴旋转（4 个朝向）—— 抄自 mindcraft `rotateXZ`，语义：
 * 0 = 不转；1 = 顺时针 90°；2 = 180°；3 = 逆时针 90°。
 *
 * @param {number} x 蓝图内坐标
 * @param {number} z 蓝图内坐标
 * @param {number} orientation 0..3
 * @param {number} sizex 蓝图在 x 方向的格数
 * @param {number} sizez 蓝图在 z 方向的格数
 * @returns {[number, number]} 旋转后的 [x, z]
 */
export function rotateXZ (x, z, orientation, sizex, sizez) {
  const o = ((Number(orientation) || 0) % 4 + 4) % 4
  if (o === 0) return [x, z]
  if (o === 1) return [z, sizex - x - 1]
  if (o === 2) return [sizex - x - 1, sizez - z - 1]
  return [sizez - z - 1, x]
}
