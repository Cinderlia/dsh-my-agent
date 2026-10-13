/**
 * src/task-runner.mjs —— **可恢复的任务状态机**（用户 2026-10-08 路线图第 ②③ 条）
 *
 * 要解决的问题（用户原话）：
 *   > 把"去找铁矿"拆成寻找洞穴、探索、发现矿石、抵达目标、换工具、挖掘、捡取、检查背包等阶段。
 *   > 任务有明确进度、失败原因和恢复入口，不必每次从头规划。
 *   > **任务进度不能只保存在 AI 的对话上下文里。**
 *
 * 所以这个模块只做三件事：
 *   ① **记住**：任务（`taskId` / `goal` / `phase` / `progress` / `checkpoint` / `lastError` / `status`）
 *      落到磁盘（`<记忆根>/tasks.json`）—— 掉线、重连、换一轮对话都还在；
 *   ② **分类**：把"失败"拆成 `no-tool` / `no-target` / `unreachable` / `server-refused` /
 *      `budget` / `timeout` / `preempted` / `full` / `aborted` / `unknown`，
 *      每种给出"下一步该干什么"（**超时不算失败**，只是"这一轮时间用完了"）；
 *   ③ **恢复**：`resume()` 用**现场状态**（背包里到底有多少）复核进度，再给出下一个具体动作 ——
 *      不是让模型从"找铁矿"重新规划一遍。
 *
 * 三条边界（写清楚免得以后越界）：
 *   - **不碰 mineflayer**：这个文件不 import 任何游戏库，现场状态由调用方（`src/core.mjs`）喂进来；
 *   - **不抢控制权**：移动编号（`#beginMove`）、控制位租约、11 秒预算、服务端破坏确认都还在 core 里，
 *     这里只记账，绝不下发动作；
 *   - **不猜**：背包数不出来就如实标 `verified: false`，不让"进度"变成假数据。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** 任务状态文件（放在记忆根里：按会话分，重连也在同一份） */
export const TASK_FILE = 'tasks.json'
/** 最多留多少个任务（活跃的永远留） */
export const TASK_KEEP = 24
/** 同一个动作 + 同一个原因连着失败几次 = 卡死了（用户要求"循环检测"） */
export const LOOP_LIMIT = 3
/** 历史条目上限（每个任务） */
export const HISTORY_KEEP = 40

export const STATUSES = ['running', 'waiting', 'paused', 'blocked', 'failed', 'done', 'cancelled']
/** "还在做"的状态（`current()` 只认这些） */
export const LIVE_STATUSES = ['running', 'waiting', 'paused', 'blocked']

/**
 * 失败分类表。`next` 是"下一步该干什么"，直接变成给模型的建议动作名。
 * 🔴 `budget` / `timeout` / `preempted` **都是 retryable**：它们不代表动作失败 ——
 *    11 秒到点时方块可能已经挖掉了，玩家插一句话也不代表任务黄了。
 */
export const FAIL_KINDS = {
  'no-tool': { retryable: false, next: 'craft-tool', hint: '背包里没有能用的工具 —— 先 mc_craft 一把（木镐 = 3 木板 + 2 木棍）再继续' },
  'no-target': { retryable: false, next: 'scan', hint: '附近找不到目标了 —— mc_scan / mc_move 换个方向或扩大范围，别在原地反复试' },
  unreachable: { retryable: true, next: 'move-closer', hint: '够不着 —— 先 mc_move 走到它旁边（3 格以内）再动手' },
  'server-refused': { retryable: true, next: 'reconnect', hint: '服务端没认这次动作（方块复原 / 没收到回包）—— 复核一次，连着两三次就 mc_connect {force:true} 重连刷新区块' },
  budget: { retryable: true, next: 'continue', hint: '这一轮的 11 秒用完了（**不是失败**）—— 用同样的参数再叫一次接着做' },
  timeout: { retryable: true, next: 'continue', hint: '超时了（**不等于没做成**：服务端可能已经执行）—— 先复核现场，再决定要不要重做' },
  preempted: { retryable: true, next: 'continue', hint: '被新的指令抢占了 —— 先把玩家要的事做完，再回来看这个任务' },
  full: { retryable: false, next: 'store', hint: '背包满了 —— 先 mc_chest 存一趟，或丢掉没用的' },
  aborted: { retryable: false, next: 'stop', hint: '被叫停了' },
  unknown: { retryable: true, next: 'continue', hint: '说不清为什么没成 —— 先复核现场（mc_observe / mc_inventory）再试' },
}

/** 分类用的判据表（顺序有意义：先匹配到的赢） */
const FAIL_RULES = [
  [/没有能挖|没有能用的工具|需要(一把)?(镐|斧|锹|锄|剑)|先 mc_craft|harvestable tool/i, 'no-tool'],
  [/附近找不到|未加载|找不到 (它|目标)|not loaded/i, 'no-target'],
  [/够不着|走过去也没走到|reach|out of range/i, 'unreachable'],
  [/复原|没收到服务端|服务端没认|还是 air|restored/i, 'server-refused'],
  [/这一轮的 11 秒|时间用完了|预算|budget|剩下的时间不够/i, 'budget'],
  [/超时|timed out|timeout/i, 'timeout'],
  [/抢占|打断|preempt|interrupt/i, 'preempted'],
  [/背包满|没有空位|emptySlot|inventory full/i, 'full'],
  [/叫停|取消|cancel|abort|终止/i, 'aborted'],
]

/**
 * 把一段错误（Error / 字符串 / 已有的 `{kind}`）分类成 `FAIL_KINDS` 里的某一项。
 * @returns {{kind:string, retryable:boolean, next:string, hint:string, reason:string}}
 */
export function classifyFailure (input) {
  const given = String(input?.kind ?? '').trim()
  const reason = String(input?.reason ?? input?.message ?? input ?? '').trim()
  let kind = given && FAIL_KINDS[given] ? given : null
  if (!kind) {
    for (const [re, k] of FAIL_RULES) { if (re.test(reason)) { kind = k; break } }
  }
  if (!kind) kind = 'unknown'
  return { kind, reason, ...FAIL_KINDS[kind] }
}

/** 任务 id：`t-<本地时间戳>-<序号>`，可读、可排序、不会撞 */
export function newTaskId (now = Date.now(), seq = 1) {
  const d = new Date(now)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `t-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(seq, 2)}`
}

/**
 * 方块 → 掉落物（**只用来复核进度**，认不出来就如实说"复核不了"）。
 * 不做全量表：minecraft-data 的 `block.drops` 在运行时才拿得到，这里是离线兜底。
 */
export const DROP_OF = {
  oak_log: 'oak_log', birch_log: 'birch_log', spruce_log: 'spruce_log', jungle_log: 'jungle_log',
  acacia_log: 'acacia_log', dark_oak_log: 'dark_oak_log', mangrove_log: 'mangrove_log',
  cherry_log: 'cherry_log', pale_oak_log: 'pale_oak_log', bamboo_block: 'bamboo',
  stone: 'cobblestone', cobblestone: 'cobblestone', deepslate: 'cobbled_deepslate',
  dirt: 'dirt', grass_block: 'dirt', sand: 'sand', red_sand: 'red_sand', gravel: 'gravel',
  clay: 'clay_ball', coal_ore: 'coal', deepslate_coal_ore: 'coal',
  iron_ore: 'raw_iron', deepslate_iron_ore: 'raw_iron',
  copper_ore: 'raw_copper', deepslate_copper_ore: 'raw_copper',
  gold_ore: 'raw_gold', deepslate_gold_ore: 'raw_gold',
  diamond_ore: 'diamond', deepslate_diamond_ore: 'diamond',
  emerald_ore: 'emerald', deepslate_emerald_ore: 'emerald',
  lapis_ore: 'lapis_lazuli', deepslate_lapis_ore: 'lapis_lazuli',
  redstone_ore: 'redstone', deepslate_redstone_ore: 'redstone',
  nether_quartz_ore: 'quartz', nether_gold_ore: 'gold_nugget',
  ancient_debris: 'ancient_debris', obsidian: 'obsidian',
  wheat: 'wheat', carrot: 'carrot', potato: 'potato', beetroot: 'beetroot',
  sugar_cane: 'sugar_cane', bamboo: 'bamboo', kelp: 'kelp', seagrass: 'seagrass',
  snow_block: 'snowball', snow: 'snowball', ice: 'ice', packed_ice: 'packed_ice',
  glowstone: 'glowstone_dust', melon: 'melon_slice', pumpkin: 'pumpkin',
  sweet_berry_bush: 'sweet_berries', vine: 'vine', mushroom: 'mushroom',
}

/** 方块名 → 掉落物名（认不出来返回 null，**不要瞎猜**） */
export function dropOf (blockName) {
  const n = String(blockName ?? '').trim().toLowerCase()
  if (!n) return null
  if (DROP_OF[n]) return DROP_OF[n]
  /* 没登记的一律 null。以前这里想"`xx_ore` / `xx_log` 按同名赌一把"，但赌错更糟：
   * 复核进度时把"背包里有 0 个 xx_ore"当成"没挖到"，会把已经挖到的活儿判成没干完。
   * 认不出来就如实说"复核不了"（`resume()` 里 `verified:false`）。 */
  return null
}

/** 一行摘要，给人看（也进工具输出） */
export function taskLine (t) {
  if (!t) return '（没有任务）'
  const p = t.progress ?? {}
  const prog = p.total != null ? `${p.done ?? 0}/${p.total}` : String(p.done ?? 0)
  const st = { running: '进行中', waiting: '等条件', paused: '暂停', blocked: '卡住了', failed: '失败', done: '完成', cancelled: '取消' }[t.status] ?? t.status
  const err = t.lastError ? ` · 上次卡在：${t.lastError.kind}${t.lastError.reason ? `（${String(t.lastError.reason).slice(0, 60)}）` : ''}` : ''
  return `${t.taskId} · ${t.kind} · ${t.goal ?? t.params?.item ?? ''} · ${prog}${p.unit ?? ''} · ${st}${err}`
}

/** 给工具返回用的紧凑对象（不塞历史） */
export function taskBrief (t) {
  if (!t) return null
  return {
    taskId: t.taskId, kind: t.kind, goal: t.goal, phase: t.phase, status: t.status,
    progress: t.progress, lastError: t.lastError, loopDetected: t.loopDetected ?? null,
    checkpoint: t.checkpoint ?? null, updatedAt: t.updatedAt, startedAt: t.startedAt,
  }
}

/* ─────────────── 三种结局：已确认成功 / 动作失败 / 结果未知（路线图第 ⑥ 条） ───────────────
 * 用户 2026-10-08 路线图："统一任务取消/超时/重连/恢复，区分'动作失败''结果未知''已确认成功'"。
 *
 * 为什么必须分开：**时间到了 ≠ 没做成**。`mc_dig` 被 11 秒预算截断时，那一镐可能已经挖下去了；
 * `mc_move` 被抢占时，人可能已经挪了两格。把"未知"当成"失败"会让 AI 重做（浪费一轮、
 * 甚至把刚放好的方块再挖掉），当成"成功"又会让它以为东西到手了。所以只认**证据**：
 *   · confirmed —— 有服务端/世界状态的证据（那格变 air 且服务端回包确认、placed>0、arrived、killed…）
 *   · failed    —— 明确被拒/明确没做成（没有工具、够不着、服务端复原、NoPath…）
 *   · unknown   —— 时间到/被抢占/超时，读不到证据（**服务器可能已经做了**）
 */
export const OUTCOMES = ['confirmed', 'failed', 'unknown']
export const OUTCOME_LABEL = { confirmed: '已确认成功', failed: '动作失败', unknown: '结果未知' }

/** 把一个动作的返回值判成三种结局之一（判不出就如实说 unknown，绝不硬判成成功） */
export function outcomeOf (res, { expect = null } = {}) {
  const r = res ?? {}
  const s = (x) => String(x ?? '')
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null)
  const blob = `${s(r.error)} ${s(r.reason)} ${s(r.note)} ${s(r.why)} ${s(r.hint)}`

  // ① 明确失败：被拒 / 够不着 / 服务端复原 / 路不通
  if (r.restored === true) return 'failed'
  if (r.broken === false && r.refused === true) return 'failed'
  if (r.placed === 0 && r.refused === true) return 'failed'
  if (/复原|够不着|没有能挖|不在线|NoPath|unreachable|refused|拒绝|缺少|先 mc_craft/i.test(blob)) return 'failed'

  // ② 明确成功：有证据
  if (Array.isArray(r.dug) && r.dug.length > 0) return 'confirmed'
  if (num(r.dug) > 0 || num(r.placed) > 0 || num(r.got) > 0) return 'confirmed'
  if (r.broken === true || r.arrived === true || r.killed === true || r.done === true || r.ok === true) return 'confirmed'

  // ③ 时间到 / 被抢占 / 超时 → 结果未知（不是失败）
  if (r.mcTimeout === true || r.cutByCall === true || r.preempted === true) return 'unknown'
  if (/budget|timeout|preempted|时间不够|用完了|被打断|抢占/i.test(blob + ' ' + s(r.status))) return 'unknown'

  if (expect != null && num(r[expect]) === 0) return 'failed'
  return 'unknown'
}

/** 结局的统一文案（附在动作输出末尾，让模型不用猜） */
export function verdictText (outcome, detail = null) {
  const label = OUTCOME_LABEL[outcome] ?? outcome
  const tail = detail ? `（${detail}）` : ''
  if (outcome === 'confirmed') return `✅ ${label}${tail}`
  if (outcome === 'failed') return `❌ ${label}${tail}`
  return `❓ ${label}${tail} —— 时间到了/被打断，但**服务器可能已经做了**：先看一眼`
    + '（`mc_observe` / `mc_inventory` / `mc_status`）再决定，别直接重做。'
}


/**
 * 任务状态机。一个 `McBot` 一个实例；文件是 `<记忆根>/tasks.json`。
 *
 * 用法（`src/core.mjs` 里）：
 *   const t = this.tasks.auto({ kind: 'dig', item: 'oak_log', total: 16 })
 *   this.tasks.progress(t.taskId, { add: 1 })
 *   this.tasks.fail(t.taskId, { action: 'dig', reason: '...' })
 *   this.tasks.resume(null, { countOf: (name) => this.#countOf(name) })
 */
export class TaskRunner {
  constructor ({ file = null, now = () => Date.now(), log = () => {} } = {}) {
    this.now = now
    this.log = log
    this.file = null
    this.data = { version: 1, seq: 0, tasks: [] }
    this.loaded = false
    if (file) this.setFile(file)
  }

  /** 换文件（index.js 每次工具调用都会喂一次记忆根；路径没变就是空操作） */
  setFile (file) {
    const f = file ? String(file) : null
    if (f === this.file) return this
    this.file = f
    this.loaded = false
    return this
  }

  /* ── 落盘 ── */

  #load () {
    if (this.loaded) return this.data
    this.loaded = true
    if (!this.file) return this.data
    try {
      if (!existsSync(this.file)) return this.data
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      if (raw && Array.isArray(raw.tasks)) this.data = { version: 1, seq: Number(raw.seq ?? 0) || 0, tasks: raw.tasks }
    } catch (e) {
      // 文件坏了不能让整个插件崩：留一条日志，从空任务表开始
      this.log(`任务文件读不了（${String(e?.message ?? e).slice(0, 80)}）—— 从空表开始：${this.file}`)
      this.data = { version: 1, seq: 0, tasks: [] }
    }
    return this.data
  }

  save () {
    if (!this.file) return false
    try {
      const d = dirname(this.file)
      if (!existsSync(d)) mkdirSync(d, { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8')
      renameSync(tmp, this.file)      // 原子替换：写到一半掉线也不会留半截 JSON
      return true
    } catch (e) {
      this.log(`任务文件写不进去：${String(e?.message ?? e).slice(0, 120)}`)
      return false
    }
  }

  /** 只留最近 `TASK_KEEP` 个（活跃的一个都不丢） */
  #prune () {
    const d = this.#load()
    if (d.tasks.length <= TASK_KEEP) return
    const live = d.tasks.filter((t) => LIVE_STATUSES.includes(t.status))
    const dead = d.tasks.filter((t) => !LIVE_STATUSES.includes(t.status))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    d.tasks = [...live, ...dead.slice(0, Math.max(0, TASK_KEEP - live.length))]
  }

  /* ── 查 ── */

  list ({ limit = 10, all = false } = {}) {
    const d = this.#load()
    const arr = all ? [...d.tasks] : d.tasks.filter((t) => LIVE_STATUSES.includes(t.status))
    return arr.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, Math.max(1, Number(limit) || 10))
  }

  /** 最近一个"还在做"的任务（`mc_dig` 靠它把进度接到同一个任务上） */
  current () { return this.list({ limit: 1 })[0] ?? null }

  get (taskId) {
    const d = this.#load()
    const id = String(taskId ?? '').trim()
    if (!id) return null
    return d.tasks.find((t) => t.taskId === id) ?? null
  }

  /* ── 写 ── */

  start ({ kind = 'task', goal = null, item = null, total = null, unit = '个', params = {}, meta = {}, phase = 'planning' } = {}) {
    const d = this.#load()
    const now = this.now()
    const t = {
      taskId: newTaskId(now, ++d.seq),
      kind, goal: goal ?? (item ? `${kind} ${item}` : kind), phase,
      progress: { done: 0, total: total == null ? null : Number(total), unit },
      checkpoint: null, lastError: null, loopDetected: null,
      status: 'running', params: { ...params, item: item ?? params.item ?? null },
      attempts: {}, history: [], meta: { ...meta },
      startedAt: now, updatedAt: now,
    }
    d.tasks.push(t)
    this.note(t.taskId, `开工：${t.goal}${t.progress.total != null ? `（目标 ${t.progress.total}${unit}）` : ''}`, { save: false })
    this.#prune()
    this.save()
    this.log(`任务开工 ${taskLine(t)}`)
    return t
  }

  /** 找到匹配的活跃任务就接着用，否则新建 —— `mc_dig` 的"同一件事接着做"就靠这个 */
  auto ({ kind, item = null, total = null, params = {} } = {}) {
    /* 🔴 找的是"**同一件事**的活跃任务"，不是"最近那个活跃任务"：
     *    挖原木挖到一半跑去挖石头，原木那条任务仍然算数 —— 回头再挖原木应该接着它，
     *    而不是又开一条新任务（否则任务表里会堆一串同名任务，进度也各自从 0 开始）。 */
    const d = this.#load()
    const cur = d.tasks
      .filter((t) => LIVE_STATUSES.includes(t.status) && t.kind === kind && (item == null || t.params?.item === item))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? null
    if (cur) {
      cur.updatedAt = this.now()
      if (total != null) cur.progress.total = Number(total)
      /* 又叫了一次 = 人还在管这件事：从"卡住/暂停/等条件"回到"进行中" */
      cur.status = 'running'
      this.save()
      return cur
    }
    return this.start({ kind, item, total, params })
  }

  touch (taskId, patch = {}) {
    const t = this.get(taskId)
    if (!t) return null
    Object.assign(t, patch, { updatedAt: this.now() })
    this.save()
    return t
  }

  progress (taskId, { add = 0, done = null, total = null, note = null } = {}) {
    const t = this.get(taskId)
    if (!t) return null
    if (done != null) t.progress.done = Math.max(0, Number(done) || 0)
    if (add) t.progress.done = Math.max(0, (Number(t.progress.done) || 0) + Number(add))
    if (total != null) t.progress.total = Number(total)
    if (t.progress.total != null && t.progress.done > t.progress.total) t.progress.done = t.progress.total
    t.updatedAt = this.now()
    if (note) this.note(taskId, note, { save: false })
    if (t.progress.total != null && t.progress.done >= t.progress.total) {
      t.status = 'done'; t.endedAt = t.updatedAt; t.phase = 'done'
      this.note(taskId, '目标达成', { save: false })
      this.log(`任务完成 ${taskLine(t)}`)
    }
    this.save()
    return t
  }

  /** 记一次检查点：位置 + 背包 + 正在盯的目标（重连后靠它判断"我在哪一步"） */
  checkpoint (taskId, extra = {}) {
    const t = this.get(taskId)
    if (!t) return null
    t.checkpoint = { at: this.now(), ...(t.checkpoint ?? {}), ...extra }
    t.updatedAt = t.checkpoint.at
    this.save()
    return t.checkpoint
  }

  /** 记一次失败：分类 + 循环检测（同一动作同一原因连着 3 次 ⇒ `blocked`） */
  fail (taskId, { action = null, reason = null, kind = null, detail = null } = {}) {
    const t = this.get(taskId)
    if (!t) return null
    const c = classifyFailure({ kind, reason })
    const now = this.now()
    t.lastError = { kind: c.kind, reason: c.reason || c.hint, detail: detail ?? null, action: action ?? null, at: now, retryable: c.retryable }
    /* 🔴 "这一轮时间用完了 / 超时 / 被抢占"**不进循环检测**：一个长活儿跑三轮很正常，
     *    把它们算成"同一个动作连着失败 3 次"会让任务莫名其妙变成"卡住"（假警报）。
     *    真正的失败（够不着 / 服务端不认 / 没工具 / 找不到目标）才计数。 */
    const counted = !['budget', 'timeout', 'preempted'].includes(c.kind)
    const key = `${action ?? 'action'}:${c.kind}`
    if (counted) {
      const a = (t.attempts[key] ??= { count: 0, lastReason: null, firstAt: now })
      if (a.lastReason === c.reason) a.count += 1
      else { a.lastReason = c.reason; a.count = 1 }
      a.at = now
      if (a.count >= LOOP_LIMIT) {
        t.loopDetected = { key, count: a.count, reason: c.reason, at: now }
        t.status = 'blocked'
        this.note(taskId, `同一个动作（${key}）连着失败 ${a.count} 次 ⇒ 停下来等指示`, { save: false })
        this.log(`任务卡住 ${taskLine(t)}`)
      } else if (t.status === 'running') {
        t.status = c.retryable ? 'running' : 'waiting'
      }
    } else {
      t.attempts[key] = { count: 1, lastReason: c.reason, firstAt: now, at: now, uncounted: true }
      if (t.status === 'blocked') t.status = 'running'    // 时间不够不是"卡住"，别让任务一直挂在 blocked
    }
    t.updatedAt = now
    this.save()
    return { task: t, ...c }
  }

  note (taskId, text, { save = true } = {}) {
    const t = this.get(taskId)
    if (!t) return null
    t.history = [...(t.history ?? []), { at: this.now(), text: String(text).slice(0, 300) }].slice(-HISTORY_KEEP)
    t.updatedAt = this.now()
    if (save) this.save()
    return t
  }

  /** 被抢占 / 等条件：**不是失败**，进度留着 */
  pause (taskId, why = '被新的指令抢占') {
    const t = this.get(taskId)
    if (!t || t.status === 'done') return t
    t.status = 'paused'
    t.pauseReason = String(why)
    this.note(taskId, `暂停：${why}`, { save: false })
    t.updatedAt = this.now()
    this.save()
    return t
  }

  /** 等条件（缺工具、背包满）：AI 处理完外部条件回来就能接着做 */
  wait (taskId, why = '等条件') {
    const t = this.get(taskId)
    if (!t || t.status === 'done') return t
    t.status = 'waiting'
    t.pauseReason = String(why)
    this.note(taskId, `等条件：${why}`, { save: false })
    t.updatedAt = this.now()
    this.save()
    return t
  }

  finish (taskId, { ok = true, note = null } = {}) {
    const t = this.get(taskId)
    if (!t) return t
    t.status = ok ? 'done' : 'failed'
    t.phase = ok ? 'done' : 'failed'
    t.endedAt = this.now()
    t.updatedAt = t.endedAt
    if (note) this.note(taskId, note, { save: false })
    this.log(`任务${ok ? '完成' : '失败'} ${taskLine(t)}`)
    this.save()
    return t
  }

  cancel (taskId, why = '取消') {
    const t = this.get(taskId)
    if (!t) return t
    t.status = 'cancelled'
    t.endedAt = this.now()
    t.updatedAt = t.endedAt
    this.note(taskId, `取消：${why}`, { save: false })
    this.save()
    return t
  }

  forget (taskId) {
    const d = this.#load()
    const before = d.tasks.length
    d.tasks = d.tasks.filter((t) => t.taskId !== String(taskId))
    if (d.tasks.length !== before) this.save()
    return before - d.tasks.length
  }

  /* ── 恢复 ── */

  /**
   * 用**现场状态**复核进度，给出下一个具体动作。
   *
   * 🔴 这里的关键是**不重新规划**：任务还是那个任务、目标还是那个目标，
   *    只把"还剩多少 / 上次卡在哪 / 下一步该调哪个工具"算出来。
   *
   * @param {string|null} taskId 不给就用最近一个活跃任务
   * @param {{countOf?: (item:string)=>number|null}} opts 现场状态：背包里某样东西有几个
   */
  resume (taskId = null, { countOf = null } = {}) {
    const t = taskId ? this.get(taskId) : this.current()
    if (!t) return { ok: false, reason: '没有可以恢复的任务', next: 'start', task: null }
    if (t.status === 'done') return { ok: true, done: true, next: 'done', task: taskBrief(t), note: '这个任务已经完成了' }
    if (t.status === 'cancelled') return { ok: false, reason: '这个任务已经被取消', next: 'start', task: taskBrief(t) }

    const item = t.params?.item ?? null
    const total = t.progress?.total ?? null
    let have = Number(t.progress?.done ?? 0)
    let verified = false
    let verifyNote = null
    if (countOf && item) {
      try {
        const c = countOf(item)
        if (c != null && Number.isFinite(Number(c))) { have = Number(c); verified = true }
        else verifyNote = `背包里数不出 ${item}（认不出掉落物），进度按记录算`
      } catch { verifyNote = '读背包出错，进度按记录算' }
    } else if (item) verifyNote = '这次没给现场状态，进度按记录算'

    const need = total == null ? null : Math.max(0, total - have)
    const le = t.lastError
    const cls = le ? (FAIL_KINDS[le.kind] ?? FAIL_KINDS.unknown) : null
    const next = need === 0 && total != null ? 'done' : (cls?.next ?? 'continue')

    return {
      ok: true, task: taskBrief(t), have, need, verified, verifyNote,
      next, hint: cls?.hint ?? '接着做（用同样的参数再叫一次就好）',
      action: suggestAction(t, need),
      loopDetected: t.loopDetected ?? null,
    }
  }
}

/** 由任务推出"下一个具体动作"（只是**建议**，下不下发由模型决定） */
export function suggestAction (t, need = null) {
  const item = t?.params?.item ?? null
  if (!item) return null
  const n = need == null ? null : Math.max(1, Number(need))
  switch (t.kind) {
    case 'dig':
      return { tool: 'mc_dig', args: { name: item, count: n ?? 8, maxDistance: t.params?.maxDistance ?? 16 } }
    case 'craft':
      return { tool: 'mc_craft', args: { name: item, ...(n ? { times: n } : {}) } }
    case 'smelt':
      return { tool: 'mc_furnace', args: { name: item, ...(n ? { count: n } : {}) } }
    case 'chest':
      return { tool: 'mc_chest', args: { ...(t.params?.chest ? { chest: t.params.chest } : {}) } }
    case 'move':
      return { tool: 'mc_move', args: { ...(t.params?.to ? { x: t.params.to.x, y: t.params.to.y, z: t.params.to.z } : {}) } }
    default:
      return null
  }
}
