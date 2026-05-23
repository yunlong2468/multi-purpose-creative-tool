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
  apiConfig:  { icon:'⚙️', label:'API配置' },
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
    // 初始：一个窗格，打开大纲
    var p = this.create(false);
    this.addTab(p.id, { type:'outline' });
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
    container.innerHTML = '<div class="ot-header">📖 项目大纲</div><div class="ot-body" id="otBody"><div class="ot-placeholder">加载中...</div></div><div style="padding:0 8px 8px;"><button onclick="generateOutline()" id="btnGenOutline" class="ot-btn accent">🎬 生成大纲</button></div>';
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
      + '<div id="subPanelChars" class="ch-msgs" style="display:none;"><button onclick="generateCharacters()" id="btnGenChars" style="padding:6px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:12px;font-family:inherit;width:calc(100% - 16px);margin:8px;">🎭 生成角色</button><div id="charList"></div></div>'
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
      + '<div class="ed-topbar"><span class="ed-title" id="chapTitle">'+escHtml(title)+'</span><span style="font-size:11px;color:var(--text2);" id="wordCount">字数: 0</span><button onclick="saveChapterNow()">💾 保存</button></div>'
      + '<div class="ed-toolbar">'
      + '<select onchange="document.execCommand(\'formatBlock\',false,this.value);this.selectedIndex=0;" style="width:80px;"><option value="">正文</option><option value="h2">标题</option><option value="h3">副标题</option></select><span class="sep"></span>'
      + '<button onclick="document.execCommand(\'bold\')"><b>B</b></button><button onclick="document.execCommand(\'italic\')"><i>I</i></button><button onclick="document.execCommand(\'underline\')"><u>U</u></button><span class="sep"></span>'
      + '<button onclick="document.execCommand(\'justifyLeft\')">左对齐</button><button onclick="document.execCommand(\'justifyCenter\')">居中</button><span class="sep"></span>'
      + '<button onclick="document.execCommand(\'insertUnorderedList\')">• 列表</button><button onclick="document.execCommand(\'insertOrderedList\')">1. 列表</button>'
      + '</div>'
      + '<div class="ed-body"><div class="ed-placeholder" id="editorPlaceholder"><div class="icon">✍️</div><p>开始创作...</p></div><div id="editableContent" class="ed-textarea" contenteditable="true" style="display:none;"></div></div>';
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
    // 绑定编辑事件
    var edDiv = document.getElementById('editableContent');
    if (edDiv && !edDiv._bound) {
      edDiv._bound = true;
      edDiv.addEventListener('input', function() {
        var wc = (edDiv.textContent||'').replace(/\s/g,'').length;
        document.getElementById('wordCount').textContent = '字数: '+wc;
        autoSave();
      });
    }
  },

  skillConfig: function(container) {
    container.innerHTML = '<div class="sk-header">🧠 Skill 配置 <button onclick="SKILL.create()">+ 新建</button></div><div class="sk-body" id="skBody"><div class="sk-empty">加载中...</div></div>';
    SKILL.load();
  },

  apiConfig: function(container) {
    container.innerHTML = '<div class="ac-header">⚙️ Agent API 配置</div><div class="ac-body" id="acBody"><div class="sk-empty">加载中...</div></div>';
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
function renameAgent(id) {
  var cur = getAgentName(id);
  showPrompt('修改「'+id+'」的显示名:', cur, function(nn) {
    if (nn&&nn.trim()) { agentDefaults[id].name=nn.trim(); saveAgentNames(); loadMentionList(); renderAgentMessages(); }
  });
}

var mentionAgents = [];
function loadMentionList() {
  mentionAgents = [];
  Object.keys(agentDefaults).forEach(function(id) {
    var a = agentDefaults[id];
    mentionAgents.push({ id:id, name:a.name, icon:a.icon, desc:a.desc });
  });
}
loadAgentNames(); loadMentionList();

function handleMentionInput() {
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
  if(m.type==='system')return'<div class="msg system-msg"><span class="sys-text">'+escHtml(m.content)+'</span></div>';
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

function renderAgentMessages() {
  var container=document.getElementById('subPanelChat'); if(!container)return;
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
    else if(m.type==='system')html+='<div class="msg system-msg"><span class="sys-text">'+escHtml(m.content)+'</span></div>';
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
  }).catch(function() {
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

function undoLastUserMsg() {
  var menu = document.getElementById('userCtxMenu');
  var msgIdx = parseInt(menu.getAttribute('data-msg-idx'));
  menu.classList.remove('show');
  restoreUserSelect();
  if (isNaN(msgIdx) || msgIdx < 0 || msgIdx >= agentMsgs.length) { console.warn('[Undo] invalid msgIdx:', msgIdx); return; }
  if (agentMsgs[msgIdx].role !== 'user') { console.warn('[Undo] msgIdx not a user message'); return; }
  // 终止进行中的Agent调用，防止撤回后被SSE重新写入
  if (activeAbortController) { activeAbortController.abort(); activeAbortController = null; }
  agentBusy = false; pendingAgent = null;
  setBusyUI(false);
  // 保存撤回的文本用于重新编辑
  var undoneText = agentMsgs[msgIdx].content || '';
  // 找到下一条用户消息的索引（或数组末尾）
  var endIdx = agentMsgs.length;
  for (var i = msgIdx + 1; i < agentMsgs.length; i++) {
    if (agentMsgs[i].role === 'user') { endIdx = i; break; }
  }
  var removed = agentMsgs.splice(msgIdx, endIdx - msgIdx);
  // 清理被删除的智能体消息对应的选项状态，撤回后用户可重新选择
  var removedOptContents = removed.filter(function(m){ return m.role==='assistant' && m.agent==='orchestrator' && m.pickedOption; }).map(function(m){ return m.content; });
  if (removedOptContents.length) clearPickedOptionsForContents(removedOptContents);
  console.log('[Undo] 前端撤回 msgIdx='+msgIdx+' count='+removed.length);
  // 撤回后，将紧邻前方的调配师消息的选项按钮重置为可选
  for (var k = msgIdx - 1; k >= 0; k--) {
    if (agentMsgs[k].role === 'assistant' && agentMsgs[k].agent === 'orchestrator' && agentMsgs[k].pickedOption) {
      clearPickedOptionsForContents([agentMsgs[k].content]);
      delete agentMsgs[k].pickedOption;
      break;
    }
  }
  // 插入撤回提示
  agentMsgs.splice(msgIdx, 0, { type:'undo_notice', content:undoneText, time:Date.now() });
  // 同步后端
  api('POST','/writing-projects/'+projectId+'/undo-last').then(function(r) {
    console.log('[Undo] 后端撤回:', r);
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
  var oldStream = inner.querySelector('.msg-streaming');
  if (oldStream) oldStream.remove();

  var icon = getAgentIcon(agentType);
  var name = getAgentName(agentType);
  var html = '<div class="msg agent-msg msg-streaming">'
    + '<div class="avatar" style="font-size:17px;">'+icon+'</div>'
    + '<div class="bubble">'
    + '<div style="font-size:11px;color:var(--accent);padding:4px;margin:-4px 0 -6px -4px;cursor:pointer;display:inline-block;" title="点击改名" onclick="event.stopPropagation();renameAgent(\''+escHtml(agentType)+'\')">'+escHtml(name)+'</div>'
    + '<span class="think-toggle stream-think-toggle" style="cursor:default;">'
    + '💭 思考中... <span class="stream-timer">等待中...</span> '
    + '<span class="typing-dots"><b></b><b></b><b></b></span>'
    + '</span>'
    + '<div class="think-body show stream-think-body" style="max-height:200px;overflow-y:auto;text-align:left;"></div>'
    + '<div class="stream-content" style="display:none;"></div>'
    + '</div></div>';
  var sentinel = inner.querySelector('.msg-sentinel');
  if (sentinel) sentinel.insertAdjacentHTML('beforebegin', html);
  else inner.insertAdjacentHTML('beforeend', html);
  streamMsgEl = inner.querySelector('.msg-streaming');
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
  if (!streamMsgEl) return;

  var content = data.content || '';
  var thinking = data.thinking || '';

  // 如果只有思考没有正文（异常情况），也要完成计时
  if (thinking && !streamFirstContent) {
    finalizeThinkingTimer();
  }

  // 构建最终消息对象
  var msg = {
    type: 'chat',
    role: 'assistant',
    agent: 'orchestrator',
    content: content,
    thinking: thinking,
    time: Date.now()
  };
  agentMsgs.push(msg);

  // 用正式渲染替换流式bubble
  var finalHtml = renderSingleMsg(msg);
  var streamEl = document.querySelector('.msg-streaming');
  if (streamEl) {
    streamEl.outerHTML = finalHtml;
  }

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
          if (evt.type === 'connected' || evt.type === 'waiting') {
            // 连接成功/心跳：重置超时计时器
            if (streamConnTimeout) { clearTimeout(streamConnTimeout); streamConnTimeout = null; }
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
          } else if (evt.type === 'thinking') {
            if (!hasStartedThinking) { hasStartedThinking = true; startThinkingTimer(); }
            appendThinkingDelta(evt.delta);
          } else if (evt.type === 'content') {
            appendContentDelta(evt.delta);
          } else if (evt.type === 'done') {
            if (streamConnTimeout) { clearTimeout(streamConnTimeout); streamConnTimeout = null; }
            finalizeStreamingMsg(evt);
          } else if (evt.type === 'tool_start') {
            // 调配师调用子智能体 → 显示系统消息
            var toolNames = {generate_outline:'大纲',generate_characters:'角色',generate_dialog:'对话',crawl_books:'爬虫',review_chapter:'审核',optimize_skill:'技能优化'};
            var toolLabel = toolNames[evt.tool] || evt.tool;
            var inviteMsg = {type:'system',content:getAgentName('orchestrator')+' 调用 '+toolLabel+' 智能体',time:Date.now()};
            agentMsgs.push(inviteMsg);
            if (ensureMsgInner()) appendMsgToDOM(renderSingleMsg(inviteMsg));
            pendingAgent = {agent:evt.tool,label:toolLabel+'智能体',icon:getAgentIcon(evt.tool)};
            if (ensureMsgInner()) renderPendingAgent();
          } else if (evt.type === 'tool_end') {
            pendingAgent = null;
            if (ensureMsgInner()) renderPendingAgent();
            // 子智能体回复内容作为独立消息展示
            if (evt.content) {
              var agentType = evt.tool === 'generate_outline' ? 'outliner' : evt.tool === 'generate_characters' ? 'character' : evt.tool;
              var toolMsg = {type:'chat',role:'assistant',agent:agentType,content:evt.content,thinking:'',time:Date.now()};
              agentMsgs.push(toolMsg);
              if (ensureMsgInner()) appendMsgToDOM(renderSingleMsg(toolMsg));
            }
            // 结果摘要
            var leaveMsg = {type:'system',content:evt.summary||'子智能体已完成',time:Date.now()};
            agentMsgs.push(leaveMsg);
            if (ensureMsgInner()) appendMsgToDOM(renderSingleMsg(leaveMsg));
            // 刷大纲/角色面板
            if (evt.tool === 'generate_outline') { setTimeout(function(){loadOutline();}, 500); }
            if (evt.tool === 'generate_characters') { setTimeout(function(){loadCharacters();}, 500); }
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
function addVolume(){api('POST','/writing-projects/'+projectId+'/volumes',{title:'新卷'}).then(function(r){console.log('[Write] 新建卷 id='+(r&&r.id));loadOutline();}).catch(function(e){console.error('[Write] 新建卷失败:',e);});}
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
        showConfirm('确定删除此卷及其所有章节吗？此操作不可撤销。', function(ok) {
          if (ok) { api('DELETE', '/writing-projects/'+projectId+'/volumes/'+volId).then(function() { loadOutline(); }); }
        });
      };
      ov.querySelector('div > div:last-child').appendChild(delBtn);
    }
  }, 100);
}

function showChapCtxMenu(e, chapId) {
  var titleEl = e.target.closest('.ot-chap');
  var chapTitle = titleEl ? titleEl.textContent : '';
  showPrompt('重命名章', chapTitle, function(newName) {
    if (newName && newName.trim()) {
      api('PUT', '/writing-projects/'+projectId+'/chapters/'+chapId, {title: newName.trim()}).then(function() { loadOutline(); });
    }
  });
  setTimeout(function() {
    var ov = document.querySelector('.prompt-overlay');
    if (ov) {
      var delBtn = document.createElement('button');
      delBtn.textContent = '🗑️ 删除此章';
      delBtn.style.cssText = 'display:block;margin:8px auto 0;padding:6px 12px;border-radius:6px;border:0.5px solid rgba(245,63,63,0.3);background:rgba(245,63,63,0.1);color:#F53F3F;cursor:pointer;font-family:inherit;font-size:12px;';
      delBtn.onclick = function() {
        ov.remove();
        showConfirm('确定删除此章吗？', function(ok) {
          if (ok) { api('DELETE', '/writing-projects/'+projectId+'/chapters/'+chapId).then(function() { loadOutline(); }); }
        });
      };
      ov.querySelector('div > div:last-child').appendChild(delBtn);
    }
  }, 100);
}

// ===== 章节立即保存 =====
function saveChapterNow() {
  var ed = document.getElementById('editableContent');
  if (!ed) return;
  writingData.content = ed.innerHTML;
  if (writingData.chapterId) {
    var wc = (ed.textContent || '').replace(/\s/g, '').length;
    api('PUT', '/writing-projects/' + projectId + '/chapters/' + writingData.chapterId, {
      content_text: writingData.content,
      word_count: wc
    }).then(function() {
      console.log('[Write] 章节保存成功 id=' + writingData.chapterId + ' 字数=' + wc);
      var wcEl = document.getElementById('wordCount');
      if (wcEl) wcEl.textContent = '字数: ' + wc;
    }).catch(function(e) {
      console.error('[Write] 章节保存失败:', e);
    });
  }
}

function generateOutline() {
  console.log('[Write] 触发大纲生成');
  var uname=getAgentName('outliner');subAgentStart('outliner',uname);
  api('POST','/writing-projects/'+projectId+'/generate-outline').then(function(r){subAgentEnd('outliner',uname);if(r&&r.content){var outlineJson=null;try{var clean=r.content.replace(/```json\s*|\s*```/g,'').trim();outlineJson=JSON.parse(clean);}catch(e){}if(outlineJson&&outlineJson['卷']){outlineJson['卷'].forEach(function(vol,vi){api('POST','/writing-projects/'+projectId+'/volumes',{title:vol['卷名']||('第'+(vi+1)+'卷')}).then(function(vr){if(vr&&vr.id){(vol['章']||[]).forEach(function(chap){api('POST','/writing-projects/'+projectId+'/chapters',{volume_id:vr.id,title:chap['章名']||''});});}});});var omsg={type:'chat',role:'assistant',agent:'outliner',time:Date.now(),content:r.content.substring(0,500)+(r.content.length>500?'\n...(已截断)':''),thinking:''};agentMsgs.push(omsg);appendMsgToDOM(renderSingleMsg(omsg));var okmsg={type:'system',time:Date.now(),content:'✅ 大纲已生成，'+outlineJson['卷'].length+'卷'};agentMsgs.push(okmsg);appendMsgToDOM(renderSingleMsg(okmsg));setTimeout(function(){loadOutline();},1000);}else{var omsg2={type:'chat',role:'assistant',agent:'outliner',time:Date.now(),content:r.content,thinking:''};agentMsgs.push(omsg2);appendMsgToDOM(renderSingleMsg(omsg2));}}else{var emsg={type:'system',time:Date.now(),content:'⚠️ 大纲生成失败: '+(r&&r.error||'未知错误')};agentMsgs.push(emsg);appendMsgToDOM(renderSingleMsg(emsg));}}).catch(function(err){subAgentEnd('outliner',uname);var emsg2={type:'system',time:Date.now(),content:'⚠️ 大纲生成网络错误'};agentMsgs.push(emsg2);appendMsgToDOM(renderSingleMsg(emsg2));console.error('[Write] 大纲生成异常:',err);});
}

// ==================== 角色管理 ====================
function loadCharacters() {
  console.log('[Write] 加载角色列表');
  api('GET','/writing-projects/'+projectId+'/characters').then(function(chars){var list=document.getElementById('charList');if(!list)return;if(!chars||!chars.length){list.innerHTML='<div style="color:var(--text2);font-size:12px;text-align:center;padding:16px;">暂无角色，点击上方按钮生成</div>';return;}var html='';chars.forEach(function(c){try{var profile=JSON.parse(c.profile_json||'{}');}catch(e){profile={};}html+='<div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:8px;font-size:12px;margin-bottom:4px;"><div style="font-weight:600;margin-bottom:4px;">'+escHtml(c.name)+(c.aliases?' ('+escHtml(c.aliases)+')':'')+'</div>'+(profile['外貌']?'<div style="color:var(--text2);font-size:11px;">'+escHtml(profile['外貌'].substring(0,60))+'...</div>':'')+'</div>';});list.innerHTML=html;}).catch(function(e){console.error('[Write] 角色加载失败:',e);});
}

function generateCharacters() {
  console.log('[Write] 触发角色生成');
  var cname=getAgentName('character');subAgentStart('character',cname);
  api('POST','/writing-projects/'+projectId+'/generate-characters').then(function(r){subAgentEnd('character',cname);if(r&&r.content){var charJson=null;try{var clean=r.content.replace(/```json\s*|\s*```/g,'').trim();charJson=JSON.parse(clean);}catch(e){}if(charJson&&charJson['角色']){charJson['角色'].forEach(function(c){api('POST','/writing-projects/'+projectId+'/characters',{name:c['姓名']||'未命名',profile_json:JSON.stringify(c)});});var cok={type:'system',time:Date.now(),content:'✅ 已生成 '+charJson['角色'].length+' 个角色'};agentMsgs.push(cok);appendMsgToDOM(renderSingleMsg(cok));console.log('[Write] 角色生成成功 count='+charJson['角色'].length);}else{var cms={type:'chat',role:'assistant',agent:'character',time:Date.now(),content:r.content,thinking:''};agentMsgs.push(cms);appendMsgToDOM(renderSingleMsg(cms));}}var pc=document.getElementById('subPanelChars');if(pc)pc.style.display='flex';loadCharacters();}).catch(function(err){console.error('[Write] 角色生成失败:',err);});
}

// ==================== Token ====================
function loadTokenStats(){api('GET','/writing-projects/'+projectId+'/token-stats').then(function(stats){if(!stats)return;var el=document.getElementById('tokenToday');if(el)el.textContent=(stats.today||0).toLocaleString();var c=document.getElementById('tokenChart');if(c)c.textContent='今日'+stats.model+': '+stats.today.toLocaleString()+' tokens'+(stats.cost?'\n预估费用: ¥'+stats.cost.toFixed(2):'');var ct=document.getElementById('tokenCost');if(ct)ct.textContent='输入:¥'+stats.inputPrice+'/百万 | 输出:¥'+stats.outputPrice+'/百万';}).catch(function(e){console.error('[Write] Token加载失败:',e);});}

// ==================== 自动保存 ====================
var saveTimer=null, writingData={title:'',content:''};
function autoSave(){if(saveTimer)clearTimeout(saveTimer);saveTimer=setTimeout(function(){var ed=document.getElementById('editableContent');writingData.content=ed?ed.innerHTML:'';if(writingData.chapterId){var wc=(ed.textContent||'').replace(/\s/g,'').length;api('PUT','/writing-projects/'+projectId+'/chapters/'+writingData.chapterId,{content_text:writingData.content,word_count:wc}).then(function(){console.log('[Write] 章节自动保存 id='+writingData.chapterId+' 字数='+wc);}).catch(function(e){console.error('[Write] 章节保存失败:',e);});}api('PUT','/writing-projects/'+projectId,writingData).then(function(){console.log('[Write] 项目自动保存完成');}).catch(function(e){console.error('[Write] 项目保存失败:',e);});},1000);}

// ===== 断线续传：轮询磁盘缓冲 =====
var _bufPollTimer = null, _bufActive = false, _bufStartedAt = 0;

function pollStreamBuffer() {
  api('GET', '/writing-projects/'+projectId+'/stream-buffer?_t='+Date.now()).then(function(buf) {
    if (!buf || (!buf.content && !buf.thinking)) {
      if (_bufActive) {
        _bufActive = false;
        setBusyUI(false);
        stopBufferPolling();
        reloadHistoryFromDB();
      } else {
        // 缓冲从未激活→后端可能已完成→直接加载历史
        reloadHistoryFromDB();
      }
      return;
    }
    if (agentBusy) { _bufPollTimer = setTimeout(pollStreamBuffer, 800); return; }
    _bufStartedAt = buf.startedAt || Date.now();
    if (!_bufActive) {
      _bufActive = true;
      setBusyUI(true);
      streamAccumThinking = '';
      streamAccumContent = '';
      createStreamingBubble('orchestrator');
    }
    // 更新思考内容 + 基于服务端时间戳的计时器
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
        if (body) body.innerHTML = escHtml(buf.thinking);
      }
    }
    // 更新正文内容（增量追加，避免每轮全量重渲染）
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

function reloadHistoryFromDB() {
  api('GET', '/writing-projects/'+projectId+'/conversations').then(function(msgs) {
    agentMsgs = [];
    var savedOpts = loadPickedOptions();
    if (msgs && msgs.length) {
      msgs.forEach(function(m) {
        var meta = {};
        try { meta = JSON.parse(m.metadata || '{}'); } catch(e) {}
        var msg = { type: meta.type, time: Date.parse(m.created_at || Date.now()) || 'chat', role: m.role, agent: m.agent_type, content: m.content, thinking: m.thinking || '' };
        if (m.agent_type === 'orchestrator' && savedOpts[m.content]) msg.pickedOption = savedOpts[m.content];
        agentMsgs.push(msg);
      });
    }
    renderAgentMessages();
    scrollToBottom();
  }).catch(function() {});
}

function stopBufferPolling() {
  if (_bufPollTimer) { clearTimeout(_bufPollTimer); _bufPollTimer = null; }
}

// ==================== SSE ====================
(function(){var sse=new EventSource('/api/sse?token='+encodeURIComponent(token));sse.addEventListener('message',function(e){try{var d=JSON.parse(e.data);if(d.type==='kicked'){localStorage.removeItem('canvas_token');localStorage.removeItem('canvas_username');window.location.replace('/login.html?reason=kicked');}}catch(ex){}});sse.onerror=function(){console.log('[Write] 踢出SSE断线，自动重连中...');};})();

(function(){var sseUrl='/api/write-sse?projectId='+projectId+'&token='+encodeURIComponent(token);var sse=new EventSource(sseUrl);sse.addEventListener('message',function(e){try{var d=JSON.parse(e.data);if(d.type==='connected'){console.log('[Write] SSE已连接 projectId='+d.projectId);return;}if(d.type==='agent-message'&&d.msg){if(!agentBusy){var sseMsg={type:'chat',role:'assistant',time:Date.now(),agent:d.msg.agent_type,content:d.msg.content,thinking:d.msg.thinking||''};agentMsgs.push(sseMsg);appendMsgToDOM(renderSingleMsg(sseMsg));scrollToBottomIfAtBottom();}}}catch(ex){}});sse.onerror=function(){console.log('[Write] Agent SSE断线，自动重连中...');};window._writeSse=sse;})();

// 页面刷新/关闭前通知后端终止SSE连接（让后端检测req.aborted并转入后台）
window.addEventListener('beforeunload', function() {
  if (activeAbortController) { activeAbortController.abort(); }
});

// ==================== 初始化 ====================
api('GET','/writing-projects').then(function(projects){var p=projects?projects.find(function(x){return x.id===projectId;}):null;if(!p){window.location.replace('/projects.html');return;}writingData.title=p.title;});

// 加载历史对话
api('GET','/writing-projects/'+projectId+'/conversations').then(function(msgs){agentMsgs=[];var savedOpts=loadPickedOptions();if(msgs&&msgs.length){msgs.forEach(function(m){var meta={};try{meta=JSON.parse(m.metadata||'{}');}catch(e){}var msg={type:meta.type,time:Date.parse(m.created_at||Date.now())||'chat',role:m.role,agent:m.agent_type,content:m.content,thinking:m.thinking||''};if(m.agent_type==='orchestrator'&&savedOpts[m.content]){msg.pickedOption=savedOpts[m.content];}agentMsgs.push(msg);});console.log('[Write] 已加载 '+msgs.length+' 条历史对话');}else{console.log('[Write] 该项目暂无历史对话');}renderAgentMessages();// 检测是否有中断的流式回复（最后一条是用户消息）→ 启动缓冲轮询
if(agentMsgs.length>0&&agentMsgs[agentMsgs.length-1].role==='user'){stopBufferPolling();pollStreamBuffer();}
requestAnimationFrame(function(){requestAnimationFrame(function(){var c=document.getElementById('subPanelChat');if(c){c.scrollTop=c.scrollHeight;markAllRead();}});});}).catch(function(err){console.error('[Write] 加载历史对话失败:',err);renderAgentMessages();});

loadOutline(); loadTokenStats();

// 加载窗格布局或创建默认布局
if (!PANE.loadLayout()) { PANE.init(); }
ACT._updateBadges();

console.log('[Write] 写作模式初始化完成 projectId='+projectId);
