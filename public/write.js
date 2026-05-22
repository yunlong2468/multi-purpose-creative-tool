
// ==================== 标签管理 (in write.html inline) ====================
// switchTab, addChapterTab, closeChapterTab, showEditorTab, switchChatSubTab defined in write.html

// ==================== 自动保存 ====================
var saveTimer = null;
var writingData = { title:'', content:'' };

function autoSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function() {
    var ed = document.getElementById('editableContent');
    writingData.content = ed ? ed.innerHTML : '';
    // 如果有活跃章节，保存章节内容
    if (writingData.chapterId) {
      var wc = (ed.textContent||'').replace(/\s/g,'').length;
      api('PUT','/writing-projects/'+projectId+'/chapters/'+writingData.chapterId, { content_text:writingData.content, word_count:wc }).then(function() {
        console.log('[Write] 章节自动保存 id='+writingData.chapterId+' 字数='+wc);
      });
    }
    api('PUT','/writing-projects/'+projectId, writingData).then(function() {
      console.log('[Write] 项目自动保存完成');
    });
  }, 1000);
}

// 内容变更监听
var edDiv = document.getElementById('editableContent');
edDiv.addEventListener('input', function() {
  var wc = (edDiv.textContent||'').replace(/\s/g,'').length;
  document.getElementById('wordCount').textContent = '字数: '+wc;
  autoSave();
});

// ==================== Agent 消息系统 ====================
var agentMsgs = [];
// Agent 显示名称（可自定义，存localStorage）
var agentDefaults = {
  orchestrator: { name:'策划',  icon:'🎭', desc:'调配师·采访需求' },
  outliner:     { name:'大纲',  icon:'📋', desc:'生成卷章大纲' },
  character:    { name:'角色',  icon:'👥', desc:'设计角色档案' },
  crawler:      { name:'爬虫',  icon:'🕷️', desc:'爬取热门小说' },
  dialog:       { name:'对话',  icon:'💬', desc:'角色扮演对话' },
  reviewer:     { name:'审核',  icon:'🔍', desc:'一致性检查' },
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
    if (nn && nn.trim()) {
      agentDefaults[id].name = nn.trim(); saveAgentNames(); loadMentionList();
      renderAgentMessages(); // 刷新所有消息中的名称
    }
  });
}

function loadMentionList() {
  mentionAgents = [];
  Object.keys(agentDefaults).forEach(function(id) {
    var a = agentDefaults[id];
    mentionAgents.push({ id:id, name:a.name, icon:a.icon, desc:a.desc });
  });
}
var mentionAgents = [];

loadAgentNames();
loadMentionList();

function handleMentionInput() {
  var inp = document.getElementById('agentInput');
  var val = inp.value;
  var cursorPos = inp.selectionStart;
  // 查找光标前最近的@
  var atIdx = -1;
  for (var i = cursorPos-1; i >= 0; i--) {
    if (val[i] === '@') { atIdx = i; break; }
    if (val[i] === ' ' || val[i] === '\n') break;
  }
  var dropdown = document.getElementById('mentionDropdown');
  if (atIdx >= 0) {
    var query = val.substring(atIdx+1, cursorPos).toLowerCase();
    var filtered = mentionAgents.filter(function(a) {
      return a.name.toLowerCase().indexOf(query)>=0 || a.id.toLowerCase().indexOf(query)>=0;
    });
    if (filtered.length) {
      var html = '';
      filtered.forEach(function(a) {
        html += '<div class="m-item" onclick="selectMention(\''+a.id+'\','+atIdx+')">';
        html += '<span class="m-avatar">'+a.icon+'</span>';
        html += '<span class="m-name">'+escHtml(a.name)+'</span>';
        html += '<span class="m-desc">'+escHtml(a.desc)+'</span>';
        html += '</div>';
      });
      dropdown.innerHTML = html;
      dropdown.classList.add('show');
      return;
    }
  }
  dropdown.classList.remove('show');
}

function selectMention(agentId, atIdx) {
  var inp = document.getElementById('agentInput');
  var val = inp.value;
  var cursorPos = inp.selectionStart;
  var agent = mentionAgents.find(function(a){return a.id===agentId;});
  var name = agent ? agent.name : agentId;
  // 替换 @xxx 为 @Agent名
  inp.value = val.substring(0, atIdx) + '@' + name + ' ' + val.substring(cursorPos);
  document.getElementById('mentionDropdown').classList.remove('show');
  inp.focus();
  inp.selectionStart = inp.selectionEnd = atIdx + name.length + 2; // 光标移到 @Agent名 后面
}

function handleInputKey(e) {
  var dropdown = document.getElementById('mentionDropdown');
  if (dropdown.classList.contains('show')) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      var items = dropdown.querySelectorAll('.m-item');
      var idx = -1;
      items.forEach(function(it, i) { if (it.style.background) idx = i; });
      if (e.key==='ArrowDown') idx = (idx+1) % items.length;
      else idx = idx <= 0 ? items.length-1 : idx-1;
      items.forEach(function(it, i) {
        it.style.background = i===idx ? 'rgba(5,163,197,0.12)' : '';
        it.style.color = i===idx ? 'var(--text)' : '';
      });
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      var sel = dropdown.querySelector('.m-item[style]');
      if (sel) { sel.click(); return; }
      dropdown.querySelector('.m-item').click();
      return;
    }
    if (e.key === 'Escape') { dropdown.classList.remove('show'); return; }
  }
  if (e.key === 'Enter') { sendAgentMessage(); }
}

function formatAgentContent(text) {
  if (!text) return '';
  // 1. 提取代码块 ```...```
  var codeBlocks = [];
  var t = text.replace(/```(\w*)\s*([\s\S]*?)```/g, function(_, lang, code) {
    codeBlocks.push(code.trim());
    return '%%CODEBLOCK_'+(codeBlocks.length-1)+'%%';
  });
  // 2. 提取表格（行级处理）
  var tables = [];
  t = t.replace(/(\|[^\n]+\|\n)+\|?[\s]*(\|[-:| ]+\|\n)+\|?[\s]*(\|[^\n]+\|\n?)+/g, function(m) {
    tables.push(m.trim());
    return '%%TABLE_'+(tables.length-1)+'%%';
  });
  // 3. 安全转义（表格占位符之后）
  t = t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  // 4. 标题 ### → <h4>
  t = t.replace(/^###\s+(.+)$/gm, '<h4 style="margin:8px 0 4px;font-size:13px;">$1</h4>');
  t = t.replace(/^##\s+(.+)$/gm, '<h3 style="margin:10px 0 6px;font-size:14px;">$1</h3>');
  // 5. 分割线 --- → <hr>
  t = t.replace(/^[-*]{3,}\s*$/gm, '<hr style="border:0.5px solid var(--border);margin:8px 0;">');
  // 6. 加粗 **text**（允许前后空格）
  t = t.replace(/\*\*\s*(.+?)\s*\*\*/g, '<b>$1</b>');
  // 7. 段落 \n\n → </p><p>
  t = '<p>'+t.split(/\n\n+/).join('</p><p>')+'</p>';
  // 8. 表格还原（生成 HTML table）
  tables.forEach(function(tbl, i) {
    var rows = tbl.split('\n').filter(function(r){ return r.indexOf('|')>=0 && !r.match(/^\|?[\s]*[-:| ]+\|?[\s]*$/); });
    var alignRow = tbl.split('\n').find(function(r){ return r.match(/^\|?[\s]*[-:| ]+\|?[\s]*$/); });
    var html = '<table style="border-collapse:collapse;width:100%;margin:6px 0;font-size:11px;"><tbody>';
    rows.forEach(function(row, ri) {
      html += '<tr>';
      var cells = row.split('|').filter(function(c,ci,arr){ return ci>0&&ci<arr.length-1||(ci===0&&row.indexOf('|')===0)||(ci===arr.length-1&&row.lastIndexOf('|')===row.length-1); });
      // 简化：按 | 分割取有效单元格
      var parts = row.replace(/^\|/, '').replace(/\|$/, '').split('|');
      parts.forEach(function(cell) {
        var tag = ri===0 ? 'th' : 'td';
        var style = ri===0 ? 'padding:4px 8px;border:0.5px solid var(--border);background:rgba(5,163,197,0.12);text-align:left;' : 'padding:4px 8px;border:0.5px solid var(--border);text-align:left;';
        var cellText = cell.trim().replace(/\*\*\s*(.+?)\s*\*\*/g, '<b>$1</b>');
        html += '<'+tag+' style="'+style+'">'+cellText+'</'+tag+'>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    t = t.replace('%%TABLE_'+i+'%%', html);
  });
  // 9. 单个换行 → <br>（但跳过在标签内的）
  t = t.replace(/\n/g, '<br>');
  // 10. 代码块还原
  codeBlocks.forEach(function(code, i) {
    t = t.replace('%%CODEBLOCK_'+i+'%%', '<div class="msg-codeblock">'+code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</div>');
  });
  // 清理空段落
  t = t.replace(/<p>\s*<br>\s*<\/p>/g, '');
  return t;
}

// ==================== 未读追踪（基于 lastReadMsgIndex） ====================
var unreadCount = 0;
var lastReadMsgIndex = -1;
var unreadObserver = null;

function isUserAtBottom() {
  var c = document.getElementById('subPanelChat');
  if (!c) return true;
  return c.scrollHeight - c.scrollTop - c.clientHeight < 60;
}

function scrollToBottom() {
  var c = document.getElementById('subPanelChat');
  if (c) { c.scrollTop = c.scrollHeight; markAllRead(); }
}

function markAllRead() {
  lastReadMsgIndex = agentMsgs.length - 1;
  unreadCount = 0;
  updateUnreadBadge();
}

function scrollToBottomIfAtBottom() {
  var c = document.getElementById('subPanelChat');
  if (!c) return;
  if (isUserAtBottom()) {
    c.scrollTop = c.scrollHeight;
    markAllRead();
  } else {
    unreadCount = Math.max(0, agentMsgs.length - 1 - lastReadMsgIndex);
    updateUnreadBadge();
  }
}

function setupUnreadObserver() {
  var container = document.getElementById('subPanelChat');
  if (!container) return;
  if (unreadObserver) unreadObserver.disconnect();
  unreadObserver = new IntersectionObserver(function(entries) {
    if (entries[0] && entries[0].isIntersecting) markAllRead();
  }, { root: container, threshold: 0.1 });
  var sentinel = container.querySelector('.msg-sentinel');
  if (sentinel) unreadObserver.observe(sentinel);
}

function scrollToUnread() {
  var container = document.getElementById('subPanelChat');
  if (!container) return;
  var targetIdx = Math.max(0, lastReadMsgIndex + 1);
  var msgs = container.querySelectorAll('.msg:not(.msg-sentinel)');
  if (msgs[targetIdx]) {
    msgs[targetIdx].scrollIntoView({ block: 'start' });
  } else {
    container.scrollTop = container.scrollHeight;
  }
  markAllRead();
}

function updateUnreadBadge() {
  var badge = document.getElementById('unreadBadge');
  if (unreadCount > 0) {
    badge.textContent = unreadCount + ' 条新消息';
    badge.classList.add('show');
  } else {
    badge.classList.remove('show');
  }
}

// 追加单条消息到 DOM（不触发全量重绘，保留哨兵和滚动状态）
function renderSingleMsg(m) {
  if (m.type === 'system') return '<div class="msg system-msg"><span class="sys-text">'+escHtml(m.content)+'</span></div>';
  if (m.role === 'user') return '<div class="msg user-msg"><div class="avatar" style="background:rgba(5,163,197,0.12);">👤</div><div class="bubble">'+escHtml(m.content)+'</div></div>';
  var avatar = getAgentIcon(m.agent);
  var h = '<div class="msg agent-msg"><div class="avatar" style="font-size:16px;">'+avatar+'</div><div class="bubble">';
  h += '<div style="font-size:10px;color:var(--accent);margin-bottom:2px;cursor:pointer;" title="点击改名" onclick="event.stopPropagation();renameAgent(\''+escHtml(m.agent||'agent')+'\')">'+escHtml(getAgentName(m.agent))+'</div>';
  if (m.thinking) {
    h += '<span class="think-toggle" onclick="var b=this.nextElementSibling;b.classList.toggle(\'show\');this.textContent=b.classList.contains(\'show\')?\'💭 收起思考\':\'💭 思考过程\'">💭 思考过程</span>';
    h += '<div class="think-body">'+formatAgentContent(m.thinking)+'</div>';
  }
  h += formatAgentContent(m.content)+'</div></div>';
  return h;
}

function appendMsgToDOM(html) {
  var inner = document.querySelector('#subPanelChat .msg-inner');
  if (!inner) return;
  var sentinel = inner.querySelector('.msg-sentinel');
  // 移除旧的思考中占位
  var thinkingEl = inner.querySelector('.msg-thinking');
  if (thinkingEl) thinkingEl.remove();
  if (sentinel) {
    sentinel.insertAdjacentHTML('beforebegin', html);
  } else {
    inner.insertAdjacentHTML('beforeend', html);
  }
}

function renderPendingAgent() {
  var inner = document.querySelector('#subPanelChat .msg-inner');
  if (!inner) return;
  var old = inner.querySelector('.msg-thinking');
  if (old) old.remove();
  if (!pendingAgent) return;
  var pa = pendingAgent;
  var html = '<div class="msg agent-msg msg-thinking"><div class="avatar" style="font-size:16px;background:rgba(5,163,197,0.15);">'+pa.icon+'</div><div class="bubble"><div style="font-size:10px;color:var(--accent);margin-bottom:2px;">'+escHtml(pa.label||pa.agent)+'</div>⏳ 思考中...</div></div>';
  var sentinel = inner.querySelector('.msg-sentinel');
  if (sentinel) sentinel.insertAdjacentHTML('beforebegin', html);
  else inner.insertAdjacentHTML('beforeend', html);
}

function renderAgentMessages() {
  var container = document.getElementById('subPanelChat');
  if (!container) return;
  var wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
  if (!agentMsgs.length) {
    container.innerHTML = '<div class="ap-loading">暂无对话记录<br><span style="font-size:10px;color:var(--text2);">在下方输入消息开始创作</span></div>';
    unreadCount = 0; updateUnreadBadge();
    return;
  }
  var html = '';
  agentMsgs.forEach(function(m) {
    if (m.type === 'system') {
      html += '<div class="msg system-msg"><span class="sys-text">'+escHtml(m.content)+'</span></div>';
    } else if (m.role === 'user') {
      html += '<div class="msg user-msg"><div class="avatar" style="background:rgba(5,163,197,0.12);">👤</div><div class="bubble">'+escHtml(m.content)+'</div></div>';
    } else {
      var avatar = getAgentIcon(m.agent);
      html += '<div class="msg agent-msg"><div class="avatar" style="font-size:16px;">'+avatar+'</div><div class="bubble">';
      html += '<div style="font-size:10px;color:var(--accent);margin-bottom:2px;cursor:pointer;" title="点击改名" onclick="event.stopPropagation();renameAgent(\''+escHtml(m.agent||'agent')+'\')">'+escHtml(getAgentName(m.agent))+'</div>';
      if (m.thinking) {
        html += '<span class="think-toggle" onclick="var b=this.nextElementSibling;b.classList.toggle(\'show\');this.textContent=b.classList.contains(\'show\')?\'💭 收起思考\':\'💭 思考过程\'">💭 思考过程</span>';
        html += '<div class="think-body">'+formatAgentContent(m.thinking)+'</div>';
      }
      html += formatAgentContent(m.content)+'</div></div>';
    }
  });
  if (pendingAgent) {
    var pa = pendingAgent;
    html += '<div class="msg agent-msg"><div class="avatar" style="font-size:16px;background:rgba(5,163,197,0.15);">'+pa.icon+'</div><div class="bubble"><div style="font-size:10px;color:var(--accent);margin-bottom:2px;">'+escHtml(pa.label||pa.agent)+'</div>⏳ 思考中...</div></div>';
  }
  // 哨兵：1px 透明元素，IntersectionObserver 监听其在视口内/外
  html += '<div class="msg msg-sentinel" style="height:1px;flex-shrink:0;opacity:0;pointer-events:none;"></div>';
  container.innerHTML = '<div class="msg-inner">'+html+'</div>';
  function scrollDown() {
    if (wasAtBottom || agentMsgs.length <= 2) {
      container.scrollTop = container.scrollHeight;
      markAllRead();
    } else {
      lastReadMsgIndex = agentMsgs.length - 1;
      unreadCount = 0;
      updateUnreadBadge();
    }
    setupUnreadObserver();
  }
  requestAnimationFrame(function() { requestAnimationFrame(scrollDown); });
}

var agentBusy = false;
var pendingAgent = null;
var activeAbortController = null;

function setBusyUI(busy) {
  agentBusy = busy;
  document.getElementById('btnSend').style.display = busy ? 'none' : '';
  document.getElementById('btnStop').style.display = busy ? '' : 'none';
  document.getElementById('agentInput').disabled = busy;
  document.getElementById('agentInput').style.opacity = busy ? '0.4' : '';
}

function stopAgentCall() {
  if (activeAbortController) {
    console.log('[Write] 用户终止Agent调用');
    activeAbortController.abort();
    activeAbortController = null;
  }
  pendingAgent = null; renderPendingAgent();
  var stopMsg = { type:'system', content:'⏹ 已终止' };
  agentMsgs.push(stopMsg); appendMsgToDOM(renderSingleMsg(stopMsg));
  setBusyUI(false);
}

function sendAgentMessage() {
  var inp = document.getElementById('agentInput');
  var text = inp.value.trim();
  if (!text || agentBusy) return;
  inp.value = '';
  setBusyUI(true);
  console.log('[Write] 用户发送: '+text.substring(0,100));
  markAllRead();
  var userMsg = { type:'chat', role:'user', content:text };
  agentMsgs.push(userMsg);
  appendMsgToDOM(renderSingleMsg(userMsg));
  scrollToBottom();
  // 调用LLM
  pendingAgent = { agent:'orchestrator', label:getAgentName('orchestrator'), icon:getAgentIcon('orchestrator') }; renderPendingAgent();
  var ac = new AbortController();
  activeAbortController = ac;
  var fetchOpts = { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+token}, body:JSON.stringify({ content:text }), signal:ac.signal };
  fetch(API+'/writing-projects/'+projectId+'/llm-call', fetchOpts).then(function(r) { return r.json(); }).then(function(r) {
    pendingAgent = null; renderPendingAgent();
    activeAbortController = null;
    if (r && r.content) {
      var reply = { type:'chat', role:'assistant', agent:'orchestrator', content:r.content, thinking:r.thinking||'' };
      agentMsgs.push(reply); appendMsgToDOM(renderSingleMsg(reply));
      console.log('[Write] 主Agent回复长度='+r.content.length);
    } else if (r && r.error) {
      var em = { type:'system', content:'⚠️ '+r.error };
      agentMsgs.push(em); appendMsgToDOM(renderSingleMsg(em));
      console.error('[Write] LLM调用失败: '+r.error);
    } else {
      var em2 = { type:'system', content:'⚠️ 无响应，请重试' };
      agentMsgs.push(em2); appendMsgToDOM(renderSingleMsg(em2));
      console.error('[Write] LLM返回空');
    }
    scrollToBottomIfAtBottom();
    setBusyUI(false);
  }).catch(function(err) {
    if (err && err.name === 'AbortError') { console.log('[Write] 调用已终止'); return; }
    pendingAgent = null; renderPendingAgent();
    activeAbortController = null;
    var em3 = { type:'system', content:'⚠️ 网络错误: '+(err&&err.message||'未知') };
    agentMsgs.push(em3); appendMsgToDOM(renderSingleMsg(em3));
    console.error('[Write] LLM调用异常:',err);
    setBusyUI(false);
  });
}

// ==================== 初始化 ====================
api('GET','/writing-projects').then(function(projects) {
  var p = projects ? projects.find(function(x){return x.id===projectId;}) : null;
  if (!p) { window.location.replace('/projects.html'); return; }
  document.getElementById('chapTitle').textContent = p.title||'未命名写作';
  writingData.title = p.title;
});

// 加载历史对话
api('GET','/writing-projects/'+projectId+'/conversations').then(function(msgs) {
  agentMsgs = [];
  if (msgs && msgs.length) {
    msgs.forEach(function(m) {
      var meta = {};
      try { meta = JSON.parse(m.metadata||'{}'); } catch(e) {}
      agentMsgs.push({
        type: meta.type||'chat', role: m.role, agent: m.agent_type,
        content: m.content, thinking: m.thinking||''
      });
    });
    console.log('[Write] 已加载 '+msgs.length+' 条历史对话, agentMsgs.length='+agentMsgs.length);
  } else {
    console.log('[Write] 该项目暂无历史对话');
  }
  renderAgentMessages();
  requestAnimationFrame(function(){ requestAnimationFrame(function(){ var c=document.getElementById('subPanelChat'); if(c){c.scrollTop=c.scrollHeight;markAllRead();} }); });
}).catch(function(err) {
  console.error('[Write] 加载历史对话失败:', err);
  renderAgentMessages();
});

// ==================== 大纲树 ====================
var volumes = [], chapters = [], activeChapterId = null;

function loadOutline() {
  console.log('[Write] 加载大纲树');
  api('GET','/writing-projects/'+projectId+'/volumes').then(function(vols) {
    volumes = vols || [];
    api('GET','/writing-projects/'+projectId+'/chapters').then(function(chaps) {
      chapters = chaps || [];
      console.log('[Write] 大纲: '+volumes.length+'卷 '+chapters.length+'章');
      renderOutlineTree();
    });
  });
}

function renderOutlineTree() {
  var body = document.getElementById('treeBody');
  var html = '';
  volumes.forEach(function(v) {
    var vChaps = chapters.filter(function(c){ return c.volume_id===v.id; });
    html += '<div style="margin-bottom:8px;">';
    html += '<div style="display:flex;align-items:center;padding:4px 6px;border-radius:4px;cursor:pointer;" onclick="toggleVolume(this)">';
    html += '<span style="font-size:10px;margin-right:4px;">▶</span>';
    html += '<span style="font-size:12px;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+escHtml(v.title||'第'+v.volume_no+'卷')+'</span>';
    html += '<button style="font-size:9px;padding:1px 4px;border-radius:3px;border:0.5px solid var(--border);background:transparent;color:var(--text2);cursor:pointer;font-family:inherit;" onclick="event.stopPropagation();addChapter('+v.id+')" title="添加章">+章</button>';
    html += '</div>';
    html += '<div class="vol-chapters" style="padding-left:12px;">';
    vChaps.forEach(function(c) {
      var active = activeChapterId===c.id ? ' style="background:rgba(5,163,197,0.12);color:var(--accent);"' : '';
      html += '<div'+active+' onclick="openChapter('+c.id+')" style="padding:3px 6px;border-radius:4px;cursor:pointer;font-size:11px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+escHtml(c.title||'第'+c.chapter_no+'章')+'</div>';
    });
    html += '</div></div>';
  });
  // 新建卷按钮
  html += '<button onclick="addVolume()" style="width:100%;padding:6px;border-radius:6px;border:1px dashed var(--border);background:transparent;color:var(--text2);cursor:pointer;font-size:11px;font-family:inherit;margin-top:4px;">+ 新建卷</button>';
  // 大纲生成按钮
  html += '<button onclick="generateOutline()" id="btnGenOutline" style="width:100%;padding:6px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:11px;font-family:inherit;margin-top:4px;">🎬 生成大纲</button>';
  body.innerHTML = html;
}

function toggleVolume(el) {
  var arrow = el.querySelector('span');
  var chaps = el.nextElementSibling;
  if (chaps && chaps.classList.contains('vol-chapters')) {
    var hidden = chaps.style.display==='none';
    chaps.style.display = hidden ? 'block' : 'none';
    arrow.textContent = hidden ? '▼' : '▶';
  }
}

function addVolume() {
  api('POST','/writing-projects/'+projectId+'/volumes', { title:'新卷' }).then(function(r) {
    console.log('[Write] 新建卷 id='+(r&&r.id));
    loadOutline();
  });
}

function addChapter(volumeId) {
  api('POST','/writing-projects/'+projectId+'/chapters', { volume_id:volumeId, title:'新章' }).then(function(r) {
    console.log('[Write] 新建章 id='+(r&&r.id)+' vid='+volumeId);
    loadOutline();
  });
}

function openChapter(chapterId) {
  console.log('[Write] 打开章 id='+chapterId);
  var ch = chapters.find(function(c){return c.id===chapterId;});
  if (!ch) return;
  addChapterTab(chapterId, ch.title||('第'+ch.chapter_no+'章'));
}

function generateOutline() {
  console.log('[Write] 触发大纲生成');
  var uname = getAgentName('outliner');
  subAgentStart('outliner', uname);
  api('POST','/writing-projects/'+projectId+'/generate-outline').then(function(r) {
    subAgentEnd('outliner', uname);
    if (r && r.content) {
      var outlineJson = null;
      try { var clean = r.content.replace(/```json\s*|\s*```/g, '').trim(); outlineJson = JSON.parse(clean); } catch(e) {}
      if (outlineJson && outlineJson['卷']) {
        outlineJson['卷'].forEach(function(vol, vi) {
          api('POST','/writing-projects/'+projectId+'/volumes', { title:vol['卷名']||('第'+(vi+1)+'卷') }).then(function(vr) {
            if (vr && vr.id) { (vol['章']||[]).forEach(function(chap) { api('POST','/writing-projects/'+projectId+'/chapters', { volume_id:vr.id, title:chap['章名']||'' }); }); }
          });
        });
        var omsg = { type:'chat', role:'assistant', agent:'outliner', content:r.content.substring(0, 500)+(r.content.length>500?'\n...(已截断)':''), thinking:'' };
        agentMsgs.push(omsg); appendMsgToDOM(renderSingleMsg(omsg));
        var okmsg = { type:'system', content:'✅ 大纲已生成，'+outlineJson['卷'].length+'卷' };
        agentMsgs.push(okmsg); appendMsgToDOM(renderSingleMsg(okmsg));
        setTimeout(function(){ loadOutline(); }, 1000);
      } else {
        var omsg2 = { type:'chat', role:'assistant', agent:'outliner', content:r.content, thinking:'' };
        agentMsgs.push(omsg2); appendMsgToDOM(renderSingleMsg(omsg2));
      }
    } else {
      var emsg = { type:'system', content:'⚠️ 大纲生成失败: '+(r&&r.error||'未知错误') };
      agentMsgs.push(emsg); appendMsgToDOM(renderSingleMsg(emsg));
    }
  }).catch(function(err) {
    subAgentEnd('outliner', uname);
    var emsg2 = { type:'system', content:'⚠️ 大纲生成网络错误' };
    agentMsgs.push(emsg2); appendMsgToDOM(renderSingleMsg(emsg2));
    console.error('[Write] 大纲生成异常:',err);
  });
}

// 初始化时加载大纲和Token
loadOutline();
loadTokenStats();

// ==================== SSE 实时通知 ====================
// ==================== 角色面板 ====================
function switchAgentTab(tab) {
  document.getElementById('tabChat').style.color = tab==='chat'?'var(--text)':'var(--text2)';
  document.getElementById('tabChars').style.color = tab==='chars'?'var(--text)':'var(--text2)';
  document.getElementById('panelChat').style.display = tab==='chat'?'flex':'none';
  var cp = document.getElementById('panelChars');
  cp.style.display = tab==='chars'?'flex':'none';
  if (tab==='chars') loadCharacters();
}

function loadCharacters() {
  console.log('[Write] 加载角色列表');
  api('GET','/writing-projects/'+projectId+'/characters').then(function(chars) {
    var list = document.getElementById('charList');
    if (!chars || !chars.length) { list.innerHTML = '<div style="color:var(--text2);font-size:11px;text-align:center;padding:16px;">暂无角色，点击上方按钮生成</div>'; return; }
    var html = '';
    chars.forEach(function(c) {
      var profile = {};
      try { profile = JSON.parse(c.profile_json||'{}'); } catch(e) {}
      var cnodes = [];
      try { cnodes = JSON.parse(c.canvas_node_ids||'[]'); } catch(e) {}
      html += '<div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:8px;font-size:11px;margin-bottom:4px;">';
      html += '<div style="font-weight:600;margin-bottom:4px;">'+escHtml(c.name)+(c.aliases?' ('+escHtml(c.aliases)+')':'')+'</div>';
      if (profile['外貌']) html += '<div style="color:var(--text2);font-size:10px;">'+escHtml(profile['外貌'].substring(0,60))+'...</div>';
      if (cnodes.length) html += '<div style="font-size:9px;color:var(--accent);margin-top:2px;">🖼️ '+cnodes.length+'张立绘</div>';
      html += '</div>';
    });
    list.innerHTML = html;
  });
}

// ==================== 子Agent 独立调度 ====================
function subAgentStart(agentId, agentName) {
  var oname = getAgentName('orchestrator');
  var inv = { type:'system', content:oname+' 邀请 '+agentName+' 进入群聊' };
  agentMsgs.push(inv); appendMsgToDOM(renderSingleMsg(inv));
  pendingAgent = { agent:agentId, label:agentName, icon:getAgentIcon(agentId) }; renderPendingAgent();
}

function subAgentEnd(agentId, agentName) {
  pendingAgent = null; renderPendingAgent();
  var leave = { type:'system', content:agentName+' 退出群聊' };
  agentMsgs.push(leave); appendMsgToDOM(renderSingleMsg(leave));
}

function generateCharacters() {
  console.log('[Write] 触发角色生成');
  var cname = getAgentName('character');
  subAgentStart('character', cname);
  api('POST','/writing-projects/'+projectId+'/generate-characters').then(function(r) {
    subAgentEnd('character', cname);
    if (r && r.content) {
      // 解析角色JSON
      var charJson = null;
      try { var clean = r.content.replace(/```json\s*|\s*```/g, '').trim(); charJson = JSON.parse(clean); } catch(e) {}
      if (charJson && charJson['角色']) {
        charJson['角色'].forEach(function(c) {
          api('POST','/writing-projects/'+projectId+'/characters', { name:c['姓名']||c['姓名']||'未命名', profile_json:JSON.stringify(c) });
        });
        var cok = { type:'system', content:'✅ 已生成 '+charJson['角色'].length+' 个角色' };
        agentMsgs.push(cok); appendMsgToDOM(renderSingleMsg(cok));
        console.log('[Write] 角色生成成功 count='+charJson['角色'].length);
      } else {
        var cms = { type:'chat', role:'assistant', agent:'character', content:r.content, thinking:'' };
        agentMsgs.push(cms); appendMsgToDOM(renderSingleMsg(cms));
      }
    }
    try { document.getElementById('panelChars').style.display = 'flex'; loadCharacters(); } catch(e) {}
  }).catch(function(err) {
    console.error('[Write] 角色生成失败:',err);
  });
}

// ==================== Token 面板 ====================
function loadTokenStats() {
  api('GET','/writing-projects/'+projectId+'/token-stats').then(function(stats) {
    if (!stats) return;
    document.getElementById('tokenToday').textContent = (stats.today||0).toLocaleString();
    // 详细
    var html = '今日'+stats.model+': '+stats.today.toLocaleString()+' tokens';
    if (stats.cost) html += '<br>预估费用: ¥'+stats.cost.toFixed(2);
    document.getElementById('tokenChart').textContent = html;
    document.getElementById('tokenCost').textContent = '输入:¥'+stats.inputPrice+'/百万 | 输出:¥'+stats.outputPrice+'/百万';
  });
}

// ==================== SSE-1: 互踢检测
(function() {
  var sse = new EventSource('/api/sse?token='+encodeURIComponent(token));
  sse.addEventListener('message', function(e) {
    try { var d = JSON.parse(e.data); if (d.type==='kicked') { localStorage.removeItem('canvas_token'); localStorage.removeItem('canvas_username'); window.location.replace('/login.html?reason=kicked'); } } catch(ex) {}
  });
  sse.onerror = function() { console.log('[Write] 踢出SSE断线，自动重连中...'); };
})();

// SSE-2: 写作Agent消息推送
(function() {
  var sseUrl = '/api/write-sse?projectId='+projectId+'&token='+encodeURIComponent(token);
  var sse = new EventSource(sseUrl);
  var reconnectTimer = null;
  sse.addEventListener('message', function(e) {
    try {
      var d = JSON.parse(e.data);
      if (d.type==='connected') { console.log('[Write] SSE已连接 projectId='+d.projectId); return; }
      if (d.type==='agent-message' && d.msg) {
        if (!agentBusy) {
          var sseMsg = { type:'chat', role:'assistant', agent:d.msg.agent_type, content:d.msg.content, thinking:d.msg.thinking||'' };
          agentMsgs.push(sseMsg);
          appendMsgToDOM(renderSingleMsg(sseMsg));
          scrollToBottomIfAtBottom();
          console.log('[Write] SSE收到Agent消息: '+d.msg.agent_type);
        }
      }
    } catch(ex) { console.error('[Write] SSE消息解析失败:',ex); }
  });
  sse.onerror = function() {
    console.log('[Write] Agent SSE断线，3秒后重连...');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(function() {
      // EventSource会自动重连，这里做容错
      console.log('[Write] SSE重连检查');
    }, 3000);
  };
  // 保存引用供broadcast使用
  window._writeSse = sse;
})();
