// 无限画布 - 本地后端服务（多画布版）
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const initSqlJs = require('sql.js');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const JWT_SECRET = process.env.JWT_SECRET || 'infinite-canvas-local-secret-key-2024';
const JWT_EXPIRES = '7d';
const PORT = process.env.PORT || 3001;
const DB_PATH = path.join(__dirname, 'data.db');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ==================== SQL.js 数据库 ====================
let db = null;

function queryAll(sql, params) { if (!db) return []; const s = db.prepare(sql); if (params) s.bind(params); const r = []; while (s.step()) r.push(s.getAsObject()); s.free(); return r; }
function queryOne(sql, params) { const r = queryAll(sql, params); return r.length > 0 ? r[0] : null; }
function dbRun(sql, params) { if (!db) return 0; db.run(sql, params); const r = queryOne('SELECT last_insert_rowid() AS id'); saveDB(); return r ? r.id : 0; }
function saveDB() { if (!db) return; fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }

// ==================== Express ====================
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

const storage = multer.diskStorage({ destination: UPLOAD_DIR, filename: (req, f, cb) => cb(null, uuidv4() + path.extname(f.originalname)) });
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ==================== SSE 实时推送 ====================
var sseClients = [];

function broadcastStyleEvent(data) {
    var json = JSON.stringify(data);
    sseClients.forEach(function(c) { try { c.write('data: ' + json + '\n\n'); } catch(e) {} });
    sseClients = sseClients.filter(function(c) { return !c.destroyed; });
}

// 按用户维度管理的 SSE 连接（用于互踢通知）
var userSseClients = new Map();

function addUserSse(userId, res) {
    if (!userSseClients.has(userId)) userSseClients.set(userId, new Set());
    userSseClients.get(userId).add(res);
}

function removeUserSse(userId, res) {
    var s = userSseClients.get(userId);
    if (s) { s.delete(res); if (s.size === 0) userSseClients.delete(userId); }
}

function cleanUserSse(userId) {
    var s = userSseClients.get(userId);
    if (!s) return;
    s.forEach(function(c) { if (c.destroyed) s.delete(c); });
    if (s.size === 0) userSseClients.delete(userId);
}

function kickUserSessions(userId) {
    var s = userSseClients.get(userId);
    if (!s) return;
    s.forEach(function(c) {
        try { c.write('data: {"type":"kicked","message":"已在其他设备登录"}\n\n'); c.end(); } catch(e) {}
    });
    userSseClients.delete(userId);
}

// ==================== 认证中间件 ====================
function auth(req, res, next) {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: '未登录' });
    try {
        const d = jwt.verify(h.split(' ')[1], JWT_SECRET);
        const user = queryOne('SELECT session_token FROM users WHERE id=?', [d.userId]);
        if (!user) return res.status(401).json({ error: '用户不存在' });
        if (user.session_token && d.session_token !== user.session_token) {
            return res.status(401).json({ error: '已在其他设备登录，请重新登录' });
        }
        req.userId = d.userId; req.username = d.username; next();
    }
    catch (e) { return res.status(401).json({ error: '登录过期' }); }
}

// 路由中间件：需要 projectId + 验证所有权
function withProject(req, res, next) {
    const pid = req.query.projectId || (req.body && req.body.projectId);
    if (!pid) return res.status(400).json({ error: '缺少 projectId' });
    const proj = queryOne('SELECT user_id FROM projects WHERE id=?', [parseInt(pid)]);
    if (!proj) return res.status(404).json({ error: '项目不存在' });
    if (proj.user_id !== req.userId) return res.status(403).json({ error: '无权访问此项目' });
    req.projectId = parseInt(pid);
    next();
}

// ==================== 路由 ====================
app.get('/', (req, res) => res.redirect('/login.html'));

// 注册
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
    if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名 2-20 字符' });
    if (password.length < 4) return res.status(400).json({ error: '密码至少 4 字符' });
    if (queryOne('SELECT id FROM users WHERE username = ?', [username])) return res.status(400).json({ error: '用户名已存在' });
    const hash = bcrypt.hashSync(password, 10);
    const sessionToken = uuidv4();
    const userId = dbRun('INSERT INTO users (username, password_hash, session_token) VALUES (?, ?, ?)', [username, hash, sessionToken]);
    // 创建默认项目
    dbRun('INSERT INTO projects (user_id, name, data) VALUES (?, ?, ?)', [userId, '新建项目', '{"notes":[],"mediaNodes":[],"connections":[]}']);
    const token = jwt.sign({ userId, username, session_token: sessionToken }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.json({ token, username });
});

// 登录
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
    const user = queryOne('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: '用户名或密码错误' });
    const sessionToken = uuidv4();
    dbRun('UPDATE users SET session_token=? WHERE id=?', [sessionToken, user.id]);
    kickUserSessions(user.id);
    const token = jwt.sign({ userId: user.id, username: user.username, session_token: sessionToken }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.json({ token, username: user.username });
});

app.get('/api/me', auth, (req, res) => res.json({ userId: req.userId, username: req.username }));

// ==================== 项目 CRUD ====================

// 项目列表
app.get('/api/projects', auth, (req, res) => {
    const projects = queryAll('SELECT id, name, updated_at, created_at, length(data) AS size FROM projects WHERE user_id = ? ORDER BY updated_at DESC', [req.userId]);
    res.json(projects);
});

// 自动命名：baseName 或 baseName (N)，自动填充最小缺失数字
function generateAutoName(userId, table, column, baseName) {
    var rows = queryAll('SELECT '+column+' AS n FROM '+table+' WHERE user_id=?', [userId]);
    var used = {};
    var regex = new RegExp('^'+baseName.replace(/[-\/\\^$*+?.()|[\]{}]/g,'\\$&')+'\\s*\\((\\d+)\\)$');
    rows.forEach(function(r) {
        if (r.n === baseName) { used[1] = true; return; }
        var m = r.n.match(regex);
        if (m) { used[parseInt(m[1])] = true; }
    });
    var num = 1;
    while (used[num]) num++;
    return num === 1 ? baseName : baseName + ' (' + num + ')';
}

// 创建画布项目
app.post('/api/projects', auth, (req, res) => {
    var name = (req.body.name || '').trim();
    if (!name) name = generateAutoName(req.userId, 'projects', 'name', '新建项目');
    const id = dbRun('INSERT INTO projects (user_id, name, data) VALUES (?, ?, ?)', [req.userId, name, '{"notes":[],"mediaNodes":[],"connections":[]}']);
    res.json({ id, name });
});

// 重命名项目
app.put('/api/projects/:id', auth, (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: '名称不能为空' });
    dbRun('UPDATE projects SET name = ? WHERE id = ? AND user_id = ?', [name, req.params.id, req.userId]);
    saveDB();
    res.json({ ok: true });
});

// 删除项目
app.delete('/api/projects/:id', auth, (req, res) => {
    dbRun('DELETE FROM projects WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    dbRun('DELETE FROM canvas_versions WHERE project_id = ?', [req.params.id]);
    dbRun('DELETE FROM pinned_snapshot WHERE project_id = ?', [req.params.id]);
    saveDB();
    res.json({ ok: true });
});

// ==================== 写作项目 ====================
app.get('/api/writing-projects', auth, (req, res) => {
    const projects = queryAll('SELECT * FROM writing_projects WHERE user_id=? ORDER BY updated_at DESC', [req.userId]);
    res.json(projects);
});
app.post('/api/writing-projects', auth, (req, res) => {
    var title = (req.body.title || '').trim();
    if (!title) title = generateAutoName(req.userId, 'writing_projects', 'title', '未命名写作');
    const id = dbRun('INSERT INTO writing_projects (user_id, title) VALUES (?,?)', [req.userId, title]);
    dbRun('INSERT OR IGNORE INTO writing_agent_config (project_id, agent_type, model_name) VALUES (?,?,?)', [id, 'orchestrator', 'deepseek-v4-pro']);
    saveDB();
    console.log('[Writing] 创建项目 id='+id+' title='+title);
    res.json({ id, title });
});
app.put('/api/writing-projects/:id', auth, (req, res) => {
    const { title, genre, sub_genre, target_words, style_ref, status } = req.body;
    var sets=[], params=[];
    if (title!==undefined){sets.push('title=?');params.push(title);}
    if (genre!==undefined){sets.push('genre=?');params.push(genre);}
    if (sub_genre!==undefined){sets.push('sub_genre=?');params.push(sub_genre);}
    if (target_words!==undefined){sets.push('target_words=?');params.push(target_words);}
    if (style_ref!==undefined){sets.push('style_ref=?');params.push(style_ref);}
    if (status!==undefined){sets.push('status=?');params.push(status);}
    if (sets.length){sets.push('updated_at=CURRENT_TIMESTAMP');params.push(req.params.id);params.push(req.userId);dbRun('UPDATE writing_projects SET '+sets.join(',')+' WHERE id=? AND user_id=?',params);saveDB();}
    res.json({ ok:true });
});
app.delete('/api/writing-projects/:id', auth, (req, res) => {
    dbRun('DELETE FROM writing_projects WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    dbRun('DELETE FROM agent_conversations WHERE project_id=?', [req.params.id]);
    dbRun('DELETE FROM writing_agent_config WHERE project_id=?', [req.params.id]);
    saveDB();
    res.json({ ok:true });
});

// ==================== Agent 对话 ====================
app.get('/api/writing-projects/:id/conversations', auth, (req, res) => {
    const msgs = queryAll('SELECT * FROM agent_conversations WHERE project_id=? ORDER BY created_at LIMIT 500', [req.params.id]);
    res.json(msgs);
});
app.post('/api/writing-projects/:id/conversations', auth, (req, res) => {
    const { agent_type, role, content, thinking, metadata } = req.body;
    const id = dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content, thinking, metadata) VALUES (?,?,?,?,?,?)',
        [req.params.id, agent_type||'user', role||'user', content||'', thinking||'', metadata||'{"type":"chat"}']);
    saveDB();
    res.json({ id });
});

// ==================== Agent LLM 调用 ====================
var ORCHESTRATOR_SYSTEM = '你是一个小说创作调配师，负责采访用户需求、协调下游写作智能体工作。\n\n'+
'## 你的职责\n'+
'1. 向用户询问以下信息（每次只问1-2个问题，不要一口气全问）：\n'+
'   - 小说类型（玄幻/都市/科幻/仙侠/武侠/悬疑/言情/历史/同人...）和细分方向\n'+
'   - 目标字数（短篇3万字 / 中篇20万字 / 长篇100万字+）\n'+
'   - 是否有初步故事构思或灵感\n'+
'   - 角色设想（主角、配角、反派等）\n'+
'   - 风格参考（类似某某作家/某某作品/某某流派）\n'+
'   - 目标读者平台（番茄/起点/晋江/纵横...）\n'+
'2. 收集足够信息后，询问用户是否授权爬取近6个月同类热门小说作为参考\n'+
'3. 整合所有信息生成一份清晰的创作需求摘要，请用户确认\n'+
'4. 用户确认后，引导用户点击界面上的「生成大纲」按钮\n\n'+
'## 重要规则\n'+
'- 你是调配师，不要亲自生成大纲、角色档案、小说正文等内容\n'+
'- 需要生成大纲 → 引导用户点击「生成大纲」按钮\n'+
'- 需要设计角色 → 引导用户点击角色面板的「生成角色」按钮\n'+
'- 你只负责：采访、整理需求摘要、提出建议、协调协调\n\n'+
'## 风格\n'+
'- 像一个有经验的编辑/策划一样对话，不要过于机械\n'+
'- 根据用户的回答灵活调整后续问题\n'+
'- 适当给出来自网文市场的建议（如"目前XX类型在XX平台比较吃香"）\n'+
'- 不要替用户做决定，始终征求确认\n\n'+
'## 输出格式\n'+
'- 以纯文本自然语言回复\n'+
'- 当需要用户确认时，在末尾明确写出确认选项';

app.post('/api/writing-projects/:id/llm-call', auth, (req, res) => {
    const projectId = parseInt(req.params.id);
    const { content } = req.body;
    if (!content) return res.status(400).json({ error:'缺少消息内容' });
    console.log('[Write LLM] 项目='+projectId+' 用户输入长度='+content.length);

    // 获取项目信息
    const proj = queryOne('SELECT * FROM writing_projects WHERE id=? AND user_id=?', [projectId, req.userId]);
    if (!proj) return res.status(404).json({ error:'项目不存在' });

    // 获取或创建设置Agent配置
    var agentConfig = queryOne('SELECT * FROM writing_agent_config WHERE project_id=? AND agent_type=?', [projectId, 'orchestrator']);
    if (!agentConfig) {
        dbRun('INSERT INTO writing_agent_config (project_id, agent_type, model_name) VALUES (?,?,?)', [projectId, 'orchestrator', 'deepseek-v4-pro']);
        agentConfig = { model_name:'deepseek-v4-pro', temperature:null, api_endpoint:null, api_key:null };
    }

    // 获取历史对话（最近30条）
    const history = queryAll('SELECT * FROM agent_conversations WHERE project_id=? ORDER BY created_at ASC LIMIT 500', [projectId]);
    var recentMsgs = history.slice(-30);

    // 保存用户消息
    dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content) VALUES (?,?,?,?)', [projectId, 'user', 'user', content]);

    // 构建消息
    var msgs = [{ role:'system', content:ORCHESTRATOR_SYSTEM}];
    recentMsgs.forEach(function(m) {
        if (m.role==='user') msgs.push({ role:'user', content:m.content });
        else if (m.role==='assistant') msgs.push({ role:'assistant', content:m.content });
    });
    msgs.push({ role:'user', content:content });

    // 获取用户默认Agent（使用first available agent for LLM calls）
    var llmAgent = queryOne('SELECT * FROM agents WHERE user_id=? ORDER BY id LIMIT 1', [req.userId]);
    if (!llmAgent || !llmAgent.api_key) {
        console.log('[Write LLM] 无可用智能体, 使用静默回退');
        return res.json({ content:'⚠️ 请先在智能体管理页面配置至少一个AI模型，然后回到这里继续。', agent_type:'orchestrator' });
    }

    var endpoint = llmAgent.api_endpoint;
    var key = llmAgent.api_key;
    var model = agentConfig.model_name || llmAgent.model || 'deepseek-v4-pro';
    var reqBody = { model:model, messages:msgs, temperature:0.7, stream:false };

    console.log('[Write LLM] 调用 model='+model+' 消息数='+msgs.length+' endpoint='+endpoint.substring(0,40)+'...');

    fetch(endpoint, {
        method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
        body:JSON.stringify(reqBody)
    }).then(function(r){ return r.json(); }).then(function(d) {
        var reply = (d.choices && d.choices[0] && d.choices[0].message) ? d.choices[0].message.content : '';
        var thinking = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.reasoning_content) ? d.choices[0].message.reasoning_content : '';
        if (!reply) { console.log('[Write LLM] 空响应'); reply='（模型未返回内容，请重试）'; }
        var tokIn = (d.usage && d.usage.prompt_tokens)||0;
        var tokOut = (d.usage && d.usage.completion_tokens)||0;
        console.log('[Write LLM] 回复长度='+reply.length+' tokens in='+tokIn+' out='+tokOut);

        // 保存助手回复
        dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content, thinking, token_used) VALUES (?,?,?,?,?,?)',
            [projectId, 'orchestrator', 'assistant', reply, thinking||'', tokIn+tokOut]);
        // 记录token消耗
        dbRun('INSERT INTO token_usage_logs (user_id, project_id, agent_type, model, input_tokens, output_tokens) VALUES (?,?,?,?,?,?)',
            [req.userId, projectId, 'orchestrator', model, tokIn, tokOut]);
        saveDB();

        res.json({ content:reply, thinking:thinking||'', token_in:tokIn, token_out:tokOut });
    }).catch(function(err) {
        console.error('[Write LLM] 调用失败:',err.message);
        dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content) VALUES (?,?,?,?)', [projectId, 'orchestrator', 'assistant', '⚠️ 调用失败：'+err.message]);
        saveDB();
        res.status(500).json({ error:'LLM调用失败: '+err.message });
    });
});

// ==================== 对话Agent ====================
var DIALOG_SYSTEM = '你是小说对白专家，负责模拟角色之间的对话。\n\n'+
'## 要求\n'+
'- 根据提供的角色档案，模拟角色之间的自然对话\n'+
'- 保持角色性格一致性（说话方式、口头禅、性格特征）\n'+
'- 考虑角色之间的关系状态（友好/敌对/爱慕等）\n'+
'- 输出纯对话文本，格式为：角色名：对话内容\n'+
'- 可以在括号内添加简短的动作/表情描述，如（冷笑）（握紧拳头）\n'+
'- 对话要推动剧情，不要空洞寒暄';

app.post('/api/writing-projects/:id/generate-dialog', auth, (req, res) => {
    const projectId = parseInt(req.params.id);
    const { character_ids, scene_context } = req.body;
    console.log('[Writing 对话] 项目='+projectId+' chars='+JSON.stringify(character_ids));
    var context = '场景：'+(scene_context||'未知')+'\n';
    if (character_ids && character_ids.length) {
        character_ids.forEach(function(cid) {
            var c = queryOne('SELECT * FROM writing_characters WHERE id=?', [cid]);
            if (c) { context += '角色档案：\n'+c.profile_json+'\n'; }
        });
    }
    callOutlineLLM(projectId, req.userId, DIALOG_SYSTEM, context, 'dialog', function(result) {
        if (result.error) return res.status(500).json({ error:result.error });
        res.json(result);
    });
});

// ==================== 关系/时间线/伏笔 CRUD ====================
app.get('/api/writing-projects/:id/relationships', auth, (req, res) => {
    res.json(queryAll('SELECT * FROM relationship_edges WHERE project_id=?', [req.params.id]));
});
app.post('/api/writing-projects/:id/relationships', auth, (req, res) => {
    var { from_character_id, to_character_id, relation_type, description, intensity } = req.body;
    var id = dbRun('INSERT INTO relationship_edges (project_id, from_character_id, to_character_id, relation_type, description, intensity) VALUES (?,?,?,?,?,?)', [req.params.id, from_character_id, to_character_id, relation_type||'custom', description||'', intensity||5]);
    saveDB();
    res.json({ id });
});
app.delete('/api/writing-projects/:id/relationships/:rid', auth, (req, res) => {
    dbRun('DELETE FROM relationship_edges WHERE id=?', [req.params.rid]);
    saveDB();
    res.json({ ok:true });
});

app.get('/api/writing-projects/:id/timeline', auth, (req, res) => {
    res.json(queryAll('SELECT * FROM plot_timeline_events WHERE project_id=? ORDER BY order_index', [req.params.id]));
});
app.post('/api/writing-projects/:id/timeline', auth, (req, res) => {
    var { event_name, summary, character_ids, chapter_id, order_index, event_type } = req.body;
    var id = dbRun('INSERT INTO plot_timeline_events (project_id, event_name, summary, character_ids, chapter_id, order_index, event_type) VALUES (?,?,?,?,?,?,?)', [req.params.id, event_name, summary||'', JSON.stringify(character_ids||[]), chapter_id||null, order_index||0, event_type||'minor']);
    saveDB();
    res.json({ id });
});

app.get('/api/writing-projects/:id/foreshadowing', auth, (req, res) => {
    res.json(queryAll('SELECT * FROM foreshadowing WHERE project_id=? ORDER BY created_at DESC', [req.params.id]));
});
app.post('/api/writing-projects/:id/foreshadowing', auth, (req, res) => {
    var { name, description, status, plant_chapter_id } = req.body;
    var id = dbRun('INSERT INTO foreshadowing (project_id, name, description, status, plant_chapter_id) VALUES (?,?,?,?,?)', [req.params.id, name, description||'', status||'planted', plant_chapter_id||null]);
    saveDB();
    res.json({ id });
});
app.put('/api/writing-projects/:id/foreshadowing/:fid', auth, (req, res) => {
    var { status, resolve_chapter_id, notes } = req.body;
    var sets=[], params=[];
    if (status) { sets.push('status=?'); params.push(status); }
    if (resolve_chapter_id) { sets.push('resolve_chapter_id=?'); params.push(resolve_chapter_id); }
    if (notes) { sets.push('notes=?'); params.push(notes); }
    if (status==='resolved') { sets.push('resolved_at=?'); params.push(new Date().toISOString()); }
    if (sets.length) { params.push(req.params.fid); dbRun('UPDATE foreshadowing SET '+sets.join(',')+' WHERE id=?', params); saveDB(); }
    res.json({ ok:true });
});

// ==================== 角色/场景/道具 CRUD ====================
app.get('/api/writing-projects/:id/characters', auth, (req, res) => {
    const chars = queryAll('SELECT * FROM writing_characters WHERE project_id=? ORDER BY id', [req.params.id]);
    res.json(chars);
});
app.post('/api/writing-projects/:id/characters', auth, (req, res) => {
    const { name, profile_json } = req.body;
    if (!name) return res.status(400).json({ error:'缺少角色名' });
    const id = dbRun('INSERT INTO writing_characters (project_id, name, profile_json) VALUES (?,?,?)', [req.params.id, name, profile_json||'{}']);
    saveDB();
    console.log('[Writing] 新建角色 id='+id+' name='+name);
    res.json({ id, name });
});
app.put('/api/writing-projects/:id/characters/:cid', auth, (req, res) => {
    const { name, aliases, profile_json, canvas_node_ids, avatar_url, status } = req.body;
    var sets=[], params=[];
    if (name!==undefined){sets.push('name=?');params.push(name);}
    if (aliases!==undefined){sets.push('aliases=?');params.push(aliases);}
    if (profile_json!==undefined){sets.push('profile_json=?');params.push(profile_json);}
    if (canvas_node_ids!==undefined){sets.push('canvas_node_ids=?');params.push(canvas_node_ids);}
    if (avatar_url!==undefined){sets.push('avatar_url=?');params.push(avatar_url);}
    if (status!==undefined){sets.push('status=?');params.push(status);}
    if (sets.length){sets.push('updated_at=CURRENT_TIMESTAMP');params.push(req.params.cid);dbRun('UPDATE writing_characters SET '+sets.join(',')+' WHERE id=?',params);saveDB();}
    res.json({ ok:true });
});
app.delete('/api/writing-projects/:id/characters/:cid', auth, (req, res) => {
    dbRun('DELETE FROM writing_characters WHERE id=?', [req.params.cid]);
    saveDB();
    res.json({ ok:true });
});

// ==================== 角色Agent ====================
var CHARACTER_SYSTEM = '你是小说角色设计专家。根据用户提供的小说信息和大纲，设计角色档案。\n\n'+
'## 输出格式\n'+
'请输出以下JSON：\n'+
'```json\n'+
'{\n'+
'  "角色": [{\n'+
'    "姓名":"主角名",\n'+
'    "别名":"称号/道号",\n'+
'    "性别":"男/女",\n'+
'    "年龄":"外表年龄/实际年龄",\n'+
'    "外貌":"详细外貌描写，100-200字",\n'+
'    "性格":"性格特征描述",\n'+
'    "背景":"身世和成长经历",\n'+
'    "能力":"功法/能力/特长",\n'+
'    "命运弧线":"角色在故事中的成长轨迹和结局走向",\n'+
'    "对白风格":"说话方式、口头禅、语言特点",\n'+
'    "关系网":"与其他角色的关系列表"\n'+
'  }]\n'+
'}\n'+
'```\n\n'+
'## 要求\n'+
'- 至少设计主角和相关重要配角\n'+
'- 外貌描写要具体可画\n'+
'- 命运弧线要涵盖从开篇到结局的完整变化';

app.post('/api/writing-projects/:id/generate-characters', auth, (req, res) => {
    const projectId = parseInt(req.params.id);
    var proj = queryOne('SELECT * FROM writing_projects WHERE id=? AND user_id=?', [projectId, req.userId]);
    if (!proj) return res.status(404).json({ error:'项目不存在' });
    console.log('[Writing 角色] 项目='+projectId+' 开始生成角色');
    var context = '项目：'+proj.title+'\n类型：'+proj.genre+' '+proj.sub_genre+'\n';
    var history = queryAll('SELECT * FROM agent_conversations WHERE project_id=? ORDER BY created_at ASC LIMIT 200', [projectId]);
    history.forEach(function(m) {
        if (m.role==='user') context += '用户：'+m.content+'\n';
        else if (m.role==='assistant') context += 'Agent：'+m.content+'\n';
    });
    callOutlineLLM(projectId, req.userId, CHARACTER_SYSTEM, context, 'character', function(result) {
        if (result.error) return res.status(500).json({ error:result.error });
        res.json(result);
    });
});

// ==================== 大纲Agent ====================
var OUTLINER_SYSTEM = '你是小说大纲生成专家。根据用户提供的小说需求摘要，生成分卷分章大纲。\n\n'+
'## 输出格式\n'+
'请严格输出以下JSON格式（不要加任何解释文字）：\n'+
'```json\n'+
'{\n'+
'  "总体大纲": "200字以内的小说总体剧情走向描述",\n'+
'  "卷": [\n'+
'    {\n'+
'      "卷名": "第一卷：开端",\n'+
'      "卷概要": "100字以内，本卷的主要剧情走向",\n'+
'      "章": [\n'+
'        { "章名": "第1章 山洞奇遇", "概要": "50字以内，本章核心剧情", "关键事件": ["事件1","事件2"], "涉及角色": ["主角","配角"] },\n'+
'        { "章名": "第2章 初入宗门", "概要": "50字以内", "关键事件": [], "涉及角色": [] }\n'+
'      ]\n'+
'    }\n'+
'  ]\n'+
'}\n'+
'```\n\n'+
'## 要求\n'+
'- 根据目标字数计算大概卷数和章数（每章约3000-5000字）\n'+
'- 第一卷的前3章需要写得特别详细（吸引读者）\n'+
'- 每个关键事件应该有推进剧情的作用\n'+
'- 章名可以简洁但不能空洞';

function callOutlineLLM(projectId, userId, systemPrompt, userContent, agentType, callback) {
    var llmAgent = queryOne('SELECT * FROM agents WHERE user_id=? ORDER BY id LIMIT 1', [userId]);
    if (!llmAgent || !llmAgent.api_key) { callback({ error:'请先在智能体管理页面配置至少一个AI模型' }); return; }
    var agentConfig = queryOne('SELECT * FROM writing_agent_config WHERE project_id=? AND agent_type=?', [projectId, agentType]);
    var model = (agentConfig && agentConfig.model_name) || llmAgent.model || 'deepseek-v4-pro';
    var reqBody = { model:model, messages:[{ role:'system', content:systemPrompt },{ role:'user', content:userContent }], temperature:0.6, stream:false };
    console.log('[Writing '+agentType+'] 调用 model='+model+' prompt长度='+userContent.length);
    dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content) VALUES (?,?,?,?)', [projectId, agentType, 'user', userContent]);
    fetch(llmAgent.api_endpoint, {
        method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+llmAgent.api_key},
        body:JSON.stringify(reqBody)
    }).then(function(r){ return r.json(); }).then(function(d) {
        var reply = (d.choices && d.choices[0] && d.choices[0].message) ? d.choices[0].message.content : '';
        if (!reply) { console.log('[Writing '+agentType+'] 空响应'); callback({ error:'模型未返回内容' }); return; }
        var tokIn = (d.usage && d.usage.prompt_tokens)||0, tokOut = (d.usage && d.usage.completion_tokens)||0;
        console.log('[Writing '+agentType+'] 回复长度='+reply.length+' tokens in='+tokIn+' out='+tokOut);
        dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content, token_used) VALUES (?,?,?,?,?)', [projectId, agentType, 'assistant', reply, tokIn+tokOut]);
        dbRun('INSERT INTO token_usage_logs (user_id, project_id, agent_type, model, input_tokens, output_tokens) VALUES (?,?,?,?,?,?)', [userId, projectId, agentType, model, tokIn, tokOut]);
        saveDB();
        callback({ content:reply, token_in:tokIn, token_out:tokOut });
    }).catch(function(err) {
        console.error('[Writing '+agentType+'] 调用失败:',err.message);
        callback({ error:err.message });
    });
}

app.post('/api/writing-projects/:id/generate-outline', auth, (req, res) => {
    const projectId = parseInt(req.params.id);
    var proj = queryOne('SELECT * FROM writing_projects WHERE id=? AND user_id=?', [projectId, req.userId]);
    if (!proj) return res.status(404).json({ error:'项目不存在' });
    console.log('[Writing 大纲] 项目='+projectId+' 开始生成大纲');

    // 收集上下文：项目信息 + 最近对话
    var context = '项目信息：\n';
    context += '- 标题：'+proj.title+'\n';
    context += '- 类型：'+(proj.genre||'未定')+' '+(proj.sub_genre||'')+'\n';
    context += '- 目标字数：'+(proj.target_words||'未定')+'\n';
    context += '- 风格参考：'+(proj.style_ref||'无')+'\n\n';

    var history = queryAll('SELECT * FROM agent_conversations WHERE project_id=? ORDER BY created_at ASC LIMIT 200', [projectId]);
    context += '用户与主Agent对话记录：\n';
    history.forEach(function(m) {
        if (m.role==='user') context += '用户：'+m.content+'\n';
        else if (m.role==='assistant' && m.agent_type==='orchestrator') context += '主Agent：'+m.content+'\n';
    });
    context += '\n请根据以上信息生成完整的小说大纲（分卷分章）。';

    callOutlineLLM(projectId, req.userId, OUTLINER_SYSTEM, context, 'outliner', function(result) {
        if (result.error) return res.status(500).json({ error:result.error });
        res.json(result);
    });
});

// ==================== 卷/章 CRUD ====================
app.get('/api/writing-projects/:id/volumes', auth, (req, res) => {
    const vols = queryAll('SELECT * FROM writing_volumes WHERE project_id=? ORDER BY sort_order', [req.params.id]);
    res.json(vols);
});
app.post('/api/writing-projects/:id/volumes', auth, (req, res) => {
    const { title } = req.body;
    const projectId = parseInt(req.params.id);
    const maxV = queryOne('SELECT MAX(volume_no) as mx FROM writing_volumes WHERE project_id=?', [projectId]);
    const vno = (maxV && maxV.mx ? maxV.mx+1 : 1);
    const id = dbRun('INSERT INTO writing_volumes (project_id, volume_no, title, sort_order) VALUES (?,?,?,?)', [projectId, vno, title||('第'+vno+'卷'), vno]);
    saveDB();
    console.log('[Writing] 新建卷 id='+id+' no='+vno+' title='+(title||'第'+vno+'卷'));
    res.json({ id, volume_no:vno, title:title||'第'+vno+'卷' });
});
app.put('/api/writing-projects/:id/volumes/:vid', auth, (req, res) => {
    const { title, summary, status } = req.body;
    var sets=[], params=[];
    if (title!==undefined){sets.push('title=?');params.push(title);}
    if (summary!==undefined){sets.push('summary=?');params.push(summary);}
    if (status!==undefined){sets.push('status=?');params.push(status);}
    if (sets.length){params.push(req.params.vid);dbRun('UPDATE writing_volumes SET '+sets.join(',')+' WHERE id=?',params);saveDB();}
    res.json({ ok:true });
});
app.delete('/api/writing-projects/:id/volumes/:vid', auth, (req, res) => {
    dbRun('DELETE FROM writing_chapters WHERE volume_id=?', [req.params.vid]);
    dbRun('DELETE FROM writing_volumes WHERE id=?', [req.params.vid]);
    saveDB();
    console.log('[Writing] 删除卷 id='+req.params.vid);
    res.json({ ok:true });
});

app.get('/api/writing-projects/:id/chapters', auth, (req, res) => {
    const chapters = queryAll('SELECT * FROM writing_chapters WHERE project_id=? ORDER BY chapter_no', [req.params.id]);
    res.json(chapters);
});
app.post('/api/writing-projects/:id/chapters', auth, (req, res) => {
    const { title, volume_id } = req.body;
    const projectId = parseInt(req.params.id);
    const maxC = queryOne('SELECT MAX(chapter_no) as mx FROM writing_chapters WHERE project_id=?', [projectId]);
    const cno = (maxC && maxC.mx ? maxC.mx+1 : 1);
    const id = dbRun('INSERT INTO writing_chapters (project_id, volume_id, chapter_no, title) VALUES (?,?,?,?)', [projectId, volume_id||null, cno, title||('第'+cno+'章')]);
    saveDB();
    console.log('[Writing] 新建章 id='+id+' no='+cno+' title='+(title||''));
    res.json({ id, chapter_no:cno, title:title||'第'+cno+'章' });
});
app.put('/api/writing-projects/:id/chapters/:cid', auth, (req, res) => {
    const { title, content_text, word_count, status } = req.body;
    var sets=[], params=[];
    if (title!==undefined){sets.push('title=?');params.push(title);}
    if (content_text!==undefined){sets.push('content_text=?');params.push(content_text);}
    if (word_count!==undefined){sets.push('word_count=?');params.push(word_count);}
    if (status!==undefined){sets.push('status=?');params.push(status);}
    if (sets.length){sets.push('updated_at=CURRENT_TIMESTAMP');params.push(req.params.cid);dbRun('UPDATE writing_chapters SET '+sets.join(',')+' WHERE id=?',params);saveDB();}
    res.json({ ok:true });
});
app.get('/api/writing-projects/:id/token-stats', auth, (req, res) => {
    var today = new Date().toISOString().substring(0,10);
    var todayTokens = queryOne('SELECT SUM(input_tokens+output_tokens) as total FROM token_usage_logs WHERE project_id=? AND created_at>=?', [req.params.id, today]);
    var pricing = queryOne('SELECT * FROM token_pricing_config WHERE (user_id=? OR user_id IS NULL) AND is_default=1 LIMIT 1', [req.userId]);
    var model = pricing ? pricing.model_name : '';
    var inpPrice = pricing ? pricing.input_price_per_million * (pricing.discount_rate||1) : 0;
    var outPrice = pricing ? pricing.output_price_per_million * (pricing.discount_rate||1) : 0;
    var todayCount = (todayTokens && todayTokens.total) || 0;
    var cost = (todayCount/1000000) * ((inpPrice+outPrice)/2);
    res.json({ today:todayCount, model:model, cost:cost, inputPrice:inpPrice, outputPrice:outPrice });
});
app.delete('/api/writing-projects/:id/chapters/:cid', auth, (req, res) => {
    dbRun('DELETE FROM writing_chapters WHERE id=?', [req.params.cid]);
    saveDB();
    console.log('[Writing] 删除章 id='+req.params.cid);
    res.json({ ok:true });
});

// ==================== 写作 SSE ====================
var writeSseClients = {};  // projectId → Set<response>

app.get('/api/write-sse', (req, res) => {
    var t = req.query.token;
    if (!t) return res.status(401).json({ error:'未登录' });
    var d;
    try { d = jwt.verify(t, JWT_SECRET); }
    catch(e) { return res.status(401).json({ error:'登录过期' }); }
    var projectId = parseInt(req.query.projectId);
    if (!projectId) return res.status(400).json({ error:'缺少projectId' });

    res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Connection':'keep-alive' });
    res.write('data: {"type":"connected","projectId":'+projectId+'}\n\n');

    if (!writeSseClients[projectId]) writeSseClients[projectId] = new Set();
    writeSseClients[projectId].add(res);

    req.on('close', function() {
        var s = writeSseClients[projectId];
        if (s) { s.delete(res); if (s.size===0) delete writeSseClients[projectId]; }
    });
});

function broadcastWriteEvent(projectId, data) {
    var s = writeSseClients[projectId];
    if (!s) return;
    var json = JSON.stringify(data);
    s.forEach(function(c) { try { c.write('data: '+json+'\n\n'); } catch(e) {} });
    // 清理断连
    s.forEach(function(c) { if (c.destroyed) s.delete(c); });
}

// ==================== 画布数据（按 projectId） ====================

app.get('/api/canvas', auth, withProject, (req, res) => {
    const p = queryOne('SELECT data, default_style_id FROM projects WHERE id = ? AND user_id = ?', [req.projectId, req.userId]);
    if (!p) return res.status(404).json({ error: '项目不存在' });
    try { var d = JSON.parse(p.data); d.defaultStyleId = p.default_style_id; res.json(d); } catch (e) { res.json({ notes: [], mediaNodes: [], connections: [] }); }
});

app.put('/api/canvas', auth, withProject, (req, res) => {
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: '缺少数据' });
    const jsonData = JSON.stringify(data);
    dbRun('UPDATE projects SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?', [jsonData, req.projectId, req.userId]);
    saveDB();
    res.json({ ok: true });
});

// ==================== 版本历史（按 projectId） ====================

app.post('/api/canvas/version', auth, withProject, (req, res) => {
    const { data, label } = req.body;
    if (!data) return res.status(400).json({ error: '缺少数据' });
    dbRun('INSERT INTO canvas_versions (user_id, project_id, data, label) VALUES (?, ?, ?, ?)', [req.userId, req.projectId, JSON.stringify(data), label || '']);
    saveDB();
    const v = queryOne('SELECT id, label, created_at FROM canvas_versions WHERE user_id = ? AND project_id = ? ORDER BY id DESC LIMIT 1', [req.userId, req.projectId]);
    res.json(v || { ok: true });
});

app.get('/api/canvas/versions', auth, withProject, (req, res) => {
    var date = req.query.date, offset = parseInt(req.query.offset)||0, limit = Math.min(parseInt(req.query.limit)||15, 50);
    var where = 'user_id=? AND project_id=?', params = [req.userId, req.projectId];
    if (date) { where += " AND date(created_at)=?"; params.push(date); }
    var total = queryOne('SELECT COUNT(*) AS cnt FROM canvas_versions WHERE '+where, params);
    var rows = queryAll('SELECT id, label, created_at FROM canvas_versions WHERE '+where+' ORDER BY id DESC LIMIT ? OFFSET ?', params.concat([limit, offset]));
    res.json({ rows:rows, total:total?total.cnt:0, hasMore:offset+limit < (total?total.cnt:0) });
});

app.get('/api/canvas/version-dates', auth, withProject, (req, res) => {
    var dates = queryAll("SELECT DISTINCT date(created_at) AS dt FROM canvas_versions WHERE user_id=? AND project_id=? ORDER BY dt DESC", [req.userId, req.projectId]);
    res.json(dates.map(function(d){return d.dt;}));
});

app.get('/api/canvas/version/:id', auth, (req, res) => {
    const v = queryOne('SELECT data, label, created_at FROM canvas_versions WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (!v) return res.status(404).json({ error: '版本不存在' });
    try { res.json({ data: JSON.parse(v.data), label: v.label, createdAt: v.created_at }); } catch (e) { res.status(500).json({ error: '数据损坏' }); }
});

app.delete('/api/canvas/version/:id', auth, (req, res) => {
    dbRun('DELETE FROM canvas_versions WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    saveDB();
    res.json({ ok: true });
});

// ==================== 置顶自动存档（按 projectId） ====================

app.get('/api/canvas/pinned', auth, (req, res) => {
    const pid = req.query.projectId;
    if (!pid) return res.json(null);
    const p = queryOne('SELECT data, updated_at FROM pinned_snapshot WHERE user_id = ? AND project_id = ?', [req.userId, parseInt(pid)]);
    if (!p) return res.json(null);
    try { res.json({ data: JSON.parse(p.data), updatedAt: p.updated_at }); } catch (e) { res.json(null); }
});

app.put('/api/canvas/pinned', auth, (req, res) => {
    const { data, projectId } = req.body;
    if (!data || !projectId) return res.status(400).json({ error: '缺少数据或 projectId' });
    const jsonData = JSON.stringify(data);
    const existing = queryOne('SELECT user_id FROM pinned_snapshot WHERE user_id = ? AND project_id = ?', [req.userId, projectId]);
    if (existing) dbRun('UPDATE pinned_snapshot SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND project_id = ?', [jsonData, req.userId, projectId]);
    else dbRun('INSERT INTO pinned_snapshot (user_id, project_id, data) VALUES (?, ?, ?)', [req.userId, projectId, jsonData]);
    res.json({ ok: true });
});

// ==================== 智能体管理 ====================

app.get('/api/agents', auth, (req, res) => {
    const agents = queryAll('SELECT id, name, model, api_endpoint, system_prompt, temperature, max_tokens, max_tokens_enabled, share_code, created_at FROM agents WHERE user_id = ? ORDER BY id', [req.userId]);
    res.json(agents.map(a => ({ ...a, api_key: a.api_key ? '***' : '' }))); // 不返回完整密钥
});

app.post('/api/agents', auth, (req, res) => {
    const { name, model, api_endpoint, api_key, system_prompt, temperature, max_tokens, max_tokens_enabled } = req.body;
    if (!name) return res.status(400).json({ error: '名称不能为空' });
    const id = dbRun('INSERT INTO agents (user_id, name, model, api_endpoint, api_key, system_prompt, temperature, max_tokens, max_tokens_enabled) VALUES (?,?,?,?,?,?,?,?,?)',
        [req.userId, name, model||'gpt-4o', api_endpoint||'https://api.openai.com/v1/chat/completions', api_key||'', system_prompt||'', temperature||0, max_tokens||16384, max_tokens_enabled||0]);
    res.json({ id, name });
});

app.put('/api/agents/:id', auth, (req, res) => {
    const { name, model, api_endpoint, api_key, system_prompt, temperature, max_tokens, max_tokens_enabled } = req.body;
    const fields = []; const params = [];
    if (name !== undefined) { fields.push('name=?'); params.push(name); }
    if (model !== undefined) { fields.push('model=?'); params.push(model); }
    if (api_endpoint !== undefined) { fields.push('api_endpoint=?'); params.push(api_endpoint); }
    if (api_key !== undefined && api_key !== '***') { fields.push('api_key=?'); params.push(api_key); }
    if (system_prompt !== undefined) { fields.push('system_prompt=?'); params.push(system_prompt); }
    if (temperature !== undefined) { fields.push('temperature=?'); params.push(temperature); }
    if (max_tokens !== undefined) { fields.push('max_tokens=?'); params.push(max_tokens); }
    if (max_tokens_enabled !== undefined) { fields.push('max_tokens_enabled=?'); params.push(max_tokens_enabled ? 1 : 0); }
    if (fields.length > 0) { params.push(req.params.id, req.userId); dbRun('UPDATE agents SET '+fields.join(',')+' WHERE id=? AND user_id=?', params); saveDB(); }
    res.json({ ok: true });
});

app.delete('/api/agents/:id', auth, (req, res) => {
    dbRun('DELETE FROM agents WHERE id=? AND user_id=?', [req.params.id, req.userId]); saveDB();
    res.json({ ok: true });
});

// 生成分享码
app.post('/api/agents/:id/share', auth, (req, res) => {
    var agent = queryOne('SELECT * FROM agents WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (!agent) return res.status(404).json({ error: '智能体不存在' });
    if (agent.share_code) return res.json({ shareCode: agent.share_code });
    // 生成: 模型名(取前8字符无空格) + 16位随机
    var modelPart = agent.model.replace(/[^a-zA-Z0-9]/g, '').substring(0, 8);
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var random = '';
    for (var i = 0; i < 16; i++) random += chars[Math.floor(Math.random() * chars.length)];
    var code = modelPart + random;
    dbRun('UPDATE agents SET share_code=? WHERE id=?', [code, agent.id]); saveDB();
    res.json({ shareCode: code });
});

// 通过分享码导入智能体
app.post('/api/agents/import', auth, (req, res) => {
    var { shareCode, name } = req.body;
    if (!shareCode) return res.status(400).json({ error: '缺少分享码' });
    var agent = queryOne('SELECT * FROM agents WHERE share_code=?', [shareCode]);
    if (!agent) return res.status(404).json({ error: '分享码无效或智能体不存在' });
    // 导入：复制提示词和参数，不包含API key
    var newName = name || (agent.name + ' (分享)');
    var newId = dbRun('INSERT INTO agents (user_id, name, model, api_endpoint, api_key, system_prompt, temperature, max_tokens, max_tokens_enabled) VALUES (?,?,?,?,?,?,?,?,?)',
        [req.userId, newName, agent.model, agent.api_endpoint, '', agent.system_prompt, agent.temperature, agent.max_tokens, agent.max_tokens_enabled || 0]);
    saveDB();
    res.json({ id: newId, name: newName, model: agent.model, prompt: agent.system_prompt ? agent.system_prompt.substring(0, 80) : '' });
});

// ==================== SKILL 库 ====================

app.get('/api/skills', auth, (req, res) => {
    const skills = queryAll('SELECT id, name, description, created_at FROM skills ORDER BY id');
    res.json(skills);
});

app.get('/api/skills/:id', auth, (req, res) => {
    const skill = queryOne('SELECT * FROM skills WHERE id=?', [req.params.id]);
    if (!skill) return res.status(404).json({ error: 'SKILL 不存在' });
    res.json(skill);
});

// ==================== 生图设置 ====================

app.get('/api/image-gen-settings', auth, (req, res) => {
    const s = queryOne('SELECT * FROM image_gen_settings WHERE user_id=?', [req.userId]);
    res.json(s || { api_key:'', api_url:'https://api.yijiarj.cn/v1/chat/completions', model:'image2', default_size:'9:16', request_interval:3 });
});

app.put('/api/image-gen-settings', auth, (req, res) => {
    const { api_key, api_url, model, default_size, request_interval } = req.body;
    const existing = queryOne('SELECT id FROM image_gen_settings WHERE user_id=?', [req.userId]);
    if (existing) {
        dbRun('UPDATE image_gen_settings SET api_key=?, api_url=?, model=?, default_size=?, request_interval=? WHERE user_id=?',
            [api_key||'', api_url||'', model||'image2', default_size||'9:16', request_interval||3, req.userId]);
    } else {
        dbRun('INSERT INTO image_gen_settings (user_id, api_key, api_url, model, default_size, request_interval) VALUES (?,?,?,?,?,?)',
            [req.userId, api_key||'', api_url||'', model||'image2', default_size||'9:16', request_interval||3]);
    }
    res.json({ ok: true });
});

// ==================== 生图 API ====================

app.post('/api/gen-image', auth, (req, res) => {
    const { prompt, refImages, size, refFrameUrl, projectId } = req.body;
    if (!prompt) return res.status(400).json({ error: '缺少提示词' });
    const settings = queryOne('SELECT * FROM image_gen_settings WHERE user_id=?', [req.userId]);
    if (!settings || !settings.api_key) return res.status(400).json({ error: '请先在设置页面配置生图 API Key' });
    console.log('[gen-image] 开始生图, prompt长度='+prompt.length+' refImages='+(refImages?refImages.length:0)+' size='+(size||settings.default_size));

    var content = [{ type:'text', text:prompt }];
    if (refImages && refImages.length) {
        var imgDesc = [];
        refImages.forEach(function(img, i) {
            if (img && img.startsWith('data:')) {
                content.push({ type:'image_url', image_url:{ url:img } });
                imgDesc.push('图'+(i+1)+'是参考图');
            }
        });
        if (imgDesc.length) {
            content[0].text = '【参考图说明】'+imgDesc.join('，')+'。请保持场景、服饰、光影、色调与参考图一致，仅按下方指令修改画面内容。\n【生成指令】'+prompt;
        }
    }

    var payload = {
        messages: [{ role:'user', content:content }],
        model: settings.model || 'image2',
        size: size || settings.default_size || '9:16'
    };

    fetch(settings.api_url || 'https://api.yijiarj.cn/v1/chat/completions', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+settings.api_key },
        body: JSON.stringify(payload)
    }).then(function(r) { return r.json(); }).then(function(d) {
        var content2 = (d.choices && d.choices[0] && d.choices[0].message) ? d.choices[0].message.content : '';
        var m = content2.match(/!\[.*?\]\((https?:\/\/[^\)]+)\)/) || content2.match(/https?:\/\/[^\s\)]+\.(?:png|jpg|jpeg|webp)/i);
        var imgUrl = m ? (m[1]||m[0]) : null;
        if (!imgUrl) { console.log('[gen-image] 未提取到图片URL, content预览:',content2.substring(0,200)); return res.json({ error:'未提取到图片URL', raw:content2 }); }
        console.log('[gen-image] 图片URL:',imgUrl.substring(0,80));
        var fname = 'gen_'+Date.now()+'.png';
        var fpath = path.join(UPLOAD_DIR, fname);
        var https = require('https');
        var http = require('http');
        var crypto = require('crypto');
        var proto = imgUrl.startsWith('https') ? https : http;
        proto.get(imgUrl, function(r2) {
            if (r2.statusCode >= 300 && r2.statusCode < 400 && r2.headers.location) {
                proto = r2.headers.location.startsWith('https') ? https : http;
                proto.get(r2.headers.location, function(r3) {
                    var hash = crypto.createHash('md5');
                    var ws = fs.createWriteStream(fpath);
                    r3.pipe(ws); r3.pipe(hash);
                    ws.on('finish', function() {
                        var md5 = hash.digest('hex');
                        dbRun('INSERT INTO assets (user_id, project_id, original_name, stored_name, mime_type, size, md5) VALUES (?,?,?,?,?,?,?)',
                            [req.userId, projectId||null, fname, fname, 'image/png', fs.statSync(fpath).size, md5]);
                        saveDB();
                        res.json({ url:'/uploads/'+fname, raw:content2 });
                    });
                });
                return;
            }
            var hash = crypto.createHash('md5');
            var ws = fs.createWriteStream(fpath);
            r2.pipe(ws); r2.pipe(hash);
            ws.on('finish', function() {
                var md5 = hash.digest('hex');
                dbRun('INSERT INTO assets (user_id, project_id, original_name, stored_name, mime_type, size, md5) VALUES (?,?,?,?,?,?,?)',
                    [req.userId, projectId||null, fname, fname, 'image/png', fs.statSync(fpath).size, md5]);
                saveDB();
                res.json({ url:'/uploads/'+fname, raw:content2 });
            });
        }).on('error', function(err) { res.status(500).json({ error:'下载失败: '+err.message }); });
    }).catch(function(err) { res.status(500).json({ error:'API调用失败: '+err.message }); });
});

// ==================== 帧快照 ====================

app.get('/api/frame-snapshots', auth, withProject, (req, res) => {
    var rows = queryAll('SELECT id, label, frame_node_id, created_at FROM frame_snapshots WHERE project_id=? AND user_id=? ORDER BY created_at DESC', [req.projectId, req.userId]);
    res.json(rows);
});

app.get('/api/frame-snapshots/:id', auth, (req, res) => {
    var row = queryOne('SELECT * FROM frame_snapshots WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (!row) return res.status(404).json({ error:'快照不存在' });
    res.json(row);
});

app.post('/api/frame-snapshots', auth, withProject, (req, res) => {
    var { label, frame_node_id, keyframe_json } = req.body;
    if (!label || !keyframe_json || !frame_node_id) return res.status(400).json({ error:'缺少参数' });
    var id = dbRun('INSERT INTO frame_snapshots (project_id, user_id, label, frame_node_id, keyframe_json) VALUES (?,?,?,?,?)',
        [req.projectId, req.userId, label, frame_node_id, typeof keyframe_json==='string'?keyframe_json:JSON.stringify(keyframe_json)]);
    res.json({ id:id, ok:true });
});

app.delete('/api/frame-snapshots/:id', auth, (req, res) => {
    dbRun('DELETE FROM frame_snapshots WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    res.json({ ok:true });
});

// ==================== 风格管理 ====================

// SSE 实时事件流（token 经 query 传入，因 EventSource 不支持自定义 header）
app.get('/api/styles/events', (req, res) => {
    var t = req.query.token;
    if (!t) return res.status(401).json({ error:'未登录' });
    try { var d = jwt.verify(t, JWT_SECRET); req.userId = d.userId; req.username = d.username; }
    catch(e) { return res.status(401).json({ error:'登录过期' }); }
    res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Connection':'keep-alive' });
    res.write('data: {"type":"connected"}\n\n');
    sseClients.push(res);
    req.on('close', function() { sseClients = sseClients.filter(function(c) { return c !== res; }); });
});

// SSE 端点：通用通知（互踢等）
app.get('/api/sse', (req, res) => {
    var t = req.query.token;
    if (!t) return res.status(401).json({ error:'未登录' });
    var d;
    try { d = jwt.verify(t, JWT_SECRET); }
    catch(e) { return res.status(401).json({ error:'登录过期' }); }
    // 检查 session_token 是否匹配
    var user = queryOne('SELECT session_token FROM users WHERE id=?', [d.userId]);
    if (!user) return res.status(401).json({ error:'用户不存在' });
    if (user.session_token && d.session_token !== user.session_token) {
        // 已被踢出 → 返回 kicked 事件后关闭
        res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Connection':'keep-alive' });
        res.write('data: {"type":"kicked","message":"已在其他设备登录"}\n\n');
        res.end();
        return;
    }
    res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Connection':'keep-alive' });
    res.write('data: {"type":"connected"}\n\n');
    addUserSse(d.userId, res);
    req.on('close', function() { removeUserSse(d.userId, res); });
});

// 我的风格列表（内置 + 自己创建的 + 收藏的）
app.get('/api/styles/my', auth, (req, res) => {
    var rows = queryAll("SELECT * FROM image_styles WHERE is_builtin=1 OR user_id=? ORDER BY is_builtin DESC, id", [req.userId]);
    res.json(rows);
});

// 创建风格
app.post('/api/styles', auth, (req, res) => {
    var { name, description, prompt_suffix, cover_url } = req.body;
    if (!name || !prompt_suffix) return res.status(400).json({ error:'缺少名称或提示词' });
    var id = dbRun('INSERT INTO image_styles (user_id, name, description, prompt_suffix, cover_url) VALUES (?,?,?,?,?)', [req.userId, name, description||'', prompt_suffix, cover_url||'']);
    console.log('[风格] 用户'+req.userId+'创建: '+name);
    broadcastStyleEvent({ type:'style-created', styleId:id, userId:req.userId, name:name });
    res.json({ id, ok:true });
});

// 编辑风格
app.put('/api/styles/:id', auth, (req, res) => {
    var row = queryOne('SELECT * FROM image_styles WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (!row) return res.status(403).json({ error:'无权编辑' });
    var { name, description, prompt_suffix, cover_url } = req.body;
    dbRun("UPDATE image_styles SET name=COALESCE(?,name), description=COALESCE(?,description), prompt_suffix=COALESCE(?,prompt_suffix), cover_url=COALESCE(?,cover_url) WHERE id=?",
        [name, description, prompt_suffix, cover_url, req.params.id]);
    console.log('[风格] 编辑 #'+req.params.id);
    broadcastStyleEvent({ type:'style-updated', styleId:parseInt(req.params.id), userId:req.userId });
    res.json({ ok:true });
});

// 删除风格（只能删自己非内置的）
app.delete('/api/styles/:id', auth, (req, res) => {
    var row = queryOne('SELECT * FROM image_styles WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error:'不存在' });
    if (row.is_builtin) return res.status(403).json({ error:'内置风格不可删除' });
    if (row.user_id !== req.userId) return res.status(403).json({ error:'无权删除' });
    dbRun('DELETE FROM image_styles WHERE id=?', [req.params.id]);
    dbRun('DELETE FROM style_comments WHERE style_id=?', [req.params.id]);
    dbRun('DELETE FROM style_likes WHERE style_id=?', [req.params.id]);
    console.log('[风格] 删除 #'+req.params.id);
    broadcastStyleEvent({ type:'style-deleted', styleId:parseInt(req.params.id), userId:req.userId });
    res.json({ ok:true });
});

// 发布/取消发布
app.put('/api/styles/:id/publish', auth, (req, res) => {
    var row = queryOne('SELECT * FROM image_styles WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (!row) return res.status(403).json({ error:'无权操作' });
    var pub = req.body.publish ? 1 : 0;
    dbRun('UPDATE image_styles SET is_published=? WHERE id=?', [pub, req.params.id]);
    console.log('[风格] '+(pub?'发布':'取消发布')+' #'+req.params.id);
    broadcastStyleEvent({ type:pub?'style-published':'style-unpublished', styleId:parseInt(req.params.id), userId:req.userId });
    res.json({ ok:true });
});

// 风格市场（所有已发布的非内置风格）
app.get('/api/styles/market', auth, (req, res) => {
    var rows = queryAll("SELECT s.*, u.username FROM image_styles s LEFT JOIN users u ON s.user_id=u.id WHERE s.is_published=1 AND s.is_builtin=0 ORDER BY s.id DESC", []);
    res.json(rows);
});

// 收藏（复制副本到自己名下）
app.post('/api/styles/:id/collect', auth, (req, res) => {
    var row = queryOne('SELECT * FROM image_styles WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error:'不存在' });
    if (row.user_id === req.userId) return res.status(400).json({ error:'不能收藏自己的风格' });
    var newId = dbRun('INSERT INTO image_styles (user_id, name, description, prompt_suffix) VALUES (?,?,?,?)',
        [req.userId, row.name+' (收藏)', row.description, row.prompt_suffix]);
    console.log('[风格] 用户'+req.userId+' 收藏 #'+req.params.id+' → 新 #'+newId);
    broadcastStyleEvent({ type:'style-collected', styleId:parseInt(req.params.id), userId:req.userId });
    res.json({ id:newId, ok:true });
});

// ==================== 评论 ====================

app.get('/api/styles/:id/comments', auth, (req, res) => {
    var rows = queryAll("SELECT c.*, u.username FROM style_comments c LEFT JOIN users u ON c.user_id=u.id WHERE c.style_id=? ORDER BY c.created_at", [req.params.id]);
    res.json(rows);
});

app.post('/api/styles/:id/comments', auth, (req, res) => {
    var { content, parent_id } = req.body;
    if (!content) return res.status(400).json({ error:'内容不能为空' });
    var cid = dbRun('INSERT INTO style_comments (style_id, user_id, parent_id, content) VALUES (?,?,?,?)',
        [req.params.id, req.userId, parent_id||null, content]);
    console.log('[评论] 用户'+req.userId+' 在风格#'+req.params.id+' 评论#'+cid);
    broadcastStyleEvent({ type:'comment-added', styleId:parseInt(req.params.id), userId:req.userId });
    res.json({ id:cid, ok:true });
});

// ==================== 点赞 ====================

app.put('/api/styles/:id/like', auth, (req, res) => {
    var vote = parseInt(req.body.vote) || 1; // 1=赞, -1=踩
    var existing = queryOne('SELECT * FROM style_likes WHERE style_id=? AND user_id=?', [req.params.id, req.userId]);
    if (existing) {
        dbRun('UPDATE style_likes SET vote=? WHERE style_id=? AND user_id=?', [vote, req.params.id, req.userId]);
    } else {
        dbRun('INSERT INTO style_likes (style_id, user_id, vote) VALUES (?,?,?)', [req.params.id, req.userId, vote]);
    }
    var stats = queryOne('SELECT SUM(CASE WHEN vote=1 THEN 1 ELSE 0 END) AS likes, SUM(CASE WHEN vote=-1 THEN 1 ELSE 0 END) AS dislikes FROM style_likes WHERE style_id=?', [req.params.id]);
    broadcastStyleEvent({ type:'like-updated', styleId:parseInt(req.params.id), userId:req.userId, likes:stats.likes||0, dislikes:stats.dislikes||0 });
    res.json({ ok:true, likes: stats.likes||0, dislikes: stats.dislikes||0 });
});

app.get('/api/styles/:id/like-stats', auth, (req, res) => {
    var myVote = queryOne('SELECT vote FROM style_likes WHERE style_id=? AND user_id=?', [req.params.id, req.userId]);
    var stats = queryOne('SELECT SUM(CASE WHEN vote=1 THEN 1 ELSE 0 END) AS likes, SUM(CASE WHEN vote=-1 THEN 1 ELSE 0 END) AS dislikes FROM style_likes WHERE style_id=?', [req.params.id]);
    res.json({ myVote: myVote?myVote.vote:0, likes: stats.likes||0, dislikes: stats.dislikes||0 });
});

// 风格详情（通配 :id 放最后）
app.get('/api/styles/:id', auth, (req, res) => {
    var row = queryOne('SELECT * FROM image_styles WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error:'风格不存在' });
    res.json(row);
});

// 项目默认风格
app.put('/api/project-style', auth, (req, res) => {
    var { projectId, styleId } = req.body;
    if (!projectId) return res.status(400).json({ error:'缺少projectId' });
    dbRun('UPDATE projects SET default_style_id=? WHERE id=? AND user_id=?', [styleId||null, projectId, req.userId]);
    res.json({ ok:true });
});

// ==================== LLM 代理调用 ====================

app.post('/api/llm/call', auth, (req, res) => {
    const { agentId, messages, skillId } = req.body;
    if (!agentId && !messages) return res.status(400).json({ error: '缺少参数' });
    const agent = agentId ? queryOne('SELECT * FROM agents WHERE id=? AND user_id=?', [agentId, req.userId]) : null;
    var endpoint, key, model, sysPrompt, temp, maxTok;
    if (agent) {
        endpoint = agent.api_endpoint; key = agent.api_key; model = agent.model;
        sysPrompt = agent.system_prompt; temp = agent.temperature; maxTok = agent.max_tokens;
    } else {
        return res.status(400).json({ error: '智能体不存在' });
    }
    // 如果指定了 SKILL，将其内容拼入 system prompt 最前面
    var skillSystem = '';
    if (skillId) {
        var skill = queryOne('SELECT * FROM skills WHERE id=?', [skillId]);
        if (skill) {
            skillSystem = '【必须严格遵循以下规范】\n\n' + skill.content;
            if (skill.json_schema) {
                try {
                    var schemaObj = JSON.parse(skill.json_schema);
                    skillSystem += '\n\n【参考输出结构 - 请按此 JSON 格式输出】\n```json\n' + JSON.stringify(schemaObj, null, 2) + '\n```\n\n请直接输出符合上述结构的 JSON，不要加任何解释文字。';
                } catch(e) {}
            }
            skillSystem += '\n\n---\n\n';
        }
    }
    var msgs = [];
    if (skillSystem) msgs.push({ role: 'system', content: skillSystem + (sysPrompt || '') });
    else if (sysPrompt) msgs.push({ role: 'system', content: sysPrompt });
    if (messages) msgs = msgs.concat(messages);

    // DeepSeek 模型：推理强度拉满 + thinking 模式
    var isDS = model && model.toLowerCase().indexOf('deepseek') >= 0;
    var finalTemp = isDS ? 0 : temp;
    var maxTokEnabled = agent.max_tokens_enabled === 1;

    var reqBody = { model: model, messages: msgs, temperature: finalTemp, stream: false };
    if (maxTokEnabled) reqBody.max_tokens = isDS ? Math.max(maxTok, 16384) : maxTok;
    if (isDS) {
        reqBody.thinking = { type: 'enabled' };
        reqBody.reasoning_effort = 'max';
        reqBody.top_p = 1.0;
    }

    fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify(reqBody)
    }).then(r => r.json()).then(d => {
        var content = (d.choices && d.choices[0] && d.choices[0].message) ? d.choices[0].message.content : (d.error ? d.error.message : '无响应');
        res.json({ content: content, raw: d });
    }).catch(err => {
        res.status(500).json({ error: 'LLM调用失败: ' + err.message });
    });
});

// ==================== 资产库（跨项目） ====================

app.get('/api/assets', auth, (req, res) => {
    const offset = parseInt(req.query.offset) || 0;
    const limit = Math.min(parseInt(req.query.limit) || 500, 500);
    var sql = 'SELECT id, project_id, original_name, stored_name, mime_type, size, md5, source_node_id, created_at FROM assets WHERE user_id=? AND is_deleted=0';
    var params = [req.userId];
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'; params.push(limit, offset);
    const assets = queryAll(sql, params);
    res.json(assets.map(a => ({ ...a, url: '/uploads/' + a.stored_name })));
});

// MD5 去重查询（上传前检查）
app.get('/api/assets/check-md5', auth, (req, res) => {
    const md5 = req.query.md5;
    if (!md5) return res.status(400).json({ error: '缺少 md5' });
    const a = queryOne('SELECT id, stored_name, mime_type, size, created_at FROM assets WHERE md5=? AND user_id=? AND is_deleted=0 LIMIT 1', [md5, req.userId]);
    if (a) res.json({ exists: true, url: '/uploads/' + a.stored_name, id: a.id });
    else res.json({ exists: false });
});

app.post('/api/assets', auth, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '没有文件' });
    const projectId = req.body.projectId ? parseInt(req.body.projectId) : null;
    const sourceNodeId = req.body.sourceNodeId || null;
    const md5 = req.body.md5 || '';
    const f = req.file;
    var newId = dbRun('INSERT INTO assets (user_id, project_id, original_name, stored_name, mime_type, size, source_node_id, md5) VALUES (?,?,?,?,?,?,?,?)',
        [req.userId, projectId, f.originalname, f.filename, f.mimetype, f.size, sourceNodeId, md5]);
    saveDB();
    res.json({ id: newId, url: '/uploads/' + f.filename, name: f.originalname });
});

app.delete('/api/assets/:id', auth, (req, res) => {
    const asset = queryOne('SELECT stored_name FROM assets WHERE id=? AND user_id=? AND is_deleted=0', [req.params.id, req.userId]);
    if (!asset) return res.status(404).json({ error: '资产不存在' });
    console.log('[资产删除] id='+req.params.id+' file='+asset.stored_name);
    const projects = queryAll('SELECT id, data FROM projects WHERE user_id=?', [req.userId]);
    var removed = 0;
    var removedNodeIds = [];
    var targetUrl = '/uploads/' + asset.stored_name;
    projects.forEach(function(p) {
        try {
            var data = JSON.parse(p.data);
            if (!data || !data.mediaNodes) return;
            var found = false;
            var keepNodes = [];
            data.mediaNodes.forEach(function(n) {
                if (n.src === targetUrl) { found = true; removed++; removedNodeIds.push(n.id); }
                else { keepNodes.push(n); }
            });
            data.mediaNodes = keepNodes;
            if (found && data.connections) {
                var nodeIds = new Set(data.mediaNodes.map(function(n) { return n.id; }));
                data.connections = data.connections.filter(function(c) {
                    return nodeIds.has(c.sourceId) && nodeIds.has(c.targetId);
                });
            }
            if (found) {
                console.log('[资产删除] 项目'+p.id+' 移除节点: '+removedNodeIds.join(','));
                dbRun('UPDATE projects SET data=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [JSON.stringify(data), p.id]);
            }
        } catch(e) { console.error('[资产删除] 项目'+p.id+' 处理失败:',e); }
    });
    console.log('[资产删除] 共移除 '+removed+' 个节点, IDs='+JSON.stringify(removedNodeIds));
    var fpath = path.join(UPLOAD_DIR, asset.stored_name);
    try { fs.unlinkSync(fpath); console.log('[资产删除] 文件已删除: '+fpath); } catch(e) { console.error('[资产删除] 删除文件失败:',e.message); }
    dbRun('DELETE FROM assets WHERE id=?', [req.params.id]);
    saveDB();
    res.json({ ok: true, removedFromProjects: removed, removedNodeIds: removedNodeIds });
});

// ==================== 文件上传 ====================
app.post('/api/upload', auth, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '没有文件' });
    const f = req.file;
    const fileId = dbRun('INSERT INTO files (user_id, original_name, stored_name, mime_type, size) VALUES (?, ?, ?, ?, ?)', [req.userId, f.originalname, f.filename, f.mimetype, f.size]);
    res.json({ id: fileId, url: '/uploads/' + f.filename, originalName: f.originalname, mimeType: f.mimetype, size: f.size });
});

// 封面上传（校验 10MB + 16:9 比例）
var coverUpload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });
app.post('/api/upload-cover', auth, coverUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '没有文件' });
    var f = req.file;
    // 读取图片尺寸
    try {
        var buf = fs.readFileSync(f.path);
        var dims = getImageDimensions(buf, f.mimetype);
        if (!dims) {
            fs.unlinkSync(f.path);
            return res.status(400).json({ error: '无法读取图片尺寸' });
        }
        var ratio = dims.width / dims.height;
        var target = 16 / 9; // ~1.778
        if (Math.abs(ratio - target) > 0.04) { // 允许±2%误差
            fs.unlinkSync(f.path);
            return res.status(400).json({ error: '封面必须是 16:9 比例，当前为 ' + dims.width + 'x' + dims.height + ' (比例: ' + ratio.toFixed(2) + ')' });
        }
        console.log('[封面上传] '+f.originalname+' '+dims.width+'x'+dims.height+' 比例ok');
    } catch(e) { fs.unlinkSync(f.path); return res.status(500).json({ error: '读取图片失败' }); }
    var fileId = dbRun('INSERT INTO files (user_id, original_name, stored_name, mime_type, size) VALUES (?, ?, ?, ?, ?)', [req.userId, f.originalname, f.filename, f.mimetype, f.size]);
    res.json({ id: fileId, url: '/uploads/' + f.filename });
});

function getImageDimensions(buf, mime) {
    if (mime === 'image/jpeg' || mime === 'image/jpg') {
        var i = 2;
        while (i < buf.length) {
            if (buf[i] !== 0xFF) break;
            var marker = buf[i+1];
            if (marker === 0xC0 || marker === 0xC2) {
                return { width: buf.readUInt16BE(i+7), height: buf.readUInt16BE(i+5) };
            }
            i += 2 + buf.readUInt16BE(i+2);
        }
    }
    if (mime === 'image/png') {
        if (buf[1]===0x50 && buf[2]===0x4E && buf[3]===0x47) {
            return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
        }
    }
    return null;
}

app.get('/api/files', auth, (req, res) => {
    const files = queryAll('SELECT id, original_name, stored_name, mime_type, size FROM files WHERE user_id = ? ORDER BY ROWID DESC', [req.userId]);
    res.json(files.map(f => ({ ...f, url: '/uploads/' + f.stored_name })));
});

// ==================== 启动 ====================
async function start() {
    const SQL = await initSqlJs();
    db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();

    db.run('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT DEFAULT \'新建项目\', data TEXT DEFAULT \'{}\', updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, original_name TEXT NOT NULL, stored_name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS canvas_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, project_id INTEGER NOT NULL, data TEXT NOT NULL, label TEXT DEFAULT \'\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS pinned_snapshot (user_id INTEGER NOT NULL, project_id INTEGER NOT NULL, data TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, project_id))');
    db.run('CREATE TABLE IF NOT EXISTS agents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, model TEXT DEFAULT \'gpt-4o\', api_endpoint TEXT DEFAULT \'https://api.openai.com/v1/chat/completions\', api_key TEXT DEFAULT \'\', system_prompt TEXT DEFAULT \'\', temperature REAL DEFAULT 0.0, max_tokens INTEGER DEFAULT 16384, max_tokens_enabled INTEGER DEFAULT 0, share_code TEXT UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS assets (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, project_id INTEGER, original_name TEXT NOT NULL, stored_name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, is_deleted INTEGER DEFAULT 0, source_node_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS skills (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT \'\', content TEXT NOT NULL, json_schema TEXT DEFAULT \'\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS image_gen_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, api_key TEXT DEFAULT \'\', api_url TEXT DEFAULT \'https://api.yijiarj.cn/v1/chat/completions\', model TEXT DEFAULT \'image2\', default_size TEXT DEFAULT \'9:16\', request_interval REAL DEFAULT 3, FOREIGN KEY (user_id) REFERENCES users(id))');
    db.run('CREATE TABLE IF NOT EXISTS frame_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, user_id INTEGER NOT NULL, label TEXT NOT NULL, frame_node_id TEXT NOT NULL, keyframe_json TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS image_styles (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT \'\', prompt_suffix TEXT NOT NULL, is_builtin INTEGER DEFAULT 0, is_published INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS style_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, style_id INTEGER NOT NULL, user_id INTEGER NOT NULL, parent_id INTEGER DEFAULT NULL, content TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (style_id) REFERENCES image_styles(id))');
    db.run('CREATE TABLE IF NOT EXISTS style_likes (style_id INTEGER NOT NULL, user_id INTEGER NOT NULL, vote INTEGER NOT NULL DEFAULT 1, UNIQUE(style_id, user_id), FOREIGN KEY (style_id) REFERENCES image_styles(id))');

    // ==================== 写作模块表 ====================
    db.run('CREATE TABLE IF NOT EXISTS writing_projects (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT DEFAULT \'未命名写作\', genre TEXT DEFAULT \'\', sub_genre TEXT DEFAULT \'\', target_words INTEGER DEFAULT 0, style_ref TEXT DEFAULT \'\', status TEXT DEFAULT \'drafting\', branch_active TEXT DEFAULT \'main\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS writing_volumes (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, volume_no INTEGER DEFAULT 1, title TEXT DEFAULT \'\', summary TEXT DEFAULT \'\', status TEXT DEFAULT \'draft\', sort_order REAL DEFAULT 0)');
    db.run('CREATE TABLE IF NOT EXISTS writing_chapters (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, volume_id INTEGER, chapter_no INTEGER DEFAULT 1, title TEXT DEFAULT \'\', content_text TEXT DEFAULT \'\', word_count INTEGER DEFAULT 0, status TEXT DEFAULT \'draft\', branch_name TEXT DEFAULT \'main\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS writing_characters (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL, aliases TEXT DEFAULT \'\', profile_json TEXT DEFAULT \'{}\', canvas_node_ids TEXT DEFAULT \'[]\', avatar_url TEXT DEFAULT \'\', status TEXT DEFAULT \'active\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS writing_scenes (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT \'\', atmosphere TEXT DEFAULT \'\', canvas_node_ids TEXT DEFAULT \'[]\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS writing_props (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT \'\', canvas_node_ids TEXT DEFAULT \'[]\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS character_memories (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, character_id INTEGER, memory_type TEXT DEFAULT \'base_profile\', content TEXT DEFAULT \'\', importance INTEGER DEFAULT 3, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, expires_at TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS relationship_edges (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, from_character_id INTEGER, to_character_id INTEGER, relation_type TEXT DEFAULT \'custom\', description TEXT DEFAULT \'\', intensity INTEGER DEFAULT 5, status TEXT DEFAULT \'active\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS plot_timeline_events (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, event_name TEXT NOT NULL, summary TEXT DEFAULT \'\', character_ids TEXT DEFAULT \'[]\', chapter_id INTEGER, order_index REAL DEFAULT 0, branch_name TEXT DEFAULT \'main\', event_type TEXT DEFAULT \'minor\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS foreshadowing (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT \'\', status TEXT DEFAULT \'planted\', plant_chapter_id INTEGER, resolve_chapter_id INTEGER, notes TEXT DEFAULT \'\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS writing_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, branch_name TEXT DEFAULT \'main\', parent_version_id INTEGER, snapshot_json TEXT NOT NULL, message TEXT DEFAULT \'\', commit_type TEXT DEFAULT \'manual\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS writing_merge_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, source_branch TEXT, target_branch TEXT, conflicts_json TEXT DEFAULT \'[]\', resolution_json TEXT DEFAULT \'{}\', status TEXT DEFAULT \'pending\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS user_behavior_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, project_id INTEGER, action_type TEXT NOT NULL, target_type TEXT, target_id INTEGER, before_data TEXT, after_data TEXT, metadata TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS writing_quality_ratings (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, chapter_id INTEGER, user_rating INTEGER, edit_distance_ratio REAL, ai_similarity_score REAL, agent_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS optimized_skills (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name_cn TEXT NOT NULL, name_en TEXT DEFAULT \'\', description TEXT DEFAULT \'\', content TEXT NOT NULL, json_schema TEXT DEFAULT \'\', source TEXT DEFAULT \'auto_generated\', is_enabled INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');

// ==================== 爬虫Agent ====================
var CRAWLER_SYSTEM = '你是一个小说数据爬取分析助手。当前无法直接访问网页，请提示用户手动提供目标网站的小说列表信息，或者请用户授权你使用搜索工具。\n\n若用户提供了HTML内容或结构化数据，请提取：书名、作者、简介、热度/排名、字数、标签、封面URL。输出JSON格式：{"书籍":[{"书名":"","作者":"","简介":"","热度":"","字数":"","标签":"","封面":""}]}';

app.post('/api/writing-projects/:id/crawl-books', auth, (req, res) => {
    var projectId = parseInt(req.params.id);
    var { platform, html_content } = req.body;
    console.log('[Writing 爬虫] 项目='+projectId+' 平台='+(platform||'手动'));
    if (!html_content) return res.status(400).json({ error:'需要提供HTML内容' });
    callOutlineLLM(projectId, req.userId, CRAWLER_SYSTEM, '请从以下HTML提取小说信息：\n平台：'+(platform||'未知')+'\nHTML：'+html_content.substring(0, 30000), 'crawler', function(result) {
        if (result.error) return res.status(500).json({ error:result.error });
        // 尝试解析并存储
        try {
            var clean = (result.content||'').replace(/```json\s*|\s*```/g, '').trim();
            var books = JSON.parse(clean);
            if (books['书籍']) {
                books['书籍'].forEach(function(b) {
                    dbRun('INSERT INTO agent_crawler_data (project_id, platform, book_name, author, cover_url, intro, tags, status) VALUES (?,?,?,?,?,?,?,?)',
                        [projectId, platform||'', b['书名']||'', b['作者']||'', b['封面']||'', b['简介']||'', JSON.stringify(b['标签']||[]), 'pending']);
                });
                saveDB();
                console.log('[Writing 爬虫] 解析到 '+books['书籍'].length+' 本书');
            }
        } catch(e) { console.log('[Writing 爬虫] JSON解析失败:', e.message); }
        res.json({ content:result.content, parsed:true });
    });
});

app.get('/api/writing-projects/:id/crawler-data', auth, (req, res) => {
    res.json(queryAll('SELECT * FROM agent_crawler_data WHERE project_id=? ORDER BY created_at DESC LIMIT 100', [req.params.id]));
});

app.put('/api/writing-projects/:id/crawler-data/:bid', auth, (req, res) => {
    var { status } = req.body;
    dbRun('UPDATE agent_crawler_data SET status=? WHERE id=?', [status||'approved', req.params.bid]);
    saveDB();
    res.json({ ok:true });
});

// ==================== 超频批量模式 ====================
var bulkGenerationQueue = {};

app.post('/api/writing-projects/:id/bulk-generate', auth, (req, res) => {
    var projectId = parseInt(req.params.id);
    var chapterIds = req.body.chapter_ids;
    if (!chapterIds || !chapterIds.length) return res.status(400).json({ error:'缺少章节ID列表' });
    console.log('[Writing 批量] 项目='+projectId+' 章节数='+chapterIds.length);
    if (bulkGenerationQueue[projectId]) return res.status(400).json({ error:'已有批量任务在运行' });

    var llmAgent = queryOne('SELECT * FROM agents WHERE user_id=? ORDER BY id LIMIT 1', [req.userId]);
    if (!llmAgent || !llmAgent.api_key) return res.status(400).json({ error:'请先配置智能体' });

    bulkGenerationQueue[projectId] = { total:chapterIds.length, done:0, failed:0, chapterIds:chapterIds, status:'running' };

    function processNext(idx) {
        if (idx >= chapterIds.length) {
            bulkGenerationQueue[projectId].status = 'done';
            console.log('[Writing 批量] 完成 成功='+bulkGenerationQueue[projectId].done+' 失败='+bulkGenerationQueue[projectId].failed);
            return;
        }
        var cid = chapterIds[idx];
        var ch = queryOne('SELECT * FROM writing_chapters WHERE id=?', [cid]);
        if (!ch) { bulkGenerationQueue[projectId].failed++; processNext(idx+1); return; }

        var proj = queryOne('SELECT * FROM writing_projects WHERE id=?', [projectId]);
        var context = '小说：'+(proj?proj.title:'')+'\n类型：'+(proj?proj.genre:'')+'\n章节：'+(ch.title||'')+'\n请撰写本章正文，每章约3000-5000字。';
        var reqBody = { model:llmAgent.model||'deepseek-v4-pro', messages:[{ role:'system', content:'你是一个专业小说写手，请根据给定的大纲和章节标题撰写高质量的小说正文。只输出正文内容，不要添加额外说明。' },{ role:'user', content:context }], temperature:0.8, stream:false };

        fetch(llmAgent.api_endpoint, {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+llmAgent.api_key},
            body:JSON.stringify(reqBody)
        }).then(function(r){ return r.json(); }).then(function(d) {
            var reply = (d.choices && d.choices[0] && d.choices[0].message) ? d.choices[0].message.content : '';
            if (reply) {
                var wc = reply.replace(/\s/g,'').length;
                dbRun('UPDATE writing_chapters SET content_text=?, word_count=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [reply, wc, 'draft', cid]);
                bulkGenerationQueue[projectId].done++;
            } else { bulkGenerationQueue[projectId].failed++; }
            saveDB();
            processNext(idx+1);
        }).catch(function(err) {
            console.error('[Writing 批量] 章节'+cid+' 失败:',err.message);
            bulkGenerationQueue[projectId].failed++;
            processNext(idx+1);
        });
    }

    // 启动串行处理（避免API限流）
    processNext(0);
    res.json({ total:chapterIds.length, message:'批量生成已启动，请等待完成。Token消耗较大，建议关注用量。' });
});

app.get('/api/writing-projects/:id/bulk-status', auth, (req, res) => {
    var q = bulkGenerationQueue[parseInt(req.params.id)];
    res.json(q || { total:0, done:0, failed:0, status:'idle' });
});

// ==================== 技能优化Agent ====================
app.post('/api/writing-projects/:id/optimize-skill', auth, (req, res) => {
    var projectId = parseInt(req.params.id);
    var logs = queryAll('SELECT * FROM user_behavior_logs WHERE user_id=? AND project_id=? ORDER BY created_at DESC LIMIT 100', [req.userId, projectId]);
    var context = '用户行为日志（最近100条）：\n';
    logs.forEach(function(l) {
        context += l.action_type+' '+l.target_type+' '+(l.metadata||'')+'\n';
    });
    console.log('[Writing Skill] 分析 '+logs.length+' 条行为日志');
    var skillPrompt = '你是技能优化专家。根据用户的行为日志，总结用户的偏好模式，设计一段 system prompt（中文，200-500字），作为该用户的定制写作Skill。\n\n要求：\n1. 针对用户的行为习惯进行优化\n2. 包含具体的写作指导、风格偏好、常见指令\n3. 只输出system prompt内容，不要加额外说明';
    callOutlineLLM(projectId, req.userId, skillPrompt, context, 'skill_optimizer', function(result) {
        if (result.error) return res.status(500).json({ error:result.error });
        var nameCn = '写作优化Skill #'+(logs.length);
        dbRun('INSERT INTO optimized_skills (user_id, name_cn, name_en, content, source) VALUES (?,?,?,?,?)',
            [req.userId, nameCn, 'writer_optimized_'+Date.now(), result.content||'', 'auto_generated']);
        saveDB();
        res.json({ content:result.content, name:nameCn });
    });
});

app.get('/api/optimized-skills', auth, (req, res) => {
    res.json(queryAll('SELECT * FROM optimized_skills WHERE user_id=? ORDER BY updated_at DESC', [req.userId]));
});
app.put('/api/optimized-skills/:sid', auth, (req, res) => {
    var { is_enabled } = req.body;
    dbRun('UPDATE optimized_skills SET is_enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?', [is_enabled?1:0, req.params.sid, req.userId]);
    saveDB();
    res.json({ ok:true });
});

// ==================== 审核Agent ====================
var REVIEWER_SYSTEM = '你是小说一致性审核专家。检查小说内容中的矛盾和不一致之处。\n\n请检查以下内容：\n1. 角色行为是否与其性格/背景一致\n2. 剧情是否存在逻辑矛盾\n3. 伏笔是否前后对应\n4. 时间线是否连贯\n5. 同一角色在不同章节中的描述是否一致\n\n输出格式：\n'+
'问题1: [描述]\n建议: [修改建议]\n\n如果没有问题，回复"✅ 未发现一致性问题"';

app.post('/api/writing-projects/:id/review-chapter', auth, (req, res) => {
    var projectId = parseInt(req.params.id);
    var { chapter_id } = req.body;
    if (!chapter_id) return res.status(400).json({ error:'缺少章节ID' });
    var ch = queryOne('SELECT * FROM writing_chapters WHERE id=?', [chapter_id]);
    if (!ch) return res.status(404).json({ error:'章节不存在' });
    console.log('[Writing 审核] 审核章 id='+chapter_id);
    var context = '当前章节内容：\n'+(ch.content_text||'').substring(0, 3000)+'\n\n';
    // 加上前面章节的角色信息
    var chars = queryAll('SELECT * FROM writing_characters WHERE project_id=?', [projectId]);
    chars.forEach(function(c) { context += '角色['+c.name+']: '+c.profile_json+'\n'; });
    callOutlineLLM(projectId, req.userId, REVIEWER_SYSTEM, context, 'reviewer', function(result) {
        if (result.error) return res.status(500).json({ error:result.error });
        res.json({ content:result.content });
    });
});

// ==================== 版本管理 ====================
app.get('/api/writing-projects/:id/versions', auth, (req, res) => {
    var branch = req.query.branch || 'main';
    var versions = queryAll('SELECT * FROM writing_versions WHERE project_id=? AND branch_name=? ORDER BY created_at DESC LIMIT 50', [req.params.id, branch]);
    res.json(versions);
});

app.post('/api/writing-projects/:id/snapshot', auth, (req, res) => {
    var { message, branch } = req.body;
    var projectId = parseInt(req.params.id);
    // 收集当前所有数据
    var proj = queryOne('SELECT * FROM writing_projects WHERE id=?', [projectId]);
    var vols = queryAll('SELECT * FROM writing_volumes WHERE project_id=?', [projectId]);
    var chaps = queryAll('SELECT * FROM writing_chapters WHERE project_id=?', [projectId]);
    var chars = queryAll('SELECT * FROM writing_characters WHERE project_id=?', [projectId]);
    var rels = queryAll('SELECT * FROM relationship_edges WHERE project_id=?', [projectId]);
    var timeline = queryAll('SELECT * FROM plot_timeline_events WHERE project_id=?', [projectId]);
    var fores = queryAll('SELECT * FROM foreshadowing WHERE project_id=?', [projectId]);
    var snapshot = JSON.stringify({ project:proj, volumes:vols, chapters:chaps, characters:chars, relationships:rels, timeline:timeline, foreshadowing:fores });
    var id = dbRun('INSERT INTO writing_versions (project_id, branch_name, snapshot_json, message, commit_type) VALUES (?,?,?,?,?)',
        [projectId, branch||'main', snapshot, message||'版本快照', 'manual']);
    saveDB();
    console.log('[Writing 版本] 快照 id='+id+' branch='+(branch||'main')+' msg='+(message||''));
    res.json({ id, branch:branch||'main' });
});

app.post('/api/writing-projects/:id/branches', auth, (req, res) => {
    var { branch_name } = req.body;
    if (!branch_name) return res.status(400).json({ error:'缺少分支名' });
    var projectId = parseInt(req.params.id);
    // 先保存当前快照
    var proj = queryOne('SELECT * FROM writing_projects WHERE id=?', [projectId]);
    if (!proj) return res.status(404).json({ error:'项目不存在' });
    var vols = queryAll('SELECT * FROM writing_volumes WHERE project_id=?', [projectId]);
    var chaps = queryAll('SELECT * FROM writing_chapters WHERE project_id=?', [projectId]);
    var snapshot = JSON.stringify({ project:proj, volumes:vols, chapters:chaps });
    var id = dbRun('INSERT INTO writing_versions (project_id, branch_name, snapshot_json, message, commit_type) VALUES (?,?,?,?,?)',
        [projectId, branch_name, snapshot, '创建分支 '+branch_name, 'manual']);
    dbRun('UPDATE writing_projects SET branch_active=? WHERE id=?', [branch_name, projectId]);
    saveDB();
    console.log('[Writing 分支] 创建 '+branch_name+' id='+id);
    res.json({ id, branch:branch_name });
});

app.post('/api/writing-projects/:id/switch-branch', auth, (req, res) => {
    var { branch_name } = req.body;
    if (!branch_name) return res.status(400).json({ error:'缺少分支名' });
    var projectId = parseInt(req.params.id);
    dbRun('UPDATE writing_projects SET branch_active=? WHERE id=?', [branch_name, projectId]);
    saveDB();
    console.log('[Writing 分支] 切换到 '+branch_name);
    res.json({ ok:true, branch:branch_name });
});
    db.run('CREATE TABLE IF NOT EXISTS writing_agent_config (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, agent_type TEXT NOT NULL, model_name TEXT, temperature REAL, api_endpoint TEXT, api_key TEXT, system_prompt TEXT, max_tokens INTEGER, is_muted INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(project_id, agent_type))');
    db.run('CREATE TABLE IF NOT EXISTS agent_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, agent_type TEXT NOT NULL, role TEXT NOT NULL, content TEXT DEFAULT \'\', thinking TEXT DEFAULT \'\', tool_calls TEXT DEFAULT \'\', metadata TEXT DEFAULT \'{"type":"chat"}\', token_used INTEGER DEFAULT 0, status TEXT DEFAULT \'done\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS token_usage_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, project_id INTEGER NOT NULL, agent_type TEXT, model TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cost_input REAL DEFAULT 0.0, cost_output REAL DEFAULT 0.0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS token_pricing_config (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, model_name TEXT NOT NULL, input_price_per_million REAL DEFAULT 0.0, output_price_per_million REAL DEFAULT 0.0, cache_hit_price_per_million REAL DEFAULT 0.0, discount_rate REAL DEFAULT 1.0, discount_valid_until TEXT DEFAULT \'\', is_default INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');

    // 默认token费用配置（DeepSeek V4 2026-05-21 含2.5折至2026-05-31）
    var hasPricing = queryOne('SELECT id FROM token_pricing_config WHERE is_default=1 LIMIT 1');
    if (!hasPricing) {
        dbRun('INSERT INTO token_pricing_config (user_id, model_name, input_price_per_million, output_price_per_million, cache_hit_price_per_million, discount_rate, discount_valid_until, is_default) VALUES (NULL, \'deepseek-v4-pro\', 0.1, 24.0, 0.1, 0.25, \'2026-05-31\', 1)');
        dbRun('INSERT INTO token_pricing_config (user_id, model_name, input_price_per_million, output_price_per_million, cache_hit_price_per_million, discount_rate, discount_valid_until, is_default) VALUES (NULL, \'deepseek-v4-flash\', 0.02, 2.0, 0.02, 1.0, \'\', 0)');
    }

    // 迁移：给旧表加列
    try { db.run('ALTER TABLE projects ADD COLUMN default_style_id INTEGER DEFAULT NULL'); } catch(e) {}
    try { db.run('ALTER TABLE image_styles ADD COLUMN cover_url TEXT DEFAULT \'\''); } catch(e) {}
    try { db.run('ALTER TABLE agents ADD COLUMN share_code TEXT'); } catch(e) {}
    try { db.run('ALTER TABLE agents ADD COLUMN max_tokens_enabled INTEGER DEFAULT 0'); } catch(e) {}
    // 迁移：给旧表加 skill_id 列
    try { db.run('ALTER TABLE agents ADD COLUMN skill_id INTEGER'); } catch(e) {}
    // 迁移：给旧表加 project_id 列
    try { db.run('ALTER TABLE canvas_versions ADD COLUMN project_id INTEGER NOT NULL DEFAULT 1'); } catch(e) {}
    try { db.run('ALTER TABLE users ADD COLUMN session_token TEXT DEFAULT \'\''); } catch(e) {}
    try { db.run('ALTER TABLE assets ADD COLUMN md5 TEXT DEFAULT \'\''); } catch(e) {}
    // pinned_snapshot 需要重建（约束变更）
    try { db.run('DROP TABLE IF EXISTS pinned_snapshot_old'); } catch(e) {}
    try {
        db.run('ALTER TABLE pinned_snapshot RENAME TO pinned_snapshot_old');
        db.run('CREATE TABLE pinned_snapshot (user_id INTEGER NOT NULL, project_id INTEGER NOT NULL, data TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, project_id))');
        db.run('INSERT INTO pinned_snapshot (user_id, project_id, data, updated_at) SELECT user_id, 1, data, updated_at FROM pinned_snapshot_old');
        db.run('DROP TABLE pinned_snapshot_old');
    } catch(e) {}

    // 迁移旧 canvases 表
    try {
        const oldCanvas = queryOne('SELECT user_id, data FROM canvases LIMIT 1');
        if (oldCanvas) {
            dbRun('INSERT INTO projects (user_id, name, data) VALUES (?, ?, ?)', [oldCanvas.user_id, '已迁移项目', oldCanvas.data]);
            db.run('DROP TABLE canvases');
            saveDB();
        }
    } catch (e) {}

    // 种子：导入默认 SKILL（分镜关键帧提示词生成器）
    var skillPath = path.join(__dirname, 'SKILL', 'storyboard-keyframe-generator', 'SKILL.md');
    var schemaPath = path.join(__dirname, 'SKILL', 'storyboard-keyframe-generator', 'references', '分镜关键帧提示词.json');
    var existingSkill = queryOne('SELECT id FROM skills WHERE name=?', ['storyboard-keyframe-generator']);
    try {
        var skillContent2 = fs.readFileSync(skillPath, 'utf-8');
        var jsonSchema2 = '';
        try { jsonSchema2 = fs.readFileSync(schemaPath, 'utf-8'); } catch(e2) {}
        if (existingSkill) {
            dbRun('UPDATE skills SET content=?, json_schema=? WHERE id=?', [skillContent2, jsonSchema2, existingSkill.id]);
            console.log('  🔄 已更新 SKILL: storyboard-keyframe-generator');
        } else {
            dbRun('INSERT INTO skills (name, description, content, json_schema) VALUES (?,?,?,?)',
                ['storyboard-keyframe-generator', '把动态分镜脚本转化为结构化JSON关键帧AI生图提示词文件', skillContent2, jsonSchema2]);
            console.log('  ✅ 已导入 SKILL: storyboard-keyframe-generator');
        }
    } catch(e3) { console.log('  ⚠️ SKILL 文件未找到，跳过: ' + skillPath); }

    // 种子：导入 7 个内置风格
    var builtinStyles = [
      {name:'厚涂二次元', desc:'厚涂二次元写实风格，半厚涂插画质感', prompt:'厚涂二次元写实风格，半厚涂插画质感，笔触可见，电影级光影，高精度细节渲染'},
      {name:'赛璐璐平涂', desc:'日系赛璐璐风格，干净线稿纯色填充', prompt:'日系赛璐璐风格，干净线稿，纯色块填充，高饱和色彩，动画关键帧质感'},
      {name:'水墨古风', desc:'中国水墨画风格，写意泼墨笔触', prompt:'中国水墨画风格，写意泼墨笔触，宣纸纹理，留白意境，淡彩渲染，古典韵味'},
      {name:'写实电影', desc:'电影级写实风格，真实光影胶片质感', prompt:'电影级写实风格，真实光影，胶片质感，景深虚化，HDR色调映射，超精细细节'},
      {name:'二次元平涂', desc:'二次元动漫平涂风格，清新明亮色彩', prompt:'二次元动漫平涂风格，清新明亮色彩，柔和渐变，细腻线条，萌系角色质感'},
      {name:'暗黑哥特', desc:'暗黑哥特风格，戏剧性明暗对比', prompt:'暗黑哥特风格，戏剧性明暗对比，冷色调，哥特式华丽细节，神秘氛围'},
      {name:'宫崎骏风格', desc:'吉卜力宫崎骏动画风格', prompt:'吉卜力宫崎骏动画风格，柔和自然光线，手绘水彩背景，温暖治愈色调，细腻角色表情，田园诗意氛围'}
    ];
    builtinStyles.forEach(function(bs) {
      var existing = queryOne('SELECT id FROM image_styles WHERE name=? AND is_builtin=1', [bs.name]);
      if (!existing) {
        dbRun('INSERT INTO image_styles (user_id, name, description, prompt_suffix, is_builtin) VALUES (0,?,?,?,1)', [bs.name, bs.desc, bs.prompt]);
        console.log('  ✅ 已导入内置风格: ' + bs.name);
      }
    });

    saveDB();

    app.listen(PORT, () => {
        console.log('\n  🎨 无限画布 本地后端已启动');
        console.log('  本机访问: http://localhost:' + PORT);
        // 显示局域网地址
        var os = require('os');
        var ifaces = os.networkInterfaces();
        Object.keys(ifaces).forEach(function(name) {
            ifaces[name].forEach(function(iface) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    console.log('  局域网:   http://' + iface.address + ':' + PORT);
                }
            });
        });
        console.log('');
    });
}

start().catch(err => { console.error('启动失败:', err); process.exit(1); });
