/**
 * live-useitem.mjs —— "对着空气用手上的东西"（`useItem`）的实机验证：真服 + 真发包
 *
 * 为什么必须实机：离线套件只能证明"`activateItem` / `deactivateItem` 被调了、时序对"，
 * **证明不了服务端真的把这次 `use_item` 当回事**。要证明，得有一个**服务端侧看得见的副作用**：
 *
 *   A 真扔（最强证据）：背包里有雪球 / 鸡蛋 / 末影珍珠 / 末影之眼 / 喷溅药水 / 经验瓶
 *     ⇒ 用一次之后 **背包里那个东西少一个**，而且 `bot.entities` 里**多出一个投掷物实体**。
 *   A2 真射（验证 hold）：有弓 + 有箭 ⇒ `hold:1000` 拉弓再松手 ⇒ **箭少一个**、多出一个 arrow 实体。
 *   A3 只有弓没有箭 ⇒ 拉弓松手不炸、弓不被消耗（射不出去是正常的）。
 *   B 什么都没有 ⇒ **如实报"这一轮验不成"**，不谎报成功。
 *
 * 已知的**反面结论**（第 2 次实机跑出来的，别再拿它当证据）：
 *   1.21 上光发 `use_item`（`activateItem`）**不会放置方块** —— 放方块走的是
 *   `player_block_placement` 包（face / cursor / sequence），也就是 mineflayer 的
 *   `placeBlock` / `_placeBlockWithOptions`，正是 `mc_act {mode:"place"}` 好用的原因。
 *   所以"挖一块土再用手上的东西放回去"**不能**用来证明 `use_item` 生效。
 *
 * 背包空 + 附近没雪时拿不到可扔物，所以本脚本会**在游戏里喊一句**、然后等玩家给
 * （创造模式：`/give wcuse_live snowball 16`，或者直接把东西丢到机器人脚下）。
 *
 * 用法：node live-useitem.mjs [--wait=180]
 * 产物：同目录 live-useitem.log
 */
import { createRequire } from 'node:module'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const HOST = '127.0.0.1'
const PORT = 25565
const NAME = 'wcuse_live'
const OUT = 'C:/Users/BLUE/Desktop/agent/dsh-mc-agent/实机验证/用物品'
/** 上一轮 B 档（放置）挖出来没填回去的那个坑 */
const LEFTOVER = { x: -177, y: 69, z: 277, was: 'grass_block' }

const WAIT_SEC = Math.max(0, Number((process.argv.find((a) => a.startsWith('--wait=')) ?? '').split('=')[1]) || 180)

const req = createRequire('file:///C:/Users/BLUE/.dsh/profiles/desktop/node_modules/mineflayer/index.js')
const Vec3 = req('vec3')
const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')
const craftExt = await import('file:///' + PKG + '/extensions/mc_craft.mjs')

const LOGFILE = join(OUT, 'live-useitem.log')
try { writeFileSync(LOGFILE, '') } catch { /* 忽略 */ }
const log = (...a) => {
  const s = `[${new Date().toISOString().slice(11, 19)}] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(s)
  try { appendFileSync(LOGFILE, s + '\n') } catch { /* 忽略 */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const posStr = (p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)})`
const countOf = (bot, n) => bot.inventory.items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0)
const invText = (bot) => bot.inventory.items().map((i) => `${i.name}×${i.count}`).join(' ') || '（空）'

const THROW = ['snowball', 'egg', 'ender_pearl', 'eye_of_ender', 'splash_potion', 'lingering_potion', 'experience_bottle', 'firework_rocket']
const PROJECTILE = ['snowball', 'egg', 'ender_pearl', 'eye_of_ender', 'potion', 'splash_potion', 'experience_bottle', 'firework_rocket', 'arrow', 'trident']

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => log(`\n${t}`)

/* ───────────────── 假宿主：只挂 mc_craft ───────────────── */
const registered = new Map()
const craftSessions = new Map()
await craftExt.apply({
  ctx: {
    tools: { register: (d) => registered.set(d.name, d), guard: () => {}, get: () => undefined },
    on: () => () => {},
    get: () => undefined,
    logger: { info: () => {}, warn: (m) => log('[craft warn]', String(m)) },
  },
  config: {},
  registry: { peek: (id) => craftSessions.get(String(id)), listSessions: () => [...craftSessions.values()] },
  asTool: (s) => s,
  getSession: (exec) => craftSessions.get(String(exec?.agent?.id)),
  memory: {}, memoryFor: () => ({}), workspaceOf: () => null,
  logLine: (l) => log('[craft]', String(l)),
  ensureWatchdog: () => {},
  Watchdog: class {},
})
const craftTool = registered.get('mc_craft')

/* ───────────────── 连服 ───────────────── */
const mc = new McBot({
  instanceId: 'live-useitem',
  lockDir: mkdtempSync(join(tmpdir(), 'wc-useitem-')),
  logFile: join(OUT, 'live-useitem-core.log'),
})
craftSessions.set('live', mc)

log(`连 ${HOST}:${PORT}（${NAME}）…`)
await mc.connect({ host: HOST, port: PORT, auth: { mode: 'offline', name: NAME } })
const bot = mc.bot
log(`连上了：${posStr(bot.entity.position)} 维度=${bot.game?.dimension} 模式=${bot.game?.gameMode} 血=${bot.health}`)
log(`附近玩家：${Object.values(bot.players ?? {}).filter((p) => p.username && p.username !== bot.username).map((p) => p.username).join(' / ') || '（没有）'}`)
log(`背包：${invText(bot)}`)

/* ───────────────── ⓪ 先补上一轮挖出来的坑 ───────────────── */
section('⓪ 补上一轮留下的坑（用 mc_act{place} 走 player_block_placement，这条一直好用）')
try {
  const blk = bot.blockAt(new Vec3(LEFTOVER.x, LEFTOVER.y, LEFTOVER.z))
  if (blk && blk.name === 'air') {
    const have = ['dirt', 'grass_block', 'cobblestone', 'stone'].find((n) => countOf(bot, n) > 0)
    if (have) {
      // 先走开 3 格再放：站在坑边上放不进去 —— 那一格和自己的身体相交，服务端会拒
      // （报 "the block is still air"，第 3 次跑踩到的）
      const away = new Vec3(LEFTOVER.x + 3, LEFTOVER.y, LEFTOVER.z)
      log(`先走开到 ${posStr(away)}（站坑边上放会被服务端拒：方块和自己的 AABB 相交）…`)
      try { await mc.walkTo({ x: away.x, y: away.y, z: away.z }, { arrive: 1.5, budget: 4000 }) } catch (e) { log(`走开失败：${e?.message}`) }
      await sleep(300)
      const r = await mc.placeBlock({ x: LEFTOVER.x, y: LEFTOVER.y, z: LEFTOVER.z, name: have })
      await sleep(500)
      const now = bot.blockAt(new Vec3(LEFTOVER.x, LEFTOVER.y, LEFTOVER.z))
      log(`用 ${have} 填 ${LEFTOVER.x},${LEFTOVER.y},${LEFTOVER.z} → ${now?.name}（${JSON.stringify(r)?.slice(0, 80)}）`)
    } else log(`想填 ${LEFTOVER.x},${LEFTOVER.y},${LEFTOVER.z} 但背包里没有土/石`)
  } else log(`${LEFTOVER.x},${LEFTOVER.y},${LEFTOVER.z} 现在是 ${blk?.name ?? '读不到'}，不用填`)
} catch (e) { log(`填坑失败：${e?.message}`) }

/* ───────────────── ① 侦察 + 等玩家给东西 ───────────────── */
section('① 侦察 —— 背包里有什么可扔的')
log(`背包：${invText(bot)}`)
let item = THROW.find((n) => countOf(bot, n) > 0) ?? null
let bow = countOf(bot, 'bow') > 0
let arrows = countOf(bot, 'arrow')
log(`可扔物：${item ?? '（没有）'}｜弓：${bow ? '有' : '没有'}｜箭：${arrows}`)

if (!item && !bow && WAIT_SEC > 0) {
  const msg = `我要测「用手上的东西」：请给我一个雪球或鸡蛋（创造模式 /give ${NAME} snowball 16，或者丢到 ${posStr(bot.entity.position)} 我脚下）。等 ${WAIT_SEC} 秒。`
  try { bot.chat(msg) } catch (e) { log(`喊话失败：${e?.message}`) }
  log(`已喊话，等 ${WAIT_SEC} 秒…`)
  const t0 = Date.now()
  let lastLeft = WAIT_SEC
  while (Date.now() - t0 < WAIT_SEC * 1000) {
    await sleep(1000)
    item = THROW.find((n) => countOf(bot, n) > 0) ?? null
    bow = countOf(bot, 'bow') > 0
    arrows = countOf(bot, 'arrow')
    if (item || bow) break
    const left = WAIT_SEC - Math.round((Date.now() - t0) / 1000)
    if (left % 30 === 0 && left !== lastLeft) { lastLeft = left; log(`…还在等（剩 ${left}s）背包：${invText(bot)}`) }
  }
  log(`等完了。背包：${invText(bot)}`)
}

/* ───────────────── ② 真用一次 ───────────────── */
section('② 真用一次 —— 看服务端认不认')
if (!item && !bow) {
  log('✗ 背包里没有可扔物、也没有弓，这一轮**验不成**（不谎报成功）')
  log('  要真验：让玩家 /give wcuse_live snowball 16，或者丢一个雪球/鸡蛋到机器人脚下，再跑一次')
  fail++
} else {
  const isBow = !item && bow
  const use = isBow ? 'bow' : item
  const hold = isBow ? 1000 : 0
  const before = countOf(bot, use)
  const projBefore = new Set(Object.values(bot.entities ?? {}).filter((e) => PROJECTILE.includes(e?.name)).map((e) => e.id))
  try {
    await mc.equip({ name: use })
    ok(bot.heldItem?.name === use, `equip 成功（手上是 ${bot.heldItem?.name}）`)
    // 朝上一点扔，免得一出手就撞地
    await bot.lookAt(bot.entity.position.offset(0, 3, 0).offset(0, 0, 0), true).catch(() => {})
    await sleep(150)
    mc.setCallDeadline(5000)
    const t0 = Date.now()
    const r = await mc.useItem({ hold })
    const ms = Date.now() - t0
    log(`useItem(${JSON.stringify({ hold })} 返回：${JSON.stringify(r)}（${ms}ms）`)
    ok(r?.used === use, '返回里 used 是这一件', String(r?.used))
    ok(Number.isFinite(r?.heldMs), '返回里有 heldMs', String(r?.heldMs))
    if (isBow) ok(r?.heldMs === 1000, '弓按满 1000ms 再松手', `heldMs=${r?.heldMs}`)
    ok(ms < 3000, '单次调用在 3 秒内返回（≤5 秒规则）', `${ms}ms`)

    // 投掷物实体是服务端生的：500ms 内轮询几次
    let seen = null
    for (let i = 0; i < 6 && !seen; i++) {
      await sleep(120)
      const now = Object.values(bot.entities ?? {}).filter((e) => PROJECTILE.includes(e?.name) && !projBefore.has(e.id))
      if (now.length) seen = now[0]
    }
    await sleep(600)
    const after = countOf(bot, use)
    if (isBow) {
      if (arrows > 0) {
        ok(after === before, '弓本身不被消耗', `${before} → ${after}`)
        ok(countOf(bot, 'arrow') === arrows - 1, `射出去了：箭 ${arrows} → ${countOf(bot, 'arrow')}`, `实体=${seen?.name ?? '没看到'}`)
      } else {
        ok(after === before, '没箭时拉弓松手不消耗弓、也不炸', `${before} → ${after}`)
        log(`· 只有弓没有箭 ⇒ 射不出去是正常的（要真射还得有箭）`)
      }
    } else {
      ok(after === before - 1, `服务端真的接受了这次 use_item：${use} ${before} → ${after}`, `before=${before} after=${after}`)
      ok(Boolean(seen), '服务端生成了投掷物实体', seen ? `${seen.name} id=${seen.id} @${posStr(seen.position)}` : '500ms 内没看到（可能飞太快/已消失）')
    }
  } catch (e) {
    fail++
    log(`✗ useItem 抛错：${e?.message}`)
  }
}

/* ───────────────── ③ 收尾 ───────────────── */
section('③ 收尾')
try {
  const now = bot.blockAt(new Vec3(LEFTOVER.x, LEFTOVER.y, LEFTOVER.z))
  log(`${LEFTOVER.x},${LEFTOVER.y},${LEFTOVER.z} 现在是：${now?.name ?? '读不到'}（净变化：${now?.name && now.name !== 'air' ? '0' : '1 个坑'}）`)
} catch { /* 忽略 */ }
log(`背包最终：${invText(bot)}`)
try { await mc.disconnect('实机验证结束') } catch { /* 忽略 */ }
await sleep(300)
log(`\n结论：pass=${pass} fail=${fail} 物品=${item ?? (bow ? 'bow' : '无')}`)
process.exit(fail === 0 ? 0 : 1)
