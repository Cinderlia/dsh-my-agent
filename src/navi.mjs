/* ============================================================================
 * navi —— **异步导航工具**（2026-10-24 用户定义的"工具"形态）
 * ----------------------------------------------------------------------------
 * 与 `mc_move` 的根本区别：
 *   · `mc_move` 是**同步**工具：一次调用最多 10 秒，走到哪算哪，agent 得反复叫；
 *   · `mc_navi` 是**异步**工具：调用时只做**规划**并立刻返回报告（路线、策略、要几块方块），
 *     然后后台自己走；走完/走挂了**主动**给 agent 发一条报告。中间不占 agent。
 *
 * 规划阶段（同步，几十毫秒）：
 *   ① 解析目标（坐标 / 玩家身边 4 格内最近的可站立点）；
 *   ② 半径上限 16 格（用户定的：太大了就该用 mc_task 分几步）；
 *   ③ 按**游戏模式**自适应（不给 LLM 添麻烦）：
 *        creative  → 直接飞（不寻路、不搭方块）
 *        spectator → 直线飞（可以穿墙）
 *        survival  → pathfinder + 允许搭方块 / 挖穿（背包里有石头木板才搭）
 *        adventure → pathfinder，**不许搭、不许挖**，只能绕和跳
 *   ④ 用 pathfinder 的 `getPathTo` 只**算**不**走**，把节点数 / 成本 / 要垫几块报出来。
 *
 * 执行阶段（后台）：飞 / 寻路，带超时与取消；结束回调 `onDone`。
 * ========================================================================== */
import Vec3 from 'vec3'
import { canStandAtWorld, standableY, setFlyingAbilities } from './movement.mjs'
import { isAir, isLiquid, isPassable } from './block-names.mjs'

/**
 * 取 `GoalBlock`：**不能静态 import**（pathfinder 是可选 vendor 依赖，没装时
 * 静态 import 会让整个插件加载失败 —— 和 `ensureMineflayer` 同一个道理）。
 * 模块缓存挂在 `self._pf`（见 `src/plugins.mjs` 的 `setupPathfinder`）。
 */
function goalBlockOf (self, x, y, z) {
  /* 🔴 pathfinder 的导出是**小写** `goals`（`module.exports = { pathfinder, Movements, goals }`），
   *    写成 `Goals` 会永远拿不到 —— 症状是每次 navi 都报「pathfinder 没挂上 Goals」。
   *    这里两种都认，再兜一层 default。 */
  const mod = self?._pf ?? null
  const Goals = mod?.goals ?? mod?.Goals ?? mod?.default?.goals ?? mod?.default?.Goals ?? null
  const GoalBlock = Goals?.GoalBlock
  if (typeof GoalBlock !== 'function') return null
  return new GoalBlock(x, y, z)
}

/** 用户定的半径上限：16 格 */
export const NAVI_RADIUS = 16
/** 找玩家落脚点时往周围找几圈 */
export const NAVI_PLAYER_SHELL = 4
/** 后台最长走多久（超过就认输，报告里说清楚） */
export const NAVI_TIMEOUT_MS = 120_000
/** 飞行时每拍多久校正一次 */
const FLY_TICK_MS = 50
const FLY_SPEED = 0.45

/** 搭路用的方块：和 pathfinder 实际会用的那一套保持一致（`scaffoldingItemIds` 是唯一判据） */
import { scaffoldingItemIds } from './place-items.mjs'

/** 当前游戏模式（读本地镜像；读不到按 survival 处理 —— 最保守的那档） */
export function naviModeOf (b) {
  const gm = String(b?.game?.gameMode ?? '').toLowerCase()
  if (gm === 'creative' || gm === 'spectator' || gm === 'adventure') return gm
  return 'survival'
}

/** 背包里能拿来垫脚的方块总数 */
export function scaffoldStock (b) {
  try {
    const ids = new Set(scaffoldingItemIds(b))          // 整方块、排除火把/门/半砖/家当
    let n = 0
    for (const it of b.inventory.items()) {
      if (it && ids.has(it.type)) n += it.count
    }
    return n
  } catch { return 0 }
}

/**
 * 玩家当作目标时：在他周围 `NAVI_PLAYER_SHELL` 格内找**能站**的格子，取离玩家最近的那个。
 * @returns {{ok:boolean, x?:number, y?:number, z?:number, name?:string, distance?:number, why?:string}}
 */
export function playerSpot (b, who) {
  const me = b?.entity?.position
  if (!me) return { ok: false, why: '我还没有位置（区块没加载完）' }
  const name = String(who ?? '').trim()
  if (!name) return { ok: false, why: '要指定玩家名' }
  let target = null
  for (const e of Object.values(b.entities ?? {})) {
    if (!e || e === b.entity) continue
    const nm = String(e.username ?? e.name ?? '')
    if (nm !== name && !nm.includes(name)) continue
    if (!e.position) continue
    if (me.distanceTo(e.position) > 64) continue
    target = e
    break
  }
  if (!target) return { ok: false, why: `64 格内找不到玩家「${name}」` }

  const p = target.position.floored()
  const cands = []
  for (let dx = -NAVI_PLAYER_SHELL; dx <= NAVI_PLAYER_SHELL; dx++) {
    for (let dz = -NAVI_PLAYER_SHELL; dz <= NAVI_PLAYER_SHELL; dz++) {
      if (dx === 0 && dz === 0) continue
      const d = Math.hypot(dx, dz)
      if (d > NAVI_PLAYER_SHELL) continue
      for (let dy = -2; dy <= 2; dy++) {
        const gx = p.x + dx; const gy = p.y + dy; const gz = p.z + dz
        if (!canStandAtWorld(b, gx, gy, gz)) continue
        cands.push({ x: gx, y: gy, z: gz, d })
        break                                  // 同一列只取最合适的那个 y
      }
    }
  }
  if (!cands.length) {
    return { ok: false, why: `玩家「${name}」周围 ${NAVI_PLAYER_SHELL} 格内没有能站的格子（悬空/被方块占满/区块没加载）` }
  }
  cands.sort((a, c) => a.d - c.d)
  const best = cands[0]
  return { ok: true, x: best.x, y: best.y, z: best.z, name: target.username ?? target.name ?? name, distance: Math.round(best.d * 10) / 10, candidates: cands.length }
}

/** 目标格不能站时，就近找一格能站的（≤2 格内）；找不到就原样返回（让寻路自己报没路） */
export function snapToStandable (b, x, y, z) {
  if (canStandAtWorld(b, x, y, z)) return { x, y, z, snapped: false }
  for (let r = 1; r <= 2; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dy = -2; dy <= 2; dy++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r && dy !== -r && dy !== r) continue
          const gx = x + dx; const gy = y + dy; const gz = z + dz
          if (canStandAtWorld(b, gx, gy, gz)) return { x: gx, y: gy, z: gz, snapped: true, from: { x, y, z } }
        }
      }
    }
  }
  return { x, y, z, snapped: false, notStandable: true }
}

/**
 * 规划（同步）：解析目标 + 定策略。**不执行**。
 * @returns {{ok:false, why:string} | {ok:true, ...}}
 */
export function buildNaviPlan (self, args = {}) {
  const b = self?.bot
  if (!b?.entity?.position) return { ok: false, why: '我还没有位置（区块没加载完或没连上）' }
  const mode = naviModeOf(b)
  const radius = Math.min(Math.max(Number(args.radius ?? NAVI_RADIUS), 1), NAVI_RADIUS)

  // ① 目标
  let target = null
  let targetSource = 'coords'
  if (args.player) {
    const spot = playerSpot(b, args.player)
    if (!spot.ok) return { ok: false, why: spot.why }
    target = { x: spot.x, y: spot.y, z: spot.z }
    targetSource = 'player'
  } else {
    const x = Number(args.x); const y = Number(args.y); const z = Number(args.z)
    if (![x, y, z].every(Number.isFinite)) return { ok: false, why: '要给坐标 x/y/z，或者给 player（玩家名）' }
    target = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
  }

  // ② 半径（以**我的位置**为圆心）
  const me = b.entity.position
  const dist = Math.hypot(target.x + 0.5 - me.x, target.y - me.y, target.z + 0.5 - me.z)
  if (dist > radius + 0.01) {
    return { ok: false, why: `目标 ${dist.toFixed(1)} 格，超出 navi 半径上限 ${radius} 格（再远请分几步，或用 mc_task 记进度）` }
  }

  // ③ 落脚点修正
  const spot = snapToStandable(b, target.x, target.y, target.z)
  target = { x: spot.x, y: spot.y, z: spot.z }

  // ④ 策略（按游戏模式）
  const stock = scaffoldStock(b)
  let strategy = 'path'
  if (mode === 'creative') strategy = 'fly'
  else if (mode === 'spectator') strategy = 'fly-through'
  const canPlace = mode === 'survival' && stock > 0
  const canDig = mode === 'survival'
  /* 飞行模式：真的算一条 3D 路线（用户 2026-10-24：「没规划，就是笔直飞」）
   * —— 创造模式不能穿方块，直线撞墙会卡住；这里按方块世界绕行/爬升。 */
  let flight = null
  if (strategy === 'fly' || strategy === 'fly-through') {
    flight = planFlight(b, me, target, { padding: 4 })
  }
  return {
    ok: true,
    target,
    targetSource,
    ...(targetSource === 'player' ? { player: args.player } : {}),
    mode,
    strategy,
    distance: Math.round(dist * 10) / 10,
    radius,
    ...(spot.snapped ? { snappedFrom: spot.from } : {}),
    ...(spot.notStandable ? { notStandable: true } : {}),
    ...(flight ? { flight } : {}),
    scaffold: { stock, canPlace },
    canDig,
    parkour: args.parkour !== false,   // 用户：允许跑酷；效果不好就只走搭路（传 parkour:false）
  }
}

/**
 * 预览路线（**只算不走**）。用 pathfinder 的 `getPathTo`；飞行模式不用算路径。
 * 超时 1.5 秒内算不出来就报"没算出来"（照样可以执行，执行时再试）。
 */
export function previewRoute (self, plan, { movements: mv = null } = {}) {
  const b = self?.bot
  const pf = b?.pathfinder
  if (!plan?.ok) return { route: null }
  if (plan.strategy !== 'path') {
    const f = plan.flight
    if (f?.ok) {
      return {
        route: {
          kind: 'fly', nodes: f.nodes, waypoints: f.waypoints.length,
          length: f.length, detour: f.detour, climb: f.climb, ms: f.ms,
          note: plan.strategy === 'fly' ? '创造模式：3D 飞行路线（绕开实心方块）' : '旁观模式：3D 路线（可穿墙）',
        },
      }
    }
    return {
      route: { kind: 'fly', direct: true, nodes: 1, note: '没算出飞行路线 → 退回直线（可能卡住）' },
      routeError: f?.why ?? '没有飞行规划结果',
    }
  }
  if (!pf || typeof pf.getPathTo !== 'function') {
    return { route: null, routeError: '没有可用的 pathfinder（装 mineflayer-pathfinder，见 PATHFINDER.md）' }
  }
  if (!mv) return { route: null, routeError: '拿不到 Movements 配置（pathfinder 还没挂上？）' }
  const goal = goalBlockOf(self, plan.target.x, plan.target.y, plan.target.z)
  if (!goal) return { route: null, routeError: 'pathfinder 没挂上 Goals（先 mc_move 一次让它初始化）' }
  const t0 = Date.now()
  try {
    const path = pf.getPathTo(mv, goal, 1500)
    const ms = Date.now() - t0
    if (!path || path.status === 'noPath' || !Array.isArray(path.path)) {
      return { route: { kind: 'path', status: path?.status ?? 'unknown', nodes: 0, ms }, routeError: '没有可行路径（可能被墙/水/悬崖隔开，或超出加载范围）' }
    }
    const nodes = path.path.length
    // 要垫几块：pathfinder 会在 steps 里标 toPlace
    let place = 0
    for (const s of path.path) if (s?.toPlace) place += 1
    return {
      route: {
        kind: 'path', status: path.status ?? 'ok', nodes,
        cost: Number.isFinite(path.cost) ? Math.round(path.cost * 10) / 10 : null,
        placeBlocks: place, ms,
        length: Math.round(path.cost ?? nodes * 1.2),
      },
    }
  } catch (e) {
    return { route: null, routeError: `算路径出错：${e?.message ?? e}` }
  }
}

/**
 * **3D 飞行规划**（创造/旁观用）：A* 在 26 邻域栅格上找一条"能飞过去"的航点序列。
 *
 * 为什么不能直接直线飞（用户 2026-10-24 指出的问题）：
 *   创造模式虽然能飞，但**不能穿方块** —— 直线撞墙就卡住，或者得靠服务端把位置拉回来。
 *   所以要用方块世界算：哪些格能过（空气/可穿方块）、绕多远、要先爬多高。
 *   旁观模式能穿墙，但保持同一条路径也无害（更稳）。
 *
 * @returns {{ok:boolean, waypoints?:Array, nodes?:number, length?:number, climb?:number, detour?:number, why?:string, ms:number}}
 */
export function planFlight (b, from, to, { padding = 4, maxNodes = 30000 } = {}) {
  const t0 = Date.now()
  const start = { x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) }
  const goal = { x: Math.floor(to.x), y: Math.floor(to.y) + 1, z: Math.floor(to.z) }
  const lo = {
    x: Math.min(start.x, goal.x) - padding,
    y: Math.min(start.y, goal.y) - padding,
    z: Math.min(start.z, goal.z) - padding,
  }
  const hi = {
    x: Math.max(start.x, goal.x) + padding,
    y: Math.max(start.y, goal.y) + padding,
    z: Math.max(start.z, goal.z) + padding,
  }
  const vol = (hi.x - lo.x + 1) * (hi.y - lo.y + 1) * (hi.z - lo.z + 1)
  if (vol > 300_000) return { ok: false, why: `搜索空间太大（${vol} 格）`, ms: Date.now() - t0 }

  const key = (x, y, z) => `${x},${y},${z}`
  /** 这一格能不能飞过去（空气 / 可穿方块 / 液体） */
  const passable = (x, y, z) => {
    const blk = b.blockAt(new Vec3(x, y, z))
    if (!blk) return false                       // 没加载 = 不知道，别飞
    if (isAir(blk.name) || isLiquid(blk.name)) return true
    return isPassable(blk.name)
  }
  /** 贴墙惩罚：周围实心越多越贵（贴着墙飞容易擦碰、也容易撞头） */
  const wallCost = (x, y, z) => {
    let n = 0
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      if (!passable(x + dx, y + dy, z + dz)) n++
    }
    return n * 0.25
  }
  /** 26 邻域 */
  const DIRS = []
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    if (dx || dy || dz) DIRS.push([dx, dy, dz, Math.hypot(dx, dy, dz)])
  }

  if (!passable(start.x, start.y, start.z)) return { ok: false, why: `我所在那格飞不出去（${b.blockAt(new Vec3(start.x, start.y, start.z))?.name ?? '未加载'}）`, ms: Date.now() - t0 }

  const h = (x, y, z) => Math.hypot(x - goal.x, y - goal.y, z - goal.z)
  const open = []                                  // 简单二叉堆够用（节点少）
  const push = (n) => {
    open.push(n)
    let i = open.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (open[p].f <= open[i].f) break
      ;[open[p], open[i]] = [open[i], open[p]]
      i = p
    }
  }
  const pop = () => {
    const top = open[0]
    const last = open.pop()
    if (open.length) {
      open[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1; const r = l + 1
        let m = i
        if (l < open.length && open[l].f < open[m].f) m = l
        if (r < open.length && open[r].f < open[m].f) m = r
        if (m === i) break
        ;[open[m], open[i]] = [open[i], open[m]]
        i = m
      }
    }
    return top
  }

  const gScore = new Map()
  const came = new Map()
  const startKey = key(start.x, start.y, start.z)
  gScore.set(startKey, 0)
  push({ x: start.x, y: start.y, z: start.z, f: h(start.x, start.y, start.z) })
  let expanded = 0
  let found = false
  while (open.length && expanded < maxNodes) {
    const cur = pop()
    const ck = key(cur.x, cur.y, cur.z)
    const g0 = gScore.get(ck)
    if (g0 === undefined || cur.f > g0 + h(cur.x, cur.y, cur.z) + 1e-9) continue
    expanded++
    if (cur.x === goal.x && cur.y === goal.y && cur.z === goal.z) { found = true; break }
    for (const [dx, dy, dz, cost] of DIRS) {
      const nx = cur.x + dx; const ny = cur.y + dy; const nz = cur.z + dz
      if (nx < lo.x || nx > hi.x || ny < lo.y || ny > hi.y || nz < lo.z || nz > hi.z) continue
      if (!passable(nx, ny, nz)) continue
      const nk = key(nx, ny, nz)
      const ng = g0 + cost + wallCost(nx, ny, nz)
      if (ng < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, ng)
        came.set(nk, ck)
        push({ x: nx, y: ny, z: nz, f: ng + h(nx, ny, nz) })
      }
    }
  }
  if (!found) {
    return { ok: false, why: `没有可飞路线（搜了 ${expanded} 个格${expanded >= maxNodes ? '，到上限了' : ''}）`, ms: Date.now() - t0, nodes: expanded }
  }
  // 回溯 + 简化（同方向的点合并）
  const raw = []
  let k = key(goal.x, goal.y, goal.z)
  while (k) {
    const [x, y, z] = k.split(',').map(Number)
    raw.push({ x, y, z })
    k = came.get(k)
  }
  raw.reverse()
  const waypoints = []
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]
    const b2 = raw[i + 1]
    const c = raw[i + 2]
    if (c && b2) {
      const d1 = { x: b2.x - a.x, y: b2.y - a.y, z: b2.z - a.z }
      const d2 = { x: c.x - b2.x, y: c.y - b2.y, z: c.z - b2.z }
      if (d1.x === d2.x && d1.y === d2.y && d1.z === d2.z) continue
    }
    waypoints.push(a)
  }
  let length = 0
  let climb = 0
  for (let i = 1; i < raw.length; i++) {
    length += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y, raw[i].z - raw[i - 1].z)
    climb = Math.max(climb, raw[i].y - start.y)
  }
  const straight = Math.hypot(goal.x - start.x, goal.y - start.y, goal.z - start.z)
  return {
    ok: true,
    waypoints,
    nodes: raw.length,
    length: Math.round(length * 10) / 10,
    detour: Math.round((length - straight) * 10) / 10,
    climb: Math.round(climb * 10) / 10,
    expanded,
    ms: Date.now() - t0,
  }
}

/**
 * 按航点飞（创造/旁观）。每段用 `creative.flyTo`（0.5 格/50ms，比控制位快 3 倍），
 * 单段带超时；整条路径失败就抛错（由 jobs 变成失败报告）。
 */
async function flyWaypoints (b, waypoints, { signal = null, timeoutMs = NAVI_TIMEOUT_MS } = {}) {
  const t0 = Date.now()
  const remaining = () => timeoutMs - (Date.now() - t0)
  for (const wp of waypoints) {
    if (signal?.aborted) throw new Error('被取消')
    if (remaining() <= 0) throw new Error(`飞行超时（${Math.round(timeoutMs / 1000)} 秒）`)
    const dest = new Vec3(wp.x + 0.5, wp.y, wp.z + 0.5)
    const me = b.entity?.position
    if (!me) throw new Error('掉线了')
    const d = me.distanceTo(dest)
    if (d < 0.6) continue
    if (typeof b.creative?.flyTo === 'function') {
      const g0 = b.physics?.gravity
      try {
        await Promise.race([
          b.creative.flyTo(dest),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`航点 (${wp.x},${wp.y},${wp.z}) 飞不到`)), Math.min(15_000, Math.max(3_000, d * 1_200)))),
        ])
      } finally {
        if (b.physics && Number.isFinite(g0)) b.physics.gravity = g0
      }
    } else {
      // 没 creative 插件：控制位逐步逼近（旁观模式仍可飞）
      setFlyingAbilities(b, true)
      while (meNow(b).distanceTo(dest) > 1.1) {
        if (signal?.aborted) throw new Error('被取消')
        if (remaining() <= 0) throw new Error('飞行超时')
        const p = meNow(b)
        const dx = dest.x - p.x; const dy = dest.y - p.y; const dz = dest.z - p.z
        b.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)), true)
        b.setControlState('forward', true)
        b.setControlState('jump', dy > 0.6)
        b.setControlState('sneak', dy < -0.6)
        await new Promise((r) => setTimeout(r, FLY_TICK_MS))
      }
      b.setControlState('forward', false); b.setControlState('jump', false); b.setControlState('sneak', false)
    }
  }
  return { ms: Date.now() - t0 }
}

const meNow = (b) => {
  const p = b.entity?.position
  if (!p) throw new Error('掉线了（没有位置）')
  return p
}

/** 飞过去（creative / spectator）：**先按航点规划飞**，没有规划时才退回直线 */
async function flyTo (b, target, { signal = null, timeoutMs = NAVI_TIMEOUT_MS, flight = null } = {}) {
  if (flight?.waypoints?.length) {
    const r = await flyWaypoints(b, flight.waypoints, { signal, timeoutMs })
    return { arrived: true, ms: r.ms, via: 'flight-path' }
  }
  const dest = new Vec3(target.x + 0.5, target.y + 1.6, target.z + 0.5)
  const t0 = Date.now()
  const release = () => {
    b.setControlState('forward', false)
    b.setControlState('jump', false)
    b.setControlState('sneak', false)
  }
  /* ① 官方 `flyTo`：改本地位置 + 发 move，不靠控制位。
   *    🔴 实测（2026-10-24）：创造模式下只写 `forward`/`jump` **推不动** ——
   *    mineflayer 的 physics 不把控制位当"飞"，位置一格不变。 */
  if (typeof b.creative?.flyTo === 'function') {
    const g0 = b.physics?.gravity
    let timer = null
    try {
      const flying = b.creative.flyTo(dest)
      const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`飞行超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs)
      })
      const abort = new Promise((_, rej) => {
        if (!signal) return
        if (signal.aborted) rej(new Error('被取消'))
        signal.addEventListener?.('abort', () => rej(new Error('被取消')), { once: true })
      })
      await Promise.race([flying, timeout, abort])
      return { arrived: true, ms: Date.now() - t0, moved: b.entity?.position?.distanceTo(dest) ?? 0, via: 'creative.flyTo' }
    } catch (e) {
      if (signal?.aborted) throw e
      if (String(e?.message ?? '').includes('超时')) throw e
      // 其它失败 → 落到控制位方案再试一次
    } finally {
      clearTimeout(timer)
      if (b.physics && Number.isFinite(g0)) b.physics.gravity = g0
    }
  }
  /* ② 兜底：写控制位 + 朝向（旁观/没有 creative 插件时） */
  setFlyingAbilities(b, true)
  try {
    while (Date.now() - t0 < timeoutMs) {
      if (signal?.aborted) throw new Error('被取消')
      const me = b.entity?.position
      if (!me) throw new Error('掉线了（没有位置）')
      const d = me.distanceTo(dest)
      if (d < 1.1) return { arrived: true, ms: Date.now() - t0, moved: d, via: 'controls' }
      const dx = dest.x - me.x; const dy = dest.y - me.y; const dz = dest.z - me.z
      b.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)), true)
      b.setControlState('forward', d > 1.5)
      b.setControlState('jump', dy > 0.6)
      b.setControlState('sneak', dy < -0.6)
      await new Promise((r) => setTimeout(r, FLY_TICK_MS))
    }
  } finally { release() }
  throw new Error(`飞了 ${Math.round((Date.now() - t0) / 1000)} 秒还没到（可能被挡住/掉线/区块没加载）`)
}

/**
 * 执行（后台调用）。走完/失败都抛或返回结构化结果，由调用方注入报告。
 * @returns {Promise<{ok:boolean, moved:number, ms:number, text:string}>}
 */
export async function runNavi (self, plan, { signal = null, onProgress = null, movements: mv = null } = {}) {
  const b = self?.bot
  const t0 = Date.now()
  if (!b?.entity) throw new Error('执行时已经掉线了')
  if (plan.strategy === 'fly' || plan.strategy === 'fly-through') {
    const r = await flyTo(b, plan.target, { signal, flight: plan.flight })
    const via = r.via === 'flight-path' ? `${plan.flight?.waypoints?.length ?? '?'} 个航点` : '直线'
    return { ok: true, moved: plan.distance, ms: r.ms, mode: plan.strategy, via: r.via ?? null, text: `飞行到达（${(r.ms / 1000).toFixed(1)} 秒，${via}）` }
  }
  if (plan.strategy === 'path') {
    const pf = b.pathfinder
    if (!pf || typeof pf.goto !== 'function') throw new Error('没有可用的 pathfinder')
    const goal = goalBlockOf(self, plan.target.x, plan.target.y, plan.target.z)
    if (!goal) throw new Error('pathfinder 没挂上 Goals')
    /* 按游戏模式改寻路规则（本地自适应，不麻烦 LLM）：
     *   · 冒险模式：**不许搭、不许挖** —— 只能绕路和跳；
     *   · 生存模式但背包没方块：也不许搭（搭不了）；挖穿仍允许。 */
    if (mv) {
      /* 🔴 三条都必须设：
       *   ① scafoldingBlocks 由 `plugins.mjs` 的 `scaffoldingItemIds()` 给（**item id**，
       *      不是 block id —— 传错会得到 `noPath, nodes=0`，实测踩过）；
       *   ② 冒险模式禁搭禁挖；
       *   ③ `setMovements(mv)`：`getPathTo(mv)` 只是预览，`goto()` 用的是内部 movements ——
       *      不 set 的症状是「规划 success、执行 0.1 秒结束、人没动」（实测踩过）。
       *   跑酷默认开，`parkour:false` 时只走搭路。 */
      if (!plan.canPlace) mv.scafoldingBlocks = []
      if (!plan.canDig) { mv.canDig = false; mv.canPlace = false }
      mv.allowParkour = plan.parkour !== false
      try { pf.setMovements(mv) } catch { /* 老版本没有 setMovements 就用默认 */ }
    }
    let done = false
    const timer = setTimeout(() => { if (!done) { try { pf.stop?.() } catch {} } }, NAVI_TIMEOUT_MS)
    try {
      await pf.goto(goal)
      done = true
      const me = b.entity?.position
      const arrived = me && Math.hypot(me.x - (plan.target.x + 0.5), me.z - (plan.target.z + 0.5)) < 2.2
      return { ok: Boolean(arrived), moved: plan.distance, ms: Date.now() - t0, mode: 'path', text: arrived ? '已走到目标附近' : '寻路结束但没到目标 2 格内' }
    } finally { clearTimeout(timer) }
  }
  throw new Error(`未知策略 ${plan.strategy}`)
}

/** 一句话报告（给工具返回与完成通知共用） */
export function naviReportText (plan, route, jobId, { started = true, position = null } = {}) {
  if (!plan?.ok) return `❌ 没能规划：${plan?.why ?? '未知原因'}`
  const lines = []
  const t = plan.target
  lines.push(`🧭 目标 (${t.x}, ${t.y}, ${t.z})${plan.player ? `（玩家 ${plan.player} 身边）` : ''}｜模式 ${plan.mode}｜策略 ${plan.strategy}`)
  lines.push(`📏 直线 ${plan.distance} 格${plan.snappedFrom ? `（原坐标不可站，已就近挪到可站格）` : ''}${plan.notStandable ? '（⚠️ 目标格本身不可站）' : ''}`)
  if (route) {
    if (route.kind === 'fly') lines.push(`✈️ ${route.note ?? '直接飞'}`)
    else lines.push(`🛣 路线：${route.nodes} 节点 / 成本 ${route.cost ?? '?'} / 要垫 ${route.placeBlocks ?? 0} 块（${route.ms}ms 算完）`)
  }
  if (plan.scaffold) lines.push(`🧱 可垫方块 ${plan.scaffold.stock} 个${plan.scaffold.canPlace ? '（够用就搭过去）' : '（没有 → 只能绕/跳）'}${plan.canDig ? '｜可挖穿挡路' : '｜不可挖'}`)
  if (jobId) lines.push(started
    ? `▶ 已在后台执行（job ${jobId}）——**你不用等**，走完会有一条报告`
    : `⏳ 已排进队列第 ${position ?? '?'} 位（job ${jobId}）——轮到它会自动跑，队列非空时主动工具会被收起`)
  return lines.join('\n')
}
