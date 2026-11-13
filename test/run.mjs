/**
 * 测试入口：在同一个进程里依次加载全部用例文件。
 *
 * 为什么不用 `node --test test/*.test.mjs`：那会为每个文件 spawn 一个子进程，
 * 在带文件/命名管道限制的沙箱里会直接 EPERM（`spawn EPERM`），
 * 看起来像测试全挂，实际是用例本身没问题。这里顺序 import，行为等价但不 spawn。
 */
await import('./menu.test.mjs')
await import('./store.test.mjs')
await import('./fallback.test.mjs')
