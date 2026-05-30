// 无限画布 - 本地后端服务（多画布版）
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const child_process = require('child_process');
const initSqlJs = require('sql.js');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { HNSW, vectorToBlob } = require('./hnsw_index.js');

let JWT_SECRET = process.env.JWT_SECRET || '';
let JWT_EXPIRES = '7d';
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

// 从 prompts/ 目录加载系统提示词（避免大段文本硬编码在server.js中）
var PROMPTS_DIR = path.join(__dirname, 'prompts');
var _promptCache = {};
function loadPrompt(filename) {
    if (_promptCache[filename]) return _promptCache[filename];
    var filePath = path.join(PROMPTS_DIR, filename);
    try {
        var content = fs.readFileSync(filePath, 'utf8').trim();
        _promptCache[filename] = content;
        console.log('[Prompt] 已加载 ' + filename + ' (' + content.length + ' 字符)');
        return content;
    } catch(e) {
        console.error('[Prompt] 加载失败 ' + filename + ': ' + e.message);
        return ''; // 降级：返回空字符串，不阻塞启动
    }
}

// ==================== SQL.js 数据库 ====================
let db = null;

function queryAll(sql, params) { if (!db) return []; const s = db.prepare(sql); if (params) s.bind(params); const r = []; while (s.step()) r.push(s.getAsObject()); s.free(); return r; }
function queryOne(sql, params) { const r = queryAll(sql, params); return r.length > 0 ? r[0] : null; }
function dbRun(sql, params) { if (!db) return 0; db.run(sql, params); const r = queryOne('SELECT last_insert_rowid() AS id'); saveDB(); return r ? r.id : 0; }
function saveDB() { if (!db) return; fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }
// 系统配置读写（密钥/Token集中管理，数据不入git）
function getSysConfig(key) { var row = queryOne('SELECT value FROM system_config WHERE key=?', [key]); return row ? row.value : ''; }
function setSysConfig(key, value) { dbRun('INSERT OR REPLACE INTO system_config (key, value) VALUES (?,?)', [key, value]); saveDB(); }

// ===== tool_request 用户确认机制 =====
// 子智能体请求工具时暂停流式，等待用户确认
var pendingToolConfirms = {}; // confirmId → { resolve, reject, timeout, tool, requested, createdAt }
var _confirmCounter = 0;

// 构建项目进度摘要（注入system prompt，让LLM知道已完成的工作）
function _buildProjectSummary(projectId, userId) {
    var items = [];
    try {
        var crawler = queryOne('SELECT COUNT(*) as c FROM agent_crawler_data WHERE project_id=?', [projectId]);
        if (crawler && crawler.c > 0) items.push('已爬取 '+crawler.c+' 本参考书籍');
        var vols = queryOne('SELECT COUNT(*) as c FROM writing_volumes WHERE project_id=?', [projectId]);
        var chaps = queryOne('SELECT COUNT(*) as c FROM writing_chapters WHERE project_id=?', [projectId]);
        if (vols && vols.c > 0) items.push('已生成 '+vols.c+' 卷 '+(chaps?chaps.c:0)+' 章大纲');
        var chars = queryOne('SELECT COUNT(*) as c FROM writing_characters WHERE project_id=?', [projectId]);
        if (chars && chars.c > 0) items.push('已设计 '+chars.c+' 个角色');
        var skills = queryOne('SELECT COUNT(*) as c FROM optimized_skills WHERE user_id=? AND is_enabled=1', [userId]);
        if (skills && skills.c > 0) items.push('已有 '+skills.c+' 个技能指南可用');
    } catch(e) {}
    if (!items.length) return '';
    return '\n\n## 当前项目进度\n- ' + items.join('\n- ');
}

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

// ===== RAG 检索 API =====
// GET 混合检索（BM25关键词 + 向量相似度）
app.get('/api/writing-projects/:id/search', auth, (req, res) => {
    var projectId = parseInt(req.params.id);
    var query = (req.query.q || '').trim();
    var k = parseInt(req.query.k) || 10;
    var sourceTypes = req.query.types ? req.query.types.split(',') : null;
    if (!query) { res.json({ results: [], method: 'empty' }); return; }
    var retrievalCfg = _getRetrievalConfig(req.userId);
    // 关键词提取：简单Bigram+专有名词（角色名、地名等）
    var keywords = _extractKeywords(query);
    // 向量检索
    var results = [];
    Promise.resolve().then(async function() {
        if (retrievalCfg) {
            var emb = await _generateEmbedding(query, retrievalCfg);
            if (emb) {
                var vecResults = HNSW.search(new Float32Array(emb.vector), k * 2, projectId);
                for (var vi = 0; vi < vecResults.length; vi++) {
                    results.push({ source_type: 'vector', chunk_id: vecResults[vi].id, score: 1 - vecResults[vi].dist, method: 'vector' });
                }
            }
        }
        // 关键词精确匹配（如果向量检索失败或数量不足，补充BM25）
        if (keywords.length > 0) {
            var bm25Results = _bm25Search(projectId, keywords, sourceTypes, k);
            // RRF融合
            var merged = _rrfMerge(results, bm25Results, 0.3);
            // 从DB加载完整内容
            var finalResults = [];
            for (var mi = 0; mi < merged.length && finalResults.length < k; mi++) {
                var chunkId = merged[mi].chunk_id;
                var chunk = queryOne('SELECT * FROM rag_chunks WHERE id=?', [chunkId]);
                if (chunk) {
                    finalResults.push({
                        id: chunk.id, source_type: chunk.source_type, source_id: chunk.source_id,
                        content: chunk.content_text, metadata: safeJsonParse(chunk.metadata_json, {}),
                        score: merged[mi].score, method: merged[mi].method
                    });
                }
            }
            res.json({ results: finalResults, method: 'hybrid', keywords: keywords });
        } else {
            // 仅向量结果
            var vr = [];
            for (var ri = 0; ri < Math.min(results.length, k); ri++) {
                var chunk = queryOne('SELECT * FROM rag_chunks WHERE id=?', [results[ri].chunk_id]);
                if (chunk) vr.push({ id: chunk.id, source_type: chunk.source_type, source_id: chunk.source_id, content: chunk.content_text, metadata: safeJsonParse(chunk.metadata_json, {}), score: results[ri].score, method: 'vector' });
            }
            res.json({ results: vr, method: 'vector', keywords: keywords });
        }
    }).catch(function(e) { console.log('[RAG] 检索失败:', e.message); res.json({ results: [], method: 'error', error: e.message }); });
});

// POST 写入/更新rag_chunks（供压缩层和检查点提交时调用）
app.post('/api/writing-projects/:id/chunks', auth, (req, res) => {
    var projectId = parseInt(req.params.id);
    var { source_type, source_id, content_text, metadata_json } = req.body;
    if (!source_type || !source_id || !content_text) { res.status(400).json({ error: '缺少必要字段' }); return; }
    var retrievalCfg = _getRetrievalConfig(req.userId);
    _enqueueEmbedding(projectId, source_type, source_id, content_text, metadata_json || '{}', retrievalCfg);
    res.json({ ok: true, queued: true });
});

// ===== 故事蓝图 API =====
app.get('/api/writing-projects/:id/blueprint', auth, (req, res) => {
    var projectId = parseInt(req.params.id);
    var bp = queryOne('SELECT * FROM story_blueprints WHERE project_id=? ORDER BY version DESC LIMIT 1', [projectId]);
    var bpResult = bp ? { version: bp.version, blueprint: safeJsonParse(bp.blueprint_json, {}), summary: bp.compression_summary, created_at: bp.created_at } : { version: 0, blueprint: _emptyBlueprint(), summary: '' };
    broadcastDevLog('info','server','[蓝图] 读取完成 版本='+bpResult.version+(bp?' 有数据':' 无数据'));
    res.json(bpResult);
});

app.post('/api/writing-projects/:id/blueprint', auth, (req, res) => {
    var projectId = parseInt(req.params.id);
    var { blueprint, compression_summary, compressed_rounds } = req.body;
    if (!blueprint) { res.status(400).json({ error: '缺少blueprint' }); return; }
    var latest = queryOne('SELECT version FROM story_blueprints WHERE project_id=? ORDER BY version DESC LIMIT 1', [projectId]);
    var newVersion = (latest ? latest.version : 0) + 1;
    // 保留最近3版，删除旧版
    if (newVersion > 3) {
        dbRun('DELETE FROM story_blueprints WHERE project_id=? AND version <= ?', [projectId, newVersion - 3]);
    }
    dbRun('INSERT INTO story_blueprints (project_id, version, blueprint_json, compression_summary, compressed_rounds) VALUES (?,?,?,?,?)',
        [projectId, newVersion, JSON.stringify(blueprint), compression_summary || '', compressed_rounds || '']);
    saveDB();
    // 异步更新蓝图块的embedding
    var retrievalCfg = _getRetrievalConfig(req.userId);
    _enqueueEmbedding(projectId, 'blueprint', 'latest', JSON.stringify(blueprint), JSON.stringify({ version: newVersion }), retrievalCfg);
        broadcastDevLog("info","server","[蓝图] 已保存 v"+newVersion+" core.premise="+((blueprint.core||{}).premise||"空").substring(0,30));
    res.json({ version: newVersion, ok: true });
});

// GET 蓝图版本历史
app.get('/api/writing-projects/:id/blueprint/history', auth, (req, res) => {
    var projectId = parseInt(req.params.id);
    var history = queryAll('SELECT version, compression_summary, compressed_rounds, created_at FROM story_blueprints WHERE project_id=? ORDER BY version DESC LIMIT 3', [projectId]);
    res.json(history || []);
});

// POST 回退蓝图到指定版本
app.post('/api/writing-projects/:id/blueprint/rollback', auth, (req, res) => {
    var projectId = parseInt(req.params.id);
    var targetVersion = parseInt(req.body.version);
    if (!targetVersion) { res.status(400).json({ error: '缺少version' }); return; }
    var target = queryOne('SELECT * FROM story_blueprints WHERE project_id=? AND version=?', [projectId, targetVersion]);
    if (!target) { res.status(404).json({ error: '版本不存在' }); return; }
    var latest = queryOne('SELECT version FROM story_blueprints WHERE project_id=? ORDER BY version DESC LIMIT 1', [projectId]);
    var newVersion = (latest ? latest.version : 0) + 1;
    dbRun('INSERT INTO story_blueprints (project_id, version, blueprint_json, compression_summary, compressed_rounds) VALUES (?,?,?,?,?)',
        [projectId, newVersion, target.blueprint_json, '回退到v'+targetVersion, '']);
    saveDB();
    res.json({ version: newVersion, ok: true, rolled_back_from: targetVersion });
});

// ===== RAG 调试状态 API =====
app.get('/api/writing-projects/:id/rag-stats', auth, (req, res) => {
    var projectId = parseInt(req.params.id);
    var chunkCount = queryOne('SELECT COUNT(*) as c FROM rag_chunks WHERE project_id=?', [projectId]);
    var embedCount = queryOne('SELECT COUNT(*) as c FROM rag_chunks WHERE project_id=? AND embedding_blob IS NOT NULL', [projectId]);
    var hnswStats = HNSW.stats();
    res.json({
        project_id: projectId,
        total_chunks: chunkCount ? chunkCount.c : 0,
        embedded_chunks: embedCount ? embedCount.c : 0,
        hnsw_nodes: hnswStats.nodeCount,
        hnsw_max_level: hnswStats.maxLevel,
        embed_cache_size: _embedCache.length,
        embed_queue_size: _embedQueue.length
    });
});

// ===== 压缩 API =====
app.post('/api/writing-projects/:id/compress', auth, async (req, res) => {
    var projectId = parseInt(req.params.id);
    console.log('[Compress] 触发全量压缩 projectId='+projectId);
    try {
        var blueprint = await _fullCompressBlueprint(projectId, req.userId);
        res.json({ ok: true, blueprint: blueprint });
    } catch(e) {
        console.log('[Compress] 压缩失败:', e.message);
        res.status(500).json({ error: '压缩失败: '+e.message });
    }
});

// ===== 检查点 API =====
// POST 创建检查点卡片消息（编排器调用，生成结构化卡片插入对话流）
app.post('/api/writing-projects/:id/checkpoint', auth, (req, res) => {
    var projectId = parseInt(req.params.id);
    var { checkpoint_type, title, fields } = req.body;
    if (!checkpoint_type || !fields) { res.status(400).json({ error: '缺少checkpoint数据' }); return; }
    var checkpointData = { type: checkpoint_type, title: title || '检查点', fields: fields, committed: false, version: 1 };
    var msgId = dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content, metadata) VALUES (?,?,?,?,?)',
        [projectId, 'orchestrator', 'assistant', title || '', JSON.stringify({ type: 'checkpoint', checkpoint_type: checkpoint_type, data: fields, committed: false })]);
    saveDB();
    broadcastDevLog('info','server','[检查点] 卡片已创建 类型='+checkpoint_type+' 消息ID='+msgId);
    res.json({ ok: true, msg_id: msgId });
});

// POST 提交检查点 → 锁定卡片 + 增量更新蓝图
app.post('/api/writing-projects/:id/checkpoint/:msgId/commit', auth, (req, res) => {
    var projectId = parseInt(req.params.id);
    var msgId = parseInt(req.params.msgId);
    var msg = queryOne('SELECT * FROM agent_conversations WHERE id=? AND project_id=?', [msgId, projectId]);
    if (!msg) { res.status(404).json({ error: '检查点消息不存在' }); return; }
    var meta = safeJsonParse(msg.metadata, {});
    if (meta.committed) { res.json({ ok: true, already_committed: true }); return; }
    // 锁定：更新metadata标记为已提交
    meta.committed = true;
    meta.committed_at = new Date().toISOString();
    dbRun('UPDATE agent_conversations SET metadata=? WHERE id=?', [JSON.stringify(meta), msgId]);
    broadcastDevLog('info','server','[检查点] 已提交确认 类型='+meta.checkpoint_type+' 消息ID='+msgId);
    // 增量更新蓝图
    var checkpointData = meta.data || {};
    _incrementalUpdateBlueprint(projectId, meta.checkpoint_type || 'character', checkpointData);
    saveDB();
    console.log('[Checkpoint] 已提交 type=' + meta.checkpoint_type + ' msgId=' + msgId);
    res.json({ ok: true, checkpoint_type: meta.checkpoint_type });
});

// ===== 用户设置 API =====
app.get('/api/user/settings', auth, (req, res) => {
    var settings = queryAll('SELECT key, value FROM user_settings WHERE user_id=?', [req.userId]);
    var map = {};
    if (settings) settings.forEach(function(s) { map[s.key] = s.value; });
    res.json(map);
});

app.post('/api/user/settings', auth, (req, res) => {
    var { key, value } = req.body;
    if (!key) { res.status(400).json({ error: '缺少key' }); return; }
    var existing = queryOne('SELECT id FROM user_settings WHERE user_id=? AND key=?', [req.userId, key]);
    if (existing) {
        dbRun('UPDATE user_settings SET value=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND key=?', [String(value), req.userId, key]);
    } else {
        dbRun('INSERT INTO user_settings (user_id, key, value) VALUES (?,?,?)', [req.userId, key, String(value)]);
    }
    saveDB();
    res.json({ ok: true });
});

// ===== 写作引导问卷分析 API =====
app.post('/api/writing/onboarding/analyze', auth, async (req, res) => {
    var { experience, duration, platform, status } = req.body;
    if (!experience || !duration || !platform || !status) {
        res.status(400).json({ error: '缺少问卷答案' }); return;
    }
    // 标记问卷已完成
    var existing = queryOne('SELECT id FROM user_settings WHERE user_id=? AND key=?', [req.userId, 'onboarding_completed']);
    if (existing) {
        dbRun('UPDATE user_settings SET value=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND key=?', ['1', req.userId, 'onboarding_completed']);
    } else {
        dbRun('INSERT INTO user_settings (user_id, key, value) VALUES (?,?,?)', [req.userId, 'onboarding_completed', '1']);
    }
    saveDB();

    var cfg = _getRetrievalConfig(req.userId);
    if (!cfg) { res.json(_defaultOnboarding(experience, status)); return; }
    var prompt = _buildOnboardingPrompt(experience, duration, platform, status);
    try {
        var resp = await fetch(cfg.endpoint + '/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.api_key },
            body: JSON.stringify({
                model: cfg.model || 'deepseek-flash',
                messages: [
                    { role: 'system', content: '你是小说创作引导专家。根据用户的写作背景，推荐最合适的引导方案并生成开场问候。只输出纯JSON，不包含解释文字。' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.6,
                thinking: { type: 'disabled' }
            })
        });
        if (!resp.ok) throw new Error('LLM HTTP '+resp.status);
        var data = await resp.json();
        var reply = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
        var json = _extractOnboardingJson(reply);
        res.json(json);
    } catch(e) {
        if (!cfg) console.log('[Onboarding] 未配置API，使用默认方案');
        else console.log('[Onboarding] LLM分析失败，使用默认方案:', e.message);
        res.json(_defaultOnboarding(experience, status));
    }
});

function _buildOnboardingPrompt(experience, duration, platform, status) {
    var labels = {
        experience: { 'newbie': '新手-刚开始接触写作', 'some': '有经验-写过但不多', 'veteran': '老手-写过不少作品' },
        duration: { 'just_started': '刚开始', 'half_year': '半年左右', '1_3_years': '1-3年', '3_plus_years': '3年以上' },
        platform: { 'fanqie': '番茄小说', 'qidian': '起点中文网', 'feilu': '飞卢小说网', 'any': '不限平台', 'other': '其他平台' },
        status: { 'has_idea': '有灵感想法', 'blank': '完全空白-不知道写什么' }
    };
    return '用户写作背景：\n'
        + '- 写作经验：' + (labels.experience[experience] || experience) + '\n'
        + '- 写作时长：' + (labels.duration[duration] || duration) + '\n'
        + '- 目标平台：' + (labels.platform[platform] || platform) + '\n'
        + '- 当前状态：' + (labels.status[status] || status) + '\n\n'
        + '请输出JSON（不要markdown代码块）：\n'
        + '{\n'
        + '  "approach": "A2_then_B1" | "B1_direct" | "A1_structured",\n'
        + '  "approach_reason": "简短说明为什么选择这个方案",\n'
        + '  "opening_message": "调配师的第一句问候语（50-150字，自然亲切）",\n'
        + '  "story_seed": {\n'
        + '    "genre_hint": "从回答推断的题材方向，如不确定填空字符串",\n'
        + '    "tone_hint": "从回答推断的风格，如不确定填空字符串",\n'
        + '    "initial_conflict": "初步的核心冲突方向，如不确定填空字符串",\n'
        + '    "platform_advice": "针对目标平台的创作建议（50字以内）"\n'
        + '  }\n'
        + '}\n\n'
        + '方案选择规则：\n'
        + '- 完全空白(status=blank) + 新手(experience=newbie) → A1_structured（递进式提问链）\n'
        + '- 完全空白 + 有经验 → A2_then_B1（先给模板方向，选定后检查点深挖）\n'
        + '- 有灵感(status=has_idea) + 任何经验 → B1_direct（检查点模式，直接开始聊想法）\n'
        + '- 老手(veteran) + 有灵感 → 可用B1_direct，问候语简洁直接';
}

function _extractOnboardingJson(text) {
    try {
        var clean = text.replace(/```json\s*|\s*```/g, '').trim();
        var i1 = clean.indexOf('{'), i2 = clean.lastIndexOf('}');
        if (i1 >= 0 && i2 > i1) clean = clean.substring(i1, i2 + 1);
        return JSON.parse(clean);
    } catch(e) {
        return _defaultOnboarding('some', 'has_idea');
    }
}

function _defaultOnboarding(experience, status) {
    var isNewbie = experience === 'newbie';
    var isBlank = status === 'blank';
    if (isBlank && isNewbie) {
        return {
            approach: 'A1_structured',
            approach_reason: '新手且无灵感，使用递进式提问链',
            opening_message: '你好！我是你的创作搭档。别担心没有方向——我准备了一套引导流程，帮你在聊天中自然地找到想写的故事。准备好了吗？先聊聊你平时爱看什么类型的小说吧~',
            story_seed: { genre_hint: '', tone_hint: '', initial_conflict: '', platform_advice: '先确定方向再考虑平台适配' }
        };
    }
    if (isNewbie) {
        return {
            approach: 'A2_then_B1',
            approach_reason: '新手但有灵感方向，先给模板参考再深入打磨',
            opening_message: '你好！很高兴认识你。你已经有了一些想法，这非常好。让我先根据你的方向准备几个故事模板供参考，帮你把灵感打磨成稳固的故事骨架。你的灵感是什么样的？尽管说~',
            story_seed: { genre_hint: '', tone_hint: '', initial_conflict: '', platform_advice: '结合目标平台的热门方向微调设定' }
        };
    }
    return {
        approach: 'B1_direct',
        approach_reason: '有经验的作者，直接使用检查点模式高效推进',
        opening_message: '你好！看到你已经有创作经验了，我就不废话了。说说你心里的故事吧——主角是谁？世界观长什么样？想到哪聊到哪，我会在关键节点帮你梳理。',
        story_seed: { genre_hint: '', tone_hint: '', initial_conflict: '', platform_advice: '保持你已有的创作风格，注意平台读者偏好' }
    };
}

// ===== 辅助函数：关键词提取（简易Bigram） =====
function _extractKeywords(text) {
    if (!text) return [];
    var keywords = [];
    // 提取引号内的专有名词
    var quoted = text.match(/[""]([^""]{1,10})[""]/g);
    if (quoted) quoted.forEach(function(q) { keywords.push(q.replace(/[""]/g,'')); });
    // 提取常见写作术语
    var terms = ['主角', '配角', '反派', '伏笔', '世界观', '大纲', '章节', '力量体系', '宗门', '修炼', '剧情'];
    terms.forEach(function(t) { if (text.indexOf(t) >= 0) keywords.push(t); });
    // Bigram分词（中文2字词组）
    var cleaned = text.replace(/[，。！？、；：""''（）\s]/g, '');
    for (var i = 0; i < cleaned.length - 1; i++) {
        var bigram = cleaned.substring(i, i + 2);
        if (keywords.indexOf(bigram) < 0) keywords.push(bigram);
    }
    return keywords.slice(0, 20); // 最多20个关键词
}

// BM25关键词匹配检索
function _bm25Search(projectId, keywords, sourceTypes, k) {
    var results = [];
    var chunks = queryAll('SELECT * FROM rag_chunks WHERE project_id=?', [projectId]);
    if (!chunks || !chunks.length) return results;
    var docFreq = {};
    keywords.forEach(function(kw) {
        docFreq[kw] = 0;
        chunks.forEach(function(c) {
            if ((c.content_text || '').indexOf(kw) >= 0) docFreq[kw]++;
        });
    });
    var totalDocs = chunks.length;
    chunks.forEach(function(c) {
        if (sourceTypes && sourceTypes.indexOf(c.source_type) < 0) return;
        var score = 0;
        var text = c.content_text || '';
        keywords.forEach(function(kw) {
            var tf = (text.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g')) || []).length;
            var df = docFreq[kw] || 1;
            var idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1);
            score += tf * idf;
        });
        if (score > 0) results.push({ chunk_id: c.id, score: score, method: 'bm25' });
    });
    results.sort(function(a, b) { return b.score - a.score; });
    return results.slice(0, k);
}

// RRF融合（Reciprocal Rank Fusion）
function _rrfMerge(vecResults, bm25Results, alpha) {
    var merged = {};
    var addScore = function(id, score, method) {
        if (!merged[id]) merged[id] = { chunk_id: id, score: 0, method: method };
        merged[id].score += score;
        if (method !== merged[id].method) merged[id].method = 'hybrid';
    };
    vecResults.forEach(function(r, i) { addScore(r.chunk_id, alpha * (1 - r.score) + (1 - alpha) * (1 / (i + 60)), r.method); });
    bm25Results.forEach(function(r, i) { addScore(r.chunk_id, alpha * (1 / (i + 60)) + (1 - alpha) * Math.min(1, r.score / 10), r.method); });
    var list = Object.values(merged);
    list.sort(function(a, b) { return b.score - a.score; });
    return list;
}

// 空蓝图模板
function safeJsonParse(str, def) {
    try { return JSON.parse(str); } catch(e) { return def || {}; }
}

function _emptyBlueprint() {
    return {
        core: { premise: '', genre: '', tone: '', target_platform: '', target_audience: '' },
        protagonist: { name: '', arc_summary: '', current_stage: '', key_traits: [], core_conflict: '' },
        world: { power_system: '', era_summary: '', key_factions: [], pending_questions: [] },
        plot: { main_thread: '', sub_threads: [], foreshadowing: [] },
        outline_progress: { current_volume: 1, current_chapter: 1, chapters_written: 0, next_chapter_hook: '' }
    };
}

// POST 撤回最近的用户消息组（该用户消息及其后的所有agent消息）
app.post('/api/writing-projects/:id/undo-last', auth, (req, res) => {
    try {
        var projectId = parseInt(req.params.id);
        var lastUser = queryOne('SELECT id, created_at FROM agent_conversations WHERE project_id=? AND role=? ORDER BY id DESC LIMIT 1', [projectId, 'user']);
        if (!lastUser) return res.json({ ok: true, deleted: 0 });
        // 找到上一条用户消息的时间戳作为安全点
        var safePoint = queryOne('SELECT created_at FROM agent_conversations WHERE project_id=? AND role=? AND id < ? ORDER BY id DESC LIMIT 1', [projectId, 'user', lastUser.id]);
        // 以被撤回消息自身的时间戳为边界，确保只回滚本轮产生的文件数据
        var safeTime = lastUser.created_at;
        // 删除对话记录
        db.run('DELETE FROM agent_conversations WHERE project_id=? AND id>=?', [projectId, lastUser.id]);
        // 回滚文件数据 + 爬虫数据
        var rollback = { volumes: 0, chapters: 0, characters: 0, crawlerBooks: 0 };
        rollback.crawlerBooks = (queryAll('SELECT id FROM agent_crawler_data WHERE project_id=? AND created_at >= ?', [projectId, safeTime])).length;
        db.run('DELETE FROM agent_crawler_data WHERE project_id=? AND created_at >= ?', [projectId, safeTime]);
        if (safePoint) {
            // 删前捕获：哪些卷会被波及（在删章之前查询）
            var affectedVolIds = queryAll('SELECT DISTINCT volume_id FROM writing_chapters WHERE project_id=? AND created_at >= ?', [projectId, safeTime]);
            // 统计并删除本轮消息之后创建的章和角色（>= 避免秒级精度丢失）
            rollback.chapters = (queryAll('SELECT id FROM writing_chapters WHERE project_id=? AND created_at >= ?', [projectId, safeTime])).length;
            // 删前捕获待删除角色ID，用于清理关联表
            var deletedChars = queryAll('SELECT id FROM writing_characters WHERE project_id=? AND created_at >= ?', [projectId, safeTime]);
            rollback.characters = deletedChars.length;
            if (deletedChars.length > 0) {
                var charIds = deletedChars.map(function(c) { return c.id; });
                var placeholders = charIds.map(function() { return '?'; }).join(',');
                db.run('DELETE FROM character_memories WHERE project_id=? AND character_id IN ('+placeholders+')', [projectId].concat(charIds));
                db.run('DELETE FROM relationship_edges WHERE project_id=? AND (from_character_id IN ('+placeholders+') OR to_character_id IN ('+placeholders+'))', [projectId].concat(charIds).concat(charIds));
            }
            db.run('DELETE FROM chapter_versions WHERE project_id=? AND created_at >= ?', [projectId, safeTime]);
            db.run('DELETE FROM writing_chapters WHERE project_id=? AND created_at >= ?', [projectId, safeTime]);
            db.run('DELETE FROM writing_characters WHERE project_id=? AND created_at >= ?', [projectId, safeTime]);
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
        console.log('[Undo] 项目 '+projectId+' 撤回消息组+回滚 卷:'+rollback.volumes+' 章:'+rollback.chapters+' 角色:'+rollback.characters+' 爬虫书:'+rollback.crawlerBooks);
        res.json({ ok: true, deleted: 1, rollback: rollback });
    } catch(e) { console.error('[Undo] error:', e); res.status(500).json({ error: e.message }); }
});

// ==================== Agent LLM 调用 ====================
var ORCHESTRATOR_SYSTEM = loadPrompt('orchestrator.md');

// ==================== 调配师工具定义（MCP风格子智能体调用） ====================
var ORCHESTRATOR_TOOLS = [
  { type: "function", function: { name: "load_skill", description: "加载指定的技能指南。不确定操作流程时先调用此工具获取技能的详细指南。", parameters: { type: "object", properties: { skill_name: { type: "string", description: "要加载的技能名称，如：角色设计指南、大纲设计指南" } }, required: ["skill_name"] } } },
  { type: "function", function: { name: "design_worldview", description: "[阶段二] 根据收集的世界观信息调用LLM生成完整世界观框架，自动提取实体和关系到数据库。在收集了至少5个方向的信息后调用。", parameters: { type: "object", properties: { genre: { type: "string", description: "题材类型" }, core_theme: { type: "string", description: "核心主题" }, world_scale: { type: "string", description: "世界规模" }, details: { type: "string", description: "用户补充的具体要求汇总" } } } } },
  { type: "function", function: { name: "generate_characters", description: "[阶段三] 根据小说信息和世界观设计角色档案。返回JSON含角色姓名/外貌/性格/背景/能力/金手指等。会自动注入世界观上下文。在收集了足够角色信息后调用。", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "crawl_books", description: "爬取番茄小说同类热门小说数据。仅在用户明确授权并说出番茄后调用。当前仅支持番茄平台。", parameters: { type: "object", properties: { platform: { type: "string", description: "用户明确说出的平台名称(当前仅番茄)" }, keyword: { type: "string", description: "搜索关键词" } }, required: ["platform", "keyword"] } } },
  { type: "function", function: { name: "plan_volume_blueprint", description: "[阶段四] 结构化保存卷蓝图规划结果(含每卷起承转合分配)。编排师完成4卷起承转合规划后调用。", parameters: { type: "object", properties: { blueprint_json: { type: "string", description: "完整卷蓝图JSON字符串" } }, required: ["blueprint_json"] } } },
  { type: "function", function: { name: "generate_outline_multi", description: "[阶段五] 多智能体并行生成4卷详细大纲。自动检查前置条件，并行启动卷Agent，提取时间线事件。大纲不写入对话历史。", parameters: { type: "object", properties: {} } } }
];

// 爬虫系统提示（需定义在executeToolAsync之前，crawl_books分支会引用）
var CRAWLER_SYSTEM = loadPrompt('crawler.md');

// ==================== 真实爬虫模块 ====================
const iconv = require('iconv-lite');

// 平台搜索URL映射（{keyword}会被替换为搜索词）
var CRAWL_URLS = {
  '番茄': { url: 'https://fanqienovel.com/search/{keyword}', enc: 'utf-8', cdp: true }, // 字节安全SDK，需CDP模式
  '起点': { url: 'https://www.qidian.com/search?kw={keyword}', enc: 'utf-8' },
  '晋江': { url: 'https://www.jjwxc.net/search.php?kw={keyword}', enc: 'gbk' },
  '飞卢': { url: 'https://b.faloo.com/search?kw={keyword}', enc: 'utf-8' },
  'QQ阅读': { url: 'https://book.qq.com/search?kw={keyword}', enc: 'utf-8' },
  '七猫': { url: 'https://www.qimao.com/search/index?keyword={keyword}', enc: 'utf-8' },
  '掌阅': { url: 'https://www.zhangyue.com/search?keyword={keyword}', enc: 'utf-8' },
  '息壤': { url: 'https://www.xrzww.com/search?keyword={keyword}', enc: 'utf-8' },
  '菠萝包': { url: 'https://www.bilibilicomics.com/search?keyword={keyword}', enc: 'utf-8' },
  '刺猬猫': { url: 'https://www.ciweimao.com/search?keyword={keyword}', enc: 'utf-8' },
  '纵横': { url: 'https://www.zongheng.com/search?keyword={keyword}', enc: 'utf-8' }
};

// Python 解释器路径（Scrapling 安装在 Python 3.13）
var PYTHON_EXE = '"C:/Users/user/AppData/Local/Programs/Python/Python313/python.exe"';
var SCRAPER_BRIDGE = '"D:/工作文件夹/AI动漫制作/科研文件夹/新-无限画布本地部署/scraper_bridge.py"';

// 通过 Python Scrapling 桥接抓取（优先使用，失败则降级到原生 fetch）
function _fetchWithScrapling(url, platform, cdpMode, onCaptcha, onCaptchaSolved, callback) {
    var cdpFlag = cdpMode ? ' --cdp' : '';
    var timeout = cdpMode ? 420000 : 30000; // CDP：420s > 桥接内部330s轮询，避免node先杀python
    console.log('[Crawler] Scrapling桥接: '+platform+(cdpMode?' [CDP模式]':''));

    if (cdpMode) {
        // CDP 模式：stdout 逐行 JSON 事件，实时读取
        var pyExe = PYTHON_EXE.replace(/"/g, '');
        var bridgePath = SCRAPER_BRIDGE.replace(/"/g, '');
        var cmdStr = '"' + pyExe + '" "' + bridgePath + '" --url "' + url + '" --platform "' + platform + '" --cdp';
        // 注入 DB 中的 PADDLEOCR_TOKEN（优先DB，回退环境变量）
        var childEnv = Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' });
        var dbOcrToken = getSysConfig('PADDLEOCR_TOKEN');
        if (dbOcrToken) childEnv.PADDLEOCR_TOKEN = dbOcrToken;
        var spawnOpts = { shell: true, env: childEnv };
        console.log('[Crawler] CDP spawn' + (dbOcrToken ? ' [OCR:DB]' : ' [OCR:NONE]'));
        var proc = child_process.spawn(cmdStr, [], spawnOpts);
        var spawnTimer = setTimeout(function() {
            console.log('[Crawler] CDP 超时，终止进程');
            try { proc.kill(); } catch(e) {}
        }, timeout);
        var stdoutBuf = '', lastResult = null;
        // stderr：逐行实时推送到开发者日志（OCR解码进度等）
        var _stderrLineBuf = '';
        proc.stderr.on('data', function(data) {
            _stderrLineBuf += data.toString();
            var lines = _stderrLineBuf.split('\n');
            _stderrLineBuf = lines.pop() || '';
            for (var i = 0; i < lines.length; i++) {
                var l = lines[i].trim();
                if (l) broadcastDevLog('info', 'scraper', '🐍 ' + l);
            }
        });
        proc.stdout.on('data', function(data) {
            stdoutBuf += data.toString();
            // 逐行解析 JSON 事件
            var lines = stdoutBuf.split('\n');
            stdoutBuf = lines.pop() || '';  // 最后一段可能不完整，保留
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (!line) continue;
                try {
                    var evt = JSON.parse(line);
                    console.log('[Crawler] event:', evt.event, evt.phase||'');
                    if (evt.event === 'captcha') {
                        if (evt.phase === 'detected') {
                            console.log('[Crawler] 验证码出现 → 通知前端');
                            if (onCaptcha) onCaptcha();
                        } else if (evt.phase === 'solved') {
                            console.log('[Crawler] 验证码已解决');
                            if (onCaptchaSolved) onCaptchaSolved();
                        }
                    }
                    if (evt.event === 'result') {
                        lastResult = evt;
                    }
                } catch(e) {
                    console.log('[Crawler] 非JSON行:', line.substring(0, 100));
                }
            }
        });
        proc.on('close', function(code) {
            clearTimeout(spawnTimer);
            // 刷新残留的 stderr
            if (_stderrLineBuf.trim()) broadcastDevLog('info', 'scraper', '🐍 ' + _stderrLineBuf.trim());
            if (lastResult) {
                // 有结果事件
                if (lastResult.ok && lastResult.html) {
                    callback({
                        html: lastResult.html,
                        url: lastResult.url || url,
                        cdp: !!lastResult.cdp
                    }, null);
                } else {
                    callback(null, lastResult.error || 'CDP 无结果');
                }
            } else {
                callback(null, 'CDP bridge 无输出 (code='+code+')');
            }
        });
        proc.on('error', function(err) {
            clearTimeout(spawnTimer);
            callback(null, err.message);
        });
    } else {
        // 非CDP模式用 exec，注入 DB 中的 PADDLEOCR_TOKEN
        var execEnv = Object.assign({}, process.env);
        var execDbOcr = getSysConfig('PADDLEOCR_TOKEN');
        if (execDbOcr) execEnv.PADDLEOCR_TOKEN = execDbOcr;
        var cmd = PYTHON_EXE + ' ' + SCRAPER_BRIDGE + ' --url "' + url + '" --platform "' + platform + '"';
        child_process.exec(cmd, { timeout: timeout, maxBuffer: 2 * 1024 * 1024, env: execEnv }, function(err, stdout, stderr) {
            // stderr 实时推送到开发者日志（OCR解码进度等）
            if (stderr) {
                stderr.split('\n').forEach(function(l) {
                    if (l.trim()) broadcastDevLog('info', 'scraper', '🐍 ' + l.trim());
                });
            }
            if (err) { callback(null, err.message); return; }
            _parseScraplingResult(stdout, stderr, platform, url, callback);
        });
    }
}

function _parseScraplingResult(stdout, stderr, platform, url, callback) {
    var captchaMsg = '';
    if (stderr && stderr.indexOf('CAPTCHA_DETECTED') >= 0) {
        captchaMsg = '\n⚠️ 浏览器触发了验证码，请在 Chrome 窗口中手动完成验证后重试';
    }
    try {
        var result = JSON.parse(stdout);
        if (result.ok && result.html && result.html.length > 100) {
            var logMsg = result.cdp ? 'Scrapling CDP成功 数据长度=' : 'Scrapling成功 HTML长度=';
            console.log('[Crawler] '+logMsg+result.html.length);
            var html = result.cdp ? result.html : _cleanHTML(result.html);
            callback({ html: html, url: result.url || url, cdp: !!result.cdp }, null);
        } else {
            var errDetail = (result.error || '内容过短') + captchaMsg;
            console.log('[Crawler] Scrapling返回无效:', errDetail);
            callback(null, errDetail);
        }
    } catch(e) {
        console.log('[Crawler] Scrapling JSON解析失败:', e.message);
        callback(null, e.message + captchaMsg);
    }
}

// 模糊匹配平台名（LLM 可能传 "番茄小说" 而非 "番茄"）
// 返回 { key: 标准化平台名, cfg: 平台配置 }
function _resolvePlatform(rawPlatform) {
    if (!rawPlatform) return null;
    // 精确匹配
    if (CRAWL_URLS[rawPlatform]) return { key: rawPlatform, cfg: CRAWL_URLS[rawPlatform] };
    // 模糊匹配：配置key包含在输入中，或输入包含在配置key中
    var keys = Object.keys(CRAWL_URLS);
    for (var i = 0; i < keys.length; i++) {
        if (rawPlatform.indexOf(keys[i]) >= 0 || keys[i].indexOf(rawPlatform) >= 0) {
            console.log('[Crawler] 平台模糊匹配: "'+rawPlatform+'" → "'+keys[i]+'"');
            return { key: keys[i], cfg: CRAWL_URLS[keys[i]] };
        }
    }
    return null;
}

// 服务端解析番茄小说搜索结果HTML，提取结构化书籍数据（避免把整个HTML喂给LLM）
function _parseSearchResultHTML(html) {
    var books = [];
    // 定位到书籍列表容器
    var listMatch = html.match(/<div class="muye-search-book-list">([\s\S]*?)(?:<div class="byte-pagination|$)/i);
    var listHtml = listMatch ? listMatch[1] : html;

    // 按 search-book-item 切分每个书籍卡片
    var items = listHtml.split(/<div class="search-book-item">/i);
    for (var i = 1; i < items.length; i++) {
        var item = items[i];
        // 截取到下一个 search-book-item 或 pagination 或结束
        var endM = item.match(/(?:<div class="search-book-item">|<div class="byte-pagination)/i);
        if (endM) item = item.substring(0, item.indexOf(endM[0]));

        var book = {};

        // 书名：title div 里的 highlight-text span
        var titleDiv = item.match(/<div class="title[^"]*">([\s\S]*?)<\/div>/i);
        if (titleDiv) {
            var titleSpan = titleDiv[1].match(/<span class="highlight-text">([\s\S]*?)<\/span>/i);
            book['书名'] = titleSpan ? titleSpan[1].replace(/<[^>]+>/g, '').trim() : titleDiv[1].replace(/<[^>]+>/g, '').trim();
        } else {
            book['书名'] = '';
        }

        // 作者、状态、分类、字数、热度 —— 在desc div中用HTML结构直接提取
        var descDivs = item.match(/<div class="desc[^"]*">([\s\S]*?)<\/div>/gi);
        if (descDivs && descDivs.length >= 1) {
            var firstDescHtml = descDivs[0];
            var firstDescText = firstDescHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

            // 作者：第一个<span>作者：<span class="highlight-text">NAME</span></span>中的NAME
            var authorSpanM = firstDescHtml.match(/作者[：:]\s*<span class="highlight-text">([\s\S]*?)<\/span>/i);
            book['作者'] = authorSpanM ? authorSpanM[1].replace(/<[^>]+>/g, '').trim() : '';

            // 如果HTML结构匹配失败，回退到纯文本匹配（去掉状态后缀）
            if (!book['作者']) {
                var plainAuthorM = firstDescText.match(/作者[：:]\s*(.+?)(?:\s*(?:已完结|连载中)|$)/i);
                book['作者'] = plainAuthorM ? plainAuthorM[1].trim() : '';
            }

            // 状态 + 标签：从后续<span class="span">中提取
            var spanMatches = firstDescHtml.match(/<span class="span">([\s\S]*?)<\/span>/gi);
            var metaItems = [];
            if (spanMatches) {
                for (var si = 0; si < spanMatches.length; si++) {
                    var spanText = spanMatches[si].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                    var subItems = spanText.split('·');
                    for (var sj = 0; sj < subItems.length; sj++) {
                        var t = subItems[sj].trim();
                        if (t) metaItems.push(t);
                    }
                }
            }

            // 状态（已完结/连载中）
            var statusM = firstDescText.match(/(已完结|连载中)/i);
            if (statusM) {
                if (!book['标签']) book['标签'] = [];
                book['标签'].push(statusM[1]);
            }

            // 分类标签
            var KNOWN_TAGS = ['仙侠','玄幻','都市','言情','历史','科幻','悬疑','灵异','游戏','竞技','轻小说','奇幻','武侠','军事','同人','古代','现代','穿越','重生','系统','东方','西方','脑洞','修真','洪荒','神话','搞笑','轻松','热血','暗黑','无敌','腹黑','赘婿','打脸','战神','恶搞','升级','种田','灵气','开局','抗战谍战','豪门总裁','宫斗宅斗','动漫衍生','男频衍生','文学经典','世界名著','传统玄幻','东方仙侠','奇幻仙侠','都市修真','战神赘婿','异世大陆','衍生','同人','古代言情','现代言情','悬疑灵异','盗墓','灵异'];
            for (var ti = 0; ti < metaItems.length; ti++) {
                var mi = metaItems[ti];
                if (KNOWN_TAGS.indexOf(mi) >= 0) {
                    if (!book['标签']) book['标签'] = [];
                    book['标签'].push(mi);
                }
                var wordsM = mi.match(/([\d.]+万字)/);
                if (wordsM) book['字数'] = wordsM[1];
                var hotM = mi.match(/([\d.]+万?\s*人在读|未满\d+人在读)/);
                if (hotM) book['热度'] = hotM[1];
            }
        } else {
            book['作者'] = '';
        }

        // 简介：abstract desc div
        if (descDivs && descDivs.length >= 2) {
            var absDesc = descDivs[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            book['简介'] = absDesc.substring(0, 500);  // 限制长度
        } else {
            book['简介'] = '';
        }

        if (!book['标签']) book['标签'] = [];
        if (!book['字数']) book['字数'] = '';
        if (!book['热度']) book['热度'] = '';

        // 只保留书名或作者至少有一个的条目
        if (book['书名'] || book['作者']) {
            books.push(book);
        }
    }
    return books;
}

// 爬取平台搜索页HTML（CDP模式 → Scrapling → 原生fetch 三级降级）
function crawlWebPage(platform, keyword, onCaptcha, onCaptchaSolved) {
    return new Promise(function(resolve) {
        var resolved = _resolvePlatform(platform);
        if (!resolved) { resolve({ error: '不支持的平台: '+platform, html: '', url: '' }); return; }
        var normalizedPlatform = resolved.key;  // 标准化后的平台名
        var cfg = resolved.cfg;
        var url = cfg.url.replace('{keyword}', encodeURIComponent(keyword));
        var enc = cfg.enc || 'utf-8';
        var useCdp = !!cfg.cdp; // 标记是否需要 CDP 模式
        console.log('[Crawler] 开始爬取: '+normalizedPlatform+' URL='+url+(useCdp?' [CDP]':''));

        _fetchWithScrapling(url, normalizedPlatform, useCdp, onCaptcha, onCaptchaSolved, function(scrapResult, scrapError) {
            if (scrapResult) { resolve(scrapResult); return; }
            // CDP 平台失败后不降级到原生 fetch（反爬 SDK 会拦截），直接返回错误
            if (useCdp) {
                var hasCaptcha = scrapError && scrapError.indexOf('验证') >= 0;
                console.log('[Crawler] CDP模式失败'+(hasCaptcha?'（验证码）':'（连接问题）'));
                resolve({
                    error: scrapError || 'CDP连接失败',
                    html: '',
                    url: url,
                    needCdp: !hasCaptcha,  // 验证码超时 ≠ CDP未配置
                    hasCaptcha: hasCaptcha
                });
                return;
            }
            // 非CDP平台：降级到原生 Node.js fetch
            console.log('[Crawler] 降级为原生fetch: '+normalizedPlatform);
            _doFetchNative(url, enc, 1, function(result) {
                if (result.error) console.log('[Crawler] 爬取失败: '+result.error);
                else console.log('[Crawler] 爬取成功 HTML长度='+result.html.length);
                resolve(result);
            });
        });
    });
}

function _doFetchNative(url, enc, attempt, callback) {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 12000);
    fetch(url, {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        },
        signal: controller.signal
    }).then(function(r) {
        clearTimeout(timer);
        if (!r.ok) {
            if (attempt < 2) { console.log('[Crawler] HTTP '+r.status+' 重试#'+attempt); return _doFetchNative(url, enc, attempt+1, callback); }
            callback({ error: 'HTTP '+r.status, html: '', url: url }); return;
        }
        // 读取响应为 ArrayBuffer 以处理编码
        return r.arrayBuffer().then(function(buf) {
            var contentType = r.headers.get('content-type') || '';
            var match = contentType.match(/charset=([^\s;]+)/i);
            var detectedEnc = match ? match[1].toLowerCase() : enc;
            // 如果响应头指定了编码，优先使用
            var useEnc = detectedEnc;
            if (useEnc === 'gb2312') useEnc = 'gbk';
            if (useEnc === 'gbk' || useEnc === 'gb18030') {
                var text = iconv.decode(Buffer.from(buf), 'gbk');
                callback({ html: _cleanHTML(text), url: url });
            } else {
                var text = new TextDecoder(useEnc).decode(buf);
                callback({ html: _cleanHTML(text), url: url });
            }
        });
    }).catch(function(err) {
        clearTimeout(timer);
        if (attempt < 2) { console.log('[Crawler] 请求超时 重试#'+attempt); return _doFetchNative(url, enc, attempt+1, callback); }
        callback({ error: err.message, html: '', url: url });
    });
}

// HTML 预处理：删除 script/style/nav/注释，压缩空白
function _cleanHTML(html) {
    html = html || '';
    // 大体积HTML先快速剥离script/style（占比最大且不含书籍信息）
    if (html.length > 200000) {
        try { html = html.replace(/<script[\s\S]*?<\/script>/gi, ''); } catch(e) {}
        try { html = html.replace(/<style[\s\S]*?<\/style>/gi, ''); } catch(e) {}
    }
    try {
        html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
        html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
        html = html.replace(/<nav[\s\S]*?<\/nav>/gi, '');
        html = html.replace(/<!--[\s\S]*?-->/g, '');
        html = html.replace(/<svg[\s\S]*?<\/svg>/gi, '');
        html = html.replace(/\n\s*\n/g, '\n');
        return html.substring(0, 20000);
    } catch(e) { return html.substring(0, 20000); }
}

var SKILL_OPTIMIZER_SYSTEM = loadPrompt('skill_optimizer.md');

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

    var reqBody = { model: model, messages: messages, temperature: 0.6, stream: true, stream_options: { include_usage: true } };
    if (isDS) { reqBody.thinking = { type: 'enabled' }; reqBody.reasoning_effort = 'max'; }
    if (tools && tools.length) reqBody.tools = tools;

    fetch(llmAgent.api_endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + llmAgent.api_key },
        body: JSON.stringify(reqBody)
    }).then(function(r) {
        if (!r.ok) return r.text().then(function(t) { callback({ error: 'HTTP '+r.status+': '+t.substring(0,200) }); });
        var reader = r.body.getReader();
        var decoder = new TextDecoder();
        var buf = '', fullContent = '', fullThinking = '', tokIn = 0, tokOut = 0, tokCache = 0;
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
                        _logTokenUsage(userId, projectId, agentType, model, tokIn, tokOut, tokCache);
                        saveDB();
                        callback({ content: fullContent, thinking: fullThinking, tool_calls: validCalls, _messages: messages, token_in: tokIn, token_out: tokOut });
                    } else {
                        // 无工具请求 → 保存DB，正常完成
                        _logTokenUsage(userId, projectId, agentType, model, tokIn, tokOut, tokCache);
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
                        if (parsed.usage) { tokIn = parsed.usage.prompt_tokens || 0; tokOut = parsed.usage.completion_tokens || 0; tokCache = (parsed.usage.prompt_tokens_details && parsed.usage.prompt_tokens_details.cached_tokens) || 0; }
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
function executeToolAsync(toolName, argsJson, projectId, userId, streamCallback, _continueMsgs, streamStartedAt, sseRes) {
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
                                dbRun('INSERT INTO writing_chapters (project_id, volume_id, chapter_no, title) VALUES (?,?,?,?)', [projectId, vid, (function(){var cnt=queryOne('SELECT COUNT(*) as c FROM writing_chapters WHERE volume_id=?',[vid]);return(cnt?cnt.c:0)+1;})(), chap['章名']||'']);
                            });
                        });
                        saveDB();
                    }
                } catch(e) {}
                resolve({ result: result.content, thinking: result.thinking || '', summary: summary });
            }, streamCallback, null, true);
        } else if (tl.indexOf('character') >= 0 || toolName === 'generate_characters') {
            var proj2 = queryOne('SELECT * FROM writing_projects WHERE id=?', [projectId]);
            var context2 = '项目：'+proj2.title+'\n类型：'+proj2.genre+' '+proj2.sub_genre+'\n';
            // 注入世界观上下文
            var worldEntities = queryAll('SELECT name, type, description FROM world_entities WHERE project_id=? ORDER BY id', [projectId]);
            if (worldEntities.length > 0) {
                context2 += '\n## 世界观设定\n';
                var typeGroups = {};
                worldEntities.forEach(function(e) {
                    var t = e.type || '其他';
                    if (!typeGroups[t]) typeGroups[t] = [];
                    typeGroups[t].push(e.name + (e.description ? '：'+e.description.substring(0,80) : ''));
                });
                Object.keys(typeGroups).forEach(function(t) {
                    context2 += '- ' + t + '：' + typeGroups[t].join('、') + '\n';
                });
                var worldRels = queryAll('SELECT fe.name as fn, te.name as tn, wr.relation_type FROM world_relations wr LEFT JOIN world_entities fe ON wr.from_entity_id=fe.id LEFT JOIN world_entities te ON wr.to_entity_id=te.id WHERE wr.project_id=?', [projectId]);
                if (worldRels.length > 0) {
                    context2 += '- 实体关系：';
                    worldRels.forEach(function(r) { context2 += (r.fn||'?')+'→'+(r.relation_type||'关联')+'→'+(r.tn||'?')+'；'; });
                    context2 += '\n';
                }
                broadcastDevLog('info','server','[CharacterGen] 世界观上下文已注入 实体='+worldEntities.length+' 关系='+worldRels.length+' | World context injected entities='+worldEntities.length);
            }
            var history2 = queryAll('SELECT * FROM agent_conversations WHERE project_id=? ORDER BY created_at ASC LIMIT 200', [projectId]);
            history2.forEach(function(m) {
                if (m.role==='user') context2 += '用户：'+m.content+'\n';
                else if (m.role==='assistant') context2 += 'Agent：'+m.content+'\n';
            });
            broadcastDevLog('info','server','[CharacterGen] 生成开始 contextLen='+context2.length+' | Starting generation contextLen='+context2.length);
            callOutlineLLM(projectId, userId, CHARACTER_SYSTEM, context2, 'character', null, function(result) {
                if (result.error) { resolve({ error: result.error, summary: '角色生成失败: '+result.error }); return; }
                var summary = '角色已生成';
                var raw = (result.content || '');
                try {
                    var jsonStr = '';
                    // 策略1: markdown 代码块提取
                    var m = raw.match(/```json\s*([\s\S]*?)```/);
                    if (m) { jsonStr = m[1].trim(); }
                    // 策略2: 直接从 {...} 边界截取（兼容非代码块输出）
                    if (!jsonStr) {
                        var idx1 = raw.indexOf('{'), idx2 = raw.lastIndexOf('}');
                        if (idx1 >= 0 && idx2 > idx1) jsonStr = raw.substring(idx1, idx2 + 1);
                    }
                    if (!jsonStr) { throw new Error('LLM输出中未找到有效JSON结构'); }
                    // 解析 + 修复常见JSON格式问题
                    var chars = null;
                    try {
                        chars = JSON.parse(jsonStr);
                    } catch(parseErr) {
                        // 尝试修复: 删除尾随逗号（LLM生成JSON时的常见错误）
                        var repaired = jsonStr.replace(/,\s*([}\]])/g, '$1');
                        console.log('[Writing 角色] 首次解析失败，已自动修复尾随逗号并重试');
                        chars = JSON.parse(repaired);
                    }
                    if (chars && chars['角色'] && Array.isArray(chars['角色']) && chars['角色'].length > 0) {
                        chars['角色'].forEach(function(c) {
                            dbRun('INSERT INTO writing_characters (project_id, name, profile_json) VALUES (?,?,?)', [projectId, c['姓名']||'未命名', JSON.stringify(c)]);
                        });
                        saveDB();
                        summary = '已生成 '+chars['角色'].length+' 个角色';
                    } else if (chars && chars['角色'] && !Array.isArray(chars['角色'])) {
                        summary = '角色已生成但"角色"字段不是数组，请检查LLM输出格式';
                        console.warn('[Writing 角色] 角色字段非数组，类型:', typeof chars['角色']);
                    } else {
                        summary = '角色已生成但缺少"角色"字段，请检查LLM输出格式';
                        console.warn('[Writing 角色] 缺少角色字段，可用keys:', chars ? Object.keys(chars).join(',') : 'null');
                    }
                } catch(e) { console.error('[Writing 角色] 保存失败:', e.message, 'raw前200字:', raw.substring(0, 200)); summary = '角色保存失败: '+e.message; }
                resolve({ result: result.content, thinking: result.thinking || '', summary: summary });
            }, streamCallback, null, true);
        } else if (tl.indexOf('crawl') >= 0 || toolName === 'crawl_books') {
            var proj3 = queryOne('SELECT * FROM writing_projects WHERE id=?', [projectId]);
            var platform = args.platform || '番茄';
            // 搜索关键词：优先使用主智能体推断的 keyword，其次用项目类型字段拼凑
            var keyword = (args.keyword||'').trim();
            if (!keyword) {
                keyword = ((proj3.genre||'') + ' ' + (proj3.sub_genre||'')).trim();
                if (keyword) keyword += ' 小说';
                else keyword = '热门小说';
            }
            console.log('[Writing 爬虫] 项目='+projectId+' 平台='+platform+' 关键词='+keyword);
            // 第1层：真实网页爬取
            // onCaptcha 回调：通过 streamCallback 发通知到前端流式气泡
            // 验证码回调：通过 streamCallback（含res闭包）+ saveStreamBuffer 双通道
            var onCaptcha = function() {
                console.log('[Writing 爬虫] CAPTCHA → 发送captcha_notice到前端');
                try {
                    if (sseRes && !sseRes.destroyed) {
                        sseRes.write('data: '+JSON.stringify({type:'captcha_notice', message:'🔐 检测到人机验证！请在弹出的 Chrome 窗口中完成滑块验证。'})+'\n\n');
                        console.log('[Writing 爬虫] captcha_notice已发送');
                    }
                } catch(e) { console.log('[Writing 爬虫] captcha_notice失败:', e.message); }
            };
            var onCaptchaSolved = function() {
                console.log('[Writing 爬虫] CAPTCHA solved → 通知前端移除浮动条');
                try {
                    if (sseRes && !sseRes.destroyed) {
                        sseRes.write('data: '+JSON.stringify({type:'captcha_notice', phase:'solved', message:'✅ 验证通过，正在获取数据...'})+'\n\n');
                    }
                } catch(e) {}
            };
            crawlWebPage(platform, keyword, onCaptcha, onCaptchaSolved).then(function(crawlResult) {
                if (crawlResult.html && !crawlResult.error) {
                    // 始终从HTML提取结构化书籍数据
                    var parsedBooks = _parseSearchResultHTML(crawlResult.html);
                    console.log('[Writing 爬虫] 服务端解析: '+parsedBooks.length+'本书');

                    // 检测是否有乱码（PUA字符残留）
                    var hasGarbled = false;
                    for (var bi = 0; bi < parsedBooks.length; bi++) {
                        if (/[-]/.test((parsedBooks[bi]['书名']||'')+(parsedBooks[bi]['作者']||'')+(parsedBooks[bi]['简介']||''))) {
                            hasGarbled = true; break;
                        }
                    }
                    console.log('[Writing 爬虫] 乱码检测: '+(hasGarbled?'有乱码→LLM校对':'无乱码→直接入库'));

                    if (parsedBooks.length > 0 && !hasGarbled) {
                        // 干净数据 → 直接入库
                        var inserted2 = 0;
                        parsedBooks.forEach(function(b) {
                            try {
                                dbRun('INSERT INTO agent_crawler_data (project_id, platform, book_name, author, cover_url, intro, tags, status, source) VALUES (?,?,?,?,?,?,?,?,?)',
                                    [projectId, b['平台']||platform, b['书名']||'', b['作者']||'', b['封面']||'', b['简介']||'', JSON.stringify(b['标签']||[]), 'pending', 'web']);
                                inserted2++;
                            } catch(e) { if (e.message && e.message.indexOf('UNIQUE')>=0) console.log('[Writing 爬虫] 重复跳过: '+b['书名']); }
                        });
                        if (inserted2 > 0) saveDB();
                        console.log('[Writing 爬虫] 直接入库'+inserted2+'本');
                        resolve({ result: JSON.stringify(parsedBooks, null, 2), summary: '爬取'+inserted2+'本参考书籍' });
                    } else if (parsedBooks.length > 0 && hasGarbled) {
                        // 有乱码 → LLM上下文校对
                        console.log('[Writing 爬虫] LLM校对中...');
                        var correctionSystem = '你是文本校对助手。以下JSON是从网页提取的书籍数据，部分字符因字体反爬未能解码，显示为乱码。\n\n'
                            + '规则：\n'
                            + '1. 根据上下文推断并修正乱码字符（那些无法正常显示的方块字）\n'
                            + '2. 已经正确显示的正常汉字不要改动\n'
                            + '3. 能从片段推断出完整书名的就补全，不确定的保留片段\n'
                            + '4. 严禁凭空编造书籍信息\n'
                            + '5. 直接输出修正后的JSON，格式不变';
                        var correctionData = JSON.stringify(parsedBooks, null, 2);
                        callOutlineLLM(projectId, userId, correctionSystem, correctionData, 'crawler', null, function(result) {
                            var correctedBooks = [];
                            try {
                                var clean = (result.content||'').replace(/```json\s*|\s*```/g, '').trim();
                                var parsed = JSON.parse(clean);
                                if (Array.isArray(parsed)) correctedBooks = parsed;
                            } catch(e) { console.log('[Writing 爬虫] LLM校对JSON解析失败:', e.message); }
                            if (correctedBooks.length === 0) correctedBooks = parsedBooks;  // 校对失败用原文
                            var inserted3 = 0;
                            correctedBooks.forEach(function(b) {
                                try {
                                    dbRun('INSERT INTO agent_crawler_data (project_id, platform, book_name, author, cover_url, intro, tags, status, source) VALUES (?,?,?,?,?,?,?,?,?)',
                                        [projectId, b['平台']||platform, b['书名']||'', b['作者']||'', b['封面']||'', b['简介']||'', JSON.stringify(b['标签']||[]), 'pending', 'web']);
                                    inserted3++;
                                } catch(e) { if (e.message && e.message.indexOf('UNIQUE')>=0) console.log('[Writing 爬虫] 重复跳过: '+b['书名']); }
                            });
                            if (inserted3 > 0) saveDB();
                            console.log('[Writing 爬虫] LLM校对完成 '+inserted3+'本');
                            resolve({ result: JSON.stringify(correctedBooks, null, 2), summary: 'LLM校对爬取'+inserted3+'本参考书籍' });
                        }, streamCallback, null, true);
                    } else {
                        // 解析为空 → 回退到LLM从原始HTML提取
                        console.log('[Writing 爬虫] 服务端解析为空，回退LLM提取');
                        var ctx3 = '目标平台：'+platform+'\n项目：'+proj3.title+'\n类型：'+(proj3.genre||'')+' '+(proj3.sub_genre||'')+'\n\n网页URL：'+crawlResult.url+'\n网页HTML：\n'+crawlResult.html;
                        callOutlineLLM(projectId, userId, CRAWLER_SYSTEM, ctx3, 'crawler', null, function(result) {
                        var summary = '爬取完成'; var allBooks = [];
                        try {
                            var clean = (result.content||'').replace(/```json\s*|\s*```/g, '').trim();
                            var parsed = JSON.parse(clean);
                            if (parsed['书籍']) allBooks = parsed['书籍'];
                        } catch(e) { console.log('[Writing 爬虫] JSON解析失败:', e.message); }
                        var inserted = 0;
                        allBooks.forEach(function(b) {
                            try {
                                dbRun('INSERT INTO agent_crawler_data (project_id, platform, book_name, author, cover_url, intro, tags, status, source) VALUES (?,?,?,?,?,?,?,?,?)',
                                    [projectId, b['平台']||platform, b['书名']||'', b['作者']||'', b['封面']||'', b['简介']||'', JSON.stringify(b['标签']||[]), 'pending', 'web']);
                                inserted++;
                            } catch(e) { if (e.message && e.message.indexOf('UNIQUE')>=0) console.log('[Writing 爬虫] 重复跳过: '+b['书名']); else console.error('[Writing 爬虫] 插入失败:', e.message); }
                        });
                        if (inserted > 0) saveDB();
                        // 第2层：提取不足3本 → LLM 补充（仅非CDP模式，CDP爬的是真实数据不用LLM编造）
                        if (inserted < 3 && !crawlResult.cdp) {
                            var hist3 = queryAll('SELECT * FROM agent_conversations WHERE project_id=? ORDER BY created_at ASC LIMIT 100', [projectId]);
                            var supp = '目标平台：'+platform+'\n项目：'+proj3.title+'\n类型：'+(proj3.genre||'')+' '+(proj3.sub_genre||'')+'\n\n';
                            hist3.forEach(function(m) { if (m.role==='user') supp += '用户：'+m.content+'\n'; else if (m.role==='assistant'&&m.agent_type==='orchestrator') supp += '主Agent：'+m.content+'\n'; });
                            supp += '\n真实网页只提取到'+inserted+'本书，请根据对话中的创作方向，用训练知识补充推荐'+(5-inserted)+'本同类热门小说。输出JSON（```json包裹），每本书的平台字段填"'+platform+'"。';
                            callOutlineLLM(projectId, userId, '基于小说创作方向，推荐同类热门网络小说。输出JSON：{"书籍":[{"书名":"","作者":"","简介":"","热度":"","字数":"","标签":[""],"平台":"'+platform+'"}]}。不要编造完全不存在的内容，根据训练数据中的知识推荐。', supp, 'crawler', null, function(r2) {
                                var suppBooks = [];
                                try { var c2 = (r2.content||'').replace(/```json\s*|\s*```/g,'').trim(); var p2 = JSON.parse(c2); if (p2['书籍']) suppBooks = p2['书籍']; } catch(e) {}
                                var ins2 = 0;
                                suppBooks.forEach(function(b) {
                                    try { dbRun('INSERT INTO agent_crawler_data (project_id,platform,book_name,author,cover_url,intro,tags,status,source) VALUES (?,?,?,?,?,?,?,?,?)', [projectId,b['平台']||platform,b['书名']||'',b['作者']||'',b['封面']||'',b['简介']||'',JSON.stringify(b['标签']||[]),'pending','llm']); ins2++; } catch(e) { if (e.message&&e.message.indexOf('UNIQUE')>=0) console.log('[Writing 爬虫] 补充重复跳过: '+b['书名']); }
                                });
                                if (ins2 > 0) saveDB();
                                console.log('[Writing 爬虫] 真实'+inserted+'本 + 补充'+ins2+'本');
                                resolve({ result: result.content, thinking: result.thinking||'', summary: '真实爬取'+inserted+'本 + LLM补充'+ins2+'本' });
                            }, null, null, true);
                        } else {
                            console.log('[Writing 爬虫] 真实爬取'+inserted+'本');
                            resolve({ result: result.content, thinking: result.thinking||'', summary: '真实爬取'+inserted+'本参考书籍' });
                        }
                    }, streamCallback, null, true);
                    } // end else (服务端解析为空 → LLM回退)
                } else {
                    // 第3层：网页获取失败 → 返回详细错误供前端气泡展示
                    var errDetail = crawlResult.error || '未知错误';
                    console.log('[Writing 爬虫] 网页获取失败: '+errDetail+' 平台='+platform+' URL='+crawlResult.url);
                    var errContent, errSummary;
                    if (crawlResult.hasCaptcha) {
                        // 验证码超时：CDP已连接但验证码未通过
                        errContent = '🔐 '+platform+' 触发了人机验证\n\n'
                            + '已通过真实 Chrome 浏览器访问了搜索页面，但触发了验证码保护。\n\n'
                            + '请在弹出的 Chrome 窗口中手动完成验证（通常点一下就行），\n'
                            + '验证通过后回到写作页面重新发送爬取指令即可。\n\n'
                            + '提示：如果验证后页面已加载出搜索结果，说明验证已通过，\n'
                            + '此时重试爬取通常能直接拿到数据。';
                        errSummary = '触发验证码：请在Chrome窗口中完成验证后重试';
                    } else if (crawlResult.needCdp) {
                        // CDP 平台需要用户手动开启 Chrome 调试模式
                        errContent = '❌ '+platform+' 网站爬取需要 CDP 模式\n\n'
                            + '该平台使用了较强的反爬保护，需要通过真实浏览器获取数据。\n\n'
                            + '系统已尝试自动启动 Chrome 调试模式，但连接失败。\n'
                            + '请手动执行：\n'
                            + '1. 关闭所有 Chrome 窗口\n'
                            + '2. Win+R 输入：chrome.exe --remote-debugging-port=9222\n'
                            + '3. 保持窗口打开，回到写作页面重试爬取';
                        errSummary = '需要CDP模式：请以调试模式启动Chrome后重试';
                    } else {
                        errContent = '❌ 网页爬取失败\n\n'
                            + '错误信息：'+errDetail+'\n'
                            + '目标平台：'+platform+'\n\n'
                            + '可能原因：\n'
                            + '1. 网站搜索接口地址已变更或失效\n'
                            + '2. 目标网站存在反爬虫机制\n'
                            + '3. 当前网络环境限制\n\n'
                            + '💡 建议尝试更换平台（如起点、纵横等）或稍后重试。';
                        errSummary = '爬取失败：无法访问【'+platform+'】网站，请更换平台或稍后重试';
                    }
                    resolve({ result: errContent, error: errDetail, summary: errSummary });
                }
            });
        } else if (tl.indexOf('design_worldview') >= 0 || tl.indexOf('世界观设计') >= 0 || (tl.indexOf('world') >= 0 && tl.indexOf('design') >= 0)) {
            // 设计世界观 → LLM生成 + 自动提取结构
            var projW = queryOne('SELECT * FROM writing_projects WHERE id=?', [projectId]);
            var ctxW = '项目名称：'+(projW?projW.title:'')+'\n类型：'+(projW?(projW.genre||'未定'):'')+' '+(projW?(projW.sub_genre||''):'')+'\n';
            var histW = queryAll('SELECT * FROM agent_conversations WHERE project_id=? ORDER BY created_at ASC LIMIT 100', [projectId]);
            histW.forEach(function(m) {
                if (m.role==='user') ctxW += '用户：'+m.content+'\n';
            });
            ctxW += '\n用户需求：'+(args.details||args.core_theme||args.genre||'请生成世界观');
            console.log('[Writing 世界观] 设计开始 项目='+projectId);
            broadcastDevLog('info','server','[Worldview] 世界观设计开始 project='+projectId);
            callOutlineLLM(projectId, userId, WORLD_EXTRACTION_SYSTEM.replace('提取实体和关系','设计并提取世界观实体和关系'), ctxW, 'world_design', null, function(result) {
                if (result.error) { resolve({ error: result.error, summary: '世界观设计失败: '+result.error }); return; }
                var summary = '世界观已生成';
                broadcastDevLog('info','server','[Worldview] LLM返回 contentLen='+(result.content||'').length+' thinkingLen='+(result.thinking||'').length);
                // 尝试提取结构化数据并写入world_entities/world_relations
                try {
                    var cleaned = (result.content||'').replace(/```json\s*/g,'').replace(/```\s*/g,'').trim();
                    var extracted = JSON.parse(cleaned);
                    broadcastDevLog('info','server','[Worldview] JSON解析成功 实体='+(extracted.实体||[]).length+' 关系='+(extracted.关系||[]).length);
                    if (extracted.实体 && Array.isArray(extracted.实体) && extracted.实体.length > 0) {
                        var idMap = {};
                        extracted.实体.forEach(function(e) {
                            var name = e.名称||e.name||'未命名';
                            var type = e.类型||e.type||'';
                            var desc = e.描述||e.description||'';
                            var eid = dbRun('INSERT INTO world_entities (project_id, name, type, description, parent_id) VALUES (?,?,?,?,?)', [projectId, name, type, desc, null]);
                            var tempId = e.临时ID||e.临时ID||e.tempId||String(eid);
                            idMap[tempId] = eid;
                            broadcastDevLog('info','server','[Worldview] 实体入库: '+name+' type='+type+' id='+eid);
                        });
                        // 回填parent_id
                        extracted.实体.forEach(function(e) {
                            var pid = e.父临时ID||e.父临时ID||e.parentTempId||null;
                            var tempId = e.临时ID||e.临时ID||e.tempId||'';
                            if (pid && idMap[pid] && idMap[tempId]) {
                                dbRun('UPDATE world_entities SET parent_id=? WHERE id=?', [idMap[pid], idMap[tempId]]);
                            }
                        });
                        // 写入关系
                        var relCount = 0;
                        (extracted.关系||[]).forEach(function(r) {
                            var fromId = idMap[r.源临时ID||r.fromTempId||''];
                            var toId = idMap[r.目标临时ID||r.toTempId||''];
                            if (fromId && toId) {
                                dbRun('INSERT INTO world_relations (project_id, from_entity_id, to_entity_id, relation_type, description) VALUES (?,?,?,?,?)', [projectId, fromId, toId, r.关系类型||r.relationType||r.relation_type||'', r.描述||r.description||'']);
                                relCount++;
                            }
                        });
                        saveDB();
                        summary = '已生成世界观，提取 '+(extracted.实体||[]).length+' 个实体和 '+relCount+' 条关系';
                        broadcastDevLog('info','server','[Worldview] 完成 实体='+(extracted.实体||[]).length+' 关系='+relCount);
                    } else {
                        broadcastDevLog('warn','server','[Worldview] LLM返回了内容但未包含"实体"数组，请检查提示词 keys='+Object.keys(extracted).join(','));
                        summary = '世界观已生成（但未提取到结构化实体，请确认世界观内容足够详细）';
                    }
                } catch(e) {
                    broadcastDevLog('warn','server','[Worldview] JSON解析失败: '+e.message+' content前200字='+(result.content||'').substring(0,200));
                    summary = '世界观已生成（结构化提取失败: '+e.message+'，但文本内容已保存）';
                }
                resolve({ result: result.content, thinking: result.thinking || '', summary: summary });
            }, streamCallback, null, true);
        } else if (tl.indexOf('extract_world') >= 0 || tl.indexOf('世界观提取') >= 0 || tl.indexOf('worldview_structure') >= 0) {
            // 从已有文本提取世界观结构
            var textToExtract = args.text || args.content || args.world_text || '';
            if (!textToExtract || textToExtract.trim().length < 10) {
                // 没有提供文本 → 从蓝图获取
                var bpW = queryOne('SELECT * FROM story_blueprints WHERE project_id=? ORDER BY version DESC LIMIT 1', [projectId]);
                if (bpW) {
                    try {
                        var bpJson = JSON.parse(bpW.blueprint_json||'{}');
                        textToExtract = (bpJson.world||{}).era_summary||'';
                    } catch(e) {}
                }
                if (!textToExtract) {
                    // 最后回退：从对话历史取
                    var histExt = queryAll('SELECT content FROM agent_conversations WHERE project_id=? AND role=? ORDER BY id DESC LIMIT 20', [projectId, 'user']);
                    textToExtract = histExt.map(function(m){return m.content;}).join('\n');
                }
            }
            if (!textToExtract || textToExtract.trim().length < 10) {
                resolve({ error: '无足够的世界观文本用于提取（需≥10字）', summary: '世界观提取失败：缺少文本' });
                return;
            }
            console.log('[Writing 世界观提取] 项目='+projectId+' textLen='+textToExtract.length);
            broadcastDevLog('info','server','[Worldview] 提取开始 textLen='+textToExtract.length);
            var extractCtx = '请从以下世界观文本中提取实体和关系：\n\n'+textToExtract.substring(0, 8000);
            callOutlineLLM(projectId, userId, WORLD_EXTRACTION_SYSTEM, extractCtx, 'world_extraction', null, function(result) {
                if (result.error) { resolve({ error: result.error, summary: '提取失败: '+result.error }); return; }
                var summary = '提取完成';
                try {
                    var cleaned = (result.content||'').replace(/```json\s*/g,'').replace(/```\s*/g,'').trim();
                    var extracted = JSON.parse(cleaned);
                    var idMap = {}, savedE = 0, savedR = 0;
                    (extracted.实体||[]).forEach(function(e) {
                        var eid = dbRun('INSERT INTO world_entities (project_id, name, type, description, parent_id) VALUES (?,?,?,?,?)', [projectId, e.名称||e.name||'', e.类型||e.type||'', e.描述||e.description||'', null]);
                        idMap[e.临时ID||e.临时ID||e.tempId||String(eid)] = eid;
                        savedE++;
                    });
                    (extracted.实体||[]).forEach(function(e) {
                        var pid = e.父临时ID||e.父临时ID||e.parentTempId||null;
                        var tempId = e.临时ID||e.临时ID||e.tempId||'';
                        if (pid && idMap[pid] && idMap[tempId]) {
                            dbRun('UPDATE world_entities SET parent_id=? WHERE id=?', [idMap[pid], idMap[tempId]]);
                        }
                    });
                    (extracted.关系||[]).forEach(function(r) {
                        var fromId = idMap[r.源临时ID||r.fromTempId||''];
                        var toId = idMap[r.目标临时ID||r.toTempId||''];
                        if (fromId && toId) {
                            dbRun('INSERT INTO world_relations (project_id, from_entity_id, to_entity_id, relation_type, description) VALUES (?,?,?,?,?)', [projectId, fromId, toId, r.关系类型||r.relationType||r.relation_type||'', r.描述||r.description||'']);
                            savedR++;
                        }
                    });
                    saveDB();
                    summary = '已提取 '+savedE+' 个实体和 '+savedR+' 条关系';
                    broadcastDevLog('info','server','[Worldview] 提取完成 实体='+savedE+' 关系='+savedR);
                } catch(e) {
                    broadcastDevLog('warn','server','[Worldview] 提取JSON解析失败: '+e.message);
                    summary = '提取失败: '+e.message;
                }
                resolve({ result: result.content, thinking: result.thinking || '', summary: summary });
            }, streamCallback, null, true);
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
                }, streamCallback, null, true);
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

    // 构建消息（注入项目进度摘要）
    var assembledContext = await _buildAssembledContext(projectId, req.userId, content, 'chat');
    var systemContent = ORCHESTRATOR_SYSTEM + '\n\n' + assembledContext;
    var msgs = [{ role:'system', content: systemContent }];
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
        var clientGone = false; // 提前声明，工具循环和读循环共用
        var toolLoopCount = 0;
        while (toolLoopCount < 5) { // 最多5轮工具调用防无限循环
            toolLoopCount++;
            // 检查停止标记和客户端断开
            var stopMark = path.join(BUFFER_DIR, 'stop_'+projectId);
            if (fs.existsSync(stopMark) || clientGone) {
                console.log('[Write LLM] 工具循环收到停止信号或客户端断开, stopMarker='+fs.existsSync(stopMark)+' clientGone='+clientGone);
                clearInterval(toolLoopHeartbeat);
                try { if (fs.existsSync(stopMark)) fs.unlinkSync(stopMark); } catch(e) {}
                break;
            }
            var toolReqBody = { model:model, messages:toolMessages, tools:allTools, temperature:0.7, stream:false };
            if (isDS) { toolReqBody.thinking = { type: 'enabled' }; }
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
                toolMessages.push({
                    role: toolMsg.role,
                    content: toolMsg.content || '',
                    tool_calls: toolMsg.tool_calls,
                    reasoning_content: toolMsg.reasoning_content || ''
                });
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
                    var toolResult = await executeToolAsync(toolName, toolArgs, projectId, req.userId, streamCallback, null, streamStartedAt, res);
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
                        // 暂停流式，等待用户确认
                        var confirmId = 'tc_' + (++_confirmCounter) + '_' + Date.now();
                        res.write('data: '+JSON.stringify({type:'tool_request_confirm',confirmId:confirmId,tool:toolName,subAgent:actualSubAgent,requested:requestedTool,args:requestedArgs})+'\n\n');
                        broadcastDevLog('info','server','[ToolConfirm] 等待用户确认 | Waiting for user: '+requestedTool+' confirmId='+confirmId);
                        // 等待用户确认（30秒超时自动拒绝）
                        var confirmPromise = new Promise(function(resolve) {
                            var timeout = setTimeout(function() {
                                broadcastDevLog('warn','server','[ToolConfirm] 超时自动拒绝 | Timeout auto-deny: '+requestedTool);
                                delete pendingToolConfirms[confirmId];
                                resolve({ approved: false, timedOut: true });
                            }, 30000);
                            pendingToolConfirms[confirmId] = { resolve: resolve, timeout: timeout, tool: toolName, requested: requestedTool };
                        });
                        var confirmResult = await confirmPromise;
                        var reqResult;
                        if (confirmResult.approved) {
                            // 用户同意 → 执行工具
                            res.write('data: '+JSON.stringify({type:'tool_request_status',confirmId:confirmId,status:'approved',tool:toolName,requested:requestedTool})+'\n\n');
                            reqResult = await executeToolAsync(requestedTool, JSON.stringify(requestedArgs), projectId, req.userId, null, null, null, null);
                            console.log('[Write LLM] 子智能体请求的工具完成: '+requestedTool+' '+reqResult.summary);
                        } else {
                            // 用户拒绝或超时 → 跳过
                            res.write('data: '+JSON.stringify({type:'tool_request_status',confirmId:confirmId,status:'denied',tool:toolName,requested:requestedTool,reason:confirmResult.timedOut?'timeout':'user_denied'})+'\n\n');
                            reqResult = { error: confirmResult.timedOut ? '用户确认超时 | Confirmation timeout' : '用户拒绝了工具调用 | User denied tool call', summary: '已跳过「'+requestedTool+'」' };
                            console.log('[Write LLM] 工具请求被'+(confirmResult.timedOut?'超时':'用户')+'拒绝: '+requestedTool);
                        }
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
                        toolResult = await executeToolAsync(toolName, toolArgs, projectId, req.userId, streamCallback, subAgentMsgs, streamStartedAt, res);
                        console.log('[Write LLM] 子智能体继续完成: '+toolName+' '+toolResult.summary);
                        _accContent += toolResult.result || '';
                        _accThinking += toolResult.thinking || '';
                        subAgentMsgs = toolResult._subAgentMsgs || subAgentMsgs;
                    }
                    // 用累积值覆盖最后一轮结果，保证tool_end/DB记录完整
                    toolResult.result = _accContent;
                    toolResult.thinking = _accThinking;
                    var resultContent = toolResult.result ? (toolResult.result||'').substring(0, 500) : toolResult.summary;
                    var subFullResult = toolResult.result || '';
                    var subFullThinking = toolResult.thinking || '';
                    saveStreamBuffer(projectId, resultContent, '✅ '+toolResult.summary, streamStartedAt, 'tool_result', actualSubAgent, subFullResult, subFullThinking);
                    // 完整结果存入DB（刷新后可恢复子智能体气泡）
                    dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content, thinking, metadata) VALUES (?,?,?,?,?,?)',
                        [projectId, actualSubAgent, 'assistant', subFullResult, subFullThinking, '{"type":"tool_result"}']);
                    // 子智能体完成后自动增量更新蓝图
                    try {
                        var tlNameLower = (toolName||'').toLowerCase();
                        console.log('[蓝图] 工具完成检测 toolName='+toolName+' agent='+actualSubAgent+' summary='+(toolResult.summary||'').substring(0,50));
                        broadcastDevLog('info','server','[蓝图] 工具完成检测 toolName='+toolName+' agent='+actualSubAgent);
                        if (actualSubAgent === 'character' || tlNameLower.indexOf('character') >= 0) {
                            // 从DB获取确认的主角名，而非用摘要文本
                            var protagName = '';
                            var protagChar = queryOne('SELECT name FROM writing_characters WHERE project_id=? AND is_protagonist=1 LIMIT 1', [projectId]);
                            if (protagChar) {
                                protagName = protagChar.name;
                            } else {
                                // 回退：取第一个角色
                                var firstChar = queryOne('SELECT name FROM writing_characters WHERE project_id=? ORDER BY id LIMIT 1', [projectId]);
                                if (firstChar) protagName = firstChar.name;
                            }
                            _incrementalUpdateBlueprint(projectId, 'character', { name: protagName || toolResult.summary || '' });
                            broadcastDevLog('info','server','[蓝图] 角色自动更新完成 主角='+protagName);
                        } else if (actualSubAgent === 'outliner' || tlNameLower.indexOf('outline') >= 0) {
                            _incrementalUpdateBlueprint(projectId, 'conflict', { main_thread: toolResult.summary || '' });
                            broadcastDevLog('info','server','[蓝图] 大纲自动更新完成');
                        } else if (tlNameLower.indexOf('world') >= 0 || tlNameLower.indexOf('世界观') >= 0 || actualSubAgent.indexOf('world') >= 0) {
                            // 世界观内容在toolResult.result中 → 提取纯文本摘要（跳过JSON结构）
                            var _raw = toolResult.result || '';
                            var _eraText = '';
                            // 尝试提取"时代概要"字段的描述部分
                            var _eraMatch = _raw.match(/时代概要[：:]\s*(.+?)(?:\n|$)/);
                            if (_eraMatch) { _eraText = _eraMatch[1].substring(0, 200); }
                            else {
                                // 回退：去掉JSON花括号内容，取纯文本
                                _eraText = _raw.replace(/\{[\s\S]*?\}/g, '').replace(/```[\s\S]*?```/g, '').trim().substring(0, 300);
                            }
                            // 提取势力列表
                            var _factions = [];
                            var _fMatch = _raw.match(/势力[：:]\s*(.+?)(?:\n|$)/);
                            if (_fMatch) { _factions = _fMatch[1].split(/[,，、]/).map(function(s){return s.trim();}).filter(Boolean); }
                            // 从world_entities表获取势力类型实体作为补充
                            if (!_factions.length) {
                                var _entFactions = queryAll("SELECT name FROM world_entities WHERE project_id=? AND type='势力' LIMIT 8", [projectId]);
                                if (_entFactions.length) _factions = _entFactions.map(function(e){return e.name;});
                            }
                            _incrementalUpdateBlueprint(projectId, 'worldbuilding', { era: _eraText || '世界观已生成（详见world_entities表）', factions: _factions });
                            broadcastDevLog('info','server','[蓝图] 世界观自动更新完成 文本长度='+_eraText.length+' 势力='+_factions.length);
                        } else {
                            broadcastDevLog('info','server','[蓝图] 工具不在自动更新范围: '+toolName);
                        }
                    } catch(e) { broadcastDevLog('warn','server','[蓝图] 自动更新失败: '+e.message); }
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
                var orchMsgId = dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content, thinking, token_used) VALUES (?,?,?,?,?,?)', [projectId, 'orchestrator', 'assistant', finalContent, finalThinking, (toolData.usage?toolData.usage.total_tokens:0)]); console.log('[Write LLM] 最终回复已存DB contentLen='+finalContent.length);
                _autoChunkMessage(projectId, 'orchestrator', 'assistant', finalContent, orchMsgId);
                saveDB();
                clearStreamBuffer(projectId);
                // 通知前端重新加载对话（爬虫等子智能体tool_result已完成入库）
                broadcastWriteEvent(projectId, {type:'reload-chat'});
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

        var streamReqBody = { model:model, messages:msgs, stream:true, temperature:0.7, stream_options: { include_usage: true } };

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
            var tokIn = 0, tokOut = 0, tokCache = 0;
            var chunkCount = 0;

            // 心跳保活（10秒间隔）；若写入失败说明客户端已断开→转入后台模式
            var heartbeat = setInterval(function() {
                try { res.write('data: {"type":"waiting"}\n\n'); } catch(e) { clearInterval(heartbeat); clientGone = true; }
            }, 10000);

            // 监听连接关闭（页面刷新/关闭时最可靠的检测方式）
            req.on('close', function() {
                if (!clientGone) {
                    clientGone = true;
                    clearInterval(heartbeat);
                    console.log('[Write LLM] 客户端断开（req.close），停止流式');
                }
            });
            console.log('[Write LLM] 进入读循环');
            while (true) {
                // 检查停止标记（用户从新页面点击了停止）
                var stopMarker = path.join(BUFFER_DIR, 'stop_'+projectId);
                if (fs.existsSync(stopMarker)) {
                    console.log('[Write LLM] 收到停止信号，终止流式');
                    reader.cancel();
                    clearInterval(heartbeat);
                    try { fs.unlinkSync(stopMarker); } catch(e) {}
                    return;
                }
                // 检查客户端是否已断开（刷新/关闭页面后不继续浪费资源）
                if (clientGone) {
                    console.log('[Write LLM] 客户端已断开，终止读循环');
                    reader.cancel();
                    clearInterval(heartbeat);
                    return;
                }
                var chunk = await reader.read();
                chunkCount++;
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
                            tokCache = (parsed.usage.prompt_tokens_details && parsed.usage.prompt_tokens_details.cached_tokens) || 0;
                        }
                    } catch(e) {}
                }
            }

            clearInterval(heartbeat);

            // 保存助手回复到数据库（无论客户端是否断开）
            if (fullContent || fullThinking) {
                dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content, thinking, token_used) VALUES (?,?,?,?,?,?)',
                    [projectId, 'orchestrator', 'assistant', fullContent, fullThinking, tokIn+tokOut]);
                _logTokenUsage(req.userId, projectId, 'orchestrator', model, tokIn, tokOut, tokCache);
                saveDB();
            }

            console.log('[Write LLM] 流式完成 回复长度='+fullContent.length+' 思考长度='+fullThinking.length+' tokens in='+tokIn+' out='+tokOut+(clientGone?' (后台完成)':''));

            // 通知 SSE 客户端 + 清除磁盘缓冲和停止标记
            broadcastWriteEvent(projectId, {type:'stream-done',content:fullContent,thinking:fullThinking});
            broadcastWriteEvent(projectId, {type:'reload-chat'});
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
    var userMsgId = dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content) VALUES (?,?,?,?)', [projectId, 'user', 'user', content]);
    _autoChunkMessage(projectId, 'user', 'user', content, userMsgId);

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
        var tokCache = (d.usage && d.usage.prompt_tokens_details && d.usage.prompt_tokens_details.cached_tokens)||0;
        console.log('[Write LLM] 回复长度='+reply.length+' tokens in='+tokIn+' out='+tokOut+(tokCache?' cache='+tokCache:''));

        dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content, thinking, token_used) VALUES (?,?,?,?,?,?)',
            [projectId, 'orchestrator', 'assistant', reply, thinking||'', tokIn+tokOut]);
        _logTokenUsage(req.userId, projectId, 'orchestrator', model, tokIn, tokOut, tokCache);
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
var DIALOG_SYSTEM = loadPrompt('dialog.md');

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

// 设置主角：清除旧主角标记后设为1，同步蓝图
app.put('/api/writing-projects/:id/characters/:cid/set-protagonist', auth, (req, res) => {
    var projectId = parseInt(req.params.id);
    var charId = parseInt(req.params.cid);
    // 清除该项目下所有旧的主角标记
    dbRun('UPDATE writing_characters SET is_protagonist=0, updated_at=CURRENT_TIMESTAMP WHERE project_id=? AND is_protagonist=1', [projectId]);
    // 设置新主角
    dbRun('UPDATE writing_characters SET is_protagonist=1, updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=?', [charId, projectId]);
    saveDB();
    // 同步到蓝图
    var c = queryOne('SELECT name FROM writing_characters WHERE id=?', [charId]);
    if (c) {
        _incrementalUpdateBlueprint(projectId, 'character', { name: c.name });
    }
    console.log('[Writing] 主角已确认: project='+projectId+' charId='+charId+' name='+(c?c.name:''));
    broadcastDevLog('info','server','[Protagonist] 主角确认: '+(c?c.name:'')+' | Protagonist confirmed: '+(c?c.name:''));
    res.json({ ok: true, name: c ? c.name : '' });
});

// 获取主角候选（角色生成后自动提议用）
app.get('/api/writing-projects/:id/protagonist-candidate', auth, (req, res) => {
    var chars = queryAll('SELECT * FROM writing_characters WHERE project_id=? ORDER BY id', [req.params.id]);
    var protagonist = null;
    // 优先找已标记为主角的
    for (var i = 0; i < chars.length; i++) {
        if (chars[i].is_protagonist === 1) { protagonist = chars[i]; break; }
    }
    // 其次找profile_json中有is_protagonist标记的
    if (!protagonist) {
        for (var i = 0; i < chars.length; i++) {
            try {
                var pf = JSON.parse(chars[i].profile_json || '{}');
                if (pf.is_protagonist || pf['主角'] || (pf['角色类型'] === '主角')) { protagonist = chars[i]; break; }
            } catch(e) {}
        }
    }
    // 都没有就用第一个角色作为候选
    if (!protagonist && chars.length > 0) protagonist = chars[0];
    res.json({ candidate: protagonist, total: chars.length, hasConfirmed: chars.some(function(c) { return c.is_protagonist === 1; }) });
});

// tool_request 用户确认端点
app.post('/api/writing-projects/:id/confirm-tool', auth, (req, res) => {
    var { confirmId, action } = req.body; // action: 'approve' | 'deny'
    if (!confirmId || !action) return res.status(400).json({ error: '缺少confirmId或action参数' });
    var pending = pendingToolConfirms[confirmId];
    if (!pending) return res.status(404).json({ error: '确认请求已过期或不存在 | Confirmation expired or not found' });
    console.log('[ToolConfirm] confirmId='+confirmId+' action='+action+' tool='+pending.tool+' requested='+pending.requested);
    broadcastDevLog('info','server','[ToolConfirm] confirmId='+confirmId+' action='+action+' | User '+(action==='approve'?'approved':'denied')+' tool: '+pending.requested);
    clearTimeout(pending.timeout);
    if (action === 'approve') {
        pending.resolve({ approved: true });
    } else {
        pending.resolve({ approved: false });
    }
    delete pendingToolConfirms[confirmId];
    res.json({ ok: true });
});

// ==================== 世界观实体 CRUD ====================
app.get('/api/writing-projects/:id/world-entities', auth, (req, res) => {
    const entities = queryAll('SELECT * FROM world_entities WHERE project_id=? ORDER BY id', [req.params.id]);
    res.json(entities);
});
app.post('/api/writing-projects/:id/world-entities', auth, (req, res) => {
    const { name, type, description, parent_id, metadata_json } = req.body;
    if (!name) return res.status(400).json({ error:'缺少实体名称' });
    const id = dbRun('INSERT INTO world_entities (project_id, name, type, description, parent_id, metadata_json) VALUES (?,?,?,?,?,?)', [req.params.id, name, type||'', description||'', parent_id||null, metadata_json||'{}']);
    saveDB();
    res.json({ id, name });
});
app.put('/api/writing-projects/:id/world-entities/:eid', auth, (req, res) => {
    const { name, type, description, parent_id, metadata_json } = req.body;
    var sets=[], params=[];
    if (name!==undefined){sets.push('name=?');params.push(name);}
    if (type!==undefined){sets.push('type=?');params.push(type);}
    if (description!==undefined){sets.push('description=?');params.push(description);}
    if (parent_id!==undefined){sets.push('parent_id=?');params.push(parent_id);}
    if (metadata_json!==undefined){sets.push('metadata_json=?');params.push(metadata_json);}
    if (sets.length){sets.push('updated_at=CURRENT_TIMESTAMP');params.push(req.params.eid);dbRun('UPDATE world_entities SET '+sets.join(',')+' WHERE id=?',params);saveDB();}
    res.json({ ok:true });
});
app.delete('/api/writing-projects/:id/world-entities/:eid', auth, (req, res) => {
    dbRun('DELETE FROM world_entities WHERE id=?', [req.params.eid]);
    dbRun('DELETE FROM world_relations WHERE from_entity_id=? OR to_entity_id=?', [req.params.eid, req.params.eid]);
    saveDB();
    res.json({ ok:true });
});

// ==================== 世界观关系 CRUD ====================
app.get('/api/writing-projects/:id/world-relations', auth, (req, res) => {
    const rels = queryAll('SELECT wr.*, fe.name AS from_name, te.name AS to_name FROM world_relations wr LEFT JOIN world_entities fe ON wr.from_entity_id=fe.id LEFT JOIN world_entities te ON wr.to_entity_id=te.id WHERE wr.project_id=? ORDER BY wr.id', [req.params.id]);
    res.json(rels);
});
app.post('/api/writing-projects/:id/world-relations', auth, (req, res) => {
    const { from_entity_id, to_entity_id, relation_type, description, intensity, metadata_json } = req.body;
    if (!from_entity_id || !to_entity_id) return res.status(400).json({ error:'缺少关联实体ID' });
    const id = dbRun('INSERT INTO world_relations (project_id, from_entity_id, to_entity_id, relation_type, description, intensity, metadata_json) VALUES (?,?,?,?,?,?,?)', [req.params.id, from_entity_id, to_entity_id, relation_type||'', description||'', intensity||5, metadata_json||'{}']);
    saveDB();
    res.json({ id });
});
app.put('/api/writing-projects/:id/world-relations/:rid', auth, (req, res) => {
    const { from_entity_id, to_entity_id, relation_type, description, intensity, metadata_json } = req.body;
    var sets=[], params=[];
    if (from_entity_id!==undefined){sets.push('from_entity_id=?');params.push(from_entity_id);}
    if (to_entity_id!==undefined){sets.push('to_entity_id=?');params.push(to_entity_id);}
    if (relation_type!==undefined){sets.push('relation_type=?');params.push(relation_type);}
    if (description!==undefined){sets.push('description=?');params.push(description);}
    if (intensity!==undefined){sets.push('intensity=?');params.push(intensity);}
    if (metadata_json!==undefined){sets.push('metadata_json=?');params.push(metadata_json);}
    if (sets.length){sets.push('updated_at=CURRENT_TIMESTAMP');params.push(req.params.rid);dbRun('UPDATE world_relations SET '+sets.join(',')+' WHERE id=?',params);saveDB();}
    res.json({ ok:true });
});
app.delete('/api/writing-projects/:id/world-relations/:rid', auth, (req, res) => {
    dbRun('DELETE FROM world_relations WHERE id=?', [req.params.rid]);
    saveDB();
    res.json({ ok:true });
});

// ==================== 角色Agent ====================
var CHARACTER_SYSTEM = loadPrompt('character.md');

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

// ==================== 世界观提取Agent ====================
var WORLD_EXTRACTION_SYSTEM = loadPrompt('world_extraction.md');

app.post('/api/writing-projects/:id/extract-world', auth, (req, res) => {
    const projectId = parseInt(req.params.id);
    const { text, autoSave } = req.body; // autoSave=true 时直接写入DB
    if (!text || text.trim().length < 10) return res.status(400).json({ error:'世界观文本过短，至少10字' });
    var proj = queryOne('SELECT * FROM writing_projects WHERE id=? AND user_id=?', [projectId, req.userId]);
    if (!proj) return res.status(404).json({ error:'项目不存在' });
    console.log('[Writing 世界观提取] 项目='+projectId+' 文本长度='+text.length);
    var context = '项目名称：'+proj.title+'\n类型：'+proj.genre+' '+proj.sub_genre+'\n\n请从以下世界观文本中提取实体和关系：\n\n'+text;
    callOutlineLLM(projectId, req.userId, WORLD_EXTRACTION_SYSTEM, context, 'world_extraction', req, function(result) {
        if (result.error) return res.status(500).json({ error:result.error });
        var extracted = null;
        try {
            var cleaned = result.content.replace(/```json\s*/g,'').replace(/```\s*/g,'').trim();
            extracted = JSON.parse(cleaned);
        } catch(e) {
            console.log('[Writing 世界观提取] JSON解析失败，尝试修复:', e.message);
            return res.status(500).json({ error:'LLM返回格式异常，无法解析为JSON', raw:result.content.substring(0,500) });
        }
        if (!extracted.实体 || !Array.isArray(extracted.实体)) {
            return res.status(500).json({ error:'LLM返回缺少"实体"数组', raw:result.content.substring(0,500) });
        }
        // 建立临时ID→真实ID映射
        var idMap = {};
        var savedEntities = [];
        if (autoSave) {
            // 先插入所有实体
            (extracted.实体||[]).forEach(function(e) {
                var eid = dbRun('INSERT INTO world_entities (project_id, name, type, description, parent_id) VALUES (?,?,?,?,?)', [projectId, e.名称||e.name||'', e.类型||e.type||'', e.描述||e.description||'', null]);
                idMap[e.临时ID||e.临时ID||e.tempId||''] = eid;
                savedEntities.push({ id:eid, name:e.名称||e.name });
            });
            // 回填parent_id
            (extracted.实体||[]).forEach(function(e) {
                var pid = e.父临时ID||e.父临时ID||e.parentTempId||null;
                if (pid && idMap[pid] && idMap[e.临时ID||e.临时ID||e.tempId||'']) {
                    dbRun('UPDATE world_entities SET parent_id=? WHERE id=?', [idMap[pid], idMap[e.临时ID||e.临时ID||e.tempId||'']]);
                }
            });
            // 插入关系
            var savedRelations = [];
            (extracted.关系||[]).forEach(function(r) {
                var fromId = idMap[r.源临时ID||r.fromTempId||''];
                var toId = idMap[r.目标临时ID||r.toTempId||''];
                if (fromId && toId) {
                    var rid = dbRun('INSERT INTO world_relations (project_id, from_entity_id, to_entity_id, relation_type, description) VALUES (?,?,?,?,?)', [projectId, fromId, toId, r.关系类型||r.relationType||r.relation_type||'', r.描述||r.description||'']);
                    savedRelations.push({ id:rid, from:fromId, to:toId, type:r.关系类型||r.relationType||'' });
                }
            });
            saveDB();
            console.log('[Writing 世界观提取] 已保存 实体='+savedEntities.length+' 关系='+savedRelations.length);
            res.json({ entities:savedEntities, relations:savedRelations, idMap:idMap });
        } else {
            // 不自动保存，只返回解析结果供前端预览
            res.json({ entities:extracted.实体, relations:extracted.关系||[], preview:true });
        }
    });
});

// 批量保存世界观实体/关系（前端预览编辑后确认）
app.post('/api/writing-projects/:id/world-bulk-save', auth, (req, res) => {
    const projectId = parseInt(req.params.id);
    const { entities, relations } = req.body;
    if (!entities || !Array.isArray(entities)) return res.status(400).json({ error:'缺少entities数组' });
    // 先插入所有实体，建立临时ID→真实ID映射
    var idMap = {};
    var savedEntities = [];
    (entities||[]).forEach(function(e) {
        var eid = dbRun('INSERT INTO world_entities (project_id, name, type, description, parent_id) VALUES (?,?,?,?,?)', [projectId, e.name||'', e.type||'', e.description||'', null]);
        idMap[e.tempId||e.临时ID||''] = eid;
        savedEntities.push({ id:eid, name:e.name, tempId:e.tempId||e.临时ID });
    });
    // 回填parent_id
    (entities||[]).forEach(function(e) {
        var pid = e.parentTempId||e.父临时ID||null;
        if (pid && idMap[pid] && idMap[e.tempId||e.临时ID||'']) {
            dbRun('UPDATE world_entities SET parent_id=? WHERE id=?', [idMap[pid], idMap[e.tempId||e.临时ID||'']]);
        }
    });
    // 插入关系
    var savedRelations = [];
    (relations||[]).forEach(function(r) {
        var fromId = idMap[r.fromTempId||r.源临时ID||''];
        var toId = idMap[r.toTempId||r.目标临时ID||''];
        if (fromId && toId) {
            var rid = dbRun('INSERT INTO world_relations (project_id, from_entity_id, to_entity_id, relation_type, description) VALUES (?,?,?,?,?)', [projectId, fromId, toId, r.type||r.关系类型||'', r.description||r.描述||'']);
            savedRelations.push({ id:rid });
        }
    });
    saveDB();
    console.log('[Writing] 批量保存 实体='+savedEntities.length+' 关系='+savedRelations.length);
    res.json({ entities:savedEntities, relations:savedRelations, idMap:idMap });
});

// 存量蓝图回填：已有项目文本→LLM提取→world_entities
app.post('/api/writing-projects/:id/backfill-world', auth, (req, res) => {
    const projectId = parseInt(req.params.id);
    var proj = queryOne('SELECT * FROM writing_projects WHERE id=? AND user_id=?', [projectId, req.userId]);
    if (!proj) return res.status(404).json({ error:'项目不存在' });
    // 收集项目中的世界观相关文本
    var bp = queryOne('SELECT * FROM story_blueprints WHERE project_id=? ORDER BY version DESC LIMIT 1', [projectId]);
    var bpJson = bp ? JSON.parse(bp.blueprint_json||'{}') : {};
    var worldText = (bpJson.world||{}).era_summary||'';
    if (!worldText) {
        // 回退：从对话历史中提取
        var history = queryAll('SELECT content FROM agent_conversations WHERE project_id=? AND role=? ORDER BY created_at DESC LIMIT 50', [projectId, 'user']);
        worldText = history.map(function(m){return m.content;}).join('\n');
    }
    if (!worldText || worldText.trim().length < 20) {
        return res.status(400).json({ error:'项目暂无足够的世界观文本用于提取（需≥20字）' });
    }
    console.log('[Writing 回填] 项目='+projectId+' 文本长度='+worldText.length);
    var context = '项目名称：'+proj.title+'\n类型：'+proj.genre+' '+proj.sub_genre+'\n\n请从以下文本中提取世界观实体和关系：\n\n'+worldText.substring(0,8000);
    callOutlineLLM(projectId, req.userId, WORLD_EXTRACTION_SYSTEM, context, 'world_backfill', req, function(result) {
        if (result.error) return res.status(500).json({ error:result.error });
        var extracted = null;
        try {
            var cleaned = result.content.replace(/```json\s*/g,'').replace(/```\s*/g,'').trim();
            extracted = JSON.parse(cleaned);
        } catch(e) {
            return res.status(500).json({ error:'LLM返回格式异常', raw:result.content.substring(0,300) });
        }
        var idMap = {}, savedE = [], savedR = [];
        (extracted.实体||[]).forEach(function(e) {
            var eid = dbRun('INSERT INTO world_entities (project_id, name, type, description, parent_id) VALUES (?,?,?,?,?)', [projectId, e.名称||e.name||'', e.类型||e.type||'', e.描述||e.description||'', null]);
            idMap[e.临时ID||e.临时ID||e.tempId||''] = eid;
            savedE.push({ id:eid, name:e.名称||e.name });
        });
        (extracted.实体||[]).forEach(function(e) {
            var pid = e.父临时ID||e.父临时ID||e.parentTempId||null;
            if (pid && idMap[pid] && idMap[e.临时ID||e.临时ID||e.tempId||'']) {
                dbRun('UPDATE world_entities SET parent_id=? WHERE id=?', [idMap[pid], idMap[e.临时ID||e.临时ID||e.tempId||'']]);
            }
        });
        (extracted.关系||[]).forEach(function(r) {
            var fromId = idMap[r.源临时ID||r.fromTempId||''];
            var toId = idMap[r.目标临时ID||r.toTempId||''];
            if (fromId && toId) {
                dbRun('INSERT INTO world_relations (project_id, from_entity_id, to_entity_id, relation_type, description) VALUES (?,?,?,?,?)', [projectId, fromId, toId, r.关系类型||r.relationType||r.relation_type||'', r.描述||r.description||'']);
                savedR.push({ from:fromId, to:toId });
            }
        });
        saveDB();
        console.log('[Writing 回填] 完成 实体='+savedE.length+' 关系='+savedR.length);
        res.json({ entities:savedE, relations:savedR, sourceLength:worldText.length });
    });
});

// ==================== 大纲Agent ====================
var OUTLINER_SYSTEM = loadPrompt('outliner.md');

// streamCallback: 流式回调 function({type:'thinking'|'content', delta:'...'})，null=非流式
// tools: 工具定义数组(用于request_tool机制)，null=不传工具
// ===== Token计费辅助 =====
function _logTokenUsage(userId, projectId, agentType, model, tokIn, tokOut, tokCache) {
    if (!tokIn && !tokOut) return;
    var pricing = queryOne('SELECT * FROM token_pricing_config WHERE (user_id=? OR user_id IS NULL) AND (model_name=? OR is_default=1) ORDER BY is_default ASC LIMIT 1', [userId, model]);
    var inpPrice = pricing ? pricing.input_price_per_million || 0 : 0;
    var outPrice = pricing ? pricing.output_price_per_million || 0 : 0;
    var cachePrice = pricing ? pricing.cache_hit_price_per_million || 0 : 0;
    var discount = pricing ? pricing.discount_rate || 1 : 1;
    tokCache = tokCache || 0;
    var costInput = (tokIn / 1000000) * inpPrice * discount;
    var costOutput = (tokOut / 1000000) * outPrice * discount;
    var costCache = (tokCache / 1000000) * cachePrice * discount;
    dbRun('INSERT INTO token_usage_logs (user_id, project_id, agent_type, model, input_tokens, output_tokens, cache_tokens, cost_input, cost_output, cost_cache) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [userId, projectId, agentType, model, tokIn, tokOut, tokCache, costInput, costOutput, costCache]);
    broadcastDevLog('info','server','[Token] '+agentType+' 输入='+tokIn+' 输出='+tokOut+(tokCache?' 缓存命中='+tokCache:'')+' 费用=¥'+(costInput+costOutput+costCache).toFixed(4));
    saveDB();
}

// ===== RAG Embedding 生成 =====
function _getRetrievalConfig(userId) {
    var cfg = queryOne('SELECT * FROM agents WHERE user_id=? ORDER BY id LIMIT 1', [userId]);
    if (!cfg || !cfg.api_key) return null;
    // 优先使用 writing_agent_config 中首个配置了检索模型的记录，否则用默认LLM配置
    var agents = queryAll('SELECT * FROM writing_agent_config WHERE project_id IN (SELECT id FROM writing_projects WHERE user_id=?)', [userId]);
    var retModel = '', retEp = '', retKey = '';
    if (agents && agents.length) {
        for (var ai = 0; ai < agents.length; ai++) {
            if (agents[ai].retrieval_model) { retModel = agents[ai].retrieval_model; retEp = agents[ai].retrieval_endpoint; retKey = agents[ai].retrieval_api_key; break; }
        }
    }
    var baseEp = retEp || (cfg.api_endpoint ? cfg.api_endpoint.replace('/chat/completions','') : 'https://api.deepseek.com/v1');
    return {
        model: retModel || cfg.model || 'deepseek-v4-flash', // 默认用用户配置的模型，未配置则用Flash
        endpoint: baseEp,
        api_key: retKey || cfg.api_key
    };
}

// Embedding查询缓存（LRU，减少API调用费用+延迟）
var _embedCache = [];  // [{text, vector, dim, model, ts}]
var _EMBED_CACHE_MAX = 100;
function _findCachedEmbedding(text) {
    var now = Date.now();
    // 清理过期缓存（5分钟）
    _embedCache = _embedCache.filter(function(e) { return now - e.ts < 300000; });
    for (var i = 0; i < _embedCache.length; i++) {
        if (_embedCache[i].text === text) { _embedCache[i].ts = now; return _embedCache[i]; }
    }
    return null;
}
function _cacheEmbedding(text, vector, dim, model) {
    _embedCache.push({ text: text, vector: vector, dim: dim, model: model, ts: Date.now() });
    if (_embedCache.length > _EMBED_CACHE_MAX) _embedCache.shift();
}

// 自动分块：消息写入时异步生成embedding
function _autoChunkMessage(projectId, agentType, role, content, msgId) {
    if (!content || content.length < 20) return; // 太短的不分块
    var proj = queryOne('SELECT user_id FROM writing_projects WHERE id=?', [projectId]);
    var retrievalCfg = proj ? _getRetrievalConfig(proj.user_id) : null;
    if (!retrievalCfg) return;
    var sourceType = role === 'user' ? 'conversation' : 'agent_' + agentType;
    var sourceId = sourceType + '_' + (msgId || Date.now());
    var meta = JSON.stringify({ agent: agentType, role: role, length: content.length });
    _enqueueEmbedding(projectId, sourceType, sourceId, content.substring(0, 2000), meta, retrievalCfg);
}

// 检索降级：embedding不可用时纯BM25兜底
async function _searchWithFallback(projectId, query, k, sourceTypes, retrievalCfg) {
    if (!retrievalCfg) {
        // 无API配置 → 纯BM25
        return { results: _bm25ToResults(projectId, query, sourceTypes, k), method: 'bm25_fallback' };
    }
    try {
        var cached = _findCachedEmbedding(query);
        var emb;
        if (cached) {
            emb = { vector: cached.vector, dim: cached.dim, model: cached.model };
        } else {
            emb = await _generateEmbedding(query, retrievalCfg);
            if (emb) _cacheEmbedding(query, emb.vector, emb.dim, emb.model);
        }
        if (!emb) throw new Error('embedding failed');
        var keywords = _extractKeywords(query);
        var vecResults = HNSW.search(new Float32Array(emb.vector), k * 2, projectId);
        var bm25Results = _bm25Search(projectId, keywords, sourceTypes, k);
        var merged = _rrfMerge(
            vecResults.map(function(r) { return { chunk_id: r.id, score: 1 - r.dist, method: 'vector' }; }),
            bm25Results,
            0.3
        );
        return { results: _loadChunkResults(merged.slice(0, k)), method: 'hybrid', keywords: keywords };
    } catch(e) {
        console.log('[RAG] 向量检索失败，降级BM25:', e.message);
        return { results: _bm25ToResults(projectId, query, sourceTypes, k), method: 'bm25_fallback' };
    }
}

function _bm25ToResults(projectId, query, sourceTypes, k) {
    var keywords = _extractKeywords(query);
    var bm25 = _bm25Search(projectId, keywords, sourceTypes, k);
    return _loadChunkResults(bm25);
}

function _loadChunkResults(ranked) {
    var finalResults = [];
    ranked.forEach(function(r) {
        var chunk = queryOne('SELECT * FROM rag_chunks WHERE id=?', [r.chunk_id]);
        if (chunk) {
            finalResults.push({
                id: chunk.id, source_type: chunk.source_type, source_id: chunk.source_id,
                content: chunk.content_text, metadata: safeJsonParse(chunk.metadata_json, {}),
                score: r.score, method: r.method || 'bm25'
            });
        }
    });
    return finalResults;
}

var _embedDisabled = false; // 首次404后停用embedding，完全依赖BM25

// 单条文本生成embedding（同步调用）
async function _generateEmbedding(text, retrievalCfg) {
    if (_embedDisabled || !retrievalCfg || !text) return null;
    try {
        var resp = await fetch(retrievalCfg.endpoint + '/embeddings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + retrievalCfg.api_key },
            body: JSON.stringify({ model: retrievalCfg.model, input: text })
        });
        if (!resp.ok) {
            if (resp.status === 404) { _embedDisabled = true; console.log('[Embedding] 端点404，已停用embedding，后续仅用BM25检索'); }
            else console.log('[Embedding] API失败 status='+resp.status);
            return null;
        }
        var data = await resp.json();
        if (data.data && data.data[0] && data.data[0].embedding) {
            return { vector: data.data[0].embedding, dim: data.data[0].embedding.length, model: data.model };
        }
    } catch(e) { console.log('[Embedding] 调用异常:', e.message); }
    return null;
}

// 异步批量生成embedding队列（不阻塞请求）
var _embedQueue = [], _embedTimer = null;
function _enqueueEmbedding(projectId, sourceType, sourceId, contentText, metadataJson, retrievalCfg) {
    if (!contentText || !retrievalCfg) return;
    _embedQueue.push({ projectId, sourceType, sourceId, contentText, metadataJson, retrievalCfg });
    if (!_embedTimer) _embedTimer = setTimeout(_processEmbedQueue, 500);
}

async function _processEmbedQueue() {
    _embedTimer = null;
    if (_embedQueue.length === 0) return;
    if (_embedDisabled) { _embedQueue = []; return; } // embedding已停用，清空队列
    var batch = _embedQueue.splice(0, Math.min(_embedQueue.length, 10));
    console.log('[Embedding] 批量处理 '+batch.length+' 条');
    for (var i = 0; i < batch.length; i++) {
        var item = batch[i];
        try {
            // 检查是否已有相同source_id的块
            var existing = queryOne('SELECT id, content_text FROM rag_chunks WHERE project_id=? AND source_type=? AND source_id=?', [item.projectId, item.sourceType, item.sourceId]);
            if (existing && existing.content_text === item.contentText) continue; // 内容未变，跳过
            var emb = await _generateEmbedding(item.contentText, item.retrievalCfg);
            if (!emb) continue;
            var blob = vectorToBlob(new Float32Array(emb.vector));
            if (existing) {
                dbRun('UPDATE rag_chunks SET content_text=?, metadata_json=?, embedding_model=?, embedding_dim=?, embedding_blob=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
                    [item.contentText, item.metadataJson, emb.model, emb.dim, blob, existing.id]);
            } else {
                dbRun('INSERT INTO rag_chunks (project_id, source_type, source_id, content_text, metadata_json, embedding_model, embedding_dim, embedding_blob) VALUES (?,?,?,?,?,?,?,?)',
                    [item.projectId, item.sourceType, item.sourceId, item.contentText, item.metadataJson, emb.model, emb.dim, blob]);
            }
            HNSW.insert(item.projectId+':'+item.sourceType+':'+item.sourceId, new Float32Array(emb.vector), item.projectId);
        } catch(e) { console.log('[Embedding] 队列处理异常:', e.message); }
    }
    saveDB();
    if (_embedQueue.length > 0) _embedTimer = setTimeout(_processEmbedQueue, 500);
}

// ===== 压缩层：增量/存量/全量 =====

// 增量更新：检查点提交后追加数据到蓝图
function _incrementalUpdateBlueprint(projectId, checkpointType, checkpointData) {
    broadcastDevLog('info','server','[蓝图] 增量更新开始 类型='+checkpointType+' 数据='+JSON.stringify(checkpointData).substring(0,80));
    var bp = queryOne('SELECT * FROM story_blueprints WHERE project_id=? ORDER BY version DESC LIMIT 1', [projectId]);
    if (!bp) broadcastDevLog('info','server','[蓝图] 项目无蓝图记录 将创建首个版本');
    var blueprint = bp ? safeJsonParse(bp.blueprint_json, _emptyBlueprintObj()) : _emptyBlueprintObj();
    var changed = false;
    switch (checkpointType) {
        case 'character':
            var c = checkpointData;
            if (c.name && blueprint.protagonist.name !== c.name) { blueprint.protagonist.name = c.name; changed = true; }
            if (c.arc && c.arc !== blueprint.protagonist.arc_summary) { blueprint.protagonist.arc_summary = c.arc; changed = true; }
            if (c.traits && c.traits.length) { blueprint.protagonist.key_traits = c.traits; changed = true; }
            if (c.conflict && c.conflict !== blueprint.protagonist.core_conflict) { blueprint.protagonist.core_conflict = c.conflict; changed = true; }
            break;
        case 'worldbuilding':
            var w = checkpointData;
            if (w.power_system && w.power_system !== blueprint.world.power_system) { blueprint.world.power_system = w.power_system; changed = true; }
            if (w.era && w.era !== blueprint.world.era_summary) { blueprint.world.era_summary = w.era; changed = true; }
            if (w.factions && w.factions.length) { blueprint.world.key_factions = w.factions; changed = true; }
            if (w.questions && w.questions.length) { blueprint.world.pending_questions = w.questions; changed = true; }
            break;
        case 'conflict':
            var cf = checkpointData;
            if (cf.main_thread && cf.main_thread !== blueprint.plot.main_thread) { blueprint.plot.main_thread = cf.main_thread; changed = true; }
            if (cf.sub_threads && cf.sub_threads.length) { blueprint.plot.sub_threads = cf.sub_threads; changed = true; }
            break;
        case 'foreshadowing':
            var f = checkpointData;
            if (f.name && f.description) {
                var exists = blueprint.plot.foreshadowing.some(function(x) { return x.name === f.name; });
                if (!exists) { blueprint.plot.foreshadowing.push({ name: f.name, planted: f.planted_chapter || '', payoff: f.payoff_chapter || '', status: 'planted' }); changed = true; }
            }
            break;
    }
    if (changed) { broadcastDevLog('info','server','[压缩] 增量压缩 类型='+checkpointType); _saveCompressedBlueprint(projectId, blueprint, '增量: '+checkpointType, ''); }
    return blueprint;
}

// 存量冲突检测：LLM轻量判定对话与蓝图的矛盾
async function _detectStockConflicts(projectId, recentMessages, userId) {
    var bp = queryOne('SELECT * FROM story_blueprints WHERE project_id=? ORDER BY version DESC LIMIT 1', [projectId]);
    if (!bp) return null;
    var blueprint = safeJsonParse(bp.blueprint_json, {});
    var cfg = _getRetrievalConfig(userId);
    if (!cfg) return null;
    var prompt = '当前设定：\n' + JSON.stringify({ protagonist: blueprint.protagonist, world: blueprint.world, plot: { main_thread: blueprint.plot.main_thread } }) + '\n\n最近对话：\n' + recentMessages + '\n\n检查对话是否有明确推翻或修正已有设定。输出JSON：{"conflicts":[{"field":"路径","old":"旧值","new":"新值","confidence":0.9}]}。无冲突返回{"conflicts":[]}。';
    try {
        var resp = await fetch(cfg.endpoint + '/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.api_key },
            body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, thinking: { type: 'disabled' } })
        });
        if (!resp.ok) return null;
        var data = await resp.json();
        var reply = (data.choices && data.choices[0] && data.choices[0].message) ? data.choices[0].message.content : '';
        var json = safeJsonParse(reply.replace(/```json|```/g, ''), { conflicts: [] });
        return (json.conflicts && json.conflicts.length > 0) ? json : null;
    } catch(e) { console.log('[Compress] 存量检测失败:', e.message); return null; }
}

// 全量压缩：收尾增量+存量 -> 生成摘要 -> 更新蓝图
async function _fullCompressBlueprint(projectId, userId) {
    var bp = queryOne('SELECT * FROM story_blueprints WHERE project_id=? ORDER BY version DESC LIMIT 1', [projectId]);
    var blueprint = bp ? safeJsonParse(bp.blueprint_json, _emptyBlueprintObj()) : _emptyBlueprintObj();
    var msgs = queryAll('SELECT agent_type, role, content FROM agent_conversations WHERE project_id=? ORDER BY created_at DESC LIMIT 20', [projectId]);
    var recentText = '';
    if (msgs) msgs.reverse().forEach(function(m) {
        recentText += (m.role === 'user' ? '用户' : m.agent_type) + '：' + (m.content || '').substring(0, 200) + '\n';
    });
    var cfg = _getRetrievalConfig(userId);
    if (!cfg) { _saveCompressedBlueprint(projectId, blueprint, '结构整理（无LLM）', ''); return blueprint; }
    var prompt = '当前故事蓝图：\n' + JSON.stringify(blueprint, null, 2) + '\n\n最近对话：\n' + recentText + '\n\n请完成：\n1. 将对话中的新信息合并到蓝图（只增不改，不确定加?标记）\n2. 生成compression_summary（50字以内）\n3. 标记已解决的pending_questions\n输出JSON：{"blueprint":{...},"summary":"..."}';
    try {
        var resp = await fetch(cfg.endpoint + '/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.api_key },
            body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], temperature: 0.4, thinking: { type: 'disabled' } })
        });
        if (!resp.ok) throw new Error('LLM HTTP ' + resp.status);
        var data = await resp.json();
        var reply = (data.choices && data.choices[0] && data.choices[0].message) ? data.choices[0].message.content : '';
        var json = safeJsonParse(reply.replace(/```json|```/g, ''), {});
        if (json.blueprint) { _saveCompressedBlueprint(projectId, json.blueprint, json.summary || '全量压缩', ''); return json.blueprint; }
    } catch(e) { console.log('[Compress] 全量压缩失败:', e.message); }
    _saveCompressedBlueprint(projectId, blueprint, '结构整理（降级）', '');
    return blueprint;
}

function _saveCompressedBlueprint(projectId, blueprint, summary, rounds) {
    var latest = queryOne('SELECT version FROM story_blueprints WHERE project_id=? ORDER BY version DESC LIMIT 1', [projectId]);
    var newVersion = (latest ? latest.version : 0) + 1;
    if (newVersion > 3) dbRun('DELETE FROM story_blueprints WHERE project_id=? AND version <= ?', [projectId, newVersion - 3]);
    dbRun('INSERT INTO story_blueprints (project_id, version, blueprint_json, compression_summary, compressed_rounds) VALUES (?,?,?,?,?)',
        [projectId, newVersion, JSON.stringify(blueprint), summary, rounds]);
    saveDB();
    var proj = queryOne('SELECT user_id FROM writing_projects WHERE id=?', [projectId]);
    if (proj) { var ecfg = _getRetrievalConfig(proj.user_id); if (ecfg) _enqueueEmbedding(projectId, 'blueprint', 'latest', JSON.stringify(blueprint), JSON.stringify({ version: newVersion }), ecfg); }
    console.log('[Compress] 蓝图已保存 v' + newVersion + ': ' + summary);
    broadcastDevLog('info','server','[压缩] 版本'+newVersion+' 已完成: '+summary);
}

function _emptyBlueprintObj() {
    return {
        core: { premise: '', genre: '', tone: '', target_platform: '', target_audience: '' },
        protagonist: { name: '', arc_summary: '', current_stage: '', key_traits: [], core_conflict: '' },
        world: { power_system: '', era_summary: '', key_factions: [], pending_questions: [] },
        plot: { main_thread: '', sub_threads: [], foreshadowing: [] },
        outline_progress: { current_volume: 1, current_chapter: 1, chapters_written: 0, next_chapter_hook: '' }
    };
}

// ===== 阶段门控：检查各阶段前置条件 =====
function _checkStagePrerequisites(projectId, stage) {
    var result = { passed: true, missing: [], details: {} };
    var we = queryOne('SELECT COUNT(*) as c FROM world_entities WHERE project_id=?', [projectId]);
    var wr = queryOne('SELECT COUNT(*) as c FROM world_relations WHERE project_id=?', [projectId]);
    var ch = queryOne('SELECT COUNT(*) as c FROM writing_characters WHERE project_id=?', [projectId]);
    var protag = queryOne('SELECT COUNT(*) as c FROM writing_characters WHERE project_id=? AND is_protagonist=1', [projectId]);
    var rels = queryOne('SELECT COUNT(*) as c FROM relationship_edges WHERE project_id=?', [projectId]);
    var vols = queryOne('SELECT COUNT(*) as c FROM writing_volumes WHERE project_id=?', [projectId]);
    var tls = queryOne('SELECT COUNT(*) as c FROM plot_timeline_events WHERE project_id=?', [projectId]);

    result.details = {
        worldEntities: we ? we.c : 0,
        worldRelations: wr ? wr.c : 0,
        characters: ch ? ch.c : 0,
        protagonistConfirmed: protag ? protag.c : 0,
        relationships: rels ? rels.c : 0,
        volumes: vols ? vols.c : 0,
        timelineEvents: tls ? tls.c : 0
    };

    // 根据目标阶段检查
    if (stage === 'worldbuilding' || stage === 'stage2') {
        // 阶段二只需要阶段一完成（需求摘要确认），这里不做硬性检查
        // 主要检查在编排师的行为约束中
    } else if (stage === 'character' || stage === 'stage3') {
        if ((we ? we.c : 0) < 5) { result.missing.push('世界观实体不足5个 | World entities < 5'); }
        if ((wr ? wr.c : 0) < 2) { result.missing.push('世界观关系不足2条 | World relations < 2'); }
    } else if (stage === 'blueprint' || stage === 'stage4') {
        if ((we ? we.c : 0) < 10) { result.missing.push('世界观实体不足10个 | World entities < 10'); }
        if ((ch ? ch.c : 0) < 3) { result.missing.push('角色不足3个 | Characters < 3'); }
        if ((protag ? protag.c : 0) < 1) { result.missing.push('主角未确认 | Protagonist not confirmed'); }
    } else if (stage === 'outline' || stage === 'stage5') {
        if ((we ? we.c : 0) < 10) { result.missing.push('世界观实体不足10个 | World entities < 10'); }
        if ((ch ? ch.c : 0) < 3) { result.missing.push('角色不足3个 | Characters < 3'); }
        if ((protag ? protag.c : 0) < 1) { result.missing.push('主角未确认 | Protagonist not confirmed'); }
        if ((rels ? rels.c : 0) < 5) { result.missing.push('角色关系不足5条 | Relationships < 5'); }
    }

    if (result.missing.length > 0) {
        result.passed = false;
        result.error = '阶段前置条件不满足：' + result.missing.join('；') + ' | Prerequisites not met: ' + result.missing.join('; ');
    }
    return result;
}

// 阶段状态查询端点
app.get('/api/writing-projects/:id/stage-status', auth, (req, res) => {
    var projectId = parseInt(req.params.id);
    var check = _checkStagePrerequisites(projectId, 'stage5'); // 返回全部检查

    // 判断当前所处阶段
    var currentStage = 1;
    if (check.details.worldEntities >= 10 && check.details.worldRelations >= 5) currentStage = 2;
    if (currentStage >= 2 && check.details.characters >= 3 && check.details.protagonistConfirmed >= 1 && check.details.relationships >= 5) currentStage = 3;
    // 阶段四判断需要检查卷蓝图是否存在（story_blueprints.plot）
    var bp = queryOne('SELECT blueprint_json FROM story_blueprints WHERE project_id=? ORDER BY version DESC LIMIT 1', [projectId]);
    if (currentStage >= 3 && bp) {
        try {
            var bpJson = JSON.parse(bp.blueprint_json || '{}');
            if (bpJson.plot && bpJson.plot.main_thread && bpJson.plot.main_thread.length > 10) currentStage = 4;
        } catch(e) {}
    }
    if (currentStage >= 4 && check.details.volumes > 0 && check.details.timelineEvents > 0) currentStage = 5;

    res.json({
        currentStage: currentStage,
        stageName: ['需求采访','世界观构建','角色设计','卷蓝图规划','大纲生成'][currentStage - 1] || '未知',
        prerequisites: check,
        details: check.details
    });

    broadcastDevLog('info','server',
        '[StageCheck] 项目='+projectId+' 当前阶段='+currentStage+'/'+['需求采访','世界观构建','角色设计','卷蓝图规划','大纲生成'][currentStage-1]+
        ' | Stage='+currentStage+' entities='+check.details.worldEntities+' chars='+check.details.characters+' protag='+check.details.protagonistConfirmed
    );
});

// ===== 组装层：上下文拼接 =====
// 将蓝图+项目摘要+RAG检索+结构化数据组装为系统提示词追加内容
async function _buildAssembledContext(projectId, userId, userQuery, mode) {
    var parts = [];
    // 1. 项目进度摘要（始终包含）
    var summary = _buildProjectSummary(projectId, userId);
    if (summary) parts.push(summary);
    // 2. 故事蓝图摘要
    var bp = queryOne('SELECT * FROM story_blueprints WHERE project_id=? ORDER BY version DESC LIMIT 1', [projectId]);
    if (bp) {
        var blueprint = safeJsonParse(bp.blueprint_json, {});
        var bpSummary = _buildBlueprintSummary(blueprint);
        if (bpSummary) parts.push('## 故事蓝图\n' + bpSummary);
    }
    // 2.5 世界观结构化数据（从world_entities/world_relations读取，始终注入）
    var weCount = queryOne('SELECT COUNT(*) as c FROM world_entities WHERE project_id=?', [projectId]);
    if (weCount && weCount.c > 0) {
        var entities = queryAll('SELECT id, name, type, description, parent_id FROM world_entities WHERE project_id=? ORDER BY id', [projectId]);
        var weText = '## 世界观实体（共'+weCount.c+'个）\n';
        // 按类型分组汇总
        var typeGroups = {};
        entities.forEach(function(e) {
            var t = e.type || '其他';
            if (!typeGroups[t]) typeGroups[t] = [];
            typeGroups[t].push(e.name + (e.description ? '：'+e.description.substring(0,60) : ''));
        });
        Object.keys(typeGroups).forEach(function(t) {
            var items = typeGroups[t];
            weText += '- ' + t + '：' + items.slice(0, 8).join('、');
            if (items.length > 8) weText += ' ...等'+items.length+'个';
            weText += '\n';
        });
        // 关系摘要
        var wrCount = queryOne('SELECT COUNT(*) as c FROM world_relations WHERE project_id=?', [projectId]);
        if (wrCount && wrCount.c > 0) {
            var rels = queryAll('SELECT fe.name as fn, te.name as tn, wr.relation_type FROM world_relations wr LEFT JOIN world_entities fe ON wr.from_entity_id=fe.id LEFT JOIN world_entities te ON wr.to_entity_id=te.id WHERE wr.project_id=?', [projectId]);
            weText += '- 关系（'+wrCount.c+'条）：';
            rels.slice(0, 5).forEach(function(r) {
                weText += (r.fn||'?') + '→' + (r.relation_type||'关联') + '→' + (r.tn||'?') + '；';
            });
            if (rels.length > 5) weText += '等';
            weText += '\n';
        }
        parts.push(weText);
    }
    // 2.6 角色数据（从writing_characters读取，标记主角）
    var charCount = queryOne('SELECT COUNT(*) as c FROM writing_characters WHERE project_id=?', [projectId]);
    if (charCount && charCount.c > 0) {
        var chars = queryAll('SELECT id, name, is_protagonist, profile_json FROM writing_characters WHERE project_id=?', [projectId]);
        var charText = '## 角色列表（共'+charCount.c+'个）\n';
        chars.forEach(function(c) {
            var pf = {};
            try { pf = JSON.parse(c.profile_json || '{}'); } catch(e) {}
            var role = c.is_protagonist === 1 ? '★主角' : (pf.角色类型 || '角色');
            charText += '- ' + role + '：' + c.name;
            if (pf.性格) charText += '（'+pf.性格.substring(0,30)+'）';
            if (pf.能力) charText += ' 能力：'+pf.能力.substring(0,30);
            charText += '\n';
        });
        parts.push(charText);
    }
    // 2.7 时间线事件摘要
    var tlCount = queryOne('SELECT COUNT(*) as c FROM plot_timeline_events WHERE project_id=?', [projectId]);
    if (tlCount && tlCount.c > 0) {
        var tls = queryAll('SELECT event_name, absolute_year, event_type FROM plot_timeline_events WHERE project_id=? ORDER BY absolute_year ASC LIMIT 10', [projectId]);
        var tlText = '## 时间线（共'+tlCount.c+'个事件）\n';
        tls.forEach(function(e) {
            tlText += '- ' + (e.absolute_year!=null?e.absolute_year+'年 ':'') + '[' + (e.event_type||'事件') + '] ' + e.event_name + '\n';
        });
        parts.push(tlText);
    }
    // 3. RAG检索（日常模式轻量，检查点模式全量）
    var searchK = mode === 'checkpoint' ? 8 : 3;
    if (userQuery && userQuery.length > 2) {
        var retrievalCfg = _getRetrievalConfig(userId);
        if (retrievalCfg) {
            try {
                var searchResults = await _searchWithFallback(projectId, userQuery, searchK, null, retrievalCfg);
                if (searchResults.results && searchResults.results.length > 0) {
                    var ragText = '## 相关上下文参考\n';
                    searchResults.results.forEach(function(r) {
                        ragText += '- [' + r.source_type + '] ' + r.content.substring(0, 150) + '\n';
                    });
                    if (ragText.length > 30) parts.push(ragText);
                }
            } catch(e) { console.log('[Assembly] RAG检索跳过:', e.message); }
        }
    }
    // 4. 当前引导方案（如有）
    var proj = queryOne('SELECT metadata FROM writing_projects WHERE id=?', [projectId]);
    if (proj) {
        var meta = safeJsonParse(proj.metadata, {});
        if (meta.approach) parts.push('## 当前引导方案\n使用「' + meta.approach + '」模式');
    }
    var result = parts.join('\n\n');
    if (result) broadcastDevLog('info','server','[组装] 上下文拼接完成 片段数='+parts.length+' 模式='+mode+' 内容长度='+result.length);
    return result;
}

// 蓝图 → 可读摘要文本
function _buildBlueprintSummary(blueprint) {
    if (!blueprint || !blueprint.core) return '';
    var lines = [];
    var c = blueprint.core;
    if (c.premise) lines.push('- 梗概：' + c.premise);
    if (c.genre) lines.push('- 题材：' + c.genre + (c.tone ? '（' + c.tone + '）' : ''));
    if (c.target_platform) lines.push('- 目标平台：' + c.target_platform);
    var p = blueprint.protagonist;
    if (p && p.name) lines.push('- 主角：' + p.name + (p.current_stage ? '（' + p.current_stage + '）' : '') + (p.core_conflict ? ' → ' + p.core_conflict : ''));
    var w = blueprint.world;
    if (w && w.power_system) lines.push('- 力量体系：' + w.power_system);
    if (w && w.key_factions && w.key_factions.length) lines.push('- 势力：' + w.key_factions.join('、'));
    var pl = blueprint.plot;
    if (pl && pl.main_thread) lines.push('- 主线：' + pl.main_thread);
    if (pl && pl.foreshadowing && pl.foreshadowing.length) lines.push('- 伏笔：' + pl.foreshadowing.map(function(f){ return f.name; }).join('、'));
    return lines.length > 0 ? lines.join('\n') : '';
}

function callOutlineLLM(projectId, userId, systemPrompt, userContent, agentType, req, callback, streamCallback, tools, skipDbSave) {
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
            console.log('[Writing '+agentType+'] 非流式完成 回复='+reply.length+' 思考='+thinking.length+' tokens in='+tokIn+' out='+tokOut+(skipDbSave?' (skipDbSave)':''));
            if (!skipDbSave) dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content, thinking, token_used) VALUES (?,?,?,?,?,?)', [projectId, agentType, 'assistant', reply, thinking, tokIn+tokOut]);
            _logTokenUsage(userId, projectId, agentType, model, tokIn, tokOut, tokCache);
            saveDB();
            callback({ content:reply, thinking:thinking, token_in:tokIn, token_out:tokOut });
        });
        // 流式模式
        var reader = r.body.getReader();
        var decoder = new TextDecoder();
        var buf = '', fullContent = '', fullThinking = '', tokIn = 0, tokOut = 0, tokCache = 0;
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
                    _logTokenUsage(userId, projectId, agentType, model, tokIn, tokOut, tokCache);
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
                        if (parsed.usage) { tokIn = parsed.usage.prompt_tokens || 0; tokOut = parsed.usage.completion_tokens || 0; tokCache = (parsed.usage.prompt_tokens_details && parsed.usage.prompt_tokens_details.cached_tokens) || 0; }
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
    var rows = queryAll('SELECT input_tokens, output_tokens, cache_tokens, cost_input, cost_output, cost_cache, model FROM token_usage_logs WHERE project_id=? AND created_at>=?', [req.params.id, today]);
    var totalIn = 0, totalOut = 0, totalCache = 0, totalCostIn = 0, totalCostOut = 0, totalCostCache = 0;
    var models = {};
    if (rows) rows.forEach(function(r) {
        totalIn += r.input_tokens || 0;
        totalOut += r.output_tokens || 0;
        totalCache += r.cache_tokens || 0;
        totalCostIn += r.cost_input || 0;
        totalCostOut += r.cost_output || 0;
        totalCostCache += r.cost_cache || 0;
        if (r.model) models[r.model] = (models[r.model] || 0) + 1;
    });
    var totalTokens = totalIn + totalOut;
    var totalCost = totalCostIn + totalCostOut + totalCostCache;
    var mainModel = Object.keys(models).sort(function(a,b){ return models[b] - models[a]; })[0] || '';
    // 累计所有时间的token
    var allTime = queryOne('SELECT SUM(input_tokens+output_tokens) as total FROM token_usage_logs WHERE project_id=?', [req.params.id]);
    res.json({
        today: totalTokens, todayIn: totalIn, todayOut: totalOut, todayCache: totalCache,
        cost: totalCost, costIn: totalCostIn, costOut: totalCostOut, costCache: totalCostCache,
        model: mainModel, allTime: (allTime && allTime.total) || 0
    });
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
    if (s && s.api_key) s.api_key = '***';  // 不返回完整密钥
    res.json(s || { api_key:'', api_url:'https://api.yijiarj.cn/v1/chat/completions', model:'image2', default_size:'9:16', request_interval:3 });
});

app.put('/api/image-gen-settings', auth, (req, res) => {
    const { api_key, api_url, model, default_size, request_interval } = req.body;
    const existing = queryOne('SELECT * FROM image_gen_settings WHERE user_id=?', [req.userId]);
    var fields = [], params = [];
    if (api_key !== undefined && api_key !== '***') { fields.push('api_key=?'); params.push(api_key); }
    if (api_url !== undefined) { fields.push('api_url=?'); params.push(api_url); }
    if (model !== undefined) { fields.push('model=?'); params.push(model); }
    if (default_size !== undefined) { fields.push('default_size=?'); params.push(default_size); }
    if (request_interval !== undefined) { fields.push('request_interval=?'); params.push(request_interval); }
    if (existing) {
        if (fields.length) {
            params.push(req.userId);
            dbRun('UPDATE image_gen_settings SET '+fields.join(',')+' WHERE user_id=?', params);
        }
    } else {
        dbRun('INSERT INTO image_gen_settings (user_id, api_key, api_url, model, default_size, request_interval) VALUES (?,?,?,?,?,?)',
            [req.userId, api_key||'', api_url||'', model||'image2', default_size||'9:16', request_interval||3]);
    }
    res.json({ ok: true });
});

// ==================== 系统配置 API（密钥管理，数据不入git） ====================

app.get('/api/system-config', auth, (req, res) => {
    var rows = queryAll('SELECT key, value FROM system_config');
    var cfg = {};
    rows.forEach(function(r) {
        // 密钥类配置返回遮盖值
        if (r.key === 'JWT_SECRET' || r.key === 'PADDLEOCR_TOKEN') {
            cfg[r.key] = r.value ? '***' : '';
        } else {
            cfg[r.key] = r.value;
        }
    });
    // 补充前端需要的默认字段
    if (!cfg.PADDLEOCR_TOKEN) cfg.PADDLEOCR_TOKEN = '';
    res.json(cfg);
});

app.put('/api/system-config', auth, (req, res) => {
    var { PADDLEOCR_TOKEN } = req.body;
    if (PADDLEOCR_TOKEN !== undefined && PADDLEOCR_TOKEN !== '***') {
        setSysConfig('PADDLEOCR_TOKEN', PADDLEOCR_TOKEN);
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
    db.run('CREATE TABLE IF NOT EXISTS writing_characters (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL, aliases TEXT DEFAULT \'\', profile_json TEXT DEFAULT \'{}\', canvas_node_ids TEXT DEFAULT \'[]\', avatar_url TEXT DEFAULT \'\', status TEXT DEFAULT \'active\', is_protagonist INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS writing_scenes (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT \'\', atmosphere TEXT DEFAULT \'\', canvas_node_ids TEXT DEFAULT \'[]\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS writing_props (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT \'\', canvas_node_ids TEXT DEFAULT \'[]\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS character_memories (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, character_id INTEGER, memory_type TEXT DEFAULT \'base_profile\', content TEXT DEFAULT \'\', importance INTEGER DEFAULT 3, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, expires_at TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS relationship_edges (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, from_character_id INTEGER, to_character_id INTEGER, relation_type TEXT DEFAULT \'custom\', description TEXT DEFAULT \'\', intensity INTEGER DEFAULT 5, status TEXT DEFAULT \'active\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS plot_timeline_events (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, event_name TEXT NOT NULL, summary TEXT DEFAULT \'\', character_ids TEXT DEFAULT \'[]\', chapter_id INTEGER, order_index REAL DEFAULT 0, branch_name TEXT DEFAULT \'main\', event_type TEXT DEFAULT \'minor\', absolute_year REAL DEFAULT NULL, era_name TEXT DEFAULT \'\', faction_calendars TEXT DEFAULT \'{}\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS foreshadowing (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT \'\', status TEXT DEFAULT \'planted\', plant_chapter_id INTEGER, resolve_chapter_id INTEGER, notes TEXT DEFAULT \'\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS writing_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, branch_name TEXT DEFAULT \'main\', parent_version_id INTEGER, snapshot_json TEXT NOT NULL, message TEXT DEFAULT \'\', commit_type TEXT DEFAULT \'manual\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS writing_merge_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, source_branch TEXT, target_branch TEXT, conflicts_json TEXT DEFAULT \'[]\', resolution_json TEXT DEFAULT \'{}\', status TEXT DEFAULT \'pending\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT)');
    // 世界观实体表（树形层级：势力/地点/力量体系/物种/人物等）
    db.run('CREATE TABLE IF NOT EXISTS world_entities (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL, type TEXT DEFAULT \'\', description TEXT DEFAULT \'\', parent_id INTEGER DEFAULT NULL, metadata_json TEXT DEFAULT \'{}\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    // 世界观关系表（实体间关系：敌对/同盟/从属等）
    db.run('CREATE TABLE IF NOT EXISTS world_relations (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, from_entity_id INTEGER NOT NULL, to_entity_id INTEGER NOT NULL, relation_type TEXT DEFAULT \'\', description TEXT DEFAULT \'\', intensity INTEGER DEFAULT 5, metadata_json TEXT DEFAULT \'{}\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS user_behavior_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, project_id INTEGER, action_type TEXT NOT NULL, target_type TEXT, target_id INTEGER, before_data TEXT, after_data TEXT, metadata TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS chapter_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, chapter_id INTEGER NOT NULL, content_text TEXT DEFAULT \'\', word_count INTEGER DEFAULT 0, save_type TEXT DEFAULT \'manual\', label TEXT DEFAULT \'\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS writing_quality_ratings (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, chapter_id INTEGER, user_rating INTEGER, edit_distance_ratio REAL, ai_similarity_score REAL, agent_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS optimized_skills (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name_cn TEXT NOT NULL, name_en TEXT DEFAULT \'\', description TEXT DEFAULT \'\', content TEXT NOT NULL, json_schema TEXT DEFAULT \'\', source TEXT DEFAULT \'auto_generated\', is_enabled INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS user_tools (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, skill_id INTEGER, name TEXT NOT NULL, description TEXT DEFAULT \'\', parameters_json TEXT DEFAULT \'{}\', is_enabled INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE TABLE IF NOT EXISTS agent_crawler_data (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, platform TEXT DEFAULT \'\', book_name TEXT NOT NULL, author TEXT DEFAULT \'\', cover_url TEXT DEFAULT \'\', intro TEXT DEFAULT \'\', tags TEXT DEFAULT \'[]\', status TEXT DEFAULT \'pending\', source TEXT DEFAULT \'llm\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    // 迁移：给旧表加 source 列（如果不存在）
    try { db.run('ALTER TABLE agent_crawler_data ADD COLUMN source TEXT DEFAULT \'llm\''); } catch(e) {}
    // 迁移：创建去重唯一索引（如果不存在）
    try { db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_crawler_unique ON agent_crawler_data (project_id, platform, book_name)'); } catch(e) {}

    // 系统配置表（存储密钥、Token等敏感配置，不入git）
    db.run('CREATE TABLE IF NOT EXISTS system_config (key TEXT PRIMARY KEY, value TEXT DEFAULT \'\')');

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
                var inserted2 = 0;
                books['书籍'].forEach(function(b) {
                    try {
                        dbRun('INSERT INTO agent_crawler_data (project_id, platform, book_name, author, cover_url, intro, tags, status, source) VALUES (?,?,?,?,?,?,?,?,?)',
                            [projectId, platform||'', b['书名']||'', b['作者']||'', b['封面']||'', b['简介']||'', JSON.stringify(b['标签']||[]), 'pending', 'web']);
                        inserted2++;
                    } catch(e) { if (e.message && e.message.indexOf('UNIQUE')>=0) console.log('[Writing 爬虫] 重复跳过: '+b['书名']); else console.error('[Writing 爬虫] 插入失败:', e.message); }
                });
                if (inserted2 > 0) saveDB();
                console.log('[Writing 爬虫] 解析到 '+inserted2+' 本书');
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
var REVIEWER_SYSTEM = loadPrompt('reviewer.md');

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
        // 遮盖 api_key，不返回完整密钥到前端
        configs.forEach(function(c) { if (c.api_key) c.api_key = '***'; });
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
            if (api_key !== undefined && api_key !== '***') { sets.push('api_key=?'); params.push(api_key); }
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
    // 用户级配置（key-value，按user_id隔离）
    db.run('CREATE TABLE IF NOT EXISTS user_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT DEFAULT \'\', updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, key))');
    // RAG分块存储（含embedding向量BLOB，按project_id隔离）
    db.run('CREATE TABLE IF NOT EXISTS rag_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL, content_text TEXT DEFAULT \'\', metadata_json TEXT DEFAULT \'{}\', embedding_model TEXT DEFAULT \'\', embedding_dim INTEGER DEFAULT 0, embedding_blob BLOB, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(project_id, source_type, source_id))');
    db.run('CREATE INDEX IF NOT EXISTS idx_rag_chunks_project ON rag_chunks(project_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_rag_chunks_type ON rag_chunks(project_id, source_type)');
    // 故事蓝图版本历史
    db.run('CREATE TABLE IF NOT EXISTS story_blueprints (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, version INTEGER DEFAULT 1, blueprint_json TEXT DEFAULT \'{}\', compression_summary TEXT DEFAULT \'\', compressed_rounds TEXT DEFAULT \'\', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.run('CREATE INDEX IF NOT EXISTS idx_blueprints_project ON story_blueprints(project_id, version DESC)');

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
    // 阶段一：写作模块骨架——项目metadata + 检索配置 + 用户设置
    try { db.run('ALTER TABLE writing_projects ADD COLUMN metadata TEXT DEFAULT \'{}\''); } catch(e) {}
    try { db.run('ALTER TABLE writing_agent_config ADD COLUMN retrieval_model TEXT DEFAULT \'\''); } catch(e) {}
    try { db.run('ALTER TABLE writing_agent_config ADD COLUMN retrieval_endpoint TEXT DEFAULT \'\''); } catch(e) {}
    try { db.run('ALTER TABLE writing_agent_config ADD COLUMN retrieval_api_key TEXT DEFAULT \'\''); } catch(e) {}
    try { db.run('ALTER TABLE token_usage_logs ADD COLUMN cache_tokens INTEGER DEFAULT 0'); } catch(e) {}
    try { db.run('ALTER TABLE token_usage_logs ADD COLUMN cost_cache REAL DEFAULT 0.0'); } catch(e) {}
    // 阶段二：数据基建——写作模块字段扩展
    try { db.run('ALTER TABLE writing_characters ADD COLUMN is_protagonist INTEGER DEFAULT 0'); } catch(e) {}
    try { db.run('ALTER TABLE plot_timeline_events ADD COLUMN absolute_year REAL DEFAULT NULL'); } catch(e) {}
    try { db.run('ALTER TABLE plot_timeline_events ADD COLUMN era_name TEXT DEFAULT \'\''); } catch(e) {}
    try { db.run('ALTER TABLE plot_timeline_events ADD COLUMN faction_calendars TEXT DEFAULT \'{}\''); } catch(e) {}
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

    // 从 DB 加载 JWT_SECRET，保持向后兼容
    var OLD_JWT_DEFAULT = 'infinite-canvas-local-secret-key-2024';
    var dbSecret = queryOne('SELECT value FROM system_config WHERE key=?', ['JWT_SECRET']);
    if (dbSecret && dbSecret.value) {
        // DB 中已有（优先）
        if (!JWT_SECRET) JWT_SECRET = dbSecret.value;
        console.log('  🔐 JWT_SECRET 已从数据库加载');
    } else if (!JWT_SECRET) {
        // DB 中无，且环境变量也未设置 → 首次启动，用旧默认值迁移，保持已有Token有效
        JWT_SECRET = OLD_JWT_DEFAULT;
        dbRun('INSERT OR REPLACE INTO system_config (key, value) VALUES (?,?)', ['JWT_SECRET', JWT_SECRET]);
        saveDB();
        console.log('  🔐 JWT_SECRET 已迁移到数据库（兼容旧Token）');
    }

    // 初始化HNSW向量索引（从DB加载已有chunks）
    try {
        var allChunks = queryAll('SELECT source_type, source_id, embedding_blob, embedding_dim, project_id FROM rag_chunks WHERE embedding_blob IS NOT NULL');
        HNSW.init(allChunks || []);
        console.log('  🧠 HNSW索引已初始化 节点数=' + HNSW.stats().nodeCount);
    } catch(e) { console.log('  ⚠️ HNSW初始化失败:', e.message); }

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
        // 显示字体解码模式
        var dbOcrToken = getSysConfig('PADDLEOCR_TOKEN');
        var ocrToken = dbOcrToken || process.env.PADDLEOCR_TOKEN || '';
        if (ocrToken) {
            console.log('  🔍 字体解码: PaddleOCR 模式（高精度）' + (dbOcrToken ? ' [DB]' : ' [ENV]'));
        } else {
            console.log('  🔍 字体解码: 本地 phash 像素比对（兜底模式）');
        }
        console.log('');
    });
}

start().catch(err => { console.error('启动失败:', err); process.exit(1); });
