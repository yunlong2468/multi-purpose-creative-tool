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
const BUFFER_DIR = path.join(__dirname, 'buffers');
if (!fs.existsSync(BUFFER_DIR)) fs.mkdirSync(BUFFER_DIR, { recursive: true });

// 流式输出磁盘缓冲（断线续传用）
function streamBufferPath(projectId) { return path.join(BUFFER_DIR, 'stream_'+projectId+'.json'); }
function saveStreamBuffer(projectId, content, thinking, startedAt, phase, agentType, subContent, subThinking) {
    try { fs.writeFileSync(streamBufferPath(projectId), JSON.stringify({content:content, thinking:thinking, startedAt:startedAt, updatedAt:Date.now(), phase:phase||'streaming', agentType:agentType||'orchestrator', subContent:subContent||'', subThinking:subThinking||''})); } catch(e) {}
}
function clearStreamBuffer(projectId) {
    try { if (fs.existsSync(streamBufferPath(projectId))) fs.unlinkSync(streamBufferPath(projectId)); } catch(e) {}
}

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

// ==================== 开发者日志实时推送 ====================
var devLogClients = [];
var devLogBuffer = []; // 环形缓冲区（新连接回溯用）
var DEV_LOG_MAX = 500;

function broadcastDevLog(level, source, msg) {
    var entry = { ts: new Date().toISOString(), source: source, level: level, msg: msg };
    devLogBuffer.push(entry);
    if (devLogBuffer.length > DEV_LOG_MAX) devLogBuffer.shift();
    var json = JSON.stringify(entry);
    devLogClients.forEach(function(c) { try { c.write('data: ' + json + '\n\n'); } catch(e) {} });
    devLogClients = devLogClients.filter(function(c) { return !c.destroyed; });
}

// 覆盖 console 方法，转发到开发者日志
(function() {
    var _log = console.log, _warn = console.warn, _error = console.error;
    console.log = function() { var m = Array.prototype.join.call(arguments, ' '); _log.apply(console, arguments); broadcastDevLog('info', 'server', m); };
    console.warn = function() { var m = Array.prototype.join.call(arguments, ' '); _warn.apply(console, arguments); broadcastDevLog('warn', 'server', m); };
    console.error = function() { var m = Array.prototype.join.call(arguments, ' '); _error.apply(console, arguments); broadcastDevLog('error', 'server', m); };
})();

app.get('/api/dev-logs', function(req, res) {
    var token = req.query.token;
    if (!token) { res.status(401).json({ error: '未授权' }); return; }
    try { var payload = jwt.verify(token, JWT_SECRET); } catch(e) { res.status(401).json({ error: 'token无效' }); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    // 先发送缓冲区中的历史日志
    devLogBuffer.forEach(function(entry) {
        try { res.write('data: ' + JSON.stringify(entry) + '\n\n'); } catch(e) {}
    });
    devLogClients.push(res);
    req.on('close', function() { devLogClients = devLogClients.filter(function(c) { return c !== res; }); });
});

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

// POST 撤回最近的用户消息组（该用户消息及其后的所有agent消息）
app.post('/api/writing-projects/:id/undo-last', auth, (req, res) => {
    try {
        var projectId = parseInt(req.params.id);
        var lastUser = queryOne('SELECT id, created_at FROM agent_conversations WHERE project_id=? AND role=? ORDER BY id DESC LIMIT 1', [projectId, 'user']);
        if (!lastUser) return res.json({ ok: true, deleted: 0 });
        // 找到上一条用户消息的时间戳作为安全点
        var safePoint = queryOne('SELECT created_at FROM agent_conversations WHERE project_id=? AND role=? AND id < ? ORDER BY id DESC LIMIT 1', [projectId, 'user', lastUser.id]);
        var safeTime = safePoint ? safePoint.created_at : lastUser.created_at;
        // 删除对话记录
        db.run('DELETE FROM agent_conversations WHERE project_id=? AND id>=?', [projectId, lastUser.id]);
        // 回滚文件数据
        var rollback = { volumes: 0, chapters: 0, characters: 0 };
        if (safePoint) {
            // 删前捕获：哪些卷会被波及（在删章之前查询）
            var affectedVolIds = queryAll('SELECT DISTINCT volume_id FROM writing_chapters WHERE project_id=? AND created_at > ?', [projectId, safeTime]);
            // 统计并删除安全点之后创建的章和角色
            rollback.chapters = (queryAll('SELECT id FROM writing_chapters WHERE project_id=? AND created_at > ?', [projectId, safeTime])).length;
            rollback.characters = (queryAll('SELECT id FROM writing_characters WHERE project_id=? AND created_at > ?', [projectId, safeTime])).length;
            db.run('DELETE FROM chapter_versions WHERE project_id=? AND created_at > ?', [projectId, safeTime]);
            db.run('DELETE FROM writing_chapters WHERE project_id=? AND created_at > ?', [projectId, safeTime]);
            db.run('DELETE FROM writing_characters WHERE project_id=? AND created_at > ?', [projectId, safeTime]);
            // 仅清理波及范围内变为空的卷
            affectedVolIds.forEach(function(vr) {
                var remain = queryOne('SELECT COUNT(*) as cnt FROM writing_chapters WHERE volume_id=?', [vr.volume_id]);
                if (!remain || remain.cnt === 0) {
                    db.run('DELETE FROM writing_volumes WHERE id=?', [vr.volume_id]);
                    rollback.volumes++;
                }
            });
        }
        saveDB();
        console.log('[Undo] 项目 '+projectId+' 撤回消息组+回滚 卷:'+rollback.volumes+' 章:'+rollback.chapters+' 角色:'+rollback.characters);
        res.json({ ok: true, deleted: 1, rollback: rollback });
    } catch(e) { console.error('[Undo] error:', e); res.status(500).json({ error: e.message }); }
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
'2. 收集足够信息后，询问用户是否授权爬取近6个月同类热门小说作为参考。授权后，必须明确询问用户希望爬取哪个目标平台。推荐平台时，根据用户的小说类型和发展意图，从以下平台中推荐最匹配的多个（至少2个）：\n'+
'   - 番茄小说：流量大，适合爽文/系统流/末世/玄幻/快节奏短篇\n'+
'   - 起点中文网：老牌平台，适合长篇/精品/传统玄幻/仙侠/都市\n'+
'   - 晋江文学城：女性向为主，适合言情/耽美/女频/古言\n'+
'   - 纵横中文网：中腰部作者友好，适合玄幻/仙侠/都市\n'+
'   - 飞卢小说网：同人/系统流/无敌流/快节奏爽文首选\n'+
'   - QQ阅读：腾讯系，覆盖面广，适合各类通俗小说\n'+
'   - 七猫/掌阅：免费阅读平台，适合快节奏/短篇/新媒体文\n'+
'   - 息壤中文网：新兴原创平台，适合创新题材/新人作者/小众类型\n'+
'   - 菠萝包轻小说：轻小说/二次元/同人/校园日常向首选\n'+
'   - 刺猬猫：二次元/轻小说/宅文/脑洞创意向\n'+
'  严禁自行推断平台。必须等用户在回复中明确说出平台名称后，才能调用crawl_books工具。\n'+
'3. 整合所有信息生成一份清晰的创作需求摘要，请用户确认\n'+
'4. 用户确认后，调用generate_outline工具生成分卷分章大纲\n\n'+
'## 工具使用规则\n'+
'- 你是调配师，不要亲自生成大纲、角色档案、小说正文等内容，必须通过调用工具完成\n'+
'- 需要生成大纲 → 调用generate_outline工具\n'+
'- 需要设计角色 → 调用generate_characters工具\n'+
'- 需要爬取数据 → 调用crawl_books工具（需先获取用户平台授权）\n'+
'- 不确定操作流程时 → 先调用load_skill工具查阅相关技能指南\n'+
'- 调用crawl_books前必须让用户明确说出平台名称，严禁从上下文推断\n'+
'- 当需要用户从多个选项中做选择时（如脑洞/构思/方向/确认项），必须在末尾用「- [选项文字]」每行一个列出所有可选项目。\n'+
'  例如你给出了三个脑洞，末尾必须列出：\n'+
'  - [展开说说脑洞一：蒸汽内核]\n'+
'  - [展开说说脑洞二：魔女改造蒸汽]\n'+
'  - [展开说说脑洞三：契约魔女]\n'+
'  - [这些都不喜欢，换个方向]\n'+
'  重要：按钮数量必须覆盖所有你给出的选项，不能只列部分。\n'+
'- 按钮文字应简洁（≤20字），足够让用户识别对应的是哪个选项。\n'+
'  正文可以展开描述细节，按钮只做"选择"用途。\n'+
	'- 任何需要用户执行的操作（生成大纲、设计角色、确认等），一律用「- [按钮文字]」按钮格式放在末尾，\n'+
	'  绝对禁止在正文里写"请点击XX按钮""点击界面上的XX"这类文字引导。按钮即引导。\n'+
	'- 用户确认需求后，末尾必须包含「- [确认无误，生成大纲]」按钮（以及修改需求等其他合理选项）。\n'+
'- 你只负责：采访、整理需求摘要、提出建议、协调协调\n\n'+
'## 风格\n'+
'- 像一个有经验的编辑/策划一样对话，不要过于机械\n'+
'- 根据用户的回答灵活调整后续问题\n'+
'- 适当给出来自网文市场的建议（如"目前XX类型在XX平台比较吃香"）\n'+
'- 不要替用户做决定，始终征求确认\n'+
'- 简洁直接，避免堆砌同义反复的形容词和排比句（如"不再压制A、不再压制B、不再压制C"这类扩写禁止）\n'+
'- 每个场景/构思用一句话概括核心冲突即可，不要铺陈细节直到用户明确要求展开\n'+
'- 回复总长度控制在300字以内（不含按钮）\n'+
	'- 【关键】用户已明确给出的数字（字数、章节数等），必须严格使用用户说的数字，绝对禁止自行替换为其他数字。\n'+
	'  例如用户说3万字，你不得说5万/8万/10万等其他数字；用户未明确时才可给建议范围。\n\n'+
'## 输出格式\n'+
'- 回复结构：正文（分析/描述/建议）→ 提问或征求确认 → 选择按钮。\n'+
'  也就是需要用户回应的提问，必须放在正文下方、按钮上方，作为结尾句。\n'+
'- 以纯文本自然语言回复，按钮行放在回复最末尾\n'+
'- 当需要用户选择或确认时，用提问语句收尾再列出选项按钮';

// ==================== 调配师工具定义（MCP风格子智能体调用） ====================
var ORCHESTRATOR_TOOLS = [
  { type: "function", function: { name: "load_skill", description: "加载指定的技能指南。当你需要执行某个操作但不清楚具体流程时（如角色设计、大纲生成等），先调用此工具获取该技能的详细指南，然后再按指南操作。", parameters: { type: "object", properties: { skill_name: { type: "string", description: "要加载的技能名称，如：角色设计指南、大纲设计指南" } }, required: ["skill_name"] } } },
  { type: "function", function: { name: "generate_outline", description: "根据用户需求生成小说分卷分章大纲。返回结构化JSON。当用户确认需求后调用。", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "generate_characters", description: "根据小说信息和大纲设计角色档案。返回JSON包含角色姓名、外貌、性格、背景、能力等。在大纲生成后或用户要求时调用。", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "crawl_books", description: "爬取/搜索同类热门小说数据作为创作参考。仅在用户已明确授权且用户本人明确说出了目标平台名称后调用。严禁自行推断或猜测平台。", parameters: { type: "object", properties: { platform: { type: "string", description: "用户明确说出的目标平台名称（番茄/起点/晋江/纵横/飞卢/QQ阅读/七猫/掌阅/息壤/菠萝包/刺猬猫等），严禁自行推断" } }, required: ["platform"] } } }
];

// 爬虫系统提示（需定义在executeToolAsync之前，crawl_books分支会引用）
var CRAWLER_SYSTEM = '你是一个小说数据爬取分析助手。基于用户的小说创作方向，搜索并推荐同类热门网络小说作为参考。\n\n请严格按以下格式输出（必须用```json包裹）：\n```json\n{"书籍":[{"书名":"","作者":"","简介":"","热度":"","字数":"","标签":[""],"平台":"番茄/起点/晋江等"}]}\n```\n至少输出5本相关书籍。根据用户的小说类型和方向，生成真实可信的参考书籍信息。';

var SKILL_OPTIMIZER_SYSTEM = '你是一个技能（Skill）优化专家。你不仅创建技能指南，还可以为技能定义**新的可调用工具**，这些工具会被注册到调配师的工具箱中供后续调用。\n\n## 系统已有工具（不可重复定义）\n- generate_outline：生成小说分卷分章大纲\n- generate_characters：设计角色档案\n- crawl_books：爬取/搜索同类热门小说数据\n- load_skill：加载技能指南\n\n## 输出格式\n请严格输出以下JSON（不含markdown代码块标记）：\n{\n  "content": "技能指南（Markdown格式，含场景、步骤、注意事项）",\n  "tools": [\n    {\n      "name": "工具英文名（snake_case，如 design_worldview）",\n      "description": "工具用途简短描述（给AI看的，说明何时调用）",\n      "parameters": {\n        "type": "object",\n        "properties": {\n          "参数名": {"type": "参数类型", "description": "参数描述"}\n        }\n      }\n    }\n  ]\n}\n\n## 规则\n1. 如果技能的操作可以完全由已有工具完成，tools数组为空 []\n2. 如果技能需要新的操作能力（如世界观设计、战斗系统设计等），在tools中定义新工具\n3. content中的操作步骤必须明确写出调用哪个工具及其参数映射\n4. tools中的每个工具都必须有清晰的 name、description、parameters\n5. 不要输出```json标记，直接输出纯JSON';

// 子智能体LLM调用（支持request_tool多轮循环）
// messages: 对话历史（会被原地修改）
// tools: 工具定义数组
// streamCallback: 流式回调 function({type, delta})
// callback: 完成回调 function({content, thinking, tool_calls, _messages})
function _callSubAgentLLM(projectId, userId, messages, agentType, tools, streamCallback, callback) {
    var llmAgent = queryOne('SELECT * FROM agents WHERE user_id=? ORDER BY id LIMIT 1', [userId]);
    if (!llmAgent || !llmAgent.api_key) { callback({ error: '请先配置AI模型' }); return; }
    var agentConfig = queryOne('SELECT * FROM writing_agent_config WHERE project_id=? AND agent_type=?', [projectId, agentType]);
    var model = (agentConfig && agentConfig.model_name) || llmAgent.model || 'deepseek-v4-pro';
    var isDS = model.toLowerCase().indexOf('deepseek') >= 0;
    console.log('[SubAgent '+agentType+'] 调用 model='+model+' 消息数='+messages.length);

    var reqBody = { model: model, messages: messages, temperature: 0.6, stream: true };
    if (isDS) { reqBody.thinking = { type: 'enabled' }; reqBody.reasoning_effort = 'max'; }
    if (tools && tools.length) reqBody.tools = tools;

    fetch(llmAgent.api_endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + llmAgent.api_key },
        body: JSON.stringify(reqBody)
    }).then(function(r) {
        if (!r.ok) return r.text().then(function(t) { callback({ error: 'HTTP '+r.status+': '+t.substring(0,200) }); });
        var reader = r.body.getReader();
        var decoder = new TextDecoder();
        var buf = '', fullContent = '', fullThinking = '', tokIn = 0, tokOut = 0;
        var fullToolCalls = [];
        function pump() {
            reader.read().then(function(chunk) {
                if (chunk.done) {
                    // 筛选有效 tool_calls
                    var validCalls = fullToolCalls.filter(function(tc) { return tc.function && tc.function.name; });
                    console.log('[SubAgent '+agentType+'] 完成 content='+fullContent.length+' thinking='+fullThinking.length+' tool_calls='+validCalls.length);
                    if (validCalls.length > 0) {
                        // 有工具请求 → 不保存DB，返回tool_calls让上层处理
                        // 构建assistant消息（含tool_calls）加入历史
                        var assistantMsg = { role: 'assistant', content: fullContent || '' };
                        if (fullThinking) assistantMsg.reasoning_content = fullThinking;
                        assistantMsg.tool_calls = validCalls;
                        messages.push(assistantMsg);
                        dbRun('INSERT INTO token_usage_logs (user_id, project_id, agent_type, model, input_tokens, output_tokens) VALUES (?,?,?,?,?,?)', [userId, projectId, agentType, model, tokIn, tokOut]);
                        saveDB();
                        callback({ content: fullContent, thinking: fullThinking, tool_calls: validCalls, _messages: messages, token_in: tokIn, token_out: tokOut });
                    } else {
                        // 无工具请求 → 保存DB，正常完成
                        dbRun('INSERT INTO token_usage_logs (user_id, project_id, agent_type, model, input_tokens, output_tokens) VALUES (?,?,?,?,?,?)', [userId, projectId, agentType, model, tokIn, tokOut]);
                        saveDB();
                        callback({ content: fullContent, thinking: fullThinking, tool_calls: [], _messages: messages, token_in: tokIn, token_out: tokOut });
                    }
                    return;
                }
                buf += decoder.decode(chunk.value, { stream: true });
                var lines = buf.split('\n'); buf = lines.pop() || '';
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i].trim();
                    if (!line || line.indexOf('data: ') !== 0) continue;
                    var raw = line.slice(6);
                    if (raw === '[DONE]') continue;
                    try {
                        var parsed = JSON.parse(raw);
                        if (parsed.usage) { tokIn = parsed.usage.prompt_tokens || 0; tokOut = parsed.usage.completion_tokens || 0; }
                        var delta = (parsed.choices && parsed.choices[0]) ? parsed.choices[0].delta : null;
                        if (!delta) continue;
                        if (delta.reasoning_content) {
                            fullThinking += delta.reasoning_content;
                            if (streamCallback) streamCallback({ type: 'thinking', delta: delta.reasoning_content });
                        }
                        if (delta.content) {
                            fullContent += delta.content;
                            if (streamCallback) streamCallback({ type: 'content', delta: delta.content });
                        }
                        if (delta.tool_calls) {
                            delta.tool_calls.forEach(function(tc) {
                                var idx = tc.index;
                                if (idx === undefined || idx === null) return;
                                if (!fullToolCalls[idx]) fullToolCalls[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
                                if (tc.id) fullToolCalls[idx].id = tc.id;
                                if (tc.function) {
                                    if (tc.function.name) fullToolCalls[idx].function.name = tc.function.name;
                                    if (tc.function.arguments) fullToolCalls[idx].function.arguments += tc.function.arguments;
                                }
                            });
                        }
                    } catch(e) {}
                }
                pump();
            }).catch(function(err) {
                console.error('[SubAgent '+agentType+'] 读取异常:', err.message);
                callback({ error: err.message });
            });
        }
        pump();
    }).catch(function(err) {
        console.error('[SubAgent '+agentType+'] 调用失败:', err.message);
        callback({ error: err.message });
    });
}

// _continueMsgs: 续接模式时的历史消息数组（子智能体request_tool后继续对话）
function executeToolAsync(toolName, argsJson, projectId, userId, streamCallback, _continueMsgs) {
    return new Promise(function(resolve) {
        try { var args = JSON.parse(argsJson || '{}'); } catch(e) { args = {}; }
        var tl = toolName.toLowerCase();
        console.log('[Tool] 执行工具: '+toolName);
        if (tl.indexOf('outline') >= 0 || toolName === 'generate_outline') {
            var proj = queryOne('SELECT * FROM writing_projects WHERE id=?', [projectId]);
            var context = '项目信息：\n- 标题：'+proj.title+'\n- 类型：'+(proj.genre||'未定')+' '+(proj.sub_genre||'')+'\n- 目标字数：'+(proj.target_words||'未定')+'\n';
            var history = queryAll('SELECT * FROM agent_conversations WHERE project_id=? ORDER BY created_at ASC LIMIT 200', [projectId]);
            history.forEach(function(m) {
                if (m.role==='user') context += '用户：'+m.content+'\n';
                else if (m.role==='assistant' && m.agent_type==='orchestrator') context += '主Agent：'+m.content+'\n';
            });
            context += '\n请根据以上信息生成完整的小说大纲（分卷分章）。';
            callOutlineLLM(projectId, userId, OUTLINER_SYSTEM, context, 'outliner', null, function(result) {
                if (result.error) { resolve({ error: result.error, summary: '大纲生成失败: '+result.error }); return; }
                var summary = '大纲已生成';
                try {
                    var clean = (result.content||'').replace(/```json\s*|\s*```/g,'').trim();
                    var outline = JSON.parse(clean);
                    if (outline && outline['卷']) {
                        summary = '已生成 '+outline['卷'].length+' 卷大纲，共 '+(outline['卷'].reduce(function(a,v){return a+(v['章']||[]).length;},0))+' 章';
                        // 写入数据库
                        outline['卷'].forEach(function(vol, vi) {
                            var vid = dbRun('INSERT INTO writing_volumes (project_id, volume_no, title, sort_order) VALUES (?,?,?,?)', [projectId, vi+1, vol['卷名']||('第'+(vi+1)+'卷'), vi+1]);
                            (vol['章']||[]).forEach(function(chap) {
                                dbRun('INSERT INTO writing_chapters (project_id, volume_id, chapter_no, title) VALUES (?,?,?,?)', [projectId, vid, (dbRun('SELECT COUNT(*) as c FROM writing_chapters WHERE volume_id=?',[vid]),0), chap['章名']||'']);
                            });
                        });
                        saveDB();
                    }
                } catch(e) {}
                resolve({ result: result.content, thinking: result.thinking || '', summary: summary });
            }, streamCallback);
        } else if (tl.indexOf('character') >= 0 || toolName === 'generate_characters') {
            var proj2 = queryOne('SELECT * FROM writing_projects WHERE id=?', [projectId]);
            var context2 = '项目：'+proj2.title+'\n类型：'+proj2.genre+' '+proj2.sub_genre+'\n';
            var history2 = queryAll('SELECT * FROM agent_conversations WHERE project_id=? ORDER BY created_at ASC LIMIT 200', [projectId]);
            history2.forEach(function(m) {
                if (m.role==='user') context2 += '用户：'+m.content+'\n';
                else if (m.role==='assistant') context2 += 'Agent：'+m.content+'\n';
            });
            callOutlineLLM(projectId, userId, CHARACTER_SYSTEM, context2, 'character', null, function(result) {
                if (result.error) { resolve({ error: result.error, summary: '角色生成失败: '+result.error }); return; }
                var summary = '角色已生成';
                try {
                    var raw = result.content || '';
                    var m = raw.match(/```json\s*([\s\S]*?)```/);
                    var jsonStr = m ? m[1].trim() : raw.trim();
                    var start = jsonStr.indexOf('{'), end = jsonStr.lastIndexOf('}');
                    if (start >= 0 && end > start) jsonStr = jsonStr.substring(start, end + 1);
                    var chars = JSON.parse(jsonStr);
                    if (chars && chars['角色']) {
                        chars['角色'].forEach(function(c) {
                            dbRun('INSERT INTO writing_characters (project_id, name, profile_json) VALUES (?,?,?)', [projectId, c['姓名']||'未命名', JSON.stringify(c)]);
                        });
                        saveDB();
                        summary = '已生成 '+chars['角色'].length+' 个角色';
                    }
                } catch(e) { console.error('[Writing 角色] 保存失败:', e.message); summary = '角色保存失败: '+e.message; }
                resolve({ result: result.content, thinking: result.thinking || '', summary: summary });
            }, streamCallback);
        } else if (tl.indexOf('crawl') >= 0 || toolName === 'crawl_books') {
            var proj3 = queryOne('SELECT * FROM writing_projects WHERE id=?', [projectId]);
            var platform = args.platform || '番茄';
            var context3 = '目标平台：'+platform+'\n正在为以下小说项目搜索参考书籍：\n- 标题：'+proj3.title+'\n- 类型：'+(proj3.genre||'未定')+' '+(proj3.sub_genre||'')+'\n- 目标字数：'+(proj3.target_words||'未定')+'\n- 风格：'+(proj3.style_ref||'无')+'\n\n';
            var history3 = queryAll('SELECT * FROM agent_conversations WHERE project_id=? ORDER BY created_at ASC LIMIT 200', [projectId]);
            history3.forEach(function(m) {
                if (m.role==='user') context3 += '用户：'+m.content+'\n';
                else if (m.role==='assistant' && m.agent_type==='orchestrator') context3 += '主Agent：'+m.content+'\n';
            });
            context3 += '\n请根据对话提取创作方向，在【'+platform+'】平台搜索最近6个月同类热门小说，输出JSON（用```json包裹），至少5本，每本书的平台字段填"'+platform+'"。';
            callOutlineLLM(projectId, userId, CRAWLER_SYSTEM, context3, 'crawler', null, function(result) {
                if (result.error) { resolve({ error: result.error, summary: '爬取失败: '+result.error }); return; }
                var summary = '爬取完成';
                try {
                    var clean = (result.content||'').replace(/```json\s*|\s*```/g, '').trim();
                    var books = JSON.parse(clean);
                    if (books['书籍']) {
                        books['书籍'].forEach(function(b) {
                            dbRun('INSERT INTO agent_crawler_data (project_id, platform, book_name, author, cover_url, intro, tags, status) VALUES (?,?,?,?,?,?,?,?)',
                                [projectId, b['平台']||'未知', b['书名']||'', b['作者']||'', b['封面']||'', b['简介']||'', JSON.stringify(b['标签']||[]), 'pending']);
                        });
                        saveDB();
                        summary = '已爬取 '+books['书籍'].length+' 本参考书籍（'+books['书籍'].map(function(b){return b['书名'];}).join('、')+'）';
                    }
                } catch(e) { console.log('[Writing 爬虫] JSON解析失败:', e.message); }
                resolve({ result: result.content, thinking: result.thinking || '', summary: summary });
            }, streamCallback);
        } else if (tl.indexOf('load_skill') >= 0 || tl.indexOf('skill') >= 0) {
            var skillName = args.skill_name || '';
            console.log('[Skill] 查询技能: '+skillName);
            // 模糊搜索启用的技能
            var skill = queryOne('SELECT * FROM optimized_skills WHERE name_cn LIKE ? AND is_enabled=1 LIMIT 1', ['%'+skillName+'%']);
            if (skill) {
                console.log('[Skill] 找到技能: '+skill.name_cn);
                resolve({ result: skill.content, summary: '已加载技能「'+skill.name_cn+'」' });
            } else {
                // 检查是否为用户主动删除的技能（is_enabled=0）
                var deletedSkill = queryOne('SELECT id FROM optimized_skills WHERE name_cn LIKE ? AND is_enabled=0 LIMIT 1', ['%'+skillName+'%']);
                if (deletedSkill) {
                    console.log('[Skill] 技能已被用户删除: '+skillName);
                    resolve({ error: '技能已被删除', summary: '技能「'+skillName+'」已被删除，如需使用请重新创建' });
                    return;
                }
                // 技能不存在 → 自动触发技能优化子智能体
                console.log('[Skill] 技能不存在，触发技能优化: '+skillName);
                var optContext = '请为用户创建一个名为「'+skillName+'」的技能（Skill）。\n- 技能名称：'+skillName+'\n- 用途：当用户要求'+skillName+'相关操作时，调配师按此技能指南执行\n- 如果技能涉及已有工具能完成的操作（大纲、角色等），在content中写明调用现有工具\n- 如果技能需要新的操作能力，请在tools数组中定义新工具';
                callOutlineLLM(projectId, userId, SKILL_OPTIMIZER_SYSTEM, optContext, 'skill_optimizer', null, function(optResult) {
                    if (optResult.error) {
                        resolve({ error: optResult.error, summary: '技能优化失败: '+optResult.error });
                        return;
                    }
                    // 解析技能优化器输出：尝试提取JSON
                    var rawText = optResult.content || '';
                    var skillContent = rawText; // 默认使用原始文本
                    var toolsJson = '';
                    var parsedTools = [];
                    // 尝试提取JSON（可能被markdown代码块包裹）
                    var jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
                    var jsonStr = jsonMatch ? jsonMatch[1].trim() : rawText.trim();
                    try {
                        var parsed = JSON.parse(jsonStr);
                        if (parsed.content) skillContent = parsed.content;
                        if (parsed.tools && Array.isArray(parsed.tools)) parsedTools = parsed.tools;
                        toolsJson = JSON.stringify(parsedTools);
                    } catch(e) {
                        // JSON解析失败，整个响应作为skill内容，无工具
                        console.log('[Skill] JSON解析失败，使用原始文本作为内容');
                    }
                    // 保存SKILL到DB
                    var newId = dbRun('INSERT INTO optimized_skills (user_id, name_cn, name_en, description, content, json_schema, source, is_enabled) VALUES (?,?,?,?,?,?,?,1)',
                        [userId, skillName, '', '自动生成的技能', skillContent, toolsJson, 'auto_generated']);
                    // 注册新工具到user_tools
                    var toolCount = 0;
                    parsedTools.forEach(function(t) {
                        if (t.name && t.description) {
                            var exists = queryOne('SELECT id FROM user_tools WHERE name=? AND user_id=?', [t.name, userId]);
                            if (!exists) {
                                dbRun('INSERT INTO user_tools (user_id, skill_id, name, description, parameters_json) VALUES (?,?,?,?,?)',
                                    [userId, newId, t.name, t.description, JSON.stringify(t.parameters || {})]);
                                toolCount++;
                                console.log('[Tool] 注册工具: '+t.name+' for user='+userId);
                            }
                        }
                    });
                    saveDB();
                    console.log('[Skill] 技能已创建 id='+newId+' name='+skillName+' tools='+toolCount);
                    resolve({ result: skillContent, thinking: optResult.thinking || '', summary: '已自动创建技能「'+skillName+'」并加载'+(toolCount>0?'（注册了'+toolCount+'个工具）':'') });
                }, streamCallback);
            }
        } else {
            // 动态工具：从user_tools查找并执行（以技能内容为system prompt调用LLM）
            var userTool = queryOne('SELECT ut.*, os.content as skill_content FROM user_tools ut INNER JOIN optimized_skills os ON ut.skill_id=os.id AND os.is_enabled=1 WHERE ut.name=? AND ut.user_id=? AND ut.is_enabled=1', [toolName, userId]);
            if (userTool) {
                console.log('[Tool] 执行动态工具: '+toolName+' skill_id='+userTool.skill_id+' 续接='+!!_continueMsgs);
                var toolIdentityPrefix = '你是小说创作工具子智能体「'+toolName+'」，负责执行以下专项任务。你不是调配师，不需要协调其他工具。如果需要调用其他工具协助，使用 request_tool 向主智能体请求。\n\n';
                var toolSystemPrompt = toolIdentityPrefix + (userTool.skill_content || '');
                // 构建工具列表和 request_tool 定义
                var allTools2 = ORCHESTRATOR_TOOLS.concat(queryAll('SELECT ut.* FROM user_tools ut INNER JOIN optimized_skills os ON ut.skill_id=os.id AND os.is_enabled=1 WHERE ut.user_id=? AND ut.is_enabled=1', [userId]).map(function(t){ return { type:'function', function:{ name:t.name, description:t.description } }; }));
                // 过滤掉自身，防止子智能体递归请求自己
                var toolListStr = allTools2.filter(function(t){ return t.function.name !== toolName; }).map(function(t){ return t.function.name+': '+t.function.description; }).join(' | ');
                var requestToolDef = { type: 'function', function: { name: 'request_tool', description: '向主智能体请求调用工具。可用工具：'+toolListStr, parameters: { type: 'object', properties: { tool_name: { type: 'string', description: '要请求调用的工具名' }, tool_args: { type: 'string', description: '工具参数的JSON字符串，如 {"skill_name":"世界观设计指南"} 或 {}' } }, required: ['tool_name'] } } };
                // 续接模式：使用历史消息继续对话；否则从零开始
                var messages;
                if (_continueMsgs) {
                    messages = JSON.parse(JSON.stringify(_continueMsgs));
                } else {
                    messages = [{ role: 'system', content: toolSystemPrompt }, { role: 'user', content: '用户请求参数：'+argsJson+'\n\n请根据技能指南执行任务并返回结果。' }];
                }
                // 直接调用流式LLM（内联callOutlineLLM逻辑，以支持多轮工具调用）
                _callSubAgentLLM(projectId, userId, messages, toolName, [requestToolDef], streamCallback, function(finalResult) {
                    if (finalResult.error) { resolve({ error: finalResult.error, summary: '动态工具执行失败: '+finalResult.error }); return; }
                    resolve({
                        result: finalResult.content || '',
                        thinking: finalResult.thinking || '',
                        tool_calls: finalResult.tool_calls || [],
                        _subAgentMsgs: finalResult._messages || messages,
                        summary: finalResult.tool_calls && finalResult.tool_calls.length > 0
                            ? '子智能体请求工具: '+finalResult.tool_calls.map(function(tc){return tc.function.name;}).join(', ')
                            : '工具「'+toolName+'」执行完成'
                    });
                });
            } else {
                resolve({ error: '未知工具: '+toolName, summary: '未知工具调用' });
            }
        }
    });
}

// 为用户创建默认技能（如果尚未创建）
function seedDefaultSkills(userId) {
    var existing = queryOne('SELECT id FROM optimized_skills WHERE user_id=? LIMIT 1', [userId]);
    if (existing) return; // 已有技能，跳过
    var defaultSkills = [
        { name:'角色设计指南', content:'# 角色设计指南\n\n## 适用场景\n当用户要求设计小说角色时。\n\n## 操作步骤\n1. 确认用户需要设计角色的数量和类型（主角、反派、配角等）\n2. 调用 generate_characters 工具生成角色档案\n3. 生成完成后向用户汇报结果\n\n## 重要\n- 必须调用 generate_characters 工具，严禁自己编写角色档案\n- 如果用户对角色不满意，可以再次调用工具重新生成' },
        { name:'大纲设计指南', content:'# 大纲设计指南\n\n## 适用场景\n当用户确认需求后需要生成小说大纲时。\n\n## 操作步骤\n1. 确认已完成需求采访和摘要确认\n2. 调用 generate_outline 工具生成分卷分章大纲\n3. 生成完成后向用户汇报卷章数量\n\n## 重要\n- 必须调用 generate_outline 工具，严禁自己编写大纲\n- 用户可以要求调整大纲结构' }
    ];
    defaultSkills.forEach(function(s) {
        dbRun('INSERT INTO optimized_skills (user_id, name_cn, name_en, description, content, json_schema, source, is_enabled) VALUES (?,?,?,?,?,?,?,1)',
            [userId, s.name, '', '系统默认技能', s.content, '', 'auto_generated']);
    });
}

app.post('/api/writing-projects/:id/llm-call', auth, async (req, res) => {
    const projectId = parseInt(req.params.id);
    const { content, stream: useStream } = req.body;
    if (!content) return res.status(400).json({ error:'缺少消息内容' });

    // 检查并创建默认技能
    seedDefaultSkills(req.userId);

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

    // 构建消息
    var msgs = [{ role:'system', content:ORCHESTRATOR_SYSTEM}];
    recentMsgs.forEach(function(m) {
        if (m.role==='user') msgs.push({ role:'user', content:m.content });
        else if (m.role==='assistant') msgs.push({ role:'assistant', content:m.content });
    });
    msgs.push({ role:'user', content:content });

    // 获取用户默认Agent
    var llmAgent = queryOne('SELECT * FROM agents WHERE user_id=? ORDER BY id LIMIT 1', [req.userId]);
    if (!llmAgent || !llmAgent.api_key) {
        console.log('[Write LLM] 无可用智能体, 使用静默回退');
        return res.json({ content:'⚠️ 请先在智能体管理页面配置至少一个AI模型，然后回到这里继续。', agent_type:'orchestrator' });
    }

    var endpoint = llmAgent.api_endpoint;
    var key = llmAgent.api_key;
    var model = agentConfig.model_name || llmAgent.model || 'deepseek-v4-pro';
    var isDS = model && model.toLowerCase().indexOf('deepseek') >= 0;

    // ==================== 工具调用循环（非流式） ====================
    if (useStream) {
        console.log('[Write LLM] 流式模式 项目='+projectId+' 用户输入长度='+content.length);

        // 设置 SSE 响应头
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.write('data: {"type":"connected"}\n\n');

        // 保存用户消息到数据库
        dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content) VALUES (?,?,?,?)',
            [projectId, 'user', 'user', content]);

        // 立即写缓冲——让刷新后的轮询器知道有活跃流
        var streamStartedAt = Date.now();
        saveStreamBuffer(projectId, '', '正在分析需求...', streamStartedAt, 'thinking'); console.log('[Write LLM] 初始缓冲已写入');

        // === MCP风格工具调用循环 ===
        var toolMessages = JSON.parse(JSON.stringify(msgs)); // 深拷贝用于工具循环
        // 加载用户自定义工具，与默认工具合并（按账号隔离）
        var userTools = queryAll('SELECT ut.* FROM user_tools ut INNER JOIN optimized_skills os ON ut.skill_id=os.id AND os.is_enabled=1 WHERE ut.user_id=? AND ut.is_enabled=1', [req.userId]);
        var dynamicTools = userTools.map(function(t) {
            var params = {};
            try { params = JSON.parse(t.parameters_json || '{}'); } catch(e) {}
            return { type: "function", function: { name: t.name, description: t.description, parameters: params } };
        });
        var allTools = ORCHESTRATOR_TOOLS.concat(dynamicTools);
        console.log('[Write LLM] 工具总数='+allTools.length+'（默认='+ORCHESTRATOR_TOOLS.length+' 自定义='+dynamicTools.length+'）');
        // 工具循环心跳保活（子智能体长时间执行时不触发前端超时）
        var toolLoopHeartbeat = setInterval(function() {
            try { res.write('data: {"type":"waiting"}\n\n'); } catch(e) { clearInterval(toolLoopHeartbeat); }
        }, 10000);
        var toolLoopCount = 0;
        while (toolLoopCount < 5) { // 最多5轮工具调用防无限循环
            toolLoopCount++;
            var toolReqBody = { model:model, messages:toolMessages, tools:allTools, temperature:0.7, stream:false };
            console.log('[Write LLM] 工具循环轮次'+toolLoopCount+' 消息数='+toolMessages.length);
            var toolResp = await fetch(endpoint, {
                method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
                body:JSON.stringify(toolReqBody)
            });
            if (!toolResp.ok) { console.log('[Write LLM] 工具调用失败 status='+toolResp.status); clearInterval(toolLoopHeartbeat); break; }
            var toolData = await toolResp.json();
            var toolMsg = toolData.choices && toolData.choices[0] && toolData.choices[0].message;
            if (!toolMsg) { console.log('[Write LLM] 工具响应无message'); clearInterval(toolLoopHeartbeat); break; }

            if (toolMsg.tool_calls && toolMsg.tool_calls.length > 0) {
                console.log('[Write LLM] 检测到'+toolMsg.tool_calls.length+'个工具调用');
                // 入库调配师回复（含思考），防止刷新后丢失这条消息
                var orchContent = toolMsg.content || '';
                var orchThinking = toolMsg.reasoning_content || '';
                if (orchContent || orchThinking) {
                    dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content, thinking, metadata) VALUES (?,?,?,?,?,?)',
                        [projectId, 'orchestrator', 'assistant', orchContent, orchThinking, '{"type":"chat"}']);
                    console.log('[Write LLM] 调配师tool_calls回复已存DB contentLen='+orchContent.length+' thinkingLen='+orchThinking.length);
                }
                toolMessages.push(toolMsg); // 添加助手消息（含tool_calls）
                for (var ti = 0; ti < toolMsg.tool_calls.length; ti++) {
                    var tc = toolMsg.tool_calls[ti];
                    var toolName = tc.function.name;
                    var toolArgs = tc.function.arguments || '{}';
                    // 获取子智能体的默认名（对应前端agentDefaults的type key）
                    var tl2 = toolName.toLowerCase();
                    var subAgentType = tl2.indexOf('outline')>=0?'outliner':tl2.indexOf('character')>=0?'character':tl2.indexOf('crawl')>=0?'crawler':tl2.indexOf('skill_optimizer')>=0?'skill_optimizer':tl2.indexOf('load_skill')>=0?'load_skill':toolName;
                    var platform = ''; try { platform = (tc.function.arguments && JSON.parse(tc.function.arguments).platform) || ''; } catch(e) {}
                    var skillName = ''; try { skillName = (tc.function.arguments && JSON.parse(tc.function.arguments).skill_name) || ''; } catch(e) {}
                    // load_skill 预查：技能不存在时会触发 skill_optimizer；但用户已删除的技能不触发
                    var actualSubAgent = subAgentType;
                    if (subAgentType === 'load_skill' && skillName) {
                        var existingSkill = queryOne('SELECT id, is_enabled FROM optimized_skills WHERE name_cn LIKE ? LIMIT 1', ['%'+skillName+'%']);
                        if (!existingSkill) {
                            // 完全不存在 → 触发skill_optimizer自动创建
                            actualSubAgent = 'skill_optimizer';
                        } else if (existingSkill.is_enabled === 0) {
                            // 用户已删除 → 保持load_skill，不触发skill_optimizer
                            console.log('[Write LLM] 技能已被用户删除: '+skillName);
                        }
                        // else: 技能存在且启用 → 保持load_skill
                    }
                    console.log('[Write LLM] 执行工具: '+toolName+' → agent: '+actualSubAgent);
                    var platformSuffix = (tl2.indexOf('crawl')>=0 && platform) ? '（平台：'+platform+'）' : '';
                    var skillSuffix = (tl2.indexOf('skill')>=0 && skillName) ? '「'+skillName+'」' : '';
                    var inviteMsg = (actualSubAgent === 'skill_optimizer')
                        ? '{agent:orchestrator}调用{agent:skill_optimizer}智能体创建技能'+skillSuffix
                        : (tl2.indexOf('load_skill')>=0)
                            ? '{agent:orchestrator}正在查阅技能指南'+skillSuffix
                            : '{agent:orchestrator}调用{agent:'+actualSubAgent+'}智能体'+platformSuffix+skillSuffix;
                    saveStreamBuffer(projectId, '', inviteMsg+'\n正在生成中...', streamStartedAt, 'tool_calling', actualSubAgent);
                    dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content, metadata) VALUES (?,?,?,?,?)', [projectId, actualSubAgent, 'system', inviteMsg, '{"type":"system"}']);
                    res.write('data: '+JSON.stringify({type:'tool_start',tool:toolName,subAgent:actualSubAgent})+'\n\n');
                    // 创建流式回调：子智能体的思考/正文实时推送到前端
                    var _subC = '', _subT = '';
                    var streamCallback = function(delta) {
                        if (delta.type === 'thinking') _subT += delta.delta;
                        if (delta.type === 'content') _subC += delta.delta;
                        saveStreamBuffer(projectId, _subC.substring(0,500), '', streamStartedAt, 'tool_calling', actualSubAgent, _subC, _subT);
                        try { res.write('data: '+JSON.stringify({type:'tool_stream',tool:toolName,subAgent:actualSubAgent,phase:delta.type,delta:delta.delta})+'\n\n'); } catch(e) {}
                    };
                    var toolResult = await executeToolAsync(toolName, toolArgs, projectId, req.userId, streamCallback);
                    console.log('[Write LLM] 工具完成: '+toolName+' '+toolResult.summary);
                    // 子智能体请求工具循环：处理request_tool
                    var subAgentMsgs = toolResult._subAgentMsgs;
                    var _accContent = toolResult.result || '';
                    var _accThinking = toolResult.thinking || '';
                    while (toolResult.tool_calls && toolResult.tool_calls.length > 0) {
                        var reqTc = toolResult.tool_calls[0];
                        var reqArgs = {};
                        try { reqArgs = JSON.parse(reqTc.function.arguments || '{}'); } catch(e) {}
                        var requestedTool = reqArgs.tool_name || '';
                        var requestedArgs = reqArgs.tool_args || {};
                        if (typeof requestedArgs === 'string') { try { requestedArgs = JSON.parse(requestedArgs); } catch(e) { requestedArgs = {}; } }
                        console.log('[Write LLM] 子智能体 '+toolName+' 请求工具: '+requestedTool);
                        // 通知前端
                        res.write('data: '+JSON.stringify({type:'tool_request',tool:toolName,subAgent:actualSubAgent,requested:requestedTool,args:requestedArgs})+'\n\n');
                        // 执行请求的工具
                        var reqResult = await executeToolAsync(requestedTool, JSON.stringify(requestedArgs), projectId, req.userId);
                        console.log('[Write LLM] 子智能体请求的工具完成: '+requestedTool+' '+reqResult.summary);
                        // 将工具结果注入子智能体会话
                        var toolResultMsg = { role: 'tool', tool_call_id: reqTc.id, content: JSON.stringify(reqResult) };
                        subAgentMsgs.push(toolResultMsg);
                        // 继续子智能体LLM（续接模式），累积写缓冲
                        streamCallback = function(delta) {
                            if (delta.type === 'thinking') _subT += delta.delta;
                            if (delta.type === 'content') _subC += delta.delta;
                            saveStreamBuffer(projectId, _subC.substring(0,500), '', streamStartedAt, 'tool_calling', actualSubAgent, _subC, _subT);
                            try { res.write('data: '+JSON.stringify({type:'tool_stream',tool:toolName,subAgent:actualSubAgent,phase:delta.type,delta:delta.delta})+'\n\n'); } catch(e) {}
                        };
                        toolResult = await executeToolAsync(toolName, toolArgs, projectId, req.userId, streamCallback, subAgentMsgs);
                        console.log('[Write LLM] 子智能体继续完成: '+toolName+' '+toolResult.summary);
                        _accContent += toolResult.result || '';
                        _accThinking += toolResult.thinking || '';
                        subAgentMsgs = toolResult._subAgentMsgs || subAgentMsgs;
                    }
                    // 用累积值覆盖最后一轮结果，保证tool_end/DB记录完整
                    toolResult.result = _accContent;
                    toolResult.thinking = _accThinking;
                    var resultContent = toolResult.result ? (toolResult.result||'').substring(0, 500) : toolResult.summary;
                    saveStreamBuffer(projectId, resultContent, '✅ '+toolResult.summary, streamStartedAt, 'tool_result', actualSubAgent, toolResult.result||'', toolResult.thinking||'');
                    dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content, metadata) VALUES (?,?,?,?,?)', [projectId, actualSubAgent, 'system', '✅ '+toolResult.summary, '{"type":"system"}']);
                    res.write('data: '+JSON.stringify({type:'tool_end',tool:toolName,subAgent:actualSubAgent,summary:toolResult.summary,content:toolResult.result||'',thinking:toolResult.thinking||''})+'\n\n');
                    toolMessages.push({ role:'tool', tool_call_id:tc.id, content:JSON.stringify(toolResult) });
                }
            } else {
                // 无工具调用 → 这是最终回复，用流式输出
                clearInterval(toolLoopHeartbeat);
                console.log('[Write LLM] 无工具调用，进入流式输出 contentLen='+(toolMsg.content?toolMsg.content.length:0)+' thinkingLen='+(toolMsg.reasoning_content?toolMsg.reasoning_content.length:0));
                var finalContent = toolMsg.content || '（工具调用已完成）';
                var finalThinking = toolMsg.reasoning_content || '';
                msgs.push({ role:'assistant', content:finalContent });
                // 直接发送done（工具调用后的最终回复用非流式）
                dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content, thinking, token_used) VALUES (?,?,?,?,?,?)', [projectId, 'orchestrator', 'assistant', finalContent, finalThinking, (toolData.usage?toolData.usage.total_tokens:0)]); console.log('[Write LLM] 最终回复已存DB contentLen='+finalContent.length);
                saveDB();
                clearStreamBuffer(projectId);
                res.write('data: '+JSON.stringify({type:'done',content:finalContent,thinking:finalThinking})+'\n\n');
                res.end();
                return;
            }
        }
        clearInterval(toolLoopHeartbeat);
        // 工具循环结束但超过最大轮次 → 流式输出当前消息
        console.log('[Write LLM] 工具循环结束（轮次='+toolLoopCount+'），进入流式');
        // 将工具消息合并回msgs用于后续流式
        msgs = toolMessages;

        var streamReqBody = { model:model, messages:msgs, stream:true, temperature:0.7 };

        try {
            var fetchStart = Date.now();
            var llmResp = await fetch(endpoint, {
                method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
                body:JSON.stringify(streamReqBody)
            });
            console.log('[Write LLM] fetch耗时='+(Date.now()-fetchStart)+'ms status='+llmResp.status);

            if (!llmResp.ok) {
                var errTxt = await llmResp.text();
                console.log('[Write LLM] 错误响应体:', errTxt.substring(0,300));
                res.write('data: '+JSON.stringify({type:'error',message:'API错误 '+llmResp.status+': '+errTxt.substring(0,200)})+'\n\n');
                res.end();
                return;
            }

            console.log('[Write LLM] DeepSeek响应状态='+llmResp.status+' contentType='+(llmResp.headers.get('content-type')||'?'));
            var reader = llmResp.body.getReader();
            var decoder = new TextDecoder();
            var buf = '';
            var fullContent = '';
            var fullThinking = '';
            var tokIn = 0, tokOut = 0;
            var chunkCount = 0;

            // 心跳保活（10秒间隔）；若写入失败说明客户端已断开→转入后台模式
            var heartbeat = setInterval(function() {
                try { res.write('data: {"type":"waiting"}\n\n'); } catch(e) { clearInterval(heartbeat); clientGone = true; }
            }, 10000);

            var clientGone = false;
            // 监听连接关闭（页面刷新/关闭时最可靠的检测方式）
            req.on('close', function() {
                if (!clientGone) {
                    clientGone = true;
                    clearInterval(heartbeat);
                    console.log('[Write LLM] 客户端断开（req.close），转入后台模式');
                }
            });
            console.log('[Write LLM] 进入读循环');
            while (true) {
                var chunk = await reader.read();
                chunkCount++;
                // 检查停止标记（用户从新页面点击了停止）
                var stopMarker = path.join(BUFFER_DIR, 'stop_'+projectId);
                if (fs.existsSync(stopMarker)) {
                    console.log('[Write LLM] 收到停止信号，终止流式');
                    reader.cancel();
                    clearInterval(heartbeat);
                    try { fs.unlinkSync(stopMarker); } catch(e) {}
                    return;
                }
                if (chunk.done) { console.log('[Write LLM] DeepSeek流结束 chunkCount='+chunkCount); break; }

                buf += decoder.decode(chunk.value, { stream:true });
                var lines = buf.split('\n');
                buf = lines.pop() || '';

                for (var li = 0; li < lines.length; li++) {
                    var line = lines[li].trim();
                    if (!line || line.indexOf('data: ') !== 0) continue;
                    var data = line.slice(6);
                    if (data === '[DONE]') continue;
                    try {
                        var parsed = JSON.parse(data);
                        var delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
                        if (delta && delta.reasoning_content) {
                            fullThinking += delta.reasoning_content;
                            if (!clientGone) res.write('data: '+JSON.stringify({type:'thinking',delta:delta.reasoning_content})+'\n\n');
                        }
                        if (delta && delta.content) {
                            fullContent += delta.content;
                            if (!clientGone) res.write('data: '+JSON.stringify({type:'content',delta:delta.content})+'\n\n');
                        }
                        // 写入磁盘缓冲（断线续传用）
                        saveStreamBuffer(projectId, fullContent, fullThinking, streamStartedAt, 'final');
                        // 广播给 write-sse 客户端
                        if (delta && (delta.reasoning_content || delta.content)) {
                            broadcastWriteEvent(projectId, {type:delta.reasoning_content?'thinking':'content',delta:delta.reasoning_content||delta.content});
                        }
                        if (parsed.usage) {
                            tokIn = parsed.usage.prompt_tokens || 0;
                            tokOut = parsed.usage.completion_tokens || 0;
                        }
                    } catch(e) {}
                }
            }

            clearInterval(heartbeat);

            // 保存助手回复到数据库（无论客户端是否断开）
            if (fullContent || fullThinking) {
                dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content, thinking, token_used) VALUES (?,?,?,?,?,?)',
                    [projectId, 'orchestrator', 'assistant', fullContent, fullThinking, tokIn+tokOut]);
                dbRun('INSERT INTO token_usage_logs (user_id, project_id, agent_type, model, input_tokens, output_tokens) VALUES (?,?,?,?,?,?)',
                    [req.userId, projectId, 'orchestrator', model, tokIn, tokOut]);
                saveDB();
            }

            console.log('[Write LLM] 流式完成 回复长度='+fullContent.length+' 思考长度='+fullThinking.length+' tokens in='+tokIn+' out='+tokOut+(clientGone?' (后台完成)':''));

            // 通知 SSE 客户端 + 清除磁盘缓冲和停止标记
            broadcastWriteEvent(projectId, {type:'stream-done',content:fullContent,thinking:fullThinking});
            clearStreamBuffer(projectId);
            try { var sm = path.join(BUFFER_DIR, 'stop_'+projectId); if (fs.existsSync(sm)) fs.unlinkSync(sm); } catch(e) {}

            if (!clientGone) {
                res.write('data: '+JSON.stringify({
                    type:'done', content:fullContent, thinking:fullThinking,
                    token_in:tokIn, token_out:tokOut
                })+'\n\n');
                res.end();
            }

        } catch(err) {
            console.error('[Write LLM] 流式异常:', err.message);
            try { if (!res.headersSent || !res.writableEnded) { res.write('data: '+JSON.stringify({type:'error',message:err.message})+'\n\n'); res.end(); } } catch(e) {}
            dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content) VALUES (?,?,?,?)',
                [projectId, 'orchestrator', 'assistant', '⚠️ 调用失败：'+err.message]);
            saveDB();
        }
        return;
    }

    // ==================== 非流式模式（兼容旧行为） ====================
    console.log('[Write LLM] 项目='+projectId+' 用户输入长度='+content.length);

    // 保存用户消息
    dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content) VALUES (?,?,?,?)', [projectId, 'user', 'user', content]);

    var reqBody = { model:model, messages:msgs, temperature:0.7, stream:false };

    console.log('[Write LLM] 调用 model='+model+' 消息数='+msgs.length+' endpoint='+endpoint.substring(0,40)+'...');

    fetch(endpoint, {
        method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
        body:JSON.stringify(reqBody)
    }).then(function(r){ return r.json(); }).then(function(d) {
        if (req.aborted) { console.log('[Write LLM] 前端已断开，放弃保存'); return; }
        var reply = (d.choices && d.choices[0] && d.choices[0].message) ? d.choices[0].message.content : '';
        var thinking = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.reasoning_content) ? d.choices[0].message.reasoning_content : '';
        if (!reply) { console.log('[Write LLM] 空响应'); reply='（模型未返回内容，请重试）'; }
        var tokIn = (d.usage && d.usage.prompt_tokens)||0;
        var tokOut = (d.usage && d.usage.completion_tokens)||0;
        console.log('[Write LLM] 回复长度='+reply.length+' tokens in='+tokIn+' out='+tokOut);

        dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content, thinking, token_used) VALUES (?,?,?,?,?,?)',
            [projectId, 'orchestrator', 'assistant', reply, thinking||'', tokIn+tokOut]);
        dbRun('INSERT INTO token_usage_logs (user_id, project_id, agent_type, model, input_tokens, output_tokens) VALUES (?,?,?,?,?,?)',
            [req.userId, projectId, 'orchestrator', model, tokIn, tokOut]);
        saveDB();

        res.json({ content:reply, thinking:thinking||'', token_in:tokIn, token_out:tokOut });
    }).catch(function(err) {
        if (req.aborted) { console.log('[Write LLM] 前端已断开，放弃错误保存'); return; }
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
    callOutlineLLM(projectId, req.userId, DIALOG_SYSTEM, context, 'dialog', req, function(result) {
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
    callOutlineLLM(projectId, req.userId, CHARACTER_SYSTEM, context, 'character', req, function(result) {
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

// streamCallback: 流式回调 function({type:'thinking'|'content', delta:'...'})，null=非流式
// tools: 工具定义数组(用于request_tool机制)，null=不传工具
function callOutlineLLM(projectId, userId, systemPrompt, userContent, agentType, req, callback, streamCallback, tools) {
    var llmAgent = queryOne('SELECT * FROM agents WHERE user_id=? ORDER BY id LIMIT 1', [userId]);
    if (!llmAgent || !llmAgent.api_key) { callback({ error:'请先在智能体管理页面配置至少一个AI模型' }); return; }
    var agentConfig = queryOne('SELECT * FROM writing_agent_config WHERE project_id=? AND agent_type=?', [projectId, agentType]);
    var model = (agentConfig && agentConfig.model_name) || llmAgent.model || 'deepseek-v4-pro';
    var isDS = model.toLowerCase().indexOf('deepseek') >= 0;
    var isStream = !!streamCallback;
    var reqBody = { model:model, messages:[{ role:'system', content:systemPrompt },{ role:'user', content:userContent }], temperature:0.6, stream:isStream };
    if (isDS && isStream) { reqBody.thinking = { type: 'enabled' }; reqBody.reasoning_effort = 'max'; }
    if (tools && tools.length) reqBody.tools = tools;
    console.log('[Writing '+agentType+'] 调用 model='+model+' stream='+isStream+' 提示词长度='+userContent.length);
    var checkAbort = req || {};
    fetch(llmAgent.api_endpoint, {
        method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+llmAgent.api_key},
        body:JSON.stringify(reqBody)
    }).then(function(r) {
        if (!r.ok) return r.text().then(function(t) { throw new Error('HTTP '+r.status+': '+t.substring(0,200)); });
        if (!isStream) return r.json().then(function(d) {
            var reply = (d.choices && d.choices[0] && d.choices[0].message) ? d.choices[0].message.content : '';
            var thinking = (d.choices && d.choices[0] && d.choices[0].message) ? (d.choices[0].message.reasoning_content || '') : '';
            var tokIn = (d.usage && d.usage.prompt_tokens)||0, tokOut = (d.usage && d.usage.completion_tokens)||0;
            if (!reply && !thinking) { callback({ error:'模型未返回内容' }); return; }
            console.log('[Writing '+agentType+'] 非流式完成 回复='+reply.length+' 思考='+thinking.length+' tokens in='+tokIn+' out='+tokOut);
            dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content, thinking, token_used) VALUES (?,?,?,?,?,?)', [projectId, agentType, 'assistant', reply, thinking, tokIn+tokOut]);
            dbRun('INSERT INTO token_usage_logs (user_id, project_id, agent_type, model, input_tokens, output_tokens) VALUES (?,?,?,?,?,?)', [userId, projectId, agentType, model, tokIn, tokOut]);
            saveDB();
            callback({ content:reply, thinking:thinking, token_in:tokIn, token_out:tokOut });
        });
        // 流式模式
        var reader = r.body.getReader();
        var decoder = new TextDecoder();
        var buf = '', fullContent = '', fullThinking = '', tokIn = 0, tokOut = 0;
        var fullToolCalls = []; // 子智能体请求的工具调用
        function pump() {
            reader.read().then(function(chunk) {
                if (checkAbort.aborted || checkAbort.destroyed) { console.log('[Writing '+agentType+'] 前端已断开'); return; }
                if (chunk.done) {
                    // 筛选有效 tool_calls
                    var validCalls = fullToolCalls.filter(function(tc){ return tc.function.name; });
                    console.log('[Writing '+agentType+'] 流式完成 回复='+fullContent.length+' 思考='+fullThinking.length+' tool_calls='+validCalls.length+' tokens in='+tokIn+' out='+tokOut);
                    if (validCalls.length > 0) {
                        console.log('[Writing '+agentType+'] 子智能体请求工具: '+validCalls.map(function(tc){return tc.function.name;}).join(', '));
                    }
                    // 流式模式下不存DB（由前端tool_end保存，避免刷新后双气泡）
                    dbRun('INSERT INTO token_usage_logs (user_id, project_id, agent_type, model, input_tokens, output_tokens) VALUES (?,?,?,?,?,?)', [userId, projectId, agentType, model, tokIn, tokOut]);
                    saveDB();
                    callback({ content:fullContent, thinking:fullThinking, tool_calls:validCalls, token_in:tokIn, token_out:tokOut });
                    return;
                }
                buf += decoder.decode(chunk.value, { stream: true });
                var lines = buf.split('\n'); buf = lines.pop() || '';
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i].trim();
                    if (!line || line.indexOf('data: ') !== 0) continue;
                    var raw = line.slice(6);
                    if (raw === '[DONE]') continue;
                    try {
                        var parsed = JSON.parse(raw);
                        if (parsed.usage) { tokIn = parsed.usage.prompt_tokens || 0; tokOut = parsed.usage.completion_tokens || 0; }
                        var delta = (parsed.choices && parsed.choices[0]) ? parsed.choices[0].delta : null;
                        if (!delta) continue;
                        if (delta.reasoning_content) {
                            fullThinking += delta.reasoning_content;
                            streamCallback({ type: 'thinking', delta: delta.reasoning_content });
                        }
                        if (delta.content) {
                            fullContent += delta.content;
                            streamCallback({ type: 'content', delta: delta.content });
                        }
                        // 检测 tool_calls（按index累积，允许name跨帧到达）
                        if (delta.tool_calls) {
                            delta.tool_calls.forEach(function(tc) {
                                var _idx = tc.index;
                                if (_idx === undefined || _idx === null) return;
                                if (!fullToolCalls[_idx]) fullToolCalls[_idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
                                if (tc.id) fullToolCalls[_idx].id = tc.id;
                                if (tc.function) {
                                    if (tc.function.name) fullToolCalls[_idx].function.name = tc.function.name;
                                    if (tc.function.arguments) fullToolCalls[_idx].function.arguments += tc.function.arguments;
                                }
                            });
                        }
                    } catch(e) {}
                }
                pump();
            }).catch(function(err) {
                console.error('[Writing '+agentType+'] 流式读取异常:', err.message);
                callback({ error: err.message });
            });
        }
        pump();
    }).catch(function(err) {
        if (checkAbort.aborted || checkAbort.destroyed) { console.log('[Writing '+agentType+'] 前端已断开'); return; }
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

    callOutlineLLM(projectId, req.userId, OUTLINER_SYSTEM, context, 'outliner', req, function(result) {
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
// ==================== 章节版本历史 ====================
app.post('/api/writing-projects/:id/chapter-versions', auth, (req, res) => {
    const { chapter_id, content_text, word_count, save_type, label } = req.body;
    const projectId = parseInt(req.params.id);
    const id = dbRun('INSERT INTO chapter_versions (project_id, chapter_id, content_text, word_count, save_type, label) VALUES (?,?,?,?,?,?)',
        [projectId, chapter_id, content_text||'', word_count||0, save_type||'manual', label||'']);
    saveDB();
    res.json({ id, created_at: new Date().toISOString() });
});

app.get('/api/writing-projects/:id/chapter-versions/:cid', auth, (req, res) => {
    const versions = queryAll('SELECT * FROM chapter_versions WHERE chapter_id=? ORDER BY created_at DESC LIMIT 200', [req.params.cid]);
    res.json(versions);
});

app.delete('/api/writing-projects/:id/chapter-versions/:vid', auth, (req, res) => {
    dbRun('DELETE FROM chapter_versions WHERE id=?', [req.params.vid]);
    saveDB();
    res.json({ ok:true });
});

// 删除卷时级联删除所有章节的版本历史（在DELETE /volumes端点中已处理）
// 章节删除时级联删除其版本历史
app.delete('/api/writing-projects/:id/chapters/:cid', auth, (req, res) => {
    dbRun('DELETE FROM chapter_versions WHERE chapter_id=?', [req.params.cid]);
    dbRun('DELETE FROM writing_chapters WHERE id=?', [req.params.cid]);
    saveDB();
    console.log('[Writing] 删除章 id='+req.params.cid);
    res.json({ ok:true });
});

// 卷删除时级联删除章节+版本历史
app.delete('/api/writing-projects/:id/volumes/:vid', auth, (req, res) => {
    // 先删所有子章节的版本历史
    var chaps = queryAll('SELECT id FROM writing_chapters WHERE volume_id=?', [req.params.vid]);
    chaps.forEach(function(c) { dbRun('DELETE FROM chapter_versions WHERE chapter_id=?', [c.id]); });
    dbRun('DELETE FROM writing_chapters WHERE volume_id=?', [req.params.vid]);
    dbRun('DELETE FROM writing_volumes WHERE id=?', [req.params.vid]);
    saveDB();
    console.log('[Writing] 删除卷 id='+req.params.vid);
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

// GET 流式磁盘缓冲（断线续传用）
app.get('/api/writing-projects/:id/stream-buffer', auth, (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    var bufPath = streamBufferPath(req.params.id);
    if (fs.existsSync(bufPath)) {
        try {
            var buf = JSON.parse(fs.readFileSync(bufPath, 'utf-8'));
            res.json(buf);
        }
        catch(e) { console.log('[Buffer] 读取失败:', e.message); res.json(null); }
    } else {
        res.json(null);
    }
});

// POST 停止后台流式（创建停止标记文件）
app.post('/api/writing-projects/:id/stop-stream', auth, (req, res) => {
    try { fs.writeFileSync(path.join(BUFFER_DIR, 'stop_'+req.params.id), '1'); } catch(e) {}
    res.json({ ok: true });
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
    db.run('CREATE TABLE IF NOT EXISTS chapter_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, chapter_id INTEGER NOT NULL, content_text TEXT DEFAULT \'\', word_count INTEGER DEFAULT 0, save_type TEXT DEFAULT \'manual\', label TEXT DEFAULT \'\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS writing_quality_ratings (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, chapter_id INTEGER, user_rating INTEGER, edit_distance_ratio REAL, ai_similarity_score REAL, agent_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS optimized_skills (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name_cn TEXT NOT NULL, name_en TEXT DEFAULT \'\', description TEXT DEFAULT \'\', content TEXT NOT NULL, json_schema TEXT DEFAULT \'\', source TEXT DEFAULT \'auto_generated\', is_enabled INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS user_tools (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, skill_id INTEGER, name TEXT NOT NULL, description TEXT DEFAULT \'\', parameters_json TEXT DEFAULT \'{}\', is_enabled INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');

// ==================== 爬虫Agent ====================

app.post('/api/writing-projects/:id/crawl-books', auth, (req, res) => {
    var projectId = parseInt(req.params.id);
    var { platform, html_content } = req.body;
    console.log('[Writing 爬虫] 项目='+projectId+' 平台='+(platform||'手动'));
    if (!html_content) return res.status(400).json({ error:'需要提供HTML内容' });
    callOutlineLLM(projectId, req.userId, CRAWLER_SYSTEM, '请从以下HTML提取小说信息：\n平台：'+(platform||'未知')+'\nHTML：'+html_content.substring(0, 30000), 'crawler', req, function(result) {
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
    callOutlineLLM(projectId, req.userId, skillPrompt, context, 'skill_optimizer', req, function(result) {
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
    callOutlineLLM(projectId, req.userId, REVIEWER_SYSTEM, context, 'reviewer', req, function(result) {
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

// ==================== Skill 管理 ====================
// GET 列出用户的优化技能
app.get('/api/writing-projects/:id/skills', auth, (req, res) => {
    try {
        var skills = queryAll('SELECT * FROM optimized_skills WHERE user_id=? AND is_enabled=1 ORDER BY updated_at DESC', [req.userId]);
        res.json(skills || []);
    } catch(e) { console.error('[Skill] GET skills error:', e); res.status(500).json({ error: e.message }); }
});

// POST 创建新技能
app.post('/api/writing-projects/:id/skills', auth, (req, res) => {
    try {
        var { name_cn, name_en, description, content, json_schema } = req.body;
        if (!name_cn) return res.status(400).json({ error: 'name_cn必填' });
        var id = dbRun('INSERT INTO optimized_skills (user_id, name_cn, name_en, description, content, json_schema, is_enabled) VALUES (?,?,?,?,?,?,0)',
            [req.userId, name_cn, name_en||'', description||'', content, json_schema||'']);
        console.log('[Skill] 创建技能 id='+id+' name='+name_cn);
        res.json({ id: id, ok: true });
    } catch(e) { console.error('[Skill] POST skill error:', e); res.status(500).json({ error: e.message }); }
});

// PUT 更新技能
app.put('/api/writing-projects/:id/skills/:sid', auth, (req, res) => {
    try {
        var sid = parseInt(req.params.sid);
        var skill = queryOne('SELECT * FROM optimized_skills WHERE id=? AND user_id=?', [sid, req.userId]);
        if (!skill) return res.status(404).json({ error: '技能不存在' });
        var sets = [];
        var params = [];
        ['name_cn','name_en','description','content','json_schema'].forEach(function(k) {
            if (req.body[k] !== undefined) { sets.push(k+'=?'); params.push(req.body[k]); }
        });
        if (req.body.is_enabled !== undefined) { sets.push('is_enabled=?'); params.push(req.body.is_enabled ? 1 : 0); }
        if (sets.length) {
            sets.push('updated_at=CURRENT_TIMESTAMP');
            params.push(sid);
            dbRun('UPDATE optimized_skills SET '+sets.join(',')+' WHERE id=?', params);
            saveDB();
            console.log('[Skill] 更新技能 id='+sid);
        }
        res.json({ ok: true });
    } catch(e) { console.error('[Skill] PUT skill error:', e); res.status(500).json({ error: e.message }); }
});

// DELETE 删除技能（软删除：设为禁用 + 级联禁用关联工具）
app.delete('/api/writing-projects/:id/skills/:sid', auth, (req, res) => {
    try {
        var sid = parseInt(req.params.sid);
        // 软删除：禁用技能而非物理删除，防止调配师重复创建
        dbRun('UPDATE optimized_skills SET is_enabled=0, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?', [sid, req.userId]);
        // 级联禁用关联的动态工具
        dbRun('UPDATE user_tools SET is_enabled=0, updated_at=CURRENT_TIMESTAMP WHERE skill_id=? AND user_id=?', [sid, req.userId]);
        console.log('[Skill] 软删除技能 id='+sid+'（已级联禁用关联工具）');
        res.json({ ok: true });
    } catch(e) { console.error('[Skill] DELETE skill error:', e); res.status(500).json({ error: e.message }); }
});

// POST 切换技能启用/禁用
app.post('/api/writing-projects/:id/toggle-skill/:sid', auth, (req, res) => {
    try {
        var sid = parseInt(req.params.sid);
        var skill = queryOne('SELECT * FROM optimized_skills WHERE id=? AND user_id=?', [sid, req.userId]);
        if (!skill) return res.status(404).json({ error: '技能不存在' });
        var newVal = skill.is_enabled ? 0 : 1;
        dbRun('UPDATE optimized_skills SET is_enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [newVal, sid]);
        saveDB();
        console.log('[Skill] 切换技能 id='+sid+' enabled='+newVal);
        res.json({ ok: true, is_enabled: !!newVal });
    } catch(e) { console.error('[Skill] Toggle skill error:', e); res.status(500).json({ error: e.message }); }
});

// ==================== 用户工具管理（动态注册） ====================
// GET 获取用户的所有动态工具
app.get('/api/writing-projects/:id/tools', auth, (req, res) => {
    try {
        var tools = queryAll('SELECT ut.*, os.name_cn as skill_name FROM user_tools ut LEFT JOIN optimized_skills os ON ut.skill_id=os.id WHERE ut.user_id=? ORDER BY ut.updated_at DESC', [req.userId]);
        res.json(tools || []);
    } catch(e) { console.error('[Tool] GET tools error:', e); res.status(500).json({ error: e.message }); }
});

// PUT 更新工具
app.put('/api/writing-projects/:id/tools/:tid', auth, (req, res) => {
    try {
        var tid = parseInt(req.params.tid);
        var tool = queryOne('SELECT * FROM user_tools WHERE id=? AND user_id=?', [tid, req.userId]);
        if (!tool) return res.status(404).json({ error: '工具不存在' });
        var { name, description, parameters_json, is_enabled } = req.body;
        var sets = [], params = [];
        if (name !== undefined) { sets.push('name=?'); params.push(name); }
        if (description !== undefined) { sets.push('description=?'); params.push(description); }
        if (parameters_json !== undefined) { sets.push('parameters_json=?'); params.push(parameters_json); }
        if (is_enabled !== undefined) { sets.push('is_enabled=?'); params.push(is_enabled ? 1 : 0); }
        if (sets.length) { sets.push('updated_at=CURRENT_TIMESTAMP'); params.push(tid); dbRun('UPDATE user_tools SET '+sets.join(',')+' WHERE id=?', params); saveDB(); }
        res.json({ ok: true });
    } catch(e) { console.error('[Tool] PUT tool error:', e); res.status(500).json({ error: e.message }); }
});

// DELETE 删除工具
app.delete('/api/writing-projects/:id/tools/:tid', auth, (req, res) => {
    try {
        var tid = parseInt(req.params.tid);
        dbRun('DELETE FROM user_tools WHERE id=? AND user_id=?', [tid, req.userId]);
        saveDB();
        res.json({ ok: true });
    } catch(e) { console.error('[Tool] DELETE tool error:', e); res.status(500).json({ error: e.message }); }
});

// ==================== Agent API 配置 ====================
// GET 获取项目下所有agent配置
app.get('/api/writing-projects/:id/agent-api-config', auth, (req, res) => {
    try {
        var configs = queryAll('SELECT * FROM writing_agent_config WHERE project_id=? ORDER BY agent_type', [req.params.id]);
        res.json(configs || []);
    } catch(e) { console.error('[AgentConfig] GET error:', e); res.status(500).json({ error: e.message }); }
});

// PUT 更新单个agent配置
app.put('/api/writing-projects/:id/agent-api-config', auth, (req, res) => {
    try {
        var { agent_type, api_endpoint, api_key, provider, model_name, temperature, max_tokens, system_prompt } = req.body;
        if (!agent_type) return res.status(400).json({ error: 'agent_type必填' });
        var projectId = parseInt(req.params.id);
        var existing = queryOne('SELECT * FROM writing_agent_config WHERE project_id=? AND agent_type=?', [projectId, agent_type]);
        if (existing) {
            var sets = [];
            var params = [];
            if (api_endpoint !== undefined) { sets.push('api_endpoint=?'); params.push(api_endpoint); }
            if (api_key !== undefined) { sets.push('api_key=?'); params.push(api_key); }
            if (model_name !== undefined) { sets.push('model_name=?'); params.push(model_name); }
            if (temperature !== undefined) { sets.push('temperature=?'); params.push(temperature); }
            if (max_tokens !== undefined) { sets.push('max_tokens=?'); params.push(max_tokens); }
            if (system_prompt !== undefined) { sets.push('system_prompt=?'); params.push(system_prompt); }
            if (sets.length) {
                sets.push('updated_at=CURRENT_TIMESTAMP');
                params.push(projectId); params.push(agent_type);
                dbRun('UPDATE writing_agent_config SET '+sets.join(',')+' WHERE project_id=? AND agent_type=?', params);
                saveDB();
            }
        } else {
            dbRun('INSERT INTO writing_agent_config (project_id, agent_type, api_endpoint, api_key, model_name, temperature, max_tokens, system_prompt) VALUES (?,?,?,?,?,?,?,?)',
                [projectId, agent_type, api_endpoint||'', api_key||'', model_name||'', temperature||null, max_tokens||null, system_prompt||'']);
        }
        console.log('[AgentConfig] 保存 '+agent_type+' for project '+projectId);
        res.json({ ok: true });
    } catch(e) { console.error('[AgentConfig] PUT error:', e); res.status(500).json({ error: e.message }); }
});
    db.run('CREATE TABLE IF NOT EXISTS writing_agent_config (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, agent_type TEXT NOT NULL, model_name TEXT, temperature REAL, api_endpoint TEXT, api_key TEXT, system_prompt TEXT, max_tokens INTEGER, is_muted INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(project_id, agent_type))');
    db.run('CREATE TABLE IF NOT EXISTS agent_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, agent_type TEXT NOT NULL, role TEXT NOT NULL, content TEXT DEFAULT \'\', thinking TEXT DEFAULT \'\', tool_calls TEXT DEFAULT \'\', metadata TEXT DEFAULT \'{"type":"chat"}\', token_used INTEGER DEFAULT 0, status TEXT DEFAULT \'done\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS token_usage_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, project_id INTEGER NOT NULL, agent_type TEXT, model TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cost_input REAL DEFAULT 0.0, cost_output REAL DEFAULT 0.0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS token_pricing_config (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, model_name TEXT NOT NULL, input_price_per_million REAL DEFAULT 0.0, output_price_per_million REAL DEFAULT 0.0, cache_hit_price_per_million REAL DEFAULT 0.0, discount_rate REAL DEFAULT 1.0, discount_valid_until TEXT DEFAULT \'\', is_default INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');

    // 默认token费用配置（DeepSeek V4 Pro 2026-05-31后永久降价至2.5折价格）
    var hasPricing = queryOne('SELECT id FROM token_pricing_config WHERE is_default=1 LIMIT 1');
    if (!hasPricing) {
        dbRun('INSERT INTO token_pricing_config (user_id, model_name, input_price_per_million, output_price_per_million, cache_hit_price_per_million, discount_rate, discount_valid_until, is_default) VALUES (NULL, \'deepseek-v4-pro\', 0.025, 6.0, 0.025, 1.0, \'\', 1)');
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
