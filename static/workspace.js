/* 小说创作工作台：项目、章节、知识库和页面导航。 */
(() => {
  const $w = (selector) => document.querySelector(selector);
  const KNOWLEDGE_TYPE_LABELS = { scene: '场景', plot: '剧情', character: '人物', relationship: '关系', term: '名词', world: '世界观', clue: '伏笔' };
  const RELATION_LAYOUT_OPTIONS = [
    ['hierarchy_source', '箭头起点为主', '主卡在左，从属卡在右'],
    ['hierarchy_target', '箭头终点为主', '箭头所指卡片作为主卡'],
    ['opposition', '对立分开', '双方分列两侧'],
    ['cluster', '同组聚集', '联系最多的卡片作为中心'],
    ['sequence', '先后链条', '按箭头从左到右'],
    ['manual', '不影响排布', '只显示连线'],
  ];
  function defaultRelationLayoutMode(label) {
    const value = String(label || '').trim();
    if (/(敌对|对立|仇敌|敌人|冲突|对抗|交战|竞争|追杀|排斥)/.test(value)) return 'opposition';
    if (/(属于|隶属|受制|受控|听命|效忠|任职于|成员|位于)/.test(value)) return 'hierarchy_target';
    if (/(拥有|持有|领导|控制|包含|管理|统领|创建|雇佣|管辖)/.test(value)) return 'hierarchy_source';
    if (/(导致|引发|转化|变成|继承|传给|发展为|前身|后继|升级|演变)/.test(value)) return 'sequence';
    return 'cluster';
  }
  function workspaceRelationLayoutMode(label) {
    const layouts = state.knowledgeTagCatalog.relation_layouts || {};
    const wanted = String(label || '').trim().toLocaleLowerCase();
    const saved = Object.entries(layouts).find(([key]) => String(key).trim().toLocaleLowerCase() === wanted)?.[1];
    return RELATION_LAYOUT_OPTIONS.some(([mode]) => mode === saved) ? saved : defaultRelationLayoutMode(label);
  }
  function workspaceRelationLayoutOptions(selected) {
    return RELATION_LAYOUT_OPTIONS.map(([value, title, description]) =>
      `<option value="${value}" ${value === selected ? 'selected' : ''}>${title}｜${description}</option>`).join('');
  }
  function storedReferenceIds() {
    try {
      const value = JSON.parse(localStorage.getItem('selectedReferenceIds') || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) { return []; }
  }
  const state = {
    knowledgeSection: 'entity',
    page: 'home', projects: [], project: null, chapters: [], chapter: null,
    selectedRefs: new Set(storedReferenceIds()),
    saveTimer: null, pendingSave: null, knowledgeTask: '', knowledgeType: '', knowledgeQuery: '', knowledgeSearchProject: '',
    knowledgeItems: [], knowledgePlotIndex: [], selectionStart: null, selectionEnd: null,
    knowledgeInitialSettings: {},
    knowledgeMutations: new Set(),
    knowledgeCatalog: [], knowledgeRelations: {},
    knowledgeTagCatalog: { card_tags: {}, relation_labels: [], relation_layouts: {} },
    manualKnowledgeSourceIds: new Set(),
    knowledgeChoicesProject: '', knowledgeChoices: [], knowledgeSelection: {}, knowledgeAwaitingReview: false,
    knowledgeSelectionSupported: false, knowledgeChapterCharLimit: 30000,
    memorySupported: false, settingTask: '',
    toolsSupported: false, autoMergeSupported: false, toolTask: '', mergeSelection: new Set(), mergeProject: '',
    auditSelectionSupported: false, auditProject: '', currentAudit: null, auditBusy: false, pendingAuditRequest: null,
    aiRunId: '', aiRunView: 'details', aiRunRefreshTimer: null, aiRunLoading: false,
  };

  function apiErrorMessage(detail, status) {
    if (typeof detail === 'string' && detail.trim()) return detail;
    if (Array.isArray(detail)) {
      const fieldNames = {source_quotes: '来源引文', source_chapter_ids: '来源章节', title: '卡片名称', summary: '卡片内容'};
      const typeMessages = {missing: '尚未填写', too_long: '数量过多', too_short: '数量不足',
        string_too_long: '内容过长', string_too_short: '内容过短', list_type: '格式应为列表'};
      const messages = detail.slice(0, 5).map(item => {
        const key = Array.isArray(item?.loc) ? item.loc[item.loc.length - 1] : '';
        const field = fieldNames[key] || key || '请求内容';
        return `${field}${typeMessages[item?.type] || item?.msg || '格式无效'}`;
      });
      return `提交内容有误：${messages.join('；') || '请检查后重试'}`;
    }
    if (detail && typeof detail === 'object') {
      if (typeof detail.message === 'string') return detail.message;
      try { return JSON.stringify(detail); } catch (_) { /* 使用下方通用提示 */ }
    }
    return `请求失败（${status}）`;
  }

  async function api(url, options = {}) {
    const response = await fetch(url, options);
    let data;
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok) throw new Error(apiErrorMessage(data.detail, response.status));
    return data;
  }

  function jsonOptions(method, body) {
    return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }

  const worksCard = $w('#works-list').closest('section');
  const uploadCard = $w('#drop').closest('section');
  const searchCard = $w('.mode-switch').closest('section');
  const resultCard = $w('#results').closest('section');
  const settingsCard = $w('#save-settings').closest('section');
  const draftContent = $w('#draft-mode-content');
  $w('#reference-mount').append(worksCard, uploadCard);
  $w('#search-mount').append(searchCard);
  $w('#search-result-mount').append(resultCard);
  $w('#settings-mount').append(settingsCard);
  $w('#draft-mount').append(draftContent);
  $w('#mode-draft').classList.add('hidden');

  function setPlotIndexCollapsed(collapsed) {
    $w('#plot-index-content').classList.toggle('hidden', collapsed);
    const button = $w('#toggle-plot-index');
    button.textContent = collapsed ? '展开' : '收起';
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    localStorage.setItem('plotIndexCollapsed', collapsed ? '1' : '0');
  }
  setPlotIndexCollapsed(localStorage.getItem('plotIndexCollapsed') === '1');
  $w('#toggle-plot-index').addEventListener('click', () =>
    setPlotIndexCollapsed(!$w('#plot-index-content').classList.contains('hidden')));

  function navigate(page) {
    if (state.page === 'knowledge' && page !== 'knowledge' && $w('#knowledge-detail-dialog').open && !closeKnowledgeDetail()) return;
    if (state.page === 'search') state.searchMode = currentMode;
    state.page = page;
    document.querySelectorAll('.app-page').forEach(el => el.classList.add('hidden'));
    const target = $w(`#page-${page}`) || $w('#page-home');
    target.classList.remove('hidden');
    document.querySelectorAll('#app-nav button').forEach(btn => btn.classList.toggle('active', btn.dataset.page === page));
    if (page === 'workbench') {
      $w('#draft-mount').append(draftContent);
      $w('#workbench-result-mount').append(resultCard);
      setMode('draft');
      syncWorkspaceSelectors();
    } else if (page === 'search') {
      $w('#search-result-mount').append(resultCard);
      setMode(state.searchMode || 'fast');
    }
    if (page === 'knowledge') loadKnowledge();
    if (page === 'references') restoreReferenceSelection();
  }
  window.navigateWorkspace = navigate;

  document.querySelectorAll('#app-nav button').forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.page)));
  document.querySelectorAll('[data-entry]').forEach(btn => btn.addEventListener('click', () => {
    if (btn.dataset.entry === 'search') return navigate('search');
    navigate('projects');
    showCreateProject(btn.dataset.entry === 'continue');
  }));

  function showCreateProject(importAfter = false) {
    $w('#project-create-panel').classList.remove('hidden');
    $w('#project-create-panel').dataset.importAfter = importAfter ? '1' : '';
    $w('#project-create-kind').value = importAfter ? 'import' : 'new';
    $w('#project-name').focus();
  }

  async function loadProjects(selectId = '') {
    const data = await api('/api/projects');
    state.projects = data.projects || [];
    renderProjectLists();
    populateProjectSelects();
    const wanted = selectId || (state.project && state.project.id);
    if (wanted && state.projects.some(p => p.id === wanted)) await selectProject(wanted);
  }

  function projectStatusLabel(project) {
    if (project.status === 'empty') return '空项目';
    if (project.status === 'indexed') return '知识已更新';
    return `待更新 ${project.dirty_count || 0} 章`;
  }

  function renderProjectLists() {
    const html = state.projects.length ? state.projects.map(project => `
      <button class="project-card ${state.project && state.project.id === project.id ? 'active' : ''}" data-project-id="${esc(project.id)}">
        <span>${esc(project.name)}</span><small>${project.chapter_count || 0} 章 · ${projectStatusLabel(project)}</small>
      </button>`).join('') : '<div class="empty-note">还没有创作项目。可以创建一部空白新小说。</div>';
    $w('#project-list').innerHTML = html;
    $w('#home-projects').innerHTML = html;
    // 项目编号也用于知识确认面板；只有列表中的小说卡片能触发导航。
    for (const selector of ['#project-list', '#home-projects']) {
      $w(selector).querySelectorAll('button.project-card[data-project-id]').forEach(btn => btn.addEventListener('click', async () => {
        if (await selectProject(btn.dataset.projectId) === false) return;
        navigate(selector === '#home-projects' ? 'workbench' : 'projects');
      }));
    }
  }

  function populateProjectSelects() {
    const options = '<option value="">不使用本作知识</option>' + state.projects.map(p =>
      `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    $w('#workspace-project').innerHTML = options;
    $w('#knowledge-project').innerHTML = state.projects.length
      ? state.projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')
      : '<option value="">暂无项目</option>';
    if (state.project) {
      $w('#workspace-project').value = state.project.id;
      $w('#knowledge-project').value = state.project.id;
    }
  }

  async function selectProject(projectId) {
    if (!(await saveChapter())) return false;
    state.selectionStart = null; state.selectionEnd = null;
    if (!projectId) {
      state.project = null; state.chapters = []; state.chapter = null;
      syncWorkspaceSelectors();
      renderEditor();
      return;
    }
    const project = await api(`/api/projects/${encodeURIComponent(projectId)}`);
    state.project = project;
    const projectIndex = state.projects.findIndex(item => item.id === project.id);
    if (projectIndex >= 0) state.projects[projectIndex] = project;
    state.chapters = project.chapters || [];
    state.chapter = state.chapters.find(c => state.chapter && c.id === state.chapter.id) || state.chapters[0] || null;
    state.selectedRefs = new Set(project.reference_ids || []);
    localStorage.setItem('selectedReferenceIds', JSON.stringify([...state.selectedRefs]));
    renderProjectLists();
    populateProjectSelects();
    renderEditor();
    syncWorkspaceSelectors();
    restoreReferenceSelection();
    loadProjectNotes();
  }

  function syncWorkspaceSelectors() {
    if (state.project) $w('#workspace-project').value = state.project.id;
    const chapterOptions = state.chapters.length
      ? state.chapters.map(c => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('')
      : '<option value="">暂无历史章节</option>';
    $w('#workspace-chapter').innerHTML = chapterOptions;
    if (state.chapter) $w('#workspace-chapter').value = state.chapter.id;
    const pill = $w('#workspace-kb-state');
    pill.textContent = state.project ? projectStatusLabel(state.project) : '未选择项目';
    pill.className = `status-pill ${state.project && state.project.status === 'indexed' ? 'ok' : ''}`;
  }

  async function createProject() {
    const name = $w('#project-name').value.trim();
    if (!name) { $w('#project-create-hint').textContent = '请填写项目名称'; return; }
    const button = $w('#create-project-submit');
    button.disabled = true;
    try {
      const project = await api('/api/projects', jsonOptions('POST', {
        name, concept: $w('#project-concept').value, characters: $w('#project-characters').value,
        worldbuilding: $w('#project-world').value, style: $w('#project-style').value,
        current_goal: $w('#project-goal').value,
      }));
      const importAfter = $w('#project-create-kind').value === 'import';
      $w('#project-create-panel').classList.add('hidden');
      await loadProjects(project.id);
      if (!importAfter) await addChapter();
      else {
        $w('#project-editor-hint').textContent = '项目已创建。请点击右下方“导入全文”选择 TXT 或 EPUB。';
        navigate('projects');
      }
    } catch (error) { $w('#project-create-hint').textContent = `❌ ${error.message}`; }
    finally { button.disabled = false; }
  }

  function renderEditor() {
    const editor = $w('#project-editor');
    $w('#chapter-nav').innerHTML = state.chapters.map(chapter => `<button class="project-card ${state.chapter && chapter.id === state.chapter.id ? 'active' : ''}" data-chapter="${esc(chapter.id)}">${esc(chapter.title)}</button>`).join('');
    $w('#chapter-nav').querySelectorAll('[data-chapter]').forEach(button => button.addEventListener('click', async () => {
      if (!(await saveChapter())) return;
      state.chapter = state.chapters.find(chapter => chapter.id === button.dataset.chapter);
      renderEditor(); syncWorkspaceSelectors();
    }));
    if (!state.project) { editor.classList.add('hidden'); return; }
    editor.classList.remove('hidden');
    $w('#editor-chapter').innerHTML = state.chapters.length
      ? state.chapters.map(c => `<option value="${esc(c.id)}">${esc(c.title)} · ${c.knowledge_status === 'indexed' ? '知识已更新' : '待更新'}</option>`).join('')
      : '<option value="">还没有章节</option>';
    if (state.chapter) {
      $w('#editor-chapter').value = state.chapter.id;
      $w('#chapter-title').value = state.chapter.title || '';
      $w('#chapter-editor-text').value = state.chapter.text || '';
    } else {
      $w('#chapter-title').value = '';
      $w('#chapter-editor-text').value = '';
    }
    $w('#chapter-version-select').innerHTML = '<option value="">展开后加载旧版本</option>';
    $w('#chapter-version-result').classList.add('hidden');
    $w('#chapter-version-result').innerHTML = '';
    $w('#chapter-version-hint').textContent = '修改章节后，覆盖前的正文会保留在这里。';
    $w('#meta-project-name').value = state.project.name || '';
    $w('#meta-project-concept').value = state.project.concept || '';
    $w('#meta-project-characters').value = state.project.characters || '';
    $w('#meta-project-world').value = state.project.worldbuilding || '';
    $w('#meta-project-style').value = state.project.style || '';
    $w('#meta-project-goal').value = state.project.current_goal || '';
  }

  async function loadChapterVersions() {
    if (!state.project || !state.chapter) return;
    const projectId = state.project.id, chapterId = state.chapter.id;
    $w('#chapter-version-hint').textContent = '正在读取版本记录…';
    try {
      const data = await api(`/api/projects/${projectId}/chapters/${chapterId}/versions`);
      if (!state.project || state.project.id !== projectId || !state.chapter || state.chapter.id !== chapterId) return;
      const old = (data.versions || []).filter(item => !item.current);
      $w('#chapter-version-select').innerHTML = old.length
        ? old.map(item => `<option value="${item.version}">版本 ${item.version} · ${esc(item.created_at)} · ${item.char_count} 字${item.change_kind === 'restore' ? ' · 恢复前快照' : ''}</option>`).join('')
        : '<option value="">尚无旧版本</option>';
      $w('#compare-chapter-version').disabled = !old.length;
      $w('#chapter-version-hint').textContent = old.length
        ? `保留了 ${old.length} 个旧版本（每章最多 50 个）。选择一个版本查看正文差异和知识影响。`
        : '当前章节还没有旧版本；下次修改并保存后会自动保留。';
    } catch (error) {
      $w('#chapter-version-hint').textContent = `❌ ${error.message}`;
    }
  }

  async function compareChapterVersion() {
    if (!(await saveChapter()) || !state.project || !state.chapter) return;
    const version = Number($w('#chapter-version-select').value);
    if (!version) return;
    const result = $w('#chapter-version-result');
    result.classList.remove('hidden');
    result.innerHTML = '<div class="hint">正在对比并检查知识影响…</div>';
    try {
      const data = await api(`/api/projects/${state.project.id}/chapters/${state.chapter.id}/compare/${version}`);
      const missing = (data.affected_knowledge || []).filter(item => item.quotes_missing > 0).length;
      const affected = (data.affected_knowledge || []).map(item => `
        <div class="chapter-impact-item ${item.quotes_missing ? 'warn' : ''}">
          <strong>${esc(KNOWLEDGE_TYPE_LABELS[item.type] || item.type)} · ${esc(item.title || '未命名')}</strong>
          <span>${item.quotes_missing ? `有 ${item.quotes_missing}/${item.quotes_total} 条引用已无法在新正文中定位` : '原有引用仍能定位，但内容含义可能受修改影响'}</span>
        </div>`).join('');
      result.innerHTML = `
        <div class="chapter-version-summary">
          版本 ${data.old_version} → 当前版本 ${data.current_version}：${data.changes.length} 处文本变化；
          直接关联 ${data.affected_knowledge.length} 条知识，其中 ${missing} 条存在失效引用；
          后续 ${data.later_chapters.length} 章列入影响范围参考，但不会自动标为待复核。
        </div>
        <div class="chapter-version-columns">
          <label class="field"><span>旧版本</span><textarea readonly>${esc(data.old_text)}</textarea></label>
          <label class="field"><span>当前版本</span><textarea readonly>${esc(data.current_text)}</textarea></label>
        </div>
        <h3>直接受影响的知识</h3>
        <div class="chapter-impact-list">${affected || '<div class="empty-note">没有知识卡片或剧情事件直接引用这一章。</div>'}</div>
        <div class="row"><button id="restore-selected-chapter-version" class="ghost danger">恢复这个旧版本</button><span class="hint">恢复也会先保存当前正文，因此可以再次撤回。</span></div>`;
      result.querySelector('#restore-selected-chapter-version').addEventListener('click', () => restoreChapterVersion(version));
    } catch (error) {
      result.innerHTML = `<div class="empty-note">❌ ${esc(error.message)}</div>`;
    }
  }

  async function restoreChapterVersion(version) {
    if (!state.project || !state.chapter || !confirm(`恢复到版本 ${version}？当前正文会先作为旧版本保留。`)) return;
    const projectId = state.project.id, chapterId = state.chapter.id;
    try {
      await api(`/api/projects/${projectId}/chapters/${chapterId}/restore`, jsonOptions('POST', { version }));
      await selectProject(projectId);
      state.chapter = state.chapters.find(item => item.id === chapterId) || state.chapter;
      renderEditor(); syncWorkspaceSelectors();
      $w('#chapter-version-panel').open = true;
      await loadChapterVersions();
      $w('#project-editor-hint').textContent = `已恢复版本 ${version}；恢复前的正文也已保留。相关知识已标记为待复核。`;
    } catch (error) {
      $w('#chapter-version-hint').textContent = `❌ ${error.message}`;
    }
  }

  async function addChapter() {
    if (!state.project) return;
    if (!(await saveChapter())) return;
    const chapter = await api(`/api/projects/${state.project.id}/chapters`, jsonOptions('POST', {
      title: `第${state.chapters.length + 1}章`, text: '',
    }));
    await selectProject(state.project.id);
    state.chapter = state.chapters.find(c => c.id === chapter.id) || chapter;
    renderEditor(); syncWorkspaceSelectors();
  }

  function scheduleSave() {
    if (!state.project || !state.chapter) return;
    $w('#chapter-save-state').textContent = '等待保存…';
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveChapter, 1500);
  }

  async function saveChapter() {
    if (!state.project || !state.chapter) return true;
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    const projectId = state.project.id, chapterId = state.chapter.id;
    const payload = { title: $w('#chapter-title').value, text: $w('#chapter-editor-text').value };
    if (!state.pendingSave && payload.title === state.chapter.title && payload.text === state.chapter.text) return true;
    const operation = (state.pendingSave || Promise.resolve()).then(async () => {
      $w('#chapter-save-state').textContent = '保存中…';
      try {
        const chapter = await api(`/api/projects/${projectId}/chapters/${chapterId}`, jsonOptions('PUT', payload));
        if (state.project && state.project.id === projectId) {
          const index = state.chapters.findIndex(c => c.id === chapter.id);
          if (index >= 0) state.chapters[index] = chapter;
          if (state.chapter && state.chapter.id === chapterId) state.chapter = chapter;
          state.project.dirty_count = state.chapters.filter(item => item.knowledge_status !== 'indexed').length;
          state.project.status = state.project.dirty_count ? 'drafting' : 'indexed';
          const projectIndex = state.projects.findIndex(item => item.id === projectId);
          if (projectIndex >= 0) state.projects[projectIndex] = state.project;
          renderProjectLists();
          syncWorkspaceSelectors();
          $w('#chapter-save-state').textContent = '已保存' + (chapter.knowledge_status !== 'indexed' ? ' · 知识待更新' : '');
        }
        return true;
      } catch (error) {
        $w('#chapter-save-state').textContent = `保存失败：${error.message}`;
        return false;
      }
    });
    state.pendingSave = operation;
    const saved = await operation;
    if (state.pendingSave === operation) state.pendingSave = null;
    return saved;
  }

  async function deleteChapter() {
    if (!state.project || !state.chapter || !confirm(`删除《${state.chapter.title}》？`)) return;
    clearTimeout(state.saveTimer);
    if (state.pendingSave) await state.pendingSave;
    await api(`/api/projects/${state.project.id}/chapters/${state.chapter.id}`, { method: 'DELETE' });
    state.chapter = null;
    await selectProject(state.project.id);
  }

  async function splitChapter() {
    if (!state.project || !state.chapter) return;
    const editor = $w('#chapter-editor-text');
    const offset = editor.selectionStart;
    if (!offset || offset >= editor.value.length) { $w('#project-editor-hint').textContent = '请先把光标放在要拆分的位置'; return; }
    if (!(await saveChapter())) return;
    await api(`/api/projects/${state.project.id}/chapters/${state.chapter.id}/split`,
      jsonOptions('POST', { offset, second_title: `${state.chapter.title}（下）` }));
    await selectProject(state.project.id);
  }

  async function mergeWithNextChapter() {
    if (!state.project || !state.chapter) return;
    const index = state.chapters.findIndex(item => item.id === state.chapter.id);
    const next = state.chapters[index + 1];
    if (!next) { $w('#project-editor-hint').textContent = '当前章节后面没有可合并的章节'; return; }
    if (!confirm(`把《${state.chapter.title}》与《${next.title}》合并？`)) return;
    if (!(await saveChapter())) return;
    const merged = await api(`/api/projects/${state.project.id}/chapters/merge`, jsonOptions('POST', {
      chapter_ids: [state.chapter.id, next.id], title: state.chapter.title,
    }));
    await selectProject(state.project.id);
    state.chapter = state.chapters.find(item => item.id === merged.id) || state.chapter;
    renderEditor(); syncWorkspaceSelectors();
  }

  async function moveChapter(delta) {
    if (!state.project || !state.chapter) return;
    const destination = state.chapter.position + delta;
    if (destination < 1 || destination > state.chapters.length) return;
    if (!(await saveChapter())) return;
    const id = state.chapter.id;
    await api(`/api/projects/${state.project.id}/chapters/${id}`,
      jsonOptions('PUT', { position: destination }));
    await selectProject(state.project.id);
    state.chapter = state.chapters.find(item => item.id === id) || state.chapter;
    renderEditor(); syncWorkspaceSelectors();
  }

  async function deleteProject() {
    if (!state.project || !confirm(`删除创作项目《${state.project.name}》及其本地正文和知识库？此操作无法撤销。`)) return;
    clearTimeout(state.saveTimer);
    if (state.pendingSave) await state.pendingSave;
    await api(`/api/projects/${state.project.id}`, { method: 'DELETE' });
    state.project = null; state.chapter = null; state.chapters = [];
    await loadProjects();
    renderEditor(); syncWorkspaceSelectors();
  }

  async function importProject(file) {
    if (!state.project || !file) return;
    if (!(await saveChapter())) return;
    const data = new FormData(); data.append('file', file);
    $w('#project-editor-hint').textContent = '正在导入并识别章节…';
    try {
      const result = await api(`/api/projects/${state.project.id}/import`, { method: 'POST', body: data });
      $w('#project-editor-hint').textContent = `已导入 ${result.count} 个章节，正文已保存；知识库尚未更新。`;
      await selectProject(state.project.id);
    } catch (error) { $w('#project-editor-hint').textContent = `❌ ${error.message}`; }
  }

  async function analyzeEditor(useSelection) {
    if (!state.chapter) return;
    const editor = $w('#chapter-editor-text');
    const selectionStart = useSelection && editor.selectionEnd > editor.selectionStart ? editor.selectionStart : null;
    const selectionEnd = selectionStart !== null ? editor.selectionEnd : null;
    let text = editor.value;
    if (selectionStart !== null) text = editor.value.slice(selectionStart, selectionEnd);
    if (!text.trim()) { $w('#project-editor-hint').textContent = '当前没有可分析的正文'; return; }
    if (!(await saveChapter())) return;
    state.selectionStart = selectionStart; state.selectionEnd = selectionEnd;
    resetDraftSession();
    $w('#draft-input').value = text;
    $w('#workspace-project').value = state.project.id;
    syncWorkspaceSelectors();
    navigate('workbench');
    $w('#draft-hint').textContent = '正文已带入。分析时会自动查询本作知识库。';
  }

  window.workspaceDraftContext = () => ({
    project_id: state.project ? state.project.id : '',
    chapter_id: state.chapter ? state.chapter.id : '',
    selection_start: state.selectionStart === null || !state.chapter ? null : Array.from(state.chapter.text.slice(0, state.selectionStart)).length,
    selection_end: state.selectionEnd === null || !state.chapter ? null : Array.from(state.chapter.text.slice(0, state.selectionEnd)).length,
  });

  function sourceButtons(projectId, chapterIds) {
    if (!projectId) return '';
    return (chapterIds || []).map((id, index) => `<details class="source-chapter" data-project="${esc(projectId)}" data-chapter="${esc(id)}"><summary>展开来源章节 ${index + 1}（当前保存版本）</summary><pre class="saved-research">正在读取…</pre></details>`).join('');
  }

  function parseKnowledgeQuoteText(value) {
    const text = String(value || '').trim();
    return text ? text.split(/\n\s*\n+/).map(part => part.trim()).filter(Boolean) : [];
  }

  function bindSourceButtons(container) {
    container.querySelectorAll('.source-chapter').forEach(details => details.addEventListener('toggle', async () => {
      if (!details.open || details.dataset.loaded) return;
      details.dataset.loaded = '1';
      try {
        const chapter = await api(`/api/projects/${details.dataset.project}/chapters/${details.dataset.chapter}`);
        details.querySelector('pre').textContent = `${chapter.title}\n\n${chapter.text}`;
      } catch (error) { details.querySelector('pre').textContent = error.message; details.dataset.loaded = ''; }
    }));
  }

  window.renderWorkspaceContext = (context, projectId = '') => {
    context = context || {};
    $w('#workspace-context-summary').textContent = context.summary || (state.project ? '尚未查询本作知识。' : '未选择项目，本次只分析当前原稿。');
    const evidence = context.evidence || [];
    const labels = { concept: '故事概念', characters: '主要人物', worldbuilding: '世界观', style: '风格与限制', current_goal: '当前场景' };
    const initial = Object.entries(context.initial_setting || {}).map(([key, value]) => `<div class="evidence-item"><strong>${esc(labels[key] || key)} · 用户确认</strong><p>${esc(value)}</p></div>`).join('');
    $w('#workspace-context-detail').innerHTML = initial + (evidence.length ? evidence.map(item => `
      <div class="evidence-item"><strong>${esc(item.title || item.chapter || item.type || '本作依据')}</strong>
      <p>${esc(item.summary || item.text || '')}</p>${(item.source_quotes || []).map(q => `<blockquote>${esc(q)}</blockquote>`).join('')}${sourceButtons(projectId, item.source_chapter_ids || (item.chapter_id ? [item.chapter_id] : []))}</div>`).join('')
      : '<div class="empty-note">暂无可展开的历史证据。</div>');
    bindSourceButtons($w('#workspace-context-detail'));
  };

  async function readKnowledgeChapterChoices(projectId, data) {
    if (Array.isArray(data.chapters)) return { supported: true, chapters: data.chapters };
    // 旧进程仍可提供正文目录；不能把缺少新版字段误判成“用户没有章节”。
    const legacy = await api(`/api/projects/${projectId}/chapters`);
    if (!Array.isArray(legacy.chapters)) throw new Error('服务未返回有效章节目录，请关闭旧服务窗口并重新启动程序。');
    return { supported: false, chapters: legacy.chapters.map(chapter => ({
      id: chapter.id, title: chapter.title, position: chapter.position, version: chapter.version,
      knowledge_status: chapter.knowledge_status,
      char_count: Array.from(chapter.text || '').length, has_text: !!(chapter.text || '').trim(),
      knowledge_batch_id: '',
    })) };
  }

  function showKnowledgeVersionWarning(visible) {
    let notice = $w('#knowledge-version-warning');
    if (!notice) {
      notice = document.createElement('div'); notice.id = 'knowledge-version-warning';
      notice.className = 'knowledge-version-warning hidden'; notice.setAttribute('role', 'alert');
      $w('#knowledge-chapter-picker').before(notice);
    }
    notice.textContent = '检测到旧版后端仍在运行。章节可以查看和勾选，但需重启服务后才能按勾选范围建立。请先关闭原来的 im-fangxie-server 服务窗口，再双击 start.bat，最后按 Ctrl + F5 刷新网页。不要只关闭网页或重复双击启动；无需重新导入小说。';
    notice.classList.toggle('hidden', !visible);
  }

  function chooseKnowledgeChaptersByTarget(chapters, startId, targetChars, hardMax = 30000) {
    const start = chapters.findIndex(chapter => chapter.id === startId);
    if (start < 0) return [];
    const target = Math.min(hardMax, Math.max(500, Number(targetChars) || 2000));
    const selected = [];
    let size = 0;
    for (const chapter of chapters.slice(start)) {
      if (!chapter.has_text) continue;
      // 不绕过超长章节悄悄改选后文；先让用户拆章或主动修改起点。
      if (chapter.char_count > hardMax) break;
      if (selected.length && size + chapter.char_count > target) break;
      selected.push(chapter.id); size += chapter.char_count;
      if (size >= target) break;
    }
    return selected;
  }

  function parseKnowledgeBuildPreferences(raw) {
    let value = {};
    try { value = JSON.parse(raw || '{}'); } catch (_) { value = {}; }
    const mode = ['auto', 'guided'].includes(value.mode) ? value.mode : 'auto';
    const parsedTarget = Math.round(Number(value.targetChars));
    const targetChars = Number.isFinite(parsedTarget) && parsedTarget >= 500
      ? Math.min(parsedTarget, 300000) : 2000;
    return { mode, targetChars };
  }

  function loadKnowledgeBuildPreferences() {
    const preferences = parseKnowledgeBuildPreferences(localStorage.getItem('knowledgeBuildPreferences'));
    $w('#knowledge-mode').value = preferences.mode;
    $w('#knowledge-target').value = String(preferences.targetChars);
  }

  function saveKnowledgeBuildPreferences() {
    const preferences = parseKnowledgeBuildPreferences(JSON.stringify({
      mode: $w('#knowledge-mode').value,
      targetChars: $w('#knowledge-target').value,
    }));
    localStorage.setItem('knowledgeBuildPreferences', JSON.stringify(preferences));
  }

  function reconcileKnowledgeSelection(chapters, selection, hardMax = 30000) {
    const result = {};
    for (const chapter of chapters) {
      if (!Object.prototype.hasOwnProperty.call(selection, chapter.id) || !chapter.has_text || chapter.char_count > hardMax) continue;
      // 只取消自勾选以来新完成的章节；用户仍可主动重选已建立章节。
      if (chapter.knowledge_batch_id && chapter.knowledge_batch_id !== selection[chapter.id]) continue;
      result[chapter.id] = selection[chapter.id];
    }
    return result;
  }

  function storeKnowledgeSelection() {
    if (!state.knowledgeChoicesProject) return;
    localStorage.setItem(`knowledgeChapterSelection:${state.knowledgeChoicesProject}`, JSON.stringify(state.knowledgeSelection));
  }

  function updateKnowledgeSelectionSummary() {
    const selected = state.knowledgeChoices.filter(chapter => Object.prototype.hasOwnProperty.call(state.knowledgeSelection, chapter.id));
    const total = selected.reduce((sum, chapter) => sum + chapter.char_count, 0);
    const indexed = selected.filter(chapter => chapter.knowledge_status === 'indexed').length;
    const regenerate = selected.length > 0 && indexed === selected.length;
    const acceptExisting = selected.length > 0 && selected.every(chapter =>
      chapter.knowledge_status !== 'indexed' && chapter.can_accept_existing_knowledge);
    const locked = !!state.knowledgeTask || state.knowledgeAwaitingReview;
    $w('#knowledge-selection-summary').textContent = selected.length
      ? `已勾选 ${selected.length} 章，共 ${total.toLocaleString()} 字。${regenerate ? '这些章节均已建立；点击后将重新生成其剧情事件概括并刷新AI知识。' : (indexed ? `其中 ${indexed} 章将重新生成，其余章节将首次建立。` : '')}${state.knowledgeAwaitingReview ? '建立前请先确认或拒绝下方待审核批次。' : ''}`
      : `尚未勾选章节。请手动勾选，或点击“按目标字数勾选”。${state.knowledgeAwaitingReview ? '请先确认或拒绝下方待审核批次。' : ''}`;
    $w('#knowledge-selected-preview').innerHTML = selected.map(chapter => `<li>${esc(chapter.title)} · ${chapter.char_count} 字</li>`).join('') || '<li>暂无勾选</li>';
    $w('#build-knowledge-btn').disabled = !state.knowledgeSelectionSupported || locked || !selected.length;
    $w('#build-knowledge-btn').textContent = regenerate ? '重新生成勾选章节知识库' : '为勾选章节建立知识库';
    $w('#knowledge-accept-existing').disabled = !state.knowledgeSelectionSupported || locked || !acceptExisting;
    $w('#knowledge-accept-existing').textContent = acceptExisting
      ? `沿用现有知识，标记为已建立（${selected.length}）` : '沿用现有知识，标记为已建立';
    $w('#knowledge-accept-existing').title = acceptExisting
      ? '不调用AI，保留当前剧情事件和知识卡片，并更新检索索引'
      : '只适用于曾经成功建立、修改后显示待更新且仍有剧情事件的章节';
    $w('#knowledge-repair-index').disabled = !state.knowledgeSelectionSupported || !!state.knowledgeTask || !state.knowledgeChoices.some(chapter => chapter.has_text);
    $w('#knowledge-project').disabled = !!state.knowledgeTask;
    for (const id of ['knowledge-select-by-target', 'knowledge-select-pending', 'knowledge-select-all', 'knowledge-clear-selection', 'knowledge-start-chapter']) {
      $w(`#${id}`).disabled = !!state.knowledgeTask || !state.knowledgeChoices.length;
    }
    $w('#knowledge-chapter-options').querySelectorAll('input').forEach(input => {
      const chapter = state.knowledgeChoices.find(item => item.id === input.value);
      input.checked = Object.prototype.hasOwnProperty.call(state.knowledgeSelection, input.value);
      input.disabled = !!state.knowledgeTask || !chapter.has_text || chapter.char_count > state.knowledgeChapterCharLimit;
    });
    updateAuditControls();
    updateAutoMergeControl();
  }

  function selectedKnowledgeChapterIds() {
    const projectId = $w('#knowledge-project').value;
    return state.knowledgeChoicesProject === projectId ? Object.keys(state.knowledgeSelection) : [];
  }

  function updateAutoMergeControl() {
    const selected = selectedKnowledgeChapterIds();
    const button = $w('#auto-merge-knowledge');
    if (!button) return;
    button.textContent = `依据勾选章节自动合并（${selected.length}）`;
    button.disabled = !state.toolsSupported || !state.autoMergeSupported || !state.knowledgeSelectionSupported ||
      !selected.length || state.auditBusy || !!(state.toolTask || state.knowledgeTask || state.settingTask);
  }

  function renderKnowledgeChapterPicker(projectId, chapters) {
    const sameProject = state.knowledgeChoicesProject === projectId;
    const oldStart = sameProject ? $w('#knowledge-start-chapter').value : '';
    if (!sameProject) {
      try {
        const stored = JSON.parse(localStorage.getItem(`knowledgeChapterSelection:${projectId}`) || '{}');
        state.knowledgeSelection = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
      } catch (_) { state.knowledgeSelection = {}; }
    }
    const previousSelection = state.knowledgeSelection;
    state.knowledgeChoicesProject = projectId; state.knowledgeChoices = chapters;
    const hardMax = state.knowledgeChapterCharLimit;
    state.knowledgeSelection = reconcileKnowledgeSelection(chapters, previousSelection, hardMax);
    const startFinished = Object.prototype.hasOwnProperty.call(previousSelection, oldStart) && !Object.prototype.hasOwnProperty.call(state.knowledgeSelection, oldStart);
    storeKnowledgeSelection();
    const start = $w('#knowledge-start-chapter');
    start.innerHTML = chapters.map(chapter => `<option value="${esc(chapter.id)}">${esc(chapter.title)} · ${chapter.knowledge_status === 'indexed' ? '已建立' : '待更新'}</option>`).join('') || '<option value="">暂无章节</option>';
    const suggested = chapters.find(chapter => Object.prototype.hasOwnProperty.call(state.knowledgeSelection, chapter.id))
      || chapters.find(chapter => chapter.has_text && (chapter.knowledge_status !== 'indexed' || !chapter.plot_covered)) || chapters[0];
    start.value = !startFinished && chapters.some(chapter => chapter.id === oldStart) ? oldStart : (suggested && suggested.id) || '';
    const labels = { indexed: '已建立', dirty: '待更新', needs_review: '待复核' };
    const options = $w('#knowledge-chapter-options');
    options.innerHTML = chapters.map(chapter => {
      const status = !chapter.has_text ? '空章节'
        : chapter.char_count > hardMax ? `超过 ${hardMax.toLocaleString()} 字，请先拆章或调整模型上下文`
        : `${labels[chapter.knowledge_status] || '待更新'} · 剧情事件 ${chapter.plot_events || 0}${chapter.plot_covered ? '' : '（缺失）'}${chapter.can_accept_existing_knowledge ? ' · 可沿用现有知识' : ''}`;
      return `<label class="knowledge-chapter-option"><input type="checkbox" value="${esc(chapter.id)}"><span>${esc(chapter.title)}</span><small>${chapter.char_count} 字 · ${status}</small></label>`;
    }).join('') || '<div class="empty-note">请先导入小说或保存章节正文。</div>';
    options.querySelectorAll('input').forEach(input => input.addEventListener('change', () => {
      const chapter = state.knowledgeChoices.find(item => item.id === input.value);
      if (input.checked) state.knowledgeSelection[input.value] = chapter.knowledge_batch_id || '';
      else delete state.knowledgeSelection[input.value];
      storeKnowledgeSelection(); updateKnowledgeSelectionSummary();
    }));
    updateKnowledgeSelectionSummary();
  }

  function selectKnowledgeChapters(method) {
    const startId = $w('#knowledge-start-chapter').value;
    let ids = [];
    if (method === 'target') ids = chooseKnowledgeChaptersByTarget(state.knowledgeChoices, startId, $w('#knowledge-target').value, state.knowledgeChapterCharLimit);
    else if (method !== 'clear') {
      const start = state.knowledgeChoices.findIndex(chapter => chapter.id === startId);
      ids = state.knowledgeChoices.slice(Math.max(0, start)).filter(chapter => chapter.has_text && chapter.char_count <= state.knowledgeChapterCharLimit && (method === 'all' || chapter.knowledge_status !== 'indexed' || !chapter.plot_covered)).map(chapter => chapter.id);
    }
    state.knowledgeSelection = Object.fromEntries(state.knowledgeChoices.filter(chapter => ids.includes(chapter.id)).map(chapter => [chapter.id, chapter.knowledge_batch_id || '']));
    storeKnowledgeSelection(); updateKnowledgeSelectionSummary();
    $w('#knowledge-selected-preview').closest('details').open = true;
    if (method === 'target') $w('#knowledge-hint').textContent = ids.length ? '已按目标字数勾选完整章节，请检查或调整后再开始建立。' : `没有选到可处理的章节；起始章节若超过 ${state.knowledgeChapterCharLimit.toLocaleString()} 字，请先拆章或调整模型上下文。`;
  }

  function aiRunStatusLabel(status) {
    return ({ running: '运行中', done: '已完成', error: '失败', interrupted: '已中断' })[status] || status || '未知';
  }

  function aiRunTime(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function renderAiRunData(data) {
    if (data == null) return '';
    if (typeof data !== 'object') return `<pre>${esc(String(data))}</pre>`;
    const sections = [];
    if (Array.isArray(data.messages)) {
      const labels = { system: '系统提示', user: '用户输入', assistant: '模型回复', tool: '工具返回' };
      sections.push(`<details open><summary>实际发送给模型的消息（${data.messages.length} 条）</summary>${data.messages.map((message, index) => {
        const content = message && message.content != null ? message.content : JSON.stringify(message, null, 2);
        return `<div class="ai-run-message"><strong>${index + 1}. ${esc(labels[message.role] || message.role || '消息')}</strong><pre>${esc(String(content))}</pre></div>`;
      }).join('')}</details>`);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'raw')) {
      sections.push(`<details open><summary>模型原始回复</summary><pre>${esc(String(data.raw || '（空回复）'))}</pre></details>`);
    }
    if (Array.isArray(data.tool_calls) && data.tool_calls.length) {
      sections.push(`<details><summary>模型调用本作查询工具（${data.tool_calls.length} 次）</summary><pre>${esc(JSON.stringify(data.tool_calls, null, 2))}</pre></details>`);
    }
    const rest = Object.fromEntries(Object.entries(data).filter(([key]) => !['messages', 'raw', 'tool_calls'].includes(key)));
    if (Object.keys(rest).length) sections.push(`<details><summary>程序数据与校验详情</summary><pre>${esc(JSON.stringify(rest, null, 2))}</pre></details>`);
    return sections.join('');
  }

  function renderAiRun(run) {
    const meta = run.metadata || {};
    const chapterText = (meta.chapters || []).map(item => item.title).join('、');
    $w('#knowledge-ai-run-meta').textContent = `${aiRunStatusLabel(run.status)} · ${run.title || 'AI任务'} · ${aiRunTime(run.created_at)}\n模型：${meta.model || '未记录'} · 方式：${meta.index_only ? '仅更新索引' : (meta.mode === 'guided' ? '逐步确认' : '自动建立')} · ${meta.group_count || 0} 批${chapterText ? `\n章节：${chapterText}` : ''}${run.summary ? `\n结果：${run.summary}` : ''}`;
    const box = $w('#knowledge-ai-run-events');
    if (state.aiRunView === 'raw') {
      box.innerHTML = `<div class="ai-run-event"><pre>${esc(JSON.stringify(run, null, 2))}</pre></div>`;
      return;
    }
    const events = run.events || [];
    box.innerHTML = events.length ? events.map(event => `<article class="ai-run-event" data-stage="${esc(event.stage || '')}">
      <div class="ai-run-event-head"><h3>${esc(event.title || '运行记录')}</h3><time>${esc(aiRunTime(event.time))}</time></div>
      ${event.summary ? `<p class="ai-run-event-summary">${esc(event.summary)}</p>` : ''}
      ${state.aiRunView === 'details' ? renderAiRunData(event.data) : ''}
    </article>`).join('') : '<div class="ai-run-empty">任务刚刚建立，正在等待第一条记录……</div>';
  }

  async function loadAiRunDetail(runId, quiet = false) {
    const projectId = $w('#knowledge-project').value;
    if (!projectId || !runId) return;
    try {
      const run = await api(`/api/projects/${projectId}/ai-runs/${runId}`);
      if (runId !== state.aiRunId) return;
      renderAiRun(run);
    } catch (error) {
      if (!quiet) $w('#knowledge-ai-run-events').innerHTML = `<div class="ai-run-empty">❌ ${esc(error.message)}</div>`;
    }
  }

  async function loadAiRunList(preferredId = '', quiet = false) {
    if (state.aiRunLoading) return;
    const projectId = $w('#knowledge-project').value;
    const select = $w('#knowledge-ai-run-select');
    if (!projectId) {
      select.innerHTML = '<option value="">请先选择小说</option>';
      $w('#knowledge-ai-run-events').innerHTML = '<div class="ai-run-empty">选择小说后可查看记录。</div>';
      return;
    }
    state.aiRunLoading = true;
    try {
      const payload = await api(`/api/projects/${projectId}/ai-runs?kind=knowledge_build&limit=20`);
      const runs = payload.runs || [];
      const wanted = preferredId || state.aiRunId;
      state.aiRunId = runs.some(run => run.id === wanted) ? wanted : (runs[0] || {}).id || '';
      select.innerHTML = runs.length ? runs.map(run => `<option value="${esc(run.id)}" ${run.id === state.aiRunId ? 'selected' : ''}>${esc(`${aiRunStatusLabel(run.status)} · ${run.title} · ${aiRunTime(run.created_at)}`)}</option>`).join('') : '<option value="">还没有运行记录</option>';
      if (state.aiRunId) await loadAiRunDetail(state.aiRunId, quiet);
      else {
        $w('#knowledge-ai-run-meta').textContent = '当前小说还没有知识整理运行记录。';
        $w('#knowledge-ai-run-events').innerHTML = '<div class="ai-run-empty">开始一次“建立知识库”后，这里会实时显示工作过程。</div>';
      }
    } catch (error) {
      if (!quiet) $w('#knowledge-ai-run-events').innerHTML = `<div class="ai-run-empty">❌ ${esc(error.message)}</div>`;
    } finally { state.aiRunLoading = false; }
  }

  function openAiRunDrawer(preferredId = '') {
    $w('#knowledge-ai-run-drawer').classList.remove('hidden');
    loadAiRunList(preferredId);
    clearInterval(state.aiRunRefreshTimer);
    state.aiRunRefreshTimer = setInterval(() => {
      if (!$w('#knowledge-ai-run-drawer').classList.contains('hidden')) loadAiRunList(state.aiRunId, true);
    }, 2000);
  }

  function closeAiRunDrawer() {
    $w('#knowledge-ai-run-drawer').classList.add('hidden');
    clearInterval(state.aiRunRefreshTimer);
    state.aiRunRefreshTimer = null;
  }

  async function buildKnowledge(indexOnly = false) {
    const projectId = $w('#knowledge-project').value;
    if (!projectId) return;
    // 旧版会忽略 chapter_ids/index_only，误执行全部待更新章节，必须阻止提交。
    if (!state.knowledgeSelectionSupported) {
      showKnowledgeVersionWarning(true);
      $w('#knowledge-hint').textContent = '请先关闭旧服务窗口并重新启动程序，再按勾选章节建立。';
      return;
    }
    if (!(await saveChapter())) return;
    const selectedIds = Object.keys(state.knowledgeSelection);
    if (!indexOnly && (state.knowledgeChoicesProject !== projectId || !selectedIds.length)) {
      $w('#knowledge-hint').textContent = '请先勾选要建立知识库的章节。'; return;
    }
    state.knowledgeTask = 'starting';
    updateKnowledgeSelectionSummary();
    $w('#knowledge-progress').classList.remove('hidden');
    try {
      const started = await api(`/api/projects/${projectId}/knowledge/build`, jsonOptions('POST', {
        mode: indexOnly ? 'auto' : $w('#knowledge-mode').value,
        target_chars: Number($w('#knowledge-target').value) || 2000,
        chapter_ids: selectedIds, index_only: indexOnly,
        keep_context: $w('#knowledge-keep-context').checked,
      }));
      state.knowledgeTask = started.task_id;
      openAiRunDrawer(started.task_id);
      const done = await pollProgress(started.task_id, 'knowledge-bar', 'knowledge-progress-text');
      const batch = done.result && done.result.batches && done.result.batches[0];
      if (batch && batch.status === 'awaiting_review') renderKnowledgeReview(projectId, batch);
      $w('#knowledge-hint').textContent = done.message;
      await loadProjects(projectId);
    } catch (error) { $w('#knowledge-hint').textContent = `❌ ${error.message}`; }
    finally { state.knowledgeTask = ''; $w('#knowledge-progress').classList.add('hidden'); await loadKnowledge(); updateKnowledgeSelectionSummary(); if (state.aiRunId) loadAiRunList(state.aiRunId, true); }
  }

  async function acceptExistingChapterKnowledge() {
    const projectId = $w('#knowledge-project').value;
    if (!projectId || !state.knowledgeSelectionSupported || state.knowledgeTask) return;
    if (!(await saveChapter())) return;
    const selected = state.knowledgeChoices.filter(chapter =>
      Object.prototype.hasOwnProperty.call(state.knowledgeSelection, chapter.id));
    if (!selected.length || selected.some(chapter =>
      chapter.knowledge_status === 'indexed' || !chapter.can_accept_existing_knowledge)) {
      $w('#knowledge-hint').textContent = '只能沿用曾经成功建立、修改后显示待更新且仍保留剧情事件的章节。';
      return;
    }
    const names = selected.map(chapter => chapter.title).join('、');
    if (!window.confirm(`将“${names}”标记为已建立？\n\n这不会调用AI，也不会重新生成或删除卡片。系统会把现有剧情事件和知识视为仍适用于修改后的正文，并更新检索索引。若这次修改改变了事实、事件或引文内容，请取消并正常重新建立知识库。`)) return;
    state.knowledgeTask = 'accepting-existing';
    updateKnowledgeSelectionSummary();
    try {
      const result = await api(`/api/projects/${projectId}/knowledge/chapters/accept-existing`,
        jsonOptions('POST', {chapter_ids: selected.map(chapter => chapter.id)}));
      selected.forEach(chapter => delete state.knowledgeSelection[chapter.id]);
      storeKnowledgeSelection();
      await loadProjects(projectId);
      await loadKnowledge();
      $w('#knowledge-hint').textContent = result.warning ||
        `已沿用现有知识并将 ${result.marked || selected.length} 章标记为已建立；没有调用AI。`;
    } catch (error) {
      $w('#knowledge-hint').textContent = `❌ ${error.message}`;
    } finally {
      state.knowledgeTask = '';
      updateKnowledgeSelectionSummary();
    }
  }

  function renderKnowledgeReview(projectId, batch) {
    const panel = $w('#knowledge-review');
    panel.classList.remove('hidden');
    panel.dataset.projectId = projectId; panel.dataset.batchId = batch.id;
    const titles = (batch.chapter_ids || []).map(id => (state.knowledgeChoices.find(chapter => chapter.id === id) || {}).title || id);
    panel.innerHTML = `<div class="card-head"><h2>逐步确认：知识卡片与剧情事件</h2><span class="hint" id="knowledge-review-count">${(batch.draft_items || []).length} 条草稿</span></div><p class="hint">本批章节：${titles.map(esc).join('、')}。剧情标题和概括可以直接修正；下方原文是支撑概括的证据，不能在这里改写。错误事件可单独删除，但每章必须保留最低数量。</p>
      <div class="review-items">${(batch.draft_items || []).map((item, index) => `
        <div class="review-item" data-index="${index}" data-original-type="${esc(item.type || '')}" data-chapter-id="${esc(item.chapter_id || (item.source_chapter_ids || [])[0] || '')}" data-details="${esc(JSON.stringify(item.details || {}))}" data-source-quotes="${esc(JSON.stringify(item.source_quotes || []))}"><select class="review-type" ${item.type === 'plot' ? 'disabled' : ''}>${knowledgeTypeOptions(item.type)}</select>
        <input class="review-title" value="${esc(item.title || item.name || '')}" placeholder="${item.type === 'plot' ? '剧情事件标题' : '标题'}">
        <textarea class="review-summary" rows="3" placeholder="${item.type === 'plot' ? '概括这段剧情实际发生了什么；可人工纠错' : '知识内容'}">${esc(item.summary || item.description || '')}</textarea>
        ${item.type === 'plot' ? '<p class="hint">这是待人工核对的AI剧情概括。只有确认写入后，后续AI才会把概括当作可靠索引；精确细节仍以原文为准。</p>' : ''}
        ${item.same_name_match ? `<p class="same-name-draft-hint">将更新已有${esc(KNOWLEDGE_TYPE_LABELS[item.type] || '知识')}卡片《${esc(item.same_name_match.title)}》；${String(item.same_name_match.review_status || '').startsWith('confirmed') ? '原用户确认摘要会保留，本条作为自动补充收纳。' : '不会再新建重复卡片。'}</p>
        <label class="same-name-separate-choice"><input class="save-review-as-separate" type="checkbox"> 不更新已有卡片，把当前内容保存为独立卡片</label>` : ''}
        <label class="field"><span>${item.type === 'plot' ? '剧情依据（同一事件可以有多段原文）' : '来源原句'}（每行一条，必须来自本批正文）</span><textarea class="review-quotes" rows="${item.type === 'plot' ? '5' : '2'}" ${item.type === 'plot' ? 'readonly' : ''}>${esc((item.source_quotes || []).join('\n'))}</textarea></label>
        <button class="ghost danger remove-review-item" type="button">删除此条草稿</button></div>`).join('')}</div>
      <div class="row"><button class="ghost" id="reject-knowledge-batch">拒绝本批</button><button class="primary" id="accept-knowledge-batch">确认并写入知识库</button></div>`;
    $w('#accept-knowledge-batch').addEventListener('click', () => reviewKnowledge(true));
    $w('#reject-knowledge-batch').addEventListener('click', () => reviewKnowledge(false));
    panel.querySelectorAll('.remove-review-item').forEach(button => button.addEventListener('click', () => {
      button.closest('.review-item').remove();
      const remaining = panel.querySelectorAll('.review-item').length;
      $w('#knowledge-review-count').textContent = `${remaining} 条草稿`;
      $w('#accept-knowledge-batch').textContent = remaining ? '确认并写入知识库' : '确认本批不写入条目';
    }));
  }

  function knowledgeTypeOptions(selected, includePlot = true) {
    const labels = { scene: '场景', plot: '剧情', character: '人物', relationship: '关系', term: '名词', world: '世界观', clue: '伏笔' };
    return Object.entries(labels).filter(([value]) => includePlot || value !== 'plot')
      .map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
  }

  async function reviewKnowledge(accepted) {
    const panel = $w('#knowledge-review');
    const convertedToPlot = accepted && [...panel.querySelectorAll('.review-item')].some(item =>
      item.dataset.originalType !== 'plot' && item.querySelector('.review-type').value === 'plot');
    const items = [...panel.querySelectorAll('.review-item')].map(item => {
      let details = {};
      try { details = JSON.parse(item.dataset.details || '{}'); } catch (_) { details = {}; }
      const type = item.querySelector('.review-type').value;
      let sourceQuotes = [];
      if (type === 'plot') {
        try { sourceQuotes = JSON.parse(item.dataset.sourceQuotes || '[]'); } catch (_) { sourceQuotes = []; }
      } else {
        sourceQuotes = item.querySelector('.review-quotes').value.split('\n').map(text => text.trim()).filter(Boolean);
      }
      return {
        draft_index: Number(item.dataset.index), chapter_id: item.dataset.chapterId || '', details,
        type,
        title: item.querySelector('.review-title').value,
        summary: item.querySelector('.review-summary').value,
        source_quotes: sourceQuotes,
        save_as_separate: item.querySelector('.save-review-as-separate')?.checked === true,
      };
    });
    try {
      const result = await api(`/api/projects/${panel.dataset.projectId}/knowledge/review`, jsonOptions('POST', {
        batch_id: panel.dataset.batchId, accepted, items,
      }));
      panel.classList.add('hidden');
      $w('#knowledge-hint').textContent = accepted
        ? (result.warning || (convertedToPlot ? '已写入知识库；改为“剧情”的条目已移到剧情页。' : '本批理解已确认并写入知识库。'))
        : '已拒绝本批，章节仍保持待更新。';
      await loadProjects(panel.dataset.projectId); await loadKnowledge();
      if (convertedToPlot) window.setKnowledgeSection('plot');
    } catch (error) { $w('#knowledge-hint').textContent = `❌ ${error.message}`; }
  }

  function characterStateEditRow(value = {}) {
    const persistence = value.persistence || 'unknown';
    return `<div class="character-state-edit-row">
      <label>状态字段<input class="character-state-edit-key" maxlength="200" value="${esc(value.key || '')}" placeholder="例如：互联网使用限制"></label>
      <label>当前内容<textarea class="character-state-edit-value" rows="2" maxlength="1200" placeholder="例如：限制已解除，可以正常联网">${esc(value.value || '')}</textarea></label>
      <label>此前状态<input class="character-state-edit-before" maxlength="1200" value="${esc(value.before || '')}" placeholder="可选"></label>
      <label>变化原因<input class="character-state-edit-reason" maxlength="1200" value="${esc(value.reason || '')}" placeholder="可选"></label>
      <label>持续性<select class="character-state-edit-persistence"><option value="unknown" ${persistence === 'unknown' ? 'selected' : ''}>未判断</option><option value="ongoing" ${persistence === 'ongoing' ? 'selected' : ''}>持续中</option><option value="temporary" ${persistence === 'temporary' ? 'selected' : ''}>暂时</option><option value="permanent" ${persistence === 'permanent' ? 'selected' : ''}>永久</option></select></label>
      <button class="ghost danger remove-character-state" type="button">移除此状态</button>
    </div>`;
  }

  function knowledgeCardHtml(item) {
    const typeLabels = KNOWLEDGE_TYPE_LABELS;
    const reviewLabels = { auto: 'AI整理', confirmed: '用户确认', needs_review: '待复核', confirmed_needs_review: '用户确认 · 原文已变更' };
    const projectId = $w('#knowledge-project').value;
    const relations = state.knowledgeRelations[item.id] || [];
    const tags = Array.isArray(item.details?.tags) ? item.details.tags : [];
    const sameNameUpdates = Array.isArray(item.details?.same_name_updates) ? item.details.same_name_updates : [];
    const sameNameHistory = Array.isArray(item.details?.same_name_history) ? item.details.same_name_history : [];
    const currentState = Array.isArray(item.current_state) ? item.current_state : [];
    return `<article class="knowledge-item knowledge-detail-item" data-id="${esc(item.id)}" data-knowledge-type="${esc(item.type)}"><label class="hint"><input type="checkbox" class="merge-select-knowledge" ${state.mergeSelection.has(item.id) ? 'checked' : ''} ${['auto','confirmed'].includes(item.review_status) ? '' : 'disabled'}> 勾选合并</label><div class="knowledge-head"><span>${esc(typeLabels[item.type] || item.type)}</span><strong>${esc(item.title || '未命名条目')}</strong><em>${esc(reviewLabels[item.review_status] || item.review_status)}</em></div>
      <label class="field compact-field knowledge-card-title-field"><span>卡片名称</span><input class="knowledge-card-title" maxlength="300" value="${esc(item.title || '')}" placeholder="请输入卡片名称"></label>
      <label class="field compact-field knowledge-card-type-field"><span>卡片类型</span><select class="knowledge-card-type">${knowledgeTypeOptions(item.type, false)}</select></label>
      <textarea class="knowledge-summary" rows="3">${esc(item.summary)}</textarea>
      ${item.type === 'character' ? `<details class="character-current-state"><summary>当前状态快照（已确认剧情状态＋人工调整）${currentState.length ? ` · ${currentState.length} 项` : ''}</summary><div class="character-state-display">${currentState.length ? currentState.map(value => `<div class="character-state-row"><strong>${esc(value.key)}</strong><span>${esc(value.value)}</span><small>${esc(value.manual ? '人工调整' : (value.event_title || ''))}</small></div>`).join('') : '<p class="hint">还没有当前状态，可以手动添加。</p>'}</div><button class="ghost edit-character-state" type="button">编辑当前快照</button><div class="character-state-editor hidden"><div class="character-state-edit-rows">${currentState.map(characterStateEditRow).join('')}</div><div class="row"><button class="ghost add-character-state" type="button">添加状态</button><button class="ghost save-character-state" type="button">保存快照</button><button class="ghost cancel-character-state" type="button">取消</button></div><p class="hint character-state-status">人工修改只影响当前快照；之后出现更晚且经确认的剧情状态时，会自动采用新状态。</p></div></details>` : ''}
      <div class="knowledge-subtypes"><span class="hint">细分：</span><span class="knowledge-subtype-chips">${tags.length ? window.KnowledgeTagPeriods.chips(item) : '<span class="hint">未标注</span>'}</span></div>
      ${sameNameUpdates.length ? `<details class="same-name-updates"><summary>发现同名卡片：保留用户确认内容，并收纳了 ${sameNameUpdates.length} 条 AI 补充</summary>${sameNameUpdates.map((update, index) => `<div class="same-name-update" data-update-index="${index}"><strong>${esc((update.chapter_titles || []).join('、') || '后续章节')}</strong><p>${esc(update.summary || '')}</p><div class="row"><button class="ghost apply-same-name-update" type="button" data-update-index="${index}">填入描述并移除</button><button class="ghost danger dismiss-same-name-update" type="button" data-update-index="${index}">移除此补充</button><button class="ghost undo-same-name-update hidden" type="button" data-update-index="${index}">撤销</button><span class="hint same-name-update-status"></span></div></div>`).join('')}</details>` : (sameNameHistory.length ? `<p class="hint same-name-merged">已自动归并 ${sameNameHistory.length} 次同类型同名知识，当前显示最新认识。</p>` : '')}
      <div class="knowledge-relations"><span class="hint">关联知识：${relations.length ? '' : '暂无'}</span>${relations.map(related => `<span class="knowledge-relation-chip ${related.temporal_status === 'ended' ? 'ended' : ''}"><button class="ghost open-related-knowledge" data-related-id="${esc(related.id)}" title="${esc(related.summary)}">${related.direction === 'out' ? `${esc(related.label)} → ${esc(related.title)}` : `${esc(related.title)} → ${esc(related.label)} → 本卡片`}</button><button class="ghost manage-relations edit-relation-period" data-focus-related-id="${esc(related.id)}" title="编辑这条关系的存在章节">${esc(relationPeriodText(related))}</button></span>`).join('')}</div>
      <div class="knowledge-sources">${(item.source_quotes || []).map(q => `<blockquote>${esc(q)}</blockquote>`).join('')}${sourceButtons(projectId, item.source_chapter_ids)}</div>
      <div class="knowledge-quote-editor hidden"><label class="field"><span>AI建议的精简引文（每段之间空一行）</span><textarea class="knowledge-optimized-quotes" rows="7"></textarea></label><div class="row"><button class="primary save-optimized-knowledge-quotes" type="button">确认替换引文</button><button class="ghost cancel-optimized-knowledge-quotes" type="button">取消</button></div><p class="hint knowledge-quote-status">AI结果尚未保存，可以继续编辑；保存时会再次逐字核对。</p></div>
      <div class="knowledge-source-editor hidden"><div class="row"><input class="knowledge-source-search" placeholder="搜索要追加的来源章节"><button class="ghost save-knowledge-sources">保存卡片与来源</button><button class="ghost cancel-knowledge-sources">取消</button></div><div class="knowledge-source-options"></div><p class="hint">已有来源章节会保留。这里追加的是这张卡片内容实际来自的章节；保存时会同时保存当前填写的名称、类型和内容。</p><p class="hint knowledge-source-status"></p></div>
      <div class="knowledge-tag-editor hidden"><p class="hint">这是“${esc(typeLabels[item.type] || item.type)}”下面的细分，只显示该大类保存过的选项。</p><div class="knowledge-tag-selected"></div><div class="row"><input class="knowledge-tag-input" maxlength="30" placeholder="输入新细分，如：人类"><button class="ghost add-knowledge-tag">添加</button><button class="ghost save-knowledge-tags">保存细分</button><button class="ghost cancel-knowledge-tags">取消</button></div><div class="knowledge-tag-suggestions"></div><p class="hint knowledge-tag-status"></p></div>
      <div class="relation-editor hidden"><div class="row"><input class="relation-search" placeholder="搜索要关联的人物、能力、名词或事件"><button class="ghost save-relations">保存关联</button><button class="ghost cancel-relations">取消</button></div><div class="relation-label-library"></div><div class="relation-options"></div><p class="hint">填写关系名称，如“拥有”“隶属于”“敌对”“发生于”。先点某个关系输入框，再点上方常用关系即可应用。关联只给模型补充只读依据，不会合并或删除卡片。</p></div>
      <div class="row"><button class="ghost manage-knowledge-sources">追加来源章节</button><button class="ghost optimize-knowledge-quotes">AI优化引文</button><button class="ghost manage-knowledge-tags">编辑细分</button><button class="ghost manage-relations">管理关联</button><button class="ghost save-knowledge-item">保存为用户确认</button><button class="ghost danger delete-knowledge-item">删除卡片</button></div></article>`;
  }

  function knowledgeCardPreviewHtml(item) {
    const reviewLabels = { auto: 'AI整理', confirmed: '用户确认', needs_review: '待复核', confirmed_needs_review: '原文已变更' };
    const tags = Array.isArray(item.details?.tags) ? item.details.tags : [];
    const relations = state.knowledgeRelations[item.id] || [];
    const sourceCount = new Set(item.source_chapter_ids || []).size;
    const mergeEnabled = ['auto', 'confirmed'].includes(item.review_status);
    const tagHtml = tags.slice(0, 2).map(tag => `<span class="knowledge-tag-chip" title="${esc(tag)}">${esc(tag)}</span>`).join('');
    return `<article class="knowledge-item knowledge-card-preview" tabindex="0" data-id="${esc(item.id)}" data-knowledge-type="${esc(item.type)}" aria-label="查看知识卡片：${esc(item.title || '未命名条目')}">
      <div class="knowledge-preview-select"><label class="hint"><input type="checkbox" class="merge-select-knowledge" ${state.mergeSelection.has(item.id) ? 'checked' : ''} ${mergeEnabled ? '' : 'disabled'}> 勾选合并</label><button class="ghost knowledge-preview-open" type="button">查看详情</button></div>
      <div class="knowledge-head"><span>${esc(KNOWLEDGE_TYPE_LABELS[item.type] || item.type)}</span><strong>${esc(item.title || '未命名条目')}</strong><em>${esc(reviewLabels[item.review_status] || item.review_status)}</em></div>
      <p class="knowledge-preview-summary">${esc(item.summary || '尚未填写卡片内容')}</p>
      <div class="knowledge-preview-meta">${tagHtml || '<span class="hint">未标注细分</span>'}${tags.length > 2 ? `<span class="hint">+${tags.length - 2}</span>` : ''}<span class="knowledge-preview-counts">${sourceCount} 章来源 · ${relations.length} 条关联</span></div>
    </article>`;
  }

  function knowledgeSettingPreviewHtml(key, label, text) {
    return `<article class="knowledge-item knowledge-card-preview confirmed-setting" tabindex="0" data-setting-field="${esc(key)}" aria-label="查看初始设定：${esc(label)}">
      <div class="knowledge-preview-select"><span class="hint">小说建立时填写</span><button class="ghost knowledge-preview-open" type="button">查看详情</button></div>
      <div class="knowledge-head"><span>初始设定</span><strong>${esc(label)}</strong><em>用户确认</em></div>
      <p class="knowledge-preview-summary">${esc(text)}</p>
      <div class="knowledge-preview-meta"><span class="hint">完整内容在详情窗口查看</span></div>
    </article>`;
  }

  function knowledgeCardCoreDirty(card) {
    if (!card) return false;
    return card.querySelector('.knowledge-card-title')?.value !== card.querySelector('.knowledge-card-title')?.defaultValue ||
      card.querySelector('.knowledge-summary')?.value !== card.querySelector('.knowledge-summary')?.defaultValue ||
      card.querySelector('.knowledge-card-type')?.value !== card.dataset.knowledgeType ||
      card.dataset.updatesChanged === '1';
  }

  function knowledgeCardHasUnsavedWork(card) {
    if (knowledgeCardCoreDirty(card)) return true;
    return !!card?.querySelector('.knowledge-quote-editor:not(.hidden),.knowledge-source-editor:not(.hidden),.knowledge-tag-editor:not(.hidden),.relation-editor:not(.hidden),.character-state-editor:not(.hidden)');
  }

  function hasUnsavedKnowledgeCards(selectedOnly = false) {
    return [...$w('#knowledge-detail-content').querySelectorAll('.knowledge-item[data-id]')]
      .some(card => (!selectedOnly || state.mergeSelection.has(card.dataset.id)) && knowledgeCardCoreDirty(card));
  }

  function syncMergeCheckboxes(itemId) {
    document.querySelectorAll('.merge-select-knowledge').forEach(box => {
      const owner = box.closest('[data-id]');
      if (owner?.dataset.id === itemId) box.checked = state.mergeSelection.has(itemId);
    });
  }

  function updateKnowledgePreviewCard(item) {
    const current = [...$w('#knowledge-list').querySelectorAll('.knowledge-card-preview[data-id]')]
      .find(card => card.dataset.id === item.id);
    if (!current) return;
    const holder = document.createElement('div');
    holder.innerHTML = knowledgeCardPreviewHtml(item);
    const replacement = holder.firstElementChild;
    current.replaceWith(replacement);
    bindKnowledgePreviews(replacement, $w('#knowledge-project').value);
    applyKnowledgeFilters();
  }

  function showKnowledgeDetailMarkup(item) {
    const dialog = $w('#knowledge-detail-dialog');
    const content = $w('#knowledge-detail-content');
    dialog.dataset.itemId = item.id;
    dialog.dataset.projectId = $w('#knowledge-project').value;
    delete dialog.dataset.settingField;
    $w('#knowledge-detail-title').textContent = item.title || '未命名知识卡片';
    content.innerHTML = knowledgeCardHtml(item);
    bindSourceButtons(content);
    bindKnowledgeCards(content, $w('#knowledge-project').value);
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    }
    document.body.classList.add('knowledge-detail-open');
    content.scrollTop = 0;
  }

  function openKnowledgeSettingDetail(field) {
    const setting = state.knowledgeInitialSettings[field];
    if (!setting) return;
    const dialog = $w('#knowledge-detail-dialog');
    const current = $w('#knowledge-detail-content').querySelector('.knowledge-item[data-id]');
    if (dialog.open && knowledgeCardHasUnsavedWork(current) && !window.confirm('当前卡片有尚未保存的修改。放弃这些修改并查看另一项内容吗？')) return;
    delete dialog.dataset.itemId;
    dialog.dataset.settingField = field;
    dialog.dataset.projectId = $w('#knowledge-project').value;
    $w('#knowledge-detail-title').textContent = setting.label;
    $w('#knowledge-detail-content').innerHTML = `<article class="knowledge-detail-setting"><div class="knowledge-head"><span>初始设定</span><strong>${esc(setting.label)}</strong><em>用户确认</em></div><div>${esc(setting.text)}</div></article>`;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    }
    document.body.classList.add('knowledge-detail-open');
  }

  function openKnowledgeDetail(itemId, options = {}) {
    const item = state.knowledgeItems.find(entry => entry.id === itemId);
    if (!item) return false;
    const dialog = $w('#knowledge-detail-dialog');
    const current = $w('#knowledge-detail-content').querySelector('.knowledge-item[data-id]');
    if (!options.force && dialog.open && current?.dataset.id !== itemId && knowledgeCardHasUnsavedWork(current) &&
        !window.confirm('当前卡片有尚未保存的修改。放弃这些修改并查看另一张卡片吗？')) return false;
    showKnowledgeDetailMarkup(item);
    return true;
  }

  function closeKnowledgeDetail(force = false) {
    const dialog = $w('#knowledge-detail-dialog');
    const current = $w('#knowledge-detail-content').querySelector('.knowledge-item[data-id]');
    if (!force && knowledgeCardHasUnsavedWork(current) && !window.confirm('这张卡片还有尚未保存的修改。确定关闭并放弃这些修改吗？')) return false;
    if (dialog.open && typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
    delete dialog.dataset.itemId;
    delete dialog.dataset.settingField;
    delete dialog.dataset.projectId;
    $w('#knowledge-detail-content').innerHTML = '';
    document.body.classList.remove('knowledge-detail-open');
    return true;
  }

  function bindKnowledgePreviews(container, projectId) {
    const cards = [
      ...(container.matches?.('.knowledge-card-preview') ? [container] : []),
      ...container.querySelectorAll('.knowledge-card-preview'),
    ];
    cards.forEach(card => {
      const open = () => {
        if (card.dataset.id) window.openKnowledgeItem?.(card.dataset.id);
        else if (card.dataset.settingField) openKnowledgeSettingDetail(card.dataset.settingField);
      };
      card.querySelector('.knowledge-preview-open')?.addEventListener('click', event => { event.stopPropagation(); open(); });
      card.addEventListener('click', event => { if (!event.target.closest('button,input,label')) open(); });
      card.addEventListener('keydown', event => {
        if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('button,input,label')) { event.preventDefault(); open(); }
      });
      card.querySelector('.merge-select-knowledge')?.addEventListener('change', event => {
        event.stopPropagation();
        const id = card.dataset.id;
        if (event.currentTarget.checked) state.mergeSelection.add(id); else state.mergeSelection.delete(id);
        syncMergeCheckboxes(id); updateMergeSelection(); applyKnowledgeFilters();
      });
    });
  }

  function relationPeriodText(relation) {
    const start = relation?.valid_from_chapter?.title || '';
    const end = relation?.invalid_from_chapter?.title || '';
    if (start && end) return `${start}起 · ${end}失效`;
    if (end) return `${end}起失效`;
    if (start) return `${start}起 · 持续有效`;
    if (relation?.invalid_from_chapter_id) return '失效章节待修正';
    return '长期有效';
  }

  function relationChapterOptions(selectedId, kind) {
    const blank = kind === 'end' ? '尚未失效（持续有效）' : '未指定（默认长期存在）';
    return `<option value="">${blank}</option>` + state.knowledgeChoices.map(chapter =>
      `<option value="${esc(chapter.id)}" ${chapter.id === selectedId ? 'selected' : ''}>${esc(chapter.title)}</option>`).join('');
  }

  function renderPlotIndex(projectId, entries) {
    const panel = $w('#plot-index-list');
    $w('#plot-index-count').textContent = `${entries.length} 个事件`;
    if (!entries.length) {
      panel.innerHTML = '<div class="empty-note">还没有剧情事件。建立知识库后，系统会把带原文依据的剧情概括按章节排列在这里。</div>';
      return;
    }
    panel.innerHTML = entries.map((item, index) => {
      const chapters = item.index_chapters || [];
      const chapterLabel = chapters.length ? chapters.map(chapter => chapter.title).join('、') : '来源章节待定位';
      const chapterIds = item.index_chapter_ids || item.source_chapter_ids || [];
      const reviewLabels = { auto: 'AI概括 · 待核对', confirmed: '用户已核对', needs_review: '原文已变更 · 待重建', confirmed_needs_review: '用户核对后原文又变更' };
      const details = item.details || {};
      const isStateChange = details.event_type === 'character_state_change';
      return `<article class="plot-index-entry" data-id="${esc(item.id)}" data-state-event="${isStateChange ? '1' : '0'}">
        <div class="plot-index-marker"><span>${index + 1}</span></div>
        <div class="plot-index-content"><div class="knowledge-head"><span>${esc(chapterLabel)}</span>${isStateChange ? `<strong class="state-change-badge">${item.review_status === 'confirmed' ? '已核对人物状态变化' : '疑似人物状态变化'} · ${esc((details.affected_character_titles || []).join('、') || '人物待确认')}</strong>` : ''}<em>${esc(reviewLabels[item.review_status] || item.review_status)}</em></div>
        <label class="field"><span>剧情事件标题</span><input class="plot-index-title" maxlength="300" value="${esc(item.title || '')}" placeholder="概括这个事件"></label>
        <label class="field"><span>剧情概括</span><textarea class="plot-index-summary" rows="3" maxlength="4000" placeholder="只写下方原文共同支持的行动、信息变化与结果">${esc(item.summary || '')}</textarea></label>
        <p class="hint plot-review-hint">${item.review_status === 'confirmed' ? '这段概括已经人工核对，会供后续AI检索；精确细节仍应查看原文。' : '这段AI概括尚未核对，后续AI暂时只能读取下方原文依据。'}</p>
        <details class="plot-evidence" ${item.review_status === 'confirmed' ? '' : 'open'}><summary>查看剧情依据（${(item.source_quotes || []).length} 段原文）</summary>${(item.source_quotes || []).map(quote => `<blockquote>${esc(quote)}</blockquote>`).join('')}</details>
        <label class="field"><span>用户备注（可选，不会覆盖上面的原文）</span><textarea class="plot-user-note" rows="2" maxlength="4000" placeholder="只在需要人工解释这段原文时填写">${esc(details.user_note || '')}</textarea></label>
        ${isStateChange ? `<details class="plot-state-editor"><summary>核对人物状态检索提示</summary><p class="hint">这些字段是AI建议，不会在用户保存前当成事实。</p><label>状态字段<input class="plot-state-key" maxlength="200" value="${esc(details.state_key || '')}" placeholder="例如：互联网使用限制"></label><label>变化前<textarea class="plot-state-before" rows="2">${esc(details.state_before || '')}</textarea></label><label>变化后<textarea class="plot-state-after" rows="2">${esc(details.state_after || '')}</textarea></label><label>变化原因<input class="plot-state-reason" maxlength="1200" value="${esc(details.change_reason || '')}"></label></details>` : ''}
        <div class="knowledge-sources">${sourceButtons(projectId, chapterIds)}</div>
        <div class="row"><button class="ghost save-plot-index">保存并确认概括</button><button class="danger delete-plot-index">删除错误事件</button><span class="hint plot-index-edit-status"></span></div></div>
      </article>`;
    }).join('');
    bindSourceButtons(panel);
    bindPlotIndex(projectId, panel);
  }

  function bindPlotIndex(projectId, panel) {
    panel.querySelectorAll('.plot-index-entry[data-id]').forEach(entry => {
      entry.querySelector('.save-plot-index').addEventListener('click', async event => {
        const button = event.currentTarget;
        const status = entry.querySelector('.plot-index-edit-status');
        button.disabled = true; status.textContent = '正在保存…';
        try {
          const previous = state.knowledgePlotIndex.find(item => item.id === entry.dataset.id) || {};
          const details = { ...(previous.details || {}) };
          const title = entry.querySelector('.plot-index-title').value.trim();
          const summary = entry.querySelector('.plot-index-summary').value.trim();
          if (!title || !summary) throw new Error('剧情标题和概括不能为空');
          details.user_note = entry.querySelector('.plot-user-note').value.trim();
          if (entry.dataset.stateEvent === '1') {
            details.state_key = entry.querySelector('.plot-state-key').value.trim();
            details.state_before = entry.querySelector('.plot-state-before').value.trim();
            details.state_after = entry.querySelector('.plot-state-after').value.trim();
            details.change_reason = entry.querySelector('.plot-state-reason').value.trim();
            details.interpretation_status = 'confirmed';
          }
          const saved = await api(`/api/projects/${projectId}/knowledge/${entry.dataset.id}`,
            jsonOptions('PUT', { title, summary, details, review_status: 'confirmed' }));
          const index = state.knowledgePlotIndex.findIndex(item => item.id === saved.id);
          if (index >= 0) state.knowledgePlotIndex[index] = { ...state.knowledgePlotIndex[index], ...saved };
          entry.querySelector('.knowledge-head em').textContent = '用户已核对';
          entry.querySelector('.plot-review-hint').textContent = '这段概括已经人工核对，会供后续AI检索；精确细节仍应查看原文。';
          status.textContent = '已保存';
          applyKnowledgeFilters();
        } catch (error) { status.textContent = `❌ ${error.message}`; }
        finally { button.disabled = false; }
      });
      entry.querySelector('.delete-plot-index').addEventListener('click', () => confirmAction(
        '删除这个错误的剧情事件？对应章节会重新标记为待更新，下次建库会重新概括。',
        () => run(async () => {
          await api(`/api/projects/${projectId}/knowledge/${entry.dataset.id}`, { method: 'DELETE' });
          await loadKnowledge();
        }),
      ));
    });
  }

  function knowledgeSearchMatches(item, query, extra = '') {
    const normalized = String(query || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
    if (!normalized) return true;
    const haystack = [item?.type, item?.title, item?.summary, JSON.stringify(item?.details || {}),
      ...(item?.source_quotes || []), extra].join(' ').toLocaleLowerCase().replace(/\s+/g, ' ');
    return normalized.split(' ').every(term => haystack.includes(term));
  }

  function applyKnowledgeFilters() {
    const query = state.knowledgeQuery || '';
    const itemMap = new Map(state.knowledgeItems.map(item => [item.id, item]));
    let visibleCards = 0, visibleSettings = 0, visiblePlots = 0;
    $w('#knowledge-list').querySelectorAll('.knowledge-card-preview[data-id]').forEach(card => {
      const item = itemMap.get(card.dataset.id) || {};
      const currentText = card.textContent || '';
      const sectionMatch = state.knowledgeSection === 'world' ? item.type === 'world' : state.knowledgeSection === 'entity' ? !['world', 'clue'].includes(item.type) : false;
      const visible = sectionMatch && (!state.knowledgeType || card.dataset.knowledgeType === state.knowledgeType) &&
        knowledgeSearchMatches(item, query, currentText);
      card.classList.toggle('hidden', !visible);
      if (visible) visibleCards++;
    });
    $w('#knowledge-list').querySelectorAll('.confirmed-setting').forEach(card => {
      const visible = (state.knowledgeSection === 'world' ? card.dataset.settingField === 'worldbuilding' : state.knowledgeSection === 'entity' && card.dataset.settingField !== 'worldbuilding') && knowledgeSearchMatches({}, query, card.textContent || '');
      card.classList.toggle('hidden', !visible);
      if (visible) visibleSettings++;
    });
    const plotMap = new Map(state.knowledgePlotIndex.map(item => [item.id, item]));
    $w('#plot-index-list').querySelectorAll('.plot-index-entry[data-id]').forEach(entry => {
      const item = plotMap.get(entry.dataset.id) || {};
      const chapters = (item.index_chapters || []).map(chapter => chapter.title).join(' ');
      const currentText = `${entry.querySelector('.plot-user-note')?.value || ''} ${entry.textContent || ''}`;
      const visible = knowledgeSearchMatches(item, query, `${chapters} ${currentText}`);
      entry.classList.toggle('hidden', !visible);
      if (visible) visiblePlots++;
    });
    const totalPlots = state.knowledgePlotIndex.length;
    $w('#plot-index-count').textContent = query ? `${visiblePlots}/${totalPlots} 个事件` : `${totalPlots} 个事件`;
    const list = $w('#knowledge-list');
    let empty = list.querySelector('.knowledge-filter-empty');
    if (!visibleCards && !visibleSettings && (query || state.knowledgeType)) {
      if (!empty) {
        empty = document.createElement('div'); empty.className = 'empty-note knowledge-filter-empty';
        list.append(empty);
      }
      empty.textContent = query ? '没有找到匹配的知识卡片或初始设定。可以换一个较短的关键词。' : '当前类型还没有知识卡片。';
    } else if (empty) empty.remove();
    list.querySelectorAll('.knowledge-base-empty').forEach(note => note.classList.toggle('hidden', !!(query || state.knowledgeType)));
    $w('#clear-knowledge-search').disabled = !query;
    $w('#knowledge-search-status').textContent = query
      ? `找到 ${visiblePlots} 条剧情、${visibleCards} 张知识卡片、${visibleSettings} 项初始设定；已勾选 ${state.mergeSelection.size} 张合并卡片。`
      : `当前共有 ${totalPlots} 条剧情、${state.knowledgeItems.length} 张知识卡片；输入关键词可跨类型搜索，已勾选 ${state.mergeSelection.size} 张合并卡片。`;
  }

  function renderKnowledgeTrash(projectId, items) {
    if ($w('#knowledge-project').value !== projectId) return;
    $w('#knowledge-trash').classList.toggle('hidden', !items.length);
    $w('#knowledge-trash-count').textContent = items.length;
    const list = $w('#knowledge-trash-list');
    list.innerHTML = items.map(item => `<article class="knowledge-trash-item"><strong>${esc(item.title || '未命名条目')}</strong><p>${esc(item.summary)}</p><button class="ghost restore-knowledge-item" data-id="${esc(item.id)}">恢复卡片</button></article>`).join('');
    list.querySelectorAll('.restore-knowledge-item').forEach(button => button.addEventListener('click', () => restoreKnowledgeCard(projectId, button.dataset.id, button)));
  }

  async function refreshKnowledgeTrash(projectId) {
    // 只刷新回收站，保留其他卡片和逐步确认面板中尚未提交的编辑。
    const data = await api(`/api/projects/${projectId}/knowledge`);
    renderKnowledgeTrash(projectId, data.deleted_items || []);
  }

  async function restoreKnowledgeCard(projectId, itemId, button) {
    const key = `${projectId}:${itemId}`;
    if (state.knowledgeMutations.has(key)) return;
    state.knowledgeMutations.add(key); button.disabled = true;
    try {
      const result = await api(`/api/projects/${projectId}/knowledge/${itemId}/restore`, jsonOptions('POST', {}));
      if ($w('#knowledge-project').value !== projectId) return;
      await loadKnowledge();
      $w('#knowledge-hint').textContent = result.warning || '卡片已恢复。';
      window.openKnowledgeItem?.(result.item.id);
    } catch (error) { $w('#knowledge-hint').textContent = `❌ ${error.message}`; }
    finally { state.knowledgeMutations.delete(key); button.disabled = false; }
  }

  function bindKnowledgeCards(container, projectId) {
    const hasUnsavedCards = () => hasUnsavedKnowledgeCards();
    container.querySelectorAll('.knowledge-item[data-id]').forEach(card => {
      card._sameNameActions = new Map();
      const markSameNameUpdate = (index, appendToSummary) => {
        const stored = state.knowledgeItems.find(item => item.id === card.dataset.id)?.details?.same_name_updates?.[index];
        const row = card.querySelector(`.same-name-update[data-update-index="${index}"]`);
        if (!stored || !row || card._sameNameActions.has(index)) return;
        const summary = card.querySelector('.knowledge-summary');
        const previousSummary = summary.value;
        if (appendToSummary) {
          const addition = String(stored.summary || '').trim();
          if (addition && !summary.value.includes(addition)) summary.value = `${summary.value.trim()}${summary.value.trim() ? '\n' : ''}${addition}`;
        }
        card._sameNameActions.set(index, { previousSummary });
        card.dataset.updatesChanged = '1';
        row.classList.add('pending-remove');
        row.querySelectorAll('.apply-same-name-update,.dismiss-same-name-update').forEach(button => button.classList.add('hidden'));
        row.querySelector('.undo-same-name-update')?.classList.remove('hidden');
        row.querySelector('.same-name-update-status').textContent = appendToSummary ? '已填入描述，保存卡片后移除' : '保存卡片后移除';
      };
      card.querySelectorAll('.apply-same-name-update').forEach(button => button.addEventListener('click', () =>
        markSameNameUpdate(Number(button.dataset.updateIndex), true)));
      card.querySelectorAll('.dismiss-same-name-update').forEach(button => button.addEventListener('click', () =>
        markSameNameUpdate(Number(button.dataset.updateIndex), false)));
      card.querySelectorAll('.undo-same-name-update').forEach(button => button.addEventListener('click', () => {
        const index = Number(button.dataset.updateIndex);
        const action = card._sameNameActions.get(index);
        const row = button.closest('.same-name-update');
        if (!action || !row) return;
        card.querySelector('.knowledge-summary').value = action.previousSummary;
        card._sameNameActions.delete(index);
        if (!card._sameNameActions.size) delete card.dataset.updatesChanged;
        row.classList.remove('pending-remove');
        row.querySelectorAll('.apply-same-name-update,.dismiss-same-name-update').forEach(value => value.classList.remove('hidden'));
        button.classList.add('hidden');
        row.querySelector('.same-name-update-status').textContent = '';
      }));
      const stateDetails = card.querySelector('.character-current-state');
      if (!stateDetails) return;
      const editor = stateDetails.querySelector('.character-state-editor');
      const rows = stateDetails.querySelector('.character-state-edit-rows');
      const bindRemoveState = scope => scope.querySelectorAll('.remove-character-state').forEach(button => {
        button.onclick = () => button.closest('.character-state-edit-row')?.remove();
      });
      bindRemoveState(rows);
      stateDetails.querySelector('.edit-character-state').onclick = () => editor.classList.remove('hidden');
      stateDetails.querySelector('.cancel-character-state').onclick = () => editor.classList.add('hidden');
      stateDetails.querySelector('.add-character-state').onclick = () => {
        rows.insertAdjacentHTML('beforeend', characterStateEditRow());
        bindRemoveState(rows.lastElementChild);
        rows.lastElementChild?.querySelector('input')?.focus();
      };
      stateDetails.querySelector('.save-character-state').onclick = async event => {
        const button = event.currentTarget;
        const values = [...rows.querySelectorAll('.character-state-edit-row')].map(row => ({
          key: row.querySelector('.character-state-edit-key').value.trim(),
          value: row.querySelector('.character-state-edit-value').value.trim(),
          before: row.querySelector('.character-state-edit-before').value.trim(),
          reason: row.querySelector('.character-state-edit-reason').value.trim(),
          persistence: row.querySelector('.character-state-edit-persistence').value,
        }));
        if (values.some(value => !value.key || !value.value)) {
          stateDetails.querySelector('.character-state-status').textContent = '每项状态都需要填写“状态字段”和“当前内容”。'; return;
        }
        button.disabled = true;
        try {
          const knownKeys = (state.knowledgeItems.find(item => item.id === card.dataset.id)?.current_state || []).map(value => value.key);
          await api(`/api/projects/${projectId}/knowledge/${card.dataset.id}/state-snapshot`, jsonOptions('PUT', { states: values, known_keys: knownKeys }));
          await loadKnowledge();
          $w('#knowledge-hint').textContent = '人物当前状态快照已保存。';
          window.openKnowledgeItem?.(card.dataset.id);
        } catch (error) { stateDetails.querySelector('.character-state-status').textContent = `❌ ${error.message}`; }
        finally { button.disabled = false; }
      };
    });
    container.querySelectorAll('.optimize-knowledge-quotes').forEach(button => button.addEventListener('click', async () => {
      if (hasUnsavedCards()) { $w('#knowledge-hint').textContent = '有尚未保存的卡片修改，请先保存，再优化引文。'; return; }
      const card = button.closest('.knowledge-item');
      const item = state.knowledgeItems.find(entry => entry.id === card.dataset.id) || {};
      const sourceIds = item.source_chapter_ids || [];
      if (!sourceIds.length) { $w('#knowledge-hint').textContent = '这张卡片还没有来源章节，请先追加来源章节。'; return; }
      const editor = card.querySelector('.knowledge-quote-editor');
      const status = editor.querySelector('.knowledge-quote-status');
      button.disabled = true; status.textContent = `AI正在读取 ${sourceIds.length} 个来源章节并精简引文……`;
      editor.classList.remove('hidden');
      try {
        const result = await api(`/api/projects/${projectId}/knowledge/quotes/optimize`, jsonOptions('POST', {
          title: item.title, summary: item.summary,
          source_chapter_ids: sourceIds, source_quotes: item.source_quotes || [],
        }));
        editor.dataset.sourceChapterIds = JSON.stringify(result.source_chapter_ids || []);
        editor.querySelector('.knowledge-optimized-quotes').value = (result.source_quotes || []).join('\n\n');
        const names = (result.source_chapters || []).map(chapter => chapter.title).join('、');
        const notes = [`AI建议保留 ${result.source_quotes?.length || 0} 段引文${names ? `，来自：${names}` : ''}`];
        if (result.discarded_quotes) notes.push(`已丢弃 ${result.discarded_quotes} 段无法逐字定位的结果`);
        if (result.evidence_note) notes.push(result.evidence_note);
        status.textContent = notes.join('；') + '。请检查，确认后才会替换。';
      } catch (error) { status.textContent = `❌ ${error.message}`; }
      finally { button.disabled = false; }
    }));
    container.querySelectorAll('.cancel-optimized-knowledge-quotes').forEach(button => button.addEventListener('click', () => {
      button.closest('.knowledge-quote-editor').classList.add('hidden');
    }));
    container.querySelectorAll('.save-optimized-knowledge-quotes').forEach(button => button.addEventListener('click', async () => {
      if (hasUnsavedCards()) { $w('#knowledge-hint').textContent = '请先保存卡片名称、类型或内容的修改，再确认替换引文。'; return; }
      const editor = button.closest('.knowledge-quote-editor');
      const card = button.closest('.knowledge-item');
      const status = editor.querySelector('.knowledge-quote-status');
      let sourceIds = [];
      try { sourceIds = JSON.parse(editor.dataset.sourceChapterIds || '[]'); } catch (_) { sourceIds = []; }
      const sourceQuotes = parseKnowledgeQuoteText(editor.querySelector('.knowledge-optimized-quotes').value);
      button.disabled = true; status.textContent = '正在逐字核对并保存引文……';
      try {
        const result = await api(`/api/projects/${projectId}/knowledge/${card.dataset.id}/quotes`,
          jsonOptions('PUT', {source_chapter_ids: sourceIds, source_quotes: sourceQuotes}));
        await loadKnowledge();
        $w('#knowledge-hint').textContent = result.warning || `已替换为 ${result.item.source_quotes.length} 段引文，并只保留实际引用的来源章节。`;
        window.openKnowledgeItem?.(card.dataset.id);
      } catch (error) { status.textContent = `❌ ${error.message}`; button.disabled = false; }
    }));
    container.querySelectorAll('.manage-knowledge-sources').forEach(button => button.addEventListener('click', () => {
      if (state.knowledgeChoicesProject !== projectId || !state.knowledgeChoices.length) {
        $w('#knowledge-hint').textContent = '章节目录尚未载入，请稍后重试。'; return;
      }
      const card = button.closest('.knowledge-item');
      const editor = card.querySelector('.knowledge-source-editor');
      const item = state.knowledgeItems.find(entry => entry.id === card.dataset.id) || {};
      const existing = new Set(item.source_chapter_ids || []);
      const selected = new Set(existing);
      const search = editor.querySelector('.knowledge-source-search');
      editor.classList.remove('hidden');
      button.disabled = true;
      const renderOptions = () => {
        const query = search.value.trim().toLocaleLowerCase();
        const choices = state.knowledgeChoices.filter(chapter => chapter.has_text &&
          (!query || `${chapter.position || ''} ${chapter.title || ''}`.toLocaleLowerCase().includes(query)));
        editor.querySelector('.knowledge-source-options').innerHTML = choices.map(chapter => {
          const fixed = existing.has(chapter.id);
          return `<label class="knowledge-source-option ${fixed ? 'fixed' : ''}"><input type="checkbox" value="${esc(chapter.id)}" ${selected.has(chapter.id) ? 'checked' : ''} ${fixed ? 'disabled' : ''}><span>${esc(chapter.title || `第${chapter.position || ''}章`)}</span>${fixed ? '<small>已有来源</small>' : ''}</label>`;
        }).join('') || '<p class="hint">没有匹配的正文章节。</p>';
        editor.querySelectorAll('.knowledge-source-option input:not(:disabled)').forEach(box => box.addEventListener('change', () => {
          if (box.checked) selected.add(box.value); else selected.delete(box.value);
          editor.querySelector('.knowledge-source-status').textContent = `当前共选择 ${selected.size} 个来源章节，其中 ${existing.size} 个是原有来源。`;
        }));
        editor.querySelector('.knowledge-source-status').textContent = `当前共选择 ${selected.size} 个来源章节，其中 ${existing.size} 个是原有来源。`;
      };
      search.oninput = renderOptions;
      editor.querySelector('.cancel-knowledge-sources').onclick = () => {
        editor.classList.add('hidden'); button.disabled = false;
      };
      editor.querySelector('.save-knowledge-sources').onclick = async () => {
        editor.querySelectorAll('button,input').forEach(element => element.disabled = true);
        try {
          const knownIds = state.knowledgeChoices.map(chapter => chapter.id);
          const sourceChapterIds = knownIds.filter(id => selected.has(id));
          [...selected].filter(id => !knownIds.includes(id)).forEach(id => sourceChapterIds.push(id));
          await api(`/api/projects/${projectId}/knowledge/${card.dataset.id}`,
            jsonOptions('PUT', {
              type: card.querySelector('.knowledge-card-type').value,
              title: card.querySelector('.knowledge-card-title').value.trim(),
              summary: card.querySelector('.knowledge-summary').value,
              source_chapter_ids: sourceChapterIds,
              review_status: 'confirmed',
            }));
          await loadKnowledge();
          $w('#knowledge-hint').textContent = `卡片和来源章节已保存，目前共 ${sourceChapterIds.length} 个来源章节。`;
          window.openKnowledgeItem?.(card.dataset.id);
        } catch (error) {
          editor.querySelector('.knowledge-source-status').textContent = `❌ ${error.message}`;
          editor.querySelectorAll('button,input').forEach(element => element.disabled = false);
        }
      };
      renderOptions();
      search.focus();
    }));
    container.querySelectorAll('.manage-knowledge-tags').forEach(button => button.addEventListener('click', () => {
      if (hasUnsavedCards()) { $w('#knowledge-hint').textContent = '有尚未保存的卡片修改，请先保存，再编辑细分。'; return; }
      const card = button.closest('.knowledge-item'), editor = card.querySelector('.knowledge-tag-editor');
      const item = state.knowledgeItems.find(entry => entry.id === card.dataset.id) || {};
      const selected = new Set(Array.isArray(item.details?.tags) ? item.details.tags : []);
      const periods = window.KnowledgeTagPeriods.editor(item.details?.tag_periods || []);
      editor.querySelector('.tag-period-editor')?.remove();
      const periodHost = document.createElement('div'); periodHost.className = 'tag-period-editor';
      editor.querySelector('.knowledge-tag-selected').after(periodHost);
      const type = card.dataset.knowledgeType;
      const input = editor.querySelector('.knowledge-tag-input');
      editor.classList.remove('hidden'); button.disabled = true;
      const renderTags = () => {
        periods.render(periodHost, selected, state.knowledgeChoices);
        editor.querySelector('.knowledge-tag-selected').innerHTML = selected.size
          ? [...selected].map(tag => `<button class="knowledge-tag-chip selected" data-tag="${esc(tag)}" title="点击移除">${esc(tag)} ×</button>`).join('')
          : '<span class="hint">尚未选择细分</span>';
        const saved = state.knowledgeTagCatalog.card_tags?.[type] || [];
        editor.querySelector('.knowledge-tag-suggestions').innerHTML = saved.length
          ? `<span class="hint">已保存的${esc(KNOWLEDGE_TYPE_LABELS[type] || '')}细分：</span>` + saved.map(tag => `<span class="knowledge-tag-option"><button class="ghost knowledge-tag-choice ${selected.has(tag) ? 'active' : ''}" data-tag="${esc(tag)}">${esc(tag)}</button><button class="ghost danger knowledge-tag-delete" data-delete-tag="${esc(tag)}" title="删除这个细分类型" aria-label="删除细分${esc(tag)}">×</button></span>`).join('')
          : '<span class="hint">这个大类还没有保存过细分。输入一次并保存后，下次可直接点击。</span>';
        editor.querySelectorAll('[data-tag]').forEach(choice => choice.onclick = () => {
          const tag = choice.dataset.tag;
          if (selected.has(tag)) selected.delete(tag); else if (selected.size < 20) selected.add(tag);
          renderTags();
        });
        editor.querySelectorAll('[data-delete-tag]').forEach(choice => choice.onclick = async () => {
          const tag = choice.dataset.deleteTag;
          const usage = state.knowledgeTagCatalog.card_tag_usage?.[type]?.[tag] || 0;
          const impact = usage ? `这会同时从 ${usage} 张“${KNOWLEDGE_TYPE_LABELS[type] || type}”卡片中移除该细分及其生效、失效时间。` : '这会从该大类的复用选项中移除它。';
          if (!window.confirm(`删除细分“${tag}”？${impact}`)) return;
          editor.querySelectorAll('button,input,select').forEach(element => element.disabled = true);
          editor.querySelector('.knowledge-tag-status').textContent = '正在删除细分类型……';
          try {
            const result = await api(`/api/projects/${projectId}/knowledge/tag-catalog`,
              jsonOptions('DELETE', { card_type: type, tag }));
            state.knowledgeTagCatalog = result.tag_catalog || state.knowledgeTagCatalog;
            await loadKnowledge();
            $w('#knowledge-hint').textContent = `细分“${tag}”已删除${result.affected_cards ? `，并已从 ${result.affected_cards} 张卡片移除` : ''}。${result.warning || ''}`;
          } catch (error) {
            editor.querySelector('.knowledge-tag-status').textContent = `❌ ${error.message}`;
            editor.querySelectorAll('button,input,select').forEach(element => element.disabled = false);
          }
        });
      };
      const addTag = () => {
        const tag = input.value.trim();
        if (!tag) return;
        if (selected.size >= 20) { editor.querySelector('.knowledge-tag-status').textContent = '每张卡片最多选择20个细分。'; return; }
        selected.add(tag); input.value = ''; renderTags();
      };
      editor.querySelector('.add-knowledge-tag').onclick = addTag;
      input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); addTag(); } };
      editor.querySelector('.cancel-knowledge-tags').onclick = () => { editor.classList.add('hidden'); button.disabled = false; };
      editor.querySelector('.save-knowledge-tags').onclick = async () => {
        editor.querySelectorAll('button,input,select').forEach(element => element.disabled = true);
        try {
          const saved = await api(`/api/projects/${projectId}/knowledge/${card.dataset.id}`,
            jsonOptions('PUT', { tags: [...selected], tag_periods: periods.values(selected), review_status: 'confirmed' }));
          const index = state.knowledgeItems.findIndex(entry => entry.id === saved.id);
          if (index >= 0) state.knowledgeItems[index] = saved;
          const catalog = state.knowledgeTagCatalog.card_tags || (state.knowledgeTagCatalog.card_tags = {});
          const known = catalog[type] || (catalog[type] = []);
          [...selected].forEach(tag => { if (!known.some(value => value.toLowerCase() === tag.toLowerCase())) known.push(tag); });
          card.querySelector('.knowledge-subtype-chips').innerHTML = selected.size
            ? window.KnowledgeTagPeriods.chips(saved) : '<span class="hint">未标注</span>';
          updateKnowledgePreviewCard(saved);
          editor.querySelectorAll('button,input,select').forEach(element => element.disabled = false);
          editor.classList.add('hidden'); button.disabled = false; applyKnowledgeFilters();
          $w('#knowledge-hint').textContent = '细分及生效时间已保存；同类卡片可复用标签名称，时间按每张卡片单独设置。';
        } catch (error) { editor.querySelector('.knowledge-tag-status').textContent = `❌ ${error.message}`; editor.querySelectorAll('button,input,select').forEach(element => element.disabled = false); }
      };
      renderTags(); input.focus();
    }));
    container.querySelectorAll('.open-related-knowledge').forEach(button => button.addEventListener('click', async () => {
      if (hasUnsavedCards()) { $w('#knowledge-hint').textContent = '有尚未保存的卡片修改，请先保存，再跳转到关联知识。'; return; }
      state.knowledgeType = '';
      state.knowledgeQuery = '';
      $w('#knowledge-global-search').value = '';
      localStorage.setItem(`knowledgeSearch:${projectId}`, '');
      document.querySelectorAll('[data-ktype]').forEach(x => x.classList.toggle('active', x.dataset.ktype === ''));
      applyKnowledgeFilters();
      window.openKnowledgeItem?.(button.dataset.relatedId);
    }));
    container.querySelectorAll('.manage-relations').forEach(button => button.addEventListener('click', () => {
      if (hasUnsavedCards()) { $w('#knowledge-hint').textContent = '有尚未保存的卡片修改，请先保存，再管理关联。'; return; }
      const card = button.closest('.knowledge-item'), editor = card.querySelector('.relation-editor');
      const selected = new Map((state.knowledgeRelations[card.dataset.id] || []).map(item => [item.id, {
        label: item.label || '相关', direction: item.direction || 'out',
        layout_mode: workspaceRelationLayoutMode(item.label || '相关'),
        valid_from_chapter_id: item.valid_from_chapter_id || '',
        invalid_from_chapter_id: item.invalid_from_chapter_id || '',
      }]));
      let activeLabelInput = null;
      editor.classList.remove('hidden'); button.disabled = true;
      const commonLabels = state.knowledgeTagCatalog.relation_labels || [];
      editor.querySelector('.relation-label-library').innerHTML = commonLabels.length
        ? `<span class="hint">常用关系：</span>${commonLabels.map(label => `<button class="ghost relation-label-choice" data-label="${esc(label)}">${esc(label)}</button>`).join('')}`
        : '<span class="hint">保存过的关系名称会出现在这里，之后可以直接点击使用。</span>';
      editor.querySelectorAll('.relation-label-choice').forEach(choice => choice.addEventListener('click', () => {
        const target = activeLabelInput || editor.querySelector('.relation-option .relation-enabled:checked')?.closest('.relation-option')?.querySelector('.relation-label');
        if (!target) { $w('#knowledge-hint').textContent = '请先勾选一个关联，并点击它的关系名称输入框。'; return; }
        target.value = choice.dataset.label; target.dispatchEvent(new Event('input'));
      }));
      const renderOptions = () => {
        const query = editor.querySelector('.relation-search').value.trim().toLowerCase();
        const choices = state.knowledgeCatalog.filter(item => item.id !== card.dataset.id &&
          (!query || `${item.title} ${item.summary}`.toLowerCase().includes(query)) && (query || selected.has(item.id))).slice(0, 80);
        editor.querySelector('.relation-options').innerHTML = choices.map(item => {
          const relation = selected.get(item.id) || { label: '相关', direction: 'out', valid_from_chapter_id: '', invalid_from_chapter_id: '' };
          const layoutMode = relation.layout_mode || workspaceRelationLayoutMode(relation.label);
          return `<div class="relation-option" data-related-id="${esc(item.id)}"><label><input class="relation-enabled" type="checkbox" ${selected.has(item.id) ? 'checked' : ''}> ${esc(item.title)}</label><select class="relation-direction"><option value="out" ${relation.direction === 'out' ? 'selected' : ''}>本卡片 → 对方</option><option value="in" ${relation.direction === 'in' ? 'selected' : ''}>对方 → 本卡片</option></select><input class="relation-label" maxlength="80" value="${esc(relation.label)}" placeholder="关系，如：拥有"><label class="relation-layout-field"><span>自动排布时</span><select class="relation-layout-mode">${workspaceRelationLayoutOptions(layoutMode)}</select></label><div class="relation-period-fields"><label><span>建立于</span><select class="relation-valid-from">${relationChapterOptions(relation.valid_from_chapter_id, 'start')}</select></label><label><span>从本章起失效</span><select class="relation-invalid-from">${relationChapterOptions(relation.invalid_from_chapter_id, 'end')}</select></label></div><small>${esc(item.summary)}</small></div>`;
        }).join('') || '<p class="hint">输入名称或内容搜索卡片。</p>';
        editor.querySelectorAll('.relation-option').forEach(option => {
          const box = option.querySelector('.relation-enabled'), id = option.dataset.relatedId;
          const update = () => {
            if (box.checked) selected.set(id, {
              label: option.querySelector('.relation-label').value,
              layout_mode: option.querySelector('.relation-layout-mode').value,
              direction: option.querySelector('.relation-direction').value,
              valid_from_chapter_id: option.querySelector('.relation-valid-from').value,
              invalid_from_chapter_id: option.querySelector('.relation-invalid-from').value,
            });
            else selected.delete(id);
          };
          const labelInput = option.querySelector('.relation-label');
          const layoutSelect = option.querySelector('.relation-layout-mode');
          box.addEventListener('change', update);
          labelInput.addEventListener('input', () => { layoutSelect.innerHTML = workspaceRelationLayoutOptions(workspaceRelationLayoutMode(labelInput.value)); update(); });
          labelInput.addEventListener('focus', () => { activeLabelInput = labelInput; });
          layoutSelect.addEventListener('change', update);
          option.querySelectorAll('.relation-direction,.relation-valid-from,.relation-invalid-from').forEach(input => input.addEventListener('change', update));
        });
      };
      const focused = button.dataset.focusRelatedId;
      if (focused) editor.querySelector('.relation-search').value = state.knowledgeCatalog.find(item => item.id === focused)?.title || '';
      editor.querySelector('.relation-search').addEventListener('input', renderOptions); renderOptions();
      editor.querySelector('.cancel-relations').onclick = () => { editor.classList.add('hidden'); button.disabled = false; };
      editor.querySelector('.save-relations').onclick = async () => {
        if (selected.size > 50) { $w('#knowledge-hint').textContent = '每张卡片最多关联50张其他卡片。'; return; }
        if ([...selected.values()].some(relation => !relation.label.trim())) { $w('#knowledge-hint').textContent = '每个勾选关联都需要填写关系名称，例如“拥有”。'; return; }
        editor.querySelectorAll('button,input,select').forEach(el => el.disabled = true);
        try {
          const relations = [...selected].map(([related_id, relation]) => ({
            related_id, label: relation.label.trim(), direction: relation.direction,
            layout_mode: relation.layout_mode,
            valid_from_chapter_id: relation.valid_from_chapter_id || '',
            invalid_from_chapter_id: relation.invalid_from_chapter_id || '',
          }));
          await api(`/api/projects/${projectId}/knowledge/${card.dataset.id}/relations`, jsonOptions('PUT', { relations }));
          const known = state.knowledgeTagCatalog.relation_labels || (state.knowledgeTagCatalog.relation_labels = []);
          relations.forEach(relation => { if (!known.some(value => value.toLowerCase() === relation.label.toLowerCase())) known.push(relation.label); });
          const layouts = state.knowledgeTagCatalog.relation_layouts || (state.knowledgeTagCatalog.relation_layouts = {});
          relations.forEach(relation => { layouts[relation.label] = relation.layout_mode; });
          $w('#knowledge-hint').textContent = '关联已保存；以后合并任一关联卡片时，会把另一张作为只读核对依据。'; await loadKnowledge();
        } catch (error) { $w('#knowledge-hint').textContent = `❌ ${error.message}`; editor.querySelectorAll('button,input,select').forEach(el => el.disabled = false); }
      };
    }));
    container.querySelectorAll('.merge-select-knowledge').forEach(box => box.addEventListener('change', () => {
      const id = box.closest('.knowledge-item').dataset.id;
      if (box.checked) state.mergeSelection.add(id); else state.mergeSelection.delete(id);
      syncMergeCheckboxes(id); updateMergeSelection(); applyKnowledgeFilters();
    }));
    container.querySelectorAll('.save-knowledge-item').forEach(btn => btn.addEventListener('click', async () => {
      const item = btn.closest('.knowledge-item');
      const key = `${projectId}:${item.dataset.id}`;
      if (state.knowledgeMutations.has(key)) return;
      state.knowledgeMutations.add(key); btn.disabled = true;
      try {
        const nextType = item.querySelector('.knowledge-card-type').value;
        const nextTitle = item.querySelector('.knowledge-card-title').value.trim();
        const typeChanged = nextType !== item.dataset.knowledgeType;
        const titleChanged = nextTitle !== item.querySelector('.knowledge-card-title').defaultValue;
        const storedUpdates = state.knowledgeItems.find(entry => entry.id === item.dataset.id)?.details?.same_name_updates || [];
        const dismissSameNameUpdates = [...(item._sameNameActions?.keys() || [])].map(index => ({
          index, created_at: storedUpdates[index]?.created_at || '', summary: storedUpdates[index]?.summary || '',
        }));
        const saved = await api(`/api/projects/${projectId}/knowledge/${item.dataset.id}`, jsonOptions('PUT', {
          type: nextType, title: nextTitle,
          summary: item.querySelector('.knowledge-summary').value, review_status: 'confirmed',
          dismiss_same_name_updates: dismissSameNameUpdates,
        }));
        if (typeChanged || titleChanged || dismissSameNameUpdates.length) {
          state.mergeSelection.delete(item.dataset.id);
          await loadKnowledge();
          $w('#knowledge-hint').textContent = dismissSameNameUpdates.length
            ? `卡片已保存，并移除了 ${dismissSameNameUpdates.length} 条已处理的AI补充。`
            : typeChanged
            ? `卡片名称和内容已保存，并已改为“${KNOWLEDGE_TYPE_LABELS[nextType]}”。`
            : `卡片名称已改为“${saved.title}”并保存。`;
          window.openKnowledgeItem?.(item.dataset.id);
        } else {
          btn.textContent = '已确认';
          item.querySelector('.knowledge-card-title').value = saved.title;
          item.querySelector('.knowledge-card-title').defaultValue = saved.title;
          item.querySelector('.knowledge-head strong').textContent = saved.title;
          item.querySelector('.knowledge-summary').value = saved.summary;
          item.querySelector('.knowledge-summary').defaultValue = saved.summary;
          const index = state.knowledgeItems.findIndex(entry => entry.id === saved.id);
          if (index >= 0) state.knowledgeItems[index] = { ...state.knowledgeItems[index], ...saved };
          updateKnowledgePreviewCard(state.knowledgeItems[index] || saved);
        }
      } catch (error) { $w('#knowledge-hint').textContent = `❌ ${error.message}`; }
      finally { state.knowledgeMutations.delete(key); btn.disabled = false; }
    }));
    container.querySelectorAll('.delete-knowledge-item').forEach(btn => btn.addEventListener('click', () => {
      const item = btn.closest('.knowledge-item');
      const itemId = item.dataset.id;
      const key = `${projectId}:${itemId}`;
      if (state.knowledgeMutations.has(key) || item.querySelector('.knowledge-delete-confirm')) return;
      const title = item.querySelector('.knowledge-head strong').textContent;
      const confirmation = document.createElement('div');
      confirmation.className = 'knowledge-delete-confirm';
      confirmation.innerHTML = '<p>只删除这张知识卡片，不影响小说正文，之后可以恢复。本卡片未保存的修改不会保留。</p><div class="row"><button class="ghost cancel-delete-knowledge">取消</button><button class="danger confirm-delete-knowledge">确认删除</button></div>';
      item.append(confirmation);
      const cancel = confirmation.querySelector('.cancel-delete-knowledge');
      const accept = confirmation.querySelector('.confirm-delete-knowledge');
      cancel.addEventListener('click', () => confirmation.remove());
      accept.addEventListener('click', async () => {
        if (state.knowledgeMutations.has(key)) return;
        state.knowledgeMutations.add(key); btn.disabled = true; cancel.disabled = true; accept.disabled = true;
        try {
          await api(`/api/projects/${projectId}/knowledge/${itemId}`, { method: 'DELETE' });
          if ($w('#knowledge-project').value !== projectId) return;
          state.knowledgeItems = state.knowledgeItems.filter(entry => entry.id !== itemId);
          state.mergeSelection.delete(itemId); updateMergeSelection();
          closeKnowledgeDetail(true);
          await loadKnowledge();
          $w('#knowledge-hint').textContent = `已删除《${title}》，小说正文未改动；可在页面下方回收站恢复。`;
        } catch (error) { $w('#knowledge-hint').textContent = `❌ ${error.message}`; }
        finally { state.knowledgeMutations.delete(key); btn.disabled = false; cancel.disabled = false; accept.disabled = false; }
      });
    }));
  }

  async function loadKnowledge() {
    const projectId = $w('#knowledge-project').value || (state.project && state.project.id);
    const detailDialog = $w('#knowledge-detail-dialog');
    const openDetailId = detailDialog.open && detailDialog.dataset.projectId === projectId ? detailDialog.dataset.itemId : '';
    const preserveOpenEditor = openDetailId && knowledgeCardCoreDirty($w('#knowledge-detail-content').querySelector('.knowledge-item[data-id]'));
    state.auditSelectionSupported = false;
    if (!projectId || $w('#knowledge-settings-proposal').dataset.projectId !== projectId) {
      renderSettingProposal(projectId, null);
      $w('#knowledge-settings-status').textContent = '';
    }
    state.knowledgeSelectionSupported = false;
    updateKnowledgeSelectionSummary();
    if (!projectId) { closeKnowledgeDetail(true); state.knowledgeItems = []; state.knowledgePlotIndex = []; state.knowledgeInitialSettings = {}; state.knowledgeTagCatalog = { card_tags: {}, relation_labels: [], relation_layouts: {} }; $w('#knowledge-list').innerHTML = '<div class="empty-note">请选择一个创作项目。</div>'; renderPlotIndex('', []); $w('#knowledge-trash').classList.add('hidden'); state.knowledgeAwaitingReview = false; showKnowledgeVersionWarning(false); renderKnowledgeChapterPicker('', []); return; }
    if (state.knowledgeSearchProject !== projectId) {
      state.knowledgeSearchProject = projectId;
      state.knowledgeQuery = localStorage.getItem(`knowledgeSearch:${projectId}`) || '';
      $w('#knowledge-global-search').value = state.knowledgeQuery;
    }
    try {
      // 一次加载全部浏览卡片；完整编辑器只在独立详情窗口中渲染。
      const data = await api(`/api/projects/${projectId}/knowledge`);
      if ($w('#knowledge-project').value !== projectId) return;
      state.knowledgeChapterCharLimit = Number(data.knowledge_chapter_char_limit) || 30000;
      $w('#knowledge-target').max = String(state.knowledgeChapterCharLimit);
      $w('#knowledge-batch-limit-hint').textContent = `当前分析模型的知识整理单批正文上限为 ${state.knowledgeChapterCharLimit.toLocaleString()} 字；为避免长批次漏掉剧情，每批最多6个完整章节，不截断章节。`;
      renderKnowledgeMemory(projectId, data);
      const legacyItems = data.items || [];
      const plotIndex = data.plot_index_supported ? (data.plot_index || []) : legacyItems.filter(item => item.type === 'plot');
      const cardItems = legacyItems.filter(item => item.type !== 'plot');
      state.knowledgeItems = cardItems;
      state.knowledgePlotIndex = plotIndex;
      renderPlotIndex(projectId, plotIndex);
      const coverage = data.plot_coverage || {};
      const missing = coverage.missing_chapters || [];
      $w('#plot-index-count').textContent = `${plotIndex.length} 个剧情事件 · ${coverage.covered_chapters || 0}/${coverage.total_chapters || 0} 章达标`;
      $w('#plot-coverage-status').textContent = missing.length
        ? `仍有 ${missing.length} 章缺少足够的剧情事件：${missing.slice(0, 12).map(chapter => chapter.title).join('、')}${missing.length > 12 ? '……' : ''}。请勾选这些章节重新建立。`
        : '所有非空章节均已达到剧情事件覆盖要求；AI概括需人工核对，事件下方始终保留可展开的原文依据。';
      state.knowledgeCatalog = (data.knowledge_catalog || cardItems).filter(item => item.type !== 'plot');
      state.knowledgeRelations = data.knowledge_relations || {};
      state.knowledgeTagCatalog = data.tag_catalog || { card_tags: {}, relation_labels: [], relation_layouts: {} };
      renderKnowledgeTools(projectId, data);
      const choices = await readKnowledgeChapterChoices(projectId, data);
      if ($w('#knowledge-project').value !== projectId) return;
      state.knowledgeSelectionSupported = choices.supported;
      showKnowledgeVersionWarning(!choices.supported);
      state.knowledgeAwaitingReview = !!(data.pending_batches && data.pending_batches.length);
      renderKnowledgeChapterPicker(projectId, choices.chapters);
      populateManualKnowledgeChapters();
      renderManualKnowledgeSources();
      renderKnowledgeTrash(projectId, data.deleted_items || []);
      if (data.index_error) $w('#knowledge-hint').textContent = data.index_error;
      if (data.pending_batches && data.pending_batches.length) {
        $w('#knowledge-mode').value = data.pending_batches[0].mode || 'guided';
        renderKnowledgeReview(projectId, data.pending_batches[0]);
      }
      else $w('#knowledge-review').classList.add('hidden');
      if (data.active_task_id && !state.knowledgeTask) {
        state.knowledgeTask = data.active_task_id;
        openAiRunDrawer(data.active_task_id);
        $w('#knowledge-progress').classList.remove('hidden');
        $w('#build-knowledge-btn').disabled = true;
        updateKnowledgeSelectionSummary();
        pollProgress(data.active_task_id, 'knowledge-bar', 'knowledge-progress-text')
          .catch(error => { $w('#knowledge-hint').textContent = error.message; })
          .finally(async () => { state.knowledgeTask = ''; $w('#knowledge-progress').classList.add('hidden'); await loadKnowledge(); updateKnowledgeSelectionSummary(); });
      }
      const settingLabels = { concept: '故事概念', characters: '主要人物', worldbuilding: '世界观', style: '风格与限制', current_goal: '当前场景' };
      state.knowledgeInitialSettings = Object.fromEntries(Object.entries(settingLabels).filter(([key]) => data.project[key])
        .map(([key, label]) => [key, { label, text: data.project[key] }]));
      const settings = Object.entries(state.knowledgeInitialSettings).map(([key, setting]) =>
        knowledgeSettingPreviewHtml(key, setting.label, setting.text)).join('');
      const items = cardItems.length ? cardItems.map(knowledgeCardPreviewHtml).join('')
        : '<div class="empty-note knowledge-base-empty">知识库还是空的。请在上方勾选章节，再点击“为勾选章节建立知识库”。</div>';
      $w('#knowledge-list').innerHTML = settings + items;
      bindKnowledgePreviews($w('#knowledge-list'), projectId);
      applyKnowledgeFilters();
      if (openDetailId) {
        const openItem = state.knowledgeItems.find(item => item.id === openDetailId);
        if (!openItem) closeKnowledgeDetail(true);
        else if (!preserveOpenEditor) showKnowledgeDetailMarkup(openItem);
      } else if (detailDialog.open && detailDialog.dataset.projectId !== projectId) closeKnowledgeDetail(true);
      document.dispatchEvent(new CustomEvent('knowledge-loaded', { detail: { projectId, items: cardItems, plots: plotIndex } }));
    } catch (error) { state.knowledgeItems = []; state.knowledgePlotIndex = []; state.knowledgeInitialSettings = {}; $w('#knowledge-list').innerHTML = `<div class="empty-note">❌ ${esc(error.message)}</div>`; renderPlotIndex('', []); }
  }
  window.reloadWorkspaceKnowledge = loadKnowledge;
  window.knowledgeSelectionIds = () => state.knowledgeChoicesProject === $w('#knowledge-project').value ? Object.keys(state.knowledgeSelection) : [];
  window.setKnowledgeSection = section => {
    state.knowledgeSection = section;
    state.knowledgeType = '';
    document.querySelectorAll('[data-ksection]').forEach(b => b.classList.toggle('active', b.dataset.ksection === section));
    document.querySelectorAll('[data-ktype]').forEach(b => {
      b.classList.toggle('active', b.dataset.ktype === '');
      b.classList.toggle('hidden', section !== 'entity' || ['world', 'clue'].includes(b.dataset.ktype));
    });
    $w('#plot-index-panel').classList.toggle('hidden', section !== 'plot');
    $w('#clue-tools').classList.toggle('hidden', section !== 'plot');
    $w('#open-knowledge-graph').classList.toggle('hidden', section !== 'entity');
    $w('.knowledge-filter').classList.toggle('hidden', section === 'plot');
    $w('#knowledge-list').classList.toggle('hidden', section === 'plot');
    applyKnowledgeFilters();
    document.dispatchEvent(new CustomEvent('knowledge-section-changed'));
  };
  document.querySelectorAll('[data-ksection]').forEach(b => b.addEventListener('click', () => window.setKnowledgeSection(b.dataset.ksection)));
  window.openKnowledgeItem = id => {
    const item = state.knowledgeItems.find(i => i.id === id) || state.knowledgePlotIndex.find(i => i.id === id);
    if (!item) return;
    state.knowledgeQuery = ''; $w('#knowledge-global-search').value = '';
    window.setKnowledgeSection(item.type === 'world' ? 'world' : ['plot', 'clue'].includes(item.type) ? 'plot' : 'entity');
    if (item.type === 'clue') { if (!closeKnowledgeDetail()) return; return window.openClueDetail?.(id); }
    if (item.type !== 'plot') { openKnowledgeDetail(id); return; }
    if (!closeKnowledgeDetail()) return;
    const target = document.querySelector(`.plot-index-entry[data-id="${CSS.escape(id)}"]`);
    $w('#plot-index-content').classList.remove('hidden');
    document.dispatchEvent(new CustomEvent('clue-reset-filter'));
    target?.classList.remove('hidden'); target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  $w('#close-knowledge-detail').addEventListener('click', () => closeKnowledgeDetail());
  $w('#knowledge-detail-dialog').addEventListener('cancel', event => { event.preventDefault(); closeKnowledgeDetail(); });
  $w('#knowledge-detail-dialog').addEventListener('click', event => {
    if (event.target === event.currentTarget) closeKnowledgeDetail();
  });
  $w('#knowledge-detail-dialog').addEventListener('close', () => document.body.classList.remove('knowledge-detail-open'));

  function knowledgeSessionText(session) {
    if (!session || session.status === 'none') return '尚无整理会话。启用连续整理后，首次建立知识库时开始保存。';
    const usage = session.last_usage || {};
    let cache = '服务商未返回缓存命中数据。';
    if (Number.isInteger(usage.prompt_cache_hit_tokens)) {
      const total = usage.prompt_tokens || (usage.prompt_cache_hit_tokens + (usage.prompt_cache_miss_tokens || 0));
      cache = `最近一批：输入 ${total} tokens，缓存命中 ${usage.prompt_cache_hit_tokens}${total ? `（${Math.round(100 * usage.prompt_cache_hit_tokens / total)}%）` : ''}。`;
    }
    const available = session.status === 'active' && session.sources_current;
    return `${available ? '已保存，可续接' : '下次将开启新会话'} · ${session.turn_count || 0} 批 · 约 ${session.context_chars || 0} 字符。${cache} ${session.reset_reason || ''}`;
  }

  function readingSessionText(session) {
    if (!session || session.status === 'none') return '合并与查漏阅读会话：尚未建立；首次使用时会把完整章节前缀保存到本地。';
    const available = session.status === 'active' && session.sources_current;
    return `合并与查漏阅读会话：${available ? '可复用' : '下次将重建'} · 已读 ${session.read_chapters || 0} 章 · 正文约 ${(session.text_chars || 0).toLocaleString()} 字 · 已调用/复用 ${session.reuse_count || 0} 次。${session.last_reason || ''}`;
  }

  function renderKnowledgeMemory(projectId, data) {
    state.memorySupported = data.memory_features === true;
    const busy = !!(data.active_task_id || data.setting_task_id || data.knowledge_tool_task_id);
    $w('#knowledge-keep-context').disabled = !state.memorySupported || busy;
    $w('#knowledge-reset-session').disabled = !state.memorySupported || busy;
    $w('#knowledge-suggest-settings').disabled = !state.memorySupported || busy;
    $w('#knowledge-session-status').textContent = state.memorySupported ? knowledgeSessionText(data.session)
      : '当前后端尚不支持整理会话与设定提炼，请关闭旧服务窗口、重新启动程序后刷新。';
    $w('#knowledge-reading-session-status').textContent = state.memorySupported ? readingSessionText(data.reading_session)
      : '当前后端尚不支持合并与查漏阅读会话。';
    renderSettingProposal(projectId, data.setting_suggestion);
    if (data.setting_task_id && !state.settingTask) watchSettingTask(projectId, data.setting_task_id);
  }

  function renderSettingProposal(projectId, proposal) {
    const panel = $w('#knowledge-settings-proposal');
    if (!proposal || proposal.status !== 'pending') {
      panel.classList.add('hidden'); panel.dataset.proposalId = ''; return;
    }
    if (panel.dataset.projectId === projectId && panel.dataset.proposalId === proposal.id) return; // 切换筛选不丢编辑内容。
    panel.dataset.projectId = projectId; panel.dataset.proposalId = proposal.id;
    const labels = { concept: '故事简介', characters: '主要人物', worldbuilding: '世界观' };
    panel.innerHTML = `<h3>待确认的初始设定建议</h3><p class="hint">仅概括下列来源支持的阶段性内容，不代表全书结论。勾选要填写的字段，可以先修改文字；确认后保存到本地项目。</p>` +
      Object.entries(proposal.fields || {}).filter(([key]) => labels[key]).map(([key, value]) => {
        const existing = (proposal.baseline || {})[key] || '';
        const evidence = (proposal.evidence || []).filter(item => (value.knowledge_ids || []).includes(item.id));
        return `<div class="setting-proposal-field" data-field="${key}">
          <label><input type="checkbox" class="setting-apply-field" ${existing ? '' : 'checked'}> ${labels[key]}${existing ? '（勾选表示允许替换已有内容）' : '（填写空白项）'}</label>
          ${existing ? `<details><summary>查看现有内容（默认不替换）</summary><pre class="saved-research">${esc(existing)}</pre></details>` : ''}
          <textarea class="setting-suggestion-text" rows="5">${esc(value.text)}</textarea>
          <details><summary>查看提炼依据（${evidence.length}条知识）</summary>${evidence.map(item => `<div class="evidence-item"><strong>${esc(item.title)}</strong><p>${esc(item.summary)}</p>${(item.source_quotes || []).map(q => `<blockquote>${esc(q)}</blockquote>`).join('')}${sourceButtons(projectId, item.source_chapter_ids)}</div>`).join('')}</details>
        </div>`;
      }).join('') + '<div class="row"><button class="primary" id="apply-setting-suggestion">确认填写勾选项</button><button class="ghost" id="dismiss-setting-suggestion">不采用本次建议</button></div>';
    panel.classList.remove('hidden');
    bindSourceButtons(panel);
    $w('#apply-setting-suggestion').addEventListener('click', () => applySettingProposal(proposal));
    $w('#dismiss-setting-suggestion').addEventListener('click', () => dismissSettingProposal(proposal));
  }

  async function watchSettingTask(projectId, taskId) {
    state.settingTask = taskId;
    $w('#knowledge-settings-progress').classList.remove('hidden');
    $w('#knowledge-suggest-settings').disabled = true;
    try {
      const done = await pollProgress(taskId, 'knowledge-settings-bar', 'knowledge-settings-progress-text');
      if ($w('#knowledge-project').value === projectId) $w('#knowledge-settings-status').textContent = done.message;
    } catch (error) {
      if ($w('#knowledge-project').value === projectId) $w('#knowledge-settings-status').textContent = `❌ ${error.message}`;
    } finally {
      state.settingTask = ''; $w('#knowledge-settings-progress').classList.add('hidden'); await loadKnowledge();
    }
  }

  async function suggestProjectSettings() {
    const projectId = $w('#knowledge-project').value;
    if (!projectId || !state.memorySupported || state.settingTask) return;
    $w('#knowledge-suggest-settings').disabled = true;
    $w('#knowledge-settings-status').textContent = '正在读取已有知识…';
    try {
      const started = await api(`/api/projects/${projectId}/knowledge/settings/suggest`, jsonOptions('POST', {}));
      await watchSettingTask(projectId, started.task_id);
    } catch (error) {
      $w('#knowledge-settings-status').textContent = `❌ ${error.message}`;
      $w('#knowledge-suggest-settings').disabled = false;
    }
  }

  async function applySettingProposal(proposal) {
    const panel = $w('#knowledge-settings-proposal');
    const projectId = panel.dataset.projectId;
    const fields = [...panel.querySelectorAll('.setting-proposal-field')].filter(el => el.querySelector('.setting-apply-field').checked);
    if (!fields.length) { $w('#knowledge-settings-status').textContent = '请先勾选要填写的字段。'; return; }
    const selected = fields.map(el => el.dataset.field);
    const edited = Object.fromEntries(fields.map(el => [el.dataset.field, el.querySelector('textarea').value]));
    $w('#apply-setting-suggestion').disabled = true;
    try {
      await api(`/api/projects/${projectId}/knowledge/settings/apply`, jsonOptions('POST', {
        proposal_id: proposal.id, selected_fields: selected, edited,
        overwrite_fields: selected.filter(key => (proposal.baseline || {})[key]),
      }));
      $w('#knowledge-settings-status').textContent = '已填写勾选的初始设定；未勾选的原内容保持不变。';
      if ($w('#knowledge-project').value === projectId) { await loadProjects(projectId); await loadKnowledge(); }
    } catch (error) { $w('#knowledge-settings-status').textContent = `❌ ${error.message}`; }
    finally { if ($w('#apply-setting-suggestion')) $w('#apply-setting-suggestion').disabled = false; }
  }

  async function dismissSettingProposal(proposal) {
    const projectId = $w('#knowledge-settings-proposal').dataset.projectId;
    try {
      await api(`/api/projects/${projectId}/knowledge/settings/dismiss`, jsonOptions('POST', { proposal_id: proposal.id }));
      $w('#knowledge-settings-status').textContent = '未采用建议，原有初始设定没有改变。'; await loadKnowledge();
    } catch (error) { $w('#knowledge-settings-status').textContent = `❌ ${error.message}`; }
  }

  $w('#knowledge-suggest-settings').addEventListener('click', suggestProjectSettings);
  $w('#knowledge-reset-session').addEventListener('click', async () => {
    const projectId = $w('#knowledge-project').value;
    if (!projectId || !state.memorySupported) return;
    try {
      await api(`/api/projects/${projectId}/knowledge/session/reset`, jsonOptions('POST', {}));
      $w('#knowledge-settings-status').textContent = '下次整理将开启新会话，已有知识和正文不受影响。'; await loadKnowledge();
    } catch (error) { $w('#knowledge-settings-status').textContent = `❌ ${error.message}`; }
  });

  function auditRequestBody(mode, audit, selectedIds) {
    if (mode === 'selected') {
      if (!selectedIds.length) throw new Error('请先在上方章节列表勾选需要检查的章节。');
      return { chapter_ids: [...selectedIds], restart: true };
    }
    if (mode === 'all') return { restart: true };
    if (!audit?.id) throw new Error('没有可继续或重新检查的报告。');
    return { audit_id: audit.id, restart: mode === 'restart' };
  }

  function updateAuditControls() {
    const projectId = $w('#knowledge-project').value;
    const selected = state.knowledgeChoicesProject === projectId ? Object.keys(state.knowledgeSelection) : [];
    const supported = state.auditSelectionSupported && state.auditProject === projectId;
    const busy = state.auditBusy || !!(state.toolTask || state.knowledgeTask || state.settingTask);
    const disabled = !supported || busy || !projectId;
    const audit = state.auditProject === projectId ? state.currentAudit : null;
    $w('#start-selected-knowledge-audit').textContent = `检查勾选章节（${selected.length}）`;
    $w('#start-selected-knowledge-audit').disabled = disabled || !state.knowledgeSelectionSupported || !selected.length;
    $w('#start-knowledge-audit').disabled = disabled;
    $w('#continue-knowledge-audit').classList.toggle('hidden', !audit || audit.status === 'done');
    $w('#continue-knowledge-audit').disabled = disabled || !audit || audit.status === 'done';
    $w('#restart-knowledge-audit').classList.toggle('hidden', !audit);
    $w('#restart-knowledge-audit').disabled = disabled || !audit;
    $w('#clear-knowledge-audit').classList.toggle('hidden', !audit);
    $w('#clear-knowledge-audit').disabled = disabled || !audit;
    $w('#knowledge-audit-selection-hint').textContent = !supported && projectId
      ? '正在读取检查功能；若按钮持续不可用，请关闭旧服务窗口、重新启动程序并刷新，防止旧版忽略章节选择而检查全文。'
      : `共勾选 ${selected.length} 章，使用上方章节列表选择，支持不连续章节。查漏不会重新建立知识库；继续上次检查不受当前勾选影响。`;
  }

  async function requestAudit(mode) {
    const projectId = $w('#knowledge-project').value;
    // 独立能力标记：旧服务也支持知识工具，但会忽略 chapter_ids/audit_id。
    if (!projectId || !state.auditSelectionSupported || state.auditProject !== projectId) {
      $w('#knowledge-tools-status').textContent = '请先重启后端服务并刷新，再使用按章节查漏。'; return;
    }
    if (state.toolTask || state.knowledgeTask || state.settingTask || state.auditBusy) return;
    const selected = state.knowledgeChoicesProject === projectId ? Object.keys(state.knowledgeSelection) : [];
    try {
      const body = auditRequestBody(mode, state.currentAudit, selected);
      if (!(await saveChapter()) || projectId !== $w('#knowledge-project').value) return;
      if (mode === 'all' || mode === 'restart') {
        const audit = state.currentAudit;
        const scope = mode === 'all' || audit?.scope !== 'selected' ? '全文' : `原报告所选的 ${Object.keys(audit.chapter_titles || {}).length} 章`;
        state.pendingAuditRequest = { projectId, body };
        $w('#audit-restart-message').textContent = `将重新调用模型检查${scope}；本次范围不随当前勾选改变。已有报告仍保存在本地。确定开始吗？`;
        $w('#audit-restart-confirm').classList.remove('hidden'); return;
      }
      await startKnowledgeTool('audit/start', body);
    } catch (error) { $w('#knowledge-tools-status').textContent = `❌ ${error.message}`; }
  }

  function updateMergeSelection() {
    const button = $w('#merge-knowledge-selected');
    button.textContent = `合并勾选卡片（${state.mergeSelection.size}）`;
    button.disabled = !state.toolsSupported || !!(state.toolTask || state.knowledgeTask || state.settingTask) || state.mergeSelection.size < 2 || state.mergeSelection.size > 12;
    updateAutoMergeControl();
  }

  function renderKnowledgeTools(projectId, data) {
    state.toolsSupported = data.knowledge_tools === true;
    state.autoMergeSupported = data.auto_merge_supported === true;
    if (state.mergeProject !== projectId) { state.mergeSelection.clear(); state.mergeProject = projectId; }
    const busy = !!(data.active_task_id || data.setting_task_id || data.knowledge_tool_task_id);
    $w('#stop-auto-merge').disabled = !data.knowledge_tool_task_id || data.auto_merge_supported !== true;
    if (state.auditProject !== projectId || state.currentAudit?.id !== data.audit?.id) {
      state.pendingAuditRequest = null; $w('#audit-restart-confirm').classList.add('hidden');
      $w('#clear-audit-confirm').classList.add('hidden');
    }
    state.auditSelectionSupported = data.audit_chapter_selection === true;
    state.auditProject = projectId; state.currentAudit = data.audit || null; state.auditBusy = busy;
    updateAutoMergeControl();
    const audit = data.audit;
    updateAuditControls();
    if (!state.toolsSupported) $w('#knowledge-tools-status').textContent = '请重启后端服务并刷新，以使用合并和查漏功能。';
    const proposals = data.merge_proposals || [];
    const queue = $w('#merge-queue'), previousId = queue.value;
    $w('#merge-queue-field').classList.toggle('hidden', !proposals.length);
    queue.innerHTML = proposals.map(p => `<option value="${esc(p.id)}">${esc(p.item.title)} · ${p.originals.length} 张卡片</option>`).join('');
    queue.value = proposals.some(p => p.id === previousId) ? previousId : (proposals[0]?.id || '');
    queue.onchange = () => renderMergePreview(projectId, proposals.find(p => p.id === queue.value));
    renderMergePreview(projectId, proposals.find(p => p.id === queue.value) || data.merge_proposal);
    const history = $w('#knowledge-merge-history');
    history.classList.toggle('hidden', !(data.merge_history || []).length);
    history.querySelector('div').innerHTML = (data.merge_history || []).map(item => `<p><button class="ghost" data-merge-id="${esc(item.id)}">撤销：${esc(item.title)}</button></p>`).join('');
    history.querySelectorAll('button').forEach(button => button.addEventListener('click', () => finishMerge('undo', projectId, { id: button.dataset.mergeId }, {})));
    renderAuditReport(projectId, audit);
    if (data.knowledge_tool_task_id && !state.toolTask) watchKnowledgeTool(projectId, data.knowledge_tool_task_id);
    updateMergeSelection();
  }

  async function watchKnowledgeTool(projectId, taskId) {
    state.toolTask = taskId; updateMergeSelection();
    updateAuditControls();
    $w('#knowledge-tools-progress').classList.remove('hidden');
    $w('#start-knowledge-audit').disabled = true; $w('#restart-knowledge-audit').disabled = true;
    try {
      const done = await pollProgress(taskId, 'knowledge-tools-bar', 'knowledge-tools-progress-text');
      if ($w('#knowledge-project').value === projectId) $w('#knowledge-tools-status').textContent = done.message;
    } catch (error) {
      if ($w('#knowledge-project').value === projectId) $w('#knowledge-tools-status').textContent = `❌ ${error.message}`;
    } finally {
      state.toolTask = ''; $w('#knowledge-tools-progress').classList.add('hidden'); await loadKnowledge();
    }
  }

  async function startKnowledgeTool(path, body) {
    const projectId = $w('#knowledge-project').value;
    if (!projectId || !state.toolsSupported || state.toolTask) return;
    state.toolTask = 'starting'; updateMergeSelection();
    $w('#auto-merge-knowledge').disabled = true;
    $w('#stop-auto-merge').disabled = path !== 'merge/auto';
    updateAuditControls();
    try {
      const started = await api(`/api/projects/${projectId}/knowledge/${path}`, jsonOptions('POST', body));
      await watchKnowledgeTool(projectId, started.task_id);
    } catch (error) { state.toolTask = ''; updateMergeSelection(); updateAuditControls(); $w('#knowledge-tools-status').textContent = `❌ ${error.message}`; await loadKnowledge(); }
  }

  function mergeStateChangesHtml(proposal) {
    if (proposal.item?.type !== 'character') return '';
    const changes = proposal.state_changes || [];
    const warnings = proposal.state_change_warnings || [];
    return `<section class="merge-state-section"><h4>阶段状态候选</h4>
      <p class="hint">这些内容不会塞进长期人物档案。保留的候选会在确认合并时写入剧情状态事件，并立即更新人物的当前状态快照；不准确的候选可删除。</p>
      ${warnings.map(value => `<p class="hint">⚠ ${esc(value)}</p>`).join('')}
      <div class="merge-state-list">${changes.length ? changes.map(change => `<article class="evidence-item merge-state-change" data-id="${esc(change.id)}">
        <label class="field"><span>事件标题</span><input class="merge-state-title" maxlength="300" value="${esc(change.title || '')}"></label>
        <label class="field"><span>事件概括</span><textarea class="merge-state-summary" rows="2">${esc(change.summary || '')}</textarea></label>
        <div class="row"><label class="field"><span>状态字段</span><input class="merge-state-key" maxlength="200" value="${esc(change.state_key || '')}"></label>
        <label class="field"><span>持续性</span><select class="merge-state-persistence"><option value="unknown" ${change.persistence === 'unknown' ? 'selected' : ''}>待确认</option><option value="ongoing" ${change.persistence === 'ongoing' ? 'selected' : ''}>持续有效</option><option value="temporary" ${change.persistence === 'temporary' ? 'selected' : ''}>临时状态</option><option value="permanent" ${change.persistence === 'permanent' ? 'selected' : ''}>不可逆变化</option></select></label></div>
        <div class="row"><label class="field"><span>变化前</span><textarea class="merge-state-before" rows="2">${esc(change.state_before || '')}</textarea></label><label class="field"><span>变化后</span><textarea class="merge-state-after" rows="2">${esc(change.state_after || '')}</textarea></label></div>
        <label class="field"><span>变化原因</span><input class="merge-state-reason" maxlength="1200" value="${esc(change.change_reason || '')}"></label>
        <details><summary>查看状态依据 · ${esc(change.source_chapter_title || '来源章节')}</summary>${(change.source_quotes || []).map(quote => `<blockquote>${esc(quote)}</blockquote>`).join('')}${sourceButtons($w('#knowledge-project').value, change.source_chapter_id ? [change.source_chapter_id] : [])}</details>
        <button class="ghost danger remove-merge-state" type="button">不保留这条阶段状态</button>
      </article>`).join('') : '<p class="hint">模型没有从所选卡片中找到有可靠依据的阶段变化。合并只会保存稳定档案。</p>'}</div></section>`;
  }

  function collectMergeStateChanges(panel) {
    return [...panel.querySelectorAll('.merge-state-change')].map(row => ({
      id: row.dataset.id, title: row.querySelector('.merge-state-title').value,
      summary: row.querySelector('.merge-state-summary').value,
      state_key: row.querySelector('.merge-state-key').value,
      state_before: row.querySelector('.merge-state-before').value,
      state_after: row.querySelector('.merge-state-after').value,
      change_reason: row.querySelector('.merge-state-reason').value,
      persistence: row.querySelector('.merge-state-persistence').value,
    }));
  }

  function renderMergePreview(projectId, proposal) {
    const panel = $w('#knowledge-merge-preview');
    if (!proposal || ['dismissed','undone'].includes(proposal.status)) { panel.classList.add('hidden'); panel.dataset.key = ''; return; }
    const key = `${projectId}:${proposal.id}:${proposal.status}`;
    if (panel.dataset.key === key) return;
    panel.dataset.key = key; panel.classList.remove('hidden');
    if (proposal.status === 'applied') {
      panel.innerHTML = '<p>已合并相关卡片，原卡片及其出处仍保存在本地。</p><button class="ghost undo-knowledge-merge">撤销这次合并</button>';
      panel.querySelector('button').addEventListener('click', () => finishMerge('undo', projectId, proposal, {})); return;
    }
    panel.innerHTML = `<h3>合并草稿 · 请检查阶段变化与冲突</h3><select class="merge-type">${knowledgeTypeOptions(proposal.item.type, false)}</select>
      <input class="merge-title" value="${esc(proposal.item.title)}" aria-label="合并标题">
      <textarea class="merge-summary" rows="6" aria-label="合并内容">${esc(proposal.item.summary)}</textarea>
      ${mergeStateChangesHtml(proposal)}
      <textarea class="merge-regenerate-instruction" rows="2" maxlength="2000" aria-label="重新生成要求" placeholder="重新生成要求（可选），例如：突出后期已确认的结论"></textarea>
      ${(proposal.evidence_chapters || []).length ? `<details><summary>查看本次判断依据章节（${proposal.evidence_chapters.length}章）</summary><p>${proposal.evidence_chapters.map(chapter => esc(chapter.title)).join('、')}</p>${sourceButtons(projectId, proposal.evidence_chapters.map(chapter => chapter.id))}</details>` : ''}
      <details><summary>查看 ${proposal.originals.length} 张原卡片及其出处</summary>${proposal.originals.map(item => `<div class="evidence-item"><strong>${esc(item.title)}</strong><p>${esc(item.summary)}</p>${(item.source_quotes || []).map(q => `<blockquote>${esc(q)}</blockquote>`).join('')}${sourceButtons(projectId, item.source_chapter_ids)}</div>`).join('')}</details>
      ${(proposal.related || []).length ? `<details><summary>查看 ${proposal.related.length} 张只读关联依据</summary><p class="hint">这些卡片帮助模型核对已经记录的事实，不会被本次合并或隐藏。</p>${proposal.related.map(item => `<div class="evidence-item"><strong>${esc(item.title)}</strong><small>${esc(item.relation_reason || '')}</small><p>${esc(item.summary)}</p>${(item.source_quotes || []).map(q => `<blockquote>${esc(q)}</blockquote>`).join('')}${sourceButtons(projectId, item.source_chapter_ids)}</div>`).join('')}</details>` : '<p class="hint">本次没有找到其他明确相关的知识卡片。</p>'}
      <div class="row"><button class="primary accept-knowledge-merge">确认合并</button><button class="ghost regenerate-knowledge-merge">快速重新生成</button><button class="ghost dismiss-knowledge-merge">取消本次合并</button></div>
      <p class="hint">快速重新生成只复用这组卡片和关联依据，不重新通读勾选章节，也不重新扫描全部知识卡片。</p>`;
    bindSourceButtons(panel);
    panel.querySelectorAll('.remove-merge-state').forEach(button => button.addEventListener('click', () => button.closest('.merge-state-change').remove()));
    panel.querySelector('.accept-knowledge-merge').addEventListener('click', () => finishMerge('apply', projectId, proposal, {
      type: panel.querySelector('.merge-type').value, title: panel.querySelector('.merge-title').value, summary: panel.querySelector('.merge-summary').value,
      state_changes: collectMergeStateChanges(panel),
    }));
    panel.querySelector('.regenerate-knowledge-merge').addEventListener('click', () => startKnowledgeTool('merge/regenerate', {
      proposal_id: proposal.id, instruction: panel.querySelector('.merge-regenerate-instruction').value.trim(),
    }));
    panel.querySelector('.dismiss-knowledge-merge').addEventListener('click', () => finishMerge('dismiss', projectId, proposal, {}));
  }

  async function finishMerge(action, projectId, proposal, edited) {
    const panel = $w('#knowledge-merge-preview');
    panel.querySelectorAll('button').forEach(b => b.disabled = true);
    try {
      const result = await api(`/api/projects/${projectId}/knowledge/merge/${action}`, jsonOptions('POST', { proposal_id: proposal.id, edited }));
      state.mergeSelection.clear();
      $w('#knowledge-tools-status').textContent = result.warning || ({apply:'合并已保存，原卡片可通过撤销合并恢复。', undo:'已恢复原卡片。', dismiss:'未合并，原卡片没有改变。'})[action];
      await loadKnowledge();
    } catch (error) { $w('#knowledge-tools-status').textContent = `❌ ${error.message}`; }
    finally { panel.querySelectorAll('button').forEach(b => b.disabled = false); }
  }

  function renderAuditReport(projectId, audit) {
    const panel = $w('#knowledge-audit-report');
    if (!audit) { panel.classList.add('hidden'); panel.dataset.key = ''; return; }
    const key = `${projectId}:${audit.id}:${audit.status}:${audit.next_group}:${(audit.findings || []).map(f => f.status).join(',')}:${(audit.discarded_findings || []).length}`;
    if (panel.dataset.key === key) return;
    panel.dataset.key = key; panel.classList.remove('hidden');
    const checked = audit.checked_ids || [], total = Object.keys(audit.chapter_titles || {}).length;
    const findings = audit.findings || [];
    const discarded = audit.discarded_findings || [];
    panel.innerHTML = `<h3>${audit.scope === 'selected' ? '所选章节' : '全文'}查漏报告</h3><p>范围：${audit.scope === 'selected' ? '仅所选章节，非全文检查' : '全文'}。已检查 ${checked.length}/${total} 章 · 疑似遗漏 ${findings.length} 条${audit.status === 'done' ? ' · 检查完成' : ' · 尚未检查完毕'}</p>
      ${audit.error ? `<p class="hint">${esc(audit.error)}</p>` : ''}
      ${discarded.length ? `<details class="audit-discarded"><summary>已自动跳过 ${discarded.length} 条无法核对原文的候选</summary><p class="hint">这些候选不会补入知识库，也不会阻止后续章节继续检查。</p>${discarded.map(item => `<div class="evidence-item"><strong>${esc(item.title || '未命名候选')}</strong><p>${esc(item.reason || '无法核对原文')}</p>${(item.source_quotes || []).map(quote => `<blockquote>${esc(quote)}</blockquote>`).join('')}${sourceButtons(projectId, item.source_chapter_ids || [])}</div>`).join('')}</details>` : ''}
      <details><summary>查看本次检查范围（${total}章）</summary><p>${Object.values(audit.chapter_titles || {}).map(esc).join('、')}</p></details>
      <details><summary>查看已检查章节</summary><p>${checked.map(id => esc(audit.chapter_titles[id] || id)).join('、') || '尚未完成章节检查。'}</p></details>
      <p class="hint">${findings.length ? '逐条检查：可先编辑内容，再直接补入知识库或忽略；未处理项会继续保留。' : (audit.status === 'done' ? '本次未发现疑似遗漏，不代表能保证完全没有遗漏。' : '可以继续检查剩余章节。')}</p>` +
      findings.map(item => `<div class="audit-finding" data-id="${esc(item.id)}">
        ${item.status === 'pending' ? `<div class="row"><strong>${esc(item.title)} · 疑似遗漏</strong><label class="field compact-field"><span>保存类型</span><select class="audit-finding-type">${knowledgeTypeOptions(item.type)}</select></label></div><textarea rows="3">${esc(item.summary)}</textarea><div class="row audit-finding-actions"><button class="primary apply-one-audit-finding">补入知识库</button><button class="ghost dismiss-one-audit-finding">忽略</button></div>` : `<strong>${esc(item.title)} · ${item.status === 'added' ? '已补入' : '已忽略'}</strong><p>${esc(item.summary)}</p>`}
        <p class="hint">${esc(item.reason)}</p>${item.source_quotes.map(q => `<blockquote>${esc(q)}</blockquote>`).join('')}${sourceButtons(projectId, item.source_chapter_ids)}</div>`).join('') +
      '';
    bindSourceButtons(panel);
    panel.querySelectorAll('.audit-finding[data-id]').forEach(finding => {
      finding.querySelector('.apply-one-audit-finding')?.addEventListener('click', () => reviewAuditFinding(projectId, audit, finding, true));
      finding.querySelector('.dismiss-one-audit-finding')?.addEventListener('click', () => reviewAuditFinding(projectId, audit, finding, false));
    });
  }

  async function reviewAuditFinding(projectId, audit, finding, accepted) {
    const buttons = finding.querySelectorAll('button');
    buttons.forEach(button => button.disabled = true);
    try {
      const result = await api(`/api/projects/${projectId}/knowledge/audit/review`, jsonOptions('POST', {
        audit_id: audit.id, decisions: [{ id: finding.dataset.id,
          type: finding.querySelector('.audit-finding-type')?.value,
          summary: finding.querySelector('textarea').value, accepted }],
      }));
      $w('#knowledge-tools-status').textContent = result.warning || (accepted ? '这一条已补入知识库。' : '这一条已忽略，没有修改知识库。');
      await loadKnowledge();
    } catch (error) { $w('#knowledge-tools-status').textContent = `❌ ${error.message}`; }
    finally { buttons.forEach(button => button.disabled = false); }
  }

  $w('#auto-merge-knowledge').addEventListener('click', async () => {
    const projectId = $w('#knowledge-project').value;
    const chapterIds = selectedKnowledgeChapterIds();
    if (!chapterIds.length) { $w('#knowledge-tools-status').textContent = '请先在页面上方勾选要作为判断依据的章节。'; return; }
    const unsaved = hasUnsavedKnowledgeCards();
    if (unsaved) { $w('#knowledge-tools-status').textContent = '有尚未保存的卡片修改，请先保存后再自动合并。'; return; }
    const maxGroups = Number($w('#auto-merge-limit').value);
    if (!Number.isInteger(maxGroups) || maxGroups < 1 || maxGroups > 20) { $w('#knowledge-tools-status').textContent = '每次组数应为1～20之间的整数。'; return; }
    if (!(await saveChapter()) || projectId !== $w('#knowledge-project').value) return;
    startKnowledgeTool('merge/auto', { chapter_ids: chapterIds, max_groups: maxGroups, apply_automatically: $w('#auto-merge-apply').checked });
  });
  $w('#stop-auto-merge').addEventListener('click', async () => {
    const projectId = $w('#knowledge-project').value;
    if (!projectId) return;
    try {
      await api(`/api/projects/${projectId}/knowledge/merge/stop`, jsonOptions('POST', {}));
      $w('#knowledge-tools-status').textContent = '已请求停止，当前模型调用结束后停止；已有草稿和合并结果保留。';
    } catch (error) { $w('#knowledge-tools-status').textContent = `❌ ${error.message}`; }
  });
  $w('#merge-knowledge-selected').addEventListener('click', () => {
    const unsaved = hasUnsavedKnowledgeCards(true);
    if (unsaved) { $w('#knowledge-tools-status').textContent = '所选卡片有未保存的修改，请先保存为用户确认，再合并。'; return; }
    startKnowledgeTool('merge/suggest', { item_ids: [...state.mergeSelection] });
  });
  $w('#clear-merge-selection').addEventListener('click', () => { state.mergeSelection.clear(); document.querySelectorAll('.merge-select-knowledge').forEach(box => box.checked = false); updateMergeSelection(); });
  $w('#start-selected-knowledge-audit').addEventListener('click', () => requestAudit('selected'));
  $w('#clear-knowledge-audit').addEventListener('click', () => {
    const panel = $w('#clear-audit-confirm');
    panel.dataset.project = $w('#knowledge-project').value; panel.classList.remove('hidden');
  });
  $w('#cancel-clear-audit').addEventListener('click', () => $w('#clear-audit-confirm').classList.add('hidden'));
  $w('#confirm-clear-audit').addEventListener('click', async () => {
    const projectId = $w('#clear-audit-confirm').dataset.project;
    if (!projectId || projectId !== $w('#knowledge-project').value) return;
    $w('#confirm-clear-audit').disabled = true;
    try {
      await api(`/api/projects/${projectId}/knowledge/audit/clear`, jsonOptions('POST', {}));
      $w('#clear-audit-confirm').classList.add('hidden');
      $w('#knowledge-tools-status').textContent = '查漏报告已清空，正文和知识卡片未改动。';
      await loadKnowledge();
    } catch (error) { $w('#knowledge-tools-status').textContent = `❌ ${error.message}`; }
    finally { $w('#confirm-clear-audit').disabled = false; }
  });
  $w('#start-knowledge-audit').addEventListener('click', () => requestAudit('all'));
  $w('#continue-knowledge-audit').addEventListener('click', () => requestAudit('resume'));
  $w('#restart-knowledge-audit').addEventListener('click', () => requestAudit('restart'));
  $w('#cancel-restart-audit').addEventListener('click', () => { state.pendingAuditRequest = null; $w('#audit-restart-confirm').classList.add('hidden'); });
  $w('#confirm-restart-audit').addEventListener('click', () => {
    const pending = state.pendingAuditRequest;
    state.pendingAuditRequest = null; $w('#audit-restart-confirm').classList.add('hidden');
    if (!pending || pending.projectId !== $w('#knowledge-project').value || !state.auditSelectionSupported) return;
    startKnowledgeTool('audit/start', pending.body);
  });
  $w('#stop-knowledge-audit').addEventListener('click', async () => {
    const projectId = $w('#knowledge-project').value;
    if (!projectId) return;
    try { await api(`/api/projects/${projectId}/knowledge/audit/stop`, jsonOptions('POST', {})); $w('#knowledge-tools-status').textContent = '已请求暂停，当前批次检查完成后停止。'; }
    catch (error) { $w('#knowledge-tools-status').textContent = `❌ ${error.message}`; }
  });

  window.restoreReferenceSelection = function restoreReferenceSelection() {
    document.querySelectorAll('.reference-select').forEach(box => {
      box.checked = state.selectedRefs.has(box.dataset.id);
      box.onchange = async () => {
        if (box.checked) state.selectedRefs.add(box.dataset.id); else state.selectedRefs.delete(box.dataset.id);
        localStorage.setItem('selectedReferenceIds', JSON.stringify([...state.selectedRefs]));
      };
    });
  };

  async function saveProjectMeta() {
    if (!state.project) return;
    const updated = await api(`/api/projects/${state.project.id}`, jsonOptions('PUT', {
      name: $w('#meta-project-name').value,
      concept: $w('#meta-project-concept').value,
      characters: $w('#meta-project-characters').value,
      worldbuilding: $w('#meta-project-world').value,
      style: $w('#meta-project-style').value,
      current_goal: $w('#meta-project-goal').value,
    }));
    state.project = { ...state.project, ...updated };
    renderProjectLists(); populateProjectSelects(); syncWorkspaceSelectors();
    $w('#project-editor-hint').textContent = '初始设定已作为用户确认信息保存。';
  }

  async function loadProjectNotes() {
    if (!state.project) return;
    try {
      const [data, history] = await Promise.all([api(`/api/projects/${state.project.id}/notes`), api(`/api/projects/${state.project.id}/analysis-sessions`)]);
      $w('#project-notes').innerHTML = data.notes.length ? data.notes.map(note => `
        <article class="project-note"><strong>${esc(note.title)}</strong><small>${esc(note.created_at)}${note.query ? ` · ${esc(note.query)}` : ''}</small>
        <details><summary>展开检索结果</summary><pre class="saved-research">${esc(buildMarkdown(note.payload))}</pre></details></article>`).join('')
        : '<div class="empty-note">还没有保存记录。</div>';
      $w('#project-notes').insertAdjacentHTML('beforeend', (history.sessions || []).map(session => `<button class="ghost open-project-session" data-session="${esc(session.session_id)}">继续原稿分析 · ${esc(session.created_at)}</button>`).join(''));
      $w('#project-notes').querySelectorAll('.open-project-session').forEach(button => button.addEventListener('click', async () => {
        const session = await api(`/api/draft/${button.dataset.session}`);
        navigate('workbench'); renderDraftSession(session);
      }));
    } catch (error) { $w('#project-notes').innerHTML = `<div class="empty-note">❌ ${esc(error.message)}</div>`; }
  }

  async function saveCurrentResult() {
    const payload = window.currentSearchExport && window.currentSearchExport();
    if (!payload) return;
    const name = prompt('输入要保存到的小说项目名称；如果名称不存在，将创建一个空项目。', state.project ? state.project.name : '');
    if (!name || !name.trim()) return;
    let project = state.projects.find(item => item.name === name.trim());
    if (!project) project = await api('/api/projects', jsonOptions('POST', { name: name.trim() }));
    if (payload.mode === 'draft' && payload.session && payload.session.id) {
      await api(`/api/draft/${payload.session.id}/project`, jsonOptions('POST', { project_id: project.id }));
    }
    await api(`/api/projects/${project.id}/notes`, jsonOptions('POST', {
      title: payload.mode === 'draft' ? '原稿分析与范本参考' : `范本检索：${payload.query || '未命名需求'}`,
      query: payload.query || '', payload,
    }));
    await loadProjects(project.id);
    $w(payload.mode === 'draft' ? '#draft-hint' : '#search-hint').textContent = `已保存到《${project.name}》的检索记录。`;
  }

  $w('#new-project-btn').addEventListener('click', () => showCreateProject(false));
  $w('#cancel-project-create').addEventListener('click', () => $w('#project-create-panel').classList.add('hidden'));
  $w('#create-project-submit').addEventListener('click', createProject);
  $w('#add-chapter-btn').addEventListener('click', addChapter);
  $w('#delete-chapter-btn').addEventListener('click', deleteChapter);
  $w('#split-chapter-btn').addEventListener('click', splitChapter);
  $w('#merge-chapter-btn').addEventListener('click', mergeWithNextChapter);
  $w('#move-chapter-up').addEventListener('click', () => moveChapter(-1));
  $w('#move-chapter-down').addEventListener('click', () => moveChapter(1));
  $w('#chapter-version-panel').addEventListener('toggle', event => {
    if (event.target.open) loadChapterVersions();
  });
  $w('#refresh-chapter-versions').addEventListener('click', loadChapterVersions);
  $w('#compare-chapter-version').addEventListener('click', compareChapterVersion);
  $w('#delete-project-btn').addEventListener('click', deleteProject);
  $w('#chapter-title').addEventListener('input', scheduleSave);
  $w('#chapter-editor-text').addEventListener('input', scheduleSave);
  $w('#editor-chapter').addEventListener('change', async () => {
    const id = $w('#editor-chapter').value;
    if (!(await saveChapter())) return;
    state.chapter = state.chapters.find(c => c.id === id) || null;
    renderEditor(); syncWorkspaceSelectors();
  });
  $w('#workspace-project').addEventListener('change', async e => { const id = e.target.value; await selectProject(id); });
  $w('#workspace-chapter').addEventListener('change', async e => {
    const id = e.target.value;
    if (!(await saveChapter())) return;
    state.selectionStart = null; state.selectionEnd = null;
    state.chapter = state.chapters.find(c => c.id === id) || null;
    renderEditor(); syncWorkspaceSelectors();
  });
  $w('#knowledge-project').addEventListener('change', async e => {
    const previousProjectId = state.project?.id || '';
    if ($w('#knowledge-detail-dialog').open && !closeKnowledgeDetail()) { e.target.value = previousProjectId; return; }
    state.aiRunId = '';
    await selectProject(e.target.value);
    loadKnowledge();
    if (!$w('#knowledge-ai-run-drawer').classList.contains('hidden')) loadAiRunList();
  });
  $w('#project-import-file').addEventListener('change', e => { importProject(e.target.files[0]); e.target.value = ''; });
  $w('#analyze-selection-btn').addEventListener('click', () => analyzeEditor(true));
  $w('#analyze-paragraph-btn').addEventListener('click', () => {
    const editor = $w('#chapter-editor-text');
    const start = editor.value.lastIndexOf('\n', Math.max(0, editor.selectionStart - 1)) + 1;
    const end = editor.value.indexOf('\n', editor.selectionStart);
    editor.setSelectionRange(start, end < 0 ? editor.value.length : end);
    analyzeEditor(true);
  });
  $w('#analyze-chapter-btn').addEventListener('click', () => analyzeEditor(false));
  $w('#save-project-meta').addEventListener('click', () => saveProjectMeta().catch(error => {
    $w('#project-editor-hint').textContent = `❌ ${error.message}`;
  }));
  $w('#build-knowledge-btn').addEventListener('click', () => buildKnowledge(false));
  $w('#knowledge-accept-existing').addEventListener('click', acceptExistingChapterKnowledge);
  $w('#open-knowledge-ai-runs').addEventListener('click', () => openAiRunDrawer(state.knowledgeTask || ''));
  $w('#close-knowledge-ai-runs').addEventListener('click', closeAiRunDrawer);
  $w('#refresh-knowledge-ai-run').addEventListener('click', () => loadAiRunList(state.aiRunId));
  $w('#knowledge-ai-run-select').addEventListener('change', event => {
    state.aiRunId = event.target.value;
    loadAiRunDetail(state.aiRunId);
  });
  document.querySelectorAll('[data-ai-run-view]').forEach(button => button.addEventListener('click', () => {
    state.aiRunView = button.dataset.aiRunView;
    document.querySelectorAll('[data-ai-run-view]').forEach(item => item.classList.toggle('active', item === button));
    if (state.aiRunId) loadAiRunDetail(state.aiRunId);
  }));
  $w('#knowledge-mode').addEventListener('change', saveKnowledgeBuildPreferences);
  $w('#knowledge-target').addEventListener('input', saveKnowledgeBuildPreferences);
  $w('#knowledge-repair-index').addEventListener('click', () => buildKnowledge(true));
  $w('#knowledge-select-by-target').addEventListener('click', () => selectKnowledgeChapters('target'));
  $w('#knowledge-select-pending').addEventListener('click', () => selectKnowledgeChapters('pending'));
  $w('#knowledge-select-all').addEventListener('click', () => selectKnowledgeChapters('all'));
  $w('#knowledge-clear-selection').addEventListener('click', () => selectKnowledgeChapters('clear'));
  $w('#stop-knowledge-btn').addEventListener('click', async () => {
    const projectId = $w('#knowledge-project').value;
    if (!projectId) return;
    await api(`/api/projects/${projectId}/knowledge/stop`, { method: 'POST' });
    $w('#knowledge-hint').textContent = '已请求暂停，当前批次完成后停止；下次更新会继续剩余章节。';
  });
  $w('#save-default-references').addEventListener('click', async () => {
    if (!state.project) { alert('请先选择一个创作项目。独立检索无需保存默认范本。'); return; }
    try {
      await api(`/api/projects/${state.project.id}/references`, jsonOptions('PUT', { reference_ids: [...state.selectedRefs] }));
      state.project.reference_ids = [...state.selectedRefs];
      alert(`已保存为《${state.project.name}》的默认范本。`);
    } catch (error) { alert(error.message); }
  });
  document.querySelectorAll('[data-ktype]').forEach(btn => btn.addEventListener('click', () => {
    state.knowledgeType = btn.dataset.ktype;
    document.querySelectorAll('[data-ktype]').forEach(x => x.classList.toggle('active', x === btn));
    applyKnowledgeFilters();
  }));
  let knowledgeSearchTimer = null;
  $w('#knowledge-global-search').addEventListener('input', event => {
    state.knowledgeQuery = event.target.value;
    const projectId = $w('#knowledge-project').value;
    if (projectId) localStorage.setItem(`knowledgeSearch:${projectId}`, state.knowledgeQuery);
    clearTimeout(knowledgeSearchTimer);
    knowledgeSearchTimer = setTimeout(applyKnowledgeFilters, 120);
  });
  $w('#clear-knowledge-search').addEventListener('click', () => {
    clearTimeout(knowledgeSearchTimer);
    state.knowledgeQuery = '';
    $w('#knowledge-global-search').value = '';
    const projectId = $w('#knowledge-project').value;
    if (projectId) localStorage.setItem(`knowledgeSearch:${projectId}`, '');
    applyKnowledgeFilters();
    $w('#knowledge-global-search').focus();
  });
  let manualSourceAnchor = '';
  function filteredManualSourceChapters() {
    const query = $w('#manual-knowledge-source-search').value.trim().toLocaleLowerCase();
    return state.knowledgeChoices.filter(chapter => !query ||
      `${chapter.position} ${chapter.title}`.toLocaleLowerCase().includes(query));
  }
  function populateManualKnowledgeChapters() {
    const list = $w('#manual-knowledge-chapter');
    const chapters = filteredManualSourceChapters();
    list.innerHTML = chapters.map(chapter => `<label class="manual-source-option"><input type="checkbox" value="${esc(chapter.id)}" ${state.manualKnowledgeSourceIds.has(chapter.id) ? 'checked' : ''}><span>${esc(chapter.title)}</span></label>`).join('') || '<p class="hint">没有匹配的章节。</p>';
    $w('#manual-source-select-results').disabled = !chapters.length;
  }
  function renderManualKnowledgeSources() {
    const panel = $w('#manual-knowledge-sources');
    const chapterMap = new Map(state.knowledgeChoices.map(chapter => [chapter.id, chapter]));
    state.manualKnowledgeSourceIds = new Set([...state.manualKnowledgeSourceIds].filter(id => chapterMap.has(id)));
    const ids = [...state.manualKnowledgeSourceIds];
    $w('#manual-source-count').textContent = `已选 ${ids.length} 章`;
    $w('#manual-autofill-scope').textContent = ids.length
      ? `AI将读取所选 ${ids.length} 章的完整正文；可查询正文中出现的专有名词来辅助理解，不会读取未选章节原文或初始设定。`
      : '未选择来源章节：AI将检索全书已有知识和原文。';
    $w('#manual-source-clear').disabled = !ids.length;
    $w('#manual-knowledge-chapter').querySelectorAll('input[type="checkbox"]').forEach(box => { box.checked = state.manualKnowledgeSourceIds.has(box.value); });
    panel.classList.toggle('hidden', !ids.length);
    panel.innerHTML = ids.length ? `<span class="hint">已选来源：</span>${ids.map(id => `
      <span class="manual-knowledge-source-chip">${esc(chapterMap.get(id).title)}
        <button type="button" data-remove-manual-source="${esc(id)}" aria-label="移除${esc(chapterMap.get(id).title)}">×</button>
      </span>`).join('')}` : '';
    panel.querySelectorAll('[data-remove-manual-source]').forEach(button => button.addEventListener('click', () => {
      state.manualKnowledgeSourceIds.delete(button.dataset.removeManualSource);
      renderManualKnowledgeSources();
    }));
  }
  $w('#manual-knowledge-chapter').addEventListener('click', event => {
    const box = event.target;
    if (!box.matches('input[type="checkbox"]')) return;
    const ids = filteredManualSourceChapters().map(chapter => chapter.id);
    const anchor = ids.indexOf(manualSourceAnchor), end = ids.indexOf(box.value);
    const range = event.shiftKey && anchor >= 0 && end >= 0
      ? ids.slice(Math.min(anchor, end), Math.max(anchor, end) + 1) : [box.value];
    range.forEach(id => box.checked ? state.manualKnowledgeSourceIds.add(id) : state.manualKnowledgeSourceIds.delete(id));
    manualSourceAnchor = box.value;
    renderManualKnowledgeSources();
  });
  $w('#manual-knowledge-source-search').addEventListener('input', () => {
    manualSourceAnchor = ''; populateManualKnowledgeChapters();
  });
  $w('#manual-source-select-results').addEventListener('click', () => {
    filteredManualSourceChapters().forEach(chapter => state.manualKnowledgeSourceIds.add(chapter.id));
    renderManualKnowledgeSources();
  });
  $w('#manual-source-clear').addEventListener('click', () => {
    state.manualKnowledgeSourceIds.clear(); manualSourceAnchor = ''; renderManualKnowledgeSources();
  });
  $w('#open-manual-knowledge').addEventListener('click', () => {
    const projectId = $w('#knowledge-project').value;
    if (!projectId) { $w('#knowledge-hint').textContent = '请先选择一部小说。'; return; }
    $w('#manual-knowledge-source-search').value = ''; manualSourceAnchor = '';
    populateManualKnowledgeChapters();
    const suggestedType = state.knowledgeSection === 'world' ? 'world'
      : state.knowledgeSection === 'plot' ? 'clue'
      : (state.knowledgeType && state.knowledgeType !== 'plot' ? state.knowledgeType : 'term');
    $w('#manual-knowledge-type').value = suggestedType;
    $w('#manual-knowledge-status').textContent = '';
    renderManualKnowledgeSources();
    $w('#manual-knowledge-form').classList.remove('hidden');
    $w('#manual-knowledge-title').focus();
    $w('#manual-knowledge-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $w('#cancel-manual-knowledge').addEventListener('click', () => {
    $w('#manual-knowledge-form').classList.add('hidden');
  });
  $w('#autofill-manual-knowledge').addEventListener('click', async () => {
    const projectId = $w('#knowledge-project').value;
    const button = $w('#autofill-manual-knowledge');
    const status = $w('#manual-knowledge-status');
    const name = $w('#manual-knowledge-title').value.trim();
    if (!projectId) { status.textContent = '❌ 请先选择一部小说。'; return; }
    if (!name) { status.textContent = '❌ 请先输入要查询的名称。'; $w('#manual-knowledge-title').focus(); return; }
    button.disabled = true;
    const requestedSources = [...state.manualKnowledgeSourceIds];
    const scopeLabel = requestedSources.length ? `所选 ${requestedSources.length} 章` : '全书';
    status.textContent = `正在检索${scopeLabel}并让AI整理草稿…`;
    try {
      const result = await api(`/api/projects/${projectId}/knowledge/autofill`, jsonOptions('POST', {
        name, preferred_type: $w('#manual-knowledge-type').value,
        source_chapter_ids: requestedSources,
      }));
      if ($w('#knowledge-project').value !== projectId) return;
      if ($w('#manual-knowledge-title').value.trim() !== name ||
          requestedSources.length !== state.manualKnowledgeSourceIds.size ||
          requestedSources.some(id => !state.manualKnowledgeSourceIds.has(id))) {
        status.textContent = '检索期间名称或来源选择已改变，本次结果未填入。请按当前选择重新搜索。'; return;
      }
      const draft = result.draft || {};
      if (draft.type && KNOWLEDGE_TYPE_LABELS[draft.type] && draft.type !== 'plot') {
        $w('#manual-knowledge-type').value = draft.type;
      }
      $w('#manual-knowledge-summary').value = draft.summary || '';
      $w('#manual-knowledge-quotes').value = (draft.source_quotes || []).join('\n\n');
      state.manualKnowledgeSourceIds = new Set(draft.source_chapter_ids || []);
      renderManualKnowledgeSources();
      const searched = result.searched || {};
      const notes = [requestedSources.length
        ? `已按${scopeLabel}填入草稿（读取 ${searched.source_passages || requestedSources.length} 章完整正文）`
        : `已按${scopeLabel}填入草稿（参考 ${searched.knowledge_cards || 0} 张已有卡片、${searched.source_passages || 0} 段原文）`];
      const termQueries = (searched.term_queries || []).filter(item => item?.status === 'ok');
      if (termQueries.length) notes.push(`为理解正文专有名词查询了 ${termQueries.length} 次已有知识`);
      if (requestedSources.length) notes.push(
        `最终来源仅保留 ${state.manualKnowledgeSourceIds.size} 章含有具体原文依据的章节`
      );
      if (result.matching_cards?.length) notes.push(`注意：已有 ${result.matching_cards.length} 张同名卡片，保存仍会新建独立卡片`);
      if (result.discarded_quotes) notes.push(`已丢弃 ${result.discarded_quotes} 段无法在正文定位的AI引文`);
      if (result.evidence_note) notes.push(result.evidence_note);
      status.textContent = notes.join('；') + '。请检查后再保存。';
    } catch (error) { status.textContent = `❌ ${error.message}`; }
    finally { button.disabled = false; }
  });
  $w('#optimize-manual-knowledge-quotes').addEventListener('click', async () => {
    const projectId = $w('#knowledge-project').value;
    const button = $w('#optimize-manual-knowledge-quotes');
    const status = $w('#manual-knowledge-status');
    const title = $w('#manual-knowledge-title').value.trim();
    const summary = $w('#manual-knowledge-summary').value.trim();
    const requestedSources = [...state.manualKnowledgeSourceIds];
    const currentQuoteText = $w('#manual-knowledge-quotes').value;
    if (!projectId) { status.textContent = '❌ 请先选择一部小说。'; return; }
    if (!title || !summary) { status.textContent = '❌ 请先填写卡片名称和内容，再让AI按内容优化引文。'; return; }
    if (!requestedSources.length) { status.textContent = '❌ 请先选择至少一个来源章节。'; return; }
    button.disabled = true;
    status.textContent = `AI正在读取所选 ${requestedSources.length} 章并挑选更短、更直接的逐字依据……`;
    try {
      const result = await api(`/api/projects/${projectId}/knowledge/quotes/optimize`, jsonOptions('POST', {
        title, summary, source_chapter_ids: requestedSources,
        source_quotes: parseKnowledgeQuoteText(currentQuoteText),
      }));
      if ($w('#knowledge-project').value !== projectId ||
          $w('#manual-knowledge-title').value.trim() !== title ||
          $w('#manual-knowledge-summary').value.trim() !== summary ||
          $w('#manual-knowledge-quotes').value !== currentQuoteText ||
          requestedSources.length !== state.manualKnowledgeSourceIds.size ||
          requestedSources.some(id => !state.manualKnowledgeSourceIds.has(id))) {
        status.textContent = '优化期间卡片内容、引文或来源选择已改变，本次结果未填入。'; return;
      }
      $w('#manual-knowledge-quotes').value = (result.source_quotes || []).join('\n\n');
      state.manualKnowledgeSourceIds = new Set(result.source_chapter_ids || []);
      renderManualKnowledgeSources();
      const names = (result.source_chapters || []).map(chapter => chapter.title).join('、');
      const notes = [`已生成 ${result.source_quotes?.length || 0} 段精简引文${names ? `，实际依据来自：${names}` : ''}`];
      if (result.discarded_quotes) notes.push(`已丢弃 ${result.discarded_quotes} 段无法逐字定位的AI结果`);
      if (result.evidence_note) notes.push(result.evidence_note);
      status.textContent = notes.join('；') + '。尚未保存，可以继续编辑。';
    } catch (error) { status.textContent = `❌ ${error.message}`; }
    finally { button.disabled = false; }
  });
  $w('#save-manual-knowledge').addEventListener('click', async () => {
    const projectId = $w('#knowledge-project').value;
    const button = $w('#save-manual-knowledge');
    const status = $w('#manual-knowledge-status');
    if (!projectId) { status.textContent = '❌ 请先选择一部小说。'; return; }
    const sourceText = $w('#manual-knowledge-quotes').value.trim();
    const sourceQuotes = parseKnowledgeQuoteText(sourceText);
    button.disabled = true; status.textContent = '正在保存…';
    try {
      const saved = await api(`/api/projects/${projectId}/knowledge`, jsonOptions('POST', {
        type: $w('#manual-knowledge-type').value,
        title: $w('#manual-knowledge-title').value.trim(),
        summary: $w('#manual-knowledge-summary').value.trim(),
        source_chapter_ids: [...state.manualKnowledgeSourceIds],
        source_quotes: sourceQuotes,
      }));
      $w('#manual-knowledge-title').value = '';
      $w('#manual-knowledge-summary').value = '';
      $w('#manual-knowledge-quotes').value = '';
      state.manualKnowledgeSourceIds = new Set();
      renderManualKnowledgeSources();
      $w('#manual-knowledge-form').classList.add('hidden');
      await loadKnowledge();
      window.openKnowledgeItem?.(saved.id);
      $w('#knowledge-hint').textContent = `已手动新增“${saved.title}”，未调用AI。`;
    } catch (error) { status.textContent = `❌ ${error.message}`; }
    finally { button.disabled = false; }
  });
  $w('#toggle-context').addEventListener('click', () => $w('#workspace-context-detail').classList.toggle('hidden'));
  $w('#draft-input').addEventListener('input', () => { state.selectionStart = null; state.selectionEnd = null; });
  $w('#save-result-project').addEventListener('click', () => saveCurrentResult().catch(error => {
    $w('#search-hint').textContent = `❌ ${error.message}`;
  }));
  window.addEventListener('beforeunload', event => {
    const unsaved = state.pendingSave || (state.chapter && ($w('#chapter-title').value !== state.chapter.title || $w('#chapter-editor-text').value !== state.chapter.text));
    if (unsaved) { event.preventDefault(); event.returnValue = ''; }
  });

  loadKnowledgeBuildPreferences();
  window.setKnowledgeSection('entity');
  loadProjects().catch(error => { $w('#home-projects').innerHTML = `❌ ${esc(error.message)}`; });
  window.restoreReferenceSelection();
  navigate('home');
})();
