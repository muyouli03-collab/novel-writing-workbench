/* Optional tour: local browser progress only, no model calls or form writes. */
(() => {
  'use strict';
  const key = 'novel-workbench-tour-v1';
  const trigger = document.getElementById('open-onboarding');
  const panel = document.getElementById('onboarding-panel');
  const steps = [
    { page: 'home', target: '.entry-grid', title: '从一个入口开始', text: '只想找写法，就选“只查询范本”；想编辑自己的小说，可创建项目或导入已有正文。这个引导不会上传文件或调用模型。' },
    { page: 'settings', target: '#set-embed-model', title: '先准备向量模型', text: '向量模型负责检索。可以用本机 Ollama 的 bge-m3，也可以填远程 Embedding API。默认地址不代表服务已经安装。在此页面选择接口类型，填写模型、地址及所需密钥，然后点击底部“保存设置”。' },
    { page: 'settings', target: '#set-model', title: '再配置聊天模型', text: '聊天模型负责精选、分析和知识整理，不能代替向量模型。填写自己的服务地址、模型名和密钥，再点击页面底部“保存设置”。远程模型会收到相关输入和片段。' },
    { page: 'references', target: '#page-references', title: '导入一个小范本', text: '先上传仓库 examples 文件夹里的“雨夜来信.txt”，等待建立索引并勾选它。大模型权重、个人小说和范本索引都没有随仓库提供。' },
    { page: 'search', target: '#page-search', title: '完成第一次检索', text: '输入“用反复的小动作表现等待同伴时的焦虑”，先选快速检索。查看原文、来源章节和写法建议；排序分数不是准确率。没有连接模型时，可以先跳过。' },
    { page: 'projects', target: '#new-project-btn', title: '保存自己的小说', text: '新建项目后可以编辑正文并自动保存，这一步不需要模型。知识库则需要主动建立，并核对 AI 内容的原文依据。' },
    { page: 'knowledge', target: '#page-knowledge', title: '按需整理知识', text: '按章节建立人物、剧情和伏笔知识，使用卡片与关系画布整理。先跑通小案例即可，不需要一次使用所有功能。你可以随时从顶部“入门引导”重新查看。' },
  ];
  let index = 0;
  let marked = null;
  let previousFocus = null;
  const title = document.getElementById('onboarding-title');
  const body = document.getElementById('onboarding-text');
  const progress = document.getElementById('onboarding-progress');
  const back = document.getElementById('onboarding-back');
  const next = document.getElementById('onboarding-next');

  function clearHighlight() {
    if (marked) marked.classList.remove('onboarding-highlight');
    marked = null;
  }

  function render() {
    clearHighlight();
    const step = steps[index];
    const tab = document.querySelector('#app-nav button[data-page="' + step.page + '"]');
    if (tab) tab.click();
    title.textContent = step.title;
    body.textContent = step.text;
    progress.textContent = (index + 1) + ' / ' + steps.length;
    back.disabled = index === 0;
    next.textContent = index === steps.length - 1 ? '完成引导' : '下一步';
    marked = document.querySelector(step.target);
    if (marked) {
      marked.classList.add('onboarding-highlight');
      marked.scrollIntoView({ behavior: 'auto', block: 'center' });
    }
  }

  function close(status) {
    try { localStorage.setItem(key, status); } catch (_) { /* Storage can be disabled. */ }
    panel.hidden = true;
    clearHighlight();
    if (previousFocus && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
  }

  function open() {
    previousFocus = document.activeElement;
    index = 0;
    panel.hidden = false;
    render();
    next.focus({ preventScroll: true });
  }

  trigger.addEventListener('click', open);
  back.addEventListener('click', () => { if (index > 0) { index--; render(); } });
  next.addEventListener('click', () => {
    if (index === steps.length - 1) close('completed');
    else { index++; render(); }
  });
  document.getElementById('onboarding-skip').addEventListener('click', () => close('skipped'));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) close('skipped');
  });
  // Browsing elsewhere should not leave a highlight on a hidden page.
  document.querySelectorAll('#app-nav button[data-page]').forEach(tab => {
    tab.addEventListener('click', clearHighlight);
  });
  let visited = false;
  try { visited = !!localStorage.getItem(key); } catch (_) { visited = true; }
  if (!visited) open();
})();
