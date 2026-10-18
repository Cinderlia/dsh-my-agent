#!/usr/bin/env node
/**
 * 任务代次（epoch）的离线自检（2026-10-15 用户点名的异步方案 ⑤「丢弃旧任务的迟到结果」）。
 *
 * 为什么单独一套：`TaskExecutor.run` 会 `await this.call(tool, args, …)` —— 那可能好几秒。
 * 在这几秒里模型完全可能 `mc_task {action:"plan"}` 重排步骤表、或者 `cancel` 掉任务。
 * 等那个 await 回来，手里那份结果就是**上一代**的了：步骤 id 可能还在，但含义已经变了，
 * 照写就会"把新计划里的某一步标成完成，而它其实没做"。
 *
 * 所以钉住两件事：
 *   ① 台账层：**只有**"重排步骤表 / 取消 / 收工"才换代，普通的记进度、记失败、换状态**不算**；
 *   ② 执行器：两个 `await`（看现场 / 干活）回来之后各对一次代次，对不上就**整份丢掉**。
 *
 * 不需要 MC、不需要 DSH；时间靠注入的假时钟，**不真等**。
 */

import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)
const stripComments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const R = await import(new URL('../src/task-runner.mjs', import.meta.url))
const { TaskRunner, migrateTask, outcomeOf, verdictText, TASK_EPOCH_START, OUTCOME_LABEL, suggestAction } = R
const { TaskExecutor } = await import(new URL('../src/task-exec.mjs', import.meta.url))

const runnerSrc = read('../src/task-runner.mjs')
const execSrc = read('../src/task-exec.mjs')

/* ── 假时钟：`now` 手动推 ── */
const mkClock = (t0 = 10_000) => {
  const c = { t: t0 }
  c.now = () => c.t
  c.advance = (ms) => { c.t += ms; return c.t }
  return c
}

/** 台账：`file: null` ⇒ 不落盘（`save()` 直接回 false） */
const mkLedger = (clock = mkClock()) => new TaskRunner({ file: null, now: clock.now, log: () => {} })

const STEPS2 = [{ id: 's1', op: 'observe' }, { id: 's2', op: 'observe' }]

const mkState = (extra = {}) => ({ online: true, position: { x: 0, y: 64, z: 0 }, counts: {}, held: null, ...extra })

const mkExec = (ledger, { call, observe = null, clock = null } = {}) => new TaskExecutor({
  ledger,
  observe: observe ?? (async () => mkState()),
  call,
  log: () => {},
  now: clock ? clock.now : () => 10_000,
})

const stepOf = (ledger, id, stepId) => (ledger.get(id)?.steps ?? []).find((s) => s.id === stepId) ?? null

/* ═══════════════ ① 台账层：谁换代、谁不换 ═══════════════ */
section('① 台账层：epoch 从 1 开始；只有"换了一代要干什么"才 +1')

{
  const L = mkLedger()
  const t = L.start({ kind: 'custom', steps: STEPS2 })
  ok(t.epoch === TASK_EPOCH_START, '开工就是第 1 代', `epoch=${t.epoch}`)
  ok(TASK_EPOCH_START === 1, '起点常量就是 1')
  ok(t.epochWhy === null, '刚开工没有"为什么换代"')
  ok(L.epochOf(t.taskId) === 1, 'epochOf 读得到')

  /* 这些是"这一代之内的正常记账"，**一律不许换代** ——
   * 换了的话执行器每轮都会被自己刚写的账判成"过期"，等于自锁。
   * ⚠️ `pause` / `wait` **不在**这一组里：它们不是"记账"，是**状态转变**
   *    （从"在做"变成"暂停/等条件"）—— 见下面的 ①d。 */
  const before = t.epoch
  L.progress(t.taskId, { add: 1, total: 8 })
  L.fail(t.taskId, { action: 'mc_dig', reason: '够不着' })
  L.note(t.taskId, '随便记一笔')
  L.checkpoint(t.taskId, { x: 1, y: 2, z: 3 })
  L.stepBegin(t.taskId, 's1')
  L.stepDone(t.taskId, 's1')
  L.stepReset(t.taskId, 's2', '结果未知')
  L.stepSkip(t.taskId, 's2', '不用做')
  L.stepFail(t.taskId, 's2', '没成')
  L.touch(t.taskId, { meta: { a: 1 } })
  ok(t.epoch === before, '记进度 / 记失败 / 备忘 / 检查点 / 步骤记账 都**不**换代', `epoch=${t.epoch}`)

  L.setSteps(t.taskId, STEPS2)
  ok(t.epoch === before + 1, '重排步骤表 ⇒ 换代', `epoch=${t.epoch}`)
  ok(/重排/.test(String(t.epochWhy)), '换代原因记下来了', `why=${t.epochWhy}`)
  ok(t.epochAt === 10_000, '换代时间也记下来了', `at=${t.epochAt}`)

  L.cancel(t.taskId, '用户改主意了')
  ok(t.epoch === before + 2, '取消 ⇒ 换代', `epoch=${t.epoch}`)
  ok(/取消/.test(String(t.epochWhy)), '取消的原因记下来了', `why=${t.epochWhy}`)

  const t2 = L.start({ kind: 'custom', steps: STEPS2 })
  L.finish(t2.taskId, { ok: true })
  ok(t2.epoch === 2, '收工 ⇒ 换代', `epoch=${t2.epoch}`)
  ok(/收工/.test(String(t2.epochWhy)), '收工的原因记下来了', `why=${t2.epochWhy}`)
}

/* ═══════════════ ①d 状态转变也要换代（2026-10-16 审计 P0-1，场景三） ═══════════════ */
section('①d 暂停 / 等条件 ⇒ 换代（断线时在飞那一步的结果不许写回台账）')
{
  /* 🔴 审计原话：**"`pause` 不 `#bump`（断线是'换了一代'的语义，代码没这么算）"**。
   *   断线走 `src/connection.mjs` 的 `tasks.pause(...)`；这时正在飞的那一步
   *   （`task-exec` 的 `await this.call(...)`）回来只查代次 —— 代次没变 ⇒ 判不出过期
   *   ⇒ **把"断线时那一步"记成已完成 / 已失败**，等下一轮开头才发现任务已经 paused。
   *   `wait` 同理（`task-exec` 自己在掉线 / 等条件时调它）。 */
  const L = mkLedger()
  const t = L.start({ kind: 'custom', steps: STEPS2 })
  const e0 = t.epoch
  L.pause(t.taskId, '断线了（等重连）')
  ok(t.epoch === e0 + 1, '暂停 ⇒ 换代', `epoch=${t.epoch}`)
  ok(/断线/.test(String(t.epochWhy)), '暂停的原因记进换代原因', `why=${t.epochWhy}`)
  ok(t.status === 'paused', '状态也真的变成 paused')
  const e1 = t.epoch
  L.wait(t.taskId, '等条件')
  ok(t.epoch === e1 + 1, '等条件 ⇒ 换代', `epoch=${t.epoch}`)
  ok(L.staleOf(t.taskId, e1).stale === true, '换代之后，手里那份旧代次判成过期')

  /* 🔴 2026-10-16 实机验收（P0-1「真实调用链」）逮到的死胡同：
   *   `resume` 原来**只给提示、不改状态** —— 任务一旦进了 `waiting`
   *   （实测：`mc_dig {name:'dirt',count:4}` 报 `no-target`「附近找不到 dirt」），
   *   `run` 在循环开头看见 `waiting` 就「这一轮先停手」，而 `resume` 又回
   *   「接着做（用同样的参数再叫一次就好）」⇒ 两边互相推诿，**只剩 `cancel` 一条路**。
   *   「恢复」的意思就是"接着做"，所以它**必须真把任务拉回 running**，
   *   并且**换代**（恢复之前飞在半路的那一步不该再写回这一代的台账）。 */
  const e2 = t.epoch
  const r1 = L.resume(t.taskId, { countOf: null })
  ok(r1.revived === true, '🔴 resume 真的把任务从 waiting 拉回来了', `revived=${r1.revived}`)
  ok(t.status === 'running', '🔴 状态真的变回 running（不然 run 会一直"先停手"）', `status=${t.status}`)
  ok(r1.wasStatus === 'waiting', '把"原来是什么状态"回给调用方', `wasStatus=${r1.wasStatus}`)
  ok(t.epoch === e2 + 1, '🔴 resume 也换代（恢复前飞在半路的那一步不许写回台账）', `epoch=${t.epoch}`)
  ok(L.staleOf(t.taskId, e2).stale === true, '换代之后，手里那份旧代次判成过期')
  ok(t.pauseReason === null && t.note === null, '拉回来时清掉"等条件"的原因（它已经不成立了）')
  /* 反面：本来就在跑的任务，`resume` 不换代、不改状态 —— 否则模型每次问一句
   * 「我该干什么」都会把在飞的那一步作废。 */
  const e3 = t.epoch
  const r2 = L.resume(t.taskId, { countOf: null })
  ok(r2.revived === false, '反面：本来就是 running ⇒ 不算"拉回来"')
  ok(t.epoch === e3, '反面：本来就在跑 ⇒ 不换代（问一句不该把在飞的活作废）')
}

section('①b staleOf：对不上就说过期（含"任务没了"）')
{
  const L = mkLedger()
  const t = L.start({ kind: 'custom', steps: STEPS2 })
  ok(L.staleOf(t.taskId, 1).stale === false, '代次对得上 ⇒ 不过期')
  ok(L.staleOf(t.taskId, 1).epoch === 1, '回的是**现在**的代次')
  L.setSteps(t.taskId, STEPS2)
  const s = L.staleOf(t.taskId, 1)
  ok(s.stale === true, '代次对不上 ⇒ 过期')
  ok(s.epoch === 2 && /重排/.test(String(s.why)), '过期时把"现在是第几代 + 为什么"一起回', `epoch=${s.epoch} why=${s.why}`)
  ok(L.staleOf('没有这个任务', 1).stale === true, '任务都不在了 ⇒ 也算过期')
  ok(L.staleOf(t.taskId, null).stale === true, '手里没有代次（null）⇒ 宁可算过期')
  ok(L.epochOf('没有这个任务') === null, 'epochOf 对不存在的任务回 null')
  ok(L.staleOf(t.taskId, 2).stale === false, '换代之后用新代次对 ⇒ 不过期')
}

section('①c migrateTask：磁盘上的老任务补 epoch')
{
  const old = migrateTask({ taskId: 't-old', status: 'running', steps: [], attempts: {} })
  ok(old.epoch === 1, '老任务读进来补成第 1 代', `epoch=${old.epoch}`)
  const bad = migrateTask({ taskId: 't-bad', epoch: 0 })
  ok(bad.epoch === 1, 'epoch=0 这种坏值也补成 1')
  const bad2 = migrateTask({ taskId: 't-bad2', epoch: 'abc' })
  ok(bad2.epoch === 1, 'epoch 不是数字也补成 1')
  const keep = migrateTask({ taskId: 't-keep', epoch: 7 })
  ok(keep.epoch === 7, '已经有的好值不许覆盖')
  ok(migrateTask(null) === null, 'null 原样回（不炸）')
}

/* ═══════════════ ② 执行器：干活的时候被重排 ⇒ 结果作废 ═══════════════ */
section('② 干到一半被重排步骤表 ⇒ 结果**丢掉**，新表一步都不许标完成')
{
  const L = mkLedger()
  const t = L.start({ kind: 'custom', steps: STEPS2 })
  let inFlight = false
  let sawPlan = false
  const E = mkExec(L, {
    call: async () => {
      inFlight = true
      /* 模拟"这一步在飞的时候，模型重排了步骤表"（新表里 s1 还在，但含义已经变了） */
      L.setSteps(t.taskId, [{ id: 's1', op: 'mc_dig', args: { name: 'stone', count: 64 } }, { id: 's9', op: 'observe' }])
      sawPlan = true
      return { ok: true, note: '我这一镐挖完了' }      // 一个**看起来成功**的结果
    },
  })
  const r = await E.run({ taskId: t.taskId, maxRounds: 3 })

  ok(inFlight && sawPlan, '前提：call 真的在飞的时候重排了步骤表')
  ok(r.stale === true, '执行器如实说"这一份过期了"', `stale=${r.stale}`)
  ok(/上一代/.test(r.lines.join('\n')), '过程里说清了是"上一代的结果"')
  ok(/没往台账上写|丢掉/.test(r.lines.join('\n')), '过程里说清了"没记账"')
  ok(/被改过|重排/.test(String(r.reason)), 'reason 里点明"任务被改过"', `reason=${r.reason}`)
  ok(/mc_task/.test(String(r.hint)) && /步骤表/.test(String(r.hint)), 'hint 让模型去看**现在**的步骤表', `hint=${r.hint}`)

  const after = L.get(t.taskId)
  ok(stepOf(L, t.taskId, 's1').status === 'pending', '🔴 新表里 s1 **还是 pending**（没被上一代的"成功"标成完成）', `status=${stepOf(L, t.taskId, 's1').status}`)
  ok(stepOf(L, t.taskId, 's9').status === 'pending', '新加进来的 s9 也没被碰')
  ok(Object.keys(after.attempts ?? {}).length === 0, '🔴 一次失败都没往台账上记（`fail()` 没被调）', `attempts=${JSON.stringify(after.attempts)}`)
  ok(after.history.length === 2, '历史里只有"开工"和"重排步骤表"两条', `history=${after.history.map((h) => h.text).join(' | ')}`)
  ok(!after.history.some((h) => /完成/.test(h.text)), '🔴 历史里**没有**假的"步骤 s1 完成"')

  ok(outcomeOf(r) === 'stale', 'outcomeOf 判成 stale（不是 unknown）', `outcome=${outcomeOf(r)}`)
  const vt = verdictText('stale')
  ok(/♻️/.test(vt) && /没往台账上写/.test(vt), 'verdictText 说"没往台账上写"')
  ok(!/服务器可能已经做了/.test(vt), '🔴 stale **不许**套用"服务器可能已经做了"那句话（那会叫模型去复核一个不存在的步骤）')
  ok(/mc_task/.test(vt), 'stale 的文案指向"看现在的步骤表"')
  ok(OUTCOME_LABEL.stale === '这一步作废了', '结局标签是"作废"')
}

section('②b 被取消 ⇒ 同样作废（而且任务状态不许被改成"完成"）')
{
  const L = mkLedger()
  const t = L.start({ kind: 'custom', steps: [{ id: 's1', op: 'observe' }] })
  const E = mkExec(L, {
    call: async () => { L.cancel(t.taskId, '用户改主意了'); return { ok: true } },
  })
  const r = await E.run({ taskId: t.taskId, maxRounds: 2 })
  ok(r.stale === true, '取消也算"这一份过期了"')
  ok(L.get(t.taskId).status === 'cancelled', '🔴 任务状态还是 cancelled（没被结果改成 done）', `status=${L.get(t.taskId).status}`)
  ok(stepOf(L, t.taskId, 's1').status !== 'done', '🔴 步骤**没被标成完成**（这一步没记账）', `status=${stepOf(L, t.taskId, 's1').status}`)
  ok(/取消/.test(String(r.reason)) || /取消/.test(String(r.hint)), '话里点到了"取消"')
}

/* ═══════════════ ②c 干到一半断线 / 被暂停 ⇒ 同样不记账（2026-10-16 审计 P0-1，场景三） ═══════════════ */
section('②c 断线把任务暂停 ⇒ 在飞那一步的结果**不许**记成已完成 / 已失败')
{
  /* 🔴 审计原话：**"`src/task-exec.mjs:340` 之后缺一次 `cur.status` 复查"**。
   *   断线走 `src/connection.mjs` 的 `tasks.pause(...)` —— 这一步的 `await this.call(...)`
   *   回来时代次虽然变了（`pause` 现在换代），但**状态**才是那条路上的第一手事实。
   *   两道检查都要在：代次答"这一代要干什么变了没有"，状态答"任务还在做吗"。 */
  const L = mkLedger()
  const t = L.start({ kind: 'custom', steps: [{ id: 's1', op: 'mc_dig', args: { name: 'stone' } }] })
  const E = mkExec(L, {
    call: async () => {
      L.pause(t.taskId, '断线了（等重连）')      // 就在这一步在飞的时候断线
      return { ok: true, note: '服务端已确认挖到了' }   // 一个**看起来成功**的结果
    },
  })
  const r = await E.run({ taskId: t.taskId, maxRounds: 2 })
  ok(r.stale === true, '如实说"这一份作废了"', `stale=${r.stale}`)
  const after = L.get(t.taskId)
  ok(after.status === 'paused', '🔴 任务状态还是 paused（没被这一步的结果改成 done / failed）', `status=${after.status}`)
  ok(stepOf(L, t.taskId, 's1').status !== 'done', '🔴 步骤没被标成完成', `status=${stepOf(L, t.taskId, 's1').status}`)
  ok(Object.keys(after.attempts ?? {}).length === 0, '🔴 也没被记成失败', `attempts=${JSON.stringify(after.attempts)}`)
  ok(/不在做了|暂停|paused|改过/.test(String(r.reason)) || /暂停|♻️/.test(r.lines.join('\n')),
    '话里点明"任务已经不在做了 / 这一代作废了"', `reason=${r.reason}`)
  /* 两道检查谁先拦住都行（`pause` 现在**也**换代 ⇒ 代次那道通常先命中），
   * 但 hint 必须把模型引回 `mc_task`，别让它照着旧计划再干一遍。 */
  ok(/mc_task/.test(String(r.hint)), 'hint 把模型引回 mc_task', `hint=${r.hint}`)
}

section('②d 断线那一步在飞、`pause` 之后又来一个"看起来成功"的结果 ⇒ 依然作废')
{
  /* 反面用例：确认上面那条不是"因为代次变了才拦住的" —— 这里**只**改状态、
   * 让代次保持不动（直接改 `status` 字段），考的是新加的那道**状态复查**本身。 */
  const L = mkLedger()
  const t = L.start({ kind: 'custom', steps: [{ id: 's1', op: 'observe' }] })
  const E = mkExec(L, {
    call: async () => {
      L.get(t.taskId).status = 'paused'    // 只动状态，不动 epoch
      return { ok: true, note: '服务端已确认' }
    },
  })
  const r = await E.run({ taskId: t.taskId, maxRounds: 2 })
  ok(r.stale === true, '🔴 代次没变、只有状态变了 ⇒ **也要**判作废（这道检查是新加的）', `stale=${r.stale}`)
  ok(stepOf(L, t.taskId, 's1').status !== 'done', '步骤照样没记账', `status=${stepOf(L, t.taskId, 's1').status}`)
}
section('③ 看现场（observe）的时候被重排 ⇒ 停手，不再按旧计划动手')
{
  const L = mkLedger()
  const t = L.start({ kind: 'custom', steps: STEPS2 })
  let calls = 0
  const E = mkExec(L, {
    observe: async () => {
      L.setSteps(t.taskId, [{ id: 'z1', op: 'observe' }])   // 就在"看现场"这一下里被改
      return mkState()
    },
    call: async () => { calls++; return { ok: true } },
  })
  const r = await E.run({ taskId: t.taskId, maxRounds: 3 })
  ok(r.stopped === 'epoch', '收场原因就是 epoch（不是 rounds）', `stopped=${r.stopped}`)
  ok(calls === 0, '🔴 一步都没动手（旧计划下不许再动手）', `call 次数=${calls}`)
  ok(/被改过/.test(r.lines.join('\n')), '过程里说清了"被改过"')
  ok(/步骤表/.test(String(r.hint)), 'hint 让模型去看现在的步骤表')
  ok(r.ok === true && r.done === false, '这不是失败（`ok:true` / `done:false`）')
}

/* ═══════════════ ④ 不误伤：正常一轮照旧 ═══════════════ */
section('④ 不误伤：正常跑（没人改计划）一切照旧')
{
  const L = mkLedger()
  const t = L.start({ kind: 'custom', steps: [{ id: 's1', op: 'observe' }] })
  const E = mkExec(L, { call: async () => ({ ok: true, note: '服务端已确认' }) })
  /* `maxRounds: 1` ⇒ 跑完一步就停在"步数用完"，不会走到"步骤都走完 ⇒ 收工"那条路
   *（那条路**会**换代 —— 收工本来就算换代，见 ①）。 */
  const r = await E.run({ taskId: t.taskId, maxRounds: 1 })
  ok(!r.stale, '没过期')
  ok(stepOf(L, t.taskId, 's1').status === 'done', '步骤正常记成完成', `status=${stepOf(L, t.taskId, 's1').status}`)
  ok(L.get(t.taskId).epoch === 1, '正常一轮里代次一次都没变', `epoch=${L.get(t.taskId).epoch}`)
  ok(r.stopped === 'rounds', '收场原因是"步数用完"（不是 epoch）', `stopped=${r.stopped}`)
}

section('④c 不误伤：走到"步骤都走完 ⇒ 收工"那条路（收工**会**换代，但收场是 done）')
{
  const L = mkLedger()
  const t = L.start({ kind: 'custom', steps: [{ id: 's1', op: 'observe' }] })
  const E = mkExec(L, { call: async () => ({ ok: true, note: '服务端已确认' }) })
  const r = await E.run({ taskId: t.taskId, maxRounds: 2 })
  ok(r.done === true && !r.stale, '正常收工，没被判成过期', `done=${r.done} stale=${r.stale}`)
  ok(L.get(t.taskId).status === 'done', '任务状态是 done')
  ok(L.get(t.taskId).epoch === 2, '收工那一下把代次推到 2（这正是"换了这一代要干什么"）', `epoch=${L.get(t.taskId).epoch}`)
}

section('④b 不误伤：结果未知（时间到）走原来的路，不会被当成过期')
{
  const L = mkLedger()
  const t = L.start({ kind: 'custom', steps: [{ id: 's1', op: 'observe' }] })
  const E = mkExec(L, { call: async () => ({ mcTimeout: true, note: '时间到' }) })
  const r = await E.run({ taskId: t.taskId, maxRounds: 2 })
  ok(!r.stale, '没过期')
  ok(r.outcome === 'unknown', '还是"结果未知"', `outcome=${r.outcome}`)
  ok(stepOf(L, t.taskId, 's1').status === 'pending', '步骤被收回 pending（等复核）')
  ok(L.get(t.taskId).epoch === 1, '代次没变')
}

/* ═══════════════ ⑤ 静态接线 ═══════════════ */
section('⑤ 静态接线')
{
  const rn = stripComments(runnerSrc)
  const ex = stripComments(execSrc)

  ok(/export const TASK_EPOCH_START = 1/.test(rn), 'task-runner 导出 TASK_EPOCH_START')
  ok(/#bump \(t, why = null\)/.test(rn), '有私有的 #bump')
  ok(/epochOf \(taskId\)/.test(rn), '有 epochOf')
  ok(/staleOf \(taskId, epoch\)/.test(rn), '有 staleOf')
  ok(/epoch: TASK_EPOCH_START, epochWhy: null, epochAt: now/.test(rn), 'start() 里给新任务写了 epoch/epochWhy/epochAt')
  ok(/if \(!Number\.isFinite\(Number\(t\.epoch\)\) \|\| Number\(t\.epoch\) < TASK_EPOCH_START\) t\.epoch = TASK_EPOCH_START/.test(rn), 'migrateTask 给老任务补 epoch')
  ok(/stepLine\(t\), epoch: Number\(t\.epoch\) \|\| TASK_EPOCH_START/.test(rn), 'stepBegin 把代次回给调用方')
  ok(/if \(r\.stale === true\) return 'stale'/.test(rn), 'outcomeOf 认 stale')
  ok(/OUTCOME_LABEL = \{[^}]*stale:/.test(rn), 'OUTCOME_LABEL 里有 stale')

  /* 换代只发生在六处 —— 多一处就要有人解释为什么。
   * 2026-10-16 审计（P0-1）从三处加到五处：**`pause` / `wait` 也是换代**（状态转变，
   * 不是记账）—— 断线时正在飞的那一步必须被判成过期，否则会被记成已完成/已失败。
   * 同日实机验收再加一处：**`resume` 把 `waiting`/`blocked`/`paused` 拉回 `running` 时换代**
   * （原来的死胡同：`run` 说"先停手"、`resume` 说"接着做"，谁都不动状态）。
   * 反过来，`progress` / `note` / `checkpoint` / `stepXxx` / `touch` 这些**记账**
   * 一律不许换代（换了执行器会被自己刚写的账判成过期 = 自锁）。 */
  const bumps = [...rn.matchAll(/this\.#bump\(/g)].length
  ok(bumps === 6, '🔴 全文件只有 6 处 #bump（重排 / 取消 / 收工 / 暂停 / 等条件 / 恢复）', `实际 ${bumps} 处`)
  ok(/#bump\(t, '步骤表被重排'\)/.test(rn), 'setSteps 换代')
  ok(/#bump\(t, `任务被取消：\$\{why\}`\)/.test(rn), 'cancel 换代')
  ok(/#bump\(t, ok \? '任务已收工' : '任务已判失败'\)/.test(rn), 'finish 换代')
  ok(/#bump\(t, `暂停：\$\{why\}`\)/.test(rn), '🔴 pause 换代（断线走这条）')
  ok(/#bump\(t, `等条件：\$\{why\}`\)/.test(rn), '🔴 wait 换代（掉线 / 缺条件走这条）')
  ok(/#bump\(t, `接着做（原来是 \$\{wasStatus\}/.test(rn), '🔴 resume 把任务拉回 running 时换代')
  /* 记账方法里一个 `#bump` 都不许有 —— 这条是"自锁"的结构性防线。
   * 分两段取：① `progress` → `pause`（progress / checkpoint / fail / note）
   *            ② `stepReset` → `resume`（stepBegin / stepDone / stepFail / stepSkip） */
  const writes1 = rn.slice(rn.indexOf('  progress (taskId'), rn.indexOf('  pause (taskId'))
  const writes2 = rn.slice(rn.indexOf('  stepReset (taskId'), rn.indexOf('  resume (taskId'))
  ok(!/#bump/.test(writes1), '🔴 记账方法（progress / checkpoint / fail / note）里一个 #bump 都没有')
  ok(!/#bump/.test(writes2), '🔴 步骤记账方法（stepBegin / stepDone / stepFail / stepSkip / stepReset）里一个 #bump 都没有')

  ok(/let epoch0 = this\.ledger\.epochOf\(t\.taskId\)/.test(ex), '执行器在开跑时记下代次')
  ok(/const began = this\.ledger\.stepBegin\(t\.taskId, step\.id\)/.test(ex), 'stepBegin 的返回值收下了')
  ok(/if \(began\?\.epoch != null\) epoch0 = began\.epoch/.test(ex), 'stepBegin 回了代次就用它（这一步是哪一代的）')
  const checks = [...ex.matchAll(/this\.ledger\.staleOf\(t\.taskId, epoch0\)/g)].length
  ok(checks === 2, '🔴 两处 await 之后各对一次代次（看现场 / 干活）', `实际 ${checks} 处`)
  ok(/const staleLook = this\.ledger\.staleOf/.test(ex), '看现场之后那次检查在')
  ok(/const staleNow = this\.ledger\.staleOf/.test(ex), '干活之后那次检查在')
  /* 顺序：看现场那次必须在 `state.online` 之前，干活那次必须在写账（stepDone/stepFail）之前 */
  ok(ex.indexOf('staleLook') < ex.indexOf('if (!state.online)'), '看现场那次检查排在"在线判断"之前')
  ok(ex.indexOf('staleNow') < ex.indexOf('this.ledger.stepDone'), '🔴 干活那次检查排在**任何写账之前**')
  ok(ex.indexOf('staleNow') < ex.indexOf('this.ledger.stepReset'), '也排在 stepReset 之前')
  ok(ex.indexOf('staleNow') < ex.indexOf('this.ledger.fail'), '也排在 fail 之前')
  ok(/stoppedWhy = 'epoch'/.test(ex), '停手时记的是 epoch 原因')
  ok(/stale: true, rounds, task: brief\(\), lines/.test(ex), '返回值里带 stale:true')
}

/* ────────────────────────────────────────────────────────────
 * ⑤ `suggestAction`：任务"下一步建议"（`resume()` 的 `action` 字段）
 *
 * 🔴 为什么单独测（2026-10-17 全项目审计）：这个函数**一个断言都没有**，
 *    而它给出的 `{ tool, args }` 是**模型照着发的**。它曾经有两处会在不报错的前提下骗人：
 *      · `kind:'chest'` 传 `{ chest: … }` —— `mc_chest` 根本没有 `chest` 参数
 *        （根 schema 不拦额外字段 ⇒ 静默丢掉），而不给 `action` 时 `mc_chest` 默认是 `list`
 *        ⇒ 这条"建议"实际是在让模型去**列一遍箱子**，看着像给了下一步、其实什么都没给；
 *      · `kind:'dig'` 直接透传 `need` —— `mc_dig` 的 `count` 上限是 16，超了**静默截断**
 *        ⇒ `need:40` 只挖 16 个，模型以为该挖的都挖完了。
 * ──────────────────────────────────────────────────────────── */
section('⑤ suggestAction（"下一步建议"里的 tool/args 必须真能用）')
{
  const T = (kind, params = {}) => ({ taskId: 't1', kind, params })
  const d5 = suggestAction(T('dig', { item: 'iron_ore' }), 5)
  ok(d5?.tool === 'mc_dig' && d5.args.name === 'iron_ore' && d5.args.count === 5, '挖矿：把 need 透给 count')
  ok(d5.args.maxDistance === 16, '挖矿：maxDistance 默认 16')
  const d40 = suggestAction(T('dig', { item: 'iron_ore', maxDistance: 32 }), 40)
  ok(d40.args.count === 16, '🔴 挖矿：need 超过 16 时夹到 16（`mc_dig` 上限就是 16，超了会静默截断）')
  ok(d40.args.maxDistance === 32, '挖矿：params.maxDistance 优先')

  const c3 = suggestAction(T('craft', { item: 'iron_pickaxe' }), 3)
  ok(c3?.tool === 'mc_craft' && c3.args.count === 3, '合成：用 `count`')
  ok(!('times' in c3.args), '🔴 合成：**不许**出现 `times`（`mc_craft` 只认 `count`）')

  const s2 = suggestAction(T('smelt', { item: 'iron_ingot' }), 2)
  ok(s2?.tool === 'mc_furnace' && s2.args.count === 2, '烧炼：用 `count`')
  ok(!('times' in s2.args), '🔴 烧炼：**不许**出现 `times`')

  const m = suggestAction(T('move', { item: 'x', to: { x: 1, y: 2, z: 3 } }), null)
  ok(m?.tool === 'mc_move' && m.args.x === 1 && m.args.y === 2 && m.args.z === 3, '移动：to 摊成 x/y/z')
  ok(!('count' in m.args), '移动：不带 count')

  const chNo = suggestAction(T('chest', { item: 'iron_ore' }), 4)
  ok(chNo === null, '🔴 箱子：**不知道往哪搬就不给建议**（旧代码给的是个不存在的 `chest` 键 ⇒ 模型会去列箱子）')
  const chPut = suggestAction(T('chest', { item: 'iron_ore', action: 'put' }), 4)
  ok(chPut?.tool === 'mc_chest' && chPut.args.action === 'put' && chPut.args.name === 'iron_ore' && chPut.args.count === 4, '箱子：params.action=put ⇒ 建议 put')
  const chTake = suggestAction(T('chest', { item: 'iron_ore', action: 'take' }), null)
  ok(chTake.args.action === 'take' && !('count' in chTake.args), '箱子：take 且 need 未知时不给 count')
  ok(!('chest' in chPut.args) && !('chest' in chTake.args), '🔴 任何箱子建议里都**不许**出现 `chest` 这个键')

  ok(suggestAction(T('dig', {}), 1) === null, '没有 item 就没有建议（返回 null，不是空对象）')
  ok(suggestAction(T('unknown-kind', { item: 'x' }), 1) === null, '认不出的 kind 返回 null')

  /* 结构性防线：建议里出现的每个参数名，都必须在**目标工具**的 `parameters` 里声明过。
   * 这里只钉我们真的会建议的那几个工具（跨文件读源码，和 check-token-budget 同一套做法）。 */
  const INDEX = read('../index.js')
  const ext = (f) => read(`../extensions/${f}.mjs`)
  const declOf = (src, toolName) => {
    const at = src.indexOf(`name: '${toolName}'`)
    if (at < 0) return null
    const pi = src.indexOf('parameters:', at)
    if (pi < 0) return null
    const open = src.indexOf('{', pi)
    if (open < 0) return null
    /* 括号匹配出 parameters 那个对象（跳过字符串/注释），再取**深度 1 的键** ——
     * `x: {…}, y: {…}, z: {…}` 写在同一行也认得。 */
    let depth = 0; let i = open; let quote = null; let line = false; let blk = false
    let end = -1
    while (i < src.length) {
      const c = src[i]; const n = src[i + 1]
      if (line) { if (c === '\n') line = false; i++; continue }
      if (blk) { if (c === '*' && n === '/') { blk = false; i++ } i++; continue }
      if (quote) { if (c === '\\') { i += 2; continue } if (c === quote) quote = null; i++; continue }
      if (c === '/' && n === '/') { line = true; i += 2; continue }
      if (c === '/' && n === '*') { blk = true; i += 2; continue }
      if (c === '"' || c === "'" || c === '`') { quote = c; i++; continue }
      if (c === '{') depth++
      else if (c === '}') { depth--; if (depth === 0) { end = i; break } }
      i++
    }
    if (end < 0) return null
    const obj = src.slice(open, end + 1)
    const keys = new Set()
    depth = 0; i = 0; quote = null; line = false; blk = false
    while (i < obj.length) {
      const c = obj[i]; const n = obj[i + 1]
      if (line) { if (c === '\n') line = false; i++; continue }
      if (blk) { if (c === '*' && n === '/') { blk = false; i++ } i++; continue }
      if (quote) { if (c === '\\') { i += 2; continue } if (c === quote) quote = null; i++; continue }
      if (c === '/' && n === '/') { line = true; i += 2; continue }
      if (c === '/' && n === '*') { blk = true; i += 2; continue }
      if (c === '"' || c === "'" || c === '`') { quote = c; i++; continue }
      if (c === '{' || c === '[') { depth++; i++; continue }
      if (c === '}' || c === ']') { depth--; i++; continue }
      if (depth === 1) {
        const mm = /^([A-Za-z_$][\w$]*)\s*:/.exec(obj.slice(i))
        if (mm && (i === 0 || /[\s{,]/.test(obj[i - 1]))) { keys.add(mm[1]); i += mm[0].length; continue }
      }
      i++
    }
    return keys
  }
  const cases = [
    ['mc_dig', d40.args, INDEX],
    ['mc_craft', c3.args, ext('mc_craft')],
    ['mc_furnace', s2.args, ext('mc_furnace')],
    ['mc_move', m.args, INDEX],
    ['mc_chest', chPut.args, ext('mc_chest')],
  ]
  for (const [tool, args, src] of cases) {
    const decl = declOf(src, tool)
    ok(decl && decl.size > 0, `读到 ${tool} 的参数表（${decl ? decl.size : 0} 个）`)
    const bad = Object.keys(args).filter((k) => !decl?.has(k))
    ok(bad.length === 0, `🔴 ${tool} 的建议里每个键都是它真认的参数`, bad.length ? `多出：${bad.join('、')}` : '')
  }
}

/* ⑬ 总目标不许被"续做"改小（2026-10-19 实机） */
section('⑬ 续做同一条任务：总目标只能变大，不能被改小')
{
  const l = mkLedger()
  const t = l.start({ kind: 'dig', item: 'obsidian', total: 10, params: { item: 'obsidian' } })
  l.progress(t.taskId, { add: 5 })
  ok(l.get(t.taskId).progress.total === 10, '开工 10 个 ⇒ total=10', String(l.get(t.taskId).progress.total))
  /* 实机现场：AI 接着挖"剩下的 5 个"时又调了一次 auto({total:5})，台账于是变成 5/5 完成 */
  l.auto({ kind: 'dig', item: 'obsidian', total: 5 })
  ok(l.get(t.taskId).progress.total === 10, '🔴 续做 auto({total:5}) 不能把 total 改小', String(l.get(t.taskId).progress.total))
  ok(l.get(t.taskId).progress.done === 5, '已挖的 5 个不受影响', String(l.get(t.taskId).progress.done))
  l.auto({ kind: 'dig', item: 'obsidian', total: 12 })
  ok(l.get(t.taskId).progress.total === 12, '真的想多挖两个时 total 可以变大', String(l.get(t.taskId).progress.total))
}

console.log(`\n${pass} ✅ / ${fail} ❌`)
process.exit(fail ? 1 : 0)
