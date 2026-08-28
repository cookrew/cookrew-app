// Where Sous lives and what it runs. Shared by every Sous caller so a machine
// with a non-default Ollama is configured once, not once per feature.
//
//   COOKREW_SOUS=0            disable entirely
//   COOKREW_SOUS_URL          Ollama base URL (default http://127.0.0.1:11434)
//   COOKREW_SOUS_MODEL        model name       (default qwen2.5:1.5b)
//   COOKREW_SOUS_TRANSLATE_MODEL  model for translation (default: the above)

export const SOUS_BASE_URL = process.env.COOKREW_SOUS_URL ?? 'http://127.0.0.1:11434'
export const SOUS_MODEL = process.env.COOKREW_SOUS_MODEL ?? 'qwen2.5:1.5b'
export const SOUS_DISABLED = process.env.COOKREW_SOUS === '0'

/**
 * The model used for TRANSLATION, which defaults to the titling model.
 *
 * Titling and translating are not equally hard. A 1.5b model writes a decent
 * six-word title and a passable translation — passable meaning it occasionally
 * narrates a line or flattens a heading. Defaulting to a bigger model would be
 * better output and a worse default: the titling model is the one we know is
 * pulled, and a default nobody has pulled fails on first click. So the default
 * is the model that works, and this is how you ask for the model that is good.
 */
export const SOUS_TRANSLATE_MODEL =
  process.env.COOKREW_SOUS_TRANSLATE_MODEL ?? process.env.COOKREW_SOUS_MODEL ?? 'qwen2.5:1.5b'

/**
 * How long Ollama keeps the model resident. Default 5m so a ~1.25GB model does
 * not sit in memory all day for occasional work.
 */
export const SOUS_KEEP_ALIVE = process.env.COOKREW_SOUS_KEEPALIVE ?? '5m'
