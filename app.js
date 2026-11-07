import { resolveSelection, questionHint } from './core.js';
import { createSession, submitPractice, advancePractice, submitMock, summarizeSession, getExamProgress } from './session.js';
import { loadState, saveState, validateBackup, exportExamFile, importExamFile } from './storage.js';

const $ = (selector, base = document) => base.querySelector(selector);
const main = $('#main');
const dialog = $('#dialog');
const html = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const clone = value => structuredClone(value);
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const dateText = value => new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
const timeText = ms => `${Math.floor((ms || 0) / 60000)}:${String(Math.floor((ms || 0) / 1000) % 60).padStart(2, '0')}`;
let catalog, state, view = 'home', editor = null, currentSessionId = null, resultFilter = 'all';
let saveSequence = 0, busy = false, toastTimer, lastClock = performance.now(), clockRunning = false, lastTimerSave = 0;

function allCatalog() {
  return { version: catalog.version, units: catalog.units };
}
function decorate(unit) {
  return { ...unit, items: unit.items.map(item => ({ ...item, unitId: unit.id, unitLabel: unit.label })) };
}
function sourceText(item) {
  const bits = [item.unitLabel || item.source?.name || '用户自建'];
  if (item.source?.printedPage) bits.push(`课本 p.${item.source.printedPage}`);
  if (item.source?.pdfPage) bits.push(`PDF 第 ${item.source.pdfPage} 页`);
  return bits.join(' · ');
}
function examById(id) { return state.exams.find(exam => exam.id === id); }
function sessionById(id = currentSessionId) { return state.sessions.find(session => session.id === id); }
function replaceSession(next) { state.sessions = state.sessions.map(session => session.id === next.id ? next : session); }
function toast(message) {
  clearTimeout(toastTimer);
  $('#notice').innerHTML = `<div class="toast">${html(message)}</div>`;
  toastTimer = setTimeout(() => { $('#notice').textContent = ''; }, 4200);
}
async function persist() {
  const sequence = ++saveSequence;
  $('#save-status').textContent = '正在保存…';
  try {
    await saveState(clone(state));
    if (sequence === saveSequence) {
      $('#save-status').textContent = '已保存在此设备';
      $('#storage-error').hidden = true;
    }
    return true;
  } catch (error) {
    $('#save-status').textContent = '尚未保存';
    $('#storage-error').hidden = false;
    $('#storage-error').innerHTML = `保存没有完成：${html(error.message)}。请先导出备份，再重试。<button class="text-button" id="retry-save">重试保存</button><button class="text-button" id="rescue-backup">导出备份</button>`;
    $('#retry-save').onclick = () => persist();
    $('#rescue-backup').onclick = exportBackup;
    return false;
  }
}
function leaveQuizClock() { accrueTime(); clockRunning = false; }
function navigate(nextView, { focus = true } = {}) {
  if (view === 'quiz' && nextView !== 'quiz') { leaveQuizClock(); void persist(); }
  view = nextView;
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (focus) main.focus({ preventScroll: true });
}
function render() {
  if (view === 'home') renderHome();
  else if (view === 'editor') renderEditor();
  else if (view === 'quiz') renderQuiz();
  else if (view === 'results') renderResults();
}
function openDialog(content) {
  $('#dialog-content').innerHTML = `<div class="dialog-inner">${content}</div>`;
  if (!dialog.open) dialog.showModal();
  $('[data-close]', dialog)?.addEventListener('click', () => dialog.close());
}
function confirmation(title, description, confirmText = '确定') {
  return new Promise(resolve => {
    openDialog(`<h2>${html(title)}</h2><p>${html(description)}</p><div class="dialog-actions"><button class="secondary" id="dialog-cancel">取消</button><button class="primary" id="dialog-confirm">${html(confirmText)}</button></div>`);
    const finish = value => { dialog.removeEventListener('cancel', cancel); dialog.close(); resolve(value); };
    const cancel = event => { event.preventDefault(); finish(false); };
    dialog.addEventListener('cancel', cancel);
    $('#dialog-cancel').onclick = () => finish(false);
    $('#dialog-confirm').onclick = () => finish(true);
  });
}
function download(filename, text, type = 'application/json;charset=utf-8') {
  if (globalThis.efzNative?.bundled) {
    void globalThis.efzNative.saveText(filename, text).then(saved => {
      if (saved) toast('文件已保存');
    }).catch(error => toast(`文件未保存：${error.message}`));
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  openDialog(`<h2>文件已准备好</h2><p>${html(filename)}</p><p>点击下方按钮保存文件。手机上也可以使用浏览器提供的“存储到文件”选项。</p><div class="dialog-actions"><button class="secondary" data-close>关闭</button><a class="button primary" id="prepared-download" href="${html(url)}" download="${html(filename)}">下载文件</a></div>`);
  dialog.addEventListener('close', () => { setTimeout(() => URL.revokeObjectURL(url),60000); },{once:true});
}
function exportBackup() {
  accrueTime();
  const stamp = new Date().toLocaleDateString('sv-SE');
  download(`efzREcite-学习备份-${stamp}.json`, JSON.stringify(state));
}
function summaryForExam(exam) {
  if (!exam.rules?.length) return `${exam.items.length} 道自选题`;
  const units = new Map((exam.sourceUnits || allCatalog().units).map(unit => [unit.id, unit]));
  const description = exam.rules.map(rule => {
    const unit = units.get(rule.unitId);
    if (!unit) return rule.unitId;
    const boundary = unit.items.find(item => item.headwordId === rule.boundaryId)?.word || '';
    return `${unit.label} · ${rule.mode === 'all' ? '全部' : rule.mode === 'through' ? `到 ${boundary} 为止（含）` : `从 ${boundary} 开始（含）`}`;
  }).join('；');
  let excluded = 0;
  try {
    const baseIds = new Set(resolveSelection({units:[...units.values()]},exam.rules).map(item => item.id));
    excluded = (exam.excludedIds || []).filter(id => baseIds.has(id)).length;
  } catch {}
  return description + (excluded ? `；另排除 ${excluded} 个义项` : '') + (exam.extraItems?.length ? `；另加 ${exam.extraItems.filter(item => !exam.excludedIds?.includes(item.id)).length} 个自建义项` : '');
}
function renderHome() {
  const active = state.sessions.filter(session => session.status === 'active');
  const history = state.sessions.filter(session => session.status === 'complete').slice().reverse().slice(0, 6);
  main.innerHTML = `<section class="hero"><div><h1>这次考试，准备好了么？</h1><p>选好范围，按课本释义练习。进度会留在这台设备上。</p></div><div class="toolbar"><button class="secondary" id="import-exam">导入考试范围</button><button class="primary" id="new-exam"><span aria-hidden="true">＋</span> 新建考试范围</button></div></section>
    ${active.map(session => `<div class="resume-card"><div><strong>继续上次${session.mode === 'mock' ? '自测' : '练习'} · ${html(session.examName)}</strong><p>${session.items.length} 题 · 已${session.mode === 'mock' ? '填写' : '完成'} ${session.mode === 'mock' ? Object.values(session.answers).filter(a => a.draft?.trim()).length : summarizeSession(session).answered} 题 · 用时 ${timeText(session.elapsedMs)}</p></div><div class="resume-actions"><button class="secondary" data-resume="${html(session.id)}">继续${session.mode === 'mock' ? '自测' : '练习'} →</button><button class="text-button danger" data-delete-session="${html(session.id)}" aria-label="删除这轮${session.mode === 'mock' ? '自测' : '练习'}">删除</button></div></div>`).join('')}
    <div class="section-title"><h2>我的考试范围 <span class="count-label">${state.exams.length} 份</span></h2><span class="shelf-note">7 册教材 · 28 个单元</span></div>
    ${state.exams.length ? `<div class="exam-grid">${state.exams.map(exam => {
      const progress = getExamProgress(exam, state.sessions);
      return `<article class="card exam-card"><div class="exam-top"><h2>${html(exam.name)}</h2><div class="toolbar" style="gap:8px;flex-shrink:0"><button class="text-button" data-export-exam="${html(exam.id)}">导出</button><button class="text-button" data-copy="${html(exam.id)}">复制</button><button class="text-button" data-edit="${html(exam.id)}">编辑</button></div></div><div class="range-summary">${html(summaryForExam(exam))}</div><div class="stats"><div class="stat"><strong>${exam.items.length}</strong><small>本范围题目</small></div><div class="stat"><strong>${progress.unseen}</strong><small>尚未测过</small></div><div class="stat"><strong>${progress.weak}</strong><small>需要复测</small></div></div><div class="coverage" aria-label="独立通过 ${progress.passed} 题"><span style="width:${exam.items.length ? progress.passed / exam.items.length * 100 : 0}%"></span></div><span class="shelf-note">最近独立通过 ${progress.passed} 题 · 不把手误重试计为首答通过</span><div class="exam-actions"><button class="primary" data-practice="${html(exam.id)}">开始练习</button><button class="secondary" data-mock="${html(exam.id)}">模拟自测</button>${progress.weak ? `<button class="secondary" data-weak="${html(exam.id)}">复测 ${progress.weak} 题</button>` : ''}</div></article>`;
    }).join('')}</div>` : `<section class="card empty-card"><div class="empty-copy"><h2>先把这次要考的选出来</h2><p>一个完整单元，或“从某个词开始”“到某个词为止”，都可以放进同一份范围。</p><button class="secondary" id="first-exam">选择教材与范围 →</button></div></section>`}
    <div class="section-title"><h2>学习记录</h2></div><div class="bottom-tools"><button class="text-button" id="export-backup">导出学习备份</button><button class="text-button" id="restore-backup">恢复备份</button></div><p class="shelf-note">已内置 1,798 条课本释义。备份包含自建范围和学习记录，换设备前请先导出。</p>
    ${history.length ? `<div class="section-title"><h2>最近完成</h2></div>${history.map(session => {
      const score = summarizeSession(session);
      return `<div class="history-row"><div><strong>${html(session.examName)}</strong><div class="muted">${dateText(session.completedAt || session.createdAt)} · ${session.mode === 'mock' ? '模拟自测' : session.filter === 'weak' ? '薄弱题复测' : '练习'} · ${timeText(session.elapsedMs)}</div></div><span class="mono">${score.firstCorrect} / ${score.total}</span><button class="text-button" data-result="${html(session.id)}">查看结果 →</button></div>`;
    }).join('')}` : ''}`;
  const quick = document.createElement('section');
  quick.className = 'card quick-unit';
  quick.innerHTML = `<div><h2>单元快捷练习</h2><p class="shelf-note">选好教材和单元即可开始，范围会自动保存。</p></div><div class="quick-unit-controls"><label>教材<select id="quick-book">${[...new Set(catalog.units.map(unit => unit.book))].map(book => `<option value="${html(book)}">${html(book)}</option>`).join('')}</select></label><label>单元<select id="quick-unit"></select></label><button class="primary" id="quick-start">练习这个单元</button></div>`;
  $('.hero').after(quick);
  const updateQuickUnits = () => {
    $('#quick-unit').innerHTML = catalog.units.filter(unit => unit.book === $('#quick-book').value).map(unit => `<option value="${html(unit.id)}">${html(unit.label.replace(`${unit.book} · `,''))} · ${unit.items.length} 题</option>`).join('');
  };
  $('#quick-book').onchange = updateQuickUnits;
  updateQuickUnits();
  $('#quick-start').onclick = () => {
    const unit = catalog.units.find(unit => unit.id === $('#quick-unit').value);
    if (!unit?.items.length) return;
    const existing = state.exams.find(exam => exam.sourceVersion === catalog.version && exam.rules?.length === 1 && exam.rules[0].unitId === unit.id && exam.rules[0].mode === 'all' && !exam.excludedIds?.length && !exam.extraItems?.length && JSON.stringify(exam.items) === JSON.stringify(unit.items));
    const exam = existing || {id:uid(),name:unit.label,items:clone(unit.items),rules:[{unitId:unit.id,mode:'all'}],sourceUnits:[clone(unit)],excludedIds:[],extraItems:[],sourceVersion:catalog.version,createdAt:now(),updatedAt:now()};
    startDialog(exam.id,'practice','all',exam);
  };
  $('#new-exam').onclick = () => openEditor();
  $('#import-exam').onclick = () => $('#exam-input').click();
  $('#first-exam')?.addEventListener('click', () => openEditor());
  $('#export-backup').onclick = exportBackup;
  $('#restore-backup').onclick = () => $('#backup-input').click();
  main.querySelectorAll('[data-copy]').forEach(button => button.onclick = () => openEditor(button.dataset.copy,true));
  main.querySelectorAll('[data-export-exam]').forEach(button => button.onclick = () => {
    try {
    const exam = examById(button.dataset.exportExam);
    download(`${exam.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_')}-考试范围.json`,exportExamFile(exam,catalog));
    } catch(error) { toast(error.message); }
  });
  main.querySelectorAll('[data-edit]').forEach(button => button.onclick = () => openEditor(button.dataset.edit));
  main.querySelectorAll('[data-practice]').forEach(button => button.onclick = () => startDialog(button.dataset.practice));
  main.querySelectorAll('[data-mock]').forEach(button => button.onclick = () => startDialog(button.dataset.mock, 'mock'));
  main.querySelectorAll('[data-weak]').forEach(button => button.onclick = () => startDialog(button.dataset.weak, 'practice', 'weak'));
  main.querySelectorAll('[data-resume]').forEach(button => button.onclick = () => { currentSessionId = button.dataset.resume; navigate('quiz'); });
  main.querySelectorAll('[data-delete-session]').forEach(button => button.onclick = () => deleteActiveSession(button.dataset.deleteSession));
  main.querySelectorAll('[data-result]').forEach(button => button.onclick = () => { currentSessionId = button.dataset.result; resultFilter = 'all'; navigate('results'); });
}

async function deleteActiveSession(id) {
  if (busy) return;
  const session = sessionById(id);
  if (!session || session.status !== 'active') return;
  busy = true;
  try {
    const label = session.mode === 'mock' ? '自测' : '练习';
    if (!await confirmation(`删除这轮未完成的${label}？`,`${session.examName}：本轮进度和已作答记录将一并删除，无法撤销。考试范围和其他轮次的记录会保留。`,'删除本轮')) return;
    main.inert = true;
    const candidate = {...state,sessions:state.sessions.filter(entry => entry.id !== id)};
    // Commit before replacing visible state so a failed write leaves the round available.
    await saveState(candidate);
    state = candidate;
    if (currentSessionId === id) currentSessionId = null;
    $('#save-status').textContent = '已保存在此设备';
    $('#storage-error').hidden = true;
    renderHome();
    toast(`这轮${label}已删除。`);
  } catch(error) {
    toast(`删除未完成，原记录仍保留：${error.message}`);
  } finally { main.inert = false; busy = false; }
}

function openEditor(examId, copy = false) {
  const exam = examById(examId);
  const base = allCatalog();
  const savedUnits = new Map((exam?.sourceUnits || []).map(unit => [unit.id, unit]));
  const units = base.units.map(unit => savedUnits.get(unit.id) || unit);
  savedUnits.forEach(unit => { if (!units.some(candidate => candidate.id === unit.id)) units.push(unit); });
  editor = { id: copy ? null : exam?.id || null, name: copy ? `${exam.name}（副本）`.slice(0,80) : exam?.name || '', rules: clone(exam?.rules || []), excluded: new Set(exam?.excludedIds || []), extraItems: clone(exam?.extraItems || []), catalog: {version: exam?.sourceVersion || catalog.version, units}, query: '', dirty: copy };
  if (exam && !exam.rules?.length && !exam.extraItems?.length) editor.extraItems = clone(exam.items);
  navigate('editor');
}
function editorItems(includeExcluded = false) {
  const items = [...resolveSelection(editor.catalog, editor.rules), ...editor.extraItems];
  const seen = new Set();
  return items.filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return includeExcluded || !editor.excluded.has(item.id); });
}
function boundaryOptions(unit, selected, query = '') {
  const seen = new Set();
  const groups = unit.items.filter(item => { if (seen.has(item.headwordId)) return false; seen.add(item.headwordId); return true; });
  return groups.map((item, index) => `<option value="${html(item.headwordId)}" ${item.headwordId === selected ? 'selected' : ''}>${html(item.word)} · ${html(item.pos)} · 第 ${index + 1} 词 · ${html(item.definition.slice(0, 46))}${item.definition.length > 46 ? '…' : ''}</option>`).join('');
}
function renderEditor() {
  let items = [], selectionError = '';
  try { items = editorItems(); } catch (error) { selectionError = error.message; }
  main.innerHTML = `<button class="text-button back" id="editor-back">← 返回考试范围</button><div class="page-title"><div><h1>${editor.id ? '编辑考试范围' : '这次考哪些？'}</h1><p>按老师的通知选择，边界词默认包含全部义项。</p></div>${editor.id ? `<button class="text-button danger" id="delete-exam">删除这份范围</button>` : ''}</div>
    <div class="editor-grid"><section class="card editor-fields"><label class="field"><span>考试名称</span><input id="exam-name" value="${html(editor.name)}" placeholder="例如：十月月考" maxlength="80" autocomplete="off"></label><div class="section-title"><h2>选择单元与范围</h2><span class="count-label">可跨册组合</span></div><div id="rules">${editor.rules.map((rule, index) => {
      const unit = editor.catalog.units.find(unit => unit.id === rule.unitId) || {id:rule.unitId,label:'来源单元不可用',items:[]};
      return `<div class="rule"><div class="rule-head"><label class="hidden" for="unit-${index}">第 ${index + 1} 项单元</label><select id="unit-${index}" data-unit="${index}" aria-label="第 ${index + 1} 项单元">${unit.items.length ? '' : `<option value="${html(rule.unitId)}" selected disabled>来源单元不可用，请重新选择</option>`}${editor.catalog.units.map(unit => `<option value="${html(unit.id)}" ${unit.id === rule.unitId ? 'selected' : ''}>${html(unit.label)}</option>`).join('')}</select><button class="icon-button" data-remove-rule="${index}" aria-label="移除第 ${index + 1} 项范围">×</button></div><div class="rule-grid"><select data-mode="${index}" aria-label="第 ${index + 1} 项范围方式"><option value="all" ${rule.mode === 'all' ? 'selected' : ''}>整个单元</option><option value="through" ${rule.mode === 'through' ? 'selected' : ''}>到某个词为止（含）</option><option value="from" ${rule.mode === 'from' ? 'selected' : ''}>从某个词开始（含）</option></select>${rule.mode !== 'all' ? `<label><span class="small-label">选择边界词（可用键盘输入英文定位）</span><select data-boundary="${index}" aria-label="第 ${index + 1} 项边界词">${boundaryOptions(unit, rule.boundaryId)}</select></label>` : ''}</div><p class="rule-note">${rule.mode === 'all' ? `本单元共 ${unit.items.length} 道义项题` : '按课本顺序截取，包含边界词的所有义项。'}</p></div>`;
    }).join('')}</div><button class="secondary" id="add-rule">＋ 添加一个单元</button>${!editor.rules.length ? '<p class="editor-footnote">例如：必修二 Unit 4 全部，加上必修三 Unit 1 到某词为止。</p>' : ''}</section>
    <aside class="card editor-summary"><span class="small muted">当前范围</span><div class="big-number" id="selection-count">${items.length}<small>道题</small></div><div id="selection-headwords" class="shelf-note">${new Set(items.map(item => item.headwordId)).size} 个来源词条 · 多个义项分别出题</div><hr><p>保存后可以直接练习，也可以进行整轮模拟自测。</p><div class="selection-error" id="selection-error">${html(selectionError)}</div><button class="primary" id="save-exam" ${items.length ? '' : 'disabled'}>保存考试范围</button><p class="editor-footnote">原课本词库会保留。已开始的练习继续使用当时的范围。</p></aside></div>
    <section class="card preview-panel"><div class="preview-top"><h2>核对题目 <span class="count-label">取消勾选即可排除某一义项</span></h2><input id="preview-search" placeholder="搜索单词或释义" aria-label="搜索范围内的词条" value="${html(editor.query)}"></div><div id="preview-list" class="preview-list"></div></section>`;
  $('#exam-name').oninput = event => { editor.name = event.target.value; editor.dirty = true; };
  $('#editor-back').onclick = () => leaveEditor();
  $('#add-rule').onclick = () => { editor.rules.push({unitId: editor.catalog.units[0].id, mode:'all'}); editor.dirty = true; renderEditor(); };
  main.querySelectorAll('[data-unit]').forEach(select => select.onchange = event => { const rule = editor.rules[Number(select.dataset.unit)]; rule.unitId = event.target.value; rule.mode = 'all'; delete rule.boundaryId; editor.dirty = true; renderEditor(); });
  main.querySelectorAll('[data-mode]').forEach(select => select.onchange = event => { const rule = editor.rules[Number(select.dataset.mode)]; rule.mode = event.target.value; const unit = editor.catalog.units.find(unit => unit.id === rule.unitId); rule.boundaryId ||= unit.items[0]?.headwordId; editor.dirty = true; renderEditor(); });
  main.querySelectorAll('[data-boundary]').forEach(select => select.onchange = event => { editor.rules[Number(select.dataset.boundary)].boundaryId = event.target.value; editor.dirty = true; updatePreview(); });
  main.querySelectorAll('[data-remove-rule]').forEach(button => button.onclick = () => { editor.rules.splice(Number(button.dataset.removeRule), 1); editor.dirty = true; renderEditor(); });
  $('#preview-search').oninput = event => { editor.query = event.target.value; updatePreview(); };
  $('#save-exam').onclick = saveExam;
  $('#delete-exam')?.addEventListener('click', async () => { if (await confirmation('删除这份考试范围？','会删除这份范围及其练习记录。教材词库和其他考试范围会保留。','删除')) { state.exams = state.exams.filter(exam => exam.id !== editor.id); state.sessions = state.sessions.filter(session => session.examId !== editor.id); await persist(); editor = null; navigate('home'); } });
  updatePreview();
}
function updatePreview() {
  let items, selected;
  try { items = editorItems(true); selected = editorItems(); }
  catch(error) { $('#selection-error').textContent = error.message; $('#save-exam').disabled = true; return; }
  $('#selection-count').innerHTML = `${selected.length}<small>道题</small>`;
  $('#selection-headwords').textContent = `${new Set(selected.map(item => item.headwordId)).size} 个来源词条 · 多个义项分别出题`;
  $('#selection-error').textContent = '';
  $('#save-exam').disabled = !selected.length;
  const query = editor.query.trim().toLowerCase();
  const visible = items.filter(item => `${item.word} ${item.definition}`.toLowerCase().includes(query));
  $('#preview-list').innerHTML = visible.length ? visible.map(item => `<label class="word-row"><input type="checkbox" data-include="${html(item.id)}" ${editor.excluded.has(item.id) ? '' : 'checked'} aria-label="纳入 ${html(item.word)}：${html(item.definition)}"><span class="word-body"><span class="word-heading"><strong>${html(item.word)}</strong><span class="pos">${html(item.pos)}</span></span><span class="definition-small">${html(item.definition)}</span><span class="source" style="display:block">${html(sourceText(item))}</span>${item.annotation ? `<span class="annotation" style="display:block">课本附注：${html(item.annotation)}</span>` : ''}</span></label>`).join('') : '<p class="shelf-note" style="padding:20px 0">还没有题目，或没有符合搜索条件的词条。搜索不会改变已选范围。</p>';
  $('#preview-list').querySelectorAll('[data-include]').forEach(input => input.onchange = () => { if(input.checked) editor.excluded.delete(input.dataset.include); else editor.excluded.add(input.dataset.include); editor.dirty = true; updatePreview(); });
}
async function leaveEditor() {
  if (editor?.dirty && !await confirmation('离开范围编辑？','尚未保存的范围调整会丢弃。','离开')) return;
  editor = null; navigate('home');
}
async function saveExam() {
  if (busy) return;
  if (!editor.name.trim()) { $('#exam-name').focus(); return toast('给这份考试范围起一个名称。'); }
  let items;
  try { items = editorItems(); } catch(error) { return toast(error.message); }
  if (!items.length) return toast('至少选择一道题。');
  busy = true;
  try {
    const existing = examById(editor.id);
    const used = new Set(editor.rules.map(rule => rule.unitId));
    const exam = {id:editor.id || uid(),name:editor.name.trim(),items:clone(items),rules:clone(editor.rules),sourceUnits:clone(editor.catalog.units.filter(unit => used.has(unit.id))),excludedIds:[...editor.excluded],extraItems:clone(editor.extraItems),sourceVersion:editor.catalog.version,createdAt:existing?.createdAt || now(),updatedAt:now()};
    if (existing) state.exams = state.exams.map(item => item.id === exam.id ? exam : item); else state.exams.push(exam);
    editor.id = exam.id;
    const saved = await persist();
    if (saved) { editor = null; navigate('home'); toast('考试范围已保存。'); }
  } finally { busy = false; }
}

function startDialog(examId, mode = 'practice', filter = 'all', sourceExam = null, fixedItems = null) {
  const exam = sourceExam || examById(examId);
  if (!exam?.items.length) return toast('请先选择考试范围。');
  const progress = getExamProgress(exam, state.sessions);
  openDialog(`<h2>${mode === 'mock' ? '开始模拟自测' : '开始练习'}</h2><p>${html(exam.name)} · ${fixedItems ? fixedItems.length : exam.items.length} 道题</p>
    ${mode === 'practice' ? `${fixedItems ? '<p>复测本轮薄弱题。</p>' : `<div class="dialog-options"><label class="dialog-option"><input type="radio" name="practice-filter" value="all" ${filter === 'all' ? 'checked' : ''}><span><strong>本范围全部 · ${exam.items.length} 题</strong><small>按课本释义完整检查一遍。</small></span></label><label class="dialog-option"><input type="radio" name="practice-filter" value="unseen" ${filter === 'unseen' ? 'checked' : ''} ${progress.unseen ? '' : 'disabled'}><span><strong>尚未测过 · ${progress.unseen} 题</strong><small>完成还没有独立作答的部分。</small></span></label><label class="dialog-option"><input type="radio" name="practice-filter" value="weak" ${filter === 'weak' ? 'checked' : ''} ${progress.weak ? '' : 'disabled'}><span><strong>需要复测 · ${progress.weak} 题</strong><small>答错、手误重试、不确定，以及未写出目标词的多解题。</small></span></label></div>`}<label class="checkbox-label"><input type="checkbox" id="random-order">打乱顺序（不勾选则按课本顺序）</label>` : '<p>整轮随机出题，交卷前可以返回修改。交卷后统一显示答案与结果。</p>'}
    <p class="shelf-note" style="margin-top:20px">与原程序相同：输入完整单词，忽略空格，区分大小写。${mode === 'practice' ? '疑似单次手误可重输一次，首答记录保留。' : '作答过程中不显示对错或手误提示。'}</p><div class="dialog-actions"><button class="secondary" data-close>取消</button><button class="primary" id="begin-session">${mode === 'mock' ? '开始自测' : '开始练习'}</button></div>`);
  $('#begin-session').onclick = async () => {
    if (busy) return;
    const selectedFilter = fixedItems ? filter : mode === 'mock' ? 'all' : $('input[name="practice-filter"]:checked', dialog)?.value || 'all';
    const items = fixedItems || exam.items.filter(item => selectedFilter === 'all' || progress.byId.get(item.id)?.status === (selectedFilter === 'weak' ? 'weak' : 'unseen'));
    if (!items.length) return toast('这部分已经没有待练习的题目。');
    const random = mode === 'mock' || $('#random-order').checked;
    const session = createSession(exam, {id:uid(),mode,items,random,now:now()});
    session.filter = selectedFilter;
    busy = true;
    try {
      if (!examById(exam.id) && !fixedItems) state.exams.push(exam);
      state.sessions.push(session); currentSessionId = session.id;
      await persist(); dialog.close(); navigate('quiz');
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    } finally { busy = false; }
  };
}
function currentQuestion(session) { return session.items.find(item => item.id === session.order[session.cursor]); }
function recordFor(session, item) {
  return session.answers[item.id] ||= {draft:'',attempts:[],uncertain:false,done:false};
}
function renderQuiz() {
  const session = sessionById();
  if (!session) { navigate('home'); return; }
  if (session.status === 'complete') { navigate('results'); return; }
  const item = currentQuestion(session);
  if (!item) { toast('无法找到当前题目，请从备份恢复或新建练习。'); navigate('home'); return; }
  const record = recordFor(session,item);
  const mock = session.mode === 'mock';
  const score = summarizeSession(session);
  const questionIndex = session.cursor + 1;
  const hint = questionHint(item.word);
  main.innerHTML = `<div class="quiz-wrap"><div class="quiz-top"><div><strong>${html(session.examName)}</strong><div class="shelf-note">${mock ? '模拟自测' : session.filter === 'weak' ? '薄弱题复测' : session.filter === 'unseen' ? '未测题练习' : '课本释义练习'}</div></div><button class="text-button" id="save-leave">保存并返回</button></div><div class="quiz-progress"><div class="coverage" id="quiz-progress-bar" role="progressbar" aria-label="本轮进度" aria-valuemin="0" aria-valuemax="${score.total}"><span></span></div><span id="quiz-remaining" class="remaining-count" aria-live="polite"></span></div>
    <section class="card quiz-card" style="margin-top:18px"><div class="quiz-caption"><span>当前题号 ${questionIndex} / ${score.total}</span><span>用时 <span id="quiz-timer" class="mono">${timeText(session.elapsedMs)}</span></span></div><div class="question-stem"><span class="word-blank">${html(hint)}</span><span class="pos">${html(item.pos)}</span></div><p class="question-definition" lang="en">${html(item.definition)}</p>
    <form id="answer-form"><label class="answer-label" for="answer-input">输入完整单词（包含首字母）</label><input id="answer-input" class="answer-input" name="efz-answer" aria-label="完整单词" value="${html(record.draft || '')}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="text" maxlength="160" ${!mock && record.done ? 'readonly' : ''}><div class="answer-meta"><label class="checkbox-label"><input type="checkbox" id="uncertain" ${record.uncertain ? 'checked' : ''}>这题不确定，之后再测</label><span class="keyboard-hint">${mock ? 'Enter 下一题' : record.done ? 'Enter 继续' : 'Enter 提交'}</span></div>
    ${!mock && record.done ? feedbackHTML(item,record) : !mock && record.retryOffered ? '<div class="feedback typo" role="status"><h3>可能是手误，再试一次</h3><p>有一处字母不同或相邻字母交换。可以重输一次，首次作答会保留。</p></div>' : ''}
    <div class="quiz-buttons">${mock ? `<button type="button" class="secondary" id="previous-question" ${session.cursor === 0 ? 'disabled' : ''}>上一题</button><button type="button" class="text-button" id="finish-mock">交卷</button><button type="submit" class="primary">${session.cursor === session.order.length - 1 ? '检查并交卷' : '下一题 →'}</button>` : record.done ? `<button type="submit" class="primary">${score.answered === score.total ? '查看本轮结果 →' : '下一题 →'}</button>` : '<button type="button" class="secondary" id="give-up">不会，查看答案</button><button type="button" class="text-button" id="skip-question">稍后再答</button><button type="submit" class="primary">提交答案 →</button>'}</div></form></section>
    <div class="quiz-bottom"><span>${mock ? '交卷前不显示答案与判定' : '横线长度固定 · 与字母个数无关'}</span><span id="quiz-completed"></span></div>
    ${mock ? `<details><summary class="text-button">查看题号，返回修改</summary><div class="question-nav">${session.order.map((id,index) => `<button class="${session.answers[id]?.draft?.trim() ? 'filled ' : ''}${index === session.cursor ? 'current' : ''}" data-question="${index}" aria-label="第 ${index+1} 题${session.answers[id]?.draft?.trim() ? ' 已填写' : ' 未填写'}">${index+1}</button>`).join('')}</div></details>` : ''}</div>`;
  updateQuizProgress(session);
  clockRunning = !document.hidden; lastClock = performance.now();
  $('#save-leave').onclick = async () => { accrueTime(); clockRunning = false; if (await persist()) navigate('home'); else clockRunning = !document.hidden; };
  const input = $('#answer-input');
  input.oninput = () => { const latest = sessionById(); if (latest.status !== 'active') return; const answer = recordFor(latest,item); if(answer.done) return; answer.draft = input.value; updateQuizProgress(latest); void persist(); };
  $('#uncertain').onchange = event => { recordFor(sessionById(),item).uncertain = event.target.checked; void persist(); };
  $('#answer-form').onsubmit = event => { event.preventDefault(); if (!busy) void (mock ? nextMock() : answerPractice()); };
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && event.isComposing) event.preventDefault(); });
  $('#give-up')?.addEventListener('click', () => answerPractice(true));
  $('#skip-question')?.addEventListener('click', async () => {
    if(busy) return; busy=true;
    try { accrueTime();
      const previous = sessionById(); const next = advancePractice(previous,now()); replaceSession(next); renderQuiz(); await persist();
      if (next.cursor === previous.cursor && next.status === 'active') toast('只剩这一题待答。可以作答，或选择“不会”。');
    } finally { busy=false; }
  });
  $('#previous-question')?.addEventListener('click', () => jumpMock(sessionById().cursor - 1));
  $('#finish-mock')?.addEventListener('click', finishMockDialog);
  main.querySelectorAll('[data-question]').forEach(button => button.onclick = () => jumpMock(Number(button.dataset.question)));
  if (matchMedia('(pointer:fine)').matches && !record.done) input.focus({preventScroll:true});
}
function updateQuizProgress(session) {
  const mock = session.mode === 'mock';
  const total = session.items.length;
  const completed = mock ? session.items.filter(item => session.answers[item.id]?.draft?.trim()).length : summarizeSession(session).answered;
  $('#quiz-remaining').textContent = mock ? `剩余 ${total - completed} 题未填` : `剩余 ${total - completed} 题`;
  $('#quiz-completed').textContent = `${mock ? '已填写' : '已完成'} ${completed} / ${total}`;
  $('#quiz-progress-bar').setAttribute('aria-valuenow',String(completed));
  $('#quiz-progress-bar span').style.width = `${completed / total * 100}%`;
}
function feedbackHTML(item, record) {
  const result = record.result;
  if (!result) return '';
  const first = record.attempts[0] || '';
  return `<div class="feedback ${result.correct ? '' : 'wrong'}" role="status"><h3>${result.correct ? record.firstCorrect ? '回答正确' : '重输后正确，之后再独立测一次' : '本题教材目标词'}</h3><div class="answer-word" lang="en">${html(item.word)}</div>${!record.firstCorrect ? `<p>首次作答：<b>${html(first || '不会 / 未作答')}</b></p>` : ''}${result.ambiguous ? `<p>本范围内题面相同的教材答案：${result.alternatives.map(html).join(' / ')}。${!result.targetMatched && result.correct ? '已记录你写出的词，当前目标词仍留作复测。' : ''}</p>` : ''}${item.annotation ? `<p>课本附注：${html(item.annotation)}（原文保留）</p>` : ''}<div class="source">${html(sourceText(item))}</div></div>`;
}
async function answerPractice(giveUp = false) {
  if (busy) return;
  busy = true;
  try {
    accrueTime();
    const session = sessionById(); const item = currentQuestion(session); const record = recordFor(session,item);
    if (record.done) {
      replaceSession(advancePractice(session,now()));
    } else {
      const answer = $('#answer-input').value;
      if (!giveUp && !answer.trim()) { toast('先输入单词，或选择“不会”。'); return; }
      record.draft = answer;
      record.uncertain = $('#uncertain').checked;
      const output = submitPractice(session,answer,{uncertain:record.uncertain,giveUp,now:now()});
      replaceSession(output.session);
    }
    await persist();
    if (sessionById().status === 'complete') { resultFilter = 'all'; navigate('results'); }
    else { renderQuiz(); if (sessionById().answers[item.id]?.retryOffered && !sessionById().answers[item.id]?.done) $('#answer-input').select(); }
  } catch(error) { toast(error.message); }
  finally { busy = false; }
}
async function jumpMock(index) {
  if(busy) return;
  const session = sessionById(); if (index < 0 || index >= session.order.length) return;
  busy=true;
  try { accrueTime(); session.cursor = index; renderQuiz(); await persist(); }
  finally { busy=false; }
}
async function nextMock() {
  const session = sessionById();
  if (session.cursor === session.order.length - 1) await finishMockDialog();
  else await jumpMock(session.cursor + 1);
}
async function finishMockDialog() {
  if (busy) return;
  const session = sessionById();
  const empty = session.order.filter(id => !session.answers[id]?.draft?.trim()).length;
  const confirm = await confirmation('提交这轮自测？', empty ? `还有 ${empty} 道题未填写。交卷后会计入本卷题数，并单列为未作答。` : '所有题目都已填写。交卷后显示答案与结果，本轮作答将保留。','交卷并查看结果');
  if (!confirm) return;
  busy = true;
  try { accrueTime(); replaceSession(submitMock(sessionById(),now())); await persist(); resultFilter = 'all'; navigate('results'); }
  finally { busy = false; }
}
function accrueTime() {
  const current = performance.now();
  const session = sessionById();
  if (clockRunning && view === 'quiz' && session?.status === 'active') session.elapsedMs += Math.max(0,current-lastClock);
  lastClock = current;
}
function renderResults() {
  const session = sessionById();
  if (!session) { navigate('home'); return; }
  const score = summarizeSession(session);
  const weak = item => { const a=session.answers[item.id]; return !a?.done || !a.firstCorrect || !a.result?.targetMatched || a.uncertain; };
  const displayed = session.items.filter(item => resultFilter === 'all' || weak(item));
  const exam = examById(session.examId);
  main.innerHTML = `<button class="text-button back" id="results-back">← 返回考试范围</button><section class="card"><div class="results-hero"><div class="results-info"><h1>${session.mode === 'mock' ? '自测已完成' : '这一轮，练完了'}</h1><p>${html(session.examName)} · ${session.filter === 'weak' ? '薄弱题复测' : session.filter === 'unseen' ? '未测题练习' : '本轮选定范围'} · 用时 ${timeText(session.elapsedMs)}</p><span class="shelf-note">${session.mode === 'mock' ? '交卷正确率' : '首答正确率'} ${Math.round(score.percent)}% · 本轮共 ${score.total} 题</span></div><div class="results-score">${score.firstCorrect}<small> / ${score.total}</small></div></div><div class="results-stats"><div class="stat"><strong>${score.firstCorrect}</strong><small>首答正确</small></div><div class="stat"><strong>${score.retried}</strong><small>手误重输</small></div><div class="stat"><strong>${score.wrong}</strong><small>未答对${score.blank ? `（含空白 ${score.blank}）` : ''}</small></div><div class="stat"><strong>${score.uncertain}</strong><small>标记不确定</small></div></div></section>
    <div class="results-actions"><button class="primary" id="review-weak" ${session.items.some(weak) ? '' : 'disabled'}>复测本轮薄弱题</button>${exam ? '<button class="secondary" id="restart-all">再测整个范围</button>' : ''}<button class="secondary" id="return-home">返回首页</button></div><p class="shelf-note">这里只统计本轮题目。重输后正确保留原来的首答记录；同题面的其他教材答案会注明，不代表所有候选词都已经会写。</p><div class="section-title"><h2>本轮作答</h2><div class="review-controls"><label for="result-filter" class="small muted">查看</label><select id="result-filter"><option value="all" ${resultFilter === 'all' ? 'selected' : ''}>全部 ${score.total} 题</option><option value="weak" ${resultFilter === 'weak' ? 'selected' : ''}>需要再测的题</option></select></div></div><section class="card answer-list">${displayed.length ? displayed.map(item => {
      const answer = session.answers[item.id]; const result = answer?.result;
      const tag = !result?.correct ? ['red',answer?.attempts?.at(-1)?.trim() ? '未答对' : '未作答 / 不会'] : !result.targetMatched ? ['amber','同题面其他答案'] : answer.uncertain ? ['amber','答对，但不确定'] : !answer.firstCorrect ? ['amber','重输后正确'] : ['', '首答正确'];
      return `<article class="answer-row"><div class="word-heading"><strong lang="en">${html(item.word)} <span class="pos">${html(item.pos)}</span></strong><span class="tag ${tag[0]}">${tag[1]}</span></div><div class="definition-small" lang="en">${html(item.definition)}</div><p class="answer-detail">你的作答：<b>${answer?.attempts?.length ? answer.attempts.map(value => html(value || '空白')).join(' → ') : '未作答'}</b></p>${result?.ambiguous ? `<p class="answer-detail">相同题面的教材答案：${result.alternatives.map(html).join(' / ')}</p>` : ''}${item.annotation ? `<p class="annotation">课本附注：${html(item.annotation)}（原文保留）</p>` : ''}<div class="source">${html(sourceText(item))}</div></article>`;
    }).join('') : '<p class="muted" style="padding:20px 0">本轮没有需要复测的题目。</p>'}</section>`;
  $('#results-back').onclick = $('#return-home').onclick = () => navigate('home');
  $('#result-filter').onchange = event => { resultFilter = event.target.value; renderResults(); };
  $('#restart-all')?.addEventListener('click', () => startDialog(session.examId,'mock'));
  $('#review-weak').onclick = () => {
    const items = session.items.filter(weak);
    if (!items.length) return;
    const source = {id:session.examId,name:session.examName,items:session.scopeItems};
    startDialog(source.id,'practice','weak',source,items);
  };
}

async function importExamRange(file) {
  if (!file) return;
  if (file.size > 1024 * 1024) return toast('考试范围文件超过 1 MB。');
  try {
    const exam = importExamFile(await file.text(),uid(),catalog,now());
    if (!await confirmation('导入这份考试范围？',`${exam.name} · ${exam.items.length} 道题。将新增一份范围，保留现有范围和学习记录。`,'导入范围')) return;
    const candidate = validateBackup({...state,exams:[...state.exams,exam]});
    await saveState(candidate);
    state = candidate;
    $('#save-status').textContent = '已保存在此设备';
    navigate('home'); toast('考试范围已导入，可以开始练习。');
  } catch(error) {
    openDialog(`<h2>考试范围未能导入</h2><p>${html(error.message)}</p><div class="dialog-actions"><button class="primary" data-close>知道了</button></div>`);
  }
}

async function restoreBackup(file) {
  if (!file) return;
  if (file.size > 32 * 1024 * 1024) return toast('备份超过 32 MB，暂时无法在这里恢复。');
  try {
    const restored = validateBackup(await file.text());
    if (!await confirmation('恢复这份学习备份？',`包含 ${restored.exams.length} 份考试范围和 ${restored.sessions.length} 轮练习。恢复会替换这台设备中的现有记录；建议先取消并导出当前备份。`,'替换并恢复')) return;
    // Commit first so an invalid or unwritable backup cannot replace memory state.
    await saveState(restored);
    state = restored; currentSessionId = null; editor = null;
    $('#save-status').textContent = '已保存在此设备';
    $('#storage-error').hidden = true;
    navigate('home'); toast('备份已恢复。');
  } catch(error) { openDialog(`<h2>备份未能恢复</h2><p>${html(error.message)}</p><p>当前记录没有被这份备份替换。</p><div class="dialog-actions"><button class="primary" data-close>知道了</button></div>`); }
}
function showHelp() {
  if (globalThis.efzStandalone?.bundled) {
    openDialog(`<h2>离线使用与备份</h2><p>这一个 HTML 文件已经包含程序和全部词库，双击打开即可使用，首次打开也无需联网。</p><ul class="help-list"><li>练习记录保存在当前浏览器中，不会写回 HTML 文件。推荐使用普通的 Chrome、Edge 或 Firefox 窗口。</li><li>请把 HTML 留在固定位置。换浏览器、换电脑、移动文件或清理浏览器数据前，先在首页导出学习备份；在新入口恢复备份即可继续。</li><li>分享考试范围只需导出范围文件；学习备份才包含练习进度。恢复备份会替换当前记录。</li><li>无痕窗口或禁用本地存储会影响记录保存。每次使用后留意“已保存在此设备”，并定期导出备份。</li><li>安卓安装版与本文件的记录各自保存，可以通过学习备份迁移。</li></ul><div class="dialog-actions"><button class="secondary" id="help-backup">导出备份</button><button class="primary" data-close>知道了</button></div>`);
    $('#help-backup').onclick = exportBackup;
    return;
  }
  if (globalThis.efzNative?.bundled) {
    openDialog(`<h2>离线使用与备份</h2><p>程序和全部教材词库已经包含在安装包中，首次打开也无需联网。</p><ul class="help-list"><li>练习自动保存在这台设备的应用中。</li><li>考试范围可以导出分享。完整学习备份还能保留练习进度；恢复备份会替换本机已有记录。</li><li>换设备、卸载或清除应用数据前，请先导出学习备份。网页版与安装版各自保存记录，需要用备份迁移。</li><li>更新时安装新版即可；请保留备份，不要先卸载旧版。</li><li>离开练习页面及切到后台不计入学习用时。模拟自测交卷前不会显示判定。</li></ul><div class="dialog-actions"><button class="secondary" id="help-backup">导出备份</button><button class="primary" data-close>知道了</button></div>`);
    $('#help-backup').onclick = exportBackup;
    return;
  }
  openDialog(`<h2>离线使用与备份</h2><p>efzREcite 的题库和学习记录保存在当前设备上。</p><ul class="help-list"><li>首次打开需要联网。右上角显示“已可离线使用”后，可以断网重新打开并练习。</li><li>iPhone：用 Safari 打开，通过分享菜单选择“添加到主屏幕”；如有“作为网页 App 打开”，将其开启。</li><li>电脑与 Android：可以直接使用浏览器，也可以使用浏览器提供的安装或添加主屏幕入口。</li><li>练习自动保存。切换设备、清理网站数据或浏览器前，请在首页导出备份；在新设备用“恢复备份”继续。</li><li>不同浏览器或主屏幕入口不保证共享记录。无痕浏览、主动清理网站数据或设备存储不足可能影响保存。</li><li>离开练习页面及切到后台不计入学习用时。模拟自测交卷前不会显示判定。</li></ul><p class="small muted">程序有更新时会先准备资源。结束练习后，关闭所有 efzREcite 页面再打开，可切换到新版本。</p><div class="dialog-actions"><button class="secondary" id="help-backup">导出备份</button><button class="primary" data-close>知道了</button></div>`);
  $('#help-backup').onclick = exportBackup;
}
async function checkOffline(worker) {
  if (!worker) return;
  const response = await new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve(null); },5000);
    channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
    worker.postMessage({type:'CHECK_OFFLINE'},[channel.port2]);
  });
  const label = $('#offline-status');
  if (response?.ready) { label.textContent = '已可离线使用'; label.classList.add('ready'); }
  else { label.textContent = '离线资源未就绪'; label.classList.remove('ready'); }
}
async function setupOffline() {
  if (globalThis.efzNative?.bundled || globalThis.efzStandalone?.bundled) {
    $('#offline-status').textContent = '已内置 · 可离线使用';
    $('#offline-status').classList.add('ready');
    return;
  }
  if (!('serviceWorker' in navigator)) { $('#offline-status').textContent = '此浏览器不支持离线'; return; }
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    const watch = worker => {
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated') void checkOffline(worker);
        if (worker.state === 'redundant') $('#offline-status').textContent = '离线准备失败，请联网重试';
      });
    };
    watch(registration.installing);
    registration.addEventListener('updatefound', () => watch(registration.installing));
    navigator.serviceWorker.addEventListener('controllerchange', () => checkOffline(navigator.serviceWorker.controller));
    if (registration.active) await checkOffline(registration.active);
    navigator.serviceWorker.ready.then(active => checkOffline(active.active)).catch(() => {});
  } catch(error) { $('#offline-status').textContent = '离线准备失败，请联网重试'; }
}
async function boot() {
  try {
    const readCatalog = async () => {
      if (globalThis.efzStandalone?.bundled) return globalThis.efzStandalone.catalog;
      const response=await fetch('./data/catalog.json');
      if (!response.ok) throw new Error('教材词库尚未加载，请重新打开。');
      return response.json();
    };
    const [data, saved] = await Promise.all([readCatalog(),loadState()]);
    catalog = data; catalog.units = catalog.units.map(decorate);
    state = saved;
    $('#save-status').textContent = '记录已读取';
    renderHome();
    $('#help-button').onclick = showHelp;
    $('.brand').onclick = async event => { event.preventDefault(); if(view === 'editor') await leaveEditor(); else if(view === 'quiz') { accrueTime(); if(await persist()) navigate('home'); } else navigate('home'); };
    $('#exam-input').onchange = event => { const file=event.target.files[0]; event.target.value=''; void importExamRange(file); };
    $('#backup-input').onchange = event => { const file=event.target.files[0]; event.target.value=''; void restoreBackup(file); };
    document.addEventListener('visibilitychange', () => { accrueTime(); clockRunning = view === 'quiz' && !document.hidden && sessionById()?.status === 'active'; if(document.hidden) void persist(); });
    window.addEventListener('pagehide', () => { accrueTime(); clockRunning=false; void persist(); });
    window.addEventListener('pageshow', () => { lastClock=performance.now(); clockRunning=view==='quiz'&&!document.hidden&&sessionById()?.status==='active'; });
    window.addEventListener('beforeunload', event => { if(editor?.dirty) { event.preventDefault(); event.returnValue=''; } });
    setInterval(() => {
      accrueTime();
      if($('#quiz-timer')) $('#quiz-timer').textContent=timeText(sessionById()?.elapsedMs);
      if(clockRunning && performance.now()-lastTimerSave>15000) { lastTimerSave=performance.now(); void persist(); }
    },1000);
    await setupOffline();
  } catch(error) {
    $('#save-status').textContent='尚未就绪';
    main.innerHTML=`<section class="card empty-copy"><h1>暂时无法打开</h1><p>${html(error.message)}</p><p class="muted">请使用普通浏览窗口，检查网络与浏览器存储是否可用。已有数据不会被自动清空。</p><button class="primary" id="retry-load">重新打开</button></section>`;
    $('#retry-load').onclick=()=>location.reload();
  }
}
void boot();
