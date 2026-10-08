/**
 * live-swim.mjs —— "别淹死"的实机验证：真服 + 真物理
 *
 * 为什么必须实机：离线套件只能证明"`swimUp()` 按了 jump、到点松手、如实报 remaining"，
 * **证明不了按住 jump 在水里真的会往上浮**（那是 mineflayer 的物理 + 服务端说了算）。
 * 这一条要是假的，整个"憋气叫醒 + mc_move{mode:'swim'}"就是空的。
 *
 * 三段：
 *   ① 找水并走进去（`findBlocks` 找最近的水，`walkTo` 过去，再按住 forward 走进水里）
 *   ② 记录**氧气读数**（`bot.oxygenLevel` 只在**头入水之后**才有 —— 水面上是 null，这是判据要两条一起看的理由）
 *   ③ 憋气判据 + 反射层：按住 sneak 沉下去 ⇒ 断言 `status().submerged = true`（头在水下），
 *      且 `mc_auto` 真的叫醒 AI（文案"多半不是被打"），而它**不自己跑、不还手**
 *   ④ `mc.swimUp()` ⇒ 断言 **rose > 0 或已经出水**；再顺手验 `mc.dig({name:'water'})` 拒绝
 *   ⑤ 收尾：从水里出来、回到岸上（不给世界留改动）
 *
 * 找不到水 / 进不了水 ⇒ **如实报"这一轮验不成"**，不谎报成功。
 *
 * 用法：node live-swim.mjs
 * 产物：同目录 live-swim.log、live-swim-core.log
 */
import { createRequire } from 'node:module'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const HOST = '127.0.0.1'
const PORT = 25565
const NAME = 'wcswim_live'
const OUT = 'C:/Users/BLUE/Desktop/agent/dsh-mc-agent/实机验证/溺水'

const req = createRequire('file:///C:/Users/BLUE/.dsh/profiles/desktop/node_modules/mineflayer/index.js')
const Vec3 = req('vec3')
const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')
const { createAuto } = await import('file:///' + PKG + '/extensions/mc_auto.mjs')

const LOGFILE = join(OUT, 'live-swim.log')
try { writeFileSync(LOGFILE, '') } catch { /* 忽略 */ }
const log = (...a) => {
  const s = `[${new Date().toISOString().slice(11, 19)}] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(s)
  try { appendFileSync(LOGFILE, s + '\n') } catch { /* 忽略 */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const posStr = (p) => (p ? `(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})` : '(?)')
const airOf = (bot) => (Number.isFinite(bot.oxygenLevel) ? bot.oxygenLevel : null)

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => log(`\n${t}`)

/* ───────────────── 连服 ───────────────── */
const mc = new McBot({
  instanceId: 'live-swim',
  lockDir: mkdtempSync(join(tmpdir(), 'wc-swim-')),
  logFile: join(OUT, 'live-swim-core.log'),
})
log(`连 ${HOST}:${PORT}（${NAME}）…`)
await mc.connect({ host: HOST, port: PORT, auth: { mode: 'offline', name: NAME } })
const bot = mc.bot
log(`连上了：${posStr(bot.entity.position)} 维度=${bot.game?.dimension} 模式=${bot.game?.gameMode} 血=${bot.health}`)
log(`附近玩家：${Object.values(bot.players ?? {}).filter((p) => p.username && p.username !== bot.username).map((p) => p.username).join(' / ') || '（没有）'}`)
log(`氧气读数：${airOf(bot)}（20 = 满）｜inWater=${Boolean(bot.entity?.isInWater)}`)

/* ───────────────── 反射层（真那份 mc_auto + 真 bot）───────────────── */
const spy = { attacks: [], interrupts: [], walks: [], autoLogs: [] }
const wrap = (obj, key, bucket) => {
  const real = obj[key].bind(obj)
  obj[key] = (...a) => { const rec = { at: Date.now(), args: a }; bucket.push(rec); return real(...a) }
}
wrap(mc, 'attack', spy.attacks)
wrap(mc, 'interruptMove', spy.interrupts)
wrap(mc, 'walkTo', spy.walks)

const agent = {
  id: 'live-swim', status: 'idle', steers: [],
  steer (m) {
    this.steers.push(m)
    log('★ 反射层叫醒 AI（第', this.steers.length, '次）：')
    for (const l of String(m?.content?.[0]?.text ?? '').split('\n')) log('    ' + l)
  },
}
const sess = { agentId: 'live-swim', bot: mc, agent, watchdog: { agent, gate: () => true, lastWakeAt: 0 }, interruptWait: () => {} }
const registry = { listSessions: () => [{ agentId: 'live-swim', online: true, mode: 'mc', watching: null }], peek: (id) => (String(id) === 'live-swim' ? sess : null) }
const auto = createAuto({ registry, rng: Math.random, now: Date.now, workspaceOf: () => null, memRootOf: () => null, logLine: (s) => { spy.autoLogs.push(String(s)); log('[auto]', String(s)) } })
auto.setConfig(agent, { enabled: true, idleWake: false, lookAround: false, autoEat: false, pickup: false, follow: null, avoid: true }, { persist: false })
const cfg = auto.cfgFor(agent)
log('自主层配置：', JSON.stringify({ enabled: cfg.enabled, avoid: cfg.avoid, idleWake: cfg.idleWake }))

let ticking = false
const ticker = setInterval(() => {
  if (!ticking) return
  try { auto.tick(Date.now()) } catch (e) { log('⚠️ tick 出错：', e.message) }
}, 250)

/* ───────────────── ① 找水 ───────────────── */
section('① 找最近的水')
const found = bot.findBlocks({ matching: (b) => /water/.test(String(b?.name ?? '')), maxDistance: 96, count: 400 })
const isWaterAt = (x, y, z) => /water/.test(String(bot.blockAt(new Vec3(x, y, z))?.name ?? ''))
/* 优先挑**至少 2 格深**的水：1 格深的浅水里机器人站着时头还在水面上（`submerged=false`、沉不下去），
 * 2026-10-07 第 2 轮就是这么"验不成"的 —— 挑深水才能真的把头埋下去。 */
const deep = (found ?? []).find((p) => isWaterAt(p.x, p.y + 1, p.z) && isWaterAt(p.x, p.y + 2, p.z))
const water = deep ?? found?.[0] ?? null
ok(Boolean(water), '附近找得到水', water
  ? `${posStr(water)}${deep ? '（≥2 格深）' : '（只有浅水，可能沉不下去）'}`
  : '（96 格内没有水 —— 这一轮验不成）')
if (!water) {
  log(`\n结论：pass=${pass} fail=${fail}（没水，没法验"上浮"；如实报，不谎报）`)
  try { await mc.disconnect('实机验证结束（没水）') } catch { /* 忽略 */ }
  await sleep(300)
  process.exit(1)
}
const dist0 = bot.entity.position.distanceTo(water)
log(`最近的水 ${posStr(water)}，离我 ${dist0.toFixed(1)} 格`)

/* ───────────────── ② 走过去 + 走进水里 ───────────────── */
section('② 走过去、走进水里（走进水里靠的是按住 forward，不是寻路）')
for (let i = 0; i < 8; i++) {
  const p = bot.entity.position
  const d = p.distanceTo(water)
  if (d <= 3.2) break
  const r = await mc.walkTo({ x: water.x, y: water.y, z: water.z }, { arrive: 2.5, budget: 4000 })
  log(`  walkTo #${i + 1}：arrived=${r.arrived} moved=${r.moved} 还差 ${r.remaining ?? '?'}（${r.reason ?? '-'}）`)
  if (!r.arrived && r.moved < 0.3) break
  await sleep(200)
}
const nearWater = bot.entity.position.distanceTo(water) <= 4.5
ok(nearWater, '走到了水边（4.5 格内）', `距离 ${bot.entity.position.distanceTo(water).toFixed(1)} 格`)

// 面向水面，按住 forward 往里走（水里寻路不可靠，直接用控制位）
const shorePos = bot.entity.position.clone()   // 记住"下水前站的岸边"，收尾要回到这儿
await bot.lookAt(new Vec3(water.x + 0.5, water.y + 0.5, water.z + 0.5), true)
bot.setControlState('forward', true)
let entered = false
const tEnter = Date.now()
while (Date.now() - tEnter < 6000) {
  await sleep(200)
  if (bot.entity?.isInWater) { entered = true; break }
}
bot.setControlState('forward', false)
ok(entered, '真的进到水里了（entity.isInWater = true）', `在 ${posStr(bot.entity.position)}`)
if (!entered) {
  log(`\n结论：pass=${pass} fail=${fail}（走不进水里，没法验"上浮"；如实报）`)
  try { await mc.disconnect('实机验证结束（进不了水）') } catch { /* 忽略 */ }
  await sleep(300)
  process.exit(1)
}

/* ───────────────── ③ 憋气判据 + 反射层（实机） ───────────────── */
section('③ 憋气判据："头在水下"（氧气读不到时唯一的可靠信号）')
const st0 = mc.status()
log(`  下水前：inWater=${st0.inWater} submerged=${st0.submerged} air=${st0.air} y=${bot.entity.position.y.toFixed(2)}`)
const airIn = airOf(bot)
// 让机器人真的沉下去：水里按住 sneak 会下潜（按住 jump 才会往上浮）
const w0 = spy.walks.length, a0 = spy.attacks.length
ticking = true
bot.setControlState('sneak', true)
let st = st0
const tSub = Date.now()
while (Date.now() - tSub < 14_000) {
  await sleep(500)
  st = mc.status()
  if (st.submerged === true && agent.steers.length > 0) break
}
bot.setControlState('sneak', false)
log(`  泡了 ${((Date.now() - tSub) / 1000).toFixed(1)}s：inWater=${st.inWater} submerged=${st.submerged} air=${st.air} y=${bot.entity.position.y.toFixed(2)} 血=${bot.health}`)
ok(st.submerged === true, '头在水下 ⇒ status().submerged = true（氧气读不到也判得出来）',
  `air=${st.air} inWater=${st.inWater} y=${bot.entity.position.y.toFixed(2)}`)
log(`  氧气读数：水面 ${st0.air} → 水下 ${st.air}`
  + '（mineflayer 只在头入水、air_supply 元数据开始来时才有读数；读不到时判据就只能靠 submerged）')
const steerText = agent.steers.map((m) => String(m?.content?.[0]?.text ?? '')).join('\n')
ok(agent.steers.length >= 1, '头在水下待够 ⇒ 反射层叫醒 AI（不是"挨了打看不到怪"）', `${agent.steers.length} 次`)
ok(/这不是被打|多半不是被打/.test(steerText) && /憋气/.test(steerText), '叫醒文案写清"不是被打、是憋气"',
  String(steerText.split('\n')[0] ?? '').slice(0, 90))
ok(!/看不到怪/.test(steerText), '文案里不许出现"看不到怪"（那是"被打"的说法，会把 AI 带偏）')
ok(spy.walks.length === w0 && spy.attacks.length === a0,
  '反射层不自己跑、不还手（只叫醒）', JSON.stringify({ walks: spy.walks.length - w0, attacks: spy.attacks.length - a0 }))
ticking = false

/* ───────────────── ④ 真上浮 ───────────────── */
section('④ mc.swimUp() —— 按住 jump 真的能浮上来吗（这是本轮的关键结论）')
const y0 = bot.entity.position.y
const air0 = airOf(bot)
const r = await mc.swimUp()
log(`  swimUp 返回：${JSON.stringify(r)}`)
const y1 = bot.entity.position.y
const rose = y1 - y0
ok(r.inWater === false || rose > 0.2, '按住 jump 真的往上浮了（rose > 0.2 或已出水）',
  `y ${y0.toFixed(2)} → ${y1.toFixed(2)}（涨 ${rose.toFixed(2)}）；返回 rose=${r.rose} inWater=${r.inWater}`)
ok(airOf(bot) == null || airOf(bot) >= (air0 ?? 0), '出水后氧气在恢复', `${air0} → ${airOf(bot)}`)

// 再叫一次（"少量多次"的实际用法）
if (bot.entity?.isInWater) {
  const r2 = await mc.swimUp()
  const y2 = bot.entity.position.y
  log(`  第二次 swimUp：${JSON.stringify(r2)}｜y ${y1.toFixed(2)} → ${y2.toFixed(2)}`)
  ok(r2.inWater === false || y2 > y1 + 0.2, '连着叫第二次还能继续往上（少量多次有效）',
    `涨 ${(y2 - y1).toFixed(2)}`)
}

/* ───────────────── ⑤ 水挖不掉 ───────────────── */
section('⑤ mc.dig 水 → 直接拒绝（旧日志里出现过"破坏 water"）')
let err = null
try { await mc.dig({ name: 'water', count: 1 }) } catch (e) { err = e }
ok(Boolean(err), 'dig water 抛错（不白花一次调用）', String(err?.message ?? '').slice(0, 80))
ok(/流体，挖不掉/.test(String(err?.message ?? '')), '错误里写清"流体，挖不掉"')

/* ───────────────── ⑥ 收尾：出水、上岸 ───────────────── */
section('⑥ 收尾：从水里出来')
if (bot.entity?.isInWater) await mc.swimUp({ hold: 3000 }).catch(() => {})
try {
  // 回到"下水前站的岸边"，最多叫两次（少量多次；上次"往前 4 格"落点还在水里 ⇒ 改成回岸边）
  for (let i = 0; i < 2 && bot.entity?.isInWater; i++) {
    const rr = await mc.walkTo({ x: Math.round(shorePos.x), y: Math.round(shorePos.y), z: Math.round(shorePos.z) }, { arrive: 1.5, budget: 4000 })
    log(`  往岸边走 #${i + 1}：arrived=${rr.arrived} moved=${rr.moved}${rr.hint ? '｜' + rr.hint : ''}`)
    await sleep(300)
  }
} catch (e) { log(`  上岸失败（不影响结论）：${e?.message ?? e}`) }
ok(!bot.entity?.isInWater, '最后不在水里', `在 ${posStr(bot.entity.position)}｜氧气 ${airOf(bot)}｜血 ${bot.health}`)
log(`反射层：叫醒 ${agent.steers.length} 次｜窗口内自己跑 ${spy.walks.length - w0} 次、还手 ${spy.attacks.length - a0} 次（后两项应该都是 0）`)
log(`（脚本自己走的 walkTo 一共 ${spy.walks.length} 次，含 ① ② ⑥）`)
log('世界改动：无（只在水里游了几下，没挖没放）')

log(`\n结论：pass=${pass} fail=${fail}`)
ticking = false
clearInterval(ticker)
try { await mc.disconnect('实机验证结束') } catch { /* 忽略 */ }
await sleep(300)
process.exit(fail === 0 ? 0 : 1)
