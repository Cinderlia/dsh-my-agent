/* ============================================================================
 * jobs —— **异步任务队列**（2026-10-24 用户定义）
 * ----------------------------------------------------------------------------
 * 用户规则（逐条对应实现）：
 *   ① 「工具需要开始执行时返回一个报告，然后异步执行」→ `enqueue()` 立刻返回**排队/开始**报告；
 *   ② 「任务板是个队列，依次执行」→ **同一时刻只跑一个**，`pump()` 串行推进；
 *   ③ 「执行结束或失败时向 agent 发送报告，平时不占用 agent」→ `notify()` 走注入通道；
 *   ④ 「任务板非空就隐藏所有主动工具」→ `onStateChange` 回调给宿主去收窄工具面；
 *   ⑤ 「准备一个原语让 agent 介入队列，冻结 + 停队首 + 只留它自己」→ `interrupt()`；
 *   ⑥ 「stop：停掉所有正在执行的、清空队列、重置被动工具」→ `stopAll()` + `passiveReset` 钩子。
 *
 * 状态机：
 *   idle ──enqueue──▶ running ──finish/fail──▶ idle（有队列就继续 running）
 *     ▲                 │
 *     └──resume──────── intervening（冻结 + 停队首 + 只留介入原语）
 *                        ▲
 *                     interrupt
 * ========================================================================== */
import { debugLog } from './log.mjs'
/** 介入冷却：两次介入之间至少要隔这么久（用户 2026-10-24：「介入模式加个冷却时间」） */
export const INTERRUPT_COOLDOWN_MS = 60_000
let seq = 0
const nextId = () => `job-${Date.now().toString(36)}-${(++seq).toString(36)}`
/** 把多行报告压成一行（调试日志一行一条，别让一个失败原因撑成十行） */
const oneLine = (s, n = 400) => String(s ?? '').replace(/\s*\n+\s*/g, ' ⏎ ').slice(0, n)
export class JobBoard {
  /**
   * @param {Object} deps
   * @param {Function} deps.inject        (agentId, text) => boolean
   * @param {Function} [deps.log]
   * @param {Function} [deps.onStateChange] (snapshot) => void  队列状态变了（宿主据此收窄/恢复工具面）
   * @param {number}   [deps.keep]
   */
  constructor ({ inject, log = null, onStateChange = null, keep = 20, interruptCooldownMs = INTERRUPT_COOLDOWN_MS, onProgress = null } = {}) {
    this.inject = typeof inject === 'function' ? inject : () => false
    this.log = typeof log === 'function' ? log : () => {}
    this.onStateChange = typeof onStateChange === 'function' ? onStateChange : () => {}
    this.keep = Math.max(4, Number(keep) || 20)
    /** @type {Array<Object>} 等待执行（FIFO） */
    this.queue = []
    /** @type {Object|null} 正在跑的那个 */
    this.current = null
    /** 'idle' | 'running' | 'frozen' | 'intervening' */
    this.state = 'idle'
    /** 最近结束的任务（含成功/失败/取消），给 mc_probe 看 */
    this.done = []
    /** 被动工具的复位钩子（用户：「重置被动工具」） */
    this.passiveResets = new Map()
    /** 介入冷却（ms）；0 = 不冷却（自检/调试用） */
    this.interruptCooldownMs = Math.max(0, Number(interruptCooldownMs) || 0)
    /** 上次介入 / 上次结束介入的时刻（两者取晚的算冷却） */
    this.lastInterruptAt = 0
    this.lastResolvedAt = 0
    /** 🔴 用户 2026-10-26：「把实时任务队列送进常驻 prompt」—— 队列一变就回调，
     *    让宿主那一轮就能看到"身体在干什么"（不用它自己去查 mc_probe）。
     *    只在**文案真的变了**时触发（同一秒里反复 flush 不至于刷屏）。 */
    this.onProgress = typeof onProgress === 'function' ? onProgress : () => {}
    this.lastLiveText = ''
  }
  /**
   * 任务自己报进度（"挖到 3/8""走到一半"…）。同一秒内重复调用只留最后一条。
   * 任务想让人知道它在干什么就调它 —— 报告也就一句，别写小作文。
   */
  progress (text) {
    /**
     * ⚠️ 任务里没把 board 传进来的情况：`run(signal, job)` 的 job 上有 `report`，
     * 它调回这里。但 `progress()` 只认 `this.current` —— yieldFor 期间 current 会被置空，
     * 那是"我挂起等别人"，此刻的 progress 应该由**插到前面的那个任务**来报，所以这里不兜。
     */
    const job = this.current
    if (!job) return false
    job.progress = oneLine(text, 120)
    job.progressAt = Date.now()
    this.pushLive()
    return true
  }
  /**
   * 调试日志（用户 2026-10-26）：「把每个任务的开始、结束和结束原因（成功或失败原因），
   * 都带上时间戳记录进 debug 日志文件。」—— 开关/文件路径都在 `src/log.mjs`，
   * 这边只管写；写失败绝不影响队列本身。
   */
  dbg (...args) {
    try { debugLog(...args) } catch { /* 日志不重要，队列重要 */ }
  }
  /** 这个任务从开始到结束用了多久（毫秒；没开始过就算 0） */
  msOf (job) {
    const a = Number(job?.startedAt ?? 0)
    const b = Number(job?.endedAt ?? Date.now())
    return a && b ? Math.max(0, b - a) : 0
  }
  /**
   * 现在能不能介入？冷却期内一律不行 —— 用户要求「加个冷却时间，同时不鼓励 agent 介入」：
   * 反复 interrupt/resume 会把队列搅成筛子，而且 agent 本来就不该管队列。
   * @returns {{ok:true} | {ok:false, waitMs:number}}
   */
  canInterrupt (now = Date.now()) {
    if (!this.interruptCooldownMs) return { ok: true }
    const base = Math.max(this.lastInterruptAt, this.lastResolvedAt)
    const left = base + this.interruptCooldownMs - now
    return left > 0 ? { ok: false, waitMs: left } : { ok: true }
  }
  /* ── 被动工具注册：`mc_stop` 会把它们重置 ── */
  registerPassiveReset (name, fn) {
    if (typeof fn === 'function') this.passiveResets.set(String(name), fn)
  }
  /**
   * 紧凑的队列快照文本（用户 2026-10-25：**队列随快照一起展示**）。
   * 给工具返回 / 任务报告末尾附一行，agent 不用另外查就知道队伍长什么样。
   */
  snapshotText () {
    const s = this.snapshot()
    const lines = []
    const stateText = s.state === 'intervening' ? '已冻结（介入中）' : s.state === 'running' ? '执行中' : '空闲'
    lines.push(`📋 队列[${stateText}]`)
    /* ★ = 初始任务（LLM 发布的那条）：它一结束就清空整个队列 —— 标出来，别让 agent 误以为后面还有活 */
    const mark = (j) => `${j.id}${j.root ? '★' : ''}（${j.summary}）`
    if (s.current) lines.push(`  ▶ ${mark(s.current)}`)
    if (s.queue.length) lines.push('  ⏳ ' + s.queue.map(mark).join(' → '))
    if (!s.current && !s.queue.length) lines.push('  （空）')
    else {
      if (s.current?.root || s.queue.some((j) => j.root)) lines.push('  ★ = 初始任务（它结束/失败会清空整个队列）')
    }
    return lines.join('\n')
  }

  /* ── 实时状态（用户 2026-10-26：「把实时任务队列送进常驻 prompt，让 LLM 知道自己在做什么」）──
   * 每轮由宿主的注入通道调 `liveText()`；文案变了宿主才置脏、下一轮重投。 */
  /** 跑了多久，人话版：37s / 4m12s */
  elapsedText (job, now = Date.now()) {
    const a = Number(job?.startedAt ?? 0)
    if (!a) return ''
    const sec = Math.max(0, Math.round((now - a) / 1000))
    if (sec < 60) return `${sec}s`
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return m < 60 ? `${m}m${String(s).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
  }
  /**
   * 常驻 prompt 里的那几行。**空队列也给一行** —— 用户要的是"永远知道现在能不能发活"。
   */
  liveText () {
    const s = this.snapshot()
    const busy = Boolean(s.current) || s.queue.length > 0
    const lines = []
    if (!busy) {
      lines.push('📋 任务队列：空 —— 身体闲着，现在可以发活。')
      lines.push('   能发活的工具：`mc_collect`（收集）、`mc_craft`（合成/熔炼）、`mc_smelt`（烧）、'
        + '`mc_build`（盖）、`mc_chest`（存取）、`mc_trade`（交易）、`mc_station`（附魔/铁砧）、'
        + '`mc_toss_to`（给人东西）、`mc_navi`（走过去/跟人）。')
      lines.push('   发布后**立刻返回**、身体在后台干；干完/失败会主动报告 —— 不用等在这儿反复查。')
      return lines.join('\n')
    }
    const stateText = s.state === 'intervening' ? '已冻结（介入中）' : '执行中'
    const now = Date.now()
    const head = s.current
      ? `▶ ${s.current.id}${s.current.root ? '★' : ''}（${s.current.summary}）· ${this.elapsedText(s.current, now)}`
      : '（没有正在跑的）'
    lines.push(`📋 任务队列[${stateText}]：` + head)
    if (s.current?.progress) lines.push(`   进度：${s.current.progress}`)
    if (s.queue.length) lines.push('   ⏳ 排队：' + s.queue.map((j) => `${j.summary}`).join(' → '))
    if (s.current?.root || s.queue.some((j) => j.root)) lines.push('   ★ = 初始任务，它一结束（成或败）整个队列就清空')
    lines.push('   ⏸ 身体正在干，暂时别硬操控它。你能做的：读环境（`mc_self`/`mc_map`/`mc_scan_surroundings`/`mc_observe`）、'
      + '想下一步；**只有发现它走歪了**才 `mc_interrupt`（冷却 60 秒）或 `mc_stop`。')
    lines.push('   🔒 操作类工具这会儿是收起的 —— 队列一空就自动回来。')
    return lines.join('\n')
  }
  /** 文案变了就通知宿主（置脏 → 下一轮重投）。队列的每个生命周期节点都该调。 */
  pushLive () {
    let text = ''
    try { text = this.liveText() } catch { return }
    if (text === this.lastLiveText) return
    this.lastLiveText = text
    try { this.onProgress(text) } catch { /* 通知失败不影响队列 */ }
  }
  /** 队列快照（给工具返回 / 宿主判据用） */
  snapshot () {
    return {
      state: this.state,
      current: this.current ? this.brief(this.current) : null,
      queue: this.queue.map((j) => this.brief(j)),
      done: this.done.slice(0, 5),
      frozen: this.state === 'frozen' || this.state === 'intervening',
      busy: Boolean(this.current) || this.queue.length > 0,
    }
  }
  brief (j) {
    return {
      id: j.id, kind: j.kind, summary: j.summary, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt, root: Boolean(j.root),
      /* 🔴 2026-10-26：`agentId` 必须带上 —— 宿主的队列闸门（队列忙就收起操作工具）
       *    是拿 `snap.current.agentId` 去找 agent 的，少这个字段闸门就永远不触发
       *    （症状：队列在跑，但工具面一点没变、debug 日志里也没有 🔒 那一行）。 */
      agentId: j.agentId ? String(j.agentId) : null,
      /* 挂起中的任务：它正等谁、走到哪一步 —— 排查"卡住不动"全靠这两个字段 */
      waitingOn: j.waitingOn ?? null,
      phase: j.state && typeof j.state === 'object' ? (j.state.phase ?? null) : null,
    }
  }
  /**
   * 入队并（可能）立刻开始。**立刻返回**，不等执行。
   * @param {Object} spec {kind, agentId, summary, plan, run(signal, job)=>Promise<{text,data}>}
   * @returns {{ok:true, job, position:number, started:boolean} | {ok:false, why:string, current:Object|null}}
   */
  enqueue ({ kind, agentId, summary, plan = null, run, initial = undefined }) {
    if (this.state === 'intervening') {
      return { ok: false, why: '队列正在被介入（agent 正在处理队首任务），先 mc_interrupt 选一个动作再继续', current: this.current ? this.brief(this.current) : null }
    }
    /* 🔴 用户 2026-10-26：「标记由 LLM 发布的那个初始任务。」
     *    显式给 initial:true 就用它；没给就按「队列空着、我是第一条」自动认作初始任务
     *    （enqueue 只被工具层调用 = 都是 LLM 发布的；插队/转交走 yieldFor/handOff，不经过这里）。 */
    const root = initial === undefined ? (!this.current && this.queue.length === 0) : Boolean(initial)
    const job = this.makeJob({ kind, agentId, summary, plan, run, root })
    this.queue.push(job)
    const wasIdle = !this.current && this.state === 'idle'
    this.log(`任务 ${job.id} 入队（第 ${this.queue.length} 位）：${job.summary}`)
    this.dbg('＋入队', job.id, `[${job.kind}]`, root ? '★初始任务' : '（插队）', job.summary,
      `第 ${this.queue.length} 位`, this.current ? `｜正在跑 ${this.current.id}` : '｜队列本来空闲')
    if (wasIdle) this.pump()
    this.changed()
    return { ok: true, job, position: this.queue.indexOf(job) + (this.current ? 1 : 0), started: this.current === job }
  }
/** 造一个任务对象（enqueue / yieldFor 共用） */
  makeJob ({ kind, agentId, summary, plan = null, run = null, state = undefined, root = false }) {
    return {
      id: nextId(),
      kind: String(kind ?? 'job'),
      agentId: agentId ? String(agentId) : null,
      summary: String(summary ?? ''),
      plan,
      /** 初始任务（LLM 发布的那条）：它结束/失败就清空整个队列（见 clearAfterRoot） */
      root: Boolean(root),
      status: 'queued',
      startedAt: null,
      endedAt: null,
      report: null,
      error: null,
      state,
      run: typeof run === 'function' ? run : null,
      controller: typeof AbortController === 'function' ? new AbortController() : null,
      /** 最近一次自报的进度（"挖到 3/8"）—— 常驻 prompt 里那行"进度："就是它 */
      progress: null,
      progressAt: 0,
      /** 任务可以调它自报进度；绑到 board 上，这样 run 里不用额外拿 ctx */
      report: (text) => { try { this.progress(String(text ?? '')) } catch { /* 报不了不影响干活 */ } },
    }
  }
  /**
   * **插队 + 挂起自己**（用户 2026-10-24 定的核心机制）。
   *
   * 语义：当前任务干到一半发现"得先让别人干件事"，就把那个任务**插到自己前面**，
   * 自己挂起排到它后面；等前面的跑完，队列会**重新调用**自己的 `run()` ——
   * 这时从 `job.state` 里恢复进度继续（所以 run 必须写成可恢复的状态机）。
   *
   * 典型用法（mc_collect）：
   *   if (距离太远) { board.yieldFor(job, { kind:'navi', …, run: … }); return { yielded: true } }
   *
   * @returns {boolean} 真的插进去了（不是当前任务就返回 false）
   */
  yieldFor (job, spec = {}) {
    if (!job || this.current !== job) return false
    if (this.state === 'frozen' || this.state === 'intervening') return false
    const child = this.makeJob(spec)
    /* 🔴 用户 2026-10-25 定的队列语义：**没有父子**，只有"插到我前面"。
     *    这里不记 parent，也不用 child/parent 这种词 —— 只是把一件事排到我前面。 */
    job.status = 'waiting'
    job.waitingOn = child.id
    this.current = null
    /* unshift 顺序：先放自己、再放子任务 ⇒ 子任务在前，自己在后 */
    this.queue.unshift(job)
    this.queue.unshift(child)
    this.state = 'running'
    this.log(`任务 ${job.id} 挂起，插入子任务 ${child.id}（${child.summary}）`)
    this.dbg('⏸ 挂起', job.id, `[${job.kind}]`, job.summary, '→ 插入', child.id, `[${child.kind}]`, child.summary)
    this.changed()
    this.pump()
    return true
  }
  /** 队列推进：没在跑的、没冻结的、有排队的 → 启动下一个 */
  pump () {
    if (this.current || this.state === 'frozen' || this.state === 'intervening') return
    const job = this.queue.shift()
    if (!job) { this.state = 'idle'; this.dbg('· 空闲（队列空）'); this.changed(); return }
    this.current = job
    this.state = 'running'
    job.status = 'running'
    /* 🔴 只在**第一次**开始记时间：任务被 yieldFor 挂起后再恢复时，
     *    这里会把 startedAt 冲掉，最终报告就变成"0.2 秒"（实测踩过）。 */
    if (!job.startedAt) job.startedAt = Date.now()
    this.changed()
    this.log(`任务 ${job.id} 开始：${job.summary}`)
    this.dbg('▶ 开始', job.id, `[${job.kind}]`, job.summary, job.root ? '★初始任务' : '',
      `｜队列剩 ${this.queue.length} 个`, job.startedAt && job.status === 'running' && job.startedAt < Date.now() - 50 ? '（恢复执行）' : '')
    Promise.resolve()
      .then(() => (job.run ?? (() => { throw new Error('没有可执行体') }))(job.controller?.signal, job))
      .then((r) => this.finish(job.id, { ...(r ?? {}), ok: r?.ok !== false }))
      .catch((e) => this.fail(job.id, e))
  }
  get (id) { return [this.current, ...this.queue, ...this.done].find((j) => j?.id === String(id ?? '')) ?? null }
  /**
   * 把失败原因写给**队列里的下一个任务**（它正是那个"等这件事做完"的人）。
   * 队列是线性的，下一个更清楚该怎么办：重试、换材料、还是放弃。
   * 不写 parent：那不是队列，那是递归。
   */
  handFailureToNext (job, error) {
    try {
      const next = this.queue[0]
      if (next?.state && typeof next.state === 'object') {
        next.state.__lastError = { kind: job.kind, summary: job.summary, error, at: Date.now() }
      }
    } catch { /* 回写失败不影响任务本身 */ }
  }

  finish (id, { text = '', data = null, ok = true } = {}) {
    const job = this.current
    if (!job || job.id !== String(id)) return false
    job.status = ok ? 'done' : 'failed'
    job.endedAt = Date.now()
    job.report = { text: String(text), data }
    if (!ok) this.handFailureToNext(job, job.report.text || '失败')
    this.current = null
    this.archive(job)
    this.dbg(ok ? '✅ 结束' : '❌ 结束（失败）', job.id, `[${job.kind}]`, job.summary,
      `${this.msOf(job)}ms`, `｜${ok ? '成功' : '失败'}原因：${oneLine(job.report.text) || '（空）'}`)
    const cleared = this.clearAfterRoot(job, ok ? '完成' : '失败')
    this.notify(job, `${ok ? '✅' : '❌'} ${job.summary}\n${job.report.text}`
      + (cleared ? `\n（初始任务结束，已清空队列里剩下的 ${cleared} 个任务）` : ''))
    this.state = 'idle'
    this.pump()
    this.changed()
    return true
  }
  fail (id, err) {
    const job = this.current
    if (!job || job.id !== String(id)) return false
    job.status = 'failed'
    job.endedAt = Date.now()
    job.error = String(err?.message ?? err ?? '未知错误')
    this.handFailureToNext(job, job.error)
    this.current = null
    this.archive(job)
    this.dbg('❌ 结束（异常）', job.id, `[${job.kind}]`, job.summary, `${this.msOf(job)}ms`,
      `｜异常：${oneLine(job.error)}`)
    const clearedFail = this.clearAfterRoot(job, '失败')
    this.notify(job, `❌ ${job.summary} 失败：${job.error}`
      + (clearedFail ? `\n（初始任务结束，已清空队列里剩下的 ${clearedFail} 个任务）` : ''))
    this.state = 'idle'
    this.pump()
    this.changed()
    return true
  }
  /**
   * **初始任务结束时清空整个队列**（用户 2026-10-26）：
   * 「当初始任务完成或者失败时，清空整个任务队列。」
   *
   * 初始任务 = LLM 发布的那条（`enqueue` 打的 `root`）。它一结束，这条工具调用链就到底了，
   * 后面排着的东西（上一轮的残留、别的东西）继续跑没有意义 —— 全停比逐个失败清楚。
   * @returns {number} 清掉的任务数（0 = 不是初始任务）
   */
  clearAfterRoot (job, why = '结束') {
    if (!job?.root) return 0
    return this.abortAll(`初始任务${why}（${job.summary}）→ 清空队列`)
  }
  /**
   * **转交**（用户 2026-10-24）：当前任务把活交给另一个任务，**自己退队**、不再恢复。
   *
   * 典型：`mc_collect` 发现要的东西是合成品 → 插一个 `craft` 到队首，自己走人。
   * 与 `yieldFor` 的区别只有一处：yield 之后自己还会回来，handOff 之后**永远不回来**。
   */
  handOff (job, spec = {}) {
    if (!job || this.current !== job) return false
    const child = this.makeJob(spec)
    /* 转交的是初始任务 → 接手的这条也算初始任务（否则链尾结束时不会清队列） */
    if (job.root) child.root = true
    job.status = 'handed-off'
    job.endedAt = Date.now()
    job.error = `已转交 ${child.kind}`
    this.current = null
    this.archive(job)
    this.queue.unshift(child)
    this.state = 'running'
    this.log(`任务 ${job.id} 转交给 ${child.id}（${child.summary}）`)
    this.dbg('🔀 转交', job.id, `[${job.kind}]`, job.summary, '→', child.id, `[${child.kind}]`, child.summary)
    this.changed()
    this.pump()
    return true
  }
  /**
   * **清空整个队列**（用户 2026-10-25）：「如果附近没有足够数量的方块，直接报错清空整个任务队列。」
   * 条件根本不满足时继续排下去没有意义，全停比逐个失败更清楚。
   * @returns {number} 清掉的任务数
   */
  abortAll (reason = '条件不满足') {
    const n = this.queue.length
    const dropped = this.queue.map((j) => `${j.id}[${j.kind}]`)
    for (const j of this.queue) {
      j.status = 'cancelled'
      j.endedAt = Date.now()
      j.error = String(reason)
      this.archive(j)
    }
    this.queue = []
    this.state = 'idle'
    this.log(`清空整个队列：${n} 个任务（${reason}）`)
    this.dbg('🧹 清空队列', `${n} 个`, `｜原因：${oneLine(reason)}`, dropped.length ? `｜丢掉：${dropped.join(' / ')}` : '')
    this.changed()
    return n
  }

  /**
   * **介入**（用户第 ⑤ 条）：冻结队列 + 停队首 + 进入 intervening（宿主据此只留感知 + 这个原语）。
   * @returns {{stopped:Object|null, queued:number}}
   */
  interrupt (why = 'agent 介入') {
    const gate = this.canInterrupt()
    if (!gate.ok) return { ok: false, cooldownMs: gate.waitMs, stopped: null, queued: this.queue.length }
    this.lastInterruptAt = Date.now()
    const stopped = this.current
    this.state = 'intervening'
    if (stopped) {
      try { stopped.controller?.abort() } catch { /* 已中止 */ }
      stopped.status = 'stopped'
      stopped.endedAt = Date.now()
      stopped.error = why
      this.current = null
      this.archive(stopped)
      this.log(`介入：停掉队首 ${stopped.id}（${stopped.summary}）`)
    }
    this.dbg('⛔ 介入（冻结队列）', stopped ? `停掉 ${stopped.id} [${stopped.kind}] ${stopped.summary}｜${this.msOf(stopped)}ms` : '（没有在跑的）', `｜排队 ${this.queue.length} 个`)
    this.changed()
    return { ok: true, stopped: stopped ? this.brief(stopped) : null, queued: this.queue.length }
  }
  /**
   * 介入之后的选择（**唯一**允许的四种；不允许直接改队列）。
   * @param {'resume'|'retry'|'skip'|'cancel'} action
   */
  resolveInterrupt (action, why = 'agent 决定') {
    const act = String(action ?? '').toLowerCase()
    let detail = ''
    if (act === 'retry') {
      const stopped = this.done.find((j) => j.status === 'stopped' && j.run)
      if (stopped) {
        const again = { ...stopped, id: nextId(), status: 'queued', startedAt: null, endedAt: null, report: null, error: null, controller: typeof AbortController === 'function' ? new AbortController() : null }
        this.queue.unshift(again)
        detail = `已把「${stopped.summary}」放回队首重试（${again.id}）`
      } else detail = '没有可重试的队首任务（它已经结束了）'
    } else if (act === 'skip') {
      const next = this.queue.shift()
      detail = next ? `已跳过并丢弃「${next.summary}」（${next.id}）` : '队列里没有排队的任务可跳过'
    } else if (act === 'cancel') {
      const n = this.queue.length
      for (const j of this.queue) { j.status = 'cancelled'; j.endedAt = Date.now(); j.error = why; this.archive(j) }
      this.queue = []
      detail = `已清空队列（丢掉 ${n} 个）`
    } else if (act === 'resume') {
      detail = '队列已恢复'
    } else {
      return { ok: false, why: `未知动作 "${action}"；只能 resume / retry / skip / cancel` }
    }
    this.lastResolvedAt = Date.now()
    this.dbg('介入处理完毕', act, `｜${oneLine(detail)}`)
    this.state = 'idle'
    this.pump()
    this.changed()
    return { ok: true, action: act, detail }
  }
  /**
   * **stop**（用户第 ⑥ 条）：停当前 + 清空队列 + 重置被动工具。
   * @returns {{stopped:Object|null, dropped:number, resets:string[]}}
   */
  stopAll (why = '被 mc_stop 停止') {
    const stopped = this.current
    if (stopped) {
      try { stopped.controller?.abort() } catch { /* 已中止 */ }
      stopped.status = 'stopped'
      stopped.endedAt = Date.now()
      stopped.error = why
      this.current = null
      this.archive(stopped)
    }
    const dropped = this.queue.length
    for (const j of this.queue) { j.status = 'cancelled'; j.endedAt = Date.now(); j.error = why; this.archive(j) }
    this.queue = []
    const resets = []
    for (const [name, fn] of this.passiveResets) {
      try { fn(); resets.push(name) } catch (e) { this.log(`重置被动工具 ${name} 失败：${e?.message ?? e}`) }
    }
    this.state = 'idle'
    this.changed()
    this.log(`stop：停了 ${stopped?.id ?? '无'}，清掉 ${dropped} 个排队，重置 ${resets.length} 个被动工具`)
    this.dbg('⏹ mc_stop', `停掉 ${stopped ? `${stopped.id} [${stopped.kind}] ${stopped.summary}` : '（没有在跑的）'}`,
      `｜清掉排队 ${dropped} 个`, `｜重置被动工具 ${resets.length} 个`)
    return { stopped: stopped ? this.brief(stopped) : null, dropped, resets }
  }
  /** 给 agent 的完成报告（唯一推送口） */
  notify (job, text) {
    const body = [
      `【后台任务 ${job.id}】${text}`,
      '',
      '（异步跑的，你不用等；队列状态用 mc_probe {what:"jobs"}）',
    ].join('\n')
    let ok = false
    try { ok = Boolean(this.inject(job.agentId, body)) } catch (e) { this.log(`注入任务报告失败：${e?.message ?? e}`) }
    this.dbg('🔔 报告', job.id, ok ? '已投给 agent' : '**没投出去**（会话不在了？）', `｜${oneLine(text)}`)
    if (!ok) this.log(`任务 ${job.id} 的报告没能投给 agent（会话不在了？）：${text.slice(0, 80)}`)
  }
  archive (job) {
    this.done.unshift(job)
    if (this.done.length > this.keep) this.done.length = this.keep
  }
  changed () {
    try { this.onStateChange(this.snapshot()) } catch (e) { this.log(`队列状态回调失败：${e?.message ?? e}`) }
    /* 实时状态：每个生命周期节点（入队/开始/结束/清空/冻结）都推一次 ——
     * 文案没变 pushLive 自己会吞掉，所以这里无脑调就行。 */
    this.pushLive()
  }
}