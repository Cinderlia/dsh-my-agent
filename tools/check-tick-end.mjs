#!/usr/bin/env node
/**
 * check-tick-end.mjs —— 26.3+ 服务端的 `tick_end` 补丁（上游 mineflayer#4189）
 *
 * 断言：
 *   A. 开关：DSH_MC_AGENT_TICK_END=off 关、其它（含不设）开
 *   B. 挂上之后：position / position_look / look / flying 后面紧跟着一个 tick_end，顺序对
 *   C. 其它包里不夹带 tick_end（不刷屏）
 *   D. 老协议（写 tick_end 会抛）不影响原包，失败只记一次 lastError
 *   E. 原包的异常原样往上抛（不吞、不变成别的异常）
 *   F. 幂等：同一个 client 连挂两次只包一层（两个位置包 → 两个 tick_end，不是四个）
 *   G. 没有 _client 的 bot 不炸，返回 installed:false
 */
import { installTickEnd, tickEndEnabled, TICK_END_AFTER } from '../src/tick-end.mjs'

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

function mkClient ({ rejectTickEnd = false } = {}) {
  const sent = []
  const client = {
    write (name, packet) {
      if (name === 'tick_end' && rejectTickEnd) throw new Error("partial packet: no such field 'tick_end'")
      if (name === 'boom') throw new Error('boom from original')
      sent.push({ name, packet, t: sent.length })
      return 'written:' + name
    },
    sent,
  }
  return client
}

console.log('\nA. 开关')
ok(tickEndEnabled({}) === true, '默认开')
ok(tickEndEnabled({ DSH_MC_AGENT_TICK_END: 'off' }) === false, 'off 关')
ok(tickEndEnabled({ DSH_MC_AGENT_TICK_END: '0' }) === false, '0 关')
ok(tickEndEnabled({ DSH_MC_AGENT_TICK_END: 'on' }) === true, 'on 开')

console.log('\nB. 移动包后面紧跟 tick_end')
{
  const client = mkClient()
  const res = installTickEnd({ _client: client }, { env: {} })
  ok(res.installed && res.reason === 'installed', '挂上了', res)
  for (const name of TICK_END_AFTER) client.write(name, { x: 1 })
  const names = client.sent.map(s => s.name)
  const expect = []
  for (const n of TICK_END_AFTER) expect.push(n, 'tick_end')
  ok(JSON.stringify(names) === JSON.stringify(expect), '四个移动包各跟一个 tick_end、顺序对', names)
  ok(client.__dshTickEnd.sent === 4, '计数 sent=4', client.__dshTickEnd)
}

console.log('\nC. 其它包不夹带')
{
  const client = mkClient()
  installTickEnd({ _client: client }, { env: {} })
  client.write('chat', { message: 'hi' })
  client.write('arm_animation', {})
  ok(client.sent.map(s => s.name).join(',') === 'chat,arm_animation', '没有 tick_end', client.sent.map(s => s.name))
}

console.log('\nD. 老协议（tick_end 不存在）')
{
  const client = mkClient({ rejectTickEnd: true })
  const res = installTickEnd({ _client: client }, { env: {} })
  const r = client.write('position', { x: 0 })
  ok(r === 'written:position', '原包照常写', r)
  ok(client.sent.length === 1 && client.sent[0].name === 'position', '只写了原包', client.sent)
  ok(res.stats.failed === 1 && /no such field/.test(res.stats.lastError), '失败记一次 lastError', res.stats)
  client.write('position', { x: 0 })
  ok(res.stats.failed === 2 && res.stats.lastError === "partial packet: no such field 'tick_end'", '第二次失败不改 lastError', res.stats)
}

console.log('\nE. 原包异常原样抛')
{
  const client = mkClient()
  installTickEnd({ _client: client }, { env: {} })
  let caught = null
  try { client.write('boom', {}) } catch (e) { caught = e }
  ok(caught?.message === 'boom from original', '抛出的是原异常', caught?.message)
  ok(client.sent.length === 0, '抛了就不补 tick_end', client.sent)
}

console.log('\nF. 幂等')
{
  const client = mkClient()
  const a = installTickEnd({ _client: client }, { env: {} })
  const b = installTickEnd({ _client: client }, { env: {} })
  ok(a.reason === 'installed' && b.reason === 'already', '第二次是 already', [a.reason, b.reason])
  client.write('position', { x: 0 })
  client.write('position', { x: 0 })
  ok(client.sent.filter(s => s.name === 'tick_end').length === 2, '两个位置包 → 两个 tick_end（不是四个）', client.sent.map(s => s.name))
}

console.log('\nG. 边界')
{
  const r1 = installTickEnd(null, { env: {} })
  const r2 = installTickEnd({}, { env: {} })
  const r3 = installTickEnd({ _client: mkClient() }, { env: { DSH_MC_AGENT_TICK_END: 'off' } })
  ok(r1.installed === false && r1.reason === 'no-client', 'null bot 不炸', r1)
  ok(r2.installed === false, '空 bot 不炸', r2)
  ok(r3.installed === false && r3.reason === 'disabled', '关掉时不包', r3)
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
