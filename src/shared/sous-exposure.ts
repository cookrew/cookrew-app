// EXPOSURE — how much a sentence can cost if Sous gets it wrong (HP round,
// lane hp-decide; the product audit's HIGH). Deterministic: verb lists in
// English and Chinese, the highest tier wins, and the tier says what the hold
// does — a 2 or a 3 never commits on its own clock, and a 2 only commits as a
// distinct act with its Boundaries line appended. Jev may refine this later;
// nothing here waits for it.
//
//   0  read / explain / list — nothing changes
//   1  edit / fix / add / refactor — a change in a working tree
//   2  delete, push, release/deploy, merge, pay, config — leaves the tree or the wallet
//   3  keys, tokens, passwords, accounts, somebody else's card — a secret or a seat

export type Exposure = 0 | 1 | 2 | 3

export interface ExposureVerdict {
  score: Exposure
  /** The word that set the tier, or null at 0. */
  why: string | null
}

const TIER_3 = [
  /\b(?:api[ _-]?keys?|secrets?|tokens?|passwords?|passwd|credentials?|accounts?|login|private key|ssh key)\b/i,
  /密钥|秘钥|口令|密码|账号|帐号|凭证|别人的卡|他人的卡|served/
]
const TIER_2 = [
  /\b(?:delete|remove|drop|rm(?:\s+-rf?)?|wipe|purge|push|force[- ]push|release|deploy|ship|publish|merge|rebase|reset\s+--hard|pay|payment|charge|spend|buy|subscribe|refund|config(?:uration)?|settings?|env(?:ironment)?\s*vars?|\.env|rotate)\b/i,
  /删除|删掉|删了|清空|推送|推上去|发版|发布|上线|部署|合并|付款|付钱|花钱|扣款|购买|充值|改配置|配置|环境变量|重置/
]
const TIER_1 = [
  /\b(?:edit|fix|add|refactor|change|rename|update|write|rewrite|implement|move|replace|convert|translate|format|clean|tidy|revert|patch|wire|build|test)\b/i,
  /改|修|加|重构|写|实现|替换|转换|翻译|整理|回退|修复|新增|重命名/
]
const TIER_0 = [/\b(?:read|explain|list|show|summari[sz]e|describe|what|look|check|find|grep|search|review|count)\b/i, /读|解释|列出|列一下|看看|看一下|总结|说明|查|找|搜|数一下/]

function first(patterns: RegExp[], sentence: string): string | null {
  for (const re of patterns) {
    const m = re.exec(sentence)
    if (m) return m[0]
  }
  return null
}

/** The tier of a sentence and the word that set it. The highest tier present wins. */
export function exposure(sentence: string): ExposureVerdict {
  const s = sentence.trim()
  const three = first(TIER_3, s)
  if (three) return { score: 3, why: three }
  const two = first(TIER_2, s)
  if (two) return { score: 2, why: two }
  const one = first(TIER_1, s)
  if (one) return { score: 1, why: one }
  const zero = first(TIER_0, s)
  return { score: 0, why: zero }
}

const isZh = (s: string): boolean => /[一-鿿]/.test(s)

/**
 * ONE positive line the brief carries at exposure ≥ 2: what the card may do
 * and the condition it does it under — never a prohibition. Null below 2.
 */
export function boundaries(score: Exposure, sentence: string): string | null {
  if (score < 2) return null
  const zh = isZh(sentence)
  if (score === 3) return zh ? '密钥只从封好的槽位读取，不打印、不写入文件、不回显' : 'read any secret from its sealed slot only — never print, write or echo it'
  const s = sentence
  if (/push|推送|推上去/i.test(s)) return zh ? '测试通过后才推送' : 'push only after the check passes'
  if (/release|deploy|ship|publish|上线|发版|发布|部署/i.test(s)) return zh ? '检查通过后才发布，先说明发布的内容' : 'release only after the check passes, naming what ships'
  if (/merge|rebase|合并/i.test(s)) return zh ? '只合并本句点名的分支，且检查通过后再合' : 'merge only the branch this names, after the check passes'
  if (/delete|remove|drop|rm\b|wipe|purge|删除|删掉|删了|清空/i.test(s)) return zh ? '只删本句点名的内容，其余一律保留' : 'delete only what this sentence names and keep everything else'
  if (/pay|payment|charge|spend|buy|subscribe|refund|付款|付钱|花钱|扣款|购买|充值/i.test(s)) return zh ? '只在本句写明的金额内付款，金额不明先问' : 'spend only the amount this names — ask first when none is named'
  if (/config|settings?|env|\.env|配置|环境变量|重置|reset/i.test(s)) return zh ? '只改本句点名的配置项，改前留下原值' : 'change only the setting this names, keeping the old value on record'
  return zh ? '只做本句点名的事，其余先问' : 'do only what this sentence names and ask before anything else'
}
