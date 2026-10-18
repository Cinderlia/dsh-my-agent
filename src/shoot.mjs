/**
 * 射箭（`mc_act {mode:"shoot"}`）—— 弹道交给**现成的** `minecrafthawkeye` 算，我们不自己推公式。
 *
 * 用户 2026-10-19：「hawkeye 主要是水晶和末影龙」—— 也就是末地战两个用法：
 *   · 末影水晶（站在黑曜石柱顶上的那个，射爆它才不让龙回血）：**坐标目标**，静止、体积大，
 *     给 `x/y/z` 就行（方块坐标，瞄它中心上方一点）。
 *   · 末影龙（会飞、会俯冲）：**实体目标**，必须带提前量 —— 这是 hawkeye 比"抬头算角度"强的地方。
 *
 * 为什么用 hawkeye 而不是自己写抛物线（用户 2026-10-06 定的"现成方案优先"）：
 *   它按武器（bow / crossbow / trident / splash_potion…）的 `BaseVo`（初速）与 `GRAVITY`（每 tick 重力）
 *   迭代出**落点误差最小**的那一档 pitch，还顺带给出整条箭矢轨迹点（`arrowTrajectoryPoints`）和
 *   轨迹上撞到的第一个方块（`blockInTrayect`，`world.raycast` 的结果）。
 *
 * 这里踩过的坑（细节见 `踩坑档案.md` 第 188 / 189 / 190 条）：
 *   ① `getMasterGrade()` 返回的 `yaw` / `pitch` **已经是弧度**（`calculateYaw` 是 atan2、`pitch` 走过
 *      `degreesToRadians`）—— 直接喂 `bot.look()`，**不要再转一次**；多转一次就永远射到天上/地里。
 *   ② 它的模块级 `bot` 是**单例**（`loadBot(bot)` 存在模块作用域）：同一进程连第二个号之后，
 *      `getMasterGrade` 会拿**上一个 bot 的坐标**算 —— 所以每次射之前都要重新 `inject(bot)` 一遍
 *      （`loadBot` 幂等，只换引用，不重复挂监听）。
 *   ③ `getMasterGrade` 在"落点误差 > 4 格"时**返回 `undefined`**（不是抛错）—— 太远/角度太刁就算不出来，
 *      这时必须如实说"算不出来、靠近点"，绝不能拿一个默认角度瞎射。
 *   ④ 弓要**拉满**才有那个初速（≥ 20 tick ≈ 1000ms）。不到 1 秒放箭，箭是"软"的 —— 落点会比算的短一大截。
 *   ⑤ 放箭瞬间的方向由服务端按**放箭那一包的 rotation** 决定：必须"先 look、再 deactivateItem"，
 *      顺序反了就是照着上一次的朝向射出去。
 *   ⑥ 创造模式**不消耗箭**，所以"箭数前后对比"这条证据在创造模式下不成立（不能据此判失败）。
 *   ⑦ 射完把**原来手里那件换回去**（用户 2026-10-19 对搭路的同一诉求：别让"为了射一箭"把
 *      手里的剑换成弓留在手上）。用的是 `bridge.mjs` 里那对 `heldSnapshotOf` / `restoreHeldOf`。
 */
import Vec3 from 'vec3'
import { sleep } from './async-util.mjs'
import { heldSnapshotOf, restoreHeldOf } from './bridge.mjs'
import { entityNameOf, pickEntity } from './entity-names.mjs'
import { loadMcDep } from './plugins.mjs'

/** 能当箭用的物品（`tipped_arrow` 也算；`arrow` 是常态） */
const ARROW_RE = /^(arrow|spectral_arrow|tipped_arrow)$/i
/** hawkeye 的 `Weapons` 里我们开放的那几个（弓是常态；弩要装填，trident 有专属弹道） */
const WEAPONS = new Set(['bow', 'crossbow', 'trident'])
/** 弓拉满要 20 tick = 1000ms，留 50ms 余量 */
const MIN_DRAW_MS = 1_050
/** `look` 之后、`deactivateItem` 之前的间隔（同一条 TCP 内本来就有序，这只是保险） */
const LOOK_SETTLE_MS = 40
/** 默认等多久再放（拉满再放） */
const DEFAULT_DRAW_MS = 1_200

/** 背包里还有几支箭（给"到底射出去没有"当证据） */
export const arrowsIn = (b) => {
  let n = 0
  for (const it of b?.inventory?.items?.() ?? []) if (ARROW_RE.test(String(it?.name ?? ''))) n += Number(it.count ?? 0)
  return n
}

/** 创造模式不耗箭（`bot.game.gameMode` 是字符串；老版本/离线服可能没有 → 当生存看） */
export const infiniteArrows = (b) => String(b?.game?.gameMode ?? b?.player?.gameMode ?? '') === 'creative'

/**
 * 放完箭等"服务端把这箭记上"（箭数掉 1）—— 最多 600ms，掉下来就立刻回。
 *
 * 🔴 为什么不固定 `sleep(120)` 再看一眼：服务端有延迟/掉帧时，120ms 常常还没回包，
 *    于是"箭数没变"被误判成"这一箭没射出去"，整个连射当场停掉（2026-10-19 实测过）。
 *    创造模式没有箭数变化，固定等一小会儿就行。
 */
async function arrowsAfterRelease (b, before, creative, stepMs = 100) {
  const step = Math.max(0, Number(stepMs) || 0)
  if (creative) { await sleep(step ? 150 : 0); return arrowsIn(b) }
  for (let i = 0; i < 6; i++) {
    if (step) await sleep(step)
    const now = arrowsIn(b)
    if (now < before) return now
  }
  return arrowsIn(b)
}

/**
 * 目标速度（每 tick 多少格）—— hawkeye 的提前量就是 `newTarget += speed` 累加 `totalTicks` 次。
 *
 * 🔴 为什么不用 `entity.velocity` 了事：末影龙那种高速飞行体的 `entity_velocity` 包很稀（几 tick 一个），
 *    两次包之间读到的常常是 0，算出来的提前量就废了。这里**实测**：隔 100ms（2 tick）读两次位置，
 *    差值除以 tick 数。静止目标（水晶）直接给零向量。
 */
const speedOf = async (e, { lead = true } = {}) => {
  if (!lead || !e?.position) return new Vec3(0, 0, 0)
  const p0 = e.position.clone ? e.position.clone() : new Vec3(e.position.x, e.position.y, e.position.z)
  const ticks = 2                       // 100ms ≈ 2 tick（20 tick/s）
  await sleep(100)
  const p1 = e?.position
  if (!p1) return new Vec3(0, 0, 0)
  return new Vec3((p1.x - p0.x) / ticks, (p1.y - p0.y) / ticks, (p1.z - p0.z) / ticks)
}

/** 换到手里的武器；返回 `{ held, equipped }`（回读确认，和 `attack` 一个规矩） */
const holdWeapon = async (b, weapon) => {
  const now = b?.heldItem?.name ?? null
  if (now === weapon) return { held: `${now}x${b.heldItem?.count ?? 1}`, equipped: false }
  const item = (b?.inventory?.items?.() ?? []).find((it) => String(it?.name ?? '') === weapon)
  if (!item) {
    const have = (b?.inventory?.items?.() ?? []).map((it) => it.name).filter((n) => /bow|crossbow|trident/i.test(String(n)))
    throw new Error(`背包里没有 ${weapon}${have.length ? `（有：${[...new Set(have)].join('、')}）` : ''}—— 先 mc_craft 一把或者去拿`)
  }
  await b.equip(item, 'hand')
  const after = b?.heldItem?.name ?? null
  if (after !== weapon) throw new Error(`换 ${weapon} 没成功：换完手里是 ${after ?? '空'}`)
  return { held: `${after}x${b.heldItem?.count ?? 1}`, equipped: true }
}

/**
 * @param {object} b mineflayer bot
 * @param {object} args `{ who, x, y, z, count, waitTime, lead, weapon, radius, budget }`
 * @param {object} ctx `{ t, callLeft, grade, log }`
 *   · `ctx.t(promise, key, label)` —— 预算闸门（发包动作都要过）
 *   · `ctx.callLeft()` —— 这一轮还剩多少毫秒
 *   · `ctx.grade(target, speed, weapon)` —— 自检脚本注入假弹道用（不给就走真 hawkeye）
 */
/**
 * 射箭的正文（换弓 → 算弹道 → 瞄准 → 拉满 → 放箭 → 数箭）。
 *
 * 不直接对外：射完"把手换回去"要在**所有**出口（成功 / 半路停 / 抛错）都发生，
 * 所以外面套了一层 `shoot()` —— 和 `bridge.mjs` 的 `bridgeAcross` 同一个套路。
 */
async function shootInner (b, args = {}, ctx = {}) {
  const {
    who = null, x, y, z, count = 1, waitTime = DEFAULT_DRAW_MS, lead = true,
    weapon = 'bow', radius = 48, budget = 8_000,
  } = args ?? {}
  const t = ctx.t ?? (async (p) => await p)
  const callLeft = ctx.callLeft ?? (() => budget)

  const hasCoords = [x, y, z].every((v) => Number.isFinite(Number(v)))
  if (!who && !hasCoords) {
    throw new Error('要射谁/射哪：给 who（实体名，如 ender_dragon）或 x/y/z（方块坐标，射水晶用）')
  }
  if (who && hasCoords) throw new Error('who 和 x/y/z 只能给一个（要射那个实体就别给坐标）')
  if (!WEAPONS.has(String(weapon))) throw new Error(`weapon 只能是 ${[...WEAPONS].join(' / ')}（现在是 "${weapon}"）`)

  const n = Math.max(1, Math.min(5, Math.trunc(Number(count) || 1)))

  /* ① 换弓（先看手里是不是已经是了）。原来的那件由外面的 `shoot()` 记着，射完换回去 */
  const { held, equipped } = await holdWeapon(b, String(weapon))

  /* ② 箭：没有就别拉弓（服务端会白拉，白白吃掉这一轮的时间） */
  const arrowsBefore = arrowsIn(b)
  const creative = infiniteArrows(b)
  if (arrowsBefore === 0 && !creative) {
    throw new Error(`没有箭（背包里箭 = 0）—— 先 mc_give 一组 arrow，或者去捡/合成，再射`)
  }

  /* ③ 目标：坐标（水晶）或实体（龙）。实体每射一箭都重新找（龙会飞走） */
  const findTarget = () => {
    if (hasCoords) {
      const pos = new Vec3(Number(x), Number(y), Number(z))
      const me = b.entity?.position
      const dist = me && typeof pos.distanceTo === 'function' ? me.distanceTo(pos) : null
      return { obj: { position: pos, isValid: true }, label: `(${x}, ${y}, ${z})`, pos, dist, entity: false }
    }
    const snap = Object.values(b.entities ?? {})
      .filter((e) => e && e !== b.entity && e.position)
      .map((e) => ({ e, d: e.position.distanceTo(b.entity.position) }))
      .filter((s) => s.d <= Math.max(8, Number(radius) || 48))
    const { hit, near } = pickEntity(snap, who)
    if (!hit) {
      throw new Error(`附近 ${radius} 格内找不到 "${who}"（实际有：${near || '什么都没有'}）`)
    }
    return { obj: hit.e, label: entityNameOf(hit.e), pos: hit.e.position, dist: hit.d, entity: true }
  }

  /* ④ 弹道：真 hawkeye（每次重新 bind，见文件头坑 ②）或注入的假弹道 */
  const gradeOf = async (target) => {
    const speed = target.entity ? await speedOf(target.obj, { lead }) : new Vec3(0, 0, 0)
    if (typeof ctx.grade === 'function') return ctx.grade(target.obj, speed, String(weapon))
    const bind = await loadMcDep('hawkeye', { log: (m) => ctx.log?.(m), logWarn: (m) => ctx.log?.(m) })
    if (!bind) {
      throw new Error('没装 minecrafthawkeye（`vendor/mc-deps` 里缺这个包）—— 弹道算不出来，不瞎射')
    }
    bind(b)                              // 幂等：只把模块级单例换成本 bot（多号共进程时必须）
    if (typeof b.hawkEye?.getMasterGrade !== 'function') {
      throw new Error('hawkeye 挂上了但没给 getMasterGrade —— 版本不对，别射了')
    }
    return b.hawkEye.getMasterGrade(target.obj, speed, String(weapon))
  }

  const shots = []
  let fired = 0
  let why = null
  let lastTarget = null

  for (let i = 1; i <= n; i++) {
    const target = findTarget()
    lastTarget = target
    const grade = await gradeOf(target)
    if (!grade) {
      why = `算不出弹道：目标 ${target.dist != null ? target.dist.toFixed(1) + ' 格' : '太远'}、角度也刁 —— `
        + 'hawkeye 要求落点误差 ≤ 4 格，靠近一点或换个高度再射'
      break
    }
    if (callLeft() < MIN_DRAW_MS + 600) { why = '这一轮时间不够拉满弓了（要 ≥ 1 秒）'; break }

    /* ⑤ 瞄准 → 拉弓 → 等拉满 → **再瞄一次**（目标动了/龙在俯冲）→ 放 */
    await t(b.look(grade.yaw, grade.pitch, true), 'look', '射箭瞄准')
    await t(b.activateItem(), 'use', '拉弓')
    const drawMs = Math.max(Number(ctx.minDrawMs ?? MIN_DRAW_MS), Math.min(Number(waitTime) || DEFAULT_DRAW_MS, callLeft() - 500))
    await sleep(drawMs)
    if (target.entity && lead) {
      const again = await gradeOf(target)
      if (again) await b.look(again.yaw, again.pitch, true)
    }
    await sleep(LOOK_SETTLE_MS)
    await t(b.deactivateItem(), 'use', '放箭')
    const after = await arrowsAfterRelease(b, arrowsBefore, creative, ctx.pollMs)
    const used = arrowsBefore - after
    const blockedPos = grade.blockInTrayect?.position ?? null
    shots.push({
      n: i,
      yawDeg: Number((grade.yaw * 180 / Math.PI).toFixed(1)),
      pitchDeg: Number((grade.pitch * 180 / Math.PI).toFixed(1)),
      grade: Number(Number(grade.grade ?? 0).toFixed(1)),
      aimError: Number(Number(grade.nearestDistance ?? 0).toFixed(2)),
      dist: target.dist != null ? Number(target.dist.toFixed(1)) : null,
      blocked: blockedPos ? (b.blockAt?.(blockedPos)?.name ?? '?') : null,
      ...(blockedPos ? { blockedAt: [blockedPos.x, blockedPos.y, blockedPos.z] } : {}),
      arrowsUsed: Math.max(0, used),
    })
    fired++
    if (!creative && used <= 0) { why = '箭数没变 —— 服务端没认这次放箭（可能没拉满/被拒），别接着射'; break }
  }

  const arrowsAfter = arrowsIn(b)
  const ok = fired > 0 && (creative || arrowsBefore > arrowsAfter)
  return {
    ok,
    weapon: String(weapon),
    held,
    ...(equipped ? { equipped: true } : {}),
    ...(creative ? { creative: true } : {}),
    ...(lastTarget
      ? {
          target: {
            name: lastTarget.label,
            at: [Math.floor(lastTarget.pos.x), Math.floor(lastTarget.pos.y), Math.floor(lastTarget.pos.z)],
            ...(lastTarget.dist != null ? { dist: Number(lastTarget.dist.toFixed(1)) } : {}),
          },
        }
      : {}),
    fired,
    shots,
    arrows: { before: arrowsBefore, after: arrowsAfter },
    ...(why ? { why } : {}),
  }
}

/**
 * 射箭（对外入口）—— 射完把手换回原来那件。
 *
 * 为什么必须包一层：`shootInner` 里有三个出口（射完 / 半路停 / 抛错），
 * 换回去这件事**每个出口都得做**；`finally` 是唯一能一次覆盖三处的地方。
 * 换不回来不算失败（箭已经射出去了），只如实记一句 `heldRestoreWhy`。
 */
export async function shoot (b, args = {}, ctx = {}) {
  const keep = heldSnapshotOf(b)
  let out = null
  try {
    out = await shootInner(b, args, ctx)
    return out
  } finally {
    const r = await restoreHeldOf(b, keep)
    if (out) {
      if (r.restored) out.heldRestored = keep.name
      else if (r.why) out.heldRestoreWhy = r.why
      out.held = b?.heldItem ? `${b.heldItem.name}x${b.heldItem.count ?? 1}` : '空手'
    }
  }
}
