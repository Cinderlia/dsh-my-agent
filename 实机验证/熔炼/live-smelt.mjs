/* 实机验收：mc_furnace 的"装料 → 盯着烧 → 取成品"整条路（m05711 的验收点）
   路径：凑 8 个圆石 → mc_craft furnace → mc_furnace 装料 → 等 14 秒 → takeOnly 取成品 → 装 1 个盯着烧完。
   为什么和 live-furnace.mjs 分开：那个是"从零备料"的长链路（会被地形卡住），这个是**只测熔炉本体**的短链路，
   失败点少、一次 40 秒左右 —— 改熔炉代码后先跑这个。
   用法（项目目录）：node 实机验证\熔炼\live-smelt.mjs
   跑完熔炉留在原地（下次接着用）；要收掉就自己 mc_act break。
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

const mc = new McBot({ instanceId: 'probe-take', lockDir: mkdtempSync(join(tmpdir(), 'probe-take-')) })
await mc.connect({ host: '127.0.0.1', port: 25565, version: '1.21.10', auth: { mode: 'offline', name: 'mcfurnace_live' } })
const bot = mc.requireBot()
sessions.set('A1', { agentId: 'A1', bot: mc })
const EXEC = { agent: { id: 'A1' } }
const run = (a) => fSpec.execute(a, EXEC)
const craft = (a) => cSpec.execute(a, EXEC)
const cnt = (n) => bot.inventory.items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0)
const bag = () => bot.inventory.items().map((i) => `${i.name}×${i.count}`).join(' ') || '（空）'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pos = () => { const p = bot.entity.position; return `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}` }
const line = (t) => String(t).split('\n')[0]

console.log('连接：', pos(), '｜圆石', cnt('cobblestone'), '｜原木', cnt('oak_log'), '｜木炭', cnt('charcoal'))
console.log('背包', bag())

/* ① 凑 8 个圆石 */
for (let i = 1; i <= 8 && cnt('cobblestone') < 8; i++) {
  let r
  try { r = await mc.dig({ name: 'stone', count: 8 - cnt('cobblestone'), maxDistance: 12 }) } catch (e) { r = { text: '挖石头抛错：' + e.message } }
  console.log(`[凑料 ${i}] 圆石=${cnt('cobblestone')}｜${line(r?.text ?? '')}`)
  if (cnt('cobblestone') >= 8) break
  try { const d = await mc.dig({ name: 'dirt', count: 2, maxDistance: 3 }); console.log(`   ↳ 挖土：${line(d?.text ?? '')}`) } catch (e) { console.log('   ↳ 挖土抛错：' + e.message) }
}
console.log('圆石 =', cnt('cobblestone'))

/* ② 做熔炉（如果背包里已经有就不用做） */
if (cnt('furnace') === 0 && cnt('cobblestone') >= 8) {
  const r = await craft({ name: 'furnace', count: 1 })
  console.log('合成熔炉：', line(r?.text ?? ''))
}
console.log('背包里有熔炉 =', cnt('furnace'))

/* ③ 装料（不盯） */
console.log('\n--- C2 装料 oak_log ×1 ---')
console.log((await run({ name: 'oak_log', count: 1 })).text)

/* ④ 等它烧完（1 个 = 10 秒，留余量） */
console.log('\n--- 等 14 秒 ---')
await sleep(14_000)

/* ⑤ 取成品（只取，不装） */
console.log('--- C3 takeOnly 取成品 ---')
const take = await run({ name: 'charcoal', takeOnly: true })
console.log(take.text)
console.log(`→ 木炭 ${cnt('charcoal')}｜原木 ${cnt('oak_log')}`)

/* ⑥ 再验证"盯着烧"（maxWaitSec）这条路：装 1 个并等它烧完直接拿到 */
console.log('\n--- C4 装 1 个并盯着烧完（maxWaitSec: 25） ---')
const t = Date.now()
const watch = await run({ name: 'oak_log', count: 1, maxWaitSec: 25 })
console.log(watch.text)
console.log(`→ 耗时 ${((Date.now() - t) / 1000).toFixed(1)}s｜木炭 ${cnt('charcoal')}｜原木 ${cnt('oak_log')}`)

console.log('\n最终背包', bag())
console.log('（熔炉留在原地，方便下次接着用；要收掉就自己 mc_act break）')
await mc.disconnect('探针结束')
process.exit(0)
