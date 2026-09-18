/* Prompt-only settings: never reads manuscript text, provider keys, or project data. */
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const state = { data: null, drafts: {}, busy: false, dirty: false, confirm: null };
  const status = text => { $('#prompt-status').textContent = text; };
  async function api(path, method = 'GET', body) {
    const response = await fetch(path, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '提示词操作失败，请重启后端并刷新');
    return data;
  }
  function changed() {
    state.dirty = !!state.data && (state.data.prompts.some(p => state.drafts[p.id] !== p.template) || $('#prompt-name').value !== state.data.presets.find(p => p.id === state.data.active_id).name);
    status(state.dirty ? '有未保存的修改；保存方案后才会影响新任务。' : `当前启用：${state.data?.presets.find(p => p.id === state.data.active_id)?.name || ''}`);
  }
  function confirmAction(message, action) {
    state.confirm = action;
    $('#prompt-confirm-text').textContent = message;
    $('#prompt-confirm').classList.remove('hidden');
    $('#prompt-confirm').scrollIntoView({ block: 'nearest' });
  }
  async function run(action) {
    if (state.busy) return;
    state.busy = true;
    $('#prompt-settings').querySelectorAll('button, input, select, textarea').forEach(el => el.disabled = true);
    try { await action(); }
    catch (error) { status(`❌ ${error.message}`); }
    finally {
      state.busy = false;
      $('#prompt-settings').querySelectorAll('button, input, select, textarea').forEach(el => el.disabled = false);
      $('#prompt-delete').disabled = !state.data || $('#prompt-preset').value === 'default';
    }
  }
  function filter() {
    const category = $('#prompt-category').value, query = $('#prompt-filter').value.trim().toLowerCase();
    $('#prompt-list').querySelectorAll('details[data-prompt]').forEach(el => {
      const p = state.data.prompts.find(item => item.id === el.dataset.prompt);
      el.classList.toggle('hidden', !!(category && p.category !== category) || !!(query && !`${p.title} ${p.usage} ${state.drafts[p.id]}`.toLowerCase().includes(query)));
    });
  }
  function render() {
    const data = state.data;
    $('#prompt-preset').innerHTML = data.presets.map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.id === data.active_id ? '（使用中）' : ''}</option>`).join('');
    $('#prompt-preset').value = data.active_id;
    $('#prompt-name').value = data.presets.find(p => p.id === data.active_id).name;
    const category = $('#prompt-category').value;
    $('#prompt-category').innerHTML = '<option value="">全部用途</option>' + [...new Set(data.prompts.map(p => p.category))].map(c => `<option>${esc(c)}</option>`).join('');
    $('#prompt-category').value = category;
    $('#prompt-list').innerHTML = data.prompts.map(p => `<details class="prompt-item" data-prompt="${esc(p.id)}">
      <summary>${esc(p.category)} · ${esc(p.title)} <small class="prompt-modified">${p.template === p.default ? '' : '已自定义'}</small></summary>
      <p class="hint">${esc(p.usage)}</p>
      ${Object.keys(p.variables).length ? `<p class="hint">自动变量：${Object.entries(p.variables).map(([k,v]) => `<code>{{${esc(k)}}}</code>：${esc(v)}`).join('；')}</p>` : '<p class="hint">此提示词没有自动变量。</p>'}
      <textarea rows="10" spellcheck="false" aria-label="${esc(p.title)}">${esc(p.template)}</textarea>
      <div class="row"><span class="prompt-validation hint"></span><button class="ghost prompt-reset">本条恢复默认</button></div>
      <details><summary>查看内置默认提示词</summary><pre class="prompt-default">${esc(p.default)}</pre></details>
    </details>`).join('');
    $('#prompt-list').querySelectorAll('details[data-prompt]').forEach(el => {
      const p = data.prompts.find(item => item.id === el.dataset.prompt);
      const textarea = el.querySelector('textarea');
      const edit = () => {
        state.drafts[p.id] = textarea.value;
        el.querySelector('.prompt-modified').textContent = textarea.value === p.default ? '' : '已自定义';
        const variables = [...new Set([...textarea.value.matchAll(/\{\{([a-zA-Z_][a-zA-Z_0-9]*)\}\}/g)].map(m => m[1]))].sort();
        el.querySelector('.prompt-validation').textContent = JSON.stringify(variables) === JSON.stringify(Object.keys(p.variables).sort()) ? '' : '变量名称有缺失或新增，请保留上方全部变量。';
        changed();
      };
      textarea.addEventListener('input', edit);
      el.querySelector('.prompt-reset').addEventListener('click', () => { textarea.value = p.default; edit(); });
    });
    filter(); changed();
  }
  async function load() {
    const data = await api('/api/prompts');
    state.data = data; state.drafts = Object.fromEntries(data.prompts.map(p => [p.id, p.template]));
    state.dirty = false; render();
  }
  async function save(copy) {
    if (!state.data) return;
    const id = copy || state.data.active_id === 'default' ? '' : state.data.active_id;
    const name = $('#prompt-name').value.trim();
    if (!id && name === '内置默认') { status('请先输入你的新方案名称。内置默认不会被覆盖。'); return; }
    const overrides = Object.fromEntries(state.data.prompts.filter(p => state.drafts[p.id] !== p.default).map(p => [p.id, state.drafts[p.id]]));
    await run(async () => { await api('/api/prompts/presets', 'POST', { name, overrides, preset_id: id }); await load(); status('方案已保存并启用，新任务将使用这套提示词。'); });
  }
  $('#prompt-save').addEventListener('click', () => save(false));
  $('#prompt-save-as').addEventListener('click', () => save(true));
  $('#prompt-switch').addEventListener('click', () => {
    const id = $('#prompt-preset').value;
    const action = () => run(async () => { await api(`/api/prompts/presets/${encodeURIComponent(id)}/activate`, 'POST'); await load(); });
    if (state.dirty) confirmAction('切换方案会放弃当前未保存的修改，是否继续？', action); else action();
  });
  $('#prompt-delete').addEventListener('click', () => {
    const id = $('#prompt-preset').value;
    const name = state.data?.presets.find(p => p.id === id)?.name;
    if (!id || id === 'default') return;
    confirmAction(`删除方案“${name}”？此操作不可撤销；当前未保存的编辑也会丢弃。不会删除正文或知识卡片。`, () => run(async () => { await api(`/api/prompts/presets/${encodeURIComponent(id)}`, 'DELETE'); await load(); }));
  });
  $('#prompt-preset').addEventListener('change', () => { $('#prompt-delete').disabled = $('#prompt-preset').value === 'default'; });
  $('#prompt-name').addEventListener('input', changed);
  $('#prompt-category').addEventListener('change', filter);
  $('#prompt-filter').addEventListener('input', filter);
  $('#prompt-reload').addEventListener('click', () => {
    if (state.dirty) confirmAction('重新加载将放弃未保存的编辑，是否继续？', () => run(load)); else run(load);
  });
  $('#prompt-reset-all').addEventListener('click', () => {
    if (!state.data) return;
    confirmAction('将编辑区的全部提示词恢复为内置默认？保存方案前不会影响实际调用。', () => {
      $('#prompt-list').querySelectorAll('details[data-prompt]').forEach(el => {
        el.querySelector('textarea').value = state.data.prompts.find(p => p.id === el.dataset.prompt).default;
        el.querySelector('textarea').dispatchEvent(new Event('input'));
      });
    });
  });
  $('#prompt-confirm-no').addEventListener('click', () => { state.confirm = null; $('#prompt-confirm').classList.add('hidden'); });
  $('#prompt-confirm-yes').addEventListener('click', () => { const action = state.confirm; state.confirm = null; $('#prompt-confirm').classList.add('hidden'); if (action) action(); });
  window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
  run(load);
})();
