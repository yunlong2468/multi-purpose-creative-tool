# 写作模块 — 调配师五阶段工作流详细实现计划

**日期**: 2026-05-30
**状态**: 计划阶段，待用户确认

---

## 总览：五阶段模型

```
阶段一        阶段二        阶段三        阶段四        阶段五
需求采访  →  世界观构建  →  角色设计  →  卷蓝图规划  →  大纲生成
(已有基础)    (需加强)      (需加强)      (全新)        (全新)
```

**核心原则**：
- 每个阶段的产出是下一阶段的输入
- 不能跳步（编排师需检查前置条件）
- 每个阶段完成后用户需确认
- 所有结构化数据可在浮动画布中预览
- **每次只问一个问题**：避免干扰用户思考，一个问题得到明确回答后再问下一个
- **开发者日志**：所有服务端关键操作输出双语调试日志（中文 | English）

---

## 阶段一：需求采访（已有基础，需要细化）

### 输入
- 用户的初始消息（可能是零散的灵感、一句话需求、或详细设定）

### 编排师行为
1. **每次只问一个问题**，得到明确回答后再问下一个。绝不一次性抛出多个问题。
2. 逐一询问以下信息（按优先级排序）：
   - **第1问**：小说类型和细分方向（玄幻/都市/科幻/仙侠/武侠/悬疑/言情/历史/同人/混合 + 系统流/凡人流/重生流/穿越/无限流/种田/...）
   - **第2问**：目标字数。限于100万字以内（短篇3万/中篇20万/长篇50万/100万）。因为项目目前没有实现稳定的长篇产出能力，限定范围降低复杂度。
   - **第3问**：目标读者平台。注意：目前只支持爬取**番茄小说**作为参考数据源。
   - **第4问**：每章预期最低字数。向用户说明各平台的计费规则——不足整千字按整千字的低一档计算（例如2900字按2000字档次计费，1999字按1000字计费），因此每章建议比目标字数多写一些（如目标3000字→建议实际写3100-3300字以保证计费档位）。**每章只能多不能少**。
   - **第5问**：是否已有初步故事构思或灵感片段？如果有，详细描述。
   - **第6问**：主角设想（性别、年龄段、核心特质、是否有原型参考）
   - **第7问**：世界观偏好（东方玄幻/西方奇幻/赛博朋克/末日废土/混合/...）
   - **第8问**：希望传达的核心主题或情感（复仇/成长/救赎/探索/守护/...）
   - **第9问**：风格参考（类似某某作家/某某作品/某某流派的哪种感觉）
   - **第10问**：更新节奏（日更/周更/不定期）
3. 全部信息收集完毕后，生成**需求摘要**（故事梗概100-300字），请用户确认。
4. 确认后，**主动询问是否授权爬取同类热门小说**作为参考。如果用户授权，**必须等用户明确说出"番茄"后**才调用 crawl_books 工具。目前**仅支持番茄小说平台**。

### 爬取参考数据质量要求
- 目前只支持**番茄小说**爬取
- 筛选规则：**在读人数少于1万的书籍不作为参考**，除非该书已完结且总字数大于30万字
- 编排师在调用 crawl_books 后应告知用户筛选标准和结果

### 编排师 System Prompt 阶段一补充内容
```
## 当前阶段：需求采访（阶段一）
- 你的目标是充分了解用户的创作意图，而不是急于推进
- **关键规则：每次只问一个问题。** 得到用户明确回答后再问下一个，绝不一次抛出多个问题干扰用户
- 目标字数限制在100万字以内（项目目前未实现稳定的长篇产出能力）
- 以下信息必须逐一收集：
  [ ] 小说类型和细分方向
  [ ] 目标字数（≤100万字）
  [ ] 目标平台（当前仅支持番茄小说爬取）
  [ ] 每章预期最低字数（向用户说明平台计费规则：2900按2000算，1999按1000算，每章只能多不能少）
  [ ] 故事构思或灵感片段
  [ ] 主角设想（性别+年龄段+核心特质）
  [ ] 世界观偏好
  [ ] 核心主题/情感
  [ ] 风格参考
  [ ] 更新节奏
- 收集完成后生成需求摘要，故事梗概100-300字
- 确认后进入阶段二（世界观构建）
- 如果用户已经提供了足够的信息，不要重复提问
```

### 完成标志
- [ ] 用户确认了需求摘要（含100-300字故事梗概）
- [ ] 目标字数 ≤ 100万字
- [ ] 每章预期最低字数已记录
- [ ] 项目的 genre/sub_genre/target_words/style_ref 字段已填写（通过 projects 表更新）
- [ ] 可选：已爬取番茄参考书籍数据，按质量规则筛选

### 产出
```json
{
  "梗概": "100-300字的故事梗概。林云是一个十六岁的底层采药少年，在南域大陆边缘的荒山中意外获得一枚刻满古老符文的青铜道器。道器融入体内后，他获得了窥探'因果线'的能力——能看到万事万物之间的因果关联。但这力量并非没有代价：每一次使用都会在身体上留下不可逆的因果刻痕，过度使用将导致自身因果崩溃。为了寻找道器的来历和控制力量的方法，林云拜入青云宗，从最底层的杂役弟子做起。在宗门内，他必须隐藏自己的力量，同时应对来自同门的竞争、师父的怀疑、以及道器带来的越来越强烈的因果反噬。这是一条从凡人到达因果法则之巅的崎岖之路，而路上的每一个选择，都将带来无法预料的连锁反应。",
  "类型": "玄幻",
  "细分方向": "凡人流+因果律",
  "目标字数": "100万字",
  "目标平台": "番茄小说",
  "每章最低字数": "3100字（目标3000字档位，实际多写100字保证计费档位不降级）",
  "风格参考": "《凡人修仙传》的凡人成长线 + 《诡秘之主》的规则探索感",
  "主角设想": "男性，16岁，坚韧务实，底层出身，性格谨慎但关键时刻敢于冒险",
  "世界观偏好": "东方玄幻修仙世界，力量体系以因果律为核心",
  "核心主题": "成长与代价——每一次选择都有不可逆的因果",
  "更新节奏": "日更4000字"
}
```

### 涉及改动
| 文件 | 改动 |
|------|------|
| server.js | 编排师 System Prompt 全面重写阶段一规则（约+30行） |
| server.js | 番茄爬取筛选规则（在读人数≥1万 或 完结且>30万字） |
| server.js | crawl_books 工具限制为仅番茄平台 |
| write.html | 无需改动 |
| write.js | 无需改动 |
| DB | 无需改动（已有字段） |

---

## 阶段二：世界观构建（需要大幅加强）

### 前置条件
- 阶段一完成（需求摘要已确认）
- 故事梗概已生成（100-300字）

### 编排师行为
1. 基于需求摘要和故事梗概，向用户宣布进入世界观构建阶段
2. **每次只问一个方向**，得到明确回答后再问下一个：
   - **第1问·世界名称与规模**："你的这个世界叫什么名字？是整个故事发生在一片大陆上，还是横跨多块大陆？有没有多层位面（如凡界/灵界/仙界）？有没有特殊维度的秘境或异空间？"
   - **第2问·世界核心法则**："这个世界最底层、最根本的'规则'是什么？比如——灵力是从哪里来的？魔法有没有代价？科技有没有禁区？有没有整个世界都必须遵守的、不可违背的铁律？（例如：等价交换、因果必报、能量守恒、寿命上限等）"
   - **第3问·力量体系**："这个世界的力量体系是什么样的？是修仙境界（炼气→筑基→金丹...）、魔法等级（学徒→法师→大法师...）、超能力分类（元素系/精神系/强化系...）、还是其他设定？请详细列出等级名称和大概的能力范围。"
   - **第4问·力量体系的细节**："每个等级之间的差距有多大？升级需要什么条件（修炼/试炼/机缘/突破）？同级之间有没有相生相克的关系？有没有'越级挑战'的可能性（在什么条件下可能发生）？"
   - **第5问·势力格局**："世界上有哪些主要的势力（宗门/国家/种族/组织）？每个势力的核心利益是什么？它们之间的关系如何——是和平共存、互相牵制、还是战争状态？有没有一个公认的最强势力？有没有正在崛起的挑战者？"
   - **第6问·势力内部结构**："最重要的那个势力（通常是主角所在势力）的内部结构是什么样的？有没有派系斗争？有没有等级森严的晋升机制？普通成员和核心成员的权利差异有多大？"
   - **第7问·地理格局**："世界的地理格局是什么样的？有没有特殊的地标（如永恒风暴、无尽深渊、浮空岛、禁地）？不同势力的领地是如何划分的？有没有中立区域或三不管地带？气候和地理环境对势力发展有什么影响？"
   - **第8问·种族/物种**："这个世界只有人类吗？还是存在其他智慧种族（精灵/兽人/妖族/龙族/机械生命...）？如果有，各个种族之间的关系如何？有没有种族歧视或种族战争的历史？不同种族之间能否通婚或合作？"
   - **第9问·历史与神话**："世界的古代历史中有哪些重大事件？有没有上古文明遗迹？有没有已经消失的强大种族或帝国？有没有流传至今的预言或传说？这些历史对当今世界格局产生了什么影响？"
   - **第10问·文化与经济**："世界的文化氛围是什么样的？有没有统一的通用语言或文字？有没有跨势力的货币体系？有没有影响整个世界的宗教或信仰？普通人（非修炼者/非魔法师）的生活状态是怎样的？"
3. 收集足够信息后（至少回答了前5个方向），调用 **design_worldview** 工具生成世界观框架
4. 工具执行流程（已实现）：
   - LLM 生成世界观文档（Markdown格式）
   - 自动提取结构化实体和关系 → 写入 world_entities + world_relations
   - 实体类型：世界、势力、地点、力量等级、物种、人物、物品、概念、事件
   - 关系类型：敌对、同盟、从属、师徒、亲属、竞争、中立、克制
5. 编排师检查提取结果，向用户汇报：
   - "已生成世界观框架：沧玄界（1个世界根节点）→ 3大势力 → 5个主要地点 → 2套力量体系，共15个实体，8条关系"
   - 自动打开浮动画布（🌍 世界观层级树），供用户检查和修改
6. 用户确认后进入阶段三

### 完成标志
- [ ] world_entities 表 ≥ 10 条记录
- [ ] world_relations 表 ≥ 5 条记录
- [ ] 至少包含以下类型的实体：世界(1个)、势力(≥2个)、地点(≥2个)、力量等级(≥1套)
- [ ] 至少包含以下关系类型：敌对或同盟(≥1条)、从属(≥1条)
- [ ] 蓝图 world.era_summary 已正确填写（非JSON原文）
- [ ] 蓝图 world.key_factions 已正确填写
- [ ] 用户确认世界观内容
- [ ] 开发者日志已记录世界观构建全过程（双语）

### 编排师 System Prompt 阶段二补充内容
```
## 当前阶段：世界观构建（阶段二）
- 阶段一已完成的产出会通过「故事蓝图」「世界观实体」「角色列表」注入你的上下文
- **关键规则：每次只问一个方向。** 绝不同时抛出多个问题
- 你需要依次询问以下方向，每个方向得到明确回答后再进入下一个：
  1. 世界名称与规模（大陆/位面/秘境）
  2. 世界核心法则（最底层的铁律）
  3. 力量体系（等级名称+能力范围）
  4. 力量体系细节（等级差距/升级条件/越级可能）
  5. 势力格局（主要势力+关系网+最强vs挑战者）
  6. 核心势力内部结构（派系/晋升/权利差异）
  7. 地理格局（特殊地标/领地划分/中立区域/气候影响）
  8. 种族/物种（多样性/关系/歧视/通婚）
  9. 历史与神话（重大事件/上古文明/预言/影响）
  10. 文化与经济（语言/货币/宗教/普通人生活）
- 至少确认前5个方向（世界→法则→力量→势力→地理）后才调用 design_worldview 工具
- 工具完成后，检查 world_entities 表是否有数据（通过蓝图更新通知判断）
- 告知用户可以在浮动画布查看世界观层级树
- 等待用户确认（或要求修改）
- 如果用户说"跳过世界观，直接开始角色"：
  → 温和提醒：没有世界观基础，角色的出身、能力来源、动机都会很空洞
  → 如果用户坚持跳过，至少要求确认力量体系和核心势力后再进入角色设计
  → 记录到蓝图 pending_questions 中
- 完成标志：world_entities ≥ 10 条 + world_relations ≥ 5 条 + 用户确认
- 每次询问和每次工具调用都输出双语调试日志
```

### 产出
结构化的世界观数据（world_entities + world_relations 表），可在浮动画布中以层级树可视化。

### 涉及改动
| 文件 | 改动 | 工作量 |
|------|------|--------|
| server.js | 编排师 System Prompt 补充阶段二规则（约+30行，含10个详细发问方向） | 中 |
| server.js | 新增 `GET /api/writing-projects/:id/stage-status` 端点（返回当前阶段+各表数据量） | 中 |
| server.js | 增强 design_worldview 工具处理：阶段门控检查（阶段一完成前置） | 小 |
| server.js | 世界观构建全过程双语调试日志 | 小 |
| write.js | 浮动画布已支持 🌍 世界观层级树 | 已完成 |

---

## 阶段三：角色设计（需要大幅加强）

### 前置条件
- 阶段一完成（需求摘要已确认）
- 阶段二完成（world_entities ≥ 10 + world_relations ≥ 5）

### 编排师行为
1. 基于世界观和需求摘要，向用户宣布进入角色设计阶段
2. **每次只问一个问题**，得到明确回答后再问下一个：
   - **第1问·主角身份**："你的主角是什么样的人？请描述他/她的——性别、年龄、出身背景（贫寒/贵族/孤儿/世家...）、社会地位（底层/中层/上层）、以及性格核心特质（例如：坚韧、谨慎、善良、冷酷、算计、豪爽...）。他/她的性格中最大的缺陷是什么？（一个好主角必须有缺点）"
   - **第2问·主角的金手指**："主角的金手指（特殊能力/机缘/作弊器）是什么？这个金手指是怎么获得的——天生/觉醒/奇遇/传承/交易？它有什么独特的规则和限制？有没有使用代价（例如消耗寿命、积累因果、牺牲记忆...）？这个金手指在故事前期、中期、后期分别能达到什么程度？"
   - **第3问·主角的核心动机**："主角最想要的是什么？他/她内心深处的驱动力是什么——复仇/保护某人/变强/寻找真相/活下去/证明自己/...？他/她最害怕的是什么？最大的弱点（不是能力上的弱点，是性格或情感上的）是什么？"
   - **第4问·主角的成长弧线**："你设想的主角成长弧线是什么样的？从故事开始到结束，他/她会发生怎样的变化？希望主角最终变成一个什么样的人？有没有一个他/她必须做出的最艰难的选择？"
   - **第5问·角色数量**："你希望主要角色有多少个？包括主角、反派、重要配角——不需要太多，但每个都要有自己的独立动机和故事。建议数量：主角1个 + 反派1-2个 + 重要配角3-5个。你倾向于多少？"
   - **第6问·反派/对手设计**："你的反派或主要对手是谁？（如果有多个反派，先讨论最主要的一个）他/她的核心理念或目标是什么？为什么他/她会成为主角的对手？他/她有没有'正当理由'？（一个好的反派不是单纯的'坏人'，而是'和主角有不可调和的目标冲突'）"
   - **第7问·配角关系**："重要的配角有哪些？每个人和主角是什么关系（朋友/导师/竞争对手/爱慕对象/家人/...）？每个配角自己的独立目标是什么？（配角不能只是'帮助主角'，他们也应该有自己的欲望和行动）"
   - **第8问·角色命名**：编排师告知用户即将生成随机命名表。此时**不调用 LLM**，而是触发本地 Python 脚本生成随机命名表（含大量姓氏+可搭配名字），展示给用户筛选。用户可以从表中选择名字或自行命名。
3. 在询问角色信息的过程中，编排师应主动根据世界观设定（势力归属、力量体系等）给出建议
4. 收集足够信息后，调用 **generate_characters** 工具生成角色档案
5. 工具执行流程（需要增强）：
   - LLM 生成角色档案（含性格、背景、能力、命运弧线、关系网）
   - 自动写入 writing_characters 表
   - **新增**：生成时注入世界观上下文（从 world_entities 表读取）
   - **新增**：要求 LLM 在 profile_json 中标记 is_protagonist
6. 编排师检查结果，**明确向用户提议主角候选**：
   - "我建议将「林云」设为主角。理由：他的因果道器能力与世界观核心法则紧密相关，性格设定（坚韧务实）适合凡人流成长线。是否确认？"
   - → 前端渲染主角确认气泡
7. 用户确认主角后：
   - is_protagonist = 1 写入 DB
   - 蓝图 protagonist.name 同步更新
   - 开放浮动画布（👤 角色星座图）
8. 编排师询问是否需要补充或修改角色
9. 用户确认后进入阶段四

### 随机命名表生成（Python 脚本）

命名表放在 `public/name_pool.json`，通过 HTTP 直接访问。Python 脚本放在 `scripts/generate_name_pool.py`，用于生成和更新命名表。

**姓氏要求**：至少包含200个姓氏，涵盖常见汉姓、复姓（欧阳、司马、慕容、上官、诸葛...）、网文常见百家姓变体、以及少量冷门但好听的姓氏。复姓不少于30个。

**名字要求**：至少包含500个可搭配的名字用字（男女各半），每个字标注性别倾向（男/女/中性），支持单字名和双字名组合。涵盖以下风格：古风（如：凌云、清寒、墨染）、现代（如：浩然、思远、雨桐）、霸气（如：霸天、破军、无痕）、温婉（如：若兰、清雪、婉清）。

**脚本输出格式**（`public/name_pool.json`）：
```json
{
  "姓氏": ["李","王","张","刘","陈","杨","赵","黄","周","吴","徐","孙","胡","朱","高","林","何","郭","马","罗","梁","宋","郑","谢","韩","唐","冯","于","董","萧","程","曹","袁","邓","许","傅","沈","曾","彭","吕","苏","卢","蒋","蔡","贾","丁","魏","薛","叶","阎","余","潘","杜","戴","夏","钟","汪","田","任","姜","范","方","石","姚","谭","廖","邹","熊","金","陆","郝","孔","白","崔","康","毛","邱","秦","江","史","顾","侯","邵","孟","龙","万","段","雷","钱","汤","尹","易","常","武","乔","贺","赖","龚","文", "欧阳","司马","慕容","上官","诸葛","令狐","独孤","尉迟","皇甫","南宫","端木","夏侯","东方","西门","公孙","长孙","宇文","轩辕","司徒","司空","百里","呼延","东郭","南门","羊舌","微生","公冶","太史","闾丘","申屠","公西","濮阳","颛孙","子车","壤驷","拓跋","夹谷","宰父","谷梁"],
  "名字用字": {
    "男": ["云","风","天","宇","辰","毅","轩","恒","远","阳","雷","霆","锋","剑","龙","虎","鹏","鸿","杰","哲","铭","渊","博","瀚","霖","逸","卓","越","峻","岩","川","河","海","岳","峰","涛","澜","波","浩","瀚","辉","耀","光","亮","明","华","荣","昌","盛","安","康","健","威","武","勇","刚","强","建","立","志","信","义","仁","德","道","正","直","诚","忠","孝","良","善","谦","逊","恭","敬","思","念","忆","怀","承","继","绍","启","开","拓","闯","行","驰","骋","飞","翔","腾","跃","超","凌","傲","啸","吟","歌"],
    "女": ["诗","画","琴","棋","书","韵","雅","静","柔","婉","秀","丽","美","艳","芬","芳","兰","梅","菊","莲","荷","蓉","薇","蕊","蕾","霜","雪","冰","清","洁","素","纯","真","灵","慧","贤","淑","贞","善","慈","容","颜","姿","影","烟","霞","云","雨","露","月","星","瑶","琼","瑛","琳","琦","琪","珠","玉","翠","碧","彩","虹","霓","锦","绣","绮","罗","绮","纱","绫","绢","素","青","紫","红","绿","蓝","翠","燕","莺","蝶","凤","凰","鸾","鹊","馨","馥","香","暖","煦","晴","晓","晨","曦","夕","晚","暮","春","夏","秋","冬"],
    "中性": ["一","之","子","亦","若","如","然","尔","以","兮","君","卿","言","行","知","明","远","安","宁","平","和","天","宇","星","辰","景","泽","润","源","泉","溪","林","木","山","石","谷","野","原","陆","洲","江","海","风","云","雪","月","日","光","影","声","音","色","文","章","书","画","意","心","志","道","德","仁","义","礼","信","诚","真","清","静","玄","妙","空","虚","无","有","常","恒","永","长","久","远","高","深","厚","重","轻","微","大","小","多","少"]
  },
  "默认组合建议": {
    "男单字": "推荐用 姓+男用字（如：林云、陈锋、赵毅）",
    "女单字": "推荐用 姓+女用字（如：苏婉、柳烟、秦瑶）",
    "男双字": "推荐用 姓+男用字+中性字（如：林云逸、陈天宇、赵凌霄）",
    "女双字": "推荐用 姓+女用字+中性字（如：苏婉清、柳如烟、秦若兰）"
  },
  "网文风格推荐": {
    "玄幻男主": "姓+霸气男字+气势字（如：龙傲天、叶无痕、萧破军）",
    "玄幻女主": "姓+清冷女字+灵韵字（如：冷若霜、楚清寒、慕容雪）",
    "都市男主": "姓+现代男字+正面字（如：陆景深、顾北辰、沈越然）",
    "都市女主": "姓+温婉女字+柔和字（如：苏晴暖、林语桐、安初夏）"
  }
}
```

**脚本名称**：`scripts/generate_name_pool.py`

**使用方式**：
```bash
python scripts/generate_name_pool.py  # 生成/更新 public/name_pool.json
```

**前端使用**：编排师在阶段三第8问时，提示用户可以在浮动画布或对话中看到随机生成的名字建议。前端通过 `fetch('/name_pool.json')` 加载命名表，在浮动画布的角色 tab 中增加"随机命名"按钮，点击后从姓氏和名字用字中随机组合出5-10个名字供用户筛选。

### 完成标志
- [ ] writing_characters 表 ≥ 3 条记录（主角+至少2个配角/反派），如果用户要求的角色数超过3则按用户要求
- [ ] 至少有一个角色 is_protagonist = 1（主角已确认）
- [ ] relationship_edges 表 ≥ 5 条记录
- [ ] 每个角色 profile_json 包含：性格、背景、能力、命运弧线、关系网
- [ ] 主角 profile_json 包含：核心动机、性格缺陷、成长弧线终点、金手指详情
- [ ] 蓝图 protagonist.name 已正确填写
- [ ] 用户确认角色阵容
- [ ] 角色命名表已生成（public/name_pool.json）
- [ ] 开发者日志已记录角色设计全过程（双语）

### 编排师 System Prompt 阶段三补充内容
```
## 当前阶段：角色设计（阶段三）
- 阶段一和阶段二的产出（世界观实体+势力+力量体系）会通过上下文注入
- **关键规则：每次只问一个问题。** 绝不同时抛出多个问题
- 你需要依次询问以下问题：
  1. 主角身份（性别/年龄/出身/地位/性格+缺陷）
  2. 主角的金手指（能力/来源/规则/限制/代价/成长阶段）
  3. 主角核心动机（驱动力/最怕什么/最大弱点/最艰难选择）
  4. 主角成长弧线（从什么状态→什么状态的完整变化）
  5. 角色数量（主角1+反派1-2+配角3-5）
  6. 反派/对手设计（理念/冲突根源/正当理由）
  7. 配角关系（每个人与主角的关系+独立目标）
  8. 角色命名（触发随机命名表生成，用户筛选）
- 在询问过程中主动根据世界观给出建议（如"以青云宗的设定，主角更适合以杂役弟子身份进入"）
- 调用 generate_characters 工具（工具会自动使用世界观上下文）
- 生成完成后，根据角色档案，主动识别主角候选并提议
- 等待用户确认主角（通过按钮）
- 检查角色关系网是否完整（至少覆盖主角↔各主要角色的关系）
- 告知用户可以在浮动画布查看角色星座图
- 角色设计原则：
  - 主角必须有明确的性格缺陷（不是完美人设）
  - 金手指必须有代价和限制（不是无敌外挂）
  - 反派必须有正当理由（不是单纯"坏人"）
  - 每个角色都要有独立于主角的欲望和目标
  - 角色关系应体现世界观中的势力格局
- 完成标志：角色 ≥ 3 个（或用户要求的数量）+ 主角已确认 + 关系 ≥ 5 条 + 用户确认
- 每次询问和每次工具调用都输出双语调试日志
```

### 产出
完整的角色档案（writing_characters + relationship_edges），可在浮动画布中以角色星座图可视化。随机命名表（public/name_pool.json）可供后续所有项目复用。

### 涉及改动
| 文件 | 改动 | 工作量 |
|------|------|--------|
| server.js | CHARACTER_SYSTEM 增强：注入世界观上下文 + 主角标记要求 + 金手指字段 | 中（约+40行） |
| server.js | executeToolAsync 角色分支：生成前查 world_entities 注入上下文 | 中（约+20行） |
| server.js | 编排师 System Prompt 补充阶段三规则（约+35行） | 中 |
| scripts/generate_name_pool.py | 🆕 新建：随机命名表生成脚本（约+120行Python） | 中 |
| public/name_pool.json | 🆕 新建：命名表静态文件（约+800行JSON） | 小（脚本自动生成） |
| write.js | 浮动画布已支持 👤 角色星座图 | 已完成 |
| write.js | 主角确认气泡已实现 | 已完成 |
| write.js | 随机命名按钮（加载 name_pool.json + 随机组合） | 小（约+30行） |

---

## 阶段四：卷蓝图规划（全新开发）

### 前置条件
- 阶段一完成（需求摘要已确认）
- 阶段二完成（world_entities ≥ 10 + world_relations ≥ 5）
- 阶段三完成（characters ≥ 用户要求数量 + 主角已确认 + relationships ≥ 5）

### 编排师行为
1. 编排师收到上下文（含完整的世界观+角色+关系网信息），**自己**做卷蓝图规划
2. 编排师需要先规划每卷的**起承转合节奏**，然后再调用工具：

#### 卷数和章数计算
- 总目标 ≤ 100万字 ÷ 每章最低字数（用户阶段一指定）≈ 总章数需求
- 例如：100万字 ÷ 3100字/章 ≈ 322章，压缩为4卷，每卷约80章（实际由剧情节奏决定，不严格要求等长）
- **4卷是推荐的卷数**，既不会让单卷太薄（导致剧情不够展开），也不会太多（导致每卷内容空洞）

#### 起承转合节奏规划（每卷独立）

每卷必须拥有独立的"起承转合"章剧情结构。编排师在调用 **plan_volume_blueprint** 之前，先在思考中完成每卷的节奏分配。起承转合的章占比为参考值，实际由剧情需要决定，但每卷四个阶段缺一不可。

| 节奏阶段 | 参考章占比 | 功能 | 要求 |
|----------|--------|------|------|
| **起** | 约25% | 建立：引入本卷的核心冲突和背景 | 快速抓住读者，建立悬念（钩子），不拖沓 |
| **承** | 约35% | 发展：冲突升级、角色成长、世界观展开 | 逐步加码压力，展示主角的应对和成长 |
| **转** | 约25% | 高潮：核心冲突爆发、关键转折 | 最大的危机或选择，主角的关键决策点，不可逆的改变 |
| **合** | 约15% | 收束：本卷核心冲突解决、过渡到下一卷 | 本卷的成果和代价，为下一卷的铺垫（新悬念/新线索/新威胁） |

**每卷起承转合的质量检查清单**：
- [ ] 第一卷的【起】是否在第一章就抛出了钩子？
- [ ] 每卷的【转】是否是本卷最大的危机或选择点？
- [ ] 每卷的【合】是否既收束了本卷又为下一卷铺垫？
- [ ] 每卷的主角是否在本卷内发生了可感知的成长变化？
- [ ] 卷与卷之间的【合】→【起】是否衔接自然？

3. 编排师向用户汇报卷蓝图，示例（4卷结构）：

   ```
   根据100万字目标（每章最低3100字），我规划了4卷结构：
   
   ━━━ 第一卷「因果初醒」(约80章) ━━━
   主题：凡人获得禁忌力量，必须在隐藏中求生存
   【起】第1-20章：获得因果道器→初识修仙→拜入青云宗→杂役生涯
      钩子：道器入体的神秘刻痕，守护兽测试
   【承】第21-48章：道器能力逐步显现→在宗门站稳→被长老收为记名弟子
      关键：第一次越级战胜、道器被动触发引来怀疑
   【转】第49-68章：道器暴露危机→被迫公开使用→面临审问和驱逐威胁
      高潮：师父替他挡下审问，他选择部分坦诚→获得有条件保留资格
   【合】第69-80章：渡过危机→领悟因果法则第一层→试炼中发现秘境符文线索
      铺垫：符文与道器一致→指向秘境→为第二卷埋下重大悬念
   
   ━━━ 第二卷「秘境争锋」(约75章) ━━━
   承接：第一卷秘境符文线索 + 师父开始调查道器来历
   主题：深入秘境→与各方势力博弈→道器能力面临真正考验
   【起】...【承】...【转】...【合】...
   铺垫：秘境深处遇到的势力→指向第三卷的更大格局
   
   ━━━ 第三卷「天下动荡」(约80章) ━━━
   承接：第二卷各方势力的注意 + 道器来历的碎片线索
   主题：宗门动荡→多势力卷入→道器继承者的身份被世人知晓
   ...铺垫：上古仙尊的传说浮出水面→指向第四卷的因果真相
   
   ━━━ 第四卷「因果终章」(约85章) ━━━
   承接：第三卷身份暴露 + 各方势力围剿
   主题：揭开道器真正来历→因果法则终极试炼→执掌或消逝
   
   跨卷伏笔规划：
   - 道器真正来历(1→2→4卷回收)
   - 师父的真实身份(1→3卷回收)
   - 秘境钥匙(1→2卷回收)
   
   是否确认这个卷蓝图？
   ```

4. 编排师完成规划后，调用 **plan_volume_blueprint** 工具结构化保存
5. 用户确认或修改后，进入阶段五

### 完成标志
- [ ] 每卷都有完整的起承转合分配
- [ ] 总卷数不超过4卷（根据100万字目标）
- [ ] 每卷章数在合理范围内（60-90章，由剧情节奏决定）
- [ ] 卷蓝图 JSON 已生成（含起承转合标注）并展示给用户
- [ ] 用户确认了卷蓝图
- [ ] 卷蓝图数据保存到 story_blueprints.plot
- [ ] 开发者日志已记录卷蓝图规划全过程（双语）

### 编排师 System Prompt 阶段四补充内容
```
## 当前阶段：卷蓝图规划（阶段四）
- 你现在拥有完整的世界观、角色阵容和关系网信息
- 你需要基于这些信息，自己规划卷蓝图（不需要调用子智能体）
- 规划要素：
  1. 总目标 ≤ 100万字，分4卷
  2. 每卷必须先规划「起承转合」四阶段的章分配：
     - 【起】：建立本卷核心冲突和背景，第一卷必须第一章就抛出钩子
     - 【承】：冲突升级、角色成长、世界观展开，逐步加码压力
     - 【转】：核心冲突爆发、关键转折、主角的关键决策——不可逆的改变
     - 【合】：收束本卷 + 为下一卷铺垫——新悬念/新线索/新威胁
  3. 每卷定义：卷名（有吸引力）、核心主题、核心冲突、主角成长阶段、起承转合各阶段章概要
  4. 每卷的"承接"必须匹配上一卷的"铺垫"
  5. 规划4个以上跨卷伏笔，标注埋设/暗示/回收卷号
  6. 完成规划后，调用 plan_volume_blueprint 工具结构化保存
  7. 输出格式：展示完整的起承转合结构，末尾附 [✅ 确认卷蓝图] [🔄 重新规划] 按钮
- 完成标志：4卷起承转合已分配 + 卷蓝图已规划 + 用户确认
- 每次规划操作输出双语调试日志
```

### 产出
```json
{
  "总脉络": "一个凡人获得因果道器，在修仙世界中步步为营，从宗门弟子成长为执掌因果法则的存在，最终揭开世界真相",
  "总卷数": 4,
  "总章数": 320,
  "目标总字数": "100万字",
  "每章最低字数": "3100字",
  "卷蓝图": [
    {
      "卷号": 1,
      "卷名": "因果初醒",
      "总章数": 80,
      "主题": "凡人获得禁忌力量，必须在隐藏中求生存",
      "核心冲突": "道器的暴露风险 vs 宗门生存压力",
      "主角成长": "凡人→炼气期圆满，从被动逃避到主动掌控命运的初步觉醒",
      "起承转合": {
        "起": { "章范围": "1-20", "功能": "建立核心冲突：获得道器、进入修仙世界", "钩子": "道器入体的神秘刻痕+守护兽测试" },
        "承": { "章范围": "21-48", "功能": "冲突升级：道器能力逐步显现、在宗门站稳、暗流涌动" },
        "转": { "章范围": "49-68", "功能": "高潮：道器暴露危机、被迫在公开场合使用、面临审问和驱逐" },
        "合": { "章范围": "69-80", "功能": "收束：渡过危机→领悟因果法则第一层→试炼中发现秘境符文→为第二卷铺垫" }
      },
      "衔接": {
        "承接": "无（开篇卷）",
        "铺垫": "秘境符文与道器符文一致→指向第二卷秘境探索；师父开始调查道器来历→身份暴露风险升级"
      }
    }
  ],
  "跨卷伏笔": [
    {
      "名称": "因果道器的真正来历",
      "描述": "道器是上古因果仙尊的传承之物，历代继承者都在达到某个境界后神秘消失",
      "埋设卷": 1, "第一次暗示卷": 2, "回收卷": 4,
      "回收方式": "主角在仙界遗迹中找到因果仙尊的遗言，明白道器是'法则的试炼'"
    }
  ]
}
```

### 涉及改动
| 文件 | 改动 | 工作量 |
|------|------|--------|
| server.js | 编排师 System Prompt 全面重写阶段四规则（约+40行，含起承转合+4卷约束） | 中 |
| server.js | executeToolAsync 新增 plan_volume_blueprint 工具分支 | 中（约+50行） |
| server.js | 阶段门控逻辑：阶段五前置检查 | 小 |
| server.js | 蓝图 plot.main_thread + plot.sub_threads 写入卷蓝图 | 小 |
| write.js | 卷蓝图在浮动画布大纲预览 tab 中展示起承转合结构 | 中（随阶段五一起做） |

---

## 阶段五：大纲生成（全新开发 + 最大工作量）

### 前置条件
- 阶段一完成（需求摘要已确认）
- 阶段二完成（world_entities ≥ 10 + world_relations ≥ 5）
- 阶段三完成（characters ≥ 3 + 主角已确认 + relationships ≥ 5）
- 阶段四完成（卷蓝图已确认）

### 编排师行为
1. 编排师检查所有前置条件满足
2. 编排师调用 **generate_outline_multi**（新工具名，区别于旧的单agent生成）
3. 编排师不参与生成过程，只等待完成通知
4. 收到 SSE 事件：{type:'outline_draft_ready', volumes:[...]}
5. 编排师回复："大纲已生成，共8卷140章 [📋 预览大纲]"
6. 用户点击按钮 → 浮动画布弹出大纲预览 tab

### 多智能体生成流程（服务端）

```
Step 5.1: 编排师调用 generate_outline_multi 工具
   → executeToolAsync 识别工具名
   
Step 5.2: 服务端组装"卷蓝图上下文"
   → 将阶段四的卷蓝图 + 世界观摘要 + 角色摘要 打包为共享上下文
   
Step 5.3: 并行启动卷 Agent（每卷一个）
   → 并发数控制：最多3个同时运行
   → 每个 Agent 的 System Prompt = OUTLINER_VOLUME_SYSTEM
   → 每个 Agent 的 User Content = 共享上下文 + 该卷的卷蓝图 slot + 相邻卷摘要
   
Step 5.4: 每个卷 Agent 输出详细大纲
   → 格式：JSON（卷名、卷概要、时间锚点、章列表）
   → 每章含：章名、概要(150-200字)、关键事件(含详细描述)、事件类型、涉及角色、伏笔标记
   
Step 5.5: 写入数据库（draft 状态）
   → writing_volumes: status='draft'
   → writing_chapters: 每章记录
   → plot_timeline_events: 从关键事件提取
   
Step 5.6: 编排师汇总
   → 检查卷间衔接一致性
   → 标注疑似矛盾
   
Step 5.7: 推送 SSE 事件
   → {type:'outline_draft_ready', projectId, volumes:[{id,title,chapterCount},...]}
```

### 浮动画布大纲预览 tab 详细设计

#### 新增大纲预览 tab 到浮动画布
```
浮动画布 tabs:
  🌍 世界观层级树 | 👤 角色星座图 | 📖 时间线 | 📋 大纲预览 ← 新增
```

#### 大纲预览 UI 详细结构
```html
<div id="fc-outline-preview">
  <!-- 顶部操作栏 -->
  <div class="ol-actions">
    <button class="ol-btn ol-confirm-all" onclick="FLOATING_CANVAS.confirmOutline('all')">
      ✅ 确认全部卷
    </button>
    <button class="ol-btn ol-reject-all" onclick="FLOATING_CANVAS.rejectOutline()">
      🗑 推翻重来
    </button>
    <button class="ol-btn ol-export" onclick="FLOATING_CANVAS.exportOutline()">
      📥 导出JSON
    </button>
    <span class="ol-status">已采纳 2/8 卷 · 批注 3 条 · 待确认 6 卷</span>
  </div>
  
  <!-- 卷列表（可折叠） -->
  <div class="ol-volumes">
    <!-- 每卷一个卡片 -->
    <div class="ol-volume" data-volume-id="1">
      <div class="ol-vol-header">
        <span class="ol-vol-toggle">▼</span>
        <span class="ol-vol-title">第一卷：因果初醒</span>
        <span class="ol-vol-meta">12章 · 主角从凡人到炼气期圆满</span>
        <span class="ol-vol-conn">承接：无(开篇) → 铺垫：秘境线索</span>
        <div class="ol-vol-btns">
          <button class="ol-btn-sm ol-confirm">✅ 采纳</button>
          <button class="ol-btn-sm ol-annotate">✏️ 批注</button>
          <button class="ol-btn-sm ol-regenerate">🔄 重生成本卷</button>
        </div>
      </div>
      
      <!-- 批注区域（默认隐藏） -->
      <div class="ol-annotation" style="display:none;">
        <textarea placeholder="输入批注意见...此批注将在重新生成时作为修改依据"></textarea>
        <button class="ol-btn-sm">💾 保存批注</button>
      </div>
      
      <!-- 章列表 -->
      <div class="ol-chapters">
        <!-- 每章一个条目 -->
        <div class="ol-chapter" data-chapter-id="1">
          <div class="ol-ch-header">
            <span class="ol-ch-num">第1章</span>
            <span class="ol-ch-title">山洞奇遇</span>
            <span class="ol-ch-type major">核心事件</span>
            <span class="ol-ch-characters">涉及：林云、守护兽</span>
          </div>
          <div class="ol-ch-summary">150字详细概要：林云在采药时意外坠入古洞，发现一尊...</div>
          <div class="ol-ch-events">
            <div class="ol-event major">
              <span class="ol-event-dot"></span>
              <span class="ol-event-name">获得因果道器</span>
              <span class="ol-event-desc">道器外观为古朴青铜环，刻有晦涩符文。林云触碰后道器融入体内，脑海中浮现因果法则的初步信息。同时触发守护兽苏醒。</span>
            </div>
            <div class="ol-event minor">
              <span class="ol-event-dot"></span>
              <span class="ol-event-name">遭遇守护兽</span>
              <span class="ol-event-desc">守护兽为上古傀儡，测试继承者资格。林云在绝境中首次无意识运用道器能力，以"因果推断"预判傀儡攻击轨迹。</span>
            </div>
          </div>
          <div class="ol-ch-foreshadow">🔮 伏笔：道器符文与后续出现的仙界遗迹铭文相同</div>
        </div>
        <!-- ... 更多章节 ... -->
      </div>
    </div>
    <!-- ... 更多卷 ... -->
  </div>
</div>
```

#### CSS 样式（新增到 write.html）
```css
/* 大纲预览容器 */
#fc-outline-preview { flex:1; overflow-y:auto; padding:12px; display:none; }
#fc-outline-preview.show { display:block; }

/* 操作栏 */
.ol-actions { display:flex; gap:8px; align-items:center; padding-bottom:12px; border-bottom:1px solid var(--border); margin-bottom:12px; flex-wrap:wrap; }
.ol-btn { padding:6px 14px; font-size:12px; border-radius:6px; cursor:pointer; border:0.5px solid var(--border); background:rgba(255,255,255,0.04); color:var(--text); font-family:inherit; transition:all 0.15s; }
.ol-btn:hover { background:rgba(255,255,255,0.08); }
.ol-confirm-all { background:rgba(34,197,94,0.12); color:#22C55E; border-color:rgba(34,197,94,0.2); }
.ol-reject-all { background:rgba(245,63,63,0.08); color:#F53F3F; border-color:rgba(245,63,63,0.15); }
.ol-status { font-size:11px; color:var(--text2); margin-left:auto; }

/* 卷卡片 */
.ol-volume { border:0.5px solid var(--border); border-radius:8px; margin-bottom:10px; background:rgba(255,255,255,0.015); overflow:hidden; }
.ol-volume.confirmed { border-color:rgba(34,197,94,0.2); background:rgba(34,197,94,0.03); }
.ol-volume.rejected { opacity:0.4; }
.ol-vol-header { padding:10px 12px; cursor:pointer; display:flex; align-items:center; gap:8px; flex-wrap:wrap; border-bottom:1px solid rgba(255,255,255,0.04); }
.ol-vol-header:hover { background:rgba(255,255,255,0.02); }
.ol-vol-toggle { font-size:10px; color:var(--text2); width:14px; }
.ol-vol-title { font-size:14px; font-weight:600; color:#ddd; }
.ol-vol-meta { font-size:11px; color:var(--text2); }
.ol-vol-conn { font-size:10px; color:rgba(255,255,255,0.2); }
.ol-vol-btns { display:flex; gap:4px; margin-left:auto; }
.ol-btn-sm { padding:3px 10px; font-size:10px; border-radius:4px; cursor:pointer; border:0.5px solid var(--border); background:rgba(255,255,255,0.04); color:var(--text2); font-family:inherit; }
.ol-btn-sm:hover { color:#fff; background:rgba(255,255,255,0.08); }
.ol-confirm:hover { background:rgba(34,197,94,0.12); color:#22C55E; border-color:rgba(34,197,94,0.2); }
.ol-regenerate:hover { background:rgba(245,166,35,0.1); color:#F5A623; border-color:rgba(245,166,35,0.2); }

/* 批注 */
.ol-annotation { padding:8px 12px; background:rgba(245,166,35,0.05); border-bottom:1px solid rgba(245,166,35,0.1); }
.ol-annotation textarea { width:100%; min-height:50px; background:rgba(0,0,0,0.3); border:0.5px solid var(--border); border-radius:6px; color:#ddd; padding:8px; font-size:12px; font-family:inherit; resize:vertical; }

/* 章列表 */
.ol-chapters { }
.ol-chapter { padding:8px 12px 8px 28px; border-bottom:1px solid rgba(255,255,255,0.02); }
.ol-chapter:last-child { border-bottom:none; }
.ol-ch-header { display:flex; align-items:center; gap:8px; margin-bottom:4px; }
.ol-ch-num { font-size:11px; color:var(--text2); min-width:40px; }
.ol-ch-title { font-size:13px; color:#ddd; font-weight:500; }
.ol-ch-type { font-size:9px; padding:1px 6px; border-radius:3px; }
.ol-ch-type.major { background:rgba(245,63,63,0.1); color:#F53F3F; }
.ol-ch-type.minor { background:rgba(255,255,255,0.05); color:var(--text2); }
.ol-ch-characters { font-size:10px; color:rgba(255,255,255,0.25); margin-left:auto; }
.ol-ch-summary { font-size:11px; color:var(--text2); line-height:1.5; margin-bottom:4px; }
.ol-ch-foreshadow { font-size:10px; color:#F5A623; margin-top:2px; }

/* 事件条目 */
.ol-ch-events { margin-top:4px; }
.ol-event { display:flex; align-items:flex-start; gap:6px; padding:3px 0; font-size:11px; }
.ol-event-dot { width:6px; height:6px; border-radius:50%; margin-top:5px; flex-shrink:0; }
.ol-event.major .ol-event-dot { background:#F53F3F; }
.ol-event.minor .ol-event-dot { background:var(--text2); }
.ol-event.foreshadow .ol-event-dot { background:#F5A623; }
.ol-event.payoff .ol-event-dot { background:#22C55E; }
.ol-event-name { font-weight:500; color:#ddd; min-width:80px; }
.ol-event-desc { color:var(--text2); }
```

#### 浮动画布 JS 新增方法
```javascript
// FLOATING_CANVAS 模块新增方法

// 切换到大纲预览 tab
_openOutlinePreview: function() {
  // 隐藏 SVG viewport，显示 HTML outline preview
  document.getElementById('fc-viewport').style.display = 'none';
  var ol = document.getElementById('fc-outline-preview');
  if (!ol) {
    // 动态创建大纲预览容器
    ol = document.createElement('div');
    ol.id = 'fc-outline-preview';
    document.getElementById('fc-canvas').insertBefore(ol, document.getElementById('fc-info'));
  }
  ol.classList.add('show');
  this._loadOutlineData();
},

// 从 API 加载大纲数据
_loadOutlineData: function() {
  var self = this;
  var headers = { 'Authorization': 'Bearer ' + token };
  fetch(API + '/writing-projects/' + projectId + '/volumes', { headers: headers })
    .then(function(r) { return r.json(); })
    .then(function(volumes) {
      // 为每卷加载章节
      var promises = volumes.map(function(vol) {
        return fetch(API + '/writing-projects/' + projectId + '/chapters?volume_id=' + vol.id, { headers: headers })
          .then(function(r) { return r.json(); })
          .then(function(chapters) {
            vol.chapters = chapters;
            return vol;
          });
      });
      return Promise.all(promises);
    })
    .then(function(volumesWithChapters) {
      self._renderOutlinePreview(volumesWithChapters);
    })
    .catch(function(err) {
      self._log('outline', '加载大纲失败: ' + err.message, 'error');
    });
},

// 渲染大纲预览 HTML
_renderOutlinePreview: function(volumes) {
  var container = document.getElementById('fc-outline-preview');
  var html = '<div class="ol-actions">';
  html += '<button class="ol-btn ol-confirm-all" onclick="FLOATING_CANVAS.confirmOutline(\'all\')">✅ 确认全部卷</button>';
  html += '<button class="ol-btn ol-reject-all" onclick="FLOATING_CANVAS.rejectOutline()">🗑 推翻重来</button>';
  html += '<button class="ol-btn" onclick="FLOATING_CANVAS.exportOutline()">📥 导出JSON</button>';
  var confirmed = volumes.filter(function(v) { return v.status === 'confirmed'; }).length;
  html += '<span class="ol-status">已采纳 ' + confirmed + '/' + volumes.length + ' 卷</span>';
  html += '</div><div class="ol-volumes">';
  
  volumes.forEach(function(vol) {
    var isConfirmed = vol.status === 'confirmed';
    html += '<div class="ol-volume' + (isConfirmed ? ' confirmed' : '') + '" data-volume-id="' + vol.id + '">';
    html += '<div class="ol-vol-header" onclick="FLOATING_CANVAS._toggleVolume(' + vol.id + ')">';
    html += '<span class="ol-vol-toggle">▼</span>';
    html += '<span class="ol-vol-title">' + escHtml(vol.title || '未命名卷') + '</span>';
    html += '<span class="ol-vol-meta">' + (vol.chapters ? vol.chapters.length : 0) + '章</span>';
    html += '<span class="ol-vol-conn">衔接：' + escHtml(vol.summary || '').substring(0, 50) + '</span>';
    html += '<div class="ol-vol-btns" onclick="event.stopPropagation()">';
    if (!isConfirmed) {
      html += '<button class="ol-btn-sm ol-confirm" onclick="FLOATING_CANVAS.confirmVolume(' + vol.id + ')">✅ 采纳</button>';
      html += '<button class="ol-btn-sm ol-annotate" onclick="FLOATING_CANVAS._toggleAnnotation(' + vol.id + ')">✏️ 批注</button>';
      html += '<button class="ol-btn-sm ol-regenerate" onclick="FLOATING_CANVAS.regenerateVolume(' + vol.id + ')">🔄 重新生成</button>';
    } else {
      html += '<span style="font-size:10px;color:#22C55E">✅ 已采纳</span>';
    }
    html += '</div></div>';
    
    // 批注区
    html += '<div class="ol-annotation" id="ol-annot-' + vol.id + '" style="display:none" onclick="event.stopPropagation()">';
    html += '<textarea id="ol-annot-text-' + vol.id + '" placeholder="输入批注意见..."></textarea>';
    html += '<button class="ol-btn-sm" onclick="FLOATING_CANVAS.saveAnnotation(' + vol.id + ')">💾 保存批注</button>';
    html += '</div>';
    
    // 章节
    html += '<div class="ol-chapters" id="ol-chapters-' + vol.id + '">';
    if (vol.chapters) {
      vol.chapters.forEach(function(ch) {
        html += '<div class="ol-chapter">';
        html += '<div class="ol-ch-header">';
        html += '<span class="ol-ch-num">第' + ch.chapter_no + '章</span>';
        html += '<span class="ol-ch-title">' + escHtml(ch.title || '') + '</span>';
        html += '</div>';
        html += '<div class="ol-ch-summary">' + escHtml(ch.content_text || ch.summary || '').substring(0, 200) + '</div>';
        html += '</div>';
      });
    }
    html += '</div></div>';
  });
  
  html += '</div>';
  container.innerHTML = html;
},

// 展开/折叠卷
_toggleVolume: function(volId) {
  var chapters = document.getElementById('ol-chapters-' + volId);
  if (chapters) chapters.style.display = chapters.style.display === 'none' ? '' : 'none';
},

// 展开/折叠批注
_toggleAnnotation: function(volId) {
  var annot = document.getElementById('ol-annot-' + volId);
  if (annot) annot.style.display = annot.style.display === 'none' ? '' : 'none';
},

// 确认单卷
confirmVolume: function(volId) {
  var self = this;
  api('PUT', '/writing-projects/' + projectId + '/volumes/' + volId, { status: 'confirmed' })
    .then(function() { self._log('outline', '卷' + volId + '已确认'); self._loadOutlineData(); });
},

// 确认全部卷
confirmOutline: function() {
  var self = this;
  showConfirm('确认全部大纲？确认后将写入数据库并通知编排师', function() {
    api('POST', '/writing-projects/' + projectId + '/outline/confirm-all', {})
      .then(function() {
        self._log('outline', '全部大纲已确认');
        self.close();
        // 通知编排师大纲已确认
        sendAgentMessage('大纲已确认，继续后续流程');
      });
  });
},

// 推翻全部
rejectOutline: function() {
  var self = this;
  showConfirm('确定推翻全部大纲？此操作不可恢复', function() {
    api('POST', '/writing-projects/' + projectId + '/outline/reject-all', {})
      .then(function() {
        self._log('outline', '全部大纲已推翻');
        self.close();
        sendAgentMessage('大纲已推翻，请重新规划');
      });
  });
},

// 重生成单卷
regenerateVolume: function(volId) {
  var self = this;
  var annotText = document.getElementById('ol-annot-text-' + volId);
  var notes = annotText ? annotText.value : '';
  api('POST', '/writing-projects/' + projectId + '/volumes/' + volId + '/regenerate', { notes: notes })
    .then(function() {
      self._log('outline', '卷' + volId + '重生成已启动');
      setTimeout(function() { self._loadOutlineData(); }, 3000);
    });
},

// 保存批注
saveAnnotation: function(volId) {
  var text = document.getElementById('ol-annot-text-' + volId).value;
  api('PUT', '/writing-projects/' + projectId + '/volumes/' + volId, { notes: text })
    .then(function() {
      toast('批注已保存');
      FLOATING_CANVAS._toggleAnnotation(volId);
    });
},

// 导出
exportOutline: function() {
  api('GET', '/writing-projects/' + projectId + '/outline/export')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'outline_' + projectId + '.json';
      a.click(); URL.revokeObjectURL(url);
    });
}
```

### 卷 Agent System Prompt（OUTLINER_VOLUME_SYSTEM）
```
你是小说卷大纲生成专家。你将收到一个卷蓝图（含卷主题、核心冲突、关键节点、衔接约束），以及完整的项目上下文（世界观实体、角色档案、故事蓝图）。你的任务是将卷蓝图展开为详细的卷大纲。

## 输出格式
严格输出以下JSON（不要加任何解释文字）：
```json
{
  "卷名": "第一卷：因果初醒",
  "卷概要": "200-300字，本卷的完整剧情弧线。包含：开端状态→冲突升级→关键转折→卷末状态。描述主角在本卷中的成长变化。",
  "时间锚点": {
    "纪元名称": "灵气复苏元年",
    "绝对年份": 0,
    "势力历法": {"青云宗": "开宗第300年", "魔教": "黑暗纪元第7年"}
  },
  "章": [
    {
      "章名": "第1章 山洞奇遇",
      "概要": "150-200字。本章发生的具体事件，包括场景、冲突、转折、结果。不是简单的'发生了什么'，而是'怎么发生的、造成了什么后果'。",
      "关键事件": [
        {
          "事件名": "获得因果道器",
          "详细描述": "林云在采药时坠入古洞，发现青铜道器。触碰后道器融入体内，浮现因果法则信息。守护兽苏醒测试继承者资格。林云在绝境中无意识运用因果推断能力，预判攻击轨迹，艰难通过测试。代价：左臂留下永久的因果刻痕。",
          "事件类型": "major",
          "涉及角色": ["林云", "守护兽（上古傀儡）"],
          "伏笔标记": "道器符文与仙界遗迹铭文相同——为第七卷埋线"
        }
      ],
      "涉及角色": ["林云", "守护兽"]
    }
  ]
}
```

## 创作要求
1. **详细但不冗余**：每章概要150-200字，必须包含：场景设定、核心冲突、关键转折、结果和影响
2. **因果链清晰**：每章的事件要有前因后果，不能是孤立的事件列表
3. **角色驱动**：事件是由角色的选择和行动推动的，不是"突然发生"
4. **伏笔意识**：注意卷蓝图中规划的伏笔，在对应章节中埋设线索
5. **卷内弧线**：本卷的12章（举例）应形成一个小型的"起承转合"
6. **衔接约束**：严格遵循卷蓝图的衔接要求（承接上一卷的铺垫、为下一卷埋线）
7. **字数对齐**：每章概要的详细程度应对应约3000-5000字的实际写作内容

## 事件类型说明
- major：核心转折点，不可跳过，会改变故事走向
- minor：日常过渡，推动剧情但不改变大方向
- foreshadow：伏笔埋设，暗示后续剧情
- payoff：伏笔回收，揭示之前的线索
```

### 多智能体编排实现（server.js executeToolAsync 新分支）
```javascript
// generate_outline_multi 工具处理
} else if (tl.indexOf('generate_outline_multi') >= 0 || (tl.indexOf('outline') >= 0 && tl.indexOf('multi') >= 0)) {
    // 检查前置条件
    var stageCheck = _checkStagePrerequisites(projectId, 'outline');
    if (!stageCheck.passed) {
        resolve({ error: stageCheck.error, summary: '前置条件不满足：' + stageCheck.missing.join('、') });
        return;
    }
    
    // 获取卷蓝图（从蓝图或上下文）
    var volumeBlueprint = _getVolumeBlueprint(projectId);
    if (!volumeBlueprint || !volumeBlueprint.卷蓝图 || !volumeBlueprint.卷蓝图.length) {
        resolve({ error: '缺少卷蓝图，请先在阶段四完成卷蓝图规划', summary: '缺少卷蓝图' });
        return;
    }
    
    // 组装共享上下文
    var sharedContext = _buildSharedOutlineContext(projectId);
    
    // 并行卷Agent生成
    var volumes = volumeBlueprint.卷蓝图;
    var concurrency = 3; // 最多3个并发
    var results = [];
    var allChapters = [];
    
    // 分批并行处理
    for (var batch = 0; batch < volumes.length; batch += concurrency) {
        var batchVolumes = volumes.slice(batch, batch + concurrency);
        var batchPromises = batchVolumes.map(function(volBlueprint, idx) {
            return _generateSingleVolumeOutline(
                projectId, userId, volBlueprint, sharedContext, 
                batch + idx, volumes.length, streamCallback
            );
        });
        var batchResults = await Promise.all(batchPromises);
        results = results.concat(batchResults);
        
        // 发送进度通知
        var completedCount = Math.min(batch + concurrency, volumes.length);
        res.write('data: ' + JSON.stringify({
            type: 'outline_progress',
            completed: completedCount,
            total: volumes.length
        }) + '\n\n');
    }
    
    // 写入数据库
    var savedVolumes = [];
    results.forEach(function(result) {
        if (result.error) return;
        var vid = dbRun('INSERT INTO writing_volumes (project_id, volume_no, title, summary, status) VALUES (?,?,?,?,?)',
            [projectId, result.data.卷号, result.data.卷名, result.data.卷概要, 'draft']);
        (result.data.章 || []).forEach(function(chap) {
            var cid = dbRun('INSERT INTO writing_chapters (project_id, volume_id, chapter_no, title, content_text, status) VALUES (?,?,?,?,?,?)',
                [projectId, vid, chap.章号, chap.章名, chap.概要, 'draft']);
            // 提取关键事件到 plot_timeline_events
            (chap.关键事件 || []).forEach(function(evt) {
                dbRun('INSERT INTO plot_timeline_events (project_id, event_name, summary, character_ids, chapter_id, absolute_year, era_name, event_type) VALUES (?,?,?,?,?,?,?,?)',
                    [projectId, evt.事件名, evt.详细描述 || '', JSON.stringify(evt.涉及角色 || []), cid,
                     result.data.时间锚点 ? result.data.时间锚点.绝对年份 : null,
                     result.data.时间锚点 ? result.data.时间锚点.纪元名称 : '',
                     evt.事件类型 || 'minor']);
            });
        });
        savedVolumes.push({ id: vid, title: result.data.卷名, chapterCount: (result.data.章 || []).length });
    });
    
    saveDB();
    
    // 汇总检查一致性
    var consistencyReport = _checkOutlineConsistency(results, volumeBlueprint);
    
    // 发送完成事件
    res.write('data: ' + JSON.stringify({
        type: 'outline_draft_ready',
        projectId: projectId,
        volumes: savedVolumes,
        totalChapters: allChapters.length,
        consistency: consistencyReport
    }) + '\n\n');
    
    resolve({
        result: JSON.stringify(savedVolumes),
        summary: '已生成 ' + savedVolumes.length + ' 卷大纲，共 ' + allChapters.length + ' 章',
        outlineDraft: true // 标记：不写入对话历史
    });
}
```

### 新增 API 端点汇总

| 端点 | 方法 | 说明 |
|------|------|------|
| `GET /api/writing-projects/:id/stage-status` | GET | 返回当前阶段 + 各表数据量 + 前置条件完成情况 |
| `PUT /api/writing-projects/:id/volumes/:vid` | PUT | 更新卷（status=confirmed, notes等） |
| `PUT /api/writing-projects/:id/volumes/:vid/annotate` | PUT | 保存卷批注 |
| `POST /api/writing-projects/:id/volumes/:vid/regenerate` | POST | 重新生成单卷（带批注） |
| `POST /api/writing-projects/:id/outline/confirm-all` | POST | 确认全部卷（draft→confirmed） |
| `POST /api/writing-projects/:id/outline/reject-all` | POST | 推翻全部卷（draft→rejected） |
| `GET /api/writing-projects/:id/outline/export` | GET | 导出大纲JSON |

### 完成标志
- [ ] 所有卷 status='confirmed'
- [ ] plot_timeline_events 表 ≥ 卷数×3 条事件
- [ ] 用户确认了全部大纲
- [ ] 蓝图 outline_progress 已更新

### 涉及改动
| 文件 | 改动 | 工作量 |
|------|------|--------|
| server.js | OUTLINER_VOLUME_SYSTEM System Prompt（约+60行） | 中 |
| server.js | executeToolAsync 新增 generate_outline_multi 分支（约+120行） | 大 |
| server.js | _buildSharedOutlineContext 函数（约+30行） | 中 |
| server.js | _generateSingleVolumeOutline 函数（约+50行） | 中 |
| server.js | _checkOutlineConsistency 函数（约+40行） | 中 |
| server.js | 阶段门控：_checkStagePrerequisites 函数（约+35行） | 中 |
| server.js | 新增 7 个 API 端点（约+100行） | 中 |
| server.js | 编排师 System Prompt 补充阶段五规则（约+20行） | 小 |
| write.html | 大纲预览 tab CSS（约+80行） | 中 |
| write.html | 浮动画布新增"📋 大纲预览"tab 按钮 | 小 |
| write.js | FLOATING_CANVAS 大纲预览模块（约+200行） | 大 |
| write.js | SSE outline_draft_ready + outline_progress 事件处理（约+40行） | 中 |
| DB | writing_volumes 加 status/notes 字段（已预留） | 小 |

---

## 实施顺序

### 第一轮（基础）：阶段门控 + 编排师 System Prompt 全面升级 + 双语调试日志
- 修改 ORCHESTRATOR_SYSTEM，加入五阶段规则和行为约束（约+120行）
- 新增 `_checkStagePrerequisites()` 函数
- 新增 `GET /api/writing-projects/:id/stage-status` 端点
- **全量添加双语调试日志**：所有阶段切换、工具调用、门控检查均输出 `中文描述 | English description` 格式的 `broadcastDevLog` 日志

### 第二轮（阶段二+三增强）：世界观和角色上下文注入 + Python命名表
- CHARACTER_SYSTEM 增强（世界观上下文注入 + 金手指字段）
- executeToolAsync 角色分支增强
- `scripts/generate_name_pool.py` 命名表生成脚本
- `public/name_pool.json` 命名表数据文件
- 已完成的浮动画布世界观树和星座图已验证

### 第三轮（阶段四+五核心）：卷蓝图规划 + 多智能体大纲生成
- 编排师 System Prompt 阶段四（起承转合 + 4卷约束）
- plan_volume_blueprint 工具处理程序
- OUTLINER_VOLUME_SYSTEM System Prompt
- generate_outline_multi 工具处理程序（4卷并行）
- _buildSharedOutlineContext + _generateSingleVolumeOutline
- 时间线事件提取到 plot_timeline_events

### 第四轮（阶段五前端）：浮动画布大纲预览
- write.html CSS + "📋 大纲预览" tab 按钮
- write.js 大纲预览模块（含起承转合展示）
- SSE outline_draft_ready + outline_progress 事件处理
- 确认/批注/推翻/导出交互

### 第五轮（串联）：端到端测试和打磨
- 完整流程测试（阶段一→二→三→四→五）
- 错误处理和降级
- 性能优化（4卷并发数调节、超时处理）
- 开发者日志完善

---

## 全局：双语调试日志规范

所有服务端关键操作必须输出双语调试日志，通过 `broadcastDevLog(level, source, msg)` 发送到前端开发者日志面板。

### 日志格式
```
[模块名] 中文描述 | English description
```

### 各阶段日志示例
```
阶段一：
[Stage1] 需求采访开始 | Interview started
[Stage1] 用户选择类型：玄幻 | User selected genre: Xuanhuan
[Stage1] 需求摘要已生成 字数=180 | Summary generated words=180
[Stage1] 阶段一完成→进入阶段二 | Stage 1 complete → Stage 2

阶段二：
[Stage2] 世界观构建开始 | Worldbuilding started
[Stage2] 第1问：世界名称与规模 | Q1: World name and scale
[Stage2] 用户回答：沧玄界 单大陆+秘境 | User answered: Cangxuan Realm single continent+secret realms
[Stage2] 调用design_worldview | Calling design_worldview
[Worldview] 实体入库: 沧玄界 type=世界 id=1 | Entity saved: Cangxuan Realm type=World id=1
[Stage2] 阶段二完成 实体=15 关系=8 | Stage 2 complete entities=15 relations=8

阶段三：
[Stage3] 角色设计开始 | Character design started
[Stage3] 第1问：主角身份 | Q1: Protagonist identity
[Stage3] 第2问：主角金手指 | Q2: Protagonist's golden finger
[Stage3] 触发命名表生成 | Triggering name pool generation
[Stage3] 主角已确认：林云 id=5 | Protagonist confirmed: Lin Yun id=5
[Stage3] 阶段三完成 角色=4 关系=6 | Stage 3 complete characters=4 relations=6

阶段四：
[Stage4] 卷蓝图规划开始 | Volume blueprint planning started
[Stage4] 计算卷数：100万字÷3100字/章≈322章→4卷 | Calculating: 1M words÷3100/ch≈322ch→4vol
[Stage4] 第一卷起承转合已分配 (80章) | Vol 1 structure assigned (80ch)
[Stage4] plan_volume_blueprint 已保存 | plan_volume_blueprint saved
[Stage4] 阶段四完成 4卷 | Stage 4 complete 4 volumes

阶段五：
[Stage5] 大纲生成开始 4卷 | Outline generation started 4 volumes
[Stage5] 前置条件检查通过 | Prerequisites check passed
[Stage5] 并行启动卷Agent 1-3 | Starting parallel volume agents 1-3
[Stage5] 卷1完成 80章 | Volume 1 complete 80 chapters
[Stage5] 全部卷Agent完成 总320章 | All volume agents complete total 320 chapters
[Stage5] 时间线事件已提取 | Timeline events extracted
[Stage5] 大纲已推送到前端（draft状态）| Outline pushed to frontend (draft)
```

### 涉及文件
| 文件 | 新增日志量 |
|------|-----------|
| server.js executeToolAsync | 约+30条 broadcastDevLog |
| server.js _buildAssembledContext | 约+10条 |
| server.js _incrementalUpdateBlueprint | 约+8条 |
| server.js _callSubAgentLLM | 约+5条 |

---

## 总工作量估算（更新后）

| 轮次 | 服务端 | 前端 | Python | 合计 |
|------|--------|------|--------|------|
| 第一轮 | ~180行 | 0行 | 0行 | ~180行 |
| 第二轮 | ~80行 | 0行 | ~120行 | ~200行 |
| 第三轮 | ~400行 | 0行 | 0行 | ~400行 |
| 第四轮 | ~120行 | ~300行 | 0行 | ~420行 |
| 第五轮 | ~60行 | ~40行 | 0行 | ~100行 |
| **合计** | **~840行** | **~340行** | **~120行** | **~1300行** |
