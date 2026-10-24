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

/** 介入冷却：两次介入之间至少要隔这么久（用户 2026-10-24：「介入模式加个冷却时间」） */
export const INTERRUPT_COOLDOWN_MS = 60_000

let seq = 0
const nextId = () => `job-${Date.now().toString(36)}-${(++seq).toString(36)}`

export class JobBoard {
  /**
   * @param {Object} deps
   * @param {Function} deps.inject        (agentId, text) => boolean
   * @param {Function} [deps.log]
   * @param {Function} [deps.onStateChange] (snapshot) => void  队列状态变了（宿主据此收窄/恢复工具面）
   * @param {number}   [deps.keep]
   */
  constructor ({ inject, log = null, onStateChange = null, keep = 20, interruptCooldownMs = INTERRUPT_COOLDOWN_MS } = {}) {
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
    return { id: j.id, kind: j.kind, summary: j.summary, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt }
  }

  /**
   * 入队并（可能）立刻开始。**立刻返回**，不等执行。
   * @param {Object} spec {kind, agentId, summary, plan, run(signal, job)=>Promise<{text,data}>}
   * @returns {{ok:true, job, position:number, started:boolean} | {ok:false, why:string, current:Object|null}}
   */
  enqueue ({ kind, agentId, summary, plan = null, run }) {
    if (this.state === 'intervening') {
      return { ok: false, why: '队列正在被介入（agent 正在处理队首任务），先 mc_interrupt 选一个动作再继续', current: this.current ? this.brief(this.current) : null }
    }
    const job = this.makeJob({ kind, agentId, summary, plan, run })
    this.queue.push(job)
    const wasIdle = !this.current && this.state === 'idle'
    this.log(`任务 ${job.id} 入队（第 ${this.queue.length} 位）：${job.summary}`)
    if (wasIdle) this.pump()
    this.changed()
    return { ok: true, job, position: this.queue.indexOf(job) + (this.current ? 1 : 0), started: this.current === job }
  }

/** 造一个任务对象（enqueue / yieldFor 共用） */
  makeJob ({ kind, agentId, summary, plan = null, run = null, state = undefined }) {
    return {
      id: nextId(),
      kind: String(kind ?? 'job'),
      agentId: agentId ? String(agentId) : null,
      summary: String(summary ?? ''),
      plan,
      status: 'queued',
      startedAt: null,
      endedAt: null,
      report: null,
      error: null,
      state,
      run: typeof run === 'function' ? run : null,
      controller: typeof AbortController === 'function' ? new AbortController() : null,
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
    job.status = 'waiting'
    job.waitingOn = child.id
    this.current = null
    /* unshift 顺序：先放自己、再放子任务 ⇒ 子任务在前，自己在后 */
    this.queue.unshift(job)
    this.queue.unshift(child)
    this.state = 'running'
    this.log(`任务 ${job.id} 挂起，插入子任务 ${child.id}（${child.summary}）`)
    this.changed()
    this.pump()
    return true
  }

  /** 队列推进：没在跑的、没冻结的、有排队的 → 启动下一个 */
  pump () {
    if (this.current || this.state === 'frozen' || this.state === 'intervening') return
    const job = this.queue.shift()
    if (!job) { this.state = 'idle'; this.changed(); return }
    this.current = job
    this.state = 'running'
    job.status = 'running'
    /* 🔴 只在**第一次**开始记时间：任务被 yieldFor 挂起后再恢复时，
     *    这里会把 startedAt 冲掉，最终报告就变成"0.2 秒"（实测踩过）。 */
    if (!job.startedAt) job.startedAt = Date.now()
    this.changed()
    this.log(`任务 ${job.id} 开始：${job.summary}`)
    Promise.resolve()
      .then(() => (job.run ?? (() => { throw new Error('没有可执行体') }))(job.controller?.signal, job))
      .then((r) => this.finish(job.id, r ?? {}))
      .catch((e) => this.fail(job.id, e))
  }

  get (id) { return [this.current, ...this.queue, ...this.done].find((j) => j?.id === String(id ?? '')) ?? null }

  finish (id, { text = '', data = null } = {}) {
    const job = this.current
    if (!job || job.id !== String(id)) return false
    job.status = 'done'
    job.endedAt = Date.now()
    job.report = { text: String(text), data }
    this.current = null
    this.archive(job)
    this.notify(job, `✅ ${job.summary}\n${job.report.text}`)
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
    this.current = null
    this.archive(job)
    this.notify(job, `❌ ${job.summary} 失败：${job.error}`)
    this.state = 'idle'
    this.pump()
    this.changed()
    return true
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
    if (!ok) this.log(`任务 ${job.id} 的报告没能投给 agent（会话不在了？）：${text.slice(0, 80)}`)
  }

  archive (job) {
    this.done.unshift(job)
    if (this.done.length > this.keep) this.done.length = this.keep
  }

  changed () {
    try { this.onStateChange(this.snapshot()) } catch (e) { this.log(`队列状态回调失败：${e?.message ?? e}`) }
  }
}
