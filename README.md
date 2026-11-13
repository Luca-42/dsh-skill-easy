# dsh-skill-easy · 技能分类与中文描述

给 DSH 的技能（skill）分类，并把 `/` 菜单里的英文描述换成中文。

装好之后，输入框里打 `/`，技能不再是糊成一片的一列英文，而是按你分的类分段显示，每条描述是你看得懂的中文。

> 本仓库是 [`ther000/dsh-skill-easy`](https://github.com/ther000/dsh-skill-easy) 的个人 fork（0.2.0），
> 修掉了「一键翻译始终返回 translator-unavailable」的问题，见下面「一键翻译为什么以前不工作」。

## 安装

需要 DSH `0.2.1-rc.3` 或更高版本。

**从本仓库安装（含一键翻译兜底，装完就能翻）**：

```bash
dsh plugin --profile web add github:Luca-42/dsh-skill-easy
```

把 `web` 换成你的 profile 名，装完**重启 DSH** 才生效。

**让 AI 装**：在 DSH 里说「装 dsh-skill-easy 这个插件」，走插件市场（市场按 `ther000/dsh-skill-easy` 这个 GitHub 源拉取）。

**手动装**：把仓库 clone 到本地，在「设置 → 插件」里从本地目录安装。

桌面版当前只支持安装和开关，升级、卸载请在 Web 版操作。

## 一键翻译为什么以前不工作（0.2.0 已修）

旧版的一键翻译只走宿主的 `translator` 服务，而该服务由 `@deepseek-ai/dsh-experimental-translator`
提供、**DSH 默认不挂载**：`ctx.get('translator') === undefined` 时整批翻译直接短路成
`translator-unavailable`，界面只显示「翻译服务不可用」。这跟技能内容、网络、账号都没关系，
默认 profile 上必然失败。

0.2.0 起翻译按下面的顺序走，前面不通就退到后面：

| 顺序 | 走哪条路 | 前置条件 |
| --- | --- | --- |
| 1 | 宿主 `translator` 服务 | profile 挂了 `@deepseek-ai/dsh-experimental-translator`（或 CoT 翻译 bundle） |
| 2 | 内置 bing 直连（`fallback.js`） | 只要能访问 `edge.microsoft.com`，不需要任何额外配置 |

- 命中第 2 条时，「技能」标题旁会标一句「翻译走内置 bing（宿主未挂载 translator 服务）」，
  提示技能描述会发到 `edge.microsoft.com`；不想外发就别点一键翻译，手动填中文始终可用。
- 宿主服务在但报错时（比如 provider 设成 `google` 而该网络不可达）也会退到内置 bing，
  两条都失败才记一条失败，原因按 `宿主原因 → 兜底原因` 拼在条目后面。
- 想用宿主服务，就在 profile（与 `package.json` 同目录）的 `cordis.patch.yml` 追加：

  ```yaml
  - insert:
      - id: translator
        name: '@deepseek-ai/dsh-experimental-translator'
        config:
          provider: bing
  ```

  注意 `provider` 建议用 `bing`：`translate.googleapis.com` 在部分网络（如中国大陆）返回 0 字节。
  已装 `@deepseek-ai/dsh-experimental-cot-translation-bundle` 的 profile 已经插入同 id 的 `translator`，
  **不要重复插入**（同 id 插两次会报错）；`--dump-config | grep -A4 "id: translator"` 有结果就别动。

## 它做什么

- **分类**：在「设置 → 技能分类」里建分类（写作、审查、部署……），把每个技能拖到某一类。分类顺序就是菜单里的顺序，没归类的排最后。
- **中文描述**：每个技能可以写一句中文，也可以点「一键翻译未翻译项」，用宿主自带的翻译服务（或内置 bing 兜底）把英文描述批量翻成中文。
- **自动过期**：技能的英文描述改过之后，对应的中文会被标记「原文已变」，一键翻译会重新翻它。

## 使用

1. 打开「设置 → 技能分类」。
2. 新建两个分类，给技能选分类、填中文（或点一键翻译）。
3. 回到输入框，输入 `/`，技能按分类分段显示。

没有建分类时，`/` 菜单保持官方原样；只填了中文描述的话，描述会被替换成中文，分组仍是「技能」。

## 数据在哪

`~/.dsh/storages/dsh-skill-easy/data.json`

纯 JSON，可以直接备份或手改。卸载插件不会删这个文件，重装后数据还在。
（`DSH_HOME` 被改过时，路径跟着 `DSH_HOME` 走。）

## 故障排查

- 一键翻译全部失败、每条都显示 `translator-unavailable`：那是 0.1.0 的行为，装 0.2.0 及以上。
- 每条都显示 `TRANSLATION_HTTP_ERROR` / `TRANSLATION_TIMEOUT`：到 `edge.microsoft.com` 的请求没通（断网、代理、杀软拦截）。
- 状态里显示 `no-provider`：宿主 translator 服务在但没有可用 provider——内置兜底会自动接手，不用管。
- 想知道宿主读到了哪些技能来源：看 `~/.dsh/storages/dsh-skill-easy/diagnostics.json`。

## 兼容性与降级

- 针对 DSH `0.2.1-rc.3` 开发。菜单分组依赖官方 `dsh-client-ui-skill` 注册的 `/` 触发源：宿主升级后如果这个内部结构变了，菜单会**自动退回原样**（不报错、不影响任何官方功能），设置页会显示「菜单增强未生效」，分类和中文数据都还在。
- 翻译按「宿主 translator → 内置 bing」降级；两条都不通时按钮会逐条给出失败原因，手动填写始终可用。

## 开发

```bash
npm run check   # 语法检查 + 菜单逻辑 / 存储保存序列 / 兜底翻译 回归测试
```

`index.js` 是宿主半边（技能目录 + Remote），`store.js` 是数据与乐观锁（可单独测试），
`fallback.js` 是内置 bing 翻译（不依赖宿主包，可单独测试），`client.js` 是浏览器半边
（设置页 + 菜单增强），零构建、无第三方依赖。

测试统一从 `test/run.mjs` 进（同一进程顺序加载全部用例）。不用 `node --test` 是为了避开
受限沙箱里子进程 spawn 的 EPERM 误报——用例本身在 `node --test` 下同样能跑。

## 更新记录

- **0.2.0**：一键翻译在宿主没有 `translator` 服务时改用内置 bing 直连（`fallback.js`），
  不再整批返回 `translator-unavailable`；翻译状态多了 `mode`（`service` / `builtin`）与 `hint`；
  设置页在走内置兜底时显示提示；补 `test/fallback.test.mjs` 与同进程测试入口 `test/run.mjs`。
- **0.1.0**：初始版本（分类、中文描述、一键翻译）。

## 卸载

在「设置 → 插件」里卸载，或从 profile 移除后重启。数据文件需要手动删。
