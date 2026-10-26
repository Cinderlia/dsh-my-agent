/* ============================================================================
 * stuck-guard —— 被卡在方块里就自救（用户 2026-10-26）
 * ----------------------------------------------------------------------------
 * 判定：**玩家头部所在的那一格**有实体方块 ⇒ 卡住了。
 *   （头部高度 = 脚底 + 1.62，所以头部格大致就是脚底格 + 1；
 *     台阶/床/船这类半砖模型用 boundingBox 判定，只认 'block' 的实心方块。）
 * 自救：传到**上方最近**的一个「脚下一格是实心方块、脚和头都是空气」的位置。
 *   搜索顺序：同一列从头部往上 → 再按水平半径 1..3 的两圈里各列往上扫，
 *   全都按"离玩家多远"排序取最近。
 * 通知：触发（判定卡住那一刻）、传走（成功）、传不走（失败/没权限）各发一条。
 * 防误判：同一个卡住状态要连续确认 CONFIRM 次（默认 2 次 ≈ 1 秒）才动手；
 *        传走之后 3 秒冷却，避免来回抖。
 * ========================================================================== */

import { Vec3 } from 'vec3'

/** 两次检测间隔 */
const TICK_MS = 500
/** 连续几次判成"卡住"才动手（防抖：放置/骑乘时可能一瞬间重叠） */
const CONFIRM = 2
/** 传走之后的冷却 */
const COOLDOWN_MS = 3000
/** 水平搜索半径（列） */
const H_RADIUS = 3
/** 往上找多高 */
const UP_MAX = 24

/** 这一格是实心方块吗（空气/水/草/火把都不算） */
function isSolid (b, pos) {
  try {
    const blk = b.blockAt(pos)
    if (!blk) return false
    if (blk.boundingBox !== 'block') return false
    /* 极少数名字误判兜底 */
    if (/^(air|cave_air|void_air|water|lava|fire|short_grass|tall_grass|fern|torch|wall_torch|soul_torch|vine|scaffolding|light|structure_void)$/.test(blk.name)) return false
    return true
  } catch { return false }
}

function isAir (b, pos) {
  try {
    const blk = b.blockAt(pos)
    if (!blk) return false
    return blk.boundingBox === 'empty'
  } catch { return false }
}

/** 头部所在的那一格（脚底 + 1.62 取整） */
export function headBlockPos (b) {
  const p = b?.entity?.position
  if (!p) return null
  return new Vec3(Math.floor(p.x), Math.floor(p.y + 1.62), Math.floor(p.z))
}

/** 卡住了吗 */
export function isStuckInBlock (b) {
  const head = headBlockPos(b)
  if (!head) return { stuck: false, why: '读不到坐标' }
  const solid = isSolid(b, head)
  let name = null
  try { name = b.blockAt(head)?.name ?? null } catch { /* ignore */ }
  return { stuck: solid, head, block: name }
}

/**
 * 找"上方最近的可站位置"：脚下实心、脚和头两格空气。
 * @returns {{x,y,z}|null} y 是**脚底**格的 y
 */
export function findUnstuckSpot (b, opts = {}) {
  const p = b?.entity?.position
  if (!p) return null
  const ox = Math.floor(p.x)
  const oy = Math.floor(p.y)
  const oz = Math.floor(p.z)
  const hRadius = opts.hRadius ?? H_RADIUS
  const upMax = opts.upMax ?? UP_MAX

  const free = (x, y, z) => {
    const feet = new Vec3(x, y, z)
    const head = new Vec3(x, y + 1, z)
    const floor = new Vec3(x, y - 1, z)
    return isSolid(b, floor) && isAir(b, feet) && isAir(b, head)
  }

  let best = null
  let bestD = Infinity
  /* 只从"当前脚底 - 1"开始往上扫：脚底下面那一层是地面，不用找 */
  for (let dy = -1; dy <= upMax; dy++) {
    const y = oy + dy
    for (let dx = -hRadius; dx <= hRadius; dx++) {
      for (let dz = -hRadius; dz <= hRadius; dz++) {
        /* 水平半径按切比雪夫限制，够用且快 */
        if (Math.max(Math.abs(dx), Math.abs(dz)) > hRadius) continue
        const sq = dx * dx + dz * dz + (dy + 1) * (dy + 1)
        if (sq >= bestD) continue
        if (!free(ox + dx, y, oz + dz)) continue
        bestD = sq
        best = { x: ox + dx, y, z: oz + dz }
      }
    }
    /* 同一高度找到过就不必再往上（"上方最近"）——但先把整层扫完 */
    if (best && best.y === y) break
  }
  return best
}

/** 发 tp 指令（内部用；本插件不给 agent 开 tp 白名单，这里直接发包） */
async function doTp (b, spot) {
  const x = spot.x + 0.5
  const y = spot.y
  const z = spot.z + 0.5
  /* ⚠️ 不带玩家名：`/tp <名字> x y z` 和 `/tp x y z` 在服务端不是一回事，
     省略名字才是"传我自己"，也省得名字解析出错。 */
  b.chat(`/tp ${x.toFixed(1)} ${y} ${z.toFixed(1)}`)
  /* 等一小会儿看有没有挪过去（有权限才会生效） */
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 120))
    const p = b.entity?.position
    if (!p) break
    if (Math.abs(p.x - x) < 1.0 && Math.abs(p.z - z) < 1.0 && Math.abs(p.y - y) < 1.5) return true
  }
  return false
}

/**
 * 启动"卡方块自救"。返回 { stop }。
 * @param {{bot}} self
 * @param {{report?, log?, tp?}} ctx
 *   report 通知（走 jobBoard.inject），log 调试日志，tp 自定义传送实现（默认发 /tp 指令）
 */
export function startStuckGuard (self, ctx = {}) {
  const { report = () => {}, log = () => {} } = ctx
  let stopped = false
  let hits = 0
  let cooldownUntil = 0
  let busy = false
  let lastHeadKey = null
  let lastFired = 0

  const tick = async () => {
    if (stopped || busy) return
    const b = self?.bot
    if (!b?.entity || !b.username) return
    busy = true
    try {
      const now = Date.now()
      if (now < cooldownUntil) { hits = 0; return }
      const st = isStuckInBlock(b)
      if (!st.stuck) { hits = 0; lastHeadKey = null; return }

      const key = `${st.head.x},${st.head.y},${st.head.z}`
      if (key !== lastHeadKey) { hits = 0; lastHeadKey = key }
      hits += 1
      log(`检测到头部落进方块：${st.block ?? '?'} @ ${key}（第 ${hits}/${CONFIRM} 次）`)
      if (hits < CONFIRM) return
      /* 同一个头位置 8 秒内只处理一次，免得传不走时刷屏 */
      if (now - lastFired < 8000) return
      lastFired = now

      const spot = findUnstuckSpot(b)
      if (!spot) {
        report(`🪨 卡在方块里（头在 ${st.block ?? '方块'} ${key}），但方圆 ${H_RADIUS} 格以内找不到落脚点，没法自救 —— 需要人工介入。`)
        log('找不到落脚点，放弃自救')
        return
      }
      const from = b.entity.position.clone()
      report(`🪨 检测到卡进方块（头在 ${st.block ?? '方块'} @ ${key}），尝试传送到上方最近的可站位置 ${spot.x},${spot.y},${spot.z}…`)
      const ok = await doTp(b, spot)
      cooldownUntil = Date.now() + COOLDOWN_MS
      hits = 0
      if (ok) {
        report(`✅ 已从 (${from.x.toFixed(1)},${from.y.toFixed(1)},${from.z.toFixed(1)}) 传送到 (${spot.x},${spot.y},${spot.z})，脱离卡死。`)
        log(`自救成功 → ${spot.x},${spot.y},${spot.z}`)
      } else {
        report(`❌ 传送到 (${spot.x},${spot.y},${spot.z}) 没有生效 —— 多半是没有 /tp 权限（需要 OP）。卡住状态还在，先别让它干别的。`)
        log('tp 未生效（可能无权限）')
      }
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => { void tick() }, TICK_MS)
  if (typeof timer.unref === 'function') timer.unref()

  return {
    stop: () => { stopped = true; clearInterval(timer) },
    /** 手动查一次（自检用） */
    check: () => isStuckInBlock(self?.bot),
    findSpot: () => findUnstuckSpot(self?.bot),
  }
}
