/**
 * 局部空间地图（P0，2026-10-23，用户：「构建局部空间地图」→「做p0」）
 *
 * **它是什么**：一份以机器人为中心、只读、可增量更新、**跨调用活着**的局部空间模型 ——
 * 把"脚下三格"扩成"一两条通道"，让 AI 在发 `mc_move` 之前就知道前面是墙、是落差、
 * 还是没加载，而不是把 10 秒一次的盲试当感知。
 *
 * **它不是什么**（写在最前面，免得后来人越界）：
 *   - **不重写寻路** —— A* 还是 mineflayer-pathfinder 的（用户 2026-10-06：「完全是瞎动」，
 *     所以不自写寻路）。这里只描述环境，不规划路径。
 *   - **不建完整三维图** —— 只存窗口内的列摘要，不存"世界里有哪些方块"。
 *   - **不落盘** —— 地图活在 bot 对象上（`WeakMap`），断线即散。
 *   - **绝不把未加载当空气** —— `blockAt` 读不到 = `unloaded`，是**一等状态**，
 *     永远不参与"能不能站"的推断（这条是 2026-10-23 反复踩过的坑）。
 *
 * **三层怎么分**（用户建议的分法，照做）：
 *   1. 事实层（`columns`）：每根柱子的方块名切片 + 观察时间。数据只来自 `b.blockAt`。
 *   2. 通行层（`nav`）：把列切片算成"能不能站 / 8 向怎么过"，供查询与诊断。
 *   3. 语义层（`spatialText`）：把上面两层压成几行字给模型看（**规则化，不经模型**）。
 *
 * **为什么能跨调用**：列切片按**绝对 y** 存（`anchorY` + `names`），所以"人走几步、
 * 换个格子看"不需要重扫 —— 只有世界变了（`blockUpdate`）或区块装卸才失效。
 * `src/terrain.mjs` 的缓存只留一份结果、3 秒过期、键含脚下坐标，做不到这一点。
 *
 * **为什么判据复用 `columnAt`**：通行判定只能有一份（用户定过"同一个问题只许一处判据"）。
 * 这里直接调 `terrain.columnAt()` 取列切片与落脚点，不另写一套"哪些方块能站"的白名单
 * —— 那种清单一定会漂移。
 */

import { Vec3 } from 'vec3'
import { columnAt } from './terrain.mjs'
import { isLiquid, isPassable, isSolidBlock } from './block-names.mjs'

/** 水平窗口半径（切比雪夫，格）—— 33×33。用户 2026-10-23 定：6 太小，一眼要看清两条以上的通道。 */
export const SPATIAL_R = 16
/** 脚下往上采几格（判头顶净空 / 跳上台阶）。 */
export const SPATIAL_UP = 8
/** 脚下往下采几格（判落差 / 深井）。 */
export const SPATIAL_DOWN = 8
/** 通行层算多大一圈（17×17）—— 跟窗口一起放大，但比窗口小一半：再远交给寻路器（用户 2026-10-23 定）。 */
export const SPATIAL_NAV_R = 8
/** 单次最多存多少列（防呆：调用方传了离谱半径也不会把内存吃穿）。 */
export const SPATIAL_MAX_COLS = 4000
/** 每列上下多采几格余量 —— 人在同一层小范围移动（±2 格）就不必重扫整圈。 */
export const SPATIAL_PAD_Y = 2

/** 四向（Minecraft 坐标：north = -z）。 */
export const SPATIAL_DIRS = [
  { name: 'N', label: '北', dx: 0, dz: -1 },
  { name: 'E', label: '东', dx: 1, dz: 0 },
  { name: 'S', label: '南', dx: 0, dz: 1 },
  { name: 'W', label: '西', dx: -1, dz: 0 },
]

/** 边怎么过的说法（给模型看的中文，顺序就是"从便宜到贵"）。 */
export const SPATIAL_EDGE_TEXT = {
  walk: '走',
  jump: '跳一格',
  climb: '要爬',
  down: '往下走',
  drop: '会掉',
  void: '没落脚点',
  blocked: '墙',
  unknown: '未加载',
  self: '自己',
}

const keyOf = (x, z) => `${x},${z}`

/* ─────────────── 缓存（挂在 bot 上，断线即散） ─────────────── */

const _spatial = new WeakMap()

function entryOf (b) {
  if (!b || (typeof b !== 'object' && typeof b !== 'function')) {
    return { cols: new Map(), ver: 0, hits: 0, misses: 0, scans: 0, evictions: 0, hooked: true, seenAt: new Map() }
  }
  let e = _spatial.get(b)
  if (!e) {
    e = { cols: new Map(), ver: 0, hits: 0, misses: 0, scans: 0, evictions: 0, hooked: false, seenAt: new Map() }
    _spatial.set(b, e)
  }
  if (!e.hooked) {
    e.hooked = true
    try {
      /* 世界变了 ⇒ 只失效**受影响的那一列**（外加紧邻两侧：台阶、门这类一格之差会把
       * 邻列的"能不能站"整个改掉）。区块装卸 ⇒ 全清（那一带的列全不可信了）。 */
      b?.on?.('blockUpdate', (block) => {
        e.ver++
        const x = block?.position?.x
        const z = block?.position?.z
        if (!Number.isFinite(x) || !Number.isFinite(z)) return
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) e.cols.delete(keyOf(Math.floor(x) + dx, Math.floor(z) + dz))
        }
      })
      const wipe = () => { e.ver++; e.cols.clear(); e.seenAt.clear() }
      b?.on?.('chunkDidLoad', wipe)
      b?.on?.('chunkDidUnload', wipe)
    } catch { /* 假 bot 没有 on：不影响，只是靠调用方 `force` 或世界版本手动作废 */ }
  }
  return e
}

/** 地图的账（`hits`/`misses`/`scans`/世界变更次数/缓存列数）—— 给 `mc_probe` 和测试看。 */
export function spatialCacheStats (b) {
  const e = entryOf(b)
  return { hits: e.hits, misses: e.misses, scans: e.scans, version: e.ver, columns: e.cols.size }
}

/** 清空这份地图（传送、换维度、手动排查用）。 */
export function spatialReset (b) {
  const e = entryOf(b)
  e.cols.clear()
  e.seenAt.clear()
  e.ver++
}

/* ─────────────── 层 1：事实（列切片） ─────────────── */

/**
 * 取一根柱子的切片。
 *
 * `columnAt` 的契约：`names` 是**从高到低**的方块名，第一格是 `feetY + up + 1`，
 * 最后一格是 `feetY - down`；任何一格读到 `null` ⇒ 整根 `unloaded`。
 * 这里把它连"锚点"一起存下来，于是**同一根柱子换个 feetY 也不用重扫**（覆盖得到就行）。
 */
function columnOf (b, x, z, anchorY, up, down, { now, force } = {}) {
  const e = entryOf(b)
  const k = keyOf(x, z)
  const hit = e.cols.get(k)
  const needY0 = anchorY - down
  const needY1 = anchorY + up + 1
  if (!force && hit && hit.y0 <= needY0 && hit.y1 >= needY1) {
    e.hits++
    return hit
  }
  e.misses++
  /* 上下各多采 `SPATIAL_PAD_Y` 格当余量：站在台阶上下一格、跳一下再下来，都不用重扫。 */
  const c = columnAt(b, x, z, anchorY, { up: up + SPATIAL_PAD_Y, down: down + SPATIAL_PAD_Y, anchorFirst: true })
  e.scans++
  /* 多采**最低那一格**：判"能不能站"要看脚下一格（`yy - 1`），而 `columnAt` 的切片
   * 只到 `anchorY - down`。少这一格就会把整圈都算成"没采到"（2026-10-23 首跑踩到：
   * 全部 `partial`，可达格数 = 1）。多读一次 `blockAt` 换来的是一整片能用的地图。 */
  const lowY = needY0 - 1
  let extra = null
  if (!c.unloaded) {
    try {
      const blk = b.blockAt(new Vec3(x, lowY, z))
      extra = blk?.name ?? null
    } catch { extra = null }
  }
  const names = c.unloaded || extra === null ? c.names : [...c.names, extra]
  const col = {
    x,
    z,
    anchorY,
    y0: extra === null ? needY0 : lowY,
    y1: anchorY + up + SPATIAL_PAD_Y + 1,
    up: up + SPATIAL_PAD_Y,
    down: down + SPATIAL_PAD_Y,
    names, // 高 → 低：第一格是 y1，最后一格是 y0
    unloaded: c.unloaded,
    seenAt: now(),
  }
  if (e.cols.size >= SPATIAL_MAX_COLS) e.evictions++
  e.cols.set(k, col)
  e.seenAt.set(k, col.seenAt)
  return col
}

/** 从列切片里读第 y 格的名字：`undefined` = 没采到（不是未加载）。 */
function nameAt (col, y) {
  const i = col.y1 - y
  if (i < 0 || i >= col.names.length) return undefined
  return col.names[i]
}

/**
 * 一根柱子对"当前这具身体"意味着什么。
 *
 * 判据与 `terrain.columnAt` 完全同源（`isSolidBlock(脚下一格) && isPassable(本格) && isPassable(头顶)`），
 * 只是输入换成了切片，所以**不再碰 `blockAt`**。
 */
export function columnFactsOf (col, feetY, { up = SPATIAL_UP, down = SPATIAL_DOWN } = {}) {
  const bad = { unloaded: true, kind: 'unloaded', standY: null, dy: null, hazard: null, liquid: null, wall: false, gap: false, headroom: null, solidNow: false }
  if (!col) return bad
  if (col.unloaded) return bad
  // 需要 [feetY - down - 1, feetY + up + 1] 都在切片里；缺一格就宁可说"没采到"
  for (let y = feetY - down - 1; y <= feetY + up + 1; y++) {
    const n = nameAt(col, y)
    if (n === undefined) return { ...bad, unloaded: false, kind: 'partial' }
  }
  let hazard = null
  let liquid = null
  for (let y = feetY - down; y <= feetY + up + 1; y++) {
    const n = nameAt(col, y)
    if (!hazard && /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire|cactus|powder_snow)$/.test(String(n))) hazard = n
    if (!liquid && isLiquid(n)) liquid = n
  }
  let standY = null
  for (let dy = up; dy >= -down; dy--) {
    const y = feetY + dy
    const u = nameAt(col, y - 1)
    const a = nameAt(col, y)
    const c = nameAt(col, y + 1)
    if (isSolidBlock(u) && isPassable(a) && isPassable(c)) { standY = y; break }
  }
  // 头顶净空：从 standY+2 往上数连续可通行的格（跳一次要 2 格高）
  let headroom = null
  if (standY !== null) {
    headroom = 0
    for (let y = standY + 2; y <= feetY + up + 1 && headroom < 3; y++) {
      if (!isPassable(nameAt(col, y))) break
      headroom++
    }
  }
  const solidAtFeet = isSolidBlock(nameAt(col, feetY))
  const kind = hazard ? 'hazard' : liquid ? 'liquid' : standY !== null ? 'stand' : solidAtFeet ? 'wall' : 'gap'
  return {
    unloaded: false,
    kind,
    standY,
    dy: standY === null ? null : standY - feetY,
    hazard,
    liquid,
    wall: standY === null && solidAtFeet,
    gap: standY === null && !solidAtFeet,
    headroom,
    solidNow: solidAtFeet,
  }
}

/* ─────────────── 层 2：通行（17×17 节点 + 8 向边） ─────────────── */

/**
 * 两个相邻格子之间这一步怎么过。
 *
 * `unknown` 是**独立**的一种（不是"墙"也不是"能走"）：区块没加载时唯一诚实的答案。
 */
export function edgeBetween (a, b, dir) {
  if (!a || !b) return 'unknown'
  if (b.unloaded) return 'unknown'
  if (b.kind === 'hazard') return 'blocked'
  if (b.standY === null) return b.wall ? 'blocked' : 'void'
  if (a.standY === null) return 'unknown'
  const d = b.standY - a.standY
  if (d === 0 || d === -1) return 'walk'
  if (d === 1) return 'jump'
  if (d === 2 || d === 3) return 'climb'
  if (d <= -2) return 'drop'
  return 'blocked'
}

/** 这一步**能不能自己过去**（不需要挖、不需要垫、不会摔）。 */
export const isWalkableEdge = (t) => t === 'walk' || t === 'jump' || t === 'climb'

/* ─────────────── 总装：spatialMapOf ─────────────── */

function feetOfBot (b) {
  try {
    const p = b?.entity?.position
    if (!p) return null
    const x = Number(p.x); const y = Number(p.y); const z = Number(p.z)
    if (![x, y, z].every(Number.isFinite)) return null
    return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
  } catch { return null }
}

/**
 * 出一份当前窗口的地图（三层都在返回对象里）。
 *
 * 返回：
 *   `{ ok, center, r, up, down, ver, stats, counts, bounds, columns, nav, note }`
 *   - `columns`：`Map<"x,z", {x,z,standY,dy,kind,headroom,hazard,liquid,seenAt}>`（事实+通行合一，查询用）
 *   - `nav`：`{ r, nodes: [ {dx,dz,x,z,kind,standY,dy,edges:{N,E,S,W}} ], reachable }`
 */
export function spatialMapOf (b, { radius = SPATIAL_R, up = SPATIAL_UP, down = SPATIAL_DOWN, now = Date.now, force = false, navR = SPATIAL_NAV_R } = {}) {
  const R = Math.min(Math.max(Math.floor(Number(radius) || SPATIAL_R), 1), 16)
  const U = Math.min(Math.max(Math.floor(Number(up) || SPATIAL_UP), 1), 8)
  const D = Math.min(Math.max(Math.floor(Number(down) || SPATIAL_DOWN), 0), 8)
  const NR = Math.min(Math.max(Math.floor(Number(navR) || SPATIAL_NAV_R), 1), R)
  const base = {
    ok: false, center: null, r: R, up: U, down: D, ver: entryOf(b).ver,
    stats: spatialCacheStats(b), counts: { stand: 0, wall: 0, gap: 0, liquid: 0, hazard: 0, unloaded: 0, partial: 0 },
    bounds: null, columns: new Map(), nav: { r: NR, nodes: [], reachable: 0 }, note: '',
  }
  if (!b || typeof b.blockAt !== 'function') return { ...base, note: '没有可读的世界（没连上？）' }
  const f = feetOfBot(b)
  if (!f) return { ...base, note: '读不到自己的坐标' }
  /* 整图快照（2026-10-23）：窗口放大到 33×33 后，逐列查缓存仍有 1000+ 次 key 查找。
   * 位置、世界版本、参数都没变 ⇒ 上一次的结果**原样能用**，直接还回去（热路径 ≈ 0 ms）。 */
  const e0 = entryOf(b)
  const snapKey = f.x + ',' + f.y + ',' + f.z + '|' + R + '|' + U + '|' + D + '|' + NR
  if (!force && e0.snap && e0.snap.key === snapKey && e0.snap.ver === e0.ver) {
    e0.hits += 1 // 快照命中也算命中（一次 blockAt 都没读）
    return e0.snap.map
  }

  const columns = new Map()
  const counts = { stand: 0, wall: 0, gap: 0, liquid: 0, hazard: 0, unloaded: 0, partial: 0 }
  let loaded = 0
  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      const x = f.x + dx
      const z = f.z + dz
      const col = columnOf(b, x, z, f.y, U, D, { now, force })
      const facts = columnFactsOf(col, f.y, { up: U, down: D })
      counts[facts.kind] = (counts[facts.kind] ?? 0) + 1
      if (!facts.unloaded && facts.kind !== 'partial') loaded++
      columns.set(keyOf(x, z), { x, z, ...facts, seenAt: col.seenAt, headroom: facts.headroom })
    }
  }

  // 通行层：只对中心 17×17 建节点与边（再远交给寻路器）
  const nodes = []
  const nodeAt = (dx, dz) => {
    const x = f.x + dx
    const z = f.z + dz
    const c = columns.get(keyOf(x, z))
    if (!c) return null
    return c
  }
  for (let dx = -NR; dx <= NR; dx++) {
    for (let dz = -NR; dz <= NR; dz++) {
      const c = nodeAt(dx, dz)
      if (!c) continue
      const edges = {}
      for (const d of SPATIAL_DIRS) {
        const n = nodeAt(dx + d.dx, dz + d.dz)
        edges[d.name] = edgeBetween(c, n, d)
      }
      nodes.push({ dx, dz, x: c.x, z: c.z, kind: c.kind, standY: c.standY, dy: c.dy, headroom: c.headroom, edges })
    }
  }
  // 从中心 BFS：只走"不用挖、不用垫、不会摔"的边 ⇒ "这片窗口里我能自己走到哪"
  const byKey = new Map()
  for (const n of nodes) byKey.set(keyOf(n.x, n.z), n)
  const seen = new Set([keyOf(f.x, f.z)])
  const centerNode = byKey.get(keyOf(f.x, f.z))
  const queue = centerNode ? [centerNode] : []
  while (queue.length) {
    const cur = queue.shift()
    for (const d of SPATIAL_DIRS) {
      if (!isWalkableEdge(cur.edges[d.name])) continue
      const n = byKey.get(keyOf(cur.x + d.dx, cur.z + d.dz))
      if (!n || n.kind !== 'stand') continue
      const k = keyOf(n.x, n.z)
      if (seen.has(k)) continue
      seen.add(k)
      queue.push(n)
    }
  }

  const out = {
    ok: loaded > 0,
    center: f,
    r: R,
    up: U,
    down: D,
    ver: entryOf(b).ver,
    stats: spatialCacheStats(b),
    counts,
    bounds: { minX: f.x - R, maxX: f.x + R, minZ: f.z - R, maxZ: f.z + R, minY: f.y - D, maxY: f.y + U },
    loaded,
    columns,
    nav: { r: NR, nodes, reachable: seen.size },
    note: loaded === 0 ? '这一圈区块都还没加载' : '',
  }
  e0.snap = { key: snapKey, ver: e0.ver, map: out }
  return out
}

/* ─────────────── 层 3：语义（给模型看的几行字） ─────────────── */

/** 沿一个方向最多连续走几步、每一步怎么过、最后为什么停。 */
export function rayAlong (map, dir, { max = null } = {}) {
  const c = map?.center
  if (!c) return { dir: dir?.name ?? '?', steps: 0, how: [], end: 'unknown', endAt: null }
  const limit = Math.min(Math.floor(Number(max) || (map.r ?? SPATIAL_R)), map.r ?? SPATIAL_R)
  const here = map.columns?.get(keyOf(c.x, c.z))
  let cur = here
  let steps = 0
  const how = []
  for (let i = 1; i <= limit; i++) {
    const n = map.columns.get(keyOf(c.x + dir.dx * i, c.z + dir.dz * i))
    const t = edgeBetween(cur, n, dir)
    if (!(isWalkableEdge(t) || t === 'down')) {
      return { dir: dir.name, label: dir.label, steps, how, end: t, endAt: n ? { x: n.x, z: n.z, dy: n.dy, kind: n.kind } : null }
    }
    steps = i
    how.push(t)
    cur = n
  }
  return { dir: dir.name, label: dir.label, steps, how, end: 'limit', endAt: null }
}

const DIR_WORD = { walk: '走', jump: '跳', climb: '爬', down: '下', drop: '掉', void: '没落脚点', blocked: '墙', unknown: '未加载', limit: '出窗口' }

/**
 * 把地图压成几行字（**规则化生成，不经模型**）。
 *
 * 目标：≤ 6 行、≤ 400 字符。宁可少说，也不要吐一张图 ——
 * 模型不需要"几千个方块"，它需要"前面能不能走"。
 */
export function spatialText (map, { rays = null } = {}) {
  if (!map || !map.ok) return []
  const c = map.center
  const n = map.counts ?? {}
  const lines = []
  lines.push(`🗺 局部 ${map.r * 2 + 1}×${map.r * 2 + 1}（半径 ${map.r}）｜可站 ${n.stand ?? 0} · 墙 ${n.wall ?? 0} · 落差 ${n.gap ?? 0} · 液体 ${n.liquid ?? 0} · 危险 ${n.hazard ?? 0} · 未加载 ${n.unloaded ?? 0}`)
  const here = map.columns?.get(keyOf(c.x, c.z))
  if (here) {
    const bits = [here.standY === null ? (here.wall ? '脚下这格站不了（实心）' : '脚下悬空') : `可站 y=${here.standY}`]
    if (here.headroom != null) bits.push(here.headroom <= 0 ? '头顶堵住，跳不起来' : `头顶 ${here.headroom} 格空`)
    lines.push(`📍 ${bits.join(' ｜ ')}`)
  }
  const rr = rays ?? SPATIAL_DIRS.map((d) => rayAlong(map, d))
  const one = (r) => {
    const head = `${r.dir} ${r.steps === 0 ? '出不去' : `走 ${r.steps} 格`}`
    const why = r.end === 'limit' ? '窗口内一直通' : `后${DIR_WORD[r.end] ?? r.end}` +
      (r.endAt && Number.isFinite(r.endAt.dy) && r.endAt.dy !== 0 ? `（落差 ${r.endAt.dy > 0 ? '+' : ''}${r.endAt.dy}）` : '')
    const mix = [...new Set(r.how.filter((x) => x !== 'walk'))]
    return `${head}${mix.length ? `（含${mix.map((x) => DIR_WORD[x] ?? x).join('/')}）` : ''} → ${why}`
  }
  lines.push('🧭 ' + rr.map(one).join(' ｜ '))
  // 只在真的能走出一段时才提"通达"，否则不提（省字）
  const far = rr.filter((r) => r.steps >= 2).sort((a, b) => b.steps - a.steps)
  if (far.length) {
    lines.push(`🚶 能自己走到：${far.map((r) => `${r.label} ${r.steps} 格`).join(' · ')}（共 ${map.nav?.reachable ?? 0} 格，不用挖不用垫）`)
  }
  return lines
}
