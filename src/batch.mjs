/* ============================================================================
 * batch —— **批处理**：一次挖一列 / 搭一行 / 搭一面墙（用户 2026-10-24）
 * ----------------------------------------------------------------------------
 * 解决的是"别让 LLM 一个方块一个方块地叫工具"：
 *   · 挖：`mode:"column"`（往下 depth 格）/ `mode:"line"`（沿 dir 走 length 格）
 *   · 放：`mode:"line"`（搭一行）/ `mode:"wall"`（一面墙）/ `mode:"block"`（单格）
 *
 * 两条用户定的规矩，这里统一处理（调用方不用管、也不用告诉 LLM）：
 *   ① 目标超出**触及范围**（4.2 格）→ **本地自动 navi 过去**再挖/放；
 *   ② 目标超出**半径 16 格** → 直接失败，报原因并建议"重新确认坐标或先移动"。
 *
 * 预算：一次调用最多干 10 秒（和别的工具同一套 CALL_MS），到点带进度返回，
 *       返回里的 `remaining` 是还没处理的坐标，再叫一次从它接着做。
 * ========================================================================== */
import Vec3 from 'vec3'

/** 触及距离（再远就得先走过去） */
export const BATCH_REACH = 4.2
/** 用户定的半径上限 */
export const BATCH_RADIUS = 16

const DIR_VEC = {
  north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0],
  n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0],
}

const int = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/**
 * 把参数翻译成一串坐标。
 * @returns {{ok:true, targets:Array<{x,y,z}>} | {ok:false, why:string}}
 */
export function buildTargets (args = {}) {
  const mode = String(args.mode ?? 'block').toLowerCase()
  const x = int(args.x); const y = int(args.y); const z = int(args.z)
  if (x === null || y === null || z === null) return { ok: false, why: '要给起点坐标 x/y/z' }

  if (mode === 'block') return { ok: true, targets: [{ x, y, z }] }

  if (mode === 'column') {
    const depth = Math.max(1, Math.min(int(args.depth ?? args.count ?? 4) ?? 4, 32))
    const down = args.up === true ? -1 : 1   // 默认往下挖
    const out = []
    for (let i = 0; i < depth; i++) out.push({ x, y: y - i * down, z })
    return { ok: true, targets: out }
  }

  if (mode === 'line') {
    const len = Math.max(1, Math.min(int(args.length ?? args.count ?? 4) ?? 4, 32))
    const dir = DIR_VEC[String(args.dir ?? 'east').toLowerCase()]
    if (!dir) return { ok: false, why: `dir 只能是 north/south/west/east（收到 ${args.dir}）` }
    const vertical = args.vertical === true
    const out = []
    for (let i = 0; i < len; i++) {
      out.push(vertical ? { x, y: y + i, z } : { x: x + dir[0] * i, y, z: z + dir[1] * i })
    }
    return { ok: true, targets: out }
  }

  if (mode === 'wall') {
    /* 一面墙：给另一角 x2/z2（和可选 y2），在这两个角之间铺一个**竖直**矩形。 */
    const x2 = int(args.x2); const z2 = int(args.z2)
    const y2 = int(args.y2)
    if (x2 === null || z2 === null) return { ok: false, why: '搭墙要给另一角 x2/z2（或者用 line 搭一行）' }
    const height = Math.max(1, Math.min(int(args.height ?? (y2 !== null ? Math.abs(y2 - y) + 1 : 3)) ?? 3, 32))
    const out = []
    const dx = Math.sign(x2 - x); const dz = Math.sign(z2 - z)
    const nx = Math.abs(x2 - x) + 1; const nz = Math.abs(z2 - z) + 1
    if (dx !== 0 && dz !== 0) return { ok: false, why: '墙只能是直的（x 或 z 一个方向），斜墙请分两次' }
    const count = dx !== 0 ? nx : nz
    const up = (y2 !== null && y2 < y) ? -1 : 1   // 默认**往上盖**；给了更低的 y2 才往下
    for (let h = 0; h < height; h++) {
      for (let i = 0; i < count; i++) {
        out.push({ x: x + dx * i, y: y + up * h, z: z + dz * i })
      }
    }
    return { ok: true, targets: out }
  }

  if (mode === 'volume') {
    const x2 = int(args.x2); const y2 = int(args.y2); const z2 = int(args.z2)
    if ([x2, y2, z2].some((v) => v === null)) return { ok: false, why: 'volume 要给另一角 x2/y2/z2' }
    const out = []
    for (let ix = Math.min(x, x2); ix <= Math.max(x, x2); ix++) {
      for (let iy = Math.min(y, y2); iy <= Math.max(y, y2); iy++) {
        for (let iz = Math.min(z, z2); iz <= Math.max(z, z2); iz++) out.push({ x: ix, y: iy, z: iz })
      }
    }
    if (out.length > 4096) return { ok: false, why: `体积太大（${out.length} 格 > 4096）` }
    return { ok: true, targets: out }
  }

  return { ok: false, why: `未知 mode "${mode}"（block / column / line / wall / volume）` }
}

/** 半径检查：任何一个目标离我超过 16 格就整单拒绝（用户要求） */
export function checkRange (b, targets, radius = BATCH_RADIUS) {
  const me = b?.entity?.position
  if (!me) return { ok: false, why: '我还没有位置（没连上/区块没加载完）' }
  const far = targets.filter((t) => Math.hypot(t.x + 0.5 - me.x, t.y - me.y, t.z + 0.5 - me.z) > radius)
  if (far.length) {
    const t = far[0]
    return {
      ok: false,
      why: `${far.length} 个目标超出 ${radius} 格（例如 ${t.x},${t.y},${t.z}，距我 ${Math.hypot(t.x + 0.5 - me.x, t.y - me.y, t.z + 0.5 - me.z).toFixed(1)} 格）`
        + ' —— 请重新确认坐标，或先移动/导航到附近再试',
      far: far.slice(0, 5),
    }
  }
  return { ok: true }
}

/** 走到某个坐标附近（用调用方给的 Goals；失败返回原因，不抛） */
export async function walkNear (b, Goals, x, y, z, { timeoutMs = 25_000, range = 2.5 } = {}) {
  const pf = b?.pathfinder
  if (!pf || !Goals?.GoalNear) return { ok: false, why: '没有可用的 pathfinder（装 mineflayer-pathfinder）' }
  try {
    await Promise.race([
      pf.goto(new Goals.GoalNear(new Vec3(x, y, z), range)),
      new Promise((_, rej) => setTimeout(() => { try { pf.stop?.() } catch {} ; rej(new Error('走过去超时')) }, timeoutMs)),
    ])
    return { ok: true }
  } catch (e) {
    return { ok: false, why: e.message }
  }
}

/** 需要走过去吗（按第一个目标判） */
export function needsWalk (b, target) {
  const me = b?.entity?.position
  if (!me) return true
  return Math.hypot(target.x + 0.5 - me.x, target.y - me.y, target.z + 0.5 - me.z) > BATCH_REACH
}

/**
 * 逐格执行（挖或放）。到 deadline 就停，返回进度。
 * @param {(t) => Promise<any>} runOne 单个坐标的执行器（返回 {ok, why})
 */
export async function runBatch (targets, runOne, { deadline = Date.now() + 10_000, signal = null, log = () => {}, ensureNear = null } = {}) {
  const done = []
  const failed = []
  const skipped = []
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    if (signal?.aborted) { skipped.push(...targets.slice(i)); break }
    if (Date.now() >= deadline) { skipped.push(...targets.slice(i)); break }
    /* 🔴 每格之前都确认够得着：一行的后几格、一面墙的上层，光靠"开局走一次"到不了
     *    （实测：放一行 4 格，第 4 格报"眼睛到方块中心 5.1 格，够不着"）。
     *    `ensureNear` 由调用方给（内部用 pathfinder 走过去）。 */
    if (typeof ensureNear === 'function') {
      try {
        const near = await ensureNear(t)
        if (near && near.ok === false) { failed.push({ ...t, why: near.why ?? '走不过去' }); continue }
      } catch (e) {
        failed.push({ ...t, why: `走过去失败：${e?.message ?? e}` })
        continue
      }
    }
    try {
      const r = await runOne(t)
      if (r && r.ok === false) failed.push({ ...t, why: r.why ?? '失败' })
      else done.push(t)
    } catch (e) {
      failed.push({ ...t, why: e?.message ?? String(e) })
    }
  }
  return { done, failed, skipped }
}

/** 一句话进度（统一给两个工具用） */
export function batchText (verb, { done, failed, skipped }, total) {
  const lines = []
  lines.push(`${verb}完成 ${done.length}/${total}${failed.length ? `，失败 ${failed.length}` : ''}${skipped.length ? `，剩 ${skipped.length} 个没轮到` : ''}`)
  if (failed.length) lines.push('失败：' + failed.slice(0, 4).map((f) => `(${f.x},${f.y},${f.z}) ${f.why}`).join('；'))
  if (skipped.length) {
    const n = skipped[0]
    lines.push(`⏳ 这一轮的时间用完了 —— 再叫一次，从 (${n.x},${n.y},${n.z}) 接着做（已经做过的不必重发）`)
  }
  return lines.join('\n')
}
