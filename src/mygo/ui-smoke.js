(async () => {
  const checks = {};
  try {
  const waitFor = async predicate => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw Error('UI check timed out after ' + lastAction + '; completed checks: ' + Object.keys(checks).join(','));
  };
  const button = text => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === text);
  let lastAction = 'initialization';
  const click = async el => {
    if (!el) throw Error('UI control missing after ' + lastAction);
    lastAction = el.textContent.trim() || el.getAttribute('aria-label');
    el.click();
    await new Promise(resolve => setTimeout(resolve, 60));
  };
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
    const initialProject = document.querySelector('.side-project[role="button"].active') || document.querySelector('.side-project[role="button"]');
    await click([...document.querySelectorAll('.navtab')].find(el => el.textContent.startsWith('待验证')));
    const otherProject = [...document.querySelectorAll('.side-project[role="button"]')].find(el => el !== initialProject);
    if (otherProject) { await click(otherProject); await click(initialProject); }
    checks.rememberFlowTab = { ok: document.querySelector('.navtab.active')?.textContent.startsWith('待验证') };
    await click([...document.querySelectorAll('.navtab')].find(el => el.textContent.startsWith('需求池')));

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
    await click(settingsTab('提示词模板'));
    await click(button('核心需求'));
    const coreInput = document.querySelector('.settings-page textarea');
    const coreDefault = coreInput.value;
    checks.corePromptTemplate = { ok: coreDefault.includes('{{requirements}}') && coreDefault.includes('{{guidance}}') && coreDefault.includes('{{requirement_ids}}') };
    await edit(coreInput, coreDefault + '\n核心模板保存检查');
    await click(button('保存设置'));
    await waitFor(() => !button('保存设置').disabled);
    const coreSaved = await window.mygo.call('ReqFlow.Invoke', 'workspace:get', []);
    checks.corePromptTemplate.ok &&= coreSaved.state.corePromptTemplate.endsWith('核心模板保存检查');
    await edit(coreInput, '');
    await click(button('保存设置'));
    await waitFor(() => !button('保存设置').disabled && coreInput.value === coreDefault);
    const coreReset = await window.mygo.call('ReqFlow.Invoke', 'workspace:get', []);
    checks.corePromptTemplate.ok &&= !coreReset.state.corePromptTemplate && coreInput.getBoundingClientRect().bottom < innerHeight;
    await click(button('基线需求'));
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
    await click(settingsTab('同步备份'));
    await waitFor(() => document.querySelector('#backup-auto') && !document.querySelector('#backup-auto').disabled);
    const backupURL = document.querySelector('.remote-fields input');
    checks.backupDefaults = { ok: !document.querySelector('#backup-auto').checked && button('从远端导入').disabled };
    await edit(backupURL, 'https://example.invalid/backup.git');
    await click(button('从远端导入'));
    checks.backupImportConfirm = { ok: !!document.querySelector('[aria-labelledby="remote-import-title"]') && !button('确认导入').disabled };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !document.querySelector('[aria-labelledby="remote-import-title"]'));
    const importBackup = window.reqflow.importBackup;
    const saveBackup = window.reqflow.saveBackupSettings;
    let importSettings;
    window.reqflow.saveBackupSettings = async () => { throw Error('导入不能先单独保存配置'); };
    window.reqflow.importBackup = async settings => { importSettings = settings; return { ok: false, error: '远端导入失败测试', status: { running: false } }; };
    try {
      await click(button('从远端导入'));
      await click(button('确认导入'));
      await waitFor(() => !button('确认导入').disabled);
      checks.backupImportFailure = { ok: importSettings?.url === 'https://example.invalid/backup.git' && !!document.querySelector('[aria-labelledby="remote-import-title"]') && document.querySelector('[aria-labelledby="remote-import-title"]').textContent.includes('远端导入失败测试') && backupURL.value === importSettings.url };
      await click(button('取消'));
    } finally { window.reqflow.importBackup = importBackup; window.reqflow.saveBackupSettings = saveBackup; }
    await edit(backupURL, '');
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
    // REQ-167：远程项目并入「我的项目」文件夹，「远程项目」独立分组不再存在
    const remoteHeading = [...document.querySelectorAll('.side-label')].find(el => el.textContent === '远程项目');
    checks.remoteProjectSection = { ok: !remoteHeading && !collaboration };
    await click(newProject);
    await waitFor(() => !!button('导入项目'));
    checks.projectCreateChoices = { ok: !!button('从本地创建') && !!button('导入项目') };
    await click(button('从本地创建'));
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

    const labelStyle = getComputedStyle(document.querySelector('.side-label'));
    const contextStyle = getComputedStyle(contextButton);
    checks.contextEntry = { ok: contextButton.getBoundingClientRect().top >= document.querySelector('.side-project-section').getBoundingClientRect().bottom && contextButton.getBoundingClientRect().top < document.querySelector('.side-foot').getBoundingClientRect().top && contextStyle.fontSize === labelStyle.fontSize && contextStyle.color === labelStyle.color && contextStyle.letterSpacing === labelStyle.letterSpacing };
    await click(contextButton);
    checks.contentMenu = { ok: !!document.querySelector('.content-workspace') && !!document.querySelector('.context-git-bar') && !document.querySelector('.switcher') && !document.querySelector('.project-folder') && footer === document.querySelector('.side-foot') };
    await click(button('新建提示词'));
    const markdownForm = document.querySelector('.content-dialog form');
    const titleField = markdownForm.querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(titleField, 'Markdown 预览回归');
    titleField.dispatchEvent(new Event('input', { bubbles: true }));
    const bodyField = markdownForm.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(bodyField, '# 标题\n\n**强调**\n\n- 列表\n\n```js\nconst x = 1;\n```');
    bodyField.dispatchEvent(new Event('input', { bubbles: true }));
    await click(button('保存提示词'));
    await waitFor(() => !document.querySelector('.content-dialog'));
    const markdownCard = [...document.querySelectorAll('.content-card')].find(el => el.querySelector('h2').textContent === 'Markdown 预览回归');
    checks.contextMarkdownPreview = { ok: !!markdownCard?.querySelector('.md-preview h1') && !!markdownCard.querySelector('.md-preview strong') && !!markdownCard.querySelector('.md-preview li') && !!markdownCard.querySelector('.md-preview pre code') };
    await click(button('返回项目菜单'));
    checks.contentReturn = { ok: !document.querySelector('[aria-label="切换项目"]') && !!document.querySelector('.project-folder') && document.querySelector('.main h1').textContent === originalProject };
    // REQ-169：统计移到侧栏，实验室不再显示；检查日历筛选和键盘导航。
    // REQ-213：打开面板即主动检测 Agent 安装状态与版本，不点击检测按钮。
    const probe = { calls: 0 };
    const detectApi = window.reqflow?.detectLocalAgents;
    if (typeof detectApi === 'function') window.reqflow.detectLocalAgents = (...args) => { probe.calls += 1; return detectApi.apply(window.reqflow, args); };
    await click(button('插件/MOD/AGENT'));
    await waitFor(() => !!document.querySelector('[aria-label="插件/MOD/AGENT"]'));
    const modsNav = () => document.querySelector('[aria-label="插件功能菜单"]');
    const modsMenu = label => [...modsNav().querySelectorAll('button')].find(el => el.textContent.startsWith(label));
    checks.modsWorkspace = { ok: !document.querySelector('.overlay') && !document.querySelector('.mods-page [role="dialog"], .mods-page [role="tablist"]') && modsNav().querySelectorAll('button').length === 5 && document.querySelector('.mods-page').clientWidth === document.querySelector('.main').clientWidth };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    checks.modsWorkspace.ok &&= !!document.querySelector('.mods-page');
    // REQ-235：插件 / MOD 说明占满右侧工作区，不再只占据中间一段阅读宽度。
    const modsPage = document.querySelector('.mods-page');
    const protocolDoc = modsPage.querySelector('.mod-document');
    const contentWidth = modsPage.querySelector('.settings-page-head')?.getBoundingClientRect().width || 0;
    checks.modsProtocolFullWidth = { ok: !!protocolDoc && contentWidth > 0 && Math.abs(protocolDoc.getBoundingClientRect().width - contentWidth) < 2 && protocolDoc.scrollWidth <= protocolDoc.clientWidth + 1, document: protocolDoc?.getBoundingClientRect().width || 0, content: contentWidth };
    await new Promise(resolve => setTimeout(resolve, 250));
    await click(modsMenu('Local Agent'));
    const detectStatus = document.querySelector('[role="status"].agent-detect-status')?.textContent || '';
    const detectAlert = [...document.querySelectorAll('.local-agent-body [role="alert"]')].map(el => el.textContent).join(' · ');
    checks.localAgentAutoDetect = { ok: probe.calls > 0 && detectStatus !== '' && (detectStatus !== '尚未检测' || detectAlert !== ''), calls: probe.calls, status: detectStatus, alert: detectAlert };
    if (typeof detectApi === 'function') window.reqflow.detectLocalAgents = detectApi;
    await click(modsMenu('实验室'));
    checks.statsMoved = { ok: !document.querySelector('.stats-panel') };
    checks.modsWorkspace.ok &&= modsMenu('实验室').getAttribute('aria-current') === 'page';
    await click(button('返回项目菜单'));
    checks.modsWorkspace.ok &&= !document.querySelector('.mods-page') && document.querySelector('.main h1').textContent === originalProject;
    const terminalSetting = async enabled => {
      await click(button('插件/MOD/AGENT'));
      await click(modsMenu('实验室'));
      const toggle = document.querySelector('[aria-label="启用 Terminal"]');
      if (!toggle) throw Error('terminalSetting(' + enabled + ') toggle missing after ' + lastAction + '; completed checks: ' + Object.keys(checks).join(','));
      if (toggle.checked !== enabled) await click(toggle);
      await waitFor(() => toggle.checked === enabled && localStorage.getItem('reqflow-lab-terminal') === String(enabled));
      checks.terminalSetting = { ok: toggle.checked === enabled && localStorage.getItem('reqflow-lab-terminal') === String(enabled) };
      await click(button('返回项目菜单'));
    };
    const terminalVeil = () => document.querySelector('.publish-terminal-body > .terminal-loading');
    const veilVisible = () => { const el = terminalVeil(); return !!el && getComputedStyle(el).visibility === 'visible' && getComputedStyle(el).opacity !== '0'; };
    await terminalSetting(true);
    // REQ-258：PowerShell 与发布终端合并为一个「终端」按钮，默认展开 PowerShell；启动发布前不出现发布页签
    await switchProject('发布终端UI检查');
    await waitFor(() => !!document.querySelector('.publish-terminal-reopen'));
    checks.terminalDefaultCollapsed = { ok: !document.querySelector('.publish-terminal') };
    await click(document.querySelector('.publish-terminal-reopen'));
    await waitFor(() => !!document.querySelector('.publish-terminal .xterm'));
    const publishTabPanel = () => document.querySelector('.terminal-tab-panel[aria-label="发布"]');
    const publishTabButton = () => [...document.querySelectorAll('.terminal-tab')].find(el => el.textContent.startsWith('发布'));
    checks.terminalImmediate = { ok: !!document.querySelector('.terminal-tab-panel[aria-label="PowerShell"] .xterm') && !document.querySelector('.terminal-elapsed') && !document.querySelector('.terminal-indicator.failure') };
    checks.terminalPublishTabOnDemand = { ok: !publishTabPanel() && !publishTabButton() };
    await waitFor(() => button('发布') && !button('发布').disabled);
    await click(button('发布'));
    await waitFor(() => !!publishTabPanel()?.querySelector('.publish-terminal'));
    checks.terminalPublishAutoOpen = { ok: !document.querySelector('.publish-terminal-reopen') };
    const terminalText = () => publishTabPanel()?.querySelector('.xterm')?.textContent || '';
    await waitFor(() => terminalText().includes('stream-first'));
    checks.terminalLive = { ok: publishTabPanel().querySelector('[role="status"]').textContent !== '发布完成' && !terminalText().includes('stream-last') };
    const terminalRunId = publishTabPanel().querySelector('.publish-terminal').dataset.runId;
    const elapsedStart = document.querySelector('.terminal-elapsed').textContent;
    await new Promise(resolve => setTimeout(resolve, 1100));
    checks.terminalRunning = { ok: !!publishTabPanel().querySelector('.terminal-spinner') && publishTabPanel().querySelector('.publish-terminal').getAttribute('aria-busy') === 'true' && document.querySelector('.terminal-elapsed').textContent !== elapsedStart };
    // REQ-258：收起发布终端后回退到仍打开的 PowerShell；重新打开发布页签后收起 PowerShell，让发布面板成为唯一终端
    await click(publishTabPanel().querySelector('[aria-label="收起终端"]'));
    checks.terminalCollapseFallback = { ok: !publishTabPanel() && !!document.querySelector('.terminal-tab-panel[aria-label="PowerShell"] .xterm') && !document.querySelector('.publish-terminal-reopen') };
    await waitFor(() => !!publishTabButton());
    await click(publishTabButton());
    await waitFor(() => !!publishTabPanel()?.querySelector('.publish-terminal'));
    await click(document.querySelector('[aria-label="收起 PowerShell 终端"]'));
    const dockHeight = document.querySelector('.main').getBoundingClientRect().height;
    await click(publishTabPanel().querySelector('[aria-label="在独立窗口打开终端"]'));
    await waitFor(() => !publishTabPanel());
    const detached = await window.reqflow.getPublishTerminal(terminalRunId);
    checks.terminalDetached = { ok: detached.ok && detached.detached && document.querySelector('.main').getBoundingClientRect().height > dockHeight + 100 && document.querySelectorAll('.publish-terminal-reopen').length === 1 };
    await window.reqflow.closePublishTerminal(terminalRunId);
    await waitFor(() => !!publishTabPanel()?.querySelector('.publish-terminal'));
    checks.terminalReattached = { ok: !button('终端') && !!document.querySelector('.terminal-elapsed') };
    await click(publishTabPanel().querySelector('[aria-label="收起终端"]'));
    checks.terminalCollapse = { ok: !publishTabPanel() && document.querySelectorAll('.publish-terminal-reopen').length === 1 };
    await terminalSetting(false);
    await terminalSetting(true);
    await waitFor(() => !!document.querySelector('.publish-terminal-reopen'));
    checks.terminalReenable = { ok: !document.querySelector('.publish-terminal') };
    // REQ-258：重新展开默认回到 PowerShell，再切「发布」页签查看输出
    await click(document.querySelector('.publish-terminal-reopen'));
    await waitFor(() => !!document.querySelector('.terminal-tab-panel[aria-label="PowerShell"] .xterm'));
    await waitFor(() => !!publishTabButton());
    await click(publishTabButton());
    await waitFor(() => !!publishTabPanel()?.querySelector('.publish-terminal'));
    await waitFor(() => terminalText().includes('stream-last') && terminalText().includes('stream-stderr'));
    await waitFor(() => publishTabPanel().querySelector('[role="status"]').textContent === '发布完成');
    checks.terminalComplete = { ok: !document.querySelector('.publish-dialog') && terminalText().includes('stream-first') };
    const elapsedEnd = document.querySelector('.terminal-elapsed').textContent;
    await new Promise(resolve => setTimeout(resolve, 1100));
    checks.terminalTimerStopped = { ok: !publishTabPanel().querySelector('.terminal-spinner') && publishTabPanel().querySelector('.publish-terminal').getAttribute('aria-busy') === 'false' && document.querySelector('.terminal-elapsed').textContent === elapsedEnd };
    const terminalBody = publishTabPanel().querySelector('.publish-terminal-body');
    terminalBody.style.maxWidth = 'calc(100% - 40px)';
    await waitFor(() => veilVisible());
    const contentHidden = () => getComputedStyle(publishTabPanel().querySelector('.publish-terminal-content')).visibility === 'hidden';
    checks.terminalResizeLoading = { ok: contentHidden() };
    // 连续多次尺寸变化（类似窗口最大化时的多帧 WM_SIZE）期间，遮罩必须持续覆盖，不能露出中间帧。
    for (const width of ['calc(100% - 28px)', 'calc(100% - 56px)', 'calc(100% - 84px)']) {
      terminalBody.style.maxWidth = width;
      await new Promise(resolve => setTimeout(resolve, 60));
      checks.terminalResizeLoading.ok &&= veilVisible() && contentHidden();
    }
    await waitFor(() => !veilVisible());
    checks.terminalResizeLoading.ok &&= !contentHidden() && terminalText().includes('stream-first') && terminalText().includes('stream-last');
    terminalBody.style.maxWidth = '';
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await waitFor(() => !veilVisible());
    await switchProject(originalProject);
    // REQ-258：未启动发布的项目没有发布页签，发布输出不跨项目泄漏
    checks.terminalIsolation = { ok: !publishTabPanel() && !publishTabButton() && !terminalText().includes('stream-first') && !terminalText().includes('stream-last') };
    await switchProject('发布终端UI检查');
    await waitFor(() => terminalText().includes('stream-last'));
    checks.terminalIsolation.ok &&= terminalText().includes('stream-first');
    // 收起隐藏中的 PowerShell，让发布面板成为唯一终端，实验室开关与后续 surface 检查只针对发布终端
    const shellCollapse = document.querySelector('[aria-label="收起 PowerShell 终端"]');
    if (shellCollapse) await click(shellCollapse);
    await terminalSetting(false);
    checks.terminalOff = { ok: !document.querySelector('.publish-terminal') && !!document.querySelector('.publish-dialog') };
    await click(document.querySelector('.publish-dialog [aria-label="关闭"]'));
    await switchProject(originalProject);
    window.__reqflowShowTerminal = async () => {
      document.querySelector('.overlay')?.click();
      if (button('返回项目菜单')) await click(button('返回项目菜单'));
      if (button('返回项目')) await click(button('返回项目'));
      await terminalSetting(true);
      await switchProject('发布终端UI检查');
      if (document.querySelector('.publish-terminal-reopen')) await click(document.querySelector('.publish-terminal-reopen'));
      await waitFor(() => terminalText().includes('stream-last'));
      await waitFor(() => !veilVisible());
      if (document.querySelector('.publish-terminal [role="status"]').textContent !== '发布完成') throw Error('Terminal lost completed result');
    };
    window.__reqflowHideTerminal = async () => {
      await terminalSetting(false);
      await switchProject(originalProject);
    };
    const dashboardEntry = button('数据看板');
    checks.statsMoved.ok &&= dashboardEntry.previousElementSibling.textContent.includes('插件/MOD/AGENT') && !!dashboardEntry.querySelector('svg');
    await click(dashboardEntry);
    await waitFor(() => !!document.querySelector('.stats-page .stats-panel'));
    const statsPanel = document.querySelector('.stats-panel');
    const kpis = statsPanel.querySelectorAll('.stats-kpi').length;
    const lines = statsPanel.querySelectorAll('.stats-plot svg path').length;
    const barRows = statsPanel.querySelectorAll('.stats-bar-row').length;
    await click([...statsPanel.querySelectorAll('button')].find(el => el.textContent === '展开明细表'));
    await waitFor(() => !!document.querySelector('.stats-table tbody tr'));
    const tableRows = document.querySelectorAll('.stats-table tbody tr').length;
    const projectTag = [...statsPanel.querySelectorAll('.stats-project-tags .tag-btn')].find(el => el.textContent !== '全部');
    if (projectTag) await click(projectTag);
    const projectBars = [...statsPanel.querySelectorAll('.stats-chart-block')].find(el => el.querySelector('h4')?.textContent === '各项目需求量');
    await click([...projectBars.querySelectorAll('button')].find(el => el.textContent.includes(projectTag.textContent)));
    await waitFor(() => !!document.querySelector('.milestone-view'));
    const milestone = document.querySelector('.milestone-view');
    checks.projectMilestones = { ok: !!milestone && !!milestone.querySelector('.milestone-hero h2') && milestone.querySelectorAll('.milestone-stat').length === 4 && (!milestone.querySelector('.milestone-timeline') || milestone.querySelectorAll('.milestone-item').length > 0) };
    const milestoneBack = [...milestone.querySelectorAll('button')].find(el => el.textContent.trim() === '返回统计');
    if (milestoneBack) await click(milestoneBack);
    await waitFor(() => !!document.querySelector('.stats-panel .activity-calendar'));
    const restoredPanel = document.querySelector('.stats-panel');
    const calendar = restoredPanel.querySelector('.activity-calendar');
    const calendarCells = [...calendar.querySelectorAll('button.activity-day')];
    const calendarProject = (await window.mygo.call('ReqFlow.Invoke', 'workspace:get', [])).state.projects.find(p => p.name === projectTag?.textContent);
    const created = new Map();
    for (const item of calendarProject?.items || []) {
      const time = item.history.find(e => e.event === '创建')?.time || item.flowEvents?.[0]?.time;
      if (!time) continue;
      const date = new Date(time), day = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
      created.set(day, (created.get(day) || 0) + 1);
    }
    const todayCell = calendarCells.at(-1);
    todayCell.focus();
    todayCell.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    const navigated = document.activeElement === calendarCells.at(-8);
    await click(calendarCells[0]);
    checks.activityCalendar = { ok: calendarCells.length === 365 && new Set(calendarCells.map(cell => cell.dataset.date)).size === 365 && navigated && calendarCells[0].getAttribute('aria-pressed') === 'true' && calendarCells.every(cell => cell.getAttribute('aria-label').includes(`新建 ${created.get(cell.dataset.date) || 0} 条需求`)) };
    const rangeButton = [...restoredPanel.querySelectorAll('.segmented button')].find(el => el.textContent === '全部');
    if (rangeButton) await click(rangeButton);
    checks.statsPanel = { ok: kpis === 5 && lines === 3 && barRows > 0 && tableRows > 0 && restoredPanel.querySelectorAll('.stats-chart-head h4').length === 1 };
    await click(button('返回项目'));
    await waitFor(() => !document.querySelector('.stats-panel'));
    // 独立浏览窗口由 smokeUI 在主窗口脚本结束后单独检查。
    await click([...document.querySelectorAll('.navtab')].find(el => el.textContent.startsWith('排期')));
    const toolbar = document.querySelector('.workspace-toolbar');
    const actionsBottom = toolbar.querySelector('.workspace-actions').getBoundingClientRect().bottom;
    const searchBottom = toolbar.querySelector('.search').getBoundingClientRect().bottom;
    checks.scheduleToolbar = { ok: toolbar.getBoundingClientRect().top >= document.querySelector('.list-scroll').getBoundingClientRect().bottom && [...toolbar.querySelectorAll('button')].every(el => el.getBoundingClientRect().bottom < innerHeight) };
    // REQ-139：批次与日期筛选在列表上方；2.13.4 起排期页操作键多于一行宽度，操作组可换行到筛选组下方，但不得高于筛选组或越出窗口
    const scheduleHeader = document.querySelector('.requirements > .list-header');
    const headerRect = scheduleHeader?.getBoundingClientRect();
    checks.listHeader = { ok: !!scheduleHeader && !!scheduleHeader.querySelector('.gen-count') && !!scheduleHeader.querySelector('[aria-label="排期日期范围"]') && headerRect.bottom <= document.querySelector('.list-scroll').getBoundingClientRect().top + 1 && !toolbar.querySelector('.workspace-schedule-filters') && toolbar.querySelector('.workspace-actions').getBoundingClientRect().top >= toolbar.querySelector('.workspace-filters').getBoundingClientRect().top - 1 && toolbar.querySelector('.workspace-actions').getBoundingClientRect().bottom <= innerHeight, header: !!scheduleHeader, genCount: !!scheduleHeader?.querySelector('.gen-count'), dateRange: !!scheduleHeader?.querySelector('[aria-label="排期日期范围"]'), above: scheduleHeader ? headerRect.bottom <= document.querySelector('.list-scroll').getBoundingClientRect().top + 1 : null, scheduleFilters: !!toolbar.querySelector('.workspace-schedule-filters') };
    checks.workspaceHeading = { ok: document.querySelector('.eyebrow').getBoundingClientRect().top <= 16 && document.querySelector('.title-actions > button').getBoundingClientRect().top >= document.querySelector('.top').getBoundingClientRect().bottom };
    // 工具栏底部在各页签保持稳定；排期页操作组可换行，其余页签单行不得低于排期页基线
    checks.sharedToolbar = { ok: true, failures: [] };
    for (const phase of ['需求池', '待验证', '归档', '排期']) {
      await click([...document.querySelectorAll('.navtab')].find(el => el.textContent.startsWith(phase)));
      const current = document.querySelector('.workspace-toolbar');
      const rowAligned = Math.abs(current.getBoundingClientRect().bottom - toolbar.getBoundingClientRect().bottom) < 1 && current.querySelector('.search').getBoundingClientRect().bottom <= current.getBoundingClientRect().bottom && current.getBoundingClientRect().top >= document.querySelector('.list-scroll').getBoundingClientRect().bottom;
      if (!rowAligned) checks.sharedToolbar.failures.push({ phase, toolbarBottom: current.getBoundingClientRect().bottom, baselineBottom: toolbar.getBoundingClientRect().bottom, searchBottom: current.querySelector('.search').getBoundingClientRect().bottom, toolbarTop: current.getBoundingClientRect().top, listBottom: document.querySelector('.list-scroll').getBoundingClientRect().bottom });
      checks.sharedToolbar.ok &&= rowAligned;
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
    checks.executionTab = { ok: executionCards.length === 5 && ['Codex', 'ZCode', 'Pi', 'Claude Code', 'OpenCode'].every(client => executionCards.some(card => card.querySelector('.execution-info strong')?.textContent.includes(client))) && executionCards.every(card => card.querySelector('.execution-info').textContent.includes('已执行')) };
    const projectExecutionCards = executionCards.map(card => card.querySelector('code').textContent);
    await click([...document.querySelectorAll('.side-label-action')].find(el => el.textContent.startsWith('执行中')));
    await waitFor(() => !!document.querySelector('.execution-page'));
    const globalCards = [...document.querySelectorAll('.execution-list .req-card')];
    const executingWorkspace = (await window.mygo.call('ReqFlow.Invoke', 'workspace:get', [])).state;
    const running = executingWorkspace.projects.flatMap(project => project.items.filter(i => !i.archived && i.status !== 'pending_verification' && i.aiExecution?.runId && !i.aiExecution.endedAt).map(item => ({ project, item })));
    checks.globalExecutionList = { ok: globalCards.length === running.length && running.every(({project,item}) => globalCards.some(card => card.querySelector('code').textContent === item.number && card.querySelector('.meta button').textContent === project.name && card.querySelector('.execution-info').textContent.includes('已执行'))) };
    const globalTime = document.querySelector('.execution-info').textContent;
    await new Promise(resolve => setTimeout(resolve, 1100));
    checks.globalExecutionList.ok &&= document.querySelector('.execution-info').textContent !== globalTime;
    await click([...document.querySelectorAll('.execution-list .req-card')].find(card => projectExecutionCards.includes(card.querySelector('code').textContent)).querySelector('.card-actions button'));
    await waitFor(() => !!document.querySelector('.navtab.active')?.textContent.startsWith('执行中'));
    checks.globalExecutionList.ok &&= !document.querySelector('.execution-page') && document.querySelectorAll('.req-card').length === 5;
    const timeBefore = document.querySelector('.execution-info').textContent;
    await new Promise(resolve => setTimeout(resolve, 1200));
    checks.executionClock = { ok: document.querySelector('.execution-info').textContent !== timeBefore };
    for (let n = 0; n < 5; n++) {
      await click(button('释放任务'));
      await click(button('确认释放'));
      await waitFor(() => !document.querySelector('[aria-label="释放 AI 任务"]'));
    }
    checks.executionRelease = { ok: ![...document.querySelectorAll('.navtab')].some(el => el.textContent.startsWith('执行中')) };
    // Release the second project's isolated fixture before the application exits.
    await switchProject('发布终端UI检查');
    await click([...document.querySelectorAll('.navtab')].find(el => el.textContent.startsWith('执行中')));
    await click(button('释放任务'));
    await click(button('确认释放'));
    await waitFor(() => !document.querySelector('[aria-label="释放 AI 任务"]'));
    await switchProject(completionProject.name);

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
    // Delay marks persist, bulk selection skips them, manual selection remains available.
    const delayState = await window.mygo.call('ReqFlow.Invoke', 'workspace:get', []);
    const delayPid = delayState.state.projects.find(project => project.name === originalProject).id;
    for (const title of ['延迟回归-普通', '延迟回归-延迟']) {
      const added = await window.mygo.call('ReqFlow.Invoke', 'workspace:apply', [{ op: 'item', project: delayPid, title, body: '延迟回归测试' }]);
      if (!added.ok) throw Error(JSON.stringify(added));
    }
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => [...document.querySelectorAll('.req-card')].some(el => el.textContent.includes('延迟回归-延迟')));
    const delaySearch = document.querySelector('[aria-label="搜索需求"]');
    const searchDelay = value => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(delaySearch, value);
      delaySearch.dispatchEvent(new Event('input', { bubbles: true }));
    };
    searchDelay('延迟回归-');
    await waitFor(() => document.querySelectorAll('.req-card').length === 2);
    const delayedCard = () => [...document.querySelectorAll('.req-card')].find(el => el.textContent.includes('延迟回归-延迟'));
    const delayButton = text => [...delayedCard().querySelectorAll('button')].find(el => el.textContent === text);
    await click(delayButton('延迟'));
    await waitFor(() => !!delayButton('取消延迟'));
    const persistedDelay = await window.mygo.call('ReqFlow.Invoke', 'workspace:get', []);
    checks.delayPersisted = { ok: persistedDelay.state.projects.find(project => project.id === delayPid).items.find(item => item.title === '延迟回归-延迟').deferred === true };
    const bulkDelay = () => [...document.querySelectorAll('.check-label')].find(el => el.textContent === '全选需求').querySelector('input');
    await click(bulkDelay());
    checks.delayBulkSkip = { ok: !delayedCard().querySelector('input[type="checkbox"]').checked && [...document.querySelectorAll('.req-card input[type="checkbox"]')].filter(el => el.checked).length === 1 && bulkDelay().checked };
    await click(delayedCard().querySelector('input[type="checkbox"]'));
    checks.delayManualSelection = { ok: delayedCard().querySelector('input[type="checkbox"]').checked };
    await click(bulkDelay());
    await click(delayButton('取消延迟'));
    await waitFor(() => !!delayButton('延迟'));
    await click(bulkDelay());
    checks.delayResume = { ok: [...document.querySelectorAll('.req-card input[type="checkbox"]')].every(el => el.checked) };
    await click(bulkDelay());
    searchDelay('');
    await new Promise(resolve => setTimeout(resolve, 60));
    await click(button('记录新需求'));
    const modalBar = document.querySelector('.modal-window-bar');
    // 记录需求弹窗只保留透明拖动层，不再重复渲染窗口按钮。
    checks.modalDragStrip = {
      ok: !!modalBar && !modalBar.querySelector('.window-controls')
        && getComputedStyle(modalBar).getPropertyValue('--app-region').trim() === 'drag'
        && Math.abs(modalBar.getBoundingClientRect().width - innerWidth) < 1
        && modalBar.getBoundingClientRect().bottom <= document.querySelector('.requirement-dialog').getBoundingClientRect().top + 1
    };
    // External Agent completes work while the new-requirement modal holds
    // stale project concurrency metadata. Saving and closing must both recover.
    const invokeAction = async action => {
      const result = await window.mygo.call('ReqFlow.Invoke', 'workspace:apply', [action]);
      if (!result.ok) throw Error(JSON.stringify(result));
      return result.state.projects.find(project => project.name === originalProject);
    };
    const currentState = await window.mygo.call('ReqFlow.Invoke', 'workspace:get', []);
    const concurrentPid = currentState.state.projects.find(project => project.name === originalProject).id;
    let concurrent = await invokeAction({ op: 'item', project: concurrentPid, title: '并发完成测试', body: 'fixture' });
    const concurrentItem = concurrent.items.find(item => item.title === '并发完成测试');
    await invokeAction({ op: 'generate', project: concurrentPid, ids: [concurrentItem.id] });
    await invokeAction({ op: 'complete', project: concurrentPid, id: concurrentItem.id, summary: '模拟 Agent 回写' });
    const expectedPending = (await window.mygo.call('ReqFlow.Invoke', 'workspace:get', [])).state.projects.find(project => project.id === concurrentPid).items.filter(i => !i.archived && i.status === 'pending_verification').length;
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => [...document.querySelectorAll('.navtab')].find(el => el.textContent.startsWith('待验证'))?.textContent.includes(String(expectedPending)));
    checks.liveFlowWhileDraftOpen = { ok: !!document.querySelector('.requirement-dialog') };

    const concurrentInput = document.querySelector('.requirement-dialog textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(concurrentInput, 'Agent 回写后仍可保存新需求');
    concurrentInput.dispatchEvent(new Event('input', { bubbles: true }));
    await click(button('保存需求'));
    await waitFor(() => !document.querySelector('.requirement-dialog'));
    const savedConcurrent = await window.mygo.call('ReqFlow.Invoke', 'workspace:get', []);
    const concurrentProject = savedConcurrent.state.projects.find(project => project.id === concurrentPid);
    checks.concurrentNewRequirement = { ok: concurrentProject.items.some(item => item.body === 'Agent 回写后仍可保存新需求') && concurrentProject.items.find(item => item.id === concurrentItem.id).status === 'pending_verification' };
    await click(button('记录新需求'));
    await invokeAction({ op: 'item', project: concurrentPid, title: '草稿关闭并发变化', body: 'fixture' });
    const closeInput = document.querySelector('.requirement-dialog textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(closeInput, '关闭窗口保留草稿');
    closeInput.dispatchEvent(new Event('input', { bubbles: true }));
    await click(document.querySelector('.requirement-dialog [aria-label="关闭"]'));
    await waitFor(() => !document.querySelector('.requirement-dialog'));
    const closedState = await window.mygo.call('ReqFlow.Invoke', 'workspace:get', []);
    checks.concurrentDraftClose = { ok: closedState.state.projects.find(project => project.id === concurrentPid).requirementDraft.body === '关闭窗口保留草稿' };
    await click(button('记录新需求'));
    await click(button('展开更多设置 · 图片、标题与验收'));
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
    // REQ-181: file completion must escape the scrollable requirement dialog.
    const mentionInput = document.querySelector('.requirement-dialog textarea');
    if (document.querySelector('.guide-settings-summary .linked-dir')) {
      const typeMention = text => {
        mentionInput.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(mentionInput, text);
        mentionInput.setSelectionRange(text.length, text.length);
        mentionInput.dispatchEvent(new Event('input', { bubbles: true }));
      };
      typeMention('@');
      await waitFor(() => !!document.querySelector('.mention-menu'));
      await new Promise(resolve => requestAnimationFrame(resolve));
      const menu = document.querySelector('.mention-menu'), rect = menu.getBoundingClientRect();
      const dialog = document.querySelector('.requirement-dialog');
      const hit = document.elementFromPoint(rect.left + 12, rect.top + 12);
      checks.requirementMentionLayer = { ok: menu.parentElement === document.body && getComputedStyle(menu).position === 'fixed' && menu.contains(hit) && rect.top >= 0 && rect.bottom <= innerHeight && dialog.scrollHeight <= dialog.clientHeight + 1 };
      mentionInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await waitFor(() => !document.querySelector('.mention-menu'));
      checks.requirementMentionEscape = { ok: !!document.querySelector('.requirement-dialog') };
      typeMention('');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    document.querySelector('.requirement-dialog').closest('.overlay').click();
    await waitFor(() => !document.querySelector('.requirement-dialog'));
    await click(document.querySelector('[aria-label="选择记录需求方式"]'));
    await click(button('功能转上下文'));
    const featureInput = document.querySelector('[aria-label="功能转上下文"] input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(featureInput, '需求排期');
    featureInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 60));
    await click(button('生成需求'));
    await waitFor(() => !!document.querySelector('.requirement-dialog'));
    checks.contextRequirement = { ok: document.querySelector('.requirement-dialog textarea').value.includes('context put --project') && document.querySelector('.requirement-dialog textarea').value.includes('需求排期') && document.querySelector('.requirement-dialog textarea').value.includes('联系') && !document.querySelector('.requirement-dialog textarea').value.includes('整理架构') };
    await click(button('清空需求'));
    await waitFor(() => !document.querySelector('.requirement-dialog [aria-label="关闭"]')?.disabled);
    document.querySelector('.requirement-dialog').closest('.overlay').click();
    await waitFor(() => !document.querySelector('.requirement-dialog'));
    // REQ-151：编辑设置浮层按功能分 tab；REQ-150：引导词输入 @ 补全文件与目录
    const linkedDir = document.querySelector('.guide-settings-summary .linked-dir');
    await click(button('编辑设置'));
    await waitFor(() => !!document.querySelector('.project-guide-dialog'));
    const guideDialog = document.querySelector('.project-guide-dialog');
    const guideTabs = [...guideDialog.querySelectorAll('.settings-tabs button')];
    checks.guideTabs = { ok: guideTabs.map(el => el.textContent).join('|') === '引导词|基线模板|验证与发布|远程同步|版本历史' && guideDialog.querySelectorAll('.guidance-field').length === 2 && !!button('保存设置') && guideDialog.querySelectorAll('.guidance-field-head .btn').length === 2 };
    const guideBody = guideDialog.querySelector('.settings-body');
    checks.guideNoScrollbar = { ok: guideBody.scrollHeight <= guideBody.clientHeight + 1, scrollHeight: guideBody.scrollHeight, clientHeight: guideBody.clientHeight };
    checks.guideExpandedFits = { ok: true };
    const rulesLimitInput = guideDialog.querySelector('input[type="number"]');
    checks.rulesLimitField = { ok: !!rulesLimitInput && rulesLimitInput.value === '500' && rulesLimitInput.min === '50' && rulesLimitInput.max === '5000' };
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
      checks.guideExpandedFits.ok &&= guideBody.scrollHeight <= guideBody.clientHeight + 1;
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
    await click(button('展开更多设置 · 图片、标题与验收'));
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
    checks.advancedLayout = { ok: dialog.scrollHeight <= dialog.clientHeight + 1 && buttons.every(el => el.getBoundingClientRect().bottom < innerHeight), images: 12, scrollHeight: dialog.scrollHeight, clientHeight: dialog.clientHeight };
  }
  return { ok: Object.values(checks).every(check => check.ok) && controls === 2 && dragRegion === 'drag' && controlsDragRegion === 'no-drag', title: document.title, sidebarProjects, controls, dragRegion, controlsDragRegion, checks };
  } catch (error) { throw Error('COMPLETED:' + Object.keys(checks).join(',') + ' :: ' + (error && error.stack || error)); }
})()
