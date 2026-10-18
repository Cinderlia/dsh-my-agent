#!/usr/bin/env node
/**
 * check-pc-power —— `mc_pc`（本机定时关机）的假命令断言。
 *
 * 绝不真的关机：所有用例都注入假 `run`，只看"发给系统的命令对不对、闸门有没有拦住"。
 *   node tools/check-pc-power.mjs
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
let pass = 0
let fail = 0
const ok = (c, label, extra) => { if (c) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? `\n     ${extra}` : ''}`) } }
const section = (t) => console.log(`\n${t}`)

const pp = await import(new URL('../src/pc-power.mjs', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'pc-power-'))
const calls = []
const fakeRun = async (cmd, args) => { calls.push([cmd, arg_ok(args)]) ; return { ok: true } }
const arg_ok = (a) => a
const boomRun = async () => ({ ok: false, error: 'Access is denied.' })

section('① 定时排上：命令、账本、剩余秒数')
{
  calls.length = 0
  const now = Date.parse('2026-10-18T20:00:00+08:00')
  const r = await pp.scheduleShutdown({ afterSec: 300, label: '测完关机' }, { home, platform: 'win32', run: fakeRun, now })
  ok(r.ok === true && r.scheduled === true, '排上了', JSON.stringify(r))
  ok(calls.length === 1 && calls[0][0] === 'shutdown', '调的是 Windows 的 shutdown', JSON.stringify(calls))
  ok(JSON.stringify(calls[0][1]) === JSON.stringify(['/s', '/t', '300']), '参数是 /s /t 300', JSON.stringify(calls[0][1]))
  ok(existsSync(pp.pcStateFile(home)), '状态文件落盘了')
  const st = JSON.parse(readFileSync(pp.pcStateFile(home), 'utf8'))
  ok(st.dueAt === now + 300_000 && st.label === '测完关机', 'dueAt / label 都记对了', JSON.stringify(st))
  const s = pp.shutdownStatus({ home, now })
  ok(s.scheduled === true && s.remainingSec === 300, 'status 报还剩 300 秒', JSON.stringify(s))
  ok(/cancel/.test(r.hint ?? ''), '提示里告诉怎么取消', r.hint)
}

section('② 闸门：太短 / 太久 / 不是 Windows / 没给时间')
{
  calls.length = 0
  ok((await pp.scheduleShutdown({ afterSec: 30 }, { home, platform: 'win32', run: fakeRun })).ok === false, '30 秒不给（留取消时间）')
  ok((await pp.scheduleShutdown({ afterSec: 13 * 3600 }, { home, platform: 'win32', run: fakeRun })).ok === false, '13 小时不给')
  ok((await pp.scheduleShutdown({ afterSec: 300 }, { home, platform: 'linux', run: fakeRun })).ok === false, '非 Windows 直接拒')
  ok((await pp.scheduleShutdown({}, { home, platform: 'win32', run: fakeRun })).ok === false, '什么都不给 ⇒ 拒')
  ok((await pp.scheduleShutdown({ at: '25:99' }, { home, platform: 'win32', run: fakeRun })).ok === false, 'HH:MM 不合法 ⇒ 拒')
  ok(calls.length === 0, '被拒时一条系统命令都没发', JSON.stringify(calls))
}

section('③ at "HH:MM"：算到下一个该时刻')
{
  const now = Date.parse('2026-10-18T20:00:00+08:00')
  ok(pp.secUntilClock('20:30', now) === 1800, '20:00 排 20:30 ⇒ 1800 秒', String(pp.secUntilClock('20:30', now)))
  ok(pp.secUntilClock('19:00', now) === 23 * 3600, '过了的点排到明天', String(pp.secUntilClock('19:00', now)))
  calls.length = 0
  const r = await pp.scheduleShutdown({ at: '20:30' }, { home, platform: 'win32', run: fakeRun, now })
  ok(r.ok === true && r.remainingSec === 1800, '按 at 排程也走同一条命令', JSON.stringify(r))
}

section('④ 系统拒绝：如实报错，不写账本')
{
  const home2 = mkdtempSync(join(tmpdir(), 'pc-power-fail-'))
  const r = await pp.scheduleShutdown({ afterSec: 120 }, { home: home2, platform: 'win32', run: boomRun })
  ok(r.ok === false && /Access is denied/.test(r.error ?? ''), '把系统的话原样带回来', JSON.stringify(r))
  ok(!existsSync(pp.pcStateFile(home2)), '失败不记账（免得 status 骗人）')
}

section('⑤ 取消与过期')
{
  calls.length = 0
  const r = await pp.cancelShutdown({ home, platform: 'win32', run: fakeRun })
  ok(r.ok === true && r.cancelled === true, '取消成功')
  ok(JSON.stringify(calls[0]) === JSON.stringify(['shutdown', ['/a']]), '调的是 shutdown /a', JSON.stringify(calls))
  ok(!existsSync(pp.pcStateFile(home)), '账本删掉了')
  ok(pp.shutdownStatus({ home }).scheduled === false, '取消后 status 说没排程')
  const now = Date.parse('2026-10-18T20:00:00+08:00')
  await pp.scheduleShutdown({ afterSec: 120 }, { home, platform: 'win32', run: fakeRun, now })
  const s = pp.shutdownStatus({ home, now: now + 200_000 })
  ok(s.scheduled === false && s.expired === true, '过了时间 ⇒ 报"过期"而不是"还在排"', JSON.stringify(s))
}

section('⑥ 静态接线')
{
  const idx = readFileSync(join(ROOT, 'index.js'), 'utf8')
  ok(/from '\.\/src\/pc-power\.mjs'/.test(idx), 'index.js 导入了 pc-power')
  ok(/name: 'mc_pc'/.test(idx), '注册了 mc_pc')
  ok(/action === 'schedule'\) return await scheduleShutdown/.test(idx), 'schedule 接到 scheduleShutdown')
  ok(/action === 'cancel'\) return await cancelShutdown/.test(idx), 'cancel 接到 cancelShutdown')
  const src = readFileSync(join(ROOT, 'src/pc-power.mjs'), 'utf8')
  ok(/execFile\(cmd, args, \{ windowsHide: true/.test(src), '用 execFile 传参数（不经 shell）')
  ok(/\['\/s', '\/t', String\(sec\)\]/.test(src), '命令参数是数组，不拼字符串')
  ok(/PC_MIN_SEC = 60/.test(src) && /PC_MAX_SEC = 12 \* 60 \* 60/.test(src), '上下限是常量')
  ok(/shutdown', \['\/s', '\/t'/.test(src), '/s /t 是显式参数')
}

console.log(`\ncheck-pc-power：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
