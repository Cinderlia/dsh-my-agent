/**
 * 提示词注入 / 通知台账 / 记忆根播种 —— 从 `index.js` 搬出来的那一大块（2026-10-20）
 *
 * 为什么搬：原先这 666 行（`index.js:4124-4789`）夹在"工具注册"和"MC 模式隔离"中间，但它**一件工具的事都没有**，
 * 只做三件事：
 *   ① **提示词注入**：`RULES.md` / `版本提示.md` / 记忆索引指针该不该塞进系统提示、塞哪一段（`promptInjectionStatus`、
 *      `memoryIndexText`、`memLabelOf`、`rulesPointerText`、`ensureAgentsMdFile`）；
 *   ② **通知台账**：哪些 `AGENTS.md` 指令已经发过了（`ledgerOf` / `reconcileNotices` / `enterWithNotices` /
 *      `sentNoticeRels`）。宿主每轮都会重放历史消息，所以"发过就别再发"，撤销掉的还要收回来
 *      （`withdrawAgentsMdNotices`）；
 *   ③ **记忆根播种**：新会话（`memoryPerSession`）的记忆目录从基根复制哪几个文件
 *      （`SESSION_SEED_FILES` / `seedSessionRoot` / `ensureMemoryRootForCwd`）。
 *
 * 为什么是"工厂 + 依赖注入"：这些逻辑要读**当前插件实例的**配置、记忆根和会话，而它们都在
 * `apply(ctx, config)` 的闭包里（`pluginConfig`、`memoryRootFor`、`workspaceOf`…）。硬拆成纯函数会变成到处传参；
 * 所以反过来 —— 由 `index.js` 把闭包里的东西**递进来**，这里保持"每个插件实例一份"的状态
 * （`noticeLedger` / `seededRoots` / `mcPresetDiag`）。
 *
 * 🔴 别把 `ctx` 换成模块级全局：同一个进程里可能有多个工作区、多个插件实例。
 * 🔴 `createInjector()` 的调用点在 `index.js` 的 **MC 模式判据之后**（`isMcModeAgent` / `isMcPlusAgent` /
 *    `agentPresetsSvc` / `MC_PLUS_NOTICE_TEXT` 都是在那之后才声明的）—— 挪回去会踩 TDZ。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
// 🔴 `sep` 不能漏：`memoryDirView` 里拼目录前缀要用它。漏了会 ReferenceError，
//    而那个错误正好被 `enterWithNotices` 的 catch 吞掉 ⇒ **提示词一条都不投**、
//    且只在日志里留一行"提示词注入失败"（2026-10-21 才被自检抓出来）。
import { join, sep } from 'node:path'

/**
 * @param {object} deps 由 `index.js` 递进来的闭包依赖（配置、记忆根、日志、宿主工具）
 * @returns 注入/台账/播种这摊子用到的函数与常量
 */
export function createInjector (deps) {
  const {
    DEFAULT_AGENTS_MD, MC_PLUS_NOTICE_TEXT,
    PLUGIN_VERSION, VERSION_PROMPT_FILE,
    agentIdOf, agentPresetsSvc,
    agentsMdPath, isMcModeAgent,
    isMcPlusAgent, lastPresetSeen,
    logDebug, logLine,
    logOnce, mcPresetDir,
    memoryBaseFor, memoryFor,
    memoryRootFor, migrateLegacyAgentsMd,
    migrateWorkspaceConfig, noteAgent,
    pluginConfig, pluginLoadNote,
    readAgentsMd, readVersionPrompt,
    syncRulesVersion, syncVersionPrompt,
    userMessage, versionPromptPath,
    versionPromptSource, versionPromptText,
    versionPromptTitle, workspaceConfigValues,
    workspaceOf, workspaceRootFor,
    wsCfgValues, wsConfigPath,
  } = deps


  /* ── 总索引自动注入系统提示（用户要求：自动注入 + 提醒及时读）── */

  /** 记忆根在提示词里的写法：还是默认的 `<工作区>/.dsh-mc-agent` 就写相对名，被 memoryDir 挪走了就写绝对路径。
   *  🔴 2026-10-06（本机补丁）：以前这里写死 `.dsh-mc-agent/`，记忆一挪 AI 就会去工作区里找/建那个文件夹。 */
  const memLabelOf = (store) => {
    const r = String(store?.root ?? '')
    return /(^|[\\/])\.dsh-mc-agent$/i.test(r) ? '.dsh-mc-agent/' : `${r}${sep}`
  }
  /** 记忆索引的正文（按工作区渲染；`store` 的根不存在且要求静默时返回空串） */
  const memoryIndexText = (store, { silentWhenMissing = false } = {}) => {
    if (silentWhenMissing && !existsSync(store.root)) return ''
    // 没记忆时不占位（第一次 append 后自动出现）
    const files = store.list()
    const label = memLabelOf(store)
    if (!files.length) {
      return `【麦块长期记忆】现在是空的（\`${label}\`）。学到值得记住的事（用户是谁、地标坐标、约定）就用 `
        + '`mc_kit_memory {action:"append", topic:"<主题>", text:"..."}` 记下来，'
        + `并在 \`${label}README.md\` 里补一行索引。`
    }
    return `【麦块长期记忆】根目录 \`${label}\`（其中 \`README.md\` 是**你维护的索引**）\n\n`
      + store.indexText()
      + '\n\n**要动手前先读相关文件**（`mc_kit_memory {action:"read", path:"..."}`）——'
      + '别凭印象做事；不确定就先 `search`。新学到的事实随手 `append`，'
      + `并且**改了记忆就顺手更新 \`${label}README.md\`**。`
  }

  /**
   * 🔴 2026-09-16 用户定的：**本插件不再往系统提示词里塞任何东西**。
   *
   * 他的原话：系统提示词在 preset 里设置好就行，宿主管组装、**会自动注入**；
   * 插件再往系统提示里注册段是冗余。而且真机事故证明那条路**不可靠**：
   * 宿主 `system-prompt/src/index.ts:606` 是 `contexts: runtimeContextSuppressed ? [] : [...]`，
   * 从官方 `minimal` 复制来的 persona 带着 `includeRuntimeContext: false` / `complete: true` 时，
   * 我们注册的 context 段会在组装时被**整个丢掉** —— 症状正是"设置页显示正常、AI 却什么都没收到"。
   *
   * 所以注入**只剩一条通道**：学宿主注入工作区 `AGENTS.md` 的做法，把内容当**插件提示行**
   * 投进 `agent.inbox.nextStep`（见 `reconcileNotices`，在 `agent/pre-step` 里对账投递）——
   * 必达、在对话里看得见、而且完全不过 systemPrompt 组装，任何 persona 都压不掉它。
   * 记忆索引（`.dsh-mc-agent/README.md`）也走同一条路。
   */

  /* 🔴 这里原来有一段"给每个 agent 注册两个 systemPrompt 段（记忆索引 + 模式指导）"的代码，
   * 2026-09-16 用户要求**整段删掉**："系统提示词不用显式注入，设置好了会自动注入" ——
   * 插件自己往系统提示里塞东西既冗余，又会被 persona 的 complete/includeRuntimeContext 压掉
   * （见上一段）。记忆索引与模式相关的话现在都走 `reconcileNotices()` 的插件提示行。 */

  /**
   * 行事准则文件缺了就补一份默认。
   * 用户 2026-09-16："启动对话时设置要求注入、但找不到文件" → **注入默认 + 重建文件**（自愈）。
   * @returns {boolean} 是否刚建出来（调用方据此打一行日志）
   */
  const ensureAgentsMdFile = (dir) => {
    const p = agentsMdPath(dir)
    try {
      // 先把老名字（`.dsh-mc-agent/AGENTS.md`）迁走 —— 只要那个文件名还在，宿主就会把它
      // 当"工作区指令"注入任何碰过本目录的会话（含非 MC 会话），而我们的开关关不掉它。
      const mig = migrateLegacyAgentsMd(dir)
      if (mig.migrated) logLine(`行事准则已改名迁移：${legacyAgentsMdPath(dir)} → ${p}（老文件备份为 ${mig.backup}）`)
      else if (mig.reason) logLine(`行事准则迁移失败（不影响使用）：${mig.reason}`)
      if (existsSync(p)) return false
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(p, DEFAULT_AGENTS_MD, 'utf8')
      return true
    } catch (e) { logLine(`重建行事准则失败（${p}）：${e.message}`); return false }
  }

  /**
   * **把提示词当"插件提示"投递**（学宿主的做法，**绝不冒充用户发言**）。
   *
   * 投三条（各一条插件提示行）：
   *    ① `<工作区>/AGENTS.md`（开关 `injectWorkspaceAgentsMd`）—— 用户要求先投它
   *    ② `<工作区>/.dsh-mc-agent/RULES.md`（开关 `injectDshMcAgentAgentsMd`）
   *    ③ `<工作区>/.dsh-mc-agent/README.md` = **记忆总索引**（无开关：记忆是这个模式的本职）
   *
   * 🔴 为什么走这条路：宿主注入工作区 `AGENTS.md` **不用 systemPrompt** ——
   *    `packages/context/agent-instructions` 把一条消息放进 `agent.inbox.nextStep`
   *    → ① **必达**（不经过 systemPrompt 组装：persona 的 `complete:true` /
   *    `includeRuntimeContext:false` 压不到它）；② **看得见**（对话里一行折叠提示）。
   *
   * 用户 2026-09-16 的要求（照做，**不多做**）：
   *    · **不加新开关** —— 就用设置里那两个：`injectDshMcAgentAgentsMd` / `injectWorkspaceAgentsMd`；
   *    · 两个都开时**先投工作区的，再投我们自己的**；
   *    · 每条都要让人**和 AI**一眼看出是哪个文件：折叠标题与正文首行都带**相对路径**
   *      （`AGENTS.md` 与 `.dsh-mc-agent/AGENTS.md` 是两回事）；
   *    · `source` 写死 `{kind:'plugin:dsh-mc-agent', form:'notice'}`（v4 规范值）→ 插件提示行，不归到用户头上；
   *    · **不做 steer 兜底**（steer 空闲会"起一轮"＝没问就替用户说话）。
   */
  /**
   * 造一条"用户角色"的消息（宿主 `UserMessage` 的形状）。
   *
   * 🔴🔴 2026-09-18 真机事故（用户在**另一台设备**上 npm 装了 0.1.3）：**提示词一条都没注入**，
   *    而工具白名单/guard 一切正常。根因这里：`@deepseek-ai/dsh-llm` **没有写进依赖声明**，
   *    本机是因为 `node_modules` 里有指向宿主源码树的链接才 `require` 得到；
   *    别人 `npm i` 装出来的插件目录里没有这个包、向上也找不到 ⇒ 提示行**一条都建不出来**。
   *    而工具白名单（`tools.restrict`）+ guard 全靠 ctx，不碰任何宿主包 ——
   *    于是症状精确地是"**工具都在、提示词全无**"。
   *
   * 现在统一走 `src/user-message.mjs`：**优先宿主实现，拿不到就用自带等价实现**
   * （字段逐个对齐 `role` / `content` / `source` / `id`），并且解析失败会记一行日志。
   * 看门狗（`src/watchdog.mjs`）是同一次事故的第二处，也已切到同一个模块。
   */
  if (pluginLoadNote) {
    // 同一句话原来在这台机器上打了 22 遍（每个会话都重打）⇒ 进程内只留一行
    logOnce('no-host-createUserMessage',
      `拿不到宿主的 createUserMessage（${pluginLoadNote}）→ 用插件自带的等价实现兜底（提示词与看门狗注入照常）`)
  }

  /**
   * 提示词投递台账（agent → 状态）。
   *
   * 🔴 2026-09-18 改挂载点（用户："应该切换到正确的挂载点……而是在对话开始后设置工具/注入提示词"）：
   *    **投递时机从"会话开始/切模式那一刻"搬到"每个请求组装之前"**（`agent/pre-step`）。
   *    台账因此按 **preset** 记账：`fp` 记"这批提示词是给哪个模式投的"，切模式就作废重投。
   *
   * 字段：`sessionId` · `fp`（mode/版本指纹）· `rel`（已投的文件名）· `items`（那一刻的正文）
   *      · `since`（会话日志的下标：**上次切出模式那一刻**，之前的投递记录不再算数）
   */
  const noticeLedger = new WeakMap()
  const ledgerOf = (agent) => {
    let l = noticeLedger.get(agent)
    if (!l) { l = { sessionId: null, fp: null, rel: [], items: new Map(), since: 0 }; noticeLedger.set(agent, l) }
    if (l.sessionId !== (agent?.id ?? null)) { l.sessionId = agent?.id ?? null; l.fp = null; l.rel = []; l.items = new Map(); l.since = 0 }
    return l
  }

  /** 这条（会话日志里的）消息是不是**我们**（dsh-mc-agent）投的插件提示行
   *  —— 认 `kind` 的 **v4 规范值**（回读日志用的判据，与投递侧同一口径；见 user-message.mjs 头注释） */
  const isOurNotice = (m) => String(m?.source?.kind ?? '') === 'plugin:dsh-mc-agent' && m?.source?.form === 'notice'

  /** 提示行正文里"它出自哪个文件"（首行 `Instructions from: <rel>`），取不到就 null */
  const noticeRelOf = (m) => {
    try {
      const text = (m?.content ?? []).map((c) => c?.text ?? '').join('')
      const m2 = /^Instructions from:\s*(\S+)/m.exec(text)
      return m2 ? m2[1] : null
    } catch { return null }
  }

  /**
   * 从**会话日志**里读"这个 preset 下我们已经投过哪些文件"。
   *
   * 为什么必须读日志：台账是**进程内**的（WeakMap），宿主重启 / 插件重载就没了，
   * 而会话日志是持久的 —— 一个已经投过提示词的 MC 会话在重启后 resume，
   * 只看台账就会**再投一遍**（重复注入）。`snapshotEvents()` 在真机上可用，
   * 拿不到就退化成"只信台账"（不抛错，绝不让诊断路径把 turn 弄挂）。
   *
   * ⚠️ 只看 `l.since`（**上次切出 MC 模式那一刻**）之后的事件：切出时提示词已经作废
   *    （台账也清了），若不划这条线，"切出 → 再切回"会被日志里的旧记录误判成"已经投过"
   *    ⇒ **再也不投**（自检逮到过这个 bug）。
   */
  const deliveredRelsFor = (agent, rels) => {
    const out = new Set()
    try {
      const from = Number(ledgerOf(agent).since) || 0
      let events = []
      try {
        const ev = agent?.session?.snapshotEvents?.()
        events = Array.isArray(ev) ? ev : []
      } catch { events = [] }
      for (const ev of events.slice(from)) {
        if (ev?.type !== 'user/message') continue
        const m = ev.data
        if (!isOurNotice(m)) continue
        const text = (m.content ?? []).map((c) => c?.text ?? '').join('')
        for (const rel of rels) if (rel && text.includes(rel)) out.add(rel)
      }
    } catch { /* 读不到日志就只信台账 */ }
    return out
  }

  /**
   * 把一条插件提示行放进会话的"待投递"队列。
   * 优先用宿主的 inbox API（`append` → 会**durable** 落事件 + 通知投影；宿主自己也走 splice 系列），
   * 老版本/替身没有这个 API 才退回直接 push。
   */
  const pushNotice = (inbox, message) => {
    if (typeof inbox.append === 'function') { inbox.append('next-step', message); return true }
    if (Array.isArray(inbox.nextStep)) { inbox.nextStep.push(message); return true }
    return false
  }

  /**
   * **清掉还没投递的**本插件提示行（切出 MC 模式时用）。
   *
   * 🔴 2026-09-18 变简单了（挂载点搬到 `agent/pre-step` 之后）：
   *    以前提示词是"会话开始/切到 MC 模式那一刻"就入队，而模式允许在**空白期**继续改，
   *    于是"切 MC → 一句话没发 → 切回标准"会把 MC 提示词留在一个标准模式会话里
   *    （真机 `session-be2e43d7`：seq 3 切 MC、seq 4 切回标准、seq 7 三条提示词还在队列里等着）。
   *    现在**只在请求组装前现场判定并投递**（见 reconcileNotices）：不是 MC 模式就一条都不投，
   *    所以那种串模式**从根上不可能发生**，也**不再需要**补一条"MC 行事准则作废"声明去圆场。
   * 这里只负责把队列里可能残留的自家提示行摘干净（幂等；本模式重新进入时会照常重投）。
   * @param agent - 宿主 Agent
   * @returns {{removed: number, delivered: boolean}} 摘掉的条数 / 之前是否真的投递过
   */
  const withdrawAgentsMdNotices = (agent) => {
    const inbox = agent?.inbox
    let removed = 0
    if (inbox && Array.isArray(inbox.nextStep)) {
      for (const m of [...inbox.nextStep]) {
        if (!isOurNotice(m)) continue
        try {
          if (typeof inbox.remove === 'function' && m?.id !== undefined && inbox.remove(m.id) === true) { removed++; continue }
          const i = inbox.nextStep.indexOf(m)
          if (i >= 0) { inbox.nextStep.splice(i, 1); removed++ }
        } catch (e) { logLine(`清掉待投递提示行失败：${e?.message ?? e}`) }
      }
    }
    // 🔴 真事故（自检逮到）：清了队列就必须**同时把台账里的 rel 抹掉**。
    //    否则"切回普通模式（清队列）→ 再切回 MC 模式"时，台账还以为投过了 ⇒ **永远不再投**，
    //    典型症状就是"提示词莫名其妙没了"。队列里还没被 claim 的，本来就不算投过。
    // 🔴 切出模式 ⇒ 这批提示词**作废**：台账里的"已投"记录必须一起清掉，否则再切回来会被
    //    误判成"已经投过" ⇒ **再也不投**。这里**不能**加 `if (removed > 0)` 的条件 ——
    //    现在提示行是在本步消息里当场送出的，队列通常是空的（removed === 0），
    //    当年那版靠"队列非空"来判断"这次真的要作废"是错的（自检逮到过）。
    {
      const l = ledgerOf(agent)
      l.rel = []
      l.items = new Map()
    }
    // 🔴 无论有没有从队列里摘到东西，都要**划一条线**：把"切出这一刻"的日志下标记下来，
    //    之后 `deliveredRelsFor` 只认这条线之后的投递记录 —— 这样"切出 → 再切回"才会重投
    //    （否则日志里的旧记录会让插件误判"已经投过"，表现为**再也不投**）。
    try {
      const ev = agent?.session?.snapshotEvents?.()
      ledgerOf(agent).since = Array.isArray(ev) ? ev.length : 0
    } catch { /* 拿不到日志下标就算了（退化：只信台账） */ }
    // 队列本来就干净 ⇒ 说明那几条**已经进过对话**（载入时从日志认出来的）
    const delivered = removed === 0 && Boolean(ledgerOf(agent).fp)
    if (removed || delivered) {
      logLine(`已退出 MC 模式：清掉待投递提示行 ${removed} 条${delivered ? '（之前投过的那几条仍在对话历史里）' : ''}`)
    }
    return { removed, delivered }
  }

  /**
   * 「规则放在文件里，让每个新会话直接去读文件」（用户 2026-10-08）。
   *
   * 投给会话的**只有这一行指针**：绝对路径 + 读法。正文留在文件里，由会话自己读 ——
   * 这样正文只在"读的那一刻"占上下文，而且**用户改文件立刻生效**（不用重启、不用重投）。
   *
   * 读法给两种：`mc_kit_memory {action:"read"}`（记忆根相对路径，MC 模式一定在）与
   * `read {file_path:"<绝对路径>"}`（宿主的文件工具；MC 模式里也在白名单里，受保护文件只读）。
   * @param {{abs:string, fileName:string, what:string}} o
   * @returns {string}
   */
  const rulesPointerText = ({ abs, fileName, what }) => [
    `📖 ${what}在文件里，**以文件为准**（改了立刻生效，不用重启）：`,
    `   \`${abs}\``,
    `   开工前先读一遍：\`mc_kit_memory {action:"read", path:"${fileName}"}\``
      + `（或 \`read {file_path:"${abs}"}\`）`,
  ].join('\n')

  /**
   * **每个请求组装之前对账一次**：现在是 MC 模式 + 这个模式还没投过 → 投三条插件提示行。
   *
   * 🔴 2026-09-18 改挂载点（用户："应该切换到正确的挂载点"）。挂在这里而不是"会话开始/切模式那一刻"，
   *    是因为**模式的最终值在第一次请求之前仍然可能变**（宿主允许空白期反复切 preset：
   *    `agent-presets/src/index.ts:709-728`，真机 `session-be2e43d7` 就是 seq3 切 MC、seq4 切回标准），
   *    而"发给 LLM 之前"这一刻才是模式已经定下来的时刻。
   *    宿主自己的同类特性也挂在这条瀑布上（`context/agent-instructions` 在 `agent/pre-step` 里同步上下文）。
   *
   * 幂等靠两件事：① 台账按 **preset 指纹**记账（`rel` 已有就不重复投）；
   * ② 队列里已经有同名提示行也不重复投（宿主可能还没把它们领走）。
   * @param agent - 宿主 Agent
   * @returns {{delivered: boolean, queued: number, reason?: string}}
   */
  const reconcileNotices = (agent) => {
    // ⚠️ 每个提前返回都必须带 `todo` 字段：`enterWithNotices` 会读 `r.todo.length`，
    //    漏一个就是 TypeError（这里被 catch 兜住 ⇒ 表现成"静默不注入"，正是最难查的那种）。
    if (!agent?.ctx) return { delivered: false, todo: [], queued: 0, reason: 'no-agent' }
    if (!isMcModeAgent(agent)) return { delivered: false, todo: [], queued: 0, reason: 'not-mc-mode' }
    const cwd = workspaceOf(agent)
    if (!cwd) return { delivered: false, todo: [], queued: 0, reason: 'no-workspace' }
    noteAgent(agent)   // 记忆按会话分：让下面只传 cwd 的调用落到本会话的记忆根
    const inbox = agent.inbox
    if (!inbox || !Array.isArray(inbox.nextStep)) return { delivered: false, todo: [], queued: 0, reason: 'no-inbox' }
    // 注：消息构造由 `src/user-message.mjs` 保证 —— 宿主实现拿不到就用自带等价实现，
    //     所以这里**不再有"静默失败"的死角**。

    // 顺序：**先工作区，再我们自己的**（用户指定）。两个开关都是**本工作区**的（src/wsconfig.mjs）。
    const wsSwitches = wsCfgValues(cwd)
    const items = []
    if (wsSwitches.injectWorkspaceAgentsMd === true) {
      try {
        const p = join(workspaceRootFor(agent), 'AGENTS.md')
        const t = existsSync(p) ? readFileSync(p, 'utf8').trim() : ''
        if (t) items.push({ rel: 'AGENTS.md', title: '提示词注入：AGENTS.md', text: t })
      } catch { /* 读不到就当没有 */ }
    }
    if (wsSwitches.injectDshMcAgentAgentsMd === true) {
      const root = memoryRootFor(cwd)
      ensureAgentsMdFile(root)
      const cur = readAgentsMd(root)
      // 🔴 用户 2026-10-08：「把规则放在文件里，让每个新会话直接去读文件。」
      //    ⇒ 这里**只投一行指针**（路径 + 读法），正文留在文件里由会话自己去读。
      //    好处：正文只在读的那一刻占上下文；用户改文件立刻生效（不用重启、不用重投）。
      items.push({
        rel: '.dsh-mc-agent/RULES.md',
        title: '提示词注入：.dsh-mc-agent/RULES.md',
        text: rulesPointerText({
          abs: cur.path,
          fileName: 'RULES.md',
          what: `行事准则（${cur.source === 'custom' ? '用户 自定义版' : '默认版'}，长期有效）`,
        }),
      })
    }
    // ③ **版本提示**（随插件版本发布，无开关）：同样只投指针，正文在 `<记忆根>/版本提示.md`。
    //    读起来就是"对这个版本的工具成熟度的补充说明"。见 src/version-prompt.mjs。
    {
      const vpDir = memoryRootFor(cwd)
      const vp = readVersionPrompt(vpDir, PLUGIN_VERSION)
      items.push({
        rel: versionPromptSource(PLUGIN_VERSION),
        title: versionPromptTitle(PLUGIN_VERSION),
        text: rulesPointerText({
          abs: vp.path,
          fileName: VERSION_PROMPT_FILE,
          what: 'dsh-mc-agent 的版本提示（这个版本的时效性注意事项）',
        }),
      })
    }
    // ③·5 **MC+ 模式说明**（无开关，仅 MC+ 会话）：MC+ 在 MC 模式基础上多一层"标准工具全量 +
    //      文件全工作区"的语境，随版本硬编码。MC 模式**不投**这条（preset 指纹换代时会整体重投）。
    if (isMcPlusAgent(agent)) {
      items.push({
        rel: versionPromptSource(PLUGIN_VERSION) + '（MC+ 模式说明）',
        title: versionPromptTitle(PLUGIN_VERSION) + '｜MC+ 模式说明',
        text: MC_PLUS_NOTICE_TEXT,
      })
    }
    // ④ 记忆总索引（`.dsh-mc-agent/README.md`）：**每个 MC 会话都给一次**——这正是"长期记忆"的入口。
    //    内容空（还没记过东西）也照样给：里面写着"怎么记"，第一轮就知道该往哪写。
    {
      const idx = memoryIndexText(memoryFor(cwd)).trim()
      if (idx) items.push({ rel: '.dsh-mc-agent/README.md', title: '提示词注入：.dsh-mc-agent/README.md', text: idx })
    }
    if (!items.length) return { delivered: false, todo: [], queued: 0, reason: 'no-items' }

    const ledger = ledgerOf(agent)
    /* 🔴 审计：这里原来是 `?? String(agent?.ctx ? '' : '')` —— 两支都是 `''`，等于什么都没兜。
     * preset 还没认出来时指纹就是 `|<版本>`（对照 1536/3777 用的 `?? null`）。 */
    const preset = lastPresetSeen.get(agent) ?? ''
    const fp = `${preset}|${PLUGIN_VERSION}`
    if (ledger.fp !== fp) { ledger.fp = fp; ledger.rel = []; ledger.items = new Map() }

    const delivered = deliveredRelsFor(agent, items.map((i) => i.rel))
    // 队列里**已经排着的**同名提示行：算"已经安排了"，不重复投（宿主下一个 step 会领走它）。
    const queuedRels = new Set(inbox.nextStep.filter(isOurNotice).map(noticeRelOf).filter(Boolean))
    const rels = new Set([...ledger.rel, ...delivered])
    const todo = items.filter((it) => !rels.has(it.rel) && !queuedRels.has(it.rel))
    if (!todo.length) {
      return { delivered: false, todo: [], queued: queuedRels.size }
    }
    // 只负责"算出该投什么"；**真正入队/改写本步消息**由 pre-step 监听器做（那里才有 decision）。
    // 注：版本提示的短哈希由 `versionPromptTitle()` 自己带进折叠标题，这里不需要再算。
    return { delivered: true, todo, queued: queuedRels.size }
  }

  /**
   * 🔴🔴 2026-09-18 **第二次改挂载点**（用户："两个全都是 LLM 运行了一半才后知后觉地注入，
   *    根本不是用户发送第一条信息后注入"）。
   *
   * 上一次我只把投递挂到 `agent/pre-step`，但**塞进了 `inbox.nextStep`** —— 而宿主的顺序是：
   *    `preStep()` 里**先 `inbox.claim()`**（把这一步的消息领走）**再**跑 `agent/pre-step` 瀑布
   *    （`core/agent-loop/src/agent.ts:244` → `:249`）。
   * 所以那一步塞进队列的提示行**这一步用不上**，要等**下一步**才被领走 ——真机实测：
   *
   *     seq= 7-9  next-step +3        ← 我在 pre-step 塞进队列
   *     seq=10    step/start  step=1  ← 这一步的消息**已经领完了**
   *     seq=12    user/message 用户那句
   *     seq=25    next-step -3        ← 到第 2 步才被领走
   *     seq=27-29 user/message ×3     ← 提示行晚了整整一步
   *
   * 这正是宿主 `agent-instructions` 的写法要解决的问题：**改写 `decision.messages`**
   *   （`context/agent-instructions/src/index.ts:313-338`：拿 `next()` 的结果 → 先把队列里
   *    那几条 `inbox.remove()` → 再 `{...decision, messages: toSpliced(...)}` 返回）。
   * 宿主紧接着在 `agent.ts:373-377` 把 `decision.messages` **逐条落成会话日志的 `user/message`**
   * 并作为请求里的那批消息 —— 既是**正规通道**（`stepAt`/重放都对得上），又能**当场**生效。
   *
   * 位置：**排在本步消息的最前面**。本步消息 = 用户那句 + 运行时上下文快照；
   * 把规矩放在最前，模型第一眼就看到（而不是先看到用户那句话再补规矩）。
   *
   * cordis：`agent/pre-step` 是 waterfall，**必须交棒**（`next()`）—— 见下面那段注释与自检。
   */
  const noticeMessagesFor = (todo) => todo.map((it) => userMessage({
    content: [{ type: 'text', text: `Instructions from: ${it.rel}\n\n${it.text}` }],
    // source.kind 用 **v4 规范值** `plugin:dsh-mc-agent`（v4 会话格式**拒绝**裸露的 'plugin'；
    // 宿主 createUserMessage 对 source 原样透传、不会替我们修正）—— 见 src/user-message.mjs 头注释
    source: { kind: 'plugin:dsh-mc-agent', form: 'notice', summary: it.title },
  }))

  /** 记一笔台账（投出去的那些文件名 + 正文，供诊断与"内容变了就地更新"） */
  const markNoticesSent = (agent, todo) => {
    const ledger = ledgerOf(agent)
    for (const it of todo) ledger.items.set(it.rel, it.text)
    ledger.rel = [...new Set([...ledger.rel, ...todo.map((i) => i.rel)])]
    logLine(`提示词已投递 ${todo.length} 条（**本步消息里**，与用户那句同批送出；插件提示行，非用户发言）：${todo.map((i) => i.rel).join(' → ')}`)
  }

  /**
   * 把提示行塞进**本步**的 `decision.messages` 最前面；没有要投的就原样返回。
   * 幂等：投过就记账，下一个 step 不会再投。
   * @param agent - 宿主 Agent（用来判模式与工作区）
   * @param decision - 交棒拿回来的 `PreStepDecision`
   * @returns 改写后的 decision（不改就别返回新对象）
   */
  const enterWithNotices = (agent, decision) => {
    try {
      if (!decision || decision.kind !== 'enter') return decision
      const r = reconcileNotices(agent)
      if (!r.todo.length) return decision
      // 队列里若有残留的自家提示行，先摘掉：它们马上要作为**本步消息**送出去了，
      // 留着会让下一步再送一遍（重复注入）。
      try { withdrawAgentsMdNotices(agent) } catch { /* 摘不掉也不影响本步 */ }
      markNoticesSent(agent, r.todo)
      const msgs = (decision.messages ?? []).filter((m) => !isOurNotice(m))
      const out = { ...decision, messages: [...noticeMessagesFor(r.todo), ...msgs] }
      return out
    } catch (e) {
      // 绝不带崩这一轮：改写失败就用内层原样结果。
      logLine(`提示词注入失败（不打断本轮，按原样继续）：${e?.message ?? e}｜${String(e?.stack ?? '').split('\n')[1] ?? ''}`)
      return decision
    }
  }

  /**
   * 「MC模式」那个 preset 的**人设压制**诊断（每次现读，便宜）。
   *
   * 为什么需要：宿主 `system-prompt/src/index.ts:606` 写着
   * `contexts: runtimeContextSuppressed ? [] : […]` —— persona 只要写了 `includeRuntimeContext: false`，
   * **我们注入的段（全是 context）会在组装时被整个丢掉**；`complete: true` 再压掉别的 section。
   * 复制官方 `minimal` 恰好带这两个开关 → "设置页显示一切正常、AI 却什么都没收到"（2026-09-16 真机）。
   */
  let mcPresetDiag = null
  /**
   * @param agent - 可选：优先诊断**这个会话自己**的 preset（两个 preset 在名单里时，
   *   不能永远只报第一个）。读不到组成文件（如新宿主的声明式 preset 没有磁盘目录）→
   *   返回上次结果/`null`；声明式 preset 的 persona 由本包声明掌控、不存在压制开关，
   *   所以新宿主上这里是空转，只对旧宿主（目录式 preset）有诊断意义。
   */
  const refreshMcPresetDiag = (agent) => {
    try {
      const svc = agentPresetsSvc
      if (!svc) return mcPresetDiag
      const prefer = agent ? lastPresetSeen.get(agent) : null
      const list = pluginConfig.mcModePresets
      const ids = prefer && list.includes(prefer) ? [prefer, ...list.filter((x) => x !== prefer)] : list
      for (const id of ids) {
        const dir = mcPresetDir(svc, id)
        const p = dir ? join(dir, 'agent.cordis.yml') : null
        if (!p || !existsSync(p)) continue
        const comp = readFileSync(p, 'utf8')
        mcPresetDiag = {
          id,
          path: p,
          complete: /complete:\s*true/.test(comp),
          runtimeContextSuppressed: /includeRuntimeContext:\s*false/.test(comp),
          personaIsOurs: /Minecraft Java 版服务器里扮演一名玩家/.test(comp),
        }
        return mcPresetDiag
      }
    } catch { /* 读不到就当没有 */ }
    return mcPresetDiag
  }

  /**
   * 这个会话**已经投出去**的提示行文件名（诊断/UI 用）。
   *
   * 来源两处，缺一不可：① 进程内台账（`ledgerOf`，按 preset 记账）；
   * ② **会话日志回读** —— 台账是进程内的，宿主重启/插件重载就没了，只信台账会漏报
   *    （用户会看到"没投递"，而 AI 其实早就收到了）。
   */
  const sentNoticeRels = (agent) => {
    if (!agent) return []
    const out = new Set(ledgerOf(agent).rel)
    for (const rel of deliveredRelsFor(agent, noticeRelCandidates())) out.add(rel)
    return [...out]
  }

  /** 所有可能被投递的文件名（回读日志时用来匹配） */
  const noticeRelCandidates = () => [
    'AGENTS.md',
    '.dsh-mc-agent/RULES.md',
    '.dsh-mc-agent/README.md',
    versionPromptSource(PLUGIN_VERSION),
    versionPromptSource(PLUGIN_VERSION) + '（MC+ 模式说明）',
  ]

  /**
   * **提示词注入状态**（给 UI / `mc_diag` 看）：每条各自"投出去了没有、为什么没有"。
   *
   * 2026-09-16 加：用户在真机上反复报"没有任何我们的提示词"，而这件事**极难从外面判断**
   * （是没进 MC 模式？开关关了？文件不在？投递失败？）。与其让人猜，不如把判据摆出来：
   * `segments` 报**实际投递**（台账 + 会话日志回读），`notes` 是人话版原因。
   */
  const promptInjectionStatus = (agent) => {
    const cwd = workspaceOf(agent)
    const root = cwd ? memoryRootFor(cwd, agentIdOf(agent)) : null
    const mcMode = Boolean(agent) && isMcModeAgent(agent)
    const mcPlus = Boolean(agent) && isMcPlusAgent(agent)
    const wsAgents = agent ? join(workspaceRootFor(agent), 'AGENTS.md') : null
    const cur = root ? readAgentsMd(root) : null
    const agentsFile = root ? agentsMdPath(root) : null
    const wsSw = wsCfgValues(cwd)
    const injectWc = wsSw.injectDshMcAgentAgentsMd === true
    const injectWs = wsSw.injectWorkspaceAgentsMd === true
    const wsExists = Boolean(wsAgents) && existsSync(wsAgents)
    // 版本提示现在是**文件**（`<记忆根>/版本提示.md`，用户 2026-10-08）：
    //   注入只投一行指针，正文由会话自己去读 ⇒ 这里给界面展示/编辑的是**文件内容**。
    const vpPath = root ? versionPromptPath(root) : null
    const vpCur = root ? readVersionPrompt(root, PLUGIN_VERSION) : null
    const presetId = (agent && lastPresetSeen.get(agent)) ?? null
    // 🔴 宿主的硬规则（system-prompt/src/index.ts:606）：persona 若写了 `includeRuntimeContext: false`，
    //    组装时 `contexts` 直接变成 `[]`；写了 `complete: true` 则"人设即全部系统提示"。
    //    复制官方 minimal 就会带这两个开关（2026-09-16 真机事故的根因）。
    //    ⚠️ 现在我们的提示词走**插件提示行**（inbox.nextStep），**不受它影响** —— 这条只作为
    //    "preset 还没被修好"的提示留着（它仍会压掉宿主自己的运行期上下文）。
    const personaSuppresses = Boolean(refreshMcPresetDiag(agent)?.complete || mcPresetDiag?.runtimeContextSuppressed)
    const sent = sentNoticeRels(agent)
    return {
      mcMode,
      mcPlus,
      presetId,
      workspace: cwd ?? null,
      switches: { injectDshMcAgentAgentsMd: injectWc, injectWorkspaceAgentsMd: injectWs },
      files: {
        agentsMd: agentsFile
          ? { path: agentsFile, exists: existsSync(agentsFile), source: cur?.source ?? null, bytes: cur ? Buffer.byteLength(cur.text) : 0 }
          : null,
        versionPrompt: vpPath
          ? { path: vpPath, exists: existsSync(vpPath), source: vpCur?.source ?? null, bytes: vpCur ? Buffer.byteLength(vpCur.text) : 0 }
          : null,
        workspaceAgentsMd: wsAgents ? { path: wsAgents, exists: wsExists } : null,
        memoryIndex: root ? { path: join(root, 'README.md'), exists: existsSync(join(root, 'README.md')) } : null,
      },
      preset: mcPresetDiag ?? null,
      // **实际投出去的文件名**（投递是唯一通道，这就是判据本身）
      notices: sent,
      // 版本提示（**文件**：`<记忆根>/版本提示.md`，随版本发布、无开关）：界面上可看可改，
      //   注入只投指针（见 reconcileNotices）。
      versionPrompt: {
        version: PLUGIN_VERSION,
        title: versionPromptTitle(PLUGIN_VERSION),
        path: vpPath,
        source: vpCur?.source ?? null,
        isDefault: (vpCur?.source ?? 'default') === 'default',
        bytes: vpCur ? Buffer.byteLength(vpCur.text) : 0,
        text: vpCur?.text ?? versionPromptText(PLUGIN_VERSION),
        defaultText: versionPromptText(PLUGIN_VERSION),
      },
      // 保留 registered/segments 两个键名（前端与 mc_diag 在用）：现在两者同源 —— 都是"真的投了"
      registered: {
        'agents-md': sent.includes('.dsh-mc-agent/RULES.md'),
        'workspace-agents-md': sent.includes('AGENTS.md'),
        'version-prompt': sent.some((r) => String(r).startsWith('dsh-mc-agent@')),
        'memory-index': sent.includes('.dsh-mc-agent/README.md'),
        'mc-plus-note': sent.some((r) => String(r).includes('（MC+ 模式说明）')),
      },
      segments: {
        'agents-md': sent.includes('.dsh-mc-agent/RULES.md'),
        'workspace-agents-md': sent.includes('AGENTS.md'),
        'version-prompt': sent.some((r) => String(r).startsWith('dsh-mc-agent@')),
        'memory-index': sent.includes('.dsh-mc-agent/README.md'),
        'mc-plus-note': sent.some((r) => String(r).includes('（MC+ 模式说明）')),
      },
      // ⚠️ 这里只留**用户看不出来、又真的影响投递**的原因。
      //    "还没到投递时机 / 开关是关的" 这种**不用提示**（用户 2026-09-18：多余）——
      //    上面那行 `本会话注入：…` 已经用 ✓/✗ 摆出来了，而"还没发过消息"本来就是一目了然的状态。
      //    （前端对 `notes.length === 0` 已经不渲染那一行了，所以全空也没关系。）
      notes: [
        ...(agent ? [] : ['拿不到当前会话（没有 agent 上下文）']),
        ...(agent && !cwd ? ['这个会话没有选中工作区 → 提示词没地方放，插件不会投递'] : []),
        ...(agent && cwd && !mcMode ? [`这个会话不是 MC 模式（preset=${presetId ?? '未知'} 不在 mcModePresets 里）→ 不投递`] : []),
        ...(mcMode && injectWs && !wsExists ? ['工作区根目录里没有 AGENTS.md 这个文件'] : []),
        ...(personaSuppresses ? ['⚠️ preset 的 persona 还带着 complete / includeRuntimeContext:false（会压掉宿主自己的运行期上下文；我们的提示走插件提示行不受影响。重启 DSH 后本插件会自动修这个 preset）'] : []),
      ],
    }
  }

  /**
   * 在**选中工作区**里备好 `.dsh-mc-agent/`（缺 README.md / RULES.md 就补默认）。
   *
   * 🔴 用户 2026-09-16 定的**时机**：**不是**启动时对每个会话建，只在两个时刻建：
   *    ① **首次发起 MC 模式会话**（`applyMcModePolicy` 跑的时候）
   *    ② **点开「MC设置」**（那组 /api/mc/* 接口进来的时候）
   * 🔴 **没有选中工作区就拒绝**（不再退到 `$DSH_HOME` 兜底目录去建）。
   *
   * @returns {boolean} 备好了吗（false = 没工作区 / 建失败）
   */
  const seededRoots = new Set()
  /**
   * 新会话记忆根要"继承"的文件（本机补丁 2026-10-06，记忆按会话分）。
   * 🔴 只拷这几样：**行事准则 + 开关**。绝不拷 `README.md`（那是记忆索引，新会话必须从空开始）、
   *    也绝不拷 `192.168.1.104/` 那种服务器记忆树 —— 拷了就等于没分。
   * 🔴 必须在 `ensureAgentsMdFile` / `syncRulesVersion` **之前**做，否则用户改过的 RULES.md
   *    会被内置默认内容盖掉。
   * 🔴 2026-10-08：`版本提示.md` 也一起继承（它同样是"规则文件"，用户改过的那份要带过去，
   *    不能因为新会话根是空的就回退成内置默认）。
   */
  const SESSION_SEED_FILES = ['RULES.md', '版本提示.md', 'config.json', 'auto.json', 'view.json']
  const seedSessionRoot = (base, root) => {
    if (base === root) return false
    let n = 0
    try {
      for (const f of SESSION_SEED_FILES) {
        const from = join(base, f)
        const to = join(root, f)
        if (!existsSync(from) || existsSync(to)) continue
        copyFileSync(from, to)
        n++
      }
    } catch (e) { logLine(`播种新会话记忆失败（不影响使用）：${e.message}`) }
    return n > 0
  }

  const ensureMemoryRootForCwd = (cwd, agentId = null) => {
    if (!cwd) return false
    const root = memoryRootFor(cwd, agentId)
    if (seededRoots.has(root)) return true
    try {
      if (!existsSync(root)) {
        mkdirSync(root, { recursive: true })
        logDebug(`已在工作区建立记忆目录：${root}`)
      }
      /* 记忆按会话分：新会话根从**基根**播种行事准则与开关（RULES.md / config.json / auto.json / view.json） */
      if (agentId && seedSessionRoot(memoryBaseFor(cwd), root)) logDebug(`新会话记忆已从基根播种：${root}`)
      try { if (memoryFor(cwd, agentId).ensureReadme()) logDebug(`已写入默认记忆索引：${join(root, 'README.md')}`) } catch (e) { logLine(`写默认索引失败：${e.message}`) }
      if (ensureAgentsMdFile(root)) logDebug(`已写入默认行事准则：${agentsMdPath(root)}`)
      /* 按工作区的 config.json（src/wsconfig.mjs）：建档 + 迁移 —— **必须先于下面的版本同步**，
       * 否则旧 `.rules-version` 的值这一轮看不到，会被当成"第一次遇到"（from=null，只 marked 不替换）。
       * seed = 旧版全局 config.json 里**显式设过**的三个开关（搬进本工作区作初值，之后互不影响）。 */
      const mig = migrateWorkspaceConfig(root, { seed: pluginConfig.legacyPromptSwitches() })
      if (mig.created) logDebug(`已建立工作区配置：${wsConfigPath(root)}${mig.seeded.length ? `（沿用了 ${mig.seeded.join('/')} 的旧全局值）` : ''}`)
      if (mig.markerRemoved) logDebug(`提示词版本标记已并入工作区配置：${wsConfigPath(root)}（旧的 .rules-version 已删除）`)
      if (mig.error) logLine(`工作区配置迁移跳过（不影响使用）：${mig.error}`)
      /* 「随版本更新」（默认开，**按工作区**）：插件版本变了就用新版本默认准则替换**基根**那份
       * （=「默认提示词」，也就是以后新建的会话会拿到的模板）。
       * 🔴 用户 2026-10-15：「对升级只动默认的，会话的不动」—— 所以这里同步的是 `memoryBaseFor(cwd)`，
       * 不是本会话的 `root`：正在跑的那个会话不该被一次升级半路换掉规矩。
       * 开关（`rulesFollowVersion`）仍从**本工作区**的 config.json 读（页面上的开关就写在那儿）。
       * 覆盖前留一份 `RULES.md.bak-<旧版本>`（基根那份往往就是用户自己改过的模板）。
       * 第一次遇到（没有版本记录）只记版本、不覆盖；关着时也只记版本。 */
      const syncDir = memoryBaseFor(cwd)
      const sync = syncRulesVersion(syncDir, PLUGIN_VERSION, {
        follow: workspaceConfigValues(root).rulesFollowVersion !== false,
        backup: true
      })
      if (sync.action === 'replaced') logLine(`插件已更新到 v${sync.to}：「随版本更新」开启 → **默认提示词**（基根那份）已替换为新版本默认内容（原为 v${sync.from}）${sync.backup ? `，旧的留在 ${sync.backup}` : ''}；本会话那份没动`)
      else if (sync.action === 'created') logLine(`已写入默认提示词：${agentsMdPath(syncDir)}（v${sync.to}）`)
      else if (sync.error) logLine(`默认提示词版本同步失败（不影响使用）：${sync.error}`)
      /* 会话根那份**内容一个字不动**，但版本标记还是跟上 —— 页面上「注入本提示词 RULES.md」的
       * 说明行显示的就是它（"当前内容对应：v…"）。`follow: false` = 只记版本、绝不覆盖内容。 */
      try { syncRulesVersion(root, PLUGIN_VERSION, { follow: false }) } catch { /* 只记版本，失败无所谓 */ }
      /* 版本提示（`版本提示.md`，用户 2026-10-08 从硬编码提示词挪成文件）：与 RULES.md 同一套
       * 「随版本更新」语义，标记独立（`config.json` 的 `versionPromptVersion`）。 */
      const vpsync = syncVersionPrompt(root, PLUGIN_VERSION, { follow: workspaceConfigValues(root).rulesFollowVersion !== false })
      if (vpsync.action === 'replaced') logLine(`插件已更新到 v${vpsync.to}：「随版本更新」开启 → 版本提示已替换为新版本默认内容（原为 v${vpsync.from}）`)
      else if (vpsync.action === 'created') logLine(`已写入默认版本提示：${versionPromptPath(root)}（v${vpsync.to}）`)
      else if (vpsync.error) logLine(`版本提示同步失败（不影响使用）：${vpsync.error}`)
      seededRoots.add(root)   // 只在全部成功后记账（失败本进程还会重试）
      return true
    } catch (e) { logLine(`初始化记忆目录失败（${root}）：${e.message}`); return false }
  }

  /** 同上，但按 agent 取工作区（活 agent 路径：首次发起 MC 模式会话时用） */

  return {
    SESSION_SEED_FILES,
    ensureMemoryRootForCwd,
    enterWithNotices,
    memoryIndexText,
    promptInjectionStatus,
    reconcileNotices,
    seedSessionRoot,
    sentNoticeRels,
    withdrawAgentsMdNotices,
    memLabelOf,
    ensureAgentsMdFile,
    rulesPointerText,
  }
}
