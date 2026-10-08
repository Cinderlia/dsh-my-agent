/* 存取箱子实机验证：真服上跑 mc_chest —— 全程正常玩法备料（机器人没有 OP，不能用 /give）
 * 用法：node live-chest.mjs
 * 安全约定：只动「自己在树林里放的那个箱子」；**绝不碰基地**（那里有玩家的熔炉/工作台）
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')
const chestExt = await import('file:///' + PKG + '/extensions/mc_chest.mjs')
const craftExt = await import('file:///' + PKG + '/extensions/mc_craft.mjs')

const registered = new Map()
const sessions = new Map()
const mkApi = () => ({
  ctx: { tools: { register: (d) => registered.set(d.name, d), guard: () => {}, get: () => undefined }, on: () => () => {}, get: () => undefined, logger: { info: () => {}, warn: () => {} } },
  config: {},
  registry: { peek: (id) => sessions.get(String(id)), listSessions: () => [] },
  asTool: (s) => s,
  getSession: (e) => sessions.get(String(e?.agent?.id)),
  memory: {}, memoryFor: () => ({}), workspaceOf: () => null,
  logLine: (l) => console.log('[log]', l), Watchdog: class {}, ensureWatchdog: () => {},
})
await chestExt.apply(mkApi())
await craftExt.apply(mkApi())
const chSpec = registered.get('mc_chest')
const cSpec = registered.get('mc_craft')
const mc = new McBot({ instanceId: 'live-chest', lockDir: mkdtempSync(join(tmpdir(), 'live-chest-')) })
sessions.set('A1', { agentId: 'A1', bot: mc })
const EXEC = { agent: { id: 'A1' } }
const run = (a) => chSpec.execute(a, EXEC)
const craft = (a) => cSpec.execute(a, EXEC)

await mc.connect({ host: '127.0.0.1', port: 25565, auth: { mode: 'offline', name: 'mcchest_live' } })
await mc.waitForChunks(20_000)
const bot = mc.requireBot()
const cnt = (n) => bot.inventory.items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0)
const bag = () => bot.inventory.items().map((i) => `${i.name}×${i.count}`).join(' ') || '（空）'
const say = (s) => console.log('\n=== ' + s + ' ===')
const firstLine = (t) => String(t).split('\n')[0]
const scan = (re, r = 4) => {
  const base = bot.entity.position.floored()
  const out = []
  for (let dx = -r; dx <= r; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -r; dz <= r; dz++) {
    const b = bot.blockAt(base.offset(dx, dy, dz))
    if (b && re.test(b.name)) out.push(`${b.name}@${b.position.x},${b.position.y},${b.position.z}`)
  }
  return out
}
const firstLineOf = (t) => String(t).split('\n')[0]
bot.on('message', (m) => { const s = m.toString().trim(); if (s) console.log('[chat]', s) })

say('连上了')
console.log('模式', bot.game.gameMode, '｜位置', JSON.stringify(bot.entity.position.floored()), '｜背包', bag())

/* ── A 只读 / 失败路径 ── */
say('A1 mc_chest {action:"list"}')
console.log((await run({ action: 'list' })).text)

say('A2 action 写错')
console.log(firstLineOf((await run({ action: 'dump', name: 'coal' })).text))

say('A3 put 既没 name 也没 all')
console.log(firstLineOf((await run({ action: 'put' })).text))

say('A4 put 一个背包里没有的东西')
console.log((await run({ action: 'put', name: 'diamond' })).text)

/* ── B 去树林备料：原木 → 木板 → 工作台 → 箱子 ── */
say('B0 找一棵好走的树')
const p0 = bot.entity.position.clone()
const logs = bot.findBlocks({ matching: (b) => b?.name === 'jungle_log' || b?.name === 'oak_log', maxDistance: 48, count: 60 })
const byTrunk = new Map()
for (const t of logs) {
  const k = `${t.x},${t.z}`
  if (!byTrunk.has(k)) byTrunk.set(k, [])
  byTrunk.get(k).push(t)
}
const vecAt = (x, y, z) => { const v = p0.clone(); v.x = x; v.y = y; v.z = z; return v }
const trunks = [...byTrunk.entries()].map(([k, list]) => {
  const [x, z] = k.split(',').map(Number)
  const ys = list.map((t) => t.y).sort((a, b) => a - b)
  return { k, x, z, n: list.length, ys, name: bot.blockAt(vecAt(x, ys[0], z))?.name ?? 'jungle_log', d: Math.hypot(x + 0.5 - p0.x, z + 0.5 - p0.z) }
}).filter((t) => t.n >= 2).sort((a, b) => (a.d + 4 * Math.abs(a.ys[0] - p0.y)) - (b.d + 4 * Math.abs(b.ys[0] - p0.y)))
for (const t of trunks.slice(0, 6)) console.log(`   ${t.k}  ${t.name} n=${t.n}  y=${t.ys[0]}..${t.ys[t.ys.length - 1]}  距离 ${t.d.toFixed(1)}  Δy=${(t.ys[0] - p0.y).toFixed(0)}`)
const boxesBefore = new Set(scan(/chest|barrel|shulker_box|crafting_table/, 8))
console.log('出发前背包', bag())

say('B1 挖原木（一棵一棵来，每挖一块核对背包）')
for (const t of trunks.slice(0, 4)) {
  if (cnt('chest') > 0) { console.log('  （背包里已经有箱子了，跳过备料）'); break }
  if (cnt('jungle_log') + cnt('oak_log') >= 6) break
  try { await mc.walkTo({ x: t.x, y: t.ys[0], z: t.z }, { arrive: 2, budget: 60_000 }) } catch (e) { console.log('  走到 ' + t.k + ' 失败：' + e.message) }
  for (let i = 0; i < t.n && cnt('jungle_log') + cnt('oak_log') < 6; i++) {
    const before = cnt('jungle_log') + cnt('oak_log')
    try {
      const r = await mc.dig({ name: t.name, count: 1, maxDistance: 6 })
      const after = cnt('jungle_log') + cnt('oak_log')
      console.log(`  ${t.k} 第 ${i + 1} 块 → ${JSON.stringify(r).slice(0, 90)}｜原木 ${before}→${after}`)
      if (after === before) break
    } catch (e) { console.log('  挖失败：' + e.message); break }
  }
}
console.log('原木 =', cnt('jungle_log') + cnt('oak_log'), '｜背包', bag())

say('B2 合成木板 ×12 → 工作台 → 箱子 ×1')
const logName = cnt('jungle_log') > 0 ? 'jungle_log' : 'oak_log'
if (cnt('chest') === 0 && cnt(logName) > 0) console.log('  ' + firstLine((await craft({ name: logName.replace('_log', '_planks'), count: 12 })).text))
console.log('  背包', bag())
if (cnt('crafting_table') === 0) console.log('  ' + firstLine((await craft({ name: 'crafting_table', count: 1 })).text))
console.log('  背包', bag())
if (cnt('chest') === 0) console.log('  ' + firstLine((await craft({ name: 'chest', count: 1 })).text))
console.log('  背包', bag())

/* ── C 真存取 ── */
const stash = cnt('jungle_planks') > 0 ? 'jungle_planks' : cnt('oak_planks') > 0 ? 'oak_planks' : cnt('jungle_log') > 0 ? 'jungle_log' : 'oak_log'
say(`C1 put ${stash}（附近没箱子 → 应该自己放一个）`)
const t1 = Date.now()
const r1 = await run({ action: 'put', name: stash })
console.log(r1.text)
console.log(`→ 耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s｜剩 ${cnt(stash)}`)

const boxesAfter = scan(/chest|barrel|shulker_box/, 8)
const mine = boxesAfter.filter((s) => !boxesBefore.has(s))
const at = mine.length ? mine[0].split('@')[1].split(',').map(Number) : null
console.log('自己放的箱子：', mine.join(' ') || '（没找到！）')

say('C2 list 指定那个箱子')
if (at) console.log((await run({ action: 'list', x: at[0], y: at[1], z: at[2] })).text)
else console.log('（没有箱子可看）')

say('C3 take 2 个 ' + stash + ' 回来')
if (at) console.log((await run({ action: 'take', name: stash, count: 2, x: at[0], y: at[1], z: at[2] })).text)
console.log(stash, '=', cnt(stash))

say('C4 put all:true keep:"chest"')
if (at) console.log((await run({ action: 'put', all: true, keep: 'chest', x: at[0], y: at[1], z: at[2] })).text)
console.log('背包', bag())

say('C5 take all:true')
if (at) console.log((await run({ action: 'take', all: true, x: at[0], y: at[1], z: at[2] })).text)
console.log('背包', bag())

say('C6 箱子里没有的东西再 take')
if (at) console.log((await run({ action: 'take', name: 'coal', x: at[0], y: at[1], z: at[2] })).text)

/* ── D 收尾：只拆自己放的那个箱子 ── */
say('D 收尾（只拆自己放的）')
const mineNow = scan(/chest|barrel|shulker_box|crafting_table/, 8).filter((s) => !boxesBefore.has(s))
for (const s of mineNow) {
  const [nm, xyz] = s.split('@')
  const [x, y, z] = xyz.split(',').map(Number)
  try {
    await mc.dig({ pos: { x, y, z }, count: 1 })
    console.log(`  挖掉自己放的 ${nm} ${x},${y},${z}`)
  } catch (e) { console.log(`  拆 ${nm} 失败：${e.message}`) }
}
console.log('收尾后：', scan(/chest|barrel|shulker_box|crafting_table/, 8).join(' ') || '（没有）')
console.log('背包', bag())

await mc.disconnect('实机验证结束')
process.exit(0)
