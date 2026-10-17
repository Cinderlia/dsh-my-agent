/**
 * "打谁 / 怎么打"那一层（路线图第 ④ 条第二十一刀）。
 *
 * 搬走 `McBot.attack({ who, budget })`（原 116 行，`core.mjs` 里第二大的"动作"方法）。
 * 只认一个 bot + 一个 `ctx = { t, callLeft, abortSignal, hasPvp, moveTo, equipTo }`：
 *   · `ctx.t`           —— 预算闸门（只有"没有 pvp 退回挥手"那条路才发包，要过闸门）
 *   · `ctx.callLeft()`  —— 这一轮还剩多少毫秒（决定"等多久"和"挥几下"）
 *   · `ctx.abortSignal` —— 玩家新命令抢占（`mc_stop` / 新一轮工具调用）
 *   · `ctx.hasPvp`      —— 插件实例状态（`this.mcPlugins.pvp`），不是 bot 的
 *   · `ctx.moveTo`      —— 走位/撤退用（现成的 `walkTo`，**不是**第二套移动控制器）
 *   · `ctx.equipTo`     —— 换武器用（现成的 `equip`）
 *   后两个**可以没有**：缺了就退化（想撤却没得撤时如实说"没给我移动能力"），不报错。
 *
 * 这里踩过的坑（`踩坑档案.md` 第 12 / 26 / 27 条）：
 *   ① `bot.pvp.attack(target)` **立刻** resolve（上游 `mineflayer-pvp\lib\PVP.js:60-76`
 *      只做三件事：设 target、`GoalFollow` 追过去、发 `startedAttacking`），真正挥拳的是
 *      `physicTick` 上的后台循环 ⇒ 旧写法 `await withTimeout(b.pvp.attack(...))` 一毫秒就返回、
 *      紧接着 `finally` 里 `b.pvp.stop()` 又把追过去的 goal 停掉 ⇒ **一下都没打，却回 "attacked: X"**。
 *      所以这里必须自己等：等到目标从 `bot.entities` 消失 / `isValid === false` / 这一轮的时间用完。
 *   ② `pvp.stop()` **不能 await**：它内部 `onceWithTimeout('path_stop', 5000)` 最多等 5 秒，
 *      会把这一轮的预算整段吃光（pathfinder 的 stop 在它第一行就已经做了）。
 *   ③ 名字匹配要看**所有**名字字段（`username` / `name` / `displayName` / `type` / `kind`）
 *      + 中文别名；找不到时**列出半径内实际有谁**，别只丢一句"附近找不到"。
 *   ④ 不带 `who` 时**只追怪**（24 格内的敌对也追），动物/玩家仍只在 4.5 格内 ——
 *      否则"打最近的"会跑过去揍玩家 6 格外的马。
 *
 * ── 2026-10-17 新增：战斗策略层（用户方案）────────────────────────────────
 * 以前这个函数只会做一件事 —— **一直往前顶**：血 4 还在顶、旁边三只怪还在顶、追不上还在顶。
 * 现在把"该进攻还是该撤"交给 `src\combat-strategy.mjs`（纯函数、不碰 bot），
 * 本文件只负责**执行一个阶段 → 重新观察 → 再问一次**。
 *
 * 🔴 三条不能破的规矩（用户原话）：
 *   · **不新建第二套移动控制** —— 走位/撤退一律 `ctx.moveTo`（现成 `walkTo`，
 *     带它自己的进度监控与脱困阶梯）。本文件里**没有一处** `setControlState`。
 *   · **不新建第二个任务状态机** —— 只报告结果，要不要继续追击/换目标/恢复原任务，
 *     由 `mc_task` 那一层决定。这里**没有** `tasks.*` 调用。
 *   · **不在 `mc_attack` 内部再调一个新工具**去换武器或吃东西（会嵌套调度、
 *     重复占资源、甚至等自己释放资源而死锁）—— 换武器走 `ctx.equipTo` 这个**能力回调**。
 *
 * 🔴 战斗结局叫 **`combat`**，不叫 `outcome` —— `outcome` 是**跨工具**的"三种结局"
 *    （`confirmed`/`failed`/`unknown`/`stale`，见 `src\task-runner.mjs` 的 `outcomeOf()`），
 *    所有工具共用同一个含义。第一版战斗结局直接占了 `outcome`，结果 `withOutcome()`
 *    见到已有 `outcome` 就原样放过（`index.js:1989`）⇒ AI **再也看不到"这事到底成没成"**，
 *    而同一个字段名在不同工具里意思还不一样。现在两个字段各说各的：
 *    `combat` = 战斗结局（打死/打伤/撤了/够不着/被中止/超时），
 *    `outcome` = 统一结局（`outcomeOf()` 会把 `combat` 翻译过去）。
 */
import { sleep } from './async-util.mjs'
import { callBudget } from './budget.mjs'
import { HOSTILE_RE, RANGED_RE, JUNK_RE, NAME_ALIAS, entityNameOf, nameFieldsOf, hostilityOf } from './entity-names.mjs'
import { dropHint, entityHealth } from './world-observer.mjs'
import { durabilityOf, EQUIP_SLOTS } from './inventory.mjs'
import {
  assessCombat, chooseStrategy, combatOutcomeOf, combatOutcomeText, combatPlanText,
  retreatPointOf, approachPointOf, isShield, RETREAT_DISTANCE, COMBAT_PHASE_MS,
} from './combat-strategy.mjs'

/**
 * 挨打记录：`bot → { at, health }` 上一次看到的样子。
 *
 * 为什么要跨调用记：一次 `mc_attack` 里通常只有**一轮**（那一轮就把预算吃光了），
 * 一轮里采不到第二个血量样本 ⇒ "每秒掉多少血"永远是 0 ⇒ "正在挨打"这个判据形同虚设。
 * 拿上一次调用收工时的血量当起点，才比得出这一轮挨了多少。
 * 用 `WeakMap` 是为了不吊住 bot（断开重连会换对象，旧记录自己就没了）。
 */
const LAST_SEEN = new WeakMap()

/** 一轮战斗最多重新评估几次（防止"进攻→够不着→进攻"这种抖动把预算磨光）
 *  真正的抖动防线是 `repositions` / `equips` 各自的次数上限；这个数字只是最后一道保险。 */
const MAX_ROUNDS = 8

export async function attack (b, { who = null, budget = 20_000 } = {}, ctx = {}) {
  const needle = who ? String(who).trim().toLowerCase() : null
  const alias = needle ? NAME_ALIAS[needle] : null
  const hasPvp = Boolean(ctx.hasPvp) && typeof b.pvp?.attack === 'function'
  /* 🔴 位置要**每次现读**（`b.entity.position` 是活的）——
   *    旧写法在函数开头 `const me = b.entity.position` 抓一次，走位之后就过期了。 */
  const distOf = (e) => { try { return e.position.distanceTo(b.entity.position) } catch { return Infinity } }
  const all = Object.values(b.entities ?? {})
    .filter((e) => e && e !== b.entity && e.position)
    .map((e) => ({ e, d: distOf(e), nm: entityNameOf(e) }))
    .filter((x) => x.d <= 24)
  /* 🔴 2026-10-17（用户实机："怪物好像不显示中立"）：立场判定统一走 `hostilityOf()`。
   *    原来这里把 `HOSTILE_RE` 命中就算敌对，而那份名单里有 `enderman` / `piglin` ——
   *    于是不带名字的 `mc_act{attack}` 会**主动去揍末影人**（本不会打你、能瞬移、40 血），
   *    而狼 / 蜜蜂 / 铁傀儡（真惹了会打你）被归进"其它"，连"被围"都不算。 */
  const stanceOf = (x) => (x.e.username || x.e.type === 'player')
    ? 'player'
    : hostilityOf(x.nm, x.e.kind)
  const rankOf = (x) => {
    if (JUNK_RE.test(x.nm)) return 4                                  // 掉落物 / 经验球 / 箭
    const st = stanceOf(x)
    if (st === 'hostile') return 0
    if (st === 'player') return 1
    if (st === 'neutral') return 2                                    // 中立：只有点名才打
    return 3                                                          // 动物之类
  }
  const hit = (x) => {
    if (!needle) return true
    const fields = nameFieldsOf(x.e)
    if (fields.some((v) => v.includes(needle))) return true
    return Boolean(alias) && fields.some((v) => v.includes(alias))
  }
  // 🔴 不给 who 时**只追怪**（24 格内的敌对也追），动物/玩家仍只在 4.5 格内 ——
  //    否则"打最近的"会跑过去揍玩家 6 格外的马（2026-10-08 探针实测附近就有 horse 6.8 格）。
  /* 🔴 中立怪（末影人 / 猪灵 / 狼 / 蜜蜂 / 铁傀儡…）**不带名字就绝不去打**。
   *    它们本不会主动打你，但惹了会 —— 末影人 40 血 + 能瞬移，是最不该"顺手打一只"的。
   *    动物仍然只在 4.5 格内才算（打猎），玩家也改成必须点名。 */
  const inReach = needle ? all : all.filter((x) => rankOf(x) === 0 || (x.d <= 4.5 && rankOf(x) === 3))
  const list = inReach.filter(hit).sort((a, c) => (rankOf(a) - rankOf(c)) || (a.d - c.d))
  const near = all.slice().sort((a, c) => a.d - c.d).slice(0, 6)
    .map((x) => `${x.nm} ${x.d.toFixed(1)} 格`).join('、')
  /* 打完这一只，**附近还有哪些怪** —— 顺手报一句（用户 2026-10-16："用完 mc_attack 后自动调用
   * 获取实体的功能，防止周围有其他怪物"）。
   * 🔴 为什么非报不可：`extensions/mc_auto.mjs:1119` 的反射层在 `s.inFlight > 0` 时
   *    **故意压住**怪物警报（除非正在挨打、或怪已经贴到 URGENT_RADIUS 以内）—— 也就是说
   *    AI 打 A 的那几秒里，旁边的 B/C 一声不吭；这次调用一返回，AI 看到 `killed:true` 就走，
   *    正撞上 B。数据本来就在手（`all` 已经列了 24 格内的全部实体），零额外遍历。
   *    没怪时返回 `{}`（一个键都不加），所以常态零结果 token。 */
  const NEARBY_R = 16
  const foesNear = (exclude) => {
    const foes = Object.values(b.entities ?? {})
      .filter((e) => e && e !== b.entity && e !== exclude && e.position)
      .map((e) => ({ e, d: distOf(e), nm: entityNameOf(e) }))
      .filter((x) => x.d <= NEARBY_R && stanceOf(x) === 'hostile')
      .sort((a, c) => a.d - c.d)
      .slice(0, 5)
      .map((x) => {
        const hp = entityHealth(b, x.e)
        return { name: x.nm, distance: Number(x.d.toFixed(1)), ...(hp == null ? {} : { health: hp }) }
      })
    if (!foes.length) return {}
    return {
      nearby: foes,
      nearbyNote: `⚠️ 附近还有 ${foes.length} 只怪：`
        + foes.map((f) => `${f.name} ${f.distance} 格${f.health == null ? '' : `（血 ${f.health}）`}`).join('、'),
    }
  }
  const pick = list[0]
  // 半径内只剩掉落物（且不在手边）就别动手：打到一个 item 是白费一轮
  /* 🔴 2026-10-15 审计：点名点到掉落物时，旧文案是"附近找不到 X（24 格内实际有：X）"——
   *    同一句话里自相矛盾（找不到却列出来了）。这里单独说清"它是掉落物、而且够不着"。 */
  const dropOutOfReach = Boolean(pick && rankOf(pick) === 4 && pick.d > 4.5)
  const target = pick && !dropOutOfReach ? pick.e : null
  if (!target) {
    if (needle && dropOutOfReach) {
      throw new Error(`"${who}" 是**掉落物**，而且离我 ${pick.d.toFixed(1)} 格（超过 4.5 格）—— 我不打掉落物。`
        + '要捡它就先 `mc_move` 走过去站上去（一两秒就自己飞进背包）。')
    }
    if (needle) {
      /* 🔴 2026-10-17（用户实机：苦力怕贴到 3 格，它报「附近找不到 creeper」，只列出 `item 2.5 格`，
       *    然后换着法子瞎试了十几个调用）：原句只说"找不到"，模型无法区分
       *    ① **名字写错了**（那好办，改个名）② **客户端根本没跟踪到那只怪**
       *    （重生 / 换维度 / 区块卸载之后 `bot.entities` 会被清空或过期 —— 这时改一百次名字都没用）。
       *    所以把"客户端共跟踪几个实体 + 我自己在哪"一并报出来：数字少得离谱本身就是证据。 */
      const seen = Object.keys(b.entities ?? {}).length
      const me = b.entity?.position
      const meText = me && Number.isFinite(me.x)
        ? `(${me.x.toFixed(1)}, ${me.y.toFixed(1)}, ${me.z.toFixed(1)})`
        : '（坐标读不到）'
      throw new Error(`附近找不到 "${who}"（24 格内实际有：${near || '什么都没有'}）`
        + ` —— 客户端现在共跟踪 ${seen} 个实体，我自己在 ${meText}。`
        + (seen < 8
          ? '**这么少基本说明客户端没跟上服务端**（刚重生 / 换了维度 / 区块还没加载）—— '
            + '先 `mc_observe` 看一眼身边到底有什么，别反复换名字试。'
          : '')
        + '名字要跟 `mc_observe` "程序检测到"里显示的一致（中文叫法也认）；'
        + '要打远处那只就先 `mc_move` 过去，怪跑远了同样找不到。')
    }
    throw new Error(`4.5 格内没有能打的实体${near ? `（24 格内最近的是 ${near}）` : ''}`
      + ' —— 掉落物 / 经验球不算，动物与玩家要贴到 4.5 格内；'
      + '要打远处的怪就先 `mc_move` 过去（或 `mc_act {mode:"attack", who:"zombie"}`，那个会追 24 格）。')
  }
  const label = entityNameOf(target)
  const d = Number(distOf(target).toFixed(1))
  const hpBefore = entityHealth(b, target)

  /* ═══════════ ① 进攻阶段（原来的实现原样搬进来，只改"谁来叫它"） ═══════════ */

  /** 这次调用还剩多少总预算（每一轮进攻都从这里面扣，不能每轮各拿一份满预算） */
  const budgetLeft = () => Math.max(0, budget - (Date.now() - t00))
  /** 这一个进攻阶段的时间上限：**比总预算短**，否则"重新观察"永远不会发生（见 COMBAT_PHASE_MS 注释） */
  const phaseMs = () => callBudget(Math.min(budgetLeft(), COMBAT_PHASE_MS), 4_000)

  /** 有 pvp：交给插件追+打，自己等到"目标没了 / 这一轮用完" */
  const engagePvp = async () => {
    /* 🔴 `bot.pvp.attack(target)` **立刻** resolve（它只做三件事：设 target、`GoalFollow` 追过去、
     *    发 `startedAttacking` 事件），真正挥拳的是 `physicTick` 上的后台循环 ⇒
     *    旧写法 `await withTimeout(b.pvp.attack(...))` 一毫秒就返回，紧接着 `finally` 里
     *    `b.pvp.stop()` 又把追过去的 goal 停掉 ⇒ **一下都没打，却回 "attacked: X"**。
     *    所以这里必须自己等：等到目标没了 / 这一轮的时间用完，再停。 */
    // 2026-10-08 审计⑦：`Math.max(300, …)` 在本轮已经用完时会白送 300ms（见 walkTo 同类注释）。
    const left = ctx.callLeft() - 600
    const bd = left <= 100 ? 0 : Math.max(0, Math.min(phaseMs(), left))
    const t0 = Date.now()
    let note = null
    let pvpErr = null
    /* 🔴 2026-10-15 审计：`killed: gone` 把"怪走出服务端实体追踪距离（destroy 包）/ 区块卸载"
     *    当成"我打死了它" ⇒ 后面还会据此报掉落物。只有**消失前读到过血量下降**才算打死。 */
    let sawDamage = false
    let lastHp = hpBefore
    try {
      await b.pvp.attack(target)
      while (Date.now() - t0 < bd) {
        if (ctx.abortSignal?.aborted) break
        if (!b.entities?.[target.id] || target.isValid === false) break
        const hp = entityHealth(b, target)
        if (hp != null) {
          if (lastHp != null && hp < lastHp) sawDamage = true
          lastHp = hp
        }
        await sleep(120)
      }
    } catch (e) {
      if (e?.mcAborted) throw e
      pvpErr = String(e?.message ?? e)
    } finally {
      /* 🔴 这里**不能 await**：`pvp.stop()` 里 `onceWithTimeout('path_stop', 5000)` 最多等 5 秒，
       *    会把这一轮的预算整段吃光（而且 pathfinder 的 stop 在它第一行就已经做了）。 */
      try { Promise.resolve(b.pvp.stop()).catch(() => {}) } catch { /* 停不掉也不影响 */ }
    }
    const gone = !b.entities?.[target.id] || target.isValid === false
    const killed = gone && sawDamage
    const inRange = Boolean(b.pvp?.wasInRange)
    const hpAfter = gone ? (killed ? 0 : null) : entityHealth(b, target)
    const waitedMs = Date.now() - t0
    if (gone && !killed && !pvpErr) {
      note = `目标不见了，但**没读到过它掉血** —— 说不清是我打死的还是它走远/区块卸载了（别当成打死了）`
    }
    /* 打死了 ⇒ 掉落物就掉在原地。用户 2026-10-08 原话："打完动物以后老是忘记走过去拾取" ——
     * 只**点一句**，不替它走过去（先捡哪个、走多远是决策，而且这一轮的预算基本已经花完了）。 */
    const pickup = killed ? dropHint(b) : null
    if (!gone && !pvpErr) {
      note = inRange
        ? `打了 ${(waitedMs / 1000).toFixed(1)} 秒还没打死（这一轮的时间到了）—— 再叫一次 mc_act{attack} 接着打`
        : `追了 ${(waitedMs / 1000).toFixed(1)} 秒还没进到攻击距离（3.5 格）—— 走不过去 / 被方块挡住 / 目标跑太快；`
          + '先 mc_move 到它旁边，或者换个近一点的目标'
    }
    return {
      attacked: label, distance: d, killed, gone, health: b.health, via: 'pvp', waitedMs,
      ...(hpBefore != null && hpAfter != null && hpBefore !== hpAfter ? { targetHealth: `${hpBefore} → ${hpAfter}` } : {}),
      ...(note ? { note } : {}),
      ...(pickup ? { pickup } : {}),
      ...(pvpErr ? { error: pvpErr } : {}),
      /* 内部字段（下划线开头，不进最终返回值）：给策略层判断用 */
      _sawDamage: sawDamage, _inRange: inRange, _gone: gone, _killed: killed,
    }
  }

  /** 没有 pvp 插件：退化成原地挥（上游原版就是一次 `b.attack`，这里按预算多挥几下） */
  const engageSwing = async () => {
    const t0 = Date.now()
    const leftMs2 = ctx.callLeft() - 400
    const bd = leftMs2 <= 100 ? 0 : Math.max(0, Math.min(phaseMs(), leftMs2))
    let swings = 0
    let sawDamage2 = false
    let lastHp2 = hpBefore
    const sample = () => {
      const hp = entityHealth(b, target)
      if (hp == null) return
      if (lastHp2 != null && hp < lastHp2) sawDamage2 = true
      lastHp2 = hp
    }
    while (Date.now() - t0 < bd) {
      if (ctx.abortSignal?.aborted) break
      if (!b.entities?.[target.id] || target.isValid === false) break
      if (distOf(target) > 4.5) break
      await ctx.t(Promise.resolve(b.attack(target)), 'attack', `攻击 ${label}`)
      swings++
      await sleep(620)
      sample()
    }
    // 没有 pvp 时至少挥一下（bd=0 说明这一轮已经用完了，那就别再拖）
    if (swings === 0 && b.entities?.[target.id] && target.isValid !== false && distOf(target) <= 4.5 && !ctx.abortSignal?.aborted) {
      try { await ctx.t(Promise.resolve(b.attack(target)), 'attack', `攻击 ${label}`); swings = 1 } catch {}
      await sleep(200)
      sample()
    }
    const gone = !b.entities?.[target.id] || target.isValid === false
    /* 🔴 同 pvp 分支：`gone` ≠ `killed`（怪可能只是走远/区块卸载）。 */
    const killed = gone && sawDamage2
    const pickup = killed ? dropHint(b) : null
    const inRange = distOf(target) <= 4.5
    return {
      attacked: label, distance: d, swings, killed, gone, health: b.health,
      ...(gone && !killed ? { note: '目标不见了，但**没读到过它掉血** —— 说不清是我打死的还是它走远/区块卸载了（别当成打死了）' } : {}),
      ...(pickup ? { pickup } : {}),
      _sawDamage: sawDamage2, _inRange: inRange, _gone: gone, _killed: killed,
    }
  }

  /* ═══════════ ② 观察 → 决策 → 执行一个阶段 → 再看一遍 ═══════════ */

  const canMove = typeof ctx.moveTo === 'function'
  const canEquip = typeof ctx.equipTo === 'function'
  const t00 = Date.now()
  const mem = { repositions: 0, equips: 0, lastEquipAt: 0, lastInRange: null }
  const actions = []
  const hurt = []
  let sawDamageAny = false
  let last = null
  let retreated = false
  let retreatWhy = null
  let unreachable = false
  let aborted = false
  let timedOut = false
  let lastStep = null
  let lastSnap = null
  let moveErr = null

  /** 视野里的敌对（`all` 已经是 24 格内、带名字和距离的快照） */
  const foesOf = (radius = NEARBY_R) => all
    .filter((x) => x.d <= radius && stanceOf(x) === 'hostile')
    .map((x) => ({
      /* 🔴 带 `id` 是为了把"正在打的那只"从威胁里**按身份**剔掉 ——
       *    第一版按**名字**剔（`f.name !== label`），于是三只僵尸会被一起剔光，
       *    "被围"永远数不出来。名字是用来给人看的，身份只能用 id。 */
      id: x.e.id ?? null,
      name: x.nm, distance: Number(x.d.toFixed(1)), hostile: true,
      ranged: RANGED_RE.test(x.nm),
      /* mineflayer 没有"谁在打我"的现成字段；有些怪会暴露 `target`。
       * 拿不到就退化成"贴到 3 格内就算在打我"—— 这比"一律不算"更接近事实。 */
      attackingMe: x.e.target === b.entity || x.d <= 3,
    }))

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (ctx.abortSignal?.aborted) { aborted = true; break }
    /* 🔴 **两道**闸门，缺一不可：
     *   ① `budget`（这次调用自己的总预算）—— 没有它，一个"目标没死、callLeft 还很宽裕"的
     *      循环会一轮轮各吃满 `min(budget, 4000)`，把总时间翻好几倍
     *      （`check-core-attack` 的"stop 挂住也按时返回"当场逮到：400ms 的预算跑了 1994ms）。
     *   ② `callLeft()`（这一轮**工具调用**还剩多少）—— 预算没超但宿主的时间快到了，也得收手。 */
    if (Date.now() - t00 >= budget - 100) { timedOut = true; break }
    if (ctx.callLeft() <= 500) { timedOut = true; break }

    const now = Date.now()
    if (Number.isFinite(Number(b.health))) hurt.push({ at: now, health: Number(b.health) })
    const prev = LAST_SEEN.get(b)
    if (prev && Number.isFinite(Number(prev.health)) && now - prev.at <= 30_000) {
      hurt.unshift({ at: prev.at, health: Number(prev.health) })
    }

    const stillThere = Boolean(b.entities?.[target.id]) && target.isValid !== false
    const foes = foesOf()
    const heldItem = b.heldItem ?? null
    const held = heldItem?.name ?? null
    let bagItems = []
    try { bagItems = b.inventory?.items?.() ?? [] } catch { bagItems = [] }
    const items = bagItems.map((i) => i?.name).filter(Boolean)
    /* 🔴 2026-10-17（用户实机：副手一直挂着 `shield 103/336`，它却报「没有盾牌，只能拉开距离」）：
     *    `b.inventory.items()` 只覆盖**背包 9..44 格**（主背包 + 快捷栏）—— 副手是 **45 格**、
     *    盔甲是 **5..8 格**，都不在里面 ⇒ 盾挂在副手 = 对这里完全不可见。
     *    槽位表直接用 `src/inventory.mjs` 的 `EQUIP_SLOTS`（`mc_inventory` / 耐久功能一直在用，
     *    别再手写一份槽号）。读不到就当没穿，绝不因此抛错。 */
    const equipped = []
    try {
      const slots = b.inventory?.slots
      if (Array.isArray(slots)) {
        for (const [slotIdx] of EQUIP_SLOTS) {
          const it = slots[slotIdx]
          if (it?.name) equipped.push(it.name)
        }
      }
    } catch { /* 读不到装备栏就当没穿 */ }
    /* 武器耐久：同一个名字可能有好几把，取**最好的一把**（换上一把快坏的没意义） */
    const pctOfItem = (it) => {
      try { const d = durabilityOf(it); return d && Number.isFinite(d.pct) ? d.pct : null } catch { return null }
    }
    const bagPct = new Map()
    for (const it of bagItems) {
      const n = it?.name
      if (!n) continue
      const p = pctOfItem(it)
      if (p == null) continue
      if (!bagPct.has(n) || p > bagPct.get(n)) bagPct.set(n, p)
    }

    const snap = assessCombat({
      health: b.health, food: b.food, air: b.oxygenLevel, submerged: b.entity?.isInWater === true,
      target: {
        name: label,
        distance: stillThere ? distOf(target) : null,
        health: stillThere ? entityHealth(b, target) : null,
        hostile: hostilityOf(label, target.kind) === 'hostile',
        ranged: RANGED_RE.test(label),
        attackingMe: stillThere && (target.target === b.entity || distOf(target) <= 3),
        canReach: mem.lastInRange === null ? undefined : mem.lastInRange,
      },
      /* `isTarget` 标出正在打的那只（按 **id** 标，不按名字 —— 三只僵尸同名，
       * 按名字标会把另外两只一起标上，于是"被围"永远数不出来）。 */
      foes: foes.map((f) => ({ ...f, isTarget: f.id === target.id })),
      held, items,
      heldPct: pctOfItem(heldItem),
      pctOf: (n) => (bagPct.has(n) ? bagPct.get(n) : null),
      hasShield: items.some((n) => isShield(n)) || equipped.some((n) => isShield(n)) || isShield(held),
      hurt, now, hasPvp,
      autoEat: b.autoEat?.enabled !== false,
      targetGone: !stillThere,
      sawDamage: sawDamageAny,
      wasInRange: mem.lastInRange,
    })
    const step = chooseStrategy(snap, mem)
    lastStep = step
    lastSnap = snap
    actions.push(step.action)

    /* ── 收工 ── */
    if (step.action === 'complete') break

    /* ── 够不着，试够了 ── */
    if (step.action === 'stop') { unreachable = true; break }

    /* ── 撤退 / 拉开距离 ── */
    if (step.action === 'retreat' || step.action === 'defend') {
      if (!canMove) {
        /* 想撤却没给我移动能力：**如实说**，然后照打（比"假装撤了"诚实）。 */
        moveErr = '想撤但这次调用没给我移动能力（ctx.moveTo 不在）'
        lastStep = { ...step, action: 'engage', why: `${step.why}；但撤不了（没给移动能力），只能接着打` }
        actions.push('engage')
      } else {
        const mp = b.entity?.position
        const tp = target.position
        const pt = mp && tp ? retreatPointOf({ x: mp.x, y: mp.y, z: mp.z }, { x: tp.x, z: tp.z }, RETREAT_DISTANCE) : null
        if (!pt) { moveErr = '算不出往哪撤（我和目标位置重合）' }
        else {
          /* 🔴 `noTower: true`：逃跑时**不许**寻路器原地垫方块往上爬
           *    （用户实机：撤退一路垫到 y=57，越逃越远）。见 `src\movement.mjs` 的同名注释。 */
          try { await ctx.moveTo(pt, { reason: `战斗撤退：${step.why}`, noTower: true }) } catch (e) { moveErr = String(e?.message ?? e) }
        }
        retreated = true
        retreatWhy = step.why
        /* 🔴 只有 defend（被围 / 被远程射）计入退次数，`retreat`（血快没了）**不计** ——
         *    保命没有上限，但"退了还退"必须有：`chooseStrategy` 用 `mem.retreats`
         *    在退够 `RETREAT_TRIES` 次之后改成边打边找机会（用户实机 2026-10-17：
         *    AI 反复调用、每轮都判"还有远程"，于是一路退到没地方退）。 */
        if (step.action === 'defend') mem.retreats = (Number(mem.retreats) || 0) + 1
        break
      }
    }

    /* ── 换武器 ── */
    if (step.action === 'equip') {
      if (!canEquip) { mem.equips = 99 /* 没能力就别再问了 */ } else {
        try { await ctx.equipTo(step.name) } catch (e) { mem.equips = 99; moveErr = `换武器失败：${String(e?.message ?? e)}` }
        mem.equips++
        mem.lastEquipAt = Date.now()
      }
      continue
    }

    /* ── 重新找位 ── */
    if (step.action === 'reposition') {
      if (!canMove) { unreachable = true; moveErr = '够不着，但这次调用没给我移动能力（ctx.moveTo 不在）'; break }
      const mp = b.entity?.position
      const tp = target.position
      const pt = mp && tp ? approachPointOf({ x: mp.x, y: mp.y, z: mp.z }, { x: tp.x, y: tp.y, z: tp.z }, 3) : null
      if (!pt) { unreachable = true; moveErr = '算不出往哪挪（我和目标位置重合）'; break }
      try { await ctx.moveTo(pt, { reason: `战斗走位：${step.why}` }) } catch (e) { moveErr = String(e?.message ?? e) }
      mem.repositions++
      mem.lastInRange = null
      continue
    }

    /* ── 进攻（一个阶段） ── */
    last = hasPvp ? await engagePvp() : await engageSwing()
    sawDamageAny = sawDamageAny || last._sawDamage === true
    mem.lastInRange = last._inRange === true
    if (last._killed === true || last._gone === true) break
    if (last.error) break
    if (ctx.callLeft() <= 500) { timedOut = true; break }
    /* 目标还在、时间还有 ⇒ 再评估一轮（MAX_ROUNDS 兜底，防止抖动磨光预算） */
  }

  if (Number.isFinite(Number(b.health))) LAST_SEEN.set(b, { at: Date.now(), health: Number(b.health) })

  /* ═══════════ ③ 组装结果 ═══════════ */

  const killed = last?._killed === true
  const gone = last?._gone === true
  const combat = combatOutcomeOf({
    killed,
    gone: gone && !killed,
    sawDamage: sawDamageAny || (last?._sawDamage === true),
    retreated, unreachable, aborted, timedOut,
  })
  /* 撤退/够不着时没有"进攻结果"可继承 ⇒ 自己拼一份，字段名与旧的一致 */
  const base = last ?? {
    attacked: label, distance: d, killed: false, gone: false, health: b.health,
  }
  const { _sawDamage, _inRange, _gone, _killed, ...clean } = base
  /* 撤退/够不着时，旧 `note` 那句"再叫一次接着打"是误导 ⇒ 换成策略层的话 */
  const strategyNote = (retreated || unreachable || aborted || timedOut) && !last?.note
    ? `${combatPlanText(lastStep)}${moveErr ? `（${moveErr}）` : ''}`
    : null

  return {
    ...clean,
    combat,
    combatText: combatOutcomeText(combat),
    strategy: lastStep?.state ?? null,
    /* 机器可读的"为什么"（`low-health` / `unreachable` / `surrounded` / `gone-no-damage`…）。
     * 和 `note`/`retreatWhy` 那种给人看的中文分开：一个给下游判分支，一个给 AI 读。 */
    reason: lastStep?.reason ?? null,
    actions,
    ...(strategyNote ? { note: strategyNote } : {}),
    ...(retreated ? { retreated: true, retreatWhy: retreatWhy ?? null } : {}),
    ...(unreachable ? { unreachable: true } : {}),
    ...(moveErr ? { strategyError: moveErr } : {}),
    ...(lastSnap?.weaponWarn ? { weaponWarn: lastSnap.weaponWarn } : {}),
    /* 有没有盾（含**副手 45 格**与盔甲槽 5..8）。如实给出来：AI 需要它判断"能不能进依赖盾牌的策略"，
     * 而这正是 2026-10-17 用户实机逮到的那个 bug 的现场（副手有盾却被判成没盾）。 */
    ...(typeof lastSnap?.hasShield === 'boolean' ? { shield: lastSnap.hasShield } : {}),
    ...foesNear(target),
  }
}
