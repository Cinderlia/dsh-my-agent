#!/usr/bin/env node
/**
 * P0-1 移动进度监控 + 自动脱困阶梯自检（`src/movement.mjs`）
 *
 * 用户 2026-10-15 的原话要求（导航优化方案 P0-1）：
 *   「给移动增加**进度监控 + 自动脱困**……每隔约 500–1000 ms 采样一次坐标……
 *     连续 2–3 秒没有有效位移，判定为疑似卡住……按顺序尝试重新计算路径、跳跃脱困、
 *     后退后重新寻路……多次失败后返回明确的 `stuck` 或 `unreachable`，不要无限重试」
 *   「**关键点：不要只根据速度为零判断卡住**。机器人在跳跃、落地、等待方块更新或
 *     接近目标时，短时间不动可能是正常的。」
 *
 * 这一套要钉死四件事：
 *   ① **判据是"既没挪动、也没靠近"** —— 光看速度为零会把正常停顿误判成卡住；
 *      反过来，"一直在动但没靠近"（绕圈）必须照样判卡住；
 *   ② **正常等待要豁免** —— 挖着 / 放着 / 悬空（跳跃落地中）算正常等待，把进度时钟往后推，
 *      但最多推 `MOVE_BUSY_MAX_MS`（免得一直挖个不停就永远不判卡）；
 *   ③ **阶梯顺序与收尾** —— 重算路径 → 跳跃脱困 → 后退再寻路；三级用完明确报 `unreachable`
 *      并带上 `repathCount`，**不无限重试**；采样器的定时器一定收掉（不然把进程钉住）；
 *   ④ **脱困动作不能跟 pathfinder 抢控制位** —— 必须先 `setGoal(null)` 真停
 *      （vendor 每个 physicsTick 都会把 forward/jump 按回去），且**不换 goal 对象**
 *      （换了 vendor 的 `goto` 会直接以 `GoalChanged` 拒绝，等于把这次走路判死）。
 *
 * 用法：node tools/check-move-progress.mjs
 */
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import vec3pkg from 'vec3'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const mod = await import(new URL('../src/movement.mjs', import.meta.url))
const {
  MOVE_SAMPLE_MS, MOVE_STUCK_MS, MOVE_BUSY_MAX_MS, MOVE_ESCAPES,
  escapeStepOf, escapeTextOf, moveBusyNow, moveProgressWatcher, escapeMove, walkPathfinder, routeTrack,
} = mod

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? `  → ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 假时钟：注入给采样器，免得一套断言真等 2.4 秒 × 4 轮 ─────────────────── */
function fakeClock () {
  let t = 0
  const jobs = []
  const c = {
    onTick: null,
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, ms, at: t + ms, live: true }; jobs.push(h); return h },
    clearTimer: (h) => { if (h) h.live = false },
    get live () { return jobs.filter((j) => j.live).length },
    async advance (ms) {
      const target = t + ms
      for (;;) {
        const due = jobs.filter((j) => j.live && j.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        t = due.at
        due.at = t + due.ms
        due.fn()
        if (c.onTick) c.onTick()
        await Promise.resolve()
      }
      t = target
    },
  }
  return c
}
/** 让假时钟自己往前走（真实 1ms 推 600ms 假时间）—— 驱动 `walkPathfinder` 的整条循环 */
function autoClock () {
  const c = fakeClock()
  let busy = false
  const h = setInterval(() => {
    if (busy) return
    busy = true
    c.advance(MOVE_SAMPLE_MS).finally(() => { busy = false })
  }, 1)
  c.stopPump = () => clearInterval(h)
  return c
}

/* ── 只够采样器 / escapeMove 用的假机器人 ─────────────────────────────────── */
function mkProbe (pos = { x: 0, y: 64, z: 0 }, { mining = false, building = false, onGround = true } = {}) {
  const b = {
    entity: { position: new Vec3(pos.x, pos.y, pos.z), onGround },
    controls: [],
    pathfinder: { isMining: () => mining, isBuilding: () => building },
    setControlState (k, v) { b.controls.push([k, v]) },
  }
  return b
}
const watchOpts = (clock) => ({ arrive: 1.6, ty: 64, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })

/* ═══════════════ ① 阶梯：纯函数 ═══════════════ */
section('① 脱困阶梯的顺序与命名（纯函数）')
{
  ok(Array.isArray(MOVE_ESCAPES) && MOVE_ESCAPES.length === 3, '阶梯就是三级', JSON.stringify(MOVE_ESCAPES))
  ok(MOVE_ESCAPES[0] === 'repath' && MOVE_ESCAPES[1] === 'jump' && MOVE_ESCAPES[2] === 'backoff',
    '🔴 顺序 = 用户要求的「重算路径 → 跳跃脱困 → 后退再寻路」', MOVE_ESCAPES.join(' → '))
  ok(escapeStepOf(0) === 'repath' && escapeStepOf(1) === 'jump' && escapeStepOf(2) === 'backoff',
    'escapeStepOf(n) 按序给动作')
  ok(escapeStepOf(3) === null && escapeStepOf(99) === null, '🔴 走完阶梯返回 null（= 该认输了，不无限重试）')
  ok(escapeTextOf('repath') === '重算路径' && escapeTextOf('jump') === '跳跃脱困' && escapeTextOf('backoff') === '后退再寻路',
    'escapeTextOf 的中文名（日志与返回值文案用）')
  ok(escapeTextOf('随便什么') === '放弃', '不认识的级别 → 放弃')
  ok(MOVE_SAMPLE_MS >= 500 && MOVE_SAMPLE_MS <= 1000, '采样间隔落在用户要求的 500–1000ms 里', `${MOVE_SAMPLE_MS}ms`)
  ok(MOVE_STUCK_MS >= 2000 && MOVE_STUCK_MS <= 3000, '判卡阈值落在用户要求的 2–3 秒里', `${MOVE_STUCK_MS}ms`)
}

/* ═══════════════ ② moveBusyNow：什么算"正常等待" ═══════════════ */
section('② moveBusyNow —— 挖着 / 放着 / 悬空都算正常等待（用户点名的坑）')
{
  ok(moveBusyNow(mkProbe({}, { mining: true })) === true, '正在挖（pathfinder.isMining）⇒ 忙')
  ok(moveBusyNow(mkProbe({}, { building: true })) === true, '正在放（pathfinder.isBuilding）⇒ 忙')
  ok(moveBusyNow(mkProbe({}, { onGround: false })) === true, '悬空（跳跃 / 落地中）⇒ 忙')
  ok(moveBusyNow(mkProbe()) === false, '站着不动、没在挖没在放、踩着地 ⇒ 不忙（照常判卡）')
  ok(moveBusyNow({}) === false, '没有 pathfinder / entity 的假 bot ⇒ 不忙（不当成"永远正常"）')
  ok(moveBusyNow(null) === false, 'null ⇒ 不忙，不抛错')
  ok(moveBusyNow({ get pathfinder () { throw new Error('x') } }) === false, '读字段抛错 ⇒ 吞掉当不忙')
}

/* ═══════════════ ③ 采样器：判据 ═══════════════ */
section('③ moveProgressWatcher —— "既没挪动、也没靠近"才判卡住')
{
  const clock = fakeClock()
  const b = mkProbe()
  const w = moveProgressWatcher(b, { x: 10, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_STUCK_MS - MOVE_SAMPLE_MS)
  ok(err === null, `不到 ${MOVE_STUCK_MS}ms 不判卡住（跳跃/落地/等方块更新都在这段时间里）`)
  await clock.advance(MOVE_SAMPLE_MS * 2)
  ok(err?.mcStuck === true, '🔴 连续既没挪动也没靠近 ⇒ reject 一个带 mcStuck 的错误')
  ok(Number.isFinite(err?.remaining) && err.remaining > 9, '错误里带 remaining（还剩多远）', String(err?.remaining))
  ok(w.info().stuck?.ms >= MOVE_STUCK_MS, 'info() 记下卡了多久（排查用）', JSON.stringify(w.info()))
  ok(clock.live === 0, '判卡住后采样定时器自己收掉')
  w.stop()
}
{
  const clock = fakeClock()
  const b = mkProbe()
  const w = moveProgressWatcher(b, { x: 20, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  for (let i = 1; i <= 8; i++) {
    b.entity.position = new Vec3(i * 0.8, 64, 0)     // 每 600ms 靠近 0.8 格（> eps）
    await clock.advance(MOVE_SAMPLE_MS)
  }
  ok(err === null, '🔴 一直在靠近 ⇒ 永远不判卡住（哪怕还没到）')
  w.stop()
}
{
  // 绕着目标转圈：位置一直在变（速度不为零），但离目标始终 10 格
  const clock = fakeClock()
  const b = mkProbe({ x: 10, y: 64, z: 0 })
  const w = moveProgressWatcher(b, { x: 0, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  let a = 0
  for (let i = 0; i < 6; i++) {
    a += 0.9
    b.entity.position = new Vec3(10 * Math.cos(a), 64, 10 * Math.sin(a))
    await clock.advance(MOVE_SAMPLE_MS)
  }
  ok(err?.mcStuck === true, '🔴 **只挪动、不靠近**（绕圈）照样判卡住 —— 不是"速度为零才算"，用户点名的那条')
  w.stop()
}
{
  const clock = fakeClock()
  const b = mkProbe({ x: 9, y: 64, z: 0 })          // 离目标 1 格 ⇒ 已经在到达半径里
  const w = moveProgressWatcher(b, { x: 10, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_STUCK_MS * 3)
  ok(err === null, '已经在到达半径里 ⇒ 不动也不算卡住')
  w.stop()
}

/* ═══════════════ ④ 采样器：正常等待的豁免有上限 ═══════════════ */
section('④ 正常等待豁免有上限（一直挖个不停不会变成"永远正常"）')
{
  const clock = fakeClock()
  const b = mkProbe({}, { mining: true })
  const w = moveProgressWatcher(b, { x: 10, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_BUSY_MAX_MS + MOVE_STUCK_MS - 200)
  ok(err === null, `挖着不动最多推 ${MOVE_BUSY_MAX_MS}ms，之前不判卡住`)
  await clock.advance(MOVE_SAMPLE_MS * 2)
  ok(err?.mcStuck === true, '🔴 一直挖超过 busyMax 之后就不再当"正常等待"，照判卡住')
  w.stop()
}
{
  const clock = fakeClock()
  const b = mkProbe({}, { onGround: false })
  const w = moveProgressWatcher(b, { x: 10, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_STUCK_MS)
  ok(err === null, '悬空（跳跃落地中）不判卡住')
  w.stop()
}

/* ═══════════════ ⑤ 采样器：stop() 之后彻底安静 ═══════════════ */
section('⑤ stop() 之后彻底安静（不能留下把进程钉住的定时器）')
{
  const clock = fakeClock()
  const b = mkProbe()
  const w = moveProgressWatcher(b, { x: 10, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_SAMPLE_MS)
  w.stop()
  ok(clock.live === 0, 'stop() 清掉定时器')
  await clock.advance(MOVE_STUCK_MS * 4)
  ok(err === null, '🔴 stop() 之后即使时间再久也不 reject（否则是"竞速结束了才炸"）')
  ok(w.info().stuck === null, 'stop() 之后 info() 也不记"卡住"')
  let again = false
  try { w.stop() } catch { again = true }
  ok(again === false, 'stop() 可以重复调（finally 里无脑调一次）')
}

/* ═══════════════ ⑤b P1：路径失效重算（不用等满 2.4 秒） ═══════════════ */
section('⑤b P1 —— 路径被反复失效：光重算没用，直接进阶梯')
{
  const clock = fakeClock()
  let resets = 3
  const w = moveProgressWatcher(mkProbe(), { x: 10, y: 64, z: 0 },
    { ...watchOpts(clock), resetsOf: () => resets, resetLimit: 4 })
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_SAMPLE_MS * 2)
  ok(err === null, '失效 3 次（< 上限 4）还不认输')
  resets = 4
  await clock.advance(MOVE_SAMPLE_MS)
  ok(err?.mcStuck === true, '🔴 失效到上限 ⇒ 直接判卡住（不等满 2.4 秒）')
  ok(err?.mcPathThrash === true, '🔴 带 mcPathThrash 标记（跟"没进展"分开报，下一步建议也不同）')
  ok(/路径被反复失效/.test(String(err?.message ?? '')), '文案说清是"光重算没用"', String(err?.message))
  ok(w.info()?.stuck?.thrash === true && w.info()?.stuck?.resets === 4, 'info() 记下成因与次数', JSON.stringify(w.info()))
  ok(clock.live === 0, '认输时收掉定时器')
}
{
  const clock = fakeClock()
  const b = mkProbe({ x: 0, y: 64, z: 0 })
  const w = moveProgressWatcher(b, { x: 10, y: 64, z: 0 },
    { ...watchOpts(clock), resetsOf: () => 99, resetLimit: 4 })
  let err = null
  w.promise.catch((e) => { err = e })
  for (let i = 1; i <= 6; i++) {
    b.entity.position = new Vec3(i * 0.9, 64, 0)   // 每轮都在靠近
    await clock.advance(MOVE_SAMPLE_MS)
  }
  ok(err === null, '🔴 一直在靠近 ⇒ 失效次数再多也不叫停（**进展优先**：一直被打断但还在往前挪，就让它挪）')
  w.stop()
}
{
  const clock = fakeClock()
  const w = moveProgressWatcher(mkProbe({}, { mining: true }), { x: 10, y: 64, z: 0 },
    { ...watchOpts(clock), resetsOf: () => 99, resetLimit: 4 })
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_SAMPLE_MS * 3)
  ok(err === null, '挖着（算正常等待）⇒ 失效次数也不叫停（挖本身就会让世界更新、路径失效）')
  w.stop()
}
{
  const clock = fakeClock()
  const w = moveProgressWatcher(mkProbe(), { x: 10, y: 64, z: 0 },
    { ...watchOpts(clock), resetsOf: () => { throw new Error('x') }, resetLimit: 4 })
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_STUCK_MS + MOVE_SAMPLE_MS)
  ok(err?.mcStuck === true && err?.mcPathThrash !== true,
    'resetsOf 抛错 ⇒ 当 0：仍按"没进展"判卡（不炸、也不误报 thrash）')
}
{
  const clock = fakeClock()
  const w = moveProgressWatcher(mkProbe(), { x: 10, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_STUCK_MS + MOVE_SAMPLE_MS)
  ok(err?.mcStuck === true && err?.mcPathThrash !== true, '不传 resetsOf ⇒ 退回 P0-1 那套纯"没进展"判据')
}

/* ═══════════════ ⑥ escapeMove：先真停、再动控制位 ═══════════════ */
section('⑥ escapeMove —— 先真停 pathfinder，再按控制位')
{
  const b = mkProbe()
  const stops = []
  const ctx = { stopPathing: (bb) => stops.push(bb === b) }
  const goal = { x: 0, y: 64, z: 0 }
  await escapeMove(b, goal, 'repath', ctx)
  ok(stops.length === 1 && stops[0] === true, '🔴 每一级脱困都先 ctx.stopPathing(b)（不然 vendor 每个 tick 把控制位按回去）')
  ok(b.controls.length === 0, 'repath 只重算，不按任何控制位')
  b.controls.length = 0; stops.length = 0
  await escapeMove(b, goal, 'jump', ctx)
  ok(stops.length === 1, 'jump 级同样先真停')
  ok(b.controls.some(([k, v]) => k === 'jump' && v === true) && b.controls.some(([k, v]) => k === 'jump' && v === false),
    'jump 级按住 jump 再松开（卡在台阶/栅栏/半砖边缘时最有效）', JSON.stringify(b.controls))
  b.controls.length = 0; stops.length = 0
  await escapeMove(b, goal, 'backoff', ctx)
  ok(b.controls.some(([k, v]) => k === 'back' && v === true) && b.controls.some(([k, v]) => k === 'back' && v === false),
    'backoff 级按住 back 再松开（贴墙贴角时原地重算还是同一条死路）', JSON.stringify(b.controls))
  ok(!b.controls.some(([k]) => k === 'jump'), 'backoff 不顺手按 jump（两级动作不混）')
  let threw = false
  try { await escapeMove(b, goal, 'repath', { stopPathing: () => { throw new Error('x') } }) } catch { threw = true }
  ok(threw === false, 'stopPathing 抛错不把整次走路炸掉')
}

/* ═══════════════ ⑦ walkPathfinder 整条循环 ═══════════════ */
section('⑦ walkPathfinder 整条循环：卡住 → 阶梯 → 明确 unreachable')

function mkLoopBot (start = { x: 0, y: 64, z: 0 }) {
  const b = {
    entity: { position: new Vec3(start.x, start.y, start.z), onGround: true },
    controls: [],
    calls: { goto: 0, setGoal: [] },
    _pending: null,
  }
  b.blockAt = () => ({ name: 'stone' })
  b.setControlState = (k, v) => b.controls.push([k, v])
  b.on = () => {}
  b.removeListener = () => {}
  b.pathfinder = {
    isMining: () => false,
    isBuilding: () => false,
    setMovements: () => {},
    setGoal (g) {
      b.calls.setGoal.push(g)
      if (g === null && b._pending) {
        const p = b._pending; b._pending = null
        const e = new Error('GoalChanged'); e.name = 'GoalChanged'; p.reject(e)
      }
    },
    goto () {
      b.calls.goto++
      return new Promise((resolve, reject) => { b._pending = { resolve, reject } })
    },
  }
  b.settleGoto = (fn) => { const p = b._pending; if (p) { b._pending = null; fn(p) } }
  return b
}
function mkSelf (bot, budgetMs = 20000) {
  const self = {
    bot,
    cfg: { moveBudgetMs: budgetMs },
    abortSignal: null,
    _moveGen: 0,
    logs: [],
    _pf: {
      goals: {
        GoalNear: class {
          constructor (x, y, z, r) { this.x = x; this.y = y; this.z = z; this.range = r }
          /* 2026-10-18：假 goal 也要有真 isEnd —— 到达判定现在先看"是不是我的目标"，
           * 永远 false 的桩会把所有"到附近"的用例判成 goal-reached-elsewhere。 */
          isEnd (p) {
            const q = p?.position ?? p
            const dx = q.x - this.x, dy = q.y - this.y, dz = q.z - this.z
            return Math.hypot(dx, dz) <= this.range + 3.0 && Math.abs(dy) <= 1.5
          }
        },
      },
      Movements: class {},
    },
    msLeft: () => 30000,
    log (m) { self.logs.push(String(m)) },
  }
  return self
}
function mkCtx (self, clock) {
  return {
    movements: () => ({}),
    collectBusy: () => false,
    cancelCollect: async () => {},
    beginMove: () => ++self._moveGen,
    stopPathing: (bb) => { bb.pathfinder.setGoal(null) },
    releaseControls: () => {},
    watchOpts: { arrive: 1.6, ty: 64, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  }
}

{
  const clock = autoClock()
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const ctx = mkCtx(self, clock)
  const r = await walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 20000 }, ctx)
  clock.stopPump()
  ok(r.arrived === false && r.stuck === true, '走不动 ⇒ arrived:false / stuck:true', JSON.stringify({ a: r.arrived, s: r.stuck }))
  ok(r.reason === 'unreachable', '🔴 阶梯用完 ⇒ reason = unreachable（**不是** timeout / 不是"再叫一次"）', String(r.reason))
  ok(r.repathCount === MOVE_ESCAPES.length, `repathCount = ${MOVE_ESCAPES.length}（三级都试过了）`, String(r.repathCount))
  ok(bot.calls.goto === MOVE_ESCAPES.length + 1, `重新 goto 了 ${MOVE_ESCAPES.length + 1} 次（首次 + 每级脱困各一次）`, String(bot.calls.goto))
  ok(/真的走不动了/.test(r.hint ?? ''), 'hint 如实说"真的走不动了"', String(r.hint).slice(0, 60))
  ok(/别原地重试/.test(r.hint ?? ''), '🔴 hint 明确劝"别原地重试"（把长路拆成几段）', String(r.hint).slice(0, 90))
  ok(!/再叫一次 mc_move 往同一个目标走/.test(r.hint ?? ''), '不误报成"再叫一次就好"')
  const escLogs = self.logs.filter((m) => /脱困/.test(m))
  ok(escLogs.length === MOVE_ESCAPES.length, '每级脱困各记一行日志', String(escLogs.length))
  ok(/重算路径/.test(escLogs[0] ?? '') && /跳跃脱困/.test(escLogs[1] ?? '') && /后退再寻路/.test(escLogs[2] ?? ''),
    '日志按阶梯顺序（重算路径 → 跳跃脱困 → 后退再寻路）', JSON.stringify(escLogs.map((s) => s.slice(0, 30))))
  ok(bot.controls.some(([k, v]) => k === 'jump' && v === true), '真的按过 jump（跳跃脱困不是空话）')
  ok(bot.controls.some(([k, v]) => k === 'back' && v === true), '真的按过 back（后退再寻路不是空话）')
  ok(clock.live === 0, '🔴 收尾时采样器定时器全清掉（不然把进程钉住）')
  ok(bot.calls.setGoal.filter((g) => g === null).length >= MOVE_ESCAPES.length,
    '每次重发 goto 前都先 setGoal(null) 真停（不攒重复的 goal_reached 监听器）', String(bot.calls.setGoal.filter((g) => g === null).length))
}
{
  // 一路靠近 ⇒ 不脱困、直接到达
  const clock = autoClock()
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const ctx = mkCtx(self, clock)
  const target = { x: 20, y: 64, z: 0 }
  clock.onTick = () => {
    const p = bot.entity.position
    const d = p.distanceTo(new Vec3(target.x, 64, target.z))
    if (d <= 1.6) { bot.settleGoto((q) => q.resolve()); return }
    bot.entity.position = new Vec3(p.x + 0.8, 64, p.z)
  }
  const r = await walkPathfinder(self, target, { arrive: 1.6, budget: 20000 }, ctx)
  clock.stopPump()
  ok(r.arrived === true, '一路靠近 ⇒ 正常到达', JSON.stringify({ a: r.arrived, rem: r.remaining }))
  ok(r.repathCount === undefined, '🔴 没卡住就不报 repathCount（不无中生有）', String(r.repathCount))
  ok(bot.calls.goto === 1, '一次 goto 就走完（没白重算）', String(bot.calls.goto))
  ok(self.logs.filter((m) => /脱困/.test(m)).length === 0, '没记任何脱困日志')
  ok(clock.live === 0, '收尾清掉采样器')
}
{
  /* P1：**水平到位、垂直差两格** —— 三维距离其实小于阈值（旧判据会报"到了"），
   * 但人站在目标正上方，必须判成"没到"。假 bot 的 `blockAt` 恒为 stone ⇒ `ty` 就是 64。 */
  const clock = autoClock()
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const ctx = mkCtx(self, clock)
  const target = { x: 20, y: 64, z: 0 }
  let done = false
  clock.onTick = () => {
    if (done) return
    done = true
    bot.entity.position = new Vec3(20, 66, 0)      // 水平 0 格、垂直 +2 格
    bot.settleGoto((q) => q.resolve())
  }
  const r = await walkPathfinder(self, target, { arrive: 1.6, budget: 20000 }, ctx)
  clock.stopPump()
  ok(r.remaining <= 1.6 + 1.0, '前提：这个位置的三维距离确实小于阈值（正是旧判据会误报的情形）', String(r.remaining))
  ok(r.arrived === false, '🔴 水平到位、高 2 格 ⇒ 不报"到了"（旧判据只看三维距离会放过去）', JSON.stringify({ a: r.arrived, rem: r.remaining }))
  ok(r.reason === 'goal_reached-but-far', 'reason = goal_reached-but-far', String(r.reason))
  ok(r.vert === 2 && r.horiz === 0, '把两个轴分开报出来', JSON.stringify({ h: r.horiz, v: r.vert }))
  ok(/高度不对/.test(r.hint ?? ''), '🔴 hint 点明"高度不对"（不是含糊的"还差 N 格"）', String(r.hint).slice(0, 80))
  ok(/同一层/.test(r.hint ?? ''), '下一步给的是"走到同一层"（能直接执行）', String(r.hint).slice(0, 120))
  ok(clock.live === 0, '收尾清掉采样器')
}

/* ═══════════════ ⑧ 静态接线：循环与返回值真的接上了 ═══════════════ */
section('⑧ 静态接线（谁把这几条改回去谁红）')
{
  const raw = read('../src/movement.mjs')
  const src = strip(raw)
  ok(/await Promise\.race\(\[\s*[\s\S]{0,300}?watch\.promise,?\s*\]\)/.test(src),
    '🔴 walkPathfinder 把采样器的 promise 和 goto 一起竞速')
  ok(!/await raceAbort\(withTimeout\(work, budget, '寻路'\), self\.abortSignal, '寻路'\)/.test(src),
    '🔴 不再是"一次 goto 到底"的老写法')
  ok(/let attempt = 0\s*\n\s*for \(;;\)/.test(src), '有重试循环（attempt 手动推进：挖台阶补救不算一级脱困）')
  ok(/const step = escapeStepOf\(attempt - 1\)/.test(src), '每轮按阶梯取脱困动作')
  ok(/err\.mcStuck = true[\s\S]{0,120}?err\.mcExhausted = true/.test(src), '阶梯用完抛的是带 mcStuck 的错误')
  ok(/if \(e\?\.mcStuck\)[\s\S]{0,1400}?attempt\+\+[\s\S]{0,200}?continue/.test(src), '采样器判卡 ⇒ 补救没戏就进下一轮脱困')
  ok(/await carveStepAhead\(b, target, \{ ignoreRange: true \}\)/.test(src) && /carveTries < MOVE_CARVE_TRIES/.test(src),
    '🔴 阶梯之前先试"挖开挡路的台阶"（2026-10-18 实机；审计后改成看眼前障碍）')
  ok(/const carveAllowed = ctx\.cfg\?\.[\s\S]{0,120}?walkCarveStep !== false/.test(src),
    '🔴 自动挖台阶服从 walkCanDig / walkCarveStep（不许绕过配置）')
  ok(/export const CARVE_PROTECTED = new RegExp/.test(src), '容器/矿石/装置有保护名单（不替 AI 挖掉）')
  ok(/export function obstacleAheadOf/.test(src) && /obstacleAheadOf\(b, target\)/.test(src),
    '🔴 该不该挖看"眼前障碍"，不是离终点还有几格')
  ok(/\.\.\.\(blockedAhead \? \{ blockedAhead \} : \{\}\)/.test(src), '失败结果带"眼前挡路的是什么"')
  ok(/const exhausted = Boolean\(e\?\.mcStuck\)/.test(src), 'catch 里认出 mcStuck')
  ok(/: exhausted \? 'unreachable'/.test(src), '🔴 reason 里有 unreachable 这一档')
  ok(/const moveInfo = \(opts = \{\}\) => \(\{/.test(src), 'moveInfo 是个多字段的汇总（地形 + 脱困 + 路径失效）')
  ok(/\[opts\.arrived \? 'terrainAtStart' : 'terrain'\]/.test(src), '🔴 到达时出发地形改名 terrainAtStart（否则跨到平地仍写 gap，属主动误导）')
  ok(/const arrivedTerrain = \(\) => \{[\s\S]{0,200}?classifyTerrainCached\(b\)/.test(src), '到达时**重算**落点地形（缓存键含脚下坐标，不用手动清）')
  ok(/arrivedTerrain: now\.kind/.test(src), '落点地形单独一个键（不与出发地形混）')
  ok(/\.\.\.moveInfo\(\{ arrived: true \}\), \.\.\.arrivedTerrain\(\)/.test(src), '🔴 到达那条返回路径两个都带上')
  ok(/\.\.\.\(repathCount \? \{ repathCount \} : \{\}\)/.test(src), 'repathCount 只在 >0 时报')
  ok(/\.\.\.\(pathThrash \? \{ pathThrash \} : \{\}\)/.test(src), 'pathThrash 只在 >0 时报')
  ok(/pathResetsTotal >= 2 \? \{ pathResets/.test(src), '失效 ≥2 次才报 pathResets（1 次是正常的）')
  ok([...src.matchAll(/\.\.\.moveInfo\(/g)].length >= 5, '每条返回路径都带上 moveInfo（脱困/失效/地形）', String([...src.matchAll(/\.\.\.moveInfo\(/g)].length))
  ok(/try \{ watch\?\.stop\(\) \} catch \{\}/.test(src), '🔴 finally 里一定收掉采样器')
  ok(/ctx\.watchOpts \?\? \{\}/.test(src), 'watchOpts 可注入（离线测试拿假时钟驱动）')
  // ── P1：路径失效重算 ──
  ok(/export const MOVE_RESET_LIMIT = \d+/.test(src), 'MOVE_RESET_LIMIT 是个具体数字（不是"无限重算"）')
  ok(/resetsOf: \(\) => pathResets/.test(src), '🔴 采样器拿到的是**本轮**失效计数（不是累计值，否则第二趟一开局就认输）')
  ok(/pathResets = 0\s*\/\//.test(src), '每轮把失效计数归零')
  ok(/if \(resetsOf && resetLimit > 0 && resetsNow\(\) >= resetLimit\)/.test(src), '🔴 失效够多就直接进阶梯')
  ok(/if \(e\?\.mcPathThrash\) pathThrash\+\+/.test(src), 'catch 里数"因失效而脱困"的次数')
  ok(/resetReasons\[k\] = \(resetReasons\[k\] \?\? 0\) \+ 1/.test(src), '按理由（stuck / block_updated / …）分类计数')
  ok(/const onReset = \(reason\) => \{[\s\S]{0,120}?pathResets\+\+/.test(src), 'onReset 里真的在数')
  ok(/REASON_TEXT\[k\] \?\? k/.test(src), '报出去的理由也翻成人话（不漏内部字符串）')
  // ── P1：到达判定分两轴 ──
  ok(/const vertBad = vert < -vertTol \|\| vert > vertTol/.test(src), '🔴 垂直窗口按意图给（near ±1.5 / stand ±0.6）')
  ok(/if \(!onSpot && \(mine === false \|\| left > arriveUsed \+ 1\.0 \|\| vertBad\)\)/.test(src), '🔴 高度不对也算"没到"（水平到了、人却在目标上下）')
  ok(/const onSpot = left <= 0\.5 && !vertBad/.test(src), '站在目标点上（≤0.5 格）直接算到（GoalNear 半径内的合理圈）')
  ok(src.indexOf('const mine = !fp') < src.indexOf('if (!onSpot && (mine === false || left > arrive'), '🔴 先判"是不是我的目标"，再看距离（别人到点不许误报成功）')
  ok(/horiz: Number\(horiz\.toFixed\(2\)\), vert: Number\(vert\.toFixed\(2\)\)/.test(src), '两个轴分开报给模型')
  ok(/高度不对/.test(src), 'hint 里点明是"高度不对"（不是"还差 N 格"）')
  ok(/vertBad && horiz <= arriveUsed \+ 1\.0/.test(src), '🔴 "站错层"要单独报（不然会被 `mine === false` 那条吞掉）')
  ok(src.indexOf('vertBad && horiz <= arrive + 1.0') < src.indexOf('emptyNoPath || mine === false'),
    '🔴 顺序：先报"站错层"，再报"别人的锅"（插件的 GoalNear 是三维球，人在上层它必然不满足）')
  ok(/Math\.max\(200, budget - \(Date\.now\(\) - t0\)\)/.test(src), '重试时用**剩余**预算（总时间仍以 budget 为界）')
  ok(!/require\(|import .*mineflayer|prismarine/.test(strip(read('../src/movement.mjs')).replace(/from 'vec3'/g, '')),
    'movement.mjs 不 import 游戏运行时（vec3 除外）')
  const all = read('./check-all.mjs')
  ok(/check-move-progress\.mjs/.test(all), 'check-all.mjs 的 ORDER 里登记了这一套')
}

/* ═══════════════ ⑨ noTower：逃跑时不许寻路器原地垫方块往上爬 ═══════════
 * 用户 2026-10-17 实机：撤退时 pathfinder 把方块垫在自己脚下，一路升到 y=57，越逃越远。
 * vendor 的 `allow1by1towers` 默认 true，而全仓**没有任何一处**设置过它（只出现在注释里）。 */
section('⑨ noTower（逃跑时关掉"原地垫高"）')
{
  const clock = autoClock()
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const mv = {}
  const ctx = { ...mkCtx(self, clock), movements: () => mv }
  await walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 20000, noTower: true }, ctx)
  clock.stopPump()
  ok(mv.allow1by1towers === false, '🔴 noTower ⇒ allow1by1towers = false（逃跑时不再原地垫高）', String(mv.allow1by1towers))
}
{
  const clock = autoClock()
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const mv = {}
  const ctx = { ...mkCtx(self, clock), movements: () => mv }
  await walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 20000 }, ctx)
  clock.stopPump()
  ok(mv.allow1by1towers === false, '🔴 不传 noTower ⇒ **默认也不垫柱**（2026-10-18：实机"拿圆石垫脚乱搭"）', String(mv.allow1by1towers))
}
{
  const src = read('../src/movement.mjs')
  ok(/if \(noTower\) mv\.allow1by1towers = false/.test(src), '🔴 关的是 allow1by1towers 这一个开关')
  ok(!/mv\.scafoldingBlocks = \[\]/.test(src), '🔴 绝不清空 scafoldingBlocks（那会把 1×1 柱子的 move 一起剪掉，掉坑里出不来）')
  ok(/noTower = true, intent = 'near' \} = \{\}, ctx = \{\}\)/.test(src), 'walkTo 也接 noTower，且**默认 true**（不垫柱 —— 2026-10-18 实机：垫柱放错就摔死）')
  /* 🔴 2026-10-17（用户："自动战斗的优先级不应该比 AI 高"）：战斗层**不再自己撤退**，
   *    所以"撤退要关掉垫脚"这条已经没有对象了 —— 反过来要守住"不许再出现撤退执行"。 */
  const atk = read('../src/attack.mjs')
  ok(!/战斗撤退/.test(atk) && !/retreatPointOf/.test(atk),
    '🔴 战斗策略层没有"自己撤退"的移动调用（撤退要 AI 自己叫 mc_move）')
}

/* ═══════════════ ⑨ 掉下去了必须看得见（P0-A） ═══════════════ */
section('⑨ 掉下去了必须看得见：`fell` 字段 + hint 先说掉下去')

/** 真时钟的 ctx（采样器 600ms 才判一次，测试在 30ms 内就把 goto 结掉 ⇒ 不会误触卡住） */
function realCtx (self) {
  return {
    movements: () => ({}),
    collectBusy: () => false,
    cancelCollect: async () => {},
    beginMove: () => ++self._moveGen,
    stopPathing: (bb) => { bb.pathfinder.setGoal(null) },
    releaseControls: () => {},
    watchOpts: { arrive: 1.6, ty: 64 },
  }
}

{
  /* 实机 2026-10-17 20:49：垫柱子时放方块被拒，人从 y=68 掉到 y=47（21 格），
   * 工具却报 `moved: 4.24` + "不是走不通，再叫一次" ⇒ AI 又爬又掉第二次。 */
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const p = walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 20000 }, realCtx(self))
  setTimeout(() => {
    bot.entity.position = new Vec3(2, 43, 0)
    bot.settleGoto((q) => { const e = new Error('Timeout'); e.name = 'Timeout'; q.reject(e) })
  }, 30)
  const r = await p
  ok(r.fell === 21, '结果里带 fell（净下落 21 格）', JSON.stringify({ fell: r.fell, moved: r.moved }))
  ok(r.fellFrom === 64 && r.fellTo === 43, '带 fellFrom / fellTo（说清从哪掉到哪）', `${r.fellFrom}→${r.fellTo}`)
  ok(/你掉下去了 21 格/.test(r.hint ?? ''), '🔴 hint 明说掉下去了', String(r.hint).slice(0, 70))
  ok(/别对着同一个高度反复爬/.test(r.hint ?? ''), 'hint 劝别对着同一个高度反复爬')
  ok(r.moved < 3, '🔴 moved 只有水平位移（旧版就是这样把掉 21 格报成挪了 4.24）', String(r.moved))
}
{
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const p = walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 20000 }, realCtx(self))
  setTimeout(() => {
    bot.entity.position = new Vec3(2, 63, 0)   // 下台阶，只差 1 格
    bot.settleGoto((q) => { const e = new Error('Timeout'); e.name = 'Timeout'; q.reject(e) })
  }, 30)
  const r = await p
  ok(r.fell === undefined, '下台阶（1 格）不算"掉下去"', String(r.fell))
  ok(!/掉下去了/.test(r.hint ?? ''), '没掉下去时 hint 不提掉落')
}
{
  /* 被抢占 + 掉下去：那天 `stopWork` 把移动掐成 preempted，hint 却说"不是走不通，再叫一次" ⇒ 又掉 14 格 */
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const p = walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 20000 }, realCtx(self))
  setTimeout(() => {
    bot.entity.position = new Vec3(1, 47, 0)
    self._moveGen++                        // 模拟"自保反射又发了一次移动"
    bot.settleGoto((q) => q.resolve())
  }, 30)
  const r = await p
  ok(r.reason === 'preempted', '被抢占 ⇒ reason = preempted', String(r.reason))
  ok(r.fell === 17, '被抢占时也报 fell', String(r.fell))
  ok(/你掉下去了 17 格/.test(r.hint ?? ''), '🔴 被抢占 + 掉下去 ⇒ hint 先说掉下去')
  ok(!/不是走不通/.test(r.hint ?? ''), '🔴 不许再说"不是走不通，再叫一次"（那天就是这么掉第二次的）')
}
{
  const src = read('../src/movement.mjs')
  ok(/const fellOf = \(p\) => \{/.test(src), 'fell 由统一的一处算（不散在五个 return 里）')
  ok(/const fellInfo = \(p\) => \{/.test(src) && (src.match(/\.\.\.fellInfo\(end\)/g) ?? []).length >= 5,
    '每个出口都带 fellInfo（arrived / preempted / 站错层 / 没路 / 时间到 / 异常）')
  ok(/const fellNote = \(p\) => \{/.test(src), 'hint 用同一份措辞（掉多少格 + 别反复爬）')
  ok(/d >= 3 \? Number\(d\.toFixed\(1\)\) : null/.test(src), '阈值 3 格：下台阶不算掉下去')
}

/* ═══════════════ ⑧ 窄隧道/台阶的手工补救（carveStepAhead）═══════════════ */
section('⑧′ 位移三种分量（2026-10-18 审计 Bug 2：moved 只有水平，上台阶/掉下去都看不出来）')
{
  const clock = autoClock()
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const ctx = mkCtx(self, clock)
  const target = { x: 0, y: 68, z: 0 }        // 正上方 4 格：只上升、不水平移动
  clock.onTick = () => {
    const p = bot.entity.position
    if (p.y >= 68) { bot.settleGoto((q) => q.resolve()); return }
    bot.entity.position = new Vec3(p.x, p.y + 1, p.z)
  }
  const r = await walkPathfinder(self, target, { arrive: 1.6, budget: 20000 }, ctx)
  clock.stopPump()
  ok(r.moved === 0, '水平没动 ⇒ moved: 0（兼容旧字段）', String(r.moved))
  ok(r.movedVertical === 4 && r.moved3d === 4, '🔴 垂直位移单独报（movedVertical 4 / moved3d 4）',
    JSON.stringify({ v: r.movedVertical, d3: r.moved3d }))
  ok(r.delta && r.delta.y === 4, 'delta.y 是原始分量，不是"总距离"', JSON.stringify(r.delta))
}

section('⑧ 贴着目标却卡住 ⇒ 挖开挡在脚上/头顶的那一格（2026-10-18 实机）')

function mkCarveBot (cells = {}, at = [0, 64, 0]) {
  const map = new Map(Object.entries(cells))
  const b = {
    entity: { position: new Vec3(...at) },
    dug: [], equipped: [],
    blockAt (v) {
      const n = map.get(`${v.x},${v.y},${v.z}`)
      return n ? { name: n, position: v } : { name: 'air', position: v }
    },
    async equip (item, dest) { b.equipped.push([item?.name ?? item, dest]) },
    async dig (blk) { b.dug.push(`${blk.position.x},${blk.position.y},${blk.position.z}`) },
    pathfinder: { bestHarvestTool: () => ({ name: 'iron_pickaxe' }) },
  }
  return b
}
const carve = mod.carveStepAhead

{
  /* 1×2 窄道 + 1 格台阶：脚那格是石头、头顶空，底下有支撑 ⇒ 挖脚那格 */
  const b = mkCarveBot({ '1,64,0': 'stone', '1,63,0': 'stone' })
  const n = await carve(b, { x: 1, y: 64, z: 0 })
  ok(n === 1 && b.dug.includes('1,64,0'), '台阶挡在脚上 ⇒ 挖掉脚那格', JSON.stringify({ n, dug: b.dug }))
  ok(b.equipped.length >= 1, '动手前先换合适的工具（bestHarvestTool）', JSON.stringify(b.equipped))
  ok(!b.dug.some((k) => k === '0,64,0'), '🔴 永不挖自己站的那一格', JSON.stringify(b.dug))
}
{
  /* 天花板低：脚那格空、头顶那格石头 ⇒ 挖头那格（"挖脚+挖头"里的第二下） */
  const b = mkCarveBot({ '1,65,0': 'stone', '1,63,0': 'stone' })
  const n = await carve(b, { x: 1, y: 64, z: 0 })
  ok(n === 1 && b.dug.includes('1,65,0'), '天花板挡着头 ⇒ 挖头那格', JSON.stringify(b.dug))
}
{
  /* 底下是空的 ⇒ 那不是台阶是坑：不许挖（挖开就是往坑里走） */
  const b = mkCarveBot({ '1,64,0': 'stone' })
  const n = await carve(b, { x: 1, y: 64, z: 0 })
  ok(n === 0 && b.dug.length === 0, '前面是坑（底下没支撑）⇒ 不挖', JSON.stringify({ n, dug: b.dug }))
}
{
  /* 底下是岩浆 ⇒ 更不许挖 */
  const b = mkCarveBot({ '1,64,0': 'stone', '1,63,0': 'lava' })
  const n = await carve(b, { x: 1, y: 64, z: 0 })
  ok(n === 0 && b.dug.length === 0, '底下是岩浆 ⇒ 不挖', JSON.stringify({ n, dug: b.dug }))
}
{
  /* 挡路的本身就是岩浆/基岩 ⇒ 不碰 */
  const lava = mkCarveBot({ '1,64,0': 'lava', '1,63,0': 'stone' })
  ok(await carve(lava, { x: 1, y: 64, z: 0 }) === 0 && lava.dug.length === 0, '挡路的是岩浆 ⇒ 不挖')
  const bed = mkCarveBot({ '1,64,0': 'bedrock', '1,63,0': 'stone' })
  ok(await carve(bed, { x: 1, y: 64, z: 0 }) === 0 && bed.dug.length === 0, '挡路的是基岩 ⇒ 不挖（白费时间）')
}
{
  /* 离得远 ⇒ 不挖（远处卡住多半是别的原因，乱挖会把路改坏） */
  const b = mkCarveBot({ '1,64,0': 'stone', '1,63,0': 'stone' })
  const n = await carve(b, { x: 20, y: 64, z: 0 })
  ok(n === 0 && b.dug.length === 0, '离目标太远（> 4.5 格）⇒ 不挖', String(n))
}
{
  /* 台阶在第二格（第一格是通的）—— cells=2 要能看到它 */
  const b = mkCarveBot({ '1,63,0': 'stone', '2,64,0': 'stone', '2,63,0': 'stone' })
  const n = await carve(b, { x: 2, y: 64, z: 0 })
  ok(n === 1 && b.dug.includes('2,64,0'), '台阶在第二格也能看到（cells=2）', JSON.stringify(b.dug))
}
{
  /* 整条链路：贴着目标还 mcStuck ⇒ 先挖开，再重跑同一个 goto（**不**白吃一级脱困） */
  const b = mkCarveBot({ '1,64,0': 'stone', '1,63,0': 'stone' })
  b.on = () => {}
  b.removeListener = () => {}
  b.setControlState = () => {}
  Object.assign(b, {
    controls: [],
    calls: { goto: 0, setGoal: [] },
    pathfinder: {
      isMining: () => false,
      isBuilding: () => false,
      setMovements: () => {},
      bestHarvestTool: () => ({ name: 'iron_pickaxe' }),
      setGoal (g) { b.calls.setGoal.push(g) },
      goto () {
        b.calls.goto++
        if (b.calls.goto === 1) {
          return new Promise((resolve, reject) => {
            setTimeout(() => { const e = new Error('stuck'); e.mcStuck = true; reject(e) }, 10)
          })
        }
        b.entity.position = new Vec3(1, 64, 0)      // 挖开之后走到了
        return Promise.resolve()
      },
    },
  })
  const self = mkSelf(b)
  const r = await walkPathfinder(self, { x: 1, y: 64, z: 0 }, { arrive: 1.6, budget: 20000 }, mkCtx(self, autoClock()))
  ok(r.arrived === true, '挖开台阶后再试一次就到位了', JSON.stringify({ arrived: r.arrived, reason: r.reason }))
  ok(r.carved >= 1, '结果里报 carved（挖开了几格）', String(r.carved))
  ok(b.calls.goto === 2 && r.repathCount === undefined, '🔴 补救只重跑同一个 goto，**不**算一级脱困（repathCount 不出现）',
    JSON.stringify({ goto: b.calls.goto, repathCount: r.repathCount }))
  ok(self.logs.some((m) => /挖开了 1 格/.test(m)), '日志写清"挖开了几格"', JSON.stringify(self.logs.slice(0, 2)))
}

/* ═══════════════ ⑧″ 挖台阶的保护与配置闸门（2026-10-18 审计 Bug 3/4）═══════════════ */
await (async () => {
section('⑧″ 自动挖台阶：不挖箱子/矿石，服从 walkCanDig / walkCarveStep，远处看眼前')
{
  const { obstacleAheadOf } = mod
  // 挡路的是一整排"箱子/钻石矿" ⇒ 一格都不挖
  const b1 = mkCarveBot({ '1,64,0': 'chest', '1,63,0': 'stone' })
  ok((await carve(b1, { x: 1, y: 64, z: 0 })) === 0 && b1.dug.length === 0, '箱子挡路 ⇒ 不挖', JSON.stringify(b1.dug))
  const b2 = mkCarveBot({ '1,64,0': 'diamond_ore', '1,63,0': 'stone' })
  ok((await carve(b2, { x: 1, y: 64, z: 0 })) === 0, '矿石挡路 ⇒ 不挖（那是 AI 的资源）', JSON.stringify(b2.dug))
  // 目标在很远处（>半径），但眼前就有台阶 ⇒ 也要能挖（ignoreRange）
  const b3 = mkCarveBot({ '1,64,0': 'stone', '1,63,0': 'stone' })
  ok((await carve(b3, { x: 40, y: 64, z: 0 })) === 0, '默认仍保守：远处不走就直接调不挖', JSON.stringify(b3.dug))
  const b4 = mkCarveBot({ '1,64,0': 'stone', '1,63,0': 'stone' })
  const n4 = await carve(b4, { x: 40, y: 64, z: 0 }, { ignoreRange: true })
  ok(n4 === 1 && b4.dug.includes('1,64,0'), '🔴 由调用方判定"眼前有障碍"时可以挖（目标在 40 格外）', JSON.stringify(b4.dug))
  // obstacleAheadOf：箱子不算"可下手"，石头才算
  ok(obstacleAheadOf(mkCarveBot({ '1,64,0': 'chest', '1,63,0': 'stone' }), { x: 5, y: 64, z: 0 }) === null,
    '箱子挡路 ⇒ obstacleAheadOf 报"没有可下手的障碍"')
  ok(obstacleAheadOf(mkCarveBot({ '1,64,0': 'stone', '1,63,0': 'stone' }), { x: 5, y: 64, z: 0 })?.name === 'stone',
    '石头挡路 ⇒ obstacleAheadOf 报出坐标与方块名')
  // 配置闸门：walkCanDig:false 时整个 carve 分支不执行
  {
    const clock = autoClock()
    const bot = mkLoopBot()
    const digged = []
    bot.dig = async (blk) => { digged.push(`${blk.position.x},${blk.position.y},${blk.position.z}`) }
    bot.pathfinder.bestHarvestTool = () => ({ name: 'iron_pickaxe' })
    bot.equip = async () => {}
    bot.blockAt = (v) => ({ name: 'stone', position: v })
    const self = mkSelf(bot)
    const ctx = mkCtx(self, clock)
    ctx.cfg = { walkCanDig: false }
    clock.onTick = () => { if (bot._pending) { const p = bot._pending; bot._pending = null; const e = new Error('stuck'); e.mcStuck = true; p.reject(e) } }
    const r = await walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 6000 }, ctx)
    clock.stopPump()
    ok(digged.length === 0, '🔴 walkCanDig:false ⇒ 一格都不挖（配置没被绕过）', JSON.stringify(digged))
    ok(r.arrived === false && r.reason === 'unreachable', '照样如实报走不动', JSON.stringify({ a: r.arrived, r: r.reason }))
  }
}
})()

console.log(`\n${'─'.repeat(50)}`)
/* ── ⑧‴ 失败结果可操作：眼前障碍 + 泳的三维位移（2026-10-18 审计 P1/Bug2）── */
section('⑧‴ 失败结果"可操作"：眼前挡路的那格 + 泳也算三维位移')
{
  const clock = autoClock()
  const bot = mkLoopBot()
  bot.blockAt = (v) => ({ name: (v.y === 63 ? 'stone' : (v.x === 1 && v.y === 64 ? 'stone' : 'air')), position: v })
  const self = mkSelf(bot)
  const ctx = mkCtx(self, clock)
  clock.onTick = () => { if (bot._pending) { const p = bot._pending; bot._pending = null; const e = new Error('stuck'); e.mcStuck = true; p.reject(e) } }
  const r = await walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 4000 }, ctx)
  clock.stopPump()
  ok(r.blockedAhead && r.blockedAhead.name === 'stone' && r.blockedAhead.cell === 'feet',
    '🔴 失败结果里带上"眼前挡路的是什么"（名字/坐标/脚还是头）', JSON.stringify(r.blockedAhead))
  ok(/mc_act \{mode:"break"/ .test(r.hint ?? ''), 'hint 直接给出"挖掉它"的可执行命令', String(r.hint).slice(0, 120))
  const src = read('../src/movement.mjs')
  ok(/movedHorizontal: r2\(Math\.hypot\(swimDx, swimDz\)\)/.test(src) && /movedVertical: swimDy/.test(src),
    '🔴 游泳也报三维分量（以前只有水平 moved）')
}
/* ── ⑪ 导航意图 / 规划-移动耗时拆分 / 竖井信息包 / 水流漂移（2026-10-18 审计 P1-P2） ── */
{
  const src = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  const { INTENTS, intentOf, shaftInfoOf } = mod
  ok(INTENTS.near.arrive === 1.6 && INTENTS.stand.arrive === 0.8
    && INTENTS.interact.arrive === 2.2 && INTENTS['same-level'].vertTol === 0.9,
    '四种导航意图的"到"标准固定下来（near/stand/interact/same-level）')
  ok(intentOf('nope') === INTENTS.near, '未知意图按 near 兜底（写错一个词不该让整次移动失败）')
  ok(/const arriveUsed = arrive === 1\.6 \? pre\.arrive : arrive/.test(src)
    && /const vertTol = pre\.vertTol/.test(src), '意图真的接到了到达复核（arriveUsed / vertTol）')

  // 竖井：头顶当场封死
  const b1 = mkCarveBot({ '0,66,0': 'stone' }, [0, 64, 0])
  const sh1 = shaftInfoOf(b1, { x: 2, y: 64, z: 0 })
  ok(sh1 && sh1.headroom === 0 && sh1.ceiling === 'stone' && sh1.canJump === false,
    '头顶封死 ⇒ headroom 0、canJump false，并报出封着的是什么', JSON.stringify(sh1 && { h: sh1.headroom, c: sh1.ceiling }))
  ok(sh1 && /跳不起来/.test(sh1.hint), '提示里明说"跳不起来，原地垫脚也不行"')

  // 头顶 2 格净空、再往上是石头；东边能走、脚下有支撑
  const b2 = mkCarveBot({ '0,68,0': 'stone', '1,64,0': 'air', '1,63,0': 'stone' }, [0, 64, 0])
  b2.inventory = { items: () => [{ name: 'cobblestone', count: 7 }, { name: 'iron_sword', count: 1 }] }
  const sh2 = shaftInfoOf(b2, { x: 2, y: 64, z: 0 })
  ok(sh2 && sh2.headroom === 2 && sh2.ceiling === 'stone' && sh2.canJump === true,
    '头顶按格数算净空（y=66/67 空、68 就是石头）', JSON.stringify(sh2 && { h: sh2.headroom, c: sh2.ceiling }))
  ok(sh2 && sh2.pillar === 7, '背包里能垫的方块数只数便宜方块（圆石 7，铁剑不算）', JSON.stringify(sh2 && sh2.pillar))
  ok(sh2 && sh2.sides.e === 'stone', '四面哪边有落脚地报出来（东边站脚那格底是石头）', JSON.stringify(sh2 && sh2.sides))
  ok(sh2 && /能跳/.test(sh2.hint) && /垫/.test(sh2.hint), '提示同时说"能跳"和"有 N 个能垫的"')

  // 走不到 + 不是被抢占 ⇒ 结果里带 shaft；被抢占不带
  ok(/\(exhausted \|\| e\?\.name === 'NoPath'\) && !preempted \? \(\(\) => \{ const sh = shaftInfoOf/.test(src),
    '🔴 只有真的走不到（卡死/没路）才给竖井信息包，被抢占/时间到不给')

  // 规划 / 移动耗时拆分
  ok(/let plannedAt = null/.test(src) && /if \(!plannedAt\) plannedAt = Date\.now\(\)/.test(src)
    && /timing: \{ planMs: plannedAt \? plannedAt - t0 : null/.test(src),
    '🔴 第一次算出路径的时刻单独记，结果里 planMs / walkMs 分开报')

  // 水流漂移：只在水里、按窗口量、反压一档、真松开
  ok(/export const SWIM_DRIFT_EPS = 0\.35/.test(src), '横向漂移有阈值（0.35 格/窗口）')
  ok(/const perp = \(mvx \* \(-gz \/ gl\) \+ mvz \* \(gx \/ gl\)\)/.test(src),
    '🔴 漂移按"垂直于目标方向"的分量算（不是总位移）')
  ok(/lastStrafe = perp > 0 \? 'right' : 'left'/.test(src), '漂向哪边就往反方向压一档')
  ok(/if \(lastStrafe\) \{ try \{ b\.setControlState\(lastStrafe, false\) \} catch \{\} ; lastStrafe = null \}/.test(src),
    '🔴 反压键每轮先松开（不收就是把方向键焊死）')
  ok(/\.\.\.\(driftFixes \? \{ drift, driftFixes \} : \{\}\)/.test(src) && /水流一直在横向推你/.test(src),
    '结果与提示里都如实报"水在推你，压了几次"')

  // 接线：mc_move 真的把 intent 传下去了
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  ok((idx.match(/intent: args\.intent/g) ?? []).length >= 2 && /intent: \{ type: 'string'/.test(idx),
    'mc_move 的 intent 参数接到了两条 walkTo 出口上')
}
/* ── ⑫ 门：规划允许穿门 + 执行层自己按开 + 卡住补救不砸门（2026-10-18 实机） ── */
{
  const src = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  const { DOOR_RE, openNearbyDoor, CARVE_PROTECTED, carveStepAhead } = mod
  ok(DOOR_RE.test('oak_door') && DOOR_RE.test('iron_trapdoor') && DOOR_RE.test('oak_fence_gate')
    && !DOOR_RE.test('oak_planks'), '门/活板门/栅栏门都认得，木板不算')
  /* 🔴 实机第四/五次反馈（"一直开门"）：① 上下半格被当成两扇门，一轮按两次 = 开了又关；
   * ② 真实数据里**上半块可能没有 `open` 属性**，读成 undefined ⇒ 误判"还关着" ⇒ 再按一次；
   * ③ 400ms 定时器重入时两次都过了检查 ⇒ 各按一次。这里逐个钉住。 */
  const mkDoorWorld = ({ open = false, upperHasOpen = true, confirm = true } = {}) => {
    const st = { open }
    const seen = []
    const b = {
      entity: { position: new Vec3(0, 64, 0) },
      blockAt (v) {
        const lower = v.x === 1 && v.z === 0 && v.y === 64
        const upper = v.x === 1 && v.z === 0 && v.y === 65
        if (lower) return { name: 'oak_door', position: v, getProperties: () => ({ open: st.open, half: 'lower' }) }
        if (upper) {
          return {
            name: 'oak_door',
            position: v,
            getProperties: () => (upperHasOpen ? { open: st.open, half: 'upper' } : { half: 'upper' }),
          }
        }
        return { name: 'air', position: v }
      },
      async activateBlock (blk) {
        seen.push(`${blk.position.y}`)
        if (confirm) st.open = !st.open
      },
    }
    return { b, st, seen }
  }
  {
    const { b, st, seen } = mkDoorWorld({ open: false })
    const n = await openNearbyDoor(b)
    ok(n === 1 && st.open === true && seen.length === 1 && seen[0] === '64',
      '关着的门 ⇒ 按下半格一次、回读确认后报"开了"', JSON.stringify({ n, open: st.open, seen }))
  }
  {
    /* 核心回归：门开着 + 上半块没有 open 属性 —— 绝不能因为上半块 undefined 再按一次 */
    const { b, st, seen } = mkDoorWorld({ open: true, upperHasOpen: false })
    const n = await openNearbyDoor(b)
    ok(n === 0 && seen.length === 0 && st.open === true,
      '🔴 门已开着、上半块没有 open 属性 ⇒ 一次都不按（按了就把门关回去）', JSON.stringify({ n, seen, open: st.open }))
  }
  {
    const { b, seen } = mkDoorWorld({ open: true })
    const n = await openNearbyDoor(b)
    ok(n === 0 && seen.length === 0, '门已经开着 ⇒ 不再乱按')
  }
  {
    /* 并发：400ms 定时器重入 —— 同一扇门最多只有一次实际点击 */
    const { b, seen, st } = mkDoorWorld({ open: false })
    const [a1, a2] = await Promise.all([openNearbyDoor(b), openNearbyDoor(b)])
    ok(seen.length === 1 && st.open === true, '🔴 两次扫描并发 ⇒ 同一扇门只点一次（在途锁）', JSON.stringify({ seen, a1, a2 }))
  }
  {
    /* 服务端没确认打开：不能报成功，也不能马上再点 */
    const { b, seen } = mkDoorWorld({ open: false, confirm: false })
    const n1 = await openNearbyDoor(b)
    ok(n1 === 0 && b.__doorLast?.closed?.length === 1, '服务端没确认 ⇒ 不报"开了"（记在 __doorLast.closed）', JSON.stringify(b.__doorLast))
    const n2 = await openNearbyDoor(b)
    ok(n2 === 0 && seen.length === 1, '没确认之后 1.5 秒内不再连点（seen 仍是 1）', JSON.stringify({ n2, seen }))
  }
  {
    /* 铁门：按不开，不空点 */
    const b = {
      entity: { position: new Vec3(0, 64, 0) },
      blockAt (v) {
        if (v.x === 1 && v.z === 0 && v.y === 64) return { name: 'iron_door', position: v, getProperties: () => ({ open: false, half: 'lower' }) }
        return { name: 'air', position: v }
      },
      async activateBlock () { throw new Error('铁门不该被按') },
    }
    const n = await openNearbyDoor(b)
    ok(n === 0 && b.__doorLast?.iron?.length === 1, '🔴 铁门按不开 ⇒ 不空点（记进 __doorLast.iron）', JSON.stringify(b.__doorLast))
  }
  {
    const { doorBaseKey, DOOR_PRESS_COOL_MS } = mod
    ok(doorBaseKey({ position: new Vec3(1, 65, 0), getProperties: () => ({ half: 'upper' }) }) === '1,64,0'
      && doorBaseKey({ position: new Vec3(1, 64, 0), getProperties: () => ({ half: 'lower' }) }) === '1,64,0',
      '🔴 上下半格折算成同一个"门轴"（否则会按两次 ⇒ 开了又关）')
    ok(DOOR_PRESS_COOL_MS >= 1000, '按门冷却不能太短（门状态要时间同步回来）')
  }
  ok(CARVE_PROTECTED.test('oak_door') && CARVE_PROTECTED.test('oak_fence_gate'),
    '🔴 卡住时的"挖开挡路的"绝不砸门（门进保护名单）')
  {
    // 门口挡着：carveStepAhead 一格都不挖
    const b = { ...mkCarveBot({ '1,64,0': 'oak_door', '1,63,0': 'stone' }) }
    b.blockAt = (v) => (v.x === 1 && v.y === 64 && v.z === 0
      ? { name: 'oak_door', position: v, getProperties: () => ({ open: false }) }
      : { name: v.x === 1 && v.y === 63 ? 'stone' : 'air', position: v })
    const n = await carveStepAhead(b, { x: 1, y: 64, z: 0 })
    ok(n === 0 && b.dug.length === 0, '门挡在前面:不挖,交给"按开"', JSON.stringify({ n, dug: b.dug }))
  }
  ok(/mv\.canOpenDoors = true/.test(readFileSync(new URL('../src/plugins.mjs', import.meta.url), 'utf8')),
    '🔴 A* 规划允许穿门（vendor 默认 false ⇒ 只会挖墙）')
  ok(/const doorTimer = setInterval\(\(\) => \{ openNearbyDoor\(b\)/.test(src)
    && /try \{ clearInterval\(doorTimer\) \} catch \{\}/.test(src),
    '移动期间定时探门（收尾一定清掉定时器）')
  ok(/是\*\*门\*\*：.*mode:"use"/.test(src) && /别挖墙也别挖门/.test(src),
    '失败提示:门用"按开",不是"挖掉"')
}
section('⑬ 长路线续行 + 地形局部重估（2026-10-18 审计 P1）')
{
  /* 续行只记账（不改路线）：同一目标连续走时，累计次数/位移/耗时都报出来；
   * 连走 3 趟、平均每趟不到半格 ⇒ hint 明说"别再原样重试"。 */
  const self = {}
  const tgt = { x: 10, y: 64, z: 10 }
  const a = routeTrack(self, tgt, { moved: 0.6, ms: 9000, arrived: false })
  ok(a.attempts === 1 && a.sameTarget === false && a.movedTotal === 0.6, '第一趟：attempts=1', JSON.stringify(a))
  const b2 = routeTrack(self, { x: 10.5, y: 64.2, z: 10.4 }, { moved: 0.2, ms: 9000, arrived: false })
  ok(b2.attempts === 2 && b2.sameTarget === true && b2.movedTotal === 0.8, '同一个目标（3 格内）第二趟累计', JSON.stringify(b2))
  const c = routeTrack(self, tgt, { moved: 0.1, ms: 8000, arrived: false })
  ok(c.attempts === 3 && c.stalled === true && c.movedTotal === 0.9,
    '第三趟仍几乎没挪 ⇒ stalled（累计才 0.9 格）', JSON.stringify(c))
  ok(/已经第 3 次走同一个目标/.test(c.hint ?? '') && /别再原样重试/.test(c.hint ?? ''),
    '🔴 hint 点名"第 N 次 + 别再原样重试"', String(c.hint).slice(0, 70))
  ok(/blockedAhead|shaft/.test(c.hint ?? '') && /intent/.test(c.hint ?? ''), 'hint 给出换做法的方向')
  const d = routeTrack(self, { x: 30, y: 64, z: 10 }, { moved: 3, ms: 9000, arrived: false })
  ok(d.attempts === 1 && d.sameTarget === false, '换了目标就重新计数', JSON.stringify(d))
  // 隔了太久（>90s）不算同一条路
  self._navRoute.at = Date.now() - 100_000
  const e = routeTrack(self, { x: 30, y: 64, z: 10 }, { moved: 0.2, ms: 9000, arrived: false })
  ok(e.attempts === 1, '超过 90 秒还没走到 ⇒ 当成新的一条路', JSON.stringify(e))
  // 真到了就不算"卡在同一个目标上"
  const self2 = {}
  routeTrack(self2, tgt, { moved: 0.1, ms: 9000, arrived: false })
  routeTrack(self2, tgt, { moved: 0.1, ms: 9000, arrived: false })
  const f = routeTrack(self2, tgt, { moved: 0.1, ms: 3000, arrived: true })
  ok(f.stalled !== true, '到点了就算这一趟成功了 —— 不劝"换做法"', JSON.stringify(f))
  // 走得好好的（每趟都在靠近）也不打扰
  const self3 = {}
  routeTrack(self3, tgt, { moved: 2, ms: 9000 })
  routeTrack(self3, tgt, { moved: 2, ms: 9000 })
  const g = routeTrack(self3, tgt, { moved: 2, ms: 9000 })
  ok(g.stalled !== true && g.movedTotal === 6, '每趟都挪 2 格 ⇒ 不算 stalled', JSON.stringify(g))
}
{
  const src = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  ok(/export function routeTrack/.test(src), '续行账本导出（只读，不改路线）')
  ok(/\{ \.\.\.info, route \}/.test(src), 'walkTo 把 route 挂到结果上')
  ok(/let terrain = classifyTerrainCached\(b\)/.test(src) && /terrainReeval \? \{ terrainReeval \}/.test(src),
    '地形重估计数（变了才报）')
  ok(/const fresh = classifyTerrainCached\(b\)[\s\S]{0,400}?terrain = fresh/.test(src),
    '🔴 脱困后真的重判地形并按新地形重设 Movements')
  ok(/if \(noTower\) mv2\.allow1by1towers = false/.test(src), '重设 Movements 时 noTower 依旧生效（别把逃跑那条腿放回来）')
}
section('⑭ 门：不挖、不重复按、按开的别被 vendor 关回去（2026-10-18 实机第二次反馈）')
{
  const { patchDoorMoves, guardDoorActivate } = await import(new URL('../src/plugins.mjs', import.meta.url))
  const blk = (name, open) => ({ name, getProperties: () => ({ open }) })
  /* 假 Movements：只有 getMoveForward，规划出一条"挖门 + 推门"的 move */
  const mkMv = (world) => ({
    getBlock (node, dx, dy, dz) { return world[`${node.x + dx},${node.y + dy},${node.z + dz}`] ?? blk('air', false) },
    getMoveForward (node, dir, neighbors) {
      neighbors.push({
        cost: 12,
        toBreak: [{ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }],
        toPlace: [{ x: 1, y: 64, z: 0, useOne: true }],
      })
    },
  })
  {
    // 门（关着）+ 旁边的石头：门不许进 toBreak，石头照常可以挖
    const mv = mkMv({ '1,64,0': blk('oak_door', false), '2,64,0': blk('stone', false) })
    patchDoorMoves(mv)
    const out = []
    mv.getMoveForward({ x: 0, y: 64, z: 0 }, { x: 1, z: 0 }, out)
    const m = out[0]
    ok(m.toBreak.length === 1 && m.toBreak[0].x === 2, '🔴 门不进"要挖的方块"（stone 照旧可挖）', JSON.stringify(m.toBreak))
    ok(!m.toPlace.some((p) => p.useOne), '🔴 门的 useOne 一律删掉（vendor 在"只有 useOne"时会 crash：placingBlock 变 undefined）', JSON.stringify(m.toPlace))
  }
  {
    // 门已经开着：同样不该再 activateBlock（那等于把它关回去）
    const mv = mkMv({ '1,64,0': blk('oak_door', true), '2,64,0': blk('stone', false) })
    patchDoorMoves(mv)
    const out = []
    mv.getMoveForward({ x: 0, y: 64, z: 0 }, { x: 1, z: 0 }, out)
    ok(out[0].toPlace.length === 0, '🔴 门已经开着 ⇒ 没有"再按一下"那步', JSON.stringify(out[0].toPlace))
  }
  {
    // 铁门按不开：保留原行为（别把唯一的路堵死）
    const mv = mkMv({ '1,64,0': blk('iron_door', false), '2,64,0': blk('stone', false) })
    patchDoorMoves(mv)
    const out = []
    mv.getMoveForward({ x: 0, y: 64, z: 0 }, { x: 1, z: 0 }, out)
    ok(out[0].toBreak.length === 2, '铁门不在这条规则里（按不开，仍允许挖）', JSON.stringify(out[0].toBreak))
  }
  {
    // guardDoorActivate：我们按开的门，vendor 的 useOne 再按时直接忽略
    let calls = 0
    const b = { activateBlock: async () => { calls++ } }
    guardDoorActivate(b)
    const openBlk = { position: { x: 1, y: 64, z: 0 }, getProperties: () => ({ open: true }) }
    const closedBlk = { position: { x: 2, y: 64, z: 0 }, getProperties: () => ({ open: false }) }
    b.__autoOpenedDoors.set('1,64,0', Date.now())
    await b.activateBlock(openBlk)
    ok(calls === 0, '🔴 刚被我们按开的门，vendor 再按 ⇒ 忽略（不关回去）', String(calls))
    await b.activateBlock(closedBlk)
    ok(calls === 1, '别的（关着的）门照常按', String(calls))
    b.__autoOpenedDoors.set('2,64,0', Date.now())
    await b.activateBlock(closedBlk)
    ok(calls === 2, '门已经是关的 ⇒ 照常按（可能被谁关上了）', String(calls))
    b.__autoOpenedDoors.set('1,64,0', Date.now() - 13_000)
    await b.activateBlock(openBlk)
    ok(calls === 3, '超过 12 秒就不再拦截（按正常交互处理）', String(calls))
  }
  {
    // 🔴 挖门的工钱也要退：只删 toBreak 不扣 cost，A* 仍觉得"挖门"和"走门"一样贵
    const doorBlk = { name: 'oak_door', getProperties: () => ({ open: false }), digTime: () => 500 }
    const mv = mkMv({ '1,64,0': doorBlk, '2,64,0': blk('stone', false) })
    mv.digCost = 4
    patchDoorMoves(mv)
    const out = []
    mv.getMoveForward({ x: 0, y: 64, z: 0 }, { x: 1, z: 0 }, out)
    const m = out[0]
    // labor = (1 + 3*0.5) * 4 = 10 ⇒ 12 - 10 = 2
    ok(m.cost === 2, '🔴 门不进 toBreak 时把挖门的 cost 也退掉（12 → 2）', String(m.cost))
    ok(m.toBreak.length === 1 && m.toBreak[0].x === 2, '…石头照旧可挖', JSON.stringify(m.toBreak))
  }
  {
    // 🔴 goto 的拒绝必须有人接：PathStopped 是 unhandledRejection ⇒ 宿主 fail-loud 直接 exit(1)
    const { guardPathfinderRejections } = await import(new URL('../src/plugins.mjs', import.meta.url))
    const unhandled = []
    const onUnhandled = (e) => unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    const fake = { pathfinder: { goto: () => Promise.reject(new Error('PathStopped: Path was stopped')) } }
    ok(guardPathfinderRejections(fake) === true, '给 goto 挂上了"拒绝必有人接"')
    ok(guardPathfinderRejections(fake) === false, '重复调用不会套两层')
    fake.pathfinder.goto()   // 故意不 catch —— 模拟"超时先返回，goto 后 reject"
    await new Promise((r) => setTimeout(r, 30))
    process.removeListener('unhandledRejection', onUnhandled)
    ok(unhandled.length === 0, '🔴 没人 catch 的 PathStopped 也不会变成 unhandledRejection（以前这一下 = 应用闪退）', String(unhandled.length))
  }
  {
    // 🔴 反向验证：这版**故意不进 openable** —— 进去就会生成 useOne-only 的 move，
    // vendor 的 monitorMovement 在那一刻会 shift() 出 undefined 并崩（踩坑 #172）。
    const plug2 = readFileSync(new URL('../src/plugins.mjs', import.meta.url), 'utf8')
    ok(!/mv\.openable\.add/.test(plug2), '🔴 门不再进 openable（否则又会出现 useOne-only 的 move）')
    ok(/openNearbyDoor/.test(readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')), '开门改由 openNearbyDoor 定时器负责')
  }
  {
    // 🔴 寻路器要挖门 ⇒ 改成"按开"（AI 自己挖门不受影响）
    const { guardDoorDig } = await import(new URL('../src/plugins.mjs', import.meta.url))
    let activated = 0
    let dug = 0
    const world = new Map()   // `x,y,z` → { name, open }
    const mkBlk = (x, y, z) => {
      const st = world.get(`${x},${y},${z}`) ?? { name: 'air', open: false }
      return {
        name: st.name,
        position: { x, y, z },
        getProperties: () => (st.name.includes('door') ? { open: st.open, half: 'lower' } : {}),
      }
    }
    world.set('1,64,0', { name: 'oak_door', open: false })
    world.set('2,64,0', { name: 'oak_door', open: true })
    world.set('3,64,0', { name: 'iron_door', open: false })
    world.set('5,64,0', { name: 'oak_door', open: false })
    const b = {
      __inPathTick: false,
      blockAt: (v) => mkBlk(v.x, v.y, v.z),
      activateBlock: async (blk) => {
        activated++
        const st = world.get(`${blk.position.x},${blk.position.y},${blk.position.z}`)
        if (st) st.open = !st.open
      },
      dig: async () => { dug++ },
    }
    ok(guardDoorDig(b) === true, '装上了"寻路要挖门 ⇒ 先按开"')
    ok(guardDoorDig(b) === false, '重复安装不会套两层')
    const closed = mkBlk(1, 64, 0)
    const openDoor = mkBlk(2, 64, 0)
    const iron = mkBlk(3, 64, 0)
    b.__inPathTick = true
    await b.dig(closed)
    ok(activated === 1 && dug === 0 && world.get('1,64,0').open === true,
      '🔴 寻路中遇到关着的木门 ⇒ 按开并回读确认，不挖', `activated=${activated} dug=${dug} open=${world.get('1,64,0').open}`)
    /* 同一个位置再来一次：1.5 秒冷却内不许再按（否则就是"开了又关"） */
    await b.dig(mkBlk(1, 64, 0))
    ok(activated === 1 && dug === 0, '🔴 同一扇门按过之后立刻又要求挖 ⇒ 冷却内不再按（不关回去、也不挖）', `activated=${activated} dug=${dug}`)
    /* 上半格：按到的是下半格那一格 */
    const baseAt = { name: 'oak_door', position: { x: 5, y: 64, z: 0 }, getProperties: () => ({ open: false, half: 'lower' }) }
    b.blockAt = (v) => ((v?.x === 5 && v?.y === 64) ? baseAt : mkBlk(v.x, v.y, v.z))
    const upper = { name: 'oak_door', position: { x: 5, y: 65, z: 0 }, getProperties: () => ({ open: false, half: 'upper' }) }
    const pressed = []
    const origActivate = b.activateBlock
    b.activateBlock = async (blk) => { pressed.push(`${blk.position.y}`); activated++ }
    await b.dig(upper)
    ok(activated === 2 && pressed[0] === '64', '🔴 上半格被要求挖时按的是下半格（同一个门轴只按一次）', JSON.stringify({ activated, pressed }))
    b.activateBlock = origActivate
    const actBefore = activated
    const dugBefore = dug
    await b.dig(openDoor)
    ok(dug === dugBefore && activated === actBefore, '门本来就开着 ⇒ 不按也不挖（这一步当成已经过了）', `activated=${activated} dug=${dug}`)
    const dugBefore2 = dug
    await b.dig(iron)
    ok(dug === dugBefore2 + 1 && activated === actBefore, '铁门按不开 ⇒ 照旧真的挖（能脱困）', `activated=${activated} dug=${dug}`)
    b.__inPathTick = false
    const dugBefore3 = dug
    await b.dig(closed)
    ok(dug === dugBefore3 + 1 && activated === actBefore, '🔴 AI 自己点名挖门（不在寻路 tick 里）⇒ 真的挖，不拦', `activated=${activated} dug=${dug}`)
    /* 🔴 开门失败也绝不回落到挖门（用户 2026-10-18：别用毁门来掩盖失败） */
    {
      world.set('7,64,0', { name: 'oak_door', open: false })
      const origAct = b.activateBlock
      let thrown = 0
      b.activateBlock = async () => { thrown++; throw new Error('server busy') }
      const d0 = dug
      b.__inPathTick = true
      await b.dig(mkBlk(7, 64, 0))
      ok(thrown === 1 && dug === d0 && world.get('7,64,0').open === false,
        '🔴 activateBlock 抛错 ⇒ 记失败、不挖门（门还在）', `thrown=${thrown} dug=${dug} open=${world.get('7,64,0').open}`)
      b.activateBlock = origAct
      b.__inPathTick = false
    }
    /* 🔴 上半格 + 下半格都被寻路器要求处理 ⇒ 最多按一次，两半都不许被挖 */
    {
      world.set('9,64,0', { name: 'oak_door', open: false })
      world.set('9,65,0', { name: 'oak_door', open: false })
      const pressed2 = []
      const origAct = b.activateBlock
      b.activateBlock = async (blk) => { pressed2.push(`${blk.position.y}`); activated++; world.get(`${blk.position.x},${blk.position.y},${blk.position.z}`).open = true }
      b.blockAt = (v) => mkBlk(v.x, v.y, v.z)
      const lowerHalf = mkBlk(9, 64, 0)
      const upperHalf = { name: 'oak_door', position: { x: 9, y: 65, z: 0 }, getProperties: () => ({ open: false, half: 'upper' }) }
      const d1 = dug
      b.__inPathTick = true
      await b.dig(upperHalf)
      await b.dig(lowerHalf)
      ok(pressed2.length <= 1 && dug === d1 && pressed2[0] === '64',
        '🔴 上下半格都被要求处理 ⇒ 最多按一次（下半格），一格都不挖', JSON.stringify({ pressed2, dug }))
      b.activateBlock = origAct
      b.__inPathTick = false
    }
  }
  {
    /* 🔴 异步窗口：vendor 是 `bot.equip().then(() => bot.dig())`，那会儿 __inPathTick 已经复位。
     * 只靠同步标记会把"挖门"放行 ⇒ 必须同时看 pathfinder.isMining()。 */
    const { guardDoorDig } = await import(new URL('../src/plugins.mjs', import.meta.url))
    let dug = 0
    let pressed = 0
    const door = { name: 'oak_door', position: { x: 1, y: 64, z: 0 }, getProperties: () => ({ open: false, half: 'lower' }) }
    const b = {
      __inPathTick: false,
      pathfinder: { isMining: () => true },
      blockAt: () => door,
      activateBlock: async () => { pressed++ },
      dig: async () => { dug++ },
    }
    guardDoorDig(b)
    await b.dig(door)
    ok(dug === 0 && pressed === 1, '🔴 装备工具的异步窗口（tick 标记已复位、isMining 仍真）⇒ 仍然按开门、不挖', JSON.stringify({ dug, pressed }))
    b.pathfinder.isMining = () => false
    await b.dig(door)
    ok(dug === 1, 'AI 自己挖（既不在 tick 里、也不在挖矿中）⇒ 照旧真的挖', JSON.stringify({ dug }))
  }
  {
    /* 🔴 统一在 getNeighbors 上过滤：与"是哪个 getMove* 生成的"无关 */
    const { patchDoorMoves } = await import(new URL('../src/plugins.mjs', import.meta.url))
    const doorBlk = { name: 'oak_door', getProperties: () => ({ open: false }), digTime: () => 500 }
    const mv = {
      digCost: 4,
      getBlock (node, dx, dy, dz) {
        const key = `${node.x + dx},${node.y + dy},${node.z + dz}`
        return key === '1,64,0' ? doorBlk : { name: 'stone', getProperties: () => ({ open: false }) }
      },
      getNeighbors (node) {
        const mk = (kind) => ({ kind, cost: 12, toBreak: [{ x: 1, y: 64, z: 0 }], toPlace: [] })
        return [mk('walk'), mk('drop'), mk('down'), mk('up'), mk('parkour')]
      },
    }
    patchDoorMoves(mv)
    const moves = mv.getNeighbors({ x: 0, y: 64, z: 0 })
    ok(moves.every((m) => m.toBreak.length === 0 && m.cost === 2),
      '🔴 所有移动类型（walk/drop/down/up/parkour）都不再带"挖门"，且挖门工钱都退掉', JSON.stringify(moves))
  }
  const plug = readFileSync(new URL('../src/plugins.mjs', import.meta.url), 'utf8')
  ok(/mv\.getNeighbors = function \(node\)/.test(plug) && /__dshDoorPatched/.test(plug),
    '🔴 门补丁挂在 getNeighbors 上（不再维护 getMove* 清单）')
  ok(/pathfinder\?\.isMining\?\.\(\)/.test(plug), '🔴 来源判断包含 pathfinder.isMining()（覆盖装备工具的异步窗口）')
  ok(/guardDoorDig\(b/.test(plug), 'setupPlugins 里装了 door dig 守卫')
  ok(/const prev = b\.__inPathTick/.test(plug), '寻路 tick 里打了 `__inPathTick` 标记（只有这段里的挖才换成开门）')
  ok(/export function patchDoorMoves/.test(plug) && /patchDoorMoves\(mv\)/.test(plug), 'movements() 里真的挂了这个补丁')
  ok(/guardDoorActivate\(b\)/.test(plug), 'setupPlugins 里装了"我们按开的门别被再按"')
  ok(/guardPathfinderRejections\(b/.test(plug), '🔴 setupPathfinder 里给 goto 的拒绝挂了 catch（否则 PathStopped 会炸宿主）')
  ok(/__autoOpenedDoors instanceof Map/.test(readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')),
    '定时器按开门时记账（供上面的守卫用）')
}
section('⑮ 寻路 tick 不许把宿主带崩（2026-10-18 真机闪退：Cannot read properties of undefined (reading y)）')
{
  const { guardPathfinderTicks } = await import(new URL('../src/plugins.mjs', import.meta.url))
  const b = new EventEmitter()
  b.entity = { position: { x: 0, y: 64, z: 0 } }
  let ticks = 0
  let stops = 0
  b.pathfinder = { stop () { stops++ } }
  b.on('physicTick', () => { ticks++; throw new TypeError("Cannot read properties of undefined (reading 'y')") })
  const n = guardPathfinderTicks(b, { log: () => {} })
  ok(n === 1, '把 vendor 挂在旧事件 physicTick 上的监听接管了', String(n))
  ok(b.listeners('physicTick').length === 0, '旧事件上不再留裸监听（弃用警告也一起没了）')
  ok(b.listeners('physicsTick').length === 1, '改挂到新事件 physicsTick')
  let threw = false
  try { b.emit('physicsTick') } catch { threw = true }
  ok(!threw, '🔴 监听里抛错不再冒到进程级（以前这一下 = 整个 DSH 闪退）')
  ok(ticks === 1, '这一拍确实执行到了（不是被吞掉不跑）')
  ok(stops === 1, '抛错后先停住寻路，别带着坏状态继续走')
  b.entity = null
  b.emit('physicsTick')
  ok(ticks === 1, '断线/重生一瞬（entity 还没回来）跳过这一拍，不进 monitorMovement', String(ticks))
  b.entity = { position: { x: 0, y: 64, z: 0 } }
  b.emit('physicsTick')
  ok(ticks === 2, 'entity 回来后继续跑')
  const plug = readFileSync(new URL('../src/plugins.mjs', import.meta.url), 'utf8')
  ok(/guardPathfinderTicks\(b/.test(plug), 'setupPathfinder 里真的调了这个接管')
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  ok(/process\.on\('uncaughtException'/.test(idx), '宿主级还有一层"未捕获异常"记录（只记栈，不拦宿主处置）')
}
console.log(`check-move-progress：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
