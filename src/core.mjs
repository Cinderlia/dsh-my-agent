// -*- coding: utf-8 -*-
/**
 * dsh-mc-agent / core.mjs —— Minecraft 无头机器人核心（不依赖 DSH，可独立运行与测试）
 * ---------------------------------------------------------------------------
 * 从 mc-bridge/server.mjs 抽出来：连接/保活/世界读取/移动/挖掘/事件分发。
 * 供两处使用：
 *   1. plugins/dsh-mc-agent/index.js（DSH 宿主插件，机器人跑在 DSH 进程里）
 *   2. dsh-mc-agent/standalone.mjs（脱离 DSH 单独跑，调试用）
 *
 * 依赖：`mineflayer` —— **装哪一份由部署方决定**（官方 npm 版，或本机 link 进来的打过补丁的树）。
 *   🔴 插件不指定版本、不打包、不打补丁（2026-09-16 用户决策）：所以这里只写裸包名，
 *      谁想连新版本就把自己那份 link 成 `mineflayer`（见 .agent-docs/mc-agent-opensource-plan）。
 * 关键坑（详见 .agent-docs/mc-bridge-agent-tools-2026-09-14.md）：
 *   - auth 传函数时必须自己 options.connect(client)
 *   - spawn 早于区块下发，读世界前要 waitForChunks
 *   - 给 mineflayer 传坐标一律用真 Vec3
 *   - 走路必须"一直按住"前进键
 */
import mineflayer from 'mineflayer'
import vec3pkg from 'vec3'
import { offlineUuid, dashUuid } from './accounts.mjs'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import {
  writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, appendFileSync,
  statSync, renameSync, readdirSync,   // 日志轮转（2026-10-06）
} from 'node:fs'
import { join, dirname, basename, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 从 mineflayer **自己的**依赖树里解析包（同一份 node_modules）。
 * 用途：创造模式取物要 new 一个 prismarine-item 的 Item 实例塞进槽位。
 * ⚠️ 用"解析到的 mineflayer 实际路径"当锚点，**不写死目录** —— 这样插件装在哪儿都成立。
 */
const requireFromMineflayer = (() => {
  try { return createRequire(createRequire(import.meta.url).resolve('mineflayer')) } catch { return createRequire(import.meta.url) }
})()

/* ─────────── 「Yggdrasil 会话 join」的兼容补丁（用户 2026-09-17：它把整个 DSH 搞崩过）───────────
 * 事故链（真机实测栈）：
 *   minecraft-protocol/src/client/encrypt.js:41
 *     yggdrasilServer.join(accessToken, profileId, serverId, secret, pubkey, cb)   ← **老式回调**
 *   yggdrasil/src/Server.js:20  join 是 **async 函数，根本不调那个 cb**
 *   yggdrasil/src/utils.js:35   `if (body?.error !== undefined) throw new Error(body.error)`
 *                               → 皮肤站令牌失效时抛 `ForbiddenOperationException`
 *   ⇒ 这个 rejection **没有任何人接**（回调没人调、返回的 promise 没人 await）
 *   ⇒ 宿主的 `installFailLoud` 把"未处理的 Promise 拒绝"当致命错误 → `dsh: fatal load failure` → **exit(1)**
 *
 * 所以这里把 `yggdrasil.server(...)` 返回的对象包一层：
 *   · 调用方传了回调 → 我们替新版库把回调调起来（成功/失败都调）⇒ 恢复老式调用的语义、不产生悬空拒绝；
 *   · 没传回调 → 至少 `.catch()` 掉，别把它变成 unhandledRejection。
 * 同时把这类认证失败记下来（`takeAuthJoinError()`），好让上层给出"去 MC设置重新登录"的明确指引。
 *
 * ⚠️ 只动这一个方法；resolver 锚在 **mineflayer 自己的依赖树**上（保证和 minecraft-protocol 用的是同一份）。
 * ─────────────────────────────────────────────────────────────────────────────────────────── */
let lastAuthJoinError = null
/** 取出（并清空）最近一次 session-join 失败 */
export function takeAuthJoinError () { const e = lastAuthJoinError; lastAuthJoinError = null; return e }

/**
 * 把 `yggdrasil.server()` 的对象包一层（**纯函数**，自检直接测它）。
 * @param {object} server `yggdrasil.server({...})` 的返回值
 * @param {(e:Error)=>void} [onError] 失败时的记录钩子
 */
export function wrapYggdrasilServer (server, onError = (e) => { lastAuthJoinError = e }) {
  if (!server || typeof server.join !== 'function' || server.__wcJoinWrapped) return server
  const orig = server.join.bind(server)
  server.join = (...args) => {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null
    const p = orig(...args)
    if (cb) {
      // 回调式调用方（minecraft-protocol 就是这个）：替新版库把回调调起来
      Promise.resolve(p).then((r) => cb(null, r), (e) => { try { onError(e) } catch {} ; cb(e) })
      return p
    }
    return Promise.resolve(p).catch((e) => { try { onError(e) } catch {} })
  }
  server.__wcJoinWrapped = true
  return server
}

/** 一次性装上补丁（模块加载时装；拿不到 yggdrasil 就静默跳过） */
const yggCompat = (() => {
  try {
    const mod = requireFromMineflayer('yggdrasil')
    if (!mod || typeof mod.server !== 'function') return 'no-server-export'
    const orig = mod.server
    const wrapped = function (...args) { return wrapYggdrasilServer(orig.apply(this, args)) }
    try { mod.server = wrapped } catch { return 'readonly-export' }
    return 'patched'
  } catch (e) { return `skip:${e?.code ?? e?.message ?? 'unknown'}` }
})()

/** 认证类失败 → 给用户看的可执行错误（needUserAction 让前端/工具照原样转达） */
export function friendlyAuthError (e) {
  const raw = String(e?.message ?? e ?? '')
  if (/ForbiddenOperationException|InvalidToken|invalid session|Unauthorized|HTTP 40[13]|HTTP 400/i.test(raw)) {
    const err = new Error(`皮肤站认证被拒（${raw}）：这个账户当前的登录令牌在那个认证服上无效`)
    err.needUserAction = true
    err.hint = '请让用户在「MC设置」里重新登录这个账户（或点该账户的「刷新」），再重新进服'
    err.cause = e
    return err
  }
  return e instanceof Error ? e : new Error(raw)
}

/**
 * 交给 minecraft-protocol 的**凭据开关**（纯函数，自检直接测）。
 *
 * 🔴 2026-09-17 真机致命事故的另一半：`haveCredentials` 的语义是"**有真凭据**能拿给认证服看"
 *   （minecraft-protocol `microsoftAuth.js:33` / `mojangAuth.js:24` 都是这么设的），
 *   而我们以前**无条件设 true** ⇒ 离线账户也会被拖去 `sessionserver.mojang.com` 做 session join，
 *   假 token 必然被拒（`ForbiddenOperationException`）→ 那条 rejection 没人接 →
 *   宿主的 fail-loud 直接 `exit(1)`，整个 Harness 死。
 *   离线账户必须走 encrypt.js 的"无凭据"分支（不发 session join）。
 * @param {'offline'|'yggdrasil'} mode 账户类型
 * @returns {{haveCredentials:boolean, useAccessToken:boolean}}
 */
export function sessionFlags (mode) {
  const ygg = mode === 'yggdrasil'
  return { haveCredentials: ygg, useAccessToken: ygg }
}

let _itemLoader = null
function itemLoader () {
  if (!_itemLoader) _itemLoader = requireFromMineflayer('prismarine-item')
  return _itemLoader
}

export const DEFAULTS = {
  // ⚠️ 不预设服务器：host/authUrl/authUser/authPass/subserver 一律由调用方（mc_connect 工具）传入。
  //    这里只留环境变量口子（脱机调试用），没有默认值——避免"忘了传参就静默连到某个服"。
  host: process.env.MC_HOST ?? '',
  port: Number(process.env.MC_PORT ?? 25565),   // 25565 是 MC 协议默认端口，不是某台服务器的绑定
  subserver: process.env.MC_SUBSERVER ?? '',
  authUrl: process.env.MC_AUTH_URL ?? '',
  authUser: process.env.MC_AUTH_USER ?? '',
  authPass: process.env.MC_AUTH_PASS ?? '',
  connectTimeoutMs: 45_000,
  moveBudgetMs: 40_000,
  chatHistory: 300,
  /* 自动重连最多试几次（2026-10-08 审计报告 F1：以前**没有上限**，5s→10s→…→60s 无限重试，
   *  而看门狗会注入"正在自动重连，先别再操作角色" ⇒ AI 停手死等一个永远不来的重连）。 */
  maxReconnectAttempts: 5,
  /**
   * 日志落盘位置。🔴 **默认不写插件包目录**（装进 `node_modules/` 后那可能是只读的、
   * 升级时也会被覆盖）：默认写 `$DSH_HOME/dsh-mc-agent/logs/`，可用 `MC_LOG` 覆盖。
   */
  logFile: process.env.MC_LOG ?? join(resolveHarnessHome(), 'dsh-mc-agent', 'logs', 'dsh-mc-agent.log'),
}

/** 宿主家目录：`$DSH_HOME` → `~/.dsh`（与宿主 `resolveDshHome` 同一套规矩） */
function resolveHarnessHome () {
  const fromEnv = String(process.env.DSH_HOME ?? '').trim()
  if (fromEnv) return fromEnv
  try { return join(homedir(), '.dsh') } catch { return join(process.cwd(), '.dsh') }
}

/**
 * 把绝对路径里的宿主家目录换成 `$DSH_HOME`（审计报告 F12）。
 * `mc_capabilities` 以前直接回绝对路径 ⇒ 把主机用户名写进工具返回、进而进对话记录。
 * 换成 `$DSH_HOME/...` 后信息量不变（模型可以用环境变量解析），但不再泄露家目录。
 */
export function redactPath (p) {
  const s = String(p ?? '')
  if (!s) return s
  const home = resolveHarnessHome()
  if (!home) return s
  if (s === home) return '$DSH_HOME'
  if (s.startsWith(home + sep) || s.startsWith(home + '/') || s.startsWith(home + '\\')) {
    return '$DSH_HOME/' + s.slice(home.length + 1).replace(/\\/g, '/')
  }
  return s
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isAir = (n) => n === 'air' || n === 'cave_air' || n === 'void_air'
const isLiquid = (n) => n === 'water' || n === 'lava' || /_water$|_lava$/.test(String(n ?? ''))

/**
 * 能"穿过去"的小东西（花草火把之类）—— 洞穴层图里**不算墙**（否则一张图全是 `#`）。
 * 注意：树叶**不在**这里（它挡视线、也算地形），但在 `SOFT_ROOF` 里（头顶有树不算"在地下"）。
 */
const PASSABLE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow|vine|glow_lichen|torch|wall_torch|soul_torch|soul_wall_torch|redstone_torch|lantern|soul_lantern|chain|rail|powered_rail|detector_rail|activator_rail|redstone_wire|tripwire|tripwire_hook|lever|lily_pad|scaffolding|string|cobweb|ladder|light)$|_sapling$|_flower$|_carpet$|^carpet$|_sign$|^sign$|_banner$|^banner$|_button$|_pressure_plate$/
const isPassable = (n) => Boolean(n) && PASSABLE.test(String(n))

/** 头顶有这些东西**不算**"在地下"（树冠、竹子、雪层…）：站在树下 / 竹林里看地表图更有用 */
const SOFT_ROOF = /_leaves$|_log$|_wood$|^bamboo|^snow|_snow$|cactus|^moss|^melon|^pumpkin|_sapling$|_flower$|^vine$|glow_lichen|^hanging_roots$|^big_dripleaf/

// 敌对 / 远程怪名单 —— 供 `mobs()` 分类用。
// 🔴 与 `extensions/mc_auto.mjs` 里的 `HOSTILE` / `RANGED` **保持一致**：那边为了能离线自检
//    故意自带一份（见那个文件头部"只依赖 ../src/user-message.mjs"），改这里记得同步改那边。
const HOSTILE_RE = /zombie|skeleton|creeper|spider|witch|enderman|slime|pillager|vindicator|ravager|phantom|drowned|husk|stray|blaze|ghast|hoglin|piglin|wither|warden|silverfish|guardian|shulker/i
const RANGED_RE = /skeleton|stray|bogged|pillager|vindicator|witch|blaze|ghast|guardian|shulker|llama|illusioner|evoker|breeze|wither|drowned/i

/**
 * 掉落物 / 投掷物 —— 也算实体，也能"攻击"，但**不该抢走打怪/打猎的机会**。
 * 2026-10-08 实机：不带 `who` 的 `mc_act{attack}` 会先打到脚边的 `item`（自己刚挖掉的方块），
 * AI 自己都发现了（"it attacked an item entity. Not useful."）。
 */
const JUNK_RE = /^(item|experience_orb|arrow|spectral_arrow|tipped_arrow|snowball|egg|ender_pearl|eye_of_ender|potion|splash_potion|lingering_potion|firework_rocket|fishing_bobber|trident|wind_charge|breeze_wind_charge|llama_spit|shulker_bullet|fireball|small_fireball|dragon_fireball)$/i

/**
 * 掉落物实体（`minecraft-data` 里 `name: 'item'`、`displayName: 'Item'`，但 **`type` 是 `'other'`**）。
 *
 * why 单独抽成一份模块级判据：`#grabDrops`（顺手捡）与 `#dropsNear`（"东西还在地上"的提示）必须用
 * **同一份**判据 —— 2026-10-08 实机就是 `e.type !== 'object'` 写错，让 `#grabDrops` 永远返回 0
 * （挖掉 3 根原木、背包里还是 1 根）。也不能拿 `Boolean(e.displayName)` 兜底：几乎每个实体都有
 * displayName（牛是 `Cow`、经验球是 `Experience Orb`）⇒ 会把生物当成掉落物。
 */
const NOT_DROP_RE = /boat|minecart|armor_stand|item_frame|painting|arrow|snowball|egg|ender_pearl|eye_of_ender|fireball|fishing_bobber|potion|tnt|falling_block|leash|knot|shulker_bullet|llama_spit|wind_charge/i
const isDropEntity = (e) => {
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
const NAME_ALIAS = {
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
const entityNameOf = (e) => String(e?.username ?? e?.name ?? e?.displayName ?? e?.type ?? '?')

/** 一个实体所有能拿来匹配的名字（都转小写） */
const nameFieldsOf = (e) => [e?.username, e?.name, e?.displayName, e?.type, e?.kind, e?.entityType]
  .filter((v) => typeof v === 'string' && v).map((v) => v.toLowerCase())

/**
 * `who` 匹配一个实体：英文名 / 玩家名 / 中文别名（`NAME_ALIAS`）都认。
 *
 * 🔴 2026-10-08 审计：`lookAt()` 与 `useBlock()` 原来各写了一遍
 *    `String(e.username ?? e.name ?? '').includes(needle)` —— 中文叫法、`displayName`、
 *    `type` 全都不认，和 `attack()` 的行为不一致（AI 学会了"僵尸"能打，转头"看僵尸"就报找不到）。
 */
const matchNameOf = (e, needle, alias = null) => {
  const fields = nameFieldsOf(e)
  return fields.some((f) => f.includes(needle)) || (alias ? fields.some((f) => f.includes(alias)) : false)
}

/** 右键能**打开窗口**的方块（`use` 之后窗口该出现，这就是"交互成功"的硬证据） */
const CONTAINER_RE = /chest|barrel|shulker_box|furnace|smoker|hopper|dispenser|dropper|brewing_stand|enchanting_table|anvil|grindstone|smithing_table|loom|cartography_table|stonecutter|crafting_table|beacon|lectern|fletching_table|respawn_anchor|decorated_pot|chiseled_bookshelf|crafter/i

/** 右键会**翻转状态**的方块（门/活板门/栅栏门/按钮/拉杆）—— 可以复核状态有没有变 */
const TOGGLE_RE = /(_door|_trapdoor|fence_gate|button|lever)$/i

/** 找实体：`list` 是 `[{ e, d }]`（d = 到自己多少格），返回 `{ hit, near }` */
const pickEntity = (list, who) => {
  const needle = String(who ?? '').trim().toLowerCase()
  const alias = NAME_ALIAS[needle] ?? null
  const sorted = [...list].sort((a, z) => a.d - z.d)
  const hit = sorted.find((x) => matchNameOf(x.e, needle, alias)) ?? null
  const near = sorted.slice(0, 6).map((x) => `${entityNameOf(x.e)} ${Number.isFinite(x.d) ? x.d.toFixed(1) : '?'} 格`)
  return { hit, near, needle, alias }
}

/**
 * 这个位置**能不能放方块进去**（= 该方块不占空间 / 是可替换物）。
 *
 * 判据用 `boundingBox === 'empty'`，**不是**"名字是不是 air"。
 * 旧版只认 air/cave_air/void_air，2026-09-15 用真实 minecraft-data(26.2) 实测发现漏了一大片：
 *   ✅ air / cave_air / void_air   → 'empty'
 *   ✅ **water / lava**             → 'empty'  ← 旧版这里直接失败，**水里建不了东西**（码头/桥全废）
 *   ✅ 草/花/蕨/雪/藤蔓/海草/海带/气泡柱/火把/火/树苗/地毯/铁轨 → 'empty'
 *   ❌ 石头/木板/台阶/楼梯/土径      → 'block'  （正确拒绝）
 * ⚠️ 未加载（blockAt 返回 null）**不算可放** —— 不能盲放。
 */
const canPlaceInto = (blk) => {
  if (!blk) return false
  if (blk.boundingBox === 'empty') return true
  return isAir(blk.name) || isLiquid(blk.name)     // 兜底：个别版本 boundingBox 可能不准
}

/**
 * ── 现成的 mineflayer 生态插件（PrismarineJS 官方/社区项目；**这些都不自己写**） ──────
 *
 * 用户 2026-10-06 要求："应该有写好的防卡住项目，现在它会一直跳来跳去，完全是瞎动。"
 * 之后又要求把「自动吃 / 捡东西 / 挖方块 / 换工具 / 打怪」也换成现成的项目。
 *
 * | 键 | 包 | 干什么 |
 * | --- | --- | --- |
 * | `pathfinder` | mineflayer-pathfinder | A* 寻路 + 挖穿挡路方块 + 垫 1×1 塔 + 卡住检测 |
 * | `collectBlock` | mineflayer-collectblock | 走过去挖方块 / 捡掉落物（内部自己换工具） |
 * | `tool` | mineflayer-tool | 按方块选并换上最好的工具 |
 * | `pvp` | mineflayer-pvp | 追击并打怪（近战节奏自己算） |
 * | `autoEat` | mineflayer-auto-eat | 饿了自动吃（自己挑食物、吃完换回原手上的东西） |
 *
 * 装法见 `dsh-mc-agent/PATHFINDER.md`：装到 `<profile>\vendor\mc-deps`（**不碰宿主的 node_modules**，
 * 免得 pnpm 一重装就把 readable-stream 那个补丁冲掉）。这里按顺序找：
 *   ① `DSH_MC_AGENT_MC_DEPS`（给"装依赖的目录"，可含 node_modules）② 插件包旁边的 vendor 树
 *   ③ 裸包名（宿主自己装了就能解析到）。找不到 = 那一项能力没有，其它照旧。
 */
export const MC_DEPS = {
  pathfinder: { pkg: 'mineflayer-pathfinder', entry: 'index.js', label: '寻路 mineflayer-pathfinder（A* + 挖穿 + 垫脚 + 卡住检测）' },
  collectBlock: { pkg: 'mineflayer-collectblock', entry: 'lib/index.js', label: '挖/捡 mineflayer-collectblock（走过去挖方块、捡掉落物）' },
  tool: { pkg: 'mineflayer-tool', entry: 'lib/index.js', label: '换工具 mineflayer-tool（按方块挑最好的工具）' },
  pvp: { pkg: 'mineflayer-pvp', entry: 'lib/index.js', label: '打怪 mineflayer-pvp（追击 + 近战节奏）' },
  autoEat: { pkg: 'mineflayer-auto-eat', entry: 'dist/index.js', label: '自动吃 mineflayer-auto-eat' },
}

const DEP_OFF = /^(off|0|false|no|none)$/i
const _depCache = new Map()

/**
 * `import()` 出来的模块可能是 CJS 也可能是 ESM，具名导出还不全 ——
 * 既看具名导出也看 `default`，按名字顺序取第一个拿到的。
 */
function pickExport (mod, names) {
  const d = mod?.default ?? {}
  for (const n of names) {
    const v = mod?.[n] ?? d?.[n]
    if (v !== undefined && v !== null) return v
  }
  return undefined
}

/**
 * 找一个 vendor 依赖并 `import()` 它。**只缓存成功**：找不到时每次调用都重新试一遍。
 * （踩过的坑：以前把"找不到"也缓存了，结果在 vendor 树里修好文件之后，
 *   进程内再也等不到重试 —— 只能重启 DSH。失败重试很便宜，只在连接时发生。）
 * @param {'pathfinder'|'collectBlock'|'tool'|'pvp'|'autoEat'} key
 * @param {{log?:Function, logWarn?:Function, spec?:string}} opts
 *   `log` = 成功细节（调用方一般传 `logDebug`，默认看不见）；`logWarn` = 失败/形状不对（info，真出问题时要看得见）
 * @returns {Promise<any>} pathfinder 返回 `{pathfinder,Movements,goals}`；其它返回 `loadPlugin` 要的那个函数；找不到返回 null
 */
export async function loadMcDep (key, { log = null, logWarn = null, spec = null } = {}) {
  if (_depCache.has(key)) return _depCache.get(key)
  const info = MC_DEPS[key]
  if (!info) throw new Error(`未知的 vendor 依赖：${key}（可用：${Object.keys(MC_DEPS).join(' / ')}）`)
  const raw = spec ?? process.env.DSH_MC_AGENT_MC_DEPS ?? null
  const cands = []
  if (raw && !DEP_OFF.test(String(raw).trim())) {
    const s = String(raw).trim()
    if (/\.(m?js|cjs)$/i.test(s)) cands.push(/^[a-zA-Z]:[\\/]|^\//.test(s) ? pathToFileURL(s).href : s)
    else {
      // 当成"装依赖的目录"：目录本身 / 目录/node_modules 里都能找
      for (const p of [
        join(s, info.pkg, info.entry),
        join(s, 'node_modules', info.pkg, info.entry),
        join(s, info.entry),
      ]) if (existsSync(p)) cands.push(pathToFileURL(p).href)
      if (!cands.length) cands.push(s)
    }
  }
  try {
    // 本文件在 <profile>/node_modules/dsh-mc-agent/src/ → 往上三层就是 <profile>
    cands.push(new URL(`../../../vendor/mc-deps/node_modules/${info.pkg}/${info.entry}`, import.meta.url).href)
  } catch {}
  // 兜底：`$DSH_HOME/profiles/*/vendor/mc-deps/` 的**绝对路径**。
  // 🔴 为什么需要它：上面那条是**相对本文件**算的，只有插件包正好是
  //   `<profile>/node_modules/dsh-mc-agent/` 这个真目录时才对。一旦装成符号链接 /
  //   junction（`file:` / `link:` 依赖），`import.meta.url` 会落到
  //   `node_modules/.pnpm/<name>@file+.../node_modules/<name>/src/` 这种深路径上，
  //   往上三层就不再是 profile ⇒ vendor 树**静默**加载不到（移动/采集/吃/打怪全哑）。
  //   这条按绝对路径找，与安装拓扑无关。
  try {
    const profRoot = join(resolveHarnessHome(), 'profiles')
    for (const ent of readdirSync(profRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const p = join(profRoot, ent.name, 'vendor', 'mc-deps', 'node_modules', info.pkg, info.entry)
      if (existsSync(p)) cands.push(pathToFileURL(p).href)
    }
  } catch {}
  cands.push(info.pkg)                        // 宿主自己装了也能解析到
  for (const c of cands) {
    const where = c.startsWith('file:') ? 'vendor 树' : c
    try {
      const m = await import(c)
      if (key === 'pathfinder') {
        // ⚠️ 它是 CJS：`import()` 出来的具名导出**不全**（实测只有 Movements/pathfinder，
        //    `goals` 只在 default 上）—— 所以两边都要看，凑成一个完整对象。
        const mod = {
          pathfinder: pickExport(m, ['pathfinder']),
          Movements: pickExport(m, ['Movements']),
          goals: pickExport(m, ['goals']),
        }
        if (mod.pathfinder && mod.Movements && mod.goals) {
          _depCache.set(key, mod)
          log?.(`已找到现成的${info.label}（${where}）`)
          return mod
        }
        ;(logWarn ?? log)?.(`pathfinder 候选不是预期的模块：${c}`)
        continue
      }
      // 其余插件：入口就是 `bot.loadPlugin()` 要的那个函数
      // （collectblock/tool/pvp 的 CJS 导出叫 `plugin`，auto-eat 的 ESM 导出叫 `loader`）
      const fn = pickExport(m, ['plugin', 'loader'])
      if (typeof fn === 'function') {
        _depCache.set(key, fn)
        log?.(`已找到现成的${info.label}（${where}）`)
        return fn
      }
      ;(logWarn ?? log)?.(`${key} 候选不是预期的模块：${c}`)
    } catch (e) {
      ;(logWarn ?? log)?.(`${key} 候选不可用（${c.startsWith('file:') ? c.slice(0, 60) + '…' : c}）：${e?.code ?? e?.message}`)
    }
  }
  // 故意不缓存失败：修好 vendor 树后，下一次连接（不用重启 DSH）就能加载上
  return null
}

/**
 * 兼容旧名字：只要寻路插件。`DSH_MC_AGENT_PATHFINDER` 仍然只影响"显式指定的那一路"，
 * 真正的开关是配置里的 `pathfinder: false`（见 `setupPathfinder`）。
 */
export async function loadPathfinder ({ log = null, logWarn = null, spec = null } = {}) {
  const raw = spec ?? process.env.DSH_MC_AGENT_PATHFINDER ?? null
  return await loadMcDep('pathfinder', { log, logWarn, spec: raw })
}

/** 测试用：清掉已成功的缓存（失败本来就不缓存，真机不需要调） */
export function resetPathfinderCache () { _depCache.delete('pathfinder') }
/** 测试用：清掉所有 vendor 依赖的成功缓存 */
export function resetMcDepCache () { _depCache.clear() }

/**
 * 形状**不是整方块**的方块名（半砖/楼梯/墙/栅栏/地毯/耕地/告示牌/头颅/铁砧…）。
 *
 * 为什么不能只看 `boundingBox`：半砖、楼梯、栅栏、墙、地毯、耕地、土径、头颅、铁砧的
 * `boundingBox` 同样是 `'block'`、`transparent` 同样是 `false`，但它们**站不住、也叠不起来**。
 * 2026-10-06 用户报"它搭方块会用非实体方块搭"就是踩在这里。
 */
const NON_FULL_BLOCK = /(_slab|_stairs|_wall|_fence|_fence_gate|_carpet|_pane|_door|_trapdoor|_button|_pressure_plate|_sign|_banner|_bed|_rail|_torch|_candle|_chain|_bars|_head|_skull|_anvil|_cauldron|_composter|_lectern|_grindstone|_stonecutter|_loom|_cartography_table|_fletching_table|_smithing_table|_brewing_stand|_enchanting_table|_beacon|_conduit|_bell|_campfire|_lantern|_pot|_plant|_flower|_sapling|_roots|_sprouts|_vine|_lily|_grass|_fern|_leaves|_azalea|_bush|_shoot|_petals?|_cluster|_hanging|_cocoon|_vein|_pointed|_dripstone|_chorus|_kelp|_seagrass|_pickle|_egg|_web|_layer)$|^(farmland|dirt_path|snow|tnt|vine|chain|anvil|rail|scaffolding|cobweb)$/

/**
 * 这个方块物品能不能当**实体方块**用 —— 整方块，能站上去、能往上叠。
 * 火把/花/告示牌/门/玻璃/树叶/梯子/半砖/楼梯/栅栏…一律不算。
 *
 * 判据三段（缺一不可，实测过 1.21.10 的 registry）：
 *   ① `boundingBox === 'block'` 排掉火把/树苗/按钮/告示牌/铁轨/蜘蛛网；
 *   ② `transparent === false` 排掉门/活板门/梯子/玻璃/树叶/脚手架/竹子/荷叶；
 *   ③ 名字黑名单排掉半砖/楼梯/墙/栅栏/地毯/耕地/土径/头颅/铁砧（①②都拦不住它们）。
 */
export function isFullBlockItem (bot, name) {
  const b = bot?.registry?.blocksByName?.[name]
  if (!b) return false                             // 根本不是方块（木棍、煤、钻石…）
  if (b.boundingBox !== 'block') return false      // 火把/花/按钮/告示牌/铁轨/蜘蛛网/树苗…
  if (b.transparent !== false) return false        // 门/活板门/梯子/玻璃/树叶/脚手架/竹子/荷叶…
  return !NON_FULL_BLOCK.test(String(name))        // 半砖/楼梯/墙/栅栏/地毯/耕地/土径/头颅/铁砧…
}

/**
 * 背包里**能当垫脚料**的方块，返回 **item id** 列表（pathfinder 的 `scafoldingBlocks` 要的就是它）。
 *
 * ⚠️ 必须用 `itemsByName`：`scafoldingBlocks` 是跟 `bot.inventory.items()` 里的 `item.type`
 *    比的（**物品 id**）；1.13+ 物品 id ≠ 方块 id，拿 `blocksByName` 的 id 填进去会永远匹配不上
 *    （2026-10-06 在 mc_craft 上刚被同一个坑咬过：工作台物品 332 / 方块 205）。
 *
 * ⚠️ 必须是**整方块**（见 `isFullBlockItem`）：火把、树苗、门、半砖也能"放下去"，
 *    但垫在脚下一站就掉 —— 用户报的"它搭方块会用非实体方块搭"就是这个。
 * 贵重的方块（矿石、钻石/铁/金块…）和家当（箱子、熔炉、工作台…）不拿去垫。
 */
const NO_SCAFFOLD = /(_ore$|^(diamond|netherite|emerald|gold|iron|copper|coal|redstone|lapis|quartz|amethyst)_(block|ore)?$|^(diamond|netherite|emerald)_block$|^ancient_debris$|^(chest|trapped_chest|barrel|ender_chest|shulker_box|furnace|blast_furnace|smoker|crafting_table|anvil|chipped_anvil|damaged_anvil|enchanting_table|beacon|conduit|hopper|dispenser|dropper|jukebox|note_block|respawn_anchor|lodestone|beehive|bee_nest|brewing_stand|cauldron|bell|sculk_catalyst|tnt)$|_shulker_box$|_bed$)/
export function scaffoldingItemIds (bot) {
  let items = []
  try { items = bot?.inventory?.items?.() ?? [] } catch {}
  const counts = new Map()                          // item id -> 手里最多的一摞
  for (const it of items) {
    const name = it?.name
    if (!name) continue
    if (!isFullBlockItem(bot, name)) continue       // 火把/门/半砖这些搭不了
    if (NO_SCAFFOLD.test(name)) continue
    counts.set(it.type, Math.max(counts.get(it.type) ?? 0, it.count ?? 1))
  }
  // 手里多的排前面：垫脚优先用存货多的，别把最后一块土用掉
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

/**
 * 挑一个"能放"的方块物品。
 * - 指定 `want`：就给那个（哪怕它是火把/半砖 —— AI 明确点名要的，不拦）
 * - 没指定：**只挑整方块**，并跳过家当（矿石/箱子/熔炉/工作台…）。
 *
 * 旧版没指定时直接 `items[0]` —— 于是背包第一格是火把/树苗/门/木棍时它就拿去搭，
 * 用户 2026-10-06 报的"它搭方块会用非实体方块搭"就是这个。
 */
export function pickPlaceItem (bot, want = null) {
  let items = []
  try { items = bot?.inventory?.items?.() ?? [] } catch {}
  if (!items.length) return null
  if (want) return items.find((i) => i.name === want) ?? null
  return items.find((i) => isFullBlockItem(bot, i.name) && !NO_SCAFFOLD.test(String(i.name))) ?? null
}

/**
 * 规范化认证端点基址：去首尾空白、去掉结尾多余的斜杠。
 * 否则 `https://x/yggdrasil/` 会拼成 `https://x/yggdrasil//authserver/authenticate`
 * （多数服务端能容忍，但不该指望）。
 */
function normalizeBaseUrl (url) {
  const s = String(url ?? '').trim()
  return s ? s.replace(/\/+$/, '') : ''
}

/* ── 日志基建：本地时间 + 级别 + 进程内去重 + 轮转（2026-10-06 用户"日志优化"）───────
 * 起因（实测 1455 行主日志）：59.7% 是启动噪声 —— 依赖横幅**每个连接重打一遍**、
 * 账户/归档/记忆播种每会话重打一遍；时间戳是 UTC（比本地早 8 小时、跨天看不出是哪天）；
 * 没有版本标记（今天的行和几天前的混在一起分不出）；从不轮转（selfcheck.log 已 1.2 MB）。
 * 改法：① `stamp()` 本地 `MM-DD HH:MM:SS`；② `logDebug()` 只在 MC_LOG_LEVEL=debug 落盘；
 *      ③ `logOnce(key)` 用 **globalThis** 判重（每个连接是新的模块实例，模块级变量拦不住）；
 *      ④ 超过 MC_LOG_MAX_BYTES（默认 2 MB）就改名 `dsh-mc-agent.YYYY-MM-DD[-n].log`，留最近 MC_LOG_KEEP（默认 7）份。
 */
const LOG_LEVELS = { quiet: 0, info: 1, debug: 2 }
/** 当前日志级别（`MC_LOG_LEVEL=quiet|info|debug`，默认 info） */
export function logLevel () {
  const v = String(process.env.MC_LOG_LEVEL ?? 'info').trim().toLowerCase()
  return LOG_LEVELS[v] ?? LOG_LEVELS.info
}
/** 本地时间 `MM-DD HH:MM:SS`（原来是 `toISOString()` 的 UTC 时分秒：跨天分不出哪天、和游戏日志差 8 小时） */
export function stamp (d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const LOG_MAX_BYTES = Number(process.env.MC_LOG_MAX_BYTES) || 2 * 1024 * 1024
const LOG_KEEP = Number(process.env.MC_LOG_KEEP) || 7

/** 超过上限就把主日志改名存档（`<名字>.YYYY-MM-DD[-n].log`），只留最近 LOG_KEEP 份 */
function rotateLogIfNeeded (file) {
  try {
    if (!existsSync(file) || statSync(file).size < LOG_MAX_BYTES) return
    const stem = basename(file).replace(/\.log$/i, '')
    const dir = dirname(file)
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    let target = join(dir, `${stem}.${day}.log`)
    for (let i = 2; existsSync(target) && i < 200; i++) target = join(dir, `${stem}.${day}-${i}.log`)
    renameSync(file, target)
    const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d{4}-\\d{2}-\\d{2}(-\\d+)?\\.log$`)
    readdirSync(dir)
      .filter((n) => re.test(n))
      .map((n) => { try { return { n, t: statSync(join(dir, n)).mtimeMs } } catch { return null } })
      .filter(Boolean)
      .sort((a, b) => b.t - a.t)
      .slice(LOG_KEEP)
      .forEach((o) => { try { unlinkSync(join(dir, o.n)) } catch {} })
  } catch {}
}

/** 统一落盘：自动建目录 + 轮转 */
function appendLog (file, line) {
  try {
    const dir = dirname(file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    rotateLogIfNeeded(file)
    appendFileSync(file, line + '\n')
  } catch {}
}

/**
 * 独立落盘日志（不需要 McBot 实例）。
 * 用途：插件加载/卸载这种"机器人都还没有"的时刻也要在 dsh-mc-agent.log 留痕——
 * 排查"插件到底加载了没"全靠这一行（曾因为没有它而误判成"工具没注册"）。
 */
export function logLine (...args) {
  const line = `[dsh-mc-agent ${stamp()}] ${args.join(' ')}`
  appendLog(DEFAULTS.logFile, line)
  return line
}

/** 只有 `MC_LOG_LEVEL=debug` 才落盘：启动横幅这类"每个连接都重打一遍"的细节行 */
export function logDebug (...args) {
  const line = `[dsh-mc-agent ${stamp()}] ${args.join(' ')}`
  if (logLevel() >= LOG_LEVELS.debug) appendLog(DEFAULTS.logFile, line)
  return line
}

/**
 * 整个进程只落盘一次（同 key 再来直接跳过，返回 false）。
 * 🔴 **必须挂在 `globalThis` 上**：每个 MC 连接都会重新 `import()` 一份 core.mjs，
 *    模块级变量根本拦不住"每个连接重打一遍"。
 */
export function logOnce (key, ...args) {
  const g = (globalThis.__dshMcAgentLogged ??= new Set())
  if (g.has(key)) return false
  g.add(key)
  logLine(...args)
  return true
}

/* ============================================================================
 * 🔴 超时保护 —— "对话卡在生成中、停止键也按不动"的根因修复（2026-09-15）
 * ----------------------------------------------------------------------------
 * mineflayer 的 dig / placeBlock / equip / lookAt / creative.flyTo 返回的都是
 * "**等服务端 ack**" 的 promise。服务端可能根本不回包（版本对不上、支持不完整
 * 时尤其如此）→ promise 永不 settle
 * → 工具 execute 永不返回 → 整轮 turn 卡死：
 *     前端一直"生成中" · 停止键无效（没有中断点） · 无法插话
 * 症状表现为"LLM 也停止输出了"——其实模型早调完工具在等结果，是工具卡住了。
 *
 * 注意：超时只是**不再等**，底层 promise 仍悬着（JS 无法取消已发出的网络等待）。
 * 因此超时后必须把机器人当作"可能已失步"处理：松掉所有控制位 + 记 lastTimeout。
 *
 * 🔴 2026-10-06 补充（实机"机器人走不了了"的根因）：对 mineflayer-collectblock
 *    这种**后台还在跑**的任务，光松控制位不够 —— 它自己会立刻把 `forward` 按回去，
 *    机器人就"物理冻住"：`mc_diag` 显示 `forward:true` 而 `velocity` 全 0、位置一格不动，
 *    之后的 `mc_move` 也全部失败（15 秒只挪 0.03 格），只有重连才恢复。
 *    必须显式 `cancelTask()` 把那个循环停下来，见 `#cancelCollect`。
 * ========================================================================== */

/** 各类操作的默认超时（ms）；可用 cfg.timeouts 覆盖 */
export const TIMEOUTS = {
  lookAt: 4_000,
  equip: 6_000,
  dig: 25_000,
  place: 6_000,
  flyTo: 30_000,
  digBlock: 25_000,
  give: 8_000,
  act: 6_000,
  toss: 5_000,
  attack: 4_000,
}

/**
 * 单次工具调用的时间上限。
 * 🔴 用户要求：**一次工具调用别挂太久，宁可少量多次** —— 一次挂几分钟的时候
 *    用户看不到消息、也没法插话（"太久根本获取不了消息"）。
 *    一开始定的是 5 秒；后来用户要求"把使用工具 5 秒的限制提高到 11 秒"（2026-10-08）⇒ 改成 11 秒。
 *    所以长动作（走路 / 挖一片 / 搭一片 / 盯熔炉 / 连串步骤）一律改成
 *    **到点就带着进度返回**，由模型再叫一次接着做。
 *    两道闸：① `asTool` 每次调用前设"截止时刻"，`#t` 和各个循环都看它；
 *            ② 工具自己的 `timeoutMs` 也压到 CALL_MS + 1 秒兜底。
 */
export const CALL_MS = 11_000         // 硬上限：一次工具调用最多占这么久
export const CALL_BUDGET_MS = 10_000  // 动作自己的预算（留 1 秒收尾 / 序列化 / 回传）
/** 把预算收进 [200, cap]；没给（或不是正数）就用 def */
export const callBudget = (v, def = CALL_BUDGET_MS, cap = CALL_BUDGET_MS) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.max(Math.round(n), 200), cap)
}
/** 这一轮调用的截止时刻（ms）—— 循环里用它早停，别把整次调用挂死 */
export const callDeadline = (ms = CALL_MS) => Date.now() + ms
/** 给模型看的"这一轮用完了"文案里的秒数（跟着 `CALL_MS` 走，改上限时不用再挨个改文案） */
export const callSecText = () => `${Math.round(CALL_MS / 1000)} 秒`
/** 动作预算的秒数（文案用） */
export const budgetSecText = () => `${Math.round(CALL_BUDGET_MS / 1000)} 秒`

/**
 * 服务器指令的**内置**白名单（保底值）。
 * 插件层会传自己的可配置白名单覆盖它（`command(cmd, { allow })`）——
 * 这份只是"没有配置时也能安全跑"的默认，和 src/config.mjs 的默认值保持一致。
 */
export const DEFAULT_COMMAND_WHITELIST = new Set([
  'tp', 'teleport', 'give', 'time', 'weather', 'say', 'tell', 'msg',
  'gamemode', 'effect', 'enchant', 'setblock', 'fill', 'clone', 'summon',
  'title', 'spawnpoint', 'difficulty', 'kill', 'clear', 'xp', 'experience',
])

/**
 * 给可能永不 settle 的 promise 套超时。超时抛出的错误带 `mcTimeout: true`。
 */
export function withTimeout (promise, ms, label) {
  let timer
  const guard = new Promise((_, reject) => {
    // ⚠️ 这里**故意不 unref**：守卫定时器代表"有真实工作在等"，unref 掉会让
    //    "只有它在跑"时进程直接退出、超时永不触发（selfcheck 里实测踩到）。
    timer = setTimeout(() => reject(new Error(`__MC_TIMEOUT__${label}`)), ms)
  })
  return Promise.race([promise, guard])
    .catch((e) => {
      if (String(e?.message ?? '').startsWith('__MC_TIMEOUT__')) {
        // ⚠️ 这句文案以前写的是"服务端没有回应，机器人可能已失步"——**误导**：
        //    超时的绝大多数原因是**目标够不着 / 寻路失败**（本地算的，跟服务端无关），
        //    模型看到"可能已失步"就会去 mc_connect 重连，白断一次线。
        //    改成如实描述 + 说清"已经做了什么"，让它先换目标而不是先重连。
        const err = new Error(`${label} 超时（${ms}ms）：这一步在限定时间内没做完`
          + '（常见原因：目标够不着、寻路失败，或服务端没回应）。'
          + '控制位已经松开；如果是挖方块/采集，后台任务也已经停掉。'
          + '可以换个近一点/好走的目标点重试，或先用 mc_status / mc_diag 看状态。')
        err.mcTimeout = true
        throw err
      }
      throw e
    })
    .finally(() => { if (timer) clearTimeout(timer) })
}

/**
 * 与 AbortSignal 赛跑 —— 让"停止按钮"真正有效。
 *
 * 为什么必须单独做：宿主的停止链路（GUI 停止键 → POST /api/session/cancel →
 * `agent.cancel({kind:'user'})` → `phase.abort.abort(cause)`）**只是 abort 一个
 * signal**，它没有能力抛弃同进程里 pending 的 promise（宿主源码原话：
 * `tools/index.ts:219` "it cannot hard-kill same-process code"）。
 * 所以工具必须自己在 await 上监听 signal，否则：
 *   本地超时兜底最长要等 25s（dig），用户按停止后仍然"卡着不动"。
 *
 * 拿到 exec.signal 的路径：`ToolExecutionInput.signal`（`exec.signal`），
 * 由 `executeToolCalls(..., signal)` 传入，就是本轮 turn 的 abort signal。
 */
export function raceAbort (promise, signal, label) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError(label, signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(label, signal))
    signal.addEventListener('abort', onAbort, { once: true })
    const settle = (fn) => (v) => { signal.removeEventListener('abort', onAbort); fn(v) }
    promise.then(settle(resolve), settle(reject))
  })
}

function abortError (label, signal) {
  const err = new Error(`${label} 被中断（用户停止 / 会话取消）`)
  err.mcAborted = true
  try { err.reason = signal?.reason } catch {}
  return err
}

/**
 * 把任意值压成**无损 JSON**，用于工具返回值（宿主会校验，不合格直接报
 * 「value is not lossless JSON」）。
 *
 * 为什么必须有：DSH 的校验（packages/core/tools/src/json-schema.ts）
 *   - isPlainJsonRecord：对象的原型链必须是 Object.prototype/null
 *   - isJsonNumber：必须是有限数，且 **不允许 -0**
 * 而 mineflayer 的 position/velocity 是 **vec3 类实例**，原型对不上，整条
 * 工具直接失败。2026 实测：mc_status / mc_diag / mc_entities / mc_move /
 * mc_connect 五个工具全栽在这一个边界上（工具本身逻辑没错）。
 *
 * 规则：类实例 → 只留自有可枚举属性（Vec3 → {x,y,z}）；Date → ISO 串；
 * Map/Set → 普通对象/数组；循环引用 → '[circular]'；NaN/±Infinity → null；
 * -0 → 0；undefined/函数/symbol → 丢掉该键（数组里补 null）。
 */
export function lossless (value, seen = new WeakSet()) {
  if (value === null) return null
  const t = typeof value
  if (t === 'number') {
    if (!Number.isFinite(value)) return null
    return Object.is(value, -0) ? 0 : value
  }
  if (t === 'bigint') return value.toString()
  if (t === 'string' || t === 'boolean') return value
  if (t !== 'object') return undefined          // undefined / function / symbol
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) {
    return value.map((v) => {
      const s = lossless(v, seen)
      return s === undefined ? null : s
    })
  }
  if (value instanceof Map) return lossless(Object.fromEntries([...value].map(([k, v]) => [String(k), v])), seen)
  if (value instanceof Set) return lossless([...value], seen)
  const out = {}
  // 只取自有可枚举属性：类实例的 getter/原型方法/私有字段一并丢掉
  for (const [k, v] of Object.entries(value)) {
    const s = lossless(v, seen)
    if (s !== undefined) out[k] = s
  }
  return out
}

/**
 * 洞穴层视图的**合成方块名 → 字符**（`heightmap({ mode:'cave' })` 用，见 `#caveCell`）。
 * 地表图是"这格地表是什么方块"，洞穴图是"这格能不能走、脚下有没有地面"，所以另起一套字形。
 */
const CAVE_GLYPH = {
  cave_wall: '#', cave_open: '·', cave_step: '↓', cave_drop: 'v',
  cave_water: '~', cave_lava: '≈', cave_ore: '*', cave_void: '?',
}
/** 洞穴层视图的中文标签（图例 / 文案用） */
const CAVE_LABEL = {
  cave_wall: '墙', cave_open: '能站', cave_step: '低一格', cave_drop: '会掉下去',
  cave_water: '水', cave_lava: '岩浆', cave_ore: '矿石', cave_void: '未加载',
}

/** 方块名 → 单字符（给没有视觉的模型"看"地形） */
export function glyphOf (name) {
  if (!name) return '?'
  if (CAVE_GLYPH[name]) return CAVE_GLYPH[name]
  if (isAir(name)) return ' '
  if (/_water$|water|_ice$|^ice$/.test(name)) return '~'
  if (/sand/.test(name)) return '.'
  if (/_leaves$|grass_block|short_grass|tall_grass|_flower|fern|bush|cactus|moss/.test(name)) return '"'
  if (/_log$|_wood$|_planks$|fence|door|sign|stairs|slab|bookshelf|crafting_table|chest/.test(name)) return 'T'
  if (/stone|cobble|deepslate|brick|concrete|terracotta|copper|iron|gold|diamond|obsidian|quartz|purpur|anvil|enchant/.test(name)) return ':'
  if (/snow|white_|quartz|glass|iron_block/.test(name)) return '#'
  if (/dirt|podzol|mud|gravel|clay|farmland|wheat|carrot|potato|beetroot/.test(name)) return '_'
  return '+'
}

const COLORS = {
  // 洞穴层视图（`mode:'cave'`）：能走 = 亮，墙 = 暗，掉下去 = 偏蓝，水/岩浆/矿石各自一色
  cave_wall: [95, 95, 100], cave_open: [205, 205, 195], cave_step: [165, 165, 150],
  cave_drop: [125, 125, 175], cave_water: [51, 76, 178], cave_lava: [222, 110, 40],
  cave_ore: [190, 155, 70], cave_void: [40, 40, 48],
  grass_block: [106, 170, 64], dirt: [134, 96, 67], sand: [219, 207, 163], suspicious_sand: [200, 185, 140],
  sandstone: [216, 203, 155], smooth_sandstone: [214, 200, 150], stone: [125, 125, 125], cobblestone: [110, 110, 110],
  water: [51, 76, 178], ice: [160, 180, 240], snow_block: [250, 250, 250], oak_log: [110, 84, 50],
  oak_leaves: [60, 120, 45], oak_planks: [162, 130, 78], glass: [200, 220, 230], farmland: [110, 80, 50],
  wheat: [190, 180, 90], bricks: [150, 97, 83], bookshelf: [140, 110, 70], obsidian: [30, 20, 45],
}
function colorOf (name) {
  if (!name) return [70, 20, 90]
  if (COLORS[name]) return COLORS[name]
  if (/_water$/.test(name)) return [51, 76, 178]
  if (/_leaves$/.test(name)) return [55, 115, 45]
  if (/_log$|_wood$/.test(name)) return [105, 80, 48]
  if (/_planks$/.test(name)) return [162, 130, 78]
  if (/_sand/.test(name)) return [219, 207, 163]
  if (/_concrete$/.test(name)) return [160, 160, 160]
  if (/_wool$/.test(name)) return [220, 220, 220]
  if (/_ore$/.test(name)) return [125, 125, 125]
  if (/stone|cobble|deepslate|brick/.test(name)) return [120, 120, 120]
  return [150, 150, 150]
}

/**
 * 一个 Minecraft 机器人（保活、事件、世界操作）。
 * 事件（EventEmitter）：'chat'(玩家聊天) 'system'(系统消息) 'spawn' 'end' 'kicked' 'error' 'damage' 'log'
 */
export class McBot extends EventEmitter {
  constructor (config = {}) {
    super()
    this.cfg = { ...DEFAULTS, ...config }
    // 实例标识：多会话各自一个 McBot，锁文件按实例分开（同进程 pid 相同，共用一个锁会互相误删）
    this.instanceId = String(config.instanceId ?? 'default').replace(/[^\w.-]/g, '_')
    if (!existsSync(dirname(this.cfg.logFile))) mkdirSync(dirname(this.cfg.logFile), { recursive: true })
    this.bot = null
    this.sub = null
    this.connecting = null
    this.connectedAt = 0
    this.lastError = null
    this.autoReconnect = true
    this.reconnectDelay = 5000
    this.reconnecting = false
    /** 断线期（从掉线一直置到**真重连成功**）：前端据此显示"重连中…"，见 end 处理里的说明 */
    this.reconnectPending = false
    this.chat = []            // { at, kind, who, text }
    this.stopped = false
    this.lastTimeout = null
    this.abortSignal = null       // 本轮 turn 的 abort signal（工具层注入）
    this.observerTimer = null     // 世界观察器（语义事件）
    this._obs = null
    this._selfMovingAt = 0        // 我们自己发起移动的时刻（排除"被传送"误判）
    this.stats = { connects: 0, deaths: 0, chats: 0, lastEventAt: 0, timeouts: 0 }
  }

  /**
   * 在线 = **有身体** 且 **连接还活着**。
   *
   * 🔴 2026-09-19「幽灵在线」（别人反馈，本地复现）：被踢之后 mineflayer 的 `bot.entity` **还在**，
   *    只看 entity 就会把死连接报成"在线" ⇒ 工具对着死 socket 干等（世界时间冻结、`/list` 零回应）、
   *    用户以为还在游戏里。socket 已结束（`_client.ended`）就不算在线。
   */
  get online () { return Boolean(this.bot?.entity) && this.bot?._client?.ended !== true }
  /** 当前位置（纯对象，绝不返回 Vec3） */
  get position () {
    const p = this.bot?.entity?.position
    if (!p) return null
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
  }

  /** 日志短标签：多会话共用一份日志时，至少能看出是哪只机器人（2026-10-06） */
  get logTag () {
    const n = this.cfg?.auth?.name
    return n ? ` ${String(n).slice(0, 12)}` : ''
  }

  log (...args) {
    const line = `[dsh-mc-agent ${stamp()}${this.logTag}] ${args.join(' ')}`
    this.emit('log', line)
    appendLog(this.cfg.logFile, line)
  }

  /** 只在 `MC_LOG_LEVEL=debug` 落盘（噪声行的归属地） */
  logDebug (...args) { if (logLevel() >= LOG_LEVELS.debug) this.log(...args) }

  /** 整个进程只落盘一次（`globalThis` 判重：每个连接是新的模块实例） */
  logOnce (key, ...args) {
    const g = (globalThis.__dshMcAgentLogged ??= new Set())
    if (g.has(key)) return false
    g.add(key)
    this.log(...args)
    return true
  }

  /**
   * 🔴🔴 **唯一的错误上报口**（2026-09-18 P0：连一个不存在的服务器 → 整个 DSH 崩）。
   *
   * 事故现场（用户实测）：
   *   `Error: connect ECONNREFUSED 127.0.0.1:61631`
   *   `Emitted 'error' event on McBot instance at: core.mjs:671`
   *   `node:events:486  throw er; // Unhandled 'error' event`  ⇒ **进程直接死**
   *
   * 根因：`McBot extends EventEmitter`，而 **EventEmitter 的语义是"emit('error') 时若没有监听者就 throw"**。
   *   原来那行 `b.on('error', (e) => this.emit('error', e))` 把 bot 的网络错误转发到 McBot，
   *   而 McBot 通常**没有 'error' 监听者**（工具是 await 抛错返回、不订阅 error）
   *   ⇒ 一个"服务器没开"的普通错误把整个宿主带走。
   *   更早那处（认证阶段）虽然是 `try { this.emit('error', err) } catch {}`，
   *   但 **try/catch 对 emit 自抛无效**（它就是抛出来的那个异常）—— 假保护。
   *
   * 现在的规矩：**任何错误都先进这里**，它保证
   *   ① 记 `lastError`（工具层据此给出人话）；
   *   ② 记一行日志（能被 `mc_diag` / 日志看到）；
   *   ③ **只在真有监听者时才 emit**（数量用 `listenerCount` 判断）—— 没人听就到此为止，绝不 throw；
   *   ④ 自己再兜一层 try/catch（监听者回调里抛错也不该带走进程）。
   * @param {unknown} e - 原始错误（socket / 认证 / 被踢…）
   * @returns {Error} 归一化后的错误（调用方想用就用）
   */
  #reportError (e) {
    const err = e instanceof Error ? e : new Error(String(e?.message ?? e ?? '未知错误'))
    if (err.message) this.lastError = err.message
    try { this.log(`连接/运行错误：${err.message}`) } catch { /* 日志失败不致命 */ }
    try {
      if (this.listenerCount('error') > 0) this.emit('error', err)
    } catch (inner) {
      try { this.log(`error 监听者自身抛错（已吞掉，不影响进程）：${inner?.message ?? inner}`) } catch {}
    }
    return err
  }

  /**
   * 所有直接打给 mineflayer 的 await 都必须过这里。
   * 双重保险：① 监听本轮 turn 的 abort signal（用户按停止 → 立即结算）
   *          ② 本地 deadline（服务端不回 ack → 到点结算）
   * 任一触发都：记 stats/lastTimeout → 松控制位（防"一直按住"跑飞）→ 抛错让工具正常返回。
   * 这样 execute **必然结算**，turn 就不会永久卡在"生成中"。
   */
  #t (promise, kind, label = kind) {
    const want = Number(this.cfg.timeouts?.[kind] ?? TIMEOUTS[kind] ?? 10_000) || 10_000
    // 🔴 上限两道：① 单次操作自己的超时；② 本轮工具调用的 11 秒 + 剩余时间
    const ms = Math.max(0, Math.min(want, CALL_MS, this.msLeft()))
    if (ms <= 0) {
      this.stats.timeouts++
      this.lastTimeout = { kind, label, at: Date.now(), aborted: false, overCall: true }
      this.#releaseControls()
      return Promise.reject(Object.assign(
        new Error(`${label}：这一轮的 ${Math.round(CALL_MS / 1000)} 秒用完了，先返回`
          + '（剩下的下次再叫一次接着做）'),
        { mcTimeout: true, mcCallOver: true }))
    }
    const raced = raceAbort(promise, this.abortSignal, label)
    return withTimeout(raced, ms, label).catch((e) => {
      if (e?.mcTimeout || e?.mcAborted) {
        this.stats.timeouts++
        this.lastTimeout = { kind, label, at: Date.now(), aborted: Boolean(e.mcAborted) }
        this.#releaseControls()
        // 文案（2026-10-06）：`ms` 是"这一轮还剩多少预算"，不是这个操作自己的超时值 ——
        // 到点打"超时（323ms）"看着像"323ms 就超时了"，其实是这一轮的 11 秒用完了。
        const over = this.msLeft() <= 400
        this.log(`⚠️ ${label} ${e.mcAborted
          ? '被用户中断'
          : over ? `这一轮的时间用完了（还剩 ${ms}ms）` : `超时（${ms}ms）`} → 已松控制位，标记为可能失步`)
      }
      throw e
    })
  }

  /**
   * 标记"本轮工具调用"的截止时刻。`asTool` 每次 execute 前调一次。
   * 长动作（走远路 / 挖一片 / 搭一片 / 连串步骤）靠 `msLeft()` 到点就带着进度返回，
   * 而不是把这一次调用挂住几分钟（用户要求：一次别挂太久，宁可少量多次）。
   */
  setCallDeadline (ms = CALL_MS) {
    // 🔴 别写 `Number(ms) || CALL_MS`：`setCallDeadline(0)` 的意思是"这一轮已经没时间了"，
    //    写成 `||` 会反过来**再给一整轮**（和 `msLeft() || CALL_BUDGET_MS` 是同一类坑）。
    const n = Number(ms)
    this.callDeadlineAt = Date.now() + (Number.isFinite(n) && n >= 0 ? n : CALL_MS)
    return this.callDeadlineAt
  }

  /** 距离本轮截止还剩多少毫秒；没设过（脚本直接调 McBot）就当作整整一轮 */
  msLeft () {
    const at = Number(this.callDeadlineAt)
    if (!Number.isFinite(at) || at <= 0) return CALL_MS
    return Math.max(0, at - Date.now())
  }

  /**
   * 本轮**还能给一个动作**多少毫秒：`min(一整轮 11 秒, 本轮剩余)`。
   * 长动作（挖一片 / 搭一片）自己排 deadline 时用它 —— 别直接 `Date.now() + CALL_MS`，
   * 那样在 `mc_sequence` 里"走 10 秒再搭"会变成 10+11=21 秒（超过 11 秒上限）。
   */
  callLeft () {
    return Math.max(0, Math.min(CALL_MS, this.msLeft()))
  }

  /**
   * 移动的"当前归属者"编号。
   *
   * 🔴 为什么需要（2026-10-06 实机，用户原话「刚刚遇到怪了，但是他动了一下不动了，
   *    应该是 move 的时候冲突了」）：
   *   自主层被怪贴上时会自己逃（`mc_auto` 的 avoid），而 AI 那一轮可能正在 `mc_move`
   *   或 `mc_dig`。两份移动同时占着**同一个** `bot.pathfinder`，而 `#walkPathfinder`
   *   的 `finally` 原来是**无条件**停 pathfinder + 松控制位的 —— 先结束的那一份会把
   *   另一份一起停掉：动一下就僵住，之后谁都不动。
   *   现在每次移动开始时领一个号，收尾时只有"号还是最新的"才允许动 pathfinder / 控制位。
   */
  _moveGen = 0

  /** 领一个新的移动号（旧号的那次走路收尾从此失效） */
  #beginMove () { return ++this._moveGen }

  /**
   * 抢占：立刻停下"正在走的 / 正在挖着走的"，好让安全反射（旁边有怪，先跑）重新开始移动。
   *
   * 被抢占的那次 `walkTo` 会如实返回 `reason:"preempted"`（hint 里写明是自保打断、不是走不通），
   * 调用方按 hint 再叫一次就能接着走。**谁都不动、物理冻住**那种情况不会再出现。
   */
  async interruptMove (reason = '') {
    const b = this.bot
    this._moveGen++                                    // 在飞的那次走路从此不许再碰控制位
    try { this.#stopPathing(b) } catch {}
    try { await this.#cancelCollect(b) } catch {}       // 采集任务也按着 forward，一起停掉
    this.#releaseControls()
    if (reason) this.log(`已打断当前移动：${reason}`)
    return true
  }

  /**
   * 真停 pathfinder。
   *
   * 🔴 `bot.pathfinder.stop()` **只是置一个标志**（vendor `index.js:162-164` `stop = () => { stopPathing = true }`）：
   *    它不清路、不松控制位、也不 `stopDigging()`。而 `monitorMovement` 每 tick 都跑，整个函数里
   *    **唯一**读这个标志的地方是"到达下一节点"分支（`index.js:579-585`）—— 在那之前它照旧
   *    `bot.look()`（`:607`）、`setControlState('forward', true)`（`:608`）；**挖路分支在到达检查之前、
   *    完全不看标志**（`:483-511`）⇒ 我们叫停之后，如果下一个节点要挖方块，插件会在工具**已经返回之后**
   *    才开始挖一整块（最坏 3.5 秒后才被 `:632-635` 的 futility 兜住）。
   *    2026-10-08 审计探针 `probe-stopflag3.cjs`：`stop()` 后空转 40 tick（≈2 秒），标志仍在。
   *
   * `setGoal(null)` 才走 `resetPath` → 真 `stop()`：清 path/stateGoal、emit `path_stop`、并 `stopDigging()`。
   * 之后**再**补一次 `stop()`（有些版本 `setGoal(null)` 早退），最后手动松控制位。
   */
  #stopPathing (b) {
    if (!b?.pathfinder) return
    try { b.pathfinder.setGoal?.(null) } catch {}
    try { b.pathfinder.stop?.() } catch {}
  }

  /**
   * 自保反射（`mc_auto`）按下的控制位租约：`{ key: 到期时刻 }`。
   *
   * 🔴 为什么需要：反射在危险脚下按 `back`（320ms）/ 在岩浆里按 `jump`（200ms）/ 溺水濒死按 `jump`（600ms），
   *    而任何一次移动收尾都会 `#releaseControls()` 把七个键全松掉 —— 实机表现是
   *    "脚边就是岩浆，走一步收尾把后退松了，机器人继续往危险里走"。反射那边没有握手，
   *    所以由这边**声明租约**：没到期的键不松。
   */
  _ctrlLease = new Map()

  /**
   * 反射层专用：按住一个控制位一小会儿，并声明租约（`#releaseControls` 会跳过没过期的键）。
   * @returns {number} 到期时刻（ms epoch）
   */
  holdControl (key, ms = 300) {
    const k = String(key)
    const span = Math.max(0, Number(ms) || 0)
    const until = Date.now() + span
    try { this._ctrlLease.set(k, until) } catch {}
    try { this.bot?.setControlState?.(k, true) } catch {}
    const t = setTimeout(() => {
      try {
        if ((this._ctrlLease.get(k) ?? 0) > Date.now()) return   // 又被续租了
        this._ctrlLease.delete(k)
        this.bot?.setControlState?.(k, false)
      } catch {}
    }, span + 20)
    try { t.unref?.() } catch {}
    return until
  }

  /** 松掉所有控制位（超时/中断后必做，否则"一直按住前进"会跑飞）—— 但跳过反射的租约 */
  #releaseControls () {
    try {
      const now = Date.now()
      for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']) {
        const until = this._ctrlLease.get(k) ?? 0
        if (until > now) continue                 // 自保反射正按着（没到期），别抢
        if (until) this._ctrlLease.delete(k)
        this.bot?.setControlState?.(k, false)
      }
    } catch {}
  }

  /** mineflayer-collectblock 现在还有任务在跑吗（`targets` 是它自己的 Targets 实例） */
  #collectBusy (b) {
    try { return Boolean(b?.collectBlock?.targets && !b.collectBlock.targets.empty) } catch { return false }
  }

  /**
   * 停掉还在后台跑的 mineflayer-collectblock 任务，并松掉控制位。
   *
   * 🔴 为什么必须做（2026-10-06 实机定位，用户原话「现在机器人走不了了」）：
   *   `dig()` 用 `withTimeout` 给 collectBlock 设了 90 秒上限，但 **`withTimeout` 只是让
   *   await 提前 reject，并不会取消底层的 collect 任务**。超时后那个任务继续在后台跑：
   *   它自己按着 `forward`、占着 pathfinder 反复寻路，于是机器人"物理冻住"——
   *   `mc_diag` 里 `controlState.forward === true` 而 `velocity` 全 0、位置一格不动，
   *   之后的 `mc_move` 也全部失败（15 秒只挪 0.03 格），**只有重连才恢复**。
   *
   *   `collectBlock.cancelTask()` 内部就是 `bot.pathfinder.stop()` + 等
   *   `collectBlock_finished` 事件（见 vendor 树 CollectBlock.js:238-252），
   *   正好让 `collectAll` 的 `while (!targets.empty)` 循环停下来。
   *   任务本来就已经跑完时（`targets.empty`）它会立刻返回，所以可以放心常调。
   *
   * @param {object} b mineflayer bot
   * @param {{ force?: boolean, budgetMs?: number }} [opts] force=true 时即使看起来没任务也照样调一遍；
   *        budgetMs = 这次取消最多能花多少毫秒（默认 1500，调用方用它防止整轮冲出工具超时）
   */
  async #cancelCollect (b, { force = false, budgetMs = null } = {}) {
    if (force || this.#collectBusy(b)) {
      this._moveGen++      // 采集/挖矿也算"一次移动"：别让旧的走路收尾把它一起停掉
      /* 🔴 这里的等待**必须能被调用方限住**（2026-10-08 实机反馈：
       *    `mc_dig` 报 `Error: tool call timed out after 6000ms`，而方块其实早挖掉了）。
       *    `cancelTask()` 最多等 1.5 秒，这段等待以前**不计入**任何预算 —— 挖 2 个目标就是
       *    2×(单个目标预算 + 1.5s) ⇒ 整轮冲出 DSH 层的工具超时，模型拿到一个没有任何信息的硬错误。
       *    `budgetMs` = 调用方"距离自己该返回还剩多少毫秒"，取消动作只能花这么多。
       */
      // 🔴 `budgetMs == null` 是"没指定"（默认等满 1.5 秒）—— 别写成 `Number(budgetMs)`：
      //    `Number(null) === 0` 且 `Number.isFinite(0) === true` ⇒ 会变成"一秒都不等、直接跳过取消"。
      const cap = budgetMs == null
        ? 1500
        : (Number.isFinite(Number(budgetMs)) ? Math.max(0, Math.min(1500, Number(budgetMs))) : 1500)
      try {
        if (typeof b?.collectBlock?.cancelTask === 'function' && cap > 0) {
          // cancelTask 会一直等到 collectBlock_finished；万一它自己也卡住，cap 毫秒后放行
          await Promise.race([
            Promise.resolve(b.collectBlock.cancelTask()).catch(() => {}),
            sleep(cap),
          ])
        }
      } catch {}
      try { this.#stopPathing(b) } catch {}
      this.#releaseControls()
      /* 🔴 2026-10-08 实机（用户「挖矿还是会」那次会话的日志）：`cancelTask()` 内部是
       *    `await once(bot, 'collectBlock_finished')`，而那个事件只有 `collect()` 的 finally 才 emit。
       *    采集任务卡在 `yield bot.dig(block)` 里时（服务端不回 air 方块更新 ⇒ mineflayer 的
       *    `diggingTask` 永远不 resolve，见 `#watchServerBreak` 的注释）**事件永远不会来**
       *    ⇒ `targets` 一直非空 ⇒ 之后每次走路都只打印"上次的采集任务还在后台跑"、
       *    机器人几分钟走不了路（日志里 02:38–02:43 连打 20 次、整整 5 分钟）。
       *    这里兜底：等不到就把队列里剩下的目标清掉（vendor `Targets.clear()`），僵尸任务挡不了路。 */
      if (this.#collectBusy(b)) {
        let cleared = false
        try { b.collectBlock?.targets?.clear?.(); cleared = !this.#collectBusy(b) } catch { /* 清不掉就如实说 */ }
        this.log(cleared
          ? '⚠️ 采集任务没停下来（等不到 collectBlock_finished）—— 已清空它队列里剩下的目标，机器人可以继续走路'
          : '⚠️ 采集任务停不下来、队列也清不掉 —— 只能 mc_connect {force:true} 重连一次')
      }
    }
  }

  /**
   * 注入本轮 turn 的 abort signal（`exec.signal`）。
   * 由 index.js 的 asTool 在每次 execute 前设置——不用清：同一 turn 内所有工具
   * 共享**同一个** signal 对象，下一 turn 会被新的覆盖。
   */
  setAbortSignal (signal) {
    try { if (this._abortHook) this._abortSignal?.removeEventListener?.('abort', this._abortHook) } catch {}
    this.abortSignal = signal ?? null
    this._abortSignal = signal ?? null
    this._abortHook = null
    /* 🔴 2026-10-08 审计④：把"用户点停止"接上 `interruptMove()` —— 以前它只在各工具自己的
     *    `raceAbort` 上等（最长要等一个 `withTimeout` 走完），而 pathfinder 的 `stop()` 又只置标志。
     *    现在 signal 一 abort 就立刻真停（`setGoal(null)`）+ 松控制位，不用等下一次 await 返回。 */
    if (signal && typeof signal.addEventListener === 'function') {
      const hook = () => { try { Promise.resolve(this.interruptMove('用户中断')).catch(() => {}) } catch {} }
      this._abortHook = hook
      try { signal.addEventListener('abort', hook, { once: true }) } catch {}
    }
  }

  /* ───────────── 世界观察器（把"变化"变成语义事件，供看门狗判定唤醒）───────────── */

  /**
   * 启动观察器：每 1s 对比快照，产出 mineflayer 本身**不提供**的语义事件：
   *   'teleport'    位置瞬移（>24 格/秒）= 多半被玩家传送
   *   'pushed'      非自主移动（没按方向键却位移）= 被推/水流
   *   'pickup'      背包总数变多 = 捡到物品
   *   'playerJoin' / 'playerLeave'
   *
   * 为什么放这里而不是看门狗里：这是"世界读取"，属于机器人核心的能力；
   * 看门狗只负责"判定要不要叫醒我"，不该自己解析世界。
   */
  startObserver () {
    if (this.observerTimer) return
    this._obs = {
      lastPos: this.position,
      lastPlayers: new Set(Object.keys(this.bot?.players ?? {})),
      lastInv: this.#invSignature(),
    }
    // 🔴 回调自己兜住异常：`setInterval` 回调里抛错 = **uncaughtException** = 整个宿主进程死
    //    （宿主只对 `unhandledRejection` 做 fail-loud，这条通道它不防）。观察 tick 出错最多是少看一眼世界。
    this.observerTimer = setInterval(() => { try { this.#observeTick() } catch (e) { this.#reportError(e) } }, 1000)
    this.observerTimer.unref?.()
  }

  stopObserver () {
    if (this.observerTimer) { clearInterval(this.observerTimer); this.observerTimer = null }
    this._obs = null
  }

  #invSignature () {
    const items = this.bot?.inventory?.items?.() ?? []
    let total = 0
    const map = {}
    for (const it of items) {
      const c = it?.count ?? 0
      total += c
      map[it.name] = (map[it.name] ?? 0) + c
    }
    return { total, map }
  }

  #observeTick () {
    const b = this.bot
    if (!b?.entity || !this._obs) return
    const now = Date.now()
    const pos = this.position
    const obs = this._obs

    // ① 玩家上下线
    const players = new Set(Object.keys(b.players ?? {}))
    for (const p of players) {
      if (!obs.lastPlayers.has(p) && p !== b.username) this.emit('playerJoin', { who: p })
    }
    for (const p of obs.lastPlayers) {
      if (!players.has(p)) this.emit('playerLeave', { who: p })
    }
    obs.lastPlayers = players

    // ② 位置突变（排除我们自己飞/走造成的变化——那由 _selfMovingAt 标记）
    const selfMovedRecently = now - (this._selfMovingAt ?? 0) < 3000
    if (obs.lastPos && pos && !selfMovedRecently) {
      const d = Math.hypot(pos.x - obs.lastPos.x, pos.y - obs.lastPos.y, pos.z - obs.lastPos.z)
      const cs = b.controlState ?? {}
      const pressing = Boolean(cs.forward || cs.back || cs.left || cs.right || cs.jump)
      if (d > 24) this.emit('teleport', { from: obs.lastPos, to: pos, distance: Number(d.toFixed(1)) })
      else if (d >= 2 && !pressing) this.emit('pushed', { from: obs.lastPos, to: pos, distance: Number(d.toFixed(1)) })
    }
    obs.lastPos = pos

    // ③ 捡到物品（背包总数变多）
    const inv = this.#invSignature()
    if (inv.total > obs.lastInv.total) {
      const gained = []
      for (const [n, c] of Object.entries(inv.map)) {
        const delta = c - (obs.lastInv.map[n] ?? 0)
        if (delta > 0) gained.push(`${n}x${delta}`)
      }
      if (gained.length) this.emit('pickup', { items: gained })
    }
    obs.lastInv = inv
  }

  /* ───────────── 连接与保活 ───────────── */

  /**
   * 连接到 MC 服务器。
   *
   * 🔴 用户 2026-09-16：**凭据不再从这里传**（LLM 不得接触密码/token）。
   *    插件层先把账户解析成一个 `auth` 描述符，再交给这里：
   *      · `{ mode:'offline',   name, uuid? }`                     —— 离线（uuid 空则按名字派生）
   *      · `{ mode:'yggdrasil', authUrl, authUser, authPass?, accessToken?, clientToken? }` —— 皮肤站
   *
   * @param {Object} opts
   * @param {string} [opts.host] / [opts.port] / [opts.subserver]
   * @param {string|false} [opts.version] - 协议版本（默认 false=自动探测）
   * @param {Object} [opts.auth] - 上面的账户描述符（**唯一**的凭据入口）
   */
  async connect (opts = {}) {
    /* 🔴 2026-10-08 审计报告 F1：`#scheduleReconnect(sub)` 以前把**子服名字符串**当 opts 传进来，
     *    而下面读的是 `opts.host` / `opts.auth` ⇒ 每次自动重连都必抛"缺少登录账户…"，
     *    再被 catch 无限重试。这里兜一层老写法（`connect('lobby')` = 只指定子服）。 */
    if (typeof opts === 'string') opts = { subserver: opts }
    const host    = opts.host      || this.cfg.host      || DEFAULTS.host
    const port    = Number(opts.port ?? this.cfg.port ?? DEFAULTS.port)
    const sub     = opts.subserver || this.cfg.subserver || DEFAULTS.subserver || ''
    const version = opts.version   ?? false
    const auth    = opts.auth ?? null
    const force   = Boolean(opts.force)

    if (!host) {
      throw new Error('缺少服务器地址：需要 host（通过 mc_connect 的 host 参数或 MC_HOST 环境变量提供）')
    }
    if (!auth?.mode) {
      throw new Error('缺少登录账户：先用 mc_accounts{action:"use", innerID:"..."} 选一个账户，'
        + '或在 mc_connect 里用 account 参数指名（账户在「MC设置」里维护）')
    }

    // 记录当前生效的连接参数（给 mc_status 用，**不含任何凭据**）
    this._connectionProfile = {
      host, port, subserver: sub, version,
      authMode: auth.mode,
      account: auth.label ?? auth.name ?? null,
    }
    /* 🔴 审计报告 F1：自动重连要用的**真**参数（含 auth 对象）。只存内存、绝不出现在任何工具返回里
     *    （`_connectionProfile` 才是给外部看的脱敏版）。 */
    this._connectOpts = { host, port, subserver: sub, version, auth }

    /* 🔴 已经连着时 `mc_connect` 是**空操作**（下面那行 return）—— 所以以前"重连一下"
     * 根本不会重连，客户端的区块缓存 / 实体视图还是旧的（实机表现：挖着挖着就说"那里本来就是空气"）。
     * `force:true` 才是真重连：先断开旧连接、让服务端放掉会话，再连一次（世界与实体全部重收）。
     */
    if (force && this.bot) {
      const old = this.bot
      this.log('强制重连：先断开旧连接')
      this.autoReconnect = false          // 别让旧连接的 end 事件又触发一次自动重连
      try { old.quit() } catch { /* 已经断了就算了 */ }
      this.bot = null
      this.reconnecting = false
      this.reconnectPending = false
      await sleep(600)                    // 服务端放掉旧会话要几秒，太急会被"已连接"顶号
    }
    if (!force && this.online && this.sub === sub && this._lastHost === host) return this.bot
    if (this.connecting) { await this.connecting.catch(() => {}); if (this.online) return this.bot }

    const attemptOnce = async (attempt) => {
      // 账户 → session（离线自己造；皮肤站 token 优先刷新）。凭据只在这一层出现。
      const session = await this.#makeSession(auth)
      // 让插件层有机会把新令牌/档案信息回写到凭据库（回调收到的是含密钥的 session，**只给插件层**）
      try { if (typeof opts.onAuth === 'function') opts.onAuth({ mode: auth.mode, profile: session.selectedProfile, session }) } catch (e) { this.log('onAuth 回调出错：' + e.message) }
      const profile = session.selectedProfile
      const uuid = dashUuid(profile.id) ?? profile.id
      const previous = this.bot

      const b = mineflayer.createBot({
        host,
        port,
        username: profile.name,
        fakeHost: sub || undefined,           // Velocity 按 forced-host 路由子服；空串不传
        // 皮肤站才需要 sessionServer；离线自己造 session，不碰认证服
        ...(auth.mode === 'yggdrasil' ? { sessionServer: `${auth.authUrl}/sessionserver` } : {}),
        accessToken: session.accessToken,
        version,                              // false = 自动探测
        auth: (client, options) => {
          client.session = session
          client.uuid = uuid
          client.username = profile.name
          client.emit('session', session)
          // 🔴 只有**皮肤站**（有真凭据）才 haveCredentials=true；离线账户必须 false，
          //    否则 encrypt.js 会拿假 token 去 sessionserver 做 session join → ForbiddenOperationException
          //    → 悬空拒绝 → 宿主 fail-loud exit(1)（2026-09-17 真炸过，见 .agent-docs）
          const flags = sessionFlags(auth.mode)
          options.haveCredentials = flags.haveCredentials
          if (flags.useAccessToken) {
            options.accessToken = session.accessToken
            options.session = session
          }
          // ⚠️ 必须显式调用；而且**必须接住它的 rejection**：
          //    皮肤站的 session join 失败（令牌失效）会从这里冒出来，
          //    不接住就是"未处理的 Promise 拒绝"→ 宿主的 fail-loud 直接 exit(1)（2026-09-17 真炸过）。
          const p = options.connect(client)
          if (p && typeof p.catch === 'function') {
            p.catch((e) => {
              const err = friendlyAuthError(e)
              this.autoReconnect = false            // 认证失败重连多少次都一样，别刷屏
              // 🔴 走统一上报口：老写法是 `this.emit('error', err)` 包在 try/catch 里 ——
              //    **emit 无监听者时自己就 throw，try/catch 拦不住同一次 emit 抛出的异常**
              //    （2026-09-17 那次"未处理拒绝把 DSH 干掉"是同一族，这里再堵死一遍）。
              this.#reportError(err)
            })
          }
        },
      })
      b._createdAt = Date.now()

      let dupe = false
      b.on('error', (e) => { this.#reportError(e) })
      b.on('kicked', (r) => {
        const text = typeof r === 'string' ? r : JSON.stringify(r)
        this.lastError = `被踢: ${text.slice(0, 300)}`
        // 「已连接」类顶号错误短时间重试（服务器放掉旧会话要几秒）
        if (/already connected|already logged/i.test(text) && Date.now() - b._createdAt < 9000) dupe = true
        else this.autoReconnect = false
        this.log(this.lastError)
      })
      b.on('end', (r) => {
        const why = this.lastError ?? '连接结束'
        // 🔴 2026-09-19：断线必须**主动播报**（AI 与前端都要马上知道），不能等下一次工具调用才发现。
        //    以前这里只写日志：于是"被踢之后 mc_status 还说在线、看门狗还挂着、AI 以为还在游戏里"。
        const willReconnect = Boolean(this.autoReconnect && this.bot === b && !this.stopped)
        // 主动下线时不再打这行：`disconnect()` 会打 `已下线：…`，原来两行成对、纯重复（2026-10-06）
        if (!this.stopped) this.log('连接结束', r ?? '')
        // 「断线期」标记：一直置到**真重连成功**为止。
        // why：`reconnecting` 只在"两次尝试之间的等待窗口"为真，一旦开始尝试连接（最长 45s）它就变 false——
        //      只看它的话，状态条在那 45 秒里会从"重连中…"退回"未上线"，看着像插件放弃了。
        if (willReconnect) this.reconnectPending = true
        this.emit('offline', { sub, reason: why, willReconnect, at: Date.now() })
        if (willReconnect) this.#scheduleReconnect(sub)
      })
      b.on('death', () => { this.stats.deaths++; this.emit('death', { position: this.position }) })
      b.on('health', () => {
        if (b.health !== undefined && b.health <= 6) this.emit('damage', { health: b.health, position: this.position })
      })
      this.wireChatEvents(b)

      try {
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error(`连接 ${sub} 超时`)), this.cfg.connectTimeoutMs)
          b.once('spawn', () => { clearTimeout(t); resolve() })
          b.once('kicked', (r) => { clearTimeout(t); reject(new Error(`被踢: ${String(r).slice(0, 200)}`)) })
        })
      } catch (e) {
        try { b.quit() } catch {}
        if (dupe && attempt < 4) {
          this.log(`顶号冲突，3.5s 后重试（第 ${attempt} 次）`)
          await sleep(3500)
          return attemptOnce(attempt + 1)
        }
        if (previous?.entity) { this.bot = previous; this.log('新连接失败，保留原有连接') }
        // 认证/入服失败（令牌失效等）：转成"需要用户处理"的明确错误；
        // 顺便把 yggdrasil 兼容层记下的那个 session-join 失败也捞出来当原因。
        const joinErr = takeAuthJoinError()
        throw friendlyAuthError(joinErr ?? e)
      }

      if (previous && previous !== b) { try { previous.quit() } catch {} }
      this.bot = b
      this.sub = sub
      this._lastHost = host          // ⚠️ 必须记：否则上面的"已连着就直接返回"永不生效，
                                     //    重复 mc_connect 会真去重连（先把自己踢下线再登回来）
      this.connectedAt = Date.now()
      this.stats.connects++
      this.autoReconnect = true
      this.reconnectPending = false      // 进来了就算"断线期"结束（手动 mc_connect 也算）
      this._reconnectTries = 0           // F1：连上了就把重试计数清零
      this.startObserver()
      // 现成的生态插件（pathfinder / collectBlock / tool / pvp / autoEat）：挂上就能用，缺哪个都不影响其它
      await this.setupPlugins().catch((e) => this.log('现成插件初始化异常：' + e.message))
      this.writeLock()
      this.log(`已进入 ${sub || '主服'} @ (${this.position?.x},${this.position?.y},${this.position?.z}) gamemode=${b.game?.gameMode}`)
      this.emit('spawn', { sub, position: this.position, gamemode: b.game?.gameMode })
      return b
    }

    this.connecting = attemptOnce(1)
    // 🔴 再挂一个 catch：调用方可能被 abort/取消而不再 await 这个 promise，
    //    那样它的 rejection 就成了"未处理拒绝"→ 宿主 fail-loud 直接 exit(1)。
    this.connecting.catch(() => {})
    try { return await this.connecting } finally { this.connecting = null }
  }

  #scheduleReconnect (sub) {
    if (this.reconnecting || this.stopped) return
    /* 🔴 2026-10-08 审计报告 F1 的两处硬伤：
     *   ① 参数错：以前 `await this.connect(sub)` 把子服名当 opts ⇒ 必抛"缺少登录账户"；
     *   ② 没有上限：catch 里 `reconnectDelay` 翻倍到 60s 后**再递归**，永远试下去。
     *    而看门狗会注入"插件正在自动重连，先别再操作角色，等重连结果" ⇒ AI 停手死等。
     *    现在：用真参数重连、记次数、试满就 emit `offline{willReconnect:false}`（看门狗会 disarm
     *    并通知 AI"你已不在 MC 里，用 mc_connect 重新进服"）。 */
    const o = this._connectOpts
    const max = Math.max(1, Number(this.cfg.maxReconnectAttempts ?? DEFAULTS.maxReconnectAttempts))
    if (!o?.auth?.mode) {
      this.reconnectPending = false
      this.log('不再自动重连：没有记下可用的登录参数')
      setImmediate(() => this.emit('offline', {
        sub, reason: '自动重连没有可用的登录参数（没记下 account/auth）', willReconnect: false, at: Date.now(),
      }))
      return
    }
    this.reconnecting = true
    const tries = (this._reconnectTries = Number(this._reconnectTries ?? 0) + 1)
    this.log(`断线，${this.reconnectDelay / 1000}s 后重连 ${sub || '主服'}（第 ${tries}/${max} 次）`)
    setTimeout(async () => {
      this.reconnecting = false
      try {
        await this.connect({ ...o, subserver: sub || o.subserver })
        this.reconnectDelay = 5000
        this._reconnectTries = 0
        // 真回来了才算"断线期"结束（前端/状态据此从"重连中…"切回"在游戏中"）
        this.reconnectPending = false
        this.emit('reconnect', { sub })
      } catch (e) {
        this.log('重连失败：' + e.message)
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000)
        if (tries >= max) {
          this.reconnectPending = false
          this.log(`自动重连放弃（连续 ${tries} 次没连上）—— 让 AI 自己 mc_connect`)
          this.emit('offline', {
            sub, reason: `自动重连失败 ${tries} 次（${e.message}）`, willReconnect: false, at: Date.now(),
          })
          return
        }
        this.#scheduleReconnect(sub)
      }
    }, this.reconnectDelay).unref?.()
  }

  /**
   * 下线。**先优雅退出，真走不掉才强断**（用户 2026-09-16 要求："一定要先尝试退出游戏"）。
   *
   *   ① 先关掉自动重连 / 世界观察器 —— 否则退服事件会把看门狗又吵醒
   *   ② `bot.quit(reason)` 发正常的断开包，给它 graceMs（默认 3s）自己走完
   *   ③ 还没走掉才 `_client.end()` 强断（兜底，不允许吊死）
   *
   * ⚠️ 宽限计时器**故意不 unref**：我们就是"在等"，unref 掉会让"只有它在跑"时进程直接退出。
   * @returns {Promise<{graceful:boolean, forced:boolean, ms:number}>}
   */
  async disconnect (reason = '主动下线', { graceMs = 3000 } = {}) {
    const t0 = Date.now()
    this.stopped = true
    this.autoReconnect = false
    this.stopObserver()

    const b = this.bot
    let graceful = false
    let forced = false

    if (b) {
      // 等它自己走完（end / kicked 任一即算走掉；到点还没走就强断）
      let sawEnd = false
      let timer = null
      const settled = new Promise((resolve) => {
        let done = false
        const finish = (byEvent) => {
          if (done) return
          done = true
          if (byEvent) sawEnd = true
          if (timer) clearTimeout(timer)
          resolve()
        }
        try { b.once('end', () => finish(true)) } catch {}
        try { b.once('kicked', () => finish(true)) } catch {}
        timer = setTimeout(() => finish(false), graceMs)
      })
      try { b.quit(reason) } catch { /* quit 本身失败 → 直接进强断 */ }
      await settled
      graceful = sawEnd || this.bot !== b || !this.online
      if (!graceful) {
        try { b._client?.end?.(reason); forced = true } catch {}
      }
    }

    this.releaseLock()
    this.bot = null
    const ms = Date.now() - t0
    this.log(`已下线：${reason}（${graceful ? '优雅退出' : forced ? '强制断开' : '本来就没连接'}，${ms}ms）`)
    return { graceful, forced, ms }
  }

  /**
   * 只做认证、**不连服**（给「刷新账户」用）。
   * 🔴 返回值**脱敏**：只有名字/uuid/有没有令牌，绝不含 accessToken。
   * 需要持久化新令牌的调用方，用 `onSession` 回调拿（那个 session 只活在插件层）。
   */
  async authOnly (auth, { onSession = null } = {}) {
    const session = await this.#makeSession(auth)
    try { if (typeof onSession === 'function') onSession(session) } catch { /* 回调出错不影响结果 */ }
    const p = session.selectedProfile ?? {}
    return { ok: true, name: p.name ?? null, uuid: dashUuid(p.id), hasToken: Boolean(session.accessToken) }
  }

  /**
   * 账户描述符 → mineflayer 能用的 session。
   *
   *   · `offline`：**自己造** session —— 这样才能支持"自定义 UUID"；
   *     不传 uuid 就按 `OfflinePlayer:<name>` 派生（与官方离线服务器一致）。
   *   · `yggdrasil`（皮肤站）：先拿缓存 accessToken 走 `refresh`（避免每次都用密码），
   *     刷新失败且存了密码才 `authenticate`；两样都没有就报"需要用户处理"。
   *
   * ⚠️ 这里（以及 #authenticate/#refresh）是全插件**唯一**接触凭据的地方；
   *    返回值只给 mineflayer，不进工具输出、不进 HTTP 响应。
   */
  async #makeSession (auth) {
    if (auth.mode === 'offline') {
      const name = String(auth.name ?? '').trim()
      if (!name) throw new Error('离线账户缺少名字——这是插件内部 bug，请报告')
      const uuid = dashUuid(auth.uuid) ?? offlineUuid(name)
      const bare = uuid.replace(/-/g, '')
      return {
        accessToken: '0',
        clientToken: '0',
        selectedProfile: { id: bare, name },
        availableProfiles: [{ id: bare, name }],
      }
    }
    if (auth.mode !== 'yggdrasil') throw new Error(`不支持的登录方式：${auth.mode}（只有 offline / yggdrasil）`)

    const base = normalizeBaseUrl(auth.authUrl)
    if (!base) throw new Error('认证端点为空（authUrl）——这是插件内部 bug，请报告')

    if (auth.accessToken) {
      try {
        const refreshed = await this.#refresh({ authUrl: base, accessToken: auth.accessToken, clientToken: auth.clientToken })
        if (refreshed?.accessToken) return refreshed
      } catch (e) { this.log(`token 刷新失败，改用密码重新登录：${e.message}`) }
    }
    if (auth.authUser && auth.authPass) {
      return this.#authenticate({ authUrl: base, authUser: auth.authUser, authPass: auth.authPass })
    }
    const err = new Error('这个账户的登录状态已失效，而且没有保存密码')
    err.needUserAction = true
    err.hint = '请让用户在「MC设置」里重新登录这个账户（或点该账户的「刷新」手动刷一次）'
    throw err
  }

  /** 用 refreshToken 换新 accessToken（皮肤站 Yggdrasil 标准端点） */
  async #refresh ({ authUrl, accessToken, clientToken }) {
    const base = normalizeBaseUrl(authUrl)
    if (!base) throw new Error('认证端点为空（authUrl）——这是插件内部 bug，请报告')
    if (!accessToken) throw new Error('refresh 需要 accessToken')
    const res = await fetch(`${base}/authserver/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken, clientToken: clientToken ?? undefined, requestUser: true }),
    })
    if (!res.ok) {
      const e = new Error(`刷新访问令牌失败 HTTP ${res.status}`)
      if (res.status === 401 || res.status === 403) e.needUserAction = true
      throw e
    }
    const session = await res.json()
    if (!session?.selectedProfile?.name) throw new Error('刷新返回异常（没拿到档案）')
    return session
  }

  /**
   * 调 Yggdrasil 外置登录。
   *
   * 🔴 这里曾经有个真 bug（2026-09-15 真机暴露）：调用点早就改成传 `{authUrl,...}`，
   *    但本方法**签名没接参数、函数体还在读 `this.cfg.authUrl`**（配置里已清空），
   *    于是退化成 `fetch('/authserver/authenticate')` → `Failed to parse URL`。
   *    守卫检查的是调用点算出的局部变量（所以"不传凭据就报缺凭据"看起来正常），
   *    fetch 用的却是空的 cfg —— 两个来源不一致才让这个 bug 藏了这么久。
   * ⚠️ 以后改动这里务必保证：**只用参数，不读 this.cfg**。
   */
  async #authenticate ({ authUrl, authUser, authPass } = {}) {
    const base = normalizeBaseUrl(authUrl)
    if (!base) throw new Error('认证端点为空（authUrl）——这是插件内部 bug，请报告')
    if (!authUser || !authPass) {
      const e = new Error('这个账户没有可用的密码——请在「MC设置」里重新登录它')
      e.needUserAction = true
      e.hint = '让用户在「MC设置」里重新登录该账户，或点它的「刷新」'
      throw e
    }
    const res = await fetch(`${base}/authserver/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 🔴 `agent` 是 **Yggdrasil 官方协议里 authenticate 的必填字段**（authlib-injector / 官方
      //    Minecraft 客户端都会发）。我们以前没发，多数皮肤站容忍，但 **LittleSkin 的新实现
      //    `Yggdrasil Connect` 不容忍**：缺 agent 直接回 **400**（不是 401/403），
      //    症状就是"LittleSkin 账号一直显示 400 认证失败，而认证服务器那种老实现没事"。
      //    2026-09-19 实测对照（同一地址、只差这一个字段）：
      //      LittleSkin 缺 agent → 400 ｜ 带 agent（假账号）→ 403（正常走完校验）
      //      认证服务器       缺 agent → 403 ｜ 带 agent         → 401
      body: JSON.stringify({
        agent: { name: 'Minecraft', version: 1 },
        username: authUser,
        password: authPass,
        requestUser: true,
      }),
    })
    if (!res.ok) {
      const e = new Error(`认证失败 HTTP ${res.status}`)
      if (res.status === 400) {
        // 400 基本只有两种来路：请求体不合规（最常见就是认证服要求某个字段）、或账号格式被拒。
        e.hint = '认证服拒绝了这次请求（400）。若这个皮肤站换过实现，可能是它要求的请求字段变了——把这条报给插件维护者'
      }
      if (res.status === 401 || res.status === 403) {
        e.needUserAction = true
        e.hint = '账号或密码可能已经变了——请让用户在「MC设置」里重新登录这个账户'
      }
      throw e
    }
    const session = await res.json()
    if (!session?.selectedProfile?.name) {
      const e = new Error('认证返回异常（没拿到游戏档案）')
      e.needUserAction = true
      e.hint = '让用户在「MC设置」里重新登录/手动刷新该账户'
      throw e
    }
    return session
  }

  /* ───────────── 按键上报兼容层（player_input）——已整体移除（2026-10-02 用户决策） ─────────────
   * 它原本为 26.2 而加（20Hz 上报按键位，mineflayer 不发）。移除原因：上游还连不了 26.2——
   * mineflayer 4.39.0 的 testedVersions 只到 26.1；minecraft-data 3.117.0 只收了 26.2 的
   * **元数据**、没有数据目录（`minecraft-data('26.2')` 为 null）。半吊子支持先撤，等上游真支持
   * 26.2 再重建。
   *
   * 将来重建**必须**沿用"先查后发"：protodef 对未知包名**不报错**，写出「id=0x00 + 空 body」
   * （实测字节 `02 00 00`），服务端会把 id 0x00 当成自己的 `accept_teleportation` 去读
   * teleportId —— 没有字节 ⇒ DecoderException ⇒ 秒踢（2026-09-19 只报 1.21.1 掉线的根因；
   * 现象极迷惑：进服完全成功、1 秒后掉线，错误却指向"确认传送"，详见 CHANGELOG 0.1.7）。
   * ─────────────────────────────────────────────────────────────────────────────────────── */

  /* ───────────── 单实例锁（按实例分文件：同进程多会话不能共用一把锁） ───────────── */

  /**
   * 单实例锁文件（连服时才有，断开即删）。
   *
   * 🔴 默认**不写插件包目录**（与日志同一个道理）：装进 `node_modules/` 后那可能是只读的，
   *    升级时也会被覆盖。优先用调用方给的 `lockDir`（= `$DSH_HOME/dsh-mc-agent/`），
   *    只有没给时才退回包目录（老行为，保底能用）。
   */
  get lockFile () {
    const dir = this.cfg.lockDir || HERE
    return join(dir, `.instance.${this.instanceId}.json`)
  }

  writeLock () {
    try {
      const f = this.lockFile
      if (!existsSync(dirname(f))) mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, JSON.stringify({ pid: process.pid, instanceId: this.instanceId, at: new Date().toISOString(), sub: this.sub }))
    } catch {}
  }

  releaseLock () {
    try {
      const rec = JSON.parse(readFileSync(this.lockFile, 'utf8'))
      if (Number(rec?.pid) === process.pid && rec?.instanceId === this.instanceId) unlinkSync(this.lockFile)
    } catch {}
  }

  /* ───────────── 聊天记录 ───────────── */

  /**
   * 把 mineflayer 的聊天/系统消息接到本实例的 `chat` / `system` 事件上。
   *
   * 🔴🔴 2026-09-16 真机事故（用户："喊我不应，只能 tp 我"）：
   *    以前只有 `_client.on('player_chat')`（**签名**聊天包）才 `emit('chat')`，
   *    而 `bot.on('message')`（`system_chat`，**未签名**聊天）被一律当成 system 丢掉。
   *    对**局域网开放的世界 / 离线服 / 1.19+ 关掉签名聊天**的服务器，玩家说话走的正是
   *    `system_chat` → `player_chat` 永不触发 → 看门狗的 mention / nearbySpeech **全哑**，
   *    只剩 damage / death / teleport 能用（`stats.chats === 0`、看门狗日志里一条 chat 都没有）。
   *
   * 现在按 mineflayer 的约定分流（`lib/plugins/chat.js` 里两种包的 emit 签名）：
   *    · `position === 'chat'`  → 来自 playerChat（签名）→ 由下面的 `player_chat` handler 处理，
   *      这里**直接跳过**（否则同一条进两遍）
   *    · `position === undefined`→ 来自 systemChat 的 **positionId 0 = 聊天**（未签名）
   *    · `position === 'system'` → 来自 systemChat 的 **positionId 1**：**也要按"内容"再判一次**
   *      —— 有的服务端（LAN 开放世界 / 某些插件）把玩家聊天塞进 system 位置，渲染出来仍是
   *      `<名字> 正文`。实验体 2026-09-16 的证据就是这样：事件队列里全是 `kind: system`、
   *      文本形如 `<<user>> tp我，ds。`，而看门狗只对 `chat` 判定 ⇒ mention 永远打不中。
   *    · `position === 'game_info'`（动作栏）→ 一律 system（动作栏刷屏不该唤醒）
   *    · 其余 → 系统消息
   *
   * ⚠️ 这是**公开方法**（不放在 connect 里内联）：自检要能用假 bot 走同一条代码路径 ——
   *    "喊我能不能醒"这种链路，断言必须落在真实实现上，不能只 grep 源码。
   * @param {object} b mineflayer bot（`on` + `_client`）
   */
  wireChatEvents (b) {
    b.on('message', (msg, position) => {
      const text = this.#plain(msg)
      if (position === 'chat') return                    // 签名聊天：player_chat 那条路已处理
      if (position !== 'game_info') {                    // 动作栏除外，其余都按内容再判一次
        const parsed = this.#playerChatFrom(msg, text)
        if (parsed) {
          this.#emitPlayerChat(parsed.who, parsed.text, b.username)
          return
        }
      }
      this.#pushChat('system', null, text)
      this.emit('system', { text })
    })
    b._client?.on?.('player_chat', (p) => {
      const who = String(p?.networkName?.value ?? p?.networkName ?? '?')
      const text = p?.plainMessage ?? ''
      this.#emitPlayerChat(who, text, b.username)
    })
    return b
  }

  #plain (msg) {
    try { return msg.toString().replace(/§./g, '') } catch { return String(msg) }
  }

  /**
   * 一条"玩家说话"进账（**唯一入口**：签名聊天与未签名聊天都走这里）。
   * 自带 1.5 秒去重：同一句同一人在极短时间内从两条路各来一次（理论上不会）也只发一次。
   */
  #emitPlayerChat (who, text, selfName) {
    const w = String(who ?? '?')
    const t = String(text ?? '')
    if (!t) return
    const key = `${w}\u0000${t}`
    const now = Date.now()
    if (this._lastChatKey === key && now - (this._lastChatAt ?? 0) < 1500) return
    /* 🔴 省 token：自己说的话服务端会**回显**一遍 —— `chatSay` 先记一条 `self`，回显又记一条 `player`，
     *    内容一字不差（`mc_status` 的 recentChat / `mc_events` 里就出现两条一模一样的）。
     *    自己的话只留 `self` 那条；别人说的话照旧记 `player`。 */
    if (w === selfName) {
      const last = this.chat[this.chat.length - 1]
      if (last?.kind === 'self' && last.text === t && now - last.at < 2000) return
    }
    this._lastChatKey = key
    this._lastChatAt = now
    this.#pushChat('player', w, t)
    this.stats.chats++
    this.stats.lastEventAt = now
    if (w !== selfName) this.emit('chat', { who: w, text: t })
  }

  /**
   * 从 `bot.on('message')` 收到的消息里**认出"玩家聊天"**（未签名聊天：LAN 开放世界 / 离线服 / 1.19+）。
   *
   * 判据按 translate 键（服务端给的聊天类型），只认这几种"有人在说话"的：
   *    · `chat.type.text`                    —— 普通公屏（渲染成 `<名字> 正文`）
   *    · `chat.type.team.text` / `.team.*`    —— 队伍聊天（with = [队伍, 发送者, 正文]）
   *    · `commands.message.display.incoming` —— 别人私聊我（with = [发送者, 正文]）
   * ④ 兜底看**渲染出来的形状**：`<名字> 正文`。
   *    🔴 这条是从实验体的证据里补的（2026-09-16）：有的服务端把玩家聊天发在 **system 位置**
   *    （positionId 1），translate 也可能是它自己那套；但渲染出来就是 `<<user>> tp我，ds。`。
   *    只按 positionId / translate 判的话，这类消息会永远停在 system 桶里，mention 一辈子打不中。
   *    宁可偶尔把"看起来像聊天的系统消息"算成聊天（最多多醒一次），也不能漏掉真人喊话。
   * @returns {{who:string, text:string}|null}
   */
  #playerChatFrom (msg, plain) {
    const t = String(msg?.translate ?? '')
    const withParts = Array.isArray(msg?.with) ? msg.with : []
    const partText = (p) => {
      if (p === null || p === undefined) return ''
      if (typeof p === 'string') return p
      if (typeof p.text === 'string') return p.text
      try { return String(p) } catch { return '' }
    }

    // ① 队伍聊天：who 取**发送者**（with[1]），不是队伍名
    if (/^chat\.type\.team\./.test(t)) {
      const who = partText(withParts[1] ?? withParts[0])
      const body = partText(withParts[withParts.length - 1])
      if (body) return { who: who || '?', text: body }
    }
    // ② 普通公屏
    if (t === 'chat.type.text') {
      const who = partText(withParts[0])
      const body = partText(withParts[1] ?? withParts[withParts.length - 1])
      if (body) return { who: who || '?', text: body }
    }
    // ③ 私聊（/tell、/msg）
    if (t === 'commands.message.display.incoming') {
      const who = partText(withParts[0])
      const body = partText(withParts[1] ?? withParts[withParts.length - 1])
      if (body) return { who: who || '?', text: body }
    }
    // ④ 兜底：渲染出来就是 `<名字> 正文` 的形状（有些服务端用自定义 chat type，translate 不认识）
    const m = /^\s*<([^<>]{1,32})>\s*(.+)$/s.exec(String(plain ?? ''))
    if (m) return { who: m[1].trim(), text: m[2] }
    return null
  }

  #pushChat (kind, who, text) {
    this.chat.push({ at: Date.now(), kind, who, text })
    if (this.chat.length > this.cfg.chatHistory) this.chat.splice(0, this.chat.length - this.cfg.chatHistory)
  }

  recentChat (n = 10) { return this.chat.slice(-n) }

  /* ───────────── 世界读取 ───────────── */

  async waitForChunks (timeoutMs = 20_000) {
    const b = this.bot
    if (!b?.entity) return false
    const t0 = Date.now()
    // 🔴 等区块也要算进"这一轮 11 秒"里：没区块可读时别把整次调用占满
    // 🔴 不写 `|| CALL_BUDGET_MS`：`msLeft()` 没设截止时刻时本来就返回 `CALL_MS`，
    //    而"这一轮已经用完"时它返回 0 —— `0 || 10000` 会白送 10 秒（本文件自检抓过一次）。
    //    2026-10-08 审计⑦：也不能写 `Math.max(300, …)` —— 用完时外层 max 又白送 300ms。
    const leftMs = this.msLeft()
    const cap = leftMs <= 100 ? 0 : Math.max(0, Math.min(Number(timeoutMs) || 20_000, leftMs))
    while (Date.now() - t0 < cap) {
      if (this.abortSignal?.aborted) throw abortError('等待区块', this.abortSignal)
      const p = b.entity.position.floored()
      if (b.blockAt(p.offset(0, -1, 0)) || b.blockAt(p)) return true
      await raceAbort(sleep(300), this.abortSignal, '等待区块')
    }
    return false
  }

  /**
   * 给前端 / 工具看的**连接信息**：只有地址三件套。
   *
   * 🔴 用户 2026-09-16："状态条别只写'在游戏中'，要显示服务器地址。"
   *    `_connectionProfile` 里还带着 `authMode` / `account`（账号名）—— 那是给日志与诊断用的，
   *    **不该跟着这个视图发到浏览器**，所以统一从这里出（`status()` 与 `modeView()` 共用）。
   * @returns {{host: string|null, port: number|null, subserver: string|null}|null}
   */
  connectionView () {
    const p = this._connectionProfile
    if (!p) return null
    return { host: p.host ?? null, port: p.port ?? null, subserver: p.subserver || null }
  }

  status () {
    const b = this.bot
    // 连的哪个服（用户 2026-09-16："状态条别只写'在游戏中'，要显示服务器地址"）。
    // 只回地址/端口/子服，**不含账号与凭据**；前端负责"太长就截断"。
    const connection = this.connectionView()
    // 🔴 「幽灵在线」（2026-09-19）：断线/被踢后 `bot.entity` 会残留，光看它就把死连接报成在线。
    //    连接已结束就按离线报，并明确标出 ghost，免得 AI 与用户都以为还在游戏里。
    const ended = b?._client?.ended === true
    if (!b?.entity || ended) {
      const reconnecting = Boolean(this.reconnecting || this.reconnectPending)
      return {
        online: false, sub: this.sub, connection, lastError: this.lastError,
        ...(reconnecting ? { reconnecting: true } : {}),
        ...(ended && b?.entity
          ? {
              ghost: true,
              hint: reconnecting
                ? '连接已经断了（bot.entity 是 mineflayer 的残留），插件正在自动重连——重连成功会自动告诉你'
                : '连接已经结束了（bot.entity 是 mineflayer 的残留）——要回到游戏里请重新 mc_connect',
            }
          : {}),
      }
    }
    const p = b.entity.position
    return {
      online: true, sub: this.sub, connection,
      position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
      yaw: b.entity.yaw, pitch: b.entity.pitch,
      gamemode: b.game?.gameMode, dimension: b.game?.dimension, time: b.time?.timeOfDay,
      health: b.health, food: b.food, players: Object.keys(b.players ?? {}),
      held: b.heldItem ? `${b.heldItem.name}x${b.heldItem.count}` : null,
      uptimeSec: Math.round((Date.now() - this.connectedAt) / 1000),
      inWater: this.#inWaterNow(b),
      // 氧气（0–20，20 = 满）。在水里憋气会一路掉到 0，然后开始掉血 —— 淹死就是这么来的。
      // 🔴 实机教训（2026-10-07）：**头在水面上的时候这项是 null** —— mineflayer 只在服务端
      // 发 `air_supply` 元数据时才设 `bot.oxygenLevel`，而那条元数据是头入水、气开始掉之后才来的。
      // 所以判据不能只看它：下面的 `submerged`（眼睛那一格是不是液体 = 头在水下）才是直接信号，
      // 氧气读数有就一起报、没有就照实说。
      air: Number.isFinite(b.oxygenLevel) ? b.oxygenLevel : null,
      submerged: (() => {
        try {
          /* 🔴 2026-10-08 实机：这里以前先看 `entity.isInWater` —— 而它泡在水柱里会读出
           *    undefined（实测机器人 (-31,59,261) 脚/头两格都是 water 却报"没在水里"）。
           *    头在水下就是头在水下，直接看眼睛那一格。 */
          const eye = b.entity.position.offset(0, b.entity.eyeHeight ?? 1.62, 0)
          return isLiquid(b.blockAt(eye)?.name)
        } catch { return false }
      })(),
    }
  }

  scan ({ radius = 8, height = 4, name = null, limit = 10 } = {}) {
    const b = this.requireBot()
    const R = Math.min(Math.max(radius, 1), 24)
    const H = Math.min(Math.max(height, 0), 16)
    const c = b.entity.position.floored()
    const counts = new Map()
    const found = []
    let unloaded = 0
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        for (let dy = -H; dy <= H; dy++) {
          const pos = new Vec3(c.x + dx, c.y + dy, c.z + dz)
          const blk = b.blockAt(pos)
          if (!blk) { unloaded++; continue }
          if (isAir(blk.name)) continue
          if (name) {
            if (blk.name === name) {
              /* 🔴 2026-10-08 第五份审计报告 ③：以前只 `found.push` 再 `slice(0, limit)` ——
               *    而三层循环是 `dx → dz → dy`，所以"前 N 个"全落在 x/z 最负的那个角
               *    （半径 24 时能差 30 多格）。AI 于是跑去够不着的地方挖，或据此判"附近没有"。
               *    现在带距离一起记，最后**按到我的距离升序**取前 N 个。 */
              const d = Math.hypot(pos.x + 0.5 - b.entity.position.x, pos.y + 0.5 - b.entity.position.y, pos.z + 0.5 - b.entity.position.z)
              found.push({ pos: `${pos.x},${pos.y},${pos.z}`, d: Math.round(d * 10) / 10 })
            }
          } else counts.set(blk.name, (counts.get(blk.name) ?? 0) + 1)
        }
      }
    }
    if (name) {
      found.sort((a, b2) => a.d - b2.d)
      return { found: found.slice(0, limit).map((f) => f.pos), total: found.length, unloaded, nearest: found.length ? found[0] : null }
    }
    return {
      center: { x: c.x, y: c.y, z: c.z }, radius: R, height: H, unloaded,
      counts: [...counts.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 25).map(([n, v]) => ({ name: n, count: v })),
    }
  }

  /**
   * 我是不是"在地下"（头顶 40 格内有实心遮挡，且遮挡不是树叶/竹子/雪层这类"软顶"）。
   *
   * 🔴 用户 2026-10-08 需求：**在地下时 `mc_map` 要切成"以我为中心上下 2 格"的洞穴层视图**
   *    （像地图模组的洞穴模式）。地表图在地下只能看到头顶那层岩石，完全没用。
   * 判据只用客户端自己算得出来的事实（逐格 `blockAt`），不依赖光照/元数据。
   */
  isUnderground () {
    const b = this.requireBot()
    const p = b.entity?.position
    if (!p) return false
    const x = Math.floor(p.x)
    const z = Math.floor(p.z)
    const y0 = Math.floor(p.y)
    for (let y = y0 + 2; y <= y0 + 40; y++) {
      const blk = b.blockAt(new Vec3(x, y, z))
      if (!blk) return false                       // 未加载 → 当露天（保守：地表图不会误导）
      const n = blk.name
      if (isAir(n) || isPassable(n) || SOFT_ROOF.test(String(n))) continue
      return true
    }
    return false
  }

  /**
   * 洞穴层视图的**一格**：判断这格能不能站、脚下有没有地面。返回 `{ key, name }`（key 见 `CAVE_GLYPH`）。
   *
   * 分两步 —— **先看我身体这两格（cy / cy+1）有没有被占，再看脚下**：
   * · 身体那两格里是方块 ⇒ 站不下（墙）；是矿 ⇒ `cave_ore`；是水/岩浆 ⇒ `cave_water`/`cave_lava`
   * · 身体那两格是空的 ⇒ 再看脚下 `slab` 格之内第一块地面：cy-1 = 正常走、cy-2 = 低一格、更低 = 会掉下去
   * · 脚下 `slab` 格内全是空的 ⇒ 再往下探 4 格（找到地面 = 会掉下去；找不到 = 深不见底/未加载）
   *
   * 🔴 别只看"最高的那块"：2 格高的巷道（天花板在 cy+2、地面在 cy-1）如果先看到天花板就会
   *    被误判成"会掉下去"。天花板高不高**不影响能不能站**，所以只查身体那两格。
   */
  #caveCell (b, x, cy, z, slab) {
    const bottom = cy - slab
    // ① 身体（cy / cy+1）被占了吗
    let block = null
    for (let y = cy + 1; y >= cy; y--) {
      const blk = b.blockAt(new Vec3(x, y, z))
      if (!blk) return { key: 'cave_void', name: null }
      if (isPassable(blk.name)) continue
      block = { y, name: blk.name }
      break
    }
    if (block) {
      if (isLiquid(block.name)) return { key: /lava/.test(block.name) ? 'cave_lava' : 'cave_water', name: block.name }
      if (/_ore$/.test(block.name)) return { key: 'cave_ore', name: block.name }
      return { key: 'cave_wall', name: block.name }
    }
    // ② 脚下 slab 格之内找地面
    for (let y = cy - 1; y >= bottom; y--) {
      const blk = b.blockAt(new Vec3(x, y, z))
      if (!blk) return { key: 'cave_void', name: null }
      if (isPassable(blk.name)) continue
      if (isLiquid(blk.name)) return { key: /lava/.test(blk.name) ? 'cave_lava' : 'cave_water', name: blk.name }
      if (y === cy - 1) return { key: 'cave_open', name: blk.name }
      if (y === cy - 2) return { key: 'cave_step', name: blk.name }
      return { key: 'cave_drop', name: blk.name }
    }
    // ③ slab 内脚下全是空的：再往下探 4 格（找不到就是"深不见底/大洞穴"）
    for (let y = bottom - 1; y >= bottom - 4; y--) {
      const blk = b.blockAt(new Vec3(x, y, z))
      if (!blk) return { key: 'cave_void', name: null }
      if (isPassable(blk.name)) continue
      if (isLiquid(blk.name)) return { key: /lava/.test(blk.name) ? 'cave_lava' : 'cave_water', name: blk.name }
      return { key: 'cave_drop', name: blk.name }
    }
    return { key: 'cave_void', name: null }
  }

  /**
   * 俯视地形：返回 { names（二维字符数组）, legend, center, unloaded, mode, layer? }
   *
   * `mode`：`'auto'`（默认）| `'surface'`（强制地表）| `'cave'`（强制洞穴层）。
   * `'auto'` 时由 `isUnderground()` 决定 —— **在地下自动给洞穴层视图**（用户 2026-10-08 需求）。
   * 洞穴层视图里 `names` 是 `cave_*` 合成名（`glyphOf` 把它们画成 `#·↓v~≈*?`），
   * 用 `slab` 控制上下看几格（默认 2 = 上下各 2 格，共 5 层）。
   */
  heightmap ({ radius = 32, yTop = 10, yBottom = -24, mode = 'auto', slab = 2 } = {}) {
    const b = this.requireBot()
    const R = Math.min(Math.max(radius, 4), 96)
    const cx = Math.floor(b.entity.position.x)
    const cz = Math.floor(b.entity.position.z)
    const cy = Math.floor(b.entity.position.y)
    const names = []
    const legend = new Map()
    let unloaded = 0
    /* 🔴 2026-10-08 第五份审计报告 ⑨：`heightmap`/`mapImage` 全是**同步**代码、内部没有任何
     *    `msLeft()` 检查 ⇒ radius=96 + surface 约 3.7 万格 × 最多 34 次 `blockAt`（百万级调用）
     *    会**阻塞事件循环**数秒（物理/看门狗/其它工具全停），11 秒约定形同虚设。
     *    现在给自己一个 2.5 秒的软上限：到点就停，剩下的行填 null（几何不变，标记 `truncated`）。 */
    const t0 = Date.now()
    const budgetMs = 2_500
    let truncated = false

    const cave = mode === 'cave' || (mode !== 'surface' && this.isUnderground())
    if (cave) {
      const S = Math.min(Math.max(Number(slab) || 2, 1), 8)
      for (let dz = -R; dz < R; dz++) {
        if (Date.now() - t0 > budgetMs) { truncated = true; break }
        const row = []
        for (let dx = -R; dx < R; dx++) {
          const cell = this.#caveCell(b, cx + dx, cy, cz + dz, S)
          if (cell.key === 'cave_void') unloaded++
          legend.set(cell.key, (legend.get(cell.key) ?? 0) + 1)
          row.push(cell.key)
        }
        names.push(row)
      }
      while (names.length < R * 2) names.push(new Array(R * 2).fill('cave_void'))
      return {
        center: { x: cx, y: cy, z: cz }, radius: R, unloaded, names, truncated,
        colors: names.map((row) => row.map(colorOf)),
        mode: 'cave', layer: { y: cy, slab: S },
        ...(truncated ? { note: `范围太大，只扫了前 ${names.filter((r) => r.some((c) => c !== 'cave_void')).length} 行（剩下的行是空的）—— 想看全就调小 radius` } : {}),
        legend: [...legend.entries()].sort((a, b2) => b2[1] - a[1])
          .map(([name, count]) => ({ name: CAVE_LABEL[name] ?? name, key: name, glyph: CAVE_GLYPH[name] ?? '?', count })),
      }
    }

    for (let dz = -R; dz < R; dz++) {
      if (Date.now() - t0 > budgetMs) { truncated = true; break }
      const row = []
      for (let dx = -R; dx < R; dx++) {
        let nm = null
        for (let y = cy + yTop; y >= cy + yBottom; y--) {
          const blk = b.blockAt(new Vec3(cx + dx, y, cz + dz))
          if (!blk) { nm = null; break }
          if (!isAir(blk.name)) { nm = blk.name; break }
        }
        if (nm === null) unloaded++
        legend.set(nm ?? 'unloaded', (legend.get(nm ?? 'unloaded') ?? 0) + 1)
        row.push(nm)
      }
      names.push(row)
    }
    while (names.length < R * 2) names.push(new Array(R * 2).fill(null))
    return {
      center: { x: cx, y: cy, z: cz }, radius: R, unloaded, names, mode: 'surface', truncated,
      colors: names.map((row) => row.map(colorOf)),
      ...(truncated ? { note: '范围太大，只扫了一部分（剩下的行是空的）—— 想看全就调小 radius' } : {}),
      legend: [...legend.entries()].sort((a, b2) => b2[1] - a[1]).map(([name, count]) => ({ name, count })),
    }
  }

  /** 字符地形图（无视觉也能读） */
  static glyphMap (names, step = 2, selfIndex = null) {
    const out = []
    for (let y = 0; y < names.length; y += step) {
      let line = ''
      for (let x = 0; x < names[y].length; x += step) {
        line += (selfIndex && y === selfIndex.y && x === selfIndex.x) ? '@' : glyphOf(names[y][x])
      }
      out.push(line)
    }
    return out.join('\n')
  }

  /**
   * 俯视地形 → RGBA 像素图（需求 7：视觉模型看图像比看字符强）。
   *
   * 字符图仍是默认（当前模型无视觉）；本方法给"有视觉的模型 / 要发给用户看"用。
   * 每格放大 scale 倍（最近邻），并在自己所在格画一个白框方便定位。
   *
   * @returns {{width:number,height:number,rgba:Uint8Array,center:object,radius:number,unloaded:number,legend:Array}}
   */
  mapImage ({ radius = 32, scale = 4, yTop = 10, yBottom = -24, markSelf = true, mode = 'auto', slab = 2 } = {}) {
    const hm = this.heightmap({ radius, yTop, yBottom, mode, slab })
    const h = hm.names.length
    const w = h > 0 ? hm.names[0].length : 0
    if (!w || !h) throw new Error('地形数据为空（区块可能还没加载）')

    const s = Math.min(Math.max(Number(scale) || 4, 1), 16)
    const W = w * s
    const H = h * s
    const rgba = new Uint8Array(W * H * 4)

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b] = colorOf(hm.names[y][x])
        for (let dy = 0; dy < s; dy++) {
          const rowBase = (y * s + dy) * W
          for (let dx = 0; dx < s; dx++) {
            const o = (rowBase + x * s + dx) * 4
            rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255
          }
        }
      }
    }

    // 自己：中心格画白色外框（内芯保留原色，便于看清脚下是什么）
    if (markSelf) {
      const cx = Math.floor(w / 2) * s
      const cy = Math.floor(h / 2) * s
      const put = (px, py, c) => {
        if (px < 0 || py < 0 || px >= W || py >= H) return
        const o = (py * W + px) * 4
        rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255
      }
      const white = [255, 255, 255]
      for (let d = 0; d < s; d++) {
        put(cx + d, cy, white)
        put(cx + d, cy + s - 1, white)
        put(cx, cy + d, white)
        put(cx + s - 1, cy + d, white)
      }
    }

    return {
      width: W, height: H, rgba,
      center: hm.center, radius: hm.radius, unloaded: hm.unloaded,
      legend: hm.legend.slice(0, 15),
      scale: s,
    }
  }

  /* ───────────── 行动 ───────────── */

  chatSay (text) {
    const b = this.requireBot()
    const t = String(text).replace(/[\r\n]+/g, ' ').slice(0, 220)
    /* 🔴 2026-10-08 审计：mineflayer 的 `bot.chat('/…')` 会当成**指令**发出去（走 `chat_command` 包），
     *    于是 `mc_say` 能绕过 `mc_command` 的指令白名单 —— 白名单就白设了。
     *    要执行指令一律走 mc_command（那道闸门在），别从公屏绕。 */
    if (t.startsWith('/')) {
      throw new Error('要说的话不能以 `/` 开头 —— 那样会被服务端当成**指令**执行，等于绕过指令白名单。'
        + '要执行指令请用 mc_command（只有白名单里的能用）；真想喊出斜杠就写全角 "／"')
    }
    b.chat(t)
    this.#pushChat('self', b.username, t)
    return t
  }

  /**
   * 挂上**现成的**寻路插件（mineflayer-pathfinder）。没装上只是"没有它"，其它功能照旧。
   *
   * 为什么用它：用户 2026-10-06 说"应该有写好的防卡住项目，现在它会一直跳来跳去，完全是瞎动"。
   * 手写的那套（按住前进 + 卡住就跳/挖/垫）在真机就是瞎动；pathfinder 是 A* + 自动挖/垫/绕路，
   * 自带卡住检测（3.5s 没进展 → `path_reset('stuck')`）和 noPath 判定。见文件顶部 `loadPathfinder`。
   */
  async setupPathfinder ({ spec = null } = {}) {
    const b = this.bot
    if (!b) return false
    if (this.cfg.pathfinder === false) { this.pfReady = false; return false }
    const mod = await loadPathfinder({ log: (m) => this.logDebug(m), logWarn: (m) => this.log(m), spec })
    if (!mod) {
      this.pfReady = false
      this.log('没有可用的 mineflayer-pathfinder（见 dsh-mc-agent/PATHFINDER.md）→ 所有移动已停止，避免盲跳')
      return false
    }
    try {
      if (typeof b.pathfinder?.goto !== 'function') b.loadPlugin(mod.pathfinder)
      // 想路线的预算：服务器卡顿时别想太久；搜索半径别放到无限。
      // 🔴 4000 太短了 —— 2026-10-06 实机挖树时频繁 "Took to long to decide path to goal!"，
      //    collectBlock 因此整批失败（改成逐个喂之后至少不会再一坏全坏）。8000 让"目标在高处、
      //    要垫脚才够得着"这类难想的目标有机会想出来，同时仍能及时放弃。
      b.pathfinder.thinkTimeout = Number(this.cfg.pfThinkTimeoutMs ?? 8000)
      b.pathfinder.tickTimeout = 40
      b.pathfinder.searchRadius = Number(this.cfg.pfSearchRadius ?? 192)
      this._pf = mod
      this.pfReady = true
      return true
    } catch (e) {
      this.log('pathfinder 挂载失败：' + e.message)
      this.pfReady = false
      return false
    }
  }

  /**
   * 造一份 `Movements`（走路 / 寻路 / collectBlock / pvp 共用同一套配置，
   * 免得"我走的时候不乱跳、插件走的时候乱跳"）。
   */
  #movements () {
    const b = this.bot
    const { Movements } = this._pf ?? {}
    if (typeof Movements !== 'function') return null
    const mv = new Movements(b)
    mv.canDig = this.cfg.walkCanDig !== false        // 挡路的方块可以挖穿（不然掉坑里出不来）
    mv.allowParkour = this.cfg.walkAllowParkour === true // 跳远（默认关：延迟下容易摔）
    mv.allowSprinting = true
    mv.maxDropDown = Number(this.cfg.walkMaxDropDown ?? 3)
    mv.liquidCost = 4                                // 尽量别下水
    mv.digCost = Number(this.cfg.walkDigCost ?? 4)   // 挖一格比走一格贵 → 优先绕路
    mv.dontMineUnderFallingBlock = true
    mv.scafoldingBlocks = scaffoldingItemIds(b)      // 背包里能垫的方块（**item id**，见该函数注释）
    return mv
  }

  /**
   * 把**现成的**生态插件都挂上（`MC_DEPS` 里那几个）。缺哪个只是少那项能力，其它照旧。
   *
   * 顺序有依赖：pathfinder 必须最先（collectBlock / pvp 都要用它的 `Movements`）。
   * 用户 2026-10-06 的要求："不要自己写，用现成的项目" —— 走路/挖/捡/换工具/打怪/吃饭
   * 全部交给 PrismarineJS 生态，`core.mjs` 只留编排和"诚实报错"。
   */
  async setupPlugins ({ spec = null } = {}) {
    const b = this.bot
    if (!b) return { pathfinder: false }
    const out = { pathfinder: false, collectBlock: false, tool: false, pvp: false, autoEat: false }
    // 成功细节（"找到了哪个文件"）走 debug：依赖横幅原来每个连接重打一遍，占全日志 31.5%
    const log = (m) => this.logDebug(m)
    const logWarn = (m) => this.log(m)      // 候选不可用 / 形状不对：真出问题时要看得见
    out.pathfinder = await this.setupPathfinder({ spec }).catch((e) => { this.log('pathfinder 初始化异常：' + e.message); return false })
    const mv = this.pfReady ? this.#movements() : null

    // ① 走过去挖方块 / 捡掉落物（内部自己用 mineflayer-tool 换工具）
    try {
      const fn = await loadMcDep('collectBlock', { log, logWarn })
      if (fn) {
        if (typeof b.collectBlock?.collect !== 'function') b.loadPlugin(fn)
        if (mv && b.collectBlock) b.collectBlock.movements = mv
        out.collectBlock = typeof b.collectBlock?.collect === 'function'
      }
    } catch (e) { this.log('collectBlock 挂载失败：' + e.message) }

    // ② 按方块挑最好的工具（dig 会用它）
    try {
      const fn = await loadMcDep('tool', { log, logWarn })
      if (fn) {
        if (typeof b.tool?.equipForBlock !== 'function') b.loadPlugin(fn)
        out.tool = typeof b.tool?.equipForBlock === 'function'
      }
    } catch (e) { this.log('tool 挂载失败：' + e.message) }

    // ③ 追击并打怪
    try {
      const fn = await loadMcDep('pvp', { log, logWarn })
      if (fn) {
        if (typeof b.pvp?.attack !== 'function') b.loadPlugin(fn)
        if (mv && b.pvp) b.pvp.movements = mv
        out.pvp = typeof b.pvp?.attack === 'function'
      }
    } catch (e) { this.log('pvp 挂载失败：' + e.message) }

    // ④ 饿了自动吃（**默认不开自动**：由 mc_auto 按自己的开关决定，免得两套逻辑抢）
    try {
      const fn = await loadMcDep('autoEat', { log, logWarn })
      if (fn) {
        if (!b.autoEat) b.loadPlugin(fn)
        if (b.autoEat?.setOpts) {
          b.autoEat.setOpts({
            priority: 'foodPoints',
            minHunger: Number(this.cfg.autoEatAt ?? 14),
            minHealth: 0,
            returnToLastItem: true,
            offhand: false,
            eatingTimeout: 10_000,
            strictErrors: false,
          })
        }
        b.autoEat?.disableAuto?.()
        out.autoEat = typeof b.autoEat?.eat === 'function'
      }
    } catch (e) { this.log('autoEat 挂载失败：' + e.message) }

    this.mcPlugins = out
    /* ⑤ 修 `bot.digTime`：它是**实际挖掘时长**（不是估算），而上游数据把 108 个"要石镐以上"的方块的
     *    material 写成了 `incorrect_for_wooden_tool` ⇒ 铁矿不管拿什么镐都按 4550ms 挖（真值 750ms）。
     *    见 `#fixDigMs` / `#patchDigTime` 的注释。失败不影响别的功能。 */
    try { this.#patchDigTime(b) } catch (e) { this.log('修 digTime 失败（不影响其它功能）：' + e.message) }
    const have = Object.entries(out).filter(([, v]) => v).map(([k]) => k)
    // 每个连接都会重打一遍（每个连接是新的模块实例）⇒ 进程内只留一行
    this.logOnce('deps-ready', `现成插件就绪：${have.length ? have.join(' / ') : '（一个都没有）'}`)
    return out
  }

  /**
   * 用 pathfinder 走到目标（**现成的防卡住寻路**：自己绕路、挖穿挡路的方块、垫 1×1 塔、过门）。
   *
   * 返回值保持 `arrived / moved / remaining / stuck / hint` 结构；
   * 上层 `mc_move` 和自主层直接使用；额外带 `via:"pathfinder"` 便于排查。
   */
  async #walkPathfinder (target, { arrive = 1.6, budget = this.cfg.moveBudgetMs, budgetAsked = null } = {}) {
    const b = this.bot
    const { goals, Movements } = this._pf
    const t0 = Date.now()
    const start = b.entity.position.clone()
    const at = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
    const startRemaining = Math.hypot(start.x - target.x, start.z - target.z)
    const goal = new goals.GoalNear(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z),
      Math.max(0, Math.round(arrive - 0.6)))
    const mv = this.#movements()
    if (!mv) throw new Error('pathfinder 的 Movements 造不出来（插件没挂上？）')
    // 🔴 上一次 `mc_dig` 超时可能留下一个还在后台跑的采集任务（它按着 forward、
    //    占着 pathfinder）—— 不先停掉，这次走路会和它抢控制权：实机表现是
    //    "15 秒只挪 0.03 格、reason:stuck"。见 #cancelCollect 的注释。
    if (this.#collectBusy(b)) {
      this.log('⚠️ 上次的采集任务还在后台跑（超时没停掉）—— 先停掉它再走路')
      await this.#cancelCollect(b)
    }
    const gen = this.#beginMove()      // 领号：这次走路从此是"最新的一次移动"
    b.pathfinder.setMovements(mv)
    let why = null
    let dug = 0, placed = 0
    const held0 = this.#heldText(b)
    const snap0 = this.#invSnap(b)     // 垫路会吃掉背包里的方块 —— 走完要如实报"用掉了什么、手上还剩什么"
    /**
     * 垫路/挖路的如实报告：`pillared` 只说了"垫了几块"，模型据此**不知道垫的是泥土**
     * 也不知道手上现在攥着什么（2026-10-07 实机：垫完爬出矿坑后拿着泥土去刨石头）。
     */
    const roadInfo = () => {
      if (!placed) return {}
      const used = this.#invUsed(b, snap0)
      const held = this.#heldText(b)
      return {
        ...(used.length ? { pillaredWith: used[0].name } : {}),
        ...(held !== held0 ? { held, heldBefore: held0 } : {}),
      }
    }
    let emptyNoPath = false
    const onUpdate = (r) => {
      if (r?.status && r.status !== 'success') why = r.status
      /* 🔴 2026-10-08 审计③：A* 一个邻居都生成不出来时 `path = []`，vendor 的 `lib/goto.js:22-30`
       *    对**空路径**的 noPath 分支是"无错 resolve"（只有非空路径才 reject NoPath）⇒ 我们拿到
       *    "成功"却离目标很远。旧代码据此报 `preempted`（"不是走不通"），模型于是一遍遍重发同一个
       *    到不了的点。这里把"空路径的 noPath"单独记下来。 */
      if (r?.status === 'noPath' && Array.isArray(r?.path) && r.path.length === 0) emptyNoPath = true
    }
    const onReset = (reason) => { why = reason }
    const onDig = () => { dug++ }
    const onBlock = (oldB, newB) => { if (oldB && newB && oldB.boundingBox !== 'block' && newB.boundingBox === 'block') placed++ }
    // ⚠️ 事件名要防着"假 bot"（自检里的最小物理 bot 没有 on/removeListener）
    const off = []
    const listen = (ev, fn) => { if (typeof b.on === 'function') { b.on(ev, fn); off.push([ev, fn]) } }
    listen('path_update', onUpdate); listen('path_reset', onReset)
    listen('diggingCompleted', onDig); listen('blockUpdate', onBlock)
    const work = b.pathfinder.goto(goal)
    work.catch(() => {})                             // 下面 race 可能先结束：别让它变成"未处理拒绝"（会炸宿主）
    try {
      await raceAbort(withTimeout(work, budget, '寻路'), this.abortSignal, '寻路')
      const end = b.entity.position
      const left = end.distanceTo(new Vec3(target.x, target.y, target.z))
      // ⚠️ 现成的插件报"到了"，也**自己核一遍距离**：`goal_reached` 个别情况会早一点
      //    （目标格被占住 / 站在半砖上 / 只到附近），盲信就又变成"谎报 arrived"。
      if (left > arrive + 1.0) {
        // 🔴 先分清"插件真的早报"还是"别人的 goal_reached 把我这次 goto 一起 resolve 了"。
        //    vendor 的 lib/goto.js:60 监听的是 bot 上的**全局** `goal_reached`，`goalReached()`
        //    连事件带的 goal 参数都不看 ⇒ 自主层的逃跑/跟随同时在走时，**它**到点会顺手把
        //    我这次 goto resolve 掉。实机表现（2026-10-06 打怪实测）：连续 19 次 mc_move
        //    秒返回 `moved=0` + `goal_reached-but-far`，模型被告知"插件说到了但还差 5 格"。
        //    判据：pathfinder 自己用的是 `stateGoal.isEnd(pos.floored())`（index.js:590，
        //    还允许 +1 格），**我自己的 goal 没满足 ⇒ 这次 resolve 必然来自别人的 goal**。
        const fp = typeof end?.floored === 'function' ? end.floored() : null
        const up1 = fp && typeof fp.offset === 'function' ? fp.offset(0, 1, 0) : null
        // mine === null 表示"判不了"（假 bot 的位置不是真 Vec3）⇒ 不据此下结论
        const mine = !fp || typeof goal?.isEnd !== 'function' ? null
          : Boolean(goal.isEnd(fp) || (up1 && goal.isEnd(up1)))
        if (this._moveGen !== gen) {
          return {
            arrived: false, position: at(end), ms: Date.now() - t0,
            remaining: Number(left.toFixed(2)),
            moved: Number(Math.hypot(end.x - start.x, end.z - start.z).toFixed(2)),
            via: 'pathfinder', stuck: true, reason: 'preempted',
            ...roadInfo(),
            hint: `这次走路被**另一次移动**接管了（旁边有怪时是自保反射先跑，也可能是又发了一次 mc_move）：`
              + `我从 ${startRemaining.toFixed(1)} 格挪到了 ${left.toFixed(1)} 格，但走到目标的是那一份。`
              + '等它结束，再叫一次 mc_move 往同一个目标走就行，**不是走不通**。',
          }
        }
        /* 🔴 2026-10-08 审计③：走到这里 = "goto 无错 resolve 但我没到"，两种成因**必须分开说**：
         *    · `emptyNoPath`：A* 连一个邻居都生成不出来（空路径假成功）⇒ **真没路**，再叫也没用；
         *    · `mine === false`：vendor 的 `goal_reached` 是**全局**事件（`lib/goto.js:60`），
         *      自主层的逃跑/跟随到点时会顺手把我这次 goto resolve 掉 ⇒ 只是被别人的到点顶了。
         *    旧代码两种都报 `preempted` + "不是走不通"，把"死路"说成"再叫一次就行"。 */
        if (emptyNoPath || mine === false) {
          return {
            arrived: false, position: at(end), ms: Date.now() - t0,
            remaining: Number(left.toFixed(2)),
            moved: Number(Math.hypot(end.x - start.x, end.z - start.z).toFixed(2)),
            via: 'pathfinder', stuck: true,
            reason: emptyNoPath ? 'NoPath' : 'goal-reached-elsewhere',
            ...roadInfo(),
            hint: emptyNoPath
              ? `寻路**没路可走**（被墙 / 水 / 悬崖挡住，或目标在实心方块里）：离目标还有 ${left.toFixed(1)} 格。`
                + '换个目标点，或先挖开挡路的那块方块 —— 再叫一次 mc_move 也还是走不通。'
              : `寻路插件报的"到了"**不是我这次的目标**（另一次寻路到点时顺手把我这次 goto 一起 resolve 掉了）`
                + `—— 我还在 ${left.toFixed(1)} 格外：等它结束，再叫一次 mc_move 往同一个目标走就行，**不是走不通**。`,
          }
        }
        return {
          arrived: false, position: at(end), ms: Date.now() - t0,
          remaining: Number(left.toFixed(2)),
          moved: Number(Math.hypot(end.x - start.x, end.z - start.z).toFixed(2)),
          via: 'pathfinder', stuck: true, reason: 'goal_reached-but-far',
          hint: `寻路插件说到了，但离目标还有 ${left.toFixed(1)} 格（可能被占住或只到附近）—— 再走一次，或换个目标点。`,
        }
      }
      return {
        arrived: true,
        position: at(end),
        ms: Date.now() - t0,
        moved: Number(Math.hypot(end.x - start.x, end.z - start.z).toFixed(2)),
        /* 到了也报 `remaining`（实机第 6 跑：`walkTo` 明明到了、`remaining` 却是 undefined，
         * 测试脚本只能打 `-`，看着像"谎报到达"）。 */
        remaining: Number(left.toFixed(2)),
        via: 'pathfinder',
        ...(dug ? { dug } : {}), ...(placed ? { pillared: placed } : {}), ...roadInfo(),
      }
    } catch (e) {
      if (e?.mcAborted) throw e
      const end = b.entity.position
      const moved = Number(Math.hypot(end.x - start.x, end.z - start.z).toFixed(2))
      const remaining = Number(end.distanceTo(new Vec3(target.x, target.y, target.z)).toFixed(2))
      const nm = e?.mcTimeout ? `走了 ${Math.round((Date.now() - t0) / 1000)} 秒还没到`
        : e?.name === 'NoPath' ? '寻路说**没路可走**（被墙/水/悬崖挡住，或目标在实心方块里）'
          : e?.name === 'Timeout' ? '寻路想路线超时'
            : e?.name === 'PathStopped' || e?.name === 'GoalChanged' ? '寻路被打断'
              : `寻路失败（${e?.name ?? '错误'}：${String(e?.message ?? '').slice(0, 80)}）`
      // 是"这一轮 11 秒用完了"还是"真走不通"—— 给模型的下一步完全不同。
      // 🔴 第三种情况最容易漏：`budget` 本身就被 `CALL_BUDGET_MS`（10 秒）压过 —— 走长路
      //    到点返回是**正常**的，不是死路。以前只看 `msLeft() <= 400`，DSH 把截止时刻设成
      //    一整轮时，预算到点的 `msLeft()` 还剩 ~1 秒 → 判成"真走不通"，
      //    于是模型被告知"换个目标点"，明明再叫一次就能接着走。
      const cutByCall = Boolean(e?.mcCallOver) || this.msLeft() <= 400
        || (Boolean(e?.mcTimeout) && budget <= Number(budgetAsked ?? budget) + 50)
      // 被抢占（自保反射先跑 / 又发了一次 mc_move）：编号已经不是我的了。
      // 这跟"走不通"完全是两回事 —— 必须说清楚，否则模型会以为目标不可达。
      const preempted = this._moveGen !== gen
      /* 🔴 2026-10-08 审计（会话 step 789 实机）：
       *    `{"moved":0,"remaining":2.3,...,"reason":"Error","hint":"…挪了 0 格）—— 这一轮的走路时间用完了，
       *      **不是走不通**：直接再叫一次 mc_move 往同一个目标走，会接着走。"}`
       *    —— 4 秒一格没挪，却告诉模型"不是走不通"，于是它一次次重发同一个走不到的点。
       *    判据补一条：**既没挪动、也没靠近** 就不算"时间到了"，得如实说卡住了。 */
      const noProgress = moved < 0.6 && remaining >= startRemaining - 0.3
      /* `reason` 也别把内部字符串原样透出去（旧版漏出过 `Error` / `block_updated`） */
      const REASON_TEXT = { stuck: 'stuck', block_updated: 'block-changed', goal_changed: 'goal-changed', path_stopped: 'stopped', path_reset: 'path-reset' }
      const PF_ERR = new Set(['NoPath', 'Timeout', 'PathStopped', 'GoalChanged', 'NoPathFound'])
      /* 🔴 2026-10-08 实机（熔炼验证，真服）：`why` 记的是**中途**事件（`path_reset` 在
       *    A* 重算 / 踩到方块更新 / 3.5 秒没推进时都会发），不能拿它盖过"这一轮时间用完了"
       *    这个真正结局 —— 那次跑出 `{"moved":32,"remaining":6.11,"reason":"path-reset"}`，
       *    10 秒明明正常挪了 32 格、只是预算到点，模型看到 "path-reset" 却会以为路被重置了、
       *    以为走不通。时间到点 + 有进展 ⇒ 如实报 budget/timeout。 */
      const reasonOut = preempted ? 'preempted'
        : (e?.mcTimeout && !noProgress ? (cutByCall ? 'budget' : 'timeout')
          : (why ? (REASON_TEXT[why] ?? 'path-reset') : (PF_ERR.has(String(e?.name)) ? String(e.name) : 'walk-failed')))
      return {
        arrived: false,
        position: at(end),
        ms: Date.now() - t0,
        remaining,
        moved,
        via: 'pathfinder',
        stuck: true,
        reason: reasonOut,
        ...(dug ? { dug } : {}), ...(placed ? { pillared: placed } : {}), ...roadInfo(),
        hint: `${nm}（从 ${startRemaining.toFixed(1)} 格变成 ${remaining.toFixed(1)} 格，挪了 ${moved} 格）`
           + (preempted
             ? '—— 这次走路被**另一次移动**打断了（旁边有怪时是自保反射先跑，也可能是又发了一次 mc_move）：等它结束，再叫一次 mc_move 往同一个目标走就行，**不是走不通**。'
             : noProgress && !cutByCall
               ? '—— **是真没走通**（一格没挪、也没靠近）：先 `mc_act {mode:"jump"}` 蹦一下（可能是卡在方块里 / 台阶上），再 `mc_scan` 看脚下和目标那格是什么；换个近一点的目标点通常更快。'
                    + '　要是"脚下明明没东西却还是走不动"，可能是我这边的世界和服务端对不上（客户端预测的方块缓存）——'
                    + '`mc_connect {force:true}` 重连一次刷新区块。（2026-10-08 实机见过一次"11 秒挪 0.01 格"，'
                    + '两种几何各试 4 次都没能复现，先留着这条排查建议。）'
               : cutByCall
                 ? `—— 这一轮的走路时间用完了（单次调用最多 ${budgetSecText()}），**不是走不通**：直接再叫一次 mc_move 往同一个目标走，会接着走。`
                 : noProgress
                   ? '—— 这一轮**一格没挪**（时间到了，但也没靠近）：再叫一次 mc_move 试试；两次都一样就换个目标点。'
                   : '—— 换个能走到的目标点，或先解除挡住它的方块。'),
      }
    } finally {
      for (const [ev, fn] of off) { try { b.removeListener?.(ev, fn) } catch {} }
      // 🔴 只有"我还是最新那次移动"才允许收尾（停 pathfinder + 松控制位）。
      //    被抢占时绝不能动：否则会把正在走的那一份一起停掉 —— 实机表现就是
      //    "动了一下不动了"。见 _moveGen 的注释。
      if (this._moveGen === gen) {
        // 🔴 2026-10-08 审计②：`stop()` 只是置标志 —— 必须 `setGoal(null)` 才真停
        //    （详见 #stopPathing 的注释：不然控制位会被插件按回去，甚至返回之后才开始挖方块）。
        try { this.#stopPathing(b) } catch {}
        this.#releaseControls()
      }
    }
  }

  /**
   * 在水里"直接游"到目标附近（**绕开 pathfinder**）。
   *
   * 🔴 为什么水里不能用 pathfinder：vendor 里那份 mineflayer-pathfinder 的 A* 明确
   *    拒绝把水当节点 —— `lib/movements.js:503` `if (blockC.liquid) return // dont go underwater`、
   *    `:523` 同一句、`:571` `if (this.getBlock(node,0,0,0).liquid) return // cant jump from water`；
   *    控制器在水里只会按住 jump（`index.js:611-613`）。所以"泡在水里、目标在岸上"时
   *    它要么只给一条只有一个节点的路、要么直接 NoPath，实机表现就是**"4 秒只挪 1 格"**。
   *    直接控制 `forward + jump` 实测 **2.05~2.27 格/秒**（正好等于 prismarine-physics 的
   *    水里水平极限 `liquidAcceleration/(1-waterInertia)` = 0.02/0.2 = 0.1 格/tick），快近 10 倍。
   *    水里按 jump 不是为了"跳"，是**浮在水面**游（贴底会卡、也慢）。
   *
   * 上岸就交还给 pathfinder（返回 `outOfWater: true`），别自己在地面上走 —— 地面上它比手写按键靠谱。
   */
  async #walkSwim (target, { arrive = 1.6, budget = this.cfg.moveBudgetMs } = {}) {
    const b = this.bot
    const goal = new Vec3(Number(target.x), Number(target.y), Number(target.z))
    const at = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
    const r2 = (n) => Math.round(n * 100) / 100
    if (!this.#inWaterNow(b)) {
      // 本来就在岸上（`mc_move {"mode":"swim"}` 给了坐标时可能这样）：按普通走路走
      /* 🔴 2026-10-08 第四份审计报告 ⑨：这里以前把**没按 `msLeft()` 钳过**的 `budget` 直接往下传 ——
       *    平时走不到（`walkTo` 判 `isInWater` 与这里判 `#inWaterNow` 之间没有 await，读的是同一个值），
       *    但哪天 `cfg.moveBudgetMs` 变成历史遗留的大值，`withTimeout(work, budget)` 就会是几十秒。
       *    埋着的雷，照样钳一遍（`budgetAsked` 仍留原值，供 cutByCall 判"是被本轮截断还是真走不通"）。 */
      const leftMs = this.msLeft()
      const r = await this.#walkPathfinder(goal, {
        arrive,
        budget: Math.max(0, Math.min(callBudget(budget), leftMs)),
        budgetAsked: callBudget(budget),
      })
      return { ...r, swam: false, outOfWater: true, note: '我没在水里，这条就按普通走路走' }
    }
    const t0 = Date.now()
    const start = b.entity.position.clone()
    /* 🔴 2026-10-08 审计①：这条游泳循环以前**不认中断、也不领移动号** ——
     *    已 abort 的信号 + budget 1200ms 实测照样跑满 1313ms、forward/jump 各按 5 次
     *    （同条件 `flyTo` 1ms 就抛 mcAborted）；用户点停止后机器人还在水里游，而且它的 finally
     *    会把别人正在走的那份控制位一起松掉。现在：领号 + 每轮查 abort/号，收尾也看号。 */
    const gen = this.#beginMove()
    const left0 = this.msLeft()
    const bd = left0 <= 100 ? 0 : Math.max(0, Math.min(callBudget(budget), left0))
    let moved = 0
    const preemptResult = (end) => ({
      arrived: false, position: at(end), ms: Date.now() - t0,
      remaining: r2(end.distanceTo(goal)), moved: r2(start.distanceTo(end)),
      via: 'swim', stuck: true, reason: 'preempted', outOfWater: !this.#inWaterNow(b),
      hint: '这次游泳被**另一次移动**接管了：等它结束，再叫一次 mc_move 往同一个目标游就行，**不是游不动**。',
    })
    try {
      while (Date.now() - t0 < bd) {
        if (this.abortSignal?.aborted) throw abortError('游泳', this.abortSignal)
        if (this._moveGen !== gen) return preemptResult(b.entity?.position ?? start)
        const me = b.entity.position
        const left = me.distanceTo(goal)
        moved = r2(start.distanceTo(me))
        if (left <= arrive) {
          return { arrived: true, position: at(me), ms: Date.now() - t0, moved, via: 'swim', remaining: r2(left) }
        }
        // 每 250ms 重新对准：水流、撞岸、浮起来都会把朝向推偏（只对准一次会游歪）
        try { await b.lookAt(goal.offset(0, 1.0, 0), true) } catch { /* 假 bot 没有 lookAt */ }
        b.setControlState('forward', true)
        b.setControlState('jump', true)      // 浮在水面游（不是跳）
        await raceAbort(sleep(250), this.abortSignal, '游泳')   // 可中断（用户点停止要立刻出来）
        // 已经上岸：剩下的路交给 pathfinder（地面上它更靠谱）
        if (!this.#inWaterNow(b) && b.entity?.onGround) break
      }
    } finally {
      // 只有"我还是最新那次移动"才允许松控制位（被抢占时松了会把正在走的那份一起停掉）
      if (this._moveGen === gen) this.#releaseControls()
    }
    const end = b.entity?.position ?? start
    moved = r2(start.distanceTo(end))
    const left = r2(end.distanceTo(goal))
    const outOfWater = !this.#inWaterNow(b)
    return {
      arrived: false,
      position: at(end),
      ms: Date.now() - t0,
      remaining: left,
      moved,
      via: 'swim',
      stuck: !outOfWater,
      reason: outOfWater ? 'swim-shore' : 'swim-budget',
      outOfWater,
      hint: outOfWater
        ? `已经上岸了（游了 ${moved} 格，离目标 ${left} 格）—— 再叫一次 mc_move 到同一个目标，它会自己走完。`
        : `还在水里：游了 ${moved} 格（离目标 ${left} 格）—— 再叫一次 mc_move 往同一个目标游，会接着游。`,
    }
  }

  /**
   * 通过 mineflayer-pathfinder 走到目标。
   * 这是唯一的移动实现：不再保留手写的按键、盲跳、挖方块或垫脚兜底。
   * ⚠️ 唯一的例外：**在水里**先交给 `#walkSwim`（A* 不把水当节点，见它的注释）。
   */
  async walkTo (target, { arrive = 1.6, budget = this.cfg.moveBudgetMs } = {}) {
    const b = this.requireBot()
    // 🔴 在水里：A* 不把水当节点（见 #walkSwim 的注释），实机表现是"4 秒挪 1 格"。
    //    先直接游；上了岸、还有时间，再把剩下的路交给 pathfinder 走完。
    //    ⚠️ 判据用 `#inWaterNow`：`entity.isInWater` 在泡水柱里会读出 undefined（实机踩过）。
    if (this.#inWaterNow(b)) {
      const swim = await this.#walkSwim(target, { arrive, budget })
      const canWalk = this.pfReady && typeof b.pathfinder?.goto === 'function'
      if (swim.arrived || !swim.outOfWater || !canWalk) return swim
      const left = this.msLeft()
      if (left < 500) return swim
      const rest = await this.#walkPathfinder(target, { arrive, budget: Math.max(0, Math.min(callBudget(budget), left)), budgetAsked: callBudget(budget) })
      return { ...rest, swam: true, swimMoved: swim.moved, swimMs: swim.ms }
    }
    if (!this.pfReady || typeof b.pathfinder?.goto !== 'function') {
      return {
        arrived: false,
        position: { x: Math.floor(b.entity.position.x), y: Math.floor(b.entity.position.y), z: Math.floor(b.entity.position.z) },
        remaining: Number(Math.hypot(b.entity.position.x - target.x, b.entity.position.z - target.z).toFixed(2)),
        moved: 0,
        via: 'pathfinder-unavailable',
        stuck: true,
        reason: 'PathfinderUnavailable',
        hint: 'mineflayer-pathfinder 没有加载，已停止移动，避免盲跳。请重启 DSH 并检查 dsh-mc-agent.log。',
      }
    }
    /* 🔴 2026-10-08 审计⑦：以前是 `Math.max(150, Math.min(callBudget(budget), this.msLeft()))`
     *    —— `msLeft()` 已经是 0 时，`Math.min` 给出 0，外层 `Math.max` 又把它抬回 150 ⇒ 照样再跑 150ms。
     *    本轮时间真的用完了就**别开始**，如实告诉模型"再叫一次接着走"。 */
    const leftMs = this.msLeft()
    if (leftMs <= 100) {
      return {
        arrived: false,
        position: { x: Math.floor(b.entity.position.x), y: Math.floor(b.entity.position.y), z: Math.floor(b.entity.position.z) },
        remaining: Number(Math.hypot(b.entity.position.x - target.x, b.entity.position.z - target.z).toFixed(2)),
        moved: 0,
        via: 'pathfinder',
        stuck: true,
        reason: 'call-over',
        hint: `这一轮的走路时间已经用完了（单次调用最多 ${budgetSecText()}）—— 直接再叫一次 mc_move 往同一个目标走，会接着走。`,
      }
    }
    return await this.#walkPathfinder(target, {
      arrive,
      // 🔴 单次调用 ≤11 秒：预算收进 CALL_BUDGET_MS，且不超过本轮剩余时间。
      //    走不到不是失败，是"这一轮用完了"—— 再叫一次接着走。
      //    `msLeft()` 没设截止时刻时返回 CALL_MS（11000），用完时返回 0（别再 `||` 补 10 秒）。
      budget: Math.max(0, Math.min(callBudget(budget), leftMs)),
      budgetAsked: callBudget(budget),
    })
  }

  /**
   * 飞到某个坐标（仅创造模式）。
   *
   * 🔴 **刻意不使用 mineflayer 的 `bot.creative.flyTo`** —— 它有两处硬伤，
   *    2026-09-15 真机（mc）踩得很惨，三个症状全部源于它：
   *
   *   ① 结尾是 `await once(bot, 'move', 0)` —— **timeout 传 0 = 永不超时**。
   *      服务端不回 move 回执就永久挂住。真机日志里 `飞行 超时（30000ms）` /
   *      `接近放置点 超时（30000ms）` 反复出现，就是这个。
   *      **表现特别坑**：客户端位移其实已经改了 → **动作生效了，但工具迟迟不返回、
   *      最后报超时**（用户原话："移动有时候已经生效了，但等很久工具才返回，返回的是超时"）。
   *
   *   ② 它调 `startFlying()` 把 `physics.gravity` 置 0，却**从不 `stopFlying()`**。
   *      一次失败就把机器人永久留在**零重力** → 之后 `walkTo` 完全失效
   *      （真机症状：fly 超时之后 walk 30s 原地不动）。
   *
   * 所以这里自己实现：小步推进 + **进度检测**（推不动就早停，不耗满预算）+ 预算上限，
   * 并且**无论如何在 finally 里恢复重力**。到位就返回，**不等服务端回执**。
   */
  async flyTo (x, y, z, { budget = CALL_BUDGET_MS } = {}) {
    const b = this.requireBot()
    if (b.game?.gameMode !== 'creative') throw new Error('飞行只在创造模式可用（当前 ' + b.game?.gameMode + '）')
    const target = new Vec3(Number(x), Number(y), Number(z))
    const t0 = Date.now()
    /* 🔴 单次调用 ≤11 秒（创造模式飞远路要分几次）；`msLeft()` 用完时是 0，别 `||` 补 10 秒。
     * 🔴 2026-10-08 审计⑤⑦：默认值以前是 20_000（比单次上限还大），而且调用方**不传 budgetMs** ⇒
     *    AI 写 `budgetMs:2000` 想"飞一小段"照样跑满 10 秒；`msLeft()` 用完时又被外层 max 抬回 150ms。 */
    const leftMs = this.msLeft()
    if (leftMs <= 100) throw new Error(`这一轮的 ${callSecText()}用完了（单次调用最多 ${budgetSecText()}）—— 过一会儿再叫一次 mc_move{mode:"fly"}`)
    const bd = Math.max(0, Math.min(callBudget(budget), leftMs))
    /* 🔴 2026-10-08 第四份审计报告 ⑥⑦：flyTo 以前**不领 `_moveGen` 号**（体系外的一块）——
     *    它靠直接写 `b.entity.position` 移动，不看控制位也不看 pathfinder，
     *    所以别的移动/反射层"抢占"它时它照飞；循环里的 `sleep(60)` 也没 `raceAbort`（中断最多晚 60ms）。
     *    现在领号 + 每轮查号 + 可中断 sleep + finally 只在还是自己时 `stopFlying()`。 */
    const gen = this.#beginMove()
    let preempted = false
    let last = b.entity.position.clone()
    let lastProgress = Date.now()
    this._selfMovingAt = Date.now()          // 别把自己飞当成"被传送"
    try {
      b.creative.startFlying()
      while (Date.now() - t0 < bd) {
        if (this.abortSignal?.aborted) throw abortError('飞行', this.abortSignal)
        if (this._moveGen !== gen) { preempted = true; break }
        const pos = b.entity.position
        const v = target.minus(pos)
        const mag = Math.hypot(v.x, v.y, v.z)
        if (mag <= 1.5) break
        const step = Math.min(mag, 2)
        b.physics.gravity = 0
        b.entity.velocity = new Vec3(0, 0, 0)
        b.entity.position = pos.offset((v.x / mag) * step, (v.y / mag) * step, (v.z / mag) * step)
        await raceAbort(sleep(60), this.abortSignal, '飞行')
        if (b.entity.position.distanceTo(last) > 0.3) {
          last = b.entity.position.clone()
          lastProgress = Date.now()
        } else if (Date.now() - lastProgress > 2500) {
          break                               // 推不动了（服务端可能不接受客户端位移），别耗满预算
        }
      }
    } finally {
      // 🔴 必须恢复重力：否则之后走路全废（见上面 ②）
      /* 🔴 报告⑥：只在**还是自己**的时候收飞行 —— 被接管了就别动接管者的状态。 */
      if (this._moveGen === gen) { try { b.creative.stopFlying() } catch { /* 忽略 */ } }
      this._selfMovingAt = Date.now()
    }
    const p = b.entity.position
    const distance = Number(p.distanceTo(target).toFixed(2))
    const arrived = distance <= 2.5
    return {
      position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
      distance, arrived, ms: Date.now() - t0,
      ...(preempted ? { reason: 'preempted', hint: '另一次移动把我接管了（我停了飞行）—— 再叫一次 mc_move{mode:"fly"} 往同一个点飞' } : {}),
      ...(arrived ? {} : {
        note: `没到目标（还差 ${distance} 格）。`
          + (Date.now() - t0 >= bd - 120
            ? `这一轮的 ${callSecText()}用完了（飞了 ${Math.round((Date.now() - t0) / 1000)} 秒）—— 直接再叫一次 mc_move{mode:"fly"} 往同一个点飞，会接着飞。`
            : '创造模式直飞是**客户端位移**，服务端未必接受（反作弊/延迟）——可改用 mc_move{mode:"walk"}，或挑更近的点位。'),
      }),
    }
  }

  /* ─────────── 手上的东西：动手前换对工具、动手后如实报"现在手里是什么" ─────────── */

  /** 手上那叠的短名（`dirtx18`）；空手就是 `空手` */
  #heldText (b) {
    return b?.heldItem ? `${b.heldItem.name}x${b.heldItem.count}` : '空手'
  }

  /** 背包按**名字合计**快照（走路/挖矿前后比"路上用掉了什么"） */
  #invSnap (b) {
    const m = new Map()
    try { for (const i of b.inventory?.items?.() ?? []) m.set(i.name, (m.get(i.name) ?? 0) + i.count) } catch { /* 假 bot 没有就算了 */ }
    return m
  }

  /** 相比快照少掉的东西（按少掉的数量降序） */
  #invUsed (b, snap) {
    if (!snap?.size) return []
    const now = this.#invSnap(b)
    const used = []
    for (const [name, n0] of snap) {
      const n1 = now.get(name) ?? 0
      if (n1 < n0) used.push({ name, lost: n0 - n1 })
    }
    return used.sort((a, z) => z.lost - a.lost)
  }

  /** 手上这叠现在能不能挖这块方块（`harvestTools` = {物品id:true}；没这项 = 徒手就行） */
  #canHarvestNow (b, blk) {
    if (b?.game?.gameMode === 'creative') return true
    const need = Object.keys(blk?.harvestTools ?? {})
    if (!need.length) return true
    return Boolean(b?.heldItem && blk.harvestTools[b.heldItem.type])
  }

  /** 挖它需要什么工具（人话：镐／斧／锹；minecraft-data 里是 pickaxe/axe/shovel 这种英文） */
  #toolKinds (b, blk) {
    const CN = { pickaxe: '镐', axe: '斧', shovel: '锹', hoe: '锄', shears: '剪刀', sword: '剑' }
    const kinds = [...new Set(Object.keys(blk?.harvestTools ?? {})
      .map((id) => b.registry?.items?.[id]?.name).filter(Boolean)
      .map((n) => CN[n.split('_').pop()] ?? n.split('_').pop()))]
    return kinds.length ? `需要${kinds.join('／')}` : '需要合适的工具'
  }

  /**
   * 读一个实体的血量（读不到就 null）。
   *
   * 优先用现成的 `bot.util.entity.getHealth()`（`@nxg-org/mineflayer-util-plugin`，`mc_entities` 也用这个），
   * 退到 `entity.health`。**读不到不要编**：`attack()` 靠它报"打掉多少血"，编了就等于谎报。
   */
  #entityHealth (b, e) {
    try {
      const h = Number(b?.util?.entity?.getHealth?.(e))
      if (Number.isFinite(h) && h > 0) return Math.round(h * 10) / 10
    } catch { /* 助手不可用就往下退 */ }
    const h2 = Number(e?.health)
    return Number.isFinite(h2) && h2 > 0 ? Math.round(h2 * 10) / 10 : null
  }

  /** 我现在在水里吗（脚在水的 AABB 里，或眼睛那格是水）。
   *  🔴 `bot.entity.isInWater` 在**浮在水面**时读出来是 false（prismarine-physics 入水 AABB 从底部缩了 0.401）
   *  ⇒ 两个判据都要看（2026-10-08 实机，水里游不动那次）。 */
  #inWaterNow (b) {
    try { if (b?.entity?.isInWater) return true } catch { /* 往下退 */ }
    try {
      const eye = b?._getBlockAtEyeLevel?.()?.name
      return eye === 'water' || eye === 'flowing_water'
    } catch { return false }
  }

  /** 挖得慢的现成理由（水里 / 空中各慢 5 倍）—— 用来把"时间不够"说清楚 */
  #slowDigWhy (b) {
    const parts = []
    if (this.#inWaterNow(b)) parts.push('我在水里')
    if (b?.entity?.onGround === false) parts.push('我在空中')
    return parts.length ? `（${parts.join('、')}，挖方块慢 5 倍）` : ''
  }

  /**
   * 站到地上再动手。
   *
   * 🔴 2026-10-08 实机（熔炼验证，探针定论）：`bot.dig()` 里的 `waitTime = bot.digTime(block)`，
   *    而 `prismarine-block` 的 `digTime` 有 `if (notOnGround) blockBreakingSpeed /= 5.0`
   *    ⇒ **人在空中挖方块慢 5 倍**（徒手原木 3 秒 → 15 秒）。那次机器人掉进一个 7 格深的坑，
   *    在下落途中挖原木：11 秒预算到点方块还在（`finishDigging` 都还没到点），只回一句"超时"，
   *    模型完全看不出"人在空中"。
   *    落地再挖才是正解 —— 这里最多等 `maxMs`（默认 1.2 秒，钳到 2 秒）。
   *    返回 true = 站在地上（或本来就站着），false = 还在空中。
   */
  async #waitGrounded (b, maxMs = 1_200) {
    const ent = b?.entity
    /* 只有**明确读到 `onGround === false`** 才等：假件（套件里的测试机器人）没有物理字段，
     * 不能因为读不到就把它拦下来。 */
    if (!ent || ent.onGround !== false) return true
    const cap = Math.max(0, Math.min(Number.isFinite(Number(maxMs)) ? Number(maxMs) : 1_200, 2_000))
    const t0 = Date.now()
    while (Date.now() - t0 < cap) {
      if (this.abortSignal?.aborted) throw abortError('落地')
      await sleep(80)
      if (ent.onGround !== false) return true
    }
    return ent.onGround !== false
  }

  /**
   * 捡起刚挖出来的掉落物。
   *
   * 🔴 2026-10-08 实机（熔炼验证）：`dig()` 的"够得着就原地挖"分支直接 `bot.dig()`，
   *    **绕过了 collectBlock**，而 collectBlock 平时是"挖完还会把掉落物捡回来"的
   *    ⇒ 原地挖 3 根原木，背包里只有 1 根（服务端只把身边约 1 格内的掉落物塞给你）。
   *    这里补上：找半径内最近的一两个掉落物，交给 collectBlock 去捡（没有 collectBlock
   *    就自己走过去）。捡不到不算失败 —— 别把"挖到了但没捡到"说成"没挖到"。
   */
  async #grabDrops (b, { radius = 8, budgetMs = 3_000 } = {}) {
    /* 掉落物的判据在模块级 `isDropEntity`（`#dropsNear` 共用同一份）。 */
    const me = b?.entity?.position
    if (!me) return 0
    const drops = this.#dropsNear(b, radius)
    if (!drops.length) return 0
    /* 🔴 报"捡回几个"要按**背包变化**算，不能按 `entity.isValid`：
     *    实机探针 `probe-drop.mjs` 里 `isValid` 根本来不及变 false（实体被移出 `bot.entities`
     *    的时机和我们数它的时机不重合）⇒ 明明捡到了也报 0（实机：原木 1 → 3，却一条
     *    "顺手捡回"都没有）。 */
    const invCount = () => {
      try { return (b.inventory?.items?.() ?? []).reduce((s, i) => s + (Number(i?.count) || 0), 0) } catch { return 0 }
    }
    const before = invCount()
    const t0 = Date.now()
    for (const { e } of drops) {
      const left = Math.min(budgetMs - (Date.now() - t0), this.callLeft() - 300)
      if (left < 400) break
      if (typeof b?.collectBlock?.collect === 'function') {
        try { await withTimeout(b.collectBlock.collect(e, { ignoreNoPath: true }), Math.min(left, 2_000), '捡东西') } catch {
          /* 🔴 超时/中断**不代表底层采集任务停了**：Entity 目标走的是 `GoalFollow` + `waitForPickup`，
           *    物品卡在方块里 / 走不过去时会一直挂着 ⇒ `collectBlock_finished` 不 emit
           *    ⇒ `#collectBusy` 恒真 ⇒ 之后几分钟走不了路（和挖方块那条路同一个病）。
           *    这里显式收尾：`#cancelCollect` 最多再花 300ms，收不掉它还会清空僵尸队列。 */
          try { await this.#cancelCollect(b, { budgetMs: 300 }) } catch { /* 收不掉也继续捡下一个 */ }
        }
      } else {
        try { await this.walkTo({ x: e.position.x, y: e.position.y, z: e.position.z }, { arrive: 0.8, budget: Math.min(left, 1_500) }) } catch { /* 忽略 */ }
      }
    }
    await sleep(120)          // 服务端把物品塞进背包有一点点延迟
    return Math.max(0, invCount() - before)
  }

  /**
   * 附近**还没捡**的掉落物（离我多远，近的在前）。判据与 `#grabDrops` 共用 `isDropEntity`。
   */
  #dropsNear (b, radius = 12) {
    const me = b?.entity?.position
    if (!me) return []
    return Object.values(b?.entities ?? {})
      .filter((e) => isDropEntity(e))
      .map((e) => ({ e, d: me.distanceTo(e.position) }))
      .filter((x) => Number.isFinite(x.d) && x.d <= radius)
      .sort((a, c) => a.d - c.d)
  }

  /**
   * "东西还掉在地上"的一句话（没有就返回 null）。
   *
   * why（用户 2026-10-08 原话）："挖完方块或者打完动物以后老是忘记走过去拾取" ——
   * 这是**决策**，插件替不了；但插件至少能在结果里**点一句**，让模型别把这活当成干完了。
   * 只在"没捡到东西 / 打死怪之后"调用，捡到手就不提醒（服务端把掉落物实体移出视野有延迟，
   * 刚捡完那一下它还挂在 `bot.entities` 里，提醒会变成假警报）。
   */
  #dropHint (b, { radius = 12 } = {}) {
    const drops = this.#dropsNear(b, radius)
    if (!drops.length) return null
    const d = drops[0].d
    /* 背包满的时候"走过去"是白跑：服务端不会把东西塞给你（准则「干活习惯」里那条也是这么写的）。 */
    let full = false
    try { full = b?.inventory?.emptySlotCount?.() === 0 } catch { full = false }
    return `地上还有 ${drops.length} 个掉落物没捡（最近 ${d.toFixed(1)} 格）—— `
      + '先 `mc_move` 走过去站上去，一两秒就飞进背包（掉落物几分钟就消失）'
      + (full ? '；**背包满了**：先 `mc_chest` 存一趟，或丢掉没用的' : '')
  }

  /**
   * 拿 `itemType` 挖这块要多久（ms）；算不出来返回 null。
   *
   * 走 prismarine-block 的 `block.digTime(itemType, creative, inWater, notOnGround, enchants, effects)`
   * —— mineflayer 自己的 `bot.digTime(block)` 就是拿**手上**那件这样算的（digging.js:228-256）。
   * 能直接算"换成背包里那把会快多少"，不用真换到手上试。
   */
  #digMsFor (b, blk, itemType = null) {
    try {
      if (typeof blk?.digTime !== 'function') {
        /* 兜底：只有 `bot.digTime(block)` 的环境（老 prismarine-block / 测试假件）——
         * 它只看**手上**那件，所以只有问"手上这件"的时候才敢用。
         * ⚠️ 必须走 `__wcOrigDigTime`（`#patchDigTime` 存的原函数）：`b.digTime` 已经被我们换掉了，
         *    直接调会递归。 */
        const fb = b?.__wcOrigDigTime ?? b?.digTime
        if (typeof fb === 'function' && (itemType == null || itemType === b?.heldItem?.type)) {
          const fallback = fb.call(b, blk)
          return Number.isFinite(fallback) && fallback > 0 ? Math.round(fallback) : null
        }
        return null
      }
      const creative = b?.game?.gameMode === 'creative'
      const inWater = this.#inWaterNow(b)
      /* 🔴 空中挖会慢 5 倍（`prismarine-block` 的 `if (notOnGround) blockBreakingSpeed /= 5.0`）。
       *    但**不能**直接用 `!b.entity.onGround`：`onGround` 在走路下台阶/贴着斜坡边缘时也会
       *    瞬间为 false ⇒ 实机（2026-10-08）出现过"木镐挖石头估成 5650ms"（真实只要 1125ms
       *    = 5650/5），把"其实一秒能挖掉"的方块判成"这一轮时间不够，我没开始挖"，白拒一次。
       *    ⇒ 判据取"**真在下落**"：离地 **且** 竖直速度明显为负。
       *    🔴 另一半也是实机（2026-10-08 熔炼验证）栽过的：机器人掉进 7 格深的坑、在下落途中
       *    `mc_dig oak_log` —— 真 digTime 是 3 秒 ×5 = **15 秒**，这里按站着估成 3 秒 ⇒ 放行 ⇒
       *    `bot.dig()` 挂满 11 秒预算（连 `finishDigging` 都没到点，方块还在），只回一句"超时"。
       *    正解是落地再挖（见 `#waitGrounded`）。 */
      const vY = Number(b?.entity?.velocity?.y ?? 0)
      const notOnGround = !b?.entity?.onGround && vY < -0.02
      /* 🔴 2026-10-08 第五份审计报告 ④：以前**附魔传空数组** —— 上游 `bot.digTime`（digging.js:228-256）
       *    会把**手持物品的附魔**和**头盔的附魔**（水下速掘 Aqua Affinity）都算进去。
       *    漏掉附魔 ⇒ 拿效率镐时我们估的 ms 偏大 ⇒ `breakBlock`/`dig` 会**白拒**一次本来挖得完的挖掘
       *    （"我没开始挖"）。这里补上：手上那件（只在问"手上这件"时）+ 头盔槽 5。 */
      const enchantsOf = (it) => {
        try {
          const arr = Array.isArray(it?.enchants) ? it.enchants : (it?.enchants ? Object.values(it.enchants) : [])
          return arr.filter((x) => x && typeof x.name === 'string').map((x) => ({ name: x.name, lvl: x.lvl ?? x.level ?? 1 }))
        } catch { return [] }
      }
      const held = b?.heldItem ?? null
      const sameAsHeld = Boolean(held && (itemType == null || itemType === held.type))
      const helmet = (() => { try { return b?.inventory?.slots?.[5] ?? null } catch { return null } })()
      const enchants = [...(sameAsHeld ? enchantsOf(held) : []), ...enchantsOf(helmet)]
      const ms = blk.digTime(itemType, creative, inWater, notOnGround, enchants, b?.entity?.effects ?? {})
      const fixed = this.#fixDigMs(b, blk, itemType)
      const cands = [ms, fixed].filter((x) => Number.isFinite(x) && x > 0)
      if (!cands.length) return null
      return Math.round(Math.min(...cands))
    } catch { return null }
  }

  /** 方块名/工具名 → 工具种类（`stone_pickaxe` → `pickaxe`）。认不出返回 null。 */
  #digToolKindOf (name) {
    const n = String(name ?? '')
    for (const k of ['pickaxe', 'axe', 'shovel', 'hoe', 'shears', 'sword']) {
      if (n === k || n.endsWith('_' + k)) return k
    }
    return null
  }

  /** 这把工具的"品级速度"：从 registry 里**所有** material 表里取它的最大倍率
   *  （`mineable/pickaxe` 里 stone_pickaxe=4、iron_pickaxe=6、diamond=8、netherite=9、golden=12…）。 */
  #digToolSpeedOf (reg, itemType) {
    let best = 0
    try {
      for (const t of Object.values(reg?.materials ?? {})) {
        const v = t?.[itemType]
        if (Number.isFinite(v) && v > best) best = v
      }
    } catch {}
    return best
  }

  /** 🔴 上游数据坑的兜底（2026-10-08 用户报「挖铁矿还是 4.5 秒」）：
   *
   *  `block.digTime()` 只在 `registry.materials[blk.material][itemType]` 有倍率时才把**工具速度**算进去。
   *  而 minecraft-data 1.21.9 把 **108 个"要石镐以上"的方块**（铁矿/金矿/钻石矿/红石矿/青金石矿/绿宝石矿、
   *  深板岩变种、铁块金块钻石块、黑曜石…）的 `material` 写成了 **`incorrect_for_wooden_tool`** ——
   *  那是原版的**品级门标签**（"木工具挖不动"），不是挖掘标签，那张表里**只有木工具**：
   *  `{wooden_sword:2, wooden_pickaxe:2, wooden_axe:2, wooden_shovel:2}`。
   *  ⇒ 拿石/铁/钻石/下界合金镐时查不到倍率 ⇒ `blockBreakingSpeed` 按 1 算 ⇒ **铁矿永远 4550ms**
   *  （真值：石镐 1150ms、铁镐 750ms、钻石镐 600ms）。这也是"**煤矿正常、铁矿不对**"的原因
   *  —— `coal_ore` 的 material 是正常的 `mineable/pickaxe`。
   *
   *  这里按原版公式重算一遍：速度用**这把工具在别处登记过的倍率**，判定顺序保证不会把"拿错工具"
   *  算快（例如拿石镐砍原木：`mineable/axe` 表里没有镐，且种类对不上 ⇒ 不修，仍是 3000ms）。
   *  只有"手上这把确实是这类方块该用的那种工具 + 品级够采它 + 没有效果/附魔干扰"时才出手；
   *  判定不了就返回 null（宁可不管，也不能估快 —— 估快会让服务端判"进度不够"把方块发回来）。
   */
  #fixDigMs (b, blk, itemType) {
    try {
      if (itemType == null) return null
      const reg = b?.registry
      if (!reg?.materials) return null
      if (b?.game?.gameMode === 'creative') return null
      const hardness = Number(blk?.hardness)
      if (!(hardness > 0)) return null
      // 有药水效果 / 附魔时不算（Haste、效率、水下速掘都会改速度，宁可退回上游那个保守值）
      const eff = b?.entity?.effects
      if (eff && typeof eff === 'object' && Object.keys(eff).length > 0) return null
      const have = reg.materials[blk?.material]?.[itemType]
      if (Number.isFinite(have) && have > 1) return null        // 数据没问题，上游算得对
      const heldKind = this.#digToolKindOf(reg.items?.[itemType]?.name)
      if (!heldKind) return null
      // 这类方块该用哪种工具？先看 material 名（mineable/pickaxe…），看不到再从 harvestTools 反推
      let needKind = null
      const m = String(blk?.material ?? '').match(/mineable\/(pickaxe|axe|shovel|hoe)/)
      if (m) needKind = m[1]
      else if (blk?.harvestTools) {
        for (const id of Object.keys(blk.harvestTools)) {
          const k = this.#digToolKindOf(reg.items?.[id]?.name)
          if (k) { needKind = k; break }
        }
      }
      if (!needKind || needKind !== heldKind) return null
      let can = false
      try { can = Boolean(blk.canHarvest?.(itemType)) } catch {}
      if (!can) return null                                      // 品级不够 ⇒ 上游那个慢值是对的
      const speed = this.#digToolSpeedOf(reg, itemType)
      if (!(speed > 1)) return null
      const inWater = this.#inWaterNow(b)
      const aqua = Number(b?.inventory?.slots?.[5]?.enchants?.find?.((x) => x?.name === 'aqua_affinity')?.lvl ?? 0)
      let sp = speed
      if (inWater && !aqua) sp /= 5
      const vY = Number(b?.entity?.velocity?.y ?? 0)
      if (!b?.entity?.onGround && vY < -0.02) sp /= 5
      const delta = sp / hardness / 30
      if (!(delta > 0)) return null
      return Math.ceil(1 / delta) * 50
    } catch { return null }
  }

  /** 🔴 把 `bot.digTime(block)` 换成**修过的**估值（见 `#fixDigMs`）。
   *
   *  为什么必须动它：mineflayer 的 `dig()` 拿 `waitTime = bot.digTime(block)` 当**实际挖掘时长**
   *  （`lib/plugins/digging.js:27` → `:135 setTimeout(finishDigging, waitTime)` → 才发 STOP_DESTROY_BLOCK）。
   *  也就是说这个估值不只是"估算"，它就是**机器人站着挖多久**。铁矿按上游那个 4550ms 挖，
   *  真人拿铁镐只要 750ms —— 用户看到的就是"挖铁矿还是 4.5 秒"。
   *
   *  留 8% + 60ms 余量：原版服务端按**自己的进度**判定，STOP 到早了（进度 < 阈值）会被判成"没挖掉"，
   *  并把那个方块发回来纠正客户端（就是玩家看到的"复原"）。宁可慢一点点，不能早。
   */
  #patchDigTime (b) {
    if (typeof b?.digTime !== 'function' || b.__wcDigTimePatched) return false
    const orig = b.digTime.bind(b)
    b.__wcOrigDigTime = orig
    const self = this
    b.digTime = (block) => {
      let base = null
      let baseErr = null
      try { base = orig(block) } catch (e) { baseErr = e }
      let fixed = null
      try { fixed = self.#digMsFor(b, block, b?.heldItem?.type ?? null) } catch {}
      const cands = [base, fixed].filter((x) => Number.isFinite(x) && x > 0)
      if (!cands.length) {
        if (baseErr) throw baseErr          // 上游本来会抛（例如传进来的不是方块）⇒ 照抛，别吞
        return base ?? 0                    // Infinity（挖不动的方块）照原样传下去
      }
      return Math.max(50, Math.round(Math.min(...cands) * 1.08 + 60))
    }
    try { b.__wcDigTimePatched = true } catch {}
    return true
  }

  /** 公开一层（自检脚本 / 以后重连时手动补挂用）：见 `#patchDigTime`。 */
  patchDigTime (b) { return this.#patchDigTime(b) }

  /** 背包里挖这块**最快**的那件（只考虑挖得动的；算不出时间的跳过） */
  #bestToolFor (b, blk) {
    const items = (() => { try { return b?.inventory?.items?.() ?? [] } catch { return [] } })()
    const need = Object.keys(blk?.harvestTools ?? {})
    let best = null
    for (const it of items) {
      if (need.length && !blk.harvestTools[it.type]) continue
      const ms = this.#digMsFor(b, blk, it.type)
      if (ms == null) continue
      if (!best || ms < best.ms) best = { item: it, ms }
    }
    return best
  }

  /** 结果里补一行"手上变了"（只在真变了的时候加，别每次都多花 token） */
  #withHeld (out, b, before) {
    const held = this.#heldText(b)
    if (before != null && held !== before) out.push(`手上：${before} → ${held}`)
    return out
  }

  /**
   * 动手前把对的工具拿到手上。
   *
   * 🔴 为什么必须做（2026-10-07 实机）：机器人从矿底**垫方块爬回地面后手上还攥着泥土**，
   *    接着对石头连发 6 次 `mc_act{mode:"break"}` —— 徒手挖石头要 7.5 秒，比一轮预算还长，
   *    于是每次都超时，工具还回一句"服务端可能拒了这次破坏"，模型完全看不出问题在哪，
   *    直到玩家在游戏里问「怎么用手挖方块」才反应过来。**手上工具不对 = 挖得极慢**，
   *    这件事必须由插件自己处理 + 明说，不能指望模型记得自己手里攥着什么。
   *
   * 🔴 不只"能不能挖"，还有"挖得多慢"（2026-10-08 实机反馈：玩家转来"快挖完的时候会重置"）：
   *    手上攥着**石剑**去挖原木（剑砍木头 ≈ 3 秒，石斧 ≈ 0.9 秒），一轮预算被啃掉大半，
   *    挖到八成到点松手 → **破坏进度清零**，模型看到的就是"快挖完就重置"。
   *    所以这里还会比较"换成背包里最快的工具能快多少"，快 1.4 倍以上就换。
   */
  async #equipFor (b, blk, label = '换工具') {
    const heldBefore = this.#heldText(b)
    const canNow = this.#canHarvestNow(b, blk)
    const nowMs = this.#digMsFor(b, blk, b?.heldItem?.type ?? null)
    const best = this.#bestToolFor(b, blk)
    const faster = Boolean(best && nowMs != null && best.ms < nowMs * 0.72
      && best.item?.name !== b?.heldItem?.name)
    if (canNow && !faster) return { heldBefore, held: heldBefore, changed: false }
    try {
      if (faster) {
        await this.#t(b.equip(best.item, 'hand'), 'equip', label)
      } else if (this.mcPlugins?.tool && typeof b.tool?.equipForBlock === 'function') {
        await this.#t(b.tool.equipForBlock(blk, { requireHarvest: false }), 'equip', label)
      } else {
        const pick = best?.item ?? (b.inventory?.items?.() ?? []).find((it) => blk?.harvestTools?.[it.type])
        if (pick && b.heldItem?.name !== pick.name) await this.#t(b.equip(pick, 'hand'), 'equip', label)
      }
    } catch { /* 换不上就照旧：调用方按"手上还是不对"如实拒绝 */ }
    const held = this.#heldText(b)
    return { heldBefore, held, changed: held !== heldBefore }
  }

  async dig ({ name = null, pos = null, maxDistance = 6, count = 1 } = {}) {
    const b = this.requireBot()
    const out = []
    const held0 = this.#heldText(b)
    const n = Math.min(Math.max(count, 1), 16)
    /* 水/岩浆是**流体**，挖不掉（`mc_dig water` 只会白花一次调用，日志里留一条
     * "破坏 water 这一轮的时间用完了"）。淹死时的正确动作是**上浮换气**，不是挖水。 */
    const fluid = name ?? (pos ? b.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name : null)
    if (fluid && isLiquid(fluid)) {
      throw new Error(`${fluid} 是流体，挖不掉 —— 想从水里出来：mc_move {"mode":"swim"} 按住 jump 上浮换气，`
        + '露出水面后再 mc_move 往岸上走（不知道岸在哪就先 mc_scan 找最近的干燥方块）。')
    }
    // 先把要挖的方块列出来（collectBlock 要一份目标清单，它自己会走过去 + 捡掉落物）
    const targets = []
    for (let i = 0; i < n; i++) {
      if (pos && i === 0) {
        const one = b.blockAt(new Vec3(pos.x, pos.y, pos.z))
        if (!one) throw new Error(`(${pos.x},${pos.y},${pos.z}) 未加载`)
        targets.push(one)
        continue
      }
      const want = name ?? (pos ? b.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name : null)
      if (!want) throw new Error('需要 name 或 pos')
      const found = typeof b.findBlocks === 'function'
        // ⚠️ mineflayer 4.39 的 findBlocks 返回的是**坐标**（{x,y,z}），不是方块对象
        //    （blocks.js:212 里 findBlock 才是 blockAt(blocks[0])）——所以要自己转回方块
        ? b.findBlocks({ matching: (blk) => blk?.name === want, maxDistance, count: n - targets.length })
          .map((p) => b.blockAt(new Vec3(p.x, p.y, p.z)))
          .filter((blk) => blk && blk.name === want)
        : [b.findBlock({ matching: (blk) => blk?.name === want, maxDistance })].filter(Boolean)
      if (!found.length) { out.push(`附近找不到 ${want}`); break }
      for (const f of found) if (!targets.includes(f)) targets.push(f)
      if (targets.length >= n) break
    }
    if (!targets.length) return out

    /* 🔴 按距离从近到远排（显式给的那个 pos 仍排第一）：
     * 2026-10-08 用户转来的实机反馈 —— "mc_dig 挑到够不着的目标就超时"。
     * findBlocks 的返回顺序不保证是最近的，第一个够不着就能把整轮 11 秒吃光。
     */
    const distOf = (blk) => { try { return b.entity.position.distanceTo(blk.position) } catch { return Infinity } }
    if (targets.length > 1) {
      const pinned = pos ? targets[0] : null
      const rest = targets.filter((t) => t !== pinned).sort((a, c) => distOf(a) - distOf(c))
      targets.length = 0
      targets.push(...(pinned ? [pinned, ...rest] : rest))
    }

    /* 🔴 手上（背包里）没有能挖它的工具就别动手：
     * ① 硬挖石头/矿石不掉东西，白耗十几秒，还容易被误当成"挖到了"；
     * ② mineflayer-collectblock 挖之前会拿 `{requireHarvest:true, getFromChest:true}` 去问
     *    mineflayer-tool 要工具，而那个插件在 chestLocations 为空时**无限递归** →
     *    JS 堆十几秒涨到几 GB 直接 OOM，而且全在微任务里跑，连 withTimeout 都不会触发。
     *    （vendor 树里已经给 mineflayer-tool 打了补丁，这里再挡一道，别白跑。）
     */
    if (b.game?.gameMode !== 'creative') {
      const inv = b.inventory.items()
      const canHarvest = (blk) => !blk?.harvestTools || inv.some((it) => blk.harvestTools[it.type])
      if (!targets.some(canHarvest)) {
        const blk = targets[0]
        return [`背包里没有能挖 ${blk.name} 的工具（${this.#toolKinds(b, blk)}）—— 先 mc_craft 一把（木镐 = 3 木板 + 2 木棍），再叫我挖`]
      }
    }

    // ① 有 mineflayer-collectblock 就交给它：走过去 → 挖 → 捡掉落物（换工具它内部用 mineflayer-tool）
    // 🔴 **一次只喂一个目标**：collectBlock 内部是个 for 循环，任何一个目标寻路失败都会把整批带崩
    //    （2026-10-06 实机：挖 4 根原木只拿到 1 根，其余全因 "Took to long to decide path to goal!" 丢掉）。
    //    逐个喂 + 逐个 catch：坏目标跳过，好目标照挖。
    /* 🔴 用 `this.callLeft()` 而不是 `callDeadline()`：本轮已经用掉的时间要算进去
     *    （`mc_sequence` 里"走一段再挖"时，挖只剩 1 秒，不能又给整整 11 秒）。
     * 🔴 再**留 900ms 收尾**（2026-10-08 实机反馈：`mc_dig` 报 `Error: tool call timed out after 6000ms`，
     *    方块其实早挖掉了）。收尾包括：`#cancelCollect` 等 `collectBlock_finished`、
     *    兜底原地挖、拼返回文本、DSH 层序列化 —— 这些以前都排在预算之外，
     *    两个目标就是 2×1.5 秒，整轮直接冲出工具超时，模型只拿到一个没有信息的硬错误。 */
    const deadline = Date.now() + Math.max(0, this.callLeft() - 900)
    const leftOf = () => deadline - Date.now()
    /* 🔴 2026-10-08 实机（用户「挖矿还是会」）：**`dig()` 不再把方块交给 mineflayer-collectblock**。
     *    collectBlock 走过去用的是 `goals.GoalLookAtBlock`（vendor CollectBlock.js:30）—— 只要**看得见**
     *    就算"到了"，站 6 格开外也算到，然后 `bot.dig()` 从够不着的地方挖：
     *    服务端按"眼睛→方块中心 ≤4.5"拒收，而 mineflayer 的 `finishDigging()`（digging.js:158）
     *    已经把**客户端**那格写成 air ⇒ 画面上就是"挖完又复原"；
     *    更糟的是服务端不回 air 方块更新 ⇒ `diggingTask` 永远不 resolve ⇒ 采集任务永远挂着
     *    （`collectBlock_finished` 不 emit）⇒ 之后几分钟走不了路（实机日志 02:38–02:43 连打 20 次
     *    "上次的采集任务还在后台跑"，机器人整整 5 分钟没挪窝）。
     *    现在统一成一条路：**自己走到方块旁边**（`walkTo` 的 pathfinder 带 canDig，能挖穿挡路的），
     *    再按"眼睛→方块中心"复核，够得着才 `bot.dig()`，而且**认服务端的破坏回包**；
     *    掉落物由 `#grabDrops` 捡（原来靠 collectBlock 顺手捡）。 */
    {
      /* 🔴 2026-10-08 审计④：`interruptMove()` 以前是**死代码**（定义了没人调），而文档说 mc_dig 靠它抢占。
       *    走路/采集会按着 forward、占着 pathfinder ⇒ 先把还在跑的移动真停掉，再领号。 */
      await this.interruptMove()
      this.#beginMove()
      let okCount = 0
      let seen = 0
      const reachMax = b.game?.gameMode === 'creative' ? 5.0 : 4.5
      for (const target of targets) {
        seen++
        // 🔴 单次调用 ≤11 秒：到点就带着已经挖到的结果返回，剩下的下次再叫
        const left = leftOf()
        if (left < 900) {
          out.push(`—— 这一轮的 ${callSecText()}用完了（挖到 ${okCount}/${targets.length}），`
            + `还有 ${targets.length - seen + 1} 个没挖：再叫一次 mc_dig 接着挖`)
          break
        }
        // 🔴 别让**一个**够不着的目标吃掉整轮：单个目标最多给"剩余时间的一大半"，
        //    剩下的时间留给后面的目标 + 兜底原地挖（2026-10-08 实机反馈）。
        const budget = Math.max(300, Math.min(
          callBudget(this.cfg.collectBudgetMs), left, Math.max(2500, Math.floor(left * 0.6))))
        const p = target.position.clone()
        const nm = target.name
        /* 够不着 → **先自己走过去**（以前这一步交给 collectBlock，而它只要"看得见"就算到）。
         * 🔴 判据必须是 `#reachOf`（**眼睛 → 方块中心**，服务端也是这么判的），不是脚到方块坐标：
         *    用脚算的话，正下方 4 格的石头会被判"够得着"，原地挖一发服务端根本不认。
         * 🔴 走到方块**自己那一格**（x+0.5 / y / z+0.5）再复核：走过去这一路 pathfinder 可能顺手
         *    把它挖穿（`canDig`），所以到地方必须重新读一次方块。 */
        let fresh = b.blockAt(p)
        if (!fresh || fresh.name !== nm) continue
        if (this.#reachOf(b, fresh) > reachMax) {
          const w = await this.walkTo({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, { arrive: 2.2, budget })
          fresh = b.blockAt(p)
          if (!fresh || fresh.name !== nm) {
            okCount++
            out.push(`走过去的时候顺手挖掉了 ${nm} @ ${p} → 现在 ${b.blockAt(p)?.name ?? '?'}`)
            const got = await this.#grabDrops(b)
            if (got > 0) out.push(`　（顺手捡回 ${got} 个掉落物）`)
            else {
              const hint = this.#dropHint(b)
              if (hint) out.push(`　（${hint}）`)
            }
            continue
          }
          if (this.#reachOf(b, fresh) > reachMax) {
            const away = this.#reachOf(b, fresh)
            out.push(`够不着 ${nm} @ ${p}（眼睛到方块中心 ${away.toFixed(1)} 格，`
              + `${w?.arrived ? '走过去也只到这么远' : '走过去也没走到'}）—— `
              + '先 `mc_move` 到它旁边（或换个近一点的目标）再叫我挖：站远了挖服务端不认，方块会"复原"')
            continue
          }
        }
        {
          const watch = this.#watchServerBreak(b, p)
          try {
            // 空中挖慢 5 倍 ⇒ 先等落地（否则预算全喂给一次注定超时的挖掘）
            if (!await this.#waitGrounded(b, Math.min(1_500, Math.max(0, leftOf() - 800)))) {
              out.push(`—— 我还在空中（没落地）就挖不了 ${nm}：空中挖方块慢 5 倍，先落稳（或 \`mc_move {mode:"jump"}\` 换个落脚点）再叫一次 mc_dig`)
              break
            }
            await this.#equipFor(b, fresh, `换工具挖 ${nm}`)
            const oneMs = this.#digMsFor(b, fresh, b?.heldItem?.type ?? null)
            if (oneMs != null && leftOf() < oneMs + 500) {
              out.push(`—— 剩下的时间不够挖 ${nm}（这块要 ${(oneMs / 1000).toFixed(1)} 秒${this.#slowDigWhy(b)}），没开始挖：再叫一次 mc_dig 接着挖`)
              break
            }
            await this.#t(b.dig(fresh, true), 'dig', `挖 ${nm}`)
            /* 等**服务端**的判决（客户端那个 air 是预测，不算数；服务端的包可能晚到约 1 秒） */
            await this.#awaitServerBreak(b, watch)
            const now = b.blockAt(p)?.name ?? '?'
            const confirmed = watch.watching ? watch.hit() : null
            /* 🔴 服务端把方块**改回来**了（复原）：这次破坏服务端没认。见 `#watchServerBreak` 注释。 */
            const restored = watch.watching ? watch.restored() : null
            if (restored != null) {
              await sleep(150)
              const back = this.#stateNameOf(b, restored) ?? b.blockAt(p)?.name ?? '别的方块'
              this.log(`⚠️ 服务端把 ${nm} 复原了（${p}）—— 这次破坏没被认`)
              out.push(`没挖掉 ${nm} @ ${p}：服务端把这块**改回了 ${back}**（复原）`
                + ' —— 多半是我离得远，或客户端区块旧了。先 `mc_move` 走到它旁边（3 格以内）再叫一次 mc_dig；'
                + '连着两三次都这样就用 `mc_connect {force:true}` 重连刷新区块')
            } else if (now !== nm) {
              okCount++
              /* 🔴 审计①：`bot.dig()` 的 resolve 来自**客户端预测**（digging.js:143-159 自己
               *    `_updateBlockState(pos, 0)` 又自己接住）⇒ 服务端拒了也照样"成功"。
               *    只有服务端发的破坏包才算真挖掉。 */
              if (!watch.watching) out.push(`挖掉 ${nm} @ ${p}（原地，不用走过去）→ 现在 ${now}`)
              else if (confirmed) out.push(`挖掉 ${nm} @ ${p}（原地，不用走过去）→ 现在 ${now}（服务端已确认）`)
              else out.push(`本地读到 ${nm} @ ${p} 已经变成 ${now}，但**没收到服务端的破坏回包**`
                + ' —— 服务端很可能拒了这次破坏（够不着 / 领地保护 / 权限 / 反作弊）：别当成挖掉了，'
                + '先 `mc_scan` 复核，真没挖掉就 `mc_connect {force:true}` 重连刷新区块')
              /* 🔴 原地挖绕过了 collectBlock（它平时挖完还会把掉落物捡回来）⇒ 得自己去捡，
               *    否则"挖到 3 根原木、背包里只有 1 根"（2026-10-08 实机）。 */
              const got = await this.#grabDrops(b)
              if (got > 0) out.push(`　（顺手捡回 ${got} 个掉落物）`)
              else {
                /* 一个都没捡到（够不着 / 卡住 / 背包满）⇒ 点一句"东西还在地上"。
                 * why：用户 2026-10-08 原话"挖完方块或者打完动物以后老是忘记走过去拾取" ——
                 * 捡东西是**决策**，插件替不了，但结果里必须让它知道这活还没完。 */
                const hint = this.#dropHint(b)
                if (hint) out.push(`　（${hint}）`)
              }
            } else out.push(`没挖成 ${nm} @ ${p}（原地挖完了，但那里**还是 ${now}**）`
              + ' —— 服务端没认这次破坏（失步 / 领地保护 / 工具不对）：先 `mc_scan` 复核，再 `mc_connect {force:true}` 重连清一下客户端缓存')
          } catch (e) {
            if (e?.mcAborted) throw e
            out.push(`挖 ${nm} @ ${p} 失败：${String(e?.message ?? e).slice(0, 120)}`)
          } finally {
            watch.stop()
          }
          continue
        }
      }
      /* 以前这里还有一条"够不着就交给 collectBlock"的路 + 一个"② 退回：原地挖"的兜底循环 ——
       * 2026-10-08 全部删掉：那条路正是"挖完又复原 + 之后几分钟走不了路"的来源（见本函数开头的注释）。
       * 够不着就如实说，让模型自己 `mc_move` 过去再挖。 */
      return this.#withHeld(out, b, held0)
    }

    return this.#withHeld(out, b, held0)
  }

  inventory () {
    const b = this.requireBot()
    const all = b.inventory.items()
    // 🔴 按**名字合计**，而且只报一次"手上"。
    // 实机教训（2026-10-07）：旧实现回 `{held, items}`，而 mineflayer 的 `inventory.items()`
    // **本来就包含手上那一格** —— 同一叠东西在输出里出现两遍，模型当场数了两遍：
    // 「held oak_planksx2 + items oak_planksx2 = 4 块木板」，于是它以为 `mc_craft` 在撒谎
    // （其实它只有 2 块，做工作台要 4 块），跑去砍树了。工具输出必须**一眼看得出总数**。
    const totals = new Map()
    for (const i of all) totals.set(i.name, (totals.get(i.name) ?? 0) + i.count)
    const items = [...totals].map(([name, count]) => ({ name, count }))
    const held = b.heldItem ? `${b.heldItem.name}x${b.heldItem.count}` : null
    const lines = [held ? `手上：${held}（这一叠已经算在下面的合计里，别再加一遍）` : '手上：空']
    lines.push(items.length ? `背包（同名已合计、**含手上那叠**）：${items.map((i) => `${i.name}x${i.count}`).join('、')}` : '背包：空')
    /* 🔴 2026-10-08 第五份审计旁注：`all.length` 是**叠数**（`items()` 一叠一条、不含 0-8 那九格），
     *    写"格"会让模型以为"背包只剩 3 格空位"。改成"叠"，并补一句空位。 */
    const free = (() => { try { return b.inventory.emptySlotCount() } catch { return null } })()
    lines.push(`共 ${all.length} 叠 / ${items.length} 样${free != null ? `（背包还有 ${free} 个空位）` : ''}`)
    return { text: lines.join('\n'), held, items }
  }

  /* ───────────── 朝向（"看向我"就该用工具，不要用 /tp 指令） ───────────── */

  /** 目标点 → mineflayer 的 yaw/pitch（mineflayer yaw = 反方向 + PI） */
  static lookAnglesTo (from, to) {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const dz = to.z - from.z
    const ground = Math.hypot(dx, dz)
    const yaw = Math.atan2(-dx, -dz)          // atan2(西, 北)
    const pitch = Math.atan2(dy, ground)      // 抬头看上面的东西为正
    return { yaw, pitch }
  }

  /** 看向坐标或某个玩家/实体（who 传名字；英文名/玩家名/中文别名都认） */
  async lookAt ({ x, y, z, who = null } = {}) {
    const b = this.requireBot()
    let target = null
    if (who) {
      const me = b.entity?.position
      const list = Object.values(b.entities ?? {}).filter((e) => e !== b.entity).map((e) => {
        let d = Infinity
        try { d = e.position.distanceTo(me) } catch { /* 假 bot 没有 position */ }
        return { e, d }
      })
      const { hit, near, needle, alias } = pickEntity(list, who)
      if (hit) target = hit.e.position
      else {
        // 兜底：实体表里没有（超过渲染距离），但玩家列表里有
        const name = Object.keys(b.players ?? {}).find((n) => n.toLowerCase().includes(needle) || (alias ? n.toLowerCase().includes(alias) : false))
        if (name) {
          target = b.players[name]?.entity?.position ?? null
          if (!target) throw new Error(`${name} 在玩家列表里，但看不到它的实体位置（离得太远 / 区块还没加载）`)
        } else {
          throw new Error(`附近找不到 "${who}"（附近实际有：${near.length ? near.join('、') : '什么都没有'}）`
            + '—— 名字要跟 mc_entities 里显示的一致（中文叫法也认）；实在没有就先 mc_entities 看一眼')
        }
      }
    } else if (x !== undefined && y !== undefined && z !== undefined) {
      target = new Vec3(Number(x), Number(y), Number(z))
    } else throw new Error('要么给 who（玩家名/怪物名），要么给 x/y/z')
    /* 🔴 2026-10-08 审计：不用 `b.lookAt(...)` —— 真 mineflayer 的 `look()`（physics.js:331-357）
     *    在不带 force 时 `await lookingTask.promise`，而那个 promise 只在物理循环发出 `look` 包
     *    时才 finish（`bot.on('move')`，physics.js:306-312）；机器人站着不动 / 骑在船里 / 刚死时
     *    物理循环整个 early return（physics.js:158-162）⇒ **永远挂着**。
     *    `#aimAt` 直接写 `bot.entity.yaw/pitch`，让物理循环自己发包（和 useBlock 同一套）。 */
    const aimed = this.#aimAt(b, target)
    if (!aimed) throw new Error('算不出要转的角度（实体位置读不到）—— 先 mc_status 看看我在哪')
    return {
      lookingAt: { x: target.x, y: target.y, z: target.z },
      myEye: { x: b.entity.position.x, y: b.entity.position.y + 1.62, z: b.entity.position.z },
      yaw: Number(b.entity.yaw.toFixed(3)), pitch: Number(b.entity.pitch.toFixed(3)),
      note: '已经转头了（包由物理循环发出）—— 服务端不回执；没转过去就再叫一次或先 mc_diag 看控制位',
    }
  }

  /* ───────────── 放置 / 破坏（"搭高"就该用工具，不要用 /setblock） ───────────── */

  /** 找一个能对着放的相邻实体方块 */
  #placeRef (pos) {
    const b = this.requireBot()
    for (const [dx, dy, dz] of [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const nb = b.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz))
      if (nb && nb.boundingBox === 'block') return { ref: nb, face: { x: -dx, y: -dy, z: -dz } }
    }
    return null
  }

  /** 把背包里的方块放到某个坐标（先走近、必要时往上搭） */
  async placeBlock ({ x, y, z, name = null } = {}) {
    const b = this.requireBot()
    const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
    const want = name ? String(name) : null
    // 选方块：指定名字就给那个；没指定就**只挑整方块**（旧版直接 items[0]，见 pickPlaceItem 注释）
    const pick = () => pickPlaceItem(b, want)
    let item = pick()

    // 创造模式：背包里没有就**自动取**（协议级 set_creative_slot，不需要 OP）。
    // 不这么做的话"给个方块名就能建"不成立——AI 得先想起来调 mc_give，
    // 否则 mc_build 直接报"背包是空的"。生存模式没这福利（得自己挖/合成）。
    if (!item && want && b.game?.gameMode === 'creative') {
      await this.giveItem({ name: want })
      item = pick()
    }
    if (!item) {
      if (want) {
        throw new Error(`背包里没有 ${want}（生存模式请先挖或合成；创造模式本应自动取物，若仍失败请看上一条错误）`)
      }
      let all = []
      try { all = b.inventory.items() } catch {}
      if (!all.length) {
        throw new Error('背包是空的——**给 name 指定要放哪种方块**（创造模式下会自动取物），或先挖方块')
      }
      // 能走到这里 = 背包里有东西，但没有"能当填充块的整方块"
      const junk = [...new Set(all.filter((i) => !isFullBlockItem(b, i.name)).map((i) => i.name))].slice(0, 6)
      const kept = [...new Set(all.filter((i) => isFullBlockItem(b, i.name)).map((i) => i.name))].slice(0, 6)
      throw new Error('背包里没有能当**实体方块**放的东西'
        + (junk.length ? `（只有 ${junk.join('、')} —— 火把/门/半砖这些放下去站不住）` : '')
        + (kept.length ? `（${kept.join('、')} 是家当，不拿来当填充块；真要放就显式给 name）` : '')
        + '。先 mc_dig 挖点泥土/圆石，或 mc_craft 做点木板。')
    }

    // 走/飞到够得着的位置（reach 约 4.5 格）
    /* 🔴 2026-10-08 第五份审计报告 ⑤：以前用"脚 → 方块角点"的距离、阈值 5.5 ——
     *    服务端是按**眼睛 → 方块中心**判的（生存 4.5 / 创造 5.0），角点到中心差最多 ~0.87 格
     *    ⇒ 4.6–5.5 格的方块能过我们的检查、然后被服务端拒（`place_block.js:42` 抛英文
     *    `Server refused to place …`，原样冒泡成工具错误）。现在按眼→中心算、阈值对齐服务端。 */
    const reachMax = b.game?.gameMode === 'creative' ? 5.0 : 4.5
    const eyePos = (() => {
      try {
        const p = b.entity.position
        return new Vec3(p.x, p.y + (b.entity.eyeHeight ?? 1.62), p.z)
      } catch { return b.entity.position }
    })()
    const dist = () => eyePos.distanceTo(pos.offset(0.5, 0.5, 0.5))
    let approachError = null
    if (dist() > 4) {
      this._selfMovingAt = Date.now()
      try {
        if (b.game?.gameMode === 'creative') await this.flyTo(pos.x + 2, pos.y + 1.5, pos.z + 2)
        else await this.walkTo({ x: pos.x + 2, y: pos.y, z: pos.z + 2 }, { arrive: 2.5, budget: 25_000 })
      } catch (e) { approachError = e.message }
      this._selfMovingAt = Date.now()
      await sleep(250)
    }
    // 🔴 够不着就别硬放。旧版把接近失败 `catch {}` 吞掉、照样往下走，
    //    结果服务端拒了放置，而工具还报"placed: X"——真机被投诉的"报假成功"。
    if (dist() > reachMax) {
      throw new Error(`够不着 (${pos.x},${pos.y},${pos.z})：眼睛到方块中心 ${dist().toFixed(1)} 格，`
        + `${b.game?.gameMode === 'creative' ? '创造 5' : '生存 4.5'} 格以内才放得下`
        + (approachError ? `（接近失败：${approachError}）` : '')
        + '。先用 mc_move 靠近，或换更近的点位。')
    }

    // 目标位置必须"能放"：不占空间才放得进去。
    // 判据是 canPlaceInto（boundingBox==='empty'）——覆盖空气三兄弟、**液体**、草/花/藤蔓等可替换物。
    const targetBlock = b.blockAt(pos)
    if (!targetBlock) {
      throw new Error(`(${pos.x},${pos.y},${pos.z}) 未加载（区块还没到）——先 mc_map 看看，或换近一点的点位`)
    }
    if (!canPlaceInto(targetBlock)) {
      throw new Error(`(${pos.x},${pos.y},${pos.z}) 已被 ${targetBlock.name} 占住，放不进去——`
        + '换个位置，或先 mc_act{mode:"break"} 清掉')
    }
    let ref = this.#placeRef(pos)
    if (!ref) {
      // 悬空：先在自己脚下垫一块，站上去，再放目标（等于"搭高"）
      const below = b.entity.position.floored().offset(0, -1, 0)
      const underFeet = b.blockAt(below)
      if (underFeet && !isAir(underFeet.name)) {
        await this.#t(b.equip(item, 'hand'), 'equip', '手持垫脚方块')
        await this.#t(b.lookAt(below.offset(0.5, 0.5, 0.5), true), 'lookAt', '看向脚下')
        await this.#t(b.placeBlock(underFeet, { x: 0, y: 1, z: 0 }), 'place', '垫脚')
        await sleep(250)
      }
      ref = this.#placeRef(pos)
      if (!ref) throw new Error('目标位置悬空且脚下没有可依附方块（先走到有方块的地方，或先放一个垫脚方块）')
    }
    await this.#t(b.equip(item, 'hand'), 'equip', '手持方块')
    await this.#t(b.lookAt(ref.ref.position.offset(0.5, 0.5, 0.5), true), 'lookAt', '看向放置面')
    try {
      await this.#t(b.placeBlock(ref.ref, new Vec3(ref.face.x, ref.face.y, ref.face.z)), 'place', '放置方块')
    } catch (e) {
      /* 🔴 报告⑤：上游 `place_block.js:42` 抛的是英文 `Server refused to place …`，
       *    以前原样冒泡给模型。翻译成它能用的话。 */
      const m = String(e?.message ?? '')
      if (/Server refused to place/i.test(m)) {
        throw new Error('服务端拒了这次放置（太远 / 目标格被占 / 手上有别的 / 失步）——'
          + '先用 `mc_move` 靠近或换个点位，**别当成放成功了**。')
      }
      throw e
    }
    await sleep(200)

    // 🔴 必须**验证**：旧版不管成没成都是 `placed: item.name` → 真机被投诉的"报假成功"
    //    （mc_build 说 placed，mc_scan 复查一格没放下）
    const now = b.blockAt(pos)?.name ?? null
    const ok = now === item.name
    return {
      placed: ok ? item.name : false,
      requested: item.name,
      at: { x: pos.x, y: pos.y, z: pos.z },
      now,
      held: this.#heldText(b),
      ...(ok ? {} : {
        note: `方块**没有出现**（现在那里是 ${now ?? '未加载'}）——服务端可能拒了这次放置`
          + '（领地保护 / 权限 / 反作弊 / 失步）。不要当成放成功了。',
      }),
    }
  }

  /**
   * 我离这块方块**真正**有多远（服务端/上游的判据）。
   *
   * 🔴 2026-10-08 实机（熔炼验证，探针定论）：上游 `canDigBlock` 和服务端用的都是
   *    **眼睛 → 方块中心**（`digging.js`：`block.position.offset(.5,.5,.5).distanceTo(
   *    bot.entity.position.offset(0,1.65,0)) <= 5.1`，生存 reach 4.5），
   *    而插件以前算的是 **脚 → 方块坐标**。两者差得远：脚边 4 格**正下方**的石头，
   *    脚距 4.0（判"够得着"、原地挖）而眼距 5.6（服务端直接忽略）
   *    ⇒ 客户端预测把方块写成 air、插件报"挖掉"，**服务端没认、也没掉任何东西**。
   *    实机证据：`mc_dig stone` 连报 5 个"挖掉 … → 现在 air"，背包里圆石 = 0，
   *    `bot.entities` 里一个掉落物都没有（探针 `probe-drop.mjs`）。
   */
  #reachOf (b, blk) {
    try {
      const p = blk?.position
      const pos = b?.entity?.position
      if (!p || !pos) return Infinity
      const ex = Number(pos.x)
      const ey = Number(pos.y) + Number(b.entity.eyeHeight ?? 1.62)
      const ez = Number(pos.z)
      const cx = Number(p.x) + 0.5
      const cy = Number(p.y) + 0.5
      const cz = Number(p.z) + 0.5
      if (![ex, ey, ez, cx, cy, cz].every(Number.isFinite)) return Infinity
      return Math.hypot(ex - cx, ey - cy, ez - cz)
    } catch { return Infinity }
  }

  /**
   * 挂一个"服务端到底认没认这次破坏"的监听。
   *
   * 🔴 2026-10-08 第五份审计报告 ①（本块最值钱的一条）：**`bot.blockAt()` 是客户端预测世界**。
   *    上游 `mineflayer/lib/plugins/digging.js` 的本地计时器到点后，`finishDigging()`
   *    **不看服务端认没认**就 `bot._updateBlockState(pos, 0)`（`digging.js:143-159`），
   *    `blocks.js` → `prismarine-world` 直接改 chunk 并 emit `blockUpdate`，
   *    该事件又被 `digging.js` 接住 ⇒ `diggingTask.finish()`。所以**服务端拒绝时 `await bot.dig()` 照样正常返回**，
   *    而此刻 `blockAt(pos)` 已经变成 air ⇒ `now !== name` 恒真 = 自己跟自己核对。
   *    （作者旧注释把"连着两次 break 都回『那里本来就是空气』"归因成"mineflayer 挖矿循环还在发包"，归因不准。）
   *    修法：只把**服务端发的破坏包**当"真挖掉了"，`blockAt` 只用来描述"我这边现在读到什么"。
   *
   * 🔴 2026-10-08 实机第二轮（用户 m19917「挖矿还是会[复原]」→ m20106「煤矿正常、铁矿不对」）：
   *    光看"有没有包"还不够 —— 服务端**拒绝**破坏时，原版会把这个位置的**真实方块**
   *    （也就是原方块本身）用 `block_change` 发回来纠正客户端（`ServerPlayerGameMode` 的 reach 检查
   *    失败分支），mineflayer `blocks.js:396-399` 照着把客户端世界改回原方块 ⇒ **玩家看到"方块复原"**。
   *    旧代码把这个**复原包**也当成"服务端认了" ⇒ 报「挖掉 … （服务端已确认）」，紧接着方块在眼前回来。
   *    所以现在区分三态：`hit()` = 服务端说这块变**空气**了（真挖掉）、`restored()` = 服务端把方块**改回来**了、
   *    其它（只有 multi_block_change 或什么都没收到）= 没有证据，调用方如实说"没收到回包"。
   */
  #watchServerBreak (b, pos) {
    const want = `${pos.x},${pos.y},${pos.z}`
    let air = false          // 服务端把这个位置改成**空气** ⇒ 真挖掉了
    let restored = 0         // 服务端把这个位置改成**非空气**（多半就是原方块）⇒ "复原"
    let multi = 0            // 看到几个 multi_block_change 记录（只用于排查）
    const mark = (stateId) => {
      const st = Number(stateId)
      if (!Number.isFinite(st)) return
      if (st === 0) { air = true; restored = 0 }
      else if (!air) restored = st
    }
    /* 位段格式照抄 mineflayer `lib/plugins/blocks.js:363-394`（别自己猜）：1.18+ 每个 record 是一个数字，
     *   `y = record & 0x0f`、`z = (record >> 4) & 0x0f`、`x = (record >> 8) & 0x0f`、方块状态 = `record >> 12`；
     *   老格式是 `{horizontalPos, y, blockId}` + `chunkX/chunkZ`。 */
    const decodeMulti = (data) => {
      const records = Array.isArray(data?.records) ? data.records : []
      const cc = data?.chunkCoordinates ?? null
      for (const rec of records) {
        let x, y, z, st
        if (rec && typeof rec === 'object') {
          x = (Number(rec.horizontalPos) >> 4) & 0x0f
          y = Number(rec.y) & 0x0f
          z = Number(rec.horizontalPos) & 0x0f
          st = rec.blockId
        } else {
          const n = Number(rec)
          if (!Number.isFinite(n)) continue
          y = n & 0x0f
          z = (n >> 4) & 0x0f
          x = (n >> 8) & 0x0f
          st = n >> 12
        }
        const ox = Number(cc?.x ?? data?.chunkX ?? 0) * 16
        const oy = Number(cc?.y ?? 0) * 16
        const oz = Number(cc?.z ?? data?.chunkZ ?? 0) * 16
        if (`${ox + x},${oy + y},${oz + z}` !== want) continue
        multi++
        mark(st)
      }
    }
    const onPacket = (data, meta) => {
      try {
        const nm = String(meta?.name ?? '')
        if (nm === 'multi_block_change') { decodeMulti(data); return }
        if (nm !== 'block_change' && nm !== 'block_update') return
        const p = data?.location ?? data?.position
        /* 🔴 没有坐标就**不当证据**（旧代码在这里 `hit = true`：任何格式不认识的包都会变成"服务端认了"）。 */
        if (!p || typeof p !== 'object') return
        if (`${p.x},${p.y},${p.z}` !== want) return
        mark(data?.type)
      } catch { /* 忽略：包格式不认识就不当证据 */ }
    }
    let watching = false
    try { b._client?.on?.('packet', onPacket); watching = typeof b?._client?.on === 'function' } catch { watching = false }
    return {
      /** 服务端确实把这个位置改成空气了吗 */
      hit: () => air,
      /** 服务端把这个位置改成**非空气**了（＝把方块改回来了）—— 返回方块状态 id，没发生返回 null */
      restored: () => (restored > 0 ? restored : null),
      /** 有没有看到 multi_block_change（排查用；它也可能是"复原"） */
      sawMulti: () => multi,
      /** 有没有真挂上监听：假 bot（套件里没有 `_client.on`）时为 false ⇒ 调用方**别下结论** */
      watching,
      stop: () => { try { b._client?.removeListener?.('packet', onPacket) } catch { /* 忽略 */ } },
    }
  }

  /** 方块状态 id → 名字（查不到就 null，别抛） */
  #stateNameOf (b, stateId) {
    try {
      const e = b?.registry?.blocksByStateId?.[Number(stateId)]
      return e?.name ?? null
    } catch { return null }
  }

  /** 等**服务端的判决**（最多 `maxMs`，服务端说"这块变空气了"就提前收手）。
   *
   * 🔴 2026-10-08 实机定论（`实机验证\挖方块\live-restore.mjs` B 段）：`bot.dig()` 的 resolve 来自
   *    **客户端预测**（`digging.js:158` 自己写 air），而服务端的 `block_change{air}` **可以晚到约 1 秒**
   *    —— 实测眼距 4.61 格的一次挖掘：`mc.dig` 204ms 就"完事"了，服务端的包在 ~970ms 才到。
   *    以前只 `sleep(200)` 就下结论 ⇒ 好端端挖掉的方块被报成"没收到服务端的破坏回包"（骗自己人）。
   */
  async #awaitServerBreak (b, watch, { maxMs = 1_200 } = {}) {
    if (!watch?.watching) return null
    const cap = Math.max(0, Math.min(Number(maxMs) || 0, this.callLeft() - 500))
    const t0 = Date.now()
    while (!watch.hit() && Date.now() - t0 < cap) {
      if (this.abortSignal?.aborted) throw abortError('等挖掘回包')
      await sleep(60)
    }
    return watch.hit()
  }

  /** 破坏某个坐标的方块（比 mc_dig 更直接：按坐标） */
  async breakBlock ({ x, y, z } = {}) {
    const b = this.requireBot()
    const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
    const blk = b.blockAt(pos)
    if (!blk) throw new Error(`${pos.x},${pos.y},${pos.z} 未加载`)
    if (isAir(blk.name)) {
      return {
        broken: null, at: { x: pos.x, y: pos.y, z: pos.z },
        note: '那里本来就是空气（**我这边**读到的）—— 要么已经挖掉了，要么客户端的区块缓存旧了：'
          + '`mc_connect {force:true}` 真重连一次（普通的 mc_connect 在已连着时是空操作、不会重连），'
          + '或走远 32 格再回来（区块会重发）；也可以 `mc_scan` 看看附近实际有什么。',
      }
    }
    const name = blk.name
    /* 🔴 2026-10-08 第五份审计报告 ② + 实机定论：`breakBlock` 以前**完全没有"够不着"检查**（dig 有）。
     *    上游 `digging.js` 的 `canDigBlock` 要求**眼睛到方块中心** ≤ 5.1，服务端生存 reach 是 4.5；
     *    对够不着的方块动手 = 服务端静默忽略 + 报告 ① 的客户端预测 ⇒ **静默假成功**。
     *    ⚠️ 判据必须是 `#reachOf`（眼→中心）：用"脚→坐标"算的话，正下方 4 格的方块会被判"够得着"。 */
    const dist = this.#reachOf(b, blk)
    const reachMax = b.game?.gameMode === 'creative' ? 5.0 : 4.5
    if (dist > reachMax) {
      return {
        broken: false, at: { x: pos.x, y: pos.y, z: pos.z }, now: name,
        held: this.#heldText(b), reach: Math.round(dist * 100) / 100,
        note: `够不着（我在 ${Math.round(dist * 100) / 100} 格外，${b.game?.gameMode === 'creative' ? '创造 5' : '生存 4.5'} 格以内才挖得动）`
          + ' —— **我没开始挖**（服务端会静默忽略，然后报个假的"挖掉了"）。先 `mc_move` 走到它旁边再挖。',
      }
    }
    // ①′ 空中挖慢 5 倍（`bot.digTime` 的 `notOnGround`）⇒ 先等落地再动手，别把预算喂给一次注定超时的挖掘
    if (!await this.#waitGrounded(b, Math.min(1_500, Math.max(0, this.callLeft() - 800)))) {
      return {
        broken: false, at: { x: pos.x, y: pos.y, z: pos.z }, now: name,
        held: this.#heldText(b),
        note: '我还在空中（没落地）—— 空中挖方块慢 5 倍（徒手原木 3 秒变 15 秒），'
          + '**我没开始挖**。先站稳（`mc_move {mode:"jump"}` 换个落脚点，或等一下）再叫一次。',
      }
    }
    // ① 先换到对的工具（背包里有的话）—— "手上攥着泥土刨石头"是"一直超时"的头号原因
    const t = await this.#equipFor(b, blk, `换工具挖 ${name}`)
    // ② 换不上就**别硬挖**：徒手挖石头要 7.5 秒，比一轮预算还长，只会白花时间 + 报个假原因
    if (!this.#canHarvestNow(b, blk)) {
      throw new Error(`手上是 ${t.held}，挖 ${name} ${this.#toolKinds(b, blk)} —— 背包里也没有能挖它的东西。`
        + '先 mc_craft 一把（木镐 = 3 木板 + 2 木棍），或先 mc_act{mode:"equip",name:"…"} 换一个。硬挖会一直超时。')
    }
    const digMs = this.#digMsFor(b, blk, b?.heldItem?.type ?? null)
    /* 🔴 时间不够就**别开始挖**（2026-10-08 实机反馈：玩家转来 AI 的话"快挖完的时候会重置"）。
     *    到点松手 = 破坏进度清零、白费一次调用；模型连着叫三次就是"挖到八成又从头来"。
     *    宁可如实说"我没开始挖"，让它专门再叫一次。 */
    const leftMs = this.callLeft()
    if (digMs != null && leftMs < digMs + 900) {
      return {
        broken: false,
        at: { x: pos.x, y: pos.y, z: pos.z },
        now: name,
        held: this.#heldText(b),
        digMs,
        budgetMs: Math.round(leftMs),
        ...(t.changed ? { tool: `${t.heldBefore} → ${t.held}` } : {}),
        note: `这一轮只剩 ${Math.round(leftMs)}ms，这块按手上的东西要 ${(digMs / 1000).toFixed(1)} 秒${this.#slowDigWhy(b)} —— **我没开始挖**`
          + '（挖到一半到点松手，破坏进度会清零，白费一次调用）。再叫一次 `mc_act {mode:"break"}` 专门挖它就行。',
      }
    }
    /* 动手之前就挂上"服务端认没认"的监听（报告 ①）。 */
    const watch = this.#watchServerBreak(b, pos)
    let timedOut = false
    try {
      await this.#t(b.dig(blk, true), 'digBlock', `破坏 ${name}`)
    } catch (e) { if (e?.mcTimeout) timedOut = true; else { watch.stop(); throw e } }
    /* 🔴 超时**不代表没挖掉**：`withTimeout` 只是让我们不等了，mineflayer 那边的挖矿循环还在发包，
     *    方块往往过一会儿就真没了（2026-10-08 实机：连着两次 `mc_act{break}` 都回"那里本来就是空气"）。
     *    所以超时时多等一会儿再复查，别急着报"没挖掉"。
     *    ⚠️ 等的是**服务端的包**（`#awaitServerBreak`），不是干睡 —— 客户端那个 air 是预测，不算数。 */
    await this.#awaitServerBreak(b, watch, { maxMs: timedOut ? 900 : 1_200 })
    // 同样要验证：挖失败（服务端拒绝/失步）不能报"broken: name"
    const now = b.blockAt(pos)?.name ?? null
    const localGone = now !== name
    /* 没挂上监听（假 bot）时**别下结论**：报 `null` 而不是 false（"没收到回包"是结论，不能凭空说）。 */
    const confirmed = watch.watching ? watch.hit() : null
    /* 🔴 服务端把方块**改回来**了（＝这次破坏服务端没认，客户端随即"复原"）。见 `#watchServerBreak` 注释。 */
    const restored = watch.watching ? watch.restored() : null
    watch.stop()
    const held = this.#heldText(b)
    if (restored != null) {
      await sleep(150)                      // 等客户端把服务端这个包应用上，好报出"复原成什么"
      /* 服务端包里的状态 id 是**权威**的（本地 `blockAt` 可能还没应用上这个包，会读成 air）⇒ 优先用它。 */
      const back = this.#stateNameOf(b, restored) ?? b.blockAt(pos)?.name ?? '别的方块'
      this.log(`⚠️ 服务端把 ${name} 复原了（${pos.x},${pos.y},${pos.z}）—— 这次破坏没被认`)
      return {
        broken: false, restored: true, at: { x: pos.x, y: pos.y, z: pos.z }, now: back,
        held, reach: Math.round(this.#reachOf(b, blk) * 100) / 100,
        ...(t.changed ? { tool: `${t.heldBefore} → ${t.held}` } : {}),
        ...(digMs != null ? { digMs } : {}),
        note: `服务端把这块**改回了 ${back}**（复原）—— 这次破坏服务端没认（多半是我离得远，或客户端区块旧了）。`
          + '先 `mc_move` 走到它旁边（3 格以内）再叫一次；连着两三次都这样就用 `mc_connect {force:true}` 重连刷新区块。',
      }
    }
    /* 真挖掉了 ⇒ 掉落物就在脚边。用户 2026-10-08 原话："挖完方块…老是忘记走过去拾取"。
     * 只**点一句**（`mc_act{break}` 这条路从来不自己捡），让模型知道这活还没完。 */
    const pickup = localGone ? this.#dropHint(b) : null
    return {
      broken: localGone ? name : false,
      confirmed,
      at: { x: pos.x, y: pos.y, z: pos.z },
      now,
      held,
      ...(t.changed ? { tool: `${t.heldBefore} → ${t.held}` } : {}),
      ...(digMs != null ? { digMs } : {}),
      ...(pickup ? { pickup } : {}),
      ...(localGone && confirmed === false ? {
        note: '本地世界已经清掉了，但**没收到服务端的破坏回包** —— 服务端很可能拒了这次破坏'
          + '（领地保护 / 权限 / 反作弊 / 太远），客户端这边却把方块写成空气了。'
          + '用 `mc_scan` 或 `mc_view` 再确认一下，**别在空气上盖房、别走进你以为挖穿的墙**；'
          + '真没挖掉就 `mc_connect {force:true}` 重连刷新区块。',
      } : {}),
      ...(localGone ? {} : {
        note: timedOut
          ? `挖了 ${callSecText()}还没挖掉（手上是 ${held}${digMs != null ? `，这块按手上的东西要 ${(digMs / 1000).toFixed(1)} 秒` : ''}）`
            + '—— 换个对的工具，或换个更近的点位；别当成"服务端拒绝"。'
          : `方块还在（${now}）—— 服务端可能拒了这次破坏，别当成挖掉了`,
      }),
    }
  }

  /** 统一交互入口：mode = look / place / break / toward */
  async interact (args = {}) {
    const mode = String(args.mode ?? 'look')
    if (mode === 'look') return { mode, ...(await this.lookAt(args)) }
    if (mode === 'place') return { mode, ...(await this.placeBlock(args)) }
    if (mode === 'break') return { mode, ...(await this.breakBlock(args)) }
    if (mode === 'toward') {
      const b = this.requireBot()
      if (!args.who) throw new Error('toward 需要 who（玩家名）')
      const r = await this.lookAt({ who: args.who })
      if (args.approach !== false) {
        const target = b.entity.position.clone()
        const eye = { x: r.lookingAt.x, y: target.y, z: r.lookingAt.z }
        await this.walkTo(eye, { arrive: 3, budget: callBudget(args.budgetMs) })
        await this.lookAt({ who: args.who })
      }
      return { mode, ...(await this.lookAt({ who: args.who })), position: this.position }
    }
    throw new Error(`未知 mode：${mode}（可用 look / place / break / toward）`)
  }

  /** 装备某物到手上 */
  async equip ({ name } = {}) {
    const b = this.requireBot()
    const before = this.#heldText(b)
    const item = b.inventory.items().find((i) => i.name === String(name))
    if (!item) throw new Error(`背包里没有 ${name}（用 mc_inventory 看有什么）`)
    await this.#t(b.equip(item, 'hand'), 'equip', `手持 ${name}`)
    /* 🔴 `held` 必须**读回来**（2026-10-08 审计：旧版拿装备前那个 item 对象拼字符串，
     *    换手静默失败时照样报"手上是 X"） */
    const held = this.#heldText(b)
    const ok = b.heldItem?.name === item.name
    return {
      held, ...(before !== held ? { before } : {}),
      ...(ok ? {} : { note: `换手没成功（现在手上是 ${held}）—— 那一叠可能被占用了，或刚被用掉；再叫一次 mc_act{mode:"equip",name:"${name}"}，先用 mc_inventory 看还剩什么` }),
    }
  }

  /**
   * 批量放置：从 (x1,y1,z1) 到 (x2,y2,z2) 的实心长方体。
   * 逐个调用 placeBlock（会自己走近/垫脚），count 上限保护。
   */
  async build ({ x1, y1, z1, x2, y2, z2, name = null, max = 64 } = {}) {
    const pts = []
    const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2)]
    const [ay, by] = [Math.min(y1, y2), Math.max(y1, y2)]
    const [az, bz] = [Math.min(z1, z2), Math.max(z1, z2)]
    for (let y = ay; y <= by; y++) for (let z = az; z <= bz; z++) for (let x = ax; x <= bx; x++) pts.push({ x, y, z })
    if (pts.length > max) throw new Error(`要放 ${pts.length} 个方块，超过上限 ${max}（缩小范围或调大 max）`)
    const b = this.requireBot()
    const want = name == null ? null : String(name)
    // 🔴 单次调用 ≤11 秒：到点就带着已放好的结果返回，剩下的下次再叫。
    //    再叫一次时**已经放对的点会跳过**（不报"这格已经有方块"），所以直接重发同一个范围就行。
    // 🔴 `this.callLeft()`：本轮已经用掉的时间要算进去（`mc_sequence` 里"走一段再搭"只剩几秒）。
    const deadline = Date.now() + this.callLeft()
    const ok = []
    const fail = []
    const skipped = []
    const held0 = this.#heldText(b)
    let used = null                       // 实际用了哪种方块（"搭完手里还剩什么"是模型最缺的一条）
    let done = 0
    for (const p of pts) {
      if (deadline - Date.now() < 300) break
      done++
      const at = `${p.x},${p.y},${p.z}`
      try {
        const cur = b.blockAt(new Vec3(p.x, p.y, p.z))?.name ?? null
        // ① 已经是想要的那种方块 ⇒ 跳过（重发同一范围时不算失败）
        if (want && cur === want) { ok.push(at); continue }
        /* ② 没指定方块、但这格已经有东西了 ⇒ 跳过并如实说
         *    （旧版会让 placeBlock 一个个抛"已被 X 占住，放不进去"，攒够 5 个就把整次调用报成失败） */
        if (!want && cur && !isAir(cur)) { skipped.push(`${at}:${cur}`); continue }
        const r = await this.placeBlock({ ...p, name })
        /* 🔴 只有**复核过真放上去了**才算 placed（2026-10-08 审计：旧版无条件 ok.push，
         *    placeBlock 回 placed:false 时也照算 ⇒ mc_build 报的数量是假的） */
        if (r?.placed) { if (!used) used = r.placed; ok.push(at) } else { fail.push(`${at}: 现在那里是 ${r?.now ?? '未加载'}`); if (fail.length >= 5) break }
      } catch (e) { fail.push(`${at}: ${e.message}`); if (fail.length >= 5) break }
    }
    const left = pts.length - done
    const held = this.#heldText(b)
    return {
      requested: pts.length, placed: ok.length, failed: fail.length, failures: fail.slice(0, 5),
      ...(skipped.length ? { skipped: skipped.length, skippedWhy: `这 ${skipped.length} 格本来就有方块（不是我要放的那种），没动它们：${skipped.slice(0, 3).join('、')}` } : {}),
      ...(used ? { used } : {}),
      ...(held !== held0 ? { held, heldBefore: held0 } : { held }),
      ...(left > 0
        ? { remaining: left, hint: `这一轮的 ${callSecText()}用完了，还有 ${left} 个没放 —— 再叫一次 mc_build（同一个范围就行，放对的会跳过）` }
        : {}),
    }
  }

  /** 原地跳一下（爬台阶用） */
  async jump () {
    const b = this.requireBot()
    /* 🔴 2026-10-08 审计⑥：以前固定占 520ms —— 不看预算、不认中断。
     *    探针：已 abort + `setCallDeadline(0)` 时仍按 jump 526ms 才返回（同条件 `flyTo` 1ms 就抛
     *    `mcAborted`）。用户已经点了停止，还会多做一个真实的跳跃动作。 */
    if (this.abortSignal?.aborted) throw abortError('跳跃', this.abortSignal)
    const left = this.msLeft()
    if (left <= 120) {
      throw new Error(`这一轮的 ${callSecText()}用完了（单次调用最多 ${budgetSecText()}）—— 过一会儿再叫一次 mc_move{mode:"jump"}`)
    }
    /* 🔴 审计（第四份报告②）：jump 以前**不领 `_moveGen` 号**，finally 里无条件松 jump
     *    ⇒ 会把"接管者"（另一次移动/反射层）正按着的 jump 松掉。现在领号，只在还是自己时才松。 */
    const gen = this.#beginMove()
    const hold = Math.max(60, Math.min(320, left - 120))
    b.setControlState('jump', true)
    try {
      await raceAbort(sleep(hold), this.abortSignal, '跳跃')
    } finally {
      if (this._moveGen === gen) { try { b.setControlState('jump', false) } catch { /* 忽略 */ } }
    }
    // 落地缓冲（别超过本轮剩余时间）
    const rest = Math.max(0, Math.min(200, this.msLeft() - 60))
    if (rest > 0) await raceAbort(sleep(rest), this.abortSignal, '跳跃')
    return { position: this.position }
  }

  /**
   * 上浮换气（在水里按住 jump 游泳）。**淹死的机制**是氧气（`air`）掉到 0 之后开始掉血，
   * 所以正确动作是"先浮上来换气"，而不是挖水（水/岩浆是流体，挖不掉）。
   * 一次最多 3 秒（和别的动作一样，宁可少量多次），返回 rose（涨了几格）与 air。
   */
  async swimUp ({ hold = 3_000 } = {}) {
    const b = this.requireBot()
    const e = b.entity
    const airOf = () => (Number.isFinite(b.oxygenLevel) ? b.oxygenLevel : null)
    const y0 = e?.position?.y ?? null
    const air0 = airOf()
    /* 🔴 2026-10-08 实机：这里以前只看 `entity.isInWater` —— 而它在**泡在水柱里但没贴水面**
     *    时读出来是 undefined（prismarine-physics 的入水 AABB 从底部缩了 0.401）。
     *    实测机器人沉在 (-31,59,261)、脚/头两格都是 water、`onGround:false`，
     *    `swimUp` 却回"我本来就没在水里" ⇒ 淹死也救不了自己。改用和挖矿守卫同一个判据。 */
    if (!this.#inWaterNow(b)) {
      return { inWater: false, air: air0, note: '我本来就没在水里 —— 这条是给"在水里憋气"用的' }
    }
    const want0 = Number.isFinite(Number(hold)) ? Number(hold) : 3_000
    /* 🔴 2026-10-08 第四份审计报告 ①④⑧：swimUp 以前三个病一起犯 ——
     *   ① 完全不认中断（abort 后仍空转满 3 秒，`heldMs` 还是**假数据**）；
     *   ④ 预算归零时 `Math.max(200, …)` 白送 200ms（探针：`setCallDeadline(0)` ⇒ 真按了 215ms）；
     *   ⑧ `Number(hold) || 3_000` 把 `hold: 0` 当成 3000。
     *   现在：先看预算、领 `_moveGen` 号、每轮查 abort 与号、`heldMs` 报实际按住时长。 */
    const left = this.callLeft()
    if (left <= 300) {
      return {
        inWater: true, airBefore: air0, air: air0, rose: 0, heldMs: 0, reason: 'call-over', remaining: 1,
        hint: `这一轮的 ${callSecText()}用完了，我没按 —— 过一会儿再叫一次 mc_move{"mode":"swim"} 接着上浮`,
      }
    }
    const want = Math.max(0, Math.min(want0, 3_000, left - 300))
    if (want <= 0) {
      return { inWater: true, airBefore: air0, air: air0, rose: 0, heldMs: 0, note: 'hold 是 0（没让我按）—— 要上浮就再叫一次 mc_move{"mode":"swim"}' }
    }
    const gen = this.#beginMove()
    const t0 = Date.now()
    let held = 0
    let preempted = false
    try {
      b.setControlState('jump', true)
      while (Date.now() - t0 < want) {
        if (this.abortSignal?.aborted) throw abortError('上浮', this.abortSignal)
        await raceAbort(sleep(100), this.abortSignal, '上浮')
        held = Date.now() - t0
        if (this._moveGen !== gen) { preempted = true; break }              // 被别人接管了
        if (!this.#inWaterNow(b)) break                                     // 已经出水
        const a = airOf()
        const rose = y0 != null && b.entity?.position ? b.entity.position.y - y0 : 0
        if (held > 500 && rose >= 0.4 && a != null && a >= 20) break        // 头露出水面、气在恢复
      }
    } finally {
      /* 🔴 报告②：只在**还是自己**的时候松 jump —— 否则会把接管者正按着的 jump 松掉。 */
      if (this._moveGen === gen) { try { b.setControlState('jump', false) } catch { /* 忽略 */ } }
    }
    const y = b.entity?.position?.y ?? null
    const air = airOf()
    const still = this.#inWaterNow(b)
    if (preempted) {
      return {
        inWater: still, airBefore: air0, air, rose: y0 != null && y != null ? Math.round((y - y0) * 100) / 100 : null,
        heldMs: held, reason: 'preempted', remaining: 1,
        hint: '另一次移动把我接管了（我没再按着 jump）—— 再叫一次 mc_move{"mode":"swim"} 接着上浮',
      }
    }
    return {
      inWater: still,
      airBefore: air0, air,
      rose: y0 != null && y != null ? Math.round((y - y0) * 100) / 100 : null,
      heldMs: held,
      ...(still
        ? {
            remaining: 1,
            hint: air != null && air >= 18
              ? '已经浮到水面、气在恢复 —— 接着用 mc_move 往岸上走（不知道岸在哪就先 mc_scan 找干燥方块）'
              : '还在水里 —— 再叫一次 mc_move{"mode":"swim"} 接着上浮；水挖不掉，别去 mc_dig 水',
          }
        : { note: '已经出水了' }),
    }
  }

  /* ───────────── 创造取物 / 使用 / 攻击 / 丢弃（补能力，2026-09-15）───────────── */

  /**
   * 选一个槽位放取来的物品。优先级：
   *   ① 已经放着**同一种**东西的槽（重复取同款不占新格，也不会覆盖别的）
   *   ② 快捷栏（36–44）的空槽
   *   ③ 手上那格（实在满了才覆盖）
   * 为什么要在意：连建一面墙会反复调 placeBlock → giveItem，
   * 若每次都挑"第一个空槽"，很快就把之前取的方块覆盖掉，导致后面莫名"背包里没有 X"。
   */
  #freeSlot (b, itemName = null) {
    const slots = b.inventory?.slots ?? []
    if (itemName) {
      for (let s = 36; s <= 44; s++) {
        if (slots[s]?.name === itemName) return s
      }
    }
    for (let s = 36; s <= 44; s++) {
      if (!slots[s]) return s
    }
    return b.quickBarSlot != null ? 36 + b.quickBarSlot : 36
  }

  /**
   * 创造模式直接获取物品。
   *
   * 为什么不用 /give：多数服对非 OP 关掉 /give，而**创造模式改槽位是协议级能力**
   * （`set_creative_slot` 包），服务端一般照收。所以走 `bot.creative.setInventorySlot`。
   * 这也是用户点名的缺口："连创造模式直接获取物品的方法都没有"。
   */
  async giveItem ({ name, count = 1, slot = null } = {}) {
    const b = this.requireBot()
    if (b.game?.gameMode !== 'creative') {
      throw new Error(`取物只在创造模式可用（当前 ${b.game?.gameMode ?? '未知'}）；生存模式请挖或合成`)
    }
    const itemName = String(name ?? '').trim()
    if (!itemName) throw new Error('要给物品名（如 oak_planks / diamond_sword）')
    const type = b.registry?.itemsByName?.[itemName]
    if (!type) throw new Error(`未知物品：${itemName}（用英文 id，如 oak_planks）`)
    const n = Math.min(Math.max(Number(count) || 1, 1), type.stackSize ?? 64)
    /* 🔴 2026-10-08 第五份审计报告 M3：`slot` 的文档以前写"0-44"，但 **0-8 不是背包槽**
     *    （`prismarine-windows` 的 `minecraft:inventory` 是 `{ start: 9, end: 44 }`：
     *     0 = 合成结果槽、1-4 = 2×2 合成格、5-8 = 盔甲槽）。
     *    写 0-8 会把物品塞进合成格/盔甲槽（模型以为是"背包第 1 格"）。
     *    现在钳到 9-44，并如实告诉它被挪过。 */
    const asked = slot != null ? Number(slot) : null
    const target = asked != null && Number.isFinite(asked)
      ? Math.min(Math.max(Math.floor(asked), 9), 44)
      : this.#freeSlot(b, itemName)

    const Item = itemLoader()(b.registry)
    const item = new Item(type.id, n)
    await this.#t(b.creative.setInventorySlot(target, item, 800), 'give', `取物 ${itemName}`)
    await sleep(120)
    const nowItem = b.inventory.slots?.[target] ?? null
    const now = nowItem ? `${nowItem.name}x${nowItem.count}` : null
    const moved = asked != null && Number.isFinite(asked) && target !== Math.floor(asked)
      ? `你要的第 ${Math.floor(asked)} 格不是背包格（背包是 9-44：0=合成结果、1-4=合成格、5-8=盔甲）—— 我放进第 ${target} 格了；`
      : ''
    return {
      gave: `${itemName}x${n}`, slot: target, now,
      ...(moved ? { slotAsked: Math.floor(asked) } : {}),
      /* 🔴 2026-10-08 审计：旧版**无条件**说"已放进背包/快捷栏"，即使那格还是空的。文案要跟 `now` 走。 */
      ...(now
        ? { note: moved + (target >= 36 ? `已放进快捷栏第 ${target - 35} 格` : '已放进背包') }
        : { note: `**没放进去**（第 ${target} 格现在还是空的）—— 服务端没认这次 setInventorySlot（失步 / 权限 / 那格被别的窗口占着）。别当成拿到了` }),
    }
  }

  /** 清空背包（创造模式） */
  async clearInventory () {
    const b = this.requireBot()
    if (b.game?.gameMode !== 'creative') throw new Error('清空背包只在创造模式可用')
    await this.#t(b.creative.clearInventory(), 'give', '清空背包')
    /* 🔴 2026-10-08 第五份审计报告 ⑥：以前直接 `return { cleared: true }` —— 而 `giveItem`
     *    已经改成"读回槽位再说结果"。清完抽查一遍，别谎报"清空成功"。 */
    await sleep(200)
    const left = (() => { try { return b.inventory.items() } catch { return [] } })()
    if (!left.length) return { cleared: true }
    const names = [...new Set(left.map((i) => i.name))].slice(0, 6)
    return {
      cleared: false,
      left: left.length,
      names,
      note: `**没清干净** —— 背包里还剩 ${left.length} 叠（${names.join('、')}${left.length > names.length ? '…' : ''}）。`
        + '服务端可能没认这次清空（失步 / 权限 / 那几格被别的窗口占着）。别当成背包空了。',
    }
  }

  /**
   * 把朝向**立刻**拧到某个点（**不等物理 tick**）。
   *
   * 🔴 为什么必须自己做（2026-10-08 审计）：mineflayer 的 `bot.lookAt()` 内部
   *    `await lookingTask.promise`，而那个 promise 只在**物理 tick 真的发出朝向包**
   *    时才 resolve（`mineflayer\lib\plugins\physics.js:306-312` 的 `bot.on('move')`）。
   *    机器人**站着不动 / 骑在船里 / 刚死**时物理循环不发包 ⇒ `lookAt` 永远挂着
   *    （实机：`mc_act {mode:"use",who:"oak_boat"}` 卡到 5000ms 超时，见会话 step 790）。
   *
   * 这里直接写 `bot.entity.yaw/pitch`（和 `bot.look` 第 347-348 行做的事一样，只是不 await），
   * 之后 mineflayer 内部那次 `lookAt` 会算出**同样的角度** ⇒ 走它的 `yawChange === 0` 快速返回
   * 分支（`physics.js:343-345`），再也不会挂。
   */
  #aimAt (b, point) {
    const eye = b?.entity?.position
    if (!eye || !point) return null
    try {
      const dx = Number(point.x) - eye.x
      const dy = Number(point.y) - (eye.y + (b.entity.eyeHeight ?? 1.62))
      const dz = Number(point.z) - eye.z
      const yaw = Math.atan2(-dx, -dz)
      const pitch = Math.atan2(dy, Math.hypot(dx, dz))
      b.entity.yaw = yaw
      b.entity.pitch = pitch
      return { yaw: Number(yaw.toFixed(3)), pitch: Number(pitch.toFixed(3)) }
    } catch { return null }
  }

  /**
   * 使用/激活方块或实体（开门、按按钮、拉杆、开箱子、喂动物…）。
   *
   * 🔴 2026-10-08 审计改了两处：
   *   ① 交互**到底成没成要复核**：`activateBlock`/`activateEntity` 内部只 `await lookAt` +
   *      写一个包（`mineflayer\lib\plugins\inventory.js:195-258`），**服务端不会回执** ——
   *      旧版无条件 `return { usedBlock }`，等于"包发出去了"就报成功。
   *      现在：容器看窗口开没开、门/按钮看方块状态翻没翻、骑乘看 `bot.vehicle`。
   *   ② `who` 用和 `attack()` 同一套匹配（中文别名/displayName 都认），找不到时列出附近实际有谁。
   */
  async useBlock ({ x, y, z, who = null } = {}) {
    const b = this.requireBot()
    if (who) {
      const me = b.entity?.position
      const list = Object.values(b.entities ?? {}).filter((e) => e !== b.entity).map((e) => {
        let d = Infinity
        try { d = e.position.distanceTo(me) } catch { /* 假 bot 没有 position */ }
        return { e, d }
      })
      const { hit, near } = pickEntity(list, who)
      if (!hit) {
        throw new Error(`附近找不到实体 "${who}"（附近实际有：${near.length ? near.join('、') : '什么都没有'}）`
          + '—— 名字要跟 mc_entities 里显示的一致（中文叫法也认）')
      }
      const ent = hit.e
      const dist = Number.isFinite(hit.d) ? Number(hit.d.toFixed(1)) : null
      if (dist != null && dist > 4.5) {
        return {
          usedEntity: entityNameOf(ent), distance: dist, reached: false,
          note: `太远了（${dist} 格，交互要 4.5 格内）—— 先 mc_move 到它旁边（或者 mc_act {mode:"toward", who:"${who}"}）再 use`,
        }
      }
      this.#aimAt(b, { x: ent.position.x, y: ent.position.y + 1, z: ent.position.z })
      await this.#t(Promise.resolve(b.activateEntity(ent)), 'act', `与 ${who} 交互`)
      await sleep(220)
      const riding = b.vehicle && b.vehicle.id === ent.id
      return {
        usedEntity: entityNameOf(ent), ...(dist != null ? { distance: dist } : {}),
        ...(riding ? { riding: entityNameOf(ent) } : {
          note: '交互包已经发出去了 —— 服务端**不会回执**，我没法确认它生效（`activateEntity` 内部只瞄一下再发包）。'
            + '如果没反应：确认它在 4.5 格内、你没被方块挡住、它不是别人拴着的/有主人的',
        }),
      }
    }
    const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
    const blk = b.blockAt(pos)
    if (!blk) throw new Error(`${pos.x},${pos.y},${pos.z} 未加载`)
    const at = { x: pos.x, y: pos.y, z: pos.z }
    const props0 = { ...(blk.getProperties?.() ?? {}) }
    this.#aimAt(b, new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5))
    await this.#t(Promise.resolve(b.activateBlock(blk)), 'act', `使用 ${blk.name}`)
    // ① 容器类：窗口该弹出来 —— 这是唯一硬证据
    if (CONTAINER_RE.test(blk.name)) {
      for (let i = 0; i < 10; i++) {
        await sleep(120)
        const w = b.currentWindow
        if (w && w !== b.inventory) {
          return {
            usedBlock: blk.name, at, opened: w.type,
            ...(typeof w.containerItems === 'function' ? { slots: w.containerItems().length } : {}),
          }
        }
      }
      return {
        usedBlock: blk.name, at, opened: false,
        note: `${blk.name} 的窗口**没有打开**（等了 1.2 秒）—— 包发出去了但服务端没回应：`
          + '够不着（要 4.5 格内、看得见）/ 被别的玩家占着 / 位置读错了。别当成开成功了。'
          + '先 mc_move 走近再试，或者 mc_scan 看一眼那格到底是什么',
      }
    }
    // ② 门/活板门/栅栏门/按钮/拉杆：方块状态应该翻转
    if (TOGGLE_RE.test(blk.name)) {
      await sleep(280)
      const after = b.blockAt(pos)
      const props1 = { ...(after?.getProperties?.() ?? {}) }
      const changed = Object.keys(props1).filter((k) => props0[k] !== props1[k])
      return {
        usedBlock: blk.name, at,
        ...(changed.length
          ? { toggled: true, changed: changed.map((k) => `${k}: ${props0[k]} → ${props1[k]}`) }
          : { toggled: false, note: `${blk.name} 的状态**一点没变**（${Object.entries(props0).map(([k, v]) => `${k}=${v}`).join(' ') || '没有可读状态'}）—— 交互没生效：够不着（4.5 格内、看得见）或被红石/插件锁着` }),
      }
    }
    // ③ 其它（床、蛋糕、炼药锅…）：只能如实说"包发出去了"
    await sleep(280)
    const after2 = b.blockAt(pos)
    const props2 = { ...(after2?.getProperties?.() ?? {}) }
    const changed2 = Object.keys(props2).filter((k) => props0[k] !== props2[k])
    return {
      usedBlock: blk.name, at,
      ...(changed2.length ? { changed: changed2.map((k) => `${k}: ${props0[k]} → ${props2[k]}`) } : {}),
      note: '交互包已经发出去了 —— 服务端**不会回执**，我没法确认生效（`activateBlock` 内部只瞄一下再发包）。'
        + '如果没反应：确认 4.5 格内、看得见、没被挡住',
    }
  }

  /**
   * 对着**空气**用**手上的东西**（右键）：扔末影之眼 / 末影珍珠 / 雪球 / 鸡蛋，拉弓射箭，喝药水。
   *
   * 为什么单独一个动作：`useBlock` 只能右键**方块或实体**（`activateBlock` / `activateEntity`），
   * 而上面这些用的是 `activateItem`（对着空气用物品）。2026-10-06 用户问"现在能通关吗"时
   * 定位到的硬缺口就是它 —— 没有它**找不到要塞**（扔末影之眼是原版唯一办法），也射不掉
   * 末影水晶、射不了烈焰人。补之前全仓一次 `activateItem` 都没有。
   *
   * `hold`：按住多少毫秒再松手（`deactivateItem`）。
   *   - 拉弓**必须给**（弦拉满约 1000ms，不给就只是"举起弓"不射箭）；
   *   - 喝药水约 1600ms；
   *   - 可扔物（眼睛 / 珍珠 / 雪球）给了也无害，松手包是幂等的。
   */
  async useItem ({ hold = 0 } = {}) {
    const b = this.requireBot()
    const item = b.heldItem
    if (!item) {
      throw new Error('手上没东西 —— 先用 mc_act{mode:"equip",name:"…"} 拿到手上（mc_inventory 看背包里有什么）')
    }
    // 别把一轮 11 秒全用来"按住不放"：最多 3 秒，且**给松手留 400ms 余量**。
    // 🔴 这个余量是必需的：松手包（`deactivateItem`）也要过 `#t` 的预算闸门，
    //    如果按住把这一轮吃干，松手会被拒 ⇒ 拉弓变成"一直举着弓、箭永远不出去"
    //    （实测就是被自己的回归套件 check-core-useitem ⑤ 抓到的）。
    const want = Math.max(0, Number(hold) || 0)
    const ms = Math.max(0, Math.min(want, 3_000, Math.max(0, this.callLeft() - 400)))
    await this.#t(Promise.resolve(b.activateItem()), 'act', `使用 ${item.name}`)
    if (ms > 0) await sleep(ms)
    if (want > 0 && typeof b.deactivateItem === 'function') {
      await this.#t(Promise.resolve(b.deactivateItem()), 'act', `松开 ${item.name}`)
    }
    const out = { used: item.name, count: item.count, heldMs: ms }
    /* 🔴 2026-10-08 第五份审计报告 ⑦：`count` 是**使用前**的快照 —— 末影珍珠/雪球扔出去后
     *    仍报旧数量，模型以为手上还有 N 个。这里补一个"用完之后还剩多少"。 */
    const after = (() => {
      try {
        const h = b?.heldItem
        if (h && h.name === item.name) return h.count
        const all = b.inventory.items().filter((i) => i.name === item.name)
        return all.reduce((s, i) => s + i.count, 0)
      } catch { return null }
    })()
    if (after != null) {
      out.left = after
      if (after >= item.count && item.name !== 'bow' && item.name !== 'crossbow') {
        out.note = `手上还是 ${after} 个（没少）—— 这一下可能没真用出去（服务端不回执这类动作，用 mc_inventory 复核）`
      }
    }
    if (want > ms) {
      out.note = [out.note, `这一轮剩下的时间不够按住 ${want}ms（只按了 ${ms}ms）—— 过一会儿再叫一次 mc_act{useitem} 补`].filter(Boolean).join('；')
    }
    return out
  }

  /**
   * 攻击实体。给 `who` 就按名字找，否则打最近的那个。
   *
   * 有现成的 `mineflayer-pvp` 就交给它（自己追、自己算近战节奏、打不动会停），
   * 没有才退回"挥一下"（老行为，只对 4.5 格内有效）。
   *
   * 🔴 2026-10-08 用户转来的三条实机反馈，都在这一个函数里：
   *   ① `who:"zombie"` 报"附近找不到"、不带 who 才打得着 ⇒ 名字匹配现在看**所有**名字字段
   *      （username / name / displayName / type / kind）+ 中文别名；找不到时**列出半径内实际有谁**，
   *      别只丢一句"附近找不到"（看不出是名字写错还是怪跑了）。
   *   ② 不带 who 会先打到脚边的掉落物 ⇒ 按"敌对 > 玩家 > 动物 > 掉落物"排，掉落物垫底。
   *   ③ 不带 who 只在 4.5 格内生效、怪一退开就够不着 ⇒ 有 pvp 时放宽到 24 格（它会自己追过去）。
   */
  async attack ({ who = null, budget = 20_000 } = {}) {
    const b = this.requireBot()
    const me = b.entity.position
    const needle = who ? String(who).trim().toLowerCase() : null
    const alias = needle ? NAME_ALIAS[needle] : null
    const hasPvp = Boolean(this.mcPlugins?.pvp && typeof b.pvp?.attack === 'function')
    const distOf = (e) => { try { return e.position.distanceTo(me) } catch { return Infinity } }
    const all = Object.values(b.entities ?? {})
      .filter((e) => e && e !== b.entity && e.position)
      .map((e) => ({ e, d: distOf(e), nm: entityNameOf(e) }))
      .filter((x) => x.d <= 24)
    const rankOf = (x) => {
      if (JUNK_RE.test(x.nm)) return 3                                  // 掉落物 / 经验球 / 箭
      if (HOSTILE_RE.test(x.nm) || x.e.kind === 'Hostile mobs') return 0
      if (x.e.username || x.e.type === 'player') return 1
      return 2                                                          // 动物之类
    }
    const hit = (x) => {
      if (!needle) return true
      const fields = nameFieldsOf(x.e)
      if (fields.some((v) => v.includes(needle))) return true
      return Boolean(alias) && fields.some((v) => v.includes(alias))
    }
    // 🔴 不给 who 时**只追怪**（24 格内的敌对也追），动物/玩家仍只在 4.5 格内 ——
    //    否则"打最近的"会跑过去揍玩家 6 格外的马（2026-10-08 探针实测附近就有 horse 6.8 格）。
    const inReach = needle ? all : all.filter((x) => x.d <= 4.5 || rankOf(x) === 0)
    const list = inReach.filter(hit).sort((a, c) => (rankOf(a) - rankOf(c)) || (a.d - c.d))
    const near = all.slice().sort((a, c) => a.d - c.d).slice(0, 6)
      .map((x) => `${x.nm} ${x.d.toFixed(1)} 格`).join('、')
    const pick = list[0]
    // 半径内只剩掉落物（且不在手边）就别动手：打到一个 item 是白费一轮
    const target = pick && !(rankOf(pick) === 3 && pick.d > 4.5) ? pick.e : null
    if (!target) {
      if (needle) {
        throw new Error(`附近找不到 "${who}"（24 格内实际有：${near || '什么都没有'}）`
          + ' —— 名字要跟 `mc_entities` 里显示的一致（中文叫法也认）；'
          + '要打远处那只就先 `mc_move` 过去，怪跑远了同样找不到。')
      }
      throw new Error(`4.5 格内没有能打的实体${near ? `（24 格内最近的是 ${near}）` : ''}`
        + ' —— 掉落物 / 经验球不算，动物与玩家要贴到 4.5 格内；'
        + '要打远处的怪就先 `mc_move` 过去（或 `mc_act {mode:"attack", who:"zombie"}`，那个会追 24 格）。')
    }
    const label = entityNameOf(target)
    const d = Number(distOf(target).toFixed(1))
    const hpBefore = this.#entityHealth(b, target)

    if (hasPvp) {
      /* 🔴 `bot.pvp.attack(target)` **立刻** resolve（它只做三件事：设 target、`GoalFollow` 追过去、
       *    发 `startedAttacking` 事件），真正挥拳的是 `physicTick` 上的后台循环 ⇒
       *    旧写法 `await withTimeout(b.pvp.attack(...))` 一毫秒就返回，紧接着 `finally` 里
       *    `b.pvp.stop()` 又把追过去的 goal 停掉 ⇒ **一下都没打，却回 "attacked: X"**。
       *    所以这里必须自己等：等到目标没了 / 这一轮的时间用完，再停。 */
      // 2026-10-08 审计⑦：`Math.max(300, …)` 在本轮已经用完时会白送 300ms（见 walkTo 同类注释）。
      const left = this.callLeft() - 600
      const bd = left <= 100 ? 0 : Math.max(0, Math.min(callBudget(budget, 4_000), left))
      const t0 = Date.now()
      let note = null
      let pvpErr = null
      try {
        await b.pvp.attack(target)
        while (Date.now() - t0 < bd) {
          if (this.abortSignal?.aborted) break
          if (!b.entities?.[target.id] || target.isValid === false) break
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
      const inRange = Boolean(b.pvp?.wasInRange)
      const hpAfter = gone ? 0 : this.#entityHealth(b, target)
      const waitedMs = Date.now() - t0
      /* 打死了 ⇒ 掉落物就掉在原地。用户 2026-10-08 原话："打完动物以后老是忘记走过去拾取" ——
       * 只**点一句**，不替它走过去（先捡哪个、走多远是决策，而且这一轮的预算基本已经花完了）。 */
      const pickup = gone ? this.#dropHint(b) : null
      if (!gone && !pvpErr) {
        note = inRange
          ? `打了 ${(waitedMs / 1000).toFixed(1)} 秒还没打死（这一轮的时间到了）—— 再叫一次 mc_act{attack} 接着打`
          : `追了 ${(waitedMs / 1000).toFixed(1)} 秒还没进到攻击距离（3.5 格）—— 走不过去 / 被方块挡住 / 目标跑太快；`
            + '先 mc_move 到它旁边，或者换个近一点的目标'
      }
      return {
        attacked: label, distance: d, killed: gone, health: b.health, via: 'pvp', waitedMs,
        ...(hpBefore != null && hpAfter != null && hpBefore !== hpAfter ? { targetHealth: `${hpBefore} → ${hpAfter}` } : {}),
        ...(note ? { note } : {}),
        ...(pickup ? { pickup } : {}),
        ...(pvpErr ? { error: pvpErr } : {}),
      }
    }

    /* 没有 pvp 插件：退化成原地挥（上游原版就是一次 `b.attack`，这里按预算多挥几下） */
    const t0 = Date.now()
    const leftMs2 = this.callLeft() - 400
    const bd = leftMs2 <= 100 ? 0 : Math.max(0, Math.min(callBudget(budget, 4_000), leftMs2))
    let swings = 0
    while (Date.now() - t0 < bd) {
      if (this.abortSignal?.aborted) break
      if (!b.entities?.[target.id] || target.isValid === false) break
      if (distOf(target) > 4.5) break
      await this.#t(Promise.resolve(b.attack(target)), 'attack', `攻击 ${label}`)
      swings++
      await sleep(620)
    }
    // 没有 pvp 时至少挥一下（bd=0 说明这一轮已经用完了，那就别再拖）
    if (swings === 0 && b.entities?.[target.id] && target.isValid !== false && distOf(target) <= 4.5 && !this.abortSignal?.aborted) {
      try { await this.#t(Promise.resolve(b.attack(target)), 'attack', `攻击 ${label}`); swings = 1 } catch {}
    }
    const gone = !b.entities?.[target.id] || target.isValid === false
    const pickup = gone ? this.#dropHint(b) : null
    return { attacked: label, distance: d, swings, killed: gone, health: b.health, ...(pickup ? { pickup } : {}) }
  }

  /** 丢弃手上的物品 */
  async tossItem ({ name = null, count = 1 } = {}) {
    const b = this.requireBot()
    let item = b.heldItem
    if (name) {
      const want = String(name)
      item = b.inventory.items().find((i) => i.name === want)
      if (!item) throw new Error(`背包里没有 ${want}（用 mc_inventory 看有什么）`)
      if (b.heldItem?.name !== want) await this.#t(b.equip(item, 'hand'), 'equip', `手持 ${want}`)
    }
    if (!item) throw new Error('手上没东西可丢')
    const n = Math.min(Math.max(Number(count) || 1, 1), item.count)
    const snap = this.#invSnap(b)
    await this.#t(Promise.resolve(b.toss(item.type, null, n)), 'toss', `丢弃 ${item.name}`)
    /* 🔴 2026-10-08 审计：`bot.toss` 底层是 `transfer()`（clickWindow + 等窗口回包），resolve 只说明
     *    "服务端回包了" —— 到底掉出去几个要按**背包数量差**说，别把"想丢几个"当结果。 */
    const lost = (snap.get(item.name) ?? 0) - (this.#invSnap(b).get(item.name) ?? 0)
    return {
      tossed: `${item.name}x${n}`,
      ...(lost === n ? {} : { note: `背包里只少了 ${Math.max(0, lost)} 个（想丢 ${n} 个）—— 东西可能还在地上或没丢出去，用 mc_inventory 看一眼` }),
    }
  }

  /* ───────────── 序列执行（需求 5：世界交互往往要连串调用）───────────── */

  /**
   * 按顺序执行一串步骤。替代"让 AI 写脚本"——我们不给它脚本能力，
   * 而是把"走这里→放几个→再走那里"这种连串动作收进一个工具，服务端逐步跑。
   *
   * 步骤 op：wait / move / look / turn(toward) / place / break / dig / use /
   *          attack / equip / give / toss / say / jump
   */
  async runSequence (steps, { stopOnError = true, budgetMs = CALL_BUDGET_MS } = {}) {
    if (!Array.isArray(steps) || !steps.length) throw new Error('steps 必须是非空数组')
    if (steps.length > 64) throw new Error(`步骤太多（${steps.length}），上限 64`)
    const t0 = Date.now()
    // 🔴 单次调用 ≤11 秒（用户要求：少量多次）。到点就停，并明确告诉模型**从第几步接着发**。
    //    2026-10-08 审计⑦：`msLeft()` 已经用完时，`Math.max(300, …)` 会白送 300ms。
    const leftMs = this.msLeft()
    const bd = leftMs <= 100 ? 0 : Math.max(0, Math.min(callBudget(budgetMs), leftMs))
    const results = []
    let next = null
    let aborted = false
    for (let i = 0; i < steps.length; i++) {
      /* 🔴 2026-10-08 第四份审计报告 ⑪：这两支以前会为**根本没执行**的那步 push 一条 `ok:false`
       *    ⇒ 汇总里 `succeeded + failed + remaining > requested`（模型据此以为"那步做失败了"）。
       *    现在只记 `next`（那步没做，重发时从它开始），不写 results。 */
      if (this.abortSignal?.aborted) { aborted = true; next = i; break }
      if (Date.now() - t0 > bd) { next = i; break }
      const step = steps[i] ?? {}
      try {
        const r = await this.#runStep(step)
        /* 🔴 2026-10-08 审计⑧：`ok: true` 以前是硬编码的 —— 而 move 步骤在"一格没挪"时返回
         *    `{arrived:false, stuck:true, reason:…}`，汇总里 `succeeded` 于是把它也算成功，
         *    模型据此以为"我已经在目标点了"。move 的 ok 必须看 `arrived`。
         * 🔴 报告⑤：`wait` 步骤被本轮预算**静默截断**时也会自报 `ok:false`（没等完），
         *    那时也要如实算失败、并从这一步重发。 */
        const ok = step.op === 'move' ? r?.arrived !== false : r?.ok !== false
        results.push({
          i, op: step.op, ok, ...r,
          ...(ok ? {} : {
            note: step.op === 'move'
              ? '这一步**没走到**（看 arrived / remaining）—— 再叫一次 mc_sequence，从这一步往后发就行'
              : '这一步**没做完**（本轮时间不够）—— 再叫一次 mc_sequence，从这一步往后发就行',
          }),
        })
        if (!ok) { next = i; break }
      } catch (e) {
        results.push({ i, op: step.op, ok: false, error: e.message })
        /* 🔴 2026-10-08 审计⑦：预算用尽也可能是**步骤自己**先发现的（`jump` / `flyTo` 开头就查
         *    `msLeft()`，`#t()` 也会抛带 `mcCallOver` 的错）。那时错误文案是"这一轮的 N 秒用完了"。
         *    不能让它变成"整串失败、从第 1 步重来"：跟循环顶部那支一样记下停在第几步。 */
        const exhausted = e?.mcCallOver === true
          || /这一轮的 [\d.]+ 秒用完了|这一轮的时间已经用完了/.test(String(e?.message ?? ''))
          || this.msLeft() <= 150
        if (exhausted) { next = i; break }
        if (stopOnError) break
      }
    }
    const okCount = results.filter((r) => r.ok).length
    return {
      requested: steps.length, succeeded: okCount, failed: results.length - okCount,
      /* 🔴 报告⑪：`remaining` 从"第一步还没做完的"算起（**含那一步本身**）⇒ 它和 `failed` 会
       *    指向同一步。想让账目不重复，看 `succeeded === stoppedAt`（stoppedAt 之前全成功）。 */
      attempted: results.length,
      elapsedMs: Date.now() - t0, results,
      ...(aborted ? { aborted: true } : {}),
      ...(next == null ? {} : {
        stoppedAt: next, remaining: steps.length - next,
        hint: aborted
          ? `被中断了（第 ${next + 1} 步还没做）—— 要接着做就再叫一次 mc_sequence，steps 从第 ${next + 1} 步往后发。`
          : next === 0
            ? `这一轮的时间已经用完了（前面什么都没做）—— 直接再叫一次 mc_sequence，steps 原样发就行。`
            : `做到第 ${next + 1} 步时这一轮的时间到了 —— 再叫一次 mc_sequence，`
              + `steps 从第 ${next + 1} 步往后发就行（前面已经做完了）。`,
      }),
    }
  }

  async #runStep (s) {
    const op = String(s.op ?? '')
    switch (op) {
      case 'wait': {
        const rawSec = s.sec != null ? Number(s.sec) : (s.ms != null ? Number(s.ms) / 1000 : 1)
        const sec = Number.isFinite(rawSec) ? rawSec : 1
        const requestedMs = Math.min(Math.max(sec * 1000, 0), 30_000)
        const ms = Math.min(requestedMs, Math.max(0, this.msLeft()))
        /* 🔴 2026-10-08 第四份审计报告 ③⑤：以前 `await sleep(ms)` ——
         *   ③ 完全不可中断（探针：60ms abort 后仍等满 2009ms）；
         *   ⑤ 被本轮预算截断时照样报 `ok:true, waitedMs:300`，汇总说"成功了"，模型以为等够了。 */
        await raceAbort(sleep(ms), this.abortSignal, '等待')
        const short = ms < requestedMs - 50
        return {
          waitedMs: ms,
          ...(short
            ? {
                ok: false, requestedMs,
                note: `只等了 ${(ms / 1000).toFixed(1)} 秒（想要 ${(requestedMs / 1000).toFixed(1)} 秒）—— 这一轮的时间不够，`
                  + '再叫一次 mc_sequence 从这一步往后发，接着等',
              }
            : {}),
        }
      }
      case 'move': {
        const target = { x: Number(s.x), y: Number(s.y), z: Number(s.z) }
        const creative = this.bot?.game?.gameMode === 'creative'
        const mode = String(s.mode ?? (creative ? 'fly' : 'walk'))
        // 🔴 2026-10-08 审计⑤：fly 以前**不传 budgetMs** —— AI 写 `budgetMs:2000` 想飞一小段，
        //    实际跑满 callBudget 的 10 秒，把整串步骤的预算全吃掉。
        if (mode === 'fly') return { ...(await this.flyTo(target.x, target.y, target.z, { budget: callBudget(s.budgetMs) })), mode }
        return { ...(await this.walkTo(target, { budget: callBudget(s.budgetMs) })), mode }
      }
      case 'look':    return this.lookAt(s)
      // 'toward' 要与 mc_act{mode:"toward"} 语义一致：**看向并走近**（只 lookAt 是错的）
      case 'toward':  return this.interact({ mode: 'toward', who: s.who, approach: s.approach, budgetMs: s.budgetMs })
      case 'place':   return this.placeBlock(s)
      case 'break':   return this.breakBlock(s)
      case 'dig':     return { result: await this.dig(s) }
      case 'use':     return this.useBlock(s)
      case 'useitem': return this.useItem(s)
      case 'attack':  return this.attack(s)
      case 'equip':   return this.equip(s)
      case 'give':    return this.giveItem(s)
      case 'toss':    return this.tossItem(s)
      case 'say':     return { said: this.chatSay(s.text ?? '') }
      case 'jump':    return this.jump()
      case 'swim':    return (s.x != null && s.y != null && s.z != null) ? this.walkTo(s) : this.swimUp(s)
      default:
        throw new Error(`未知步骤 op："${op}"（可用：wait/move/look/toward/place/break/dig/use/useitem/attack/equip/give/toss/say/jump/swim）`)
    }
  }

  /**
   * 附近有谁（怪 / 玩家 / 动物 / 掉落物）—— 名字、坐标、距离、上下差、血量、是不是远程。
   *
   * 上游原版只有"名字 / 类型 / 坐标 / 距离"，2026-10-06 用户问"可不可以获取附近怪物的位置"
   * 之后补上了**分类 + 血量 + 远程标记**。**不用自己算**：mineflayer 内核本来就把周围所有实体
   * 放在 `bot.entities`（服务端 spawn / teleport / relative-move 包喂进去的），每条都有
   * `.name` / `.position` / `.kind` / `.metadata`。这里只是**读出来 + 分类 + 按距离排序 + 截断**，
   * 没有任何自研算法。
   *
   * 血量和距离用**现成的** `@nxg-org/mineflayer-util-plugin`（`bot.util.entity.*`）：
   * 它是 `mineflayer-auto-eat` 的依赖，auto-eat 注入时会 `bot.loadPlugin()` 它
   * （见 `mineflayer-auto-eat/dist/index.js:2,6`），所以我们加载 auto-eat 之后 `bot.util` 就在。
   * 它按版本挑 metadata 槽位读怪的血（1.17+ 用 9），比 `entity.health` 靠谱 ——
   * mineflayer **不给别的实体**暴露 `.health`（只有 bot 自己的）。助手不在/抛错就退回自己算。
   *
   * 🔴 只读：不碰世界、不按控制位、不受看图门禁限制。
   */
  entities (radius = 24, { kind = 'all', limit = 40 } = {}) {
    const b = this.requireBot()
    const me = b.entity?.position
    if (!me) return { error: '还没有位置信息（区块没加载完？）' }
    const R = Math.min(Math.max(Number(radius) || 24, 1), 128)
    const want = String(kind ?? 'all').toLowerCase()
    const ue = b?.util?.entity ?? null                       // 现成助手（可能没装）
    const distOf = (e) => {
      try {
        const d = Number(ue?.entityDistance?.(e))
        if (Number.isFinite(d)) return d
      } catch { /* 助手不可用就自己算 */ }
      try { return e.position.distanceTo(me) } catch { return Infinity }
    }
    const healthOf = (e) => {
      try {
        const h = Number(ue?.getHealth?.(e))
        if (Number.isFinite(h) && h > 0) return Math.round(h * 10) / 10
      } catch { /* 同上 */ }
      const h2 = Number(e?.health)
      return Number.isFinite(h2) && h2 > 0 ? Math.round(h2 * 10) / 10 : null
    }
    const list = []
    for (const e of Object.values(b.entities ?? {})) {
      if (!e || e === b.entity || !e.position) continue
      const nm = entityNameOf(e)
      const isPlayer = Boolean(e.username) || e.type === 'player'
      const hostile = HOSTILE_RE.test(nm) || e.kind === 'Hostile mobs'
      const group = isPlayer ? 'player' : (hostile ? 'hostile' : 'other')
      if (want === 'hostile' && group !== 'hostile') continue
      if (want === 'player' && group !== 'player') continue
      if (want === 'mob' && group === 'player') continue
      const d = distOf(e)
      if (d > R) continue
      const hp = healthOf(e)
      list.push({
        name: nm, kind: group, hostile, ranged: RANGED_RE.test(nm),
        distance: Math.round(d * 100) / 100,
        position: { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) },
        dy: Math.round((e.position.y - me.y) * 10) / 10,
        ...(hp === null ? {} : { health: hp }),
        ...(isPlayer ? { player: true } : {}),
      })
    }
    list.sort((a, c) => a.distance - c.distance)
    const counts = { hostile: 0, player: 0, other: 0 }
    for (const x of list) counts[x.kind]++
    return {
      me: { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) },
      radius: R, kind: want, counts,
      total: list.length,
      list: list.slice(0, Math.min(Math.max(Number(limit) || 40, 1), 64)),
    }
  }

  /**
   * 发服务器指令（以玩家身份走聊天）。
   *
   * @param {string} cmd 以 `/` 开头的完整指令
   * @param {{allow?: ((name:string)=>boolean)|null}} [opts]
   *   白名单判定：默认用**内置**那份（保底，独立测试时不依赖插件配置）；
   *   插件层会传自己的可配置白名单进来（用户 2026-09-16 要求白名单可配置）。
   */
  command (cmd, { allow = null } = {}) {
    const b = this.requireBot()
    const c = String(cmd).trim()
    if (!c.startsWith('/')) throw new Error('指令必须以 / 开头')
    const name = c.slice(1).split(/\s+/)[0].toLowerCase()
    const ok = typeof allow === 'function' ? Boolean(allow(name)) : DEFAULT_COMMAND_WHITELIST.has(name)
    if (!ok) throw new Error(`指令不在白名单：/${name}`)
    b.chat(c)
    return c
  }

  requireBot () {
    // ⚠️ 用 `online`（= 有身体 **且** 连接没结束）：只看 `bot.entity` 会把"被踢后的残留"当在线，
    //    于是所有世界工具对着死连接干等（2026-09-19 幽灵在线）。
    if (!this.online) {
      const ghost = this.bot?._client?.ended === true && this.bot?.entity
      throw new Error(`机器人不在线${ghost ? '（连接已结束，bot.entity 是残留，需要 mc_connect 重连）' : ''}${this.lastError ? '：' + this.lastError : ''}`)
    }
    return this.bot
  }
}

/**
 * 边界信息：这个插件"能连哪些 MC 版本"、用的 mineflayer 是哪一版。
 * 数据源是 mineflayer 的模块级常量 `lib/version.js`（`testedVersions` 决定上界拒绝）。
 * 给 `mc_capabilities` 工具用；**不连服、不产生副作用**。
 */
export function libraryInfo () {
  const out = { mineflayer: null, testedVersions: [], oldest: null, latest: null, dataVersions: null, error: null, yggdrasilCompat: yggCompat }
  try {
    const pkg = requireFromMineflayer('./package.json')
    out.mineflayer = pkg?.version ?? null
    const v = requireFromMineflayer('./lib/version.js')
    const list = Array.isArray(v?.testedVersions) ? v.testedVersions : (Array.isArray(v?.default) ? v.default : [])
    out.testedVersions = [...list]
    out.oldest = v?.oldestSupportedVersion ?? list[0] ?? null
    out.latest = v?.latestSupportedVersion ?? list[list.length - 1] ?? null
  } catch (e) { out.error = String(e?.message ?? e) }
  try {
    const mcd = requireFromMineflayer('minecraft-data')
    const pc = mcd?.versions?.pc ?? []
    const releases = pc.map((x) => x?.minecraftVersion).filter((x) => typeof x === 'string' && /^\d+\.\d+(\.\d+)?$/.test(x))
    out.dataVersions = { total: pc.length, releaseCount: releases.length, newest: releases.slice(-6) }
  } catch { /* minecraft-data 拿不到就算了 */ }
  return out
}

export { Vec3 }
export default McBot
