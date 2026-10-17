/**
 * 实体名字与分类 —— "谁是谁"的那一层（路线图第 ④ 条第四刀从 `src/core.mjs` 搬出来）。
 *
 * 这一层全是**纯函数 / 常量**：只认传进来的实体对象（`e.name` / `e.username` / `e.displayName` …），
 * 不碰 `bot`、不碰世界、不碰事件、不读实时状态。搬它的理由和前三刀一样 —— 让 `core.mjs` 少一层
 * 与"玩法流程"无关的字符串规则。
 *
 * 🔴 两条"别改坏"的约定：
 *   ① `HOSTILE_RE` / `RANGED_RE` 与 `extensions/mc_auto.mjs` 里的 `HOSTILE` / `RANGED` **必须逐字一致**
 *      （那边为了能离线自检故意自带一份）—— `tools/check-core-entities.mjs` 会逐字比对两份。
 *   ② 掉落物判据只有 `isDropEntity()` 这一份：`minecraft-data` 里掉落物实体的 `type` 是 `'other'`
 *      不是 `'object'`，也**不能**拿 `displayName` 兜底（牛是 `Cow`、经验球是 `Experience Orb`）。
 */

// 敌对 / 远程怪名单 —— 供 `mobs()` 分类用。
// 🔴 与 `extensions/mc_auto.mjs` 里的 `HOSTILE` / `RANGED` **保持一致**：那边为了能离线自检
//    故意自带一份（见那个文件头部"只依赖 ../src/user-message.mjs"），改这里记得同步改那边。
/* 🔴 2026-10-17 审计：这份名单原来漏了 10 种**真的会打你**的怪 —— `endermite` / `magma_cube` /
 *    `vex` / `zoglin` / `bogged` / `evoker` / `illusioner` / `breeze` / `giant` / `ender_dragon`。
 *    后果不是"少打一只怪"，而是**反射层瞎了**：`mc_auto` 的 `hostilesNear()`、`danger.mjs` 的
 *    `nearestHostile()`、`world-scan.mjs` 的 `entitiesNear(kind:'hostile')` 全都走这一份 ——
 *    一只 `breeze`（1.21 的风袭怪）贴脸射你，它既不会叫醒 AI，也不会把正在挖的串砍断。
 *    更刺眼的是 `RANGED_RE` 早就把 `bogged`/`evoker`/`illusioner`/`breeze` 算成"远程怪"了，
 *    也就是说**代码自己知道它们会远程打你，却不认为它们是敌人**。 */
export const HOSTILE_RE = /zombie|skeleton|creeper|spider|witch|enderman|slime|pillager|vindicator|ravager|phantom|drowned|husk|stray|blaze|ghast|hoglin|piglin|wither|warden|silverfish|guardian|shulker|endermite|magma_cube|vex|zoglin|bogged|evoker|illusioner|breeze|giant|ender_dragon/i
export const RANGED_RE = /skeleton|stray|bogged|pillager|vindicator|witch|blaze|ghast|guardian|shulker|llama|illusioner|evoker|breeze|wither|drowned/i

/**
 * **中立**怪 —— 你不惹它，它不惹你（用户 2026-10-17 实机："怪物好像不显示中立"）。
 *
 * 🔴 为什么必须单独一档：`HOSTILE_RE` 里有 `enderman` 和 `piglin`，可这两只**默认是中立的**
 *    （末影人不看眼睛不打人；猪灵穿着金装不打人）。原来只有"敌对 / 其它"两档，于是
 *    末影人被当成敌对 ⇒ 不带名字的 `mc_act{attack}` 会**主动去揍一只本不会打我、而且能瞬移、
 *    血 40** 的怪；反过来狼/蜜蜂/铁傀儡被归进 `other` ⇒ 打它们时既不算"被围"也不报警。
 *
 * 名单口径（vanilla 1.21）：末影人、猪灵、僵尸猪灵、狼、蜜蜂、北极熊、熊猫、铁傀儡、
 * 羊驼 / 行商羊驼、山羊、海豚、雪傀儡。**猪灵蛮兵 / 僵尸猪灵以外的下界猪类仍是敌对**，
 * 所以 `ALWAYS_HOSTILE_RE` 先判一次（`piglin` 是 `piglin_brute` 的子串，顺序反了就把蛮兵当中立）。
 */
export const NEUTRAL_RE = /enderman|piglin|zombified_piglin|wolf|bee|polar_bear|panda|iron_golem|llama|goat|dolphin|snow_golem/i
/** 名字里带中立词、但其实**永远敌对**的那几个（必须排在 `NEUTRAL_RE` 之前判） */
export const ALWAYS_HOSTILE_RE = /piglin_brute|zoglin|hoglin/i

/**
 * 一只实体到底是什么立场 —— `'hostile' | 'neutral' | 'passive' | 'player'`。
 *
 * 这是**唯一**的判定处（`world-scan` 的分组、`attack` 的选目标、`danger` 的警报都调它）。
 * 以前每个调用方自己写 `HOSTILE_RE.test(nm) || e.kind === 'Hostile mobs'`，
 * 于是"中立"这个概念在四个地方各丢一次。
 *
 * @param {string} nm 实体名字（`entityNameOf()` 的结果）
 * @param {string} [kind] minecraft-data 的 `e.kind`（`'Hostile mobs'` 之类）
 */
export function hostilityOf (nm, kind) {
  const n = String(nm ?? '')
  if (ALWAYS_HOSTILE_RE.test(n)) return 'hostile'
  if (NEUTRAL_RE.test(n)) return 'neutral'
  if (HOSTILE_RE.test(n) || kind === 'Hostile mobs') return 'hostile'
  return 'passive'
}

/**
 * 掉落物 / 投掷物 —— 也算实体，也能"攻击"，但**不该抢走打怪/打猎的机会**。
 * 2026-10-08 实机：不带 `who` 的 `mc_act{attack}` 会先打到脚边的 `item`（自己刚挖掉的方块），
 * AI 自己都发现了（"it attacked an item entity. Not useful."）。
 */
export const JUNK_RE = /^(item|experience_orb|arrow|spectral_arrow|tipped_arrow|snowball|egg|ender_pearl|eye_of_ender|potion|splash_potion|lingering_potion|firework_rocket|fishing_bobber|trident|wind_charge|breeze_wind_charge|llama_spit|shulker_bullet|fireball|small_fireball|dragon_fireball)$/i

/**
 * 掉落物实体（`minecraft-data` 里 `name: 'item'`、`displayName: 'Item'`，但 **`type` 是 `'other'`**）。
 *
 * why 单独抽成一份模块级判据：`#grabDrops`（顺手捡）与 `#dropsNear`（"东西还在地上"的提示）必须用
 * **同一份**判据 —— 2026-10-08 实机就是 `e.type !== 'object'` 写错，让 `#grabDrops` 永远返回 0
 * （挖掉 3 根原木、背包里还是 1 根）。也不能拿 `Boolean(e.displayName)` 兜底：几乎每个实体都有
 * displayName（牛是 `Cow`、经验球是 `Experience Orb`）⇒ 会把生物当成掉落物。
 */
export const NOT_DROP_RE = /boat|minecart|armor_stand|item_frame|painting|arrow|snowball|egg|ender_pearl|eye_of_ender|fireball|fishing_bobber|potion|tnt|falling_block|leash|knot|shulker_bullet|llama_spit|wind_charge/i
export const isDropEntity = (e) => {
  if (!e?.position) return false
  const n = String(e.name ?? '')
  const dn = String(e.displayName ?? '')
  if (!/^item$/i.test(n) && !/^item$/i.test(dn)) return false
  return !NOT_DROP_RE.test(n) && !NOT_DROP_RE.test(dn)
}

/**
 * 中文叫法 → 实体名。**只在 `who` 一次都没匹配上时**兜底查一遍。
 *
 * why：AI 的思考与汇报都是中文，很容易顺手写 `who:"僵尸"`；以前那样只会得到一句
 * `附近找不到 "僵尸"`，看不出是名字写错了还是怪跑了。表不大、只在失败路径上用，不进工具描述。
 */
export const NAME_ALIAS = {
  僵尸: 'zombie', 骷髅: 'skeleton', 爬行者: 'creeper', 苦力怕: 'creeper', 蜘蛛: 'spider',
  洞穴蜘蛛: 'cave_spider', 末影人: 'enderman', 女巫: 'witch', 溺尸: 'drowned', 尸壳: 'husk',
  流浪者: 'stray', 史莱姆: 'slime', 岩浆怪: 'magma_cube', 烈焰人: 'blaze', 恶魂: 'ghast',
  猪灵: 'piglin', 猪灵蛮兵: 'piglin_brute', 疣猪兽: 'hoglin', 劫掠者: 'pillager', 卫道士: 'vindicator',
  幻翼: 'phantom', 守卫者: 'guardian', 潜影贝: 'shulker', 凋灵: 'wither', 监守者: 'warden',
  蠹虫: 'silverfish', 末影螨: 'endermite', 牛: 'cow', 猪: 'pig', 羊: 'sheep', 鸡: 'chicken',
  兔: 'rabbit', 马: 'horse', 狼: 'wolf', 猫: 'cat', 村民: 'villager', 铁傀儡: 'iron_golem',
  雪傀儡: 'snow_golem', 鱿鱼: 'squid', 鲑鱼: 'salmon', 鳕鱼: 'cod', 蜜蜂: 'bee', 海豚: 'dolphin',
  羊驼: 'llama', 熊猫: 'panda', 狐狸: 'fox', 鹦鹉: 'parrot', 蝙蝠: 'bat',
}

/** 实体名字：**玩家优先 `username`**（玩家的 `name` 是注册表里的 'player'，照它显示就分不清谁是谁） */
export const entityNameOf = (e) => String(e?.username ?? e?.name ?? e?.displayName ?? e?.type ?? '?')

/** 一个实体所有能拿来匹配的名字（都转小写） */
export const nameFieldsOf = (e) => [e?.username, e?.name, e?.displayName, e?.type, e?.kind, e?.entityType]
  .filter((v) => typeof v === 'string' && v).map((v) => v.toLowerCase())

/**
 * `who` 匹配一个实体：英文名 / 玩家名 / 中文别名（`NAME_ALIAS`）都认。
 *
 * 🔴 2026-10-08 审计：`lookAt()` 与 `useBlock()` 原来各写了一遍
 *    `String(e.username ?? e.name ?? '').includes(needle)` —— 中文叫法、`displayName`、
 *    `type` 全都不认，和 `attack()` 的行为不一致（AI 学会了"僵尸"能打，转头"看僵尸"就报找不到）。
 */
export const matchNameOf = (e, needle, alias = null) => {
  const fields = nameFieldsOf(e)
  return fields.some((f) => f.includes(needle)) || (alias ? fields.some((f) => f.includes(alias)) : false)
}

/** 找实体：`list` 是 `[{ e, d }]`（d = 到自己多少格），返回 `{ hit, near }` */
export const pickEntity = (list, who) => {
  const needle = String(who ?? '').trim().toLowerCase()
  const alias = NAME_ALIAS[needle] ?? null
  const sorted = [...list].sort((a, z) => a.d - z.d)
  const hit = sorted.find((x) => matchNameOf(x.e, needle, alias)) ?? null
  const near = sorted.slice(0, 6).map((x) => `${entityNameOf(x.e)} ${Number.isFinite(x.d) ? x.d.toFixed(1) : '?'} 格`)
  return { hit, near, needle, alias }
}
