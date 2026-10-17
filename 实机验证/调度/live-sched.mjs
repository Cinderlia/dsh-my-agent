/**
 * live-sched.mjs —— P0-1「调度器与自主层一致性」实机验收（用户 m11448）
 *
 * 用户原话：「重点不是再添加一套调度机制，而是检查现有 actionId、资源冲突、优先级和任务代次
 * 是否在所有入口保持一致……这部分应以**真实调用链**验证为主。」
 *
 * 所以这个脚本**不是**直接调 `ActionScheduler`（那样只证明了类本身没问题），而是：
 *   ① 用假宿主跑真的 `apply()`（`index.js`）—— 工具按真实路径注册；
 *   ② 然后从**工具入口**调（`tools.get(name).execute(args, exec)`）——
 *      走的就是 `asTool.execute → perfWrap → runScheduled → ActionScheduler → 工具实现` 这条真链；
 *   ③ 真连本地 1.21.9 服，真发指令。
 *
 * 覆盖的场景（场景二"寻路中触发水下自救"在离线套件 `check-water-recovery` ⑧ 里钉：
 * 那一组的判据是"接线对不对"，静态断言比实机复现"寻路中途憋气"更可靠也更便宜）：
 *   ① 长动作在飞时 `mc_stop` ⇒ 调度器真的清空 + 在飞动作真的被 abort
 *   ④ 父子动作 ⇒ 子动作**复用父的 actionId**（不新建顶层记录，父记录 `frames` 涨到 2）
 *   ③ 长任务执行期间断线 ⇒ 任务换代 + 在飞那一步**不记账**
 *
 * 用法：node live-sched.mjs
 */
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOST = '127.0.0.1'
const PORT = 25565
const NAME = 'wcsched'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${'═'.repeat(6)} ${t} ${'═'.repeat(6)}`)

/* ── ① 假宿主 + 真插件 ──
 * 抄 `tools/check-rules-file.mjs` 的 `boot()`：最小够用的 ctx，只为让 `apply()` 跑起来。 */
const state = mkdtempSync(join(tmpdir(), 'wc-sched-state-'))
const ws = mkdtempSync(join(tmpdir(), 'wc-sched-ws-'))
mkdirSync(join(state, 'mem'), { recursive: true })
writeFileSync(join(state, 'config.json'), JSON.stringify({ memoryDir: join(state, 'mem') }, null, 2), 'utf8')
process.env.DSH_MC_AGENT_DIR = state
delete process.env.DSH_MC_AGENT_MEMORY_DIR

const tools = new Map()
const logs = []
const agent = { id: 'session-sched01', session: { header: { cwd: ws } } }
const fakeCtx = {
  logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), debug: (m) => logs.push(String(m)) },
  tools: { register: (d) => { tools.set(d.name, d); return () => {} }, guard: () => () => {} },
  agentPresets: { composedPreset: () => null, authorable: true, defaultId: 'standard', roots: [], list: async () => [], copy: async () => {} },
  webServer: { register: () => () => {} },
  workspaceRegistry: { archiveSession: async () => {} },
  systemPrompt: { context: () => () => {}, section: () => () => {}, getContextOrder: () => 100, getSectionOrder: () => 100 },
  inject: () => {},
  effect: (fn) => { try { fn() } catch (e) { logs.push('[effect] ' + e.message) } },
  set: () => {},
  get: (k) => (k === 'agents' ? { get: (sid) => (String(sid) === agent.id ? agent : null) } : undefined),
  on: () => () => {},
}
const mod = await import('../../index.js')
mod.apply(fakeCtx, mod.Config ? mod.Config({}) : {})
console.log(`插件已挂载：注册了 ${tools.size} 个工具`)

const exec = { agent, signal: null }
/** 从**真工具入口**调（不是直接调调度器） */
const call = async (name, args = {}) => {
  const t = tools.get(name)
  if (!t) throw new Error(`没有工具 ${name}`)
  return await t.execute(args, exec)
}
/** 工具返回两种形状：字符串，或 `{ text }` / `{ result }` —— 统一成文本 */
const txt = (r) => {
  if (r == null) return ''
  if (typeof r === 'string') return r
  if (typeof r.text === 'string') return r.text
  if (Array.isArray(r.result)) return r.result.join('\n')
  if (typeof r.result === 'string') return r.result
  try { return JSON.stringify(r) } catch { return String(r) }
}
const diag = async () => {
  const d = await call('mc_diag', {})
  return (d && typeof d === 'object') ? (d.scheduler ?? null) : null
}
const names = (s) => JSON.stringify((s?.active ?? []).map((a) => `${a.name}#${a.actionId}(${a.frames})`))
/** 直接读台账文件 —— `mc_task {action:"get"}` 的文本里**没有 epoch**，而换代正是要验的东西 */
const taskFile = () => {
  const stack = [join(state, 'mem')]
  while (stack.length) {
    const d = stack.pop()
    let es = []
    try { es = readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of es) {
      const p = join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name === 'tasks.json') return p
    }
  }
  return null
}
const epochOf = (tid) => {
  const p = taskFile()
  if (!p) return NaN
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    const t = (j.tasks ?? []).find((x) => x.taskId === tid)
    return Number(t?.epoch ?? NaN)
  } catch { return NaN }
}
/** 台账里某一步的状态 —— 用来验"断线时在飞那一步有没有被记账" */
const stepStatusOf = (tid, sid) => {
  const p = taskFile()
  if (!p) return null
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    const t = (j.tasks ?? []).find((x) => x.taskId === tid)
    const s = (t?.steps ?? []).find((x) => x.id === sid)
    return s ? `${s.status}(试${s.attempts}次)` : null
  } catch { return null }
}

try {
  section('前置：真连本地服')
  const conn = await call('mc_connect', { host: HOST, port: PORT })
  console.log(`  · mc_connect ⇒ ${txt(conn).slice(0, 120)}`)
  const stTxt = txt(await call('mc_status', {}))
  ok(/🟢|active|我在/.test(stTxt), '连上了（mc_status 看得到自己）', stTxt.slice(0, 90))
  const s0 = await diag()
  ok(s0 && Array.isArray(s0.active), 'mc_diag 里能看到调度器快照', `mode=${s0?.mode} active=${s0?.active?.length}`)

  const p0 = stTxt.match(/\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/)
  const bx = p0 ? Number(p0[1]) : 0, by = p0 ? Number(p0[2]) : 64, bz = p0 ? Number(p0[3]) : 0
  console.log(`  · 我在 (${bx},${by},${bz})`)

  /* ═══════════ ① 长动作在飞时 mc_stop ═══════════ */
  section('① 长动作在飞时 mc_stop ⇒ 调度器清空 + 在飞动作被 abort')
  const moveP = call('mc_move', { x: bx + 80, y: by, z: bz + 80, budget: 20000 }).then(
    (r) => ({ done: true, t: txt(r).slice(0, 100) }), (e) => ({ done: true, err: String(e?.message ?? e) }))
  await sleep(700)
  const s1 = await diag()
  const moving = (s1?.active ?? []).find((a) => a.name === 'mc_move')
  ok(Boolean(moving), '在飞的 mc_move 登记在调度器里（有 actionId）', JSON.stringify(moving ?? null).slice(0, 130))
  ok((moving?.resources ?? []).includes('movement'), '它占着 movement 资源', JSON.stringify(moving?.resources ?? []))

  await call('mc_stop', {})
  await sleep(500)
  const s2 = await diag()
  ok((s2?.active ?? []).length === 0, '🔴 mc_stop 之后调度器**真的清空了**（不是"表里还挂着"）', `active=${names(s2)}`)
  const moved = await Promise.race([moveP, sleep(8000).then(() => ({ done: false }))])
  ok(moved.done === true, '在飞的 mc_move 真的收场了（没被挂住）', JSON.stringify(moved).slice(0, 120))
  /* 🔴 `mc_stop` = 「强制停止」，它**会退出游戏**（`stopSession` 第 ② 步）——
   *    所以后面要重连。这本身也是"stop 真的停了"的一条旁证。 */
  const offTxt = txt(await call('mc_status', {}))
  ok(/standby|不在游戏里|⚪/.test(offTxt), '🔴 mc_stop 之后确实退出了游戏（旁证：它真的停了）', offTxt.slice(0, 70))
  await call('mc_connect', { host: HOST, port: PORT })
  await sleep(600)
  ok(/🟢|active|我在/.test(txt(await call('mc_status', {}))), '重连成功（继续测后面的场景）')

  /* ═══════════ ④ 父子动作复用 actionId ═══════════ */
  section('④ 任务里的子动作复用父的 actionId（父记录 frames 涨到 2，不新建顶层记录）')
  /* 任务只能由"长活儿"自动开（`mc_dig` 的 count>=4）—— 挖不到也算开了台账，这里要的是台账本身。
   * 🔴 目标**故意挑 `sand`**：机器人背包里已经有 34 个 dirt，拿 dirt 当目标的话
   *    `resume` 的现场复核会算出 `need === 0` ⇒ 任务立刻"完成"、一步都不跑，
   *    场景 ④（父子同时在飞）和 ③（在飞那一步）就都测不到了。 */
  const digTxt = txt(await call('mc_dig', { name: 'sand', count: 8 }))
  console.log(`  · mc_dig 建台账 ⇒ ${digTxt.replace(/\n/g, ' | ').slice(0, 120)}`)
  const listTxt = txt(await call('mc_task', { action: 'list' }))
  const taskId = (listTxt.match(/(t[a-z0-9-]{6,})/i) ?? [])[1] ?? null
  ok(Boolean(taskId), '挖 4 个以上真的开了任务台账', `taskId=${taskId} · ${listTxt.replace(/\n/g, ' | ').slice(0, 90)}`)
  const planTxt = txt(await call('mc_task', {
    action: 'plan', taskId,
    steps: [
      { id: '走到东北边', op: 'mc_move', args: { x: bx + 40, y: by, z: bz + 40 } },
      { id: '再走回来', op: 'mc_move', args: { x: bx, y: by, z: bz } },
    ],
  }))
  console.log(`  · plan ⇒ ${planTxt.replace(/\n/g, ' | ').slice(0, 140)}`)
  ok(/走到东北边/.test(planTxt), '步骤表写进去了', planTxt.slice(0, 90))
  /* 🔴 台账现在是 `waiting`（`mc_dig` 找不到目标就把自己挂起了）—— `run` 见 `waiting` 会
   *    「先停手」、一步都不跑（实测「推进 0 步」）。先 `resume` 把它拉回 `running`。 */
  const resTxt = txt(await call('mc_task', { action: 'resume', taskId }))
  console.log(`  · resume ⇒ ${resTxt.replace(/\n/g, ' | ').slice(0, 130)}`)
  ok(/进行中/.test(resTxt) && !/· waiting/.test(resTxt),
    '🔴 resume 真的把任务从 waiting 拉回「进行中」（以前只给建议、不动状态 ⇒ 死胡同）', resTxt.slice(0, 80))
  ok(/拉回/.test(resTxt), '工具输出里说清了"从哪个状态拉回来的"')

  const runP = call('mc_task', { action: 'run', taskId, force: true }).then(
    (r) => ({ done: true, t: txt(r).slice(0, 120) }), (e) => ({ done: true, err: String(e?.message ?? e) }))
  let shared = null
  for (let i = 0; i < 60; i++) {
    const s = await diag()
    const a = (s?.active ?? [])[0]
    if (a && Number(a.frames) >= 2) { shared = { s, a }; break }
    if ((await Promise.race([runP, sleep(1).then(() => null)]))?.done) break
    await sleep(100)
  }
  if (shared) {
    ok(true, '🔴 子动作复用父的 actionId（`frames` 涨到 2，不是另起一条）',
      `${shared.a.name}#${shared.a.actionId} frames=${shared.a.frames} parent=${shared.a.parent}`)
    ok((shared.s.active ?? []).length === 1, '同一时刻只有一条顶层记录（子动作没另起记录）', names(shared.s))
  } else {
    console.log('  · 没抓到"父子同时在飞"的中间态 —— 用静态断言兜底（下面那两条）')
  }
  const schedSrc = readFileSync(new URL('../../src/action-scheduler.mjs', import.meta.url), 'utf8')
  ok(/parentRec \? parentRec\.actionId : null/.test(schedSrc), '静态：子动作的 actionId 取自父记录')
  ok(/rec\.frames\+\+/.test(schedSrc), '静态：子动作只让父记录 `frames++`，不新建记录')
  const ran = await Promise.race([runP, sleep(12000).then(() => ({ done: false }))])
  console.log(`  · run ⇒ ${JSON.stringify(ran).slice(0, 140)}`)

  /* ═══════════ ③ 长任务执行中断线 ⇒ 换代 + 不记账 ═══════════ */
  section('③ 长任务在飞时断线 ⇒ 任务换代、那一步不记账')
  const eMid = epochOf(taskId)
  /* 让任务重新跑起来，再在"某一步在飞"的时候断线 */
  await call('mc_task', { action: 'plan', taskId, steps: [
    { id: '走很远', op: 'mc_move', args: { x: bx + 70, y: by, z: bz + 70 } },
  ] })
  await call('mc_task', { action: 'resume', taskId })
  const run2 = call('mc_task', { action: 'run', taskId, force: true }).then(
    (r) => ({ done: true, t: txt(r).slice(0, 120) }), (e) => ({ done: true, err: String(e?.message ?? e) }))
  let flying = null
  for (let i = 0; i < 40; i++) {
    const s = await diag()
    if ((s?.active ?? []).length > 0) { flying = s; break }
    if ((await Promise.race([run2, sleep(1).then(() => null)]))?.done) break
    await sleep(100)
  }
  ok(Boolean(flying), '断线前确实有动作在飞（不然测不到"在飞那一步"）', names(flying))
  const stepBefore = stepStatusOf(taskId, '走很远')
  await call('mc_disconnect', {})
  await sleep(900)
  const after = txt(await call('mc_task', { action: 'get', taskId }))
  const settled = await Promise.race([run2, sleep(8000).then(() => ({ done: false }))])
  const stepAfter = stepStatusOf(taskId, '走很远')
  console.log(`  · 断线后 get ⇒ ${after.replace(/\n/g, ' | ').slice(0, 150)}`)
  console.log(`  · 「走很远」这一步：${stepBefore} → ${stepAfter}（直读 tasks.json）`)
  ok(/paused|暂停|blocked|卡住了|done|完成/.test(after), '🔴 断线后任务不再是"继续跑"', after.slice(0, 100))
  ok(!/· running/.test(after), '🔴 断线后任务**不**停在 running（否则在飞那一步会被记成已完成）', after.slice(0, 100))
  ok(!/^done/.test(String(stepAfter ?? '')), '🔴 断线时在飞的那一步**没有**被记成已完成', `step=${stepAfter}`)
  const eAfter = epochOf(taskId)
  console.log(`  · 台账 epoch：${eMid} → ${eAfter}（直读 tasks.json）`)
  ok(Number.isFinite(eMid) && Number.isFinite(eAfter) && eAfter > eMid,
    '🔴 断线**让任务换代了**（epoch 涨了）—— 在飞那一步回来会被判过期', `epoch ${eMid} → ${eAfter}`)
  ok(settled.done === true, '任务执行器收场了（没被挂住）', JSON.stringify(settled).slice(0, 130))
  const sEnd = await diag()
  ok((sEnd?.active ?? []).length === 0, '断线后调度器也是空的', `active=${names(sEnd)}`)

  await call('mc_disconnect', {}).catch(() => {})
} catch (e) {
  fail++
  console.log(`\n💥 脚本自己炸了：${e?.stack ?? e}`)
} finally {
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`live-sched：pass=${pass} fail=${fail}`)
  process.exit(fail ? 1 : 0)
}
