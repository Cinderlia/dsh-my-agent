/**
 * 战斗策略层 —— **只评估、只决定，不动手**（用户 2026-10-17 的战斗方案）。
 *
 * 为什么单独一层：原来的 `src\attack.mjs` 把"选谁打 / 怎么打 / 打没打死"揉在一个流程里，
 * 于是它只会做一件事 —— **一直往前顶**。血量 4 还在顶、旁边三只怪还在顶、追不上还在顶。
 * 现在把"该进攻还是该撤"抽出来，`attack.mjs` 只负责**执行一个阶段**，执行完**重新观察**再决定。
 *
 * 硬约束（用户原话）：
 *   · **不直接控制 Mineflayer、不自己创建任务、不操作全局控制位** —— 这个文件里
 *     `import` 的东西只有名字表和常量，**一个 `bot.xxx()` 调用都没有**。
 *   · 不重建第二套移动控制器：真正的移动由 `attack.mjs` 转交给 `ctx.moveTo`（现成的 `walkTo`，
 *     带它自己的进度监控与脱困阶梯）。
 *   · 状态切换**必须依赖实际观察**，不是上一次工具调用的自然语言结果 ——
 *     所以 `assessCombat()` 每次都重新读血量、距离、视野里的敌人。
 *
 * 怎么测：全是纯函数 ⇒ `tools\check-core-attack.mjs` 里可以随便造血量/距离/敌人组合，
 * 不需要真 bot、不需要真服务器。真寻路与真命中才走实机。
 */

/* ═══════════════ 阈值（都能在测试里一眼看懂） ═══════════════ */

/** 血到这条线 ⇒ **必须撤**（不打了） */
export const HEALTH_CRITICAL = 8
/** 血到这条线 ⇒ **停止冒进**（还能打，但不主动往上顶） */
export const HEALTH_LOW = 12
/** 近战攻击距离（`mineflayer-pvp` 默认 3.5 格） */
export const MELEE_RANGE = 3.5
/** 远程威胁：这个距离内的远程怪算"它够得着我" */
export const RANGED_THREAT_RANGE = 12
/**
 * **威胁分**：同档怪之间谁先打（用户 2026-10-18 转来游戏里 AI 的原话：
 * 「不会按威胁排优先级 —— 凋灵骷髅（挂凋零、10 秒掉 5 血）应该优先于僵尸，但它不会」）。
 *
 * 🔴 分只用于**已经决定要打**的候选之间排序（`attack.mjs` 里 rank 0 敌对那一档）：
 *    · 凋零 / 爆炸 / 强制伤害型排最前（放着不管会把你按死）；
 *    · 远程（骷髅/烈焰人/女巫）次之（它们会边退边打，越拖越亏）；
 *    · 近战僵尸系最便宜（追得上、打得动）。
 *    名字用注册名；`threatScoreOf` 有兜底，别在表外漏掉就崩。
 */
export const THREAT_SCORE = {
  wither: 130,
  ender_dragon: 140,
  warden: 120,
  wither_skeleton: 100,
  creeper: 96,
  blaze: 92,
  evoker: 90,
  witch: 88,
  ravager: 86,
  elder_guardian: 85,
  enderman: 84,
  ghast: 80,
  skeleton: 80,
  stray: 80,
  bogged: 80,
  zoglin: 78,
  piglin_brute: 76,
  vex: 75,
  hoglin: 74,
  vindicator: 72,
  pillager: 70,
  phantom: 70,
  shulker: 70,
  drowned: 66,
  guardian: 65,
  spider: 60,
  cave_spider: 58,
  silverfish: 55,
  endermite: 55,
  zombie: 50,
  husk: 50,
  zombie_villager: 40,
  magma_cube: 35,
  slime: 30,
}

/** 名字 ⇒ 威胁分（表外给兜底分，不认识也照样能排） */
export function threatScoreOf (name) {
  const n = String(name ?? '').trim().toLowerCase()
  if (THREAT_SCORE[n] != null) return THREAT_SCORE[n]
  /* 带后缀的变体（`zombie_horse`、`skeleton_horse`、模组怪 `xx_zombie`）按关键词兜底 */
  if (/wither/.test(n)) return 100
  if (/creeper/.test(n)) return 96
  if (/skeleton/.test(n)) return 80
  if (/zombie|husk/.test(n)) return 50
  if (/spider/.test(n)) return 60
  if (/slime/.test(n)) return 30
  return 45
}
/** 视野里敌对数量到这个数 ⇒ 算"被围" */
export const CROWD_THRESHOLD = 3
/**
 * "被围"只数**贴到这么近**的怪。
 *
 * 🔴 2026-10-17（用户实机：骷髅射我，它只会退）：`foes` 是 24 格内的全部敌对，原来
 *    `crowd = foes.length` ⇒ 20 格外的两只僵尸 + 一只骷髅就让"被围"成立，战斗层
 *    一直判"退"，AI 反复调用也只能反复退。真正该退的是**贴脸围上来**，不是"视野里有三只"。
 */
export const CROWD_RANGE = 8
/** 掉血速度的观察窗口 */
export const HURT_WINDOW_MS = 4_000
/**
 * 每秒掉血超过这个数 ⇒ 立刻撤（**急症**：来不及打完就得跑）。
 *
 * 🔴 为什么不能设小：一个没穿甲的空手 bot 挨一只简单僵尸，大约 2 点/秒。
 *    设成 1.5 会让 `mc_act{attack}` **对每一只落单的僵尸都掉头就跑** ——
 *    实机验收第一轮就是这么红的（`actions: ["retreat"]`，一下都没打）。
 *    "掉血"本身不是撤退理由，它只把 `threat` 抬到 high（挡住换装、标出危险）；
 *    真正决定收手的是血量：`HEALTH_LOW` ⇒ 不再往前压，`HEALTH_CRITICAL` ⇒ 撤。
 *    这里只管**急症** —— 20 血按 4/秒算，5 秒就没了，比脱身还快。
 */
export const HURT_RETREAT_DPS = 4.0
/** 一轮战斗里最多重新找位几次（找不到就老实说"够不着"） */
export const REPOSITION_MAX = 2
/**
 * **一个战斗阶段**最多打多久。
 *
 * 🔴 为什么必须比总预算短：策略循环是"执行一个阶段 → 重新观察 → 再决定"，
 *    如果一个阶段就把 `budget` 吃光，那"重新观察"永远不会发生 ——
 *    `reposition` / `equip` 这些分支写了也走不到（第一版就是这样：`check-core-attack`
 *    的"够不着"用例当场发现它从来不重新找位，因为第一次进攻就把预算用完了）。
 *
 * 🔴 2026-10-18 从 3 秒压到 1.2 秒（用户转来游戏里 AI 的原话：「**一次 3 秒不能中断**，
 *    打一半想跑跑不掉」）：现在每 1.2 秒就重新看一次血/目标/旁边的怪，掉头、换目标、
 *    提前收手都只差一个阶段，不再"闷头挥满 3 秒"。
 */
export const COMBAT_PHASE_MS = 1_200
/** 两次换武器之间至少隔多久（换装本身要花时间） */
export const EQUIP_COOLDOWN_MS = 1_500
/** 撤退最多试几次（走不动就如实说，不无限试） */
export const RETREAT_TRIES = 2

/**
 * 机器可读的战斗结局（用户方案里的七个）。
 *
 * 🔴 字段名是 **`combat`**，不是 `outcome` —— `outcome` 已经被 `index.js` 的
 *    `withOutcome()` 占着，装的是**跨工具**的 `confirmed / failed / unknown / stale`。
 *    第一版战斗结局直接叫 `outcome`，后果有两个：① `withOutcome()` 见到已有 `outcome`
 *    就原样放过（`index.js:1989`）⇒ AI **再也看不到统一结局**；② 同一个键在不同工具里
 *    意思不同，读的人只能靠猜。现在 `outcomeOf()` 会把 `combat` **翻译**成统一结局，
 *    两个字段各说各的、都能看见。
 */
export const COMBAT_OUTCOMES = ['damaged', 'killed', 'unreachable', 'aborted', 'timeout', 'unknown']

/** 结局 → 给人看的一句话（模型不用去猜 `outcome` 这个词什么意思） */
export const COMBAT_OUTCOME_TEXT = {
  damaged: '⚔️ 打到了，但没打死',
  killed: '✅ 打死了',
  unreachable: '🚧 够不着',
  aborted: '🛑 被打断',
  timeout: '⏱ 这一轮时间到了',
  unknown: '❓ 说不清结果',
}

/* ═══════════════ 武器 ═══════════════ */

/** 武器剩这么点耐久 ⇒ 算"快坏了"，优先换备用的（与 `src/inventory.mjs` 的 `DUR_LOW` 同值） */
export const WEAPON_WORN = 0.2
/**
 * 武器分级（数字越大越好）。用**明确的表**而不是"猜名字里有没有 sword"：
 * 剑 > 三叉戟/重锤 > 斧 > 镐 > 锹，同一类里按材质排。
 *
 * 为什么斧要排在剑后面但高于镐：斧的伤害接近同级剑、但攻速慢；镐/锹只是"手里有东西"
 * 比空手强，真拿它们当武器是没办法的办法。
 */
const WEAPON_TIERS = {
  netherite_sword: 100, diamond_sword: 90, iron_sword: 80, golden_sword: 70, stone_sword: 60, wooden_sword: 50,
  mace: 96, trident: 92,
  netherite_axe: 88, diamond_axe: 78, iron_axe: 68, golden_axe: 58, stone_axe: 48, wooden_axe: 38,
  netherite_pickaxe: 30, diamond_pickaxe: 27, iron_pickaxe: 24, golden_pickaxe: 21, stone_pickaxe: 18, wooden_pickaxe: 15,
  netherite_shovel: 14, diamond_shovel: 12, iron_shovel: 10, golden_shovel: 8, stone_shovel: 6, wooden_shovel: 4,
}

/** 近战武器分数；不是武器就回 0（空手也是 0） */
export function weaponScoreOf (name) {
  const n = String(name ?? '').trim().toLowerCase()
  if (!n) return 0
  if (WEAPON_TIERS[n] != null) return WEAPON_TIERS[n]
  /* 兜底：认得出是剑/斧/镐/锹但材质没在表里（模组物品）—— 给一个中间分，别当空手 */
  if (/_sword$/.test(n)) return 55
  if (/_axe$/.test(n)) return 43
  if (/_pickaxe$/.test(n)) return 16
  if (/_shovel$/.test(n)) return 5
  return 0
}

/** 是盾牌吗（用户点名：没有盾牌就别进"靠盾硬顶"的策略） */
export function isShield (name) {
  return /(^|_)shield$/.test(String(name ?? '').trim().toLowerCase())
}

/**
 * 该不该换武器 / 换成什么。**只给建议，不执行**（执行交给 `ctx.equipTo`）。
 *
 * @param {{ held?:string, items?:string[], targetDistance?:number, arrowCount?:number, inDanger?:boolean }} o
 * @returns {{ name:string, why:string }|null}  null = 不用换
 */
export function weaponChoiceOf ({ held = null, items = [], targetDistance = null, arrowCount = 0, inDanger = false, heldPct = null, pctOf = null } = {}) {
  const now = weaponScoreOf(held)
  const bag = (Array.isArray(items) ? items : []).filter((x) => typeof x === 'string')
  const best = bag.map((n) => ({ n, s: weaponScoreOf(n) })).sort((a, c) => c.s - a.s)[0] ?? null
  /* 🔴 武器快坏了要**优先换**，哪怕背包里那把评分更低 ——
   *    用户方案原话："武器耐久很低 ⇒ 在安全条件下更换备用武器；无备用武器时评估是否继续战斗"。
   *    这一段必须排在"评分更高才换"前面：手里钻石剑只剩 3% 时，石剑（评分低得多）才是对的。 */
  if (heldPct != null && heldPct <= WEAPON_WORN) {
    const pct = (n) => (typeof pctOf === 'function' ? pctOf(n) : null)
    const spare = bag
      .map((n) => ({ n, s: weaponScoreOf(n), p: pct(n) }))
      .filter((x) => x.s > 0 && (x.p == null || x.p > WEAPON_WORN))
      .sort((a, c) => c.s - a.s)[0] ?? null
    const left = Math.max(0, Math.round(heldPct * 100))
    if (inDanger) return { name: null, warn: `手里 ${held} 只剩 ${left}%，但现在不安全，先不换` }
    if (spare) return { name: spare.n, why: `手里 ${held} 只剩 ${left}%，换上 ${spare.n}` }
    return { name: null, warn: `手里 ${held} 只剩 ${left}%，背包里没有备用的` }
  }
  if (!best || best.s <= now) return null
  /* 危险中不换武器：换装要花几百毫秒，那几百毫秒里手是无防备的。
   *
   * 🔴 2026-10-18（用户："用attack的时候能不能自动切剑" ⇒ 选"开打第一件事就换"）：
   *    `inDanger` 的含义**收窄**了 —— 调用方（`assessCombat`）现在只在"已经该考虑撤"时
   *    才传 true（血少 / 掉血快到撑不住）。**被围、被远程射不再算"危险"**：
   *    那些局面恰恰最需要换剑，而且 `attack.mjs` 把 retreat/defend 全降级成"照打"
   *    （hold-line），拦下换装就等于"被骷髅射着、手里攥着镐一直拿镐打"。
   *    函数这一层的守卫保留：别的调用方仍可以显式传 true 来禁换。 */
  if (inDanger) return null
  const why = now === 0
    ? `空手打不动，背包里有 ${best.n}`
    : `手里 ${held}（${now}）不如背包里的 ${best.n}（${best.s}）`
  return { name: best.n, why }
}

/* ═══════════════ 威胁评估 ═══════════════ */

/**
 * 单个实体的威胁分（越大越该先打）。
 *
 * 为什么不能只按"是不是敌对"排序：那样"优先打敌对生物"就等于"随便挑一只敌对"，
 * 而真正该先处理的是**正在打我、够得着我、还是远程**的那只。
 *
 * @param {{ name?:string, distance?:number, hostile?:boolean, ranged?:boolean, attackingMe?:boolean,
 *           health?:number, canReach?:boolean, dangerousTerrain?:boolean }} t
 */
export function threatOf (t = {}) {
  const d = Number.isFinite(Number(t.distance)) ? Number(t.distance) : Infinity
  let s = 0
  if (t.hostile) s += 40
  if (t.attackingMe) s += 50            // 正在打我 —— 最高优先
  if (t.ranged) s += 25                 // 远程：它够得着我，我未必够得着它
  /* 距离：越近越急。12 格外基本不急 */
  s += Math.max(0, 30 - d * 2.5)
  if (t.canReach === false) s -= 15     // 够不着的先别管
  if (t.dangerousTerrain) s -= 20       // 打它要把自己送进岩浆/悬崖 ⇒ 降权
  const hp = Number(t.health)
  if (Number.isFinite(hp) && hp <= 6) s += 10   // 快死了，补一刀
  return Math.round(s * 10) / 10
}

/**
 * 按威胁分排序（不改原数组）。敌对依然优先于玩家与动物 ——
 * 用户明确要求保留这条：**不能因为新增威胁评分就去自动打无关玩家**。
 */
export function rankTargets (list = []) {
  const arr = Array.isArray(list) ? list.slice() : []
  const cls = (t) => (t?.hostile ? 0 : (t?.player ? 1 : 2))
  return arr
    .map((t) => ({ t, s: threatOf(t), c: cls(t) }))
    .sort((a, c) => (a.c - c.c) || (c.s - a.s) || ((a.t?.distance ?? Infinity) - (c.t?.distance ?? Infinity)))
    .map((x) => x.t)
}

/** 掉血速度（点/秒）：从"受伤样本"里算最近一个窗口内的斜率 */
export function hurtRateOf (samples = [], now = Date.now()) {
  const s = (Array.isArray(samples) ? samples : [])
    .filter((x) => x && Number.isFinite(Number(x.at)) && Number.isFinite(Number(x.health)))
    .filter((x) => now - x.at <= HURT_WINDOW_MS)
    .sort((a, c) => a.at - c.at)
  if (s.length < 2) return 0
  const first = s[0]; const last = s[s.length - 1]
  const dt = (last.at - first.at) / 1000
  const dh = first.health - last.health
  if (dt <= 0 || dh <= 0) return 0
  return Math.round((dh / dt) * 100) / 100
}

/* ═══════════════ 战况快照 ═══════════════ */

/**
 * 把"现在看到的东西"整理成一份战况（纯函数，不读 bot）。
 *
 * @param {object} o
 * @param {number} o.health
 * @param {number} [o.food]
 * @param {number} [o.air]
 * @param {boolean} [o.submerged]
 * @param {object|null} o.target   正在打的那个：`{ name, distance, health, ranged, hostile, attackingMe, canReach }`
 * @param {object[]} [o.foes]      视野里的敌对（含 target 也行，会按 id/名字去重由调用方保证）
 * @param {string|null} [o.held]
 * @param {string[]} [o.items]
 * @param {number|null} [o.heldPct] 手里武器还剩多少耐久（0–1）；null = 不可磨损/读不到
 * @param {(name:string)=>number|null} [o.pctOf] 背包里某个名字的剩余耐久（同名取最好的一把）
 * @param {boolean} [o.hasShield]
 * @param {number} [o.armorPoints]
 * @param {Array<{at:number,health:number}>} [o.hurt]
 * @param {number} [o.now]
 * @param {boolean} [o.hasPvp]
 * @param {boolean} [o.autoEat]
 * @param {boolean} [o.targetGone]  目标已经从实体表里消失
 * @param {boolean} [o.sawDamage]   消失前读到过它掉血
 * @param {boolean} [o.wasInRange]  上一轮有没有进到攻击距离
 */
export function assessCombat (o = {}) {
  const health = Number.isFinite(Number(o.health)) ? Number(o.health) : 20
  const now = Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now()
  const foes = Array.isArray(o.foes) ? o.foes : []
  const hurtDps = hurtRateOf(o.hurt, now)
  const target = o.target ?? null
  const d = Number(target?.distance)
  const notes = []

  /* 贴到 `CROWD_RANGE` 以内的才算"被围"（`crowdAll` 仍然给 24 格内的总数，供 AI 判断局势） */
  const crowdNear = foes.filter((f) => (Number(f?.distance) ?? Infinity) <= CROWD_RANGE)
  const crowd = crowdNear.length
  /* 🔴 "被围"要**连正在打的那只一起数**（三只怪围着你是三只，不是两只）——
   *    但"远程威胁"和"正在挨打"要把它剔掉：我正在打一只僵尸，它贴着我，
   *    那是**正常交战**，不是"被围"也不是"有人拿弓射我"。
   *    调用方用 `isTarget: true` 标出正在打的那只（`attack.mjs` 按 **id** 标，不按名字 ——
   *    按名字会把同类的其它怪一起剔光）。 */
  const others = foes.filter((f) => f?.isTarget !== true)
  const rangedFoes = others.filter((f) => f?.ranged === true
    && (f.attackingMe === true || (Number(f?.distance) <= RANGED_THREAT_RANGE))).length
  const rangedOnMe = others.filter((f) => f?.ranged === true && f.attackingMe === true).length
  const meleeOnMe = others.filter((f) => f?.attackingMe === true).length
  /* 光有一个远处的远程还不够劝退：正在射我 / 来俩 / 真在掉血 / 已经快没血 —— 占一条才算。
   * （第一版没有这个门槛，10 格外一只骷髅就让"打僵尸"变成"见骷髅就跑"。） */
  const rangedThreat = rangedOnMe >= 1 || rangedFoes >= 2
    || (rangedFoes >= 1 && (hurtDps > 0 || health <= HEALTH_LOW))
  const nearestFoe = foes.reduce((m, f) => Math.min(m, Number(f?.distance) ?? Infinity), Infinity)

  /* 威胁等级：先看"有没有正在打我的 / 被围 / 挨打速度"，再看血量 */
  let threat = 'none'
  if (crowd > 0) threat = 'low'
  if (crowd >= CROWD_THRESHOLD || rangedThreat) threat = 'mid'
  if (hurtDps >= HURT_RETREAT_DPS || meleeOnMe > 0 || rangedOnMe > 0) threat = 'high'

  const targetGone = o.targetGone === true
  const sawDamage = o.sawDamage === true
  const targetInRange = Number.isFinite(d) && d <= MELEE_RANGE
  const targetReachable = target?.canReach !== false

  /* 换武器：**只有"已经该考虑撤"时不换**（见下面 `inDanger` 的新口径）。
   * 被围 / 被远程射 / 目标是远程都不拦 —— 那几种局面正是最需要把镐换成剑的时候。 */
  const inDanger = health <= HEALTH_LOW || hurtDps >= HURT_RETREAT_DPS
  const weapon = weaponChoiceOf({
    held: o.held, items: o.items, targetDistance: Number.isFinite(d) ? d : null,
    arrowCount: o.arrowCount, inDanger, heldPct: o.heldPct, pctOf: o.pctOf,
  })
  /* 换不了但"武器快坏了"这件事必须说出来 —— 用户方案："无备用武器时**评估**是否继续战斗"，
   * 评估是 AI 的活，我们只负责把事实递上去。 */
  const weaponWarn = weapon?.warn ?? null
  if (weaponWarn) notes.push(weaponWarn)

  if (o.air != null && Number(o.air) <= 5) notes.push('氧气快没了')
  if (o.submerged) notes.push('在水里')
  if (o.autoEat === false && Number(o.food) <= 6) notes.push('饿着而且自动吃没开')

  return {
    health, food: o.food ?? null, air: o.air ?? null, submerged: o.submerged === true,
    now, hurtDps, hurtWindowMs: HURT_WINDOW_MS,
    threat, crowd, crowdAll: foes.length, rangedFoes, rangedOnMe, rangedThreat, nearestFoe: Number.isFinite(nearestFoe) ? Math.round(nearestFoe * 10) / 10 : null,
    targetRanged: target?.ranged === true,
    target, targetGone, sawDamage, targetInRange, targetReachable,
    held: o.held ?? null, hasShield: o.hasShield === true, armorPoints: o.armorPoints ?? null,
    weapon, inDanger, notes, weaponWarn,
    /* 三条"要不要撤"的独立判据 —— 分开给出，方便结果里说清**为什么**撤 */
    mustRetreat: health <= HEALTH_CRITICAL || hurtDps >= HURT_RETREAT_DPS,
    shouldStopAdvancing: health <= HEALTH_LOW,
    surrounded: crowd >= CROWD_THRESHOLD,
    hasPvp: o.hasPvp !== false,
  }
}

/* ═══════════════ 策略选择 ═══════════════ */

/**
 * 状态机一步：**看战况 + 记住已经试过什么 ⇒ 决定下一步做什么**。
 *
 * 纯函数：`mem` 只读，不改。调用方按 `step.action` 执行完再自己更新 `mem`。
 *
 * @param {ReturnType<typeof assessCombat>} s 战况快照
 * @param {{ repositions?:number, equips?:number, lastEquipAt?:number, lastInRange?:boolean|null }} [mem]
 * @returns {{ state:string, action:string, reason:string, name?:string, why?:string, at?:string }}
 *   action ∈ 'engage' | 'equip' | 'reposition' | 'defend' | 'retreat' | 'recover' | 'complete' | 'stop'
 */
export function chooseStrategy (s, mem = {}) {
  const repositions = Number(mem.repositions) || 0
  const equips = Number(mem.equips) || 0
  const lastEquipAt = Number(mem.lastEquipAt) || 0
  /* 已经退过几次（`attack.mjs` 每执行一次 defend 就 +1）—— 用来给退了还退设上限 */
  const retreats = Number(mem.retreats) || 0
  const m = (state, action, reason, extra = {}) => ({ state, action, reason, ...extra })

  /* ① 目标没了 —— 先分清"打死了"和"走远了"（这是既有的、必须保住的口径）。
   * 🔴 **这里不许说"打死了"**：`sawDamage` 只说明**打到过**，它完全可能挨了一下之后走远 / 被卸载。
   *    实机 2026-10-17 撞到过：结果里同时出现 `reason:"killed"` 和 `killed:false`、`gone:false`
   *    —— 同一个问题两处判据（这里是 `sawDamage`，`attack.mjs` 是 `gone && sawDamage`），
   *    读的人只能靠猜该信哪个。"到底打死没有"**只由 `attack.mjs` 的 `killed` 一处说了算**，
   *    策略层只说"它不见了"这个观察到的事实。 */
  if (s.targetGone) {
    return s.sawDamage
      ? m('complete', 'complete', 'gone-after-damage', { why: '目标消失前读到过掉血 —— 可能是我打死的，也可能它走远了' })
      : m('complete', 'complete', 'gone-no-damage', { why: '目标不见了，但没读到过它掉血 —— 说不清' })
  }

  /* ② 命要紧：血量危险 / 正在快速掉血 ⇒ 撤。**排在"进攻"前面** */
  if (s.mustRetreat) {
    const why = s.health <= HEALTH_CRITICAL
      ? `血只剩 ${s.health}`
      : `每秒掉 ${s.hurtDps} 点血`
    return m('retreat', 'retreat', 'low-health', { why })
  }

  /* ③ 手里的家伙不如背包里的 ⇒ **先换把趁手的**（2026-10-18 提到这里，见下）。
   *
   * 🔴 为什么必须排在"冲上去 / 拉开距离"前面：`attack.mjs` 把 retreat/defend 一律降级成
   *    **照打**（`hold-line`，AI 叫的打就是命令）—— 所以以前把换武器放在它们后面，
   *    等于"只要被围、被远程射、或目标本身是远程，换武器那条分支就永远走不到"。
   *    实机后果：被骷髅射着、手里攥着镐，一路拿镐把骷髅捶死（或者被捶死）。
   *    现在**开打第一件事就是换武器**，只有"该撤了"（② 血少/掉血快）和"打死了"（①）在前。
   *
   * 🔴 `lastEquipAt === 0` 要当成"从来没换过"，不能拿它去比冷却 ——
   *    否则"刚开局、`now` 又是个小数字"时冷却恒不满足，换武器这条分支永远走不到
   *    （`check-core-attack` 的纯函数用例就是这么逮到它的：`now = 1000` ⇒ `1000 - 0 < 1500`）。 */
  const equipReady = lastEquipAt === 0 || (s.now - lastEquipAt) >= EQUIP_COOLDOWN_MS
  /* 🔴 `s.weapon.name` 必须是真的：`weaponChoiceOf` 在"武器快坏了"那条路上会回
   *    `{ name: null, warn: ... }`（只报警告、不换）—— 以前这里只看 `s.weapon` 有没有值，
   *    于是拿着 name=null 去 `equipTo(null)` ⇒ `equip()` 抛"要给 name" ⇒ `mem.equips = 99`，
   *    **整场战斗再也不会换武器**（用户 2026-10-19："武器也自动切换我也没看到生效"）。 */
  if (s.weapon?.name && equipReady && equips < 2) {
    return m('assess', 'equip', 'better-weapon', { name: s.weapon.name, why: s.weapon.why })
  }

  /* ④ 目标**自己就是远程** ⇒ 冲上去打，不是站着挨。
   *
   * 🔴 2026-10-17（用户实机，游戏里那个 AI 的原话）：「只要目标被它判成远程（骷髅/女巫/烈焰人
   *    全算），它就只挡不还手 … 所以骷髅打我我永远打不到它，只能挨。」
   *    原因就在这里：远程威胁一律走 `defend` = 往反方向退 8 格然后收工 —— 可骷髅的箭比腿快，
   *    退只会一边挨射一边把距离拉开，下一轮还得再走回来。远程怪的优势**只在拉开距离时**成立，
   *    贴到近战距离它们反而最弱（骷髅 20 血、烈焰人 20 血、女巫 26 血且没有近战）。
   *    真正的远程威胁是**别的怪在射我**（下面 ⑤），不是我要打的那只恰好是远程。 */
  if (s.targetRanged && s.targetReachable !== false) {
    return m('engage', 'engage', 'close-in',
      { why: `目标是远程（${s.target?.name ?? '?'}，${s.target?.distance ?? '?'} 格）—— 站在外面只会挨打，冲上去近战` })
  }

  /* ⑤ 被围 / **别的**远程在射我 ⇒ 拉开距离（用户方案：没有盾牌手段时退化为拉开距离）。
   *
   * 🔴 必须有次数上限：同一个实机会话里另一个症状是退了还退 —— 每轮重新观察都还能看到
   *    远程威胁，于是一路退到没地方退、血还是掉。退够 `RETREAT_TRIES` 次就换成边打边找机会。 */
  if (s.surrounded || s.rangedThreat) {
    const why = s.surrounded
      ? `贴到 ${CROWD_RANGE} 格内的有 ${s.crowd} 只怪（视野里共 ${s.crowdAll ?? s.crowd} 只）`
      : `有 ${s.rangedFoes} 个远程在 ${s.nearestFoe} 格`
    if (retreats >= RETREAT_TRIES) {
      return m('engage', 'engage', 'retreat-exhausted',
        { why: `${why}；已经退过 ${retreats} 次还是甩不掉 —— 再退也是白退，改成边打边找机会` })
    }
    /* 没有盾牌就**明说**是拉开距离，别让 AI 以为我们在举盾 ——
     * 用户方案：没有盾牌或无法防御 ⇒ 不进入依赖盾牌的策略。 */
    const how = s.hasShield ? '有盾，边挡边退' : '没有盾牌，只能拉开距离'
    return m('defend', 'defend', s.surrounded ? 'surrounded' : 'ranged-threat', { why: `${why}（${how}）`, shield: s.hasShield })
  }

  /* ⑥ 血不多了 ⇒ 停止冒进（还能打，但不主动往上顶） */
  if (s.shouldStopAdvancing && !s.targetInRange) {
    return m('retreat', 'retreat', 'low-health-stop', { why: `血 ${s.health}，先拉开距离` })
  }

  /* ⑦ 够不着 ⇒ 换个位置再来（有限次；试完就说"够不着"，不无限试） */
  if (s.targetReachable === false || mem.lastInRange === false) {
    if (repositions < REPOSITION_MAX) {
      return m('reposition', 'reposition', 'out-of-reach',
        { why: `够不着（${s.target?.distance ?? '?'} 格），换个位置再来（第 ${repositions + 1}/${REPOSITION_MAX} 次）` })
    }
    return m('reposition', 'stop', 'unreachable',
      { why: `试了 ${REPOSITION_MAX} 次还是够不着 —— 别在原地耗，换个目标或先 mc_move 过去` })
  }

  /* ⑧ 其余情况：进攻 */
  return m('engage', 'engage', 'engage', { why: `打 ${s.target?.name ?? '目标'}` })
}

/* ═══════════════ 结局 ═══════════════ */

/**
 * 把"战斗过程中实际发生的事"翻成机器可读的 `outcome`。
 *
 * 判据全部来自**证据**（掉血、实体消失、被中断、预算耗尽），不来自自然语言。
 *
 * @param {{ killed?:boolean, gone?:boolean, sawDamage?:boolean,
 *           unreachable?:boolean, aborted?:boolean, timedOut?:boolean }} r
 */
export function combatOutcomeOf (r = {}) {
  if (r.killed === true) return 'killed'
  if (r.aborted === true) return 'aborted'
  if (r.unreachable === true) return 'unreachable'
  /* 🔴 审计 F5：`timedOut` 必须排在 `sawDamage` 前面。攻击循环结束那一刻常同时带着
   *    「打中过」和「时间到了」；以前先判 damaged ⇒ 报"打到了"、被判成功，
   *    实际是**打到一半被预算掐断**，怪还活着。 */
  if (r.timedOut === true) return 'timeout'
  if (r.sawDamage === true) return 'damaged'
  if (r.gone === true) return 'unknown'
  return 'unknown'
}

/** 结局 → 给人看的一句话（找不到就用 `unknown` 那句） */
export function combatOutcomeText (outcome) {
  return COMBAT_OUTCOME_TEXT[outcome] ?? COMBAT_OUTCOME_TEXT.unknown
}

/**
 * 重新找位点：朝目标走 `step` 格（`reposition` 用）。
 *
 * 为什么不做寻路：同上 —— 只算一个坐标，移动交给现成的 `walkTo`。
 * `step` 取小一点（3~4 格）是有意的：一次挪太多容易冲进别的怪堆里，
 * 而且 `walkTo` 自己的进度监控更适合短距离。
 *
 * @returns {{x:number,y:number,z:number}|null} 我和目标重合就回 null
 */
export function approachPointOf (me = {}, target = {}, step = 3) {
  const mx = Number(me.x); const my = Number(me.y); const mz = Number(me.z)
  const tx = Number(target.x); const ty = Number(target.y); const tz = Number(target.z)
  if (![mx, my, mz, tx, tz].every(Number.isFinite)) return null
  const dx = tx - mx; const dz = tz - mz
  const len = Math.hypot(dx, dz)
  if (len < 0.5) return null
  const k = Math.min(step, len) / len
  return {
    x: Math.round((mx + dx * k) * 100) / 100,
    /* y 用**目标那一层**：够不着常常是"它在上面/下面一层"。
     * 但如果目标和我差得太多（>3 格），就别指望一步跨上去 —— 交给 walkTo 自己爬。 */
    y: Number.isFinite(ty) && Math.abs(ty - my) <= 3 ? Math.round(ty) : Math.round(my),
    z: Math.round((mz + dz * k) * 100) / 100,
  }
}

/** 人话总结（给 `note` / `combatPlanText` 用） */
export function combatPlanText (step) {
  if (!step) return ''
  const why = step.why ? `（${step.why}）` : ''
  switch (step.action) {
    case 'engage': return `进攻${why}`
    case 'equip': return `换 ${step.name}${why}`
    case 'reposition': return `换个位置${why}`
    case 'defend': return `拉开距离${why}`
    case 'retreat': return `撤${why}`
    case 'recover': return `恢复${why}`
    case 'complete': return `收工${why}`
    case 'stop': return `停手${why}`
    default: return String(step.action ?? '')
  }
}
