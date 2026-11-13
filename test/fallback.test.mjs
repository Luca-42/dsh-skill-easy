/**
 * 内置兜底翻译的回归用例。
 *
 * 这一层要断的是「宿主没挂 translator 服务时，一键翻译仍然能翻」：
 * - 请求形状（端点、查询串、body、content-type）必须和宿主 translator 的 bing 分支一致；
 * - 响应解析、HTTP 错误、体积超限、超时各自映射成稳定的 `code`，客户端能直接显示；
 * - 空文本不发请求。
 *
 * fetch 全部用假实现替换，跑测试不需要联网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FALLBACK_ENDPOINT,
  bingLanguage,
  buildRequest,
  parsePayload,
  translateDirect,
} from '../fallback.js'

/** 临时替换 globalThis.fetch，返回一个还原函数。 */
function withFetch(impl) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return () => {
    globalThis.fetch = original
  }
}

/** 一次正常的 bing 响应。 */
function bingResponse(text, init) {
  return new Response(JSON.stringify([{ translations: [{ text }] }]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

test('语言标签：zh-CN 归一成 bing 的 zh-Hans', () => {
  assert.equal(bingLanguage('zh-CN'), 'zh-Hans')
  assert.equal(bingLanguage('zh'), 'zh-Hans')
  assert.equal(bingLanguage('zh-TW'), 'zh-Hant')
  assert.equal(bingLanguage('ja'), 'ja')
})

test('请求形状：POST 到 bing 端点，body 是单元素数组', () => {
  const { url, init } = buildRequest('Reviews diffs and PRs.', { targetLanguage: 'zh-CN' })
  const parsed = new URL(url)
  assert.equal(parsed.origin + parsed.pathname, FALLBACK_ENDPOINT)
  assert.equal(parsed.searchParams.get('to'), 'zh-Hans')
  assert.equal(parsed.searchParams.get('isEnterpriseClient'), 'false')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(init.body), ['Reviews diffs and PRs.'])
})

test('响应解析：取第一卷的 translations[0].text', () => {
  assert.equal(parsePayload([{ translations: [{ text: '检查代码并修复错误' }] }]), '检查代码并修复错误')
})

test('响应解析：结构不对时报 TRANSLATION_INVALID_RESPONSE', () => {
  for (const payload of [null, [], [{}], [{ translations: [] }], [{ translations: [{ text: 1 }] }]]) {
    assert.throws(() => parsePayload(payload), (error) => error.code === 'TRANSLATION_INVALID_RESPONSE')
  }
})

test('译文：正常返回原文对应的中文', async () => {
  let seen
  const restore = withFetch(async (url, init) => {
    seen = { url: String(url), init }
    return bingResponse('检查代码并修复登录流程中的错误')
  })
  try {
    const zh = await translateDirect('Checks code and fixes errors in the login flow.')
    assert.equal(zh, '检查代码并修复登录流程中的错误')
    assert.match(seen.url, /edge\.microsoft\.com/)
    assert.deepEqual(JSON.parse(seen.init.body), ['Checks code and fixes errors in the login flow.'])
  } finally {
    restore()
  }
})

test('译文：HTTP 非 2xx 报 TRANSLATION_HTTP_ERROR', async () => {
  const restore = withFetch(async () => new Response('nope', { status: 503 }))
  try {
    await assert.rejects(() => translateDirect('anything'), (error) => {
      assert.equal(error.code, 'TRANSLATION_HTTP_ERROR')
      assert.match(error.message, /503/)
      return true
    })
  } finally {
    restore()
  }
})

test('译文：响应超过体积上限报 TRANSLATION_RESPONSE_LIMIT', async () => {
  const restore = withFetch(async () => bingResponse('很长的一段译文'))
  try {
    await assert.rejects(() => translateDirect('anything', { maxBytes: 4 }), (error) => error.code === 'TRANSLATION_RESPONSE_LIMIT')
  } finally {
    restore()
  }
})

test('译文：超时报 TRANSLATION_TIMEOUT', async () => {
  const restore = withFetch((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  }))
  try {
    await assert.rejects(() => translateDirect('anything', { timeoutMs: 10 }), (error) => error.code === 'TRANSLATION_TIMEOUT')
  } finally {
    restore()
  }
})

test('译文：空文本不发请求', async () => {
  let called = false
  const restore = withFetch(async () => {
    called = true
    return bingResponse('不该走到这里')
  })
  try {
    assert.equal(await translateDirect('   '), '')
    assert.equal(called, false)
  } finally {
    restore()
  }
})
