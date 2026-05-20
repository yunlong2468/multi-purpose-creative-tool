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

// 创建项目
app.post('/api/projects', auth, (req, res) => {
    let name = (req.body.name || '').trim();
    if (!name) {
        // 自动命名：检查是否已有"新建项目"
        const existing = queryOne('SELECT COUNT(*) AS cnt FROM projects WHERE user_id = ? AND name = ?', [req.userId, '新建项目']);
        if (existing && existing.cnt > 0) {
            const now = new Date();
            name = '新建项目 ' + now.getFullYear() + '-' +
                String(now.getMonth() + 1).padStart(2, '0') + '-' +
                String(now.getDate()).padStart(2, '0') + ' ' +
                String(now.getHours()).padStart(2, '0') + ':' +
                String(now.getMinutes()).padStart(2, '0');
        } else {
            name = '新建项目';
        }
    }
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
