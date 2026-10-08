/**
 * live-auto5.mjs —— 自主层实机验证 ⑤：真服上验"待机 5 秒触发"（用户 m02357）
 *
 * 目的：默认值改成了 idleWakeSec/minIdleGapSec/idleWakeNearPlayerSec = 5s，
 *       这里**一个时间参数都不改**（只关掉反射层免得乱走），用真服 + 真时钟看叫醒节奏：
 *         第 1 次 ≈5s（待机 5 秒触发）
 *         第 2 次 ≈10s（间隔 5s）
 *         第 3 次 ≈20s（没动作 → 退避翻倍到 10s）
 *         第 4 次 ≈40s（再翻倍到 20s）
 * 跑法：node live-auto5.mjs（约 50 秒）
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const PKG = 'file:///C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const { McBot } = await import(`${PKG}/src/core.mjs`)
const { createAuto, AUTO_DEFAULTS } = await import(`${PKG}/extensions/mc_auto.mjs`)

const OUT = 'C:/Users/BLUE/Desktop/agent/dsh-mc-agent/mc_auto-实机验证'
mkdirSync(OUT, { recursive: true })
const lines = []
const fmt = (a) => (typeof a[0] === 'string' && a[0].includes('%s')
  ? (() => { let i = 1; return a[0].replace(/%s/g, () => String(a[i++] ?? '')) })()
  : a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
const log = (...a) => { const s = [new Date().toISOString().slice(11, 19), fmt(a)].join(' '); lines.push(s); console.log(s) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const A = new McBot({ host: '127.0.0.1', port: 25565, instanceId: 'live5-a', logFile: `${OUT}/live-auto5-bot.log` })
const B = new McBot({ host: '127.0.0.1', port: 25565, instanceId: 'live5-b', logFile: `${OUT}/live-auto5-bot-b.log` })
log('连接 A / B …')
await A.connect({ host: '127.0.0.1', port: 25565, auth: { mode: 'offline', name: 'mcauto_live' } })
await B.connect({ host: '127.0.0.1', port: 25565, auth: { mode: 'offline', name: 'mcplayer_b' } })
await A.waitForChunks().catch(() => {})
await B.waitForChunks().catch(() => {})
log('A', JSON.stringify(A.status().position), '｜B（当旁边的玩家）', JSON.stringify(B.status().position))

/* ── 假 agent：只记录，永远不动手（模拟"AI 被叫醒后什么都没做"） ── */
const T0 = Date.now()
const steers = []
const agent = {
  id: 'live5-a1', status: 'idle',
  steer (m) {
    const text = String(m?.content?.[0]?.text ?? '')
    steers.push({ at: (Date.now() - T0) / 1000, m })
    log('★ 被插话（%ss，source=%s）', ((Date.now() - T0) / 1000).toFixed(1), m?.source?.summary ?? '?')
    for (const l of text.split('\n')) log('    ' + l)
  },
}
const interrupts = []
const sess = {
  agentId: 'live5-a1', bot: A, agent,
  watchdog: { agent, gate: () => true, lastWakeAt: 0 },
  interruptWait: (k) => { interrupts.push(k) },
}
const registry = {
  listSessions: () => [{ agentId: 'live5-a1', online: true, mode: 'mc', watching: null }],
  peek: (id) => (String(id) === 'live5-a1' ? sess : null),
}
const auto = createAuto({ registry, logLine: (s) => log('[auto]', s), rng: Math.random, now: Date.now })

// 🔴 只关反射层，**不动任何时间参数** —— 用的就是产品默认值（5s）
auto.setConfig(agent, {
  lookAround: false, avoid: false, pickup: false, autoEat: false,
}, { persist: false })
const cfg = auto.cfgFor(agent)
log('生效的时间参数：', JSON.stringify({
  idleWakeSec: cfg.idleWakeSec,
  minIdleGapSec: cfg.minIdleGapSec,
  idleWakeNearPlayerSec: cfg.idleWakeNearPlayerSec,
  idleWakeMaxPerHour: cfg.idleWakeMaxPerHour,
  defaults: {
    idleWakeSec: AUTO_DEFAULTS.idleWakeSec,
    minIdleGapSec: AUTO_DEFAULTS.minIdleGapSec,
    idleWakeNearPlayerSec: AUTO_DEFAULTS.idleWakeNearPlayerSec,
    idleWakeMaxPerHour: AUTO_DEFAULTS.idleWakeMaxPerHour,
  },
}))

const t0 = Date.now()
while (Date.now() - t0 < 48_000) {
  auto.tick(Date.now())
  await sleep(250)
}

const st = auto.stateOf('live5-a1')
const texts = steers.map((s) => String(s.m?.content?.[0]?.text ?? ''))
const wakes = steers.filter((s) => String(s.m?.content?.[0]?.text ?? '').includes('自主行动轮'))
const wakeAt = wakes.map((s) => s.at.toFixed(1))
const gap = (i) => (wakes[i] && wakes[i - 1] ? (wakes[i].at - wakes[i - 1].at).toFixed(1) : '-')

log('──────── 结论 ────────')
log('① 生效间隔（秒）：', JSON.stringify({ idleWakeSec: cfg.idleWakeSec, minIdleGapSec: cfg.minIdleGapSec, near: cfg.idleWakeNearPlayerSec }))
log('② 叫醒次数：', wakes.length, '｜发生在第（秒）：', JSON.stringify(wakeAt))
log('③ 相邻间隔（秒）：', JSON.stringify([gap(1), gap(2), gap(3)]), '（期望 ≈5 / 10 / 20：间隔 5s 起，没动作就翻倍退避）')
log('④ 第 1 次是否 ≈5s：', wakeAt[0] ? Math.abs(Number(wakeAt[0]) - 5) <= 2 : false, '（实际', wakeAt[0] ?? '-', 's）')
log('⑤ 第二轮起文案带"连着 N 轮"警告：', texts.some((t) => t.includes('连着 1 轮')), '｜streak =', st.noActionStreak)
log('⑥ stats：', JSON.stringify({ wakes: st.stats.wakes, nudges: st.stats.nudges, denied: st.stats.denied }))
log('⑦ interruptWait 被打断：', interrupts.length, '次')
writeFileSync(`${OUT}/live-auto5.log`, lines.join('\n') + '\n')
try { A.disconnect?.() } catch { /* 忽略 */ }
try { B.disconnect?.() } catch { /* 忽略 */ }
setTimeout(() => process.exit(0), 800)
