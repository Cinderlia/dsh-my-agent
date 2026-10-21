/**
 * 未处理拒绝守卫（`src/crash-guard.mjs`）—— GitHub issue #1 的回归测试。
 *
 * 现场：`mc_move` 被调度器抢占之后，上一次的 `pathfinder.goto` 被 reject 成 `PathStopped`，
 * 它早就没人 await 了（派生链 `withTimeout → raceAbort → Promise.race` 一个个先撤），
 * 于是变成 unhandledRejection ⇒ 宿主的 fail-loud `exit(1)` ⇒ **整个 DSH 闪退**。
 *
 * 这里不连服务器，纯进程内造拒绝：
 *   ① 白名单里的 → 拦下、原监听一条都收不到；
 *   ② 白名单外的 → **原样转交**（真 bug 照崩，不掩盖）；
 *   ③ 环境变量关掉 → 一条都不拦；
 *   ④ 卸载之后监听恢复原样。
 */
import { installRejectionGuard, uninstallRejectionGuard, refreshRejectionGuard, rejectionGuardStats, PATH_REJECTION_NAMES } from '../src/crash-guard.mjs'

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)

const named = (name, message = 'test') => { const e = new Error(message); e.name = name; return e }

/** 造一条"没人接"的拒绝，跑一轮事件循环让 process 有机会发出 unhandledRejection */
const leak = async (err) => {
  Promise.reject(err)
  await new Promise((r) => setTimeout(r, 60))
}

/** 把进程现有的 unhandledRejection 监听摘下来，跑完再装回去（别影响别的自检） */
const withCleanProcess = async (fn) => {
  const saved = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  try { return await fn() } finally {
    process.removeAllListeners('unhandledRejection')
    for (const h of saved) process.on('unhandledRejection', h)
  }
}

section('① 白名单：PathStopped / NoPath / GoalChanged / Timeout 都被拦下')
{
  await withCleanProcess(async () => {
    const got = []
    const hostLike = (reason) => got.push(reason?.name)      // 宿主 fail-loud 的替身
    process.on('unhandledRejection', hostLike)

    const r = installRejectionGuard({ enabled: true, log: () => {} })
    ok(r.installed === true, '装上了', JSON.stringify(r))
    ok(r.forwarded === 1, '接管了 1 个原监听（宿主那条）', String(r.forwarded))

    await leak(named('PathStopped'))
    await leak(named('NoPath'))
    await leak(named('GoalChanged'))
    await leak(named('Timeout'))

    ok(got.length === 0, '宿主一条都没收到（不会 exit）', JSON.stringify(got))
    const st = rejectionGuardStats()
    ok(st.swallowed === 4, '吞了 4 条', String(st.swallowed))
    ok(st.forwarded === 0, '没有误转交', String(st.forwarded))
    ok(st.allow.includes('PathStopped') && st.allow.length === 4, '白名单就是那四个名字', JSON.stringify(st.allow))
    uninstallRejectionGuard()
  })
}

section('② 白名单外：原样转交（真 bug 照崩，不掩盖）')
{
  await withCleanProcess(async () => {
    const got = []
    process.on('unhandledRejection', (reason) => got.push(String(reason?.message ?? reason?.name ?? reason)))
    installRejectionGuard({ enabled: true, log: () => {} })

    await leak(new Error('我是真的 bug'))
    ok(got.length === 1, '宿主收到了那条真 bug', JSON.stringify(got))
    ok(/我是真的 bug/.test(String(got[0])), '内容完整转交', String(got[0]))
    ok(rejectionGuardStats().forwarded === 1, '统计记了 1 条转交', String(rejectionGuardStats().forwarded))

    await leak(named('PathStopped'))
    ok(got.length === 1, '白名单那条没跟过去（还是 1）', String(got.length))
    uninstallRejectionGuard()
  })
}

section('③ 环境变量 off：一条都不拦')
{
  await withCleanProcess(async () => {
    const got = []
    process.on('unhandledRejection', (reason) => got.push(reason?.name))
    const old = process.env.DSH_MC_AGENT_REJECTION_GUARD
    process.env.DSH_MC_AGENT_REJECTION_GUARD = 'off'
    const r = installRejectionGuard({ log: () => {} })
    ok(r.installed === false && r.reason === 'disabled', 'off ⇒ 不装', JSON.stringify(r))
    await leak(named('PathStopped'))
    ok(got.length === 1, '照旧交给宿主（这条会 exit，就是要它崩）', JSON.stringify(got))
    if (old === undefined) delete process.env.DSH_MC_AGENT_REJECTION_GUARD
    else process.env.DSH_MC_AGENT_REJECTION_GUARD = old
  })
}

section('④ 幂等与卸载')
{
  await withCleanProcess(async () => {
    const hostLike = () => {}
    process.on('unhandledRejection', hostLike)
    const a = installRejectionGuard({ enabled: true, log: () => {} })
    const b = installRejectionGuard({ enabled: true, log: () => {} })
    ok(a.installed === true, '第一次装上', JSON.stringify(a))
    ok(b.installed === false && b.reason === 'already', '第二次幂等（不重复包装）', JSON.stringify(b))

    ok(uninstallRejectionGuard() === true, '卸得掉')
    ok(process.listeners('unhandledRejection').length === 1, '原监听回来了（1 条）', String(process.listeners('unhandledRejection').length))
    ok(rejectionGuardStats().installed === false, '卸载后没有状态', JSON.stringify(rejectionGuardStats()))
  })
}

section('⑥ 装完之后才注册的监听：补挂能收编回来')
{
  await withCleanProcess(async () => {
    const late = []
    installRejectionGuard({ enabled: true, log: () => {} })
    /* 模拟"宿主的 fail-loud 晚于插件安装" */
    process.on('unhandledRejection', (reason) => late.push(String(reason?.name ?? '')))
    ok(process.listeners('unhandledRejection').length === 2, '现在进程里有 2 个 handler（我们 + 后挂的）', String(process.listeners('unhandledRejection').length))
    const n = refreshRejectionGuard({ log: () => {} })
    ok(n === 1, '补挂收编了 1 个', String(n))
    ok(process.listeners('unhandledRejection').length === 1, '又回到"只有我们一个 handler"', String(process.listeners('unhandledRejection').length))
    await leak(named('PathStopped'))
    ok(late.length === 0, '白名单那条没跑到后挂的监听里去', JSON.stringify(late))
    await leak(new Error('真 bug'))
    ok(late.length === 1, '真 bug 照样转交给它', JSON.stringify(late))
    uninstallRejectionGuard()
  })
}

section('⑤ 白名单是冻结常量（别被人手改）')
{
  ok(Object.isFrozen(PATH_REJECTION_NAMES), 'PATH_REJECTION_NAMES 冻结了')
  ok(PATH_REJECTION_NAMES.join(',') === 'PathStopped,NoPath,GoalChanged,Timeout', '四个名字一个不多一个不少', PATH_REJECTION_NAMES.join(','))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
