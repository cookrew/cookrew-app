import type { AccountRefusal } from '../../../shared/account-v2'
import { refusalSentence } from './account-store'

/** The tones a field's note is drawn in, as account-store's views name them. */
export type FieldTone = 'good' | 'bad' | 'dim'

/** The rest of the vocabulary is the account sheet's, said the same way. */
export const accountProblemHint = (reason: AccountRefusal): string => refusalSentence(reason)
