/* ============================================================================
 * killa —— **被动战斗接管**（用户 2026-10-25）
 * ----------------------------------------------------------------------------
 * 敌对的生物进入可触及范围（~5 格）时：
 *   ① 背包里有合适武器（剑/斧/矛/三叉戟）→ **自动换武器 + 自动跳劈**，接管身体开打；
 *   ② 没有武器 → 导航远离；
 *   ③ 苦力怕 → 不管有没有武器，**直接远离**（不要靠近）。
 *
 * 接管时：
 *   · **抑制合成**（不插 craft 任务）；
 *   · **停掉当前正在跑的本地脚本**（队列 stopAll）；
 *   · 向 LLM 报告："检测到 xxx，killa 自动接管（攻击/逃离），xxx 工具被终止"。
 * ========================================================================== */
import Vec3 from 'vec3'

/** 敌对生物（名字列表——按常见怪，别的靠 entity.type === 'hostile' 兜底） */
const HOSTILE = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider',
  'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'zombified_piglin', 'piglin_brute',
  'enderman', 'slime', 'magma_cube', 'silverfish', 'endermite', 'phantom', 'blaze', 'ghast',
  'wither_skeleton', 'guardian', 'elder_guardian', 'hoglin', 'zoglin', 'warden', 'breeze',
])

/** 武器优先级：剑/斧/矛/三叉戟（等级高的先） */
const WEAPON_RE = /_(sword|axe|trident)$|^trident$|_(mace)$/

/** 触发接管距离（可触及范围） */
export const KILLA_RANGE = 5
/** 苦力怕的敬畏距离 */
export const CREEPER_RANGE = 7
/** 跳劈节奏：暴击窗口（下落中攻击） */
const ATTACK_COOLDOWN_MS = 620

function isHostile (e) {
  if (!e || !e.position) return false
  const n = String(e.name ?? e.displayName ?? '').toLowerCase()
  if (HOSTILE.has(n)) return true
  return e.type === 'hostile' || e.type === 'mob' && HOSTILE.has(n)
}

function isCreeper (e) {
  return /creeper/.test(String(e.name ?? '').toLowerCase())
}

/** 背包里最合适的武器 */
export function bestWeapon (b) {
  const items = []
  try { for (const it of b.inventory.items()) items.push(it) } catch { return null }
  const cands = []
  for (const it of items) {
    const n = String(it.name ?? '')
    if (!WEAPON_RE.test(n) && !['trident', 'mace'].includes(n)) continue
    const tier = /netherite/.test(n) ? 0 : /diamond/.test(n) ? 1 : /iron/.test(n) ? 2 : /stone/.test(n) ? 3 : /wooden|golden/.test(n) ? 4 : 5
    const durLeft = (it.maxDurability ?? 0) - (it.durabilityUsed ?? 0)
    if (durLeft > 0 && durLeft < 3) continue
    cands.push({ item: it, tier })
  }
  cands.sort((a, c) => a.tier - c.tier)
  return cands[0]?.item ?? null
}

/** 换武器到手上 */
async function equipWeapon (b, weapon) {
  try {
    if (b.heldItem?.type === weapon.type) return true
    await b.equip(weapon, 'hand')
    return true
  } catch { return false }
}

/**
 * 跳劈：跳起来，等落到下落段再打（暴击）。
 * @returns {Promise<boolean>} 是否打中
 */
export async function jumpAttack (b, target) {
  try {
    const dist = b.entity.position.distanceTo(target.position)
    if (dist > 3.8) {
      try { await b.lookAt(target.position.offset(0, 1.2, 0), false) } catch { /* ignore */ }
    }
    b.setControlState('jump', true)
    await sleep(120)
    b.setControlState('jump', false)
    await sleep(260)                       // 上升 → 开始下落
    try { await b.lookAt(target.position.offset(0, 1.2, 0), false) } catch { /* ignore */ }
    await b.attack(target)
    return true
  } catch {
    return false
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 启动 killa（返回 stop 函数）。每 400ms 检查一次。
 * @param {object} self  { bot: mineflayer bot, _pf }
 * @param {object} ctx   { board, report(text), log(text) }
 */
export function startKilla (self, ctx = {}) {
  const { board = null, report = () => {}, log = () => {} } = ctx
  let stopped = false
  let busy = false
  let engaged = null            // 当前锁定的目标 id
  let lastReport = 0
  let lastAttackAt = 0
  let takeovers = 0

  const findNearest = (b) => {
    let best = null
    let bestD = Infinity
    for (const e of Object.values(b.entities ?? {})) {
      if (!isHostile(e)) continue
      const d = b.entity.position.distanceTo(e.position)
      if (d < bestD) { bestD = d; best = e }
    }
    return best ? { ent: best, dist: bestD } : null
  }

  const tick = async () => {
    if (stopped || busy) return
    const b = self?.bot
    if (!b?.entity || !b.health) return
    busy = true
    try {
      const near = findNearest(b)
      if (!near) { engaged = null; return }
      const { ent, dist } = near
      const name = String(ent.name ?? '怪物')
      const creeper = isCreeper(ent)
      const weapon = bestWeapon(b)

      /* 苦力怕：多远都要跑，绝不靠近 */
      if (creeper && dist < CREEPER_RANGE) {
        takeovers += 1
        if (board) { try { board.stopAll(`killa：苦力怕（${name}）`) } catch { /* 空队列 */ } }
        const away = awayPoint(b, ent, 10)
        try {
          const goals = self?._pf?.goals ?? self?._pf?.Goals
          if (goals?.GoalNear) b.pathfinder?.setGoal?.(new goals.GoalNear(new Vec3(away.x, away.y, away.z), 2))
        } catch { /* ignore */ }
        if (Date.now() - lastReport > 4000) {
          lastReport = Date.now()
          report(`⚠️ killa 接管：检测到苦力怕（${dist.toFixed(1)} 格），**直接远离**，当前工具已终止`)
        }
        return
      }

      /* 没到触发距离：不管 */
      if (dist > KILLA_RANGE) { engaged = null; return }

      /* 有武器 → 打；没武器 → 跑 */
      if (!weapon || !weapon.name) {
        takeovers += 1
        if (board) { try { board.stopAll(`killa：无武器，远离 ${name}`) } catch { /* 空 */ } }
        const away = awayPoint(b, ent, 12)
        try {
          const goals = self?._pf?.goals ?? self?._pf?.Goals
          if (goals?.GoalNear) b.pathfinder?.setGoal?.(new goals.GoalNear(new Vec3(away.x, away.y, away.z), 2))
        } catch { /* ignore */ }
        if (Date.now() - lastReport > 4000) {
          lastReport = Date.now()
          report(`⚠️ killa 接管：检测到 ${name}（${dist.toFixed(1)} 格），**没有武器 → 远离**，当前工具已终止`)
        }
        return
      }

      /* 第一次锁定这个怪：停掉本地脚本 + 报告 */
      if (engaged !== ent.id) {
        engaged = ent.id
        if (board) {
          const stopped = board.snapshot?.()
          const what = stopped?.current?.summary ?? null
          try { board.stopAll(`killa：${name}`) } catch { /* 空 */ }
          if (Date.now() - lastReport > 1500) {
            lastReport = Date.now()
            report(`⚔️ killa 接管：检测到 ${name}（${dist.toFixed(1)} 格），自动换 ${weapon.name} 开始攻击`
              + (what ? `；**${what}** 已终止` : ''))
          }
        }
        await equipWeapon(b, weapon)
      }

      /* 攻击（带跳劈节奏） */
      if (Date.now() - lastAttackAt < ATTACK_COOLDOWN_MS) return
      const live = b.entities?.[ent.id] ?? ent
      if (!live?.position || live.health === 0) { engaged = null; return }
      if (b.entity.position.distanceTo(live.position) > KILLA_RANGE + 1) return
      lastAttackAt = Date.now()
      await jumpAttack(b, live)
    } catch (e) {
      log('killa 出错：' + (e?.message ?? e))
    } finally {
      busy = false
    }
  }

  const timer = setInterval(tick, 400)
  return {
    stop () { stopped = true; clearInterval(timer) },
    stats () { return { takeovers, engaged } },
  }
}

/** 从怪物身边往外退的落点 */
function awayPoint (b, ent, distance) {
  const me = b.entity.position
  const dx = me.x - ent.position.x
  const dz = me.z - ent.position.z
  const len = Math.hypot(dx, dz) || 1
  return {
    x: Math.floor(me.x + (dx / len) * distance),
    y: Math.floor(me.y),
    z: Math.floor(me.z + (dz / len) * distance),
  }
}
