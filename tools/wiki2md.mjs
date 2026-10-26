/** 把保存下来的 Minecraft Wiki 页面（HTML）转成 Markdown。
 * 用法：node tools/wiki2md.mjs <输入目录> <输出目录>
 * 只做"正文可读"级别的转换：标题/段落/列表/表格文本，丢掉脚本样式图片。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', times: '×', rarr: '→', larr: '←', uarr: '↑', darr: '↓' }

function decode (s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
}

function stripTags (html) {
  return decode(html.replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<figure[\s\S]*?<\/figure>/gi, '')
    .replace(/<sup[\s\S]*?<\/sup>/gi, '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** 从 wiki 页面里切出正文 HTML */
function bodyOf (html) {
  const start = html.indexOf('id="mw-content-text"')
  if (start < 0) return html
  const endMarkers = ['<div class="printfooter"', 'id="catlinks"', '<div class="mw-indicators', '<!-- Saved in parser cache']
  let end = html.length
  for (const m of endMarkers) {
    const i = html.indexOf(m, start)
    if (i > 0 && i < end) end = i
  }
  const gt = html.indexOf('>', start)
  return html.slice(gt > 0 ? gt + 1 : start, end)
}

/** 粗略 HTML → Markdown */
function toMarkdown (body) {
  let s = body
  /* 去掉目录/导航/编辑链接（TOC 有的用 id、有的用 class） */
  s = s.replace(/<div[^>]*id="toc"[^>]*>[\s\S]*?<\/div>/gi, '')
  s = s.replace(/<div[^>]*class="[^"]*(toc|mw-editsection|navbox|metadata|printfooter)[^"]*"[\s\S]*?<\/div>/gi, '')
  s = s.replace(/<span[^>]*class="[^"]*mw-editsection[^"]*"[\s\S]*?<\/span>/gi, '')
  /* 表格：保留每个单元格文本，按行拼 */
  s = s.replace(/<table[\s\S]*?<\/table>/gi, (t) => {
    const rows = [...t.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((r) => {
      const cells = [...r[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => stripTags(c[1]))
      return cells.filter(Boolean).join(' | ')
    }).filter(Boolean)
    return rows.length ? '\n\n' + rows.join('\n') + '\n\n' : ''
  })
  /* 标题 */
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => '\n\n' + '#'.repeat(Math.min(6, Number(n))) + ' ' + stripTags(t) + '\n\n')
  /* 列表 */
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => '\n- ' + stripTags(t))
  /* 段落/换行 */
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, t) => '\n\n' + stripTags(t) + '\n\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  /* 剩下的标签清掉 */
  s = stripTags(s)
  /* 压空行 */
  s = s.replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '')
  return s
}

const [inDir, outDir] = process.argv.slice(2)
if (!inDir || !outDir) { console.error('用法: node tools/wiki2md.mjs <输入目录> <输出目录>'); process.exit(1) }
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
const files = readdirSync(inDir).filter((f) => f.endsWith('.html'))
let n = 0
for (const f of files) {
  const html = readFileSync(join(inDir, f), 'utf8')
  const title = (f.match(/^(?:Tutorial|教程)_(.+?)\s*[–-]\s*Minecraft Wiki/) ?? [])[1] ?? basename(f, '.html')
  const md = toMarkdown(bodyOf(html))
  const out = join(outDir, title.replace(/[\/:*?"<>|]/g, '_') + '.md')
  writeFileSync(out, `# ${title}\n\n> 来源：Minecraft Wiki（本地保存的页面转换）\n\n${md}\n`, 'utf8')
  console.log(`${(md.length / 1024).toFixed(0).padStart(5)}KB  ${title}.md`)
  n++
}
console.log(`完成：${n} 个`)
