const $ = (s) => document.querySelector(s);

// 全局错误上报:任何前端 JS 错误都显示到提示行,便于定位
window.addEventListener('error', (e) => {
  const el = document.querySelector('#search-hint');
  if (el) el.textContent = `⚠️ 前端错误:${e.message || e.error}`;
});

let currentWork = '';
let lastExport = null;
let regularExport = null;
let draftExport = null;
let currentMode = 'fast';
let deepHistory = [];
let deepTried = [];
let deepLastBest = null;
let deepQ0 = '';
let deepTaskId = null;
let draftSession = null;

// 原稿对照与三种检索共用同一个模式卡片和结果区。
const draftModeContent = $('#draft-mode-content');
document.querySelector('.mode-switch').insertAdjacentElement('afterend', draftModeContent);

const draftParamPairs = [
  ['#recallk', '#draft-fast-recall'], ['#rerankk', '#draft-fast-rerank'], ['#topk', '#draft-fast-topk'],
  ['#r-recallk', '#draft-refine-recall'], ['#rounds', '#draft-refine-rounds'],
  ['#batchk', '#draft-refine-batch'], ['#r-topk', '#draft-refine-topk'],
  ['#judgechars', '#draft-refine-judge'], ['#d-recallk', '#draft-deep-recall'],
  ['#d-batchk', '#draft-deep-batch'], ['#d-topk', '#draft-deep-topk'],
  ['#d-judgechars', '#draft-deep-judge'], ['#d-retry', '#draft-deep-retry'],
];

function setDraftRetrievalMode(mode) {
  if (!['fast', 'refine', 'deep'].includes(mode)) mode = 'fast';
  $('#draft-retrieval-mode').value = mode;
  $('#draft-fast-params').classList.toggle('hidden', mode !== 'fast');
  $('#draft-refine-params').classList.toggle('hidden', mode !== 'refine');
  $('#draft-deep-params').classList.toggle('hidden', mode !== 'deep');
  const hints = {
    fast: '快速检索会根据每处薄弱描写分别查询,批量时最多同时处理 3 处。',
    refine: '精细检索会进行多轮相关性判断,批量时最多同时处理 2 处。',
    deep: '深度迭代会为每处薄弱描写反复改写查询,为避免模型请求过多会逐处处理。',
  };
  $('#draft-retrieval-hint').textContent = hints[mode];
}

function draftRetrievalParams() {
  const mode = $('#draft-retrieval-mode').value;
  if (mode === 'fast') return {
    recall_k: $('#draft-fast-recall').value, rerank_k: $('#draft-fast-rerank').value,
    top_k: $('#draft-fast-topk').value,
  };
  if (mode === 'refine') return {
    recall_k: $('#draft-refine-recall').value, rounds: $('#draft-refine-rounds').value,
    batch_size: $('#draft-refine-batch').value, top_k: $('#draft-refine-topk').value,
    judge_chars: $('#draft-refine-judge').value,
  };
  return {
    recall_k: $('#draft-deep-recall').value, batch_size: $('#draft-deep-batch').value,
    top_k: $('#draft-deep-topk').value, judge_chars: $('#draft-deep-judge').value,
    retry_count: $('#draft-deep-retry').value,
  };
}

function applyDraftRetrievalConfig(config) {
  if (!config || !config.mode) return;
  setDraftRetrievalMode(config.mode);
  const ids = config.mode === 'fast'
    ? { recall_k: '#draft-fast-recall', rerank_k: '#draft-fast-rerank', top_k: '#draft-fast-topk' }
    : (config.mode === 'refine'
      ? { recall_k: '#draft-refine-recall', rounds: '#draft-refine-rounds', batch_size: '#draft-refine-batch', top_k: '#draft-refine-topk', judge_chars: '#draft-refine-judge' }
      : { recall_k: '#draft-deep-recall', batch_size: '#draft-deep-batch', top_k: '#draft-deep-topk', judge_chars: '#draft-deep-judge', retry_count: '#draft-deep-retry' });
  Object.entries(ids).forEach(([key, id]) => {
    if (config[key] !== undefined) $(id).value = config[key];
  });
}

function setDraftRetrievalLocked(locked) {
  $('#draft-retrieval-mode').disabled = locked;
  document.querySelectorAll('#draft-fast-params input, #draft-refine-params input, #draft-deep-params input')
    .forEach(input => { input.disabled = locked; });
}

draftParamPairs.forEach(([mainId, draftId]) => {
  $(mainId).addEventListener('input', () => { $(draftId).value = $(mainId).value; });
  $(draftId).addEventListener('input', () => { $(mainId).value = $(draftId).value; });
});
$('#draft-retrieval-mode').addEventListener('change', (e) => setDraftRetrievalMode(e.target.value));

function setMode(mode) {
  const previousMode = currentMode;
  currentMode = mode;
  $('#mode-fast').classList.toggle('active', mode === 'fast');
  $('#mode-refine').classList.toggle('active', mode === 'refine');
  $('#mode-deep').classList.toggle('active', mode === 'deep');
  $('#mode-draft').classList.toggle('active', mode === 'draft');
  $('#scene-mode-content').classList.toggle('hidden', mode === 'draft');
  $('#draft-mode-content').classList.toggle('hidden', mode !== 'draft');
  $('#fast-params').classList.toggle('hidden', mode !== 'fast');
  $('#refine-params').classList.toggle('hidden', mode !== 'refine');
  $('#deep-params').classList.toggle('hidden', mode !== 'deep');
  $('#expand-btn').classList.toggle('hidden', mode !== 'fast');
  $('#search-btn').classList.toggle('hidden', mode === 'deep' || mode === 'draft');
  $('#deep-actions').classList.toggle('hidden', mode !== 'deep');
  clearExpandVersions();
  clearDeepQueryVersions();
  $('#search-btn').textContent = mode === 'fast' ? '快速检索' : '精细检索';
  renderDeepHistory();
  if (mode === 'draft') {
    if (draftSession && (draftSession.annotations || []).length) {
      renderDraftAnnotations(draftSession);
    } else {
      const box = $('#results');
      box.classList.add('empty');
      box.innerHTML = '还没有薄弱描写诊断结果。先分析原稿、确认需要加强的位置并查询范本。';
      $('#hyde-note').classList.add('hidden');
      lastExport = null;
      setExportEnabled(false);
    }
  } else if (previousMode === 'draft') {
    if (regularExport) {
      lastExport = regularExport;
      render({ results: regularExport.results || [] });
      setExportEnabled(true);
    } else {
      const box = $('#results');
      box.classList.add('empty');
      box.innerHTML = '还没有检索结果。输入场景后开始检索。';
      lastExport = null;
      setExportEnabled(false);
    }
  }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function setProgress(barId, textId, done, total, message) {
  const bar = $('#' + barId);
  const text = $('#' + textId);
  if (bar) {
    if (total > 0) {
      bar.classList.remove('indeterminate');
      bar.style.width = Math.min(100, Math.round((done / total) * 100)) + '%';
    } else {
      bar.classList.add('indeterminate');
    }
  }
  if (text && message !== undefined) text.textContent = message;
}

async function pollProgress(taskId, barId, textId) {
  let failures = 0;
  const startedAt = Date.now();
  while (true) {
    if (Date.now() - startedAt > 6 * 60 * 60 * 1000) throw new Error('任务等待超时');
    await sleep(800);
    let p;
    try {
      const r = await fetch(`/api/progress/${taskId}`);
      p = await r.json();
      if (!r.ok) throw new Error(p.detail || `无法读取任务状态（${r.status}）`);
      failures = 0;
    } catch (e) {
      failures += 1;
      if (failures >= 8) throw e;
      continue;
    }
    setProgress(barId, textId, p.done, p.total, p.message);
    if (p.status === 'done') {
      setProgress(barId, textId, p.total, p.total, p.message);
      return p;
    }
    if (p.status === 'cancelled') {
      document.getElementById(barId)?.classList.remove('indeterminate');
      return p;
    }
    if (p.status === 'error') {
      const error = new Error(p.error || '任务失败');
      error.taskFinished = true;
      throw error;
    }
  }
}

function renderDraftPreview(draft, units) {
  const sorted = [...(units || [])].sort((a, b) => a.start - b.start);
  let html = '';
  let last = 0;
  sorted.forEach((unit) => {
    const start = Math.max(last, Number(unit.start) || 0);
    const end = Math.max(start, Number(unit.end) || start);
    html += esc(draft.slice(last, start));
    html += `<mark data-unit="${esc(unit.id)}">${esc(draft.slice(start, end))}</mark>`;
    last = end;
  });
  html += esc(draft.slice(last));
  $('#draft-preview').innerHTML = html;
}

function renderDraftUnits(units) {
  $('#draft-units').innerHTML = (units || []).map((unit, i) => `
    <div class="draft-unit" data-id="${esc(unit.id)}">
      <label class="draft-unit-head">
        <input class="draft-unit-selected" type="checkbox" ${unit.selected !== false ? 'checked' : ''}>
        <span>${esc(unit.id || `u${i + 1}`)} · 原稿 P${unit.paragraph_start}${unit.paragraph_end !== unit.paragraph_start ? `–P${unit.paragraph_end}` : ''}</span>
      </label>
      <div class="draft-unit-source">${esc(unit.source_text)}</div>
      <div class="draft-unit-fields">
        <label>为什么显得薄弱<textarea class="draft-unit-weakness" rows="3">${esc(unit.weakness || unit.intent || '')}</textarea></label>
        <label>前后场景概括<textarea class="draft-unit-context" rows="3">${esc(unit.context_summary || unit.source_text || '')}</textarea></label>
        <label>希望丰富什么<textarea class="draft-unit-goal" rows="3">${esc(unit.enrichment_goal || unit.intent || '')}</textarea></label>
        <label>AI 优化后的检索内容<span class="draft-field-note">可修改；过短时才自动补充场景语境</span><textarea class="draft-unit-query" rows="3">${esc(unit.query || '')}</textarea></label>
      </div>
    </div>`).join('');
}

function collectDraftUnits() {
  if (!draftSession) return [];
  const original = new Map((draftSession.units || []).map(u => [String(u.id), u]));
  return [...document.querySelectorAll('.draft-unit')].map((el) => {
    const base = original.get(el.dataset.id) || {};
    return {
      ...base,
      id: el.dataset.id,
      selected: el.querySelector('.draft-unit-selected').checked,
      weakness: el.querySelector('.draft-unit-weakness').value.trim(),
      context_summary: el.querySelector('.draft-unit-context').value.trim(),
      enrichment_goal: el.querySelector('.draft-unit-goal').value.trim(),
      intent: el.querySelector('.draft-unit-goal').value.trim(),
      query: el.querySelector('.draft-unit-query').value.trim(),
    };
  });
}

function renderDraftAnnotations(session) {
  const annotations = session.annotations || [];
  draftExport = { mode: 'draft', session, work: currentWork };
  if (currentMode !== 'draft') return;
  const box = $('#results');
  $('#hyde-note').classList.add('hidden');
  if (!annotations.length) {
    box.classList.add('empty');
    box.innerHTML = '还没有薄弱描写诊断结果。确认需要加强的位置并完成范本查询后会显示在这里。';
    lastExport = null;
    setExportEnabled(false);
    return;
  }
  const unitMap = new Map((session.units || []).map(u => [String(u.id), u]));
  box.classList.remove('empty');
  box.innerHTML = annotations.map((ann) => {
    const unit = unitMap.get(String(ann.unit_id));
    const refs = ann.references || [];
    return `<div class="draft-annotation">
      <div class="draft-ann-title">${esc(ann.unit_id)} · ${esc(unit ? (unit.enrichment_goal || unit.intent) : '后续查询')}</div>
      ${unit ? `<div class="draft-diagnosis">
        <div><span>薄弱原因</span>${esc(unit.weakness || unit.intent || '-')}</div>
        <div><span>前后场景</span>${esc(unit.context_summary || unit.source_text || '-')}</div>
        <div><span>丰富目标</span>${esc(unit.enrichment_goal || unit.intent || '-')}</div>
      </div>` : ''}
      ${ann.summary ? `<div class="draft-ann-summary"><span>丰富思路</span>${esc(ann.summary)}</div>` : ''}
      ${refs.length ? refs.map((ref, i) => `<div class="draft-reference">
        <div class="draft-reference-head"><span>#${i + 1}</span>${ref.work_name ? `<span>《${esc(ref.work_name)}》</span>` : ''}<span>${esc(ref.chapter || '')}</span>${ref.hybrid_scores
          ? `<span>混合 ${(ref.hybrid_scores.combined * 100).toFixed(1)}% · D ${(ref.hybrid_scores.dense * 100).toFixed(1)} / S ${(ref.hybrid_scores.sparse * 100).toFixed(1)} / C ${(ref.hybrid_scores.colbert * 100).toFixed(1)}</span>`
          : `<span>判断 ${esc(ref.llm_score ?? '-')} / 3</span>`}</div>
        <div class="draft-reference-text">${esc(ref.text || '')}</div>
        ${ref.correspondence ? `<div class="draft-reference-note"><span>对应</span>${esc(ref.correspondence)}</div>` : ''}
        ${ref.what_to_learn ? `<div class="draft-reference-note"><span>借鉴</span>${esc(ref.what_to_learn)}</div>` : ''}
        ${ref.suggestion ? `<div class="draft-reference-note"><span>迁移</span>${esc(ref.suggestion)}</div>` : ''}
      </div>`).join('') : '<div class="hint">没有找到足够贴合的范本片段。</div>'}
    </div>`;
  }).join('');
  lastExport = draftExport;
  setExportEnabled(true);
}

function renderDraftEvents(events) {
  $('#draft-events').innerHTML = (events || []).map(e =>
    `<div class="draft-event ${e.role === 'user' ? 'user' : 'assistant'}">${esc(e.content)}</div>`
  ).join('');
  $('#draft-events').scrollTop = $('#draft-events').scrollHeight;
}

function renderDraftUnderstanding(session) {
  const clarification = session.clarification || {};
  const panel = $('#draft-understanding-panel');
  const hasUnderstanding = Boolean(clarification.understanding || (clarification.questions || []).length);
  panel.classList.toggle('hidden', !hasUnderstanding);
  if (!hasUnderstanding) return;
  const inConfirmationStage = ['awaiting_clarification', 'awaiting_understanding_confirmation'].includes(session.status);
  const ready = session.status === 'awaiting_understanding_confirmation';
  $('#draft-understanding-state').textContent = ready
    ? '信息已足够 · 等待你的确认'
    : (session.status === 'awaiting_clarification' ? '需要补充信息' : '已确认');
  $('#draft-understanding').textContent = clarification.understanding || '分析模型未提供理解摘要。';
  $('#draft-questions').innerHTML = (clarification.questions || []).map((q, i) => `
    <div class="draft-question" data-id="${esc(q.id || `q${i + 1}`)}">
      <div class="draft-question-title">${i + 1}. ${esc(q.question || '')}</div>
      ${q.reason ? `<div class="draft-question-reason">为什么要确认:${esc(q.reason)}</div>` : ''}
      <textarea class="draft-question-answer" rows="2" placeholder="填写你的回答"></textarea>
    </div>`).join('');
  $('.draft-correction-label').classList.toggle('hidden', !inConfirmationStage);
  $('.draft-understanding-actions').classList.toggle('hidden', !inConfirmationStage);
  $('#draft-correction').value = '';
  $('#draft-understanding-confirm').checked = false;
  $('#draft-understanding-confirm').disabled = !ready;
  $('#draft-decompose-btn').disabled = true;
  $('#draft-clarify-btn').textContent = ready ? '提交补充或纠正' : '提交回答或纠正';
}

function renderDraftSession(session) {
  draftSession = session;
  applyDraftRetrievalConfig(session.retrieval_config);
  $('#draft-input').value = session.draft || '';
  $('#draft-supplement').value = session.supplement || '';
  $('#draft-input').disabled = true;
  $('#draft-supplement').disabled = true;
  $('#draft-workspace').classList.remove('hidden');
  $('#draft-new-btn').classList.remove('hidden');
  $('#draft-analyze-btn').classList.add('hidden');
  renderDraftUnderstanding(session);
  const hasUnits = (session.units || []).length > 0;
  $('#draft-decomposition-workspace').classList.toggle('hidden', !hasUnits);
  if (hasUnits) {
    renderDraftPreview(session.draft || '', session.units || []);
    renderDraftUnits(session.units || []);
  }
  renderDraftAnnotations(session);
  renderDraftEvents(session.events || []);
  const busy = ['analyzing', 'clarifying', 'decomposing', 'retrieving', 'aligning', 'chatting'].includes(session.status);
  $('#draft-confirm-btn').disabled = session.status !== 'awaiting_confirmation';
  setDraftRetrievalLocked(session.status !== 'awaiting_confirmation');
  $('#draft-chat-panel').classList.toggle('hidden', !['completed', 'error'].includes(session.status));
  const statusHints = {
    awaiting_clarification: '分析模型需要你确认一些信息。请逐项回答或补充纠正。',
    awaiting_understanding_confirmation: '分析模型认为信息已经足够。请核对理解,确认后诊断薄弱描写。',
    awaiting_confirmation: '请检查诊断结果,可修改薄弱原因、场景概括、丰富目标和检索语句后确认。',
    completed: '薄弱描写与范本学习建议已生成,可以继续提出要求。',
  };
  $('#draft-hint').textContent = statusHints[session.status] || (busy ? '分析模型正在处理…' : `会话状态:${session.status}`);
  if (window.renderWorkspaceContext) window.renderWorkspaceContext(session.knowledge_context || {}, session.project_id || '');
}

async function analyzeDraft() {
  const draft = $('#draft-input').value.trim();
  const supplementalInfo = $('#draft-supplement').value.trim();
  if (!draft) { $('#draft-hint').textContent = '⚠️ 请先粘贴原稿'; return; }
  const btn = $('#draft-analyze-btn');
  btn.disabled = true; btn.textContent = '理解中…';
  $('#draft-hint').textContent = '分析模型正在理解原稿和补充信息…';
  try {
    const workspaceContext = window.workspaceDraftContext ? window.workspaceDraftContext() : {};
    const r = await fetch('/api/draft/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft, supplemental_info: supplementalInfo,
        ...workspaceContext, reference_ids: selectedReferenceIds() }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || '原稿分析失败');
    renderDraftSession(d);
  } catch (e) {
    $('#draft-hint').textContent = `❌ ${e.message}`;
  } finally {
    btn.disabled = false; btn.textContent = '分析原稿并确认理解';
  }
}

async function clarifyDraftUnderstanding() {
  if (!draftSession) return;
  const answers = [...document.querySelectorAll('.draft-question')].map(el => ({
    id: el.dataset.id,
    question: el.querySelector('.draft-question-title').textContent.replace(/^\d+\.\s*/, '').trim(),
    answer: el.querySelector('.draft-question-answer').value.trim(),
  }));
  const correction = $('#draft-correction').value.trim();
  if (!correction && !answers.some(item => item.answer)) {
    $('#draft-hint').textContent = '⚠️ 请回答问题或填写补充纠正';
    return;
  }
  const btn = $('#draft-clarify-btn');
  btn.disabled = true; btn.textContent = '更新理解中…';
  $('#draft-hint').textContent = '分析模型正在根据你的回答更新理解…';
  try {
    const r = await fetch(`/api/draft/${draftSession.id}/clarify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers, correction }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || '更新理解失败');
    renderDraftSession(d);
  } catch (e) {
    $('#draft-hint').textContent = `❌ ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function decomposeConfirmedDraft() {
  if (!draftSession || !$('#draft-understanding-confirm').checked) return;
  const btn = $('#draft-decompose-btn');
  btn.disabled = true; btn.textContent = '诊断中…';
  $('#draft-hint').textContent = '理解已确认,分析模型正在诊断最值得加强的描写…';
  try {
    const r = await fetch(`/api/draft/${draftSession.id}/decompose`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || '薄弱描写诊断失败');
    renderDraftSession(d);
  } catch (e) {
    $('#draft-hint').textContent = `❌ ${e.message}`;
  } finally {
    btn.textContent = '确认理解并诊断薄弱描写';
    btn.disabled = !$('#draft-understanding-confirm').checked;
  }
}

async function confirmDraftUnits() {
  if (!draftSession) return;
  const units = collectDraftUnits();
  const btn = $('#draft-confirm-btn');
  const progress = $('#draft-progress');
  btn.disabled = true; btn.textContent = '查询中…';
  progress.classList.remove('hidden');
  setProgress('draft-bar', 'draft-progress-text', 0, 0, '准备查询范本…');
  try {
    const r = await fetch(`/api/draft/${draftSession.id}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        units,
        retrieval_mode: $('#draft-retrieval-mode').value,
        retrieval_params: draftRetrievalParams(),
        reference_ids: selectedReferenceIds(),
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || '启动原稿查询失败');
    const p = await pollProgress(d.task_id, 'draft-bar', 'draft-progress-text');
    renderDraftSession(p.result);
  } catch (e) {
    $('#draft-hint').textContent = `❌ ${e.message}`;
  } finally {
    progress.classList.add('hidden');
    btn.disabled = false; btn.textContent = '确认诊断并查询范本';
  }
}

async function sendDraftChat() {
  if (!draftSession) return;
  const input = $('#draft-chat-input');
  const message = input.value.trim();
  if (!message) return;
  const btn = $('#draft-chat-send');
  const progress = $('#draft-progress');
  btn.disabled = true; btn.textContent = '处理中…';
  progress.classList.remove('hidden');
  setProgress('draft-bar', 'draft-progress-text', 0, 0, '分析模型正在理解新要求…');
  try {
    const r = await fetch(`/api/draft/${draftSession.id}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || '发送失败');
    input.value = '';
    const p = await pollProgress(d.task_id, 'draft-bar', 'draft-progress-text');
    renderDraftSession(p.result);
  } catch (e) {
    $('#draft-hint').textContent = `❌ ${e.message}`;
  } finally {
    progress.classList.add('hidden');
    btn.disabled = false; btn.textContent = '发送';
  }
}

function resetDraftSession() {
  draftSession = null;
  draftExport = null;
  $('#draft-input').disabled = false;
  $('#draft-supplement').disabled = false;
  $('#draft-input').value = '';
  $('#draft-supplement').value = '';
  $('#draft-workspace').classList.add('hidden');
  $('#draft-understanding-panel').classList.add('hidden');
  $('#draft-decomposition-workspace').classList.add('hidden');
  $('#draft-new-btn').classList.add('hidden');
  $('#draft-analyze-btn').classList.remove('hidden');
  $('#draft-hint').textContent = '';
  setDraftRetrievalLocked(false);
  if (currentMode === 'draft') {
    const box = $('#results');
    box.classList.add('empty');
    box.innerHTML = '还没有薄弱描写诊断结果。先分析原稿、确认需要加强的位置并查询范本。';
    lastExport = null;
    setExportEnabled(false);
  }
}

async function refreshStatus() {
  const el = $('#status');
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    currentWork = d.active_name || '';
    if (d.indexed) {
      el.innerHTML = `<span style="color:var(--ok)">●</span> 已加载 <b>${esc(d.active_name)}</b>(<b>${d.chunks}</b> 块)`;
    } else if (d.index_error) {
      el.innerHTML = `<span style="color:var(--warn)">●</span> 索引不可用：${esc(d.index_error)}`;
    } else {
      el.innerHTML = `<span style="color:var(--warn)">●</span> 尚未加载作品`;
    }
    el.innerHTML += d.embed_provider === 'openai'
      ? ' · Embedding：兼容 API（连接结果以实际检索为准）'
      : ` · Embedding：Ollama 协议（${d.ollama ? '在线' : '<span class="warn">未连接</span>'}）`;
    if (d.hybrid && d.hybrid.enabled) {
      const hybridReady = d.hybrid.installed && d.hybrid.model_ready;
      el.innerHTML += ` · 混合精排 ${hybridReady ? '<span style="color:var(--ok)">可用</span>' : '<span class="warn">未就绪</span>'}`;
    }
    if (d.embed_provider !== 'openai' && !d.ollama) el.innerHTML += ' — <span class="warn">请检查向量服务地址和接口类型</span>';
    renderWorks(d.works || [], d.active);
  } catch (e) {
    el.innerHTML = '<span class="warn">⚠️ 无法连接后端服务</span>';
  }
}

function renderWorks(works, active) {
  const box = $('#works-list');
  if (!works || !works.length) {
    box.innerHTML = '<div class="empty-note">还没有已检索的作品。上传一个范本后,它会出现在这里,下次直接点击即可。</div>';
    return;
  }
  box.innerHTML = works.map(w => `
    <div class="work ${w.id === active ? 'active' : ''}">
      <label class="reference-check" title="加入本次多范本检索"><input type="checkbox" class="reference-select" data-id="${esc(w.id)}">参考</label>
      <div class="work-main">
        <span class="work-name">${esc(w.name)}</span>
        <span class="work-meta">${w.chunks} 块 · ${esc(w.created_at || '')}</span>
      </div>
      <div class="work-actions">
        ${w.id === active
          ? '<span class="active-badge">使用中</span>'
          : `<button class="ghost use-btn" data-id="${esc(w.id)}">使用</button>`}
        <button class="ghost danger del-btn" data-id="${esc(w.id)}">删除</button>
      </div>
    </div>`).join('');
  box.querySelectorAll('.use-btn').forEach(b => b.addEventListener('click', () => activate(b.dataset.id)));
  box.querySelectorAll('.del-btn').forEach(b => b.addEventListener('click', () => removeWork(b.dataset.id)));
  if (window.restoreReferenceSelection) window.restoreReferenceSelection();
}

function selectedReferenceIds() {
  return [...document.querySelectorAll('.reference-select:checked')].map(el => el.dataset.id).filter(Boolean);
}

async function activate(id) {
  try {
    const r = await fetch('/api/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || '切换失败');
    await refreshStatus();
    $('#search-hint').textContent = `已切换到「${d.name}」,可以开始检索`;
  } catch (e) {
    $('#search-hint').textContent = `❌ ${e.message}`;
  }
}

async function removeWork(id) {
  if (!confirm('确定删除这个已检索的作品吗?(会删除其本地索引)')) return;
  try {
    const r = await fetch(`/api/works/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || '删除失败');
    await refreshStatus();
  } catch (e) {
    $('#search-hint').textContent = `❌ ${e.message}`;
  }
}

// —— 上传 ——
const drop = $('#drop');
const fileInput = $('#file');
let indexTaskId = null;
let indexUploadBusy = false;
let uploadPollingFailed = false;
let indexTerminal = null;
function resetIndexUpload() {
  indexTaskId = null;
  indexUploadBusy = false;
  fileInput.disabled = false;
  fileInput.value = '';
  stopIndexBtn.classList.add('hidden');
}
const stopIndexBtn = $('#stop-index-btn');
stopIndexBtn.addEventListener('click', async () => {
  const taskId = indexTaskId;
  if (!taskId) return;
  stopIndexBtn.disabled = true;
  stopIndexBtn.textContent = '正在停止…';
  $('#stop-index-error').textContent = '';
  try {
    const r = await fetch(`/api/index/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' });
    const p = await r.json();
    if (!r.ok) throw new Error(p.detail || '停止失败');
    if (indexTaskId === taskId && ['cancelled', 'done', 'error'].includes(p.status)) {
      indexTerminal = p;
      $('#upload-text').textContent = p.error || p.message;
      $('#upload-bar').classList.remove('indeterminate');
      // 正常轮询负责解锁；轮询已失败时由停止响应恢复上传入口。
      if (uploadPollingFailed) resetIndexUpload();
    }
  } catch (e) {
    if (indexTaskId === taskId) {
      $('#stop-index-error').textContent = `停止失败：${e.message}，请重试`;
      stopIndexBtn.disabled = false;
      stopIndexBtn.textContent = '停止向量化';
    }
  }
});
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  if (e.dataTransfer.files.length) upload(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) upload(fileInput.files[0]);
});

async function upload(file) {
  if (indexUploadBusy) return;
  indexUploadBusy = true;
  uploadPollingFailed = false;
  indexTerminal = null;
  fileInput.disabled = true;
  $('#stop-index-error').textContent = '';
  const prog = $('#upload-progress');
  prog.classList.remove('hidden');
  setProgress('upload-bar', 'upload-text', 0, 0, `⏳ 正在分块并向量化「${file.name}」…`);
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await fetch('/api/index', { method: 'POST', body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || '上传失败');
    indexTaskId = d.task_id;
    stopIndexBtn.disabled = false;
    stopIndexBtn.textContent = '停止向量化';
    stopIndexBtn.classList.remove('hidden');
    const p = await pollProgress(d.task_id, 'upload-bar', 'upload-text');
    indexTerminal = p;
    if (p.status === 'cancelled') return;
    const res = p.result || {};
    $('#upload-text').textContent = `✅ 完成:「${d.name}」${res.chunks ?? ''} 个分块已建索引`;
    await refreshStatus();
  } catch (e) {
    setProgress('upload-bar', 'upload-text', 0, 0, `❌ 失败:${e.message}`);
    if (e.taskFinished) indexTaskId = null;
    // 状态查询失败时仍保留停止入口，避免遗留无法控制的后台任务。
    if (indexTaskId && !indexTerminal) { uploadPollingFailed = true; return; }
  } finally {
    $('#upload-bar').classList.remove('indeterminate');
    if (!uploadPollingFailed) resetIndexUpload();
  }
}

// —— AI 扩写(多版本,可选中/编辑)——
async function doExpand() {
  const q = $('#query').value.trim();
  if (!q) { $('#search-hint').textContent = '⚠️ 请先输入场景描述'; return; }
  const btn = $('#expand-btn');
  btn.disabled = true; btn.textContent = '扩写中…';
  $('#search-hint').textContent = 'AI 扩写中…';
  try {
    const r = await fetch('/api/expand', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, n: 3 }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || '扩写失败');
    renderExpandVersions(d.versions || []);
    $('#search-hint').textContent = `已生成 ${d.versions.length} 个扩写版本,可选中并修改后再检索`;
  } catch (e) {
    $('#search-hint').textContent = `❌ ${e.message}`;
  } finally {
    btn.disabled = false; btn.textContent = 'AI 扩写(×3)';
  }
}

function renderExpandVersions(versions) {
  const box = $('#expand-versions');
  if (!versions.length) {
    $('#expand-box').classList.add('hidden');
    return;
  }
  $('#expand-box').classList.remove('hidden');
  box.innerHTML = versions.map((v, i) => `
    <div class="expand-version ${i === 0 ? 'selected' : ''}">
      <label class="ev-head">
        <input type="radio" name="expand-ver" value="${i}" ${i === 0 ? 'checked' : ''}>
        <span>版本 ${i + 1}</span>
      </label>
      <textarea class="ev-text" rows="4">${esc(v)}</textarea>
    </div>`).join('');
  box.querySelectorAll('input[name="expand-ver"]').forEach(radio => {
    radio.addEventListener('change', () => {
      box.querySelectorAll('.expand-version').forEach(el => el.classList.remove('selected'));
      radio.closest('.expand-version').classList.add('selected');
    });
  });
}

function selectedExpanded() {
  if ($('#expand-box').classList.contains('hidden')) return '';
  const radio = document.querySelector('input[name="expand-ver"]:checked');
  if (!radio) return '';
  const ta = radio.closest('.expand-version').querySelector('.ev-text');
  return ta ? ta.value.trim() : '';
}

function clearExpandVersions() {
  $('#expand-versions').innerHTML = '';
  $('#expand-box').classList.add('hidden');
}

function clearDeepQueryVersions() {
  $('#deep-versions').innerHTML = '';
  $('#deep-query-box').classList.add('hidden');
}

function resetDeepSearchState() {
  deepHistory = [];
  deepTried = [];
  deepLastBest = null;
  clearDeepQueryVersions();
  renderDeepHistory();
}

function selectedSearchQuery() {
  const original = $('#query').value.trim();
  if ($('#query-optimize-box').classList.contains('hidden')) return original;
  return $('#optimized-query').value.trim() || original;
}

function disableOptimizedQuery(showMessage = true) {
  $('#query-optimize-box').classList.add('hidden');
  $('#optimized-query').value = '';
  $('#query-optimize-summary').textContent = '';
  clearExpandVersions();
  resetDeepSearchState();
  if (showMessage) $('#search-hint').textContent = '已停用查询优化，将直接使用原始写作要求检索';
}

async function optimizeQuery() {
  const q = $('#query').value.trim();
  if (!q) { $('#search-hint').textContent = '⚠️ 请先输入场景描述'; return; }
  const btn = $('#optimize-query-btn');
  btn.disabled = true; btn.textContent = '优化中…';
  $('#search-hint').textContent = 'AI 正在整理检索内容…';
  try {
    const r = await fetch('/api/query/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || '查询优化失败');
    clearExpandVersions();
    $('#optimized-query').value = d.optimized_query || q;
    $('#query-optimize-summary').textContent = d.summary ? `优化重点：${d.summary}` : '';
    $('#query-optimize-box').classList.remove('hidden');
    resetDeepSearchState();
    $('#search-hint').textContent = '已启用优化内容；你可以修改上方文本后再检索';
  } catch (e) {
    $('#search-hint').textContent = `❌ ${e.message}`;
  } finally {
    btn.disabled = false; btn.textContent = 'AI 优化检索内容';
  }
}

// —— 检索(本地秒出 + 后台 AI 精读)——
async function search() {
  const q = $('#query').value.trim();
  if (!q) { $('#search-hint').textContent = '⚠️ 请先输入场景描述'; return; }
  const btn = $('#search-btn');
  const hint = $('#search-hint');
  const topK = parseInt($('#topk').value, 10) || 3;
  const recallK = parseInt($('#recallk').value, 10) || 24;
  const rerankK = parseInt($('#rerankk').value, 10) || 8;
  const searchQuery = selectedSearchQuery();
  const expandedQuery = selectedExpanded();

  btn.disabled = true; btn.textContent = '检索中…';
  hint.textContent = '检索中…';
  $('#hyde-note').classList.add('hidden');

  let d;
  try {
    const r = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, search_query: searchQuery, top_k: topK,
        recall_k: recallK, rerank_k: rerankK, expanded: expandedQuery,
        reference_ids: selectedReferenceIds() }),
    });
    d = await r.json();
    if (!r.ok) throw new Error(d.detail || '检索失败');
  } catch (e) {
    hint.textContent = `❌ ${e.message}`;
    render(null);
    btn.disabled = false; btn.textContent = '检索片段';
    return;
  }

  render(d);
  btn.disabled = false; btn.textContent = '检索片段';
  hint.textContent = `${d.hybrid_used ? 'BGE-M3 混合精排 · ' : (d.hybrid_error ? '混合精排已回退 · ' : '')}命中 ${d.count} 个片段 · AI 精读中…`;
  lastExport = { query: q, search_query: searchQuery, expanded: expandedQuery, results: d.results, work: currentWork, recall_k: recallK, rerank_k: rerankK, top_k: topK, mode: 'local' };
  regularExport = lastExport;
  setExportEnabled(true);

  const sp = $('#search-progress');
  sp.classList.remove('hidden');
  setProgress('search-bar', 'search-text', 0, 0, 'AI 精读中(扩写/精选)…');

  try {
    const ar = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, search_query: searchQuery, top_k: topK,
        recall_k: recallK, rerank_k: rerankK, expanded: expandedQuery,
        retrieval_id: d.retrieval_id || '', reference_ids: selectedReferenceIds() }),
    });
    const ad = await ar.json();
    if (ar.ok) {
      render(ad);
      $('#hyde-text').textContent = ad.expanded || '';
      const hl = $('#hyde-label');
      if (hl) hl.textContent = ad.mode === 'instruction' ? '🔍 查询指令:' : '🔍 扩写检索词:';
      $('#hyde-note').classList.remove('hidden');
      hint.textContent = `${ad.hybrid_used ? 'BGE-M3 混合精排 + ' : (ad.hybrid_error ? '混合精排已回退 · ' : '')}AI 精读完成 · 精选 ${ad.count} 段`;
      lastExport = { query: q, search_query: searchQuery, expanded: ad.expanded || '', results: ad.results, work: currentWork, recall_k: recallK, rerank_k: rerankK, top_k: topK, mode: ad.mode || 'local' };
      regularExport = lastExport;
      setExportEnabled(true);
    } else {
      hint.textContent = `命中 ${d.count} 个片段 · ${ad.detail || 'AI 精读未启用'}`;
    }
  } catch (e) {
    hint.textContent = `命中 ${d.count} 个片段 · AI 精读失败(${e.message})`;
  } finally {
    sp.classList.add('hidden');
  }
}

function render(d) {
  const box = $('#results');
  if (!d || !d.results.length) {
    box.classList.add('empty');
    box.innerHTML = '没有结果。';
    return;
  }
  box.classList.remove('empty');
  box.innerHTML = d.results.map((r, i) => `
    <article class="result">
      <div class="meta">
        <span class="rank">#${i + 1}</span>
        ${r.work_name ? `<span class="work-source">《${esc(r.work_name)}》</span>` : ''}
        <span class="chapter">${esc(r.chapter)}</span>
        <span class="score">${r.hybrid_scores ? '混合分' : '向量分'} ${(r.score * 100).toFixed(1)}%</span>
        ${r.hybrid_scores ? `<span title="dense / sparse / ColBERT">D ${(r.hybrid_scores.dense * 100).toFixed(1)} · S ${(r.hybrid_scores.sparse * 100).toFixed(1)} · C ${(r.hybrid_scores.colbert * 100).toFixed(1)}</span>` : ''}
        <span>段落 ${r.para_start + 1}–${r.para_end + 1}</span>
      </div>
      <pre class="text">${renderHighlighted(r.text, r.spans)}</pre>
      ${renderNotes(r)}
    </article>`).join('');
}

function renderNotes(r) {
  const matches = (r.spans || []).filter(s => s.reason).map(s =>
    `<li><span class="quote">「${esc(s.quote)}」</span> — ${esc(s.reason)}</li>`).join('');
  if (!matches && !r.technique && !r.imitation_tip) return '';
  let html = '<div class="ai-notes">';
  if (matches) html += `<div class="ai-matches"><span class="ai-label">🎯 匹配理由</span><ul>${matches}</ul></div>`;
  if (r.technique) html += `<div class="ai-item"><span class="ai-label">✍️ 技法</span>${esc(r.technique)}</div>`;
  if (r.imitation_tip) html += `<div class="ai-item"><span class="ai-label">💡 仿写建议</span>${esc(r.imitation_tip)}</div>`;
  html += '</div>';
  return html;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderHighlighted(text, spans) {
  if (!spans || !spans.length) return esc(text);
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let html = '';
  let last = 0;
  for (const s of sorted) {
    if (s.start < last || s.end <= s.start) continue;
    html += esc(text.slice(last, s.start));
    html += '<mark>' + esc(text.slice(s.start, s.end)) + '</mark>';
    last = s.end;
  }
  html += esc(text.slice(last));
  return html;
}

// —— 精细检索(迭代式:LLM 判断相关性 + 伪相关反馈)——
async function refine() {
  const q = $('#query').value.trim();
  if (!q) { $('#search-hint').textContent = '⚠️ 请先输入场景描述'; return; }
  const btn = $('#search-btn');
  const hint = $('#search-hint');
  const topK = parseInt($('#r-topk').value, 10) || 3;
  const recallK = parseInt($('#r-recallk').value, 10) || 50;
  const rounds = parseInt($('#rounds').value, 10) || 2;
  const batchK = parseInt($('#batchk').value, 10) || 5;
  const judgeChars = parseInt($('#judgechars').value, 10) || 400;
  const searchQuery = selectedSearchQuery();

  btn.disabled = true; btn.textContent = '精细检索中…';
  hint.textContent = '';
  const sp = $('#search-progress');
  sp.classList.remove('hidden');
  setProgress('search-bar', 'search-text', 0, rounds, '迭代检索准备中…');
  $('#hyde-note').classList.add('hidden');

  try {
    const r = await fetch('/api/refine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, search_query: searchQuery, recall_k: recallK, rounds, batch_size: batchK, top_k: topK, judge_chars: judgeChars, reference_ids: selectedReferenceIds() }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || '精细检索失败');
    const p = await pollProgress(d.task_id, 'search-bar', 'search-text');
    const ad = p.result;
    render(ad);
    const hl = $('#hyde-label');
    if (hl) hl.textContent = '🔍 检索方式:';
    $('#hyde-text').textContent = `查询:「${ad.search_query || searchQuery}」· 强相关 ${ad.confirmed} 段 · 弱相关 ${ad.weak ?? 0} 段 · ${ad.rounds} 轮`;
    $('#hyde-note').classList.remove('hidden');
    hint.textContent = `${ad.hybrid_used ? 'BGE-M3 混合精排 + ' : (ad.hybrid_error ? '混合精排已回退 · ' : '')}精细检索完成 · 确认 ${ad.confirmed} 段 · 精选 ${ad.count} 段`;
    lastExport = { query: q, search_query: searchQuery, expanded: '', results: ad.results, work: currentWork, recall_k: recallK, rerank_k: '-', top_k: topK, mode: 'iterative', rounds: ad.rounds, confirmed: ad.confirmed, weak: ad.weak ?? 0 };
    regularExport = lastExport;
    setExportEnabled(true);
  } catch (e) {
    hint.textContent = `❌ ${e.message}`;
    render(null);
  } finally {
    sp.classList.add('hidden');
    btn.disabled = false; btn.textContent = '精细检索';
  }
}

// —— 深度迭代(LLM 查询改写 + 裁判,人工/自动双驱动)——
function deepEnsureQ0() {
  const q0 = $('#query').value.trim();
  if (q0 !== deepQ0) {
    deepQ0 = q0;
    deepHistory = [];
    deepTried = [];
    deepLastBest = null;
    clearDeepQueryVersions();
  }
  return q0;
}

function currentDeepQuery() {
  const q0 = $('#query').value.trim();
  const selected = $('#deep-query-box').classList.contains('hidden')
    ? null : document.querySelector('#deep-versions input[name="deep-ver"]:checked');
  if (selected) {
    const ta = selected.closest('.deep-version').querySelector('.ev-text');
    const v = ta ? ta.value.trim() : '';
    if (v) return v;
  }
  return selectedSearchQuery() || q0;
}

function renderDeepQueries(queries) {
  const box = $('#deep-versions');
  if (!queries.length) {
    $('#deep-query-box').classList.add('hidden');
    return;
  }
  $('#deep-query-box').classList.remove('hidden');
  box.innerHTML = queries.map((v, i) => `
    <div class="expand-version ${i === 0 ? 'selected' : ''}">
      <label class="ev-head">
        <input type="radio" name="deep-ver" value="${i}" ${i === 0 ? 'checked' : ''}>
        <span>查询 ${i + 1}</span>
      </label>
      <textarea class="ev-text" rows="3">${esc(v)}</textarea>
      <div class="ev-actions">
        <button type="button" class="ghost deep-round-btn">🔍 用这条检索</button>
      </div>
    </div>`).join('');
  box.querySelectorAll('input[name="deep-ver"]').forEach(radio => {
    radio.addEventListener('change', () => {
      box.querySelectorAll('.expand-version').forEach(el => el.classList.remove('selected'));
      radio.closest('.expand-version').classList.add('selected');
    });
  });
  box.querySelectorAll('.deep-round-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ta = btn.closest('.expand-version').querySelector('.ev-text');
      deepRound(ta ? ta.value.trim() : '');
    });
  });
}

function renderDeepHistory() {
  const box = $('#deep-history');
  if (!box) return;
  if (currentMode !== 'deep' || !deepHistory.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '<div class="deep-history-title">🧭 历史迭代记录</div>' +
    deepHistory.map(h => `
      <div class="deep-history-item">
        <span class="dh-round">第 ${h.round} 轮</span>
        <div class="dh-query">查询:${esc(h.query)}</div>
        <div class="dh-meta">找到 ${h.new} 段${h.best_chapter ? ` · 最佳《${esc(h.best_chapter)}》` : ''}${h.reason ? ` · ${esc(h.reason)}` : ''}${h.improved === true ? ' <span class="improved">✅ 有改进</span>' : (h.improved === false ? ' <span class="notimproved">⏸ 无改进</span>' : '')}</div>
      </div>`).join('');
}

async function deepRound(explicitQuery) {
  const q0 = deepEnsureQ0();
  if (!q0) { $('#search-hint').textContent = '⚠️ 请先输入场景描述'; return; }
  const searchQuery = (typeof explicitQuery === 'string' ? explicitQuery.trim() : '') || currentDeepQuery() || q0;
  const topK = parseInt($('#d-topk').value, 10) || 3;
  const recallK = parseInt($('#d-recallk').value, 10) || 50;
  const batchK = parseInt($('#d-batchk').value, 10) || 5;
  const judgeChars = parseInt($('#d-judgechars').value, 10) || 400;

  const btn = $('#deep-search-btn');
  btn.disabled = true; btn.textContent = '检索中…';
  $('#search-hint').textContent = '深度检索中…';
  $('#hyde-note').classList.add('hidden');

  try {
    const r = await fetch('/api/deep_round', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q0, search_query: searchQuery, recall_k: recallK, batch_size: batchK, top_k: topK, judge_chars: judgeChars, reference_ids: selectedReferenceIds() }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || '检索失败');
    render(d);
    deepHistory.push({
      round: deepHistory.length + 1,
      query: searchQuery,
      new: d.confirmed,
      best_chapter: d.best ? d.best.chapter : (d.results[0] ? d.results[0].chapter : ''),
    });
    if (d.best) deepLastBest = d.best;
    if (searchQuery && !deepTried.includes(searchQuery)) deepTried.push(searchQuery);
    renderDeepHistory();
    const hl = $('#hyde-label'); if (hl) hl.textContent = '🧭 深度检索:';
    $('#hyde-text').textContent = `查询:「${searchQuery}」· 确认 ${d.confirmed} 段`;
    $('#hyde-note').classList.remove('hidden');
    $('#search-hint').textContent = `深度检索完成 · 确认 ${d.confirmed} 段 · 精选 ${d.count} 段`;
    const retryValue = parseInt($('#d-retry').value, 10);
    lastExport = { query: q0, search_query: searchQuery, results: d.results, work: currentWork, recall_k: recallK, top_k: topK, mode: 'deep', rounds: deepHistory.length, confirmed: d.confirmed, history: deepHistory, batch_size: batchK, judge_chars: judgeChars, variants: parseInt($('#d-variants').value, 10) || 3, retry_count: Number.isNaN(retryValue) ? 1 : retryValue };
    regularExport = lastExport;
    setExportEnabled(true);
  } catch (e) {
    $('#search-hint').textContent = `❌ ${e.message}`;
    render(null);
  } finally {
    btn.disabled = false; btn.textContent = '检索';
  }
}

async function deepRewrite() {
  const q0 = deepEnsureQ0();
  if (!q0) { $('#search-hint').textContent = '⚠️ 请先输入场景描述'; return; }
  const btn = $('#deep-rewrite-btn');
  const n = parseInt($('#d-variants').value, 10) || 3;
  btn.disabled = true; btn.textContent = '改写中…';
  $('#search-hint').textContent = 'AI 改写查询中…';
  try {
    const r = await fetch('/api/deep_rewrite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q0, best_text: deepLastBest ? deepLastBest.text : '', best_chapter: deepLastBest ? deepLastBest.chapter : '', tried: deepTried, n }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || '改写失败');
    renderDeepQueries(d.queries || []);
    $('#search-hint').textContent = (d.queries && d.queries.length) ? `已生成 ${d.queries.length} 个改写查询,可选中并修改后再检索` : '未生成有效改写查询,请重试';
  } catch (e) {
    $('#search-hint').textContent = `❌ ${e.message}`;
  } finally {
    btn.disabled = false; btn.textContent = 'AI 改写查询';
  }
}

async function deepAuto() {
  const q0 = deepEnsureQ0();
  if (!q0) { $('#search-hint').textContent = '⚠️ 请先输入场景描述'; return; }
  const topK = parseInt($('#d-topk').value, 10) || 3;
  const recallK = parseInt($('#d-recallk').value, 10) || 50;
  const batchK = parseInt($('#d-batchk').value, 10) || 5;
  const judgeChars = parseInt($('#d-judgechars').value, 10) || 400;
  const variants = parseInt($('#d-variants').value, 10) || 3;
  const parsedRetryCount = parseInt($('#d-retry').value, 10);
  const retryCount = Number.isNaN(parsedRetryCount) ? 1 : parsedRetryCount;
  const searchQuery = selectedSearchQuery();

  const btn = $('#deep-auto-btn');
  btn.disabled = true; btn.textContent = '自动迭代中…';
  $('#deep-stop-btn').classList.remove('hidden');
  $('#search-hint').textContent = '自动深度迭代中…';
  const sp = $('#search-progress');
  sp.classList.remove('hidden');
  setProgress('search-bar', 'search-text', 0, 15, '深度迭代准备中…');
  $('#hyde-note').classList.add('hidden');

  try {
    const r = await fetch('/api/deep', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q0, search_query: searchQuery, recall_k: recallK, batch_size: batchK, top_k: topK, judge_chars: judgeChars, variants, retry_count: retryCount, reference_ids: selectedReferenceIds() }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || '深度迭代失败');
    deepTaskId = d.task_id;
    const p = await pollProgress(d.task_id, 'search-bar', 'search-text');
    const ad = p.result;
    render(ad);
    deepHistory = ad.history || [];
    deepTried = deepHistory.map(h => h.query).filter(Boolean);
    if (ad.best) deepLastBest = ad.best;
    renderDeepHistory();
    const hl = $('#hyde-label'); if (hl) hl.textContent = '🧭 深度迭代:';
    $('#hyde-text').textContent = `首轮查询:「${ad.search_query || searchQuery}」· 共 ${ad.rounds} 轮 · 确认 ${ad.confirmed} 段`;
    $('#hyde-note').classList.remove('hidden');
    $('#search-hint').textContent = `${ad.hybrid_used ? 'BGE-M3 混合精排 + ' : (ad.hybrid_error ? '混合精排已回退 · ' : '')}深度迭代完成 · ${ad.rounds} 轮 · 确认 ${ad.confirmed} 段 · 精选 ${ad.count} 段`;
    const lastQuery = deepHistory.length ? deepHistory[deepHistory.length - 1].query : q0;
    lastExport = { query: q0, search_query: lastQuery || searchQuery, results: ad.results, work: currentWork, recall_k: recallK, top_k: topK, mode: 'deep', rounds: ad.rounds, confirmed: ad.confirmed, history: deepHistory, batch_size: batchK, judge_chars: judgeChars, variants, retry_count: retryCount };
    regularExport = lastExport;
    setExportEnabled(true);
  } catch (e) {
    $('#search-hint').textContent = `❌ ${e.message}`;
    render(null);
  } finally {
    sp.classList.add('hidden');
    btn.disabled = false; btn.textContent = '自动迭代';
    $('#deep-stop-btn').classList.add('hidden');
    deepTaskId = null;
  }
}

$('#search-btn').addEventListener('click', () => {
  if (currentMode === 'refine') refine(); else search();
});
$('#optimize-query-btn').addEventListener('click', optimizeQuery);
$('#use-original-query-btn').addEventListener('click', () => disableOptimizedQuery(true));
$('#optimized-query').addEventListener('input', () => {
  clearExpandVersions();
  resetDeepSearchState();
});
$('#expand-btn').addEventListener('click', doExpand);
$('#mode-fast').addEventListener('click', () => setMode('fast'));
$('#mode-refine').addEventListener('click', () => setMode('refine'));
$('#mode-deep').addEventListener('click', () => setMode('deep'));
$('#mode-draft').addEventListener('click', () => setMode('draft'));
$('#deep-search-btn').addEventListener('click', () => deepRound());
$('#deep-rewrite-btn').addEventListener('click', deepRewrite);
$('#deep-auto-btn').addEventListener('click', deepAuto);
$('#draft-analyze-btn').addEventListener('click', analyzeDraft);
$('#draft-new-btn').addEventListener('click', resetDraftSession);
$('#draft-clarify-btn').addEventListener('click', clarifyDraftUnderstanding);
$('#draft-decompose-btn').addEventListener('click', decomposeConfirmedDraft);
$('#draft-understanding-confirm').addEventListener('change', (e) => {
  $('#draft-decompose-btn').disabled = !e.target.checked;
});
$('#draft-confirm-btn').addEventListener('click', confirmDraftUnits);
$('#draft-chat-send').addEventListener('click', sendDraftChat);
$('#draft-chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendDraftChat();
});
$('#deep-stop-btn').addEventListener('click', async () => {
  if (!deepTaskId) return;
  try {
    await fetch(`/api/deep_stop/${deepTaskId}`, { method: 'POST' });
    $('#search-hint').textContent = '已请求停止,当前轮结束后停止…';
  } catch (e) { /* ignore */ }
});
$('#query').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    if (currentMode === 'refine') refine();
    else if (currentMode === 'deep') deepRound();
    else search();
  }
});
$('#query').addEventListener('input', () => {
  clearExpandVersions();
  resetDeepSearchState();
  if (!$('#query-optimize-box').classList.contains('hidden')) disableOptimizedQuery(false);
});

// —— 导出 ——
function setExportEnabled(on) {
  $('#export-btn').disabled = !on;
  const saveButton = $('#save-result-project');
  if (saveButton) saveButton.disabled = !on;
}

window.currentSearchExport = () => lastExport;

function buildDraftMarkdown(data) {
  const session = data.session || {};
  const annotations = new Map((session.annotations || []).map(a => [String(a.unit_id), a]));
  const L = ['# 仿写辅助 · 原稿对照结果', ''];
  L.push(`- 范本作品:${data.work || '未命名'}`);
  L.push(`- 原稿分析模型:${data.analysis_model || '(复用主 LLM)'}`);
  L.push(`- 判断模型:${data.judge_model || '(复用主 LLM)'}`);
  L.push(`- Embedding:${data.embed_model || '-'}`);
  const retrievalConfig = session.retrieval_config || {};
  const retrievalName = { fast: '快速检索', refine: '精细检索', deep: '深度迭代' }[retrievalConfig.mode] || '-';
  L.push(`- 范本查询模式:${retrievalName}`);
  if (retrievalConfig.recall_k !== undefined) L.push(`- 召回段数:${retrievalConfig.recall_k}`);
  if (retrievalConfig.rerank_k !== undefined) L.push(`- 送 AI 段数:${retrievalConfig.rerank_k}`);
  if (retrievalConfig.rounds !== undefined) L.push(`- 迭代轮数:${retrievalConfig.rounds}`);
  if (retrievalConfig.batch_size !== undefined) L.push(`- 每批片段数:${retrievalConfig.batch_size}`);
  if (retrievalConfig.top_k !== undefined) L.push(`- 输出段数:${retrievalConfig.top_k}`);
  if (retrievalConfig.judge_chars !== undefined) L.push(`- 判断截断:${retrievalConfig.judge_chars}`);
  if (retrievalConfig.retry_count !== undefined) L.push(`- 无改进后重试:${retrievalConfig.retry_count}`);
  L.push(`- 会话编号:${session.id || '-'}`);
  L.push(`- 导出时间:${new Date().toLocaleString('zh-CN')}`);
  if (session.supplement) L.push('', '## 作者补充信息', '', session.supplement);
  if (session.clarification && session.clarification.understanding) {
    L.push('', '## 经用户确认的分析模型理解', '', session.clarification.understanding);
  }
  L.push('', '## 原稿', '', session.draft || '', '', '## 薄弱描写诊断与范本学习', '');
  (session.units || []).forEach((unit, index) => {
    const ann = annotations.get(String(unit.id)) || {};
    L.push(`### ${index + 1}. ${unit.id} · ${unit.enrichment_goal || unit.intent || '待丰富描写'}`, '');
    L.push('**原稿位置:**', '', unit.source_text || '', '');
    L.push(`**薄弱原因:** ${unit.weakness || unit.intent || '-'}`, '');
    L.push(`**前后场景:** ${unit.context_summary || unit.source_text || '-'}`, '');
    L.push(`**丰富目标:** ${unit.enrichment_goal || unit.intent || '-'}`, '');
    L.push(`**补充检索要求:** ${unit.query || '-'}`, '');
    L.push('> 实际检索会自动组合「前后场景 + 丰富目标 + 补充检索要求」。', '');
    if (ann.summary) L.push(`**丰富思路:** ${ann.summary}`, '');
    const refs = ann.references || [];
    if (!refs.length) {
      L.push('未找到足够贴合的范本片段。', '');
      return;
    }
    refs.forEach((ref, refIndex) => {
      L.push(`#### 范本 ${refIndex + 1} · ${ref.work_name ? `《${ref.work_name}》 · ` : ''}${ref.chapter || '未知章节'}`, '');
      if (ref.hybrid_scores) {
        L.push(`- **BGE-M3 混合分:** ${(ref.hybrid_scores.combined * 100).toFixed(1)}%（dense ${(ref.hybrid_scores.dense * 100).toFixed(1)} / sparse ${(ref.hybrid_scores.sparse * 100).toFixed(1)} / ColBERT ${(ref.hybrid_scores.colbert * 100).toFixed(1)}）`, '');
      }
      L.push(ref.text || '', '');
      if (ref.correspondence) L.push(`- **对应:** ${ref.correspondence}`);
      if (ref.what_to_learn) L.push(`- **借鉴:** ${ref.what_to_learn}`);
      if (ref.suggestion) L.push(`- **迁移:** ${ref.suggestion}`);
      L.push('');
    });
  });
  if ((session.events || []).length) {
    L.push('## 分析会话记录', '');
    session.events.forEach(e => L.push(`- **${e.role === 'user' ? '用户' : '分析模型'}:** ${e.content}`));
    L.push('');
  }
  return L.join('\n');
}

function buildMarkdown(data) {
  if (data.mode === 'draft') return buildDraftMarkdown(data);
  const L = [];
  L.push('# 仿写辅助 · 检索结果');
  L.push('');
  L.push(`- 范本作品:${data.work || '未命名'}`);
  L.push(`- 主 LLM:${data.model || '-'}`);
  L.push(`- 判断模型:${data.judge_model || '(复用主 LLM)'}`);
  L.push(`- Embedding:${data.embed_model || '-'}`);
  L.push(`- 导出时间:${new Date().toLocaleString('zh-CN')}`);
  L.push('');
  const modeText = { hyde: 'AI 扩写检索', instruction: '查询指令前缀', local: '本地向量检索', iterative: '迭代式检索(LLM 判断相关性)', deep: '深度迭代(查询改写 + 裁判)' }[data.mode] || '本地向量检索';
  const modeName = { hyde: '快速检索', instruction: '快速检索', local: '快速检索', iterative: '精细检索', deep: '深度迭代' }[data.mode] || '快速检索';
  L.push('## 检索参数');
  L.push('');
  L.push(`- 检索模式:${modeName}`);
  L.push(`- 召回段数:${data.recall_k ?? '-'}`);
  L.push(`- 送 AI 段数:${data.rerank_k ?? '-'}`);
  L.push(`- 输出段数:${data.top_k ?? '-'}`);
  if (data.mode === 'iterative') {
    L.push(`- 迭代轮数:${data.rounds ?? '-'}`);
    L.push(`- 确认相关(强相关):${data.confirmed ?? '-'} 段`);
    if (data.weak !== undefined && data.weak !== null) L.push(`- 弱相关种子:${data.weak} 段`);
  }
  if (data.mode === 'deep') {
    L.push(`- 每批片段数:${data.batch_size ?? '-'}`);
    L.push(`- 判断截断:${data.judge_chars ?? '-'}`);
    L.push(`- 改写版本数:${data.variants ?? '-'}`);
    L.push(`- 无更好结果后重试次数:${data.retry_count ?? '-'}`);
    L.push(`- 迭代轮数:${data.rounds ?? '-'}`);
    L.push(`- 确认相关:${data.confirmed ?? '-'} 段`);
  }
  L.push(`- 检索方式:${modeText}`);
  L.push('');
  L.push('## 原始输入');
  L.push('');
  L.push(data.query);
  L.push('');
  const expandedLabel = data.mode === 'deep' ? '最终检索查询' : '扩写检索词';
  L.push(`## ${expandedLabel}`);
  L.push('');
  L.push(data.search_query || data.expanded || '(无)');
  L.push('');
  if (data.mode === 'deep' && data.history && data.history.length) {
    L.push('## 历史迭代记录');
    L.push('');
    data.history.forEach(h => {
      L.push(`${h.round}. 第 ${h.round} 轮 · 查询:「${h.query}」`);
      let meta = `找到 ${h.new} 段`;
      if (h.best_chapter) meta += ` · 最佳《${h.best_chapter}》`;
      if (h.improved === true) meta += ' · ✅ 有改进';
      else if (h.improved === false) meta += ' · ⏸ 无改进';
      if (h.reason) meta += ` · ${h.reason}`;
      L.push(`   → ${meta}`);
      L.push('');
    });
  }
  L.push(`## 检索结果(共 ${data.results.length} 段)`);
  L.push('');
  data.results.forEach((r, i) => {
    L.push(`### ${i + 1}. ${r.work_name ? `《${r.work_name}》 · ` : ''}${r.chapter}(${r.hybrid_scores ? 'BGE-M3 混合分' : '向量分'} ${(r.score * 100).toFixed(1)}%)`);
    L.push('');
    if (r.hybrid_scores) {
      L.push(`- dense ${(r.hybrid_scores.dense * 100).toFixed(1)} / sparse ${(r.hybrid_scores.sparse * 100).toFixed(1)} / ColBERT ${(r.hybrid_scores.colbert * 100).toFixed(1)}`);
      L.push('');
    }
    L.push('**原文片段:**');
    L.push('');
    L.push(r.text);
    L.push('');
    const reasons = (r.spans || []).filter(s => s.reason);
    if (reasons.length) {
      L.push('**匹配理由:**');
      reasons.forEach(s => L.push(`- 「${s.quote}」— ${s.reason}`));
      L.push('');
    }
    if (r.technique) { L.push(`**技法:** ${r.technique}`); L.push(''); }
    if (r.imitation_tip) { L.push(`**仿写建议:** ${r.imitation_tip}`); L.push(''); }
  });
  return L.join('\n');
}

function exportResults() {
  if (!lastExport) return;
  const model = ($('#set-model') && $('#set-model').value.trim()) || '';
  const analysisModel = ($('#set-analysis-model') && $('#set-analysis-model').value.trim()) || '';
  const judgeModel = ($('#set-judge-model') && $('#set-judge-model').value.trim()) || '';
  const embedModel = ($('#set-embed-model') && $('#set-embed-model').value.trim()) || '';
  const content = buildMarkdown({ ...lastExport, model: model || '-', analysis_model: analysisModel, judge_model: judgeModel, embed_model: embedModel });
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  const work = (lastExport.work || '检索结果').replace(/[\\/:*?"<>|]/g, '');
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${lastExport.mode === 'draft' ? '原稿对照' : '仿写检索'}_${work}_${ts}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

$('#export-btn').addEventListener('click', exportResults);

// —— 设置(DeepSeek / 兼容 API)——
function showLlmResolution(d) {
  const sources = { own: '独立配置', main: '继承主 LLM', none: '未配置（免鉴权服务可留空）' };
  for (const role of ['analysis', 'judge']) {
    const hint = $(`#set-${role}-resolved`);
    const endpoint = d.resolved_llm?.[role];
    if (hint) hint.textContent = endpoint
      ? `当前已保存的生效配置：${endpoint.model || '未配置模型'} · ${endpoint.base_url || '未配置地址'} · 密钥：${sources[endpoint.key_source] || '未知'}`
      : '保存后可核对生效配置；若未显示，请重启服务并刷新页面。';
  }
}

async function loadSettings() {
  try {
    const r = await fetch('/api/settings');
    const d = await r.json();
    $('#set-key').value = d.api_key || '';
    showLlmResolution(d);
    $('#set-base').value = d.base_url || '';
    $('#set-model').value = d.model || '';
    $('#set-analysis-model').value = d.analysis_model || '';
    $('#set-analysis-base').value = d.analysis_base_url || '';
    $('#set-analysis-key').value = d.analysis_api_key || '';
    $('#set-analysis-context').value = d.analysis_context_tokens || '';
    $('#set-analysis-context-hint').textContent = `当前解析为 ${(Number(d.resolved_analysis_context_tokens) || 0).toLocaleString()} tokens；知识整理单批正文上限 ${(Number(d.knowledge_chapter_char_limit) || 30000).toLocaleString()} 字。`;
    $('#set-judge-model').value = d.judge_model || '';
    $('#set-judge-base').value = d.judge_base_url || '';
    $('#set-judge-key').value = d.judge_api_key || '';
    $('#set-embed-provider').value = d.embed_provider || 'auto';
    $('#set-embed-model').value = d.embed_model || '';
    $('#set-embed-base').value = d.embed_base_url || '';
    $('#set-embed-key').value = d.embed_api_key || '';
    // 恢复检索参数与模式
    if (d.fast_recall) $('#recallk').value = d.fast_recall;
    if (d.fast_rerank) $('#rerankk').value = d.fast_rerank;
    if (d.fast_topk) $('#topk').value = d.fast_topk;
    if (d.refine_recall) $('#r-recallk').value = d.refine_recall;
    if (d.refine_rounds) $('#rounds').value = d.refine_rounds;
    if (d.refine_batch) $('#batchk').value = d.refine_batch;
    if (d.refine_topk) $('#r-topk').value = d.refine_topk;
    if (d.refine_judge_chars) $('#judgechars').value = d.refine_judge_chars;
    if (d.deep_recall) $('#d-recallk').value = d.deep_recall;
    if (d.deep_batch) $('#d-batchk').value = d.deep_batch;
    if (d.deep_topk) $('#d-topk').value = d.deep_topk;
    if (d.deep_judge_chars) $('#d-judgechars').value = d.deep_judge_chars;
    if (d.deep_variants) $('#d-variants').value = d.deep_variants;
    if (d.deep_retry) $('#d-retry').value = d.deep_retry;
    draftParamPairs.forEach(([mainId, draftId]) => { $(draftId).value = $(mainId).value; });
    setDraftRetrievalMode(d.draft_retrieval_mode || 'fast');
    if (['refine', 'fast', 'deep', 'draft'].includes(d.mode)) setMode(d.mode);
  } catch (e) { /* 忽略 */ }
}

async function saveSettings() {
  const hint = $('#settings-hint');
  try {
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: $('#set-key').value.trim(),
        base_url: $('#set-base').value.trim(),
        model: $('#set-model').value.trim(),
        analysis_model: $('#set-analysis-model').value.trim(),
        analysis_base_url: $('#set-analysis-base').value.trim(),
        analysis_api_key: $('#set-analysis-key').value.trim(),
        analysis_context_tokens: $('#set-analysis-context').value.trim(),
        judge_model: $('#set-judge-model').value.trim(),
        judge_base_url: $('#set-judge-base').value.trim(),
        judge_api_key: $('#set-judge-key').value.trim(),
        embed_provider: $('#set-embed-provider').value,
        embed_model: $('#set-embed-model').value.trim(),
        embed_base_url: $('#set-embed-base').value.trim(),
        embed_api_key: $('#set-embed-key').value.trim(),
        mode: currentMode,
        draft_retrieval_mode: $('#draft-retrieval-mode').value,
        fast_recall: $('#recallk').value.trim(),
        fast_rerank: $('#rerankk').value.trim(),
        fast_topk: $('#topk').value.trim(),
        refine_recall: $('#r-recallk').value.trim(),
        refine_rounds: $('#rounds').value.trim(),
        refine_batch: $('#batchk').value.trim(),
        refine_topk: $('#r-topk').value.trim(),
        refine_judge_chars: $('#judgechars').value.trim(),
        deep_recall: $('#d-recallk').value.trim(),
        deep_batch: $('#d-batchk').value.trim(),
        deep_topk: $('#d-topk').value.trim(),
        deep_judge_chars: $('#d-judgechars').value.trim(),
        deep_variants: $('#d-variants').value.trim(),
        deep_retry: $('#d-retry').value.trim(),
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || '保存失败');
    hint.textContent = `✅ 已保存(model: ${esc(d.model)}${d.has_key ? ' · 已配置密钥' : ' · 未配置密钥'} · 知识正文单批上限 ${(Number(d.knowledge_chapter_char_limit) || 30000).toLocaleString()} 字)`;
    await loadSettings();
    await refreshStatus();
  } catch (e) {
    hint.textContent = `❌ ${e.message}`;
  }
}

$('#save-settings').addEventListener('click', saveSettings);
loadSettings();
refreshStatus();
