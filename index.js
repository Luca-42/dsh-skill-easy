/**
 * dsh-skill-easy · 宿主半边
 *
 * 三件事：
 * 1. 读技能目录（ctx.skills），给客户端一份可展示的清单；
 * 2. 存「分类 + 中文描述」这份用户数据（原子写 JSON）；
 * 3. 用宿主自带的 translator 服务批量翻译英文描述。
 *
 * 数据落在 ~/.dsh/storages/dsh-skill-easy/data.json，和插件本身解耦：
 * 卸载插件不会删数据，重装即恢复。
 *
 * @module dsh-skill-easy
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DocumentStore, emptyDocument, hashOf, text, MAX_ZH } from './store.js'

/** 翻译目标语言；translator 内部会把 zh-CN 归一成各 provider 的写法。 */
const TARGET_LANGUAGE = 'zh-CN'
/** 翻译并发：provider 是公开机器翻译接口，压太高容易被限流。 */
const TRANSLATE_CONCURRENCY = 3
/** 代码版本号：界面上会显示，用来确认跑的是哪一版。 */
const CODE_VERSION = 9

/** 按固定并发跑完一组任务，单项失败不影响其他项。 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/** 宿主服务：技能分类与中文描述的数据面，同时是客户端唯一的 Remote 入口。 */
export default class SkillEasyService extends TypertRemoteService {
  static inject = ['skills']

  constructor(ctx) {
    super(ctx, 'skillEasy')
    this.ctx = ctx
    this.store = new DocumentStore(join(resolveDshHome(), 'storages', 'dsh-skill-easy', 'data.json'), ctx.logger)
    this.diagnosticsPath = join(dirname(this.store.path), 'diagnostics.json')
    this.ready = this.store.load().catch((error) => {
      ctx.logger?.warn?.(`dsh-skill-easy: 初始化失败：${error?.message ?? error}`)
      return emptyDocument()
    })
    ctx.logger?.info?.('dsh-skill-easy: 服务已启动')
  }

  /**
   * 取一个可选服务。
   * 先走 ctx.get（不要求本插件 inject 过），失败再退回属性访问（走 fiber 链）。
   * 两条路都不通时返回 undefined，绝不让上层因为缺服务而崩。
   * @param name - 服务键。
   * @returns 服务实例或 undefined。
   */
  service(name) {
    try {
      const value = this.ctx.get(name)
      if (value !== undefined) return value
    } catch (error) {
      // 忽略：换属性访问再试。
    }
    try {
      const value = this.ctx[name]
      if (value !== undefined) return value
    } catch (error) {
      // 忽略：确实拿不到。
    }
    return undefined
  }

  /**
   * 候选的技能注册表。
   *
   * 关键事实：技能 provider 是随 agent 预设挂载的，根上下文那份 `ctx.skills` 往往没有 provider。
   * 官方 `skills/list` 控制器（session-skill-catalog）的取法是：
   * `presets.serviceFor(agent, 'skills') ?? ctx.get('skills')`，再 `list({ cwd, scope: agent })`。
   * 这里照抄，并额外保留几个退化路径，避免没有活跃 agent 时彻底没数据。
   * @returns `[{ label, registry, options }]`，按优先级排列。
   */
  async skillSources() {
    const sources = []
    const meta = { codeVersion: CODE_VERSION }
    try {
      meta.getSkills = this.ctx.get('skills') !== undefined
    } catch (error) {
      meta.getSkills = `throw: ${error?.message ?? error}`
    }
    const root = this.service('skills')
    meta.rootService = root !== undefined
    try {
      const agents = this.service('agents')
      const list = typeof agents?.list === 'function' ? agents.list() : []
      const live = Array.isArray(list) ? list[0] : undefined
      meta.agents = Array.isArray(list) ? list.length : -1
      if (live !== undefined) {
        let cwd
        try {
          const workingDirectory = this.service('workingDirectory')
          meta.workingDirectory = workingDirectory !== undefined
          if (workingDirectory !== undefined && typeof workingDirectory.ensure === 'function') {
            cwd = await workingDirectory.ensure(live)
          }
        } catch (error) {
          meta.cwdError = `${error?.name ?? 'Error'}: ${error?.message ?? error}`
        }
        meta.cwd = cwd
        const presets = this.service('agentPresets')
        meta.agentPresets = presets !== undefined
        let scoped
        try {
          scoped = typeof presets?.serviceFor === 'function' ? presets.serviceFor(live, 'skills') : undefined
        } catch (error) {
          meta.serviceForError = `${error?.name ?? 'Error'}: ${error?.message ?? error}`
        }
        meta.presetSkills = scoped !== undefined
        if (scoped !== undefined) sources.push({ label: 'preset', registry: scoped, options: { cwd, scope: live } })
        if (root !== undefined) {
          sources.push({ label: 'root+scope', registry: root, options: { cwd, scope: live } })
          sources.push({ label: 'root+cwd', registry: root, options: { cwd } })
        }
      }
    } catch (error) {
      meta.error = `${error?.name ?? 'Error'}: ${error?.message ?? error}`
      this.ctx.logger?.warn?.(`dsh-skill-easy: 枚举技能来源失败：${meta.error}`)
    }
    if (root !== undefined) sources.push({ label: 'root', registry: root, options: {} })
    meta.labels = sources.map((source) => source.label)
    return { sources, meta }
  }

  /** 把一次目录读取的实况落盘，出问题时可以直接看文件，不用靠界面猜。 */
  async writeDiagnostics(payload) {
    try {
      await mkdir(dirname(this.diagnosticsPath), { recursive: true })
      await writeFile(this.diagnosticsPath, JSON.stringify(payload, null, 2), 'utf8')
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-skill-easy: 写诊断文件失败：${error?.message ?? error}`)
    }
  }

  /**
   * 当前技能目录。只取展示需要的字段，避免把整份定义送到客户端。
   *
   * 按优先级逐个来源试，第一个非空的就是结果；全空时把每个来源的尝试结果一并返回，
   * 同时写一份 diagnostics.json，方便定位是哪一层没拿到。
   * @returns `{ skills, error, diagnostics }`。
   */
  async catalog() {
    const { sources, meta } = await this.skillSources()
    const diagnostics = []
    let empty = null
    let lastError = null
    for (const source of sources) {
      try {
        const skills = await source.registry.list(source.options)
        const mapped = skills
          .map((skill) => ({
            name: skill.name,
            description: skill.description,
            srcHash: hashOf(skill.description),
            modelInvocable: skill.invocation?.modelInvocable !== false,
            userInvocable: skill.invocation?.userInvocable !== false,
            source: skill.source,
            ...(skill.path === undefined ? {} : { path: skill.path }),
          }))
          // 只保留能在 `/` 菜单里出现的技能，避免设置页里出现点了也用不了的条目。
          .filter((skill) => skill.userInvocable)
          .sort((left, right) => left.name.localeCompare(right.name))
        diagnostics.push(`${source.label}: ${mapped.length}`)
        if (mapped.length > 0) {
          await this.writeDiagnostics({ ...meta, at: new Date().toISOString(), attempts: diagnostics, count: mapped.length })
          return { skills: mapped, error: null, diagnostics }
        }
        empty = mapped
      } catch (error) {
        const reason = `${error?.name ?? 'Error'}: ${error?.message ?? error}`
        lastError = reason
        diagnostics.push(`${source.label}: 失败 ${reason}`)
        this.ctx.logger?.warn?.(`dsh-skill-easy: 读取技能目录失败（${source.label}）：${reason}`)
      }
    }
    const result = { skills: empty ?? [], error: empty === null ? lastError : null, diagnostics }
    await this.writeDiagnostics({ ...meta, at: new Date().toISOString(), attempts: diagnostics, count: result.skills.length })
    return result
  }

  /** 翻译服务状态：不可用时客户端只提供手动填写，不报错。 */
  async translatorState() {
    const translator = this.service('translator')
    if (translator === undefined) return { available: false, reason: 'translator-unavailable', providers: [] }
    try {
      const providers = await translator.availableProviders()
      const names = (Array.isArray(providers) ? providers : []).map((entry) => {
        if (typeof entry === 'string') return entry
        return String(entry?.provider ?? entry?.id ?? entry?.name ?? '')
      })
      return { available: names.length > 0, reason: names.length > 0 ? null : 'no-provider', providers: names }
    } catch (error) {
      return { available: false, reason: error?.message ?? 'translator-error', providers: [] }
    }
  }

  /**
   * 客户端首屏：一次拿齐文档、技能目录、翻译能力。
   * @returns 完整视图。
   */
  async overview() {
    await this.ready
    // 必须取内存里的当前数据：`this.ready` 只是启动时那次读盘的结果，保存后不会变。
    const document = this.store.snapshot()
    const [catalog, translator] = await Promise.all([this.catalog(), this.translatorState()])
    return { document, codeVersion: CODE_VERSION, skills: catalog.skills, catalogError: catalog.error, catalogDiagnostics: catalog.diagnostics, translator }
  }

  /**
   * 整份保存。数据量只有几十条，整体覆盖比增量合并更不容易出错。
   *
   * 乐观锁在 DocumentStore 里实现，比较对象是内存里的当前文档。
   * @param request - `{ document, baseRev? }`。
   * @returns `{ ok: true, document }` 或 `{ ok: false, reason, document? }`。
   */
  async save(request) {
    await this.ready
    try {
      return await this.store.save({ document: request?.document, baseRev: request?.baseRev })
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-skill-easy: 保存失败：${error?.message ?? error}`)
      return { ok: false, reason: error?.message ?? 'save-failed' }
    }
  }

  /**
   * 翻译指定技能的英文描述。
   * 逐条独立：某条失败只进 failures，其余照常返回。
   * @param request - `{ names?: string[] }`，省略表示翻译全部有英文描述的技能。
   * @returns `{ results, failures, translator }`。
   */
  async translate(request) {
    await this.ready
    const document = this.store.snapshot()
    // 客户端已经拿到了 `/` 菜单同源的技能清单，优先用它；没有才退回自己读。
    const provided = Array.isArray(request?.skills)
      ? request.skills.filter((skill) => skill !== null && typeof skill === 'object' && typeof skill.name === 'string')
      : null
    const catalog = provided === null ? (await this.catalog()).skills : provided
    const byName = new Map(catalog.map((skill) => [skill.name, skill]))
    const wanted = Array.isArray(request?.names) && request.names.length > 0
      ? request.names.filter((name) => byName.has(name))
      : catalog.map((skill) => skill.name)
    const translator = this.service('translator')
    if (translator === undefined) {
      return { results: [], failures: wanted.map((name) => ({ name, reason: 'translator-unavailable' })), translator: { available: false, reason: 'translator-unavailable', providers: [] } }
    }

    const outcomes = await mapLimit(wanted, TRANSLATE_CONCURRENCY, async (name) => {
      const skill = byName.get(name)
      const description = String(skill?.description ?? '').trim()
      if (description === '') return { name, reason: 'empty-description' }
      try {
        const spec = translator.resolve({ text: description, targetLanguage: TARGET_LANGUAGE, sourceLanguage: 'en' })
        const translated = await translator.translate(spec)
        const zh = text(String(translated ?? '').replace(/\s+/g, ' ').trim(), MAX_ZH)
        if (zh === '') return { name, reason: 'empty-translation' }
        return { name, zh, srcHash: hashOf(description) }
      } catch (error) {
        return { name, reason: error?.code ?? error?.message ?? 'translate-failed' }
      }
    })

    const results = []
    const failures = []
    for (const outcome of outcomes) {
      if (outcome !== undefined && typeof outcome.zh === 'string') results.push(outcome)
      else if (outcome !== undefined) failures.push({ name: outcome.name, reason: outcome.reason })
    }
    // 翻译结果顺手落盘，避免客户端还没保存就丢了。
    if (results.length > 0) {
      const next = { ...document, skills: { ...document.skills } }
      for (const entry of results) {
        const current = next.skills[entry.name] ?? {}
        next.skills[entry.name] = { ...current, zh: entry.zh, srcHash: entry.srcHash }
      }
      try {
        await this.store.save({ document: next, baseRev: document.rev })
      } catch (error) {
        this.ctx.logger?.warn?.(`dsh-skill-easy: 翻译结果保存失败：${error?.message ?? error}`)
      }
    }
    const translatorState = await this.translatorState()
    return { results, failures, document: this.store.snapshot(), translator: translatorState }
  }

  /**
   * 清空所有分类和中文描述。
   * @returns `{ ok, document }`。
   */
  async reset() {
    await this.ready
    const current = this.store.snapshot()
    const outcome = await this.store.save({ document: emptyDocument(), baseRev: current.rev })
    return { ok: outcome.ok === true, document: outcome.document }
  }
}

/** 把服务方法登记成客户端可调用的 Remote 方法（等价于逐个加 @Remote 装饰器）。 */
{
  const methods = ['overview', 'save', 'translate', 'reset']
  const prototype = SkillEasyService.prototype
  for (const name of methods) {
    Remote(name)(prototype[name], {
      name,
      private: false,
      static: false,
      addInitializer(fn) {
        fn.call(Object.create(prototype))
      },
    })
  }
}
