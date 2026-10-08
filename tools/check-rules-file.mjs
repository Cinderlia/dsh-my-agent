/**
 * 自检：**规则放在文件里，让每个新会话直接去读文件**
 * （起因 = 用户 m15520 原文：「把规则放在文件里，让每个新会话直接去读文件」）
 *
 * 验的是行为，不是配置项：
 *   ① 记忆根里会建出 `版本提示.md`（默认内容带版本号与那两条规矩），并且**新会话根从基根播种**它
 *      —— 用户改过的那份不能被内置默认盖掉；
 *   ② 注入的那两条提示词**只剩一行指针**（文件绝对路径 + 读法），正文不再进提示词
 *      —— 这是省 token 的关键：正文只在"读的那一刻"占上下文；
 *   ③ 设置页接口能**读/改/恢复** `版本提示.md`（`target:"version"`），且**不碰 RULES.md**（两份独立）；
 *   ④ 「随版本更新」对它是**文件级**语义：第一次遇到只记版本、版本变了才替换、开关关着不替换；
 *   ⑤ 它和 RULES.md 一样是**受保护文件**（MC 模式 AI 可读不可写）。
 *
 * 🔴 必须从包目录跑（源码树里 `import '../index.js'` 会缺 mineflayer 依赖）：
 *      cd <profile>/node_modules/dsh-mc-agent && node tools/check-rules-file.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本套件要静态扫的两个源文件（**按脚本自身定位**，别用 cwd 拼 `..`） */
const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = { index: join(HERE, '..', 'index.js'), client: join(HERE, '..', 'client.js') }

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label + (extra !== undefined ? ' → ' + extra : '')) }
}
const section = (t) => console.log('\n' + t)

const TMP = []
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); TMP.push(d); return d }
const rd = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }

/** 起一套假宿主 + 假状态目录（照 check-session-memory.mjs），返回注册好的工具/路由 */
async function boot ({ perSession = false } = {}) {
  const state = mk('wc-rulesfile-state-')
  const base = join(state, 'mem')          // 记忆**基根**
  const ws = mk('wc-rulesfile-ws-')
  mkdirSync(base, { recursive: true })
  writeFileSync(join(base, 'RULES.md'), '# 用户的准则\n自定义内容，不能被内置默认盖掉\n', 'utf8')
  writeFileSync(join(base, '版本提示.md'), '# 我的版本提示\n这是 Master 改过的那份\n', 'utf8')
  writeFileSync(join(base, 'auto.json'), '{"enabled":true}', 'utf8')
  const cfg = { memoryDir: base }
  if (perSession) cfg.memoryPerSession = true
  writeFileSync(join(state, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8')
  process.env.DSH_MC_AGENT_DIR = state
  delete process.env.DSH_MC_AGENT_MEMORY_DIR

  const tools = new Map()
  const routes = []
  const logs = []
  const agent = { id: 'session-abc123', session: { header: { cwd: ws } } }
  const fakeCtx = {
    logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), debug: (m) => logs.push(String(m)) },
    tools: { register: (d) => { tools.set(d.name, d); return () => {} }, guard: () => () => {} },
    agentPresets: { composedPreset: () => null, authorable: true, defaultId: 'standard', roots: [], list: async () => [], copy: async () => {} },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    workspaceRegistry: { archiveSession: async () => {} },
    systemPrompt: { context: () => () => {}, section: () => () => {}, getContextOrder: () => 100, getSectionOrder: () => 100 },
    inject: () => {},
    effect: (fn) => { try { fn() } catch (e) { logs.push('[effect] ' + e.message) } },
    set: () => {},
    get: (k) => (k === 'agents'
      ? { get: (sid) => (String(sid) === 'session-abc123' ? agent : null) }
      : undefined),
    on: () => () => {},
  }
  const mod = await import('../index.js')
  mod.apply(fakeCtx, mod.Config ? mod.Config({}) : {})
  return { state, base, ws, tools, routes, logs, agent }
}

/**
 * 调插件注册的 HTTP 路由（假 req/res；host 用回环，过 isTrustedRequest）。
 * `body` 给了就模拟 POST/PUT/DELETE 的请求体：`readJsonBody` 用 `req.on('data'/'end')` 读，
 * 所以这里把监听器记下来、等它挂上再把 body 喂进去（最多等 1 秒）。
 */
async function callRoute (route, method, url, body) {
  let status = 0
  let out = ''
  const res = { writeHead: (s) => { status = s }, end: (d) => { out += d ?? '' }, setHeader: () => {} }
  const listeners = {}
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:9999' },
    on: (ev, fn) => { (listeners[ev] ??= []).push(fn); return req },
    once: (ev, fn) => { (listeners[ev] ??= []).push(fn); return req },
    destroy: () => {},
  }
  const done = (async () => {
    try { await route.handler(req, res) } catch (e) { return { status, body: out, json: null, err: e } }
    let json = null
    try { json = JSON.parse(out) } catch {}
    return { status, body: out, json }
  })()
  if (body !== undefined) {
    const chunk = JSON.stringify(body)
    let tries = 0
    const feed = () => {
      const ends = listeners.end ?? []
      if (!ends.length) { if (++tries < 500) setTimeout(feed, 2); return }
      for (const fn of listeners.data ?? []) fn(chunk)
      for (const fn of ends) fn()
    }
    setTimeout(feed, 0)
  }
  return done
}

const apiRoute = (h) => h.routes.find((r) => String(r.path ?? '').startsWith('/api/mc'))
const q = (ws) => `cwd=${encodeURIComponent(ws)}&sessionId=session-abc123`

/* ─────────────── ① 记忆根里的 版本提示.md（含新会话播种） ─────────────── */
section('① 记忆根里有 `版本提示.md`；新会话根从基根播种（用户改过的那份不能被盖掉）')
const h = await boot({ perSession: true })
{
  const route = apiRoute(h)
  ok(!!route, '注册了 /api/mc 路由')
  const r = await callRoute(route, 'GET', '/api/mc/agents-md?' + q(h.ws))
  ok(r.status === 200 && r.json?.ok === true, 'GET /api/mc/agents-md 成功', 'status=' + r.status + ' body=' + String(r.body).slice(0, 160))
  const vp = r.json?.versionPrompt ?? {}
  const sessVp = join(h.base, 'sessions', 'abc123', '版本提示.md')
  ok(vp.path === sessVp, `versionPrompt.path 指向会话记忆根：${sessVp}`, vp.path)
  ok(existsSync(sessVp), '文件真的建出来了')
  ok(rd(sessVp) === rd(join(h.base, '版本提示.md')), '内容是**基根那份**（播种过来的，不是内置默认）', String(rd(sessVp)).slice(0, 40))
  ok(vp.source === 'custom' && vp.isDefault === false, 'source 判成 custom（内容 ≠ 内置默认）', JSON.stringify({ source: vp.source, isDefault: vp.isDefault }))
  ok(String(vp.text ?? '').includes('Master 改过的那份'), '接口回的是**文件内容**（不是硬编码字符串）', String(vp.text ?? '').slice(0, 40))
  ok(String(vp.defaultText ?? '').includes('dsh-mc-agent 版本提示'), 'defaultText 给了内置那份（前端"看内置默认"用）', String(vp.defaultText ?? '').slice(0, 40))
  ok(String(vp.defaultText ?? '').includes('mc_command'), '内置默认里还是那两条规矩（mc_command / express）')
  ok(String(vp.defaultText ?? '').includes('mc_kit_express'), '内置默认里带着 mc_kit_express 那条')
  ok(typeof vp.versionPromptVersion === 'string' && vp.versionPromptVersion.length > 0, '记了"这份内容对应哪个版本"', vp.versionPromptVersion)
  ok(r.json?.injection?.files?.versionPrompt?.path === sessVp, 'promptInjectionStatus.files 里也报了它', JSON.stringify(r.json?.injection?.files?.versionPrompt ?? null))
}

/* ─────────────── ② 改 / 恢复默认：两份文件互不干扰 ─────────────── */
section('② 设置页改/恢复 `版本提示.md`（target:"version"），**不碰 RULES.md**')
{
  const route = apiRoute(h)
  const sessVp = join(h.base, 'sessions', 'abc123', '版本提示.md')
  const sessRules = join(h.base, 'sessions', 'abc123', 'RULES.md')
  const rulesBefore = rd(sessRules)
  const put = await callRoute(route, 'PUT', '/api/mc/agents-md?' + q(h.ws), { sessionId: 'session-abc123', target: 'version', text: '# 改过的版本提示\n新规矩：先问用户\n' })
  ok(put.status === 200 && put.json?.ok === true, 'PUT target:"version" 成功', 'status=' + put.status + ' body=' + String(put.body).slice(0, 160))
  ok(put.json?.target === 'version', '返回里标了 target:"version"', JSON.stringify(put.json?.target))
  ok(String(rd(sessVp)).includes('新规矩：先问用户'), '文件被改掉了', String(rd(sessVp)).slice(0, 40))
  ok(rd(sessRules) === rulesBefore, 'RULES.md 一个字节没动（两份独立）')

  const g2 = await callRoute(route, 'GET', '/api/mc/agents-md?' + q(h.ws))
  ok(g2.json?.versionPrompt?.source === 'custom', 'GET 回读：source=custom', g2.json?.versionPrompt?.source)

  const putRules = await callRoute(route, 'PUT', '/api/mc/agents-md?' + q(h.ws), { sessionId: 'session-abc123', text: '# 只改 RULES\n' })
  ok(putRules.json?.target === 'rules', '不带 target = 改 RULES.md（老行为不变）', JSON.stringify(putRules.json?.target))
  ok(String(rd(sessVp)).includes('新规矩：先问用户'), '改 RULES.md 不会碰到 版本提示.md')

  const del = await callRoute(route, 'DELETE', '/api/mc/agents-md?' + q(h.ws), { sessionId: 'session-abc123', target: 'version' })
  ok(del.status === 200 && del.json?.ok === true, 'DELETE target:"version" 成功', 'status=' + del.status + ' body=' + String(del.body).slice(0, 160))
  ok(String(rd(sessVp)).startsWith('# dsh-mc-agent 版本提示'), '恢复成了内置默认（首行是文件标题）', String(rd(sessVp)).slice(0, 40))
  const g3 = await callRoute(route, 'GET', '/api/mc/agents-md?' + q(h.ws))
  ok(g3.json?.versionPrompt?.source === 'default' && g3.json?.versionPrompt?.isDefault === true, '回读：source=default', JSON.stringify({ s: g3.json?.versionPrompt?.source }))
}

/* ─────────────── ③ 没有工作区：只读、还是能看见内置那份 ─────────────── */
section('③ 没有工作区时：只读，但照样能看到内置那份（跟工作区无关）')
{
  const route = apiRoute(h)
  const r = await callRoute(route, 'GET', '/api/mc/agents-md?sessionId=session-不存在')
  ok(r.status === 200 && r.json?.readOnly === true && r.json?.hasWorkspace === false, '无工作区 → readOnly', JSON.stringify({ status: r.status, readOnly: r.json?.readOnly, hasWorkspace: r.json?.hasWorkspace }))
  ok(r.json?.versionPrompt?.path === null, '没有文件路径（无工作区）', String(r.json?.versionPrompt?.path))
  ok(String(r.json?.versionPrompt?.text ?? '').includes('dsh-mc-agent 版本提示'), '正文 = 内置默认', String(r.json?.versionPrompt?.text ?? '').slice(0, 30))
}

/* ─────────────── ④ 「随版本更新」的文件级语义（真跑模块） ─────────────── */
section('④ syncVersionPrompt：第一次只记版本、版本变了才替换、开关关着不替换')
const vpm = await import('../src/version-prompt.mjs')
const wsc = await import('../src/wsconfig.mjs')
{
  const d = mk('wc-rulesfile-sync-')
  ok(vpm.VERSION_PROMPT_FILE === '版本提示.md', 'VERSION_PROMPT_FILE = 版本提示.md', vpm.VERSION_PROMPT_FILE)
  ok(vpm.versionPromptPath(d) === join(d, '版本提示.md'), 'versionPromptPath 拼在记忆根根级')
  ok(!existsSync(join(d, '版本提示.md')), '一开始没有文件')
  const s1 = vpm.syncVersionPrompt(d, '0.2.0', { follow: true })
  ok(s1.action === 'created', '第一次 = created（建默认 + 记版本）', JSON.stringify(s1))
  ok(existsSync(join(d, '版本提示.md')), '文件建出来了')
  ok(vpm.readVersionPrompt(d, '0.2.0').source === 'default', '内容 = 内置默认')
  ok(wsc.readVersionPromptVersion(d) === '0.2.0', 'config.json 里记了 versionPromptVersion', String(wsc.readVersionPromptVersion(d)))
  ok(wsc.readRulesVersion(d) === null, 'rulesVersion 没被顺手写上（两个标记独立）', String(wsc.readRulesVersion(d)))

  vpm.writeVersionPrompt(d, '# 我自己改的\n', '0.2.0')
  ok(vpm.readVersionPrompt(d, '0.2.0').source === 'custom', '用户改过 → custom')
  const s2 = vpm.syncVersionPrompt(d, '0.2.0', { follow: true })
  ok(s2.action === 'kept' && String(rd(join(d, '版本提示.md'))).includes('我自己改的'), '版本没变 → kept（不动内容）', JSON.stringify(s2))

  const s3 = vpm.syncVersionPrompt(d, '0.2.1', { follow: true })
  ok(s3.action === 'replaced' && s3.from === '0.2.0' && s3.to === '0.2.1', '版本变了 + 开关开 → replaced', JSON.stringify(s3))
  ok(vpm.readVersionPrompt(d, '0.2.1').source === 'default', '替换后内容 = 本版本的默认（source 回 default）')

  vpm.writeVersionPrompt(d, '# 又改了一次\n', '0.2.1')
  const s4 = vpm.syncVersionPrompt(d, '0.2.2', { follow: false })
  ok(s4.action === 'kept' && String(rd(join(d, '版本提示.md'))).includes('又改了一次'), '开关关着 → kept（保留用户改的）', JSON.stringify(s4))
  ok(wsc.readVersionPromptVersion(d) === '0.2.2', '但版本标记照样更新到 0.2.2', String(wsc.readVersionPromptVersion(d)))

  const d2 = mk('wc-rulesfile-sync2-')
  writeFileSync(join(d2, '版本提示.md'), '# 手工放的\n', 'utf8')
  const s5 = vpm.syncVersionPrompt(d2, '9.9.9', { follow: true })
  ok(s5.action === 'marked' && String(rd(join(d2, '版本提示.md'))).includes('手工放的'), '有文件、没标记 → marked（只记版本，不覆盖）', JSON.stringify(s5))

  const d3 = mk('wc-rulesfile-sync3-')
  vpm.syncVersionPrompt(d3, '0.2.0', { follow: true })                 // 建默认
  vpm.syncVersionPrompt(d3, '0.2.1', { follow: false })               // 升级但开关关着：内容不动
  ok(vpm.readVersionPrompt(d3, '0.2.1').source === 'default', '🔴 升级 + 开关关着：内容还是默认，source 不该被判成 custom（判据跨版本稳定）', vpm.readVersionPrompt(d3, '0.2.1').source)

  let threw = false
  try { vpm.writeVersionPrompt(d2, '   ', '9.9.9') } catch { threw = true }
  ok(threw, '写空内容被拒（想恢复默认要用 resetVersionPrompt）')
  vpm.resetVersionPrompt(d2, '9.9.9')
  ok(vpm.readVersionPrompt(d2, '9.9.9').source === 'default', 'resetVersionPrompt 恢复默认')

  const t0 = vpm.versionPromptText('1.2.3')
  ok(t0.startsWith('# dsh-mc-agent 版本提示'), '默认正文首行是文件标题', t0.split('\n')[0])
  ok(!/v\d+\.\d+\.\d+/.test(t0), '🔴 正文里**没有版本号**（版本由来源行 / 折叠标题 / config.json 标记携带 —— 这样 source 判据跨版本稳定）')
  ok(t0.includes('以本文件为准') || t0.includes('以文件为准'), '正文写明"以本文件为准"')
  ok(t0.includes('/tp') && t0.includes('/setblock') && t0.includes('.express/') && t0.includes('mc_kit_express'), '两条规矩的正文还在（/tp /setblock .express/ mc_kit_express）')
  ok(vpm.versionPromptHash('1.2.3') === vpm.versionPromptHash('1.2.4'), '不同版本的默认正文哈希**相同**（哈希只标记这段文字本身）')
  ok(vpm.versionPromptSource('1.2.3') === 'dsh-mc-agent@1.2.3（版本提示文件）', '来源行标明"版本提示文件"且带版本号', vpm.versionPromptSource('1.2.3'))
}

/* ─────────────── ⑤ 受保护文件（MC 模式 AI 只读） ─────────────── */
section('⑤ `版本提示.md` 与 RULES.md 同一套保护：MC 模式 AI 可读不可写')
const prot = await import('../src/protected.mjs')
{
  ok(prot.PROTECTED_FILES.includes('版本提示.md'), 'PROTECTED_FILES 里有它', prot.PROTECTED_FILES.join('/'))
  ok(prot.isProtectedName('版本提示.md') === true, 'isProtectedName 认它')
  ok(prot.isProtectedPathArg('版本提示.md') === true, '裸名算（记忆工具的相对路径）')
  ok(prot.isProtectedPathArg('E:\\ws\\.dsh-mc-agent\\版本提示.md') === true, '带 .dsh-mc-agent 段的绝对路径也算')
  ok(prot.isProtectedPathArg('sub/版本提示.md') === false, '嵌套目录里的同名文件不算（可以正常读写）')
  ok(prot.rejectionText().includes('版本提示.md'), '拒绝文案里点名了它', prot.rejectionText().slice(0, 60))
}

/* ─────────────── ⑥ 静态接线：注入只剩指针（正文不再进提示词） ─────────────── */
section('⑥ 注入只剩一行指针：正文不在 index.js 的提示词里')
const stripComments = (s) => s.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
{
  const src = stripComments(rd(SRC.index) ?? '')
  ok(src.includes('const rulesPointerText = ({ abs, fileName, what }) =>'), '有 rulesPointerText() 组装指针')
  ok(src.includes('mc_kit_memory {action:"read", path:"${fileName}"}'), '指针给了 mc_kit_memory 的读法')
  ok(src.includes('read {file_path:"${abs}"}'), '指针给了 read 的读法（绝对路径）')
  ok(src.includes('开工前先读一遍'), '指针写着"开工前先读一遍"')
  ok(src.includes('rel: \'.dsh-mc-agent/RULES.md\',\n        title: \'提示词注入：.dsh-mc-agent/RULES.md\',\n        text: rulesPointerText({'), 'RULES.md 那条投的是指针（不是正文）')
  ok(src.includes('title: versionPromptTitle(PLUGIN_VERSION),\n        text: rulesPointerText({'), '版本提示那条投的也是指针（不是正文）')
  ok(!src.includes('text: versionPromptText()'), '不再把版本提示正文直接塞进提示词')
  ok(!src.includes('【dsh-mc-agent 行事准则（'), '不再把行事准则正文直接塞进提示词')
  ok(src.includes("SESSION_SEED_FILES = ['RULES.md', '版本提示.md', 'config.json', 'auto.json', 'view.json']"), '新会话播种清单里有 版本提示.md')
  ok(src.includes('const vpsync = syncVersionPrompt(root, PLUGIN_VERSION'), '建档时按版本同步它')
  ok(src.includes('已写入默认版本提示：'), '建档日志有它（好排查）')
  ok(src.includes("const isVersion = String(body.target ?? 'rules') === 'version'"), '接口按 target 区分两份文件')
  ok(src.includes('writeVersionPrompt(promptDir, body.text, PLUGIN_VERSION)'), 'PUT 能改 版本提示.md')
  ok(src.includes('resetVersionPrompt(promptDir, PLUGIN_VERSION)'), 'DELETE 能恢复它')
  ok(src.includes('const vpPath = root ? versionPromptPath(root) : null'), 'promptInjectionStatus 里报了它的路径')
  ok(src.includes('defaultText: versionPromptText(PLUGIN_VERSION)'), '接口回了内置默认（前端"看内置默认"用）')
}

/* ─────────────── ⑦ 静态接线：设置页可编辑 ─────────────── */
section('⑦ 设置页：版本提示从"只读展示"改成"可编辑"')
{
  const src = stripComments(rd(SRC.client) ?? '')
  ok(src.includes('vpText, onVpText, onVpSave, onVpReset'), 'PromptPane 收了这四个 props')
  ok(src.includes("run('vp:save', () => apiPut('/api/mc/agents-md', { text: vpText, sessionId, target: 'version' })"), '保存走 target:"version"')
  ok(src.includes("run('vp:reset', () => apiDelete('/api/mc/agents-md', { sessionId, target: 'version' })"), '恢复默认走 target:"version"')
  ok(src.includes('setVpText(String(m.versionPrompt?.text ?? \'\'))'), 'load() 把文件内容灌进输入框')
  ok(src.includes('看内置默认（「恢复默认」用的就是这一份）'), '给了"看内置默认"的折叠')
  ok(src.includes('注入只投一行指针，正文由会话自己去读'), '界面把"只投指针"写清了')
  ok(src.includes("mark(seg['version-prompt'])"), '"本会话注入"那行也显示 版本提示.md 的状态')
}

/* ─────────────── 收尾 ─────────────── */
for (const d of TMP) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
