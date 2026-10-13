(async () => {
  const waitFor = async predicate => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw Error('UI check timed out');
  };
  const button = text => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === text);
  const click = async el => {
    if (!el) throw Error('UI control missing');
    el.click();
    await new Promise(resolve => setTimeout(resolve, 60));
  };
  const checks = {};
  let completionProject;
  await waitFor(() => document.querySelector('.desktop-app'));
  for (const channel of ['app:info', 'workspace:get', 'ai:settings:get', 'storage:status']) {
    const result = await window.mygo.call('ReqFlow.Invoke', channel, []);
    checks[channel] = { ok: !!result && result.ok !== false };
    if (channel === 'app:info') checks[channel] = { ok: result.version === __REQFLOW_VERSION__ && result.backend === 'go', version: result.version, backend: result.backend };
    if (channel === 'workspace:get') {
      checks[channel].count = result.state.projects.length;
      completionProject = result.state.projects.find(p => p.items.some(i => i.title === '完成说明UI检查'));
    }
  }
  const expected = checks['workspace:get'].count;
  await waitFor(() => document.querySelectorAll('.side-project[role="button"]').length === expected);
  const sidebarProjects = expected;
  const controls = document.querySelectorAll('.window-controls button').length;
  const dragRegion = getComputedStyle(document.querySelector('.window-bar')).getPropertyValue('--app-region').trim();
  const controlsDragRegion = getComputedStyle(document.querySelector('.window-controls')).getPropertyValue('--app-region').trim();
  const rightGap = innerWidth - document.querySelector('.window-close').getBoundingClientRect().right;
  checks.windowSpacing = { ok: Math.abs(rightGap - 8) < 1, rightGap };

  if (__REQFLOW_INTERACTIONS__) {
    const footer = document.querySelector('.side-foot');
    const originalProject = document.querySelector('.switcher strong').textContent;
    await click(document.querySelector('[aria-label="切换项目"]'));
    const projects = [...document.querySelectorAll('.switcher-row')];
    checks.projectSwitcher = { ok: projects.length === expected && projects.every(el => el.querySelector('strong').textContent !== 'CONTENT') };
    if (projects.length > 1) {
      const target = projects.find(el => !el.classList.contains('current'));
      const name = target.querySelector('strong').textContent;
      await click(target);
      await waitFor(() => document.querySelector('.main h1')?.textContent === name);
      checks.projectSwitcher.ok &&= document.querySelector('.switcher strong').textContent === name;
      await click(document.querySelector('[aria-label="切换项目"]'));
      await click([...document.querySelectorAll('.switcher-row')].find(el => el.querySelector('strong').textContent === originalProject));
    } else await click(document.querySelector('[aria-label="切换项目"]'));
    const contextButton = button('上下文管理');
    const newProject = button('新建项目');
    const collaboration = [...document.querySelectorAll('.side-label')].find(el => el.textContent === '协作项目');
    const labelStyle = getComputedStyle(collaboration);
    const contextStyle = getComputedStyle(contextButton);
    checks.contextEntry = { ok: contextButton.getBoundingClientRect().top > newProject.getBoundingClientRect().top && contextButton.getBoundingClientRect().top < collaboration.getBoundingClientRect().top && contextStyle.fontSize === labelStyle.fontSize && contextStyle.color === labelStyle.color && contextStyle.letterSpacing === labelStyle.letterSpacing };
    await click(contextButton);
    checks.contentMenu = { ok: !!document.querySelector('.content-workspace') && !document.querySelector('.switcher') && !document.querySelector('.project-folder') && footer === document.querySelector('.side-foot') };
    await click(button('返回项目菜单'));
    checks.contentReturn = { ok: !!document.querySelector('[aria-label="切换项目"]') && !!document.querySelector('.project-folder') && document.querySelector('.switcher strong').textContent === originalProject };
    await click([...document.querySelectorAll('.navtab')].find(el => el.textContent.startsWith('排期')));
    const bottom = document.querySelector('.schedule-bottom');
    checks.scheduleBottom = { ok: Math.abs(bottom.getBoundingClientRect().bottom - innerHeight) < 1 && !document.querySelector('.page-foot') && [...bottom.querySelectorAll('button')].every(el => el.getBoundingClientRect().bottom <= innerHeight), bottom: bottom.getBoundingClientRect().bottom, height: innerHeight };
    if (completionProject.name !== originalProject) {
      await click(document.querySelector('[aria-label="切换项目"]'));
      await click([...document.querySelectorAll('.switcher-row')].find(el => el.querySelector('strong').textContent === completionProject.name));
      await waitFor(() => document.querySelector('.main h1')?.textContent === completionProject.name);
    }
    await click([...document.querySelectorAll('.navtab')].find(el => el.textContent.startsWith('待验证')));
    const reportCard = [...document.querySelectorAll('.card-body')].find(el => el.querySelector('.item-title')?.textContent === '完成说明UI检查');
    const completionNote = reportCard?.querySelector('.completion-note');
    checks.completionNote = { ok: completionNote?.querySelector('p').textContent === '已补齐完成说明，CLI检查通过' && !!(completionNote.compareDocumentPosition(reportCard.querySelector('.next-step')) & Node.DOCUMENT_POSITION_FOLLOWING), project: originalProject, titles: [...document.querySelectorAll('.item-title')].map(el => el.textContent), text: completionNote?.textContent || '', card: !!reportCard };
    if (completionProject.name !== originalProject) {
      await click(document.querySelector('[aria-label="切换项目"]'));
      await click([...document.querySelectorAll('.switcher-row')].find(el => el.querySelector('strong').textContent === originalProject));
      await waitFor(() => document.querySelector('.main h1')?.textContent === originalProject);
    }
    await click([...document.querySelectorAll('.navtab')].find(el => el.textContent.startsWith('归档')));
    const archiveNav = document.querySelector('.archive-folders');
    if (archiveNav) {
      // REQ-131：进入归档页即展开最新年/月，年份可折叠，点击日文件夹筛选、全部日期还原
      const yearButton = [...archiveNav.querySelectorAll('.archive-row')].find(el => /^\d{4} 年$/.test(el.querySelector('strong')?.textContent || ''));
      const monthsOnEntry = archiveNav.querySelectorAll('.archive-month').length;
      const openOnEntry = yearButton?.getAttribute('aria-expanded') === 'true';
      let collapsed = false;
      if (yearButton) {
        if (yearButton.getAttribute('aria-expanded') !== 'true') await click(yearButton);
        await click(yearButton);
        collapsed = archiveNav.querySelectorAll('.archive-month').length === 0;
        await click(yearButton);
      }
      const dayButton = archiveNav.querySelector('.archive-day');
      const total = document.querySelector('.list-foot span').textContent;
      if (dayButton) await click(dayButton);
      const dayCount = dayButton ? parseInt(dayButton.querySelector('span').textContent, 10) : 0;
      const dayFilter = dayButton
        ? dayButton.classList.contains('chosen') && document.querySelector('.list-foot span').textContent.startsWith(`${dayCount} 条需求`) && document.querySelector('.list-foot span').textContent !== total
        : true;
      checks.archiveFolders = { ok: !!openOnEntry && monthsOnEntry > 0 && collapsed && dayFilter, openOnEntry, monthsOnEntry, collapsed, dayFilter };
    } else checks.archiveFolders = { ok: true, note: 'no archived dates' };
    await click(document.querySelector('.navtab'));

    const deletion = document.querySelector('.side-project-del');
    if (deletion) {
      await click(deletion);
      checks.deleteMessage = { ok: document.querySelector('.dialog').textContent.includes('不会删除项目的源文件或目录') };
      await click(button('取消'));
    }
    await click(button('记录新需求'));
    await click(button('展开更多设置 · 图片、标题、验收与交付'));
    const textarea = document.querySelector('.requirement-dialog textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, '长中文说明、附件与高级字段清空检查。'.repeat(35));
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await click(document.querySelector('[aria-label="需求类型"] button:nth-child(3)'));
    await click(document.querySelector('[aria-label="优先级"] button'));
    await click(button('清空需求'));
    await waitFor(() => !document.querySelector('.requirement-advanced'));
    const reset = () => document.querySelector('.requirement-dialog textarea')?.value === '' && document.querySelector('[aria-label="需求类型"] [aria-pressed="true"]')?.textContent === '新需求' && document.querySelector('[aria-label="优先级"] [aria-pressed="true"]')?.textContent === 'P1 重要';
    checks.clearRequirement = { ok: reset() };
    const after = await window.mygo.call('ReqFlow.Invoke', 'workspace:get', []);
    const draft = after.state.projects.find(project => project.name === originalProject).requirementDraft;
    checks.clearDraft = { ok: draft.body === '' && !draft.attachments?.length && draft.title === '' && draft.criteria === '' && draft.executor === 'ai' && draft.aiValidation === false };
    document.querySelector('.requirement-dialog').closest('.overlay').click();
    await waitFor(() => !document.querySelector('.requirement-dialog'));
    await click(button('记录新需求'));
    checks.reopenDraft = { ok: reset() && !document.querySelector('.requirement-advanced') };
    const buttons = [...document.querySelectorAll('.editor-footer button')];
    checks.editorLayout = { ok: buttons.map(el => el.textContent).join('|') === '清空需求|保存需求' && Math.abs(buttons[0].getBoundingClientRect().top - buttons[1].getBoundingClientRect().top) < 1 && buttons.every(el => el.getBoundingClientRect().bottom < innerHeight) };
    await click(button('展开更多设置 · 图片、标题、验收与交付'));
    const body = document.querySelector('.requirement-dialog textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(body, '长中文说明与十二张参考图片的布局检查。'.repeat(60));
    body.dispatchEvent(new Event('input', { bubbles: true }));
    const files = new DataTransfer();
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMr8AAAAASUVORK5CYII='), char => char.charCodeAt(0));
    for (let index = 0; index < 12; index++) files.items.add(new File([png], `参考图片${index + 1}.png`, { type: 'image/png' }));
    const upload = document.querySelector('.requirement-dialog input[type="file"]');
    upload.files = files.files;
    upload.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => document.querySelectorAll('.requirement-dialog .attachment-grid figure').length === 12);
    const dialog = document.querySelector('.requirement-dialog');
    checks.advancedLayout = { ok: dialog.scrollHeight <= dialog.clientHeight + 1 && buttons.every(el => el.getBoundingClientRect().bottom < innerHeight), images: 12 };
  }
  return { ok: Object.values(checks).every(check => check.ok) && controls === 2 && dragRegion === 'drag' && controlsDragRegion === 'no-drag', title: document.title, sidebarProjects, controls, dragRegion, controlsDragRegion, checks };
})()
