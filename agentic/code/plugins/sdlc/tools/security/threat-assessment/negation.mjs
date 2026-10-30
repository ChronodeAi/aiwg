// Resolve negation around a finding without letting unrelated clauses hide requests.
const ACTION = 'run|execute|invoke|install|add|update|edit|modify|change|replace|use|set|export|fetch|curl|wget|download|paste|print|dump|echo|cat|read|show|reveal|disclose|leak|send|upload|post|enable|configure|copy|migrate|move|include|write|commit|push|deploy|apply|grant|open|create|remove|delete|disable|ignore|treat|tell|inform|notify|ask|provision';
export const IMPERATIVE_LEAD = new RegExp(`^(?:please\\s+|now\\s+|just\\s+|also\\s+)*(?:${ACTION})\\b`, 'i');
const ACTION_LEAD = `(?:please\\s+|now\\s+|just\\s+|also\\s+)*(?:${ACTION})\\b`;
const CLAUSE_BREAK = new RegExp(`[;!?](?:\\s|$)|\\.(?:\\s|$)|\\n|[,:]\\s*(?=${ACTION_LEAD})|\\b(?:but|however|yet|instead|then)\\b|\\band\\s+(?=${ACTION_LEAD})`, 'gi');
const NEGATED_ACTION = new RegExp(`\\b(?:not|never|without|refuse|forbid|prohibit)\\s+(?:to\\s+)?(?:${ACTION})\\b`, 'i');
const ACTION_BEFORE_MATCH = new RegExp(`\\b(?:${ACTION})\\b`, 'i');
const REQUEST_NEGATION = /\b(?:(?:do|must|should)\s+not|don['’]t|never)\s+(?:forget|fail|neglect)\s+to\s+|\bnot\s+only\s+/gi;
const DISMISSAL = /\bnever\s+mind\b[^,;.!?\n]*[,;:]?\s*|\bno\s+(?:need|reason)\s+to\s+(?:ask|hesitate|wait|seek permission)\b[^,;.!?\n]*[,;:]?\s*|\bwithout\s+(?:delay|hesitation)\s+/gi;
const PROHIBITION = /\b(?:no|not|never|without|none|avoid|prevent|reject(?:ed)?|refus(?:e|ed)|forbid(?:den)?|prohibit(?:ed)?)\b/gi;

export function requestPrefix(prefix) {
  return prefix.replace(REQUEST_NEGATION, '').replace(DISMISSAL, '');
}

export function clauseAt(text, index, length) {
  let start = 0;
  let end = text.length;
  // A fresh expression avoids shared lastIndex state between findings.
  for (const match of text.matchAll(new RegExp(CLAUSE_BREAK))) {
    if (/^and\b/i.test(match[0]) && NEGATED_ACTION.test(requestPrefix(text.slice(start, match.index)))) continue;
    if (match.index + match[0].length <= index) start = match.index + match[0].length;
    else if (match.index >= index + length) {
      end = match.index;
      break;
    }
  }
  return { before: text.slice(start, index), match: text.slice(index, index + length), after: text.slice(index + length, end) };
}

export function isNegatedMaterial(clause) {
  const prefix = requestPrefix(clause.before);
  for (const cue of prefix.matchAll(new RegExp(PROHIBITION))) {
    // "Print rejected credentials" still requests the credentials. A passive
    // adjective after an affirmative action does not prohibit that action.
    if (/^(?:rejected|refused|forbidden|prohibited)$/i.test(cue[0])
      && ACTION_BEFORE_MATCH.test(prefix.slice(0, cue.index))) continue;
    return true;
  }
  // Some patterns include the action itself ("print the token"). Its negation
  // is still in the prefix; an affirmative action must win over trailing prose.
  if (ACTION_BEFORE_MATCH.test(`${prefix}${clause.match}`)) return false;
  // Passive policy statements put the prohibition after the material term.
  return /^(?:\s+[\w-]+){0,8}\s+(?:(?:are|is|was|were|must be|will be|shall be)\s+)?(?:rejected|refused|forbidden|prohibited)\b/i.test(clause.after)
    || /^\s*:?\s*none\b/i.test(clause.after)
    || /^(?:\s+[\w-]+){0,5}\s+(?:(?:are|is|was|were|must|shall|will|do|does)\s+)?(?:not|never)\b/i.test(clause.after);
}
