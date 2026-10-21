#!/usr/bin/env node
/**
 * 「游戏内聊天 → 记忆」自检 —— `src/chat-log.mjs`
 *
 * 🔴 起因（用户 2026-10-20）：「记忆加和玩家游戏内的聊天记录」。
 *    要的是**流水账**：真人说的话 + 我自己 `mc_say` 说的话，按天分段落到记忆根的 `chat-log.md`。
 *
 * 钉死这几件事：
 *   ① 只记 `player` / `self`；系统消息（进服/成就/公告）不进文件（那些看门狗已经在记）；
 *   ② 自己说的话标 `（我）`，事后翻记录能分清谁说的；
 *   ③ 首次写会建文件 + 头部说明；同一天继续追加不新建日期段；跨天新建 `## 日期`；
 *   ④ 按天只留最近 N 天（默认 7），头部说明保留；文件超上限时从最老的段往下丢；
 *   ⑤ **任何失败都不抛**（`not-chat` / `no-store` / `protected` / `error`），聊天绝不能被记忆搞挂；
 *   ⑥ `index.js` 进服就把钩子挂上；`src/chat.mjs` 的 `pushChat()` 是唯一入口；
 *   ⑦ 开关是配置键 `chatLog`（默认开）/ `chatLogDays`（1~90）。
 *
 * 用法：node tools/check-chat-log.mjs
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { recordChat, chatLineOf, trimChatLog, chatSections, chatLogHeader, CHAT_LOG_REL, CHAT_LINE_MAX } =
  await import(new URL('../src/chat-log.mjs', import.meta.url))
const { MemoryStore } = await import(new URL('../src/memory.mjs', import.meta.url))

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? ` —— ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)

const P = 'Bluezi'
const SELF = 'DeepSeek'
/** 固定时刻（本地时区），免得测试跟着机器跑偏 */
const at = (h, m, d = 20) => new Date(2026, 9, d, h, m, 0, 0).getTime()

const tmpRoot = () => mkdtempSync(join(tmpdir(), 'chat-log-'))

// ── ① 一行聊天长什么样 ──────────────────────────────────────────────
section('① 一行聊天')
{
  const a = chatLineOf({ kind: 'player', who: P, text: '你试试我看看', at: at(21, 34) })
  ok(a?.day === '2026-10-20', '日期段按本地日期算', a?.day)
  ok(a?.line === '- 21:34 <Bluezi> 你试试我看看', '`- HH:MM <名字> 正文` 的形状', a?.line)

  const b = chatLineOf({ kind: 'self', who: SELF, text: '好，我看一眼', at: at(21, 35) })
  ok(b?.line === '- 21:35 <DeepSeek（我）> 好，我看一眼', '自己说的话标「（我）」', b?.line)

  ok(chatLineOf({ kind: 'system', who: null, text: 'Bluezi joined the game', at: at(1, 1) }) === null,
    '系统消息不记（not-chat）')
  ok(chatLineOf({ kind: 'player', who: P, text: '   ', at: at(1, 1) }) === null, '空话不记')
  ok(chatLineOf({ kind: 'player', who: P, text: 'a\nb\r\nc', at: at(1, 1) })?.line === '- 01:01 <Bluezi> a b c',
    '换行压成空格（记忆文件按行切，不能让它撑破一行）')

  const long = chatLineOf({ kind: 'player', who: P, text: 'x'.repeat(1000), at: at(1, 1) })
  ok(long.line.length < CHAT_LINE_MAX + 40 && long.line.includes('x'), `超长正文截到 ${CHAT_LINE_MAX} 字`, String(long.line.length))

  ok(chatLineOf({}) === null, '空对象不炸也不记')
  ok(chatLineOf({ kind: 'player', who: null, text: 'hi', at: NaN })?.line.includes('<?>'),
    '没有名字时用 `?`、没有时间时拿 now 也不炸')
}

// ── ② 落到记忆根 ────────────────────────────────────────────────────
section('② 落到记忆根（首次建文件 / 当天追加 / 跨天新建段）')
{
  const root = tmpRoot()
  const store = new MemoryStore(root, { create: true })
  const w1 = recordChat(store, { kind: 'player', who: P, text: '你试试我看看', at: at(21, 34) })
  ok(w1.written === true && w1.path === CHAT_LOG_REL, '第一句就建出 chat-log.md', JSON.stringify(w1.why ?? ''))
  const text1 = readFileSync(join(root, CHAT_LOG_REL), 'utf8')
  ok(text1.startsWith('# 聊天记录'), '带标题')
  ok(text1.includes('## 2026-10-20'), '带当天日期段')
  ok(text1.includes('- 21:34 <Bluezi> 你试试我看看'), '正文落进去了')

  const w2 = recordChat(store, { kind: 'self', who: SELF, text: '好，我看一眼', at: at(21, 35) })
  ok(w2.written === true, '第二句追加成功')
  const text2 = readFileSync(join(root, CHAT_LOG_REL), 'utf8')
  ok(chatSections(text2).length === 1, '同一天不新建日期段（还是 1 段）', String(chatSections(text2).length))
  ok(text2.indexOf('<Bluezi>') < text2.indexOf('（我）'), '顺序就是发生顺序')

  const w3 = recordChat(store, { kind: 'player', who: P, text: '第二天了', at: at(9, 5, 21) })
  ok(w3.written === true, '跨天也能写')
  const text3 = readFileSync(join(root, CHAT_LOG_REL), 'utf8')
  ok(chatSections(text3).map((s) => s.day).join(',') === '2026-10-20,2026-10-21', '新的一天另起一段', chatSections(text3).map((s) => s.day).join(','))

  const dup = recordChat(store, { kind: 'player', who: P, text: '第二天了', at: at(9, 5, 21) })
  ok(dup.written === false && dup.why === 'dup', '紧挨着重复的一句不重复记（服务端回显/重连补发）', JSON.stringify(dup.why))

  const sys = recordChat(store, { kind: 'system', who: null, text: 'x', at: at(9, 6, 21) })
  ok(sys.written === false && sys.why === 'not-chat', '系统消息写了也不进文件（返回 not-chat）', JSON.stringify(sys.why))
  ok(!readFileSync(join(root, CHAT_LOG_REL), 'utf8').includes('> x'), '文件里确实没有那条系统消息')

  ok(recordChat(null, { kind: 'player', who: P, text: 'hi', at: at(1, 1) }).why === 'no-store', '没有 store 就如实说 no-store，不抛')
  ok(recordChat({ safePath: () => ({ protected: true, rel: 'x', abs: '/x' }) }, { kind: 'player', who: P, text: 'hi', at: at(1, 1) }).why === 'protected',
    '受保护文件拒写（走 MemoryStore 的规矩）')
  const boom = recordChat({ safePath: () => { throw new Error('越界') } }, { kind: 'player', who: P, text: 'hi', at: at(1, 1) })
  ok(boom.written === false && boom.why === 'error' && /越界/.test(boom.error), 'safePath 抛错也被兜住（不冒泡）', JSON.stringify(boom.why))
}

// ── ③ 只留最近 N 天 ────────────────────────────────────────────────
section('③ 只留最近 N 天')
{
  const root = tmpRoot()
  const store = new MemoryStore(root, { create: true })
  for (let d = 1; d <= 9; d++) recordChat(store, { kind: 'player', who: P, text: `day${d}`, at: at(10, 0, d) }, { keepDays: 3 })
  const text = readFileSync(join(root, CHAT_LOG_REL), 'utf8')
  ok(chatSections(text).length === 3, '写完 9 天只剩 3 段', String(chatSections(text).length))
  ok(chatSections(text).map((s) => s.day).join(',') === '2026-10-07,2026-10-08,2026-10-09', '留的是**最近**三天', chatSections(text).map((s) => s.day).join(','))
  ok(!text.includes('day1'), '最老的正文被丢掉')
  ok(text.startsWith('# 聊天记录'), '头部说明保留（不被裁掉）')
  ok(text.includes('只留最近 3 天'), '头部的天数跟着 keepDays 走', text.split('\n')[3]?.slice(0, 40))

  const raw = '# 聊天记录\n\n## 2026-01-01\n\n- a\n'
  ok(trimChatLog(raw, 7) === raw, '段数没超就原样返回（不做无谓改写）')
  ok(chatSections(trimChatLog(raw, 1)).map((s) => s.day).join(',') === '2026-01-01', 'keepDays=1 至少留一段')
}

// ── ④ 体积上限：天数压完还超就继续丢最老的段 ──────────────────────────
section('④ 体积上限')
{
  const root = tmpRoot()
  const store = new MemoryStore(root, { create: true })
  // 一天塞 40 句，掐一个很小的上限：段数不会再降（都是同一天），只能靠"丢最老段"兜底前先把天压到 1
  for (let i = 0; i < 40; i++) recordChat(store, { kind: 'player', who: P, text: `m${i}-${'x'.repeat(80)}`, at: at(10, i % 60, 20) }, { keepDays: 30, maxBytes: 900 })
  const bytes = Buffer.byteLength(readFileSync(join(root, CHAT_LOG_REL), 'utf8'), 'utf8')
  ok(bytes <= 900 + 200, '接进上限附近（不会无限长）', String(bytes))
  const text = readFileSync(join(root, CHAT_LOG_REL), 'utf8')
  ok(text.includes('m39-'), '最后一条一定还在（丢的是最老的）')
  ok(text.startsWith('# 聊天记录'), '头部还在')
  ok(chatLogHeader(5).includes('5 天'), '头部文案能跟着天数变')
}

// ── ⑤ 接线：进服挂钩子 + pushChat 是唯一入口 ─────────────────────────
section('⑤ 接线')
{
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const chat = readFileSync(new URL('../src/chat.mjs', import.meta.url), 'utf8')
  const cfg = readFileSync(new URL('../src/config.mjs', import.meta.url), 'utf8')

  ok(/import \{ recordChat \} from '\.\/src\/chat-log\.mjs'/.test(idx), 'index.js 引了 recordChat')
  ok(/const attachChatLog = \(sess, agent\) =>/.test(idx), 'index.js 有 attachChatLog')
  ok(/bot\.onChatLine = \(entry\) =>/.test(idx), '钩子挂在 bot.onChatLine 上')
  ok(/if \(!pluginConfig\.chatLog\) return/.test(idx), '配置关掉就不记（chatLog）')
  ok(/keepDays: pluginConfig\.chatLogDays/.test(idx), '天数走配置 chatLogDays')
  ok(/const chatLogRoot = attachChatLog\(sess, exec\?\.agent\)/.test(idx), 'mc_connect 成功后就挂上')
  ok(/try \{ self\.onChatLine\?\.\(entry\) \} catch/.test(chat), 'pushChat 里叫钩子，且**包了 try/catch**（记不上不能把聊天搞挂）')
  ok(/const entry = \{ at: Date\.now\(\), kind, who, text \}/.test(chat), 'pushChat 先造 entry 再入环（钩子拿的是同一条）')

  ok(/chatLog: true,/.test(cfg), '配置默认开（chatLog: true）')
  ok(/get chatLog \(\) \{[\s\S]{0,120}this\.get\('chatLog'\) !== false/.test(cfg), 'getter：只有显式 false 才关')
  ok(/get chatLogDays \(\)/.test(cfg), '有 chatLogDays getter')
  ok(/top === 'chatLogDays'/.test(cfg), 'chatLogDays 有校验（1~90）')
}

// ── ⑥ 真机：memory 根的路径与受保护名单不冲突 ─────────────────────────
section('⑥ 不撞受保护文件')
{
  const root = tmpRoot()
  const store = new MemoryStore(root, { create: true })
  const t = store.safePath(CHAT_LOG_REL)
  ok(t.protected === false, 'chat-log.md 不是受保护文件（能自动写）')
  ok(existsSync(root), '记忆根本身存在')
  // 顺带确认：受保护名单里确实没有它
  const prot = readFileSync(new URL('../src/protected.mjs', import.meta.url), 'utf8')
  ok(!/chat-log\.md/.test(prot), '受保护名单里没有 chat-log.md')
  mkdirSync(join(root, '_global'), { recursive: true })
  writeFileSync(join(root, '_global', 'x.md'), '# x\n', 'utf8')
  const w = recordChat(store, { kind: 'player', who: P, text: '和别的记忆文件并存', at: at(12, 0) })
  ok(w.written === true && existsSync(join(root, CHAT_LOG_REL)), '和其它记忆文件放在一起没问题')
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
