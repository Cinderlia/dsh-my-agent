/* ============================================================================
 * 原语层（primitives）—— 2026-10-24 底层架构重构第一步
 * ----------------------------------------------------------------------------
 * **原语 vs 工具**（用户定义）：
 *   · 原语：agent 直接控制的细粒度操作。**只改本地状态**（控制位 / 朝向 / 发送一个包），
 *           **没有延迟、立即返回**，不 await 世界反馈，不排队、不占 11 秒调用预算。
 *   · 工具：本地脚本，接输入自己把活干完（寻路、挖一片、合成、建造……）。
 *
 * 所以这里的每个原语都必须满足：
 *   ① 不调 pathfinder / collectblock / 任何"跑一段"的东西；
 *   ② 不等到方块变化、不等到实体受击；
 *   ③ 返回值 = **本地镜像**（我现在的状态 / 我发出的动作），不是"世界已确认"；
 *   ④ 粒度 = 一个动作（一次转头、一次按键、一次挥手、一次交互）。
 *
 * 分工：`mc_act`（复合身体操作）与 `mc_move`（寻路）保持原样不动；
 *      原语是给 agent 补上"自己控制身体"的那一层，不是替换它们。
 * ========================================================================== */
import { bagWarning } from './scaffold.mjs'
import Vec3 from 'vec3'
import { entitiesNear } from './world-scan.mjs'
import { aimAt, lookAnglesTo } from './camera.mjs'
import { isAir } from './block-names.mjs'

/** 控制位（`bot.setControlState` 的键）—— 只允许这几个，避免拼错静默无效 */
export const CONTROL_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']

/** 半径上限：原语要快，别让一次调用扫穿整个世界 */
const MAX_BLOCK_R = 16
const MAX_BLOCK_VOLUME = 8192

const num = (v, d = null) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
const int = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : null
}
const pt = (v) => {
  const p = v && typeof v === 'object' ? v : null
  if (!p) return null
  const x = num(p.x); const y = num(p.y); const z = num(p.z)
  return x === null || y === null || z === null ? null : { x, y, z }
}
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d
const posOf = (p) => p ? { x: round(p.x), y: round(p.y), z: round(p.z) } : null

/** 背包摘要（折叠 `mc_self` 的能力：名字 × 数量 + 空位数 + 手持） */
export function inventorySummary (b) {
  const items = []
  let used = 0
  try {
    for (const it of b.inventory.items()) {
      if (!it) continue
      used += 1
      items.push({ name: it.name, count: it.count, slot: it.slot })
    }
  } catch { /* 没连接就没有背包 */ }
  items.sort((a, c) => c.count - a.count || a.name.localeCompare(c.name))
  const held = b.heldItem ? { name: b.heldItem.name, count: b.heldItem.count } : null
  return { held, stacks: items, usedSlots: used, freeSlots: Math.max(0, 36 - used) }
}

/** 脚下实心块 + 头顶净空（原语里最常用的两条落地判断） */
export function footingOf (b) {
  const p = b.entity?.position
  if (!p) return { feet: null, ground: null, headroom: null, canJump: null }
  const feet = p.floored()
  let ground = null
  for (let dy = 1; dy <= 3; dy++) {
    const blk = b.blockAt(feet.offset(0, -dy, 0))
    if (blk && !isAir(blk.name)) { ground = { name: blk.name, y: feet.y - dy }; break }
  }
  let headroom = 0
  for (let dy = 1; dy <= 8; dy++) {
    const blk = b.blockAt(feet.offset(0, dy, 0))
    if (!blk || !isAir(blk.name)) break
    headroom = dy
  }
  return { feet: posOf(feet), ground, headroom, canJump: headroom >= 2 }
}

/** 正在挖 / 正在用的目标（本地状态，不是世界回执） */
function activityOf (b) {
  const dig = b.targetDigBlock ?? null
  return {
    digging: dig ? { name: dig.name, position: posOf(dig.position) } : null,
    usingItem: Boolean(b.usingHeldItem),
    swinging: Boolean(b.swingArmActive),
  }
}

/** 一层薄封装：取 bot；没连上就抛一句人话 */
function needBot (getBot, exec) {
  const b = getBot(exec)
  if (!b) throw new Error('还没进服：先 mc_connect 连上服务器（原语只操作本地身体，不替你连服）')
  return b
}

/**
 * 造 9 个原语的 spec 数组。`index.js` 负责注册（它知道怎么包 defineTool / 会话）。
 *
 * @param {Object} api
 * @param {Function} api.getBot       (exec) => mineflayer bot | null
 * @param {Function} api.getSession   (exec) => 会话对象（取 cfg / 日志）
 * @param {Function} api.text         () => 输出渲染器（index.js 的 text()）
 * @param {Function} [api.afterInput] 可选：输入变化后的钩子（比如让看门狗知道我在动）
 */
export function buildPrimitives ({ getBot, getSession, text, afterInput = null }) {
  /** 取 bot 的快捷方式（每个 execute 内部自己调，不进外层包装） */
  const botOf = (exec) => needBot(getBot, exec)

  /* ── 移动原语：只写控制位 / 朝向，立即返回 ───────────────────────────── */

  const mcLook = {
    name: 'mc_look',
    description: '把视角直接转到指定角度（**原语**：只改本地朝向，立即返回，不转头动画、不等人）。\n'
      + '`yaw`：0=南(+Z)、90=西(-X)、180=北(-Z)、270=东(+X)；`pitch`：-90=正上、90=正下。\n'
      + '要"看向某个坐标/实体"用 `mc_look_at`。',
    parameters: {
      yaw: { type: 'number', required: true, description: '水平角（度）' },
      pitch: { type: 'number', description: '俯仰角（度），默认 0 = 平视' },
    },
    output: text(),
    async execute (args, exec) {
      const b = needBot(getBot, exec)
      const yaw = ((num(args.yaw, NaN) % 360) + 360) % 360
      if (!Number.isFinite(yaw)) throw new Error('yaw 必须是数字（度）')
      const pitch = Math.max(-90, Math.min(90, num(args.pitch, 0)))
      b.look(yaw * Math.PI / 180, pitch * Math.PI / 180, true)
      return {
        yaw: round(yaw, 1), pitch: round(pitch, 1),
        applied: true, confirmed: false,
        note: '已写入本地朝向；服务端不会回执（原语语义）',
        text: `👀 朝向已设为 yaw ${round(yaw, 1)}° / pitch ${round(pitch, 1)}°（本地立即生效）`,
      }
    },
  }

  const mcLookAt = {
    name: 'mc_look_at',
    description: '看向一个坐标或一个玩家/实体（**原语**：算好角度写进本地朝向，立即返回，**不移动**）。\n'
      + '给 `x/y/z` 看方块/坐标；给 `who` 看最近的同名实体。两者都给时以坐标为准。',
    parameters: {
      x: { type: 'number', description: '目标 x' },
      y: { type: 'number', description: '目标 y' },
      z: { type: 'number', description: '目标 z' },
      who: { type: 'string', description: '玩家/实体名（中英文都认；不给坐标时用）' },
      aim: { type: 'string', description: '"eyes"（默认）= 瞄眼睛高度；"feet" = 瞄脚底' },
    },
    output: text(),
    async execute (args, exec) {
      const b = needBot(getBot, exec)
      const p = pt(args)
      if (p) {
        const res = aimAt(b, new Vec3(p.x, p.y, p.z))
        if (!res) throw new Error('算不出角度（目标和我重合？）')
        return { ...res, target: p, applied: true, text: `👀 已看向 (${p.x}, ${p.y}, ${p.z})` }
      }
      const who = String(args.who ?? '').trim()
      if (!who) throw new Error('要给坐标 x/y/z，或者给 who（实体名）')
      const found = entitiesNear(b, 64, { kind: 'all', limit: 64 }).list?.find((e) => e.name === who)
        ?? entitiesNear(b, 64, { kind: 'all', limit: 64 }).list?.find((e) => String(e.name).includes(who))
      if (!found) throw new Error(`64 格内没有叫「${who}」的实体`)
      const y = args.aim === 'feet' ? found.position.y : found.position.y + 1.6
      const res = aimAt(b, new Vec3(found.position.x + 0.5, y, found.position.z + 0.5))
      if (!res) throw new Error('算不出角度')
      return { ...res, target: found.position, entity: found.name, applied: true, text: `👀 已看向 ${found.name}（${found.distance} 格）` }
    },
  }

  const mcInput = {
    name: 'mc_input',
    description: '按/松开移动键（**原语**：等价于按住键盘，立即返回；按下就一直生效，直到再调一次把它关掉）。\n'
      + '可一次给多个键（`forward:true,jump:true`）。**不做避障、不寻路** —— 撞墙就撞墙，要绕路用 `mc_move`。\n'
      + '· 全空 = 松开所有键（急停）\n'
      + '· `sprint` 只在 `forward` 按下时有效（原版规则）',
    parameters: {
      forward: { type: 'boolean', description: '前进' },
      back: { type: 'boolean', description: '后退' },
      left: { type: 'boolean', description: '左平移' },
      right: { type: 'boolean', description: '右平移' },
      jump: { type: 'boolean', description: '跳跃（按住会连续跳）' },
      sneak: { type: 'boolean', description: '潜行' },
      sprint: { type: 'boolean', description: '疾跑' },
      all: { type: 'boolean', description: 'true = 先把所有键松开，再按这次给的（默认 false = 只改给到的键）' },
    },
    output: text(),
    async execute (args, exec) {
      const b = needBot(getBot, exec)
      if (args.all === true) for (const k of CONTROL_KEYS) b.setControlState(k, false)
      const changed = {}
      for (const k of CONTROL_KEYS) {
        if (args[k] === undefined) continue
        b.setControlState(k, Boolean(args[k]))
        changed[k] = Boolean(args[k])
      }
      try { afterInput?.(b) } catch { /* 钩子失败不影响原语 */ }
      const state = {}
      for (const k of CONTROL_KEYS) state[k] = Boolean(b.controlState?.[k])
      const on = CONTROL_KEYS.filter((k) => state[k])
      return {
        changed,
        controlState: state,
        text: on.length
          ? `🕹 按住：${on.join(' + ')}（松开用 mc_input {all:true} 或把对应键设 false）`
          : '🕹 所有移动键都松开了（站住）',
      }
    },
  }

  /* ── 丢弃原语（用户 2026-10-25）：朝指定方向丢，立即返回 ── */
  const mcToss = {
    name: 'mc_toss',
    description: '🗑 **丢弃物品**（原语，立即执行）：从背包丢出指定物品与数量。\n'
      + '· 给 `dir` 就朝那个方向扔（north/south/east/west/up/down）；不给就朝当前视线\n'
      + '· 要丢给**玩家**请用工具 `mc_toss_to`（它会先走过去）',
    parameters: {
      name: { type: 'string', required: true, description: '物品名（英文 id，如 cobblestone）' },
      count: { type: 'number', description: '丢几个（默认 1）' },
      dir: { type: 'string', description: '方向：north/south/east/west/up/down（不给=当前朝向）' },
    },
    output: text(),
    async execute (args, exec) {
      const b = botOf(exec)
      const want = String(args.name ?? '').trim().toLowerCase()
      if (!want) return { ok: false, text: '❌ 要丢什么？给物品名' }
      const items = b.inventory.items()
      const it = items.find((x) => x.name === want) ?? items.find((x) => x.name.endsWith(want))
      if (!it) {
        return { ok: false, text: `❌ 背包里没有 ${want}（有：${items.slice(0, 10).map((x) => x.name).join(', ') || '空'}）` }
      }
      const count = Math.max(1, Math.min(Number(args.count ?? 1) || 1, it.count))
      const dir = String(args.dir ?? '').toLowerCase()
      const YAW = { south: 0, west: 90, north: 180, east: 270 }
      try {
        if (dir === 'up') b.look?.(b.entity.yaw, -Math.PI / 2, false)
        else if (dir === 'down') b.look?.(b.entity.yaw, Math.PI / 2, false)
        else if (YAW[dir] != null) b.look?.(YAW[dir] * Math.PI / 180, 0, false)
        await b.toss(it.type, null, count)
        return {
          ok: true, name: it.name, count, dir: dir || null,
          text: `🗑 丢出 ${it.name} ×${count}${dir ? `（朝 ${dir}）` : ''}，背包还剩 ${it.count - count}`,
        }
      } catch (e) {
        return { ok: false, text: `❌ 丢失败：${e.message}` }
      }
    },
  }

  const mcSwing = {
    name: 'mc_swing',
    description: '挥一下主手（**原语**：只发一次动画包，立即返回，不判定是否打中）。\n'
      + '用途：空挥/攻击节奏/触发某些方块交互。要真打怪用 `mc_attack`（工具，会追、会选目标）。',
    parameters: {},
    output: text(),
    async execute (args, exec) {
      const b = needBot(getBot, exec)
      b.swingArm('right')
      return { swing: 'right', applied: true, text: '🤚 主手挥了一下（不判定命中）' }
    },
  }

  /* ── 感知原语：只读本地镜像，立即返回 ─────────────────────────────────── */

  const mcSelf = {
    name: 'mc_self',
    description: '我自己的身体状态（**原语**：读本地镜像，立即返回）。\n'
      + '含：坐标/朝向/血量/饥饿/氧气/游戏模式/在地面/骑乘/正在挖什么/正在用物品/手持 + 背包摘要 + 脚下方块 + 头顶净空。\n'
      + '想看画面用 `mc_observe`；要看周围方块/实体用 `mc_blocks` / `mc_entities`。',
    parameters: {
      verbose: { type: 'boolean', description: 'true = 背包逐格列出（默认只给前 12 叠）' },
    },
    output: text(),
    async execute (args, exec) {
      const b = needBot(getBot, exec)
      const p = b.entity?.position
      const inv = inventorySummary(b)
      const foot = footingOf(b)
      const act = activityOf(b)
      const stacks = args.verbose === true ? inv.stacks : inv.stacks.slice(0, 12)
      const hp = Number(b.health)
      const food = Number(b.food)
      const lines = []
      lines.push(p ? `📍 ${round(p.x)}, ${round(p.y)}, ${round(p.z)}` : '📍 还没位置')
      lines.push(`❤ ${Number.isFinite(hp) ? round(hp, 1) : '?'}/20 · 🍗 ${Number.isFinite(food) ? food : '?'}/20`
        + (b.oxygenLevel !== undefined && b.oxygenLevel < 300 ? ` · 氧气 ${Math.max(0, Number(b.oxygenLevel))}` : ''))
      lines.push(`🎮 ${b.game?.gameMode ?? '?'} · ${b.game?.dimension ?? '?'} · ${b.entity?.onGround ? '在地面' : '空中'}`
        + (b.entity?.vehicle ? ` · 骑着 ${b.entity.vehicle?.name ?? '载具'}` : ''))
      lines.push(`🧭 yaw ${round((b.entity?.yaw ?? 0) * 180 / Math.PI, 1)}° · pitch ${round((b.entity?.pitch ?? 0) * 180 / Math.PI, 1)}°`)
      lines.push(`✋ 手持 ${inv.held ? `${inv.held.name} ×${inv.held.count}` : '空手'} · 背包 ${inv.usedSlots}/36 叠`
        + ` · 脚下方块 ${foot.ground?.name ?? '空气（会掉下去）'}${foot.headroom !== null ? ` · 头顶净空 ${foot.headroom} 格` : ''}`)
      if (act.digging) lines.push(`⛏ 正在挖 ${act.digging.name} @ ${act.digging.position.x},${act.digging.position.y},${act.digging.position.z}`)
      if (act.usingItem) lines.push('🎯 正在用手上物品')
      if (stacks.length) lines.push('🎒 ' + stacks.map((s) => `${s.name}×${s.count}`).join(' · ') + (inv.stacks.length > stacks.length ? ` …（还有 ${inv.stacks.length - stacks.length} 叠，verbose:true 全看）` : ''))
      /* 用户 2026-10-25：背包空格 <= 2 时预警，提醒清理背包，避免捡不起掉落物 */
      const warn = bagWarning(b)
      if (warn) lines.push(warn)
      return {
        position: posOf(p), yaw: round((b.entity?.yaw ?? 0) * 180 / Math.PI, 1), pitch: round((b.entity?.pitch ?? 0) * 180 / Math.PI, 1),
        health: Number.isFinite(hp) ? hp : null, food: Number.isFinite(food) ? food : null,
        oxygen: b.oxygenLevel ?? null, gameMode: b.game?.gameMode ?? null, dimension: b.game?.dimension ?? null,
        onGround: Boolean(b.entity?.onGround), vehicle: b.entity?.vehicle?.name ?? null,
        inventory: inv, footing: foot, activity: act,
        text: lines.join('\n'),
      }
    },
  }

  const mcBlock = {
    name: 'mc_block',
    description: '读**一格**方块（**原语**：本地镜像，立即返回）。读不到 = 那格没加载，不是空气。\n'
      + '给绝对坐标 `x/y/z`；或给相对偏移 `dx/dy/dz`（相对我的脚底格）；给 `name` 则判断"这里是不是这种方块"。',
    parameters: {
      x: { type: 'number', description: '绝对 x' },
      y: { type: 'number', description: '绝对 y' },
      z: { type: 'number', description: '绝对 z' },
      dx: { type: 'number', description: '相对我的 dx' },
      dy: { type: 'number', description: '相对我的 dy' },
      dz: { type: 'number', description: '相对我的 dz' },
    },
    output: text(),
    async execute (args, exec) {
      const b = needBot(getBot, exec)
      const feet = b.entity?.position?.floored()
      const hasRel = args.dx !== undefined || args.dy !== undefined || args.dz !== undefined
      const target = hasRel
        ? (feet ? feet.offset(int(args.dx) ?? 0, int(args.dy) ?? 0, int(args.dz) ?? 0) : null)
        : (int(args.x) !== null && int(args.y) !== null && int(args.z) !== null ? new Vec3(int(args.x), int(args.y), int(args.z)) : null)
      if (!target) throw new Error('给绝对坐标 x/y/z，或者相对偏移 dx/dy/dz')
      const blk = b.blockAt(target)
      if (!blk) {
        return { position: posOf(target), loaded: false, text: `❔ (${target.x},${target.y},${target.z}) 没加载（区块还没下发，不是空气）` }
      }
      let state = null
      try {
        const props = blk.getProperties?.()
        if (props && Object.keys(props).length) state = props
      } catch { state = null }
      return {
        position: posOf(target), loaded: true, name: blk.name, ...(state ? { state } : {}),
        diggable: blk.diggable ?? null, hardness: blk.hardness ?? null,
        text: `🧱 (${target.x},${target.y},${target.z}) = ${blk.name}${state ? ' ' + JSON.stringify(state) : ''}`,
      }
    },
  }

  const mcBlocks = {
    name: 'mc_blocks',
    description: '读一片方块（**原语**：本地镜像，立即返回）。\n'
      + '· 给 `name`：找这种方块（返回前 N 个，按距离升序）\n'
      + '· 不给 `name`：返回这一片里**非空气**的方块清单（压缩成"名字 × 数量 + 坐标组"，最多 `limit` 种）\n'
      + '范围：`r`（默认 8，上限 16）或 `x1/y1/z1/x2/y2/z2` 的实心立方。体素上限 8192，超了直接报错让你缩小范围。',
    parameters: {
      name: { type: 'string', description: '方块名（如 oak_log / water / diamond_ore）' },
      r: { type: 'number', description: '半径（默认 8，上限 16）' },
      x1: { type: 'number' }, y1: { type: 'number' }, z1: { type: 'number' },
      x2: { type: 'number' }, y2: { type: 'number' }, z2: { type: 'number' },
      limit: { type: 'number', description: '最多返回几条（默认 24，上限 64）' },
    },
    output: text(),
    async execute (args, exec) {
      const b = needBot(getBot, exec)
      const feet = b.entity?.position?.floored()
      if (!feet) throw new Error('还没有位置（区块没加载完）')
      const limit = Math.min(Math.max(Number(args.limit ?? 24), 1), 64)
      const name = args.name ? String(args.name).trim() : null
      const box = (int(args.x1) !== null && int(args.y1) !== null && int(args.z1) !== null
        && int(args.x2) !== null && int(args.y2) !== null && int(args.z2) !== null)
        ? { x1: int(args.x1), y1: int(args.y1), z1: int(args.z1), x2: int(args.x2), y2: int(args.y2), z2: int(args.z2) }
        : null
      const r = Math.min(Math.max(Number(args.r ?? 8), 1), MAX_BLOCK_R)
      const from = box ? new Vec3(Math.min(box.x1, box.x2), Math.min(box.y1, box.y2), Math.min(box.z1, box.z2)) : feet.offset(-r, -r, -r)
      const to = box ? new Vec3(Math.max(box.x1, box.x2), Math.max(box.y1, box.y2), Math.max(box.z1, box.z2)) : feet.offset(r, r, r)
      const volume = (to.x - from.x + 1) * (to.y - from.y + 1) * (to.z - from.z + 1)
      if (volume > MAX_BLOCK_VOLUME) {
        throw new Error(`范围太大（${volume} 格 > 上限 ${MAX_BLOCK_VOLUME}）——缩小 r 或给更小的立方`)
      }
      const hits = []
      const tally = new Map()
      let unloaded = 0
      for (let x = from.x; x <= to.x; x++) {
        for (let y = from.y; y <= to.y; y++) {
          for (let z = from.z; z <= to.z; z++) {
            const blk = b.blockAt(new Vec3(x, y, z))
            if (!blk) { unloaded++; continue }
            if (isAir(blk.name)) continue
            if (name) {
              if (blk.name !== name) continue
              const d = Math.hypot(x + 0.5 - b.entity.position.x, y + 0.5 - b.entity.position.y, z + 0.5 - b.entity.position.z)
              hits.push({ x, y, z, d: round(d, 1) })
            } else {
              let e = tally.get(blk.name)
              if (!e) { e = { name: blk.name, count: 0, sample: [] }; tally.set(blk.name, e) }
              e.count += 1
              if (e.sample.length < 4) e.sample.push(`${x},${y},${z}`)
            }
          }
        }
      }
      const scanned = (to.x - from.x + 1) * (to.y - from.y + 1) * (to.z - from.z + 1)
      if (name) {
        hits.sort((a, c) => a.d - c.d)
        const out = hits.slice(0, limit)
        return {
          name, scanned, unloaded, total: hits.length, list: out,
          text: hits.length
            ? `🔎 ${name}：${hits.length} 个（列前 ${out.length}，按距离）\n` + out.map((h) => `  ${h.x},${h.y},${h.z}（${h.d} 格）`).join('\n')
            : `🔎 ${scanned} 格里没有 ${name}${unloaded ? `（${unloaded} 格未加载，可能藏在那里）` : ''}`,
        }
      }
      const types = [...tally.values()].sort((a, c) => c.count - a.count).slice(0, limit)
      return {
        scanned, unloaded, types: tally.size, list: types,
        text: types.length
          ? `🧱 ${scanned} 格里 ${tally.size} 种方块（列前 ${types.length}）\n`
            + types.map((t) => `  ${t.name} ×${t.count}  例：${t.sample.join(' / ')}`).join('\n')
            + (unloaded ? `\n（${unloaded} 格未加载）` : '')
          : `🧱 ${scanned} 格里全是空气${unloaded ? `（${unloaded} 格未加载）` : ''}`,
      }
    },
  }

  const mcEntities = {
    name: 'mc_entities',
    description: '看周围有哪些实体（**原语**：本地镜像，立即返回，**不做威胁判断、不给战术建议**）。\n'
      + '返回：名字 / 类别（hostile·neutral·player·other·junk）/ 坐标 / 距离 / dy / 血量（读不到就没有）。\n'
      + '要打架用 `mc_attack`（工具，会挑目标、追、放风筝）。',
    parameters: {
      r: { type: 'number', description: '半径（默认 24，上限 64）' },
      kind: { type: 'string', description: 'all（默认）/ hostile / neutral / player / mob / junk' },
      limit: { type: 'number', description: '最多几条（默认 20，上限 64）' },
    },
    output: text(),
    async execute (args, exec) {
      const b = needBot(getBot, exec)
      const r = Math.min(Math.max(Number(args.r ?? 24), 1), 64)
      const out = entitiesNear(b, r, { kind: String(args.kind ?? 'all'), limit: Math.min(Math.max(Number(args.limit ?? 20), 1), 64) })
      if (out?.error) return { error: out.error, text: '👀 ' + out.error }
      const lines = out.list.map((e) => `  ${e.name}${e.hostile ? '⚠' : ''} ${e.distance} 格 (${e.position.x},${e.position.y},${e.position.z})${e.health ? ` ♥${e.health}` : ''}`)
      return {
        ...out,
        text: `👥 ${out.radius} 格内 ${out.total} 个（敌对 ${out.counts.hostile} / 中立 ${out.counts.neutral} / 玩家 ${out.counts.player} / 其它 ${out.counts.other} / 掉落物 ${out.counts.junk}）\n` + lines.join('\n'),
      }
    },
  }

  /* ── 宏/批原语：一次提交多个身体改动 ─────────────────────────────────── */

  const mcApply = {
    name: 'mc_apply',
    description: '**宏原语**：一次提交"朝向 + 控制位"，立即返回（等价于同一瞬间按好几个键并转视角）。\n'
      + '用途：边走边看向某处、边跳边前进、一次性摆好姿态，省掉好几次来回。\n'
      + '· `look`：`{yaw,pitch}` 或 `{x,y,z}` 或 `{who}`（三选一，可省略）\n'
      + '· `input`：`{forward,jump,...}`；给了就按这次的值设，**没给的键保持原样**\n'
      + '· `releaseAll:true`：先把所有键松开再应用',
    parameters: {
      look: { type: 'object', additionalProperties: true, description: '{yaw,pitch} 或 {x,y,z} 或 {who}；不给就不动视角' },
      input: { type: 'object', additionalProperties: true, description: '{forward/back/left/right/jump/sneak/sprint} 布尔值' },
      releaseAll: { type: 'boolean', description: 'true = 先松开所有键' },
    },
    output: text(),
    async execute (args, exec) {
      const b = needBot(getBot, exec)
      const did = []
      if (args.releaseAll === true) { for (const k of CONTROL_KEYS) b.setControlState(k, false); did.push('松开全部键') }
      const look = args.look && typeof args.look === 'object' ? args.look : null
      if (look) {
        if (look.who) {
          const found = entitiesNear(b, 64, { kind: 'all', limit: 64 }).list?.find((e) => e.name === String(look.who))
          if (!found) throw new Error(`64 格内没有「${look.who}」`)
          aimAt(b, new Vec3(found.position.x + 0.5, found.position.y + 1.6, found.position.z + 0.5))
          did.push(`看向 ${found.name}`)
        } else if (int(look.x) !== null && int(look.y) !== null && int(look.z) !== null) {
          aimAt(b, new Vec3(Number(look.x), Number(look.y), Number(look.z)))
          did.push(`看向 (${look.x},${look.y},${look.z})`)
        } else if (num(look.yaw, null) !== null) {
          b.look(num(look.yaw) * Math.PI / 180, (num(look.pitch, 0)) * Math.PI / 180, true)
          did.push(`朝向 yaw ${round(num(look.yaw), 1)}°`)
        } else throw new Error('look 要给 {yaw,pitch} / {x,y,z} / {who} 之一')
      }
      const input = args.input && typeof args.input === 'object' ? args.input : null
      if (input) {
        const on = []
        for (const k of CONTROL_KEYS) {
          if (input[k] === undefined) continue
          b.setControlState(k, Boolean(input[k]))
          if (input[k]) on.push(k)
        }
        did.push(on.length ? `按住 ${on.join('+')}` : '松开这次提到的键')
      }
      try { afterInput?.(b) } catch { /* 钩子失败不影响原语 */ }
      if (!did.length) throw new Error('什么都没给：至少给 look / input / releaseAll 之一')
      const state = {}
      for (const k of CONTROL_KEYS) state[k] = Boolean(b.controlState?.[k])
      return { did, controlState: state, text: `🎛 ${did.join('；')}` }
    },
  }

  return [mcLook, mcLookAt, mcInput, mcSwing, mcSelf, mcBlock, mcBlocks, mcEntities, mcApply, mcToss]
}

/** 原语名清单（index.js 用来把它们排除在"工具预算/调度器"之外） */
export const PRIMITIVE_NAMES = [
  'mc_toss',
  'mc_look', 'mc_look_at', 'mc_input', 'mc_swing',
  'mc_self', 'mc_block', 'mc_blocks', 'mc_entities',
  'mc_apply',
]

export { lookAnglesTo }
