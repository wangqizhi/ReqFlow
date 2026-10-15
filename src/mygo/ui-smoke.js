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
  let lastAction = 'initialization';
  const click = async el => {
    if (!el) throw Error('UI control missing after ' + lastAction);
    lastAction = el.textContent.trim() || el.getAttribute('aria-label');
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
      checks[channel].count = result.state.projects.filter(p => !p.hidden).length;
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
  // REQ-138：顶部窗口栏横贯主区整条且为拖动区
  const topBar = document.querySelector('.desktop-app .top');
  checks.topDragStrip = { ok: getComputedStyle(topBar).getPropertyValue('--app-region').trim() === 'drag' && Math.abs(topBar.getBoundingClientRect().width - document.querySelector('.main').getBoundingClientRect().width) < 1 };

  if (__REQFLOW_INTERACTIONS__) {
    const footer = document.querySelector('.side-foot');
    const originalProject = document.querySelector('.main h1').textContent;
    // REQ-153: exercise the actual persisted project controls on the isolated copy.
    const sidebarFirst = document.querySelector('.side-project[role="button"]');
    const firstName = sidebarFirst.querySelector('.project-name').textContent;
    await click(sidebarFirst.querySelector('.side-project-hide'));
    await waitFor(() => document.querySelectorAll('.side-project[role="button"]').length === expected - 1);
    await click(document.querySelector('[aria-label="管理项目"]'));
    await waitFor(() => !!document.querySelector('.project-manager'));
    const manager = document.querySelector('.project-manager');
    let firstRow = [...manager.querySelectorAll('.project-manager-row')].find(row => row.querySelector('strong').textContent === firstName);
    const firstID = firstRow.dataset.projectId;
    const findRow = () => [...manager.querySelectorAll('.project-manager-row')].find(row => row.dataset.projectId === firstID);
    await click([...firstRow.querySelectorAll('button')].find(el => el.textContent === '取消隐藏'));
    await waitFor(() => document.querySelectorAll('.side-project[role="button"]').length === expected);
    firstRow = findRow();
    const dragProject = async (source, target, after = false) => {
      const transfer = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: after ? rect.bottom - 1 : rect.top + 1 }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: after ? rect.bottom - 1 : rect.top + 1 }));
      await new Promise(resolve => setTimeout(resolve, 100));
    };
    let orderOK = !manager.querySelector('[aria-label^="下移 "], [aria-label^="上移 "]');
    const nextID = firstRow.nextElementSibling?.dataset.projectId;
    if (nextID) {
      const nextRow = manager.querySelector(`[data-project-id="${nextID}"]`);
      await dragProject(firstRow, nextRow, true);
      await waitFor(() => findRow().previousElementSibling?.dataset.projectId === nextID);
      await click(findRow().querySelector('[aria-label^="置顶 "]'));
      await waitFor(() => findRow().nextElementSibling?.dataset.projectId === nextID);
    }
    const groupButtons = [...findRow().querySelectorAll('.project-manager-folders button')];
    const originalGroup = groupButtons.find(el => el.getAttribute('aria-pressed') === 'true').textContent;
    const otherGroup = groupButtons.find(el => el.getAttribute('aria-pressed') === 'false');
    if (otherGroup) {
      await click(otherGroup);
      await waitFor(() => findRow().closest('section').querySelector('h4').textContent === otherGroup.textContent);
      await click([...findRow().querySelectorAll('.project-manager-folders button')].find(el => el.textContent === originalGroup));
      await waitFor(() => findRow().closest('section').querySelector('h4').textContent === originalGroup);
    }
    const persisted = await window.mygo.call('ReqFlow.Invoke', 'workspace:get', []);
    checks.projectManagement = { ok: orderOK && persisted.state.projects.find(project => project.id === firstID).hidden === false && manager.getBoundingClientRect().bottom <= innerHeight, grouping: !!otherGroup };
    await click(document.querySelector('[aria-label="关闭项目管理"]'));
    await waitFor(() => !document.querySelector('.project-manager'));
    if (nextID) {
      const sideRow = id => document.querySelector(`.side-project[data-project-id="${id}"]`);
      await dragProject(sideRow(firstID), sideRow(nextID), true);
      await waitFor(() => sideRow(firstID).previousElementSibling?.dataset.projectId === nextID);
      await dragProject(sideRow(firstID), sideRow(nextID), false);
      await waitFor(() => sideRow(firstID).nextElementSibling?.dataset.projectId === nextID);
      checks.sidebarProjectOrder = { ok: true };
    }

    await click([...document.querySelectorAll('.side-project[role="button"]')].find(el => el.querySelector('.project-name').textContent === originalProject));
    const projects = [...document.querySelectorAll('.side-project[role="button"]')];
    checks.projectSwitcher = { ok: !document.querySelector('[aria-label="切换项目"]') && projects.length === expected };
    const switchProject = async name => {
      await click([...document.querySelectorAll('.side-project[role="button"]')].find(el => el.querySelector('.project-name').textContent === name));
      await waitFor(() => document.querySelector('.main h1')?.textContent === name);
    };
    if (projects.length > 1) {
      await switchProject(projects.find(el => !el.classList.contains('active')).querySelector('.project-name').textContent);
      await switchProject(originalProject);
    }
    await click(document.querySelector('[aria-label="选择记录需求方式"]'));
    document.querySelector('.main h1').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await waitFor(() => !document.querySelector('.new-requirement-menu'));
    await click(document.querySelector('[aria-label="选择记录需求方式"]'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !document.querySelector('.new-requirement-menu'));
    checks.newMenuDismiss = { ok: true };
    // Settings occupy the main workspace; exercise profile persistence on this isolated copy.
    const originalAI = await window.mygo.call('ReqFlow.Invoke', 'ai:settings:get', []);
    await click(button('设置'));
    await waitFor(() => document.querySelector('.settings-page') && !button('新增配置').disabled);
    const settingsNav = document.querySelector('[aria-label="设置功能菜单"]');
    checks.settingsWorkspace = { ok: settingsNav.querySelectorAll('button').length === 6 && !document.querySelector('.overlay') && !footer.textContent.includes('导出全部数据') && document.querySelector('.settings-page').getBoundingClientRect().width > 900 };
    const profileCount = document.querySelectorAll('.ai-profile-list button').length;
    await click(button('新增配置'));
    await click(button('本地 CLI'));
    await waitFor(() => document.querySelectorAll('.cli-provider-card').length === 4);
    await click([...document.querySelectorAll('.cli-provider-card')].find(el => el.querySelector('strong').textContent === 'Pi'));
    await click(button('保存设置'));
    await waitFor(() => !button('保存设置').disabled);
    const savedAI = await window.mygo.call('ReqFlow.Invoke', 'ai:settings:get', []);
    checks.aiProfiles = { ok: savedAI.ok && savedAI.settings.kind === 'cli' && savedAI.settings.cli === 'pi' && savedAI.settings.profiles.length === profileCount + 1 && !!document.querySelector('.settings-page') && !document.querySelector('.input-action input') };
    await click(button('返回项目菜单'));
    await click(button('设置'));
    await waitFor(() => document.querySelector('.cli-provider-card[aria-pressed="true"]'));
    checks.aiProfiles.ok &&= document.querySelector('.cli-provider-card[aria-pressed="true"] strong').textContent === 'Pi';
    await click(document.querySelector('.ai-profile-list button'));
    await click(button('保存设置'));
    await waitFor(() => !button('保存设置').disabled);
    const switchedAI = await window.mygo.call('ReqFlow.Invoke', 'ai:settings:get', []);
    checks.aiProfiles.ok &&= switchedAI.settings.activeProfileId === switchedAI.settings.profiles[0].id;
    const detectCLI = window.reqflow.detectAIProviderCLIs;
    window.reqflow.detectAIProviderCLIs = async () => ({ ok: true, agents: [{ id: 'codex', installed: true, models: [{ id: 'test-model', name: '测试模型', reasoningEfforts: ['none', 'low', 'high'] }] }, { id: 'pi', installed: true }] });
    await click(button('本地 CLI'));
    await waitFor(() => button('重新检测') && !button('重新检测').disabled);
    await click(button('重新检测'));
    await click([...document.querySelectorAll('.cli-provider-card')].find(el => el.querySelector('strong').textContent === 'Codex'));
    await click([...document.querySelectorAll('button')].find(el => el.textContent.startsWith('选择可用模型')));
    await click(button('测试模型'));
    const effortGroup = document.querySelector('[aria-label="CLI 思考等级"]');
    checks.cliModels = { ok: document.querySelector('[aria-label="CLI 模型名称"]').value === 'test-model' && effortGroup.querySelector('[aria-pressed="true"]').textContent === '关闭' };
    await click([...effortGroup.querySelectorAll('button')].find(el => el.textContent === '高'));
    await click(button('保存设置'));
    await waitFor(() => !button('保存设置').disabled);
    const modelSettings = await window.mygo.call('ReqFlow.Invoke', 'ai:settings:get', []);
    checks.cliModels.ok &&= modelSettings.settings.model === 'test-model' && modelSettings.settings.reasoningEffort === 'high';
    await click([...document.querySelectorAll('.cli-provider-card')].find(el => el.querySelector('strong').textContent === 'Pi'));
    checks.cliModels.ok &&= !document.querySelector('[aria-label="CLI 模型名称"]').value && !document.querySelector('[aria-label="CLI 思考等级"]');
    await click(button('保存设置'));
    await waitFor(() => !button('保存设置').disabled);
    window.reqflow.detectAIProviderCLIs = detectCLI;
    // Dirty state spans tabs. Failed saves keep the dialog and all drafts.
    const edit = async (element, value) => {
      const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 50));
    };
    const settingsTab = text => [...document.querySelectorAll('[aria-label="设置功能菜单"] button')].find(el => el.textContent === text);
    await edit(document.querySelector('.settings-page form input'), '未保存配置测试');
    await click(settingsTab('需求模板'));
    const templateText = document.querySelector('.settings-page textarea').value;
    await edit(document.querySelector('.settings-page textarea'), templateText + '\n跨页保存检查');
    await click(button('返回项目菜单'));
    await waitFor(() => button('保存并返回'));
    await click(button('继续编辑'));
    checks.settingsUnsaved = { ok: !document.querySelector('[aria-labelledby="unsaved-settings-title"]') && document.querySelector('.settings-page textarea').value.endsWith('跨页保存检查') };
    await click(button('返回项目菜单'));
    const saveAI = window.reqflow.saveAISettings;
    window.reqflow.saveAISettings = async () => ({ ok: false, error: '保存失败测试' });
    await click(button('保存并返回'));
    await waitFor(() => !button('保存并返回').disabled);
    checks.settingsUnsaved.ok &&= !!document.querySelector('[aria-labelledby="unsaved-settings-title"]') && document.querySelector('.settings-page textarea').value.endsWith('跨页保存检查');
    window.reqflow.saveAISettings = saveAI;
    await click(button('保存并返回'));
    await waitFor(() => !document.querySelector('.settings-page'));
    const persistedAI = await window.mygo.call('ReqFlow.Invoke', 'ai:settings:get', []);
    const persistedTemplates = await window.mygo.call('ReqFlow.Invoke', 'workspace:get', []);
    checks.settingsUnsaved.ok &&= persistedAI.settings.provider === '未保存配置测试' && persistedTemplates.state.baselineTemplate.endsWith('跨页保存检查');
    await click(button('设置'));
    await waitFor(() => document.querySelector('.settings-page textarea') && !document.querySelector('.settings-page textarea').disabled);
    await edit(document.querySelector('.settings-page textarea'), '放弃草稿检查');
    await click(button('返回项目菜单'));
    await click(button('放弃更改'));
    await waitFor(() => !document.querySelector('.settings-page'));
    const afterDiscard = await window.mygo.call('ReqFlow.Invoke', 'workspace:get', []);
    checks.settingsUnsaved.ok &&= afterDiscard.state.baselineTemplate.endsWith('跨页保存检查');
    await click(button('设置'));
    await waitFor(() => document.querySelector('.settings-page'));
    await click([...document.querySelectorAll('[aria-label="设置功能菜单"] button')].find(el => el.textContent === '数据'));
    await waitFor(() => button('导出全部数据'));
    const anchorClick = HTMLAnchorElement.prototype.click;
    const createURL = URL.createObjectURL;
    let exportURL = '';
    let exportedBlob;
    URL.createObjectURL = function(blob) { exportedBlob = blob; return createURL(blob); };
    HTMLAnchorElement.prototype.click = function() { exportURL = this.href; };
    const revokeURL = URL.revokeObjectURL;
    URL.revokeObjectURL = () => {};
    try {
      await click(button('导出全部数据'));
      await waitFor(() => exportURL);
      const exported = JSON.parse(await exportedBlob.text());
      const latest = await window.mygo.call('ReqFlow.Invoke', 'workspace:get', []);
      checks.settingsExport = { ok: exported.projects.length === latest.state.projects.length && !document.querySelector('.settings-page .settings-footer .primary') };
    } finally { HTMLAnchorElement.prototype.click = anchorClick; URL.createObjectURL = createURL; URL.revokeObjectURL = revokeURL; if (exportURL) revokeURL(exportURL); }
    await window.mygo.call('ReqFlow.Invoke', 'ai:settings:save', [originalAI.settings]);
    await click(button('返回项目菜单'));
    const contextButton = button('上下文管理');
    const newProject = button('新建项目');
    const collaboration = [...document.querySelectorAll('.side-label')].find(el => el.textContent === '协作项目');
    const remoteHeading = [...document.querySelectorAll('.side-label')].find(el => el.textContent === '远程项目');
    checks.remoteProjectSection = { ok: remoteHeading.getBoundingClientRect().top > collaboration.getBoundingClientRect().top };
    await click(newProject);
    await waitFor(() => !!document.querySelector('.project-create'));
    await click(button('连接远程服务器'));
    await waitFor(() => !!document.querySelector('.ssh-directory'));
    const sshDialog = document.querySelector('.ssh-directory');
    checks.sshDirectoryPicker = { ok: sshDialog.getBoundingClientRect().bottom <= innerHeight && !sshDialog.querySelector('input[type="password"]') && button('绑定当前目录').disabled && sshDialog.textContent.includes('免密') };
    await click(document.querySelector('[aria-label="关闭远程目录"]'));
    await waitFor(() => !document.querySelector('.ssh-directory'));
    const projectDialog = document.querySelector('.project-create').closest('.dialog');
    await click(projectDialog.querySelector('[aria-label="关闭"]'));
    await waitFor(() => !document.querySelector('.project-create'));

    const labelStyle = getComputedStyle(collaboration);
    const contextStyle = getComputedStyle(contextButton);
    checks.contextEntry = { ok: contextButton.getBoundingClientRect().top > newProject.getBoundingClientRect().top && contextButton.getBoundingClientRect().top < collaboration.getBoundingClientRect().top && contextStyle.fontSize === labelStyle.fontSize && contextStyle.color === labelStyle.color && contextStyle.letterSpacing === labelStyle.letterSpacing };
    await click(contextButton);
    checks.contentMenu = { ok: !!document.querySelector('.content-workspace') && !document.querySelector('.switcher') && !document.querySelector('.project-folder') && footer === document.querySelector('.side-foot') };
    await click(button('返回项目菜单'));
    checks.contentReturn = { ok: !document.querySelector('[aria-label="切换项目"]') && !!document.querySelector('.project-folder') && document.querySelector('.main h1').textContent === originalProject };
    // REQ-148：实验室 · 数据面板 —— KPI、单系列折线、单色条形与明细表、项目切换
    await click(button('插件/MOD/AGENT'));
    await waitFor(() => !!document.querySelector('[aria-label="插件/MOD/AGENT"]'));
    await click([...document.querySelectorAll('.settings-tabs button')].find(el => el.textContent === '实验室'));
    await waitFor(() => !!document.querySelector('.stats-panel'));
    const statsPanel = document.querySelector('.stats-panel');
    const kpis = statsPanel.querySelectorAll('.stats-kpi').length;
    const lines = statsPanel.querySelectorAll('.stats-plot svg path').length;
    const barRows = statsPanel.querySelectorAll('.stats-bar-row').length;
    await click([...statsPanel.querySelectorAll('button')].find(el => el.textContent === '展开明细表'));
    await waitFor(() => !!document.querySelector('.stats-table tbody tr'));
    const tableRows = document.querySelectorAll('.stats-table tbody tr').length;
    const projectTag = [...statsPanel.querySelectorAll('.stats-project-tags .tag-btn')].find(el => el.textContent !== '全部');
    if (projectTag) await click(projectTag);
    const rangeButton = [...statsPanel.querySelectorAll('.segmented button')].find(el => el.textContent === '全部');
    if (rangeButton) await click(rangeButton);
    checks.statsPanel = { ok: kpis === 5 && lines === 3 && barRows > 0 && tableRows > 0 && statsPanel.querySelectorAll('.stats-chart-head h4').length === 1 };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !document.querySelector('.stats-panel'));
    await click([...document.querySelectorAll('.navtab')].find(el => el.textContent.startsWith('排期')));
    const toolbar = document.querySelector('.workspace-toolbar');
    const actionsBottom = toolbar.querySelector('.workspace-actions').getBoundingClientRect().bottom;
    const searchBottom = toolbar.querySelector('.search').getBoundingClientRect().bottom;
    checks.scheduleToolbar = { ok: toolbar.getBoundingClientRect().top >= document.querySelector('.list-scroll').getBoundingClientRect().bottom && [...toolbar.querySelectorAll('button')].every(el => el.getBoundingClientRect().bottom < innerHeight) };
    // REQ-139：批次与日期筛选在列表上方，底部工具栏只有一行（操作与筛选同行、无排期筛选块）
    const scheduleHeader = document.querySelector('.requirements > .list-header');
    checks.listHeader = { ok: !!scheduleHeader && !!scheduleHeader.querySelector('.gen-count') && !!scheduleHeader.querySelector('[aria-label="排期日期范围"]') && scheduleHeader.getBoundingClientRect().bottom <= document.querySelector('.list-scroll').getBoundingClientRect().top + 1 && !toolbar.querySelector('.workspace-schedule-filters') && Math.abs(toolbar.querySelector('.workspace-actions').getBoundingClientRect().top - toolbar.querySelector('.workspace-filters').getBoundingClientRect().top) < 1 };
    checks.workspaceHeading = { ok: document.querySelector('.eyebrow').getBoundingClientRect().top <= 16 && document.querySelector('.title-actions > button').getBoundingClientRect().top >= document.querySelector('.top').getBoundingClientRect().bottom };
    checks.sharedToolbar = { ok: true };
    for (const phase of ['需求池', '待验证', '归档', '排期']) {
      await click([...document.querySelectorAll('.navtab')].find(el => el.textContent.startsWith(phase)));
      const current = document.querySelector('.workspace-toolbar');
      checks.sharedToolbar.ok &&= Math.abs(current.querySelector('.workspace-actions').getBoundingClientRect().bottom - actionsBottom) < 1 && Math.abs(current.querySelector('.search').getBoundingClientRect().bottom - searchBottom) < 1 && current.getBoundingClientRect().top >= document.querySelector('.list-scroll').getBoundingClientRect().bottom;
      // REQ-140：需求池排序固定在列表上方，滚动列表时位置不变
      if (phase === '需求池') {
        const sort = document.querySelector('.requirement-sort');
        const scroll = document.querySelector('.list-scroll');
        const fixed = sort && sort.parentElement.classList.contains('list-header') && sort.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().top + 1;
        const before = sort.getBoundingClientRect().top;
        scroll.scrollTop = 160;
        const stable = Math.abs(sort.getBoundingClientRect().top - before) < 1;
        scroll.scrollTop = 0;
        checks.poolSort = { ok: !!fixed && stable };
      }
    }
    if (completionProject.name !== originalProject) {
      await switchProject(completionProject.name);
      await waitFor(() => document.querySelector('.main h1')?.textContent === completionProject.name);
    }
    await click([...document.querySelectorAll('.navtab')].find(el => el.textContent.startsWith('执行中')));
    const executionCards = [...document.querySelectorAll('.req-card')];
    checks.executionTab = { ok: executionCards.length === 4 && ['Codex', 'ZCode', 'Pi', 'Claude Code'].every(client => executionCards.some(card => card.querySelector('.execution-info strong')?.textContent.includes(client))) && executionCards.every(card => card.querySelector('.execution-info').textContent.includes('已执行')) };
    const timeBefore = document.querySelector('.execution-info').textContent;
    await new Promise(resolve => setTimeout(resolve, 1200));
    checks.executionClock = { ok: document.querySelector('.execution-info').textContent !== timeBefore };
    for (let n = 0; n < 4; n++) {
      await click(button('释放任务'));
      await click(button('确认释放'));
      await waitFor(() => !document.querySelector('[aria-label="释放 AI 任务"]'));
    }
    checks.executionRelease = { ok: ![...document.querySelectorAll('.navtab')].some(el => el.textContent.startsWith('执行中')) };
    await click([...document.querySelectorAll('.navtab')].find(el => el.textContent.startsWith('待验证')));
    const reportCard = [...document.querySelectorAll('.card-body')].find(el => el.querySelector('.item-title')?.textContent === '完成说明UI检查');
    const completionNote = reportCard?.querySelector('.completion-note');
    checks.completionNote = { ok: completionNote?.querySelector('p').textContent === '已补齐完成说明，CLI检查通过' && !!(completionNote.compareDocumentPosition(reportCard.querySelector('.next-step')) & Node.DOCUMENT_POSITION_FOLLOWING), project: originalProject, titles: [...document.querySelectorAll('.item-title')].map(el => el.textContent), text: completionNote?.textContent || '', card: !!reportCard };
    if (completionProject.name !== originalProject) {
      await switchProject(originalProject);
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
    // REQ-151：编辑设置浮层按功能分 tab；REQ-150：引导词输入 @ 补全文件与目录
    const linkedDir = document.querySelector('.guide-settings-summary .linked-dir');
    await click(button('编辑设置'));
    await waitFor(() => !!document.querySelector('.project-guide-dialog'));
    const guideDialog = document.querySelector('.project-guide-dialog');
    const guideTabs = [...guideDialog.querySelectorAll('.settings-tabs button')];
    checks.guideTabs = { ok: guideTabs.map(el => el.textContent).join('|') === '引导词|基线模板|验证与发布|版本历史' && guideDialog.querySelectorAll('.guidance-field').length === 2 && !!button('保存设置') && guideDialog.querySelectorAll('.guidance-field-head .btn').length === 2 };
    // 引导词默认只读文本块，点击进入编辑框；点另一个字段时前一个自动收起
    checks.guideView = { ok: guideDialog.querySelectorAll('.guidance-view').length === 2 && !guideDialog.querySelector('.guidance-input-wrap textarea') };
    checks.guideFullWidth = { ok: true, widths: [] };
    for (const field of guideDialog.querySelectorAll('.guidance-field')) {
      await click(field.querySelector('.guidance-view'));
      await waitFor(() => !!field.querySelector('textarea'));
      const inputWidth = field.querySelector('textarea').getBoundingClientRect().width;
      const available = field.querySelector('.guidance-input-wrap').getBoundingClientRect().width;
      checks.guideFullWidth.widths.push({ inputWidth, available });
      checks.guideFullWidth.ok &&= Math.abs(inputWidth - available) < 1 && inputWidth > 400;
      await click([...field.querySelectorAll('button')].find(el => el.textContent.trim() === '收起'));
    }
    if (linkedDir) {
      await click(guideDialog.querySelector('.guidance-field .guidance-view'));
      await waitFor(() => !!guideDialog.querySelector('.guidance-field .guidance-input-wrap textarea'));
      const guideInput = guideDialog.querySelector('.guidance-field .guidance-input-wrap textarea');
      const originalGuide = guideInput.value;
      const typeGuide = text => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(guideInput, text);
        guideInput.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const settle = () => new Promise(resolve => setTimeout(resolve, 120));
      typeGuide(originalGuide + ' 遵守@');
      await waitFor(() => {
        const menu = document.querySelector('.mention-menu');
        return !!menu && !menu.textContent.includes('正在读取目录');
      });
      const items = [...document.querySelectorAll('.mention-item')];
      if (items.length === 0) {
        checks.guideMention = { ok: true, note: 'mention list unavailable: ' + (document.querySelector('.mention-menu')?.textContent.trim() || '') };
      } else {
        let keyboardOK = true;
        if (items.length > 1) {
          const firstOn = items[0].classList.contains('on');
          guideInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
          await settle();
          keyboardOK = firstOn && !items[0].classList.contains('on') && items[1].classList.contains('on');
        }
        // 目录在列表前排（选中后追加 / 继续浏览），继续 ↓ 直到选中一个文件再回车插入
        for (let n = 0; n <= items.length && items.some(el => el.classList.contains('on')); n++) {
          const on = items.findIndex(el => el.classList.contains('on'));
          if (on >= 0 && !items[on].title.endsWith('/')) break;
          guideInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
          await settle();
        }
        guideInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await settle();
        const insertOK = /@[^\s]+ $/.test(guideInput.value) && !document.querySelector('.mention-menu');
        typeGuide(originalGuide + ' 遵守@');
        await waitFor(() => !!document.querySelector('.mention-menu'));
        await settle();
        guideInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await settle();
        const escOK = !document.querySelector('.mention-menu') && !!document.querySelector('.project-guide-dialog');
        checks.guideMention = { ok: keyboardOK && insertOK && escOK, items: items.length, keyboardOK, insertOK, escOK };
      }
      typeGuide(originalGuide);
      // 「收起」回到文本块展示，再点击文本块重新进入编辑
      await click([...guideDialog.querySelectorAll('.guidance-field-actions .btn')].find(el => el.textContent.trim() === '收起'));
      await waitFor(() => guideDialog.querySelectorAll('.guidance-view').length === 2 && !guideDialog.querySelector('.guidance-input-wrap textarea'));
      const collapsed = guideDialog.querySelectorAll('.guidance-view').length === 2 && !guideDialog.querySelector('.guidance-input-wrap textarea');
      await click(guideDialog.querySelector('.guidance-view'));
      await settle();
      checks.guideCollapse = { ok: collapsed && guideDialog.querySelectorAll('.guidance-input-wrap textarea').length === 1 };
    } else checks.guideMention = { ok: true, note: 'project dir not linked' };
    await click(guideTabs.find(el => el.textContent === '版本历史'));
    await click(guideTabs.find(el => el.textContent === '验证与发布'));
    checks.guideRunTab = { ok: guideDialog.querySelectorAll('[aria-label="验证源类型"] button').length === 3 && guideDialog.querySelectorAll('[aria-label="发布设置"] button').length === 3 };
    await click(guideTabs.find(el => el.textContent === '基线模板'));
    checks.guideTemplateTab = { ok: !!guideDialog.querySelector('.settings-body textarea') };
    guideDialog.closest('.overlay').click();
    await waitFor(() => !document.querySelector('.project-guide-dialog'));
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
