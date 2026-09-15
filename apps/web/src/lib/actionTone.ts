/**
 * What colour a poker action should be.
 *
 * Both hold'em screens - the bots table and the shared one - render `lastAction` as a
 * badge, and both need the same reading of it, so the mapping lives here rather than
 * twice. Getting it wrong in one place would be worse than having no colour at all: a
 * fold and a raise wearing the same badge is a table you have to read word by word.
 *
 * Matched on the leading verb rather than parsed, because the engine's labels carry an
 * amount (`Call 40`, `Raise to 120`). Anything unrecognised falls back to neutral, so a
 * new action added upstream renders plainly instead of miscoloured.
 */
export type ActionTone = 'fold' | 'passive' | 'aggressive' | 'allin' | 'neutral';

export function actionTone(action: string): ActionTone {
  const word = action.trim().toLowerCase();
  if (word.startsWith('fold')) return 'fold';
  if (word.startsWith('all in')) return 'allin';
  if (word.startsWith('bet') || word.startsWith('raise')) return 'aggressive';
  if (word.startsWith('check') || word.startsWith('call')) return 'passive';
  return 'neutral';
}
