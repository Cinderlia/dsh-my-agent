/* ============================================================================
 * bot-placed —— **记下 bot 自己放了哪些方块**（用户 2026-10-26 的需求）
 * ----------------------------------------------------------------------------
 * 用户原话：「…除非它是高价值方块，或 **bot 亲自放下的方块**（这个可以用本地缓存实现，
 * 记录 bot 放置了哪些方块）…」
 *
 * 用途：雷达图里"自己摆的东西"永远单独给一个字符，不被折叠成 `O`。
 * 为什么值得单独记：自己铺的木板/石头往往是**结构线索**（房子、桥、路标），
 * 一旦被折进 `O`，模型就分不清"我盖的墙"和"天然石头"了。
 *
 * 存储：`WeakMap<bot, Map<"x,y,z", name>>` —— 跟着连接走，断线自动回收，不落盘、不占内存。
 * 上限：一张表最多 4096 格（盖个小房子绰绰有余），超了丢最早的一批（Map 保序）。
 * ========================================================================== */

const LIMIT = 4096
const TABLES = new WeakMap()

const keyOf = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`

/** 拿（必要时建）这张 bot 的放置表 */
function tableOf (b) {
  if (!b || (typeof b !== 'object' && typeof b !== 'function')) return null
  let t = TABLES.get(b)
  if (!t) { t = new Map(); TABLES.set(b, t) }
  return t
}

/**
 * 记一笔「这个格子是我放的」。
 * @param {object} b mineflayer bot
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {string} [name] 放的方块名（给不出就只记坐标）
 */
export function notePlaced (b, x, y, z, name = null) {
  const t = tableOf(b)
  if (!t) return
  const k = keyOf(x, y, z)
  t.delete(k)                        // 重新插入 ⇒ 更新"最近一次"的次序
  t.set(k, name ? String(name).split(':').pop() : '?')
  while (t.size > LIMIT) {
    const oldest = t.keys().next().value
    t.delete(oldest)
  }
}

/**
 * 这一格是不是我放的（且放的还是同一种方块）。
 * @param {object} b
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {string} [name] 现在那里的方块名；给了就要求**同名**（被换掉了就不算）
 * @returns {boolean}
 */
export function wasPlacedByBot (b, x, y, z, name = null) {
  const t = b ? TABLES.get(b) : null
  if (!t) return false
  const got = t.get(keyOf(x, y, z))
  if (got === undefined) return false
  if (name == null || got === '?') return true
  return got === String(name).split(':').pop()
}

/** 我自己放的方块一共记了多少格（诊断用） */
export function placedCount (b) {
  return (b ? TABLES.get(b)?.size : 0) ?? 0
}

/** 忘掉一格（比如挖掉了） */
export function forgetPlaced (b, x, y, z) {
  const t = b ? TABLES.get(b) : null
  if (t) t.delete(keyOf(x, y, z))
}
