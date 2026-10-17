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
const SRC = { index: join(HERE, '..', 'index.js'), client: join(HERE, '..', 'client.js'), agentsmd: join(HERE, '..', 'src', 'agentsmd.mjs'), config: join(HERE, '..', 'src', 'config.mjs'), commands: join(HERE, '..', 'src', 'commands.mjs') }

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
  /* 🔴 2026-10-15：「提示词」页分成上下两块之后，PUT/DELETE 的目标目录由 `scope` 决定 ——
   *    `session`（默认）= 本会话那份、`default` = **基根**那份（新会话的种子）。
   *    版本提示只有会话那一份，所以 `scope:'default'` 对它**不生效**（`&& !isVersion`）。 */
  ok(src.includes('const dir = (scope === \'default\' && !isVersion) ? baseDir : sessionDir'),
    '写入目标按 scope 选目录（版本提示不走 default）')
  ok(src.includes('writeVersionPrompt(dir, body.text, PLUGIN_VERSION)'), 'PUT 能改 版本提示.md')
  ok(src.includes('resetVersionPrompt(dir, PLUGIN_VERSION)'), 'DELETE 能恢复它')
  ok(src.includes('const vpPath = root ? versionPromptPath(root) : null'), 'promptInjectionStatus 里报了它的路径')
  ok(src.includes('defaultText: versionPromptText(PLUGIN_VERSION)'), '接口回了内置默认（前端"看内置默认"用）')
}

/* ─────────────── ⑦ 静态接线：版本提示不再有界面入口 ─────────────── */
section('⑦ 设置页：版本提示不再有编辑入口（用户 2026-10-15「这两个去掉」）')
{
  const src = stripComments(rd(SRC.client) ?? '')
  ok(!src.includes('vpText, onVpText, onVpSave, onVpReset'), 'PromptPane 不再收版本提示那四个 props')
  ok(!src.includes('setVpText('), 'load() 不再灌版本提示的输入框')
  ok(!src.includes('data-wc-verprompt'), '「版本提示」那一块整个不在了（连它的 CSS 一起）')
  ok(!src.includes("run('vp:save'") && !src.includes("run('vp:reset'"),
    '两个写动作也删干净了（不留死代码）')
  ok(!src.includes('看内置默认'),
    '「默认提示词」那块也不再给"看内置默认"的折叠（用户 2026-10-15「这个去掉」）')
  ok(String(rd(join(HERE, '..', 'index.js')) ?? '').includes('builtinText: DEFAULT_AGENTS_MD'),
    '（接口仍然回着 builtinText —— 只是界面上不再展示）')
  /* 🔴 2026-10-15 审计（client.js 报告第 1 条）：写接口以前写死 `'/api/mc/agents-md'`
     且只把 `sessionId` 塞进 body —— 服务端 `gateOf()` 是
     `settingsGate(query.sessionId ?? b?.sessionId, query.cwd ?? b?.cwd)`，**它认 `cwd`**。
     会话还没落盘时（新对话页）定位不到工作区，用户看到"提示词看得到、存不进去"。
     现在统一走 `withSid(...)`（它把 `sessionId` + `cwd` 都拼进 query）。 */
  ok(src.includes("run('md:save', () => apiPut(withSid('/api/mc/agents-md'), { text: mdText, sessionId })"), 'RULES.md 保存走 withSid（带上 cwd）')
  ok(src.includes("run('md:reset', () => apiDelete(withSid('/api/mc/agents-md'), { sessionId, from: 'default' })"),
    'RULES.md 恢复默认也走 withSid（且现在是"从默认重新播种"）')
  ok(!src.includes("apiPut('/api/mc/agents-md'") && !src.includes("apiDelete('/api/mc/agents-md'"),
    '🔴 写接口不再有裸路径（裸路径 = 不带 cwd ⇒ 新会话页存不进去）')
  ok(src.includes("mark(seg['version-prompt'])"), '"本会话注入"那行仍显示 版本提示.md 的状态（文件还在注入）')
}

/* ─────────────── ⑦b 「提示词」页分成上下两块（2026-10-15，用户点名）───────────────
 * 用户原话：「把mc设置里的提示词优化一下，分为会话提示词和默认提示词。」
 *   · 上 = **默认提示词** = **基根**那份（`<memoryDir>/RULES.md`）。新会话的记忆根是
 *     `seedSessionRoot()` 从基根**拷** RULES.md 播种的 ⇒ 改它只影响**以后**的会话。
 *   · 下 = **会话提示词** = 本会话那份（`memoryRootFor()`）。
 * 两块都可编辑；「会话提示词 → 恢复为默认」= 用**基根那份**重新播种（不是出厂值）。 */
section('⑦b 提示词页分两块：默认提示词（基根）+ 会话提示词')
{
  const idx = stripComments(rd(SRC.index) ?? '')
  const src = stripComments(rd(SRC.client) ?? '')
  // —— 服务端：GET 要同时回两块 ——
  ok(idx.includes('const baseDir = memoryBaseFor(cwd)'), 'GET 里取到**基根**目录（默认提示词那一块）')
  ok(idx.includes('const baseCur = readAgentsMd(baseDir)'), '读了基根那份 RULES.md')
  ok(idx.includes('sharedWithSession: baseDir === promptDir'),
    '🔴 没开 memoryPerSession 时如实标记"两块是同一份文件"')
  ok(idx.includes('builtinText: DEFAULT_AGENTS_MD'), '回了出厂那份（前端"看内置默认"用）')
  ok(idx.includes('text: baseCur.text,') && idx.includes('exists: existsSync(baseCur.path),'),
    '回参里有 default 那一块（含基根那份的正文与"在不在"）')
  // —— 服务端：写入按 scope 选目录 ——
  ok(idx.includes('const sessionDir = memoryRootFor(gate.cwd, agentIdOf(safeAgentById(sessionId)))'),
    '写分支把会话目录单独取出来')
  ok(idx.includes("const scope = String(body.scope ?? 'session') === 'default' ? 'default' : 'session'"),
    '收 scope（默认 session）')
  ok(idx.includes('const dir = (scope === \'default\' && !isVersion) ? baseDir : sessionDir'),
    'scope=default 写基根')
  ok(idx.includes("if (String(body.from ?? '') === 'default')"), 'DELETE 支持 from=default（重新播种）')
  ok(idx.includes('copyFileSync(src, dst)'), '重新播种就是**拷基根那份**过去')
  ok(idx.includes('if (src === dst)'), '🔴 两块同一文件时不拷自己（会 EBUSY/EPERM）')
  ok(idx.includes('默认提示词那份文件还不存在'), '基根那份不在时给一句能懂的话')
  // —— 客户端：两块各自的状态与动作 ——
  ok(src.includes('const [dfText, setDfText] = React.useState(\'\')'), 'dfText 进了 state')
  ok(src.includes('const [dfInfo, setDfInfo] = React.useState(null)'), 'dfInfo 进了 state')
  ok(src.includes("setDfText(String(m.default?.text ?? ''))"), 'load() 把默认那份灌进输入框')
  ok(src.includes("setDfInfo(m.default ?? null)"), 'load() 记下默认那块的元信息')
  ok(src.includes("run('df:save', () => apiPut(withSid('/api/mc/agents-md'), { text: dfText, sessionId, scope: 'default' })"),
    '默认那块的保存走 scope:"default"')
  ok(src.includes("run('df:reset', () => apiDelete(withSid('/api/mc/agents-md'), { sessionId, scope: 'default' })"),
    '默认那块的恢复走 scope:"default"')
  ok(src.includes('dfText, dfInfo, dfReady, onDfText, onDfSave, onDfReset'), 'PromptPane 收了这六个 props')
  /* 🔴 服务端还没重载时（宿主没重启），GET 回的仍是旧形状 ⇒ 读不到内容。
     这时**必须挡住保存**：旧服务端不认 `scope:'default'`，会把它写进**本会话**那份 ——
     看着像"改默认"，其实是把当前会话覆盖了。 */
  ok(src.includes('const [dfReady, setDfReady] = React.useState(true)'), 'dfReady 进了 state（服务端有没有回 default 那块）')
  ok(src.includes('setDfReady(m.default != null)'), 'load() 按"回没回 default"判定')
  ok(src.includes('disabled: busy || !dfReady'), '🔴 服务端没重载时输入框是禁用的')
  ok(src.includes('hasWorkspace && dfReady'), '🔴 服务端没重载时保存/恢复按钮不出现')
  ok(src.includes('if (!dfReady) {') && src.includes('现在保存会写进当前会话那份，先别存。'),
    '🔴 动作层也硬拒（按钮藏了不算，回调也可能被别处叫到）')
  ok(src.includes("'data-wc-defprompt': ''") && src.includes("'data-wc-sessionprompt': ''"),
    '两个块各有一个可定位的容器')
  ok(src.includes('以后新建的会话用的就是这一份'), '默认那块写清"只影响以后新建的会话"')
  ok(src.includes('本会话正在用的那份'), '会话那块写清"就是本会话"')
  ok(src.includes("onClick: () => setConfirmDfReset(true)"), '默认那块的恢复要二次确认')
  ok(src.includes("title: '用上面「默认提示词」那一份重新播种本会话'"),
    '会话那块的「恢复为默认」= 用上面那块（不是出厂值）')
  ok(src.includes("'⚠️ 「记忆按会话分」没开"), '两块同一文件时界面上有警示')
  ok(!src.includes('看内置默认'), '默认那块不再给"看内置默认"的折叠（用户 2026-10-15 去掉）')
  ok(!src.includes("title: '恢复默认提示词'"), '旧的单个「恢复默认」按钮已经不在')
}

/* ─────────────── ⑦c 「随版本更新」只动默认提示词（用户 2026-10-15） ─────────────── */
section('⑦c 「随版本更新」只动默认提示词（基根），会话那份不碰')
{
  const idx = stripComments(rd(SRC.index) ?? '')
  const src = stripComments(rd(SRC.client) ?? '')
  const md = stripComments(rd(SRC.agentsmd) ?? '')
  // —— 服务端：同步目标是**基根**，不是会话根 ——
  ok(idx.includes('const syncDir = memoryBaseFor(cwd)'), '🔴 同步目标是**基根**（=「默认提示词」那份）')
  ok(/syncRulesVersion\(syncDir, PLUGIN_VERSION, \{\s*follow: workspaceConfigValues\(root\)\.rulesFollowVersion !== false,\s*backup: true\s*\}\)/.test(idx),
    '🔴 同步的是 syncDir（基根）且开了备份')
  ok(!/syncRulesVersion\(root, PLUGIN_VERSION, \{ follow: workspaceConfigValues\(root\)\.rulesFollowVersion !== false \}\)/.test(idx),
    '🔴 旧的"同步会话根"那条已经不在')
  ok(/syncRulesVersion\(root, PLUGIN_VERSION, \{ follow: false \}\)/.test(idx),
    '会话根只**记版本**（follow:false = 内容一个字不动），页面上"当前内容对应：v…"才不会僵住')
  ok(idx.includes('默认提示词**（基根那份）已替换为新版本默认内容'), '替换时日志点名"默认提示词"，并说明本会话没动')
  // —— 模块：备份 ——
  ok(md.includes('{ follow = true, backup = false } = {}'), 'syncRulesVersion 收了 backup 选项')
  ok(md.includes('`${p}.bak-${from ?? \'unknown\'}`'), '备份名带旧版本号')
  ok(md.includes('copyFileSync(p, cand)'), '覆盖前先拷一份')
  ok(md.includes("...(backupPath ? { backup: backupPath } : {})"), '回参里带上备份路径')
  // —— 客户端：开关的说明跟着改 ——
  ok(src.includes('用新版本默认内容替换「默认提示词」那一块') && src.includes('「会话提示词」不动'),
    '🔴 开关说明写清"只动默认那块"')
  ok(!src.includes('用新版本的默认提示词替换当前内容'), '旧的"替换当前内容"说法已经不在')
}

/* ─────────────── ⑦d 第三方账户的「编辑」（用户 2026-10-15 报的 bug） ─────────────── */
section('⑦d 第三方账户点「编辑」走自己的表单，不是离线表单')
{
  const idx = stripComments(rd(SRC.index) ?? '')
  const src = stripComments(rd(SRC.client) ?? '')
  /* 🔴 用户原话：「我用的是第三方皮肤站账号，点编辑进去还是离线账号」——
     路由只分了 microsoft / 其它，第三方被归进 edit-offline（那个表单没有服务器和密码，
     一保存就把账户写成了离线）。 */
  ok(/acc\.type === 'microsoft' \? 'edit-microsoft' : acc\.type === 'yggdrasil' \? 'edit-yggdrasil' : 'edit-offline'/.test(src),
    '🔴 路由按三种类型分档（第三方有自己那一档）')
  ok(src.includes("view === 'new-yggdrasil' || view === 'edit-yggdrasil'"), '第三方表单同时接新建与编辑')
  ok(src.includes("const { servers = [], busyKey, mode = 'new', account } = props"), '表单收了 mode / account')
  ok(src.includes("editing ? '编辑第三方账户' : '新建第三方账户'"), '标题跟着换')
  ok(src.includes("editing ? '保存中…' : '创建中…'"), '按钮文案跟着换')
  ok(src.includes("'密码（留空 = 不改）'"), '🔴 编辑时密码留空 = 不改（标签上写出来）')
  ok(src.includes('if (!editing && !hasPass) missing.push(\'密码\')'), '🔴 编辑时密码不是必填项')
  ok(src.includes('if (p) payload.password = p'), '🔴 没填密码就不发 password 字段')
  ok(src.includes('...(editing ? {} : { name: fallback })'), '编辑时不拿账号前缀覆盖显示名')
  ok(src.includes('props.onPatch(account.innerID, payload, key)'), '编辑走 PATCH')
  /* 服务端：PATCH 必须像 POST 一样认 serverUrl / password —— 否则 update() 会把它们静默忽略 */
  const a = idx.indexOf("req.method === 'PATCH'")
  const seg = a >= 0 ? idx.slice(a, a + 1400) : ''
  ok(/cur\.type === 'yggdrasil'/.test(seg), '🔴 PATCH 里对第三方账户单独处理')
  ok(/normalizeServerUrl\(String\(body\.serverUrl\)\)/.test(seg), '🔴 PATCH 认 serverUrl（resolve-or-create）')
  ok(/patch\.serverId = serverId/.test(seg), '🔴 PATCH 把解析出来的 serverId 交给 update')
  ok(/if \(body\.password\) await accounts\.setCredential\(innerID/.test(seg), '🔴 PATCH 认 password（留空就不覆盖）')
  ok(/await accounts\.refreshCredentialIndex\(\)/.test(seg), '写完刷一次凭据索引')
  ok(idx.includes('delete patch.password'), 'password 不直接丢给 update（它不认这个字段）')
}

/* ─────────────── ⑧ 静态接线：client.js 审计 10 条（2026-10-15） ─────────────── */
section('⑧ client.js 审计修复的静态接线')
{
  const src = stripComments(rd(SRC.client) ?? '')
  const idx = rd(SRC.index) ?? ''

  /* 🔴 第 2 条：config 读失败被 `.catch` 吞掉 ⇒ `Promise.all` 恒 resolve ⇒ `setLoaded(true)`
     恒执行，而白名单那份 state 还是初始空值 ⇒ 拨任何一个开关都会拿"只有这一条"的名单
     **把服务端真实白名单覆盖掉**。凭证是 `cfgOk`。 */
  ok(src.includes('const [cfgOk, setCfgOk] = React.useState(false)'), '🔴 有 cfgOk 凭证（默认 false）')
  ok(src.includes('setCfgOk(true)'), 'config 读成功才翻 true')
  ok(src.includes('setCfgOk(false)'), 'load() 开头与失败分支都翻回 false')
  ok(src.includes('const cfgBad = cfgOk === false'), 'UI 按 cfgBad 提示')
  ok(/if \(!cfgOk\) \{[\s\S]{0,220}?return Promise\.resolve\(false\)/.test(src),
    '🔴 改白名单 / 存 base 在没读到配置时**硬拒**（不是只把按钮变灰）')
  ok(src.includes('onToggleCmd: toggleCmd') && src.includes('hasWorkspace, cfgOk'),
    'cfgOk 传给了 WhitelistPane 与 SharePane')

  /* 🟡 第 3 条：hero 注入按钮 dispose 竞态 */
  ok(src.includes('let disposed = false'), '🟡 hero 注入器有 disposed 标志')
  ok((src.match(/if \(disposed\) return/g) ?? []).length >= 3, 'place/track/微任务回调都查 disposed')

  /* 🟡 第 4 条：空密码「创建」静默无反应 */
  ok(src.includes('const [hasPass, setHasPass] = React.useState(false)'), '🟡 密码只记布尔（不进 state）')
  ok(src.includes('const missing = []') || src.includes('missing.length'), '🟡 按钮按"还差什么"禁用')

  /* 🟡 第 5 条：强制停止不检查结果 */
  ok(src.includes('const [stopErr, setStopErr] = React.useState('), '🟡 停止失败有地方显示')
  ok(src.includes("j.ok !== true") && src.includes('服务端没有确认停止'),
    '🟡 强制停止**两层都判**（HTTP 与业务 ok）')

  /* 🟡 第 6 条：一次轮询失败就把状态清空 ⇒ 状态条（含唯一入口「强制停止」）消失 */
  ok(src.includes('const [pollFail, setPollFail] = React.useState(0)'), '🟡 轮询失败单独计数，不动 state')
  ok(src.includes('return [state, setState, pollFail]') && src.includes('useMcStatus(sessionId, pollNow)'),
    '🟡 轮询失败不再把 state 置 null')
  ok(src.includes('const pollBad = pollFail >= 2'), '连续失败才提示，且提示"显示的是最后一次读到的状态"')

  /* 🟡 第 7 条：busyKey 单值互相清忙碌态 */
  ok(src.includes('const inflightRef = React.useRef(new Map())'), '🟡 在飞动作按 key 计数')
  ok(src.includes('const syncBusy = React.useCallback('), '🟡 对外忙碌态由计数推出（不是无条件置 null）')

  /* 🟡 第 8 条：连接弹窗账户状态不同步 */
  ok(src.includes('const prevSettingsOpen = React.useRef(false)'), '🟡 盯 settingsOpen 的 true→false 沿')
  ok(src.includes('prevSettingsOpen.current = settingsOpen'), '沿检测实现')

  /* 🟡 第 9 条：preset 名单是模块级变量 ⇒ 异步回来不重渲染 */
  ok(src.includes('const [presetIds, setPresetIds] = React.useState(MC_PRESETS_FALLBACK)'),
    '🟡 preset 名单进 state')
  ok(src.includes('presetIds.includes(preset)'), '门控读 state（不是模块级变量）')
  ok(!/^\s*let mcPresetIds = /m.test(src), '模块级不再有可变的 mcPresetIds')

  /* 🟢 第 10 条：版本门控原来是 `() => null` 的桩 ⇒ 拦截与红标一行都到不了 */
  ok(!src.includes('const describe = '), '🟢 删掉死代码 describe')
  ok(src.includes('function MC_VERSION_IN_RANGE(v)') && src.includes('function mcVersionParts(v)'),
    '🟢 版本门控真实现了（逐段比数字，不是 includes）')
  ok(src.includes("const lanVersionOk = (s) => MC_VERSION_IN_RANGE(s?.version) !== false"),
    '调用点仍是"只有明确 false 才拦"')
  ok(idx.includes('testedVersions: lib.testedVersions') && idx.includes('latestVersion: lib.latest'),
    '🟢 服务端 /api/mc/presets 带上了支持版本范围')
}

/* ─────────── ⑨ 「指令白名单」页：目录 + 开关（用户 2026-10-15） ─────────── */
section('⑨ 指令白名单页改成"列出全部指令 + 每条一个开关"')
{
  const { COMMAND_GROUPS, catalogNames, inCatalog } = await import('../src/commands.mjs')
  const { matchCommandList, isRegexEntry, PluginConfig } = await import('../src/config.mjs')
  const src = stripComments(rd(SRC.client) ?? '')
  const idx = stripComments(rd(SRC.index) ?? '')
  const cfgSrc = stripComments(rd(SRC.config) ?? '')
  const cmdSrc = stripComments(rd(SRC.commands) ?? '')

  /* ① 目录本身 */
  const names = catalogNames()
  ok(Array.isArray(COMMAND_GROUPS) && COMMAND_GROUPS.length >= 5, `目录有 ${COMMAND_GROUPS.length} 个分组`)
  ok(names.length >= 50, `目录里 ${names.length} 条指令`)
  ok(new Set(names).size === names.length, '目录里没有重名')
  ok(COMMAND_GROUPS.every((g) => g.group && Array.isArray(g.items) && g.items.length), '每个分组都有名字和条目')
  ok(COMMAND_GROUPS.every((g) => g.items.every((it) => it.name && it.desc)), '每条都有名字和中文说明')
  ok(COMMAND_GROUPS.some((g) => g.items.some((it) => it.danger === true)), '危险指令有 danger 标记')
  ok(inCatalog('tp') && inCatalog('/tp') && inCatalog('TP') && !inCatalog('nope') && !inCatalog(''),
    'inCatalog 认前导斜杠与大小写、空串回 false')
  ok(cmdSrc.includes('export function catalogNames') && cmdSrc.includes('export function inCatalog'), '两个助手都导出了')
  ok(!/^import /m.test(cmdSrc), 'commands.mjs 是叶子（一行 import 都没有）')

  /* ② 匹配逻辑**只有一份** */
  ok(cfgSrc.includes('export function matchCommandList'), 'matchCommandList 导出了（两个调用方共用）')
  ok((cfgSrc.match(/function matchCommandList/g) ?? []).length === 1, '全文件只定义一次')
  ok(/commandAllowed \(command\) \{[\s\S]{0,200}?return matchCommandList\(this\.get\('commandWhitelist'\), command\)/.test(cfgSrc),
    'commandAllowed 改成委托（不再自带一份匹配）')
  ok(cfgSrc.includes('commandInList (command)'), '新增 commandInList')
  ok(/commandInList \(command\) \{[\s\S]{0,120}?return matchCommandList\(this\.get\('commandWhitelist'\), command\)/.test(cfgSrc),
    'commandInList 只看名单')
  const cfg = new PluginConfig(mk('wc-wl-cfg-'))
  cfg.set('commandWhitelist', ['tp', '/^gi/'])
  cfg.set('allowAllCommands', true)
  ok(cfg.commandAllowed('give') === true && cfg.commandInList('give') === true, '名单命中的两条都认')
  ok(cfg.commandAllowed('op') === true && cfg.commandInList('op') === false,
    '🔴 打开「允许所有指令」后 commandAllowed 全放行，但 commandInList **不跟着全亮**')
  ok(cfg.commandAllowed('/tp x y z') === true && cfg.commandInList('tp') === true, '输入可以带 `/` 与参数')
  ok(matchCommandList(['*'], 'anything') === true && matchCommandList([], 'tp') === false, '`*` 与空名单')
  ok(matchCommandList(['/tp'], 'tp') === true, '`/tp` 这种带前导斜杠的精确名仍然认（审计第 6 条）')
  ok(isRegexEntry('/^gi/') === true && isRegexEntry('/tp') === false && isRegexEntry('*') === false && isRegexEntry('tp') === false,
    'isRegexEntry 与匹配逻辑同款规矩（`/tp` 不是正则）')

  /* ③ 服务端下发 */
  ok(idx.includes("from './src/commands.mjs'") && idx.includes('COMMAND_GROUPS'), 'index.js 引了目录')
  ok(idx.includes('commandCatalog: COMMAND_GROUPS.map'), 'configView 下发 commandCatalog')
  ok(idx.includes('on: pluginConfig.commandInList(it.name)'), '🔴 每条的 on 由服务端算（客户端不判）')
  ok(idx.includes('commandExtra:') && idx.includes('covers: names.filter'), 'configView 下发自定义条目 + 它们罩着谁')
  ok(idx.includes('if (!isRegexEntry(entry) && entry !== ') , '目录里的精确名不重复列进"自定义条目"')

  /* ③b 会挪人的指令 ⇒ 发完打断在飞的移动（2026-10-17 复审） */
  {
    const { COMMANDS_THAT_MOVE_ME } = await import('../src/commands.mjs')
    ok(COMMANDS_THAT_MOVE_ME instanceof Set, '导出了 COMMANDS_THAT_MOVE_ME')
    for (const n of ['tp', 'teleport', 'spreadplayers', 'execute']) {
      ok(COMMANDS_THAT_MOVE_ME.has(n), `\`/${n}\` 被认成"会挪人"`)
    }
    ok(!COMMANDS_THAT_MOVE_ME.has('say') && !COMMANDS_THAT_MOVE_ME.has('time'),
      '说话/改时间不算挪人（不然每次说话都打断移动）')
    ok(idx.includes('COMMANDS_THAT_MOVE_ME'), 'index.js 引了这份名单')
    ok(/if \(COMMANDS_THAT_MOVE_ME\.has\(name\)\)[\s\S]{0,160}?interruptMove\(/.test(idx),
      '🔴 发完 /tp 就 interruptMove（否则在飞的 mc_move 会继续朝旧目标走）')
  }

  /* ④ 客户端：文本框与「保存」都没了 */
  const pane = src.slice(src.indexOf('function WhitelistPane'), src.indexOf('function PromptPane'))
  ok(pane.length > 200, '切出了 WhitelistPane 那一段')
  ok(!pane.includes("'data-wc-textarea'"), '🔴 白名单那个自由文本框删掉了')
  ok(!pane.includes('wlText') && !pane.includes('onWlText'), '不再用 wlText')
  ok(!pane.includes("'保存'") && !pane.includes('wl:save'), '🔴 「保存」按钮删掉了')
  ok(pane.includes('catalog.map') && pane.includes('h(Switch'), '改成按目录渲染一排开关')
  ok(pane.includes('data-wc-cmdgroup') && pane.includes('data-wc-cmdextra'), '有分组标题与自定义条目区')
  ok(pane.includes('onToggleCmd') && pane.includes('onDropEntry'), '拨开关与删条目都接上了')
  ok(pane.includes('disabled: rowOff') && pane.includes('const rowOff = busy || cfgBad || locked'),
    'allowAll / cfgBad / busy 时开关置灰')
  ok(src.includes('const [wlList, setWlList] = React.useState([])') &&
    src.includes('const [cmdCatalog, setCmdCatalog] = React.useState([])') &&
    src.includes('const [cmdExtra, setCmdExtra] = React.useState([])'), 'state 换成名单 + 目录 + 自定义条目')
  ok(src.includes('setWlList(Array.isArray(c.commandWhitelist) ? c.commandWhitelist : [])') &&
    src.includes('setCmdCatalog(Array.isArray(c.commandCatalog) ? c.commandCatalog : [])'),
    'load() 从服务端读这三份')
  ok(src.includes('const applyWhitelist = React.useCallback') &&
    src.includes("apiPatch(withSid('/api/mc/config'), { commandWhitelist: next })"),
    '改一条 = PATCH 一次（不再等「保存」）')
  ok(src.includes('if (Array.isArray(r?.commandCatalog)) setCmdCatalog(r.commandCatalog)'),
    '🔴 服务端回来的新目录直接覆盖本地（拨了没生效的开关会自己弹回去）')
  ok(src.includes('wl:cmd:') && src.includes("'wl:drop'"), '每次拨动有独立的忙碌键')
  ok(/const isRe = \(t\) => t\.length > 1 && t\.startsWith\('\/'\) && t\.lastIndexOf\('\/'\) > 0/.test(src),
    '关掉时只删同名精确条目（正则与 `*` 留着）')
  ok(!src.includes('whitelistToText') && !src.includes('textToWhitelist'), '两个文本转换助手已随文本框一起删掉')
}


for (const d of TMP) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
