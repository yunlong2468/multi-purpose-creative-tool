with open(r'd:\工作文件夹\AI动漫制作\科研文件夹\新-无限画布本地部署\server.js', 'r', encoding='utf-8') as f:
    content = f.read()

marker = 'function callOutlineLLM(projectId, userId, systemPrompt, userContent, agentType, req, callback, streamCallback, tools, skipDbSave)'
idx = content.find(marker)
if idx < 0:
    print('NOT FOUND')
    exit()

new_code = '''// ===== 压缩层：增量/存量/全量 =====

// 增量更新：检查点提交后追加数据到蓝图
function _incrementalUpdateBlueprint(projectId, checkpointType, checkpointData) {
    var bp = queryOne('SELECT * FROM story_blueprints WHERE project_id=? ORDER BY version DESC LIMIT 1', [projectId]);
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
    if (changed) _saveCompressedBlueprint(projectId, blueprint, '增量: '+checkpointType, '');
    return blueprint;
}

// 全量压缩：收尾增量+存量 -> 生成摘要 -> 更新蓝图
async function _fullCompressBlueprint(projectId, userId) {
    var bp = queryOne('SELECT * FROM story_blueprints WHERE project_id=? ORDER BY version DESC LIMIT 1', [projectId]);
    var blueprint = bp ? safeJsonParse(bp.blueprint_json, _emptyBlueprintObj()) : _emptyBlueprintObj();
    var msgs = queryAll('SELECT agent_type, role, content FROM agent_conversations WHERE project_id=? ORDER BY created_at DESC LIMIT 20', [projectId]);
    var recentText = '';
    if (msgs) msgs.reverse().forEach(function(m) {
        recentText += (m.role === 'user' ? '用户' : m.agent_type) + '：' + (m.content || '').substring(0, 200) + '\\n';
    });
    var cfg = _getRetrievalConfig(userId);
    if (!cfg) { _saveCompressedBlueprint(projectId, blueprint, '结构整理（无LLM）', ''); return blueprint; }
    var prompt = '当前故事蓝图：\\n' + JSON.stringify(blueprint, null, 2) + '\\n\\n最近对话：\\n' + recentText + '\\n\\n请完成：\\n1. 将对话中的新信息合并到蓝图（只增不改，不确定加?标记）\\n2. 生成compression_summary（50字以内）\\n3. 标记已解决的pending_questions\\n输出JSON：{"blueprint":{...},"summary":"..."}';
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

'''

content = content[:idx] + new_code + content[idx:]
with open(r'd:\工作文件夹\AI动漫制作\科研文件夹\新-无限画布本地部署\server.js', 'w', encoding='utf-8') as f:
    f.write(content)
print('DONE: Inserted compression functions')
