#!/usr/bin/env node
/**
 * 数字参数容错自检 —— `src/tool-def.mjs` 的 `loosenNumberParams` / `coerceNumberArgs`
 *
 * 🔴 起因（用户 2026-10-23 贴的实机报错）：
 *      { mode:"place", name:"crafting_table", x:-531, y:72, z:"-32" }
 *      → `Error: invalid arguments: "z" must be a number`
 *    模型把坐标写成了字符串，宿主（我们本地用内置等价实现）按参数表里的 `type:"number"`
 *    在校验层就拒掉 —— `execute` 一次都没跑。这不是模型的错，是我们把参数表写得太窄：
 *    参数表里同时**允许字符串**，再在 `execute` 前把"看上去是数字的字符串"转成真数字，
 *    既不放过 `"abc"`（`numOf` 仍会报原文），也不会让下游拿到字符串。
 *
 * 钉死这几件事：
 *   ① `loosenNumberParams`：number/integer → `type:"json"`，其它属性一个都不动；
 *      注解（description/default/required）原样保留；**不改入参对象**；
 *   ② `coerceNumberArgs`：只动严格表里声明为 number/integer 的键；
 *      `"-32"` / `" 72 "` / `"3.5"` / `"1e3"` 转成数字，`"abc"` / `""` / `"  "` 原样留着；
 *      `name:"64"` 这类文本参数不碰；没改动时**返回原对象引用**；
 *   ③ 闭环：宽松表注册出来的工具，传字符串能进 `execute` 且拿到的是 number；
 *      同一份表不宽松时，传字符串在**校验层**就被拒（说明这层真的有用）；
 *   ④ 静态：`index.js` 的 `asTool` 确实两条都接了，且严格表仍然是 `type:'number'`。
 *
 * 用法：node tools/check-tool-args.mjs
 */
import { readFileSync } from 'node:fs'
import {
  builtinDefineTool, loosenNumberParams, coerceNumberArgs, isNumericParam,
} from '../src/tool-def.mjs'

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? ` —— ${extra}` : ''}`) }
}
const eq = (a, b, label) => ok(Object.is(a, b), label, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
const section = (t) => console.log(`\n${t}`)

/* ───────────────────────── ① loosenNumberParams ───────────────────────── */
section('① 注册用的宽松表：number/integer → json，别的一动不动')
{
  const strict = {
    x: { type: 'number' },
    y: { type: 'number', description: '高度' },
    count: { type: 'integer', description: '几个', default: 1 },
    mode: { type: 'string', description: 'walk / fly' },
    flag: { type: 'boolean' },
    list: { type: 'array', items: { type: 'string' } },
    value: { type: 'json', description: '任意值' },
    must: { type: 'string', required: true },
  }
  const loose = loosenNumberParams(strict)
  eq(loose.x.type, 'json', 'number → json')
  eq(loose.count.type, 'json', 'integer → json')
  eq(loose.mode.type, 'string', 'string 参数不动')
  eq(loose.flag.type, 'boolean', 'boolean 参数不动')
  eq(loose.list.type, 'array', 'array 参数不动')
  eq(loose.value.type, 'json', '本来就是 json 的照旧')
  eq(loose.y.description, '高度', '注解 description 原样保留')
  eq(loose.count.default, 1, '注解 default 原样保留')
  eq(loose.must.required, true, 'required 原样保留')
  eq(strict.x.type, 'number', '**不改入参对象**（严格表还是 number）')
  ok(loose !== strict, '返回的是新对象')
  ok(loose.mode === strict.mode, '非数字参数连引用都复用（没白复制）')
  eq(loosenNumberParams(undefined), undefined, '入参缺失原样返回')
  eq(loosenNumberParams(null), null, '入参 null 原样返回')
  ok(isNumericParam({ type: 'number' }) && isNumericParam({ type: 'integer' }), 'isNumericParam 认 number/integer')
  ok(!isNumericParam({ type: 'string' }) && !isNumericParam(null) && !isNumericParam(undefined), 'isNumericParam 不认别的')
}

/* ───────────────────────── ② coerceNumberArgs ───────────────────────── */
section('② 执行前：数字字符串 → number（文本参数一个都不碰）')
{
  const params = {
    x: { type: 'number' },
    z: { type: 'number' },
    count: { type: 'integer' },
    name: { type: 'string' },
    text: { type: 'string' },
  }
  const out = coerceNumberArgs(params, { x: 10, z: '-32', count: ' 3 ', name: '64', text: '123' })
  eq(out.x, 10, '本来就是数字的原样')
  eq(out.z, -32, '"−32" → -32（用户实机那条）')
  eq(out.count, 3, '" 3 " → 3（前后空格也认）')
  eq(out.name, '64', '字符串参数 name:"64" **不转**')
  eq(out.text, '123', '字符串参数 text:"123" **不转**')
  ok(typeof out.z === 'number' && typeof out.count === 'number', '转完真是 number 类型')
  eq(coerceNumberArgs(params, { z: '-3.5' }).z, -3.5, '小数 "-3.5" → -3.5')
  eq(coerceNumberArgs(params, { z: '1e3' }).z, 1000, '科学计数 "1e3" → 1000')
  eq(coerceNumberArgs(params, { z: '0' }).z, 0, '"0" → 0（不是假值就跳过）')
  eq(coerceNumberArgs(params, { z: 'abc' }).z, 'abc', '"abc" 原样留着（交给 numOf 报原文）')
  eq(coerceNumberArgs(params, { z: '' }).z, '', '空串原样留着')
  eq(coerceNumberArgs(params, { z: '   ' }).z, '   ', '全空格原样留着')
  eq(coerceNumberArgs(params, { z: null }).z, null, 'null 不动')
  eq(coerceNumberArgs(params, { z: undefined }).z, undefined, 'undefined 不动')
  eq(coerceNumberArgs(params, { z: Infinity }).z, Infinity, '真 Infinity 不动（不是字符串）')

  const same = { x: 1 }
  ok(coerceNumberArgs(params, same) === same, '没改动时返回**原对象引用**（不白造对象）')
  const unknown = { whatever: '-32' }
  ok(coerceNumberArgs(params, unknown) === unknown, '严格表里没有的键不动')
  const arr = ['-32']
  ok(coerceNumberArgs(params, arr) === arr, '数组入参原样返回')
  ok(coerceNumberArgs(undefined, { z: '-32' }).z === '-32', '参数表缺失时一个都不转')
}

/* ───────────────────────── ③ 闭环：注册 → 调用 ───────────────────────── */
section('③ 闭环：宽松表注册的工具，字符串入参能进 execute 且拿到 number')
{
  const strict = { z: { type: 'number', description: '坐标' } }
  let seen = null
  const tolerant = builtinDefineTool({
    name: 'probe_tolerant',
    description: '探针',
    output: { schema: { type: 'string' } },
    parameters: loosenNumberParams(strict),
    async execute (rawArgs) {
      const args = coerceNumberArgs(strict, rawArgs)
      seen = args
      return { ok: true, z: args.z, type: typeof args.z }
    },
  })
  let threw = null
  try {
    // 宿主（内置等价实现）先按注册的那份表校验；宽松表里 z 是"任意 JSON"，字符串能过
    const r = await tolerant.execute({ z: '-32' }, {})
    ok(r.ok === true, '字符串入参没有被校验层拒掉（当前报错的那种情况已消失）')
    eq(seen.z, -32, 'execute 之前已经转成 number（下游拿到的是数字）')
    eq(r.type, 'number', 'typeof 确实是 number')
  } catch (e) { threw = e }
  if (threw) ok(false, '宽松表下不该抛错', String(threw?.message ?? threw))

  /* 对照：同一份表**不宽松**时，字符串在校验层就被拒（说明这一层真的在起作用） */
  const strictTool = builtinDefineTool({
    name: 'probe_strict',
    description: '对照组',
    output: { schema: { type: 'string' } },
    parameters: strict,
    async execute (args) { return { z: args.z } },
  })
  let strictErr = null
  try { await strictTool.execute({ z: '-32' }, {}) } catch (e) { strictErr = e }
  ok(strictErr !== null, '对照组：严格表 + 字符串确实被拒（修复前就是这样）')
  ok(/must be a number/.test(String(strictErr?.message ?? '')) && /invalid arguments/.test(String(strictErr?.message ?? '')),
    '对照组报错文案与用户贴的一致（invalid arguments: "z" must be a number）', String(strictErr?.message ?? ''))
  ok(strictErr?.code === 'INVALID_ARGS', '对照组错误码 INVALID_ARGS')
}

/* ───────────────────────── ④ 静态：接线没接歪 ───────────────────────── */
section('④ 静态：asTool 两条都接了，严格表还是 number')
{
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  ok(/import \{[^}]*loosenNumberParams[^}]*coerceNumberArgs[^}]*\} from '\.\/src\/tool-def\.mjs'/.test(src),
    'index.js 从 tool-def 里 import 了这两个函数')
  ok(/parameters: loosenNumberParams\(strictParams\)/.test(src), '注册时把参数表换成宽松表')
  ok(/const args = coerceNumberArgs\(strictParams, rawArgs\)/.test(src), 'execute 前先把数字字符串转出来')
  ok(/const strictParams = spec\?\.parameters/.test(src), '严格表留在闭包里（宽松只给宿主看）')
  const numberParams = (src.match(/type: 'number'/g) ?? []).length
  ok(numberParams > 40, `严格表里仍然大量使用 type:'number'（${numberParams} 处，意图没被改掉）`)
  const jsonParams = (src.match(/type: 'json'/g) ?? []).length
  ok(jsonParams === 1, `严格表没有被就地改成 json（index.js 里 type:'json' 只剩 mc_admin_config 的 value 那一处，实际 ${jsonParams} 处）`)
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
