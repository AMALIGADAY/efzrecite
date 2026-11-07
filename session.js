import { gradeAnswer, normalizeAnswer, shuffle } from './core.js';

const snapshot = value => JSON.parse(JSON.stringify(value));
const isoNow = () => new Date().toISOString();
const timestamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;

function currentItem(session) {
  const id = session.order[session.cursor];
  const item = session.items.find(candidate => candidate.id === id);
  if (!item) throw new Error('当前题目不存在，请返回考试范围后恢复练习。');
  return item;
}

export function createSession(exam, {
  id, mode = 'practice', items = exam.items, random = true, now = isoNow(),
} = {}) {
  if (!id || typeof id !== 'string') throw new Error('本轮练习缺少标识。');
  if (!['practice', 'mock'].includes(mode)) throw new Error('练习模式无效。');
  if (!Array.isArray(items) || !items.length) throw new Error('所选范围没有可练习的题目。');
  const scopeIds = new Set(exam.items.map(item => item.id));
  if (new Set(items.map(item => item.id)).size !== items.length || items.some(item => !scopeIds.has(item.id))) {
    throw new Error('本轮题目重复或不在已保存的考试范围内。');
  }
  const savedItems = snapshot(items);
  const ordered = random ? shuffle(savedItems) : savedItems;
  return {
    id,
    examId: exam.id,
    examName: exam.name,
    mode,
    filter: 'all',
    items: savedItems,
    scopeItems: snapshot(exam.items),
    order: ordered.map(item => item.id),
    cursor: 0,
    answers: Object.fromEntries(savedItems.map(item => [item.id, {
      draft: '', attempts: [], uncertain: false, done: false,
    }])),
    status: 'active',
    elapsedMs: 0,
    createdAt: now,
  };
}

export function submitPractice(session, answer, {
  uncertain = false, giveUp = false, now = isoNow(),
} = {}) {
  if (session.mode !== 'practice') throw new Error('模拟自测请在整轮完成后交卷。');
  if (session.status === 'complete') return { session, feedback: 'correct' };
  const item = currentItem(session);
  const original = session.answers[item.id];
  if (original.done) return { session, feedback: original.result?.correct ? 'correct' : 'wrong' };
  const input = giveUp ? '' : String(answer ?? '');
  if (!giveUp && !normalizeAnswer(input)) throw new Error('请输入答案，或选择“不会”。');
  const next = snapshot(session);
  const record = next.answers[item.id];
  const result = gradeAnswer(input, item, session.scopeItems);
  record.draft = input;
  record.uncertain = Boolean(uncertain);
  record.attempts.push(input);
  if (record.attempts.length === 1) record.firstCorrect = result.correct;
  record.result = result;
  const canRetry = !giveUp && !result.correct && result.typo && !record.retryOffered && record.attempts.length === 1;
  if (canRetry) {
    record.retryOffered = true;
    record.done = false;
    return { session: next, feedback: 'retry' };
  }
  record.done = true;
  record.answeredAt = now;
  if (giveUp) record.gaveUp = true;
  return { session: next, feedback: result.correct ? 'correct' : 'wrong' };
}

/** Skip or leave feedback: choose the next unfinished question in this fixed order. */
export function advancePractice(session, now = isoNow()) {
  if (session.mode !== 'practice') throw new Error('此操作仅用于练习模式。');
  if (session.status === 'complete') return session;
  const next = snapshot(session);
  const length = session.order.length;
  for (let offset = 1; offset <= length; offset++) {
    const cursor = (session.cursor + offset) % length;
    if (!session.answers[session.order[cursor]]?.done) {
      next.cursor = cursor;
      return next;
    }
  }
  next.status = 'complete';
  next.cursor = length;
  next.completedAt = now;
  return next;
}

/** Mock answers are graded only at submission, including the remaining blanks. */
export function submitMock(session, now = isoNow()) {
  if (session.mode !== 'mock') throw new Error('此操作仅用于模拟自测。');
  if (session.status === 'complete') return session;
  const next = snapshot(session);
  for (const item of next.items) {
    const record = next.answers[item.id];
    const draft = String(record.draft ?? '');
    record.attempts = [draft];
    record.result = gradeAnswer(draft, item, next.scopeItems);
    record.firstCorrect = record.result.correct;
    record.done = true;
    record.answeredAt = now;
  }
  next.status = 'complete';
  next.cursor = next.order.length;
  next.completedAt = now;
  return next;
}

export function summarizeSession(session) {
  const result = {
    total: session.items.length, answered: 0, firstCorrect: 0, correct: 0,
    wrong: 0, blank: 0, uncertain: 0, retried: 0, unanswered: 0, percent: 0,
  };
  for (const item of session.items) {
    const answer = session.answers[item.id];
    if (!answer?.done || (session.mode === 'mock' && session.status !== 'complete')) continue;
    result.answered++;
    if (answer.firstCorrect) result.firstCorrect++;
    if (answer.result?.correct) result.correct++;
    else result.wrong++;
    if (!normalizeAnswer(answer.attempts.at(-1) ?? answer.draft ?? '')) result.blank++;
    if (answer.uncertain) result.uncertain++;
    if (answer.attempts.length > 1) result.retried++;
  }
  result.unanswered = result.total - result.answered;
  result.percent = result.total ? result.firstCorrect / result.total * 100 : 0;
  return result;
}

/** Latest completed answer for each source sense within this saved exam. */
export function getExamProgress(exam, sessions) {
  const byId = new Map(exam.items.map(item => [item.id, { status: 'unseen', answer: null, sessionId: null }]));
  const latest = new Map();
  for (const session of sessions) {
    if (session.examId !== exam.id || (session.mode === 'mock' && session.status !== 'complete')) continue;
    for (const item of session.items) {
      if (!byId.has(item.id)) continue;
      const answer = session.answers[item.id];
      if (!answer?.done) continue;
      const at = timestamp(answer.answeredAt ?? session.completedAt ?? session.createdAt);
      if (latest.has(item.id) && at < latest.get(item.id)) continue;
      latest.set(item.id, at);
      const passed = answer.firstCorrect === true && answer.result?.correct === true
        && answer.result.targetMatched === true && !answer.uncertain;
      byId.set(item.id, { status: passed ? 'passed' : 'weak', answer: snapshot(answer), sessionId: session.id });
    }
  }
  const result = { byId, passed: 0, weak: 0, unseen: 0, total: exam.items.length };
  for (const value of byId.values()) result[value.status]++;
  return result;
}
