/**
 * / 菜单增强的回归用例。
 *
 * 这一层没有 UI 可断言，能测的是纯逻辑：候选列表被改写后是否
 * 按分类分段、中文描述是否生效、没有分类时是否保持官方顺序。
 * 顺带验证 client.js 能被模块加载器解析、apply 能装到假的 ctx 上。
 *
 * 运行：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = await readFile(join(here, '..', 'client.js'), 'utf8')

/** 一个够用的 React 替身：只要工厂能建元素、hooks 能跑。 */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
}

/** 把 client.js 当成浏览器脚本执行，取回模块定义。 */
function loadModule() {
  let definition
  globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value } } }
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'require', clientSource)
  run(globalThis.window, (name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  return definition
}

/** 造一个只有菜单相关部分的客户端 ctx。 */
function createHarness(options = {}) {
  const source = {
    trigger: '/',
    name: 'skill',
    order: 2,
    async candidates() {
      return [
        { name: 'check', description: 'Reviews diffs, PRs, release readiness.' },
        { name: 'agent-experience', description: 'Use when writing a model-facing tool definition.' },
        { name: 'domain-modeling', description: 'Build and sharpen a project domain model.' },
      ]
    },
  }
  const ctx = {
    effects: [],
    effect(fn) {
      const dispose = fn()
      this.effects.push(dispose)
      return dispose
    },
    get(name) {
      if (name === 'inputTriggers') return { live: { sources: [source] } }
      if (name === 'remote.skillEasy') return ctx.remote.skillEasy
      return undefined
    },
    inject(deps, callback) {
      // 假 ctx：依赖总是就绪，立刻回调。
      callback(this)
      return { dispose: () => {} }
    },
    locale: {
      register() {
        return () => {}
      },
      bind() {
        return (key) => (key === 'uncategorized' ? '未分类' : key === 'userOnly' ? '仅用户' : key)
      },
    },
    slots: {
      inject() {},
      register() {
        return () => {}
      },
    },
    remote: {
      async $mount() {},
      skillEasy: {
        async overview() {
          return {
            document: options.document ?? { version: 1, categories: [], skills: {}, options: { menuChinese: true } },
            skills: [
              { name: 'check', description: 'Reviews diffs, PRs, release readiness.', srcHash: 'h-check', modelInvocable: true },
              { name: 'agent-experience', description: 'Use when writing a model-facing tool definition.', srcHash: 'h-agent', modelInvocable: true },
              { name: 'domain-modeling', description: 'Build and sharpen a project domain model.', srcHash: 'h-domain', modelInvocable: false },
            ],
            translator: { available: true, reason: null, providers: ['bing'] },
          }
        },
        async save(request) {
          return { ok: true, document: request.document }
        },
        async translate() {
          return { results: [], failures: [], document: null, translator: { available: true, providers: [] } }
        },
        async reset() {
          return { ok: true, document: { version: 1, categories: [], skills: {}, options: { menuChinese: true } } }
        },
      },
    },
  }
  return { ctx, source }
}

/** 等首屏数据落地（overview 是异步的）。 */
async function settle() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 5))
}

test('没有分类时不加 section，只换中文描述', async () => {
  const definition = loadModule()
  assert.equal(definition.id, 'dsh-skill-easy')
  assert.deepEqual(definition.factory(() => React).inject, ['slots', 'locale', 'remote'])

  const { ctx, source } = createHarness({
    document: {
      version: 1,
      categories: [],
      skills: { check: { zh: '审查改动与发布就绪度', srcHash: 'h-check' } },
      options: { menuChinese: true },
    },
  })
  const plugin = definition.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  plugin.apply(ctx)
  await settle()

  const items = await source.candidates({ sessionId: 's1' }, { query: '' })
  assert.deepEqual(items.map((item) => item.name), ['check', 'agent-experience', 'domain-modeling'])
  assert.equal(items[0].description, '审查改动与发布就绪度')
  assert.equal(items[1].description, 'Use when writing a model-facing tool definition.')
  assert.equal(items[0].section, undefined)
})

test('有分类时按分类顺序分段，未归类的排最后', async () => {
  const definition = loadModule()
  const { ctx, source } = createHarness({
    document: {
      version: 1,
      categories: [{ id: 'review', name: '审查', order: 10 }],
      skills: {
        check: { categoryId: 'review', zh: '审查改动', srcHash: 'h-check' },
        'domain-modeling': { zh: '领域建模', srcHash: 'h-domain' },
      },
      options: { menuChinese: true },
    },
  })
  const plugin = definition.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  plugin.apply(ctx)
  await settle()

  const items = await source.candidates({ sessionId: 's1' }, { query: '' })
  assert.deepEqual(items.map((item) => item.name), ['check', 'agent-experience', 'domain-modeling'])
  assert.equal(items[0].section, '审查')
  assert.equal(items[0].description, '审查改动')
  assert.equal(items[1].section, '未分类')
  assert.equal(items[2].section, '未分类')
  // 仅用户可调用的技能保留标记
  assert.equal(items[2].description, '仅用户 · 领域建模')
})

test('没有中文描述时完全沿用官方候选', async () => {
  const definition = loadModule()
  const { ctx, source } = createHarness()
  const plugin = definition.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  plugin.apply(ctx)
  await settle()

  const items = await source.candidates({ sessionId: 's1' }, { query: '' })
  assert.deepEqual(items.map((item) => item.name), ['check', 'agent-experience', 'domain-modeling'])
  assert.equal(items[0].description, 'Reviews diffs, PRs, release readiness.')
  assert.equal(items[0].section, undefined)
})

test('找不到官方 source 时不抛错，标记菜单未生效', async () => {
  const definition = loadModule()
  const { ctx } = createHarness()
  ctx.get = () => undefined
  const plugin = definition.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  assert.doesNotThrow(() => plugin.apply(ctx))
  await settle()
})

test('保存冲突：先按最新 rev 重试，重试仍冲突才采纳服务端（回归：改名被回滚）', () => {
  const definition = loadModule()
  const { planSave } = definition.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  }).__test

  assert.equal(planSave({ ok: true, document: { rev: 3 } }, false, 0), 'done')
  // 回归点：旧实现把任何 stale 都当成「别人改过」直接采纳服务端文档，
  // 于是用户自己上一次保存推进 rev 后，下一次改名会被回滚。
  assert.equal(planSave({ ok: false, reason: 'stale', document: { rev: 9 } }, false, 9), 'retry')
  // 真冲突：服务端版本比自己写的还新，采纳服务端文档才对。
  assert.equal(planSave({ ok: false, reason: 'stale', document: { rev: 10 } }, false, 9), 'adopt')
  assert.equal(planSave({ ok: false, reason: 'stale', document: { rev: 9 } }, true, 9), 'adopt')
  assert.equal(planSave({ ok: false, reason: 'save-failed' }, false, 9), 'error')
  assert.equal(planSave(undefined, false, 9), 'error')
})

test('中文过期判断用的哈希稳定且对内容敏感', () => {
  const definition = loadModule()
  const { hashOf } = definition.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  }).__test

  assert.equal(hashOf('same text'), hashOf('same text'))
  assert.notEqual(hashOf('same text'), hashOf('same text.'))
  assert.match(hashOf(''), /^[0-9a-f]{8}$/)
})

test('设置页用到的每个 class 都在 SETTINGS_CSS 里有定义', () => {
  const cssBlock = clientSource.match(/const SETTINGS_CSS = \[([\s\S]*?)\]\.join\(''\)/)
  assert.ok(cssBlock, 'SETTINGS_CSS 找不到')
  const css = [...cssBlock[1].matchAll(/'([^']*)'/g)].map((match) => match[1]).join('')
  assert.ok(css.length > 500, '样式内容过短，疑似被截断')

  const used = new Set()
  for (const match of clientSource.matchAll(/className: '([^']+)'/g)) {
    for (const name of match[1].split(/\s+/)) if (name !== '') used.add(name)
  }
  assert.ok(used.size >= 15, `className 数量异常：${used.size}`)
  for (const name of used) {
    assert.ok(css.includes(`.${name}`), `设置页用了 .${name} 但样式里没有定义`)
  }
})

