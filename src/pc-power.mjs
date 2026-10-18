/**
 * 本机（Windows）定时关机 —— 给 AI 一个"真的能把电脑关掉"的最小工具面。
 *
 * 设计要点（2026-10-18 用户要求）：
 *   · **只在本机 Windows 上执行**，用的是系统自带命令，不引入依赖：
 *       shutdown /s /t <秒>   —— 交给 Windows 自己的定时器（**宿主进程退出也照样关**）
 *       shutdown /a           —— 取消
 *   · `execFile` 而不是 `exec`：参数逐个传，不经过 shell，避免任何拼接注入。
 *   · 长短都有闸：< 60 秒不给（给不了取消的机会），> 12 小时不给（多半是写错了）。
 *   · 状态落盘（`<DSH_HOME>/dsh-mc-agent/pc-shutdown.json`），只为"还剩多久 / 取消"能查、能对账；
 *     **不靠它来触发** —— 触发是 Windows 的定时器，插件重启不会丢。
 *   · `run` 可注入：测试里换成假的，绝不真的关机。
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveHarnessHome } from './format.mjs'

/** 最短：留够"发现不对还能取消"的时间 */
export const PC_MIN_SEC = 60
/** 最长：再长多半是算错了 */
export const PC_MAX_SEC = 12 * 60 * 60

/** 状态文件：`<DSH_HOME>/dsh-mc-agent/pc-shutdown.json` */
export function pcStateFile (home = resolveHarnessHome()) {
  return join(home, 'dsh-mc-agent', 'pc-shutdown.json')
}

/** 真的调用系统命令；返回 `{ ok, error }`，永不抛 */
function runSystem (cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { windowsHide: true, timeout: 15_000 }, (err) => {
        if (err) resolve({ ok: false, error: String(err.message ?? err) })
        else resolve({ ok: true })
      })
    } catch (e) {
      resolve({ ok: false, error: String(e?.message ?? e) })
    }
  })
}

/**
 * `"HH:MM"` ⇒ 距离**下一个**该时刻还有多少秒（今天已经过了就算明天）。
 * 解析不了返回 `null`。
 */
export function secUntilClock (at, now = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at ?? '').trim())
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) return null
  const d = new Date(now)
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0)
  if (target.getTime() <= now) target.setDate(target.getDate() + 1)
  return Math.max(1, Math.round((target.getTime() - now) / 1000))
}

/** 读状态文件（不存在 / 坏了都当没有） */
export function readShutdownState (home = resolveHarnessHome()) {
  const file = pcStateFile(home)
  try {
    if (!existsSync(file)) return null
    const o = JSON.parse(readFileSync(file, 'utf8'))
    return o && typeof o === 'object' ? o : null
  } catch {
    return null
  }
}

/**
 * 定时关机。
 * @param {{ afterSec?: number, at?: string, label?: string }} args  `afterSec` 与 `at` 二选一
 * @param {{ home?: string, platform?: string, run?: Function, now?: number }} opts
 */
export async function scheduleShutdown (args = {}, opts = {}) {
  const {
    home = resolveHarnessHome(),
    platform = process.platform,
    run = runSystem,
    now = Date.now()
  } = opts
  if (platform !== 'win32') {
    return { ok: false, error: `只支持 Windows 本机（当前 ${platform}）—— 没在这里实现别的系统的关机` }
  }
  const hasAfter = args.afterSec !== undefined && args.afterSec !== null && args.afterSec !== ''
  const hasAt = args.at !== undefined && args.at !== null && args.at !== ''
  if (!hasAfter && !hasAt) return { ok: false, error: '要给 afterSec（多少秒后）或 at（"HH:MM"）' }
  let sec = null
  if (hasAfter) {
    sec = Math.round(Number(args.afterSec))
    if (!Number.isFinite(sec)) return { ok: false, error: `afterSec 不是数字：${args.afterSec}` }
  } else {
    sec = secUntilClock(args.at, now)
    if (sec === null) return { ok: false, error: `at 要写成 "HH:MM"：${args.at}` }
  }
  if (sec < PC_MIN_SEC) return { ok: false, error: `至少 ${PC_MIN_SEC} 秒（现在给的是 ${sec}）—— 留点取消的时间` }
  if (sec > PC_MAX_SEC) return { ok: false, error: `最多 ${PC_MAX_SEC / 3600} 小时（现在给的是 ${Math.round(sec / 60)} 分钟）` }

  const r = await run('shutdown', ['/s', '/t', String(sec)])
  if (!r?.ok) return { ok: false, error: `系统没接受：${r?.error ?? '未知错误'}` }

  const state = {
    dueAt: now + sec * 1000,
    dueAtText: new Date(now + sec * 1000).toLocaleString('zh-CN'),
    sec,
    label: String(args.label ?? ''),
    by: 'mc_pc',
    at: new Date(now).toISOString()
  }
  try {
    mkdirSync(dirname(pcStateFile(home)), { recursive: true })
    writeFileSync(pcStateFile(home), JSON.stringify(state, null, 2) + '\n', 'utf8')
  } catch { /* 记不下就算了，关机是 Windows 那边排的 */ }
  return {
    ok: true,
    scheduled: true,
    dueAt: state.dueAt,
    dueAtText: state.dueAtText,
    remainingSec: sec,
    label: state.label,
    hint: `取消：mc_pc {action:"cancel"}；关机前 ${sec} 秒里随时能撤`
  }
}

/** 取消（`shutdown /a`）。没有排程也直接调，Windows 会回一句"没有关机计划"—— 照样算成功。 */
export async function cancelShutdown (opts = {}) {
  const { home = resolveHarnessHome(), platform = process.platform, run = runSystem } = opts
  if (platform !== 'win32') return { ok: false, error: `只支持 Windows 本机（当前 ${platform}）` }
  const before = readShutdownState(home)
  const r = await run('shutdown', ['/a'])
  try {
    if (existsSync(pcStateFile(home))) rmSync(pcStateFile(home))
  } catch { /* 删不掉也无所谓，下次排程会覆盖 */ }
  if (!r?.ok) {
    return {
      ok: false,
      error: `取消没成功：${r?.error ?? '未知错误'}`,
      ...(before ? { hadSchedule: before } : {})
    }
  }
  return { ok: true, cancelled: true, ...(before ? { was: { dueAtText: before.dueAtText, label: before.label } } : {}) }
}

/** 还剩多久。**以 Windows 的定时器为准，这里只是账本**。 */
export function shutdownStatus (opts = {}) {
  const { home = resolveHarnessHome(), now = Date.now() } = opts
  const st = readShutdownState(home)
  if (!st?.dueAt) return { scheduled: false }
  const left = Math.round((st.dueAt - now) / 1000)
  if (left <= 0) return { scheduled: false, expired: true, was: { dueAtText: st.dueAtText, label: st.label } }
  return { scheduled: true, remainingSec: left, dueAtText: st.dueAtText, label: st.label ?? '' }
}
