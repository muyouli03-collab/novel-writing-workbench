/* 原生知识卡片图画布：不改变知识顺序，只保存画布坐标。 */
(() => {
  const q = selector => document.querySelector(selector);
  const overlay = q('#knowledge-graph-overlay');
  if (!overlay) return;

  const TYPE_LABELS = { character: '人物', relationship: '关系', term: '名词', world: '世界观', scene: '场景', clue: '伏笔' };
  const ALL_TYPES = ['character', 'relationship', 'term', 'scene'];
  const EDITABLE_TYPES = ['character', 'relationship', 'term', 'scene', 'world', 'clue'];
  const state = {
    projectId: '', nodes: new Map(), edges: [], positions: {}, visible: new Set(), selected: new Set(),
    types: new Set(ALL_TYPES), query: '', mode: 'browse', expanded: '',
    view: { x: 0, y: 0, scale: 1 }, pointer: null, space: false, ghost: null,
    undo: { can_undo: false, label: '' }, relation: null, busy: false,
    transientPositions: null, layoutFilterKey: '', viewBeforeFilter: null,
    hovered: '', showAllEdges: false, shiftBrowse: false, suppressClick: false,
    focus: null,
    relationLayoutsDraft: null, selectedRelationLabel: '',
    tagCatalog: { card_tags: {}, relation_labels: [], relation_layouts: {} },
    segmentId: '', segments: [], segmentChapters: [], segmentCards: [], promptedSegments: new Set(),
  };

  function escGraph(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  async function graphApi(url, options = {}) {
    const response = await fetch(url, options);
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(data.detail || `请求失败（${response.status}）`);
    return data;
  }

  function graphJson(method, body) {
    return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }

  function rightClickSelection(current, nodeId, additive = false) {
    const next = new Set(current || []);
    if (!nodeId || next.has(nodeId)) return next;
    if (!additive) next.clear();
    next.add(nodeId);
    return next;
  }

  function closeGraphContextMenu() {
    const menu = q('#knowledge-graph-context-menu');
    menu.classList.add('hidden'); menu.innerHTML = '';
  }

  function showGraphContextMenu(clientX, clientY, items) {
    const menu = q('#knowledge-graph-context-menu');
    const actions = new Map();
    menu.innerHTML = items.map((item, index) => {
      if (item.separator) return '<div class="knowledge-graph-context-menu-separator" role="separator"></div>';
      actions.set(String(index), item.action);
      return `<button type="button" role="menuitem" data-context-action="${index}" class="${item.danger ? 'danger' : ''}">${escGraph(item.label)}</button>`;
    }).join('');
    menu.classList.remove('hidden');
    menu.style.left = `${clientX}px`; menu.style.top = `${clientY}px`;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - rect.height - 8))}px`;
    menu.querySelectorAll('[data-context-action]').forEach(button => button.addEventListener('click', async event => {
      event.stopPropagation();
      const action = actions.get(button.dataset.contextAction);
      closeGraphContextMenu();
      try { await action?.(); }
      catch (error) { setStatus(`❌ 快捷操作失败：${error.message}`, true); }
    }));
    menu.querySelector('button')?.focus();
  }

  function openGraphContextMenu(event) {
    event.preventDefault(); event.stopPropagation();
    if (state.busy) return;
    const element = event.target.closest('.knowledge-graph-node');
    const nodeId = element?.dataset.id || '';
    if (nodeId) {
      state.selected = rightClickSelection(state.selected, nodeId, event.ctrlKey || event.metaKey);
      renderGraph();
    }
    const selectedIds = [...state.selected].filter(id => state.visible.has(id));
    const node = nodeId ? state.nodes.get(nodeId) : null;
    const items = [];
    if (node) {
      items.push({ label: `查看并编辑“${node.title || '未命名卡片'}”`, action: () => renderCardEditSidebar(node) });
      items.push({ label: '管理这张卡片的关联', action: () => {
        if (state.mode !== 'relation') setMode('relation');
        state.selected.add(nodeId); state.expanded = nodeId; renderGraph();
        setStatus('关联模式：可从这张卡片右侧的连接点拖向另一张卡片，也可点击已有连线进行编辑。');
      } });
      items.push({ separator: true });
    }
    if (state.segmentId) {
      items.push({ label: '＋ 加入卡片到本段', action: () => renderSegmentCardLibrary(false) });
      if (selectedIds.length) items.push({
        label: `移出当前分段（${selectedIds.length}张）`, danger: true,
        action: () => updateSegmentNodes(selectedIds, 'exclude'),
      });
    }
    const mergeable = selectedIds.filter(id => state.nodes.get(id)?.eligible);
    if (selectedIds.length >= 2 && selectedIds.length <= 12 && mergeable.length === selectedIds.length) {
      items.push({ label: `生成合并草稿（${selectedIds.length}张）`, action: () => startGraphMerge() });
    }
    if (items.length && !items.at(-1)?.separator) items.push({ separator: true });
    items.push({ label: '＋ 新建剧情分段', action: () => renderCreateSegmentSidebar() });
    if (state.edges.some(edge => state.visible.has(edge.source_id) && state.visible.has(edge.target_id))) {
      items.push({ label: 'AI 智能排布当前画布', action: () => arrangeGraphByRelations() });
    }
    items.push({ label: '适应画布', action: () => fitGraph() });
    showGraphContextMenu(event.clientX, event.clientY, items);
  }

  function activeSegment() {
    return state.segments.find(segment => segment.id === state.segmentId) || null;
  }

  async function saveGraphPositions(positions, recordHistory = true, label = '移动知识卡片') {
    if (state.segmentId) {
      return graphApi(`/api/projects/${state.projectId}/knowledge/segments/${state.segmentId}/layout`,
        graphJson('PUT', { positions }));
    }
    return graphApi(`/api/projects/${state.projectId}/knowledge/graph/layout`,
      graphJson('PUT', { positions, record_history: recordHistory, label }));
  }

  function renderSegmentRail() {
    const list = q('#knowledge-segment-list');
    q('#knowledge-segment-overview').classList.toggle('active', !state.segmentId);
    list.innerHTML = state.segments.map(segment => `<div class="knowledge-segment-row"><button class="knowledge-segment-item ${segment.id === state.segmentId ? 'active' : ''}" data-segment-id="${escGraph(segment.id)}"><strong>${escGraph(segment.name)}</strong><small>${escGraph((segment.chapter_titles || []).join('、'))}</small><small>${segment.active_count || 0} 张卡片${segment.pending_count ? ` · ${segment.pending_count} 张待恢复` : ''}</small></button><button class="ghost danger knowledge-segment-delete" data-delete-segment="${escGraph(segment.id)}" title="删除这个画布分段">×</button></div>`).join('');
    list.querySelectorAll('[data-segment-id]').forEach(button => button.onclick = async () => {
      if (state.busy || state.segmentId === button.dataset.segmentId) return;
      state.segmentId = button.dataset.segmentId; state.selected.clear(); state.expanded = ''; state.focus = null;
      await loadGraph(false);
    });
    list.querySelectorAll('[data-delete-segment]').forEach(button => button.onclick = async () => {
      const segment = state.segments.find(item => item.id === button.dataset.deleteSegment);
      if (!segment || !window.confirm(`删除剧情段“${segment.name}”？知识卡片本身不会删除。`)) return;
      try {
        await graphApi(`/api/projects/${state.projectId}/knowledge/segments/${segment.id}`, { method: 'DELETE' });
        if (state.segmentId === segment.id) state.segmentId = '';
        await loadGraph(false, false); setStatus('剧情段已删除，知识卡片未改变。');
      } catch (error) { setStatus(`❌ ${error.message}`, true); }
    });
    const scoped = !!state.segmentId;
    q('#knowledge-segment-add-card').classList.toggle('hidden', !scoped);
    q('#knowledge-segment-remove-selected').classList.toggle('hidden', !scoped);
    const segment = activeSegment();
    q('#knowledge-segment-hint').textContent = segment
      ? `${(segment.chapter_titles || []).join('、')}。移出只影响本段画布。`
      : '全书总览保留原来的全局布局。';
  }

  function graphSearchMatches(node, query) {
    const terms = String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const details = { ...(node.details || {}) };
    delete details.knowledge_relations; delete details.related_knowledge_ids;
    const text = [node.type, node.title, node.summary, JSON.stringify(details),
      ...(node.source_quotes || []), ...(node.source_chapters || []).map(chapter => chapter.title)]
      .join(' ').toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  }

  function zoomAroundPoint(view, point, nextScale) {
    const scale = Math.max(.18, Math.min(2.5, Number(nextScale) || 1));
    const worldX = (point.x - view.x) / view.scale;
    const worldY = (point.y - view.y) / view.scale;
    return { scale, x: point.x - worldX * scale, y: point.y - worldY * scale };
  }

  function graphNodeTime(node) {
    const chapterPositions = (node.source_chapters || []).map(chapter => Number(chapter.position)).filter(Number.isFinite);
    if (Number.isFinite(Number(node.order_start))) return Number(node.order_start);
    if (chapterPositions.length) return Math.min(...chapterPositions);
    if (Number.isFinite(Number(node.order_end))) return Number(node.order_end);
    return Number.MAX_SAFE_INTEGER;
  }

  function computeTypeTimeLayout(nodes, bucketSize = 5) {
    const positions = {};
    const safeBucket = Math.max(1, Number(bucketSize) || 5);
    const bucketOf = node => Math.floor((Math.max(1, graphNodeTime(node)) - 1) / safeBucket);
    const columns = [...new Set(nodes.map(bucketOf))].sort((a, b) => a - b);
    const columnIndex = new Map(columns.map((bucket, index) => [bucket, index]));
    let laneY = 0;
    ALL_TYPES.forEach(type => {
      const group = nodes.filter(node => node.type === type).sort((a, b) =>
        graphNodeTime(a) - graphNodeTime(b) || Number(a.order_end || 0) - Number(b.order_end || 0) ||
        String(a.title || '').localeCompare(String(b.title || '')) || a.id.localeCompare(b.id));
      if (!group.length) return;
      const stacks = new Map();
      for (const node of group) {
        const bucket = bucketOf(node), stack = stacks.get(bucket) || [];
        stack.push(node); stacks.set(bucket, stack);
      }
      let maxStack = 1;
      for (const [bucket, stack] of stacks) {
        maxStack = Math.max(maxStack, stack.length);
        stack.forEach((node, row) => { positions[node.id] = { x: columnIndex.get(bucket) * 300, y: laneY + row * 105 }; });
      }
      laneY += Math.max(190, maxStack * 105 + 70);
    });
    return positions;
  }

  const RELATION_LAYOUT_OPTIONS = [
    ['hierarchy_source', '箭头起点为主', '适合“拥有、领导、包含”：主卡在左，从属卡排列在右侧。'],
    ['hierarchy_target', '箭头终点为主', '适合“属于、隶属于、受控于”：箭头所指卡片作为主卡。'],
    ['opposition', '对立分开', '适合敌对、对抗、竞争：双方分列两侧并留出明显间距。'],
    ['cluster', '同组聚集', '适合同盟、亲友、共同参与：联系最多的卡片居中，其余卡片靠拢。'],
    ['sequence', '先后链条', '适合导致、转化、继承：按照箭头方向从左到右排列。'],
    ['manual', '不影响排布', '只显示连线；自动整理时不让这条关系改变卡片位置。'],
  ];

  function defaultRelationLayoutMode(label) {
    const value = String(label || '').trim();
    if (/(敌对|对立|仇敌|敌人|冲突|对抗|交战|竞争|追杀|排斥)/.test(value)) return 'opposition';
    if (/(属于|隶属|受制|受控|听命|效忠|任职于|成员|位于)/.test(value)) return 'hierarchy_target';
    if (/(拥有|持有|领导|控制|包含|管理|统领|创建|雇佣|管辖)/.test(value)) return 'hierarchy_source';
    if (/(导致|引发|转化|变成|继承|传给|发展为|前身|后继|升级|演变)/.test(value)) return 'sequence';
    if (/(同盟|盟友|朋友|亲友|同伴|同学|合作|共同|搭档|亲属|夫妻|参与|相关|认识|使用|遵守|发生于)/.test(value)) return 'cluster';
    return 'cluster';
  }

  function relationLayoutMode(label, layouts = {}) {
    const wanted = String(label || '').trim().toLocaleLowerCase();
    const saved = Object.entries(layouts || {}).find(([key]) => String(key).trim().toLocaleLowerCase() === wanted)?.[1];
    return RELATION_LAYOUT_OPTIONS.some(([mode]) => mode === saved) ? saved : defaultRelationLayoutMode(label);
  }

  function relationLayoutSelectOptions(selected) {
    return RELATION_LAYOUT_OPTIONS.map(([value, title, description]) =>
      `<option value="${value}" ${value === selected ? 'selected' : ''}>${title}｜${description}</option>`).join('');
  }

  function renderRelationLayoutManager() {
    const container = q('#knowledge-graph-relation-layout-rules');
    const draft = state.relationLayoutsDraft || {};
    const labels = Object.keys(draft).sort((a, b) => a.localeCompare(b));
    if (!labels.length) {
      container.innerHTML = '<p class="empty-note">当前还没有关系名称。建立第一条卡片关系后，这里会自动出现。</p>';
      return;
    }
    container.innerHTML = RELATION_LAYOUT_OPTIONS.map(([mode, title, description]) => {
      const assigned = labels.filter(label => draft[label] === mode);
      return `<section class="relation-layout-rule" data-layout-mode="${mode}" role="button" tabindex="0"><h4>${title}</h4><p class="hint">${description}</p><div class="relation-layout-rule-labels">${assigned.map(label =>
        `<button type="button" class="relation-layout-chip ${state.selectedRelationLabel === label ? 'selected' : ''}" draggable="true" data-relation-label="${escGraph(label)}">${escGraph(label)}</button>`).join('') || '<span class="hint">把关系拖到这里</span>'}</div></section>`;
    }).join('');
    const assignSelected = mode => {
      if (!state.selectedRelationLabel) return;
      draft[state.selectedRelationLabel] = mode; state.selectedRelationLabel = '';
      q('#knowledge-graph-relation-layout-status').textContent = '分组已调整；点击“保存排布设置”后生效。';
      renderRelationLayoutManager();
    };
    container.querySelectorAll('.relation-layout-chip').forEach(chip => {
      chip.onclick = event => {
        event.stopPropagation();
        state.selectedRelationLabel = state.selectedRelationLabel === chip.dataset.relationLabel ? '' : chip.dataset.relationLabel;
        q('#knowledge-graph-relation-layout-status').textContent = state.selectedRelationLabel
          ? `已选择“${state.selectedRelationLabel}”，请点击目标排布规则。` : '';
        renderRelationLayoutManager();
      };
      chip.ondragstart = event => {
        state.selectedRelationLabel = chip.dataset.relationLabel;
        event.dataTransfer.setData('text/plain', chip.dataset.relationLabel);
        event.dataTransfer.effectAllowed = 'move';
      };
    });
    container.querySelectorAll('.relation-layout-rule').forEach(rule => {
      rule.onclick = () => assignSelected(rule.dataset.layoutMode);
      rule.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); assignSelected(rule.dataset.layoutMode); } };
      rule.ondragover = event => { event.preventDefault(); rule.classList.add('drag-over'); event.dataTransfer.dropEffect = 'move'; };
      rule.ondragleave = () => rule.classList.remove('drag-over');
      rule.ondrop = event => {
        event.preventDefault(); rule.classList.remove('drag-over');
        const label = event.dataTransfer.getData('text/plain');
        if (Object.hasOwn(draft, label)) state.selectedRelationLabel = label;
        assignSelected(rule.dataset.layoutMode);
      };
    });
  }

  function openRelationLayoutManager() {
    const labels = [...new Set([
      ...(state.tagCatalog.relation_labels || []),
      ...state.edges.map(edge => String(edge.label || '').trim()).filter(Boolean),
    ])];
    state.relationLayoutsDraft = Object.fromEntries(labels.map(label => [
      label, relationLayoutMode(label, state.tagCatalog.relation_layouts || {}),
    ]));
    state.selectedRelationLabel = '';
    q('#knowledge-graph-relation-layout-status').textContent = '';
    renderRelationLayoutManager();
    q('#knowledge-graph-relation-layout-dialog').classList.remove('hidden');
  }

  function closeRelationLayoutManager() {
    q('#knowledge-graph-relation-layout-dialog').classList.add('hidden');
    state.relationLayoutsDraft = null; state.selectedRelationLabel = '';
  }

  async function saveRelationLayoutManager() {
    if (!state.relationLayoutsDraft || state.busy) return;
    state.busy = true; updateModeControls();
    const status = q('#knowledge-graph-relation-layout-status'); status.textContent = '正在保存……';
    try {
      const result = await graphApi(`/api/projects/${state.projectId}/knowledge/relation-layouts`,
        graphJson('PUT', { layouts: state.relationLayoutsDraft }));
      state.tagCatalog = result.tag_catalog || state.tagCatalog;
      closeRelationLayoutManager();
      setStatus('关系排布设置已保存。点击“AI 智能排布”后，模型会结合这些规则重新规划画布。');
    } catch (error) { status.textContent = `❌ 保存失败：${error.message}`; }
    finally { state.busy = false; updateModeControls(); }
  }

  function nearestFreeRelationPosition(anchorId, movingId, preferredOffset = null) {
    const shown = visualPositions();
    const anchor = shown[anchorId] || state.positions[anchorId] || { x: 0, y: 0 };
    const occupied = Object.entries(shown).filter(([id]) => id !== movingId).map(([, point]) => point);
    const offsets = [
      ...(preferredOffset ? [preferredOffset] : []),
      [320, 0], [-320, 0], [0, 160], [0, -160], [320, 160], [320, -160], [-320, 160], [-320, -160],
    ];
    for (let ring = 1; ring <= 8; ring += 1) {
      for (const [dx, dy] of offsets) {
        const point = { x: anchor.x + dx * ring, y: anchor.y + dy * ring };
        if (!occupied.some(other => Math.abs(other.x - point.x) < 280 && Math.abs(other.y - point.y) < 125)) return point;
      }
    }
    return { x: anchor.x + 320, y: anchor.y + 160 };
  }

  function rectangleCollisionForce(width = 254, height = 108, strength = .9) {
    let nodes = [];
    function force(alpha) {
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const first = nodes[i], second = nodes[j];
          let dx = second.x - first.x, dy = second.y - first.y;
          if (!dx && !dy) { dx = first.id < second.id ? -0.01 : 0.01; dy = 0.01; }
          const overlapX = width - Math.abs(dx), overlapY = height - Math.abs(dy);
          if (overlapX <= 0 || overlapY <= 0) continue;
          const firstFixed = first.fx != null, secondFixed = second.fx != null;
          if (firstFixed && secondFixed) continue;
          const horizontal = overlapX < overlapY;
          const direction = Math.sign(horizontal ? dx : dy) || 1;
          const amount = (horizontal ? overlapX : overlapY) * strength * alpha;
          const firstShare = firstFixed ? 0 : (secondFixed ? 1 : .5);
          const secondShare = secondFixed ? 0 : (firstFixed ? 1 : .5);
          if (horizontal) {
            first.vx -= direction * amount * firstShare;
            second.vx += direction * amount * secondShare;
          } else {
            first.vy -= direction * amount * firstShare;
            second.vy += direction * amount * secondShare;
          }
        }
      }
    }
    force.initialize = value => { nodes = value || []; };
    return force;
  }

  // 力导向布局在 alpha 降低后可能留下少量矩形交叠。保存前再直接移动坐标，
  // 直到所有可移动卡片都与周围卡片留出稳定间距，避免刷新后仍叠在一起。
  function settleRectangleOverlaps(nodes, movableIds, width = 254, height = 108, maxPasses = 240) {
    const movable = movableIds instanceof Set ? movableIds : new Set(movableIds || []);
    let passes = 0;
    let remaining = 0;
    for (; passes < maxPasses; passes += 1) {
      let changed = false;
      remaining = 0;
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const first = nodes[i], second = nodes[j];
          const firstMovable = movable.has(first.id), secondMovable = movable.has(second.id);
          if (!firstMovable && !secondMovable) continue;
          let dx = second.x - first.x, dy = second.y - first.y;
          if (!dx && !dy) {
            const direction = String(first.id) < String(second.id) ? -1 : 1;
            dx = direction * .01; dy = .01;
          }
          const overlapX = width - Math.abs(dx), overlapY = height - Math.abs(dy);
          if (overlapX <= .1 || overlapY <= .1) continue;
          remaining += 1; changed = true;
          const horizontal = overlapX < overlapY;
          const direction = Math.sign(horizontal ? dx : dy) || 1;
          const amount = (horizontal ? overlapX : overlapY) + .75;
          const firstShare = firstMovable ? (secondMovable ? .5 : 1) : 0;
          const secondShare = secondMovable ? (firstMovable ? .5 : 1) : 0;
          if (horizontal) {
            first.x -= direction * amount * firstShare;
            second.x += direction * amount * secondShare;
          } else {
            first.y -= direction * amount * firstShare;
            second.y += direction * amount * secondShare;
          }
        }
      }
      if (!changed) break;
    }
    return { passes, remaining };
  }

  function computeMissingGraphPositions(nodes, _edges, existing = {}) {
    const positions = Object.fromEntries(Object.entries(existing || {}).map(([id, point]) => [id, { x: Number(point.x), y: Number(point.y) }]));
    const defaults = computeTypeTimeLayout(nodes);
    for (const node of nodes) {
      if (positions[node.id] && Number.isFinite(positions[node.id].x) && Number.isFinite(positions[node.id].y)) continue;
      const point = { ...(defaults[node.id] || { x: 0, y: 0 }) };
      // 新卡片避开已有手工坐标；不会挪动用户摆好的旧卡片。
      while (Object.values(positions).some(saved => Math.abs(saved.x - point.x) < 235 && Math.abs(saved.y - point.y) < 105)) point.y += 110;
      positions[node.id] = point;
    }
    return positions;
  }

  function setStatus(text, error = false) {
    const target = q('#knowledge-graph-status');
    target.textContent = text;
    target.classList.toggle('error', error);
  }

  function applyTransform() {
    q('#knowledge-graph-world').style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.scale})`;
    q('#knowledge-graph-zoom').textContent = `${Math.round(state.view.scale * 100)}%`;
  }

  function worldPoint(clientX, clientY) {
    const rect = q('#knowledge-graph-viewport').getBoundingClientRect();
    return { x: (clientX - rect.left - state.view.x) / state.view.scale,
             y: (clientY - rect.top - state.view.y) / state.view.scale };
  }

  function visibleNodes() {
    return [...state.nodes.values()].filter(node => state.visible.has(node.id));
  }

  function graphFilterActive() {
    return !!state.focus || !!state.query.trim() || state.types.size !== ALL_TYPES.length;
  }

  function focusNeighborhood(ids, edges) {
    const result = new Set(ids);
    for (const edge of edges) {
      if (ids.has(edge.source_id)) result.add(edge.target_id);
      if (ids.has(edge.target_id)) result.add(edge.source_id);
    }
    return result;
  }

  function focusLayout(nodes, rootId, edges) {
    const ids = new Set(nodes.map(n => n.id));
    const depths = new Map([[rootId, 0]]); let frontier = new Set([rootId]);
    for (let depth = 1; depth <= nodes.length && frontier.size; depth++) {
      const next = focusNeighborhood(frontier, edges); frontier = new Set();
      for (const id of next) if (ids.has(id) && !depths.has(id)) { depths.set(id, depth); frontier.add(id); }
    }
    const positions = {};
    let radius = 0;
    for (const depth of [...new Set(nodes.map(n => depths.get(n.id) || (n.id === rootId ? 0 : 1)))].sort((a,b) => a-b)) {
      const ring = nodes.filter(n => (depths.get(n.id) || (n.id === rootId ? 0 : 1)) === depth);
      if (depth) radius = Math.max(radius + 380, ring.length * 310 / (2 * Math.PI));
      ring.forEach((n, i) => { positions[n.id] = { x: depth ? Math.cos(i * Math.PI * 2 / ring.length) * radius : 0, y: depth ? Math.sin(i * Math.PI * 2 / ring.length) * radius : 0 }; });
    }
    const values = nodes.map(n => ({ id:n.id, ...positions[n.id] }));
    settleRectangleOverlaps(values, ids);
    return Object.fromEntries(values.map(n => [n.id, { x:n.x, y:n.y }]));
  }

  function focusCard(id, expand = false) {
    if (state.busy) return;
    if (!state.focus) state.focus = { root: id, ids: new Set(), previousView: { ...state.view }, query: state.query, types: new Set(state.types) };
    if (!expand) { state.focus.root = id; state.focus.ids = new Set(); }
    state.focus.ids = new Set([...state.focus.ids, ...focusNeighborhood(new Set([id]), state.edges)]);
    state.query = ''; q('#knowledge-graph-search').value = ''; state.types = new Set(ALL_TYPES);
    state.layoutFilterKey = ''; state.expanded = ''; renderTypeFilters(); refreshFilteredGraph();
    setStatus('局部聚焦：点击卡片可继续展开关联；临时位置可保存，返回总览恢复原视野。');
  }

  function returnOverview() {
    if (!state.focus || state.busy) return;
    const previous = state.focus; state.focus = null; state.view = previous.previousView;
    state.query = previous.query; state.types = previous.types; q('#knowledge-graph-search').value = state.query;
    state.viewBeforeFilter = null; state.layoutFilterKey = ''; state.transientPositions = null;
    renderTypeFilters(); renderGraph(); applyTransform();
  }

  async function saveTemporaryLayout() {
    if (state.busy || !state.transientPositions) return;
    state.busy = true;
    try {
      const positions = Object.fromEntries([...state.visible].map(id => [id, state.transientPositions[id]]));
      const result = await saveGraphPositions(positions, true, '保存局部布局');
      Object.assign(state.positions, positions); state.undo = result.undo || state.undo; setStatus('当前可见布局已保存，可撤销。');
    } catch (error) { setStatus(`❌ ${error.message}`, true); }
    finally { state.busy = false; updateModeControls(); }
  }

  function visualPositions() {
    return state.transientPositions || state.positions;
  }

  function nextGraphTypeSelection(current, type) {
    const next = new Set(current);
    if (next.size === ALL_TYPES.length) return new Set([type]);
    if (next.has(type)) {
      next.delete(type);
      return next.size ? next : new Set(ALL_TYPES);
    }
    next.add(type);
    return next;
  }

  function effectiveGraphMode(mode, shiftBrowse) {
    return shiftBrowse ? 'browse' : mode;
  }

  function activeGraphMode() {
    return effectiveGraphMode(state.mode, state.shiftBrowse);
  }

  function updateVisibility() {
    state.visible = new Set([...state.nodes.values()].filter(node => (!state.focus || state.focus.ids.has(node.id)) && state.types.has(node.type) && graphSearchMatches(node, state.query)).map(node => node.id));
    for (const id of [...state.selected]) if (!state.visible.has(id)) state.selected.delete(id);
    if (state.expanded && !state.visible.has(state.expanded)) state.expanded = '';
    if (state.hovered && !state.visible.has(state.hovered)) state.hovered = '';
    if (graphFilterActive()) {
      if (!state.viewBeforeFilter) state.viewBeforeFilter = { ...state.view };
      const key = `${state.query.trim()}|${[...state.types].sort().join(',')}|${[...state.visible].sort().join(',')}`;
      if (key !== state.layoutFilterKey) {
        state.transientPositions = state.focus ? focusLayout(visibleNodes(), state.focus.root, state.edges) : computeTypeTimeLayout(visibleNodes());
        state.layoutFilterKey = key;
      }
    } else {
      state.transientPositions = null;
      state.layoutFilterKey = '';
    }
    q('#knowledge-graph-overview').classList.toggle('hidden', !state.focus);
    q('#knowledge-graph-save-view').classList.toggle('hidden', !graphFilterActive());
  }

  function refreshFilteredGraph() {
    renderGraph();
    if (graphFilterActive()) requestAnimationFrame(fitGraph);
    else if (state.viewBeforeFilter) {
      state.view = state.viewBeforeFilter; state.viewBeforeFilter = null; applyTransform();
    }
  }

  function renderTypeFilters() {
    const panel = q('#knowledge-graph-types');
    panel.innerHTML = `<button class="ghost graph-type-all ${state.types.size === ALL_TYPES.length ? 'active' : ''}">全部</button>` +
      ALL_TYPES.map(type => `<button class="ghost graph-type ${state.types.has(type) ? 'active' : ''}" data-type="${type}">${TYPE_LABELS[type]}</button>`).join('') +
      `<span class="hint graph-visible-count"></span>`;
    panel.querySelector('.graph-type-all').addEventListener('click', () => {
      state.types = new Set(ALL_TYPES); renderTypeFilters(); refreshFilteredGraph();
    });
    panel.querySelectorAll('.graph-type').forEach(button => button.addEventListener('click', () => {
      const type = button.dataset.type;
      // 全选状态下第一次点击表示“只看这一类”；之后继续点击才是多选增减。
      state.types = nextGraphTypeSelection(state.types, type);
      renderTypeFilters(); refreshFilteredGraph();
    }));
  }

  function nodeDetailsHtml(node) {
    const details = { ...(node.details || {}) };
    const tags = Array.isArray(details.tags) ? details.tags : [];
    const sameNameUpdates = Array.isArray(details.same_name_updates) ? details.same_name_updates : [];
    const sameNameHistory = Array.isArray(details.same_name_history) ? details.same_name_history : [];
    for (const key of ['knowledge_relations', 'related_knowledge_ids', 'source_history', 'merged_from', 'tags', 'tag_periods', 'same_name_updates', 'same_name_history']) delete details[key];
    const detailText = Object.keys(details).length ? `<h4>结构化详情</h4><pre>${escGraph(JSON.stringify(details, null, 2))}</pre>` : '';
    const relations = state.edges.filter(edge => edge.source_id === node.id || edge.target_id === node.id).map(edge => {
      const outgoing = edge.source_id === node.id;
      const other = state.nodes.get(outgoing ? edge.target_id : edge.source_id);
      if (!other) return '';
      return `<li>${outgoing ? `${escGraph(edge.label)} → ${escGraph(other?.title || '')}` : `${escGraph(other?.title || '')} → ${escGraph(edge.label)} → 本卡片`} <small>${escGraph(relationPeriodLabel(edge))}</small></li>`;
    }).join('');
    return `<div class="knowledge-graph-node-body">${tags.length ? `<div class="knowledge-subtypes"><span class="hint">细分：</span>${window.KnowledgeTagPeriods.chips(node)}</div>` : ''}<p>${escGraph(node.summary || '')}</p>
      ${sameNameUpdates.length ? `<details><summary>同名自动补充（${sameNameUpdates.length}）</summary>${sameNameUpdates.map(update => `<div class="same-name-update"><strong>${escGraph((update.chapter_titles || []).join('、') || '后续章节')}</strong><p>${escGraph(update.summary || '')}</p></div>`).join('')}</details>` : (sameNameHistory.length ? `<p class="hint">已自动归并 ${sameNameHistory.length} 次同名知识，当前显示最新认识。</p>` : '')}${detailText}
      ${(node.source_quotes || []).length ? `<h4>来源原句</h4>${node.source_quotes.map(quote => `<blockquote>${escGraph(quote)}</blockquote>`).join('')}` : ''}
      ${(node.source_chapters || []).length ? `<h4>来源章节</h4>${node.source_chapters.map(chapter => `<button class="ghost graph-source-button" data-chapter-id="${escGraph(chapter.id)}">${escGraph(chapter.title)}</button>`).join('')}` : ''}
      ${relations ? `<h4>现有关联</h4><ul>${relations}</ul>` : ''}
      ${(node.external_relations || []).map(r => `<button class="ghost graph-external" data-related-id="${escGraph(r.id)}">${escGraph(r.label)} · ${escGraph(TYPE_LABELS[r.type])} · ${escGraph(r.title)}</button>`).join('')}
      <div class="row"><button class="ghost graph-focus-card">聚焦此卡</button>${state.focus ? '<button class="ghost graph-expand-neighbors">展开更多关联</button>' : ''}<button class="ghost graph-edit-card">编辑这张卡片</button>${state.segmentId ? '<button class="ghost danger graph-remove-from-segment">移出本段</button>' : ''}</div></div>`;
  }

  function renderGraph() {
    updateVisibility();
    const nodes = q('#knowledge-graph-nodes');
    nodes.innerHTML = visibleNodes().map(node => {
      const point = visualPositions()[node.id] || { x: 0, y: 0 };
      const expanded = state.expanded === node.id;
      const tags = Array.isArray(node.details?.tags) ? node.details.tags : [];
      const segmentBadge = node.segment_meta?.origin === 'new' ? '本段新增' : node.segment_meta?.evidence ? '本段出现' : node.segment_meta ? '上段继承' : '';
      return `<article class="knowledge-graph-node ${state.selected.has(node.id) ? 'selected' : ''} ${expanded ? 'expanded' : ''} ${node.eligible ? '' : 'ineligible'}" data-id="${escGraph(node.id)}" data-type="${escGraph(node.type)}" style="left:${point.x}px;top:${point.y}px">
        ${segmentBadge ? `<span class="graph-segment-badge">${segmentBadge}</span>` : ''}
        <div class="knowledge-graph-node-head"><span class="knowledge-graph-node-type">${escGraph(TYPE_LABELS[node.type] || node.type)}</span><strong class="knowledge-graph-node-title">${escGraph(node.title || '未命名卡片')}</strong><span class="knowledge-graph-node-status">${node.eligible ? '' : '待复核'}</span></div>
        ${tags.length ? `<div class="knowledge-graph-node-tags">${window.KnowledgeTagPeriods.chips({...node, details: {...node.details, tags: tags.slice(0, 3)}})}${tags.length > 3 ? `<span>+${tags.length - 3}</span>` : ''}</div>` : ''}
        <div class="knowledge-graph-node-preview">${escGraph((node.summary || '').slice(0, 300))}</div>
        ${expanded ? nodeDetailsHtml(node) : ''}<button class="knowledge-graph-port" title="拖向另一张卡片建立关联" aria-label="从此卡片建立关联"></button></article>`;
    }).join('');
    bindGraphNodes();
    q('#knowledge-graph-empty').classList.toggle('hidden', !!state.visible.size);
    const count = q('.graph-visible-count'); if (count) count.textContent = `显示 ${state.visible.size}/${state.nodes.size} 张卡片`;
    updateModeControls();
    requestAnimationFrame(renderEdges);
  }

  function edgePath(source, target) {
    const dx = target.x - source.x, dy = target.y - source.y;
    if (Math.abs(dy) >= Math.abs(dx)) {
      const bend = Math.max(55, Math.abs(dy) * .45);
      const direction = Math.sign(dy) || 1;
      return `M ${source.x} ${source.y} C ${source.x} ${source.y + bend * direction}, ${target.x} ${target.y - bend * direction}, ${target.x} ${target.y}`;
    }
    const bend = Math.max(60, Math.abs(dx) * .45);
    const direction = Math.sign(dx) || 1;
    return `M ${source.x} ${source.y} C ${source.x + bend * direction} ${source.y}, ${target.x - bend * direction} ${target.y}, ${target.x} ${target.y}`;
  }

  function nodeCenter(id) {
    const element = q(`.knowledge-graph-node[data-id="${CSS.escape(id)}"]`);
    const point = visualPositions()[id];
    if (!point) return null;
    return { x: point.x + (element?.offsetWidth || 220) / 2, y: point.y + (element?.offsetHeight || 74) / 2 };
  }

  function renderEdges() {
    const svg = q('#knowledge-graph-edges');
    const focused = new Set([...state.selected, state.hovered, state.expanded].filter(Boolean));
    let html = `<defs><marker id="knowledge-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8290a8"></path></marker></defs>`;
    for (const edge of state.edges) {
      if (!state.visible.has(edge.source_id) || !state.visible.has(edge.target_id)) continue;
      if (!state.showAllEdges && activeGraphMode() !== 'relation' && !focused.has(edge.source_id) && !focused.has(edge.target_id)) continue;
      const source = nodeCenter(edge.source_id), target = nodeCenter(edge.target_id);
      if (!source || !target) continue;
      const d = edgePath(source, target), mx = (source.x + target.x) / 2, my = (source.y + target.y) / 2 - 7;
      html += `<g data-relation-id="${escGraph(edge.id)}" class="${edge.temporal_status === 'ended' ? 'knowledge-graph-edge-ended' : ''}"><path class="knowledge-graph-edge-hit" d="${d}"></path><path class="knowledge-graph-edge" d="${d}"></path><text class="knowledge-graph-edge-label" x="${mx}" y="${my}" text-anchor="middle">${escGraph(edge.label)}${edge.temporal_status === 'ended' ? ' · 已失效' : ''}</text></g>`;
    }
    if (state.ghost) {
      const source = nodeCenter(state.ghost.sourceId);
      if (source) html += `<path class="knowledge-graph-ghost-edge" d="${edgePath(source, state.ghost.point)}"></path>`;
    }
    svg.innerHTML = html;
    svg.querySelectorAll('g[data-relation-id]').forEach(group => {
      group.querySelectorAll('.knowledge-graph-edge-hit,.knowledge-graph-edge-label').forEach(target => target.addEventListener('click', event => {
        event.stopPropagation(); if (activeGraphMode() !== 'relation' || state.suppressClick) return;
        const edge = state.edges.find(item => item.id === group.dataset.relationId);
        if (edge) openRelationDialog(edge);
      }));
    });
  }

  function bindGraphNodes() {
    q('#knowledge-graph-nodes').querySelectorAll('.knowledge-graph-node').forEach(element => {
      const id = element.dataset.id;
      element.addEventListener('mouseenter', () => { state.hovered = id; renderEdges(); });
      element.addEventListener('mouseleave', () => { if (state.hovered === id) state.hovered = ''; renderEdges(); });
      element.addEventListener('click', event => {
        if (event.target.closest('button') || state.suppressClick) return;
        if (activeGraphMode() === 'browse') {
          state.expanded = state.expanded === id ? '' : id; renderGraph();
        } else if (activeGraphMode() === 'merge') {
          const node = state.nodes.get(id);
          if (!node?.eligible) return setStatus('待复核卡片不能参与合并，请先在普通列表中确认。', true);
          if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
          renderGraph();
        }
      });
      element.addEventListener('pointerdown', event => startNodePointer(event, id));
      element.querySelector('.knowledge-graph-port').addEventListener('pointerdown', event => startRelationPointer(event, id));
      element.querySelector('.graph-edit-card')?.addEventListener('click', event => {
        event.stopPropagation(); if (!state.busy) renderCardEditSidebar(state.nodes.get(id));
      });
      element.querySelector('.graph-remove-from-segment')?.addEventListener('click', async event => {
        event.stopPropagation(); await updateSegmentNodes([id], 'exclude');
      });
      element.querySelector('.graph-focus-card')?.addEventListener('click', event => { event.stopPropagation(); focusCard(id); });
      element.querySelector('.graph-expand-neighbors')?.addEventListener('click', event => { event.stopPropagation(); focusCard(id, true); });
      element.querySelectorAll('.graph-external').forEach(b => b.addEventListener('click', event => { event.stopPropagation(); Promise.resolve(closeGraph()).then(() => window.openKnowledgeItem?.(b.dataset.relatedId)); }));
      element.querySelectorAll('.graph-source-button').forEach(button => button.addEventListener('click', event => {
        event.stopPropagation(); if (!state.suppressClick) showSourceChapter(button.dataset.chapterId, button);
      }));
    });
  }

  async function showSourceChapter(chapterId, button) {
    if (button.dataset.loaded) return;
    button.disabled = true;
    try {
      const chapter = await graphApi(`/api/projects/${state.projectId}/chapters/${chapterId}`);
      const pre = document.createElement('pre'); pre.textContent = `${chapter.title}\n\n${chapter.text}`;
      button.after(pre); button.dataset.loaded = '1'; button.textContent = '已展开来源章节';
    } catch (error) { setStatus(`❌ ${error.message}`, true); }
    finally { button.disabled = false; }
  }

  function startNodePointer(event, id) {
    // Some browsers deliver Shift as a pointer modifier before the standalone
    // keydown handler runs. Let the event bubble so the viewport can pan.
    if (state.busy || event.shiftKey) return;
    if (activeGraphMode() !== 'move' || event.button !== 0 || event.target.closest('.knowledge-graph-port')) return;
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey) {
      if (state.selected.has(id)) { state.selected.delete(id); renderGraph(); return; }
      state.selected.add(id);
    } else if (!state.selected.has(id)) {
      state.selected.clear(); state.selected.add(id);
    }
    const start = worldPoint(event.clientX, event.clientY);
    const shown = visualPositions();
    const originals = Object.fromEntries([...state.selected].map(itemId => [itemId, { ...shown[itemId] }]));
    const baseOriginals = Object.fromEntries([...state.selected].map(itemId => [itemId, { ...state.positions[itemId] }]));
    state.pointer = { kind: 'node', start, originals, baseOriginals, moved: false };
    renderGraph();
  }

  function startRelationPointer(event, id) {
    if (state.busy || event.shiftKey) return;
    if (activeGraphMode() !== 'relation' || !state.nodes.get(id)?.eligible || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    state.pointer = { kind: 'relation', sourceId: id, moved: true };
    state.ghost = { sourceId: id, point: worldPoint(event.clientX, event.clientY) };
    renderEdges();
  }

  function graphModeMessage(mode) {
    return {
      browse: '浏览模式：悬停预览，点击卡片展开完整内容；拖动空白区域平移画布。',
      move: '移动模式：单击或 Ctrl 多选，拖动任一已选卡片会整组移动；拖框可以批量选择。按住 Shift 可临时拖动画布。',
      merge: '合并模式：选择 2～12 张有效卡片，再点击右下角生成合并草稿。按住 Shift 可临时拖动画布。',
      relation: '关联模式：从卡片右侧连接点拖向另一张卡片；点击已有连线可编辑。按住 Shift 可临时拖动画布。',
    }[mode];
  }

  function setMode(mode) {
    closeGraphContextMenu();
    state.mode = state.mode === mode ? 'browse' : mode;
    state.shiftBrowse = false;
    state.selected.clear(); state.expanded = ''; state.ghost = null; state.pointer = null;
    overlay.dataset.mode = state.mode;
    setStatus(graphModeMessage(state.mode)); renderGraph();
  }

  function updateModeControls() {
    const mode = activeGraphMode();
    q('.knowledge-graph-modes').querySelectorAll('[data-graph-mode]').forEach(button => {
      button.classList.toggle('active', button.dataset.graphMode === mode); button.disabled = state.busy;
    });
    const merge = q('#knowledge-graph-merge-confirm');
    merge.classList.toggle('hidden', mode !== 'merge');
    merge.textContent = `生成合并草稿（${state.selected.size}）`;
    merge.disabled = state.busy || state.selected.size < 2 || state.selected.size > 12;
    q('#knowledge-graph-undo').disabled = state.busy || !!state.segmentId || !state.undo.can_undo;
    q('#knowledge-graph-undo').textContent = state.undo.can_undo ? `撤销：${state.undo.label}` : '撤销';
    q('#knowledge-graph-arrange-type').disabled = state.busy || !state.nodes.size;
    const relations = q('#knowledge-graph-arrange-relations');
    relations.disabled = state.busy || !state.edges.some(edge => state.visible.has(edge.source_id) && state.visible.has(edge.target_id));
    relations.textContent = 'AI 智能排布';
    q('#knowledge-graph-toggle-edges').textContent = state.showAllEdges ? '隐藏全部关联' : '显示全部关联';
    q('#knowledge-segment-remove-selected').disabled = state.busy || !state.segmentId || !state.selected.size;
  }

  function beginViewportPointer(event) {
    if (state.busy) return;
    const overGraphItem = event.target.closest('.knowledge-graph-node,.knowledge-graph-edge-label,.knowledge-graph-edge-hit');
    const temporaryBrowse = state.shiftBrowse || event.shiftKey;
    if ((overGraphItem && !temporaryBrowse) || event.button > 1) return;
    const viewport = q('#knowledge-graph-viewport'), rect = viewport.getBoundingClientRect();
    if (effectiveGraphMode(state.mode, temporaryBrowse) === 'move' && event.button === 0 && !state.space) {
      state.pointer = { kind: 'marquee', x: event.clientX - rect.left, y: event.clientY - rect.top,
                        currentX: event.clientX - rect.left, currentY: event.clientY - rect.top,
                        additive: event.ctrlKey || event.metaKey, moved: false };
      q('#knowledge-graph-marquee').classList.remove('hidden'); updateMarquee();
    } else {
      state.pointer = { kind: 'pan', clientX: event.clientX, clientY: event.clientY,
                        viewX: state.view.x, viewY: state.view.y, moved: false };
    }
  }

  function updateMarquee() {
    const p = state.pointer, box = q('#knowledge-graph-marquee');
    const left = Math.min(p.x, p.currentX), top = Math.min(p.y, p.currentY);
    box.style.left = `${left}px`; box.style.top = `${top}px`;
    box.style.width = `${Math.abs(p.currentX - p.x)}px`; box.style.height = `${Math.abs(p.currentY - p.y)}px`;
  }

  async function finishPointer(event) {
    const pointer = state.pointer;
    if (!pointer) return;
    state.pointer = null;
    if (pointer.moved) {
      state.suppressClick = true;
      setTimeout(() => { state.suppressClick = false; }, 0);
    }
    if (pointer.kind === 'node' && pointer.moved) {
      if (graphFilterActive()) { setStatus('临时布局已调整，点击“保存当前布局”写入；返回总览不会改变原位置。'); updateModeControls(); return; }
      const shown = visualPositions(), positions = {};
      for (const id of Object.keys(pointer.originals)) {
        const dx = shown[id].x - pointer.originals[id].x, dy = shown[id].y - pointer.originals[id].y;
        positions[id] = { x: pointer.baseOriginals[id].x + dx, y: pointer.baseOriginals[id].y + dy };
        state.positions[id] = positions[id];
      }
      try {
        const result = await saveGraphPositions(positions, true, `移动 ${Object.keys(positions).length} 张卡片`);
        state.undo = result.undo || state.undo; setStatus(`已保存 ${Object.keys(positions).length} 张卡片的位置。`);
      } catch (error) { setStatus(`❌ ${error.message}`, true); await loadGraph(true); }
      updateModeControls();
    } else if (pointer.kind === 'marquee') {
      q('#knowledge-graph-marquee').classList.add('hidden');
      if (!pointer.additive) state.selected.clear();
      const viewportRect = q('#knowledge-graph-viewport').getBoundingClientRect();
      const selectRect = { left: viewportRect.left + Math.min(pointer.x, pointer.currentX), top: viewportRect.top + Math.min(pointer.y, pointer.currentY),
        right: viewportRect.left + Math.max(pointer.x, pointer.currentX), bottom: viewportRect.top + Math.max(pointer.y, pointer.currentY) };
      q('#knowledge-graph-nodes').querySelectorAll('.knowledge-graph-node').forEach(node => {
        const rect = node.getBoundingClientRect();
        if (rect.right >= selectRect.left && rect.left <= selectRect.right && rect.bottom >= selectRect.top && rect.top <= selectRect.bottom) state.selected.add(node.dataset.id);
      });
      renderGraph();
    } else if (pointer.kind === 'relation') {
      state.ghost = null; renderEdges();
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.knowledge-graph-node');
      if (target && target.dataset.id !== pointer.sourceId && state.nodes.get(target.dataset.id)?.eligible) {
        openRelationDialog({ source_id: pointer.sourceId, target_id: target.dataset.id, label: '' });
      } else setStatus('没有连接到另一张有效卡片，未建立关系。', true);
    }
  }

  function movePointer(event) {
    const p = state.pointer; if (!p) return;
    if (p.kind === 'node') {
      const current = worldPoint(event.clientX, event.clientY), dx = current.x - p.start.x, dy = current.y - p.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) p.moved = true;
      const shown = visualPositions();
      for (const [id, origin] of Object.entries(p.originals)) shown[id] = { x: origin.x + dx, y: origin.y + dy };
      for (const id of Object.keys(p.originals)) {
        const node = q(`.knowledge-graph-node[data-id="${CSS.escape(id)}"]`);
        if (node) { node.style.left = `${shown[id].x}px`; node.style.top = `${shown[id].y}px`; }
      }
      renderEdges();
    } else if (p.kind === 'pan') {
      p.moved = true; state.view.x = p.viewX + event.clientX - p.clientX; state.view.y = p.viewY + event.clientY - p.clientY; applyTransform();
    } else if (p.kind === 'marquee') {
      const rect = q('#knowledge-graph-viewport').getBoundingClientRect();
      p.currentX = event.clientX - rect.left; p.currentY = event.clientY - rect.top; p.moved = true; updateMarquee();
    } else if (p.kind === 'relation') {
      state.ghost.point = worldPoint(event.clientX, event.clientY); renderEdges();
    }
  }

  function fitGraph() {
    const nodes = visibleNodes(); if (!nodes.length) return;
    const shown = visualPositions();
    const xs = nodes.map(node => shown[node.id]?.x || 0), ys = nodes.map(node => shown[node.id]?.y || 0);
    const minX = Math.min(...xs) - 80, minY = Math.min(...ys) - 80;
    const maxX = Math.max(...xs) + 320, maxY = Math.max(...ys) + 190;
    const rect = q('#knowledge-graph-viewport').getBoundingClientRect();
    const scale = Math.max(.18, Math.min(1.25, Math.min(rect.width / Math.max(1, maxX - minX), rect.height / Math.max(1, maxY - minY)) * .92));
    state.view = { scale, x: (rect.width - (maxX - minX) * scale) / 2 - minX * scale,
                   y: (rect.height - (maxY - minY) * scale) / 2 - minY * scale };
    applyTransform();
  }

  function changeZoom(factor, point = null) {
    const rect = q('#knowledge-graph-viewport').getBoundingClientRect();
    const center = point || { x: rect.width / 2, y: rect.height / 2 };
    state.view = zoomAroundPoint(state.view, center, state.view.scale * factor); applyTransform();
  }

  async function arrangeGraphByRelations() {
    if (state.busy || !state.nodes.size) return;
    const nodes = visibleNodes();
    const links = state.edges.filter(edge => state.visible.has(edge.source_id) && state.visible.has(edge.target_id));
    if (!links.length) { setStatus('当前搜索和筛选范围内没有可供 AI 理解的关联。', true); return; }
    state.expanded = '';
    state.busy = true; updateModeControls();
    setStatus(`AI 正在通读 ${nodes.length} 张卡片和 ${links.length} 条关系，判断主题、中心、阵营与层级……`);
    try {
      const planned = await graphApi(`/api/projects/${state.projectId}/knowledge/graph/ai-layout`, graphJson('POST', {
        node_ids: nodes.map(node => node.id),
        edge_ids: links.map(edge => edge.id).filter(Boolean),
      }));
      const positions = planned.positions || {};
      if (Object.keys(positions).length !== nodes.length) throw new Error('AI返回的布局没有覆盖当前全部卡片，请重试');
      const groupCount = (planned.groups || []).length;
      const rationale = String(planned.rationale || '').trim();
      if (graphFilterActive()) {
        state.transientPositions = positions;
        state.layoutFilterKey = '';
        renderGraph(); requestAnimationFrame(fitGraph);
        setStatus(`AI 已把当前筛选结果规划为 ${groupCount} 个关系组；这是临时预览，可点击“保存当前布局”。${rationale ? ` ${rationale}` : ''}`);
        return;
      }
      const result = await saveGraphPositions(positions, true, `AI 智能排布 ${Object.keys(positions).length} 张卡片`);
      state.positions = positions; state.transientPositions = null; state.undo = result.undo || state.undo;
      renderGraph(); requestAnimationFrame(fitGraph);
      const fallback = Number(planned.unassigned_count || 0);
      setStatus(`AI 已规划 ${groupCount} 个关系组${fallback ? `，并为模型遗漏的 ${fallback} 张卡片安排了安全位置` : ''}；位置变化可以撤销。${rationale ? ` ${rationale}` : ''}`);
    } catch (error) { setStatus(`❌ AI 智能排布失败：${error.message}；当前布局没有被覆盖。`, true); }
    finally { state.busy = false; updateModeControls(); }
  }

  async function placeNewRelationNode(sourceId, targetId, sourceHadRelations, targetHadRelations, layoutMode = 'cluster') {
    let movingId = '', anchorId = '';
    if (sourceHadRelations && !targetHadRelations) { movingId = targetId; anchorId = sourceId; }
    else if (!sourceHadRelations && targetHadRelations) { movingId = sourceId; anchorId = targetId; }
    else if (!sourceHadRelations && !targetHadRelations) { movingId = targetId; anchorId = sourceId; }
    if (!movingId || !state.nodes.has(movingId) || !state.nodes.has(anchorId)) {
      setStatus('关系已保存；两端卡片都已有关系，因此保留原位置。'); return;
    }
    let preferredOffset = null;
    if (layoutMode === 'opposition') preferredOffset = [460, 0];
    else if (layoutMode === 'sequence') preferredOffset = movingId === targetId ? [360, 0] : [-360, 0];
    else if (layoutMode === 'hierarchy_source') preferredOffset = movingId === targetId ? [360, 0] : [-360, 0];
    else if (layoutMode === 'hierarchy_target') preferredOffset = movingId === sourceId ? [360, 0] : [-360, 0];
    const point = nearestFreeRelationPosition(anchorId, movingId, preferredOffset);
    state.busy = true; updateModeControls();
    try {
      const result = await saveGraphPositions({ [movingId]: point }, true, '让未关联卡片靠近关系簇');
      state.positions[movingId] = point; state.undo = result.undo || state.undo;
      renderGraph();
      setStatus('关系已保存；只移动了原本未建立关系的卡片，已有关系簇保持原位。');
    } catch (error) { setStatus(`关系已保存，但新卡片位置保存失败：${error.message}`, true); await loadGraph(true); }
    finally { state.busy = false; updateModeControls(); }
  }

  async function arrangeGraphByType() {
    if (state.busy || !state.nodes.size) return;
    const relatedIds = new Set(state.edges.flatMap(edge => [edge.source_id, edge.target_id]));
    const nodes = visibleNodes().filter(node => !relatedIds.has(node.id));
    if (!nodes.length) { setStatus('当前范围没有未关联卡片；已有关系的卡片只会在移动模式或“按关系整理”时移动。'); return; }
    const shown = visualPositions();
    const fixedY = visibleNodes().filter(node => relatedIds.has(node.id)).map(node => shown[node.id]?.y || 0);
    const baseY = fixedY.length ? Math.max(...fixedY) + 260 : 0;
    const arranged = computeTypeTimeLayout(nodes);
    const positions = Object.fromEntries(Object.entries(arranged).map(([id, point]) => [id, { x: point.x, y: point.y + baseY }]));
    if (graphFilterActive()) {
      state.transientPositions = { ...shown, ...positions }; renderGraph(); requestAnimationFrame(fitGraph);
      setStatus('已临时整理未关联卡片；已有关系的卡片位置未改变，可点击“保存当前布局”。'); return;
    }
    state.busy = true; updateModeControls(); setStatus('正在按类型和来源时间整理未关联卡片……');
    try {
      const result = await saveGraphPositions(positions, true, '按类型整理未关联卡片');
      Object.assign(state.positions, positions); state.undo = result.undo || state.undo;
      renderGraph(); requestAnimationFrame(fitGraph);
      setStatus('已按类型和来源时间整理未关联卡片；已有关系的卡片位置未改变。');
    } catch (error) { setStatus(`❌ ${error.message}`, true); await loadGraph(true); }
    finally { state.busy = false; updateModeControls(); }
  }

  function relationDirectionText(relation) {
    const source = state.nodes.get(relation.source_id), target = state.nodes.get(relation.target_id);
    return `${source?.title || '来源卡片'} → ${target?.title || '目标卡片'}`;
  }

  function relationPeriodLabel(relation) {
    const start = relation?.valid_from_chapter?.title || '';
    const end = relation?.invalid_from_chapter?.title || '';
    if (start && end) return `${start}起，${end}起失效`;
    if (end) return `${end}起失效`;
    if (start) return `${start}起，持续有效`;
    if (relation?.invalid_from_chapter_id) return '失效章节待修正';
    return '长期有效';
  }

  function graphRelationChapterOptions(selectedId, endBoundary = false) {
    const blank = endBoundary ? '尚未失效，持续有效' : '未指定，默认长期存在';
    return `<option value="">${blank}</option>` + state.segmentChapters.map(chapter =>
      `<option value="${escGraph(chapter.id)}" ${chapter.id === selectedId ? 'selected' : ''}>${escGraph(chapter.title)}</option>`).join('');
  }

  function openRelationDialog(relation) {
    state.relation = { ...relation };
    q('#knowledge-graph-relation-title').textContent = relation.id ? '编辑卡片关联' : '建立卡片关联';
    q('#knowledge-graph-relation-direction').textContent = relationDirectionText(state.relation);
    const labelInput = q('#knowledge-graph-relation-label');
    const layoutSelect = q('#knowledge-graph-relation-layout');
    labelInput.value = relation.label || '';
    const syncLayout = () => {
      const selected = relationLayoutMode(labelInput.value, state.tagCatalog.relation_layouts || {});
      layoutSelect.innerHTML = relationLayoutSelectOptions(selected);
    };
    syncLayout(); labelInput.oninput = syncLayout;
    q('#knowledge-graph-relation-valid-from').innerHTML = graphRelationChapterOptions(relation.valid_from_chapter_id || '', false);
    q('#knowledge-graph-relation-invalid-from').innerHTML = graphRelationChapterOptions(relation.invalid_from_chapter_id || '', true);
    const library = q('#knowledge-graph-relation-label-library');
    const labels = state.tagCatalog.relation_labels || [];
    library.innerHTML = labels.length
      ? `<span class="hint">常用关系：</span>${labels.map(label => `<button class="ghost" data-label="${escGraph(label)}">${escGraph(label)}</button>`).join('')}`
      : '<span class="hint">保存一次关系名称后，以后会在这里直接显示。</span>';
    library.querySelectorAll('[data-label]').forEach(button => button.addEventListener('click', () => {
      labelInput.value = button.dataset.label; syncLayout(); labelInput.focus();
    }));
    q('#knowledge-graph-relation-delete').classList.toggle('hidden', !relation.id);
    q('#knowledge-graph-relation-error').textContent = '';
    q('#knowledge-graph-relation-dialog').classList.remove('hidden');
    setTimeout(() => q('#knowledge-graph-relation-label').focus(), 0);
  }

  function closeRelationDialog() {
    state.relation = null; q('#knowledge-graph-relation-dialog').classList.add('hidden');
  }

  async function saveRelation() {
    const relation = state.relation; if (!relation) return;
    const label = q('#knowledge-graph-relation-label').value.trim();
    if (!label) { q('#knowledge-graph-relation-error').textContent = '请填写关系名称。'; return; }
    const isNew = !relation.id;
    const layoutMode = q('#knowledge-graph-relation-layout').value;
    const sourceHadRelations = state.edges.some(edge => edge.source_id === relation.source_id || edge.target_id === relation.source_id);
    const targetHadRelations = state.edges.some(edge => edge.source_id === relation.target_id || edge.target_id === relation.target_id);
    let saved = false;
    state.busy = true; updateModeControls();
    try {
      const url = relation.id
        ? `/api/projects/${state.projectId}/knowledge/graph/relations/${relation.id}`
        : `/api/projects/${state.projectId}/knowledge/graph/relations`;
      await graphApi(url, graphJson(relation.id ? 'PUT' : 'POST', {
        source_id: relation.source_id, target_id: relation.target_id, label,
        layout_mode: layoutMode,
        valid_from_chapter_id: q('#knowledge-graph-relation-valid-from').value,
        invalid_from_chapter_id: q('#knowledge-graph-relation-invalid-from').value,
      }));
      closeRelationDialog(); await loadGraph(true);
      saved = true;
      if (!isNew) setStatus('关系修改已保存，卡片位置未改变。');
    } catch (error) { q('#knowledge-graph-relation-error').textContent = `❌ ${error.message}`; }
    finally { state.busy = false; updateModeControls(); }
    if (saved && isNew) await placeNewRelationNode(
      relation.source_id, relation.target_id, sourceHadRelations, targetHadRelations,
      layoutMode,
    );
  }

  async function deleteRelation() {
    if (!state.relation?.id) return;
    state.busy = true; updateModeControls();
    try {
      await graphApi(`/api/projects/${state.projectId}/knowledge/graph/relations/${state.relation.id}`, { method: 'DELETE' });
      closeRelationDialog(); await loadGraph(true); setStatus('关系已删除，可以使用撤销恢复。');
    } catch (error) { q('#knowledge-graph-relation-error').textContent = `❌ ${error.message}`; }
    finally { state.busy = false; updateModeControls(); }
  }

  function renderCardEditSidebar(node) {
    if (!node) return;
    const panel = q('#knowledge-graph-sidebar'); panel.classList.remove('hidden');
    panel.innerHTML = `<div class="card-head"><h3>编辑知识卡片</h3><button class="ghost graph-sidebar-close">关闭</button></div>
      <p class="hint">可以修改知识内容并追加来源章节；已有来源不会被移除，画布位置保持不变。</p>
      <label class="field"><span>类型</span><select class="graph-card-type">${EDITABLE_TYPES.map(type => `<option value="${type}" ${type === node.type ? 'selected' : ''}>${TYPE_LABELS[type]}</option>`).join('')}</select></label>
      <label class="field"><span>标题</span><input class="graph-card-title" maxlength="300" value="${escGraph(node.title || '')}"></label>
      <label class="field"><span>卡片内容</span><textarea class="graph-card-summary" maxlength="4000" rows="12">${escGraph(node.summary || '')}</textarea></label>
      <div class="field graph-card-sources"><span>追加来源章节</span><input class="graph-card-source-search" placeholder="搜索章节"><div class="knowledge-source-options graph-card-source-options"></div><small class="hint graph-card-source-count"></small></div>
      <div class="field graph-card-tags"><span>细分标签</span><div class="knowledge-tag-selected"></div><div class="row"><input class="graph-card-tag-input" maxlength="30" placeholder="输入新细分，如：人类"><button class="ghost graph-card-tag-add">添加</button></div><div class="knowledge-tag-suggestions"></div><small class="hint">细分归属于上方所选类型；保存后，同类卡片可以直接点击复用。</small></div>
      <div class="row"><button class="primary graph-card-save">保存为用户确认</button><button class="ghost graph-card-cancel">取消</button></div>
      <p class="hint graph-sidebar-status"></p>`;
    const originalTags = Array.isArray(node.details?.tags) ? node.details.tags : [];
    const periodEditors = new Map([[node.type, window.KnowledgeTagPeriods.editor(node.details?.tag_periods || [])]]);
    const periodHost = document.createElement('div'); periodHost.className = 'tag-period-editor';
    panel.querySelector('.knowledge-tag-selected').after(periodHost);
    const selectedPeriods = () => {
      if (!periodEditors.has(typeInput.value)) periodEditors.set(typeInput.value, window.KnowledgeTagPeriods.editor());
      return periodEditors.get(typeInput.value);
    };
    const existingSources = new Set((node.source_chapters || []).map(chapter => chapter.id));
    const selectedSources = new Set(existingSources);
    const selections = new Map([[node.type, new Set(originalTags)]]);
    const typeInput = panel.querySelector('.graph-card-type');
    const selectedTags = () => {
      if (!selections.has(typeInput.value)) selections.set(typeInput.value, new Set());
      return selections.get(typeInput.value);
    };
    const renderTags = () => {
      const selected = selectedTags();
      selectedPeriods().render(periodHost, selected, state.segmentChapters);
      panel.querySelector('.knowledge-tag-selected').innerHTML = selected.size
        ? [...selected].map(tag => `<button class="knowledge-tag-chip selected" data-selected-tag="${escGraph(tag)}" title="点击移除">${escGraph(tag)} ×</button>`).join('')
        : '<span class="hint">尚未选择细分</span>';
      const options = state.tagCatalog.card_tags?.[typeInput.value] || [];
      panel.querySelector('.knowledge-tag-suggestions').innerHTML = options.length
        ? `<span class="hint">已保存的${escGraph(TYPE_LABELS[typeInput.value])}细分：</span>${options.map(tag => `<span class="knowledge-tag-option"><button class="ghost knowledge-tag-choice ${selected.has(tag) ? 'active' : ''}" data-tag="${escGraph(tag)}">${escGraph(tag)}</button><button class="ghost danger knowledge-tag-delete" data-delete-tag="${escGraph(tag)}" title="删除这个细分类型" aria-label="删除细分${escGraph(tag)}">×</button></span>`).join('')}`
        : `<span class="hint">${escGraph(TYPE_LABELS[typeInput.value])}类还没有保存过细分。</span>`;
      panel.querySelectorAll('[data-selected-tag]').forEach(button => button.onclick = () => { selected.delete(button.dataset.selectedTag); renderTags(); });
      panel.querySelectorAll('.knowledge-tag-choice').forEach(button => button.onclick = () => {
        const tag = button.dataset.tag;
        if (selected.has(tag)) selected.delete(tag); else if (selected.size < 20) selected.add(tag);
        renderTags();
      });
      panel.querySelectorAll('[data-delete-tag]').forEach(button => button.onclick = async () => {
        const type = typeInput.value, tag = button.dataset.deleteTag;
        const usage = state.tagCatalog.card_tag_usage?.[type]?.[tag] || 0;
        const impact = usage ? `这会同时从 ${usage} 张“${TYPE_LABELS[type] || type}”卡片中移除该细分及其生效、失效时间。` : '这会从该大类的复用选项中移除它。';
        if (!window.confirm(`删除细分“${tag}”？${impact}`)) return;
        state.busy = true; panel.querySelectorAll('button,input,textarea,select').forEach(element => element.disabled = true); updateModeControls();
        try {
          const result = await graphApi(`/api/projects/${state.projectId}/knowledge/tag-catalog`,
            graphJson('DELETE', { card_type: type, tag }));
          close(); await loadGraph(true, false);
          setStatus(`细分“${tag}”已删除${result.affected_cards ? `，并已从 ${result.affected_cards} 张卡片移除` : ''}。${result.warning || ''}`);
        } catch (error) {
          panel.querySelector('.graph-sidebar-status').textContent = `❌ ${error.message}`;
          panel.querySelectorAll('button,input,textarea,select').forEach(element => element.disabled = false);
        } finally { state.busy = false; updateModeControls(); }
      });
    };
    const addTag = () => {
      const input = panel.querySelector('.graph-card-tag-input'), tag = input.value.trim();
      if (!tag) return;
      if (selectedTags().size >= 20) { panel.querySelector('.graph-sidebar-status').textContent = '❌ 每张卡片最多选择20个细分。'; return; }
      selectedTags().add(tag); input.value = ''; renderTags();
    };
    typeInput.addEventListener('change', renderTags);
    const renderSources = () => {
      const query = panel.querySelector('.graph-card-source-search').value.trim().toLocaleLowerCase();
      const chapters = state.segmentChapters.filter(chapter => chapter.has_text !== false &&
        (!query || `${chapter.position || ''} ${chapter.title || ''}`.toLocaleLowerCase().includes(query)));
      panel.querySelector('.graph-card-source-options').innerHTML = chapters.map(chapter => {
        const fixed = existingSources.has(chapter.id);
        return `<label class="knowledge-source-option ${fixed ? 'fixed' : ''}"><input type="checkbox" value="${escGraph(chapter.id)}" ${selectedSources.has(chapter.id) ? 'checked' : ''} ${fixed ? 'disabled' : ''}><span>${escGraph(chapter.title)}</span>${fixed ? '<small>已有来源</small>' : ''}</label>`;
      }).join('') || '<span class="hint">没有匹配章节。</span>';
      panel.querySelectorAll('.graph-card-source-options input:not(:disabled)').forEach(box => box.onchange = () => {
        if (box.checked) selectedSources.add(box.value); else selectedSources.delete(box.value);
        panel.querySelector('.graph-card-source-count').textContent = `已选择 ${selectedSources.size} 章，其中 ${existingSources.size} 章为原有来源。`;
      });
      panel.querySelector('.graph-card-source-count').textContent = `已选择 ${selectedSources.size} 章，其中 ${existingSources.size} 章为原有来源。`;
    };
    panel.querySelector('.graph-card-source-search').addEventListener('input', renderSources);
    panel.querySelector('.graph-card-tag-add').addEventListener('click', addTag);
    panel.querySelector('.graph-card-tag-input').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addTag(); } });
    renderTags(); renderSources();
    const close = () => panel.classList.add('hidden');
    panel.querySelector('.graph-sidebar-close').addEventListener('click', close);
    panel.querySelector('.graph-card-cancel').addEventListener('click', close);
    panel.querySelector('.graph-card-save').addEventListener('click', async () => {
      const type = panel.querySelector('.graph-card-type').value;
      const title = panel.querySelector('.graph-card-title').value.trim();
      const summary = panel.querySelector('.graph-card-summary').value.trim();
      const status = panel.querySelector('.graph-sidebar-status');
      if (!title || !summary) { status.textContent = '❌ 标题和卡片内容不能为空。'; return; }
      state.busy = true; panel.querySelectorAll('button,input,textarea,select').forEach(element => element.disabled = true); updateModeControls();
      status.textContent = '正在保存并更新知识索引……';
      try {
        await graphApi(`/api/projects/${state.projectId}/knowledge/${node.id}`, graphJson('PUT', {
          type, title, summary, tags: [...selectedTags()], tag_periods: selectedPeriods().values(selectedTags()), source_chapter_ids: [...selectedSources], review_status: 'confirmed',
        }));
        const movedOut = !ALL_TYPES.includes(type);
        close(); await loadGraph(true, false); state.expanded = movedOut ? '' : node.id; renderGraph();
        setStatus(movedOut
          ? `卡片已改为“${TYPE_LABELS[type]}”并移出实体画布，可在对应分区查看。`
          : '卡片修改已保存为用户确认；关联和画布位置保持不变。');
      } catch (error) { status.textContent = `❌ ${error.message}`; }
      finally {
        state.busy = false;
        panel.querySelectorAll('button,input,textarea,select').forEach(element => element.disabled = false);
        updateModeControls();
      }
    });
  }

  function graphMergeStateChangesHtml(proposal) {
    if (proposal.item?.type !== 'character') return '';
    const changes = proposal.state_changes || [];
    return `<section class="merge-state-section"><h4>阶段状态候选</h4><p class="hint">稳定资料留在人物卡；保留的阶段变化会写入剧情事件并更新当前快照。</p>
      ${(proposal.state_change_warnings || []).map(value => `<p class="hint">⚠ ${escGraph(value)}</p>`).join('')}
      ${changes.length ? changes.map(change => `<article class="evidence-item graph-merge-state" data-id="${escGraph(change.id)}">
        <label class="field"><span>事件标题</span><input class="graph-state-title" maxlength="300" value="${escGraph(change.title || '')}"></label>
        <label class="field"><span>事件概括</span><textarea class="graph-state-summary" rows="2">${escGraph(change.summary || '')}</textarea></label>
        <label class="field"><span>状态字段</span><input class="graph-state-key" maxlength="200" value="${escGraph(change.state_key || '')}"></label>
        <div class="row"><label class="field"><span>变化前</span><textarea class="graph-state-before" rows="2">${escGraph(change.state_before || '')}</textarea></label><label class="field"><span>变化后</span><textarea class="graph-state-after" rows="2">${escGraph(change.state_after || '')}</textarea></label></div>
        <label class="field"><span>变化原因</span><input class="graph-state-reason" maxlength="1200" value="${escGraph(change.change_reason || '')}"></label>
        <label class="field"><span>持续性</span><select class="graph-state-persistence"><option value="unknown" ${change.persistence === 'unknown' ? 'selected' : ''}>待确认</option><option value="ongoing" ${change.persistence === 'ongoing' ? 'selected' : ''}>持续有效</option><option value="temporary" ${change.persistence === 'temporary' ? 'selected' : ''}>临时状态</option><option value="permanent" ${change.persistence === 'permanent' ? 'selected' : ''}>不可逆变化</option></select></label>
        <details><summary>查看依据 · ${escGraph(change.source_chapter_title || '来源章节')}</summary>${(change.source_quotes || []).map(quote => `<blockquote>${escGraph(quote)}</blockquote>`).join('')}</details>
        <button class="ghost danger graph-remove-state" type="button">不保留这条阶段状态</button></article>`).join('') : '<p class="hint">没有找到带可靠依据的阶段变化，本次只保存稳定档案。</p>'}</section>`;
  }

  function collectGraphMergeStateChanges(panel) {
    return [...panel.querySelectorAll('.graph-merge-state')].map(row => ({
      id: row.dataset.id, title: row.querySelector('.graph-state-title').value,
      summary: row.querySelector('.graph-state-summary').value,
      state_key: row.querySelector('.graph-state-key').value,
      state_before: row.querySelector('.graph-state-before').value,
      state_after: row.querySelector('.graph-state-after').value,
      change_reason: row.querySelector('.graph-state-reason').value,
      persistence: row.querySelector('.graph-state-persistence').value,
    }));
  }

  function renderMergeSidebar(proposal) {
    const panel = q('#knowledge-graph-sidebar'); panel.classList.remove('hidden');
    panel.innerHTML = `<div class="card-head"><h3>合并草稿</h3><button class="ghost graph-sidebar-close">关闭</button></div>
      <p class="hint">请检查阶段变化与冲突，确认后才会替换画布中的原卡片。</p>
      <label class="field"><span>类型</span><select class="graph-merge-type">${ALL_TYPES.map(type => `<option value="${type}" ${type === proposal.item.type ? 'selected' : ''}>${TYPE_LABELS[type]}</option>`).join('')}</select></label>
      <label class="field"><span>标题</span><input class="graph-merge-title" value="${escGraph(proposal.item.title || '')}"></label>
      <label class="field"><span>合并内容</span><textarea class="graph-merge-summary" rows="8">${escGraph(proposal.item.summary || '')}</textarea></label>
      ${graphMergeStateChangesHtml(proposal)}
      <label class="field"><span>重新生成要求（可选）</span><textarea class="graph-merge-regenerate-instruction" rows="3" placeholder="例如：突出后期已经确认的结论，减少过程复述"></textarea></label>
      <details open><summary>原卡片（${(proposal.originals || []).length}）</summary>${(proposal.originals || []).map(item => `<div class="evidence-item"><strong>${escGraph(item.title)}</strong><p>${escGraph(item.summary)}</p></div>`).join('')}</details>
      ${(proposal.related || []).length ? `<details><summary>只读关联依据（${proposal.related.length}）</summary>${proposal.related.map(item => `<div class="evidence-item"><strong>${escGraph(item.title)}</strong><p>${escGraph(item.summary)}</p></div>`).join('')}</details>` : ''}
      <div class="row"><button class="primary graph-merge-apply">确认合并</button><button class="ghost graph-merge-regenerate">快速重新生成</button><button class="ghost graph-merge-dismiss">取消本次合并</button></div>
      <p class="hint">快速重新生成会复用本次卡片上下文，不重新通读章节，也不重新扫描全部卡片。</p><p class="hint graph-sidebar-status"></p>`;
    panel.querySelector('.graph-sidebar-close').addEventListener('click', () => panel.classList.add('hidden'));
    panel.querySelectorAll('.graph-remove-state').forEach(button => button.addEventListener('click', () => button.closest('.graph-merge-state').remove()));
    panel.querySelector('.graph-merge-apply').addEventListener('click', () => finishGraphMerge('apply', proposal));
    panel.querySelector('.graph-merge-regenerate').addEventListener('click', () => regenerateGraphMerge(proposal));
    panel.querySelector('.graph-merge-dismiss').addEventListener('click', () => finishGraphMerge('dismiss', proposal));
  }

  async function regenerateGraphMerge(proposal) {
    if (state.busy) return;
    const panel = q('#knowledge-graph-sidebar');
    const instruction = panel.querySelector('.graph-merge-regenerate-instruction')?.value.trim() || '';
    state.busy = true; updateModeControls(); renderMergeProgress('正在复用卡片上下文快速重新生成，不会重新通读章节……');
    try {
      const started = await graphApi(`/api/projects/${state.projectId}/knowledge/merge/regenerate`, graphJson('POST', {
        proposal_id: proposal.id, instruction,
      }));
      const done = await graphPoll(started.task_id);
      const wanted = done.result?.proposal_id;
      const payload = await loadGraph(true, false);
      const replacement = (payload.merge_proposals || []).find(item => item.id === wanted);
      if (!replacement) throw new Error('新合并草稿已经不存在，请重新选择卡片');
      renderMergeSidebar(replacement); setStatus('新草稿已快速生成，本次没有重新通读章节。');
    } catch (error) { panel.classList.add('hidden'); setStatus(`❌ ${error.message}`, true); }
    finally { state.busy = false; updateModeControls(); }
  }

  function renderMergeProgress(text) {
    const panel = q('#knowledge-graph-sidebar'); panel.classList.remove('hidden');
    panel.innerHTML = `<h3>正在生成合并草稿</h3><p class="hint">${escGraph(text || '正在调用分析模型……')}</p><div class="progress"><div class="progress-bar"><div class="progress-fill" style="width:35%"></div></div></div>`;
  }

  async function graphPoll(taskId) {
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 800));
      const progress = await graphApi(`/api/progress/${taskId}`);
      renderMergeProgress(progress.message);
      if (progress.status === 'done') return progress;
      if (progress.status === 'error') throw new Error(progress.error || '合并草稿生成失败');
    }
  }

  async function startGraphMerge() {
    if (state.selected.size < 2 || state.selected.size > 12 || state.busy) return;
    state.busy = true; updateModeControls(); renderMergeProgress('正在准备所选卡片……');
    try {
      const started = await graphApi(`/api/projects/${state.projectId}/knowledge/merge/suggest`, graphJson('POST', { item_ids: [...state.selected] }));
      const done = await graphPoll(started.task_id);
      const wanted = done.result?.proposal_id;
      const payload = await loadGraph(true, false);
      const proposal = (payload.merge_proposals || []).find(item => item.id === wanted) || (payload.merge_proposals || [])[0];
      if (!proposal) throw new Error('合并草稿已经不存在，请重新选择卡片');
      renderMergeSidebar(proposal); setStatus('合并草稿已生成，请在右侧检查。');
    } catch (error) { q('#knowledge-graph-sidebar').classList.add('hidden'); setStatus(`❌ ${error.message}`, true); }
    finally { state.busy = false; updateModeControls(); }
  }

  async function finishGraphMerge(action, proposal) {
    const panel = q('#knowledge-graph-sidebar'); state.busy = true; panel.querySelectorAll('button').forEach(button => button.disabled = true); updateModeControls();
    try {
      const body = { proposal_id: proposal.id, edited: {}, record_graph_action: action === 'apply' };
      if (action === 'apply') body.edited = { type: panel.querySelector('.graph-merge-type').value,
        title: panel.querySelector('.graph-merge-title').value, summary: panel.querySelector('.graph-merge-summary').value,
        state_changes: collectGraphMergeStateChanges(panel) };
      await graphApi(`/api/projects/${state.projectId}/knowledge/merge/${action}`, graphJson('POST', body));
      state.selected.clear(); panel.classList.add('hidden'); await loadGraph(true);
      setStatus(action === 'apply' ? '合并已保存，新卡片放在原卡片组中心；可以撤销。' : '本次合并已取消。');
    } catch (error) { panel.querySelector('.graph-sidebar-status').textContent = `❌ ${error.message}`; }
    finally { state.busy = false; panel.querySelectorAll('button').forEach(button => button.disabled = false); updateModeControls(); }
  }

  async function undoGraph() {
    if (!state.undo.can_undo || state.busy) return;
    state.busy = true; updateModeControls();
    try {
      const result = await graphApi(`/api/projects/${state.projectId}/knowledge/graph/undo`, { method: 'POST' });
      await loadGraph(true); setStatus(`已撤销：${result.undone}。`);
    } catch (error) { setStatus(`❌ ${error.message}`, true); }
    finally { state.busy = false; updateModeControls(); }
  }

  async function updateSegmentNodes(ids, action, restoreRelations = true) {
    if (!state.segmentId || !ids.length || state.busy) return;
    state.busy = true; updateModeControls();
    try {
      await graphApi(`/api/projects/${state.projectId}/knowledge/segments/${state.segmentId}/nodes`,
        graphJson('PUT', { node_ids: ids, action, restore_relations: restoreRelations }));
      state.selected.clear(); state.expanded = ''; await loadGraph(true, false);
      setStatus(action === 'exclude' ? `已将 ${ids.length} 张卡片移出当前剧情段；全书知识和关联未删除。` : `已向当前剧情段加入 ${ids.length} 张卡片。`);
    } catch (error) { setStatus(`❌ ${error.message}`, true); }
    finally { state.busy = false; updateModeControls(); }
  }

  function renderCreateSegmentSidebar() {
    const panel = q('#knowledge-graph-sidebar'); panel.classList.remove('hidden');
    const used = new Set(state.segments.flatMap(segment => segment.chapter_ids || []));
    panel.innerHTML = `<div class="card-head"><h3>新建剧情段</h3><button class="ghost graph-sidebar-close">关闭</button></div>
      <p class="hint">选择一段连续章节。新分段会继承上一段的卡片和位置，再加入本段新出现的卡片。</p>
      <label class="field"><span>分段名称</span><input class="segment-name" maxlength="120" placeholder="例如：百年好盒婚丧服务部篇"></label>
      <div class="row"><label class="field"><span>起始章节</span><select class="segment-range-start"><option value="">请选择</option>${state.segmentChapters.filter(chapter => !used.has(chapter.id)).map(chapter => `<option value="${escGraph(chapter.id)}">${escGraph(chapter.title)}</option>`).join('')}</select></label><label class="field"><span>结束章节</span><select class="segment-range-end"><option value="">请选择</option>${state.segmentChapters.filter(chapter => !used.has(chapter.id)).map(chapter => `<option value="${escGraph(chapter.id)}">${escGraph(chapter.title)}</option>`).join('')}</select></label><button class="ghost segment-select-range">勾选范围</button></div>
      <div class="segment-chapter-picker">${state.segmentChapters.map(chapter => `<label class="${used.has(chapter.id) ? 'disabled' : ''}"><input type="checkbox" value="${escGraph(chapter.id)}" ${used.has(chapter.id) ? 'disabled' : ''}><span>${escGraph(chapter.title)}</span></label>`).join('')}</div>
      <div class="row"><button class="primary segment-create-save">创建分段</button><button class="ghost graph-sidebar-close">取消</button></div><p class="hint segment-sidebar-status"></p>`;
    panel.querySelectorAll('.graph-sidebar-close').forEach(button => button.onclick = () => panel.classList.add('hidden'));
    panel.querySelector('.segment-select-range').onclick = () => {
      const start = state.segmentChapters.findIndex(chapter => chapter.id === panel.querySelector('.segment-range-start').value);
      const end = state.segmentChapters.findIndex(chapter => chapter.id === panel.querySelector('.segment-range-end').value);
      if (start < 0 || end < 0) return;
      const low = Math.min(start, end), high = Math.max(start, end);
      panel.querySelectorAll('.segment-chapter-picker input').forEach(input => {
        const index = state.segmentChapters.findIndex(chapter => chapter.id === input.value);
        if (!input.disabled) input.checked = index >= low && index <= high;
      });
    };
    panel.querySelector('.segment-create-save').onclick = async () => {
      const chapterIds = [...panel.querySelectorAll('.segment-chapter-picker input:checked')].map(input => input.value);
      const status = panel.querySelector('.segment-sidebar-status');
      try {
        const created = await graphApi(`/api/projects/${state.projectId}/knowledge/segments`, graphJson('POST', {
          name: panel.querySelector('.segment-name').value, chapter_ids: chapterIds,
        }));
        state.segmentId = created.id; panel.classList.add('hidden'); await loadGraph(false, false);
        setStatus('剧情段已创建；已继承前段画布并加入本段有原文依据的新卡片。');
      } catch (error) { status.textContent = `❌ ${error.message}`; }
    };
  }

  function renderSegmentCardLibrary(autoPrompt = false) {
    const segment = activeSegment(); if (!segment) return;
    const panel = q('#knowledge-graph-sidebar'); panel.classList.remove('hidden');
    const active = new Set(Object.entries(segment.nodes || {}).filter(([, node]) => node.active).map(([id]) => id));
    const choices = state.segmentCards.filter(card => !active.has(card.id));
    const pending = new Set(Object.entries(segment.nodes || {}).filter(([, node]) => node.pending_restore).map(([id]) => id));
    panel.innerHTML = `<div class="card-head"><h3>${autoPrompt ? '发现重新出现的卡片' : '向本段加入卡片'}</h3><button class="ghost graph-sidebar-close">关闭</button></div>
      <p class="hint">${pending.size ? `${pending.size} 张以前移出的卡片在本段再次出现。` : '搜索全书卡片，加入只影响当前剧情段。'}</p>
      <input class="segment-card-search" type="search" placeholder="搜索标题或内容">
      <div class="segment-card-library"></div>
      <label><input class="segment-restore-relations" type="checkbox" checked> 恢复其与当前画布卡片的原有关联</label>
      <div class="row"><button class="primary segment-card-add-save">加入所选卡片</button><button class="ghost graph-sidebar-close">取消</button></div><p class="hint segment-sidebar-status"></p>`;
    const paint = () => {
      const query = panel.querySelector('.segment-card-search').value.trim().toLocaleLowerCase();
      panel.querySelector('.segment-card-library').innerHTML = choices.filter(card => !query || `${card.title} ${card.summary}`.toLocaleLowerCase().includes(query))
        .sort((a, b) => Number(pending.has(b.id)) - Number(pending.has(a.id)) || a.title.localeCompare(b.title))
        .map(card => `<label class="segment-card-option"><input type="checkbox" value="${escGraph(card.id)}"><span><strong>${escGraph(TYPE_LABELS[card.type])} · ${escGraph(card.title)}</strong>${pending.has(card.id) ? '<small>本段再次出现 · 可恢复关联</small>' : ''}<small>${escGraph((card.summary || '').slice(0, 150))}</small></span></label>`).join('') || '<p class="hint">没有可加入的卡片。</p>';
    };
    panel.querySelector('.segment-card-search').oninput = paint; paint();
    panel.querySelectorAll('.graph-sidebar-close').forEach(button => button.onclick = () => panel.classList.add('hidden'));
    panel.querySelector('.segment-card-add-save').onclick = async () => {
      const ids = [...panel.querySelectorAll('.segment-card-library input:checked')].map(input => input.value);
      if (!ids.length) { panel.querySelector('.segment-sidebar-status').textContent = '请先选择卡片。'; return; }
      panel.classList.add('hidden'); await updateSegmentNodes(ids, 'add', panel.querySelector('.segment-restore-relations').checked);
    };
  }

  async function loadGraph(preserveView = false, renderPending = true) {
    const [payload, segmentPayload] = await Promise.all([
      graphApi(`/api/projects/${state.projectId}/knowledge/graph`),
      graphApi(`/api/projects/${state.projectId}/knowledge/segments`),
    ]);
    state.segments = segmentPayload.segments || []; state.segmentChapters = segmentPayload.chapters || [];
    state.segmentCards = segmentPayload.cards || [];
    if (state.segmentId && !state.segments.some(segment => segment.id === state.segmentId)) state.segmentId = '';
    const segment = activeSegment();
    const allNodes = payload.nodes || [];
    const activeIds = segment ? new Set(Object.entries(segment.nodes || {}).filter(([, meta]) => meta.active).map(([id]) => id)) : null;
    state.nodes = new Map(allNodes.filter(node => !activeIds || activeIds.has(node.id)).map(node => [node.id, {
      ...node, ...(segment ? { segment_meta: segment.nodes[node.id] || {} } : {}),
    }]));
    const hiddenEdges = new Set(segment?.hidden_edge_ids || []);
    state.edges = (payload.edges || []).filter(edge => !hiddenEdges.has(edge.id));
    if (state.focus) {
      for (const node of state.nodes.values()) if ((node.details?.merged_from || []).some(id => state.focus.ids.has(id))) {
        state.focus.ids.add(node.id); if (!state.nodes.has(state.focus.root)) state.focus.root = node.id;
      }
    }
    state.tagCatalog = payload.tag_catalog || { card_tags: {}, relation_labels: [], relation_layouts: {} };
    const previousPositions = segment
      ? Object.fromEntries(Object.entries(segment.nodes || {}).filter(([, meta]) => meta.active && Number.isFinite(meta.x) && Number.isFinite(meta.y)).map(([id, meta]) => [id, { x: meta.x, y: meta.y }]))
      : (payload.positions || {});
    state.positions = computeMissingGraphPositions([...state.nodes.values()], state.edges, previousPositions);
    state.layoutFilterKey = '';
    state.undo = payload.undo || { can_undo: false, label: '' };
    const missing = Object.fromEntries(Object.entries(state.positions).filter(([id]) => !previousPositions[id]));
    if (Object.keys(missing).length) {
      try {
        const saved = await saveGraphPositions(missing, false, '初始化画布布局');
        state.undo = saved.undo || state.undo;
      } catch (error) { setStatus(`画布已打开，但初始位置暂未保存：${error.message}`, true); }
    }
    renderSegmentRail(); renderTypeFilters(); renderGraph(); applyTransform();
    if (!preserveView) requestAnimationFrame(fitGraph);
    if (renderPending && (payload.merge_proposals || []).length) renderMergeSidebar(payload.merge_proposals[0]);
    if (payload.merge_task_id && !state.busy) {
      state.busy = true; graphPoll(payload.merge_task_id).then(() => loadGraph(true)).catch(error => setStatus(`❌ ${error.message}`, true)).finally(() => { state.busy = false; updateModeControls(); });
    }
    if (segment?.pending_count && !state.promptedSegments.has(segment.id) && !(payload.merge_proposals || []).length) {
      state.promptedSegments.add(segment.id); renderSegmentCardLibrary(true);
    }
    return payload;
  }

  async function openGraph() {
    const project = q('#knowledge-project');
    if (!project?.value) { q('#knowledge-search-status').textContent = '请先选择一个创作项目。'; return; }
    state.projectId = project.value; state.query = ''; state.types = new Set(ALL_TYPES); state.selected.clear(); state.expanded = ''; state.mode = 'browse'; state.view = { x: 0, y: 0, scale: 1 };
    state.segmentId = ''; state.segments = []; state.segmentCards = []; state.segmentChapters = []; state.promptedSegments.clear();
    state.transientPositions = null; state.layoutFilterKey = ''; state.viewBeforeFilter = null; state.hovered = ''; state.showAllEdges = false;
    state.shiftBrowse = false; state.suppressClick = false;
    state.focus = null;
    overlay.dataset.mode = 'browse'; overlay.classList.remove('hidden'); document.body.classList.add('knowledge-graph-open');
    q('#knowledge-graph-project').textContent = project.options[project.selectedIndex]?.textContent || '';
    q('#knowledge-graph-search').value = ''; setStatus('正在读取知识卡片和画布布局……');
    try { await loadGraph(false); setStatus('浏览模式：悬停预览，点击卡片展开完整内容；拖动空白区域平移画布。'); }
    catch (error) { setStatus(`❌ ${error.message}`, true); }
  }

  function closeGraph() {
    closeGraphContextMenu();
    overlay.classList.add('hidden'); document.body.classList.remove('knowledge-graph-open'); state.pointer = null; state.ghost = null;
    state.shiftBrowse = false; state.space = false; closeRelationDialog(); closeRelationLayoutManager();
    if (typeof window.reloadWorkspaceKnowledge === 'function') return window.reloadWorkspaceKnowledge();
  }

  q('#open-knowledge-graph').addEventListener('click', openGraph);
  q('#knowledge-segment-overview').addEventListener('click', async () => {
    if (!state.segmentId || state.busy) return;
    state.segmentId = ''; state.selected.clear(); state.expanded = ''; state.focus = null; await loadGraph(false, false);
  });
  q('#knowledge-segment-create').addEventListener('click', renderCreateSegmentSidebar);
  q('#knowledge-segment-add-card').addEventListener('click', () => renderSegmentCardLibrary(false));
  q('#knowledge-segment-remove-selected').addEventListener('click', () => updateSegmentNodes([...state.selected], 'exclude'));
  q('#close-knowledge-graph').addEventListener('click', closeGraph);
  q('#knowledge-graph-fit').addEventListener('click', fitGraph);
  q('#knowledge-graph-overview').addEventListener('click', returnOverview);
  q('#knowledge-graph-save-view').addEventListener('click', saveTemporaryLayout);
  q('#knowledge-graph-arrange-type').addEventListener('click', arrangeGraphByType);
  q('#knowledge-graph-arrange-relations').addEventListener('click', () => arrangeGraphByRelations());
  q('#knowledge-graph-manage-relation-layouts').addEventListener('click', openRelationLayoutManager);
  q('#knowledge-graph-toggle-edges').addEventListener('click', () => {
    state.showAllEdges = !state.showAllEdges; renderEdges(); updateModeControls();
    setStatus(state.showAllEdges ? '已显示当前筛选范围内的全部关联。' : '已隐藏全局连线；悬停或点击卡片时显示它的直接关联。');
  });
  q('#knowledge-graph-zoom-in').addEventListener('click', () => changeZoom(1.2));
  q('#knowledge-graph-zoom-out').addEventListener('click', () => changeZoom(1 / 1.2));
  q('#knowledge-graph-undo').addEventListener('click', undoGraph);
  q('#knowledge-graph-merge-confirm').addEventListener('click', startGraphMerge);
  q('.knowledge-graph-modes').querySelectorAll('[data-graph-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.graphMode)));
  q('#knowledge-graph-search').addEventListener('input', event => { state.query = event.target.value; refreshFilteredGraph(); });
  q('#knowledge-graph-viewport').addEventListener('pointerdown', beginViewportPointer);
  q('#knowledge-graph-viewport').addEventListener('wheel', event => {
    event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect();
    changeZoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, { x: event.clientX - rect.left, y: event.clientY - rect.top });
  }, { passive: false });
  q('#knowledge-graph-viewport').addEventListener('contextmenu', openGraphContextMenu);
  window.addEventListener('pointerdown', event => {
    const menu = q('#knowledge-graph-context-menu');
    if (!menu.classList.contains('hidden') && !menu.contains(event.target)) closeGraphContextMenu();
  });
  window.addEventListener('pointermove', movePointer);
  window.addEventListener('pointerup', finishPointer);
  window.addEventListener('keydown', event => {
    if (overlay.classList.contains('hidden')) return;
    if (event.key === ' ') state.space = true;
    const editingText = event.target?.matches?.('input,textarea,select,[contenteditable="true"]');
    if (event.key === 'Shift' && !editingText && state.mode !== 'browse' && !state.shiftBrowse && !state.pointer) {
      state.shiftBrowse = true; overlay.dataset.mode = 'browse'; updateModeControls(); renderEdges();
      setStatus('临时浏览模式：按住 Shift 拖动画布；松开后恢复原模式和已选卡片。');
    }
    if (event.key === 'Escape') {
      if (!q('#knowledge-graph-context-menu').classList.contains('hidden')) closeGraphContextMenu();
      else if (!q('#knowledge-graph-relation-layout-dialog').classList.contains('hidden')) closeRelationLayoutManager();
      else if (!q('#knowledge-graph-relation-dialog').classList.contains('hidden')) closeRelationDialog();
      else if (state.mode !== 'browse') setMode(state.mode);
      else closeGraph();
    }
  });
  window.addEventListener('keyup', event => {
    if (event.key === ' ') state.space = false;
    if (event.key === 'Shift' && state.shiftBrowse) {
      state.shiftBrowse = false; overlay.dataset.mode = state.mode; updateModeControls(); renderEdges();
      setStatus(graphModeMessage(state.mode));
    }
  });
  window.addEventListener('blur', () => {
    state.space = false;
    if (state.shiftBrowse) {
      state.shiftBrowse = false; overlay.dataset.mode = state.mode; updateModeControls(); renderEdges();
      setStatus(graphModeMessage(state.mode));
    }
  });
  q('#knowledge-graph-relation-save').addEventListener('click', saveRelation);
  q('#knowledge-graph-relation-cancel').addEventListener('click', closeRelationDialog);
  q('#knowledge-graph-relation-delete').addEventListener('click', deleteRelation);
  q('#knowledge-graph-relation-reverse').addEventListener('click', () => {
    if (!state.relation) return;
    [state.relation.source_id, state.relation.target_id] = [state.relation.target_id, state.relation.source_id];
    q('#knowledge-graph-relation-direction').textContent = relationDirectionText(state.relation);
  });
  q('#knowledge-graph-relation-layout-save').addEventListener('click', saveRelationLayoutManager);
  q('#knowledge-graph-relation-layout-cancel').addEventListener('click', closeRelationLayoutManager);
  q('#knowledge-graph-relation-layout-close').addEventListener('click', closeRelationLayoutManager);

  window.__knowledgeGraphTest = { graphSearchMatches, zoomAroundPoint, computeTypeTimeLayout, computeMissingGraphPositions, nextGraphTypeSelection, effectiveGraphMode, focusNeighborhood, focusLayout, rightClickSelection };
})();
