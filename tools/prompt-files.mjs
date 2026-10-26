#!/usr/bin/env node
/**
 * prompt-files.mjs —— 把常驻提示词（`DEFAULT_AGENTS_MD`）拆成「一个 `## 小节` = 一个文件」，
 * 方便用户一个文件一个文件地精简；改完再 `join` 回 `src/agentsmd.mjs`。
 *
 * 用法：
 *   node tools/prompt-files.mjs split [目录]   # 从 src/agentsmd.mjs 拆出来（默认 .dsh-mc-agent/常驻提示词）
 *   node tools/prompt-files.mjs join  [目录]   # 按文件顺序拼回去，覆盖 src/agentsmd.mjs 里的那一段
 *   node tools/prompt-files.mjs check [目录]   # 只比对：拼起来跟现在的源码一不一样（不写文件）
 *
 * 规矩：
 *   · 文件按文件名开头的两位数字排序，**数字就是顺序**；`00-` 是 H1 标题块。
 *   · 只有 `*.md` 参与拼接（`.md` 之外随你放草稿）。
 *   · 每个文件末尾自动补一个换行，文件之间不额外插空行 —— 所以「原样拆、原样拼」是逐字节一致的。
 *   · 改文件名里的中文标题不会影响拼接结果（只排序号，内容以文件正文为准）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SOURCE = join(ROOT, 'src', 'agentsmd.mjs')
const DEFAULT_DIR = join(ROOT, '.dsh-mc-agent', '常驻提示词')

const START = '/* >>> PROMPT-LITERAL-START —— 这一段由 `node tools/prompt-files.mjs join` 覆盖，别手改 */'
const END = '/* <<< PROMPT-LITERAL-END */'

/** 从 src/agentsmd.mjs 里把 `export const DEFAULT_AGENTS_MD = \`…\`` 那段原文取出来 */
function readLiteral () {
  const src = readFileSync(SOURCE, 'utf8')
  const a = src.indexOf(START)
  const b = src.indexOf(END)
  if (a < 0 || b < 0 || b < a) throw new Error(`src/agentsmd.mjs 里找不到标记：\n  ${START}\n  ${END}`)
  return { src, from: a, to: b + END.length, body: src.slice(a + START.length, b) }
}

/** 把模板字面量的正文还原成字符串（只处理我们会遇到的那几种转义） */
function unescapeLiteral (body) {
  const open = body.indexOf('`')
  const close = body.lastIndexOf('`')
  if (open < 0 || close <= open) throw new Error('没找到反引号包着的字面量')
  const inner = body.slice(open + 1, close)
  let out = ''
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c === '\\') {
      const n = inner[i + 1]
      if (n === 'n') { out += '\n'; i++; continue }
      if (n === 't') { out += '\t'; i++; continue }
      if (n === '`') { out += '`'; i++; continue }
      if (n === '\\') { out += '\\'; i++; continue }
      if (n === '$') { out += '$'; i++; continue }
      out += c
      continue
    }
    out += c
  }
  return out
}

/** 反过来：字符串 → 能塞进模板字面量的正文（转义反引号 / ${ / 反斜杠） */
function escapeLiteral (text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
}

function safeName (s) {
  return s
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

/** 按 `## ` 切块：第一块是 H1 + 前言，其余每块一个小节 */
export function splitSections (text) {
  const lines = text.split('\n')
  const blocks = []
  let cur = { heading: '', lines: [] }
  for (const line of lines) {
    if (/^## /.test(line)) {
      blocks.push(cur)
      cur = { heading: line.slice(3).trim(), lines: [line] }
    } else {
      cur.lines.push(line)
    }
  }
  blocks.push(cur)
  return blocks
    .filter((b) => b.lines.join('').trim() !== '')
    .map((b, i) => ({
      index: i,
      heading: b.heading,
      text: b.lines.join('\n').replace(/\n+$/, '\n'),
    }))
}

function cmdSplit (dir) {
  const text = unescapeLiteral(readLiteral().body)
  const sections = splitSections(text)
  if (existsSync(dir)) {
    // 只清「数字-」开头的分节文件，别把 `_怎么用.md`、草稿一起删掉
    for (const f of readdirSync(dir)) if (/^\d{2}-.*\.md$/.test(f)) rmSync(join(dir, f))
  }
  mkdirSync(dir, { recursive: true })
  sections.forEach((s, i) => {
    const num = String(i).padStart(2, '0')
    const label = i === 0 ? '标题' : safeName(s.heading)
    writeFileSync(join(dir, `${num}-${label}.md`), s.text, 'utf8')
  })
  const total = sections.reduce((n, s) => n + Buffer.byteLength(s.text), 0)
  console.log(`✅ 拆出 ${sections.length} 个文件 → ${dir}`)
  for (const [i, s] of sections.entries()) {
    console.log(`   ${String(i).padStart(2, '0')}  ${(i === 0 ? '标题' : s.heading).padEnd(16)} ${String(Buffer.byteLength(s.text)).padStart(6)} B`)
  }
  console.log(`   合计 ${total} B（源码里的字符串 ${Buffer.byteLength(text)} B）`)
}

function collectFiles (dir) {
  if (!existsSync(dir)) throw new Error(`目录不存在：${dir}（先跑 split）`)
  // 只认「两位数字-名字.md」——`_怎么用.md` 这种说明文件、草稿都不参与拼接
  const files = readdirSync(dir).filter((f) => /^\d{2}-.*\.md$/.test(f)).sort((a, b) => a.localeCompare(b, 'en'))
  if (files.length === 0) throw new Error(`${dir} 里没有「00-xxx.md」这种文件`)
  const missing = files.findIndex((f, i) => !f.startsWith(String(i).padStart(2, '0')))
  if (missing >= 0) throw new Error(`序号不连续：第 ${missing} 个是 ${files[missing]}，应该是 ${String(missing).padStart(2, '0')}-xxx.md`)
  return files.map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n') }))
}

function joined (dir) {
  const files = collectFiles(dir)
  // 文件之间固定隔一个空行（每个文件自己以单个换行结尾），跟 `## ` 小节之间的格式一致
  return { files, text: files.map((f) => f.text).join('\n') }
}

function cmdCheck (dir) {
  const { files, text } = joined(dir)
  const cur = unescapeLiteral(readLiteral().body)
  const same = cur === text
  console.log(`文件 ${files.length} 个 / ${Buffer.byteLength(text)} B；源码里 ${Buffer.byteLength(cur)} B`)
  if (same) { console.log('✅ 完全一致（可以直接 join，不会改动字符串）'); return }
  const a = cur.split('\n')
  const b = text.split('\n')
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      console.log(`❌ 第 ${i + 1} 行开始不同：`)
      console.log('   源码: ' + a[i].slice(0, 120))
      console.log('   文件: ' + b[i].slice(0, 120))
      return
    }
  }
  console.log(`❌ 行数不同：源码 ${a.length} 行 / 文件 ${b.length} 行`)
}

function cmdJoin (dir) {
  const { text } = joined(dir)
  const lit = readLiteral()
  if (!lit.body.includes('export const DEFAULT_AGENTS_MD')) throw new Error('标记之间没有 DEFAULT_AGENTS_MD 声明，先手工确认')
  const body = 'export const DEFAULT_AGENTS_MD = `' + escapeLiteral(text) + '`'
  const next = lit.src.slice(0, lit.from) + START + '\n' + body + '\n' + END + lit.src.slice(lit.to)
  writeFileSync(SOURCE, next, 'utf8')
  console.log(`✅ 已写回 ${SOURCE}（${Buffer.byteLength(text)} B）`)
  console.log('   下一步：node --check src/agentsmd.mjs && node tools/check-core.mjs')
}

const [cmd = 'split', dirArg] = process.argv.slice(2)
const dir = dirArg ? resolve(ROOT, dirArg) : DEFAULT_DIR
try {
  if (cmd === 'split') cmdSplit(dir)
  else if (cmd === 'join') cmdJoin(dir)
  else if (cmd === 'check') cmdCheck(dir)
  else { console.log('用法：node tools/prompt-files.mjs split|join|check [目录]'); process.exit(1) }
} catch (e) {
  console.error('❌ ' + (e?.message ?? e))
  process.exit(1)
}
