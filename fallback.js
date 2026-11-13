/**
 * dsh-skill-easy · 内置兜底翻译
 *
 * 一键翻译原本完全依赖宿主的 `translator` 服务，而 DSH 默认不挂载它：
 * `ctx.get('translator') === undefined` 时整批翻译直接短路成 translator-unavailable。
 * 这里补一条不依赖 profile 补丁的兜底——直接调 bing 公共翻译端点，
 * 请求格式与 `@deepseek-ai/dsh-experimental-translator` 的 bing 分支保持一致：
 *
 *   POST https://edge.microsoft.com/translate/translatetext?to=zh-Hans&isEnterpriseClient=false
 *   body: ["<text>"]（content-type: application/json）
 *   resp: [{ translations: [{ text }] }]
 *
 * 取舍：
 * - 只走 bing：google 的 translate.googleapis.com 在部分网络（如中国大陆）返回 0 字节；
 * - 不读凭据、不落盘、不引第三方依赖，唯一副作用是把技能描述发到 edge.microsoft.com；
 * - 超时与响应体积都有上限，失败抛带 `code` 的错误，调用方按条记录，不影响其他条目。
 *
 * 这份文件不依赖任何宿主包，可以单独用 node --test 跑（test/fallback.test.mjs）。
 *
 * @module dsh-skill-easy/fallback
 */

/** 兜底端点：与宿主 translator 的 bing 默认端点相同。 */
export const FALLBACK_ENDPOINT = 'https://edge.microsoft.com/translate/translatetext'
/** 兜底 provider 名，会出现在翻译状态里。 */
export const FALLBACK_PROVIDER = 'bing'
/** 单条请求超时上限。 */
export const FALLBACK_TIMEOUT_MS = 8_000
/** 响应体积上限，防止异常响应把内存撑爆。 */
export const FALLBACK_MAX_BYTES = 256 * 1024

/**
 * 把 BCP 47 语言标签归一成 bing 认的写法（与宿主 translator 的规则一致）。
 * @param tag - 语言标签，如 `zh-CN`。
 * @returns bing 端点可用的标签，如 `zh-Hans`。
 */
export function bingLanguage(tag) {
  const lower = String(tag ?? '').toLowerCase()
  if (['zh', 'zh-cn', 'zh-sg', 'zh-hans'].includes(lower)) return 'zh-Hans'
  if (['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant'].includes(lower)) return 'zh-Hant'
  return String(tag ?? '')
}

/**
 * 构造一次翻译请求。
 * @param text - 待翻译文本。
 * @param options - `{ endpoint?, targetLanguage? }`。
 * @returns `{ url, init }`，可直接交给 fetch。
 */
export function buildRequest(text, options = {}) {
  const url = new URL(options.endpoint ?? FALLBACK_ENDPOINT)
  url.searchParams.set('to', bingLanguage(options.targetLanguage ?? 'zh-CN'))
  url.searchParams.set('isEnterpriseClient', 'false')
  return {
    url: url.href,
    init: {
      method: 'POST',
      body: JSON.stringify([String(text ?? '')]),
      headers: { 'content-type': 'application/json' },
    },
  }
}

/**
 * 从 bing 响应里取出译文；结构不对就按响应无效处理。
 * @param payload - 已解析的 JSON。
 * @returns 译文。
 */
export function parsePayload(payload) {
  const first = Array.isArray(payload) ? payload[0] : undefined
  const translated = first !== null && typeof first === 'object' && Array.isArray(first.translations)
    ? first.translations[0]
    : undefined
  if (translated === null || typeof translated !== 'object' || typeof translated.text !== 'string') {
    throw failure('TRANSLATION_INVALID_RESPONSE', 'bing returned an invalid translation response')
  }
  return translated.text
}

/** 造一个带 `code` 的错误：客户端会把这个 code 显示成失败原因。 */
function failure(code, detail) {
  const error = new Error(detail)
  error.code = code
  return error
}

/**
 * 读响应 JSON，顺带卡住体积上限。
 * @param response - fetch 的 Response。
 * @param maxBytes - 允许的最大字节数。
 * @returns 解析后的 JSON。
 */
async function readJsonLimited(response, maxBytes) {
  const reader = response.body?.getReader?.()
  if (reader === undefined) {
    const raw = await response.text()
    try {
      return JSON.parse(raw)
    } catch (error) {
      throw failure('TRANSLATION_INVALID_RESPONSE', 'bing returned invalid JSON')
    }
  }
  const chunks = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        throw failure('TRANSLATION_RESPONSE_LIMIT', `bing translation response exceeds ${maxBytes} bytes`)
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    throw failure('TRANSLATION_INVALID_RESPONSE', 'bing returned invalid JSON')
  }
}

/**
 * 直接把一段文本翻成中文（bing 直连，不经过宿主服务）。
 * @param text - 待翻译文本。
 * @param options - `{ endpoint?, targetLanguage?, timeoutMs?, maxBytes? }`。
 * @returns 译文；空输入返回空串。
 */
export async function translateDirect(text, options = {}) {
  const source = String(text ?? '').trim()
  if (source === '') return ''
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : FALLBACK_TIMEOUT_MS
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : FALLBACK_MAX_BYTES
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    const { url, init } = buildRequest(source, options)
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      credentials: 'omit',
      signal: controller.signal,
    })
    if (!response.ok) {
      await response.body?.cancel?.()
      throw failure('TRANSLATION_HTTP_ERROR', `bing translation failed (HTTP ${response.status})`)
    }
    return parsePayload(await readJsonLimited(response, maxBytes))
  } catch (error) {
    if (timedOut) throw failure('TRANSLATION_TIMEOUT', `bing translation timed out after ${timeoutMs}ms`)
    if (error?.code !== undefined) throw error
    throw failure('TRANSLATION_REQUEST_FAILED', `bing translation request failed: ${error?.message ?? error}`)
  } finally {
    clearTimeout(timer)
  }
}
