/* 合成实机验证（混木种）：真服上一次调用做木镐，不许再靠"重试"
 * 场景复刻实机日志：背包里同时有橡木和桦木木板时，旧代码执行期按 Recipe.find 顺序重挑配方，
 * 第 2 步会挑走桦木木板做桦木木棍 → 第 3 步两边都凑不齐 → cherry → mineflayer 抛 missing ingredient。
 * 用法：node live-craft-mixed.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')
const craft = await import('file:///' + PKG + '/extensions/mc_craft.mjs')

const registered = new Map()
const sessions = new Map()
const logs = []
const ctx = {
  tools: { register: (d) => registered.set(d.name, d), guard: () => {}, get: () => undefined },
  on: () => () => {},
  get: () => undefined,
  logger: { info: () => {}, warn: (m) => console.log('[warn]', m) },
}
const api = {
  ctx,
  config: {},
  registry: { peek: (id) => sessions.get(String(id)), listSessions: () => [...sessions.values()] },
  asTool: (s) => s,
  getSession: (exec) => sessions.get(String(exec?.agent?.id)),
  memory: {}, memoryFor: () => ({}), workspaceOf: () => null,
  logLine: (l) => { logs.push(l); console.log('[log]', l) },
  Watchdog: class {}, ensureWatchdog: () => {},
}
await craft.apply(api)
const spec = registered.get('mc_craft')
if (!spec) throw new Error('mc_craft 没注册上')

const lockDir = mkdtempSync(join(tmpdir(), 'live-craft-mixed-'))
const NAME = 'mccraft_mix'
const mc = new McBot({ instanceId: 'live-craft-mixed', lockDir })
sessions.set('A1', { agentId: 'A1', bot: mc })
const run = (args) => spec.execute(args, { agent: { id: 'A1' } })
const say = (s) => console.log('\n=== ' + s + ' ===')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await mc.connect({ host: '127.0.0.1', port: 25565, auth: { mode: 'offline', name: NAME } })
await mc.waitForChunks(20_000)
const bot = mc.requireBot()
const countOf = (n) => bot.inventory.items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0)
bot.on('message', (m) => { const s = m.toString(); if (s.trim()) console.log('[chat]', s) })

say('连上了')
console.log('模式', bot.game.gameMode, '| 位置', JSON.stringify(bot.entity.position.floored()))

/* ── 摆出"混木种"的背包：2 橡木原木 + 1 橡木木板 + 2 桦木木板 + 1 工作台 ── */
say('清空背包 + 给材料（/clear + /give）')
bot.chat(`/clear ${NAME}`)
await wait(800)
for (const [n, c] of [['oak_log', 2], ['oak_planks', 1], ['birch_planks', 2], ['crafting_table', 1]]) {
  bot.chat(`/give ${NAME} ${n} ${c}`)
  await wait(600)
}
await wait(1500)
console.log('背包', JSON.stringify(mc.inventory()))
const before = { oak_log: countOf('oak_log'), oak_planks: countOf('oak_planks'), birch_planks: countOf('birch_planks') }
console.log('起点', JSON.stringify(before))

/* ── 一次调用做木镐 ── */
say('mc_craft {name:"wooden_pickaxe"}（只调一次，不许重试）')
const t0 = Date.now()
const r = await run({ name: 'wooden_pickaxe' })
console.log(r.text)
const ms = Date.now() - t0

say('核对')
const after = { oak_log: countOf('oak_log'), oak_planks: countOf('oak_planks'), birch_planks: countOf('birch_planks'), stick: countOf('stick'), wooden_pickaxe: countOf('wooden_pickaxe') }
console.log('终点', JSON.stringify(after))
const around = []
const p0 = bot.entity.position.floored()
for (let dx = -4; dx <= 4; dx++) {
  for (let dy = -3; dy <= 3; dy++) {
    for (let dz = -4; dz <= 4; dz++) {
      const b = bot.blockAt(p0.offset(dx, dy, dz))
      if (b && b.name === 'crafting_table') around.push(`${b.position}`)
    }
  }
}
console.log('脚边工作台：', around.length ? around.join(' ') : '（没有）')

const bad = /missing ingredient|原料对不上|❌|失败/.test(r.text)
const checks = [
  ['一次调用就完成', /完成/.test(r.text) && !bad],
  ['没有 missing ingredient', !/missing ingredient/i.test(r.text)],
  ['拿到木镐', after.wooden_pickaxe >= 1],
  ['桦木木板没被动（一路橡木）', after.birch_planks === before.birch_planks],
  ['橡木原木只用了 1 根', after.oak_log === before.oak_log - 1],
  ['橡木木板刚好用光', after.oak_planks === 0],
  ['耗时 < 5 秒', ms < 5000]
]

/* ── 场景 B：先拆掉脚边的工作台，让插件自己放一个（实机日志里"放桌同秒失败"的那条路） ── */
say('B 拆掉工作台 → 让插件自己放 → 一次调用做木镐')
const pb = bot.entity.position.floored()
let dug = 0
for (let dx = -4; dx <= 4; dx++) {
  for (let dy = -3; dy <= 3; dy++) {
    for (let dz = -4; dz <= 4; dz++) {
      const blk = bot.blockAt(pb.offset(dx, dy, dz))
      if (blk && blk.name === 'crafting_table') { try { await bot.dig(blk); dug++ } catch (e) { console.log('挖工作台失败：' + e.message) } }
    }
  }
}
console.log('拆掉工作台', dug, '个')
await wait(600)
bot.chat(`/clear ${NAME}`)
await wait(800)
for (const [n, c] of [['oak_log', 4], ['crafting_table', 1]]) { bot.chat(`/give ${NAME} ${n} ${c}`); await wait(600) }
await wait(1200)
console.log('背包', JSON.stringify(mc.inventory()))
const tb = Date.now()
const r2 = await run({ name: 'wooden_pickaxe' })
console.log(r2.text)
const after2 = { oak_log: countOf('oak_log'), oak_planks: countOf('oak_planks'), stick: countOf('stick'), wooden_pickaxe: countOf('wooden_pickaxe') }
const ms2 = Date.now() - tb
console.log('终点', JSON.stringify(after2))
checks.push(
  ['B 一次调用就完成（放桌+合成同一轮）', /完成/.test(r2.text) && !/missing ingredient|❌|失败/.test(r2.text)],
  ['B 拿到木镐', after2.wooden_pickaxe >= 1],
  ['B 插件自己放了工作台', /工作台：\(|自动放了工作台/.test(r2.text)],
  ['B 耗时 < 5 秒', ms2 < 5000]
)

console.log('\n--- 结论 ---')
let fail = 0
for (const [label, okv] of checks) { console.log(`${okv ? 'ok  ' : 'FAIL'} ${label}`); if (!okv) fail++ }
console.log(`耗时 ${ms}ms | ${fail === 0 ? '全部通过' : fail + ' 项不合格'}`)

await mc.disconnect('测试结束')
try { rmSync(lockDir, { recursive: true, force: true }) } catch {}
process.exit(fail === 0 ? 0 : 1)
