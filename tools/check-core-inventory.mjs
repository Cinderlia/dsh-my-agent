#!/usr/bin/env node
/**
 * check-core-inventory.mjs —— `mc_inventory` 的输出必须"一眼看得出总数"的回归检查
 *
 * 背景（用户 2026-10-07 转来的实机现象：「我手上4个木板它非说不算，让我去砍原木」）：
 *   `McBot.inventory()` 旧实现回 `{ held, items }`，而 mineflayer 的 `inventory.items()`
 *   **本来就包含手上那一格** —— 同一叠东西在输出里出现两遍（`"held": "oak_planksx2"` 和
 *   列表里又一条 `"oak_planksx2"`），模型当场数了两遍：
 *   「oak_planks x2 held + oak_planks x2 = 4 planks」，于是它断定 `mc_craft` 在撒谎
 *   （其实它只有 2 块木板、做工作台要 4 块），跑去砍树了。
 *
 * 这个脚本把四件事钉死（防止坑回来）：
 *   ① 同名的多格要**合计**成一条（`oak_planksx2` ×2 格 ⇒ `oak_planksx4` 一条）；
 *   ② `held` 要明说"已经算在合计里，别再加一遍"，且**不再重复出现在 items 里**；
 *   ③ 回 `text`（宿主直接渲染它，不再 pretty-print JSON），`items` 保持数组给
 *      `mc_craft` / `mc_furnace` 打"背包：…"用；
 *   ④ 静态接线：两个扩展里那行 `Array.isArray(inv)` 的老写法必须绝迹
 *      （`mc.inventory()` 回的是对象，那个条件永远为假 ⇒ 那行"背包：…"从来没打印过）。
 *
 * 用法：node tools/check-core-inventory.mjs
 *   ⚠️ **必须从包目录跑**（`<profile>/node_modules/dsh-mc-agent`）：`src/core.mjs` 顶部
 *      `import ... from 'mineflayer'`，源码树里没有 node_modules 会 ERR_MODULE_NOT_FOUND。
 *      （工作区自带 node_modules，所以在工作区跑也行。）
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

// ── 断言小工具（和别的 check-*.mjs 一致）────────────────────────────────────────
let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)
/** 断言"不许出现某种写法"之前必须剥注释 —— 注释里正是拿这些反面写法当例子 */
const stripComments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

// ── 借依赖：源码树里没有 node_modules，从包目录借 vec3 ────────────────────────────
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')
const req = (() => {
  const bases = [
    new URL('../index.js', import.meta.url).href,
    join(PROFILE, 'node_modules', 'dsh-mc-agent', 'index.js'),
    join(PROFILE, 'index.js'),
  ]
  for (const base of bases) {
    try { const r = createRequire(base); r('mineflayer'); return r } catch {}
  }
  return null
})()
if (!req) {
  console.log('✗ 拿不到 mineflayer —— 请从包目录（<profile>/node_modules/dsh-mc-agent）跑，')
  console.log('  或确认已安装 mineflayer。')
  process.exit(2)
}
const { McBot } = await import(new URL('../src/core.mjs', import.meta.url))

const TMP_DIRS = []
const mkMc = (stacks, heldIndex = null) => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-inv-'))
  TMP_DIRS.push(dir)
  const mc = new McBot({ logFile: join(dir, 'check.log') })
  const items = stacks.map(([name, count]) => ({ name, count }))
  mc.bot = {
    entity: {},
    // 真 mineflayer 的语义：`inventory.items()` 里**手上那一格也在内**
    inventory: { items: () => items },
    heldItem: heldIndex == null ? null : items[heldIndex],
  }
  return mc
}

/* ─────────── ① 同名多格要合计，手上那格不再重复数 ─────────── */
section('① 同名多格合计 + held 不重复计数（实机那个坑）')
{
  // 实机现场：两格 oak_planks 各 2 块（其中一格拿在手上），外加 16 块圆石
  const mc = mkMc([['oak_planks', 2], ['oak_planks', 2], ['cobblestone', 16]], 0)
  const inv = mc.inventory()
  ok(Array.isArray(inv.items), 'items 是数组（扩展要按它打"背包：…"）', JSON.stringify(inv.items))
  const planks = inv.items.find((i) => i.name === 'oak_planks')
  ok(planks && planks.count === 4, '两格 oak_planks 各 2 块 ⇒ 合计 4 块', JSON.stringify(planks))
  ok(inv.items.filter((i) => i.name === 'oak_planks').length === 1, '同名只出一条（不再两格两条）', JSON.stringify(inv.items.map((i) => `${i.name}x${i.count}`)))
  ok(inv.held === 'oak_planksx2', 'held 照旧写清手上那一叠是什么、几个', String(inv.held))
  ok(typeof inv.text === 'string' && inv.text.length > 0, '回 text（宿主直接渲染，不再 pretty-print JSON）')
  ok(inv.text.includes('oak_planksx4'), '文本里是合计后的 4 块', inv.text.replace(/\n/g, ' | '))
  ok(!/oak_planksx2[^\d]*oak_planksx2/.test(inv.text.replace('手上：oak_planksx2', '')), '正文里不会出现两遍 oak_planksx2（模型数两遍的根源）', inv.text.replace(/\n/g, ' | '))
  ok(inv.text.includes('别再加一遍'), '文本明说"手上那叠已经算在合计里，别再加一遍"', inv.text.replace(/\n/g, ' | '))
  /* 空位后缀只在真 `bot.inventory.emptySlotCount()` 可用时才有（假 bot 没有）⇒ 断言别写死后缀。 */
  ok(/共 3 叠 \/ 2 样/.test(inv.text), '给出"几叠 / 几样"的总数', inv.text.replace(/\n/g, ' | '))
}

/* ─────────── ② 只有手上那一叠（最容易数两遍的情形）─────────── */
section('② 只有手上那一叠 —— 必须报 2，不是 4')
{
  const mc = mkMc([['oak_planks', 2]], 0)
  const inv = mc.inventory()
  ok(inv.items.length === 1 && inv.items[0].count === 2, '一格 2 块 ⇒ 合计就是 2 块', JSON.stringify(inv.items))
  ok(inv.text.includes('oak_planksx2') && !inv.text.includes('oak_planksx4'), '文本里不会变成 4 块', inv.text.replace(/\n/g, ' | '))
}

/* ─────────── ③ 空背包 / 空手 ─────────── */
section('③ 空背包')
{
  const mc = mkMc([], null)
  const inv = mc.inventory()
  ok(Array.isArray(inv.items) && inv.items.length === 0, 'items 是空数组')
  ok(inv.held === null, 'held 是 null')
  ok(inv.text.includes('手上：空') && inv.text.includes('背包：空') && /共 0 叠 \/ 0 样/.test(inv.text),
    '空背包文案齐全', inv.text.replace(/\n/g, ' | '))
}

/* ─────────── ④ 静态接线：老写法必须绝迹 ─────────── */
section('④ 静态接线（老写法不许回来）')
{
  const core = readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8')
  const inv = stripComments(core)
  ok(inv.includes('同名已合计'), 'core.mjs 的 inventory() 标了"同名已合计"')
  ok(inv.includes('别再加一遍'), 'core.mjs 的 inventory() 提醒"别再加一遍"')
  ok(!/items:\s*b\.inventory\.items\(\)\.map/.test(inv), 'core.mjs 不再直接把 items() 原样 map 出去（那是重复计数那版）')
  ok(/const totals = new Map\(\)/.test(inv), 'core.mjs 用 totals 按名字合计')

  for (const f of ['mc_craft.mjs', 'mc_furnace.mjs']) {
    const src = stripComments(readFileSync(new URL(`../extensions/${f}`, import.meta.url), 'utf8'))
    ok(src.includes('Array.isArray(inv?.items)'), `${f} 按 { items } 取背包一览`)
    ok(!/Array\.isArray\(inv\)\s*\?/.test(src), `${f} 不再写 Array.isArray(inv)（条件永远为假）`)
    ok(src.includes('背包：'), `${f} 还会打"背包：…"这一行`)
  }
}

for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
console.log(`\n结果：${pass}/${pass + fail} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
