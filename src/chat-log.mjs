/**
 * 游戏内聊天 → 记忆目录（`chat-log.md`）。
 * ============================================================================
 * 用户 2026-10-20：「记忆加和玩家游戏内的聊天记录」。
 *
 * 干什么：玩家说的话（`kind === 'player'`）和我自己说的话（`kind === 'self'`，
 * 就是 `mc_say` 发出去的那条）按**天**分段追加到记忆根的 `chat-log.md`：
 *
 * ```md
 * # 聊天记录
 *
 * ## 2026-10-20
 *
 * - 21:34 <Bluezi> 你试试我看看
 * - 21:35 <DeepSeek（我）> 好，我看一眼
 * ```
 *
 * 规矩：
 *   · **只记人和我**：系统消息（进服/退出/成就/服务器公告）不进这个文件 —— 它们量大、
 *     且已经由看门狗的事件队列负责（`mc_events` / `mc_watch{action:"log"}`）。想翻系统消息去那儿。
 *   · **按天分段 + 只留最近 N 天**（默认 7）：聊天是"流水"，无限追加会把记忆撑爆
 *     （`MemoryStore` 单个文件上限 512KB，撞上就直接抛错 ⇒ 记不进去）。
 *   · **不许抛**：调用点在聊天回调里，写盘失败绝不能把 `mc_say` / 收消息搞挂
 *     （这里全部返回 `{written:false, why}`，不 throw）。
 *   · 路径一律过 `MemoryStore.safePath()`（防越界、防受保护文件）。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** 记忆根下的相对路径（根级单个文件，不按服务器分目录 —— 一个会话同时只连一个服） */
export const CHAT_LOG_REL = 'chat-log.md'

/** 保留几天（默认） */
export const CHAT_LOG_KEEP_DAYS = 7

/** 文件大小上限（字节；留一半余量给 `MemoryStore` 的 512KB 硬上限） */
export const CHAT_LOG_MAX_BYTES = 256 * 1024

/** 单条消息最多留多少字（服务端本来就截到 220 左右，这里再兜一层） */
export const CHAT_LINE_MAX = 300

const pad2 = (n) => String(n).padStart(2, '0')

/** `2026-10-20` */
export function dayStr (d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** `21:34` */
export function clockStr (d = new Date()) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/**
 * 一条聊天 → `{ day, line }`；不该记的返回 `null`。
 *
 * @param {{kind?:string, who?:string, text?:string, at?:number}} entry
 *        `kind` 用 `McBot.chat` 环形数组那套：`player` / `self` / `system`
 */
export function chatLineOf (entry = {}) {
  const kind = String(entry.kind ?? '')
  if (kind !== 'player' && kind !== 'self') return null
  const body = String(entry.text ?? '').replace(/\s+/g, ' ').trim()
  if (!body) return null
  const at = Number(entry.at)
  const d = new Date(Number.isFinite(at) && at > 0 ? at : Date.now())
  const name = String(entry.who ?? '').trim() || '?'
  // 自己说的话标出来：事后翻记录要能一眼分清谁说的
  const who = kind === 'self' ? `${name}（我）` : name
  return { day: dayStr(d), line: `- ${clockStr(d)} <${who}> ${body.slice(0, CHAT_LINE_MAX)}` }
}

/** 切出所有 `## YYYY-MM-DD` 段（返回 `{day,start,end}`，end 不含） */
export function chatSections (content) {
  const text = String(content ?? '')
  const re = /^## (\d{4}-\d{2}-\d{2})\s*$/gm
  const marks = []
  let m
  while ((m = re.exec(text)) !== null) marks.push({ day: m[1], start: m.index })
  return marks.map((mk, i) => ({ ...mk, end: i + 1 < marks.length ? marks[i + 1].start : text.length }))
}

/** 只留最近 `keepDays` 天（按 `## 日期` 段切；头部的标题/说明保留） */
export function trimChatLog (content, keepDays = CHAT_LOG_KEEP_DAYS) {
  const text = String(content ?? '')
  const keep = Math.max(1, Number(keepDays) || CHAT_LOG_KEEP_DAYS)
  const secs = chatSections(text)
  if (secs.length <= keep) return text
  const first = secs[0].start
  const head = text.slice(0, first)
  const from = secs[secs.length - keep].start
  return (head + text.slice(from)).replace(/\s+$/, '\n')
}

/**
 * 丢**最老的一条正文**（`- ` 开头那行）；没有可丢的就原样返回（调用方据此收手）。
 * 头部标题/说明行（`#` / `>`）永远不动。
 */
export function dropOldestLine (content) {
  const text = String(content ?? '')
  const lines = text.split('\n')
  const i = lines.findIndex((l) => l.startsWith('- '))
  if (i < 0) return text
  lines.splice(i, 1)
  return lines.join('\n')
}

/** 头部（新建文件时写一次） */export function chatLogHeader (keepDays = CHAT_LOG_KEEP_DAYS) {
  return '# 聊天记录\n\n'
    + `> 游戏内公屏的流水账，插件自动追加（真人发言 + 我自己 mc_say 说的话；系统消息不在这里）。\n`
    + `> 按天分段，只留最近 ${keepDays} 天；不想记就把配置 chatLog 设成 false。\n`
}

/**
 * 追加一条聊天进记忆根的 `chat-log.md`。
 *
 * @param {object} store `MemoryStore`（只要有 `safePath()` 就够 —— 自检用假 store 也能走这条路）
 * @param {object} entry `{kind, who, text, at}`
 * @returns {{written:boolean, path?:string, why?:string, bytes?:number, line?:string}}
 *          `why` 取值：`not-chat`（系统消息/空话）· `protected`（被受保护文件规则挡住）·
 *          `error`（写盘失败，`error` 字段带原因）
 */
export function recordChat (store, entry = {}, { keepDays = CHAT_LOG_KEEP_DAYS, maxBytes = CHAT_LOG_MAX_BYTES } = {}) {
  let hit
  try { hit = chatLineOf(entry) } catch { return { written: false, why: 'not-chat' } }
  if (!hit) return { written: false, why: 'not-chat' }
  let target
  try {
    if (typeof store?.safePath !== 'function') return { written: false, why: 'no-store' }
    target = store.safePath(CHAT_LOG_REL)
  } catch (e) {
    return { written: false, why: 'error', error: e.message }
  }
  if (target.protected) return { written: false, why: 'protected' }

  try {
    let content = ''
    if (existsSync(target.abs)) {
      try { content = readFileSync(target.abs, 'utf8') } catch { content = '' }
    }
    if (!content.trim()) content = chatLogHeader(keepDays)

    // 同一条紧挨着重复（服务端回显/重连补发）就不记第二遍
    if (content.replace(/\s+$/, '').endsWith(hit.line)) {
      return { written: false, why: 'dup', path: target.rel, line: hit.line }
    }

    const secs = chatSections(content)
    const lastDay = secs.length ? secs[secs.length - 1].day : null
    if (lastDay === hit.day) {
      content = content.replace(/\s*$/, '\n') + hit.line + '\n'
    } else {
      content = content.replace(/\s*$/, '\n') + `\n## ${hit.day}\n\n` + hit.line + '\n'
    }

    content = trimChatLog(content, keepDays)
    /* 天数压完还超（一天里聊了太多）⇒ 继续丢：先丢最老的**日期段**，
     * 只剩一段时改成丢最老的那条正文（头部说明永远留着）。 */
    let guard = 0
    while (Buffer.byteLength(content, 'utf8') > maxBytes && guard++ < 512) {
      const s = chatSections(content)
      if (s.length > 1) {
        content = content.slice(0, s[0].start) + content.slice(s[1].start)
        continue
      }
      const next = dropOldestLine(content)
      if (next === content) break          // 已经只剩最后一条，不再削（留一条总比空文件强）
      content = next
    }

    writeFileSync(target.abs, content, 'utf8')
    return { written: true, path: target.rel, bytes: Buffer.byteLength(content, 'utf8'), line: hit.line }
  } catch (e) {
    return { written: false, why: 'error', error: e.message }
  }
}
