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
  await waitFor(() => document.querySelector('.desktop-app'));
  for (const channel of ['app:info', 'workspace:get', 'ai:settings:get', 'storage:status']) {
    const result = await window.mygo.call('ReqFlow.Invoke', channel, []);
    checks[channel] = { ok: !!result && result.ok !== false };
    if (channel === 'app:info') checks[channel] = { ok: result.version === __REQFLOW_VERSION__ && result.backend === 'go', version: result.version, backend: result.backend };
    if (channel === 'workspace:get') checks[channel].count = result.state.projects.length;
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
    await click(button('CONTENT'));
    checks.contentMenu = { ok: !!document.querySelector('.content-workspace') && !document.querySelector('.switcher') && !document.querySelector('.project-folder') && footer === document.querySelector('.side-foot') };
    await click(button('返回项目菜单'));
    checks.contentReturn = { ok: !!document.querySelector('[aria-label="切换项目"]') && !!document.querySelector('.project-folder') && document.querySelector('.switcher strong').textContent === originalProject };

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
