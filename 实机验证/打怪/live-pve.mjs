/**
 * live-pve.mjs —— PvE（打怪 / 保命）实机验证：真服 + 真怪 + 真反射层
 *
 * 用真 McBot 连真服，把宿主 ctx/api 换成最小假件，加载**产品里那份** extensions/mc_auto.mjs，
 * 然后让机器人自己去惹怪，看反射层到底干了什么：
 *
 *   A 有人值守（agent.steer 在）：怪靠近 / 挨打 → **只叫醒 AI**（steer 文案带怪名 / 坐标 / 血量 /
 *     三个选项），反射层**不自己跑、不抢控制权**（抢占 0 次、撤 0 次 —— 用户 m11410 的要求）
 *   B 没人值守（agent 没有 steer）：**也不还手、也不自己跑**，只记档
 *     （用户 2026-10-06："反射层兜底还手：judgeFight() 不需要了" ⇒ 反射层永不自己动手）
 *
 * 说明：脚本自己的"走过去找怪"也走 mc.walkTo，所以 spy.walks 会把那些一起算进去 ——
 * 下面 A/B 段报的 `delta.walks` 是**观察窗口内**发生的调用（找怪那几次在窗口外），
 * 反射层不自己跑时它应当是 0。
 *
 * 说明 2：真服上没法让骷髅按点射我 —— A 段观察窗口末尾会**伪造一次 `entityHurt`**
 * （`bot.emit('entityHurt', bot.entity)`，走的是反射层真挂的 handler），把"有人值守 → 叫醒 AI"逼出来。
 * 放在窗口末尾是因为自保叫醒有 15 秒限流（`DANGER_WAKE_GAP_MS`）。
 *
 * 说明 3：背包是**跨连接留存**的，手里已经有剑就跳过备料（不再砍树）；被怪咬死会掉剑，下次还得备料。
 *
 * 用法：node live-pve.mjs [--seconds=300] [--observe=30]
 * 产物：同目录 live-pve.log
 */
import { createRequire } from 'node:module'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const HOST = '127.0.0.1'
const PORT = 25565
const NAME = 'wcpve_live'
const OUT = 'C:/Users/BLUE/Desktop/agent/dsh-mc-agent/实机验证/打怪'
const arg = (k, d) => Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)) || d
const HUNT_SEC = arg('seconds', 300)
const OBSERVE_SEC = arg('observe', 30)

const req = createRequire('file:///C:/Users/BLUE/.dsh/profiles/desktop/node_modules/mineflayer/index.js')
const Vec3 = req('vec3')
const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')
const { createAuto } = await import('file:///' + PKG + '/extensions/mc_auto.mjs')
const craftExt = await import('file:///' + PKG + '/extensions/mc_craft.mjs')

const lines = []
const LOGFILE = join(OUT, 'live-pve.log')
try { writeFileSync(LOGFILE, '') } catch { /* 忽略 */ }
const log = (...a) => {
  const s = `[${new Date().toISOString().slice(11, 19)}] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  lines.push(s)
  console.log(s)
  // 边跑边落盘：万一被外面掐断（比如管道关掉），也留得下现场
  try { appendFileSync(LOGFILE, s + '\n') } catch { /* 忽略 */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const HOSTILE = /zombie|skeleton|stray|bogged|creeper|spider|witch|enderman|slime|pillager|vindicator|ravager|phantom|drowned|husk|blaze|ghast|piglin|hoglin|guardian|shulker|silverfish|magma|wither|breeze/i
const posStr = (p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)})`
const countOf = (bot, n) => bot.inventory.items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0)

/* ───────────────── 假宿主：只为把 mc_craft 挂起来造一把剑 ───────────────── */
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
  Watchdog: class {}, ensureWatchdog: () => {},
})
const craftTool = registered.get('mc_craft')
log('mc_craft 已挂上：', Boolean(craftTool))

/* ───────────────── 连接 ───────────────── */
const lockDir = mkdtempSync(join(tmpdir(), 'pve-live-'))
const mc = new McBot({ instanceId: 'pve-live', lockDir, logFile: join(lockDir, 'pve-live.log') })
const bot = await mc.connect({ host: HOST, port: PORT, auth: { mode: 'offline', name: NAME } })
await mc.waitForChunks(20_000).catch(() => {})
log('连上了：', posStr(bot.entity.position), '｜血', bot.health, '｜食物', bot.food, '｜模式', bot.game?.gameMode)
log('插件：', mc.pfReady ? 'pathfinder 就绪' : 'pathfinder 没装上', '｜', Object.keys(mc.mcPlugins ?? {}).join(', ') || '（无）')
log('游戏内时间', bot.time?.timeOfDay, '｜玩家：', Object.values(bot.players ?? {}).filter((p) => p.username !== bot.username).map((p) => p.username + posStr(p.entity?.position ?? bot.entity.position)).join(', ') || '（只有我）')
bot.on('message', (m) => { const s = m.toString().trim(); if (s) log('[chat]', s) })
bot.on('death', () => log('☠️ 机器人死了'))
bot.on('health', () => { if (bot.health <= 6) log('⚠️ 血只剩', bot.health) })

/* ───────────────── 间谍：看反射层到底调了什么 ───────────────── */
const spy = { attacks: [], interrupts: [], walks: [], autoLogs: [] }
const wrap = (obj, key, bucket, extra) => {
  const real = obj[key].bind(obj)
  obj[key] = (...a) => { const rec = { at: Date.now(), args: a }; if (extra) extra(rec, a); bucket.push(rec); return real(...a) }
}
wrap(mc, 'attack', spy.attacks, (r, a) => { r.who = a?.[0]?.who })
wrap(mc, 'interruptMove', spy.interrupts, (r, a) => { r.why = a?.[0] })
wrap(mc, 'walkTo', spy.walks, (r, a) => { r.target = a?.[0] })

/* ───────────────── 自主层（真那份代码 + 真 bot）───────────────── */
const agent = {
  id: 'live-pve', status: 'idle', steers: [],
  steer (m) {
    this.steers.push(m)
    log('★ 反射层叫醒 AI（第', this.steers.length, '次）：')
    for (const l of String(m?.content?.[0]?.text ?? '').split('\n')) log('    ' + l)
  },
}
const sess = { agentId: 'live-pve', bot: mc, agent, watchdog: { agent, gate: () => true, lastWakeAt: 0 }, interruptWait: () => {} }
const registry = { listSessions: () => [{ agentId: 'live-pve', online: true, mode: 'mc', watching: null }], peek: (id) => (String(id) === 'live-pve' ? sess : null) }
const auto = createAuto({ registry, rng: Math.random, now: Date.now, workspaceOf: () => null, memRootOf: () => null, logLine: (s) => { spy.autoLogs.push(String(s)); log('[auto]', String(s)) } })
auto.setConfig(agent, { enabled: true, idleWake: false, lookAround: false, autoEat: false, pickup: false, follow: null, avoid: true }, { persist: false })
const cfg = auto.cfgFor(agent)
log('自主层配置：', JSON.stringify({ enabled: cfg.enabled, avoid: cfg.avoid, wearArmor: cfg.wearArmor, idleWake: cfg.idleWake }))

let ticking = false   // 阶段 1（备料）先关掉反射层：不然自保会一直抢占我的走路，料都拿不到
const ticker = setInterval(() => {
  if (!ticking) return
  try { auto.tick(Date.now()) } catch (e) { log('⚠️ tick 出错：', e.message) }
}, 250)

/* ───────── 阶段 1：合法搞一把剑（**有武器也不该还手** —— 这样才测得准）───────── */
log('──────── 阶段 1：备料（造木剑）────────')
/* 背包是跨连接留存的：上一轮留下的剑还在就**跳过备料**，别为了测一次再砍一棵树 */
const preSword = bot.inventory.items().find((i) => /sword|axe$/.test(i.name))
if (preSword) {
  log('背包里已经有武器（', `${preSword.name}x${preSword.count}`, '）→ 跳过备料，这一轮不砍树')
} else {
const logs = bot.findBlocks({ matching: (b) => b?.name === 'oak_log', maxDistance: 48, count: 24 })
if (!logs.length) log('48 格内没找到橡木')
else {
  const me0 = bot.entity.position.clone()
  const tree = logs.map((p) => ({ p, d: p.distanceTo(me0) })).sort((a, b) => a.d - b.d)[0]
  // 树干最底下那根原木。🔴 别拿它**下面**的地面当目标：这棵树长在台地上，地面比树干低 6 格，
  //    站上去手够不着（上一版就是这么连挖两次都失败的）。直接走到**树干那一格的高度**，
  //    寻路会自己垫/挖上去。
  const trunk = logs.filter((p) => Math.abs(p.x - tree.p.x) <= 1 && Math.abs(p.z - tree.p.z) <= 1)
  const base = (trunk.length ? trunk : [tree.p]).sort((a, b) => a.y - b.y)[0]
  log('最近的树：', posStr(tree.p), tree.d.toFixed(1), '格｜树干底', posStr(base), '｜我现在', posStr(me0))
  for (let i = 0; i < 14; i++) {
    const d = bot.entity.position.distanceTo(new Vec3(base.x, base.y, base.z))
    if (d <= 3) { log('  到树干底下了（', d.toFixed(1), '格）'); break }
    const r = await mc.walkTo({ x: base.x, y: base.y, z: base.z }, { arrive: 2, budget: 4000 })
    log(`  靠近树 ${i + 1}：arrived=${r.arrived} moved=${r.moved ?? '-'} 还差=${r.remaining ?? '-'} ${r.reason ?? ''}`)
    if (r.arrived) break
  }
  const me2 = bot.entity.position
  const best = (trunk.length ? trunk : logs).map((p) => ({ p, dy: Math.abs(p.y - (me2.y + 1)), d: p.distanceTo(me2) }))
    .sort((a, b) => (a.dy - b.dy) || (a.d - b.d))[0]
  log('要挖的原木：', posStr(best.p), best.d.toFixed(1), '格')
  const dug = await mc.dig({ name: 'oak_log', pos: { x: best.p.x, y: best.p.y, z: best.p.z }, maxDistance: 6, count: 1 })
  log('挖木头：', JSON.stringify(dug).slice(0, 400))
  if (countOf(bot, 'oak_log') === 0) {
    log('还没挖到，退回 collectBlock 再试一次（它能自己绕过去）')
    const dug2 = await mc.dig({ name: 'oak_log', count: 1, maxDistance: 20 })
    log('挖木头 2：', JSON.stringify(dug2).slice(0, 300))
  }
}
log('背包：', bot.inventory.items().map((i) => `${i.name}x${i.count}`).join(' ') || '空')
craftSessions.set('live-pve', { agentId: 'live-pve', bot: mc })
if (craftTool && countOf(bot, 'oak_log') > 0) {
  const r = await craftTool.execute({ name: 'wooden_sword' }, { agent: { id: 'live-pve' } })
  log('mc_craft wooden_sword →', String(r?.text ?? JSON.stringify(r)).split('\n').slice(0, 3).join(' / '))
} else {
  log('没有木料，跳过造剑（这次只能测"没武器就先撤"）')
}
}
const sword = bot.inventory.items().find((i) => /sword|axe$/.test(i.name))
log('手上武器：', sword ? `${sword.name}x${sword.count}` : '（没有）')
ticking = true
log('反射层开跑')

/* ───────────────── 阶段 2：去找怪 ───────────────── */
const nearestFoe = () => {
  const me = bot.entity.position
  return Object.values(bot.entities ?? {})
    .filter((e) => e && e !== bot.entity && e.name && HOSTILE.test(e.name))
    .map((e) => ({ name: e.name, pos: e.position, d: e.position.distanceTo(me) }))
    .sort((a, b) => a.d - b.d)[0] ?? null
}
log('──────── 阶段 2：找怪（最多', HUNT_SEC, '秒）────────')
const tHunt = Date.now()
let met = null
while ((Date.now() - tHunt) / 1000 < HUNT_SEC) {
  const foe = nearestFoe()
  if (foe && foe.d < 20) { met = foe; log('怪已进入 20 格：', foe.name, foe.d.toFixed(1)); break }
  if (foe) {
    log('朝', foe.name, '走（', foe.d.toFixed(1), '格', posStr(foe.pos), '）')
    const r = await mc.walkTo({ x: foe.pos.x, y: foe.pos.y, z: foe.pos.z }, { arrive: 3, budget: 4000 })
    log(`  → arrived=${r.arrived} moved=${r.moved ?? '-'} stuck=${r.stuck ?? false} ${r.reason ?? ''}`)
    if (bot.health <= 8) { log('⚠️ 血太低，停止找怪'); break }
  } else {
    log('附近没看到怪，原地等 5 秒（夜里会刷）')
    await sleep(5000)
  }
}
if (!met) log('⚠️ 没能在限定时间内碰到怪')

/* ───────────────── 阶段 3：观察反射层 ───────────────── */
const watch = async (label, sec, opts = {}) => {
  log(`──────── ${label}（观察 ${sec} 秒）────────`)
  const foe0 = nearestFoe()
  const from = bot.entity.position.clone()
  const hp0 = bot.health
  const before = { attacks: spy.attacks.length, interrupts: spy.interrupts.length, walks: spy.walks.length, steers: agent.steers.length }
  for (let i = 0; i < sec; i++) {
    await sleep(1000)
    /* 🔴 真服上没法让骷髅"按点"射我：观察窗口**快结束**时还没挨打就伪造一次 `entityHurt` ——
     * 走的是反射层真挂的那个 handler（`b.on('entityHurt', …)`），只是触发时机由脚本定。
     * 放窗口末尾是因为自保叫醒有 15 秒限流（`DANGER_WAKE_GAP_MS`）：早发会被上一轮的自然叫醒挡掉
     * （2026-10-06 实测：t+3s 发的那次就被挡了，只在 stats.alerts 上留了痕）。 */
    if (opts.forceHurt && i === Math.max(3, sec - 4) && typeof agent.steer === 'function' && bot.health > 0 && bot.health === hp0) {
      try { bot.emit('entityHurt', bot.entity); log('  ⚡ 脚本伪造一次 entityHurt（逼出自保叫醒：真服上没法让骷髅按点射我）') } catch { /* 忽略 */ }
    }
    const foe = nearestFoe()
    log(`  t+${i + 1}s 血 ${Number(bot.health).toFixed(1)} ｜怪 ${foe ? `${foe.name} ${foe.d.toFixed(1)}格` : '无'} ｜我 ${posStr(bot.entity.position)} ｜抢占 ${spy.interrupts.length} 撤 ${spy.walks.length} 叫醒 ${agent.steers.length} 还手 ${spy.attacks.length}`)
    if (bot.health <= 0) break
  }
  const st = auto.stateOf('live-pve')
  const after = { attacks: spy.attacks.length, interrupts: spy.interrupts.length, walks: spy.walks.length, steers: agent.steers.length }
  return {
    label, before, after,
    delta: { attacks: after.attacks - before.attacks, interrupts: after.interrupts - before.interrupts, walks: after.walks - before.walks, steers: after.steers - before.steers },
    moved: bot.entity.position.distanceTo(from),
    foeDist: { from: foe0?.d ?? null, to: nearestFoe()?.d ?? null },
    stats: st?.stats ?? null,
  }
}

const resA = await watch('阶段 3A：有人值守（agent.steer 在）', OBSERVE_SEC, { forceHurt: true })

log('──────── 阶段 3B：把 agent.steer 拿掉（模拟没人值守）────────')
delete agent.steer
// 先再去找一次怪：A 段之后附近可能已经没怪了，B 段没怪就测不到"不还手"
{
  const t2 = Date.now()
  while ((Date.now() - t2) / 1000 < 90) {
    const foe = nearestFoe()
    if (foe && foe.d < 12) { log('B 段：怪已进入 12 格 ——', foe.name, foe.d.toFixed(1)); break }
    if (foe && foe.d < 60) {
      log('B 段：朝', foe.name, '走（', foe.d.toFixed(1), '格）')
      const r = await mc.walkTo({ x: foe.pos.x, y: foe.pos.y, z: foe.pos.z }, { arrive: 3, budget: 4000 })
      log(`  → arrived=${r.arrived} moved=${r.moved ?? '-'} ${r.reason ?? ''}`)
    } else { log('B 段：附近没怪，等 5 秒'); await sleep(5000) }
    if (bot.health <= 6) { log('⚠️ 血太低，B 段不追了'); break }
  }
}
const resB = await watch('阶段 3B：没人值守 → 也不还手、也不自己跑（只记档）', OBSERVE_SEC)

/* ───────────────── 结论 ───────────────── */
ticking = false
clearInterval(ticker)
const st = auto.stateOf('live-pve')
const steerTexts = agent.steers.map((m) => String(m?.content?.[0]?.text ?? ''))
const hit = (re) => steerTexts.some((t) => re.test(t))
log('──────── 结论 ────────')
log('① 环境：血', bot.health, '｜武器', sword ? sword.name : '无', '｜碰到怪', met ? `${met.name} ${met.d.toFixed(1)}格` : '没碰到')
log('② A 有人值守：抢占', resA.delta.interrupts, '次｜自己撤', resA.delta.walks, '次｜叫醒 AI', resA.delta.steers, '次｜还手', resA.delta.attacks, '次｜移动', resA.moved.toFixed(1), '格｜怪的距离', JSON.stringify(resA.foeDist))
log('③ A 的 steer 文案含：怪名', hit(HOSTILE), '｜血量', hit(/血 \d/), '｜attack 提示', hit(/action.*attack/), '｜"不用问我"', hit(/不用问我/))
log('④ B 没人值守：抢占', resB.delta.interrupts, '次｜自己撤', resB.delta.walks, '次｜还手', resB.delta.attacks, '次（**应该都是 0** —— 反射层永不自己动手；attack 调用：', JSON.stringify(spy.attacks.slice(-3).map((a) => ({ who: a.who, at: new Date(a.at).toISOString().slice(11, 19) }))), '）')
log('⑤ auto stats：', JSON.stringify(st?.stats ?? null), '｜lastError：', JSON.stringify(st?.lastError ?? null))
log('⑥ 反射层日志条数：', spy.autoLogs.length, '｜最后 3 条：', JSON.stringify(spy.autoLogs.slice(-3)))
log('⑦ 活着：', bot.health > 0, '｜最终位置', posStr(bot.entity.position), '｜背包', bot.inventory.items().map((i) => `${i.name}x${i.count}`).join(' ') || '空')

writeFileSync(LOGFILE, lines.join('\n') + '\n')
try { await mc.disconnect('PvE 验证结束') } catch { /* 忽略 */ }
setTimeout(() => process.exit(0), 800)
