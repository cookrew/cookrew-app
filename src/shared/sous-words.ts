// THE WORDS THAT NEVER DECIDE (route program round 2, lane decide).
//
// On the live app a shapeless sentence went to whichever idle card shared a
// word with it — "about". A candidate matches a brief on CONTENT: words that
// name a thing, not the glue around it and not the verb every brief starts
// with. Two lists, kept small and tested: stopwords (glue) and generic task
// verbs (write, draft, make…). Neither ever counts as overlap.

export const STOP_WORDS: ReadonlySet<string> = new Set(
  'the a an and or of to in on for with into from by at as is are be this that it its my our your please do all every keep then also just some any about like via per 把 的 了 和 与 并 在 给 让 要 一个 这个 那个 所有 全部 一下 关于'.split(' ')
)

/** Verbs (and fillers) a brief is made of — present in most sentences, so they say nothing about WHO. */
export const GENERIC_VERBS: ReadonlySet<string> = new Set(
  'write draft make compose add fix say create give tell show put get set go start try help want need update change check look see use send ask run build 写 做 加 修 改 说 给 看 用 发 跑 建'.split(' ')
)

/** Every word but the glue — verbs included — for counting how much was SAID (is it a remark or a brief?). */
export function saidWords(text: string): Set<string> {
  return tokenize(text, (w) => STOP_WORDS.has(w))
}

/** Does the sentence carry a generic task verb — "draft", "compose", "say"? A brief with one is a brief, not a remark. */
export function hasGenericVerb(text: string): boolean {
  return [...saidWords(text)].some((w) => GENERIC_VERBS.has(w))
}

export function isNoise(word: string): boolean {
  return STOP_WORDS.has(word) || GENERIC_VERBS.has(word)
}

/** Lowercased content words; CJK runs become overlapping bigrams so "安装一节" and "安装" meet. */
export function contentWords(text: string): Set<string> {
  return tokenize(text, isNoise)
}

function tokenize(text: string, skip: (word: string) => boolean): Set<string> {
  const out = new Set<string>()
  for (const token of text.toLowerCase().match(/[a-z0-9][a-z0-9_./-]*|[一-鿿]+/g) ?? []) {
    if (/^[一-鿿]+$/.test(token)) {
      if (token.length === 1) continue
      for (let i = 0; i + 1 < token.length || i === 0; i++) {
        const bigram = token.slice(i, i + 2)
        if (!skip(bigram)) out.add(bigram)
      }
      continue
    }
    const word = token.replace(/^[./-]+|[./-]+$/g, '')
    if (word.length < 2 || skip(word)) continue
    out.add(word)
  }
  return out
}

/**
 * Words that make a sentence a REPO task: code, files, tests, branches. The
 * Chinese terms are TWO characters or more — a single character (修, 仓, 类)
 * sits inside everyday words (修一下自行车, 仓鼠, 类似) and misrouted chores
 * into the repo. A sentence with none of these and no card to take it is a chore — it gets a
 * card in ~/.cookrew/chores, never in the repo, with no repo digest.
 */
export const CODE_WORDS: ReadonlySet<string> = new Set(
  'test tests spec fix bug bugs refactor file files function class module component commit branch pr merge rebase repo repository lint typecheck build ci deploy release migration schema api endpoint route handler hook store script package dependency dep import export readme changelog docs diff patch regex query sql html css ts tsx js json yaml 测试 修复 修改 重构 文件 函数 类型 模块 组件 提交 分支 仓库 代码 接口 路由 脚本 依赖 文档 构建 发版 部署 报错 编译 单测 用例 函数名 变量 数据库 迁移 面板 组件库 全仓'.split(' ')
)

const CODE_SHAPE_RE = /[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|md|css|html|py|rs|go|sh|yaml|yml|toml)\b|\/[\w.-]+\/|\b[a-z]+[A-Z]\w+\b|\w+_\w+|#\d+|\bv\d+(?:\.\d+)*\b|`[^`]+`/

/** Does the sentence name code — a word from CODE_WORDS, a path, a filename, an identifier? */
export function isRepoTask(sentence: string): boolean {
  if (CODE_SHAPE_RE.test(sentence)) return true
  for (const token of sentence.toLowerCase().match(/[a-z0-9][a-z0-9_./-]*|[一-鿿]+/g) ?? []) {
    if (/^[一-鿿]+$/.test(token)) {
      for (const w of CODE_WORDS) if (w.length >= 2 && /[一-鿿]/.test(w) && token.includes(w)) return true
      continue
    }
    if (CODE_WORDS.has(token.replace(/^[./-]+|[./-]+$/g, ''))) return true
  }
  return false
}
