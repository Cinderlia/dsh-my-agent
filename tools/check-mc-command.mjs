#!/usr/bin/env node
/**
 * check-mc-command.mjs —— `mc_command` 多行支持 / 换行踢人的回归检查
 *
 * 病根（2026-10-19 实机踩到）：
 *   我要铺 32×40 的像素画，一口气生成了 10 条 `/fill`，**拼成一个多行字符串**发进 `mc_command`。
 *   聊天包里带换行符 ⇒ 服务端判定非法字符 ⇒
 *     **`multiplayer.disconnect.illegal_characters`，人当场掉线**，整轮建造作废。
 *
 * 修法：
 *   ① `src/commands.mjs` 的 `splitCommands()` 把多行拆成一条一条（空行丢掉、每条必须以 `/`
 *      开头、不许夹控制字符、超过 32 条直接拒而不是静默截断）；
 *   ② `mc_command` 逐条发（间隔 120ms，避免被判刷屏）；
 *   ③ `McBot.command()` 里再挡一道：单条里出现换行就抛错，**绝不把换行发进 b.chat()**。
 *
 * 用法：node tools/check-mc-command.mjs（从包目录跑）
 */

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

const { splitCommands, commandNameOf, MAX_COMMANDS_PER_CALL, COMMANDS_THAT_MOVE_ME } = await import('../src/commands.mjs')

// ── ① 正常：一条 / 多条 ──────────────────────────────────────────────────────────
section('① 拆分：一条 / 多条 / 空行 / CRLF')
{
  ok(JSON.stringify(splitCommands('/tp DeepSeek 0 64 0')) === JSON.stringify(['/tp DeepSeek 0 64 0']), '一条就回一条')
  const two = splitCommands('/say hi\n/time set day')
  ok(two.length === 2 && two[1] === '/time set day', '两行拆成两条', JSON.stringify(two))
  const messy = splitCommands('\n\n/say a\r\n\r\n  /say b  \n')
  ok(messy.length === 2 && messy[0] === '/say a' && messy[1] === '/say b', '空行/CRLF/首尾空白都吃掉', JSON.stringify(messy))
}

// ── ② 复现当初掉线的那一包：10 条 /fill 拼成多行 ─────────────────────────────────
section('② 复现：10 条 /fill 拼成一个多行字符串（当初就是这么被踢的）')
{
  const fills = Array.from({ length: 10 }, (_, i) => `/fill -1765 ${72 + i} 1233 -1734 ${72 + i} 1233 light_gray_concrete`)
  const one = fills.join('\n')
  ok(/\n/.test(one), '拼出来的字符串里确实有换行符（= 会踢人的那种）')
  const lines = splitCommands(one)
  ok(lines.length === 10, '拆成 10 条', String(lines.length))
  ok(lines.every((l) => !/[\r\n]/.test(l)), '拆完每一条里都不含换行符（可以安全塞进 b.chat）')
  ok(lines.every((l) => l.startsWith('/fill ')), '每条都还是 /fill')
}

// ── ③ 该拒的要拒（而且要说清楚是第几条） ────────────────────────────────────────
section('③ 校验：不是 / 开头、空、超量、控制字符')
{
  const err = (fn) => { try { fn(); return null } catch (e) { return String(e.message ?? e) } }
  const e1 = err(() => splitCommands('/say ok\nsay 忘了斜杠'))
  ok(/第 2 条/.test(e1 ?? ''), '第二行没写 / ⇒ 报"第 2 条"', (e1 ?? '').slice(0, 40))
  const e2 = err(() => splitCommands('   \n\n '))
  ok(e2 != null, '全是空白 ⇒ 报错（不是默默发 0 条）', (e2 ?? '').slice(0, 30))
  const e3 = err(() => splitCommands(Array.from({ length: 33 }, () => '/say x').join('\n')))
  ok(/33/.test(e3 ?? '') && /32/.test(e3 ?? ''), '超过 32 条 ⇒ 报错并说清给了几条（不静默截断）', (e3 ?? '').slice(0, 40))
  const e4 = err(() => splitCommands('/say a\tb'))
  ok(e4 != null && /控制字符/.test(e4), '制表符 ⇒ 报控制字符', (e4 ?? '').slice(0, 30))
  ok(MAX_COMMANDS_PER_CALL === 32, '上限是 32 条', String(MAX_COMMANDS_PER_CALL))
}

// ── ④ 名字解析 + 会挪人的那几条 ─────────────────────────────────────────────────
section('④ commandNameOf / COMMANDS_THAT_MOVE_ME')
{
  ok(commandNameOf('/TP DeepSeek 0 64 0') === 'tp', '/TP → tp（大小写不敏感）')
  ok(commandNameOf('  /fill 1 2 3 4 5 6 stone ') === 'fill', '带前后空白也认')
  ok(commandNameOf('/') === '', '只有斜杠 ⇒ 空名字（白名单会拒）')
  ok(COMMANDS_THAT_MOVE_ME.has('tp') && COMMANDS_THAT_MOVE_ME.has('execute'), 'tp / execute 仍在"会挪人"名单里')
  ok(!COMMANDS_THAT_MOVE_ME.has('fill'), 'fill 不在（它不挪人）')
}

// ── ⑤ 核心防线：McBot.command() 绝不放换行进 b.chat() ───────────────────────────
section('⑤ McBot.command()：换行挡在 b.chat() 之前')
{
  const { McBot } = await import('../src/core.mjs')
  const chats = []
  const bot = new McBot({ log: () => {}, verbose: false })
  // 只搭到"能调 command()"为止：requireBot 返回一个只会记 chat 的假 bot
  bot.bot = { chat: (c) => chats.push(c) }
  bot.requireBot = () => bot.bot
  let e = null
  try { bot.command('/fill 1 2 3 4 5 6 stone\n/fill 1 2 3 4 5 6 dirt') } catch (err) { e = err }
  ok(e != null && /illegal_characters|换行/.test(String(e.message)), '多行 ⇒ 直接抛错（不发出去）', (e?.message ?? '').slice(0, 46))
  ok(chats.length === 0, '一条聊天包都没发（服务端不会被惹到）', `chat 收到 ${chats.length} 条`)
  // 单条照样能发
  chats.length = 0
  let single = null
  try { single = bot.command('/say hello') } catch (err) { e = err }
  ok(single === '/say hello' && chats.length === 1, '单条正常发出去', JSON.stringify(chats))
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
