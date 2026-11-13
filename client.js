/**
 * dsh-skill-easy · 客户端半边
 *
 * 两个界面，共用一份数据：
 * 1. 设置 → 技能分类：建分类、给技能归组、写中文描述、一键翻译；
 * 2. 输入框的 `/` 菜单：按分类分段显示，描述优先用中文。
 *
 * 菜单那一半是对官方 `dsh-client-ui-skill` 注册的 slash source 做一次薄包装：
 * 只改写 candidates 的返回（加 section、换描述），排序、插入、引用、图标全部沿用官方实现。
 * 包装失败（宿主改了内部结构）时静默退回原样，设置页会显示「菜单增强未生效」。
 *
 * 不导入任何 Harness Client 包：控件自己写，样式只用主题 token。
 */
window.__ModuleLoader__.load({
  id: 'dsh-skill-easy',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PLUGIN_ID = 'dsh-skill-easy'
    const NS = 'skill-easy'
    const SECTION_ID = 'dsh-skill-easy'
    /** 客户端版本号：和宿主的 CODE_VERSION 一起显示，用来确认页面跑的是哪一版。 */
    const CLIENT_VERSION = 15

    /* ───────────────────────── 文案 ───────────────────────── */

    const UI_zh = {
      nav: '技能分类',
      title: '技能分类',
      intro: '给技能分个类、写句中文描述。之后在输入框输入 / ，技能会按分类分段显示，描述用中文。',
      categories: '分类',
      categoriesHint: '分类顺序就是 / 菜单里的显示顺序。没归类的技能排在最后。',
      searchSkills: '搜索技能名或中文描述',
      newCategory: '新建分类',
      categoryName: '分类名',
      moveUp: '上移',
      moveDown: '下移',
      remove: '删除',
      skills: '技能',
      zhPlaceholder: '留空则显示英文原文',
      uncategorized: '未分类',
      translateAll: '一键翻译未翻译项',
      translating: '翻译中…',
      translateOne: '翻译',
      reset: '全部重置',
      resetConfirm: '确定清空所有分类和中文描述？此操作不可撤销。',
      saved: '已保存',
      saving: '保存中…',
      saveFailed: '保存失败：',
      loading: '正在读取技能目录…',
      loadFailed: '读取失败：',
      retry: '重试',
      menuOn: '菜单增强已生效',
      menuOff: '菜单增强未生效（宿主版本不匹配）',
      menuOffHint: '设置照常可用，只是 / 菜单不会分组。',
      translatorOff: '翻译服务不可用',
      translatorHint: '仍可手动填写中文描述。',
      translatorBuiltin: '翻译走内置 bing（宿主未挂载 translator 服务）',
      userOnly: '仅用户',
      stale: '原文已变',
      emptySkills: '没有发现技能。',
      emptyCategories: '还没有分类。建两个分类，/ 菜单里就会分段显示。',
      failedCount: '条失败',
      doneCount: '已翻译',
      noTargets: '没有需要翻译的技能',
    }

    const UI_en = {
      nav: 'Skill Groups',
      title: 'Skill Groups',
      intro: 'Group your skills and give them a Chinese description. The / menu then shows them grouped, with the Chinese text.',
      categories: 'Groups',
      categoriesHint: 'Group order is the order shown in the / menu. Ungrouped skills come last.',
      searchSkills: 'Search by name or Chinese text',
      newCategory: 'New group',
      categoryName: 'Group name',
      moveUp: 'Move up',
      moveDown: 'Move down',
      remove: 'Remove',
      skills: 'Skills',
      zhPlaceholder: 'Empty keeps the English text',
      uncategorized: 'Ungrouped',
      translateAll: 'Translate untranslated',
      translating: 'Translating…',
      translateOne: 'Translate',
      reset: 'Reset all',
      resetConfirm: 'Clear every group and Chinese description? This cannot be undone.',
      saved: 'Saved',
      saving: 'Saving…',
      saveFailed: 'Save failed: ',
      loading: 'Loading skill catalog…',
      loadFailed: 'Load failed: ',
      retry: 'Retry',
      menuOn: 'Menu grouping active',
      menuOff: 'Menu grouping inactive (host version mismatch)',
      menuOffHint: 'Settings still work; the / menu just stays ungrouped.',
      translatorOff: 'Translation unavailable',
      translatorHint: 'You can still type Chinese descriptions by hand.',
      translatorBuiltin: 'Translating via built-in Bing (host translator service not mounted)',
      userOnly: 'user-only',
      stale: 'source changed',
      emptySkills: 'No skills found.',
      emptyCategories: 'No groups yet. Create two and the / menu starts grouping.',
      failedCount: 'failed',
      doneCount: 'translated',
      noTargets: 'Nothing to translate',
    }

    /* ───────────────────────── Remote 描述表 ───────────────────────── */

    const codec = () => ({
      mode: 'strict',
      typeSymbol: `${PLUGIN_ID}#json`,
      create: () => ({
        parse: (value) => value,
        safeParse: (value) => ({ success: true, data: value }),
      }),
    })

    function descriptor(method, hasParams) {
      return {
        id: `${PLUGIN_ID}#skillEasy/${method}`,
        service: 'skillEasy',
        namespace: 'skillEasy',
        method,
        invocation: { kind: 'direct' },
        ...(hasParams
          ? { parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec() }] }
          : { parameters: [] }),
        result: { mode: 'src-json' },
        cancellation: { parameter: 'signal' },
      }
    }

    const TYPERT_REMOTE = {
      package: PLUGIN_ID,
      descriptors: [
        descriptor('overview', false),
        descriptor('save', true),
        descriptor('translate', true),
        descriptor('reset', false),
      ],
    }

    /* ───────────────────────── 数据模型 ───────────────────────── */

    function createModel() {
      let snapshot = {
        status: 'loading',
        document: null,
        skills: [],
        catalogError: null,
        catalogDiagnostics: [],
        codeVersion: null,
        translator: null,
        error: null,
        menuActive: false,
        menuReason: null,
      }
      const listeners = new Set()
      return {
        /** 注入上下文里的 remote.skillEasy 服务；首屏就绪后由 boot 填入。 */
        namespace: null,
        get: () => snapshot,
        set(patch) {
          snapshot = { ...snapshot, ...patch }
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch (error) {
              console.error('[dsh-skill-easy] 订阅者抛错', error)
            }
          }
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        doc: () => snapshot.document,
        skills: () => snapshot.skills,
      }
    }

    function useSnapshot(model) {
      const [snapshot, setSnapshot] = useState(model.get())
      useEffect(() => {
        setSnapshot(model.get())
        return model.subscribe(() => setSnapshot(model.get()))
      }, [model])
      return snapshot
    }

    /** 空文档：宿主返回异常时也能把设置页渲染出来。 */
    function emptyDocument() {
      return { version: 1, rev: 0, categories: [], skills: {}, options: { menuChinese: true } }
    }

    /** 把异常折成一行可读文本，直接展示给用户。 */
    function describeError(error) {
      if (error === null || error === undefined) return 'unknown error'
      if (typeof error === 'string') return error
      const name = error.name ?? 'Error'
      const message = error.message ?? String(error)
      return message === '' ? name : `${name}: ${message}`
    }

    /**
     * 远程调用返回的是信封 `{ ok, value }`：成功取 value，失败抛错。
     * 这层不解包，拿到的就是信封本身，字段全是 undefined——踩过一次。
     */
    function unwrap(result) {
      if (result === null || result === undefined) throw new Error('远程调用没有返回结果')
      if (result.ok === false) {
        const failure = result.error ?? {}
        throw new Error(failure.message ?? failure.code ?? '远程调用失败')
      }
      return 'value' in result ? result.value : result
    }

    /** 英文描述的短指纹，和宿主用同一套算法（FNV-1a），用来判断中文是否过期。 */
    function hashOf(value) {
      let hash = 0x811c9dc5
      const source = String(value ?? '')
      for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      return hash.toString(16).padStart(8, '0')
    }

    /**
     * 一次保存结果 → 下一步动作。
     *
     * `stale` 有两种含义，必须分开：
     * - 服务端版本正好等于「自己上一次写入的版本」：是连续输入导致自己推进了 rev，本地编辑不能丢 → 重试。
     * - 服务端版本比自己写的还新：确实有另一个页面在改 → 采纳服务端文档。
     * @param outcome - 宿主 save 的业务结果。
     * @param retried - 是否已经重试过。
     * @param ownRev - 本客户端上一次成功写入的 rev。
     * @returns 'done' | 'retry' | 'adopt' | 'error'。
     */
    function planSave(outcome, retried, ownRev) {
      if (outcome?.ok === true) return 'done'
      if (outcome?.reason !== 'stale') return 'error'
      if (retried === true) return 'adopt'
      const serverRev = outcome?.document?.rev
      return Number.isFinite(serverRev) && serverRev === ownRev ? 'retry' : 'adopt'
    }

    /**
     * 挂载 Remote 命名空间，取回命名空间服务。
     *
     * 命名空间是 Cordis 服务 `remote.skillEasy`，由 $mount 动态创建，出现时机不一定同步，
     * 所以两条路一起等：直接取一次，再用 ctx.inject 等它注册；超时就把挂载错误一起报出来。
     */
    function openRemote(ctx) {
      return new Promise((resolve, reject) => {
        let settled = false
        let mountState = 'pending'
        let mountError = null
        const describeMount = () => {
          if (mountState === 'ok') return '挂载已返回，但命名空间未注册'
          if (mountState === 'failed') return `挂载失败：${describeError(mountError)}`
          return '挂载调用一直没返回'
        }
        const finish = (settle, value) => {
          if (settled) return
          settled = true
          settle(value)
        }
        const timer = setTimeout(() => {
          finish(reject, new Error(`remote.skillEasy 在 20 秒内未就绪（${describeMount()}）`))
        }, 20000)

        // 服务已经在：直接返回（ctx.get 不要求本插件 inject 过它）。
        try {
          const direct = ctx.get('remote.skillEasy')
          if (direct !== undefined && direct !== null) {
            clearTimeout(timer)
            finish(resolve, direct)
            return
          }
        } catch (error) {
          // 服务还没注册，走下面的 inject。
        }

        // 服务稍后注册：inject 会在依赖就绪时回调。
        try {
          ctx.inject(['remote.skillEasy'], (child) => {
            clearTimeout(timer)
            finish(resolve, child.remote.skillEasy)
          })
        } catch (error) {
          clearTimeout(timer)
          finish(reject, error)
          return
        }

        Promise.resolve()
          .then(() => ctx.remote.$mount(TYPERT_REMOTE))
          .then(() => {
            mountState = 'ok'
          })
          .catch((error) => {
            // 重复挂载（重试、热重载）不算致命：命名空间可能已经在，交给 inject/超时判定。
            mountState = 'failed'
            mountError = error
            console.error('[dsh-skill-easy] Remote 命名空间挂载失败', error)
          })
      })
    }

    /** 取已就绪的数据通道；没就绪就抛一个能看懂的错。 */
    function channel(ctx, model) {
      const namespace = model.namespace ?? ctx.get('remote.skillEasy')
      if (namespace === undefined || namespace === null) throw new Error('数据通道尚未就绪，请点「重试」')
      return namespace
    }

    /* ───────────────────────── `/` 菜单增强 ───────────────────────── */

    /**
     * 改写官方候选列表：加 section、换中文描述、按分类排序。
     * 没有任何分类时只换描述，保持官方「技能」分组不变。
     */
    function decorateItems(items, doc, skills, t) {
      if (!Array.isArray(items) || items.length === 0) return items
      const zhEnabled = doc?.options?.menuChinese !== false
      const meta = doc?.skills !== null && typeof doc?.skills === 'object' ? doc.skills : {}
      const categories = Array.isArray(doc?.categories) ? doc.categories : []
      const byId = new Map()
      categories.forEach((category, index) => {
        byId.set(category.id, {
          name: category.name,
          order: Number.isFinite(category.order) ? category.order : index * 10,
        })
      })
      const userOnly = new Map()
      for (const skill of skills) userOnly.set(skill.name, skill.modelInvocable === false)

      const rows = items.map((item, index) => {
        const entry = meta[item.name] ?? {}
        const category = entry.categoryId === undefined ? undefined : byId.get(entry.categoryId)
        const zh = zhEnabled && typeof entry.zh === 'string' ? entry.zh : ''
        return {
          item,
          index,
          section: category === undefined ? undefined : category.name,
          order: category === undefined ? Number.MAX_SAFE_INTEGER : category.order,
          zh,
        }
      })

      const grouped = rows.some((row) => row.section !== undefined)
      const output = rows.map((row) => {
        const next = { ...row.item }
        if (row.zh !== '') {
          next.description = userOnly.get(row.item.name) ? `${t('userOnly')} · ${row.zh}` : row.zh
        }
        if (grouped) next.section = row.section ?? t('uncategorized')
        return { next, order: row.order, index: row.index }
      })
      if (grouped) output.sort((left, right) => left.order - right.order || left.index - right.index)
      return output.map((entry) => entry.next)
    }

    /**
     * 包装官方 skill source。找不到就有限重试，最后如实标记未生效。
     * @returns 还原函数。
     */
    function installMenuPatch(ctx, model, t) {
      let disposed = false
      let restore = null
      let timer = null
      let attempts = 0

      const tryInstall = () => {
        if (disposed || restore !== null) return
        attempts += 1
        let source
        try {
          const triggers = ctx.get('inputTriggers')
          const sources = triggers?.live?.sources
          if (Array.isArray(sources)) {
            source = sources.find(
              (candidate) =>
                candidate !== null &&
                typeof candidate === 'object' &&
                candidate.trigger === '/' &&
                candidate.name === 'skill' &&
                typeof candidate.candidates === 'function',
            )
          }
        } catch (error) {
          console.warn('[dsh-skill-easy] 读取触发源失败', error)
        }
        if (source === undefined) {
          if (attempts < 12) {
            timer = setTimeout(tryInstall, 250)
          } else {
            model.set({ menuActive: false, menuReason: 'source-missing' })
            console.warn('[dsh-skill-easy] 未找到官方 skill 触发源，/ 菜单保持原样')
          }
          return
        }
        const original = source.candidates
        source.candidates = async function patchedCandidates(session, options) {
          const items = await original.call(source, session, options)
          try {
            const doc = model.doc()
            if (doc === null) return items
            return decorateItems(items, doc, model.skills(), t)
          } catch (error) {
            console.warn('[dsh-skill-easy] 菜单装饰失败，返回原始候选', error)
            return items
          }
        }
        restore = () => {
          source.candidates = original
        }
        model.set({ menuActive: true, menuReason: null })
      }

      tryInstall()
      return () => {
        disposed = true
        if (timer !== null) clearTimeout(timer)
        if (restore !== null) restore()
      }
    }

    /* ───────────────────────── 样式 ───────────────────────── */

    /**
     * 设置页样式。
     *
     * 原则一：全部走宿主主题 token，深浅色都成立，不写死颜色。
     * 原则二：「静止像文字，聚焦才像输入框」。32 行技能如果每行都画成方框，
     *         页面会变成一片栅栏；这里只在 hover/focus 时显形。
     * 原则三：行距、字号照抄宿主设置页（14/22 行、12/18 说明、.5px 分隔线）。
     * 类名统一 ske- 前缀，避免和宿主或其他插件撞车。
     */
    const SETTINGS_CSS = [
      '.ske-page{display:flex;flex-direction:column;gap:16px;padding:2px 0 40px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}',
      '.ske-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}',
      '.ske-title{margin:0;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.01em}',
      '.ske-intro{margin:6px 0 0;max-width:62ch;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      '.ske-status{display:inline-flex;flex:none;align-items:center;gap:6px;height:26px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;cursor:pointer}',
      '.ske-status:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}',
      '.ske-dot{width:6px;height:6px;border-radius:50%;flex:none}',
      '.ske-status[data-tone="ok"] .ske-dot{background:var(--dsw-alias-state-success-primary)}',
      '.ske-status[data-tone="warn"] .ske-dot{background:var(--dsw-alias-state-warn-primary)}',
      '.ske-toolbar{display:flex;align-items:center;gap:8px}',
      '.ske-search{box-sizing:border-box;flex:0 1 240px;min-width:140px;height:30px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.ske-search::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.ske-spacer{flex:1}',
      '.ske-btn{flex:none;height:30px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}',
      '.ske-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.ske-btn:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.ske-btn--primary{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent);color:var(--dsw-alias-brand-primary)}',
      '.ske-btn--primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}',
      '.ske-btn--quiet{border-color:transparent;padding:0 8px;color:var(--dsw-alias-label-secondary)}',
      '.ske-btn--quiet:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.ske-line{min-height:18px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
      '.ske-line[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}',
      '.ske-line[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
      '.ske-section{display:flex;flex-direction:column;gap:6px}',
      '.ske-sectionHead{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.ske-sectionTitle{margin:0;font-size:13px;font-weight:600;line-height:20px}',
      '.ske-count{margin-left:6px;color:var(--dsw-alias-label-tertiary);font-weight:400;font-variant-numeric:tabular-nums}',
      '.ske-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.ske-empty{margin:0;padding:10px 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      '.ske-note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
      '.ske-catList{display:flex;flex-direction:column}',
      '.ske-catRow{display:flex;align-items:center;gap:10px;padding:4px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.ske-catName{flex:1;min-width:0;height:28px;padding:0 8px;margin-left:-8px;border:.5px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px}',
      '.ske-catName:hover{border-color:var(--dsw-alias-border-l1)}',
      '.ske-catName:focus{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l4)}',
      '.ske-catCount{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}',
      '.ske-catTools{display:flex;align-items:center;gap:2px}',
      '.ske-iconBtn{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;cursor:pointer}',
      '.ske-iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.ske-iconBtn:disabled{opacity:.35;cursor:default}',
      '.ske-textBtn{height:24px;padding:0 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.ske-textBtn:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.ske-group{margin-top:10px}',
      '.ske-groupHead{display:flex;align-items:baseline;gap:8px;padding:4px 0 2px}',
      '.ske-groupName{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.ske-groupCount{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.ske-skillRow{display:grid;grid-template-columns:180px minmax(0,1fr) 128px;align-items:center;gap:10px;padding:3px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.ske-nameCell{display:flex;align-items:center;gap:6px;min-width:0}',
      '.ske-skillName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.ske-tag{flex:none;padding:0 5px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);color:var(--dsw-alias-state-warn-primary);font-size:10px;line-height:16px;white-space:nowrap}',
      '.ske-zh{box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:.5px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.ske-zh::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.ske-zh:hover{border-color:var(--dsw-alias-border-l1)}',
      '.ske-zh:focus{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l4)}',
      '.ske-select{box-sizing:border-box;width:100%;height:28px;padding:0 6px;border:.5px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;color-scheme:light}',
      '@media (prefers-color-scheme:dark){.ske-select{color-scheme:dark}}',
      // 原生下拉层不继承页面配色：不给 option 显式配色，深色模式下就是白底浅字。
      '.ske-select option{background-color:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.ske-select option:checked{background-color:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.ske-select:hover{border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}',
      '.ske-debug{margin:4px 0 0;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}',
      '@media (max-width:680px){.ske-skillRow{grid-template-columns:minmax(0,1fr) 112px}.ske-nameCell{grid-column:1/-1}.ske-search{flex:1 1 auto}}',
      '.ske-btn:focus-visible,.ske-status:focus-visible,.ske-iconBtn:focus-visible,.ske-textBtn:focus-visible,.ske-search:focus-visible,.ske-zh:focus-visible,.ske-select:focus-visible,.ske-catName:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
    ].join('')


    /* ───────────────────────── 设置页 ───────────────────────── */

    function nextCategoryId(categories) {
      const taken = new Set(categories.map((category) => category.id))
      let index = categories.length + 1
      while (taken.has(`c${index}`)) index += 1
      return `c${index}`
    }

    function SettingsView(props) {
      const { ctx, t, model } = props
      const snapshot = useSnapshot(model)
      const [draft, setDraft] = useState(null)
      const [saveState, setSaveState] = useState('idle')
      const [saveError, setSaveError] = useState('')
      const [busy, setBusy] = useState('')
      const [report, setReport] = useState(null)
      const [showDebug, setShowDebug] = useState(false)
      const [query, setQuery] = useState('')
      /** 调试开关（点版本号展开）：只保留最近 12 条，定位「草稿被回退」这类时序问题用。 */
      const debugLog = useRef([])
      const trace = (label) => {
        const now = new Date()
        const stamp = `${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`
        debugLog.current = [...debugLog.current.slice(-11), `${stamp} ${label}`]
      }
      const timer = useRef(null)
      const dirty = useRef(false)
      const editSeq = useRef(0)
      /**
       * 服务端文档的版本号。
       * 单独用 ref 存，而不是从草稿里读：保存成功时用户往往已经继续输入，
       * 那条路径会跳过采纳响应，草稿里的 rev 就过期了——下一次保存会被乐观锁判 stale 并回滚。
       */
      const revRef = useRef(0)
      /** 本客户端上一次成功写入的 rev：用来区分「自己推进的 rev」和「别的页面改过」。 */
      const lastWritten = useRef(0)
      /** 已经采纳过的最高 rev：迟到的旧响应不许把界面状态回退。 */
      const adoptedRev = useRef(0)

      // 没有本地未保存改动时，跟随模型（首次加载、翻译返回、重置）。
      useEffect(() => {
        if (snapshot.document !== null && Number.isFinite(snapshot.document.rev)) {
          revRef.current = snapshot.document.rev
          adoptedRev.current = Math.max(adoptedRev.current, snapshot.document.rev)
        }
        if (dirty.current) {
          trace('sync skipped (dirty)')
          return
        }
        if (snapshot.document !== null) {
          trace(`draft <- server rev ${snapshot.document.rev}`)
          setDraft(snapshot.document)
        } else if (snapshot.status === 'ready') setDraft(emptyDocument())
      }, [snapshot.document, snapshot.status])

      useEffect(() => () => {
        if (timer.current !== null) clearTimeout(timer.current)
      }, [])

      const saveNow = useCallback((next) => {
        if (timer.current !== null) {
          clearTimeout(timer.current)
          timer.current = null
        }
        // 分类名暂时为空（比如全选准备改写）时不发请求：宿主会把空名分类丢掉，
        // 返回的文档再覆盖本地草稿，看起来就像「一边打字一边消失」。
        const invalid = (Array.isArray(next?.categories) ? next.categories : [])
          .some((category) => typeof category?.name !== 'string' || category.name.trim() === '')
        if (invalid) {
          setSaveState('invalid')
          setSaveError('分类名不能为空')
          return Promise.resolve(false)
        }
        const at = editSeq.current
        setSaveState('saving')

        /**
         * 发一次保存。`retried` 用来限制「按最新 rev 重试」只做一次。
         */
        const send = (baseRev, retried) => Promise.resolve()
          .then(() => channel(ctx, model).save({ document: next, baseRev }))
          .then((result) => unwrap(result))
          .then((result) => {
            const step = planSave(result, retried, lastWritten.current)
            trace(`save base=${baseRev} retry=${retried} -> ${step}${result?.document ? ` rev=${result.document.rev}` : ''}`)
            if (step === 'done') {
              // 无论本地是否已被更新的输入取代，都要记住服务端推进后的 rev。
              if (Number.isFinite(result.document?.rev)) {
                // 并发保存时响应可能乱序：迟到的旧 rev 不许把已经采纳的新状态回退。
                if (result.document.rev < adoptedRev.current) {
                  trace(`ignore late response rev ${result.document.rev} < ${adoptedRev.current}`)
                  return true
                }
                revRef.current = result.document.rev
                lastWritten.current = result.document.rev
                adoptedRev.current = result.document.rev
              }
              // 保存期间又改过：只同步 rev，别用旧快照盖掉输入。
              if (editSeq.current !== at) return true
              dirty.current = false
              model.set({ document: result.document })
              setSaveState('saved')
              setSaveError('')
              return true
            }
            if (step === 'retry') {
              // 版本冲突：多半是「自己上一次保存刚推进了 rev」，本地编辑不该被丢弃。
              const serverRev = Number.isFinite(result?.document?.rev) ? result.document.rev : revRef.current
              revRef.current = serverRev
              return send(serverRev, true)
            }
            if (step === 'adopt') {
              // 重试后仍然冲突：确实有另一个页面在同时改，这时才采纳服务端文档。
              dirty.current = false
              if (result.document !== undefined && result.document !== null) {
                if (Number.isFinite(result.document.rev)) revRef.current = result.document.rev
                model.set({ document: result.document })
              }
              setSaveState('error')
              setSaveError('数据已被另一个页面改过，已载入最新内容，请重试这次修改')
              return false
            }
            setSaveState('error')
            setSaveError(String(result?.reason ?? 'save-failed'))
            return false
          })

        return send(revRef.current, false)
          .catch((error) => {
            setSaveState('error')
            setSaveError(String(error?.message ?? error))
            return false
          })
      }, [ctx, model])

      const persist = useCallback((next) => {
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          timer.current = null
          saveNow(next)
        }, 450)
      }, [saveNow])

      const commit = useCallback((next) => {
        dirty.current = true
        editSeq.current += 1
        setDraft(next)
        persist(next)
      }, [persist])

      const categories = draft?.categories ?? []
      const meta = draft?.skills ?? {}

      const orderedSkills = useMemo(() => {
        const orderOf = new Map(categories.map((category, index) => [category.id, Number.isFinite(category.order) ? category.order : index * 10]))
        return [...snapshot.skills].sort((left, right) => {
          const leftCat = meta[left.name]?.categoryId
          const rightCat = meta[right.name]?.categoryId
          const leftOrder = leftCat === undefined || !orderOf.has(leftCat) ? Number.MAX_SAFE_INTEGER : orderOf.get(leftCat)
          const rightOrder = rightCat === undefined || !orderOf.has(rightCat) ? Number.MAX_SAFE_INTEGER : orderOf.get(rightCat)
          if (leftOrder !== rightOrder) return leftOrder - rightOrder
          return left.name.localeCompare(right.name)
        })
      }, [snapshot.skills, meta, categories])

      const pendingNames = useMemo(
        () => snapshot.skills
          .filter((skill) => {
            const entry = meta[skill.name] ?? {}
            if (typeof entry.zh !== 'string' || entry.zh === '') return true
            return entry.srcHash !== skill.srcHash
          })
          .map((skill) => skill.name),
        [snapshot.skills, meta],
      )

      const addCategory = () => {
        const id = nextCategoryId(categories)
        const maxOrder = categories.reduce((max, category) => Math.max(max, Number.isFinite(category.order) ? category.order : 0), 0)
        commit({
          ...draft,
          categories: [...categories, { id, name: t('newCategory'), order: maxOrder + 10 }],
        })
      }

      const patchCategory = (id, patch) => {
        commit({
          ...draft,
          categories: categories.map((category) => (category.id === id ? { ...category, ...patch } : category)),
        })
      }

      const removeCategory = (id) => {
        const skills = {}
        for (const [name, entry] of Object.entries(meta)) {
          if (entry.categoryId === id) {
            const { categoryId, ...rest } = entry
            if (Object.keys(rest).length > 0) skills[name] = rest
          } else {
            skills[name] = entry
          }
        }
        commit({ ...draft, categories: categories.filter((category) => category.id !== id), skills })
      }

      const moveCategory = (id, delta) => {
        const index = categories.findIndex((category) => category.id === id)
        const target = index + delta
        if (index < 0 || target < 0 || target >= categories.length) return
        const next = [...categories]
        const [moved] = next.splice(index, 1)
        next.splice(target, 0, moved)
        commit({ ...draft, categories: next.map((category, position) => ({ ...category, order: position * 10 })) })
      }

      const patchSkill = (name, patch) => {
        const current = meta[name] ?? {}
        const merged = { ...current, ...patch }
        const skills = { ...meta }
        if (merged.zh === undefined || merged.zh === '') {
          delete merged.zh
          delete merged.srcHash
        }
        if (merged.categoryId === undefined || merged.categoryId === '') delete merged.categoryId
        if (Object.keys(merged).length === 0) delete skills[name]
        else skills[name] = merged
        commit({ ...draft, skills })
      }

      const translate = (names) => {
        const targets = names ?? pendingNames
        if (targets.length === 0) {
          setReport({ text: t('noTargets') })
          return
        }
        setBusy('translate')
        setReport(null)
        // 先把还没落盘的编辑存掉，否则翻译返回的整份文档会覆盖掉它们。
        const flushed = dirty.current && draft !== null ? saveNow(draft) : Promise.resolve(true)
        flushed
          .then(() => channel(ctx, model).translate({
            names: targets,
            skills: snapshot.skills.map((skill) => ({ name: skill.name, description: skill.description })),
          }))
          .then((result) => unwrap(result))
          .then((result) => {
            if (result?.document !== undefined && result.document !== null) {
              dirty.current = false
              if (Number.isFinite(result.document.rev)) {
                revRef.current = result.document.rev
                lastWritten.current = result.document.rev
              }
              // 只接纳服务端的中文描述和版本号：分类结构以本地为准，
              // 免得服务端丢掉的空名分类把本地正在编辑的内容一起覆盖掉。
              const local = draft
              const localValid = local !== null
                && !(local.categories ?? []).some((category) => typeof category?.name !== 'string' || category.name.trim() === '')
              model.set({
                document: localValid
                  ? { ...local, skills: result.document.skills ?? local.skills, rev: result.document.rev }
                  : result.document,
                translator: result.translator ?? snapshot.translator,
              })
            }
            const done = Array.isArray(result?.results) ? result.results.length : 0
            const failed = Array.isArray(result?.failures) ? result.failures : []
            setReport({
              text: failed.length === 0
                ? `${t('doneCount')} ${done}`
                : `${t('doneCount')} ${done} · ${failed.length} ${t('failedCount')}：${failed.slice(0, 3).map((entry) => `${entry.name}（${entry.reason}）`).join('，')}`,
            })
          })
          .catch((error) => setReport({ text: `${t('saveFailed')}${String(error?.message ?? error)}`, error: true }))
          .finally(() => setBusy(''))
      }

      const reset = () => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(t('resetConfirm'))) return
        setBusy('reset')
        Promise.resolve()
          .then(() => channel(ctx, model).reset())
          .then((result) => unwrap(result))
          .then((result) => {
            if (result?.ok === true) {
              dirty.current = false
              if (Number.isFinite(result.document?.rev)) {
                revRef.current = result.document.rev
                lastWritten.current = result.document.rev
              }
              model.set({ document: result.document })
              setSaveState('saved')
            }
          })
          .catch((error) => setReport({ text: String(error?.message ?? error), error: true }))
          .finally(() => setBusy(''))
      }

      const translatorOff = snapshot.translator !== null && snapshot.translator.available === false
      // 宿主没挂 translator 服务时，宿主半边会走内置 bing 兜底：翻译照常可用，
      // 只是要让人知道描述发出去了，所以在标题旁标一句，而不是弹「不可用」。
      const translatorBuiltin = snapshot.translator !== null
        && snapshot.translator.available !== false
        && snapshot.translator.mode === 'builtin'

      /**
       * 当前生效的主题（light / dark）。
       * 原生 select 的下拉层由浏览器绘制，不吃页面的 CSS 变量，只能靠 color-scheme 告诉它配色；
       * 宿主允许强制深色（与系统不同），所以优先读主题服务，读不到再交给 CSS 的媒体查询兜底。
       */
      const themeMode = (() => {
        try {
          const theme = ctx.get('theme')
          const id = theme?.getTheme?.()?.active?.id
          return id === 'dark' ? 'dark' : id === 'light' ? 'light' : undefined
        } catch (error) {
          return undefined
        }
      })()

      // 工具条下面那一条状态：保存状态和最近一次操作结果共用一个位置，字号统一，不跳。
      const statusText = (() => {
        if (report !== null && typeof report.text === 'string' && report.text !== '') {
          return { text: report.text, tone: report.error === true ? 'error' : 'info' }
        }
        if (saveState === 'saving') return { text: t('saving'), tone: 'info' }
        if (saveState === 'saved') return { text: t('saved'), tone: 'info' }
        if (saveState === 'invalid') return { text: saveError, tone: 'warn' }
        if (saveState === 'error') return { text: `${t('saveFailed')}${saveError}`, tone: 'error' }
        return null
      })()

      const header = h('header', { className: 'ske-head' },
        h('div', null,
          h('h2', { className: 'ske-title' }, t('title')),
          h('p', { className: 'ske-intro' }, t('intro')),
        ),
        h('button', {
          type: 'button',
          className: 'ske-status',
          'data-tone': snapshot.menuActive ? 'ok' : 'warn',
          title: '点一下查看调试信息',
          onClick: () => setShowDebug((value) => !value),
        },
          h('span', { className: 'ske-dot' }),
          `${snapshot.menuActive ? t('menuOn') : t('menuOff')} · v${snapshot.codeVersion ?? '?'}/${CLIENT_VERSION}`,
        ),
      )

      if (snapshot.status === 'loading' || draft === null) {
        if (snapshot.status === 'error') {
          return h('div', { className: 'ske-page' },
            h('style', { dangerouslySetInnerHTML: { __html: SETTINGS_CSS } }),
            header,
            h('p', { className: 'ske-line', 'data-tone': 'error' }, `${t('loadFailed')}${snapshot.error ?? ''}`),
            h('div', null, h('button', { type: 'button', className: 'ske-btn ske-btn--primary', onClick: () => model.reload?.() }, t('retry'))),
          )
        }
        return h('div', { className: 'ske-page' },
          h('style', { dangerouslySetInnerHTML: { __html: SETTINGS_CSS } }),
          header,
          h('p', { className: 'ske-note' }, t('loading')),
        )
      }

      // 技能按分类分组：空分类不占位置，未归类的单独一组放最后。
      const needle = query.trim().toLowerCase()
      const groupMap = new Map(categories.map((category) => [category.id, { key: category.id, name: category.name, skills: [] }]))
      const ungrouped = { key: '__ungrouped__', name: t('uncategorized'), skills: [] }
      for (const skill of orderedSkills) {
        const entry = meta[skill.name] ?? {}
        if (needle !== '') {
          const haystack = `${skill.name} ${typeof entry.zh === 'string' ? entry.zh : ''} ${skill.description ?? ''}`.toLowerCase()
          if (!haystack.includes(needle)) continue
        }
        const bucket = groupMap.get(entry.categoryId) ?? ungrouped
        bucket.skills.push(skill)
      }
      const groups = [...groupMap.values()].filter((group) => group.skills.length > 0)
      if (ungrouped.skills.length > 0) groups.push(ungrouped)

      const countOf = (id) => snapshot.skills.reduce((total, skill) => (meta[skill.name]?.categoryId === id ? total + 1 : total), 0)

      const categorySection = h('section', { className: 'ske-section' },
        h('div', { className: 'ske-sectionHead' },
          h('h3', { className: 'ske-sectionTitle' }, t('categories'), h('span', { className: 'ske-count' }, String(categories.length))),
          h('button', { type: 'button', className: 'ske-btn ske-btn--quiet', onClick: addCategory }, `+ ${t('newCategory')}`),
        ),
        categories.length === 0
          ? h('p', { className: 'ske-empty' }, t('emptyCategories'))
          : h('div', { className: 'ske-catList' }, categories.map((category, index) => h('div', { key: category.id, className: 'ske-catRow' },
            h('input', {
              className: 'ske-catName',
              value: category.name,
              'aria-label': t('categoryName'),
              maxLength: 24,
              // 新建的分类默认叫「新建分类」，聚焦时全选，直接打字就能替换。
              onFocus: (event) => event.currentTarget.select(),
              onChange: (event) => patchCategory(category.id, { name: event.target.value }),
            }),
            h('span', { className: 'ske-catCount' }, String(countOf(category.id))),
            h('div', { className: 'ske-catTools' },
              h('button', {
                type: 'button', className: 'ske-iconBtn', disabled: index === 0,
                'aria-label': t('moveUp'), title: t('moveUp'), onClick: () => moveCategory(category.id, -1),
              }, '↑'),
              h('button', {
                type: 'button', className: 'ske-iconBtn', disabled: index === categories.length - 1,
                'aria-label': t('moveDown'), title: t('moveDown'), onClick: () => moveCategory(category.id, 1),
              }, '↓'),
              h('button', { type: 'button', className: 'ske-textBtn', onClick: () => removeCategory(category.id) }, t('remove')),
            ),
          ))),
        h('p', { className: 'ske-hint' }, t('categoriesHint')),
      )

      const skillSection = h('section', { className: 'ske-section' },
        h('div', { className: 'ske-sectionHead' },
          h('h3', { className: 'ske-sectionTitle' }, t('skills'), h('span', { className: 'ske-count' }, String(snapshot.skills.length))),
          translatorOff
            ? h('span', { className: 'ske-note' }, `${t('translatorOff')} · ${t('translatorHint')}`)
            : translatorBuiltin
              ? h('span', { className: 'ske-note' }, t('translatorBuiltin'))
              : null,
        ),
        snapshot.skills.length === 0
          ? h('div', null,
            h('p', { className: 'ske-empty' }, t('emptySkills')),
            snapshot.catalogError === null
              ? null
              : h('p', { className: 'ske-line', 'data-tone': 'error' }, `读取技能目录失败：${snapshot.catalogError}`),
            h('p', { className: 'ske-note' }, `来源尝试：${Array.isArray(snapshot.catalogDiagnostics) && snapshot.catalogDiagnostics.length > 0 ? snapshot.catalogDiagnostics.join(' · ') : '（宿主没有返回任何来源信息）'}`),
            h('p', { className: 'ske-note' }, `版本：宿主 v${snapshot.codeVersion ?? '?'} / 客户端 v${CLIENT_VERSION}`),
          )
          : h('div', null, groups.map((group) => h('div', { key: group.key, className: 'ske-group' },
            h('div', { className: 'ske-groupHead' },
              h('span', { className: 'ske-groupName' }, group.name),
              h('span', { className: 'ske-groupCount' }, String(group.skills.length)),
            ),
            group.skills.map((skill) => {
              const entry = meta[skill.name] ?? {}
              const stale = typeof entry.zh === 'string' && entry.zh !== '' && entry.srcHash !== skill.srcHash
              return h('div', { key: skill.name, className: 'ske-skillRow' },
                h('span', { className: 'ske-nameCell' },
                  h('span', { className: 'ske-skillName', title: skill.description }, skill.name),
                  stale ? h('span', { className: 'ske-tag' }, t('stale')) : null,
                ),
                h('input', {
                  className: 'ske-zh',
                  value: entry.zh ?? '',
                  placeholder: t('zhPlaceholder'),
                  'aria-label': `${skill.name} 中文描述`,
                  maxLength: 200,
                  onChange: (event) => patchSkill(skill.name, { zh: event.target.value, srcHash: skill.srcHash }),
                }),
                h('select', {
                  className: 'ske-select',
                  value: entry.categoryId ?? '',
                  'aria-label': `${skill.name} 分类`,
                  style: themeMode === undefined ? undefined : { colorScheme: themeMode },
                  onChange: (event) => patchSkill(skill.name, { categoryId: event.target.value === '' ? undefined : event.target.value }),
                },
                  h('option', { value: '' }, t('uncategorized')),
                  categories.map((category) => h('option', { key: category.id, value: category.id }, category.name)),
                ),
              )
            }),
          ))),
        groups.length === 0 && snapshot.skills.length > 0
          ? h('p', { className: 'ske-empty' }, `没有匹配「${query}」的技能`)
          : null,
      )

      const debugBlock = showDebug
        ? h('pre', { className: 'ske-debug' }, [
          `draft.rev ${draft?.rev} / server.rev ${snapshot.document?.rev} / ref ${revRef.current} / written ${lastWritten.current} / dirty ${String(dirty.current)} / state ${saveState}`,
          `draft cats: ${(draft?.categories ?? []).map((category) => `${category.id}:${category.name}`).join(', ')}`,
          `server cats: ${(snapshot.document?.categories ?? []).map((category) => `${category.id}:${category.name}`).join(', ')}`,
          `skills ${snapshot.skills.length} · status ${snapshot.status}`,
          '——',
          ...debugLog.current.slice(-10),
        ].join('\n'))
        : null

      return h('div', { className: 'ske-page' },
        h('style', { dangerouslySetInnerHTML: { __html: SETTINGS_CSS } }),
        header,
        h('div', { className: 'ske-toolbar' },
          h('input', {
            className: 'ske-search',
            value: query,
            placeholder: t('searchSkills'),
            'aria-label': t('searchSkills'),
            onChange: (event) => setQuery(event.target.value),
          }),
          h('span', { className: 'ske-spacer' }),
          h('button', {
            type: 'button',
            className: 'ske-btn ske-btn--primary',
            disabled: busy !== '' || pendingNames.length === 0,
            onClick: () => translate(),
          }, busy === 'translate' ? t('translating') : `${t('translateAll')}${pendingNames.length > 0 ? `（${pendingNames.length}）` : ''}`),
          h('button', { type: 'button', className: 'ske-btn', disabled: busy !== '', onClick: reset }, t('reset')),
        ),
        h('div', { className: 'ske-line', 'data-tone': statusText === null ? 'info' : statusText.tone }, statusText === null ? '' : statusText.text),
        categorySection,
        skillSection,
        debugBlock,
      )
    }

    /* ───────────────────────── 插件入口 ───────────────────────── */

    const inject = ['slots', 'locale', 'remote']

    function apply(ctx) {
      const model = createModel()

      ctx.effect(() => ctx.locale.register(NS, { zh: UI_zh, en: UI_en }), 'dsh-skill-easy: locale')
      const t = ctx.locale.bind(NS)

      // 首屏数据：挂载 Remote 命名空间，再拉一次全量视图。
      let generation = 0
      const boot = () => {
        const mine = ++generation
        model.set({ status: 'loading', error: null })
        Promise.resolve()
          .then(() => openRemote(ctx))
          .then(async (namespace) => {
            // 记住这个对象：它是注入上下文里的命名空间服务，直接调方法不会再报 inject 错误。
            model.namespace = namespace
            return unwrap(await namespace.overview())
          })
          .then(async (view) => {
            if (mine !== generation) return
            model.set({
              status: 'ready',
              document: view?.document ?? null,
              skills: Array.isArray(view?.skills) ? view.skills : [],
              catalogError: view?.catalogError ?? null,
              catalogDiagnostics: Array.isArray(view?.catalogDiagnostics) ? view.catalogDiagnostics : [],
              codeVersion: view?.codeVersion ?? null,
              translator: view?.translator ?? null,
            })
          })
          .catch((error) => {
            if (mine !== generation) return
            console.error('[dsh-skill-easy] 初始化失败', error)
            model.set({ status: 'error', error: describeError(error) })
          })
      }
      model.reload = boot
      ctx.effect(() => {
        boot()
        return () => {
          generation += 1
        }
      }, 'dsh-skill-easy: overview')

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: 46,
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ t }),
        }, (ownerProps) => h(SettingsView, { ctx, t, model, ...ownerProps })))

      ctx.effect(() => installMenuPatch(ctx, model, t), 'dsh-skill-easy: slash menu')
    }

    // `__test` 只给 test/ 下的回归用例用，运行时不读它。
    return { inject, apply, __test: { planSave, hashOf, unwrap } }
  },
})
