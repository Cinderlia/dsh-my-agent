/**
 * **vendor 依赖加载器**（路线图第 ④ 条第二十八刀：从 `src\core.mjs` 搬出来的）。
 *
 * 这一层负责两件事（本来就是一件事）：**把 PrismarineJS 生态那几个现成插件找出来**、**把它们挂到 bot 上**。
 * `MC_DEPS`（清单）、`loadMcDep(key, opts)`（找 + 缓存**成功**）、`loadPathfinder()`（兼容旧名字）、
 * `setupPathfinder(self, opts)` / `movements(self)` / `setupPlugins(self, opts)`（第二十九刀搬进来的装配）、
 * `resetMcDepCache()` / `resetPathfinderCache()`（自检脚本用）。
 *
 * 三条约定：
 *   ① **不反向 import `core.mjs`**；只借 `node:fs` / `node:path` / `node:url` 与 `format.mjs` 的 `resolveHarnessHome`。
 *   ② **只缓存成功**：找不到时每次调用都重新试一遍（修好 vendor 树后下一次连接就能加载上，不用重启 DSH）。
 *   ③ 相对路径 `../../../vendor/mc-deps/...` 是按**本文件位置**算的 —— 本文件与 `core.mjs` 同在 `src/`，
 *      所以搬过来之后这条相对路径仍然对；但 junction / 符号链接安装时它会落到 `.pnpm` 深路径上，
 *      所以另有"按 `$DSH_HOME\profiles\<profile>\vendor\mc-deps` 绝对路径找"那条兜底。
 */
import { existsSync, readdirSync } from 'node:fs'
import Vec3 from 'vec3'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveHarnessHome } from './format.mjs'
import { scaffoldingItemIds } from './place-items.mjs'
import { patchDigTime } from './dig-speed.mjs'
import { applyProfile, classifyTerrainCached, profileFor } from './terrain.mjs'
import { avoidBlockIds } from './bridge.mjs'
/* 门的判断/去重/冷却只有一份（`src/movement.mjs`）：上半格可能没有 `open` 属性，
 * 必须统一下半块判断；两处各写一份就会各按一次（踩坑 #175/#176）。 */
import { DOOR_PRESS_COOL_MS, doorBaseKey, doorFaceOf, doorOpenStateOf } from './movement.mjs'
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
 * 挂上**现成的**寻路插件（mineflayer-pathfinder）。没装上只是"没有它"，其它功能照旧。
 *
 * 为什么用它：用户 2026-10-06 说"应该有写好的防卡住项目，现在它会一直跳来跳去，完全是瞎动"。
 * 手写的那套（按住前进 + 卡住就跳/挖/垫）在真机就是瞎动；pathfinder 是 A* + 自动挖/垫/绕路，
 * 自带卡住检测（3.5s 没进展 → `path_reset('stuck')`）和 noPath 判定。见文件顶部 `loadPathfinder`。
 */
/**
 * 把 pathfinder 挂在 tick 上的监听**接过来**（见 `setupPathfinder` 里 2026-10-18 崩溃的注释）。
 *
 * 为什么必须接：那个监听（`monitorMovement`）在 vendor 里是裸的，任何一次
 * `placingBlock`/`bot.entity` 是 undefined 都会从 `setInterval` 回调抛到进程级 ——
 * 宿主只对 `unhandledRejection` fail-loud，`uncaughtException` 直接**应用闪退**。
 *
 * 接管后：
 * - 统一挂到新事件 `physicsTick`（vendor 写的是已废弃的 `physicTick`）；
 * - `bot.entity?.position` 不在了（断线/重生一瞬）就跳过这一拍；
 * - 监听里抛错 ⇒ 记一条（每分钟最多一条）+ 停寻路 + 继续跑。
 *
 * @returns {number} 接管了几个监听（0 = 没装上 pathfinder，正常）
 */
export function guardPathfinderTicks (b, { log = null } = {}) {
  if (!b?.on || typeof b.listeners !== 'function') return 0
  const fns = []
  for (const ev of ['physicTick', 'physicsTick']) {
    for (const fn of b.listeners(ev) ?? []) if (typeof fn === 'function' && !fns.includes(fn)) fns.push(fn)
  }
  if (!fns.length) return 0
  for (const ev of ['physicTick', 'physicsTick']) b.removeAllListeners?.(ev)
  let lastLogAt = 0
  for (const fn of fns) {
    b.on('physicsTick', function (...args) {
      if (!b.entity?.position) return
      /* 标记"这一段是寻路插件自己在跑"：只有它发起的挖方块才会被 `guardDoorDig` 换成"开门"。
       * AI 自己调 `mc_dig`/`mc_act{break}` 走的是工具线程，不受影响。 */
      const prev = b.__inPathTick
      b.__inPathTick = true
      try {
        return fn.apply(this, args)
      } catch (e) {
        const now = Date.now()
        if (now - lastLogAt > 60_000) {
          lastLogAt = now
          try { log?.(`寻路 tick 里抛错（已拦住，没让宿主崩）：${e?.stack ?? e?.message ?? e}`) } catch {}
        }
        try { b.pathfinder?.stop?.() } catch {}
      } finally {
        b.__inPathTick = prev
      }
    })
  }
  return fns.length
}

/**
 * 寻路器要挖门时，**改成"把门按开"**（2026-10-18 实机第三次反馈："门还是不行，栅栏门可以"）。
 *
 * 现场：门前停 8 秒（`stuck`，只挪 1.56 格），再叫一次就把门挖了 —— 说明规划里门确实
 * 带着"挖掉"的账，而 vendor 的开门分支（`useOne`）对门本身是坏的（踩坑 #172）。
 * 与其和它的放置状态机较劲，不如在**执行层**拦一道：门/活板门/栅栏门被寻路器要求挖时，
 * 先 `activateBlock` 按开；按开了就当"这一步完成了"，人直接走过去。
 *
 * 只拦**寻路器自己**发起的挖（`b.__inPathTick`）——AI 点名挖门照旧真的挖。
 * 按不开的（铁门/被方块顶住）回落到真挖，至少能脱困。
 */
export function guardDoorDig (b, { log = null } = {}) {
  if (!b || typeof b.dig !== 'function' || b.__dshGuardedDig) return false
  const orig = b.dig.bind(b)
  let lastLogAt = 0
  const say = (m) => {
    const now = Date.now()
    if (now - lastLogAt < 15_000) return
    lastLogAt = now
    try { log?.(m) } catch {}
  }
  /* 门有上下两格：按任意一格都能开关，**按两格 = 开了又关**。
   * 这里统一折算到"门轴那一格"，并按 1.5 秒冷却去重 —— 实机"卡在门外一直开门"就是
   * 400ms 定时器 + 这里各按一次、上下半格再各按一次，来回把门打开又关上。
   * 与 `openNearbyDoor` 共享同一套 key / 冷却 / 在途锁（`b.__doorPressAt` / `b.__doorInFlight`）。 */
  b.dig = function (block, ...rest) {
    const nm = block?.name
    const isDoor = typeof nm === 'string' && DOOR_BLOCK_RE.test(nm) && !IRON_DOOR_RE.test(nm)
    if (!isDoor || !b.__inPathTick) return orig(block, ...rest)
    return (async () => {
      const target = doorFaceOf(b, block) ?? block
      const key = doorBaseKey(target) ?? `${target?.position?.x},${target?.position?.y},${target?.position?.z}`
      const pressAt = b.__doorPressAt instanceof Map ? b.__doorPressAt : (b.__doorPressAt = new Map())
      const inFlight = b.__doorInFlight instanceof Set ? b.__doorInFlight : (b.__doorInFlight = new Set())
      /* 正在按 / 1.5 秒内按过这扇门 ⇒ 当这一步已经完成（别关回去，也别再挖） */
      if (inFlight.has(key)) return
      if (Date.now() - Number(pressAt.get(key) ?? 0) < DOOR_PRESS_COOL_MS) return
      const state = doorOpenStateOf(target)
      if (state === 'open') return                              // 已经开着：这一步当过了
      if (state !== 'closed') return orig(block, ...rest)       // 状态读不到：不猜，照旧处理
      inFlight.add(key)
      pressAt.set(key, Date.now())                              // await 之前就上锁（tick 会重入）
      try {
        await b.activateBlock(target)
        /* 回读确认：确认开了才当"这一步完成"；没确认就回落到真挖（至少能脱困） */
        let after = doorOpenStateOf(typeof b.blockAt === 'function' ? b.blockAt(target.position) : target)
        for (let i = 0; i < 3 && after !== 'open'; i++) {
          await new Promise((r) => setTimeout(r, 50))
          after = doorOpenStateOf(typeof b.blockAt === 'function' ? b.blockAt(target.position) : target)
        }
        if (after === 'open') {
          if (b.__autoOpenedDoors instanceof Map) b.__autoOpenedDoors.set(key, Date.now())
          b.__doorOpens = (b.__doorOpens ?? 0) + 1
          say(`🚪 寻路要挖 ${nm} —— 改成按开（${key}）`)
          return
        }
        say(`🚪 按了 ${nm} 但没确认开门（${after}），回落到挖（${key}）`)
      } catch (e) {
        say(`🚪 按开 ${nm} 失败（回落到挖）：${e?.message ?? e}`)
      } finally {
        inFlight.delete(key)
      }
      return orig(block, ...rest)
    })()
  }
  b.__dshGuardedDig = true
  return true
}

/**
 * 给 `bot.pathfinder.goto` 加一层"拒绝一定有人接"的保险（2026-10-18 第二次闪退）。
 *
 * 崩溃现场：`goto` → `setGoal(null)` → `resetPath` → `stop()` → 发 `path_stop` →
 * **上一次还没走完的 goto** 被 reject 成 `PathStopped`，而它已经没人 await 了
 * （超时先返回、或 collectBlock/pvp 内部先撤）⇒ `unhandledRejection` ⇒
 * 宿主 fail-loud 直接 `exit(1)`（应用闪退）。
 *
 * 做法：包一层 `goto`，对返回的 promise **挂一个空 catch**（只是标记"已处理"，
 * 不改变返回值 —— 调用方自己 `.catch` / `await` 仍然照常收到 reject）。
 */
export function guardPathfinderRejections (b, { log = null } = {}) {
  const pf = b?.pathfinder
  if (!pf || typeof pf.goto !== 'function' || pf.__dshGuardedGoto) return false
  const orig = pf.goto.bind(pf)
  pf.goto = function (...args) {
    const p = orig(...args)
    try {
      p?.catch?.(() => {})
    } catch (e) {
      try { log?.(`给 goto 的拒绝挂 catch 失败：${e?.message ?? e}`) } catch {}
    }
    return p
  }
  pf.__dshGuardedGoto = true
  return true
}

export async function setupPathfinder (self, { spec = null } = {}) {
  const b = self.bot
  if (!b) return false
  if (self.cfg.pathfinder === false) { self.pfReady = false; return false }
  const mod = await loadPathfinder({ log: (m) => self.logDebug(m), logWarn: (m) => self.log(m), spec })
  if (!mod) {
    self.pfReady = false
    self.log('没有可用的 mineflayer-pathfinder（见 dsh-mc-agent/PATHFINDER.md）→ 所有移动已停止，避免盲跳')
    return false
  }
  try {
    if (typeof b.pathfinder?.goto !== 'function') b.loadPlugin(mod.pathfinder)
    /* 2026-10-18 真机崩溃：pathfinder 的 `monitorMovement` 挂在 tick 上，某次
     * `placingBlock`/`bot.entity` 是 undefined ⇒ `TypeError: Cannot read properties of undefined (reading 'y')`
     * 从 setInterval 回调里抛出去 = uncaughtException = **整个 DSH 宿主进程退出**（不是掉线，是应用闪退）。
     * 它同时还在用已废弃的 `physicTick` 事件。这里把它的 tick 监听接过来：
     * ① 换到新事件 `physicsTick`（不再触发弃用警告）② `entity` 还没回来就跳过
     * ③ 抛错时只记日志并停住寻路，绝不让它冒到进程级。 */
    const guarded = guardPathfinderTicks(b, { log: (m) => self.log(m) })
    if (guarded) self.logDebug(`pathfinder tick 已接管（${guarded} 个监听）`)
    guardPathfinderRejections(b, { log: (m) => self.log(m) })
    // 想路线的预算：服务器卡顿时别想太久；搜索半径别放到无限。
    // 🔴 4000 太短了 —— 2026-10-06 实机挖树时频繁 "Took to long to decide path to goal!"，
    //    collectBlock 因此整批失败（改成逐个喂之后至少不会再一坏全坏）。8000 让"目标在高处、
    //    要垫脚才够得着"这类难想的目标有机会想出来，同时仍能及时放弃。
    b.pathfinder.thinkTimeout = Number(self.cfg.pfThinkTimeoutMs ?? 8000)
    b.pathfinder.tickTimeout = 40
    b.pathfinder.searchRadius = Number(self.cfg.pfSearchRadius ?? 192)
    self._pf = mod
    self.pfReady = true
    return true
  } catch (e) {
    self.log('pathfinder 挂载失败：' + e.message)
    self.pfReady = false
    return false
  }
}

/**
 * 造一份 `Movements`（走路 / 寻路 / collectBlock / pvp 共用同一套配置，
 * 免得"我走的时候不乱跳、插件走的时候乱跳"）。
 *
 * `terrain` 是 `classifyTerrain()` 的结果（`src/terrain.mjs`，导航 P2）——
 * 给了它就**按地形挑权重**（台阶上挖便宜一点、沟边垫方块便宜一点、岩浆边一格都不许跳），
 * 不给就退回平地那套（= 改动前的全局值）。用户显式配置永远优先（见 `profileFor` 的 `over`）。
 */
/** 门这类方块：能按开就不该挖（2026-10-18 实机第二次反馈："会开但是不走门那，还是会挖方块"）。 */
export const DOOR_BLOCK_RE = /_(door|trapdoor|fence_gate)$/
/** 铁门/铁活板门要红石，按不开 —— 这条规则不管它们（仍允许挖，至少能脱困）。 */
const IRON_DOOR_RE = /^iron_(door|trapdoor)$/

/**
 * 给 vendor 的 `Movements` 打两个补丁（**只影响规划出来的那条 move**，不改 A*）：
 *
 * ① **别把门算进 `toBreak`**：vendor 的 `getMoveForward` 先
 *    `cost += safeOrBreak(blockB, toBreak)`（门的上半格就是 blockB）—— "穿门"这条路
 *    因此带着一条"把门挖掉"的账；执行到那一步就把门挖了，`canOpenDoors` 只救了门的下半格。
 * ② **门已经开着就不要再 `activateBlock`**：vendor 的 `useOne` 是无条件按一下；
 *    我们 400ms 定时器已经按开了，vendor 再按一次 = **又把门关上**（"开了但不走"）。
 *
 * 只过滤木门/栅栏门/活板门；铁门按不开，保留原行为。
 */
export function patchDoorMoves (mv) {
  if (!mv) return mv
  const doorAt = (node, p) => {
    try { return mv.getBlock?.(node, p.x - node.x, p.y - node.y, p.z - node.z) ?? null } catch { return null }
  }
  const isDoor = (blk) => Boolean(blk?.name && DOOR_BLOCK_RE.test(blk.name) && !IRON_DOOR_RE.test(blk.name))
  /* 把"挖这扇门"的工钱退掉：vendor 的 safeOrBreak 已经把它算进 `m.cost` 了，
   * 只在 toBreak 里删位置而不扣钱，A* 仍然觉得"挖门"和"走门"一样贵 ⇒ 还是选墙。
   * 公式照 `movements.js:290-298`（laborCost = (1 + 3*digTime/1000) * digCost）。 */
  const laborOf = (blk) => {
    try {
      if (!Number.isFinite(mv.digCost) || typeof blk?.digTime !== 'function') return 0
      const tool = mv.bot?.pathfinder?.bestHarvestTool?.(blk)
      const digTime = blk.digTime(tool?.type ?? null, false, false, false, [], {}) || 0
      return (1 + 3 * digTime / 1000) * mv.digCost
    } catch { return 0 }
  }
  const wrap = (name) => {
    const orig = mv[name]
    if (typeof orig !== 'function') return
    mv[name] = function (node, dir, neighbors) {
      const before = Array.isArray(neighbors) ? neighbors.length : 0
      const r = orig.call(this, node, dir, neighbors)
      if (!Array.isArray(neighbors)) return r
      for (let i = before; i < neighbors.length; i++) {
        const m = neighbors[i]
        if (!m) continue
        if (Array.isArray(m.toBreak) && m.toBreak.length) {
          const kept = []
          for (const p of m.toBreak) {
            const blk = doorAt(node, p)
            if (isDoor(blk)) {
              m.cost = Math.max(0, (Number(m.cost) || 0) - laborOf(blk))
              continue
            }
            kept.push(p)
          }
          m.toBreak = kept
        }
        if (Array.isArray(m.toPlace) && m.toPlace.length) {
          /* 🔴 门的 `useOne` **一律删掉**（不管门现在是开是关）。
           * 2026-10-18 第三次闪退/卡门的根因就在这：vendor 的 `monitorMovement`
           * 在 `useOne` 只有一步时 `placingBlock = nextPoint.toPlace.shift()` 会拿到 undefined，
           * 而 `placing` 标志不复位 ⇒ 下一拍读 `placingBlock.y` 抛 TypeError
           * （我们拦住后它停住寻路 ⇒ 表现成"卡在门口、原地不动"）。
           * 门由 `openNearbyDoor`（400ms 探一次、够得着就按）负责开 —— 规划里不需要这一步。 */
          m.toPlace = m.toPlace.filter((p) => !(p?.useOne && isDoor(doorAt(node, p))))
        }
      }
      return r
    }
  }
  wrap('getMoveForward')
  wrap('getMoveJumpUp')
  wrap('getMoveDiagonal')
  return mv
}

export function movements (self, { terrain = null } = {}) {
  const b = self.bot
  const { Movements } = self._pf ?? {}
  if (typeof Movements !== 'function') return null
  const mv = new Movements(b)
  // 地形档案（导航 P2）：先铺一套，再用下面那几行把"跟地形无关的"补上
  const profile = profileFor(terrain?.kind ?? 'unknown', self.cfg)
  /* 2026-10-18 实机（用户："move 遇到门不会开，会直接从墙挖进去"）：
   * vendor 默认 `canOpenDoors = false`（注释：Causes issues），门在 A* 眼里就是实心；
   * 配上 canDig=true ⇒ "挖墙"永远比"绕路"便宜。规划允许穿门，执行由
   * `src/movement.mjs` 的 `openNearbyDoor` 走到门边按一下。 */
  mv.canOpenDoors = true
  /* ⚠️ 2026-10-18 晚：**不要把门塞进 `mv.openable`**。
   * 试过（上一版）——规划里会给门加一步 `useOne`，而 vendor 的
   * `monitorMovement` 在"`useOne` 是最后一步"时会 `shift()` 出 undefined、
   * `placing` 不复位 ⇒ 下一拍读 `placingBlock.y` 抛 TypeError（我们拦住后它停住寻路，
   * 表现就是「卡在门口、原地不动、试三次都不走」）。
   * 现在门一律**不进 `openable`**：规划里门仍算"可挖"，但 `patchDoorMoves` 把它从
   * `toBreak` 删掉并退回挖门的工钱（= 穿门不额外花钱），执行时由 400ms 的
   * `openNearbyDoor` 走到跟前按开。挖墙 vs 走门：门更便宜。 */
  mv.canDig = self.cfg.walkCanDig !== false        // 挡路的方块可以挖穿（不然掉坑里出不来）
  mv.allowSprinting = true
  mv.dontMineUnderFallingBlock = true
  /* 危险方块进寻路黑名单（mc_map 第二轮）：`blocksToAvoid` 决定"这格能不能站"
   * （`movements.js:233` 的 `b.safe`），上游只放了 fire/cobweb/web/lava ——
   * 把仙人掌 / 细雪 / 甜浆果丛 / 岩浆块 / 营火补上，A* 会主动绕开。 */
  for (const id of avoidBlockIds(b)) mv.blocksToAvoid.add(id)
  // 垫方块（pathfinder 的 scaffolding）：上游默认 `placeCost = 1`，比挖一格（4）还便宜 4 倍
  // ⇒ A* 有得垫就垫，下坡时表现为"横向往行进方向垫方块"（`movements.js:372-385` 的
  // `getMoveForward`：斜前方下面那格是空气就计划 toPlace）。平地上调高到 12，让它变成最后手段：
  // 掉进 1 格坑里垫出来那种仍然会垫（那时只有这一条路），下坡时改成绕路 / 挖穿。
  // ⚠️ 不能靠清空 `scafoldingBlocks` 来治 —— `remainingBlocks === 0` 会把
  // `getMoveUp`（1×1 柱子）那条路一起剪掉，机器人就爬不出坑了。
  applyProfile(mv, profile)
  mv.scafoldingBlocks = scaffoldingItemIds(b)      // 背包里能垫的方块（**item id**，见该函数注释）
  /* 2026-10-18：门只许"按开"，不许挖；已经开着就别再按（否则等于关回去）。见 `patchDoorMoves`。 */
  patchDoorMoves(mv)
  return mv
}

/**
 * 按当前地形**重挂**一份 `Movements`（`b.pathfinder.setMovements`），返回
 * `{ terrain, profile, changed }`；没挂上 pathfinder 就回 `null`。
 *
 * 这是"地形变了就换策略"的唯一入口 —— `src/movement.mjs` 每次走路前调它。
 */
export function adaptMovements (self, { feet = null, radius = null } = {}) {
  const b = self.bot
  if (!b?.pathfinder || typeof b.pathfinder.setMovements !== 'function') return null
  if (!self.pfReady) return null
  const terrain = radius == null ? classifyTerrainCached(b, { feet }) : classifyTerrainCached(b, { feet, radius })
  const mv = movements(self, { terrain })
  if (!mv) return null
  try { b.pathfinder.setMovements(mv) } catch { return null }
  const profile = profileFor(terrain.kind, self.cfg)
  return { terrain, profile, mv }
}

/**
 * 我们**自己按开**的门：vendor 的 `useOne` 是无条件 `activateBlock` ——
 * 定时器刚把门按开，它走到门口又按一下，等于**把门关回去**（实机："开了但不走门"）。
 * 这里给 `b.activateBlock` 加一层"最近被我们打开过的门，重复按直接忽略"。
 * 只在 12 秒内、且门**现在确实是开着**时才忽略；别人关了/状态不明就照常按。
 */
export function guardDoorActivate (b) {
  if (!b || typeof b.activateBlock !== 'function' || b.__doorGuard) return b
  const orig = b.activateBlock.bind(b)
  b.__doorGuard = true
  b.__autoOpenedDoors = new Map()
  b.activateBlock = async function (blk, ...rest) {
    const key = blk?.position ? `${Math.floor(blk.position.x)},${Math.floor(blk.position.y)},${Math.floor(blk.position.z)}` : null
    const at = key ? b.__autoOpenedDoors.get(key) : null
    if (key && at && Date.now() - at < 12_000) {
      let open = false
      try { open = blk.getProperties?.().open === true } catch { open = false }
      if (open) { b.__autoOpenedDoors.delete(key); return }
    }
    return orig(blk, ...rest)
  }
  return b
}

/**
 * 把**现成的**生态插件都挂上（`MC_DEPS` 里那几个）。缺哪个只是少那项能力，其它照旧。
 *
 * 顺序有依赖：pathfinder 必须最先（collectBlock / pvp 都要用它的 `Movements`）。
 * 用户 2026-10-06 的要求："不要自己写，用现成的项目" —— 走路/挖/捡/换工具/打怪/吃饭
 * 全部交给 PrismarineJS 生态，`core.mjs` 只留编排和"诚实报错"。
 */
export async function setupPlugins (self, { spec = null } = {}) {
  const b = self.bot
  if (!b) return { pathfinder: false }
  const out = { pathfinder: false, collectBlock: false, tool: false, pvp: false, autoEat: false }
  // 成功细节（"找到了哪个文件"）走 debug：依赖横幅原来每个连接重打一遍，占全日志 31.5%
  const log = (m) => self.logDebug(m)
  const logWarn = (m) => self.log(m)      // 候选不可用 / 形状不对：真出问题时要看得见
  out.pathfinder = await setupPathfinder(self, { spec }).catch((e) => { self.log('pathfinder 初始化异常：' + e.message); return false })
  /* 门：① 规划时别挖门/别重复按（`patchDoorMoves`，在 `movements()` 里）；
   *     ② 执行时"我们刚按开的门"别被 vendor 的 useOne 再按回去（`guardDoorActivate`）。 */
  guardDoorActivate(b)
  guardDoorDig(b, { log: (m) => self.log(m) })
  const mv = self.pfReady ? movements(self) : null

  // ① 走过去挖方块 / 捡掉落物（内部自己用 mineflayer-tool 换工具）
  try {
    const fn = await loadMcDep('collectBlock', { log, logWarn })
    if (fn) {
      if (typeof b.collectBlock?.collect !== 'function') b.loadPlugin(fn)
      if (mv && b.collectBlock) b.collectBlock.movements = mv
      out.collectBlock = typeof b.collectBlock?.collect === 'function'
    }
  } catch (e) { self.log('collectBlock 挂载失败：' + e.message) }

  // ② 按方块挑最好的工具（dig 会用它）
  try {
    const fn = await loadMcDep('tool', { log, logWarn })
    if (fn) {
      if (typeof b.tool?.equipForBlock !== 'function') b.loadPlugin(fn)
      out.tool = typeof b.tool?.equipForBlock === 'function'
    }
  } catch (e) { self.log('tool 挂载失败：' + e.message) }

  // ③ 追击并打怪
  try {
    const fn = await loadMcDep('pvp', { log, logWarn })
    if (fn) {
      if (typeof b.pvp?.attack !== 'function') b.loadPlugin(fn)
      if (mv && b.pvp) b.pvp.movements = mv
      out.pvp = typeof b.pvp?.attack === 'function'
    }
  } catch (e) { self.log('pvp 挂载失败：' + e.message) }

  // ④ 饿了自动吃（**默认不开自动**：由 mc_auto 按自己的开关决定，免得两套逻辑抢）
  try {
    const fn = await loadMcDep('autoEat', { log, logWarn })
    if (fn) {
      if (!b.autoEat) b.loadPlugin(fn)
      if (b.autoEat?.setOpts) {
        b.autoEat.setOpts({
          priority: 'foodPoints',
          minHunger: Number(self.cfg.autoEatAt ?? 14),
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
  } catch (e) { self.log('autoEat 挂载失败：' + e.message) }

  self.mcPlugins = out
  /* ⑤ 修 `bot.digTime`：它是**实际挖掘时长**（不是估算），而上游数据把 108 个"要石镐以上"的方块的
   *    material 写成了 `incorrect_for_wooden_tool` ⇒ 铁矿不管拿什么镐都按 4550ms 挖（真值 750ms）。
   *    见 `src\dig-speed.mjs` 的 `fixDigMs` / `patchDigTime` 注释。失败不影响别的功能。 */
  try { patchDigTime(b) } catch (e) { self.log('修 digTime 失败（不影响其它功能）：' + e.message) }
  const have = Object.entries(out).filter(([, v]) => v).map(([k]) => k)
  // 每个连接都会重打一遍（每个连接是新的模块实例）⇒ 进程内只留一行
  self.logOnce('deps-ready', `现成插件就绪：${have.length ? have.join(' / ') : '（一个都没有）'}`)
  return out
}
