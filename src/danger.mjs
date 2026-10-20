/*
 * 危险信号 —— 回答一个问题：**"现在，值得把控制权从循环里抢回来吗？"**
 *
 * ── 为什么要有这一层（2026-10-17 实机，用户报"工具排队执行、延迟很大"）────────────
 * `mc_sequence` 一次能塞 64 步，AI 常塞十几步。实机日志（一个晚上 61 次调用）：
 *
 *     总工具耗时        334.6 秒
 *     其中 >=5000ms 的  301.4 秒   ← 占 90%
 *     mc_sequence       34 次  平均 7071ms  最长 11010ms（顶到 CALL_MS 硬上限）
 *     同一时段「mc_auto 叫醒 AI」18 次
 *
 * 而**一次工具调用是原子的** —— 循环里只查 `abortSignal` 和预算，**没有一处查"我正在挨打"**。
 * 于是这一幕成立（用户截图那次）：12 个 `break` 往下挖竖井 → 骷髅跟下来一路射 →
 * 直到那 10 秒过完 AI 才知道。日志里两行紧挨着：
 *
 *     00:16:31  mc_auto：zombie 贴上来 → 已叫醒 AI 定策略（血 17/20）
 *     00:16:36  [调度器] 动作 a73 mc_act 3471ms completed
 *
 * **反射层 5 秒前就把 AI 叫醒了**，但 AI 动不了 —— 它卡在还没返回的调用里。
 * 调度器那边没问题（`模式 observe-only`，不排队），卡的是"动作发出去就没人能打断"。
 *
 * ── 这一层的规矩 ──────────────────────────────────────────────────────────────
 * 判据**保守**，只认两件事：
 *   ① 这次循环期间**掉过血**（`hp0` = 循环开始时的血）—— 最直接的证据；
 *   ② 敌对怪贴到 `DANGER_HOSTILE_R` 格内 —— 还没打到，但已经来不及了。
 * **8 格外有只僵尸不算**：反射层会为它叫醒 AI，但没必要把一个正常的挖掘串砍断 ——
 * 砍断太勤会让"挖 12 格"变成 12 次调用，反而更慢（这正是我们要修的病）。
 *
 * 只读，**不动 bot、不发指令、不占资源** —— 怎么用由调用方（`sequence` / `build` / `mining`
 * 的循环）决定：它们拿到非 null 就带进度 `break`，把 `next` 交回给 AI。
 *
 * 形状：只认 `b.entities` / `b.entity` / `b.health` 三样（与 `world-scan.mjs` 同一套路数），
 * 不 import 游戏库、不 import `core.mjs`。
 */
import { HOSTILE_RE, hostilityOf } from './entity-names.mjs'

/** 敌对怪贴到这个距离内 ⇒ 紧急（3 格：僵尸再走一步就够到了） */
export const DANGER_HOSTILE_R = 3
/** 这次循环期间掉这么多血就算"挨打了"（1 点 = 被僵尸碰一下） */
export const DANGER_HP_LOST = 1

/** 读血量；读不到回 `null`（**不回 0** —— 那会让"不知道"变成"血空了"） */
export function healthOf (b) {
  /* 🔴 `Number(null) === 0` 而且 `Number.isFinite(0)` 为真 —— 少了这道 null 判，
   *    "读不到血"会变成"血 = 0"，于是 `hp <= hp0 - 1` 恒成立 ⇒ 每步都以为在挨打。
   *    （同款坑见 `踩坑档案.md` 第 112 / 113 条。） */
  const h = b?.health
  if (h == null || h === '') return null
  const n = Number(h)
  return Number.isFinite(n) ? n : null
}

/**
 * 最近的敌对怪（`radius` 格内），没有就回 `null`。
 * 与 `extensions/mc_auto.mjs` 的 `hostilesNear()` 同一套判据（那边自带一份正则，见 `entity-names.mjs` 的注释）。
 */
export function nearestHostile (b, radius = DANGER_HOSTILE_R) {
  const me = b?.entity?.position
  if (!me) return null
  let best = null
  for (const e of Object.values(b?.entities ?? {})) {
    if (!e || e === b.entity || !e.position) continue
    const nm = String(e.name ?? e.username ?? '')
    /* 🔴 2026-10-18 审计：末影人/猪灵在 `HOSTILE_RE` 里，但**默认中立** ——
     *    走过去一只末影人就把正在跑的 12 步序列砍断（"有怪贴脸"），可它根本不打人。
     *    中立怪只有**正在打我**（它的 target 是我）才算威胁。 */
    const stance = hostilityOf(nm, e.kind)
    const d = e.position.distanceTo(me)
    if (!Number.isFinite(d) || d > radius) continue
    /* 🔴 2026-10-20 审计：这里原来判 `e.target === b.entity`（"它正盯着我"），
     *    但 prismarine-entity **根本没有 `target` 字段**（那个包里 target 零命中）——
     *    这行永远 false，等于一段死代码。而"中立怪真的在打我"这件事，
     *    上面的 ① 掉血判据已经覆盖了（被末影人/猪灵打 ⇒ 掉血 ⇒ kind:'hurt'），
     *    所以这里**只认 `hostile`**，中立怪贴脸不算"危险"（2026-10-18 用户定的：
     *    路过一只末影人就把 12 步序列砍断，反而更糟）。 */
    if (stance !== 'hostile') continue
    if (!best || d < best.distance) {
      best = {
        name: nm || String(e.type ?? '?'),
        distance: Math.round(d * 10) / 10,
        position: { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) },
      }
    }
  }
  return best
}

/**
 * 现在危险吗？`hp0` 传**循环开始时**的血量（不传就只查怪）。
 * @returns {null | { kind: 'hurt'|'fireball'|'breath'|'hostile', health: number|null, hp0?: number, lost?: number, name?: string, distance?: number, position?: object }}
 */
export function dangerNow (b, { hp0 = null, radius = DANGER_HOSTILE_R, lost = DANGER_HP_LOST } = {}) {
  const hp = healthOf(b)
  /* ① 掉血优先报：它是"已经打到我身上了"，比"有怪在附近"硬。
   *    `hp0 == null`（循环开始时就读不到血）⇒ 这一条**不判**，不能拿 null 比大小。 */
  if (hp != null && hp0 != null && hp <= hp0 - lost) {
    return { kind: 'hurt', health: hp, hp0, lost: Math.round((hp0 - hp) * 10) / 10 }
  }
  /* ② 龙息火球（还在飞的那颗）—— 落地才变云，所以它比云早几秒
   *    🔴 2026-10-20 审计：以前 32 格内**任何**一颗弹都抢在这里，且不看已经算好的 `inbound`。
   *    末影龙一直在吐弹，哪怕那颗正飞离我，也会把"僵尸贴到 3 格"整个盖掉
   *    ⇒ 只有"朝我飞 / 方向说不清"的弹抢优先级，飞走的弹排到敌对怪之后（见末尾）。 */
  const ball = fireballNear(b)
  if (ball && ball.inbound !== false) return { kind: 'fireball', health: hp, ...ball }
  /* ③ 龙息云：**踩进去就在掉血**，比"有怪贴脸"更急（用户 2026-10-19：「检测到龙息应该提醒」） */
  const breath = breathNear(b)
  if (breath) return { kind: 'breath', health: hp, ...breath }
  const foe = nearestHostile(b, radius)
  if (foe) return { kind: 'hostile', health: hp, ...foe }
  if (ball) return { kind: 'fireball', health: hp, ...ball }
  return null
}

/**
 * 龙息云（`area_effect_cloud`）—— 末影龙吐出来的那团紫雾。
 *
 * 🔴 用户 2026-10-19：「现在不会躲龙息，检测到龙息应该提醒」。
 *    末地那趟我被它烧死过至少 5 次：云半径约 3 格，**站在里面每 0.5 秒掉 4 点血**，
 *    血 20 也就十来秒的事。它不属于"敌对实体"（`hostilesNear` 看不见它），
 *    也不掉血（只要你不进去），所以以前的报险逻辑完全没反应 —— 人就这么一路站着被熏死。
 *
 * 判据只有一条：`name === 'area_effect_cloud'`（龙息、滞留药水都是它），拿最近的那团说事。
 */
export const BREATH_RE = /^area_effect_cloud$/i
/** 云半径 3 格 + 再留一格退路 ⇒ 6 格内就提醒 */
export const BREATH_NEAR_R = 6

/**
 * 最近的龙息云：`{ name, distance, position, escape }`，没有就 `null`。
 * `escape` 是"往哪边跑"（单位向量，已算好水平方向 + 建议跑几格），省得调用方再算一遍。
 */
export function breathNear (b, radius = BREATH_NEAR_R) {
  const me = b?.entity?.position
  if (!me) return null
  let best = null
  for (const e of Object.values(b?.entities ?? {})) {
    if (!e || e === b.entity || !e.position) continue
    if (!BREATH_RE.test(String(e.name ?? ''))) continue
    const d = e.position.distanceTo(me)
    if (!Number.isFinite(d) || d > radius) continue
    if (!best || d < best.distance) best = { e, d }
  }
  if (!best) return null
  const { e, d } = best
  let dx = me.x - e.position.x
  let dz = me.z - e.position.z
  const len = Math.hypot(dx, dz)
  if (len < 0.2) { dx = 1; dz = 0 } else { dx /= len; dz /= len }
  const away = Math.max(8, Math.ceil(d) + 6)      // 跑出云外 + 余量
  return {
    name: 'area_effect_cloud',
    distance: Math.round(d * 10) / 10,
    position: { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) },
    escape: {
      dx: Math.round(dx * 100) / 100,
      dz: Math.round(dz * 100) / 100,
      blocks: away,
      x: Math.floor(me.x + dx * away),
      z: Math.floor(me.z + dz * away),
    },
  }
}

/**
 * 龙息**火球**（`dragon_fireball`）—— 落地才变成上面那团云，飞在半路时是**另一个实体**。
 *
 * 用户 2026-10-19 追问：「只能落地的才能检测到吗」——问到点子上了：
 * `area_effect_cloud`（id 3，宽 6 ⇒ 半径 3）是**已经落地**的那团；龙吐出来的是
 * `dragon_fireball`（id 35，projectile，1×1），飞到落地/碰撞后才生成云。
 * 只盯云等于只在"已经晚了"的那一刻报警 —— 所以这里连"飞过来的火球"一起看：
 * 能判断是不是朝我这边飞（`velocity` 与我成锐角）。
 */
export const FIREBALL_RE = /^dragon_fireball$/i
/** 用户 2026-10-19：「在飞的龙息弹改成 32 格告警」—— 让 AI 有 2~3 秒的决策时间，
 *  而不是等它飞进 14 格（那时只剩 1 秒，说什么都来不及）。 */
export const FIREBALL_NEAR_R = 32

/**
 * 预测**落点**：沿速度方向一格半格地往前探，第一个实心方块就是它撞上的地方。
 *
 * 用户 2026-10-19：「火球 26.5 格（24, 72, 8）这里可以改成落点吗」—— 对，报"它现在在哪"
 * 不如报"它会砸在哪"：云就长在落点上，AI 只需要知道**落点离我多远、要不要跑**。
 *
 * 只认 `bot.blockAt`（读不到区块就跳过那一格，不瞎猜）；没有 `blockAt`（自检/别的宿主）回 `null`。
 * 火球基本走直线（`AbstractHurtingProjectile` 只带一点点阻力），所以直线推进够准。
 * @returns {null | { x:number, y:number, z:number, blocks:number, hitsMe:boolean, distanceToMe:number }}
 */
export function predictImpact (b, pos, vel, { maxBlocks = 96, step = 0.5 } = {}) {
  if (!pos || !vel) return null
  const blockAt = typeof b?.blockAt === 'function'
    ? b.blockAt.bind(b)
    : (typeof b?.world?.blockAt === 'function' ? b.world.blockAt.bind(b.world) : null)
  if (!blockAt) return null
  /* 🔴 2026-10-20 审计（真 bug）：`bot.blockAt(pos)` 一路走到 prismarine-world 的
   *    `getBlock(pos)`，那里第一行就是 `pos.floored()` —— 纯对象 `{x,y,z}` **没有这个方法**，
   *    于是每一格都抛 TypeError，而下面的 `catch { return null }` 把它吞成"算不出落点"。
   *    ⇒ 这个"预测落点"从上线起**一次都没生效过**（`fireballNear` 一直在走 `approx` 兜底）。
   *    本文件约定不 import 游戏库，所以直接从实体坐标上取 Vec3 的构造器。 */
  const VecCtor = (() => {
    try {
      const p = b?.entity?.position
      return typeof p?.floored === 'function' ? p.constructor : null
    } catch { return null }
  })()
  const vec = (x, y, z) => (VecCtor ? new VecCtor(x, y, z) : { x, y, z })
  const speed = Math.hypot(vel.x, vel.y ?? 0, vel.z)
  if (!(speed > 0.01)) return null
  const ux = vel.x / speed
  const uy = (vel.y ?? 0) / speed
  const uz = vel.z / speed
  const me = b?.entity?.position ?? null
  for (let t = step; t <= maxBlocks; t += step) {
    let blk = null
    try {
      const q = typeof pos.offset === 'function'
        ? pos.offset(ux * t, uy * t, uz * t)
        : { x: pos.x + ux * t, y: pos.y + uy * t, z: pos.z + uz * t }
      blk = blockAt(vec(Math.floor(q.x), Math.floor(q.y), Math.floor(q.z)))
    } catch { return null }
    if (!blk) continue                       // 未加载 / 查不到：当作没撞上，接着往前探
    const bb = blk.boundingBox
    const solid = bb == null ? true : bb !== 'empty'
    if (!solid) continue
    const x = Math.floor(blk.position?.x ?? (pos.x + ux * t))
    const y = Math.floor(blk.position?.y ?? (pos.y + uy * t)) + 1   // 云长在落点上方那一层
    const z = Math.floor(blk.position?.z ?? (pos.z + uz * t))
    const distanceToMe = me ? Math.round(Math.hypot(me.x - x, me.z - z) * 10) / 10 : null
    return {
      x, y, z,
      blocks: Math.round(t * 10) / 10,
      distanceToMe,
      hitsMe: distanceToMe != null && distanceToMe <= 3.5,   // 云半径 3 格
    }
  }
  return null
}

/** 最近的龙息火球：`{ name, distance, position, inbound, escape }`，没有就 `null` */
export function fireballNear (b, radius = FIREBALL_NEAR_R) {
  const me = b?.entity?.position
  if (!me) return null
  let best = null
  for (const e of Object.values(b?.entities ?? {})) {
    if (!e || e === b.entity || !e.position) continue
    if (!FIREBALL_RE.test(String(e.name ?? ''))) continue
    const d = e.position.distanceTo(me)
    if (!Number.isFinite(d) || d > radius) continue
    if (!best || d < best.distance) best = { e, d }
  }
  if (!best) return null
  const { e, d } = best
  /* 朝我飞吗：速度在"从我到它"的反方向上有分量 ⇒ 正在靠近 */
  const v = e.velocity
  let inbound = null
  let etaSec = null
  if (v && Number.isFinite(v.x) && Number.isFinite(v.z)) {
    const speed = Math.hypot(v.x, v.y ?? 0, v.z)
    if (speed > 0.05) {
      const toMeX = me.x - e.position.x
      const toMeZ = me.z - e.position.z
      inbound = v.x * toMeX + v.z * toMeZ > 0
      /* mineflayer 的 velocity 是**每 tick 的位移**（1 tick = 50ms）⇒ 换算成秒 */
      etaSec = Math.round((d / (speed * 20)) * 10) / 10
    }
  }
  /* 落点：比"它现在在哪"有用得多（云就长在那儿）。
   * 一路没撞到方块（末地大片虚空/没加载的区块）时退一步算"离我最近的那个点"——
   * 报"近似落点"也比报"算不出来"有用：那才是它从我身边掠过的地方。 */
  let impact = v && Number.isFinite(v.x) ? predictImpact(b, e.position, v) : null
  if (!impact && v && Number.isFinite(v.x)) {
    const speed = Math.hypot(v.x, v.y ?? 0, v.z)
    if (speed > 0.05) {
      const ux = v.x / speed, uy = (v.y ?? 0) / speed, uz = v.z / speed
      const rx = me.x - e.position.x, ry = me.y - e.position.y, rz = me.z - e.position.z
      const t = Math.max(0, Math.min(96, rx * ux + ry * uy + rz * uz))
      const px = e.position.x + ux * t, py = e.position.y + uy * t, pz = e.position.z + uz * t
      const horiz = Math.hypot(me.x - px, me.z - pz)
      impact = {
        x: Math.floor(px), y: Math.floor(py), z: Math.floor(pz),
        blocks: Math.round(t * 10) / 10,
        distanceToMe: Math.round(horiz * 10) / 10,
        hitsMe: horiz <= 3.5,
        approx: true,
      }
    }
  }
  /* 躲的方向：垂直入射方向侧移（火球走直线，横向挪开最省力） */
  let dx = me.x - e.position.x
  let dz = me.z - e.position.z
  const len = Math.hypot(dx, dz)
  if (len < 0.2) { dx = 1; dz = 0 } else { dx /= len; dz /= len }
  return {
    name: 'dragon_fireball',
    distance: Math.round(d * 10) / 10,
    position: { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) },
    inbound,
    etaSec,
    impact,
    escape: { dx: Math.round(dx * 100) / 100, dz: Math.round(dz * 100) / 100, blocks: 5,
      x: Math.floor(me.x + dx * 5), z: Math.floor(me.z + dz * 5) },
  }
}

/** 火球的一句话（`null` 进 `null` 出） */
export function fireballText (f) {
  if (!f) return null
  const esc = f.escape
  const to = esc ? `，往 (${esc.x}, ${esc.z}) 侧移` : ''
  const eta = f.etaSec != null && f.inbound ? `，约 ${f.etaSec} 秒到` : ''
  const at = f.impact
    ? `${f.impact.approx ? '，掠过点约' : '，落点'} (${f.impact.x}, ${f.impact.z})`
      + (f.impact.distanceToMe != null ? `（离我 ${f.impact.distanceToMe} 格${f.impact.hitsMe ? '，**正砸我脚下**' : ''}）` : '')
    : ''
  return `龙息火球在 ${f.distance} 格${at}${f.inbound ? '、正朝我飞来' : ''}${eta}${to}`
}

/** 龙息云的一句话（`null` 进 `null` 出）：带"往哪跑"的落点坐标 */
export function breathText (c) {
  if (!c) return null
  const esc = c.escape
  const to = esc ? `，往 (${esc.x}, ${esc.z}) 那边跑 ${esc.blocks} 格` : ''
  return `龙息云在 ${c.distance} 格${to}`
}

/** 给人看的一句话（`null` 进 `null` 出） */
export function dangerText (d) {
  if (!d) return null
  if (d.kind === 'hurt') return `正在挨打（血 ${d.hp0} → ${d.health}）`
  if (d.kind === 'fireball') return fireballText(d) ?? '龙息火球飞过来了'
  if (d.kind === 'breath') return breathText(d) ?? '站进龙息云里了'
  const where = d.position ? `（${d.position.x}, ${d.position.y}, ${d.position.z}）` : ''
  return `${d.name} 贴到 ${d.distance} 格了${where}`
}

/**
 * 「只提醒、不打断」时写进结果里的那一行。
 *
 * 🔴 用户 2026-10-19：「不要打断只提醒」—— 长动作（`mc_sequence` / `mc_build` / `mc_dig`）
 *    以前一挨打就**带进度退出**、把控制权交回给 AI：挖一半的竖井、搭一半的桥都得重发一次，
 *    而 AI 还得先处理怪、再重看现场，一来一回就是好几个回合。
 *    现在默认改成**把险情写进结果、活照跑完这一轮**（每轮本来就 ≤11 秒），
 *    真要停下来处理由反射层（`mc_auto`）叫醒决定；想恢复旧行为就把 `config.stopOnDanger` 设成 true。
 */
export function dangerNotice (d) {
  const t = dangerText(d)
  return t ? `⚠️ ${t} —— 只提醒，没打断（这一轮跑完再说）` : null
}

/** 同一种险情**一次调用里只提醒一次**（不然每挖一格刷一行，把结果挤满） */
export function noticeKey (d) {
  return d ? `${d.kind}:${d.name ?? ''}` : ''
}
