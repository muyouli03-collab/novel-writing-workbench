/* Shared chapter-range editor for list and canvas tags. */
(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function description(row) {
    const start = row.valid_from_chapter?.title;
    const end = row.invalid_from_chapter?.title;
    if (row.temporal_status === 'unknown') return '章节已删除或顺序改变，时间待修正';
    if (start && end) return `${start}起 · ${end}起失效`;
    if (end) return `${end}起失效`;
    if (start) return `${start}起生效 · 未设失效章节`;
    return '未限定时间';
  }
  function chips(item) {
    const tags = item.details?.tags || [];
    return tags.map(tag => {
      const rows = (item.tag_periods || []).filter(row => row.tag === tag);
      const text = rows.length ? rows.map(description).join('；') : '未限定时间';
      const ended = rows.length && rows.every(row => row.temporal_status === 'ended');
      return `<span class="knowledge-tag-chip${ended ? ' tag-ended' : ''}" title="${esc(text)}">${esc(tag)}<small> · ${esc(text)}</small></span>`;
    }).join('');
  }
  function editor(initial = []) {
    const periods = initial.map(row => ({tag: row.tag, valid_from_chapter_id: row.valid_from_chapter_id || '', invalid_from_chapter_id: row.invalid_from_chapter_id || ''}));
    function values(tags) {
      return [...tags].flatMap(tag => {
        const rows = periods.filter(row => row.tag === tag);
        return rows.length ? rows.map(row => ({...row})) : [{tag, valid_from_chapter_id: '', invalid_from_chapter_id: ''}];
      });
    }
    function render(host, tags, chapters) {
      for (const tag of tags) if (!periods.some(row => row.tag === tag)) periods.push({tag, valid_from_chapter_id: '', invalid_from_chapter_id: ''});
      const options = (selected, end) => `<option value="">${end ? '未设失效章节' : '未限定起始章节'}</option>` +
        (selected && !chapters.some(c => c.id === selected) ? `<option value="${esc(selected)}" selected>原章节已删除，请重新选择</option>` : '') +
        chapters.map(c => `<option value="${esc(c.id)}" ${selected === c.id ? 'selected' : ''}>${esc(c.title)}</option>`).join('');
      host.innerHTML = [...tags].map(tag => `<div class="tag-period-group"><strong>${esc(tag)}</strong>${periods.map((row, i) => row.tag !== tag ? '' :
        `<div class="relation-period-fields tag-period-row" data-period="${i}"><label>从本章起生效<select data-field="valid_from_chapter_id">${options(row.valid_from_chapter_id, false)}</select></label><label>从本章起失效<select data-field="invalid_from_chapter_id">${options(row.invalid_from_chapter_id, true)}</select></label>${periods.filter(r => r.tag === tag).length > 1 ? '<button class="ghost tag-period-remove">移除此时段</button>' : ''}</div>`).join('')}<button class="ghost tag-period-add" data-period-tag="${esc(tag)}">再加一个时段</button></div>`).join('') +
        (tags.size ? '<p class="hint">起始章包含在有效期内，失效章不包含。留空表示该端不限定；再次生效时可增加时段。</p>' : '');
      host.querySelectorAll('[data-period]').forEach(element => {
        const i = Number(element.dataset.period);
        element.querySelectorAll('select').forEach(select => select.onchange = () => { periods[i][select.dataset.field] = select.value; });
        const remove = element.querySelector('.tag-period-remove');
        if (remove) remove.onclick = () => { periods.splice(i, 1); render(host, tags, chapters); };
      });
      host.querySelectorAll('.tag-period-add').forEach(button => button.onclick = () => {
        periods.push({tag: button.dataset.periodTag, valid_from_chapter_id: '', invalid_from_chapter_id: ''}); render(host, tags, chapters);
      });
    }
    return {values, render};
  }
  window.KnowledgeTagPeriods = {description, chips, editor};
})();
