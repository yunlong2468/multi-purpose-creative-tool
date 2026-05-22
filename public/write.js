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
    tabEl.classList.add('dragging');
    var ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = tabEl.textContent.replace(/✕/g,'').trim();
    document.body.appendChild(ghost);
    TABDRAG.ghost = ghost;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tabId);
    var img = new Image(); img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    e.dataTransfer.setDragImage(img, 0, 0);
    requestAnimationFrame(function(){ TABDRAG._moveGhost(e.clientX); });
    document.addEventListener('dragover', TABDRAG._onGlobalDrag);
  },

  onEnd: function(e) {
    document.removeEventListener('dragover', TABDRAG._onGlobalDrag);
    cleanupDragIndicators();
    if (TABDRAG.ghost) { TABDRAG.ghost.remove(); TABDRAG.ghost = null; }
    var container = document.getElementById('paneContainer');
    if (container) container.style.boxShadow = '';
    var el = document.querySelector('.pane-tab.dragging');
    if (el) el.classList.remove('dragging');
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
    // 在目标标签栏中找插入位置：鼠标在哪个标签的左半边就在它前面插入
    var tabEls = tabsEl.querySelectorAll('.pane-tab:not(.dragging)');
    var insertIdx = tabEls.length;
    for (var i=0; i<tabEls.length; i++) {
      var rect = tabEls[i].getBoundingClientRect();
      if (e.clientX < rect.left + rect.width/2) { insertIdx = i; break; }
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
      + '<span style="font-size:10px;color:var(--text2);" id="onlineAgents">1人</span>'
      + '</div>'
      + '<div id="subPanelChat" class="ch-msgs"><div class="ap-loading">加载历史对话中...</div></div>'
      + '<div id="subPanelChars" class="ch-msgs" style="display:none;"><button onclick="generateCharacters()" id="btnGenChars" style="padding:6px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:11px;font-family:inherit;width:calc(100% - 16px);margin:8px;">🎭 生成角色</button><div id="charList"></div></div>'
      + '<div class="ch-input" id="chatInputArea">'
      + '<div class="unread-badge" id="unreadBadge" onclick="scrollToUnread()"></div>'
      + '<div class="mention-dropdown" id="mentionDropdown"></div>'
      + '<textarea id="agentInput" rows="1" placeholder="输入消息或 @Agent..." onkeydown="handleInputKey(event)" oninput="handleMentionInput();autoGrowInput()"></textarea>'
      + '<button id="btnSend" onclick="sendAgentMessage()">发送</button>'
      + '<button id="btnStop" onclick="stopAgentCall()" style="display:none;background:rgba(245,63,63,0.15)!important;color:#F53F3F!important;border:0.5px solid rgba(245,63,63,0.3)!important;">⏹ 停止</button>'
      + '</div>'
      + '<div class="tok-bar" id="panelToken" onclick="this.classList.toggle(\'expanded\')">'
      + '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text2);"><span>💰 Token</span><span id="tokenToday">加载中</span></div>'
      + '<div class="tok-detail"><div id="tokenChart" style="font-size:9px;color:var(--text2);"></div><div style="font-size:9px;color:var(--text2);" id="tokenCost"></div></div>'
      + '</div></div>';
    // 渲染现有消息
    if (agentMsgs.length) renderAgentMessages();
    else { var c=document.getElementById('subPanelChat'); if(c)c.innerHTML='<div class="ap-loading">暂无对话记录<br><span style="font-size:10px;color:var(--text2);">在下方输入消息开始创作</span></div>'; }
    loadTokenStats();
  },

  editor: function(container, tab) {
    var title = tab.label || '未命名章节';
    writingData.chapterId = tab.chapterId || null;
    activeChapterId = tab.chapterId || null;
    container.innerHTML = ''
      + '<div class="ed-topbar"><span class="ed-title" id="chapTitle">'+escHtml(title)+'</span><span style="font-size:10px;color:var(--text2);" id="wordCount">字数: 0</span><button onclick="autoSave()">💾 保存</button></div>'
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
    +'<div style="font-size:14px;margin-bottom:12px;color:#fff;">✏️ 编辑技能</div>'
    +'<div style="overflow-y:auto;flex:1;max-height:70vh;">'
    +'<div style="margin-bottom:8px;"><label style="font-size:11px;color:var(--text2);">中文名称</label><input id="skEdNameCn" style="width:100%;padding:6px 8px;background:rgba(255,255,255,0.04);border:0.5px solid var(--border);border-radius:4px;color:#fff;font-size:12px;font-family:inherit;outline:none;" value="'+escHtml(s.name_cn||'')+'"></div>'
    +'<div style="margin-bottom:8px;"><label style="font-size:11px;color:var(--text2);">英文名称</label><input id="skEdNameEn" style="width:100%;padding:6px 8px;background:rgba(255,255,255,0.04);border:0.5px solid var(--border);border-radius:4px;color:#fff;font-size:12px;font-family:inherit;outline:none;" value="'+escHtml(s.name_en||'')+'"></div>'
    +'<div style="margin-bottom:8px;"><label style="font-size:11px;color:var(--text2);">描述</label><input id="skEdDesc" style="width:100%;padding:6px 8px;background:rgba(255,255,255,0.04);border:0.5px solid var(--border);border-radius:4px;color:#fff;font-size:12px;font-family:inherit;outline:none;" value="'+escHtml(s.description||'')+'"></div>'
    +'<div style="margin-bottom:8px;"><label style="font-size:11px;color:var(--text2);">📄 SKILL.md 内容</label><textarea id="skEdContent" style="width:100%;height:200px;padding:8px;background:rgba(255,255,255,0.04);border:0.5px solid var(--border);border-radius:4px;color:#fff;font-size:11px;font-family:Consolas,Monaco,monospace;outline:none;resize:vertical;white-space:pre-wrap;">'+escHtml(s.content||'')+'</textarea></div>'
    +'<div style="margin-bottom:8px;"><label style="font-size:11px;color:var(--text2);">📋 参考 JSON (json_schema)</label><textarea id="skEdSchema" style="width:100%;height:120px;padding:8px;background:rgba(255,255,255,0.04);border:0.5px solid var(--border);border-radius:4px;color:#fff;font-size:11px;font-family:Consolas,Monaco,monospace;outline:none;resize:vertical;white-space:pre-wrap;">'+escHtml(s.json_schema||'')+'</textarea></div>'
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
        body.innerHTML = '<div class="sk-empty">暂无技能<br><span style="font-size:10px;">使用技能优化Agent自动生成，或手动创建</span></div>';
        return;
      }
      var html = '';
      skills.forEach(function(s) {
        var en = s.is_enabled ? ' enabled' : '';
        var ds = escHtml(JSON.stringify({id:s.id,name_cn:s.name_cn,name_en:s.name_en||'',description:s.description||'',content:s.content||'',json_schema:s.json_schema||''}));
        html += '<div class="sk-card" data-skill="'+ds+'">';
        html += '<div class="sk-name">'+escHtml(s.name_cn)+(s.name_en?' <span style="color:var(--text2);font-size:10px;">('+escHtml(s.name_en)+')</span>':'')+'</div>';
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
    if (!confirm('确定删除此技能吗？')) return;
    api('DELETE','/writing-projects/'+projectId+'/skills/'+sid).then(function(r) {
      if (r && r.error) { toast('删除失败: '+r.error, 'error'); return; }
      toast('技能已删除');
      SKILL.load();
    }).catch(function(e) { console.error('[Skill] 删除失败:', e); toast('删除失败', 'error'); });
  }
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
        html += '<div class="ac-agent">'+a.icon+' '+a.name+' <span style="font-size:10px;color:var(--text2);">('+a.type+')</span><span class="ac-saved" id="acSaved_'+a.type+'">✓ 已保存</span></div>';
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
  orchestrator: { name:'策划', icon:'🎭', desc:'调配师·采访需求' },
  outliner:     { name:'大纲', icon:'📋', desc:'生成卷章大纲' },
  character:    { name:'角色', icon:'👥', desc:'设计角色档案' },
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
  t = t.replace(/^###\s+(.+)$/gm, '<h4 style="margin:8px 0 4px;font-size:13px;">$1</h4>');
  t = t.replace(/^##\s+(.+)$/gm, '<h3 style="margin:10px 0 6px;font-size:14px;">$1</h3>');
  t = t.replace(/^[-*]{3,}\s*$/gm, '<hr style="border:0.5px solid var(--border);margin:8px 0;">');
  t = t.replace(/\*\*\s*(.+?)\s*\*\*/g, '<b>$1</b>');
  t = '<p>'+t.split(/\n\n+/).join('</p><p>')+'</p>';
  tables.forEach(function(tbl,i) {
    var rows = tbl.split('\n').filter(function(r){ return r.indexOf('|')>=0&&!r.match(/^\|?[\s]*[-:| ]+\|?[\s]*$/); });
    var html = '<table style="border-collapse:collapse;width:100%;margin:6px 0;font-size:11px;"><tbody>';
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

function parseOptBtns(rawText, agentType) {
  if (agentType !== 'orchestrator') return {html:formatAgentContent(rawText), btns:''};
  // 在原始文本层面按行解析 — 行匹配 "^ - [按钮文字] $"（前后允许空格）
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
    btnHtml += '<button class="opt-btn" data-opt="'+escHtml(t)+'" onclick="event.stopPropagation();clickOption(this)">'+escHtml(t)+'</button>';
  });
  btnHtml += '</div>';
  return {html:html, btns:btnHtml};
}

function clickOption(btn) {
  var text = btn.getAttribute('data-opt'); if (!text) return;
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
  if(m.type==='system')return'<div class="msg system-msg"><span class="sys-text">'+escHtml(m.content)+'</span></div>';
  if(m.role==='user'){
    var idx = agentMsgs.indexOf(m);
    var ctx = (idx === lastUserMsgIdx()) ? ' oncontextmenu="event.preventDefault();showUserCtxMenu(event,'+idx+')"' : '';
    return'<div class="msg user-msg"'+ctx+'><div class="avatar" style="background:rgba(5,163,197,0.12);">👤</div><div class="bubble">'+escHtml(m.content)+t+'</div></div>';
  }
  var avatar=getAgentIcon(m.agent);
  var parsed = parseOptBtns(m.content, m.agent);
  var contentHtml = parsed.html + parsed.btns;
  var h='<div class="msg agent-msg"><div class="avatar" style="font-size:16px;">'+avatar+'</div><div class="bubble">';
  h+='<div style="font-size:10px;color:var(--accent);margin-bottom:2px;cursor:pointer;" title="点击改名" onclick="event.stopPropagation();renameAgent(\''+escHtml(m.agent||'agent')+'\')">'+escHtml(getAgentName(m.agent))+'</div>';
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
  var html='<div class="msg agent-msg msg-thinking"><div class="avatar" style="font-size:16px;background:rgba(5,163,197,0.15);">'+pa.icon+'</div><div class="bubble"><div style="font-size:10px;color:var(--accent);margin-bottom:2px;">'+escHtml(pa.label||pa.agent)+'</div><span class="typing-dots"><b></b><b></b><b></b></span></div></div>';
  var sentinel=inner.querySelector('.msg-sentinel');
  if(sentinel)sentinel.insertAdjacentHTML('beforebegin',html);
  else inner.insertAdjacentHTML('beforeend',html);
}

function renderAgentMessages() {
  var container=document.getElementById('subPanelChat'); if(!container)return;
  var wasAtBottom=container.scrollHeight-container.scrollTop-container.clientHeight<60;
  if(!agentMsgs.length){container.innerHTML='<div class="ap-loading">暂无对话记录<br><span style="font-size:10px;color:var(--text2);">在下方输入消息开始创作</span></div>';unreadCount=0;updateUnreadBadge();return;}
  var lastUserIdx = lastUserMsgIdx();
  var html='';
  agentMsgs.forEach(function(m, i) {
    var t = m.time ? '<div class="msg-time">'+fmtTime(m.time)+'</div>' : '';
    if(m.type==='system')html+='<div class="msg system-msg"><span class="sys-text">'+escHtml(m.content)+'</span></div>';
    else if(m.role==='user'){
      var ctx = (i === lastUserIdx) ? ' data-msg-idx="'+i+'" oncontextmenu="event.preventDefault();showUserCtxMenu(event,'+i+')"' : '';
      html+='<div class="msg user-msg"'+ctx+'><div class="avatar" style="background:rgba(5,163,197,0.12);">👤</div><div class="bubble">'+escHtml(m.content)+t+'</div></div>';
    }
    else {
      var avatar=getAgentIcon(m.agent);
      var parsed = parseOptBtns(m.content, m.agent);
  var contentHtml = parsed.html + parsed.btns;
      html+='<div class="msg agent-msg"><div class="avatar" style="font-size:16px;">'+avatar+'</div><div class="bubble">';
      html+='<div style="font-size:10px;color:var(--accent);margin-bottom:2px;cursor:pointer;" title="点击改名" onclick="event.stopPropagation();renameAgent(\''+escHtml(m.agent||'agent')+'\')">'+escHtml(getAgentName(m.agent))+'</div>';
      if(m.thinking){html+='<span class="think-toggle" onclick="var b=this.nextElementSibling;b.classList.toggle(\'show\');this.textContent=b.classList.contains(\'show\')?\'💭 收起思考\':\'💭 思考过程\'">💭 思考过程</span>';html+='<div class="think-body">'+formatAgentContent(m.thinking)+'</div>';}
      html+=contentHtml+t+'</div></div>';
    }
  });
  if(pendingAgent){var pa=pendingAgent;html+='<div class="msg agent-msg"><div class="avatar" style="font-size:16px;background:rgba(5,163,197,0.15);">'+pa.icon+'</div><div class="bubble"><div style="font-size:10px;color:var(--accent);margin-bottom:2px;">'+escHtml(pa.label||pa.agent)+'</div><span class="typing-dots"><b></b><b></b><b></b></span></div></div>';}
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

function showUserCtxMenu(e, msgIdx) {
  e.preventDefault();
  var menu = document.getElementById('userCtxMenu');
  menu.setAttribute('data-msg-idx', msgIdx);
  if (agentBusy || pendingAgent) {
    menu.innerHTML = '<div class="ctx-item" style="color:var(--text2);cursor:default;">⏳ 智能体思考中，请停止或等待回复完成</div>';
  } else {
    menu.innerHTML = '<div class="ctx-item" onclick="undoLastUserMsg()">↩ 撤回</div>';
  }
  menu.classList.add('show');
  menu.style.left = e.clientX+'px';
  menu.style.top = e.clientY+'px';
  setTimeout(function(){ document.addEventListener('click', function h(){ menu.classList.remove('show'); document.removeEventListener('click',h); }); }, 0);
}

function undoLastUserMsg() {
  var menu = document.getElementById('userCtxMenu');
  var msgIdx = parseInt(menu.getAttribute('data-msg-idx'));
  menu.classList.remove('show');
  if (isNaN(msgIdx) || msgIdx < 0 || msgIdx >= agentMsgs.length) { console.warn('[Undo] invalid msgIdx:', msgIdx); return; }
  if (agentMsgs[msgIdx].role !== 'user') { console.warn('[Undo] msgIdx not a user message'); return; }
  // 终止进行中的Agent调用，防止撤回后被SSE重新写入
  if (activeAbortController) { activeAbortController.abort(); activeAbortController = null; }
  agentBusy = false; pendingAgent = null;
  setBusyUI(false);
  // 找到下一条用户消息的索引（或数组末尾）
  var endIdx = agentMsgs.length;
  for (var i = msgIdx + 1; i < agentMsgs.length; i++) {
    if (agentMsgs[i].role === 'user') { endIdx = i; break; }
  }
  var removed = agentMsgs.splice(msgIdx, endIdx - msgIdx);
  console.log('[Undo] 前端撤回 msgIdx='+msgIdx+' count='+removed.length);
  // 同步后端
  api('POST','/writing-projects/'+projectId+'/undo-last').then(function(r) {
    console.log('[Undo] 后端撤回:', r);
  }).catch(function(e) { console.error('[Undo] 后端撤回失败:', e); });
  renderAgentMessages();
  requestAnimationFrame(function(){ var c=document.getElementById('subPanelChat'); if(c)c.scrollTop=c.scrollHeight; });
}

// ===== Agent 调用 =====
var agentBusy=false, pendingAgent=null, activeAbortController=null;

function setBusyUI(busy) {
  agentBusy=busy;
  var send=document.getElementById('btnSend'), stop=document.getElementById('btnStop'), inp=document.getElementById('agentInput');
  if(send)send.style.display=busy?'none':'';
  if(stop)stop.style.display=busy?'':'none';
  if(inp){inp.disabled=busy;inp.style.opacity=busy?'0.4':'';}
}

function stopAgentCall() {
  if(activeAbortController){console.log('[Write] 用户终止Agent调用');activeAbortController.abort();activeAbortController=null;}
  pendingAgent=null;renderPendingAgent();
  var stopMsg={type:'system',content:'⏹ 已终止',time:Date.now()};
  agentMsgs.push(stopMsg);appendMsgToDOM(renderSingleMsg(stopMsg));
  setBusyUI(false);
}

function sendAgentMessage() {
  var inp=document.getElementById('agentInput'); if(!inp)return;
  var text=inp.value.trim(); if(!text||agentBusy)return;
  inp.value=''; setBusyUI(true);
  console.log('[Write] 用户发送: '+text.substring(0,100));
  markAllRead();
  var now = Date.now();
  var userMsg={type:'chat',role:'user',content:text,time:now};
  agentMsgs.push(userMsg); appendMsgToDOM(renderSingleMsg(userMsg)); scrollToBottom();
  pendingAgent={agent:'orchestrator',label:getAgentName('orchestrator'),icon:getAgentIcon('orchestrator')};renderPendingAgent();
  var ac=new AbortController(); activeAbortController=ac;
  var fetchOpts={method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({content:text}),signal:ac.signal};
  fetch(API+'/writing-projects/'+projectId+'/llm-call',fetchOpts).then(function(r){return r.json();}).then(function(r){
    pendingAgent=null;renderPendingAgent();activeAbortController=null;
    if(r&&r.content){var reply={type:'chat',role:'assistant',agent:'orchestrator',content:r.content,thinking:r.thinking||'',time:Date.now()};agentMsgs.push(reply);appendMsgToDOM(renderSingleMsg(reply));console.log('[Write] 主Agent回复长度='+r.content.length);}
    else if(r&&r.error){var em={type:'system',content:'⚠️ '+r.error,time:Date.now()};agentMsgs.push(em);appendMsgToDOM(renderSingleMsg(em));console.error('[Write] LLM调用失败: '+r.error);}
    else{var em2={type:'system',content:'⚠️ 无响应，请重试',time:Date.now()};agentMsgs.push(em2);appendMsgToDOM(renderSingleMsg(em2));console.error('[Write] LLM返回空');}
    scrollToBottomIfAtBottom();setBusyUI(false);
  }).catch(function(err){if(err&&err.name==='AbortError'){console.log('[Write] 调用已终止');return;}pendingAgent=null;renderPendingAgent();activeAbortController=null;var em3={type:'system',content:'⚠️ 网络错误: '+(err&&err.message||'未知'),time:Date.now()};agentMsgs.push(em3);appendMsgToDOM(renderSingleMsg(em3));console.error('[Write] LLM调用异常:',err);setBusyUI(false);});
}

// ===== 子Agent调度 =====
function subAgentStart(agentId, agentName) {
  var oname=getAgentName('orchestrator'); var inv={type:'system',content:oname+' 邀请 '+agentName+' 进入群聊',time:Date.now()};
  agentMsgs.push(inv);appendMsgToDOM(renderSingleMsg(inv));
  pendingAgent={agent:agentId,label:agentName,icon:getAgentIcon(agentId)};renderPendingAgent();
}
function subAgentEnd(agentId, agentName) {
  pendingAgent=null;renderPendingAgent();
  var leave={type:'system',content:agentName+' 退出群聊',time:Date.now()};
  agentMsgs.push(leave);appendMsgToDOM(renderSingleMsg(leave));
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
    html+='<div class="ot-vol"><div class="ot-vol-header" onclick="toggleVolume(this)"><span class="ot-vol-arrow">▶</span><span class="ot-vol-title">'+escHtml(v.title||'第'+v.volume_no+'卷')+'</span><button class="ot-vol-add" onclick="event.stopPropagation();addChapter('+v.id+')" title="添加章">+章</button></div><div class="ot-chapters">';
    vChaps.forEach(function(c){
      var active=activeChapterId===c.id?' active':'';
      html+='<div class="ot-chap'+active+'" ondblclick="openChapter('+c.id+')" onclick="activeChapterId='+c.id+';renderOutlineTree();">'+escHtml(c.title||'第'+c.chapter_no+'章')+'</div>';
    });
    html+='</div></div>';
  });
  html+='<button onclick="addVolume()" class="ot-btn">+ 新建卷</button>';
  body.innerHTML=html;
}

function toggleVolume(el){var arrow=el.querySelector('.ot-vol-arrow'),chaps=el.nextElementSibling;if(chaps&&chaps.classList.contains('ot-chapters')){var hidden=chaps.style.display==='none';chaps.style.display=hidden?'block':'none';arrow.textContent=hidden?'▼':'▶';}}
function addVolume(){api('POST','/writing-projects/'+projectId+'/volumes',{title:'新卷'}).then(function(r){console.log('[Write] 新建卷 id='+(r&&r.id));loadOutline();}).catch(function(e){console.error('[Write] 新建卷失败:',e);});}
function addChapter(volumeId){api('POST','/writing-projects/'+projectId+'/chapters',{volume_id:volumeId,title:'新章'}).then(function(r){console.log('[Write] 新建章 id='+(r&&r.id)+' vid='+volumeId);loadOutline();}).catch(function(e){console.error('[Write] 新建章失败:',e);});}

function generateOutline() {
  console.log('[Write] 触发大纲生成');
  var uname=getAgentName('outliner');subAgentStart('outliner',uname);
  api('POST','/writing-projects/'+projectId+'/generate-outline').then(function(r){subAgentEnd('outliner',uname);if(r&&r.content){var outlineJson=null;try{var clean=r.content.replace(/```json\s*|\s*```/g,'').trim();outlineJson=JSON.parse(clean);}catch(e){}if(outlineJson&&outlineJson['卷']){outlineJson['卷'].forEach(function(vol,vi){api('POST','/writing-projects/'+projectId+'/volumes',{title:vol['卷名']||('第'+(vi+1)+'卷')}).then(function(vr){if(vr&&vr.id){(vol['章']||[]).forEach(function(chap){api('POST','/writing-projects/'+projectId+'/chapters',{volume_id:vr.id,title:chap['章名']||''});});}});});var omsg={type:'chat',role:'assistant',agent:'outliner',time:Date.now(),content:r.content.substring(0,500)+(r.content.length>500?'\n...(已截断)':''),thinking:''};agentMsgs.push(omsg);appendMsgToDOM(renderSingleMsg(omsg));var okmsg={type:'system',time:Date.now(),content:'✅ 大纲已生成，'+outlineJson['卷'].length+'卷'};agentMsgs.push(okmsg);appendMsgToDOM(renderSingleMsg(okmsg));setTimeout(function(){loadOutline();},1000);}else{var omsg2={type:'chat',role:'assistant',agent:'outliner',time:Date.now(),content:r.content,thinking:''};agentMsgs.push(omsg2);appendMsgToDOM(renderSingleMsg(omsg2));}}else{var emsg={type:'system',time:Date.now(),content:'⚠️ 大纲生成失败: '+(r&&r.error||'未知错误')};agentMsgs.push(emsg);appendMsgToDOM(renderSingleMsg(emsg));}}).catch(function(err){subAgentEnd('outliner',uname);var emsg2={type:'system',time:Date.now(),content:'⚠️ 大纲生成网络错误'};agentMsgs.push(emsg2);appendMsgToDOM(renderSingleMsg(emsg2));console.error('[Write] 大纲生成异常:',err);});
}

// ==================== 角色管理 ====================
function loadCharacters() {
  console.log('[Write] 加载角色列表');
  api('GET','/writing-projects/'+projectId+'/characters').then(function(chars){var list=document.getElementById('charList');if(!list)return;if(!chars||!chars.length){list.innerHTML='<div style="color:var(--text2);font-size:11px;text-align:center;padding:16px;">暂无角色，点击上方按钮生成</div>';return;}var html='';chars.forEach(function(c){try{var profile=JSON.parse(c.profile_json||'{}');}catch(e){profile={};}html+='<div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:8px;font-size:11px;margin-bottom:4px;"><div style="font-weight:600;margin-bottom:4px;">'+escHtml(c.name)+(c.aliases?' ('+escHtml(c.aliases)+')':'')+'</div>'+(profile['外貌']?'<div style="color:var(--text2);font-size:10px;">'+escHtml(profile['外貌'].substring(0,60))+'...</div>':'')+'</div>';});list.innerHTML=html;}).catch(function(e){console.error('[Write] 角色加载失败:',e);});
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

// ==================== SSE ====================
(function(){var sse=new EventSource('/api/sse?token='+encodeURIComponent(token));sse.addEventListener('message',function(e){try{var d=JSON.parse(e.data);if(d.type==='kicked'){localStorage.removeItem('canvas_token');localStorage.removeItem('canvas_username');window.location.replace('/login.html?reason=kicked');}}catch(ex){}});sse.onerror=function(){console.log('[Write] 踢出SSE断线，自动重连中...');};})();

(function(){var sseUrl='/api/write-sse?projectId='+projectId+'&token='+encodeURIComponent(token);var sse=new EventSource(sseUrl);var reconnectTimer=null;sse.addEventListener('message',function(e){try{var d=JSON.parse(e.data);if(d.type==='connected'){console.log('[Write] SSE已连接 projectId='+d.projectId);return;}if(d.type==='agent-message'&&d.msg){if(!agentBusy){var sseMsg={type:'chat',role:'assistant',time:Date.now(),agent:d.msg.agent_type,content:d.msg.content,thinking:d.msg.thinking||''};agentMsgs.push(sseMsg);appendMsgToDOM(renderSingleMsg(sseMsg));scrollToBottomIfAtBottom();console.log('[Write] SSE收到Agent消息: '+d.msg.agent_type);}}}catch(ex){console.error('[Write] SSE消息解析失败:',ex);}});sse.onerror=function(){console.log('[Write] Agent SSE断线，3秒后重连...');if(reconnectTimer)clearTimeout(reconnectTimer);reconnectTimer=setTimeout(function(){console.log('[Write] SSE重连检查');},3000);};window._writeSse=sse;})();

// ==================== 初始化 ====================
api('GET','/writing-projects').then(function(projects){var p=projects?projects.find(function(x){return x.id===projectId;}):null;if(!p){window.location.replace('/projects.html');return;}writingData.title=p.title;});

// 加载历史对话
api('GET','/writing-projects/'+projectId+'/conversations').then(function(msgs){agentMsgs=[];if(msgs&&msgs.length){msgs.forEach(function(m){var meta={};try{meta=JSON.parse(m.metadata||'{}');}catch(e){}agentMsgs.push({type:meta.type,time:Date.parse(m.created_at||Date.now())||'chat',role:m.role,agent:m.agent_type,content:m.content,thinking:m.thinking||''});});console.log('[Write] 已加载 '+msgs.length+' 条历史对话');}else{console.log('[Write] 该项目暂无历史对话');}renderAgentMessages();requestAnimationFrame(function(){requestAnimationFrame(function(){var c=document.getElementById('subPanelChat');if(c){c.scrollTop=c.scrollHeight;markAllRead();}});});}).catch(function(err){console.error('[Write] 加载历史对话失败:',err);renderAgentMessages();});

loadOutline(); loadTokenStats();

// 加载窗格布局或创建默认布局
if (!PANE.loadLayout()) { PANE.init(); }
ACT._updateBadges();

console.log('[Write] 写作模式初始化完成 projectId='+projectId);
