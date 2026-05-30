import re

with open(r'd:\工作文件夹\AI动漫制作\科研文件夹\新-无限画布本地部署\server.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Add detailed logging to key functions

# 1. Blueprint GET - add broadcastDevLog
old_bp_get = 'res.json(bp ? { version: bp.version, blueprint: safeJsonParse(bp.blueprint_json, {}), summary: bp.compression_summary, created_at: bp.created_at } : { version: 0, blueprint: _emptyBlueprint(), summary: \'\' });'
new_bp_get = '''var bpResult = bp ? { version: bp.version, blueprint: safeJsonParse(bp.blueprint_json, {}), summary: bp.compression_summary, created_at: bp.created_at } : { version: 0, blueprint: _emptyBlueprint(), summary: '' };
    broadcastDevLog('info','server','[Blueprint] GET v'+bpResult.version+(bp?' hasData':' empty'));
    res.json(bpResult);'''
if old_bp_get in content:
    content = content.replace(old_bp_get, new_bp_get)
    print('1. Blueprint GET log added')
else:
    print('1. Blueprint GET: pattern not found')

# 2. Checkpoint create - add broadcastDevLog
old_cp_create = "var msgId = dbRun('INSERT INTO agent_conversations (project_id, agent_type, role, content, metadata) VALUES (?,?,?,?,?)',"
if old_cp_create in content:
    idx = content.find(old_cp_create)
    # Find the res.json after this
    res_idx = content.find('res.json({ ok: true, msg_id: msgId });', idx)
    if res_idx >= 0:
        old_json = 'res.json({ ok: true, msg_id: msgId });'
        new_json = "broadcastDevLog('info','server','[Checkpoint] create type='+checkpoint_type+' msgId='+msgId);\n    res.json({ ok: true, msg_id: msgId });"
        content = content.replace(old_json, new_json)
        print('2. Checkpoint create log added')
    else:
        print('2. Checkpoint create: res.json not found')
else:
    print('2. Checkpoint create: insert not found')

# 3. Checkpoint commit - add broadcastDevLog
old_cp_commit = "dbRun('UPDATE agent_conversations SET metadata=? WHERE id=?', [JSON.stringify(meta), msgId]);"
if old_cp_commit in content:
    new_cp_commit = "dbRun('UPDATE agent_conversations SET metadata=? WHERE id=?', [JSON.stringify(meta), msgId]);\n    broadcastDevLog('info','server','[Checkpoint] commit type='+meta.checkpoint_type+' msgId='+msgId);"
    content = content.replace(old_cp_commit, new_cp_commit)
    print('3. Checkpoint commit log added')
else:
    print('3. Checkpoint commit: not found')

# 4. Compression functions - add logging
old_full_compress = "console.log('[Compress] 蓝图已保存 v' + newVersion + ': ' + summary);"
if old_full_compress in content:
    new_full_compress = "console.log('[Compress] 蓝图已保存 v' + newVersion + ': ' + summary);\n    broadcastDevLog('info','server','[Compress] v'+newVersion+': '+summary);"
    content = content.replace(old_full_compress, new_full_compress)
    print('4. Full compress log added')
else:
    print('4. Full compress: not found')

# 5. Incremental update - add logging
old_inc = "if (changed) _saveCompressedBlueprint(projectId, blueprint, '增量: '+checkpointType, '');"
if old_inc in content:
    new_inc = "if (changed) { broadcastDevLog('info','server','[Compress] incremental '+checkpointType); _saveCompressedBlueprint(projectId, blueprint, '增量: '+checkpointType, ''); }"
    content = content.replace(old_inc, new_inc)
    print('5. Incremental update log added')
else:
    print('5. Incremental: not found')

# 6. Assembled context - add logging
old_asm = "return parts.join('\\n\\n');"
idx_asm = content.rfind(old_asm, 0, content.find('function callOutlineLLM'))
if idx_asm >= 0:
    new_asm = "var result = parts.join('\\n\\n');\n    if (result) broadcastDevLog('info','server','[Assembly] context parts='+parts.length+' mode='+mode);\n    return result;"
    content = content[:idx_asm] + new_asm + content[idx_asm + len(old_asm):]
    print('6. Assembly log added')
else:
    print('6. Assembly: not found')

# 7. Token usage logging
old_tok = "dbRun('INSERT INTO token_usage_logs (user_id, project_id, agent_type, model, input_tokens, output_tokens, cache_tokens, cost_input, cost_output, cost_cache) VALUES (?,?,?,?,?,?,?,?,?,?)',"
if old_tok in content:
    idx = content.find(old_tok)
    # Add log AFTER the insert
    end_idx = content.find('saveDB();', idx)
    if end_idx >= 0:
        old_save = 'saveDB();'
        new_save = "broadcastDevLog('info','server','[Token] '+agentType+' in='+tokIn+' out='+tokOut+(tokCache?' cache='+tokCache:'')+' cost='+(costInput+costOutput+costCache).toFixed(4));\n    saveDB();"
        # Only replace the one after _logTokenUsage
        content = content[:end_idx] + new_save + content[end_idx + len(old_save):]
        print('7. Token log added')
else:
    print('7. Token: not found')

with open(r'd:\工作文件夹\AI动漫制作\科研文件夹\新-无限画布本地部署\server.js', 'w', encoding='utf-8') as f:
    f.write(content)
print('\nAll done')
