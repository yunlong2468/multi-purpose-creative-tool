# 无限画布 (Infinite Canvas)

面向 AI 动漫制作的无限画布系统，支持剧本拆分、分镜关键帧生成、AI 生图、资产管理的全流程工作台。

## 技术栈

| 层 | 技术 |
|---|------|
| 后端 | Node.js + Express (~3000行) |
| 数据库 | SQL.js (SQLite 文件持久化) |
| 前端 | 原生 HTML/CSS/JS (~4000行) |
| 认证 | JWT + session_token 多设备互踢 |
| 实时 | SSE (Server-Sent Events) 流式推送 |
| LLM | OpenAI 兼容 API (DeepSeek/OpenAI/自定义) |
| 爬虫 | Python 3.10+ Scrapling + Playwright CDP + fontTools字形解码 |
| 多智能体 | 编排器 + 大纲/角色/爬虫/技能优化子智能体 + 动态工具 |

## 快速开始（零基础也能上手）

### 方式一：一键安装（推荐）

1. 双击项目根目录下的 **`setup.bat`**
2. 脚本会自动检测环境、安装依赖、启动服务
3. 浏览器访问 **http://localhost:3001**

> 首次运行会下载 Scrapling 浏览器依赖（约 300MB），请保持网络畅通。

### 方式二：手动安装

#### 第一步：安装 Node.js

Node.js 是让电脑运行 JavaScript 程序的工具，所有操作都需要它。

1. 打开浏览器，访问 **https://nodejs.org**
2. 点击左侧绿色的 **LTS** 按钮（长期稳定版），下载安装包
3. 双击下载的 `.msi` 文件，一路点 **Next** 直到完成
4. 验证安装：按 `Win+R`，输入 `cmd` 回车，输入以下命令：
   ```
   node --version
   ```
   如果显示 `v20.x.x` 或 `v22.x.x`，说明安装成功

> **Mac 用户**：下载 `.pkg` 文件，双击安装即可。终端 (`Cmd+空格 → 输入 Terminal`) 中输入 `node --version` 验证。

### 第二步：下载项目

**方式一（推荐，无需 git）**：
1. 打开 https://github.com/yunlong2468/infinite-canvas-
2. 点击绿色 **Code** 按钮 → **Download ZIP**
3. 解压到你喜欢的文件夹（如 `D:\无限画布`）

**方式二（会 git 的用户）**：
```bash
git clone https://github.com/yunlong2468/infinite-canvas-.git
```

### 第三步：安装依赖

1. 按 `Win+R`，输入 `cmd` 回车，打开命令提示符
2. 进入项目文件夹（把路径换成你实际解压的位置）：
   ```
   cd "D:\无限画布"
   ```
3. 安装依赖包：
   ```
   npm install
   ```
   看到 `added XX packages` 就完成了。

#### 第四步（可选）：安装 Python 爬虫依赖

> **不装也能用！** 缺少 Python 时，爬虫功能自动降级为 Node.js 原生请求，不影响其他功能。

写作模块的"爬取参考书籍"功能需要 Scrapling（自适应爬虫框架）提供更好的反爬能力：

1. 安装 **Python 3.10+**：https://www.python.org/downloads/
   - 安装时务必勾选 **"Add Python to PATH"**
2. 在项目目录下运行：
   ```
   pip install -r requirements.txt
   scrapling install
   ```
3. `scrapling install` 会下载 Chromium 浏览器（约 300MB），仅在爬取需 JS 渲染的网站时使用。

> **🍅 番茄小说特别说明**：该平台使用了字节跳动安全 SDK，普通爬取无法获取数据。
> 需要以 **CDP 调试模式** 启动 Chrome 后爬取：
> ```
> chrome.exe --remote-debugging-port=9222
> ```
> 启动后保持 Chrome 窗口打开，再在写作页面发起爬取即可自动连接。

#### 第五步：启动服务

在同一个命令提示符窗口中继续输入：
```
node server.js
```
看到以下输出就成功了：
```
🎨 无限画布 本地后端已启动
本机访问: http://localhost:3001
```

> **关闭服务**：在命令提示符窗口按 `Ctrl+C`，下次使用重复本步即可。

### 第六步：打开画布

浏览器访问 **http://localhost:3001**，注册账号即可开始使用。

> **关闭服务**：在命令提示符窗口按 `Ctrl+C`，下次使用重复第四步即可。
> **局域网共享**：把控制台显示的局域网地址（如 `http://192.168.x.x:3001`）发给同一 WiFi 下的其他人即可。首次使用需以管理员身份运行：`netsh advfirewall firewall add rule name="无限画布3001" dir=in action=allow protocol=TCP localport=3001`

首次启动会自动创建数据库、导入默认分镜生成技能（SKILL）。

## 已实现功能

### 画布核心
- [x] DOM 无限画布（平移、缩放、焦点适配全部节点）
- [x] 5 种节点类型：剧本拆分、帧分析、图片、视频、便签
- [x] 节点连线系统（DFS 环路检测）
- [x] 节点自动编号/标记
- [x] 框选多节点
- [x] 图层 z-index 管理
- [x] 右键上下文菜单
- [x] 版本历史（日历 + 分页）

### 剧本拆分节点
- [x] 文本输入/输出
- [x] 智能体选择
- [x] LLM 拆分执行（AbortController 可取消）
- [x] 流光进度条

### 帧分析节点
- [x] 上游连接检测（实时查找已连接且有输出的剧本节点）
- [x] 智能体选择 + SKILL 匹配
- [x] LLM 生成关键帧 JSON
- [x] 帧表格预览（内联表格 + 全屏模态弹窗）
- [x] JSON 解析失败提示 + 原始响应查看
- [x] 快照保存/加载
- [x] 生成图（单帧生图）
- [x] 参考帧/参考图/风格选择
- [x] 提示词语言：中文，不含画面比例

### AI 生图
- [x] yijiarj image2 API 集成
- [x] base64 参考图传入
- [x] 多种尺寸（1:1, 9:16 竖屏, 16:9 等）
- [x] 风格系统（创建/发布/收藏/评论/点赞）
- [x] 风格市场 SSE 实时同步
- [x] 封面上传（16:9 校验）
- [x] 生图进度/取消/重试
- [x] 生图结果自动入库资产库（MD5 去重）

### 资产库
- [x] 左侧 48px 侧边栏
- [x] 320px 滑出面板，时间分组（今天/昨天/本周/本月/更早）
- [x] MD5 去重上传
- [x] 拖拽上传
- [x] 大图预览 + 下载
- [x] 删除资产联级移除画布节点

### 图片节点
- [x] 双击弹出图片来源选择弹窗（左侧上传 + 右侧资产库网格）
- [x] 右键放大查看（全屏预览 + 下载原图）
- [x] 连接参考图传 base64 至生图 API

### 用户体验
- [x] 自定义 toast/confirm/prompt（无浏览器原生弹窗）
- [x] 退出登录二次确认
- [x] 登录跳转 projects.html
- [x] 进入画布自动适配全部节点
- [x] 剪贴板系统：Ctrl+C 复制 / Ctrl+X 剪切 / Ctrl+V 粘贴（自动 ID 映射 + 连线保留）
- [x] 撤销系统：Ctrl+Z 快照式撤销（最多 25 步，仅高亮被恢复的节点）
- [x] Shift+点击取消多选 / Shift+点击任意区域选中节点
- [x] 已选中节点可从文本区/按钮/帧表格任意位置拖拽

### 账号安全
- [x] JWT 登录/注册
- [x] session_token 多设备互踢
- [x] SSE 实时踢出通知（秒级感知）
- [x] 项目归属校验 (withProject 中间件)

### 局域网共享
- [x] 启动日志显示局域网 IP
- [x] `JWT_SECRET` 支持环境变量覆盖

### 写作模块（AI 辅助小说创作）
- [x] 多智能体协作：调配师 + 大纲师 + 角色设计 + 爬虫 + 动态技能工具
- [x] 分卷分章大纲生成与管理
- [x] 角色档案自动生成（LLM JSON 提取 + DB 持久化）
- [x] 角色关系图谱 + 伏笔追踪
- [x] 章节编辑器（自动保存 + 版本快照）
- [x] 智能体流式对话 + 思考计时器 + 牛马碎碎念轮播
- [x] 平台小说爬取（番茄/起点/晋江/纵横等 11 个平台）
- [x] Scrapling CDP 浏览器自动化（绕过字节跳动反爬 SDK）
- [x] PUA 自定义字体字形解码（破解字体反爬乱码）
- [x] 人机验证码浮动通知 + 自动等待
- [x] 撤销恢复（撤回对话同步回滚章/卷/角色）
- [x] LLM 多轮工具调用 + 子智能体 request_tool 递归

### 爬虫架构（三级降级）

```
平台请求
  ├─ CDP 模式（番茄等强反爬）→ 真实Chrome → page.content() → 字形解码
  ├─ Scrapling 桥接（HTTP TLS伪装）→ Python Fetcher → HTML
  └─ 原生 Node.js fetch（兜底）→ 标准HTTP请求
```

---

## 开发计划

### 🔜 短期（v1.2）

| 功能 | 说明 | 状态 |
|------|------|------|
| 撤销/重做 | Ctrl+Z / Ctrl+Y 画布操作历史 | ✅ |
| 批量生图 | 帧节点一键生成所有关键帧图片 | ⬜ |
| 图片裁剪 | 节点内裁剪工具，固定比例裁切 | ⬜ |
| 节点编组 | 多节点合并为组，统一移动/复制 | ⬜ |
| 键盘快捷键 | Ctrl+C/X/V/Z 剪贴板+撤销 | ✅ |
| 项目模板 | 预设画布模板快速创建 | ⬜ |

### 📅 中期（v1.3）

| 功能 | 说明 | 状态 |
|------|------|------|
| 分镜时间轴 | 横向时间轴视图，关键帧按时间排列 | ⬜ |
| 翻页书预览 | 多帧连续播放动画预览 | ⬜ |
| 视频节点播放 | 内嵌视频播放器 + 截帧功能 | ⬜ |
| 协作编辑 | WebSocket 多用户实时协作 | ⬜ |
| 云端备份 | GitHub/Gitee 自动备份画布数据 | ⬜ |
| 导出功能 | 导出画布为图片/PDF/JSON | ⬜ |

### 🚀 长期（v2.0+）

| 功能 | 说明 | 状态 |
|------|------|------|
| 插件系统 | 第三方插件扩展 | ⬜ |
| AI 辅助分镜 | LLM 从文字剧本直接生成分镜脚本 | ⬜ |
| 角色库 | 角色设定集中管理，自动匹配生图 | ✅ |
| 小说爬虫 | 多平台热门书籍爬取参考 | ✅ |
| 多智能体写作 | 编排器+子智能体协同创作 | ✅ |
| CDP 浏览器自动化 | 绕过强反爬网站保护 | ✅ |
| 字体反爬解码 | 字形比对破解PUA乱码 | ✅ |
| 移动端适配 | 响应式布局，平板可用 | ⬜ |
| 外部工具对接 | AE/PR/ComfyUI 工作流集成 | ⬜ |

---

## 项目结构

```
新-无限画布本地部署/
├── server.js              # Express 后端 (~6000行)
├── package.json           # Node.js 依赖声明
├── requirements.txt       # Python 依赖声明（Scrapling爬虫）
├── setup.bat              # Windows 一键环境安装脚本
├── chrome_debug.bat       # Chrome CDP调试模式启动器
├── scraper_bridge.py      # Scrapling → Node.js 爬虫桥接
├── glyph_decoder.py       # PUA字体字形解码器（破解反爬乱码）
├── public/
│   ├── canvas.html        # 画布主页面
│   ├── write.html         # 写作页面（多智能体聊天）
│   ├── write.js           # 写作前端逻辑 (~2800行)
│   ├── projects.html      # 项目列表
│   ├── agents.html        # 智能体管理
│   ├── settings.html      # 生图 API 设置
│   └── login.html         # 登录/注册
├── SKILL/
│   └── storyboard-keyframe-generator/
│       ├── SKILL.md       # 分镜关键帧生成提示词规范
│       └── references/
├── uploads/               # 上传文件（gitignore）
└── data.db                # SQLite 数据库（gitignore）
```

## 配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT` | 3001 | 服务端口 |
| `JWT_SECRET` | 内置默认值 | JWT 签名密钥 |

## License

MIT
