import sys
sys.stdout.reconfigure(encoding='utf-8')

# Fix hnsw_index.js
with open(r'd:\工作文件夹\AI动漫制作\科研文件夹\新-无限画布本地部署\hnsw_index.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix 1: _searchLayer initial candidate missing id
old1 = 'var candidates = [{ index: entryIdx, dist: _cosineDist(query, HNSW.nodes[entryIdx].vector) }];'
new1 = 'var entryNode = HNSW.nodes[entryIdx]; var candidates = [{ index: entryIdx, id: entryNode.id, dist: _cosineDist(query, entryNode.vector) }];'
content = content.replace(old1, new1)

# Fix 2: Add projectId to insert
old2 = '  insert(id, vector) {'
new2 = '  insert(id, vector, projectId) {\n    projectId = projectId || 0;'
content = content.replace(old2, new2)

# Fix 3: Add projectId to node
old3 = 'var node = { id: id, vector: vector, level: level, neighbors: [] };'
new3 = 'var node = { id: id, vector: vector, level: level, neighbors: [], projectId: projectId };'
content = content.replace(old3, new3)

# Fix 4: Add projectId to search
old4 = '  search(queryVec, k) {'
new4 = '  search(queryVec, k, projectId) {\n    projectId = projectId || 0;'
content = content.replace(old4, new4)

# Fix 5: Filter results by projectId in search
old5 = 'return _searchLayer(queryVec, ep, this.efSearch, 0).slice(0, k);'
new5 = 'var layerResults = _searchLayer(queryVec, ep, this.efSearch, 0);\n    if (projectId > 0) layerResults = layerResults.filter(function(r) { return HNSW.nodes[r.index].projectId === projectId || HNSW.nodes[r.index].projectId === undefined; });\n    return layerResults.slice(0, k);'
content = content.replace(old5, new5)

with open(r'd:\工作文件夹\AI动漫制作\科研文件夹\新-无限画布本地部署\hnsw_index.js', 'w', encoding='utf-8') as f:
    f.write(content)
print('hnsw_index.js fixes done')

# Fix server.js BM25 IDF
with open(r'd:\工作文件夹\AI动漫制作\科研文件夹\新-无限画布本地部署\server.js', 'r', encoding='utf-8') as f:
    scontent = f.read()

old_bm25 = '''function _bm25Search(projectId, keywords, sourceTypes, k) {
    var results = [];
    var chunks = queryAll('SELECT * FROM rag_chunks WHERE project_id=?', [projectId]);
    if (!chunks) return results;
    chunks.forEach(function(c) {
        if (sourceTypes && sourceTypes.indexOf(c.source_type) < 0) return;
        var score = 0;
        var text = c.content_text || '';
        keywords.forEach(function(kw) {
            var count = (text.match(new RegExp(kw.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&'),'g')) || []).length;
            if (count > 0) score += count * Math.log(1 + chunks.length / Math.max(1, count));
        });
        if (score > 0) results.push({ chunk_id: c.id, score: score, method: 'bm25' });
    });
    results.sort(function(a, b) { return b.score - a.score; });
    return results.slice(0, k);
}'''

new_bm25 = '''function _bm25Search(projectId, keywords, sourceTypes, k) {
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
            var tf = (text.match(new RegExp(kw.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&'),'g')) || []).length;
            var df = docFreq[kw] || 1;
            var idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1);
            score += tf * idf;
        });
        if (score > 0) results.push({ chunk_id: c.id, score: score, method: 'bm25' });
    });
    results.sort(function(a, b) { return b.score - a.score; });
    return results.slice(0, k);
}'''

scontent = scontent.replace(old_bm25, new_bm25)

with open(r'd:\工作文件夹\AI动漫制作\科研文件夹\新-无限画布本地部署\server.js', 'w', encoding='utf-8') as f:
    f.write(scontent)
print('server.js BM25 fix done')
