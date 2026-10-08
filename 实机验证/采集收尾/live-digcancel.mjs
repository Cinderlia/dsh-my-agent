/* 采集超时后还能不能走路 —— 实机验证用户 2026-10-06 报的"现在机器人走不了了"
 *
 * 背景：`dig()` 的 `withTimeout` 只让 `await` 提前 reject，**不取消底层 collectBlock 任务**。
 * 超时后那个任务继续在后台按着 `forward`、占着 pathfinder ⇒ 机器人当场"物理冻住"：
 *   mc_diag 里 controlState.forward === true、velocity 全 0、15 秒只挪 0.03 格，只有重连才恢复。
 *
 * 这个脚本在真服上把那条路走一遍：
 *   B 先正常挖一块（确认正常路径没被改坏）
 *   C 把 `collectBudgetMs` 压到 3 秒，去挖一块 30+ 格外的石头 → 必然超时
 *     断言：① dig 在几秒内返回（不是干等 90 秒）② forward 控制位已松开
 *           ③ collectBlock.targets 已空（后台任务真停了）
 *   D **立刻**走一小段 → 断言真的动了、arrived:true（修之前这里会卡死）
 *
 * 用法：node live-digcancel.mjs      （要先 `cd` 到本目录，或直接给全路径）
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const core = await import('file:///' + PKG + '/src/core.mjs')
const McBot = core.default ?? core.McBot

const mc = new McBot({ instanceId: 'live-digcancel', lockDir: mkdtempSync(join(tmpdir(), 'live-digcancel-')) })

const say = (s) => console.log('\n=== ' + s + ' ===')
let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const posOf = (b) => `${Math.floor(b.x)},${Math.floor(b.y)},${Math.floor(b.z)}`

say('连上 127.0.0.1:25565（survival）')
await mc.connect({ host: '127.0.0.1', port: 25565, auth: { mode: 'offline', name: 'wcdig_live' } })
await mc.waitForChunks(20_000)
const bot = mc.requireBot()
bot.on('message', (m) => { const s = m.toString().trim(); if (s && !/^</.test(s)) console.log('[chat]', s) })
console.log('位置', posOf(bot.entity.position), '｜模式', bot.game?.gameMode)
console.log('插件', JSON.stringify(mc.mcPlugins ?? {}))

const ctrl = () => JSON.stringify(bot.controlState ?? {})
const busy = () => Boolean(bot.collectBlock?.targets && !bot.collectBlock.targets.empty)

/* ── A 基线：现在能走路吗 ────────────────────────────────────────────── */
say('A 基线 —— 先走一小段，确认"走"本身是好的')
{
  const from = bot.entity.position.clone()
  // 找一格同高度、水平 4~6 格外的落脚点（脚下要有实体方块）
  let tgt = null
  for (let r = 4; r <= 6 && !tgt; r++) {
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
      const p = from.clone(); p.x = Math.floor(from.x) + dx; p.z = Math.floor(from.z) + dz
      const under = bot.blockAt(p.offset(0, -1, 0))
      const here = bot.blockAt(p)
      if (under && here && /air/.test(here.name) && under.boundingBox === 'block') { tgt = { x: p.x, y: Math.floor(from.y), z: p.z }; break }
    }
  }
  if (!tgt) { console.log('  没找到合适的落脚点，跳过 A'); }
  else {
    console.log('  目标', JSON.stringify(tgt))
    const r = await mc.walkTo(tgt, { arrive: 1.6, budget: 20_000 })
    console.log('  返回', JSON.stringify(r))
    ok(r?.arrived === true || Number(r?.moved) > 1, '基线：能走', `moved=${r?.moved} via=${r?.via} reason=${r?.reason ?? '-'}`)
  }
}

/* ── B 正常挖一块（正常路径不能被改坏）────────────────────────────────── */
say('B 正常挖一块近的（把 collectBudgetMs 压到 3 秒之前先验一次正常路径）')
{
  const out = await mc.dig({ name: 'short_grass', count: 1, maxDistance: 8 })
  console.log('  返回', JSON.stringify(out))
  const bad = out.every((l) => /附近找不到|没有能挖/.test(l))
  ok(!bad, '正常挖：没报"找不到/没工具"', String(out[0]).slice(0, 70))
}

/* ── C 制造一次超时：压小预算去挖一块（远处的优先）──────────────────── */
say('C 制造超时 —— 压小 collectBudgetMs，去挖一块远处的土')
let timedOut = false
let everPressed = false
{
  // 用 dirt：不需要工具（挖石头会先被"没镐"守卫拦下，验不到超时那条路）
  const found = bot.findBlocks({ matching: (b) => b?.name === 'dirt', maxDistance: 64, count: 3000 })
  // 挑离机器人最远的一块（越远越挖不完）
  let far = null, farD = -1
  for (const p of found) {
    const d = bot.entity.position.distanceTo(p)
    if (d > farD) { farD = d; far = p }
  }
  console.log(`  土候选 ${found.length} 块，最远 ${farD.toFixed(1)} 格 @ ${far ? posOf(far) : '-'}`)
  const budget = far && farD >= 12 ? 2500 : 400
  mc.cfg.collectBudgetMs = budget
  console.log(`  collectBudgetMs = ${budget}（这块 ${farD.toFixed(1)} 格远，肯定挖不完）`)
  // 一边挖一边采样控制位：证明 collectBlock 真的在驱动机器人 —— 这才是会冻住的机制
  const samples = []
  const sampler = setInterval(() => {
    const cs = bot.controlState ?? {}
    samples.push(['forward', 'back', 'left', 'right', 'jump'].filter((k) => cs[k]).join('+'))
  }, 50)
  const t0 = Date.now()
  const out = await mc.dig({ pos: { x: far.x, y: far.y, z: far.z }, count: 1 })
  const ms = Date.now() - t0
  clearInterval(sampler)
  everPressed = samples.some((s) => s)
  console.log(`  用了 ${ms}ms，返回 ${JSON.stringify(out)}`)
  console.log(`  采样 ${samples.length} 次，其中 ${samples.filter((s) => s).length} 次采到按键`)
  timedOut = /超时/.test(out.join(' '))
  ok(ms < 30_000, '超时后很快就返回了（没有干等 90 秒）', `${ms}ms`)
  ok(timedOut, '确实触发了超时（这样才验得到那条路）', out.join(' ').slice(0, 60))
  ok(everPressed, '采集任务确实启动过（采到过控制键被按下 —— 这就是会冻住的状态）')
}

/* ── C2 关键断言：控制位松开 + 后台任务停了 ──────────────────────────── */
say('C2 超时之后：控制位必须松开、后台采集任务必须停掉')
if (timedOut) {
  await sleep(400)
  const cs = bot.controlState ?? {}
  const held = ['forward', 'back', 'left', 'right', 'jump'].filter((k) => cs[k])
  console.log('  控制位', ctrl())
  console.log('  collectBlock.targets.empty =', bot.collectBlock?.targets?.empty)
  ok(held.length === 0, '**没有控制键还被按着**（修之前 forward 会一直是 true）', held.join(',') || '（全松）')
  ok(!busy(), '后台采集任务已经停了（targets 已空）', `empty=${bot.collectBlock?.targets?.empty}`)
} else {
  console.log('  （C 没触发超时，跳过）')
}

/* ── D 决定性的一步：超时之后还能不能走 ──────────────────────────────── */
say('D 超时之后**立刻**走一段 —— 修之前这里会冻死（15 秒挪 0.03 格）')
{
  const from = bot.entity.position.clone()
  let tgt = null
  for (let r = 5; r <= 9 && !tgt; r++) {
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r]]) {
      const p = from.clone(); p.x = Math.floor(from.x) + dx; p.z = Math.floor(from.z) + dz
      const under = bot.blockAt(p.offset(0, -1, 0))
      const here = bot.blockAt(p)
      if (under && here && /air/.test(here.name) && under.boundingBox === 'block') { tgt = { x: p.x, y: Math.floor(from.y), z: p.z }; break }
    }
  }
  if (!tgt) { console.log('  没找到目标点，跳过 D'); }
  else {
    const r = await mc.walkTo(tgt, { arrive: 1.6, budget: 20_000 })
    console.log('  返回', JSON.stringify(r))
    const moved = Number(r?.moved ?? 0)
    ok(moved >= 1, '**超时之后还能走**（真的位移了）', `moved=${moved} via=${r?.via} reason=${r?.reason ?? '-'}`)
    ok(r?.reason !== 'stuck' || moved >= 1, '不是"原地打转"', `reason=${r?.reason ?? '-'}`)
  }
}

say('收尾')
console.log('位置', posOf(bot.entity.position), '｜控制位', ctrl())
await mc.disconnect().catch(() => {})
console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
