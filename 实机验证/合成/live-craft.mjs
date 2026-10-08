/* 合成实机验证：真服上跑 mc_craft（原木 → 木板 → 工作台 → 木棍 → 木镐）
 * 用法：node live-craft.mjs
 * 说明：用真实 McBot + 真实扩展，只把宿主 ctx/api 换成最小假件（与 tools/check-mc-craft.mjs 同一契约）。
 */
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const PROFILE = 'C:/Users/BLUE/.dsh/profiles/desktop'
const req = createRequire('file:///' + PROFILE + '/node_modules/mineflayer/index.js')
const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')
const craft = await import('file:///' + PKG + '/extensions/mc_craft.mjs')

/* ── 假宿主 ── */
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
  getSession: (exec) => {
    const id = exec?.agent?.id
    if (!id) throw new Error('拿不到当前会话')
    return sessions.get(String(id))
  },
  memory: {}, memoryFor: () => ({}), workspaceOf: () => null,
  logLine: (l) => { logs.push(l); console.log('[log]', l) },
  Watchdog: class {}, ensureWatchdog: () => {},
}
await craft.apply(api)
const spec = registered.get('mc_craft')
if (!spec) throw new Error('mc_craft 没注册上')

const mc = new McBot({ instanceId: 'live-craft', lockDir: mkdtempSync(join(tmpdir(), 'live-craft-')) })
sessions.set('A1', { agentId: 'A1', bot: mc })
const run = (args) => spec.execute(args, { agent: { id: 'A1' } })
const say = (s) => console.log('\n=== ' + s + ' ===')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await mc.connect({ host: '127.0.0.1', port: 25565, auth: { mode: 'offline', name: 'mccraft_live' } })
await mc.waitForChunks(20_000)
const bot = mc.requireBot()
const countOf = (n) => bot.inventory.items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0)
bot.on('message', (m) => { const s = m.toString(); if (s.trim()) console.log('[chat]', s) })

say('连上了')
console.log('模式', bot.game.gameMode, '| 位置', JSON.stringify(bot.entity.position.floored()))
console.log('背包', JSON.stringify(mc.inventory()))

/* ── 搞材料 ── */
if (bot.game.gameMode === 'creative') {
  say('创造模式：直接给 3 个原木')
  console.log(JSON.stringify(await mc.giveItem({ name: 'oak_log', count: 3 })))
} else {
  say('先试 /give（服务器允许就用它，最省事）')
  bot.chat('/give mccraft_live oak_log 3')
  await wait(2000)
  console.log('原木数', countOf('oak_log'))
  if (countOf('oak_log') < 3) {
    say('生存模式：出门找树')
    for (let i = 0; i < 20 && countOf('oak_log') < 3; i++) {
      const blk = bot.findBlock({ matching: (b) => /_log$/.test(b.name), maxDistance: 96 })
      if (!blk) { console.log('附近 96 格内没有原木了'); break }
      const d = bot.entity.position.distanceTo(blk.position)
      console.log(`第 ${i + 1} 根：${blk.name} @ ${blk.position} 距离 ${d.toFixed(1)}`)
      if (d > 3.2) { try { await mc.walkTo(blk.position, { arrive: 2.6, budget: 25_000 }) } catch (e) { console.log('走过去失败：' + e.message) } }
      try { await bot.dig(blk) } catch (e) { console.log('挖失败：' + e.message) }
      await wait(400)
    }
    console.log('原木数', countOf('oak_log'))
  }
}

/* ── ① 工作台（1 原木 → 4 木板 → 1 工作台） ── */
say('① mc_craft {name:"crafting_table"}')
console.log((await run({ name: 'crafting_table' })).text)

/* ── ② 木镐（自动放工作台 + 递归补齐木板/木棍） ── */
say('② mc_craft {name:"wooden_pickaxe"}')
console.log((await run({ name: 'wooden_pickaxe' })).text)

/* ── ③ 核对 ── */
say('核对')
console.log('背包', JSON.stringify(mc.inventory()))
const around = []
for (let dx = -3; dx <= 3; dx++) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dz = -3; dz <= 3; dz++) {
      const b = bot.blockAt(bot.entity.position.floored().offset(dx, dy, dz))
      if (b && b.name === 'crafting_table') around.push(`${b.position}`)
    }
  }
}
console.log('脚边工作台：', around.length ? around.join(' ') : '（没有）')
console.log('木镐', countOf('wooden_pickaxe'), '| 木板', countOf('oak_planks'), '| 木棍', countOf('stick'), '| 原木', countOf('oak_log'))
await mc.disconnect('测试结束')
process.exit(0)
