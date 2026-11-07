/** Shared, DOM-free rules for the textbook vocabulary trainer. */

export function normalizeAnswer(value) {
  return String(value ?? '').normalize('NFC').replace(/\s/gu, '');
}

/** The blank is constant: it must never reveal the answer's length or spacing. */
export function questionHint(word) {
  return `${Array.from(String(word ?? ''))[0] || ''}_______`;
}

/** Exactly one insertion, deletion, substitution or adjacent transposition. */
export function isTypo(answer, target) {
  const a = Array.from(normalizeAnswer(answer));
  const b = Array.from(normalizeAnswer(target));
  if (!a.length || !b.length || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const differences = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) differences.push(i);
      if (differences.length > 2) return false;
    }
    if (differences.length === 1) return true;
    if (differences.length !== 2) return false;
    const [i, j] = differences;
    return j === i + 1 && a[i] === b[j] && a[j] === b[i];
  }
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let firstDifference = 0;
  while (firstDifference < shorter.length && shorter[firstDifference] === longer[firstDifference]) firstDifference++;
  for (let i = firstDifference; i < shorter.length; i++) {
    if (shorter[i] !== longer[i + 1]) return false;
  }
  return true;
}

const normalSpace = value => String(value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ');

/** Only information visible in the original question belongs in its key. */
export function promptKey(item) {
  return JSON.stringify([
    Array.from(normalizeAnswer(item.word))[0] ?? '',
    normalSpace(item.pos),
    normalSpace(item.definition),
  ]);
}

/** Preserve rule order; overlapping ranges include a source sense only once. */
export function resolveSelection(catalog, rules) {
  if (!catalog || !Array.isArray(catalog.units)) throw new Error('词库格式有误：缺少单元列表。');
  if (!Array.isArray(rules)) throw new Error('考试范围格式有误。');
  const units = new Map(catalog.units.map(unit => [unit.id, unit]));
  const seen = new Set();
  const items = [];
  for (const rule of rules) {
    const unit = units.get(rule.unitId);
    if (!unit) throw new Error(`找不到单元：${rule.unitId ?? '未选择单元'}。`);
    let selected;
    if (rule.mode === 'all') {
      selected = unit.items;
    } else if (rule.mode === 'through' || rule.mode === 'from') {
      const indices = [];
      unit.items.forEach((item, index) => {
        if (item.headwordId === rule.boundaryId && rule.boundaryId) indices.push(index);
      });
      if (!indices.length) throw new Error(`${unit.label || unit.id}：找不到所选边界词，请重新选择。`);
      selected = rule.mode === 'through'
        ? unit.items.slice(0, indices.at(-1) + 1)
        : unit.items.slice(indices[0]);
    } else {
      throw new Error(`${unit.label || unit.id}：范围方式有误，请选择整个单元、到某词为止或从某词开始。`);
    }
    for (const item of selected) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        items.push(item);
      }
    }
  }
  return items;
}

/** Accept another textbook answer only when all visible hints match in scope. */
export function gradeAnswer(answer, item, scopeItems = []) {
  const key = promptKey(item);
  const alternatives = [];
  const seen = new Set();
  for (const candidate of [item, ...scopeItems]) {
    if (promptKey(candidate) !== key) continue;
    const normalized = normalizeAnswer(candidate.word);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      alternatives.push(candidate.word);
    }
  }
  const normalized = normalizeAnswer(answer);
  const matchedWord = alternatives.find(word => normalizeAnswer(word) === normalized) ?? null;
  const correct = matchedWord !== null;
  return {
    correct,
    matchedWord,
    alternatives,
    ambiguous: alternatives.length > 1,
    targetMatched: correct && normalized === normalizeAnswer(item.word),
    typo: !correct && alternatives.some(word => isTypo(answer, word)),
  };
}

export function shuffle(items, rng = Math.random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const random = rng();
    if (!Number.isFinite(random) || random < 0 || random >= 1) throw new Error('随机数应在 0（含）至 1（不含）之间。');
    const j = Math.floor(random * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Two independent 32-bit accumulators give compact deterministic import IDs.
function stableHash(value) {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) {
    a = Math.imul(a ^ value.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ value.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

const POS_PATTERN = /^(adj\.|adv\.|n\.|v\.|vt\.|vi\.|pron\.|prep\.|conj\.|interj\.|int\.|num\.|number|art\.|det\.|aux\.|modal|abbr\.|phr\.|phrase|n\.pl\.|aux\.v\.|phr\.v\.)\s+(.+)$/u;
const DAMAGED_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD]/u;

/** Parse the legacy count + "word: POS definition" TXT format without repairs. */
export function parseLegacy(text, sourceName = '用户导入') {
  if (typeof text !== 'string') throw new Error(`${sourceName}：词库必须为 UTF-8 文本。`);
  const lines = text.replace(/^\uFEFF/u, '').split(/\r\n|\n|\r/u);
  for (let i = 0; i < lines.length; i++) {
    if (DAMAGED_TEXT.test(lines[i])) throw new Error(`${sourceName} 第 ${i + 1} 行包含损坏字符或不可见控制字符，请检查文件编码（UTF-8）。`);
  }
  if (!/^\d+$/u.test(lines[0].trim())) throw new Error(`${sourceName} 第 1 行应为题目数量（非负整数）。`);
  const declaredCount = Number(lines[0].trim());
  if (!Number.isSafeInteger(declaredCount)) throw new Error(`${sourceName} 第 1 行的题目数量过大。`);
  const items = [];
  const duplicateCounts = new Map();
  const headwordGroups = new Map();
  let previousWord = null;
  let currentHeadwordId = '';
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fail = message => { throw new Error(`${sourceName} 第 ${i + 1} 行：${message}`); };
    const colon = line.indexOf(':');
    if (colon <= 0) fail('应使用“单词: 词性 英文释义”格式，缺少单词或英文冒号。');
    const word = line.slice(0, colon).trim();
    if (!word || /[\[\]\u0000-\u001F]/u.test(word)) fail('单词格式有误。');
    let body = line.slice(colon + 1).trim();
    let annotation = '';
    const annotationMatch = body.match(/\s*\[(Textbook typo:\s*[^\]]+)\]\s*$/u);
    if (annotationMatch) {
      annotation = annotationMatch[1];
      body = body.slice(0, annotationMatch.index).trimEnd();
    }
    const match = body.match(POS_PATTERN);
    if (!match || !match[2].trim()) fail('缺少有效词性或英文释义，例如“n. a person ...”。');
    const pos = match[1];
    const definition = match[2];
    const normalizedWord = normalSpace(word);
    if (normalizedWord !== previousWord) {
      const groupNumber = (headwordGroups.get(normalizedWord) ?? 0) + 1;
      headwordGroups.set(normalizedWord, groupNumber);
      currentHeadwordId = `import-head-${stableHash(JSON.stringify([sourceName, normalizedWord, groupNumber]))}`;
    }
    previousWord = normalizedWord;
    const identity = JSON.stringify([sourceName, word, pos, definition]);
    const occurrence = (duplicateCounts.get(identity) ?? 0) + 1;
    duplicateCounts.set(identity, occurrence);
    items.push({
      id: `import-${stableHash(identity)}-${occurrence}`,
      headwordId: currentHeadwordId,
      word,
      pos,
      definition,
      annotation,
      source: { name: sourceName, line: i + 1, kind: 'import' },
    });
  }
  const warnings = declaredCount === items.length ? [] : [
    `${sourceName}：声明 ${declaredCount} 题，实际 ${items.length} 题；将按有效的 ${items.length} 题使用。`,
  ];
  return { items, warnings };
}

export function exportLegacy(items) {
  const lines = items.map((item, index) => {
    const { word, pos, definition } = item;
    if (![word, pos, definition].every(value => typeof value === 'string' && value.trim() && !/[\r\n]/u.test(value) && !DAMAGED_TEXT.test(value))) {
      throw new Error(`第 ${index + 1} 条词条不完整或包含无法导出的字符。`);
    }
    if (word.includes(':')) throw new Error(`第 ${index + 1} 条单词含有冒号，无法导出为旧版格式。`);
    const annotation = String(item.annotation ?? '').trim();
    if (/[\r\n]/u.test(annotation) || DAMAGED_TEXT.test(annotation)) throw new Error(`第 ${index + 1} 条标注包含无法导出的字符。`);
    const note = annotation.replace(/^\[(.*)\]$/u, '$1');
    const suffix = note ? ` [${note.startsWith('Textbook typo:') ? note : `Textbook typo: ${note}`}]` : '';
    return `${word}: ${pos} ${definition}${suffix}`;
  });
  return [String(items.length), ...lines, ''].join('\r\n');
}
