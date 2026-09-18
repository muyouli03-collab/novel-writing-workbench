/* 剧情下的伏笔引用共享同一详情，不复制知识记录。 */
(() => {
  const q = s => document.querySelector(s);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const labels = { unknown: '未确认', open: '未回收', partial: '部分回收', resolved: '已回收' };
  const roles = { plant: '埋下', advance: '推进', resolve: '回收' };
  const cardTypes = { character: '人物', relationship: '关系', term: '名词', scene: '场景', world: '世界观', clue: '伏笔' };
  let projectId = '', plots = [], data = { clues: [], links: [], suggestions: [], jobs: [], chapters: [] }, watching = '';
  const dialog = document.createElement('dialog'); dialog.className = 'clue-dialog'; document.body.append(dialog);
  // Native dialogs keep their previous scroll position when their contents are replaced.
  // Closing on a backdrop click also gives every clue dialog an obvious escape route.
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  const base = () => `/api/projects/${projectId}/knowledge/clues`;
  async function api(path, method = 'GET', body) {
    const response = await fetch(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const value = await response.json(); if (!response.ok) throw new Error(value.detail || '操作失败'); return value;
  }
  function status(text) { q('#clue-operation-status').textContent = text; }
  async function perform(callback) {
    const buttons = [...dialog.querySelectorAll('button:not(:disabled)')];
    buttons.forEach(b => b.disabled = true);
    try { return await callback(); } catch (e) { status(`❌ ${e.message}`); const error = dialog.querySelector('.clue-dialog-error'); if (error) error.textContent = e.message; }
    finally { buttons.forEach(b => b.disabled = false); }
  }
  function shell(title, html) {
    dialog.innerHTML = `<div class="card-head"><h2>${esc(title)}</h2><button class="ghost clue-close">关闭</button></div><p class="hint clue-dialog-error" role="status"></p>${html}`;
    dialog.querySelector('.clue-close').onclick = () => dialog.close();
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
  }
  function options(values, selected) {
    return Object.entries(values).map(([id, label]) => `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(label)}</option>`).join('');
  }
  function chapterOptions(selected, all = false) {
    return (all ? '<option value="">全部章节</option>' : '<option value="">选择生效章节</option>') +
      data.chapters.map(c => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.title)}</option>`).join('');
  }
  function matchFilter(clue) {
    const statusFilter = q('#clue-status-filter').value;
    const query = q('#knowledge-global-search').value.trim().toLowerCase();
    const text = JSON.stringify([clue.title, clue.summary, clue.source_quotes, clue.clue_state]).toLowerCase();
    return (!statusFilter || clue.clue_state.status === statusFilter) && (!query || query.split(/\s+/).every(t => text.includes(t)));
  }
  function chip(clue, link) {
    return `<button class="ghost clue-chip" data-clue="${esc(clue.id)}">${link ? `${esc(roles[link.role])} · ` : ''}${esc(clue.title)} <small>${esc(labels[clue.clue_state.status])}</small>${link?.origin === 'auto' ? ' · 自动对应' : ''}${link?.stale ? ' · 待重新对应' : ''}</button>`;
  }
  function render() {
    const clueMap = new Map(data.clues.map(c => [c.id, c]));
    const unlinked = data.clues.filter(c => !data.links.some(l => l.clue_id === c.id && !l.stale));
    q('#unlinked-clue-count').textContent = `（${unlinked.length}）`;
    q('#unlinked-clues').innerHTML = unlinked.filter(matchFilter).map(c => chip(c)).join('') || '<p class="hint">没有符合筛选条件的待关联伏笔。</p>';
    q('#plot-index-list').querySelectorAll('.plot-index-entry').forEach(entry => {
      entry.querySelector('.plot-clues')?.remove();
      const links = data.links.filter(l => l.plot_id === entry.dataset.id && !l.stale && clueMap.has(l.clue_id));
      const visible = links.filter(l => matchFilter(clueMap.get(l.clue_id)));
      const panel = document.createElement('div'); panel.className = 'plot-clues';
      const open = visible.filter(l => clueMap.get(l.clue_id).clue_state.status !== 'resolved');
      const closed = visible.filter(l => clueMap.get(l.clue_id).clue_state.status === 'resolved');
      panel.innerHTML = `<div class="row"><strong>关联伏笔</strong><button class="ghost attach-clue" data-plot="${esc(entry.dataset.id)}">关联伏笔</button></div>` +
        open.map(l => chip(clueMap.get(l.clue_id), l)).join('') +
        (closed.length ? `<details><summary>已回收（${closed.length}）</summary>${closed.map(l => chip(clueMap.get(l.clue_id), l)).join('')}</details>` : '');
      entry.querySelector('.plot-index-content').append(panel);
      // 全局搜索也应能通过伏笔标题找到它所挂载的剧情。
      const query = q('#knowledge-global-search').value.trim().toLowerCase();
      const plot = plots.find(p => p.id === entry.dataset.id);
      const plotMatches = !query || query.split(/\s+/).every(t => JSON.stringify(plot || {}).toLowerCase().includes(t));
      entry.classList.toggle('hidden', (!plotMatches && !visible.length) || ((q('#clue-only-events').checked || q('#clue-status-filter').value) && !visible.length));
    });
    q('#clue-suggestions').innerHTML = data.suggestions.length ? '<h3>待确认的伏笔进展</h3>' + data.suggestions.map(s => `<article class="clue-suggestion"><strong>${esc(clueMap.get(s.clue_id)?.title || '原伏笔已失效')} → ${esc(labels[s.status])}</strong><p>${esc(s.explanation)}</p>${s.source_quotes.map(x => `<blockquote>${esc(x)}</blockquote>`).join('')}<div class="row"><button class="primary review-clue" data-suggestion="${esc(s.id)}">审阅并确认</button><button class="ghost dismiss-clue" data-suggestion="${esc(s.id)}">忽略</button></div></article>`).join('') : '';
    q('#clue-jobs').innerHTML = data.jobs.filter(j => j.status !== 'done').map(j => `<p class="hint">伏笔检查：${j.next_group}/${j.groups.length} 批 ${esc(j.error || '')} <button class="ghost resume-clue" data-job="${esc(j.id)}">继续上次检查</button></p>`).join('');
    document.querySelectorAll('[data-clue]').forEach(b => b.onclick = () => showClue(b.dataset.clue));
    document.querySelectorAll('.attach-clue').forEach(b => b.onclick = () => chooseLink('', b.dataset.plot));
    document.querySelectorAll('.review-clue').forEach(b => b.onclick = () => editState(data.suggestions.find(s => s.id === b.dataset.suggestion).clue_id, data.suggestions.find(s => s.id === b.dataset.suggestion)));
    document.querySelectorAll('.dismiss-clue').forEach(b => b.onclick = () => perform(async () => { await api(`${base()}/suggestions/${b.dataset.suggestion}/dismiss`, 'POST'); await refresh(); }));
    document.querySelectorAll('.resume-clue').forEach(b => b.onclick = () => startCheck(b.dataset.job));
  }
  async function refresh() {
    if (!projectId) return;
    const requested = projectId;
    const loaded = await api(base());
    if (requested !== projectId) return;
    data = loaded; render();
    if (data.active_task_id && watching !== data.active_task_id) watch(data.active_task_id);
  }
  function showClue(id) {
    const clue = data.clues.find(c => c.id === id); if (!clue) return;
    const links = data.links.filter(l => l.clue_id === id);
    shell(clue.title, `<p class="hint">伏笔 · ${esc(labels[clue.clue_state.status])}</p><label>类型<select id="clue-card-type">${options(cardTypes, 'clue')}</select></label><label>标题<input id="clue-title" value="${esc(clue.title)}" maxlength="300"></label><label>问题与内容<textarea id="clue-summary" rows="5">${esc(clue.summary)}</textarea></label><button class="ghost" id="clue-save-text">保存内容</button>
      ${clue.clue_state.explanation ? `<h3>当前进展</h3><p>${esc(clue.clue_state.explanation)}</p>` : ''}
      <div class="row"><button class="primary" id="clue-edit-state">编辑填坑状态</button><button class="ghost" id="clue-undo-state" ${clue.can_undo_state ? '' : 'disabled'}>撤销最近状态确认</button><button class="ghost" id="clue-attach-plot">关联剧情</button></div>
      <h3>关联事件</h3>${links.map(l => `<div class="clue-link-row"><button class="ghost jump-clue-plot" data-plot="${esc(l.plot_id)}" ${l.stale ? 'disabled' : ''}>${esc(roles[l.role])} · ${esc(plots.find(p => p.id === l.plot_id)?.title || '原事件已失效，待重新对应')}</button><small>${l.origin === 'auto' ? '自动对应' : '用户确认'}</small><button class="ghost edit-clue-link" data-link="${esc(l.id)}">${l.stale ? '重新对应' : '修改'}</button><button class="ghost remove-clue-link" data-link="${esc(l.id)}">解除关联</button></div>`).join('') || '<p class="hint">尚未关联剧情。</p>'}
      <details ${links.length ? '' : 'open'}><summary>推荐剧情候选</summary>${clue.candidates.map(c => `<div class="clue-candidate"><strong>${esc(c.title)}</strong><small>${c.exact ? '同位置原文' : '来源章节重合'}</small><p>${esc(c.summary)}</p><button class="ghost candidate-link" data-plot="${esc(c.plot_id)}">关联这一事件</button></div>`).join('') || '<p class="hint">未找到候选，可搜索其他章节的剧情。</p>'}</details>
      <details><summary>埋设原文与来源章节</summary>${clue.source_quotes.map(x => `<blockquote>${esc(x)}</blockquote>`).join('')}${(clue.source_chapter_ids || []).map(cid => `<button class="ghost clue-source" data-chapter="${esc(cid)}">${esc(data.chapters.find(c => c.id === cid)?.title || '来源已失效')}</button>`).join('')}</details>`);
    q('#clue-save-text').onclick = () => perform(async () => {
      const nextType = q('#clue-card-type').value;
      await api(`/api/projects/${projectId}/knowledge/${id}`, 'PUT', { type: nextType, title: q('#clue-title').value, summary: q('#clue-summary').value, review_status: 'confirmed' });
      dialog.close(); await window.reloadWorkspaceKnowledge(); await refresh();
      if (nextType === 'clue') showClue(id); else window.openKnowledgeItem?.(id);
    });
    q('#clue-edit-state').onclick = () => editState(id);
    const history = document.createElement('details');
    history.innerHTML = '<summary>状态确认历史与依据</summary>' + (clue.state_history || []).map(e => `<article><strong>${esc(labels[e.status])} · ${esc(data.chapters.find(c => c.id === e.chapter_id)?.title || '来源失效')}${e.undone ? '（已撤销）' : ''}</strong><p>${esc(e.explanation)}</p>${(e.source_quotes || []).map(x => `<blockquote>${esc(x)}</blockquote>`).join('')}</article>`).join('');
    dialog.append(history);
    const references = document.createElement('div');
    references.innerHTML = (clue.cross_references || []).map(r => `<button class="ghost" data-reference="${esc(r.id)}">${esc(r.label)} · ${esc(r.title)}</button>`).join('');
    references.querySelectorAll('button').forEach(b => b.onclick = () => { dialog.close(); window.openKnowledgeItem(b.dataset.reference); });
    dialog.append(references);
    const originalSelection = document.querySelector(`.knowledge-item[data-id="${CSS.escape(id)}"] .merge-select-knowledge`);
    if (originalSelection) {
      const label = document.createElement('label');
      label.innerHTML = `<input type="checkbox" ${originalSelection.checked ? 'checked' : ''} ${originalSelection.disabled ? 'disabled' : ''}> 勾选合并（关闭详情后，在知识整理工具中确认）`;
      label.querySelector('input').onchange = e => { originalSelection.checked = e.target.checked; originalSelection.dispatchEvent(new Event('change', { bubbles: true })); };
      dialog.append(label);
    }
    const remove = document.createElement('button'); remove.className = 'ghost danger'; remove.textContent = '删除伏笔';
    remove.onclick = () => {
      shell('确认删除伏笔', `<p>只删除“${esc(clue.title)}”，不删除正文；原关联和状态历史保留，恢复卡片后仍可查看。</p><button class="danger" id="clue-confirm-delete">确认删除</button>`);
      q('#clue-confirm-delete').onclick = () => perform(async () => { await api(`/api/projects/${projectId}/knowledge/${id}`, 'DELETE'); dialog.close(); await window.reloadWorkspaceKnowledge(); await refresh(); });
    };
    dialog.append(remove);
    q('#clue-undo-state').onclick = () => perform(async () => { await api(`${base()}/${id}/undo`, 'POST'); await refresh(); showClue(id); });
    q('#clue-attach-plot').onclick = () => chooseLink(id);
    dialog.querySelectorAll('.jump-clue-plot').forEach(b => b.onclick = () => { dialog.close(); window.openKnowledgeItem(b.dataset.plot); });
    dialog.querySelectorAll('.candidate-link').forEach(b => b.onclick = () => chooseLink(id, b.dataset.plot));
    dialog.querySelectorAll('.edit-clue-link').forEach(b => b.onclick = () => { const l = links.find(l => l.id === b.dataset.link); chooseLink(id, l.stale ? '' : l.plot_id, l); });
    dialog.querySelectorAll('.remove-clue-link').forEach(b => b.onclick = () => perform(async () => { await api(`${base()}/links/${b.dataset.link}`, 'DELETE'); await refresh(); showClue(id); }));
    dialog.querySelectorAll('.clue-source').forEach(b => b.onclick = () => perform(async () => { if (b.dataset.loaded) return; const c = await api(`/api/projects/${projectId}/chapters/${b.dataset.chapter}`); const pre = document.createElement('pre'); pre.textContent = c.text; b.after(pre); b.dataset.loaded = 'true'; }));
  }
  function chooseLink(clueId = '', plotId = '', existing = null) {
    const clue = data.clues.find(c => c.id === clueId);
    const choosePlot = !!clueId;
    const initialChapter = !plotId && choosePlot ? (clue.candidates[0]?.chapter_ids[0] || clue.source_chapter_ids[0] || '') : '';
    shell('关联伏笔与剧情', `<p>${esc(clue?.title || plots.find(p => p.id === plotId)?.title)}</p><input id="clue-link-query" type="search" placeholder="搜索标题、内容和原文"><select id="clue-link-chapter">${chapterOptions(initialChapter, true)}</select><div id="clue-link-options" class="clue-picker"></div><label>关系<select id="clue-link-role">${options(roles, existing?.role || 'plant')}</select></label><label><input id="clue-link-state-too" type="checkbox"> 保存后继续确认填坑状态</label><div class="row clue-dialog-actions"><button class="primary" id="clue-link-save">保存关联</button><button class="ghost" id="clue-link-cancel" type="button">取消</button></div>`);
    let selected = choosePlot ? plotId : clueId;
    const paint = () => {
      const query = q('#clue-link-query').value.trim().toLowerCase(), chapter = q('#clue-link-chapter').value;
      const choices = choosePlot ? plots : data.clues;
      const sorted = [...choices].sort((a, b) => (clue?.candidates.some(c => c.plot_id === b.id) ? 1 : 0) - (clue?.candidates.some(c => c.plot_id === a.id) ? 1 : 0));
      q('#clue-link-options').innerHTML = sorted.filter(i => (!chapter || (i.source_chapter_ids || []).includes(chapter)) && (!query || JSON.stringify([i.title, i.summary, i.source_quotes]).toLowerCase().includes(query))).map(i => `<label class="clue-picker-option"><input type="radio" name="clue-link-choice" value="${esc(i.id)}" ${selected === i.id ? 'checked' : ''}><span><strong>${esc(i.title)}</strong><small>${esc(i.summary.slice(0, 180))}</small></span></label>`).join('') || '<p class="hint">没有符合条件的条目，请改选全部章节或修改搜索词。</p>';
      q('#clue-link-options').querySelectorAll('input').forEach(i => i.onchange = () => selected = i.value);
    };
    q('#clue-link-query').oninput = paint; q('#clue-link-chapter').onchange = paint; paint();
    q('#clue-link-cancel').onclick = () => dialog.close();
    q('#clue-link-save').onclick = () => perform(async () => {
      if (!selected) throw new Error('请选择要关联的条目');
      const cid = choosePlot ? clueId : selected, pid = choosePlot ? selected : plotId;
      const role = q('#clue-link-role').value, also = q('#clue-link-state-too').checked;
      await api(`${base()}/links${existing ? `/${existing.id}` : ''}`, existing ? 'PUT' : 'POST', { clue_id: cid, plot_id: pid, role });
      await refresh();
      if (also) editState(cid, null, pid, role === 'resolve' ? 'resolved' : 'partial'); else showClue(cid);
    });
  }
  function editState(id, suggestion = null, plotId = '', preferred = '') {
    const clue = data.clues.find(c => c.id === id); if (!clue) return;
    const value = suggestion || clue.clue_state;
    const autofillSupported = data.state_autofill_supported === true;
    const selectedPlots = new Set(value.plot_ids || (value.plot_id ? [value.plot_id] : []));
    if (plotId) selectedPlots.add(plotId);
    shell(`确认伏笔进展 · ${clue.title}`, `<p>${esc(clue.summary)}</p><label>状态<select id="clue-state-value">${options(labels, preferred || value.status)}</select></label><label>生效章节<select id="clue-state-chapter">${chapterOptions(value.chapter_id || (plots.find(p => p.id === plotId)?.source_chapter_ids || [])[0])}</select></label>
      <details class="clue-state-plots"><summary>对应剧情（可多选）<span id="clue-state-plot-count"></span></summary><input id="clue-state-plot-query" type="search" placeholder="搜索剧情标题、内容或原文"><div id="clue-state-plot-options" class="clue-picker"></div></details>
      <div class="row"><button class="ghost" id="clue-state-autofill" type="button" ${autofillSupported ? '' : 'disabled'}>AI自动填充解释和依据</button><span class="hint" id="clue-state-autofill-status">${autofillSupported ? '会按生效章节限制时间范围，并可查询此前知识卡片与原文；结果不会自动保存。' : '当前后端尚未加载AI填充接口，请重启小说工作台后再使用。'}</span></div>
      <label>如何解释／还剩什么未解决<textarea id="clue-state-explanation" rows="5">${esc(value.explanation || '')}</textarea></label><label>正文依据（每行一条）<textarea id="clue-state-quotes" rows="3">${esc((value.source_quotes || []).join('\n'))}</textarea></label><button class="primary" id="clue-state-save">确认状态与说明</button>`);
    const paintPlots = () => {
      const query = q('#clue-state-plot-query').value.trim().toLowerCase();
      const chapterId = q('#clue-state-chapter').value;
      const boundary = data.chapters.find(c => c.id === chapterId)?.position ?? Infinity;
      q('#clue-state-plot-options').innerHTML = plots.filter(p => !query || JSON.stringify([p.title, p.summary, p.source_quotes]).toLowerCase().includes(query)).map(p => {
        const latest = Math.max(0, ...(p.source_chapter_ids || []).map(cid => data.chapters.find(c => c.id === cid)?.position || 0));
        const future = latest > boundary;
        if (future) selectedPlots.delete(p.id);
        return `<label class="clue-picker-option ${future ? 'disabled' : ''}"><input type="checkbox" value="${esc(p.id)}" ${selectedPlots.has(p.id) ? 'checked' : ''} ${future ? 'disabled' : ''}><span><strong>${esc(p.title)}</strong><small>${future ? '晚于当前生效章节' : esc((p.summary || '').slice(0, 180))}</small></span></label>`;
      }).join('') || '<p class="hint">没有符合条件的剧情。</p>';
      q('#clue-state-plot-options').querySelectorAll('input:not(:disabled)').forEach(box => box.onchange = () => {
        if (box.checked) selectedPlots.add(box.value); else selectedPlots.delete(box.value);
        q('#clue-state-plot-count').textContent = selectedPlots.size ? `（已选 ${selectedPlots.size}）` : '';
      });
      q('#clue-state-plot-count').textContent = selectedPlots.size ? `（已选 ${selectedPlots.size}）` : '';
    };
    q('#clue-state-plot-query').oninput = paintPlots;
    q('#clue-state-chapter').onchange = paintPlots;
    paintPlots();
    q('#clue-state-autofill').onclick = () => perform(async () => {
      if (!autofillSupported) throw new Error('当前后端尚未加载AI填充接口，请重启小说工作台');
      const statusValue = q('#clue-state-value').value;
      const chapterId = q('#clue-state-chapter').value;
      const plotIds = [...selectedPlots];
      const explanation = q('#clue-state-explanation').value;
      const quoteText = q('#clue-state-quotes').value;
      if (!chapterId) throw new Error('请先选择生效章节');
      const startedAt = Date.now();
      q('#clue-state-autofill-status').textContent = 'AI正在阅读本章，并按需查询此前知识卡片和原文（最多等待150秒）……';
      const elapsed = setInterval(() => {
        const target = q('#clue-state-autofill-status');
        if (target) target.textContent = `AI正在整理，已等待 ${Math.floor((Date.now() - startedAt) / 1000)} 秒（最多150秒）……`;
      }, 1000);
      let result;
      try {
        result = await api(`${base()}/${id}/state/autofill`, 'POST', {
          status: statusValue, chapter_id: chapterId, plot_ids: plotIds,
          current_explanation: explanation,
          current_source_quotes: quoteText.split('\n').map(x => x.trim()).filter(Boolean),
        });
      } catch (error) {
        const target = q('#clue-state-autofill-status');
        if (target) target.textContent = `❌ ${error.message}${error.message === 'Not Found' ? '；当前后端版本过旧，请重启小说工作台。' : ''}`;
        throw error;
      } finally { clearInterval(elapsed); }
      if (!dialog.open || q('#clue-state-value')?.value !== statusValue ||
          q('#clue-state-chapter')?.value !== chapterId ||
          [...selectedPlots].join('\n') !== plotIds.join('\n') ||
          q('#clue-state-explanation')?.value !== explanation || q('#clue-state-quotes')?.value !== quoteText) {
        if (q('#clue-state-autofill-status')) q('#clue-state-autofill-status').textContent = '生成期间表单选择或内容已经改变，本次结果未覆盖。';
        return;
      }
      q('#clue-state-explanation').value = result.explanation || '';
      q('#clue-state-quotes').value = (result.source_quotes || []).join('\n');
      const notes = [`已填入解释和 ${result.source_quotes?.length || 0} 条逐字依据`,
        `查询此前资料 ${result.tool_calls?.length || 0} 次`];
      if (result.evidence_chapters?.length) notes.push(`依据来自：${result.evidence_chapters.map(c => c.title).join('、')}`);
      if (result.discarded_quotes) notes.push(`丢弃 ${result.discarded_quotes} 条无法定位的AI引文`);
      if (result.evidence_note) notes.push(result.evidence_note);
      q('#clue-state-autofill-status').textContent = notes.join('；') + '。请检查后再确认保存。';
    });
    q('#clue-state-save').onclick = () => perform(async () => {
      await api(`${base()}/${id}/state`, 'POST', { status: q('#clue-state-value').value, chapter_id: q('#clue-state-chapter').value,
        explanation: q('#clue-state-explanation').value, source_quotes: q('#clue-state-quotes').value.split('\n').filter(x => x.trim()),
        plot_ids: [...selectedPlots], suggestion_id: suggestion?.id || '' });
      await refresh(); showClue(id);
    });
  }
  async function watch(taskId) {
    if (watching === taskId) return;
    watching = taskId; const pid = projectId;
    try {
      for (;;) {
        const p = await api(`/api/progress/${taskId}`);
        if (pid !== projectId) break;
        status(p.message || p.error || '检查中…');
        if (p.status === 'error') throw new Error(p.error);
        if (p.status === 'done') break;
        await new Promise(resolve => setTimeout(resolve, 1800));
      }
    } catch (e) { if (pid === projectId) status(`检查暂停或失败：${e.message}；可继续上次检查。`); }
    finally { watching = ''; if (pid === projectId) await refresh(); }
  }
  function startCheck(jobId = '') { return perform(async () => {
    if (!projectId) throw new Error('请先选择小说');
    const ids = window.knowledgeSelectionIds(); if (!jobId && !ids.length) throw new Error('请在上方勾选需要检查的章节');
    const started = await api(`${base()}/check`, 'POST', { chapter_ids: jobId ? [] : ids, job_id: jobId });
    await watch(started.task_id);
  }); }
  q('#check-clues').onclick = () => startCheck();
  q('#match-clues').onclick = () => perform(async () => { if (!projectId) throw new Error('请先选择小说'); const r = await api(`${base()}/match`, 'POST'); await refresh(); status(`新增 ${r.added} 条精确对应；其他候选可在伏笔详情中选择。`); });
  q('#stop-clue-check').onclick = () => perform(async () => { await api(`${base()}/check/stop`, 'POST'); status('将在当前批次后暂停，已完成的建议会保留。'); });
  q('#clue-status-filter').onchange = render; q('#clue-only-events').onchange = render;
  q('#knowledge-global-search').addEventListener('input', () => setTimeout(render, 350));
  document.addEventListener('knowledge-section-changed', render);
  document.addEventListener('clue-reset-filter', () => { q('#clue-status-filter').value = ''; q('#clue-only-events').checked = false; render(); });
  document.addEventListener('knowledge-loaded', event => { if (projectId !== event.detail.projectId) dialog.close(); projectId = event.detail.projectId; plots = event.detail.plots; perform(refresh); });
  q('#knowledge-project').addEventListener('change', () => { dialog.close(); projectId = ''; data = { clues: [], links: [], suggestions: [], jobs: [], chapters: [] }; render(); });
  window.openClueDetail = id => perform(async () => { await refresh(); showClue(id); });
})();
