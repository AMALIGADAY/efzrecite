import {resolveSelection} from './core.js';
// A single durable record makes an answer and its session position atomic.
const DB_NAME = 'efz-recite-word';
const STORE_NAME = 'state';
const STATE_KEY = 'current';
const MAX_BYTES = 32 * 1024 * 1024;
const POISON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
let databasePromise;
let saveQueue = Promise.resolve();

export function freshState() {
  return { schemaVersion: 1, exams: [], sessions: [], customUnits: [] };
}

function fail(message) {
  throw new Error(`备份内容无效：${message}`);
}

function object(value, location) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${location} 应为对象`);
  return value;
}

function text(value, location, max = 1000, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) {
    fail(`${location} 的文字格式或长度不正确`);
  }
}

function array(value, location, max = 10000) {
  if (!Array.isArray(value) || value.length > max) fail(`${location} 的列表格式或数量不正确`);
}

function integer(value, location, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) fail(`${location} 应为有效整数`);
}

function enumValue(value, choices, location) {
  if (!choices.includes(value)) fail(`${location} 的值无法识别`);
}

function boolean(value, location) {
  if (typeof value !== 'boolean') fail(`${location} 应为是或否`);
}

// Validate the whole tree before using keys or assigning imported records.
function inspectTree(value, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 1500000 || depth > 24) fail('数据层级或总量过大');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > 20000) fail('单段文字过长');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('含有无效数字');
    return;
  }
  if (typeof value !== 'object') fail('含有无法保存的数据类型');
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail('含有非标准对象');
  } else if (value.length > 100000) fail('单个列表过长');
  for (const key of Object.keys(value)) {
    if (POISON_KEYS.has(key)) fail('含有禁止使用的字段');
    if (key.length > 400) fail('字段名过长');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('含有非数据字段');
    inspectTree(descriptor.value, depth + 1, budget);
  }
}

function validateItems(items, location, allowEmpty = false) {
  array(items, location);
  if (!allowEmpty && !items.length) fail(`${location} 不能为空`);
  const ids = new Set();
  items.forEach((item, index) => {
    const loc = `${location} 第 ${index + 1} 条`;
    object(item, loc);
    text(item.id, `${loc} ID`, 300);
    if (ids.has(item.id)) fail(`${location} 含有重复题目 ID`);
    ids.add(item.id);
    text(item.word, `${loc} 单词`, 200);
    text(item.pos, `${loc} 词性`, 100, true);
    text(item.definition, `${loc} 释义`, 10000);
    text(item.headwordId, `${loc} 词组 ID`, 300);
    if (item.annotation !== undefined && item.annotation !== null) text(item.annotation, `${loc} 标注`, 10000, true);
    if (item.source !== undefined && item.source !== null) {
      object(item.source, `${loc} 来源`);
      if (item.source.pdf !== undefined) text(item.source.pdf, `${loc} 来源文件`, 1000, true);
      for (const key of ['pdfPage', 'printedPage']) {
        if (item.source[key] !== undefined && item.source[key] !== null) integer(item.source[key], `${loc} 页码`, 0);
      }
    }
  });
  return ids;
}

function uniqueRecords(records, location) {
  const ids = new Set();
  records.forEach(record => {
    object(record, location);
    text(record.id, `${location} ID`, 300);
    if (ids.has(record.id)) fail(`${location} 含有重复 ID`);
    ids.add(record.id);
  });
}

/** Accept a JSON string, direct state, or {format:'efz-backup',version:1,state}. */
export function validateBackup(raw) {
  let parsed;
  if (typeof raw === 'string') {
    if (raw.length > MAX_BYTES) fail('文件过大（上限 32 MB）');
    try { parsed = JSON.parse(raw); } catch { fail('不是完整的 JSON 文件'); }
  } else {
    parsed = raw;
  }
  inspectTree(parsed);
  object(parsed, '根数据');
  let state = parsed;
  if (parsed.format !== undefined) {
    if (parsed.format !== 'efz-backup' || parsed.version !== 1) fail('备份格式或版本不受支持');
    state = object(parsed.state, '学习记录');
  }
  if (state.schemaVersion !== 1) fail('学习记录版本不受支持');
  array(state.exams, '考试范围', 500);
  array(state.sessions, '练习记录', 2000);
  array(state.customUnits, '自定义词库', 500);
  uniqueRecords(state.exams, '考试范围');
  uniqueRecords(state.sessions, '练习记录');
  uniqueRecords(state.customUnits, '自定义词库');
  state.exams.forEach(exam => {
    text(exam.name, '考试名称', 200);
    validateItems(exam.items, '考试题目');
    if (exam.rules !== undefined) {
      array(exam.rules, '考试范围规则', 500);
      exam.rules.forEach(rule => {
        object(rule, '考试范围规则');
        text(rule.unitId, '规则对应单元 ID', 300);
        enumValue(rule.mode, ['all', 'through', 'from'], '单元截取方式');
        if (rule.mode !== 'all' || rule.boundaryId !== undefined) text(rule.boundaryId, '单元边界词 ID', 300);
      });
    }
    if (exam.sourceVersion !== undefined) text(exam.sourceVersion, '来源版本', 300, true);
    if (exam.sourceUnits !== undefined) {
      array(exam.sourceUnits, '考试来源单元', 500);
      uniqueRecords(exam.sourceUnits, '考试来源单元');
      exam.sourceUnits.forEach(unit => {
        text(unit.label, '来源单元名称', 200);
        validateItems(unit.items, '来源单元题目');
      });
      for (const rule of exam.rules || []) {
        const unit = exam.sourceUnits.find(candidate => candidate.id === rule.unitId);
        if (!unit) fail('考试范围规则引用了缺失的来源单元');
        if (rule.mode !== 'all' && !unit.items.some(item => item.headwordId === rule.boundaryId)) {
          fail('考试范围规则引用了不存在的边界词');
        }
      }
    }
    if (exam.excludedIds !== undefined) {
      array(exam.excludedIds, '手动排除的题目');
      exam.excludedIds.forEach(id => text(id, '排除题目 ID', 300));
    }
    if (exam.extraItems !== undefined) validateItems(exam.extraItems, '手动添加的题目', true);
  });
  state.customUnits.forEach(unit => {
    text(unit.label, '自定义词库名称', 200);
    validateItems(unit.items, '自定义词库题目');
  });
  state.sessions.forEach(session => {
    text(session.examId, '练习对应的考试 ID', 300);
    text(session.examName, '练习对应的考试名称', 200);
    enumValue(session.mode, ['practice', 'mock'], '练习模式');
    enumValue(session.filter, ['all', 'weak', 'unseen'], '练习范围');
    enumValue(session.status, ['active', 'complete'], '练习状态');
    const ids = validateItems(session.items, '本轮题目');
    const scopeIds = validateItems(session.scopeItems, '本轮对应完整范围');
    if ([...ids].some(id => !scopeIds.has(id))) fail('本轮题目不在完整范围内');
    array(session.order, '出题顺序');
    if (session.order.length !== ids.size || new Set(session.order).size !== ids.size || session.order.some(id => !ids.has(id))) {
      fail('出题顺序与本轮题目不一致');
    }
    integer(session.cursor, '作答位置');
    if (session.cursor > session.order.length) fail('作答位置超出本轮范围');
    if (typeof session.elapsedMs !== 'number' || !Number.isFinite(session.elapsedMs) || session.elapsedMs < 0) fail('累计用时不正确');
    object(session.answers, '原始作答');
    for (const [id, answer] of Object.entries(session.answers)) {
      if (!ids.has(id)) fail('作答中含有不属于本轮的题目');
      object(answer, '题目作答');
      array(answer.attempts, '作答尝试', 100);
      answer.attempts.forEach(value => text(value, '原作答', 1000, true));
      boolean(answer.uncertain, '不确定标记');
      boolean(answer.done, '已作答标记');
      if (answer.draft !== undefined) text(answer.draft, '未提交作答', 1000, true);
      if (answer.firstCorrect !== undefined) boolean(answer.firstCorrect, '首次正确标记');
      if (answer.result !== undefined && answer.result !== null) {
        const result = object(answer.result, '判定结果');
        for (const key of ['correct', 'ambiguous', 'targetMatched', 'typo']) boolean(result[key], '判定结果');
        array(result.alternatives, '本题可接受的教材答案', 1000);
        result.alternatives.forEach(word => text(word, '教材答案', 200));
        if (result.matchedWord !== null) text(result.matchedWord, '作答对应的教材词', 200);
      }
    }
  });
  const encoded = JSON.stringify(state);
  if (encoded.length > MAX_BYTES || new TextEncoder().encode(encoded).byteLength > MAX_BYTES) fail('记录总量过大（上限 32 MB）');
  // Return an independent snapshot so further edits cannot mutate a queued save.
  return JSON.parse(encoded);
}

/** Range files reference only the bundled catalog; they never carry editable words. */
function rangeFromReferences(data, catalog, id, timestamp) {
  inspectTree(data);
  object(data, '考试范围');
  const allowed = new Set(['format','version','catalogVersion','name','rules','excludedIds']);
  if (Object.keys(data).some(key => !allowed.has(key))) throw new Error('考试范围文件含有不支持的字段，请重新导出；不能夹带词库或作答记录。');
  if (data.format !== 'efz-exam' || data.version !== 1) throw new Error('请选择导出的考试范围文件；学习备份请使用“恢复备份”。');
  if (data.catalogVersion !== catalog.version) throw new Error('两端内置词库版本不一致，请更新到相同版本后重新导出、导入范围。');
  text(data.name,'考试名称',200);
  array(data.rules,'范围规则',500);
  if (!data.rules.length) throw new Error('考试范围至少需要一个内置单元。');
  for (const rule of data.rules) {
    object(rule,'范围规则');
    if (Object.keys(rule).some(key => !['unitId','mode','boundaryId'].includes(key))) throw new Error('范围规则含有不支持的字段。');
    text(rule.unitId,'单元 ID',300);
    enumValue(rule.mode,['all','from','through'],'范围方式');
    if (rule.mode !== 'all') text(rule.boundaryId,'边界词',300);
  }
  array(data.excludedIds,'排除项');
  const selected = resolveSelection(catalog,data.rules);
  const selectedIds = new Set(selected.map(item => item.id));
  if (new Set(data.excludedIds).size !== data.excludedIds.length || data.excludedIds.some(id => typeof id !== 'string' || !selectedIds.has(id))) throw new Error('排除项不在选定的教材范围内。');
  const excluded = new Set(data.excludedIds);
  const used = new Set(data.rules.map(rule => rule.unitId));
  const exam = {id,name:data.name,rules:data.rules,excludedIds:data.excludedIds,items:selected.filter(item => !excluded.has(item.id)),sourceUnits:catalog.units.filter(unit => used.has(unit.id)),sourceVersion:catalog.version,extraItems:[],createdAt:timestamp,updatedAt:timestamp};
  return validateBackup({...freshState(),exams:[exam]}).exams[0];
}

export function exportExamFile(exam, catalog) {
  if (exam.sourceVersion !== catalog.version || exam.extraItems?.length) throw new Error('这份范围不是当前内置词库的范围，请用当前教材重新选择后再导出。');
  const selectedIds = new Set(resolveSelection(catalog,exam.rules || []).map(item => item.id));
  const rules = (exam.rules || []).map(rule => rule.mode === 'all' ? {unitId:rule.unitId,mode:'all'} : {unitId:rule.unitId,mode:rule.mode,boundaryId:rule.boundaryId});
  const data = {format:'efz-exam',version:1,catalogVersion:catalog.version,name:exam.name,rules,excludedIds:(exam.excludedIds || []).filter(id => selectedIds.has(id))};
  const rebuilt = rangeFromReferences(data,catalog,exam.id,new Date().toISOString());
  const signature = items => JSON.stringify(items.map(item => [item.id,item.headwordId,item.word,item.pos,item.definition,item.annotation ?? null,item.source ?? null]));
  if (signature(exam.items) !== signature(rebuilt.items)) throw new Error('这份范围的题目与当前内置词库不一致，请重新选择范围后再导出。');
  return JSON.stringify(data);
}

export function importExamFile(raw, id, catalog, timestamp = new Date().toISOString()) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > 1024 * 1024) throw new Error('考试范围文件过大或格式不正确（上限 1 MB）。');
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('不是完整的考试范围 JSON 文件。'); }
  return rangeFromReferences(data,catalog,id,timestamp);
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('当前浏览器无法保存学习记录。请允许网站存储后重试。'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    let failed = false;
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onerror = () => reject(new Error('无法打开本地学习记录。请检查浏览器存储权限。', { cause: request.error }));
    request.onblocked = () => {
      failed = true;
      reject(new Error('本地记录被另一个页面占用。请关闭本工具的其他标签后重试。'));
    };
    request.onsuccess = () => {
      if (failed) { request.result.close(); return; }
      const database = request.result;
      database.onversionchange = () => { database.close(); databasePromise = undefined; };
      resolve(database);
    };
  }).catch(error => { databasePromise = undefined; throw error; });
  return databasePromise;
}

export async function loadState() {
  await saveQueue;
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(STATE_KEY);
    let result;
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => {
      try { resolve(result === undefined ? freshState() : validateBackup(result)); }
      catch (error) { reject(error); }
    };
    transaction.onabort = () => reject(new Error('读取学习记录失败，原有记录未被更改。', { cause: transaction.error }));
    transaction.onerror = () => {};
  });
}

export function saveState(state) {
  let snapshot;
  try { snapshot = validateBackup(state); }
  catch (error) { return Promise.reject(error); }
  const result = saveQueue.then(async () => {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(snapshot, STATE_KEY);
      // A request success precedes commit; only transaction completion is durable.
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error('保存失败，请立即导出备份并检查设备剩余空间。', { cause: transaction.error }));
      transaction.onerror = () => {};
    });
  });
  saveQueue = result.catch(() => {});
  return result;
}
