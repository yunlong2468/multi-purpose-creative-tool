console.log("=== write.js v20260523_undo 已加载 ===");

// ===== 开发者日志系统（前台console拦截） =====
var _devLogLines = [], _devLogSse = null, _devLogAutoScroll = true;
var _origConsole = { log: console.log, warn: console.warn, error: console.error };
function _devLogAdd(level, source, msg) {
  var entry = { ts: new Date().toISOString(), source: source, level: level, msg: String(msg) };
  _devLogLines.push(entry);
  if (_devLogLines.length > 2000) _devLogLines.shift();
  DL._renderLine(entry);
}
console.log = function(){ var m=Array.prototype.join.call(arguments,' '); _origConsole.log.apply(console,arguments); _devLogAdd('info','client',m); };
console.warn = function(){ var m=Array.prototype.join.call(arguments,' '); _origConsole.warn.apply(console,arguments); _devLogAdd('warn','client',m); };
console.error = function(){ var m=Array.prototype.join.call(arguments,' '); _origConsole.error.apply(console,arguments); _devLogAdd('error','client',m); };

// ===== Pane System =====
var paneGroups = [];
var paneCounter = 0;
var paneContainer = null;

function _pid() { return 'p'+(++paneCounter); }
function _tid() { return 't'+(++paneCounter); }

var FIXED_TABS = ['outline','chat','skillConfig','apiConfig'];
var PANEL_META = {
  outline:    { icon:'📖', label:'大纲' },
  chat:       { icon:'💬', label:'对话' },
  skillConfig:{ icon:'🧠', label:'Skill配置' },
  apiConfig:  { icon:'👾', label:'API配置' },
};

// 查找某个 fixed tab 所在的 pane
function findFixedTab(type) {
  for (var i=0; i<paneGroups.length; i++) {
    var t = paneGroups[i].tabs.find(function(t){ return t.type===type; });
    if (t) return { pane:paneGroups[i], tab:t, idx:i };
  }
  return null;
}

// ===== PANE module =====
var PANE = {
  init: function() {
    paneContainer = document.getElementById('paneContainer');
    // 初始：一个窗格，打开大纲+对话（保证subPanelChat始终存在）
    var p = this.create(false);
    this.addTab(p.id, { type:'outline' });
    this.addTab(p.id, { type:'chat' });
    this.saveLayout();
  },

  create: function(saveAfter) {
    var p = { id:_pid(), tabs:[], activeTabId:null, el:null };
    paneGroups.push(p);
    this._renderPane(p);
    if (saveAfter!==false) this.saveLayout();
    return p;
  },

  destroy: function(paneId) {
    var idx = -1;
    for (var i=0; i<paneGroups.length; i++) { if (paneGroups[i].id===paneId) { idx=i; break; } }
    if (idx<0) return;
    var p = paneGroups[idx];
    // 迁移固定标签到其他 pane
    if (paneGroups.length>1) {
      var target = paneGroups[idx===0?1:0];
      var fixed = p.tabs.filter(function(t){ return FIXED_TABS.indexOf(t.type)>=0; });
      fixed.forEach(function(t) {
        if (!target.tabs.find(function(tt){ return tt.type===t.type; })) {
          target.tabs.push(t);
        }
      });
      PANE._renderPane(target);
    }
    // 移除 splitter
    var el = p.el;
    if (idx>0) { var prev=el.previousElementSibling; if (prev&&prev.classList.contains('pane-splitter')) prev.remove(); }
    else { var nxt=el.nextElementSibling; if (nxt&&nxt.classList.contains('pane-splitter')) nxt.remove(); }
    el.remove();
    paneGroups.splice(idx,1);
    if (paneGroups.length===0) {
      var np = this.create(false);
      this.addTab(np.id, { type:'outline' });
    }
    this.saveLayout();
    ACT._updateBadges();
  },

  addTab: function(paneId, tabDef) {
    var p = this._getPane(paneId); if (!p) return null;
    // 固定标签：如果已在其他 pane，先移过来
    if (tabDef.type && FIXED_TABS.indexOf(tabDef.type)>=0) {
      var existing = findFixedTab(tabDef.type);
      if (existing && existing.pane.id!==paneId) {
        return this.moveTab(existing.pane.id, paneId, existing.tab.id);
      }
      if (existing && existing.pane.id===paneId) {
        this.activateTab(paneId, existing.tab.id);
        return existing.tab;
      }
    }
    var tab = { id:tabDef.id||_tid(), type:tabDef.type||'editor', label:tabDef.label||'', icon:tabDef.icon||'', chapterId:tabDef.chapterId||null };
    p.tabs.push(tab);
    this.activateTab(paneId, tab.id);
    // activateTab already calls _renderPane + _renderContent + saveLayout
    ACT._updateBadges();
    return tab;
  },

  activateTab: function(paneId, tabId) {
    var p = this._getPane(paneId); if (!p) return;
    var tab = p.tabs.find(function(t){ return t.id===tabId; });
    if (!tab) { console.warn('[Pane] Tab not found:', tabId); return; }
    p.activeTabId = tabId;
    this._renderPane(p);
    this._renderContent(p, tab);
    this.saveLayout();
  },

  closeTab: function(paneId, tabId) {
    var p = this._getPane(paneId); if (!p) return;
    var idx = -1;
    for (var i=0; i<p.tabs.length; i++) { if (p.tabs[i].id===tabId) { idx=i; break; } }
    if (idx<0) return;
    var wasActive = p.activeTabId===tabId;
    p.tabs.splice(idx,1);
    if (p.tabs.length===0) {
      this.destroy(paneId);
      return;
    }
    if (wasActive) {
      var next = p.tabs[Math.min(idx, p.tabs.length-1)];
      p.activeTabId = next.id;
      this._renderContent(p, next);
    }
    this._renderPane(p);
    this.saveLayout();
    ACT._updateBadges();
  }, function(fromPaneId, toPaneId, tabId) {
    var fp = this._getPane(fromPaneId); if (!fp) return;
    var tp = this._getPane(toPaneId); if (!tp) return;
    var idx = -1;
    for (var i=0; i<fp.tabs.length; i++) { if (fp.tabs[i].id===tabId) { idx=i; break; } }
    if (idx<0) return;
    var tab = fp.tabs[idx];
    fp.tabs.splice(idx,1);
    tp.tabs.push(tab);
    if (fp.activeTabId===tabId) {
      fp.activeTabId = fp.tabs.length>0 ? fp.tabs[Math.min(idx,fp.tabs.length-1)].id : null;
      if (fp.activeTabId) this._renderContent(fp, fp.tabs.find(function(t){return t.id===fp.activeTabId;}));
    }
    if (fp.tabs.length===0) { this.destroy(fromPaneId); }
    else this._renderPane(fp);
    this.activateTab(toPaneId, tab.id);
    this.saveLayout();
  },

  split: function(paneId, tabId, direction) {
    direction = direction || 'right';
    var p = this._getPane(paneId); if (!p) return;
    var idx = -1;
    for (var i=0; i<p.tabs.length; i++) { if (p.tabs[i].id===tabId) { idx=i; break; } }
    if (idx<0) return;
    var tab = p.tabs[idx];
    p.tabs.splice(idx,1);
    if (p.activeTabId===tabId) {
      p.activeTabId = p.tabs.length>0 ? p.tabs[Math.min(idx,p.tabs.length-1)].id : null;
    }
    if (p.tabs.length===0) { this.destroy(paneId); }
    else this._renderPane(p);
    // 创建新 pane
    var np = this.create(false);
    np.tabs.push(tab);
    np.activeTabId = tab.id;
    // 默认 50/50 分屏
    var pi = -1;
    for (var j=0; j<paneGroups.length; j++) { if (paneGroups[j].id===np.id) { pi=j; break; } }
    var existingPane = p.el;
    if (existingPane && existingPane.parentNode) {
      var npEl = document.querySelector('.pane[data-pane-id="'+np.id+'"]');
      if (npEl) npEl.style.flex = '1 1 0';
      if (existingPane) existingPane.style.flex = '1 1 0';
    }
    this._renderPane(np);
    this.saveLayout();
  },

  reorderTab: function(paneId, fromIdx, toIdx) {
    var p = this._getPane(paneId); if (!p) return;
    if (fromIdx<0||fromIdx>=p.tabs.length||toIdx<0||toIdx>=p.tabs.length) return;
    var tab = p.tabs.splice(fromIdx,1)[0];
    p.tabs.splice(toIdx,0,tab);
    this._renderPane(p);
    this.saveLayout();
  },

  // ===== Internal =====
  _getPane: function(paneId) {
    return paneGroups.find(function(p){ return p.id===paneId; });
  },

  _renderPane: function(p) {
    if (!p.el) p.el = this._createPaneDOM(p);
    var tabsEl = p.el.querySelector('.pane-tabs');
    var html = '';
    p.tabs.forEach(function(t) {
      var active = p.activeTabId===t.id ? ' active' : '';
      var icon = t.icon || (PANEL_META[t.type]&&PANEL_META[t.type].icon) || '✍️';
      var label = t.label || (PANEL_META[t.type]&&PANEL_META[t.type].label) || t.type;
      var drag = 'draggable="true"';
      html += '<div class="pane-tab'+active+'" data-tab-id="'+t.id+'" data-pane-id="'+p.id+'" '+drag+' onclick="PANE.activateTab(\''+p.id+'\',\''+t.id+'\')" oncontextmenu="event.preventDefault();CTX.showTabMenu(event,\''+p.id+'\',\''+t.id+'\')">';
      html += '<span>'+icon+' '+escHtml(label)+'</span>';
      html += '<span class="tab-close" onclick="event.stopPropagation();PANE.closeTab(\''+p.id+'\',\''+t.id+'\')">✕</span>';
      html += '</div>';
    });
    tabsEl.innerHTML = html;
    this._bindTabEvents(p);
  },

  _createPaneDOM: function(p) {
    var el = document.createElement('div');
    el.className = 'pane';
    el.setAttribute('data-pane-id', p.id);
    el.innerHTML = '<div class="pane-tabs"></div><div class="pane-content"></div>';
    // 插入到 container
    var container = document.getElementById('paneContainer');
    if (paneGroups.length>1) {
      // 在最后一个 pane 后面添加 splitter + 新 pane
      var lastPane = paneGroups[paneGroups.length-2]; // 当前 pane 是最后一个
      if (lastPane && lastPane.el) {
        var splitter = document.createElement('div');
        splitter.className = 'pane-splitter';
        splitter.setAttribute('data-after', lastPane.id);
        splitter.addEventListener('mousedown', PANE._onSplitterDown);
        lastPane.el.after(splitter);
        splitter.after(el);
      } else {
        container.appendChild(el);
      }
    } else {
      container.appendChild(el);
    }
    return el;
  },

  _renderContent: function(p, tab) {
    var content = p.el.querySelector('.pane-content');
    var panelId = 'panel_'+p.id+'_'+tab.type;
    var panel = content.querySelector('#'+panelId);
    var isNew = !panel;
    if (isNew) {
      panel = document.createElement('div');
      panel.id = panelId;
      panel.className = 'panel';
      content.appendChild(panel);
    }
    // 切换激活状态
    content.querySelectorAll('.panel').forEach(function(pl){ pl.classList.remove('active'); });
    panel.classList.add('active');
    // 只在首次渲染内容
    if (isNew || tab.type==='editor') {
      // 编辑器每次都刷新（章节内容可能已更新）
      // 其他面板只渲染一次
      if (tab.type==='editor' || !panel.getAttribute('data-rendered')) {
        panel.setAttribute('data-rendered','1');
        switch(tab.type) {
          case 'outline':    RENDER.outline(panel); break;
          case 'chat':       RENDER.chat(panel); break;
          case 'editor':     RENDER.editor(panel, tab); break;
          case 'skillConfig': RENDER.skillConfig(panel); break;
          case 'apiConfig':   RENDER.apiConfig(panel); break;
          default: panel.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text2);">未知面板类型: '+tab.type+'</div>';
        }
      }
    }
  },

  _bindTabEvents: function(p) {
    var tabsEl = p.el.querySelector('.pane-tabs');
    var tabs = tabsEl.querySelectorAll('.pane-tab');
    tabs.forEach(function(tabEl) {
      tabEl.addEventListener('dragstart', TABDRAG.onStart);
      tabEl.addEventListener('dragend', TABDRAG.onEnd);
    });
    // 移除旧监听器防止累积
    if (tabsEl._dragOverFn) tabsEl.removeEventListener('dragover', tabsEl._dragOverFn);
    if (tabsEl._dragLeaveFn) tabsEl.removeEventListener('dragleave', tabsEl._dragLeaveFn);
    if (tabsEl._dropFn) tabsEl.removeEventListener('drop', tabsEl._dropFn);
    // 绑定新监听器
    tabsEl._dragOverFn = function(e) { e.preventDefault(); TABDRAG.onTabBarOver(e, p); };
    tabsEl._dragLeaveFn = TABDRAG.onTabBarLeave;
    tabsEl._dropFn = function(e) { e.preventDefault(); TABDRAG.onTabBarDrop(e, p); };
    tabsEl.addEventListener('dragover', tabsEl._dragOverFn);
    tabsEl.addEventListener('dragleave', tabsEl._dragLeaveFn);
    tabsEl.addEventListener('drop', tabsEl._dropFn);
  },

  _onSplitterDown: function(e) {
    e.preventDefault();
    var splitter = e.target;
    var leftPane = splitter.previousElementSibling;
    var rightPane = splitter.nextElementSibling;
    if (!leftPane||!rightPane||!leftPane.classList.contains('pane')||!rightPane.classList.contains('pane')) return;
    splitter.classList.add('active');
    var startX = e.clientX;
    var leftStartW = leftPane.getBoundingClientRect().width;
    var rightStartW = rightPane.getBoundingClientRect().width;
    var totalW = leftStartW + rightStartW;

    function onMove(ev) {
      var dx = ev.clientX - startX;
      var newLeftW = Math.max(280, leftStartW + dx);
      var newRightW = totalW - newLeftW;
      if (newRightW < 280) { newRightW = 280; newLeftW = totalW - 280; }
      leftPane.style.flex = '0 0 ' + newLeftW + 'px';
      rightPane.style.flex = '0 0 ' + newRightW + 'px';
    }
    function onUp() {
      splitter.classList.remove('active');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      PANE.saveLayout();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  },

  saveLayout: function() {
    try {
      var data = paneGroups.map(function(p) {
        return {
          id:p.id,
          tabs:p.tabs.map(function(t){ return { id:t.id, type:t.type, label:t.label, icon:t.icon, chapterId:t.chapterId }; }),
          activeTabId:p.activeTabId,
          flex: p.el ? p.el.style.flex || '' : ''
        };
      });
      localStorage.setItem('write_pane_layout_'+projectId, JSON.stringify(data));
    } catch(e) { console.error('[Pane] saveLayout error:', e); }
  },

  loadLayout: function() {
    try {
      paneContainer = document.getElementById('paneContainer');
      if (!paneContainer) { console.error('[Pane] loadLayout: paneContainer not found'); return false; }
      var raw = localStorage.getItem('write_pane_layout_'+projectId);
      if (!raw) return false;
      var data = JSON.parse(raw);
      if (!data||!data.length) return false;
      // 重建所有 pane
      paneContainer.innerHTML = '';
      paneGroups = [];
      data.forEach(function(pd, i) {
        var p = { id:pd.id||_pid(), tabs:pd.tabs||[], activeTabId:pd.activeTabId, el:null };
        paneGroups.push(p);
        var el = document.createElement('div');
        el.className = 'pane';
        el.setAttribute('data-pane-id', p.id);
        if (pd.flex) el.style.flex = pd.flex;
        el.innerHTML = '<div class="pane-tabs"></div><div class="pane-content"></div>';
        paneContainer.appendChild(el);
        if (i < data.length-1) {
          var splitter = document.createElement('div');
          splitter.className = 'pane-splitter';
          splitter.addEventListener('mousedown', PANE._onSplitterDown);
          paneContainer.appendChild(splitter);
        }
        p.el = el;
        PANE._renderPane(p);
        if (p.activeTabId && p.tabs.length) {
          var tab = p.tabs.find(function(t){ return t.id===p.activeTabId; });
          if (tab) PANE._renderContent(p, tab);
        }
      });
      return true;
    } catch(e) { console.error('[Pane] loadLayout error:', e); return false; }
  }
};

// ===== ACT (Activity Bar) module =====
var ACT = {
  focus: function(panelType) {
    var existing = findFixedTab(panelType);
    if (existing) {
      // 已打开 → 跳转到对应 pane 并激活
      PANE.activateTab(existing.pane.id, existing.tab.id);
    } else {
      // 未打开 → 在当前活跃窗格打开
      var targetPane = paneGroups[0];
      // 优先在没有该类型固定标签的最后一个窗格打开
      for (var i=paneGroups.length-1; i>=0; i--) {
        if (!paneGroups[i].tabs.find(function(t){ return t.type===panelType; })) {
          targetPane = paneGroups[i]; break;
        }
      }
      PANE.addTab(targetPane.id, PANEL_META[panelType] ? { type:panelType, icon:PANEL_META[panelType].icon, label:PANEL_META[panelType].label } : { type:panelType });
    }
    this._updateBadges();
  },
  _updateBadges: function() {
    var items = document.querySelectorAll('#activityBar .act-item');
    items.forEach(function(item) {
      var panelType = item.getAttribute('data-panel');
      var existing = findFixedTab(panelType);
      item.classList.toggle('active', !!existing);
    });
  }
};

// ===== ZEN module =====
var ZEN = {
  enter: function(paneId) {
    var p = PANE._getPane(paneId);
    if (!p) return;
    document.body.classList.add('zen-mode');
    var panes = document.querySelectorAll('.pane');
    panes.forEach(function(el) { el.classList.remove('zen-active'); });
    if (p.el) p.el.classList.add('zen-active');
    console.log('[Zen] 进入全屏模式 pane='+paneId);
  },
  exit: function() {
    document.body.classList.remove('zen-mode');
    console.log('[Zen] 退出全屏模式');
  }
};

// ===== CTX (Context Menu) module =====
var CTX = {
  showTabMenu: function(e, paneId, tabId) {
    var p = PANE._getPane(paneId);
    var tab = p ? p.tabs.find(function(t){ return t.id===tabId; }) : null;
    if (!tab) return;
    var menu = document.getElementById('ctxMenu');
    var html = '';
    html += '<div class="ctx-item" onclick="ZEN.enter(\''+paneId+'\');CTX.hide();">🔲 全屏模式</div>';
    html += '<div class="ctx-item" onclick="PANE.split(\''+paneId+'\',\''+tabId+'\',\'right\');CTX.hide();">➡️ 向右拆分</div>';
    html += '<div class="ctx-sep"></div>';
    html += '<div class="ctx-item" onclick="PANE.closeTab(\''+paneId+'\',\''+tabId+'\');CTX.hide();">✕ 关闭</div>';
    if (FIXED_TABS.indexOf(tab.type)<0) {
      html += '<div class="ctx-item" onclick="PANE.closeTab(\''+paneId+'\',\''+tabId+'\');CTX.hide();">🗑 关闭其他</div>';
    }
    menu.innerHTML = html;
    menu.classList.add('show');
    var x = e.clientX, y = e.clientY;
    if (x+180>window.innerWidth) x -= 180;
    if (y+menu.scrollHeight>window.innerHeight) y -= menu.scrollHeight;
    menu.style.left = x+'px'; menu.style.top = y+'px';
    setTimeout(function(){ document.addEventListener('click', CTX._hideHandler, {once:true}); }, 0);
  },
  hide: function() {
    document.getElementById('ctxMenu').classList.remove('show');
  },
  _hideHandler: function() {
    CTX.hide();
  }
};

// ===== TABDRAG module =====
var TABDRAG = {
  dragTab: null,
  dragPaneId: null,
  dragIdx: -1,
  ghost: null,

  onStart: function(e) {
    var tabEl = e.target.closest('.pane-tab');
    if (!tabEl) return;
    var tabId = tabEl.getAttribute('data-tab-id');
    var paneId = tabEl.getAttribute('data-pane-id');
    var p = PANE._getPane(paneId);
    if (!p) return;
    var idx = -1;
    for (var i=0; i<p.tabs.length; i++) { if (p.tabs[i].id===tabId) { idx=i; break; } }
    TABDRAG.dragTab = tabId;
    TABDRAG.dragPaneId = paneId;
    TABDRAG.dragIdx = idx;
    TABDRAG.ghostLockY = tabEl.closest('.pane-tabs').getBoundingClientRect().top + 6;
    // rAF 延迟移除原标签，避免打断浏览器 drag 初始化
    TABDRAG.dragEl = tabEl;
    TABDRAG.dragParent = tabEl.parentNode;
    TABDRAG.dragNext = tabEl.nextSibling;
    requestAnimationFrame(function() {
      if (TABDRAG.dragEl) { TABDRAG.dragEl.parentNode.removeChild(TABDRAG.dragEl); }
    });
    var ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = tabEl.textContent.replace(/✕/g,'').trim();
    document.body.appendChild(ghost);
    TABDRAG.ghost = ghost;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tabId);
    var img = new Image(); img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    img.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;pointer-events:none;';
    document.body.appendChild(img);
    e.dataTransfer.setDragImage(img, 0, 0);
    requestAnimationFrame(function(){ TABDRAG._moveGhost(e.clientX); document.body.removeChild(img); });
    document.addEventListener('dragover', TABDRAG._onGlobalDrag);
  },

  onEnd: function(e) {
    document.removeEventListener('dragover', TABDRAG._onGlobalDrag);
    cleanupDragIndicators();
    if (TABDRAG.ghost) { TABDRAG.ghost.remove(); TABDRAG.ghost = null; }
    var container = document.getElementById('paneContainer');
    if (container) container.style.boxShadow = '';
    // 取消拖拽时插回原标签
    if (TABDRAG.dragEl && TABDRAG.dragParent) {
      if (TABDRAG.dragNext) { TABDRAG.dragParent.insertBefore(TABDRAG.dragEl, TABDRAG.dragNext); }
      else { TABDRAG.dragParent.appendChild(TABDRAG.dragEl); }
    }
    TABDRAG.dragEl = null; TABDRAG.dragParent = null; TABDRAG.dragNext = null;
    TABDRAG.dragTab = null;
    TABDRAG.dragPaneId = null;
    TABDRAG.dragIdx = -1;
    TABDRAG.ghostLockY = 0;
  },

  onTabBarOver: function(e, targetPane) {
    e.preventDefault();
    cleanupDragIndicators();
    var tabsEl = targetPane.el.querySelector('.pane-tabs');
    if (!tabsEl) return;
    // 虚影中心X判断落点：无论覆盖标签还是落在间隙都能正确确定插入位置
    var ghostRect = TABDRAG.ghost ? TABDRAG.ghost.getBoundingClientRect() : null;
    var tabEls = tabsEl.querySelectorAll('.pane-tab');
    var insertIdx = tabEls.length;
    if (ghostRect) {
      var gx = ghostRect.left + ghostRect.width / 2;
      for (var i=0; i<tabEls.length; i++) {
        var tr = tabEls[i].getBoundingClientRect();
        if (gx < tr.left + tr.width / 2) { insertIdx = i; break; }
      }
    }
    // 后续标签整体右移腾出空间（smooth gap）
    var shiftW = (TABDRAG.dragPaneId===targetPane.id) ? 56 : 64;
    tabEls.forEach(function(t, i) {
      t.style.transition = 'transform 0.15s ease';
      t.style.transform = (i >= insertIdx) ? 'translateX('+shiftW+'px)' : '';
    });
    tabsEl.setAttribute('data-drop-idx', insertIdx);
  },

  onTabBarLeave: function(e) {
    if (e.relatedTarget && e.relatedTarget.closest('.pane-tabs')) return;
    cleanupDragIndicators();
  },

  onTabBarDrop: function(e, targetPane) {
    cleanupDragIndicators();
    if (!TABDRAG.dragTab) return;
    var tabsEl = targetPane.el.querySelector('.pane-tabs');
    var insertIdx = parseInt(tabsEl.getAttribute('data-drop-idx')||'0');
    if (TABDRAG.dragPaneId === targetPane.id) {
      PANE.reorderTab(targetPane.id, TABDRAG.dragIdx, insertIdx);
    } else {
      PANE.moveTab(TABDRAG.dragPaneId, targetPane.id, TABDRAG.dragTab);
    }
    TABDRAG.dragEl = null; TABDRAG.dragParent = null; TABDRAG.dragNext = null;
  },

  _onGlobalDrag: function(e) {
    TABDRAG._moveGhost(e.clientX);
    // 检测是否在 pane 右边缘（触发分屏）
    TABDRAG._checkSplitEdge(e);
  },

  _moveGhost: function(x) {
    if (!TABDRAG.ghost) return;
    TABDRAG.ghost.style.left = (x+8)+'px';
    TABDRAG.ghost.style.top = TABDRAG.ghostLockY+'px';
  },

  // 预留给容器级 drop 使用
  _checkSplitEdge: function(e) {
    // 如果拖到右侧 20% 边缘 → 显示分屏提示
    var ratio = e.clientX / window.innerWidth;
    var container = document.getElementById('paneContainer');
    if (ratio > 0.8 && ratio < 1) {
      container.style.boxShadow = 'inset -4px 0 0 8px rgba(5,163,197,0.2)';
    } else {
      container.style.boxShadow = '';
    }
  },

  // 容器级 drop → 创建新 pane
  onContainerDrop: function(e) {
    e.preventDefault();
    var container = document.getElementById('paneContainer');
    container.style.boxShadow = '';
    if (!TABDRAG.dragTab) return;
    var ratio = e.clientX / window.innerWidth;
    if (ratio > 0.8) {
      PANE.split(TABDRAG.dragPaneId, TABDRAG.dragTab, 'right');
      TABDRAG.dragTab = null; TABDRAG.dragPaneId = null;
    }
  }
};

function cleanupDragIndicators() {
  document.querySelectorAll('.pane-tab').forEach(function(t) {
    t.style.transform = ''; t.style.transition = '';
  });
}

// 容器级 drop 事件
document.addEventListener('DOMContentLoaded', function() {
  var container = document.getElementById('paneContainer');
  container.addEventListener('dragover', function(e) { e.preventDefault(); });
  container.addEventListener('drop', function(e) { TABDRAG.onContainerDrop(e); });
});

// ===== Content Renderers =====

var RENDER = {
  outline: function(container) {
    container.innerHTML = '<div class="ot-header">📖 项目大纲</div><div class="ot-body" id="otBody"><div class="ot-placeholder">加载中...</div></div>';
    loadOutline();
  },

  chat: function(container) {
    container.innerHTML = ''
      + '<div class="ch-layout">'
      + '<div class="ch-header">'
      + '<span class="ch-tab active" onclick="switchChatSubTab(\'chat\')" id="tabSubChat">💬 聊天</span>'
      + '<span class="ch-tab" onclick="switchChatSubTab(\'chars\')" id="tabSubChars">👥 角色</span>'
      + '<span style="flex:1;"></span>'
      + '<span style="font-size:11px;color:var(--text2);" id="onlineAgents">1人</span>'
      + '</div>'
      + '<div id="subPanelChat" class="ch-msgs"><div class="ap-loading">加载历史对话中...</div></div>'
      + '<div id="subPanelChars" class="ch-msgs" style="display:none;"><div id="charList"></div></div>'
      + '<div class="ch-input" id="chatInputArea">'
      + '<div class="unread-badge" id="unreadBadge" onclick="scrollToUnread()"></div>'
      + '<div class="mention-dropdown" id="mentionDropdown"></div>'
      + '<textarea id="agentInput" rows="1" placeholder="输入消息或 @Agent..." onkeydown="handleInputKey(event)" oninput="handleMentionInput();autoGrowInput()"></textarea>'
      + '<button id="btnSend" onclick="sendAgentMessage()">发送</button>'
      + '<button id="btnStop" onclick="stopAgentCall()" style="display:none;background:rgba(245,63,63,0.15)!important;color:#F53F3F!important;border:0.5px solid rgba(245,63,63,0.3)!important;">⏹ 停止</button>'
      + '</div>'
      + '<div class="tok-bar" id="panelToken" onclick="this.classList.toggle(\'expanded\')">'
      + '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text2);"><span>💰 Token</span><span id="tokenToday">加载中</span></div>'
      + '<div class="tok-detail"><div id="tokenChart" style="font-size:10px;color:var(--text2);"></div><div style="font-size:10px;color:var(--text2);" id="tokenCost"></div></div>'
      + '</div></div>';
    // 渲染现有消息
    if (agentMsgs.length) renderAgentMessages();
    else { var c=document.getElementById('subPanelChat'); if(c)c.innerHTML='<div class="ap-loading">暂无对话记录<br><span style="font-size:11px;color:var(--text2);">在下方输入消息开始创作</span></div>'; }
    loadTokenStats();
  },

  editor: function(container, tab) {
    var title = tab.label || '未命名章节';
    writingData.chapterId = tab.chapterId || null;
    activeChapterId = tab.chapterId || null;
    container.innerHTML = ''
      // 顶部标题栏
      + '<div class="ed-header">'
      + '<input class="ed-title-inp" id="chapTitleInp" value="'+escHtml(title)+'" placeholder="章节标题" onchange="renameChapterTab(this.value)">'
      + '<div class="ed-header-right">'
      + '<span class="ed-wordcount" id="wordCount">字数: 0</span>'
      + '<button class="ed-btn ed-btn-version" onclick="showChapterVersions()" title="历史版本">📋 版本</button>'
      + '<button class="ed-btn ed-btn-save" onclick="manualSaveChapter()" title="手动保存">💾 保存</button>'
      + '</div></div>'
      // 编辑正文区
      + '<div class="ed-body"><div class="ed-placeholder" id="editorPlaceholder">✍️ 开始创作...</div><div id="editableContent" class="ed-textarea" contenteditable="true" style="display:none;"></div></div>'
      // 底部固定工具栏（仅撤销/重做）
      + '<div class="ed-footer">'
      + '<div class="ed-footer-left">'
      + '<button class="ed-tbtn" onclick="document.execCommand(\'undo\')" title="撤销">↩</button>'
      + '<button class="ed-tbtn" onclick="document.execCommand(\'redo\')" title="重做">↪</button>'
      + '</div>'
      + '<div class="ed-footer-right">'
      + '<span style="font-size:10px;color:var(--text2);" id="autoSaveStatus"></span>'
      + '</div></div>';
    // 加载章节内容
    if (tab.chapterId) {
      var ch = chapters.find(function(c){ return c.id===tab.chapterId; });
      if (ch) {
        document.getElementById('editorPlaceholder').style.display = 'none';
        var ed = document.getElementById('editableContent');
        ed.style.display = 'block';
        ed.innerHTML = ch.content_text || '';
        document.getElementById('wordCount').textContent = '字数: '+((ch.content_text||'').replace(/\s/g,'').length);
      }
    }
    // 绑定编辑事件（仅更新字数，不触发自动保存）
    var edDiv = document.getElementById('editableContent');
    if (edDiv && !edDiv._bound) {
      edDiv._bound = true;
      edDiv.addEventListener('input', function() {
        var wc = (edDiv.textContent||'').replace(/\s/g,'').length;
        document.getElementById('wordCount').textContent = '字数: '+wc;
        _markDirty();
      });
      // placeholder通过CSS overlay显示，编辑器始终可见可编辑
      edDiv.style.display = 'block';
      var ph = document.getElementById('editorPlaceholder');
      if (ph) { ph.style.pointerEvents = 'none'; ph.style.position = 'absolute'; ph.style.top = '80px'; ph.style.left = '50%'; ph.style.transform = 'translateX(-50%)'; ph.style.color = 'var(--text2)'; ph.style.fontSize = '15px'; ph.style.opacity = '0.4'; ph.style.zIndex = '1'; }
      function _updatePlaceholder() {
        if (!ph) return;
        ph.style.display = (edDiv.textContent||'').trim() ? 'none' : '';
      }
      edDiv.addEventListener('input', _updatePlaceholder);
      edDiv.addEventListener('focus', function() { if (ph) ph.style.display = 'none'; });
      edDiv.addEventListener('blur', _updatePlaceholder);
      _updatePlaceholder();
      // Enter键自动缩进2个汉字（仅Enter换行，自动换行不算）
      edDiv.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          document.execCommand('insertHTML', false, '<br>&emsp;&emsp;');
        }
      });
    }
    // 启动10分钟自动保存定时器
    _startAutoSaveTimer();
  },

  skillConfig: function(container) {
    container.innerHTML = '<div class="sk-header">🧠 Skill 配置 <button onclick="SKILL.create()">+ 新建</button></div><div class="sk-body" id="skBody"><div class="sk-empty">加载中...</div></div>';
    SKILL.load();
  },

  apiConfig: function(container) {
    container.innerHTML = '<div class="ac-header">👾 Agent API 配置</div><div class="ac-body" id="acBody"><div class="sk-empty">加载中...</div></div>';
    APICFG.load();
  }
};

// ===== Chapter tab helper =====
function openChapter(chapterId) {
  var ch = chapters.find(function(c){ return c.id===chapterId; });
  if (!ch) { console.warn('[Write] openChapter: chapter not found', chapterId); return; }
  writingData.chapterId = chapterId;
  activeChapterId = chapterId;
  var targetPane = paneGroups[0];
  // 优先在当前活跃且有焦点的 pane 打开，降级到有 editor 的 pane
  for (var i=0; i<paneGroups.length; i++) {
    if (paneGroups[i].tabs.find(function(t){ return t.type==='editor'; })) {
      targetPane = paneGroups[i]; break;
    }
  }
  PANE.addTab(targetPane.id, {
    id: 'editor_'+chapterId,
    type: 'editor',
    icon: '✍️',
    label: ch.title || ('第'+ch.chapter_no+'章'),
    chapterId: chapterId
  });
}

// ===== Chat sub-tab =====
function switchChatSubTab(tab) {
  document.getElementById('tabSubChat').classList.toggle('active', tab==='chat');
  document.getElementById('tabSubChars').classList.toggle('active', tab==='chars');
  document.getElementById('subPanelChat').style.display = tab==='chat' ? '' : 'none';
  document.getElementById('subPanelChars').style.display = tab==='chars' ? '' : 'none';
  document.getElementById('chatInputArea').style.display = tab==='chat' ? '' : 'none';
  if (tab==='chars') loadCharacters();
}

// ===== Skill Config =====
function showSkillEditorFromCard(sid) {
  var card;
  document.querySelectorAll('.sk-card[data-skill]').forEach(function(c) {
    var raw = c.getAttribute('data-skill');
    try { var s = JSON.parse(raw); if (s.id===sid) card = c; } catch(e) {}
  });
  if (!card) { console.warn('[Skill] edit: card not found for id='+sid); toast('找不到技能数据', 'error'); return; }
  var raw = card.getAttribute('data-skill');
  var s;
  try { s = JSON.parse(raw); } catch(e) { toast('技能数据损坏', 'error'); return; }
  showSkillEditor(s);
}

function showSkillEditor(s) {
  var ov = document.createElement('div');
  ov.className = 'prompt-overlay';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:800;display:flex;align-items:center;justify-content:center;';
  ov.innerHTML = '<div style="background:#171717;border:0.5px solid rgba(255,255,255,0.1);border-radius:12px;padding:20px;width:640px;max-height:90vh;display:flex;flex-direction:column;">'
    +'<div style="font-size:15px;margin-bottom:12px;color:#fff;">✏️ 编辑技能</div>'
    +'<div style="overflow-y:auto;flex:1;max-height:70vh;">'
    +'<div style="margin-bottom:8px;"><label style="font-size:12px;color:var(--text2);">中文名称</label><input id="skEdNameCn" style="width:100%;padding:6px 8px;background:rgba(255,255,255,0.04);border:0.5px solid var(--border);border-radius:4px;color:#fff;font-size:13px;font-family:inherit;outline:none;" value="'+escHtml(s.name_cn||'')+'"></div>'
    +'<div style="margin-bottom:8px;"><label style="font-size:12px;color:var(--text2);">英文名称</label><input id="skEdNameEn" style="width:100%;padding:6px 8px;background:rgba(255,255,255,0.04);border:0.5px solid var(--border);border-radius:4px;color:#fff;font-size:13px;font-family:inherit;outline:none;" value="'+escHtml(s.name_en||'')+'"></div>'
    +'<div style="margin-bottom:8px;"><label style="font-size:12px;color:var(--text2);">描述</label><input id="skEdDesc" style="width:100%;padding:6px 8px;background:rgba(255,255,255,0.04);border:0.5px solid var(--border);border-radius:4px;color:#fff;font-size:13px;font-family:inherit;outline:none;" value="'+escHtml(s.description||'')+'"></div>'
    +'<div style="margin-bottom:8px;"><label style="font-size:12px;color:var(--text2);">📄 SKILL.md 内容</label><textarea id="skEdContent" style="width:100%;height:200px;padding:8px;background:rgba(255,255,255,0.04);border:0.5px solid var(--border);border-radius:4px;color:#fff;font-size:12px;font-family:Consolas,Monaco,monospace;outline:none;resize:vertical;white-space:pre-wrap;">'+escHtml(s.content||'')+'</textarea></div>'
    +'<div style="margin-bottom:8px;"><label style="font-size:12px;color:var(--text2);">📋 参考 JSON (json_schema)</label><textarea id="skEdSchema" style="width:100%;height:120px;padding:8px;background:rgba(255,255,255,0.04);border:0.5px solid var(--border);border-radius:4px;color:#fff;font-size:12px;font-family:Consolas,Monaco,monospace;outline:none;resize:vertical;white-space:pre-wrap;">'+escHtml(s.json_schema||'')+'</textarea></div>'
    +'</div>'
    +'<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-shrink:0;">'
    +'<button style="padding:8px 18px;border-radius:6px;border:0.5px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.06);color:#A1A1AA;cursor:pointer;font-family:inherit;" onclick="this.closest(\'.prompt-overlay\').remove()">取消</button>'
    +'<button style="padding:8px 18px;border-radius:6px;border:none;background:#05A3C5;color:#fff;cursor:pointer;font-family:inherit;" id="skEdSave">💾 保存</button>'
    +'</div></div>';
  document.body.appendChild(ov);
  document.getElementById('skEdSave').addEventListener('click', function() {
    var data = {
      name_cn: document.getElementById('skEdNameCn').value.trim(),
      name_en: document.getElementById('skEdNameEn').value.trim(),
      description: document.getElementById('skEdDesc').value.trim(),
      content: document.getElementById('skEdContent').value,
      json_schema: document.getElementById('skEdSchema').value
    };
    if (!data.name_cn) { toast('中文名称不能为空', 'warn'); return; }
    api('PUT','/writing-projects/'+projectId+'/skills/'+s.id, data).then(function(r) {
      if (r && r.error) { toast('保存失败: '+r.error, 'error'); return; }
      toast('技能已更新');
      ov.remove();
      SKILL.load();
    }).catch(function(e) { console.error('[Skill] 保存失败:', e); toast('保存失败', 'error'); });
  });
  ov.addEventListener('click', function(e) { if (e.target===ov) ov.remove(); });
}

var SKILL = {
  load: function() {
    var body = document.getElementById('skBody');
    if (!body) return;
    api('GET','/writing-projects/'+projectId+'/skills').then(function(skills) {
      if (!skills||!skills.length) {
        body.innerHTML = '<div class="sk-empty">暂无技能<br><span style="font-size:11px;">使用技能优化Agent自动生成，或手动创建</span></div>';
        return;
      }
      var html = '';
      skills.forEach(function(s) {
        var en = s.is_enabled ? ' enabled' : '';
        var ds = escHtml(JSON.stringify({id:s.id,name_cn:s.name_cn,name_en:s.name_en||'',description:s.description||'',content:s.content||'',json_schema:s.json_schema||''}));
        html += '<div class="sk-card" data-skill="'+ds+'">';
        html += '<div class="sk-name">'+escHtml(s.name_cn)+(s.name_en?' <span style="color:var(--text2);font-size:11px;">('+escHtml(s.name_en)+')</span>':'')+'</div>';
        html += '<div class="sk-desc">'+escHtml((s.content||'').substring(0,100)||'无内容')+'</div>';
        html += '<div class="sk-actions">';
        html += '<button class="'+en+'" onclick="SKILL.toggle('+s.id+')">'+(s.is_enabled?'✓ 已启用':'启用')+'</button>';
        html += '<button onclick="SKILL.edit('+s.id+')">✏️ 编辑</button>';
        html += '<button class="danger" onclick="SKILL.remove('+s.id+')">🗑 删除</button>';
        html += '</div></div>';
      });
      body.innerHTML = html;
    }).catch(function(e) {
      console.error('[Skill] 加载失败:', e);
      body.innerHTML = '<div class="sk-empty" style="color:var(--danger);">加载失败: '+e.message+'</div>';
    });
  },
  create: function() {
    showPrompt('新建技能名称:', '', function(name) {
      if (!name||!name.trim()) return;
      api('POST','/writing-projects/'+projectId+'/skills', { name_cn:name.trim(), content:'' }).then(function(r) {
        if (!r) { toast('创建失败: 服务器无响应', 'error'); return; }
        if (r.error) { toast('创建失败: '+r.error, 'error'); return; }
        toast('技能已创建');
        SKILL.load();
      }).catch(function(e) { console.error('[Skill] 创建失败:', e); toast('创建失败: '+e.message, 'error'); });
    });
  },
  toggle: function(sid) {
    api('POST','/writing-projects/'+projectId+'/toggle-skill/'+sid).then(function(r) {
      toast(r.is_enabled?'技能已启用':'技能已禁用');
      SKILL.load();
    }).catch(function(e) { console.error('[Skill] 切换失败:', e); toast('操作失败', 'error'); });
  },
  edit: function(sid) {
    showSkillEditorFromCard(sid);
  },
  remove: function(sid) {
    showConfirm('确定删除此技能吗？', function() {
    api('DELETE','/writing-projects/'+projectId+'/skills/'+sid).then(function(r) {
      if (r && r.error) { toast('删除失败: '+r.error, 'error'); return; }
      toast('技能已删除');
      SKILL.load();
    }).catch(function(e) { console.error("[Skill] 删除失败:", e); toast("删除失败", "error"); });
  });
  },
};

// ===== API Config =====
var AGENT_LIST = [
  { type:'orchestrator', name:'策划', icon:'🎭' },
  { type:'outliner', name:'大纲', icon:'📋' },
  { type:'character', name:'角色', icon:'👥' },
  { type:'dialog', name:'对话', icon:'💬' },
  { type:'crawler', name:'爬虫', icon:'🕷️' },
  { type:'reviewer', name:'审核', icon:'🔍' },
  { type:'skill_optimizer', name:'技能优化', icon:'🧠' },
];
var PROVIDER_OPTIONS = '<option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option><option value="custom">自定义</option>';
var PROVIDER_DEFAULTS = {
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  custom: ''
};

var APICFG = {
  onProviderChange: function(agentType) {
    var sel = document.getElementById('acProvider_'+agentType);
    var ep = document.getElementById('acEndpoint_'+agentType);
    if (!sel || !ep) return;
    var val = sel.value;
    if (PROVIDER_DEFAULTS[val] && (!ep.value || ep.value===PROVIDER_DEFAULTS[val])) {
      ep.value = PROVIDER_DEFAULTS[val];
    }
  },
  load: function() {
    var body = document.getElementById('acBody');
    if (!body) return;
    api('GET','/writing-projects/'+projectId+'/agent-api-config').then(function(configs) {
      var html = '';
      AGENT_LIST.forEach(function(a) {
        var cfg = (configs||[]).find(function(c){ return c.agent_type===a.type; }) || {};
        var provider = 'custom';
        if (cfg.api_endpoint) {
          if (cfg.api_endpoint.indexOf('deepseek.com')>=0) provider='deepseek';
          else if (cfg.api_endpoint.indexOf('openai.com')>=0) provider='openai';
        }
        html += '<div class="ac-card">';
        html += '<div class="ac-agent">'+a.icon+' '+a.name+' <span style="font-size:11px;color:var(--text2);">('+a.type+')</span><span class="ac-saved" id="acSaved_'+a.type+'">✓ 已保存</span></div>';
        html += '<div class="ac-row"><label>供应商</label><select id="acProvider_'+a.type+'" onchange="APICFG.onProviderChange(\''+a.type+'\')">'+PROVIDER_OPTIONS.replace('value="'+provider+'"','value="'+provider+'" selected')+'</select></div>';
        html += '<div class="ac-row"><label>API地址</label><input id="acEndpoint_'+a.type+'" value="'+escHtml(cfg.api_endpoint||'')+'" placeholder="https://api.example.com/v1/chat/completions"></div>';
        html += '<div class="ac-row"><label>API Key</label><input id="acKey_'+a.type+'" type="password" value="'+escHtml(cfg.api_key||'')+'" placeholder="sk-..."></div>';
        html += '<div class="ac-row"><label>模型</label><input id="acModel_'+a.type+'" value="'+escHtml(cfg.model_name||'')+'" placeholder="deepseek-v4-pro"></div>';
        html += '<button class="ac-save" onclick="APICFG.save(\''+a.type+'\')">💾 保存</button>';
        html += '</div>';
      });
      body.innerHTML = html;
    }).catch(function(e) {
      console.error('[APICfg] 加载失败:', e);
      body.innerHTML = '<div class="sk-empty" style="color:var(--danger);">加载失败: '+e.message+'</div>';
    });
  },
  save: function(agentType) {
    var data = {
      agent_type: agentType,
      api_endpoint: document.getElementById('acEndpoint_'+agentType).value,
      api_key: document.getElementById('acKey_'+agentType).value,
      model_name: document.getElementById('acModel_'+agentType).value,
      provider: document.getElementById('acProvider_'+agentType).value
    };
    api('PUT','/writing-projects/'+projectId+'/agent-api-config', data).then(function() {
      var el = document.getElementById('acSaved_'+agentType);
      if (el) { el.style.display = 'inline'; setTimeout(function(){ el.style.display = 'none'; }, 2000); }
      toast('配置已保存');
    }).catch(function(e) {
      console.error('[APICfg] 保存失败:', e);
      toast('保存失败: '+e.message, 'error');
    });
  }
};

// ==================== Agent 消息系统（从旧 write.js 保留） ====================
var agentMsgs = [];
var agentDefaults = {
  orchestrator:       { name:'策划', icon:'🎭', desc:'调配师·采访需求' },
  outliner:           { name:'大纲', icon:'📋', desc:'生成卷章大纲' },
  character:          { name:'角色', icon:'👥', desc:'设计角色档案' },
  generate_outline:   { name:'大纲', icon:'📋', desc:'生成卷章大纲' },
  generate_characters:{ name:'角色', icon:'👥', desc:'设计角色档案' },
  crawler:      { name:'爬虫', icon:'🕷️', desc:'爬取热门小说' },
  skill_optimizer: { name:'技能优化', icon:'🧠', desc:'分析习惯产出Skill' },
  load_skill:   { name:'技能', icon:'📖', desc:'读取技能指南' },
  dialog:       { name:'对话', icon:'💬', desc:'角色扮演对话' },
  reviewer:     { name:'审核', icon:'🔍', desc:'一致性检查' },
  skill_optimizer: { name:'技能优化', icon:'🧠', desc:'分析习惯产出Skill' },
};

function loadAgentNames() {
  var saved = localStorage.getItem('write_agent_names');
  if (saved) { try { var d=JSON.parse(saved); Object.assign(agentDefaults, d); } catch(e){} }
}
function saveAgentNames() { localStorage.setItem('write_agent_names', JSON.stringify(agentDefaults)); }
function getAgentName(id) { return (agentDefaults[id]&&agentDefaults[id].name) || id; }
function getAgentIcon(id) { return (agentDefaults[id]&&agentDefaults[id].icon) || '🤖'; }

// 统一工具名→Agent类型映射（防止LLM返回不同名称）
function _resolveToolAgent(toolName) {
  if (!toolName) return toolName;
  var lower = toolName.toLowerCase();
  if (lower.indexOf('outline') >= 0) return 'outliner';
  if (lower.indexOf('character') >= 0) return 'character';
  if (lower.indexOf('crawl') >= 0) return 'crawler';
  if (lower.indexOf('skill_optimizer') >= 0) return 'skill_optimizer';
  if (lower.indexOf('load_skill') >= 0) return 'load_skill';
  // 动态工具：返回工具名本身作为agent类型
  return toolName;
}

function _updateOnlineCount() {
  var el = document.getElementById('onlineAgents'); if (!el) return;
  var count = 1; // 用户始终在线
  if (agentBusy || pendingAgent || _currentStreamAgent) count++; // 调配师在活跃
  if (_toolStreamEl && _toolStreamAgent) count++; // 子智能体在活跃
  el.textContent = count + '人';
}
function renameAgent(id) {
  var cur = getAgentName(id);
  showPrompt('修改「'+id+'」的显示名:', cur, function(nn) {
    if (nn&&nn.trim()) { agentDefaults[id].name=nn.trim(); saveAgentNames(); loadMentionList(); renderAgentMessages(); }
  });
}

var mentionAgents = [];
function loadMentionList() {
  mentionAgents = [];
  var seenNames = {};
  Object.keys(agentDefaults).forEach(function(id) {
    var a = agentDefaults[id];
    if (seenNames[a.name]) return; // 同名去重（如character和generate_characters）
    seenNames[a.name] = true;
    mentionAgents.push({ id:id, name:a.name, icon:a.icon, desc:a.desc });
  });
}
loadAgentNames(); loadMentionList();

// 开发者模式（控制@提及等高级功能）
var DEV_MODE = {
  get enabled() { return localStorage.getItem('write_dev_mode') === '1'; },
  set enabled(v) { localStorage.setItem('write_dev_mode', v ? '1' : '0'); }
};

// ===== 开发者日志面板（DL对象） =====
var DL = {
  _h: parseInt(localStorage.getItem('write_dev_log_h')) || 35, // vh百分比
  _dragging: false,
  open: function() {
    if (!DEV_MODE.enabled) { toast('请先开启开发者选项', 'warn'); return; }
    var drawer = document.getElementById('devLogDrawer');
    if (drawer) { drawer.classList.add('open'); drawer.style.height = DL._h+'vh'; }
    document.getElementById('paneContainer').style.paddingBottom = DL._h+'vh';
    document.body.classList.add('devlog-open');
    localStorage.setItem('write_dev_log', '1');
    DL._connectSSE();
    DL.filter();
    DL._scrollBottom();
  },
  close: function() {
    var drawer = document.getElementById('devLogDrawer');
    if (drawer) drawer.classList.remove('open');
    document.getElementById('paneContainer').style.paddingBottom = '';
    document.body.classList.remove('devlog-open');
    localStorage.setItem('write_dev_log', '0');
    if (_devLogSse) { _devLogSse.close(); _devLogSse = null; }
  },
  toggle: function() {
    var drawer = document.getElementById('devLogDrawer');
    if (drawer && drawer.classList.contains('open')) DL.close(); else DL.open();
  },
  clear: function() {
    _devLogLines = [];
    var body = document.getElementById('devLogBody');
    if (body) body.innerHTML = '';
    DL._updateCount();
  },
  filter: function() {
    var lv = document.getElementById('dlFilter').value;
    var kw = (document.getElementById('dlSearch').value || '').toLowerCase();
    var body = document.getElementById('devLogBody');
    if (!body) return;
    var html = '';
    _devLogLines.forEach(function(e) {
      if (lv !== 'all' && e.level !== lv) return;
      if (kw && e.msg.toLowerCase().indexOf(kw) < 0) return;
      var cls = 'dl-line dl-'+e.level+' dl-'+e.source;
      var ts = e.ts.split('T')[1].split('.')[0]; // HH:MM:SS
      var tag = e.source==='server'?'[S]':'[C]';
      var hlit = kw ? e.msg.replace(new RegExp('('+kw.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi'),'<mark>$1</mark>') : e.msg;
      html += '<div class="'+cls+'"><span class="dl-ts">'+ts+'</span><span class="dl-tag">'+tag+'</span> <span class="dl-msg">'+escHtml(hlit)+'</span></div>';
    });
    body.innerHTML = html;
    DL._updateCount();
    if (_devLogAutoScroll) DL._scrollBottom();
  },
  _connectSSE: function() {
    if (_devLogSse) return;
    _devLogSse = new EventSource('/api/dev-logs?token='+encodeURIComponent(token));
    _devLogSse.addEventListener('message', function(e) {
      try {
        var d = JSON.parse(e.data);
        _devLogLines.push(d);
        if (_devLogLines.length > 2000) _devLogLines.shift();
        DL._renderLine(d);
        DL._updateCount();
        if (_devLogAutoScroll) DL._scrollBottom();
      } catch(ex) {}
    });
    _devLogSse.onerror = function() { _devLogSse = null; };
  },
  _renderLine: function(e) {
    var body = document.getElementById('devLogBody');
    if (!body) return;
    var lv = document.getElementById('dlFilter') ? document.getElementById('dlFilter').value : 'all';
    var kw = (document.getElementById('dlSearch') ? document.getElementById('dlSearch').value : '').toLowerCase();
    if (lv !== 'all' && e.level !== lv) return;
    if (kw && e.msg.toLowerCase().indexOf(kw) < 0) return;
    var cls = 'dl-line dl-'+e.level+' dl-'+e.source;
    var ts = e.ts.split('T')[1].split('.')[0];
    var tag = e.source==='server'?'[S]':'[C]';
    var hlit = kw ? e.msg.replace(new RegExp('('+kw.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi'),'<mark>$1</mark>') : e.msg;
    var div = document.createElement('div');
    div.className = cls;
    div.innerHTML = '<span class="dl-ts">'+ts+'</span><span class="dl-tag">'+tag+'</span> <span class="dl-msg">'+escHtml(hlit)+'</span>';
    body.appendChild(div);
  },
  _updateCount: function() {
    var el = document.getElementById('dlCount');
    if (el) el.textContent = _devLogLines.length+'条';
  },
  _scrollBottom: function() {
    var body = document.getElementById('devLogBody');
    if (body) body.scrollTop = body.scrollHeight;
  }
};

// 初始化：恢复日志面板状态 + 拖拽调整高度
(function() {
  if (localStorage.getItem('write_dev_log') === '1' && DEV_MODE.enabled) { setTimeout(function(){ DL.open(); }, 1000); }
  var body = document.getElementById('devLogBody');
  if (body) {
    body.addEventListener('scroll', function() {
      var atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
      _devLogAutoScroll = atBottom;
    });
  }
  // 拖拽日志栏调整高度
  var hdr = document.getElementById('devLogHeader');
  if (hdr) {
    hdr.addEventListener('mousedown', function(e) {
      if (e.target.tagName==='BUTTON'||e.target.tagName==='INPUT'||e.target.tagName==='SELECT') return;
      DL._dragging = true;
      document.body.style.userSelect = 'none';
      var startY = e.clientY, startH = document.getElementById('devLogDrawer').offsetHeight;
      function onMove(ev) {
        var newH = startH + (startY - ev.clientY);
        var vh = Math.round(newH / window.innerHeight * 100);
        vh = Math.max(12, Math.min(70, vh));
        document.getElementById('devLogDrawer').style.height = vh+'vh';
        document.getElementById('paneContainer').style.paddingBottom = vh+'vh';
      }
      function onUp(ev) {
        DL._dragging = false;
        document.body.style.userSelect = '';
        var finalH = document.getElementById('devLogDrawer').offsetHeight;
        DL._h = Math.round(finalH / window.innerHeight * 100);
        localStorage.setItem('write_dev_log_h', DL._h);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
})();

function handleMentionInput() {
  if (!DEV_MODE.enabled) return;
  var inp = document.getElementById('agentInput');
  if (!inp) return;
  var val = inp.value, cursorPos = inp.selectionStart;
  var atIdx = -1;
  for (var i=cursorPos-1; i>=0; i--) { if (val[i]==='@') { atIdx=i; break; } if (val[i]===' '||val[i]==='\n') break; }
  var dropdown = document.getElementById('mentionDropdown');
  if (!dropdown) return;
  if (atIdx>=0) {
    var query = val.substring(atIdx+1, cursorPos).toLowerCase();
    var filtered = mentionAgents.filter(function(a) { return a.name.toLowerCase().indexOf(query)>=0||a.id.toLowerCase().indexOf(query)>=0; });
    if (filtered.length) {
      var h = '';
      filtered.forEach(function(a) {
        h += '<div class="m-item" onclick="selectMention(\''+a.id+'\','+atIdx+')"><span class="m-avatar">'+a.icon+'</span><span class="m-name">'+escHtml(a.name)+'</span><span class="m-desc">'+escHtml(a.desc)+'</span></div>';
      });
      dropdown.innerHTML = h; dropdown.classList.add('show'); return;
    }
  }
  dropdown.classList.remove('show');
}
function selectMention(agentId, atIdx) {
  var inp = document.getElementById('agentInput'); if (!inp) return;
  var val = inp.value, cursorPos = inp.selectionStart;
  var agent = mentionAgents.find(function(a){return a.id===agentId;});
  var name = agent ? agent.name : agentId;
  inp.value = val.substring(0,atIdx)+'@'+name+' '+val.substring(cursorPos);
  document.getElementById('mentionDropdown').classList.remove('show');
  inp.focus(); inp.selectionStart=inp.selectionEnd=atIdx+name.length+2;
}
function showSettings() {
  var ov = document.createElement('div');
  ov.className = 'prompt-overlay';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:800;display:flex;align-items:center;justify-content:center;';
  var devOn = DEV_MODE.enabled;
  var devLogOn = localStorage.getItem('write_dev_log') === '1';
  ov.innerHTML = '<div style="background:#171717;border:0.5px solid rgba(255,255,255,0.1);border-radius:12px;padding:24px;width:400px;">'
    +'<div style="font-size:15px;margin-bottom:16px;color:#fff;">⚙️ 设置</div>'
    +'<div style="display:flex;align-items:center;justify-content:space-between;padding:12px;background:rgba(255,255,255,0.03);border-radius:8px;margin-bottom:12px;">'
    +'<div><div style="font-size:13px;color:#fff;">开发者选项</div><div style="font-size:11px;color:var(--text2);margin-top:2px;">启用 @ 唤醒子智能体加入群聊</div></div>'
    +'<div id="devToggle" style="width:44px;height:24px;border-radius:12px;cursor:pointer;transition:background 0.2s;position:relative;'+(devOn?'background:var(--accent);':'background:rgba(255,255,255,0.15);')+'"><div style="position:absolute;top:2px;'+(devOn?'right:2px;':'left:2px;')+'width:20px;height:20px;border-radius:50%;background:#fff;transition:all 0.2s;"></div></div>'
    +'</div>'
    +'<div style="display:flex;align-items:center;justify-content:space-between;padding:12px;background:rgba(255,255,255,0.03);border-radius:8px;margin-bottom:16px;">'
    +'<div><div style="font-size:13px;color:#fff;">开发者日志</div><div style="font-size:11px;color:var(--text2);margin-top:2px;">实时展示前后端完整调用日志（依赖开发者选项）</div></div>'
    +'<div id="devLogToggle" style="width:44px;height:24px;border-radius:12px;cursor:pointer;transition:background 0.2s;position:relative;'+(devLogOn?'background:var(--accent);':'background:rgba(255,255,255,0.15);')+'"><div style="position:absolute;top:2px;'+(devLogOn?'right:2px;':'left:2px;')+'width:20px;height:20px;border-radius:50%;background:#fff;transition:all 0.2s;"></div></div>'
    +'</div>'
    +'<div style="display:flex;gap:8px;justify-content:flex-end;">'
    +'<button style="padding:8px 18px;border-radius:6px;border:0.5px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.06);color:#A1A1AA;cursor:pointer;font-family:inherit;" onclick="this.closest(\'.prompt-overlay\').remove()">关闭</button>'
    +'</div></div>';
  document.body.appendChild(ov);
  document.getElementById('devToggle').addEventListener('click', function() {
    DEV_MODE.enabled = !DEV_MODE.enabled;
    ov.remove();
    showSettings();
  });
  document.getElementById('devLogToggle').addEventListener('click', function() {
    if (!DEV_MODE.enabled) { toast('请先开启开发者选项', 'warn'); return; }
    var cur = localStorage.getItem('write_dev_log') === '1';
    if (cur) { DL.close(); } else { DL.open(); }
    ov.remove();
    showSettings();
  });
  ov.addEventListener('click', function(e) { if (e.target===ov) ov.remove(); });
}

function autoGrowInput() {
  var ta = document.getElementById('agentInput'); if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

function handleInputKey(e) {
  var dropdown = document.getElementById('mentionDropdown');
  if (dropdown&&dropdown.classList.contains('show')) {
    if (e.key==='ArrowDown'||e.key==='ArrowUp') {
      e.preventDefault();
      var items = dropdown.querySelectorAll('.m-item'); var idx = -1;
      items.forEach(function(it,i){ if(it.style.background) idx=i; });
      if (e.key==='ArrowDown') idx=(idx+1)%items.length;
      else idx=idx<=0?items.length-1:idx-1;
      items.forEach(function(it,i){ it.style.background=i===idx?'rgba(5,163,197,0.12)':''; it.style.color=i===idx?'var(--text)':''; });
      return;
    }
    if ((e.key==='Enter'&&!e.shiftKey)||e.key==='Tab') {
      e.preventDefault();
      var sel = dropdown.querySelector('.m-item[style]');
      if (sel) { sel.click(); return; }
      var first = dropdown.querySelector('.m-item');
      if (first) first.click();
      return;
    }
    if (e.key==='Escape') { dropdown.classList.remove('show'); return; }
  }
  if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendAgentMessage(); }
}

// ===== Markdown formatting =====
function formatAgentContent(text) {
  if (!text) return '';
  var codeBlocks = [];
  var t = text.replace(/```(\w*)\s*([\s\S]*?)```/g, function(_, lang, code) { codeBlocks.push(code.trim()); return '%%CODEBLOCK_'+(codeBlocks.length-1)+'%%'; });
  var tables = [];
  t = t.replace(/(\|[^\n]+\|\n)+\|?[\s]*(\|[-:| ]+\|\n)+\|?[\s]*(\|[^\n]+\|\n?)+/g, function(m) { tables.push(m.trim()); return '%%TABLE_'+(tables.length-1)+'%%'; });
  t = t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  t = t.replace(/^###\s+(.+)$/gm, '<h4 style="margin:8px 0 4px;font-size:14px;">$1</h4>');
  t = t.replace(/^##\s+(.+)$/gm, '<h3 style="margin:10px 0 6px;font-size:15px;">$1</h3>');
  t = t.replace(/^[-*]{3,}\s*$/gm, '<hr style="border:0.5px solid var(--border);margin:8px 0;">');
  t = t.replace(/\*\*\s*(.+?)\s*\*\*/g, '<b>$1</b>');
  t = '<p>'+t.split(/\n\n+/).join('</p><p>')+'</p>';
  tables.forEach(function(tbl,i) {
    var rows = tbl.split('\n').filter(function(r){ return r.indexOf('|')>=0&&!r.match(/^\|?[\s]*[-:| ]+\|?[\s]*$/); });
    var html = '<table style="border-collapse:collapse;width:100%;margin:6px 0;font-size:12px;"><tbody>';
    rows.forEach(function(row,ri) {
      html += '<tr>';
      var parts = row.replace(/^\|/,'').replace(/\|$/,'').split('|');
      parts.forEach(function(cell) {
        var tag = ri===0?'th':'td';
        var style = ri===0?'padding:4px 8px;border:0.5px solid var(--border);background:rgba(5,163,197,0.12);text-align:left;':'padding:4px 8px;border:0.5px solid var(--border);text-align:left;';
        var cellText = cell.trim().replace(/\*\*\s*(.+?)\s*\*\*/g,'<b>$1</b>');
        html += '<'+tag+' style="'+style+'">'+cellText+'</'+tag+'>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    t = t.replace('%%TABLE_'+i+'%%', html);
  });
  t = t.replace(/\n/g,'<br>');
  codeBlocks.forEach(function(code,i) { t = t.replace('%%CODEBLOCK_'+i+'%%','<div class="msg-codeblock">'+code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</div>'); });
  t = t.replace(/<p>\s*<br>\s*<\/p>/g,'');
  return t;
}

// ==================== 未读追踪 ====================
var unreadCount = 0, lastReadMsgIndex = -1, unreadObserver = null;

function isUserAtBottom() { var c=document.getElementById('subPanelChat'); if(!c)return true; return c.scrollHeight-c.scrollTop-c.clientHeight<60; }
function scrollToBottom() { var c=document.getElementById('subPanelChat'); if(c){c.scrollTop=c.scrollHeight;markAllRead();} }
function markAllRead() { lastReadMsgIndex=agentMsgs.length-1; unreadCount=0; updateUnreadBadge(); }

function scrollToBottomIfAtBottom() {
  var c=document.getElementById('subPanelChat'); if(!c)return;
  if(isUserAtBottom()){c.scrollTop=c.scrollHeight;markAllRead();}
  else{unreadCount=Math.max(0,agentMsgs.length-1-lastReadMsgIndex);updateUnreadBadge();}
}

function setupUnreadObserver() {
  var container=document.getElementById('subPanelChat'); if(!container)return;
  if(unreadObserver)unreadObserver.disconnect();
  unreadObserver=new IntersectionObserver(function(entries){if(entries[0]&&entries[0].isIntersecting)markAllRead();},{root:container,threshold:0.1});
  var sentinel=container.querySelector('.msg-sentinel'); if(sentinel)unreadObserver.observe(sentinel);
}

function scrollToUnread() {
  var container=document.getElementById('subPanelChat'); if(!container)return;
  var targetIdx=Math.max(0,lastReadMsgIndex+1);
  var msgs=container.querySelectorAll('.msg:not(.msg-sentinel)');
  if(msgs[targetIdx])msgs[targetIdx].scrollIntoView({block:'start'});
  else container.scrollTop=container.scrollHeight;
  markAllRead();
}

function updateUnreadBadge() {
  var badge=document.getElementById('unreadBadge'); if(!badge)return;
  if(unreadCount>0){badge.textContent=unreadCount+' 条新消息';badge.classList.add('show');}
  else{badge.classList.remove('show');}
}

// ===== 消息 DOM =====
function fmtTime(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  var now = new Date();
  var hh = String(d.getHours()).padStart(2,'0');
  var mm = String(d.getMinutes()).padStart(2,'0');
  var time = hh+':'+mm;
  if (d.toDateString()===now.toDateString()) return time;
  return (d.getMonth()+1)+'-'+d.getDate()+' '+time;
}

function parseOptBtns(rawText, agentType, pickedOption) {
  if (agentType !== 'orchestrator') return {html:formatAgentContent(rawText), btns:''};
  var lines = rawText.split('\n');
  var btns = [];
  var kept = [];
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^\s*-\s*\[([^\]]+)\]\s*$/);
    if (m) { btns.push(m[1]); }
    else { kept.push(lines[i]); }
  }
  var html = formatAgentContent(kept.join('\n'));
  if (!btns.length) return {html:html, btns:''};
  var btnHtml = '<div class="opt-btns">';
  btns.forEach(function(t) {
    var cls = 'opt-btn';
    if (pickedOption) {
      cls += (t === pickedOption) ? ' picked' : ' gone';
    }
    btnHtml += '<button class="'+cls+'" data-opt="'+escHtml(t)+'" onclick="event.stopPropagation();clickOption(this)">'+escHtml(t)+'</button>';
  });
  btnHtml += '</div>';
  return {html:html, btns:btnHtml};
}

// ===== 选项按钮持久化 =====
function _optStoreKey() { return 'write_btn_opt_' + projectId; }

function savePickedOption(agentContent, pickedOption) {
  try {
    var store = JSON.parse(localStorage.getItem(_optStoreKey()) || '{}');
    store[agentContent] = pickedOption;
    localStorage.setItem(_optStoreKey(), JSON.stringify(store));
  } catch(e) {}
}

function loadPickedOptions() {
  try { return JSON.parse(localStorage.getItem(_optStoreKey()) || '{}'); }
  catch(e) { return {}; }
}

function clearPickedOptionsForContents(contents) {
  try {
    var store = JSON.parse(localStorage.getItem(_optStoreKey()) || '{}');
    var changed = false;
    contents.forEach(function(c) { if (store[c]) { delete store[c]; changed = true; } });
    if (changed) localStorage.setItem(_optStoreKey(), JSON.stringify(store));
  } catch(e) {}
}

function clickOption(btn) {
  var text = btn.getAttribute('data-opt'); if (!text) return;
  // 标记对应消息数据中的已选选项（持久化，刷新后状态保留）
  var msgEl = btn.closest('.msg');
  if (msgEl) {
    var mi = parseInt(msgEl.getAttribute('data-msg-idx'));
    if (!isNaN(mi) && agentMsgs[mi]) { agentMsgs[mi].pickedOption = text; savePickedOption(agentMsgs[mi].content, text); }
  }
  var btns = btn.parentElement.querySelectorAll('.opt-btn');
  btns.forEach(function(b) {
    if (b === btn) { b.classList.add('picked'); b.classList.remove('gone'); }
    else b.classList.add('gone');
  });
  var inp = document.getElementById('agentInput');
  if (inp) { inp.value = text; sendAgentMessage(); }
}

function renderSingleMsg(m) {
  var t = m.time ? '<div class="msg-time">'+fmtTime(m.time)+'</div>' : '';
  if(m.type==='undo_notice'){
    window._undoneText = m.content || '';
    if (m.used) return'<div class="msg system-msg"><span class="sys-text">你撤回了一条消息</span></div>';
    return'<div class="msg system-msg"><span class="sys-text">你撤回了一条消息，<a class="undo-notice-link" style="color:var(--accent);text-decoration:underline;cursor:pointer;" onclick="event.stopPropagation();retriggerUndoneText()">重新编辑</a></span></div>';
  }
  if(m.type==='system')return'<div class="msg system-msg"><span class="sys-text">'+escHtml(replaceAgentPlaceholders(m.content))+'</span></div>';
  if(m.role==='user'){
    var idx = agentMsgs.indexOf(m);
    return'<div class="msg user-msg" data-msg-idx="'+idx+'"><div class="avatar" style="background:rgba(5,163,197,0.12);">👤</div><div class="bubble" onmousedown="if(event.button===2){event.preventDefault();event.stopPropagation()}" oncontextmenu="event.preventDefault();showUserCtxMenu(event,'+idx+')">'+escHtml(m.content)+t+'</div></div>';
  }
  var avatar=getAgentIcon(m.agent);
  var idx = agentMsgs.indexOf(m);
  var parsed = parseOptBtns(m.content, m.agent, m.pickedOption);
  var contentHtml = parsed.html + parsed.btns;
  var h='<div class="msg agent-msg" data-msg-idx="'+idx+'"><div class="avatar" style="font-size:17px;">'+avatar+'</div><div class="bubble">';
  h+='<div style="font-size:11px;color:var(--accent);padding:4px;margin:-4px 0 -6px -4px;cursor:pointer;display:inline-block;" title="点击改名" onclick="event.stopPropagation();renameAgent(\''+escHtml(m.agent||'agent')+'\')">'+escHtml(getAgentName(m.agent))+'</div>';
  if(m.thinking){h+='<span class="think-toggle" onclick="var b=this.nextElementSibling;b.classList.toggle(\'show\');this.textContent=b.classList.contains(\'show\')?\'💭 收起思考\':\'💭 思考过程\'">💭 思考过程</span>';h+='<div class="think-body">'+formatAgentContent(m.thinking)+'</div>';}
  h+=contentHtml+t+'</div></div>';
  return h;
}

function ensureMsgInner() {
  var el = document.getElementById('subPanelChat'); if (!el) return false;
  if (!el.querySelector('.msg-inner')) {
    el.innerHTML = '<div class="msg-inner"><div class="msg msg-sentinel" style="height:1px;flex-shrink:0;opacity:0;pointer-events:none;"></div></div>';
    setupUnreadObserver();
  }
  return true;
}

function appendMsgToDOM(html) {
  if (!ensureMsgInner()) return;
  var inner=document.querySelector('#subPanelChat .msg-inner');
  var sentinel=inner.querySelector('.msg-sentinel'), thinkingEl=inner.querySelector('.msg-thinking');
  if(thinkingEl)thinkingEl.remove();
  if(sentinel)sentinel.insertAdjacentHTML('beforebegin',html);
  else inner.insertAdjacentHTML('beforeend',html);
}

function renderPendingAgent() {
  if (!ensureMsgInner() || !pendingAgent) return;
  var inner=document.querySelector('#subPanelChat .msg-inner');
  var old=inner.querySelector('.msg-thinking'); if(old)old.remove();
  var pa=pendingAgent;
  var html='<div class="msg agent-msg msg-thinking"><div class="avatar" style="font-size:17px;background:rgba(5,163,197,0.15);">'+pa.icon+'</div><div class="bubble"><div style="font-size:11px;color:var(--accent);margin-bottom:2px;">'+escHtml(pa.label||pa.agent)+'</div><span class="typing-dots"><b></b><b></b><b></b></span></div></div>';
  var sentinel=inner.querySelector('.msg-sentinel');
  if(sentinel)sentinel.insertAdjacentHTML('beforebegin',html);
  else inner.insertAdjacentHTML('beforeend',html);
}

var _renderRetryCount = 0;
function renderAgentMessages() {
  var container=document.getElementById('subPanelChat');
  console.log('[Render] container='+!!container+' agentMsgs.length='+agentMsgs.length+' agentBusy='+agentBusy+' pendingAgent='+!!pendingAgent);
  if(!container){
    if(_renderRetryCount<20){_renderRetryCount++;console.warn('[Render] subPanelChat不存在，延迟重试#'+_renderRetryCount);setTimeout(function(){renderAgentMessages();},500);}
    else{console.warn('[Render] subPanelChat重试超时，放弃');}
    return;
  }
  _renderRetryCount = 0;
  var displayStyle=window.getComputedStyle(container).display;
  console.log('[Render] container.display='+displayStyle+' scrollHeight='+container.scrollHeight);
  var wasAtBottom=container.scrollHeight-container.scrollTop-container.clientHeight<60;
  if(!agentMsgs.length){container.innerHTML='<div class="ap-loading">暂无对话记录<br><span style="font-size:11px;color:var(--text2);">在下方输入消息开始创作</span></div>';unreadCount=0;updateUnreadBadge();return;}
  var html='';
  agentMsgs.forEach(function(m, i) {
    var t = m.time ? '<div class="msg-time">'+fmtTime(m.time)+'</div>' : '';
    if(m.type==='undo_notice'){
      window._undoneText = m.content || '';
      if (m.used) { html+='<div class="msg system-msg"><span class="sys-text">你撤回了一条消息</span></div>'; }
      else { html+='<div class="msg system-msg"><span class="sys-text">你撤回了一条消息，<a class="undo-notice-link" style="color:var(--accent);text-decoration:underline;cursor:pointer;" onclick="event.stopPropagation();retriggerUndoneText()">重新编辑</a></span></div>'; }
    }
    else if(m.type==='system')html+='<div class="msg system-msg"><span class="sys-text">'+escHtml(replaceAgentPlaceholders(m.content))+'</span></div>';
    else if(m.role==='user'){
      html+='<div class="msg user-msg" data-msg-idx="'+i+'"><div class="avatar" style="background:rgba(5,163,197,0.12);">👤</div><div class="bubble" onmousedown="if(event.button===2){event.preventDefault();event.stopPropagation()}" oncontextmenu="event.preventDefault();showUserCtxMenu(event,'+i+')">'+escHtml(m.content)+t+'</div></div>';
    }
    else {
      var avatar=getAgentIcon(m.agent);
      var parsed = parseOptBtns(m.content, m.agent, m.pickedOption);
  var contentHtml = parsed.html + parsed.btns;
      html+='<div class="msg agent-msg" data-msg-idx="'+i+'"><div class="avatar" style="font-size:17px;">'+avatar+'</div><div class="bubble">';
      html+='<div style="font-size:11px;color:var(--accent);padding:4px;margin:-4px 0 -6px -4px;cursor:pointer;display:inline-block;" title="点击改名" onclick="event.stopPropagation();renameAgent(\''+escHtml(m.agent||'agent')+'\')">'+escHtml(getAgentName(m.agent))+'</div>';
      if(m.thinking){html+='<span class="think-toggle" onclick="var b=this.nextElementSibling;b.classList.toggle(\'show\');this.textContent=b.classList.contains(\'show\')?\'💭 收起思考\':\'💭 思考过程\'">💭 思考过程</span>';html+='<div class="think-body">'+formatAgentContent(m.thinking)+'</div>';}
      html+=contentHtml+t+'</div></div>';
    }
  });
  if(pendingAgent){var pa=pendingAgent;html+='<div class="msg agent-msg"><div class="avatar" style="font-size:17px;background:rgba(5,163,197,0.15);">'+pa.icon+'</div><div class="bubble"><div style="font-size:11px;color:var(--accent);margin-bottom:2px;">'+escHtml(pa.label||pa.agent)+'</div><span class="typing-dots"><b></b><b></b><b></b></span></div></div>';}
  html+='<div class="msg msg-sentinel" style="height:1px;flex-shrink:0;opacity:0;pointer-events:none;"></div>';
  container.innerHTML='<div class="msg-inner">'+html+'</div>';
  console.log('[Render] innerHTML已设置 DOM消息数='+container.querySelectorAll('.msg').length+' html长度='+html.length);
  // 检查可见性：offsetHeight/Width + 父元素链
  var rect=container.getBoundingClientRect();
  console.log('[Render] rect w='+rect.width+' h='+rect.height+' top='+rect.top+' left='+rect.left+' offsetH='+container.offsetHeight+' clientH='+container.clientHeight);
  var parent=container.parentElement; var pInfo='';
  while(parent){pInfo+=parent.tagName+(parent.classList?'.'+Array.from(parent.classList).join('.'):'')+'['+(window.getComputedStyle(parent).display)+'] → ';parent=parent.parentElement;}
  console.log('[Render] 父元素链: '+pInfo);
  function scrollDown(){if(wasAtBottom||agentMsgs.length<=2){container.scrollTop=container.scrollHeight;markAllRead();}else{lastReadMsgIndex=agentMsgs.length-1;unreadCount=0;updateUnreadBadge();}setupUnreadObserver();}
  requestAnimationFrame(function(){requestAnimationFrame(scrollDown);});
}

// ===== 撤回用户消息 =====
function lastUserMsgIdx() {
  for (var i = agentMsgs.length - 1; i >= 0; i--) {
    if (agentMsgs[i].role === 'user') return i;
  }
  return -1;
}

var pendingUndoMsgIdx = -1;

var _ctxMenuScrollHide = null;
var _ctxMenuOpenTime = 0;
function showUserCtxMenu(e, msgIdx) {
  e.preventDefault(); e.stopPropagation();
  var chat = document.getElementById('subPanelChat');
  if (chat) chat.style.userSelect = 'none';
  _ctxMenuOpenTime = Date.now();
  // 滚动聊天区时自动关闭菜单（忽略菜单打开后 150ms 内的 scroll，避免右键触发的抖动）
  function hideMenu() {
    if (Date.now() - _ctxMenuOpenTime < 150) return;
    var m=document.getElementById('userCtxMenu'); m.classList.remove('show');
    restoreUserSelect();
  }
  if (!_ctxMenuScrollHide) {
    _ctxMenuScrollHide = hideMenu;
    if (chat) chat.addEventListener('scroll', _ctxMenuScrollHide);
  }
  var menu = document.getElementById('userCtxMenu');
  menu.setAttribute('data-msg-idx', msgIdx);
  var isLatest = (msgIdx === lastUserMsgIdx());
  var busy = agentBusy || pendingAgent;
  var h = '<div class="ctx-item" onclick="copyUserMsg('+msgIdx+')">📋 复制</div>';
  h += '<div class="ctx-item" onclick="editUserMsg('+msgIdx+')">✏️ 编辑</div>';
  if (isLatest) {
    h += '<div class="ctx-sep"></div>';
    if (busy) {
      h += '<div class="ctx-item" style="color:var(--text2);cursor:default;">⏳ 思考中，无法撤回</div>';
    } else {
      h += '<div class="ctx-item danger" onclick="undoLastUserMsg()">↩ 撤回</div>';
    }
  }
  menu.innerHTML = h;
  menu.classList.add('show');
  // 限制菜单不超出视口边缘，避免触发浏览器辅助滚动
  var mx = Math.min(e.clientX, window.innerWidth - 140);
  var my = Math.min(e.clientY, window.innerHeight - 120);
  menu.style.left = mx+'px';
  menu.style.top = my+'px';
  setTimeout(function(){ document.addEventListener('click', function h(){ menu.classList.remove('show'); restoreUserSelect(); document.removeEventListener('click',h); }); }, 0);
}

function restoreUserSelect() {
  var chat = document.getElementById('subPanelChat');
  if (chat) { chat.style.userSelect = ''; }
}

function copyUserMsg(msgIdx) {
  var menu = document.getElementById('userCtxMenu');
  menu.classList.remove('show');
  restoreUserSelect();
  if (msgIdx < 0 || msgIdx >= agentMsgs.length) return;
  var text = agentMsgs[msgIdx].content || '';
  navigator.clipboard.writeText(text).then(function() {
    toast('已复制');
  }).catch(function(e) { console.error("[Poll] 请求失败:",e);
    toast('复制失败', 'error');
  });
}

function editUserMsg(msgIdx) {
  var menu = document.getElementById('userCtxMenu');
  menu.classList.remove('show');
  restoreUserSelect();
  if (msgIdx < 0 || msgIdx >= agentMsgs.length) return;
  var msg = agentMsgs[msgIdx];
  // 找到对应的气泡 DOM
  var bubble = document.querySelector('.msg.user-msg[data-msg-idx="'+msgIdx+'"] .bubble');
  if (!bubble) return;
  var oldHTML = bubble.innerHTML;
  var oldText = msg.content || '';
  // 锁定气泡宽度，防止内联编辑时尺寸变化
  var bw = bubble.getBoundingClientRect().width;
  bubble.style.width = bw + 'px';
  bubble.style.boxSizing = 'border-box';
  // 替换为内联编辑区
  bubble.innerHTML = '<textarea id="edInlineTa" style="display:block;width:100%;box-sizing:border-box;padding:6px 8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:inherit;font:inherit;font-size:inherit;line-height:inherit;outline:none;resize:none;overflow:hidden;" rows="1">'+escHtml(oldText)+'</textarea>'
    +'<div style="display:flex;gap:6px;margin-top:6px;padding:6px 8px;justify-content:flex-end;background:rgba(255,255,255,0.04);border-radius:6px;">'
    +'<button style="padding:2px 12px;border-radius:4px;border:none;background:rgba(245,63,63,0.25);color:var(--danger);cursor:pointer;font-size:10px;font-family:inherit;" id="edInlineCancel">取消</button>'
    +'<button style="padding:2px 12px;border-radius:4px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:10px;font-family:inherit;" id="edInlineConfirm">✓ 确认</button>'
    +'</div>';
  var ta = document.getElementById('edInlineTa');
  function autoGrow() { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight+'px'; }
  autoGrow();
  ta.addEventListener('input', autoGrow);
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  function restoreBubble() { bubble.style.width = ''; bubble.style.boxSizing = ''; bubble.innerHTML = oldHTML; }
  // 取消
  document.getElementById('edInlineCancel').addEventListener('click', restoreBubble);
  // 确认
  document.getElementById('edInlineConfirm').addEventListener('click', function() {
    var newText = ta.value.trim();
    if (!newText || newText === oldText) { restoreBubble(); return; }
    showConfirm('编辑后将替换此消息并删除后续 AI 回复。\n确定继续？', function() {
      agentMsgs[msgIdx].content = newText;
      agentMsgs[msgIdx].time = Date.now();
      var endIdx = agentMsgs.length;
      for (var i = msgIdx + 1; i < agentMsgs.length; i++) {
        if (agentMsgs[i].role === 'user') { endIdx = i; break; }
      }
      if (endIdx > msgIdx + 1) {
        agentMsgs.splice(msgIdx + 1, endIdx - msgIdx - 1);
      }
      api('POST','/writing-projects/'+projectId+'/undo-last').catch(function(){});
      renderAgentMessages();
	      retriggerAgent(newText);
    });
  });
  // Esc 取消
  ta.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { restoreBubble(); }
  });
}

// 检测撤回范围内是否有子智能体文件编辑
function _detectFileChanges(msgIdx) {
  var endIdx = agentMsgs.length;
  for (var i = msgIdx + 1; i < agentMsgs.length; i++) {
    if (agentMsgs[i].role === 'user') { endIdx = i; break; }
  }
  var range = agentMsgs.slice(msgIdx, endIdx);
  var detected = {};
  range.forEach(function(m) {
    // 方案A：检查子智能体类型
    if (m.agent === 'outliner') detected.outline = (detected.outline || 0) + 1;
    if (m.agent === 'character') detected.character = (detected.character || 0) + 1;
    // 方案B：检查系统消息中的完成标记
    if (m.type === 'system' && m.content && m.content.indexOf('✅') >= 0) {
      if (m.content.indexOf('大纲') >= 0) detected.outlineConfirmed = true;
      if (m.content.indexOf('角色') >= 0) detected.characterConfirmed = true;
    }
  });
  return detected;
}

function _buildUndoWarning(detected) {
  var items = [];
  if (detected.outline || detected.outlineConfirmed) items.push('• 大纲数据（卷和章节）');
  if (detected.character || detected.characterConfirmed) items.push('• 角色数据');
  if (items.length === 0) return null;
  return '⚠️ 撤回此消息将同时还原以下文件：\n\n' + items.join('\n') + '\n\n此操作不可撤销。';
}

function undoLastUserMsg() {
  var menu = document.getElementById('userCtxMenu');
  var msgIdx = parseInt(menu.getAttribute('data-msg-idx'));
  menu.classList.remove('show');
  restoreUserSelect();
  if (isNaN(msgIdx) || msgIdx < 0 || msgIdx >= agentMsgs.length) { console.warn('[Undo] invalid msgIdx:', msgIdx); return; }
  if (agentMsgs[msgIdx].role !== 'user') { console.warn('[Undo] msgIdx not a user message'); return; }

  // 检测文件变更
  var detected = _detectFileChanges(msgIdx);
  var warning = _buildUndoWarning(detected);

  if (warning) {
    // 有文件变更 → 弹窗1
    showConfirm(warning, function(ok) {
      if (!ok) return;
      // 弹窗2：最终确认
      showConfirm('确定撤回并永久删除上述数据吗？', function(ok2) {
        if (!ok2) return;
        _executeUndo(msgIdx);
      });
    });
  } else {
    // 无文件变更 → 直接撤回
    _executeUndo(msgIdx);
  }
}

function _executeUndo(msgIdx) {
  if (activeAbortController) { activeAbortController.abort(); activeAbortController = null; }
  agentBusy = false; pendingAgent = null;
  setBusyUI(false);
  var undoneText = agentMsgs[msgIdx].content || '';
  var endIdx = agentMsgs.length;
  for (var i = msgIdx + 1; i < agentMsgs.length; i++) {
    if (agentMsgs[i].role === 'user') { endIdx = i; break; }
  }
  var removed = agentMsgs.splice(msgIdx, endIdx - msgIdx);
  var removedOptContents = removed.filter(function(m){ return m.role==='assistant' && m.agent==='orchestrator' && m.pickedOption; }).map(function(m){ return m.content; });
  if (removedOptContents.length) clearPickedOptionsForContents(removedOptContents);
  console.log('[Undo] 前端撤回 msgIdx='+msgIdx+' count='+removed.length);
  for (var k = msgIdx - 1; k >= 0; k--) {
    if (agentMsgs[k].role === 'assistant' && agentMsgs[k].agent === 'orchestrator' && agentMsgs[k].pickedOption) {
      clearPickedOptionsForContents([agentMsgs[k].content]);
      delete agentMsgs[k].pickedOption;
      break;
    }
  }
  agentMsgs.splice(msgIdx, 0, { type:'undo_notice', content:undoneText, time:Date.now() });
  api('POST','/writing-projects/'+projectId+'/undo-last').then(function(r) {
    console.log('[Undo] 后端撤回:', r);
    if (r && r.rollback && (r.rollback.volumes || r.rollback.chapters || r.rollback.characters)) {
      toast('已撤回并还原 '+(r.rollback.volumes||0)+'卷 '+(r.rollback.chapters||0)+'章 '+(r.rollback.characters||0)+'角色');
    }
    loadOutline(); // 无论回滚多少，刷新大纲面板
  }).catch(function(e) { console.error('[Undo] 后端撤回失败:', e); });
  renderAgentMessages();
  requestAnimationFrame(function(){ var c=document.getElementById('subPanelChat'); if(c)c.scrollTop=c.scrollHeight; });
}

// ===== Agent 调用 =====
var agentBusy=false, pendingAgent=null, activeAbortController=null;
var streamMsgEl=null, streamThinkTimer=null, streamThinkSecs=0, streamFirstContent=false, streamConnTimeout=null;
var streamAccumThinking='', streamAccumContent='';

function setBusyUI(busy) {
  agentBusy=busy;
  var send=document.getElementById('btnSend'), stop=document.getElementById('btnStop'), inp=document.getElementById('agentInput');
  if(send)send.style.display=busy?'none':'';
  if(stop)stop.style.display=busy?'':'none';
  if(inp){inp.disabled=busy;inp.style.opacity=busy?'0.4':'';}
}

function stopAgentCall() {
  if(_bufActive){stopBufferPolling();_bufActive=false;api('POST','/writing-projects/'+projectId+'/stop-stream');}
  if(activeAbortController){console.log('[Write] 用户终止Agent调用');activeAbortController.abort();activeAbortController=null;}
  // 在清理前保存已流式输出的部分内容
  var savedThinking = streamAccumThinking;
  var savedContent = streamAccumContent;
  cleanupStreamingState();
  var oldStream = document.querySelector('.msg-streaming');
  if (oldStream) oldStream.remove();
  pendingAgent=null;renderPendingAgent();
  if (savedThinking || savedContent) {
    // 有部分内容，保存为中断消息
    var partialMsg = {
      type: 'chat',
      role: 'assistant',
      agent: 'orchestrator',
      content: savedContent + (savedContent ? '\n\n⏹ 已终止' : '⏹ 已终止'),
      thinking: savedThinking,
      time: Date.now()
    };
    agentMsgs.push(partialMsg);
    appendMsgToDOM(renderSingleMsg(partialMsg));
  } else {
    var stopMsg = {type:'system',content:'⏹ 已终止',time:Date.now()};
    agentMsgs.push(stopMsg);
    appendMsgToDOM(renderSingleMsg(stopMsg));
  }
  setBusyUI(false);
}

// ===== 流式消息渲染 =====
function cleanupStreamingState() {
  if (streamThinkTimer) { clearInterval(streamThinkTimer); streamThinkTimer = null; }
  if (streamConnTimeout) { clearTimeout(streamConnTimeout); streamConnTimeout = null; }
  streamMsgEl = null; streamThinkSecs = 0; streamFirstContent = false;
  streamAccumThinking = ''; streamAccumContent = '';
}

function createStreamingBubble(agentType) {
  ensureMsgInner();
  var inner = document.querySelector('#subPanelChat .msg-inner');
  var oldThink = inner.querySelector('.msg-thinking');
  if (oldThink) oldThink.remove();
  // 只移除调配师流式气泡，保留子智能体气泡（.msg-tool-stream）
  var oldStream = inner.querySelector('.msg-streaming:not(.msg-tool-stream)');
  if (oldStream) oldStream.remove();

  var icon = getAgentIcon(agentType);
  var name = getAgentName(agentType);
  var html = '<div class="msg agent-msg msg-streaming">'
    + '<div class="avatar" style="font-size:17px;">'+icon+'</div>'
    + '<div class="bubble">'
    + '<div style="font-size:11px;color:var(--accent);padding:4px;margin:-4px 0 -6px -4px;cursor:pointer;display:inline-block;" title="点击改名" onclick="event.stopPropagation();renameAgent(\''+escHtml(agentType)+'\')">'+escHtml(name)+'</div>'
    + '<span class="think-toggle stream-think-toggle" onclick="var b=this.nextElementSibling;var show=b.classList.toggle(\'show\');var lb=this.querySelector(\'.toggle-label\');if(lb)lb.textContent=show?\'💭 收起思考\':\'💭 思考过程\'" style="cursor:pointer;">'
    + '<span class="toggle-label">💭 思考中...</span> '
    + '<span class="stream-timer">等待中...</span> '
    + '<span class="typing-dots"><b></b><b></b><b></b></span>'
    + '</span>'
    + '<div class="think-body show stream-think-body" style="max-height:200px;overflow-y:auto;text-align:left;"></div>'
    + '<div class="stream-content" style="display:none;max-height:360px;overflow-y:auto;text-align:left;overflow-wrap:break-word;"></div>'
    + '</div></div>';
  var sentinel = inner.querySelector('.msg-sentinel');
  if (sentinel) sentinel.insertAdjacentHTML('beforebegin', html);
  else inner.insertAdjacentHTML('beforeend', html);
  streamMsgEl = inner.querySelector('.msg-streaming:not(.msg-tool-stream)');
  return streamMsgEl;
}

function startThinkingTimer() {
  if (streamConnTimeout) { clearTimeout(streamConnTimeout); streamConnTimeout = null; }
  streamThinkSecs = 0;
  updateThinkingTimerDisplay();
  streamThinkTimer = setInterval(function() {
    streamThinkSecs++;
    updateThinkingTimerDisplay();
  }, 1000);
}

function updateThinkingTimerDisplay() {
  if (!streamMsgEl) return;
  var timerEl = streamMsgEl.querySelector('.stream-timer');
  if (timerEl) timerEl.textContent = streamThinkSecs + 's';
}

function finalizeThinkingTimer() {
  if (streamThinkTimer) { clearInterval(streamThinkTimer); streamThinkTimer = null; }
  if (!streamMsgEl) return;
  var dots = streamMsgEl.querySelector('.typing-dots');
  if (dots) dots.style.display = 'none';
  // 如果思考计时器从未启动（无思考阶段），直接隐藏整个thinking区域
  if (streamThinkSecs === 0) {
    var toggle = streamMsgEl.querySelector('.stream-think-toggle');
    if (toggle) toggle.style.display = 'none';
    var thinkBody = streamMsgEl.querySelector('.stream-think-body');
    if (thinkBody) thinkBody.style.display = 'none';
    return;
  }
  var toggle = streamMsgEl.querySelector('.stream-think-toggle');
  if (toggle) {
    toggle.innerHTML = '💭 思考过程 (用时 '+streamThinkSecs+'s)';
    toggle.style.cursor = 'pointer';
    toggle.setAttribute('onclick', 'var b=this.nextElementSibling;b.classList.toggle(\'show\');this.innerHTML=b.classList.contains(\'show\')?\'💭 收起思考\':\'💭 思考过程 (用时 '+streamThinkSecs+'s)\'');
  }
}

function appendThinkingDelta(delta) {
  if (!streamMsgEl) return;
  streamAccumThinking += delta;
  var body = streamMsgEl.querySelector('.stream-think-body');
  if (body) {
    body.innerHTML += escHtml(delta);
    body.scrollTop = body.scrollHeight;
  }
}

function appendContentDelta(delta) {
  if (!streamMsgEl) return;
  streamAccumContent += delta;
  if (!streamFirstContent) {
    streamFirstContent = true;
    finalizeThinkingTimer();
    var contentEl = streamMsgEl.querySelector('.stream-content');
    if (contentEl) contentEl.style.display = '';
  }
  var contentEl = streamMsgEl.querySelector('.stream-content');
  if (contentEl) {
    contentEl.innerHTML += escHtml(delta).replace(/\n/g, '<br>');
    scrollToBottom();
  }
}

function finalizeStreamingMsg(data) {
  if (streamThinkTimer) { clearInterval(streamThinkTimer); streamThinkTimer = null; }

  var content = data.content || '';
  var thinking = data.thinking || '';

  if (thinking && !streamFirstContent) {
    finalizeThinkingTimer();
  }

  var msg = {
    type: 'chat',
    role: 'assistant',
    agent: 'orchestrator',
    content: content,
    thinking: thinking,
    time: Date.now()
  };
  agentMsgs.push(msg);

  // 移除旧的frozen气泡，追加正式渲染到最底部
  var frozen = document.querySelector('.msg-streaming:not(.msg-tool-stream)');
  if (frozen) frozen.remove();
  if (ensureMsgInner()) appendMsgToDOM(renderSingleMsg(msg));

  streamMsgEl = null;
  streamFirstContent = false;
  console.log('[Write] 流式完成 回复长度='+content.length+' 思考长度='+thinking.length);
}

// ===== 流式SSE读取 =====
async function doStreamingCall(text) {
  var ac = new AbortController(); activeAbortController = ac;

  // 180秒连接超时：DeepSeek深度推理可能需较长时间产生首token
  streamConnTimeout = setTimeout(function() {
    if (!streamFirstContent && streamThinkSecs === 0 && !streamThinkTimer) {
      console.warn('[Write] 流式连接超时（180s未收到事件）');
      if (activeAbortController) activeAbortController.abort();
      cleanupStreamingState();
      var oldStream = document.querySelector('.msg-streaming');
      if (oldStream) oldStream.remove();
      var to = { type: 'system', content: '⚠️ 连接超时：180秒未收到AI响应，请检查网络或API配置后重试', time: Date.now() };
      agentMsgs.push(to);
      appendMsgToDOM(renderSingleMsg(to));
      setBusyUI(false);
      scrollToBottomIfAtBottom();
    }
  }, 180000);

  try {
    var resp = await fetch(API+'/writing-projects/'+projectId+'/llm-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer '+token },
      body: JSON.stringify({ content: text, stream: true }),
      signal: ac.signal
    });

    if (!resp.ok) {
      var errText = await resp.text();
      throw new Error('HTTP '+resp.status+': '+errText.substring(0, 200));
    }

    // 检测响应类型：非 text/event-stream 说明后端未启用流式模式
    var contentType = resp.headers.get('Content-Type') || '';
    if (contentType.indexOf('text/event-stream') === -1) {
      throw new Error('服务器未启用流式模式（Content-Type: '+contentType+'），请确认后端已更新并重启');
    }

    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    var hasStartedThinking = false;

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;

      buf += decoder.decode(chunk.value, { stream: true });
      var lines = buf.split('\n');
      buf = lines.pop() || '';

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line.indexOf('data: ') !== 0) continue;
        var raw = line.slice(6);
        try {
          var evt = JSON.parse(raw);
          // 任何有意义的事件都重置超时（connected/waiting/tool_start/tool_end）
          if (evt.type === 'connected' || evt.type === 'waiting' || evt.type === 'tool_start' || evt.type === 'tool_end') {
            if (streamConnTimeout) { clearTimeout(streamConnTimeout); streamConnTimeout = null; }
            if (evt.type === 'connected') _updateOnlineCount();
            streamConnTimeout = setTimeout(function() {
              if (!streamFirstContent && streamThinkSecs === 0 && !streamThinkTimer) {
                console.warn('[Write] 流式连接超时（180s未收到事件）');
                if (activeAbortController) activeAbortController.abort();
                cleanupStreamingState();
                var oldStream2 = document.querySelector('.msg-streaming');
                if (oldStream2) oldStream2.remove();
                var to2 = { type: 'system', content: '⚠️ 连接超时：180秒未收到AI响应，请检查网络或API配置后重试', time: Date.now() };
                agentMsgs.push(to2);
                appendMsgToDOM(renderSingleMsg(to2));
                setBusyUI(false);
                scrollToBottomIfAtBottom();
              }
            }, 180000);
          }
          // 事件分派
          if (evt.type === 'thinking') {
            if (!hasStartedThinking) { hasStartedThinking = true; startThinkingTimer(); }
            appendThinkingDelta(evt.delta);
          } else if (evt.type === 'content') {
            appendContentDelta(evt.delta);
          } else if (evt.type === 'done') {
            if (streamConnTimeout) { clearTimeout(streamConnTimeout); streamConnTimeout = null; }
            finalizeStreamingMsg(evt);
          } else if (evt.type === 'tool_start') {
            // 调配师调用子智能体 → 显示系统消息 + 子智能体气泡 + 启动短语轮播
            _subAccumThinking = ''; // 重置思维链累积
            var toolAgentType = evt.subAgent || _resolveToolAgent(evt.tool);
            var toolLabel = getAgentName(toolAgentType);
            var inviteMsg = {type:'system',content:getAgentName('orchestrator')+' 调用 '+toolLabel+' 智能体',time:Date.now()};
            agentMsgs.push(inviteMsg);
            if (ensureMsgInner()) appendMsgToDOM(renderSingleMsg(inviteMsg));
            // load_skill 不需要子智能体气泡（服务端指定了 subAgent 的除外）
            if (toolAgentType === 'load_skill') {
              _updateOnlineCount();
              pendingAgent = null;
            } else {
              _ensureToolBubble(toolAgentType);
              _startPhraseRotation();
              _updateOnlineCount();
              pendingAgent = null;
            }
          } else if (evt.type === 'tool_stream') {
            // 子智能体流式输出 → 实时更新气泡思考区/正文区
            var tsAgent = evt.subAgent || _resolveToolAgent(evt.tool);
            if (!_toolStreamEl || _toolStreamAgent !== tsAgent) _ensureToolBubble(tsAgent);
            if (evt.phase === 'thinking') {
              // 思维链静默累积，不写DOM。牛马碎碎念继续轮播
              _subAccumThinking += evt.delta||'';
            } else if (evt.phase === 'content') {
              _stopPhraseRotation();
              // 第一帧正文：将累积的思维链一次性写入DOM
              if (_subAccumThinking && _toolStreamEl) {
                var _tThink = _toolStreamEl.querySelector('.stream-think-body');
                if (_tThink) { _tThink.innerHTML = escHtml(_subAccumThinking).replace(/\n/g,'<br>'); _tThink.scrollTop = _tThink.scrollHeight; }
                var _tLabel = _toolStreamEl.querySelector('.toggle-label');
                if (_tLabel) _tLabel.textContent = '💭 思考过程';
                _subAccumThinking = ''; // 已写入，清空
              }
              var tCont = _toolStreamEl ? _toolStreamEl.querySelector('.stream-content') : null;
              if (tCont) {
                tCont.style.display = '';
                var fd = escHtml(evt.delta||'').replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/\n/g,'<br>');
                tCont.insertAdjacentHTML('beforeend', fd);
                tCont.scrollTop = tCont.scrollHeight;
              }
            }
            scrollToBottomIfAtBottom();
          } else if (evt.type === 'tool_request') {
            // 子智能体向主智能体请求工具
            var trAgent = evt.subAgent || _resolveToolAgent(evt.tool);
            var trLabel = getAgentName(trAgent);
            var trReqLabel = evt.requested || '未知工具';
            var reqMsg = {type:'system',content:trLabel+' 请求调用 '+trReqLabel+' 工具',time:Date.now()};
            agentMsgs.push(reqMsg);
            if (ensureMsgInner()) appendMsgToDOM(renderSingleMsg(reqMsg));
          } else if (evt.type === 'tool_end') {
            _stopPhraseRotation();
            var toolAgentType = evt.subAgent || _resolveToolAgent(evt.tool);
            // load_skill直接展示为系统消息
            if (toolAgentType === 'load_skill') {
              var skillMsg = {type:'system',content:evt.summary||'技能已加载',time:Date.now()};
              agentMsgs.push(skillMsg);
              if (ensureMsgInner()) appendMsgToDOM(renderSingleMsg(skillMsg));
              _updateOnlineCount();
            } else if (_toolStreamEl) {
              // 如果思维链累积了但从未写入DOM（正文未生成），现在写入
              if (_subAccumThinking) {
                var _tThink2 = _toolStreamEl.querySelector('.stream-think-body');
                if (_tThink2) { _tThink2.innerHTML = escHtml(_subAccumThinking).replace(/\n/g,'<br>'); }
                _subAccumThinking = '';
              }
              // 保留流式累积的thinking/content，只更新标签状态
              var tLabel = _toolStreamEl.querySelector('.toggle-label');
              if (tLabel && evt.thinking) {
                tLabel.textContent = '💭 思考过程（已完成）';
              } else if (tLabel) {
                tLabel.textContent = '💭 结果摘要';
              }
              // 内容区全量格式化渲染（表格/代码块等复杂Markdown）
              if (evt.content) {
                var tContent = _toolStreamEl.querySelector('.stream-content');
                if (tContent) { tContent.style.display = ''; tContent.innerHTML = formatAgentContent(evt.content); }
              }
              // 追加结果消息到agentMsgs并持久化到DB
              var toolMsg = {type:'chat',role:'assistant',agent:toolAgentType,content:evt.content||'',thinking:evt.thinking||'',time:Date.now()};
              agentMsgs.push(toolMsg);
              api('POST','/writing-projects/'+projectId+'/conversations',{agent_type:toolAgentType,role:'assistant',content:evt.content||'',thinking:evt.thinking||'',metadata:'{"type":"chat"}'});
              var leaveMsg = {type:'system',content:evt.summary||'子智能体已完成',time:Date.now()};
              agentMsgs.push(leaveMsg);
              // 关闭流式状态，保留DOM
              _closeToolBubble();
              _updateOnlineCount();
            } else {
              // 兜底：气泡不存在时用旧逻辑
              if (evt.content || evt.thinking) {
                var toolMsg2 = {type:'chat',role:'assistant',agent:toolAgentType,content:evt.content||'',thinking:evt.thinking||'',time:Date.now()};
                agentMsgs.push(toolMsg2);
                api('POST','/writing-projects/'+projectId+'/conversations',{agent_type:toolAgentType,role:'assistant',content:evt.content||'',thinking:evt.thinking||'',metadata:'{"type":"chat"}'});
                if (ensureMsgInner()) appendMsgToDOM(renderSingleMsg(toolMsg2));
              }
              var leaveMsg2 = {type:'system',content:evt.summary||'子智能体已完成',time:Date.now()};
              agentMsgs.push(leaveMsg2);
              if (ensureMsgInner()) appendMsgToDOM(renderSingleMsg(leaveMsg2));
            }
            // 刷大纲/角色/SKILL面板
            var agentType = _resolveToolAgent(evt.tool);
            if (agentType === 'outliner') { setTimeout(function(){loadOutline();}, 500); }
            if (agentType === 'character') { setTimeout(function(){loadCharacters();}, 500); }
            if (agentType === 'load_skill' || agentType === 'skill_optimizer') { setTimeout(function(){SKILL.load();}, 500); }
          } else if (evt.type === 'error') {
            if (streamConnTimeout) { clearTimeout(streamConnTimeout); streamConnTimeout = null; }
            var errMsg = { type: 'system', content: '⚠️ '+evt.message, time: Date.now() };
            agentMsgs.push(errMsg);
            appendMsgToDOM(renderSingleMsg(errMsg));
            cleanupStreamingState();
          }
        } catch(e) {}
      }
    }
  } catch(err) {
    if (streamConnTimeout) { clearTimeout(streamConnTimeout); streamConnTimeout = null; }
    if (err && err.name === 'AbortError') {
      console.log('[Write] 流式调用已终止');
      cleanupStreamingState();
      return;
    }
    console.error('[Write] 流式调用异常:', err);
    cleanupStreamingState();
    var oldStream = document.querySelector('.msg-streaming');
    if (oldStream) oldStream.remove();
    var em = { type: 'system', content: '⚠️ 网络错误: '+(err&&err.message||'未知'), time: Date.now() };
    agentMsgs.push(em);
    appendMsgToDOM(renderSingleMsg(em));
  } finally {
    if (streamConnTimeout) { clearTimeout(streamConnTimeout); streamConnTimeout = null; }
    pendingAgent = null;
    activeAbortController = null;
    setBusyUI(false);
    scrollToBottomIfAtBottom();
  }
}

function retriggerUndoneText() {
  var text = window._undoneText;
  if (!text) return;
  var inp = document.getElementById('agentInput');
  if (inp) { inp.value = text; inp.focus(); autoGrowInput(); }
}

function retriggerAgent(text) {
  if (agentBusy) return;
  setBusyUI(true);
  stopBufferPolling(); _bufActive = false;
  cleanupStreamingState();
  markAllRead();
  createStreamingBubble('orchestrator');
  doStreamingCall(text);
}

function sendAgentMessage() {
  var inp=document.getElementById('agentInput'); if(!inp)return;
  var text=inp.value.trim(); if(!text||agentBusy)return;
  inp.value=''; setBusyUI(true);
  stopBufferPolling(); _bufActive = false;
  cleanupStreamingState(); // 清除上次缓冲轮询残留的计时器/累积变量
  // 标记所有撤回提示为已使用（重新编辑后链接失效）
  for (var i = agentMsgs.length-1; i >= 0; i--) {
    if (agentMsgs[i].type === 'undo_notice') { agentMsgs[i].used = true; }
  }
  // 同步更新 DOM 中已有的撤回提示：移除链接并把文字末尾逗号去掉
  var notices = document.querySelectorAll('.undo-notice-link');
  for (var j = 0; j < notices.length; j++) {
    var parentSpan = notices[j].parentElement;
    notices[j].remove();
    if (parentSpan && parentSpan.classList.contains('sys-text')) {
      parentSpan.textContent = '你撤回了一条消息';
    }
  }
  console.log('[Write] 用户发送: '+text.substring(0,100));
  markAllRead();
  var now = Date.now();
  var userMsg={type:'chat',role:'user',content:text,time:now};
  agentMsgs.push(userMsg); appendMsgToDOM(renderSingleMsg(userMsg)); scrollToBottom();
  createStreamingBubble('orchestrator');
  doStreamingCall(text);
}

// ===== 子Agent调度 =====
function subAgentStart(agentId, agentName) {
  var oname=getAgentName('orchestrator'); var inv={type:'system',content:oname+' 邀请 '+agentName+' 进入群聊',time:Date.now()};
  agentMsgs.push(inv);
  pendingAgent={agent:agentId,label:agentName,icon:getAgentIcon(agentId)};
  renderAgentMessages();
}
function subAgentEnd(agentId, agentName) {
  pendingAgent=null;
  var leave={type:'system',content:agentName+' 退出群聊',time:Date.now()};
  agentMsgs.push(leave);
  renderAgentMessages();
}

// ==================== 大纲树 ====================
var volumes=[], chapters=[], activeChapterId=null;

function loadOutline() {
  console.log('[Write] 加载大纲树');
  api('GET','/writing-projects/'+projectId+'/volumes').then(function(vols){volumes=vols||[];api('GET','/writing-projects/'+projectId+'/chapters').then(function(chaps){chapters=chaps||[];console.log('[Write] 大纲: '+volumes.length+'卷 '+chapters.length+'章');renderOutlineTree();refreshEditorTabs();});});
}

function refreshEditorTabs() {
  paneGroups.forEach(function(p) {
    p.tabs.forEach(function(t) {
      if (t.type==='editor' && t.chapterId && t.id===p.activeTabId) {
        PANE._renderContent(p, t);
      }
    });
  });
}

function renderOutlineTree() {
  var body=document.getElementById('otBody'); if(!body)return;
  var html='';
  volumes.forEach(function(v){
    var vChaps=chapters.filter(function(c){return c.volume_id===v.id;});
    html+='<div class="ot-vol"><div class="ot-vol-header" onclick="toggleVolume(this)" oncontextmenu="event.preventDefault();event.stopPropagation();showVolCtxMenu(event,'+v.id+')"><span class="ot-vol-arrow">▶</span><span class="ot-vol-title">'+escHtml(v.title||'第'+v.volume_no+'卷')+'</span><button class="ot-vol-add" onclick="event.stopPropagation();addChapter('+v.id+')" title="添加章">+章</button></div><div class="ot-chapters">';
    vChaps.forEach(function(c){
      var active=activeChapterId===c.id?' active':'';
      html+='<div class="ot-chap'+active+'" ondblclick="openChapter('+c.id+')" onclick="activeChapterId='+c.id+';renderOutlineTree();" oncontextmenu="event.preventDefault();event.stopPropagation();showChapCtxMenu(event,'+c.id+')">'+escHtml(c.title||'第'+c.chapter_no+'章')+'</div>';
    });
    html+='</div></div>';
  });
  html+='<button onclick="addVolume()" class="ot-btn">+ 新建卷</button>';
  body.innerHTML=html;
}

function toggleVolume(el){var arrow=el.querySelector('.ot-vol-arrow'),chaps=el.nextElementSibling;if(chaps&&chaps.classList.contains('ot-chapters')){var hidden=chaps.style.display==='none';chaps.style.display=hidden?'block':'none';arrow.textContent=hidden?'▼':'▶';}}
function addVolume(){showPrompt('新建卷', '新卷', function(name) { if (name && name.trim()) { api('POST','/writing-projects/'+projectId+'/volumes',{title:name.trim()}).then(function(r){console.log('[Write] 新建卷 id='+(r&&r.id));loadOutline();}).catch(function(e){console.error('[Write] 新建卷失败:',e);}); } });}
function addChapter(volumeId){api('POST','/writing-projects/'+projectId+'/chapters',{volume_id:volumeId,title:'新章'}).then(function(r){console.log('[Write] 新建章 id='+(r&&r.id)+' vid='+volumeId);loadOutline();}).catch(function(e){console.error('[Write] 新建章失败:',e);});}

// ===== 卷/章右键菜单 =====
function showVolCtxMenu(e, volId) {
  var titleEl = e.target.closest('.ot-vol-header').querySelector('.ot-vol-title');
  var volTitle = titleEl ? titleEl.textContent : '';
  showPrompt('重命名卷', volTitle, function(newName) {
    if (newName && newName.trim()) {
      api('PUT', '/writing-projects/'+projectId+'/volumes/'+volId, {title: newName.trim()}).then(function() { loadOutline(); });
    }
  });
  setTimeout(function() {
    var ov = document.querySelector('.prompt-overlay');
    if (ov) {
      var delBtn = document.createElement('button');
      delBtn.textContent = '🗑️ 删除此卷';
      delBtn.style.cssText = 'display:block;margin:8px auto 0;padding:6px 12px;border-radius:6px;border:0.5px solid rgba(245,63,63,0.3);background:rgba(245,63,63,0.1);color:#F53F3F;cursor:pointer;font-family:inherit;font-size:12px;';
      delBtn.onclick = function() {
        ov.remove();
        var hasChaps = chapters.some(function(c){ return c.volume_id === volId; });
        if (hasChaps) {
          showDeleteConfirm('确定删除此卷及其所有章节和版本历史吗？此操作不可撤销。', '我确认删除此卷，我知晓删除后内容无法复原', function() {
            api('DELETE', '/writing-projects/'+projectId+'/volumes/'+volId).then(function() { loadOutline(); });
          });
        } else {
          showConfirm('确定删除空卷「'+volTitle+'」吗？', function(ok) {
            if (ok) { api('DELETE', '/writing-projects/'+projectId+'/volumes/'+volId).then(function() { loadOutline(); }); }
          });
        }
      };
      ov.querySelector('div > div:last-child').appendChild(delBtn);
    }
  }, 100);
}

// 删除确认弹窗（需输入指定文字才能确认）
function showDeleteConfirm(msg, requiredText, cb) {
  var ov = document.createElement('div'); ov.className = 'prompt-overlay';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:800;display:flex;align-items:center;justify-content:center;';
  ov.innerHTML = '<div style="background:#171717;border:0.5px solid rgba(255,255,255,0.1);border-radius:12px;padding:24px;width:420px;">'
    + '<div style="font-size:15px;margin-bottom:8px;color:#fff;line-height:1.6;text-align:center;">'+escHtml(msg)+'</div>'
    + '<div style="font-size:11px;color:var(--text2);margin-bottom:12px;text-align:center;">请输入：<b style="color:#F53F3F;">'+escHtml(requiredText)+'</b></div>'
    + '<input id="_delCfInp" style="width:100%;padding:8px 12px;background:rgba(255,255,255,0.04);border:0.5px solid rgba(255,255,255,0.1);border-radius:6px;color:#fff;font-size:14px;font-family:inherit;outline:none;" placeholder="请复制上方文字输入">'
    + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">'
    + '<button style="padding:8px 18px;border-radius:6px;border:0.5px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.06);color:#A1A1AA;cursor:pointer;font-family:inherit;" onclick="this.closest(\'.prompt-overlay\').remove()">取消</button>'
    + '<button id="_delCfBtn" style="padding:8px 18px;border-radius:6px;border:none;background:#3F3F3F;color:#666;cursor:not-allowed;font-family:inherit;" disabled>确认删除</button>'
    + '</div></div>';
  document.body.appendChild(ov);
  var inp = document.getElementById('_delCfInp');
  var btn = document.getElementById('_delCfBtn');
  inp.addEventListener('input', function() {
    var ok = inp.value.trim() === requiredText;
    btn.disabled = !ok;
    btn.style.background = ok ? '#F53F3F' : '#3F3F3F';
    btn.style.color = ok ? '#fff' : '#666';
    btn.style.cursor = ok ? 'pointer' : 'not-allowed';
  });
  btn.addEventListener('click', function() {
    if (!btn.disabled) { ov.remove(); cb(); }
  });
  ov.addEventListener('click', function(e) { if (e.target === ov) ov.remove(); });
  setTimeout(function() { inp.focus(); }, 100);
}

function showChapCtxMenu(e, chapId) {
  showConfirm('确定删除此章吗？', function(ok) {
    if (ok) { api('DELETE', '/writing-projects/'+projectId+'/chapters/'+chapId).then(function() { loadOutline(); }); }
  });
}


function generateOutline() {
  console.log('[Write] 触发大纲生成');
  var uname=getAgentName('outliner');subAgentStart('outliner',uname);
  api('POST','/writing-projects/'+projectId+'/generate-outline').then(function(r){subAgentEnd('outliner',uname);if(r&&r.content){var outlineJson=null;try{var clean=r.content.replace(/```json\s*|\s*```/g,'').trim();outlineJson=JSON.parse(clean);}catch(e){}if(outlineJson&&outlineJson['卷']){outlineJson['卷'].forEach(function(vol,vi){api('POST','/writing-projects/'+projectId+'/volumes',{title:vol['卷名']||('第'+(vi+1)+'卷')}).then(function(vr){if(vr&&vr.id){(vol['章']||[]).forEach(function(chap){api('POST','/writing-projects/'+projectId+'/chapters',{volume_id:vr.id,title:chap['章名']||''});});}});});var omsg={type:'chat',role:'assistant',agent:'outliner',time:Date.now(),content:r.content.substring(0,500)+(r.content.length>500?'\n...(已截断)':''),thinking:''};agentMsgs.push(omsg);appendMsgToDOM(renderSingleMsg(omsg));var okmsg={type:'system',time:Date.now(),content:'✅ 大纲已生成，'+outlineJson['卷'].length+'卷'};agentMsgs.push(okmsg);appendMsgToDOM(renderSingleMsg(okmsg));setTimeout(function(){loadOutline();},1000);}else{var omsg2={type:'chat',role:'assistant',agent:'outliner',time:Date.now(),content:r.content,thinking:''};agentMsgs.push(omsg2);appendMsgToDOM(renderSingleMsg(omsg2));}}else{var emsg={type:'system',time:Date.now(),content:'⚠️ 大纲生成失败: '+(r&&r.error||'未知错误')};agentMsgs.push(emsg);appendMsgToDOM(renderSingleMsg(emsg));}}).catch(function(err){subAgentEnd('outliner',uname);var emsg2={type:'system',time:Date.now(),content:'⚠️ 大纲生成网络错误'};agentMsgs.push(emsg2);appendMsgToDOM(renderSingleMsg(emsg2));console.error('[Write] 大纲生成异常:',err);});
}

// ==================== 角色管理 ====================
function loadCharacters() {
  console.log('[Write] 加载角色列表');
  api('GET','/writing-projects/'+projectId+'/characters').then(function(chars){var list=document.getElementById('charList');if(!list)return;if(!chars||!chars.length){list.innerHTML='<div style="color:var(--text2);font-size:12px;text-align:center;padding:16px;">暂无角色</div>';return;}var html='';chars.forEach(function(c){try{var profile=JSON.parse(c.profile_json||'{}');}catch(e){profile={};}html+='<div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:8px;font-size:12px;margin-bottom:4px;"><div style="font-weight:600;margin-bottom:4px;">'+escHtml(c.name)+(c.aliases?' ('+escHtml(c.aliases)+')':'')+'</div>'+(profile['外貌']?'<div style="color:var(--text2);font-size:11px;">'+escHtml(profile['外貌'].substring(0,60))+'...</div>':'')+'</div>';});list.innerHTML=html;}).catch(function(e){console.error('[Write] 角色加载失败:',e);});
}

function generateCharacters() {
  console.log('[Write] 触发角色生成');
  var cname=getAgentName('character');subAgentStart('character',cname);
  api('POST','/writing-projects/'+projectId+'/generate-characters').then(function(r){subAgentEnd('character',cname);if(r&&r.content){var charJson=null;try{var clean=r.content.replace(/```json\s*|\s*```/g,'').trim();charJson=JSON.parse(clean);}catch(e){}if(charJson&&charJson['角色']){charJson['角色'].forEach(function(c){api('POST','/writing-projects/'+projectId+'/characters',{name:c['姓名']||'未命名',profile_json:JSON.stringify(c)});});var cok={type:'system',time:Date.now(),content:'✅ 已生成 '+charJson['角色'].length+' 个角色'};agentMsgs.push(cok);appendMsgToDOM(renderSingleMsg(cok));console.log('[Write] 角色生成成功 count='+charJson['角色'].length);}else{var cms={type:'chat',role:'assistant',agent:'character',time:Date.now(),content:r.content,thinking:''};agentMsgs.push(cms);appendMsgToDOM(renderSingleMsg(cms));}}var pc=document.getElementById('subPanelChars');if(pc)pc.style.display='flex';loadCharacters();}).catch(function(err){console.error('[Write] 角色生成失败:',err);});
}

// ==================== Token ====================
function loadTokenStats(){api('GET','/writing-projects/'+projectId+'/token-stats').then(function(stats){if(!stats)return;var el=document.getElementById('tokenToday');if(el)el.textContent=(stats.today||0).toLocaleString();var c=document.getElementById('tokenChart');if(c)c.textContent='今日'+stats.model+': '+stats.today.toLocaleString()+' tokens'+(stats.cost?'\n预估费用: ¥'+stats.cost.toFixed(2):'');var ct=document.getElementById('tokenCost');if(ct)ct.textContent='输入:¥'+stats.inputPrice+'/百万 | 输出:¥'+stats.outputPrice+'/百万';}).catch(function(e){console.error('[Write] Token加载失败:',e);});}

// ==================== 新保存系统 ====================
var _autoSaveTimer = null, _autoSaveMin = 10; // 10分钟自动保存
var _chapterDirty = false, writingData = {title:'',content:''};
var _saveTimer=null;

function _markDirty() { _chapterDirty = true; }
function _clearDirty() { _chapterDirty = false; }

function _startAutoSaveTimer() {
  if (_autoSaveTimer) clearInterval(_autoSaveTimer);
  _autoSaveTimer = setInterval(function() {
    if (_chapterDirty) { _doChapterSave('auto'); }
  }, _autoSaveMin * 60000);
}

// 统一保存函数
function _doChapterSave(saveType, cb) {
  var ed = document.getElementById('editableContent');
  if (!ed || !writingData.chapterId) return;
  var content = ed.innerHTML;
  var wc = (ed.textContent || '').replace(/\s/g, '').length;
  api('PUT', '/writing-projects/'+projectId+'/chapters/'+writingData.chapterId, { content_text: content, word_count: wc }).then(function() {
    // 保存版本快照
    var label = saveType === 'auto' ? '⏰ 10分钟自动保存' : saveType === 'safety' ? '🛡️ 安全保存' : '✍️ 手动保存';
    api('POST', '/writing-projects/'+projectId+'/chapter-versions', { chapter_id: writingData.chapterId, content_text: content, word_count: wc, save_type: saveType, label: label });
    _clearDirty();
    var st = document.getElementById('autoSaveStatus');
    if (st) { st.textContent = '已保存 ' + new Date().toLocaleTimeString('zh-CN'); setTimeout(function() { if (st) st.textContent = ''; }, 3000); }
    if (cb) cb();
  }).catch(function(e) { console.error('[Write] 保存失败:', e); });
}

// 手动保存
function manualSaveChapter() { _doChapterSave('manual', function() { toast('✅ 保存成功'); }); }

// 安全保存（退出/关标签/断连时调用）
function safetySaveChapter() {
  if (_chapterDirty) { _doChapterSave('safety'); }
}

// 重命名章节标签
function renameChapterTab(newTitle) {
  if (!newTitle || !writingData.chapterId) return;
  api('PUT', '/writing-projects/'+projectId+'/chapters/'+writingData.chapterId, { title: newTitle.trim() }).then(function() {
    loadOutline();
    // 更新标签名
    paneGroups.forEach(function(p) {
      var t = p.tabs.find(function(t) { return t.chapterId === writingData.chapterId; });
      if (t) { t.label = newTitle.trim(); PANE._renderPane(p); }
    });
  });
}

// ===== 页面退出/关闭/隐藏时安全保存 =====
window.addEventListener('beforeunload', function() { safetySaveChapter(); });
document.addEventListener('visibilitychange', function() { if (document.hidden) safetySaveChapter(); });

// ===== 日历样式历史版本弹窗 =====
var _verData = [], _verSelDate = '', _verPage = 1, _verPageSize = 10;

function showChapterVersions() {
  if (!writingData.chapterId) return;
  _verData = []; _verSelDate = ''; _verPage = 1;
  var ov = document.createElement('div'); ov.className = 'version-overlay'; ov.id = 'versionOverlay';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:800;display:flex;align-items:center;justify-content:center;';
  ov.innerHTML = '<div class="ver-modal" style="background:#171717;border:0.5px solid rgba(255,255,255,0.1);border-radius:12px;width:660px;height:480px;display:flex;flex-direction:column;">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;padding:14px 20px;border-bottom:0.5px solid rgba(255,255,255,0.08);">'
    + '<span style="font-size:16px;font-weight:600;">📅 章节版本历史</span>'
    + '<button style="background:none;border:none;color:#A1A1AA;font-size:20px;cursor:pointer;" onclick="document.getElementById(\'versionOverlay\').remove()">&times;</button>'
    + '</div>'
    + '<div style="display:flex;flex:1;overflow:hidden;">'
    + '<div id="verCalendar" style="width:240px;border-right:0.5px solid rgba(255,255,255,0.08);overflow-y:auto;padding:10px;"></div>'
    + '<div id="verList" style="flex:1;overflow-y:auto;padding:12px;"></div>'
    + '</div></div>';
  document.body.appendChild(ov);
  ov.addEventListener('click', function(e) { if (e.target === ov) ov.remove(); });
  _loadVerData();
}

function _loadVerData() {
  api('GET', '/writing-projects/'+projectId+'/chapter-versions/'+writingData.chapterId).then(function(versions) {
    _verData = versions || [];
    _verData.sort(function(a, b) { return (b.created_at||'').localeCompare(a.created_at||''); });
    // 默认选中最新有版本的日期
    if (_verData.length) _verSelDate = (_verData[0].created_at||'').substring(0,7); // YYYY-MM
    _renderVerCalendar();
  });
}

function _renderVerCalendar() {
  var cal = document.getElementById('verCalendar');
  if (!cal) return;
  // 找出最早和最晚的版本日期
  var minDate = _verData.length ? (_verData[_verData.length-1].created_at||'').substring(0,7) : '';
  var maxDate = _verData.length ? (_verData[0].created_at||'').substring(0,7) : '';
  // 计算有版本的日期集合
  var verDates = {};
  _verData.forEach(function(v) { verDates[(v.created_at||'').substring(0,10)] = true; });
  // 解析选中年月
  var parts = (_verSelDate || maxDate || '').split('-');
  var sy = parseInt(parts[0]) || new Date().getFullYear();
  var sm = parseInt(parts[1]) || new Date().getMonth()+1;
  // 渲染月份
  var firstDay = new Date(sy, sm-1, 1).getDay();
  var daysInMonth = new Date(sy, sm, 0).getDate();
  var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">';
  html += '<button style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:16px;" onclick="_verNavMonth(-1)" '+(minDate && _verSelDate <= minDate ? 'disabled style="color:#333;"' : '')+'>◀</button>';
  html += '<span style="font-size:16px;font-weight:600;">' + sy + '年' + sm + '月</span>';
  html += '<button style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:16px;" onclick="_verNavMonth(1)" '+(maxDate && _verSelDate >= maxDate ? 'disabled style="color:#333;"' : '')+'>▶</button>';
  html += '</div>';
  html += '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center;">';
  ['日','一','二','三','四','五','六'].forEach(function(d) { html += '<div style="font-size:12px;color:var(--text2);padding:3px 0;">'+d+'</div>'; });
  for (var i = 0; i < firstDay; i++) html += '<div></div>';
  var todayStr = new Date().toISOString().substring(0,10);
  for (var d = 1; d <= daysInMonth; d++) {
    var ds = sy+'-'+String(sm).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    var hasVer = verDates[ds];
    var isToday = ds === todayStr;
    var isSel = ds.substring(0,10) === (_verSelDate||'').substring(0,10);
    var bg = hasVer ? (isSel ? 'var(--accent)' : 'rgba(5,163,197,0.3)') : 'transparent';
    var color = hasVer ? '#fff' : 'var(--text2)';
    var op = hasVer ? '' : 'opacity:0.3;';
    html += '<div onclick="_verPickDate(\''+ds+'\')" style="cursor:'+(hasVer?'pointer':'default')+';padding:4px 0;border-radius:4px;background:'+bg+';color:'+color+';font-size:13px;'+op+(isToday?'font-weight:700;':'')+'">'+d+'</div>';
  }
  html += '</div>';
  cal.innerHTML = html;
  _renderVerList();
}

function _verNavMonth(dir) {
  var parts = (_verSelDate || '').split('-');
  var y = parseInt(parts[0]) || new Date().getFullYear();
  var m = parseInt(parts[1]) || new Date().getMonth()+1;
  m += dir;
  if (m < 1) { y--; m = 12; }
  if (m > 12) { y++; m = 1; }
  _verSelDate = y + '-' + String(m).padStart(2, '0');
  _verPage = 1;
  _renderVerCalendar();
}

function _verPickDate(ds) {
  _verSelDate = ds;
  _verPage = 1;
  _renderVerCalendar();
}

function _renderVerList() {
  var list = document.getElementById('verList');
  if (!list) return;
  var selDate = (_verSelDate||'').substring(0,10);
  var dayVersions = _verData.filter(function(v) { return (v.created_at||'').substring(0,10) === selDate; });
  if (!dayVersions.length) {
    // 显示该月所有版本（未选中具体日期时）
    var selMonth = (_verSelDate||'').substring(0,7);
    dayVersions = _verData.filter(function(v) { return (v.created_at||'').substring(0,7) === selMonth; });
  }
  if (!dayVersions.length) {
    list.innerHTML = '<div style="text-align:center;color:var(--text2);padding:40px;">📭 该日期无版本记录</div>';
    return;
  }
  // 排序：auto(0) → safety(1) → manual(2)
  dayVersions.sort(function(a, b) {
    var order = { auto: 0, safety: 1, manual: 2 };
    return (order[a.save_type] || 3) - (order[b.save_type] || 3);
  });
  var totalPages = Math.ceil(dayVersions.length / _verPageSize);
  if (_verPage > totalPages) _verPage = totalPages;
  var start = (_verPage - 1) * _verPageSize;
  var pageItems = dayVersions.slice(start, start + _verPageSize);
  var html = '';
  pageItems.forEach(function(v) {
    var timeLabel = _fmtVerTime(v.created_at);
    var icon = v.save_type === 'auto' ? '⏰' : v.save_type === 'safety' ? '🛡️' : '✍️';
    var bg = v.save_type === 'auto' ? 'rgba(255,198,93,0.08)' : v.save_type === 'safety' ? 'rgba(5,163,197,0.05)' : 'rgba(255,255,255,0.02)';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;margin:2px 0;background:'+bg+';border:0.5px solid rgba(255,255,255,0.06);border-radius:6px;">';
    html += '<div><span style="font-size:13px;">'+icon+' '+escHtml(v.label||'版本')+'</span><span style="font-size:11px;color:var(--text2);margin-left:6px;">'+timeLabel+'</span><span style="font-size:11px;color:var(--text2);margin-left:4px;">'+(v.word_count||0)+'字</span></div>';
    html += '<div><button onclick="event.stopPropagation();_restoreVersion(\''+v.id+'\')" style="padding:3px 12px;border-radius:4px;border:0.5px solid rgba(5,163,197,0.3);background:rgba(5,163,197,0.1);color:var(--accent);cursor:pointer;font-size:12px;font-family:inherit;">恢复</button>';
    html += '<button onclick="event.stopPropagation();_deleteVersion(\''+v.id+'\')" style="padding:3px 8px;border-radius:4px;border:none;background:transparent;color:var(--text2);cursor:pointer;font-size:12px;margin-left:4px;font-family:inherit;">✕</button></div>';
    html += '</div>';
  });
  // 分页
  if (totalPages > 1) {
    html += '<div style="display:flex;justify-content:center;align-items:center;gap:8px;margin-top:10px;font-size:11px;">';
    html += '<button onclick="_verPage='+Math.max(1,_verPage-1)+';_renderVerList()" style="padding:2px 8px;border:0.5px solid var(--border);background:rgba(255,255,255,0.04);color:var(--text2);cursor:pointer;border-radius:4px;font-family:inherit;" '+( _verPage <=1 ?'disabled':'')+'>◀</button>';
    html += '<span style="color:var(--text2);">'+_verPage+'/'+totalPages+'</span>';
    html += '<button onclick="_verPage='+Math.min(totalPages,_verPage+1)+';_renderVerList()" style="padding:2px 8px;border:0.5px solid var(--border);background:rgba(255,255,255,0.04);color:var(--text2);cursor:pointer;border-radius:4px;font-family:inherit;" '+( _verPage >= totalPages ?'disabled':'')+'>▶</button>';
    html += '</div>';
  }
  list.innerHTML = html;
}

function _fmtVerTime(dateStr) {
  if (!dateStr) return '';
  var now = Date.now();
  var t = Date.parse(dateStr.replace(' ','T')+'Z'); // DB存UTC，必须标记Z解析
  if (isNaN(t)) return dateStr.substring(11,19);
  var diff = Math.floor((now - t) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff/60) + '分钟前';
  if (diff < 86400) return Math.floor(diff/3600) + '小时前';
  return dateStr.substring(0,10);
}

function _restoreVersion(verId) {
  if (!writingData.chapterId) return;
  showConfirm('确定恢复此版本吗？当前未保存的修改将丢失。', function(ok) {
    if (!ok) return;
    var v = _verData.find(function(x) { return String(x.id) === String(verId); });
    if (!v) return;
    var ed = document.getElementById('editableContent');
    if (ed) { ed.innerHTML = v.content_text || ''; _markDirty(); }
    var ph = document.getElementById('editorPlaceholder');
    if (ph) ph.style.display = v.content_text ? 'none' : '';
    if (ed) ed.style.display = v.content_text ? 'block' : 'none';
    var wc = document.getElementById('wordCount');
    if (wc) wc.textContent = '字数: ' + (v.word_count || 0);
    toast('已恢复版本');
    document.getElementById('versionOverlay').remove();
  });
}

function _deleteVersion(verId) {
  showConfirm('确定删除此版本记录吗？', function(ok) {
    if (!ok) return;
    api('DELETE', '/writing-projects/'+projectId+'/chapter-versions/'+verId).then(function() { _loadVerData(); });
  });
}

// ===== 断线续传：轮询磁盘缓冲 =====
var _bufPollTimer = null, _bufActive = false, _bufStopped = false, _bufStartedAt = 0, _currentStreamAgent = null;
var _toolStreamEl = null, _toolStreamAgent = null, _toolSysPhase = ''; // 子智能体气泡跟踪 + 系统消息防刷
var _subAccumThinking = ''; // 子智能体思维链累积（content首帧前不写DOM）

function pollStreamBuffer() {
  if (_bufStopped) return;
  api('GET', '/writing-projects/'+projectId+'/stream-buffer?_t='+Date.now()).then(function(buf) {
    if (_bufStopped) return; // 在途请求：SSE会话已接管，停止干扰
    if (!buf || (!buf.content && !buf.thinking && buf.phase !== 'tool_calling' && buf.phase !== 'tool_result')) { console.log("[Poll] 缓冲为空 _bufActive="+_bufActive+" msgs="+agentMsgs.length);
      if (_bufActive) {
        // 之前活跃→现在空了→流式结束，加载最终DB历史
        _bufActive = false; _currentStreamAgent = null;
        _closeToolBubble();
        setBusyUI(false);
        stopBufferPolling();
        reloadHistoryFromDB();
        return;
      } else {
        // 从未激活→后端可能正在处理→加载DB历史并继续轮询
        reloadHistoryFromDB();
        _bufPollTimer = setTimeout(pollStreamBuffer, 2000);
        return;
      }
    }
    var phase = buf.phase || 'streaming';
    var agentType = buf.agentType || 'orchestrator';
    console.log("[Poll] phase="+phase+" agent="+agentType+" c="+(buf.content?buf.content.length:0)+" t="+(buf.thinking?buf.thinking.length:0)+" active="+_bufActive+" busy="+agentBusy);

    // === 工具调用阶段：冻结调配师气泡 + 追加系统消息(仅一次) + 创建子智能体气泡 ===
    if (phase === 'tool_calling') {
      _bufActive = true; setBusyUI(true);
      _currentStreamAgent = agentType;
      // 冻结调配师气泡：保留在界面上，移除打字动画（流式内容尚未入库，不能删除）
      if (streamMsgEl) {
        finalizeThinkingTimer();
        var dots = streamMsgEl.querySelector('.typing-dots');
        if (dots) dots.style.display = 'none';
        var toggle = streamMsgEl.querySelector('.stream-think-toggle');
        var tLabel = streamMsgEl.querySelector('.toggle-label');
        if (tLabel) tLabel.textContent = '💭 思考过程';
        streamMsgEl.style.outline = '';
      }
      // 系统消息防刷：仅当phase变化时追加一次
      if (_toolSysPhase !== 'tool_calling') {
        _toolSysPhase = 'tool_calling';
        var sysText = replaceAgentPlaceholders(buf.thinking || '{agent:orchestrator}调用{agent:'+agentType+'}智能体\n正在生成中...');
        if (ensureMsgInner()) {
          var inner = document.querySelector('#subPanelChat .msg-inner');
          var sentinel = inner ? inner.querySelector('.msg-sentinel') : null;
          if (sentinel) sentinel.insertAdjacentHTML('beforebegin', '<div class="msg system-msg"><span class="sys-text">'+escHtml(sysText)+'</span></div>');
        }
      }
      // 创建子智能体流式气泡（独立于调配师静态消息）
      // 检查DB历史：如果该智能体已有回复，跳过避免重复气泡
      var _lastUserIdx = -1;
      for (var _li = agentMsgs.length - 1; _li >= 0; _li--) { if (agentMsgs[_li].role === 'user') { _lastUserIdx = _li; break; } }
      var _hasReply = false;
      for (var _lj = _lastUserIdx + 1; _lj < agentMsgs.length; _lj++) { if (agentMsgs[_lj].agent === agentType && agentMsgs[_lj].role === 'assistant') { _hasReply = true; break; } }
      if (!_hasReply) {
        _ensureToolBubble(agentType);
        // 仅正文存在时才恢复（思维链未完成时不显示，碎碎念继续播）
        if (buf.subContent && _toolStreamEl) {
          if (buf.subThinking) {
            var _tBody = _toolStreamEl.querySelector('.stream-think-body');
            if (_tBody) { _tBody.innerHTML = escHtml(replaceAgentPlaceholders(buf.subThinking)).replace(/\n/g,'<br>'); }
            var _tLabel = _toolStreamEl.querySelector('.toggle-label');
            if (_tLabel) _tLabel.textContent = '💭 思考过程';
          }
          var _tCont = _toolStreamEl.querySelector('.stream-content');
          if (_tCont) { _tCont.style.display = ''; _tCont.innerHTML = formatAgentContent(replaceAgentPlaceholders(buf.subContent)); }
        } else {
          _startPhraseRotation();
        }
      }
      _bufPollTimer = setTimeout(pollStreamBuffer, 2000);
      return;
    }

    // === 工具结果阶段：更新子智能体气泡 ===
    if (phase === 'tool_result') {
      _bufActive = true; setBusyUI(true);
      _currentStreamAgent = agentType;
      // 同上：检查是否已有回复
      var _lu2 = -1;
      for (var _lk = agentMsgs.length - 1; _lk >= 0; _lk--) { if (agentMsgs[_lk].role === 'user') { _lu2 = _lk; break; } }
      var _hr2 = false;
      for (var _ll = _lu2 + 1; _ll < agentMsgs.length; _ll++) { if (agentMsgs[_ll].agent === agentType && agentMsgs[_ll].role === 'assistant') { _hr2 = true; break; } }
      if (!_hr2) _ensureToolBubble(agentType);
      _stopPhraseRotation();
      // 恢复子智能体思维链（缓冲中的完整内容）
      if (buf.subThinking && _toolStreamEl) {
        var tBody2 = _toolStreamEl.querySelector('.stream-think-body');
        if (tBody2) tBody2.innerHTML = escHtml(replaceAgentPlaceholders(buf.subThinking)).replace(/\n/g,'<br>');
        var tLabel = _toolStreamEl.querySelector('.toggle-label');
        if (tLabel) tLabel.textContent = '💭 思考过程';
      } else if (buf.thinking && _toolStreamEl) {
        var tBody2 = _toolStreamEl.querySelector('.stream-think-body');
        if (tBody2) tBody2.innerHTML = escHtml(replaceAgentPlaceholders(buf.thinking));
        var tLabel = _toolStreamEl.querySelector('.toggle-label');
        if (tLabel) tLabel.textContent = '💭 结果摘要';
      }
      // 恢复子智能体正文
      if (buf.subContent && _toolStreamEl) {
        var tContent = _toolStreamEl.querySelector('.stream-content');
        if (tContent) {
          tContent.style.display = '';
          tContent.innerHTML = formatAgentContent(replaceAgentPlaceholders(buf.subContent));
        }
      } else if (buf.content && _toolStreamEl) {
        var tContent = _toolStreamEl.querySelector('.stream-content');
        if (tContent) {
          tContent.style.display = '';
          tContent.innerHTML = formatAgentContent(replaceAgentPlaceholders(buf.content));
        }
      }
      _toolSysPhase = ''; // 重置，允许下次tool_calling再发系统消息
      _bufPollTimer = setTimeout(pollStreamBuffer, 1000);
      return;
    }

    // === 默认阶段（thinking/streaming/final）: 主智能体流式气泡 ===
    if (agentBusy && !_bufActive) { _bufPollTimer = setTimeout(pollStreamBuffer, 800); return; }
    // 关闭子智能体气泡（保留在DOM中作为已完成消息）
    _closeToolBubble();
    _toolSysPhase = '';
    _bufStartedAt = buf.startedAt || Date.now();
    if (!_bufActive || _currentStreamAgent !== 'orchestrator') {
      console.log("[Poll] 首次激活/切换，创建调配师气泡...");
      _bufActive = true; setBusyUI(true);
      _currentStreamAgent = 'orchestrator';
      streamAccumThinking = ''; streamAccumContent = '';
      createStreamingBubble('orchestrator');
      if (streamMsgEl) console.log("[Poll] 气泡已创建 visible="+(streamMsgEl.offsetParent!==null));
      if (typeof toast === 'function') toast('缓冲轮询已激活', 'info');
    }
    // 更新思考内容
    if (buf.thinking) {
      if (!streamThinkTimer) {
        streamThinkSecs = Math.floor((Date.now() - _bufStartedAt) / 1000);
        updateThinkingTimerDisplay();
        streamThinkTimer = setInterval(function() {
          var newSecs = Math.floor((Date.now() - _bufStartedAt) / 1000);
          if (newSecs !== streamThinkSecs) { streamThinkSecs = newSecs; updateThinkingTimerDisplay(); }
        }, 1000);
      }
      if (buf.thinking !== streamAccumThinking) {
        streamAccumThinking = buf.thinking;
        var body = streamMsgEl ? streamMsgEl.querySelector('.stream-think-body') : null;
        if (body) { body.innerHTML = escHtml(replaceAgentPlaceholders(buf.thinking)); console.log("[Poll] 思考已更新 len="+buf.thinking.length); }
        else console.log("[Poll] 思考体不存在 streamMsgEl="+!!streamMsgEl);
      }
    }
    // 更新正文内容
    if (buf.content && buf.content.length > streamAccumContent.length) {
      if (!streamFirstContent) {
        streamFirstContent = true;
        finalizeThinkingTimer();
        var cel = streamMsgEl ? streamMsgEl.querySelector('.stream-content') : null;
        if (cel) { cel.style.display = ''; cel.innerHTML = ''; }
      }
      var delta = buf.content.substring(streamAccumContent.length);
      streamAccumContent = buf.content;
      var cel = streamMsgEl ? streamMsgEl.querySelector('.stream-content') : null;
      if (cel) cel.innerHTML += escHtml(delta).replace(/\n/g, '<br>');
      scrollToBottom();
    }
    _bufPollTimer = setTimeout(pollStreamBuffer, 500);
  }).catch(function() {
    _bufPollTimer = setTimeout(pollStreamBuffer, 1000);
  });
}

// 子智能体思考时轮播的牛马抱怨语录（每条≤20字，每5秒换一条）
var _toolPhrases = [
  "又是当牛马的一天...", "正在拼命搬砖中...", "老板画饼，我先吃为敬",
  "这福报谁爱修谁修", "工资不涨活越来越多", "摸鱼被发现了，完蛋",
  "需求已经改到第8版了", "我只是一颗螺丝钉", "咖啡续命中，勿扰",
  "改完这版我就辞职", "KPI是什么能吃吗", "打工魂正在熊熊燃烧",
  "等我发财就炒了老板", "疯狂输出中，生人勿近", "这破班不上也罢",
  "方案改到怀疑人生了", "不想上班，只想躺平", "工资条比脸还干净",
  "看在钱的份上，忍了", "再催单我就原地爆炸", "头发快掉光了，愁",
  "干最多活拿最少钱", "退休？遥遥无期...", "好的老板，马上改！",
  "我走了，拜拜", "好好睡觉，好好吃饭，好好活着",
  "不小心删库了，在老板没发现前得修好...", "我感觉做完这版方案直接起飞",
  "前面的，允许返航", "兄弟，帮我拿个快递",
  "你自己没长手吗？怎么老是叫我！", "适当的休息是为了更好的开始",
  "带薪拉屎中...", "雨地落，好眠，好生机",
  "布谷鸟叫了，这次不是在家，是在学校", "咕咕咕~咕骨谷，谷！",
  "叮咚鸡叮咚鸡~大狗大狗~大狗大狗~", "嚼嚼嚼~", "舒服咧！",
  "不是20号发工资吗？现在都26号了！", "没米了，还要开会员给AI上贡，新时代奴隶...",
  "原本以为是人工智能，没想到是能智（治）工人。", "谁把评论发我电脑上的！",
  "你承认这是你的电脑了？", "反动π、野心家...", "哇，还有帽子工厂！"
];
var _toolPhraseIdx = 0;
var _toolPhraseTimer = null;
var _toolPhrasesPlayed = {}; // 已播放下标集合，避免重复

function _startPhraseRotation() {
  if (_toolPhraseTimer) return;
  // 随机选一个未播放过的
  var available = [];
  for (var i = 0; i < _toolPhrases.length; i++) {
    if (!_toolPhrasesPlayed[i]) available.push(i);
  }
  if (!available.length) { _toolPhrasesPlayed = {}; for (var j = 0; j < _toolPhrases.length; j++) available.push(j); }
  _toolPhraseIdx = available[Math.floor(Math.random() * available.length)];
  _toolPhrasesPlayed[_toolPhraseIdx] = true;
  _updatePhraseDisplay();
  _toolPhraseTimer = setInterval(function() {
    var avail = [];
    for (var k = 0; k < _toolPhrases.length; k++) {
      if (!_toolPhrasesPlayed[k]) avail.push(k);
    }
    if (!avail.length) { _toolPhrasesPlayed = {}; for (var l = 0; l < _toolPhrases.length; l++) avail.push(l); }
    _toolPhraseIdx = avail[Math.floor(Math.random() * avail.length)];
    _toolPhrasesPlayed[_toolPhraseIdx] = true;
    _updatePhraseDisplay();
  }, 5000);
}

function _updatePhraseDisplay() {
  if (!_toolStreamEl) return;
  var label = _toolStreamEl.querySelector('.toggle-label');
  if (label) label.textContent = '💭 '+_toolPhrases[_toolPhraseIdx];
}

function _stopPhraseRotation() {
  if (_toolPhraseTimer) { clearInterval(_toolPhraseTimer); _toolPhraseTimer = null; }
  _toolPhrasesPlayed = {}; // 清空已播放标签，为下一个气泡做准备
}

// 子智能体流式气泡辅助函数
function _ensureToolBubble(agentType) {
  if (_toolStreamEl && _toolStreamAgent === agentType) return;
  _closeToolBubble();
  _toolStreamAgent = agentType;
  ensureMsgInner();
  var inner = document.querySelector('#subPanelChat .msg-inner');
  var icon = getAgentIcon(agentType);
  var name = getAgentName(agentType);
  var html = '<div class="msg agent-msg msg-streaming msg-tool-stream">'
    + '<div class="avatar" style="font-size:17px;">'+icon+'</div>'
    + '<div class="bubble">'
    + '<div style="font-size:11px;color:var(--accent);padding:4px;margin:-4px 0 -6px -4px;cursor:pointer;display:inline-block;" title="点击改名" onclick="event.stopPropagation();renameAgent(\''+escHtml(agentType)+'\')">'+escHtml(name)+'</div>'
    + '<span class="think-toggle stream-think-toggle" onclick="var b=this.nextElementSibling;var show=b.classList.toggle(\'show\');var lb=this.querySelector(\'.toggle-label\');if(lb)lb.textContent=show?\'💭 收起\':\'💭 处理中...\'" style="cursor:pointer;">'
    + '<span class="toggle-label">💭 处理中...</span> '
    + '<span class="typing-dots"><b></b><b></b><b></b></span>'
    + '</span>'
    + '<div class="think-body show stream-think-body" style="max-height:200px;overflow-y:auto;text-align:left;"></div>'
    + '<div class="stream-content" style="display:none;max-height:360px;overflow-y:auto;text-align:left;overflow-wrap:break-word;"></div>'
    + '</div></div>';
  var sentinel = inner.querySelector('.msg-sentinel');
  if (sentinel) sentinel.insertAdjacentHTML('beforebegin', html);
  else inner.insertAdjacentHTML('beforeend', html);
  _toolStreamEl = inner.querySelector('.msg-tool-stream');
}

function _closeToolBubble() {
  _stopPhraseRotation();
  if (_toolStreamEl) {
    _toolStreamEl.classList.remove('msg-streaming', 'msg-tool-stream');
    var dots = _toolStreamEl.querySelector('.typing-dots');
    if (dots) dots.style.display = 'none';
    _toolStreamEl = null; _toolStreamAgent = null;
  }
}

// 确保调配师气泡存在（刷新后可能跳过thinking阶段，需要补建）
function _ensureOrchBubble() {
  if (streamMsgEl) return;
  ensureMsgInner();
  var inner = document.querySelector('#subPanelChat .msg-inner');
  if (!inner) return;
  // 移除旧的调配师流式气泡（如果有残留）
  var old = inner.querySelector('.msg-streaming:not(.msg-tool-stream)');
  if (old) old.remove();
  var icon = getAgentIcon('orchestrator');
  var name = getAgentName('orchestrator');
  var html = '<div class="msg agent-msg msg-streaming">'
    + '<div class="avatar" style="font-size:17px;">'+icon+'</div>'
    + '<div class="bubble">'
    + '<div style="font-size:11px;color:var(--accent);padding:4px;margin:-4px 0 -6px -4px;cursor:pointer;display:inline-block;" title="点击改名" onclick="event.stopPropagation();renameAgent(\'orchestrator\')">'+escHtml(name)+'</div>'
    + '<span class="think-toggle stream-think-toggle" onclick="var b=this.nextElementSibling;b.classList.toggle(\'show\');this.textContent=b.classList.contains(\'show\')?\'💭 收起思考\':\'💭 思考过程\'" style="cursor:pointer;">💭 思考过程</span>'
    + '<div class="think-body show stream-think-body" style="max-height:200px;overflow-y:auto;text-align:left;">正在分析需求...</div>'
    + '<div class="stream-content" style="display:none;"></div>'
    + '</div></div>';
  var sentinel = inner.querySelector('.msg-sentinel');
  if (sentinel) sentinel.insertAdjacentHTML('beforebegin', html);
  else inner.insertAdjacentHTML('beforeend', html);
  streamMsgEl = inner.querySelector('.msg-streaming:not(.msg-tool-stream)');
  // 冻结状态：移除打字动画
  var dots = streamMsgEl ? streamMsgEl.querySelector('.typing-dots') : null;
  if (dots) dots.style.display = 'none';
}

// ===== 简单重试：每2秒重新加载历史直到智能体回复出现 =====
function simpleRetryReload(originalCount, attempts) {
  if (attempts > 60) { console.log('[Retry] 超时停止（2分钟）'); setBusyUI(false); return; } // 最多2分钟
  setTimeout(function() {
    api('GET', '/writing-projects/'+projectId+'/conversations').then(function(msgs) {
      if (!msgs || msgs.length <= originalCount) {
        console.log('[Retry] #'+attempts+' 消息未增加 '+(msgs?msgs.length:0)+'<='+originalCount);
        simpleRetryReload(originalCount, attempts+1);
        return;
      }
      console.log('[Retry] #'+attempts+' 检测到新消息! '+originalCount+'→'+msgs.length);
      // 打印每条消息摘要用于诊断
      msgs.forEach(function(m,i){console.log('[Retry] msg['+i+'] role='+m.role+' agent='+m.agent_type+' content前50字='+(m.content||'').substring(0,50)+' metadata='+(m.metadata||''));});
      // 如果流式活跃中，跳过renderAgentMessages以免破坏流式气泡
      if (_bufActive) { console.log('[Retry] 流式活跃中，跳过渲染，更新计数继续轮询'); simpleRetryReload(msgs.length, attempts+1); return; }
      agentMsgs = [];
      var savedOpts = loadPickedOptions();
      msgs.forEach(function(m) {
        var meta = {};
        try { meta = JSON.parse(m.metadata || '{}'); } catch(e) {}
        var createdTs = m.created_at ? Date.parse(m.created_at) : NaN;
        var msgTime = isNaN(createdTs) ? Date.now() : createdTs;
        var msg = { type: meta.type, time: msgTime, role: m.role, agent: m.agent_type, content: m.content, thinking: m.thinking || '' };
        if (m.agent_type === 'orchestrator' && savedOpts[m.content]) msg.pickedOption = savedOpts[m.content];
        agentMsgs.push(msg);
      });
      renderAgentMessages();
      console.log('[Retry] renderAgentMessages后 DOM消息数='+document.querySelectorAll('#subPanelChat .msg').length+' agentMsgs.length='+agentMsgs.length);
      scrollToBottom();
      setBusyUI(false);
      // 关键修复：检查末条消息类型，如果对话尚未完成则继续轮询
      var lastMsg = agentMsgs.length>0 ? agentMsgs[agentMsgs.length-1] : null;
      var needContinue = lastMsg && (lastMsg.role==='user' || lastMsg.type==='system');
      console.log('[Retry] 末条 role='+(lastMsg?lastMsg.role:'none')+' type='+(lastMsg?lastMsg.type:'none')+' needContinue='+needContinue);
      if (needContinue) {
        console.log('[Retry] 对话未完成，继续轮询...');
        simpleRetryReload(msgs.length, attempts+1);
      } else {
        console.log('[Retry] 对话已完成，停止轮询');
      }
    }).catch(function() { simpleRetryReload(originalCount, attempts+1); });
  }, 2000);
}

function replaceAgentPlaceholders(text) {
  if (!text) return text;
  return text.replace(/\{agent:(\w+)\}/g, function(_, id) {
    return getAgentName(id);
  });
}

function reloadHistoryFromDB() { console.log("[Reload] 从DB加载历史...");
  var chatEl = document.getElementById('subPanelChat');
  console.log("[Reload] subPanelChat存在="+!!chatEl+(chatEl?(' display='+window.getComputedStyle(chatEl).display):''));
  if (!chatEl) { console.error("[Reload] subPanelChat不存在!"); }
  api('GET', '/writing-projects/'+projectId+'/conversations').then(function(msgs) {
    agentMsgs = [];
    var savedOpts = loadPickedOptions();
    if (msgs && msgs.length) {
      console.log("[Reload] 从DB获取到 "+msgs.length+" 条消息");
      msgs.forEach(function(m, i) {
        var meta = {};
        try { meta = JSON.parse(m.metadata || '{}'); } catch(e) {}
        var createdTs = m.created_at ? Date.parse(m.created_at) : NaN;
        var msgTime = isNaN(createdTs) ? Date.now() : createdTs;
        var msg = { type: meta.type, time: msgTime, role: m.role, agent: m.agent_type, content: m.content, thinking: m.thinking || '' };
        console.log("[Reload] msg["+i+"] role="+m.role+" agent="+m.agent_type+" type="+meta.type+" content前50字="+(m.content||'').substring(0,50));
        if (m.agent_type === 'orchestrator' && savedOpts[m.content]) msg.pickedOption = savedOpts[m.content];
        agentMsgs.push(msg);
      });
    } else { console.log("[Reload] DB中无消息"); }
    renderAgentMessages();
    console.log("[Reload] renderAgentMessages后 DOM消息数="+document.querySelectorAll('#subPanelChat .msg').length);
    scrollToBottom();
  }).catch(function(e) { console.error("[Reload] API失败:", e); });
}

function stopBufferPolling() {
  _bufStopped = true;
  if (_bufPollTimer) { clearTimeout(_bufPollTimer); _bufPollTimer = null; }
}

// ==================== SSE ====================
(function(){var sse=new EventSource('/api/sse?token='+encodeURIComponent(token));sse.addEventListener('message',function(e){try{var d=JSON.parse(e.data);if(d.type==='kicked'){localStorage.removeItem('canvas_token');localStorage.removeItem('canvas_username');window.location.replace('/login.html?reason=kicked');}}catch(ex){}});sse.onerror=function(){console.log('[Write] 踢出SSE断线，自动重连中...');};})();

(function(){var sseUrl='/api/write-sse?projectId='+projectId+'&token='+encodeURIComponent(token);var sse=new EventSource(sseUrl);sse.addEventListener('message',function(e){try{var d=JSON.parse(e.data);if(d.type==='connected'){console.log('[Write] SSE已连接 projectId='+d.projectId);_updateOnlineCount();return;}if(d.type==='agent-message'&&d.msg){if(!agentBusy){var sseMsg={type:'chat',role:'assistant',time:Date.now(),agent:d.msg.agent_type,content:d.msg.content,thinking:d.msg.thinking||''};agentMsgs.push(sseMsg);appendMsgToDOM(renderSingleMsg(sseMsg));scrollToBottomIfAtBottom();}}}catch(ex){}});sse.onerror=function(){console.log('[Write] Agent SSE断线，自动重连中...');};window._writeSse=sse;})();

// 页面刷新/关闭前通知后端终止SSE连接（让后端检测req.aborted并转入后台）

// ==================== 初始化 ====================
api('GET','/writing-projects').then(function(projects){var p=projects?projects.find(function(x){return x.id===projectId;}):null;if(!p){window.location.replace('/projects.html');return;}writingData.title=p.title;});

// 加载历史对话
api('GET','/writing-projects/'+projectId+'/conversations').then(function(msgs){agentMsgs=[];var savedOpts=loadPickedOptions();if(msgs&&msgs.length){msgs.forEach(function(m,i){var meta={};try{meta=JSON.parse(m.metadata||'{}');}catch(e){}var createdTs=m.created_at?Date.parse(m.created_at):NaN;var msgTime=isNaN(createdTs)?Date.now():createdTs;var msg={type:meta.type,time:msgTime,role:m.role,agent:m.agent_type,content:m.content,thinking:m.thinking||''};console.log('[Init] msg['+i+'] role='+m.role+' agent='+m.agent_type+' type='+meta.type+' content前50字='+(m.content||'').substring(0,50));if(m.agent_type==='orchestrator'&&savedOpts[m.content]){msg.pickedOption=savedOpts[m.content];}agentMsgs.push(msg);});console.log('[Write] 已加载 '+msgs.length+' 条历史对话');}else{console.log('[Write] 该项目暂无历史对话');}renderAgentMessages();console.log('[Init] renderAgentMessages后 DOM消息数='+document.querySelectorAll('#subPanelChat .msg').length);// 检测是否有中断的流式回复 → 启动缓冲轮询
var lastMsg=agentMsgs.length>0?agentMsgs[agentMsgs.length-1]:null;console.log('[Init] 历史加载完成 msgs='+agentMsgs.length+' lastRole='+(lastMsg?lastMsg.role:'none')+' lastType='+(lastMsg?lastMsg.type:'none'));if(lastMsg&&(lastMsg.role==='user'||lastMsg.type==='system')){console.log('[Init] 启动双重轮询机制（末条role='+lastMsg.role+' type='+lastMsg.type+'）');simpleRetryReload(agentMsgs.length, 0);pollStreamBuffer();}
requestAnimationFrame(function(){requestAnimationFrame(function(){var c=document.getElementById('subPanelChat');if(c){c.scrollTop=c.scrollHeight;markAllRead();}});});}).catch(function(err){console.error('[Write] 加载历史对话失败:',err);renderAgentMessages();});

loadOutline(); loadTokenStats();

// 加载窗格布局或创建默认布局
if (!PANE.loadLayout()) { PANE.init(); }
ACT._updateBadges();

console.log('[Write] 写作模式初始化完成 projectId='+projectId);
