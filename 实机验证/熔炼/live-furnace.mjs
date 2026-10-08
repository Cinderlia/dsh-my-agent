/* 熔炼实机验证：真服上跑 mc_furnace —— 全程正常玩法备料（机器人没有 OP，不能用 /give）
 * 用法：node live-furnace.mjs
 *
 * 两条安全约定（上一版就是在这里拆了玩家的熔炉）：
 *   ① 目标**全部动态找**，不写死坐标 —— 玩家会搬家（2026-10-08 实测出生点从老基地 (4,82,7)
 *      一带挪到了 (-23,64,307)，写死坐标的版本直接跑成"原木 = 0"）。
 *   ② 收尾只拆「树林里**新出现**的」容器/工作台，并且**先把出生点附近的基地容器拉黑**，
 *      绝不碰玩家自己的东西。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')
const furnaceExt = await import('file:///' + PKG + '/extensions/mc_furnace.mjs')
const craftExt = await import('file:///' + PKG + '/extensions/mc_craft.mjs')

const registered = new Map()
const sessions = new Map()
const fakeHost = {
  ctx: { tools: { register: (d) => registered.set(d.name, d), guard: () => {}, get: () => undefined }, on: () => () => {}, get: () => undefined, logger: { info: () => {}, warn: () => {} } },
  config: {},
  registry: { peek: (id) => sessions.get(String(id)), listSessions: () => [] },
  asTool: (s) => s,
  getSession: (e) => sessions.get(String(e?.agent?.id)),
  memory: {}, memoryFor: () => ({}), workspaceOf: () => null,
  logLine: (l) => console.log('[log]', l), Watchdog: class {}, ensureWatchdog: () => {},
}
await furnaceExt.apply(fakeHost)
await craftExt.apply(fakeHost)
const fSpec = registered.get('mc_furnace')
const cSpec = registered.get('mc_craft')
const mc = new McBot({ instanceId: 'live-furnace', lockDir: mkdtempSync(join(tmpdir(), 'live-furnace-')) })
sessions.set('A1', { agentId: 'A1', bot: mc })
const EXEC = { agent: { id: 'A1' } }
const run = (a) => fSpec.execute(a, EXEC)
const craft = (a) => cSpec.execute(a, EXEC)

await mc.connect({ host: '127.0.0.1', port: 25565, auth: { mode: 'offline', name: 'mcfurnace_live' } })
await mc.waitForChunks(20_000)
const bot = mc.requireBot()
const cnt = (n) => bot.inventory.items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0)
const bag = () => bot.inventory.items().map((i) => `${i.name}×${i.count}`).join(' ') || '（空）'
const say = (s) => console.log('\n=== ' + s + ' ===')
const firstLine = (t) => String(t).split('\n')[0]
const FURN_RE = /furnace|smoker|crafting_table/
const here = () => bot.entity.position.floored()

/* 诊断（定位"圆石自己变少"）：背包每次变化都打一行，并记下那一刻在捡什么 */
{
  let last = bag()
  let lastC = cnt('cobblestone')
  const t0 = Date.now()
  const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`
  bot.on('playerCollect', (who, what) => {
    const d = what?.getDroppedItem?.()
    console.log(`  · [${ts()} 捡] ${d?.name ?? what?.name ?? '?'}×${d?.count ?? '?'}`)
  })
  bot.on('death', () => console.log(`  · [${ts()} 💀 我死了]`))
  setInterval(() => {
    const b = bag()
    if (b === last) return
    const c = cnt('cobblestone')
    console.log(`  · [${ts()} 背包] 圆石 ${lastC} → ${c}｜血 ${bot.health}｜位置 ${here().x},${here().y},${here().z}`)
    last = b
    lastC = c
  }, 300)
}

/** 半径内找方块，按"离我多远"从近到远（findBlocks 返回的是坐标，不是方块对象） */
const near = (pred, maxDistance = 48, count = 64) => {
  const me = bot.entity.position
  return bot.findBlocks({ matching: pred, maxDistance, count })
    .map((p) => bot.blockAt(p)).filter(Boolean)
    .sort((a, b) => me.distanceTo(a.position) - me.distanceTo(b.position))
}
const containersNear = (r) => near((b) => FURN_RE.test(b?.name ?? ''), r).map((b) => `${b.name}@${b.position.x},${b.position.y},${b.position.z}`)

/* 出生点一带是**水塘区**（2026-10-08 实测：机器人一到树边就落水，`onGround === false` ⇒ 挖掘守卫
 * 如实拒绝"还在空中（没落地）"）。所以挑树的标准不是"最近"，而是"树干旁边有干地落脚点"：
 * 脚/头两格是 air、下面那格是固体，且这三格都不是水/岩浆。 */
const Vec3 = bot.entity.position.constructor
const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
const WET = /water|lava/
const solidAt = (b) => Boolean(b) && b.name !== 'air' && !WET.test(b.name) && b.boundingBox !== 'empty'
const drySpotNear = (log, r = 3) => {
  const p = log.position
  const me = bot.entity.position
  const cand = []
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (Math.abs(dx) + Math.abs(dz) > r || (dx === 0 && dz === 0)) continue
      for (let dy = -1; dy <= 2; dy++) {
        const y = p.y + dy
        const foot = at(p.x + dx, y, p.z + dz)
        const head = at(p.x + dx, y + 1, p.z + dz)
        const below = at(p.x + dx, y - 1, p.z + dz)
        if (!foot || !head || !below) continue
        if (foot.name !== 'air' || head.name !== 'air') continue
        if (!solidAt(below)) continue
        cand.push({ x: p.x + dx, y, z: p.z + dz, d: me.distanceTo(new Vec3(p.x + dx, y, p.z + dz)) })
      }
    }
  }
  return cand.sort((a, c) => a.d - c.d)[0] ?? null
}
bot.on('message', (m) => { const s = m.toString().trim(); if (s) console.log('[chat]', s) })

/* 🔴 先确认自己没泡在水里（2026-10-08 实测）：上一轮跑完机器人沉在 (-30,54,261) 的水坑底，
 *    氧气掉到 -1、`mc_dig` 因为"水里挖方块慢 5 倍"当场拒绝 ⇒ 后面全部连锁失败（原木 0、
 *    合成全缺料、石头被工具守卫拦）。`swimUp()` 实测 2.7 秒升 8.89 格并出水。
 *    ⚠️ `bot.entity.isInWater` 浮在水面时读出来是 false，所以眼那格也要看。 */
const inWaterNow = () => Boolean(bot.entity.isInWater) || /water/.test(bot._getBlockAtEyeLevel?.()?.name ?? '')

say('连上了')
console.log('模式', bot.game.gameMode, '｜位置', JSON.stringify(here()), '｜背包', bag())

if (inWaterNow()) {
  say('我泡在水里（会一直往下沉），先上浮换气')
  console.log(JSON.stringify(await mc.swimUp({ hold: 3_000 })))
  console.log('位置', JSON.stringify(here()), '｜还在水里', inWaterNow())
}

/* 先把出生点附近的基地容器拉黑（玩家的东西，收尾绝不碰） */
const protectedSet = new Set(containersNear(24))
console.log('出生点 24 格内的基地容器（拉黑）：', [...protectedSet].join(' ') || '（没有）')

/* 走不到就接着走：walkTo 单次只走一轮预算（约 10 秒），AI 在实机上也是反复叫 mc_move */
const approach = async (pos, { arrive = 2, tries = 5 } = {}) => {
  let last = null
  for (let i = 1; i <= tries; i++) {
    // 泡在水里就走不动（A* 不把水当节点）：先上浮出水，再交给寻路
    if (inWaterNow()) {
      try { await mc.swimUp({ hold: 2_500 }) } catch (e) { console.log(`  第 ${i} 次走：上浮抛错 ${e.message}`) }
    }
    try { last = await mc.walkTo({ x: pos.x, y: bot.entity.position.floored().y, z: pos.z }, { arrive, budget: 30_000 }) }
    catch (e) { console.log(`  第 ${i} 次走：抛错 ${e.message}`); continue }
    const left = bot.entity.position.distanceTo(pos)
    console.log(`  第 ${i} 次走：arrived=${last.arrived} remaining=${last.remaining ?? '-'} moved=${last.moved ?? '-'} reason=${last.reason ?? '-'}（实测还差 ${left.toFixed(1)} 格）`)
    if (left <= arrive + 0.6) return last
    if ((last.moved ?? 0) < 0.6 && i >= 3) return last
  }
  return last
}

/* ── A 只读 / 失败路径 ── */
say('A1 mc_furnace {list:true}')
console.log((await run({ list: true })).text)
say('A2 mc_furnace {name:"apple"}')
console.log(firstLine((await run({ name: 'apple' })).text))
say('A3 mc_furnace {name:"raw_gold"}（背包里没有）')
console.log((await run({ name: 'raw_gold' })).text)

/* ── B 备料（动态找目标，不写死坐标） ── */
say('B0 先出水，再走到有树的地方')
/* 2026-10-08 实测：机器人登出的位置在 (-31,59,261) —— **一个水塘底**（那一列 y=53..62 全是 water），
 * 附近 64 格只有 1 根原木、还泡在水下；往 +z 走 8 轮 ×12 格之后是片林子（z≈356 有 64 根原木）。
 * 所以 B0 分两步：① 在水里就先上浮（`swimUp` 修完判据后实测 0.8 秒升 3 格出水）；
 * ② 一轮一轮走，直到找到"树干旁边有干地落脚点"的树。 */
if (inWaterNow()) {
  console.log('我泡在水里，先上浮：', JSON.stringify(await mc.swimUp({ hold: 3_000 })))
  console.log('位置', JSON.stringify(here()), '｜在水里', inWaterNow())
}
let tree = null
let spot = null
for (let i = 1; i <= 12 && !tree; i++) {
  const logs = near((b) => /_log$/.test(b?.name ?? ''), 48, 64)
  for (const lg of logs) { const s = drySpotNear(lg); if (s) { tree = lg; spot = s; break } }
  if (tree) { console.log(`第 ${i} 轮：找到能站的树（附近有 ${logs.length} 根原木）`); break }
  const me = bot.entity.position.floored()
  let r = null
  try { r = await mc.walkTo({ x: me.x, y: me.y, z: me.z + 12 }, { arrive: 2 }) } catch (e) { console.log(`第 ${i} 轮走抛错：${e.message}`); continue }
  console.log(`第 ${i} 轮：附近没有"旁边有干地"的树（只有 ${logs.length} 根），往 +z 走 12 格 → arrived=${r.arrived} moved=${r.moved} reason=${r.reason ?? '-'}｜位置 ${JSON.stringify(here())}`)
}
if (!tree) { console.log('❌ 走了 12 轮也没找到能站的树，没法备料'); await mc.disconnect('没树'); process.exit(1) }
const logName = tree.name
const species = logName.replace(/_log$/, '')
console.log(`挑中的树：${logName}@${tree.position.x},${tree.position.y},${tree.position.z}（离我 ${bot.entity.position.distanceTo(tree.position).toFixed(1)} 格）｜落脚点 (${spot.x},${spot.y},${spot.z})`)
await approach({ x: spot.x, y: spot.y, z: spot.z }, { arrive: 1.6, tries: 5 })
console.log('位置', JSON.stringify(here()), '｜落地', bot.entity.onGround, '｜在水里', inWaterNow())
const woodsBefore = new Set(containersNear(8))
console.log('位置', JSON.stringify(here()), '｜这一带原有容器/工作台：', [...woodsBefore].join(' ') || '（没有）')

say(`B1 徒手挖 ${logName} ×6`)
/* 站好之后**重新挑一根**：同一棵树里选"离我眼睛最近"的那根原木 —— 实测站在树干下、目标在脚下
 * 两格时 `bot.dig()` 会等不到服务端回执（11 秒超时），挑同一层/上面的原木最稳。 */
const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
/* 🔴 `findBlocks` 的 matching 会被**没有 position 的 Block 原型**调用（mineflayer blocks.js
 *    `isBlockInSection` 用 `Block.fromStateId` 造对象扫调色板，position 是 null）⇒
 *    判据里**绝不能碰 `.position`**，只能按名字筛，位置在 `near()` 转回真方块之后再过滤。 */
const sameTree = near((b) => b?.name === logName, 24, 64)
  .filter((b) => Math.abs(b.position.x - tree.position.x) <= 2 && Math.abs(b.position.z - tree.position.z) <= 2)
const pickLog = sameTree.slice().sort((a, c) => eye.distanceTo(a.position.offset(0.5, 0.5, 0.5)) - eye.distanceTo(c.position.offset(0.5, 0.5, 0.5)))[0] ?? tree
console.log(`  这一棵树有 ${sameTree.length} 根原木，挑 ${pickLog.position}（眼睛到中心 ${eye.distanceTo(pickLog.position.offset(0.5, 0.5, 0.5)).toFixed(2)} 格）`)
try {
  // 一轮 11 秒挖不完 6 根（一轮常常只够 3 根）⇒ 接着叫，直到够 6 根或没得挖
  for (let round = 1; round <= 3 && cnt(logName) < 6; round++) {
    console.log(`  [${round}] ` + JSON.stringify(await mc.dig({ name: logName, count: 6 - cnt(logName), maxDistance: 16 })).slice(0, 400))
    if (cnt(logName) >= 6) break
    const left = near((b) => b?.name === logName, 16, 32).length
    if (left === 0) { console.log('  附近没原木了，停'); break }
  }
} catch (e) { console.log('挖失败：' + e.message) }
console.log('原木 =', cnt(logName))
if (cnt(logName) === 0) {
  console.log('  诊断：目标', JSON.stringify(pickLog.position), '现在 blockAt =', bot.blockAt(pickLog.position)?.name,
    '｜我', JSON.stringify(here()), '｜手上', bot.heldItem?.name ?? '空')
  for (const l of sameTree.slice(0, 6)) console.log('   同树原木', JSON.stringify(l.position), '→', bot.blockAt(l.position)?.name)
}

say('B2 合成木板 ×8 / 工作台 / 木镐')
if (cnt(logName) > 0) console.log('  ' + firstLine((await craft({ name: `${species}_planks`, count: 8 })).text))
if (cnt('crafting_table') === 0) console.log('  ' + firstLine((await craft({ name: 'crafting_table', count: 1 })).text))
if (cnt('wooden_pickaxe') + cnt('stone_pickaxe') + cnt('iron_pickaxe') === 0) {
  console.log('  ' + firstLine((await craft({ name: 'wooden_pickaxe', count: 1 })).text))
}
console.log('背包', bag())

say('B3 挖石头 ×8 → 合成熔炉')
const pick = cnt('wooden_pickaxe') + cnt('stone_pickaxe') + cnt('iron_pickaxe')
if (pick === 0) console.log('  ⚠️ 没镐，挖不了石头（工具守卫会拦）')
else {
  const st = near((b) => b?.name === 'stone', 32, 32)[0]
  if (st) console.log(`  最近的石头 ${st.position.x},${st.position.y},${st.position.z}（${bot.entity.position.distanceTo(st.position).toFixed(1)} 格，我脚下 y=${here().y}）`)
  // 一轮挖不完（11 秒预算）就接着叫 —— 熔炉要 8 个圆石，一轮常常只够挖 3~5 个
  for (let round = 1; round <= 4 && cnt('cobblestone') < 8; round++) {
    try { console.log(`  [${round}] ` + JSON.stringify(await mc.dig({ name: 'stone', count: 8 - cnt('cobblestone'), maxDistance: 16 })).slice(0, 200)) }
    catch (e) { console.log('  挖石头失败：' + e.message) }
    if (cnt('cobblestone') < 8) {   // 石头在地下：先往下挖开一层
      console.log(`  圆石 = ${cnt('cobblestone')}（还不够 8），先往下挖开一层（dirt）再试`)
      try { console.log('  ' + JSON.stringify(await mc.dig({ name: 'dirt', count: 3, maxDistance: 4 })).slice(0, 160)) } catch (e) { console.log('  挖土失败：' + e.message) }
    }
  }
}
console.log('圆石 =', cnt('cobblestone'))
if (cnt('cobblestone') >= 8) console.log('  ' + firstLine((await craft({ name: 'furnace', count: 1 })).text))
console.log('背包', bag())

/* ── C 真烧 ── */
say('C1 dryRun')
console.log((await run({ name: logName, count: 2, dryRun: true })).text)

say(`C2 真烧 ${logName} ×2（radius:1 逼它自己放熔炉）`)
const t2 = Date.now()
console.log((await run({ name: logName, count: 2, radius: 1 })).text)
console.log(`→ 耗时 ${((Date.now() - t2) / 1000).toFixed(1)}s｜木炭 ${cnt('charcoal')}｜原木剩 ${cnt(logName)}｜木板剩 ${cnt(`${species}_planks`)}`)

say('C3 等 26 秒让这一炉烧完（2 个 ×10 秒；mc_furnace 默认"装好就返回"、不盯炉子）')
await new Promise((r) => setTimeout(r, 26_000))

say('C4 takeOnly（radius 故意给小 = 1，验证"记得上次那个熔炉"）')
console.log((await run({ name: 'charcoal', takeOnly: true, radius: 1 })).text)
console.log(`→ 木炭 ${cnt('charcoal')}`)

say('C5 写产物名也能烧：mc_furnace {name:"charcoal", count:1}（连续使用同一个熔炉）')
const t4 = Date.now()
console.log((await run({ name: 'charcoal', count: 1 })).text)
console.log(`→ 耗时 ${((Date.now() - t4) / 1000).toFixed(1)}s｜木炭 ${cnt('charcoal')}｜原木剩 ${cnt(logName)}`)

say('C6 再等 14 秒，取 C5 那一个')
await new Promise((r) => setTimeout(r, 14_000))
console.log((await run({ name: 'charcoal', takeOnly: true })).text)
console.log(`→ 木炭 ${cnt('charcoal')}｜原木剩 ${cnt(logName)}｜木板剩 ${cnt(`${species}_planks`)}`)

/* ── D 收尾：只拆自己在树林里新放的（基地容器已拉黑） ── */
say('D 收尾（只动新出现的，绝不碰玩家基地）')
const mine = containersNear(8).filter((s) => !woodsBefore.has(s) && !protectedSet.has(s))
console.log('要拆：', mine.join(' ') || '（没有）')
for (const s of mine) {
  const [name, xyz] = s.split('@')
  const [x, y, z] = xyz.split(',').map(Number)
  try {
    const p = bot.entity.position.clone(); p.x = x; p.y = y; p.z = z
    const blk = bot.blockAt(p)
    if (!blk || blk.name !== name) continue
    if (bot.entity.position.distanceTo(blk.position) > 3.5) await mc.walkTo({ x, y, z }, { arrive: 2.5, budget: 30_000 })
    const fresh = bot.blockAt(p)
    if (fresh && fresh.name === name) { await bot.dig(fresh); console.log('  挖掉自己放的', name, xyz) }
  } catch (e) { console.log('  拆失败 ' + name + '：' + e.message) }
}
console.log('收尾后这一带：', containersNear(8).join(' ') || '（没有）')
console.log('背包', bag())
await mc.disconnect('测试结束')
process.exit(0)
