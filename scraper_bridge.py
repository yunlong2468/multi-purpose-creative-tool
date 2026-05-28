"""
Scrapling 桥接脚本 — 供 Node.js 爬虫智能体调用。

用法:
  python scraper_bridge.py --url <URL> [--platform <平台名>]
  python scraper_bridge.py --url <URL> --cdp   (CDP模式：连真实Chrome)

CDP 模式下 stdout 逐行输出 JSON 事件（实时状态推送）：
  {"event":"status","phase":"..."}
  {"event":"captcha","phase":"detected"}
  {"event":"captcha","phase":"solved"}
  {"event":"result","ok":true/false,...}

非CDP模式输出单行 JSON 结果。
"""
import os
import re
import sys
import json
import time
import argparse
import subprocess
import urllib.request
from scrapling.fetchers import Fetcher

# ==================== 配置 ====================

PLATFORM_CONFIG = {
    "番茄": {
        "impersonate": "chrome", "stealthy_headers": True, "timeout": 20,
        "cdp": True,
    },
    "起点": {
        "impersonate": "chrome", "stealthy_headers": True, "timeout": 20,
    },
    "晋江": {
        "impersonate": "chrome", "stealthy_headers": True, "timeout": 20,
        "encoding_hint": "gbk",
    },
    "飞卢": {
        "impersonate": "chrome", "stealthy_headers": True, "timeout": 20,
    },
    "七猫": {
        "impersonate": "chrome", "stealthy_headers": True, "timeout": 20,
    },
    "纵横": {
        "impersonate": "chrome", "stealthy_headers": True, "timeout": 20,
    },
}

DEFAULT_CONFIG = {
    "impersonate": "chrome", "stealthy_headers": True, "timeout": 20,
}

MAX_HTML_LENGTH = 80000
ENCODING_HINTS = ["utf-8", "gbk", "gb2312", "gb18030", "latin-1"]

CDP_URL = "http://127.0.0.1:9222"
CDP_WAIT_SECONDS = 30
CDP_POLL_INTERVAL = 2
CDP_CAPTCHA_TIMEOUT = 300  # 验证码等待最长5分钟

_CHROME_PATHS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]
_CDP_USER_DATA = r"C:\temp\chrome-debug-profile"


# ==================== 输出辅助 ====================

def _emit(event: dict):
    """向 stdout 输出一行 JSON 事件并立即刷新"""
    line = json.dumps(event, ensure_ascii=False)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


# ==================== 编码工具 ====================

def _decode_body(body_bytes: bytes, encoding_hint: str = None) -> str:
    candidates = []
    if encoding_hint:
        candidates.append(encoding_hint)
    candidates.extend(ENCODING_HINTS)
    best_html = ""
    for enc in candidates:
        try:
            decoded = body_bytes.decode(enc, errors="replace")
            if len(decoded) > len(best_html):
                best_html = decoded
        except Exception:
            pass
    return best_html


# ==================== 非CDP模式抓取 ====================

def _find_font_url_deep(html: str) -> list:
    """深度搜索所有字体URL：先搜HTML直链，再下载CSS文件搜@font-face"""
    urls = []
    # 第1步：直接从HTML搜woff2直链
    urls.extend(re.findall(r"(https?://[^\"'\s]+\.woff2)", html, re.I))

    # 第2步：下载所有CSS文件搜woff2
    css_urls = re.findall(r'<link[^>]+href="([^"]+\.css[^"]*)"', html, re.I)
    for css_url in css_urls:
        if css_url.startswith("//"):
            css_url = "https:" + css_url
        try:
            req = urllib.request.Request(css_url, headers={"User-Agent": "Mozilla/5.0"})
            css_text = urllib.request.urlopen(req, timeout=8).read().decode("utf-8", errors="replace")
            found = re.findall(r"url\([\"']?(https?://[^\"')\s]+\.woff2)[\"']?\)", css_text, re.I)
            urls.extend(found)
        except Exception:
            pass

    # 第3步：搜 style 标签内的@font-face
    style_blocks = re.findall(r'<style[^>]*>([\s\S]*?)</style>', html, re.I)
    for sb in style_blocks:
        found = re.findall(r"url\([\"']?(https?://[^\"')\s]+\.woff2)[\"']?\)", sb, re.I)
        urls.extend(found)

    # 去重
    seen = set()
    return [u for u in urls if not (u in seen or seen.add(u))]


def _decode_font_if_needed(html: str) -> str:
    """深度搜索所有字体URL，逐一解码，合并映射后应用到HTML"""
    try:
        from glyph_decoder import decode_font, apply_mapping
        font_urls = _find_font_url_deep(html)
        if not font_urls:
            print("[Bridge] 非CDP模式未找到字体URL", file=sys.stderr, flush=True)
            return html
        print(f"[Bridge] 非CDP模式找到 {len(font_urls)} 个字体URL", file=sys.stderr, flush=True)
        # 逐字体解码，合并映射
        merged = {}
        for fu in font_urls:
            print(f"[Bridge] 解码字体: {fu[:100]}", file=sys.stderr, flush=True)
            _emit({"event": "debug", "msg": f"字体URL: {fu[:100]}"})
            try:
                m = decode_font(fu, timeout=15)
                if m:
                    dc = sum(1 for v in m.values() if v != '□')
                    print(f"[Bridge]   映射: {dc}/{len(m)}字", file=sys.stderr, flush=True)
                    merged.update(m)
            except Exception as e:
                print(f"[Bridge]   解码异常: {e}", file=sys.stderr, flush=True)
        if merged:
            total_dc = sum(1 for v in merged.values() if v != '□')
            print(f"[Bridge] 合并映射: {total_dc}/{len(merged)}字", file=sys.stderr, flush=True)
            _emit({"event": "debug", "msg": f"合并解码{total_dc}/{len(merged)}字"})
            return apply_mapping(html, merged)
        else:
            print("[Bridge] 所有字体解码返回空映射", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"[Bridge] 字体解码异常: {e}", file=sys.stderr, flush=True)
    return html


def fetch_page(url: str, platform: str) -> dict:
    cfg = PLATFORM_CONFIG.get(platform, DEFAULT_CONFIG)
    try:
        page = Fetcher.get(
            url,
            impersonate=cfg.get("impersonate", "chrome"),
            stealthy_headers=cfg.get("stealthy_headers", True),
            timeout=cfg.get("timeout", 20),
        )
        body_bytes = getattr(page, "body", None)
        if body_bytes is None or not isinstance(body_bytes, bytes):
            return {"ok": False, "error": f"Scrapling 响应无 body 数据", "url": url}
        html = _decode_body(body_bytes, cfg.get("encoding_hint"))
        if not html or len(html) < 50:
            return {"ok": False, "error": f"解码后内容过短(长度={len(html)})", "url": url}
        # 非CDP模式也做字体解码
        html = _decode_font_if_needed(html)
        if len(html) > MAX_HTML_LENGTH:
            html = html[:MAX_HTML_LENGTH]
        return {"ok": True, "html": html, "url": url}
    except Exception as e:
        return {"ok": False, "error": str(e), "url": url}


# ==================== CDP Chrome 管理 ====================

def _is_cdp_ready() -> bool:
    try:
        req = urllib.request.Request(f"{CDP_URL}/json/version", method="GET")
        urllib.request.urlopen(req, timeout=2)
        return True
    except Exception:
        return False


def _auto_start_chrome() -> bool:
    """启动 Chrome 调试模式。端口已监听则跳过；否则启动新实例（独立用户目录，不杀旧进程）"""
    if _is_cdp_ready():
        return True
    chrome_exe = None
    for candidate in _CHROME_PATHS:
        if os.path.exists(candidate):
            chrome_exe = candidate
            break
    if not chrome_exe:
        return False
    # 不杀旧 Chrome——用独立 user-data-dir 确保新实例独立运行
    try:
        subprocess.Popen(
            [chrome_exe, f"--remote-debugging-port={CDP_URL.rsplit(':',1)[-1]}",
             f"--user-data-dir={_CDP_USER_DATA}",
             "--no-first-run", "--no-default-browser-check"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception:
        return False
    for _ in range(15):
        time.sleep(1)
        if _is_cdp_ready():
            return True
    return False


# ==================== CDP 模式抓取（实时事件输出） ====================

_CAPTCHA_JS = (
    # 多策略检测人机验证弹窗
    "(function(){"
    # 策略1：检测验证码iframe（geetest、滑块等常见类型）
    "var ifs=document.querySelectorAll('iframe');"
    "for(var i=0;i<ifs.length;i++){"
    "  var s=ifs[i].src||'';"
    "  if(s.indexOf('captcha')>=0||s.indexOf('verify')>=0||s.indexOf('geetest')>=0||"
    "     s.indexOf('sec')>=0||s.indexOf('challenge')>=0){"
    "    var d=window.getComputedStyle(ifs[i]).display;"
    "    if(d!=='none'&&ifs[i].offsetHeight>20)return true;"
    "  }"
    "}"
    # 策略2：检测body子div弹窗（字节系通用 — display:block=验证中）
    "var divs=document.querySelectorAll('body>div');"
    "for(var j=0;j<divs.length&&j<8;j++){"
    "  if(window.getComputedStyle(divs[j]).display==='block'&&divs[j].offsetHeight>100){"
    "    var t=divs[j].textContent||'';"
    "    if(t.indexOf('验证')>=0||t.indexOf('安全')>=0||t.indexOf('拖动')>=0||"
    "       t.indexOf('滑块')>=0||t.indexOf('人机')>=0){return true;}"
    "  }"
    "}"
    # 策略3：检测class/id含captcha/verify/geetest的可见元素
    "var els=document.querySelectorAll('[class*=\"captcha\"],[class*=\"verify\"],[class*=\"geetest\"],"
    "[id*=\"captcha\"],[id*=\"verify\"],.sec warriors-captcha,.byte-captcha');"
    "for(var k=0;k<els.length;k++){"
    "  if(window.getComputedStyle(els[k]).display!=='none'&&els[k].offsetHeight>30)return true;"
    "}"
    "return false;"
    "})()"
)

_SEARCH_STATE_JS = (
    # __INITIAL_STATE__ 只是SSR初始快照，API返回后不会更新
    # 尝试多个可能的全局状态对象
    "JSON.stringify({"
    "  init: ((window.__INITIAL_STATE__||{}).search||{}).searchBookList,"
    "  store: window.__REDUX_STORE__&&window.__REDUX_STORE__.getState?window.__REDUX_STORE__.getState().search:null,"
    "  state: window.__APP_STATE__&&window.__APP_STATE__.search?window.__APP_STATE__.search.searchBookList:null"
    "})"
)

_DOM_BOOKS_JS = (
    # 精确XPath定位书籍列表容器，提取每本书的结构化数据
    "JSON.stringify((function(){"
    "  var items=document.querySelectorAll('.search-book-item');"
    "  if(!items.length){"
    "    var c=document.evaluate('/html/body/div[1]/div/div[2]/div/div',document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;"
    "    if(c)items=c.querySelectorAll('.search-book-item');"
    "  }"
    "  return Array.from(items).map(function(el){"
    "    var titleEl=el.querySelector('.title,.book-item-text .title');"
    "    var descSpans=el.querySelectorAll('.book-item-text .desc>span');"
    "    var abstractEl=el.querySelector('.desc.abstract,.book-item-text .desc.abstract');"
    "    var chapterEl=el.querySelector('.footer .chapter');"
    "    var imgEl=el.querySelector('img.book-cover-img');"
    "    var author='',category='',wordCount=0,status='连载中';"
    "    if(descSpans.length>0){"
    "      var t=descSpans[0].textContent.replace(/作者[：:]\\s*/,'').trim();"
    "      if(t)author=t;"
    "    }"
    "    if(descSpans.length>1){"
    "      var t2=descSpans[1].textContent.trim();"
    "      if(t2.indexOf('已完结')>=0)status='已完结';"
    "      category=t2.replace('连载中','').replace('已完结','').trim();"
    "    }"
    "    if(descSpans.length>2){"
    "      var wm=descSpans[2].textContent.match(/([\\d.]+)万?字/);"
    "      if(wm)wordCount=parseFloat(wm[1])*(wm[0].indexOf('万')>=0?10000:1);"
    "    }"
    "    return {"
    "      bookName:(titleEl?titleEl.textContent.trim():''),"
    "      author:author,"
    "      category:category,"
    "      wordCount:wordCount,"
    "      creationStatus:status==='已完结'?0:1,"
    "      bookAbstract:(abstractEl?abstractEl.textContent.trim().substring(0,300):''),"
    "      lastChapterTitle:(chapterEl?chapterEl.textContent.trim():''),"
    "      thumbUrl:(imgEl?imgEl.getAttribute('src')||'':''),"
    "    };"
    "  }).slice(0,20);"
    "})())"
)

# 终极方案：将整个页面HTML返回给LLM解析
_FULL_HTML_JS = "document.documentElement.outerHTML"


def _extract_books(books_raw) -> list:
    """将原始书籍数据转为标准格式"""
    result = []
    for b in books_raw:
        result.append({
            "书名": (b.get("bookName") or b.get("book_name") or ""),
            "作者": (b.get("author") or ""),
            "简介": (b.get("bookAbstract") or b.get("book_abstract") or ""),
            "分类": (b.get("category") or ""),
            "字数": (b.get("wordCount") or b.get("word_count") or 0),
            "状态": "连载中" if b.get("creationStatus") == 1 else "已完结",
            "封面": (b.get("thumbUrl") or b.get("thumb_url") or ""),
        })
    return result


def fetch_page_cdp(url: str, platform: str):
    """CDP 模式抓取。策略：只轮询验证码状态（轻量），验证码解决后等5秒渲染，
    然后一次性拿 page.content() 全页HTML，立即退出。避免反复 page.evaluate()
    触发字节SDK关闭标签页。"""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        _emit({"event": "result", "ok": False,
               "error": "Playwright 未安装。", "url": url})
        return

    _emit({"event": "status", "phase": "chrome_start"})
    if not _is_cdp_ready():
        if not _auto_start_chrome():
            _emit({"event": "result", "ok": False,
                   "error": "CDP 连接失败：无法启动 Chrome。", "url": url})
            return

    _emit({"event": "status", "phase": "connecting"})
    pw = None
    page = None
    try:
        pw = sync_playwright().start()
        browser = pw.chromium.connect_over_cdp(CDP_URL)
        page = browser.new_page()

        _emit({"event": "status", "phase": "navigating", "url": url})
        page.goto(url, timeout=30000, wait_until="domcontentloaded")

        # 阶段1：等待验证码解决（轻量检测），无验证码则快速跳过
        _emit({"event": "status", "phase": "polling"})
        last_captcha_state = False
        captcha_solved_at = 0
        no_captcha_loops = 8     # 8×2s=16s内无验证码→视为无需验证
        captcha_timeout_loops = CDP_CAPTCHA_TIMEOUT // CDP_POLL_INTERVAL
        _poll_errors = 0  # 连续异常计数
        for i in range(captcha_timeout_loops):
            time.sleep(CDP_POLL_INTERVAL)
            try:
                captcha_now = page.evaluate(_CAPTCHA_JS)
                _poll_errors = 0
            except Exception:
                # 页面正在跳转/加载中，保留上次状态，避免误判
                _poll_errors += 1
                if _poll_errors > 3:
                    # 连续多次异常 → 页面可能已关闭或CDP断开
                    _emit({"event": "debug", "msg": f"CDP轮询连续{_poll_errors}次异常，检查连接"})
                continue

            if captcha_now and not last_captcha_state:
                _emit({"event": "captcha", "phase": "detected"})
            elif not captcha_now and last_captcha_state:
                _emit({"event": "captcha", "phase": "solved"})
                captcha_solved_at = time.time()
                break
            last_captcha_state = captcha_now

            # 16秒内验证码从未出现 → 尝试速查数据，有则直接跳阶段3
            if i >= no_captcha_loops and captcha_solved_at == 0 and not captcha_now and not last_captcha_state:
                try:
                    has_data = page.evaluate(
                        "!!(document.querySelector('.search-book-item')||document.querySelector('.muye-search-book-list'))"
                    )
                except Exception:
                    has_data = False
                if has_data:
                    _emit({"event": "debug", "msg": "无验证码且页面已有数据, 跳过等待直接提取"})
                    break

        # 阶段2：验证码刚解决→等待页面稳定并渲染搜索结果
        if captcha_solved_at > 0:
            _emit({"event": "status", "phase": "waiting_render"})
            # 等待页面完成跳转/加载
            try:
                page.wait_for_load_state("networkidle", timeout=15000)
            except Exception:
                pass
            # 额外等待搜索结果DOM出现（最多20s）
            for _ in range(10):
                try:
                    has_data = page.evaluate(
                        "!!(document.querySelector('.search-book-item')||document.querySelector('.muye-search-book-list'))"
                    )
                    if has_data:
                        break
                except Exception:
                    pass
                time.sleep(2)

        # 阶段3：获取全页HTML，解码字体反爬
        _emit({"event": "status", "phase": "extracting"})
        html = None
        try:
            html = page.content()
            _emit({"event": "debug", "msg": f"page.content() len={len(html) if html else 0}"})
        except Exception as e:
            _emit({"event": "debug", "msg": f"page.content() 失败: {e}"})

        if html and len(html) > 500:
            # 尝试解码PUA字体乱码（支持多字体分片）
            _emit({"event": "status", "phase": "decoding"})
            try:
                from glyph_decoder import extract_font_url_from_page, decode_font, apply_mapping
                print("[Bridge] 开始字体解码...", file=sys.stderr, flush=True)
                font_urls = extract_font_url_from_page(page)
                if not font_urls:
                    # 兜底：从HTML文本搜
                    from glyph_decoder import extract_font_url_from_html
                    font_urls = extract_font_url_from_html(html)
                if font_urls:
                    print(f"[Bridge] 找到 {len(font_urls)} 个字体URL", file=sys.stderr, flush=True)
                    merged = {}
                    for fu in font_urls:
                        print(f"[Bridge] 解码字体: {fu[:100]}", file=sys.stderr, flush=True)
                        _emit({"event": "debug", "msg": f"字体URL: {fu[:100]}"})
                        try:
                            m = decode_font(fu, timeout=15)
                            if m:
                                dc = sum(1 for v in m.values() if v != '□')
                                print(f"[Bridge]   映射: {dc}/{len(m)}字", file=sys.stderr, flush=True)
                                merged.update(m)
                        except Exception as e:
                            print(f"[Bridge]   解码异常: {e}", file=sys.stderr, flush=True)
                    if merged:
                        total_dc = sum(1 for v in merged.values() if v != '□')
                        print(f"[Bridge] 合并映射: {total_dc}/{len(merged)}字", file=sys.stderr, flush=True)
                        _emit({"event": "debug", "msg": f"合并解码{total_dc}/{len(merged)}字"})
                        html = apply_mapping(html, merged)
                    else:
                        print("[Bridge] 所有字体解码返回空映射", file=sys.stderr, flush=True)
                else:
                    print("[Bridge] 未找到字体URL", file=sys.stderr, flush=True)
                    _emit({"event": "debug", "msg": "未找到字体URL"})
            except Exception as e:
                print(f"[Bridge] 字体解码异常: {e}", file=sys.stderr, flush=True)
                _emit({"event": "debug", "msg": f"字体解码异常: {e}"})

            html = html[:MAX_HTML_LENGTH]
            _emit({"event": "result", "ok": True, "html": html, "url": url, "cdp": True})
            return

        # 结构化提取备用：DOM直接取数据（可能有字体反爬乱码，但LLM会处理）
        try:
            dom_raw = page.evaluate(_DOM_BOOKS_JS)
            _emit({"event": "debug", "msg": f"DOM提取结果: {dom_raw[:200] if dom_raw else 'null'}"})
            dom_list = json.loads(dom_raw) if dom_raw else []
            if dom_list and len(dom_list) >= 1:
                books = _extract_books(dom_list)
                if books:
                    _emit({"event": "debug", "msg": f"结构化提取到{len(books)}本书"})
                    html = json.dumps({"书籍": books}, ensure_ascii=False, indent=2)
                    _emit({"event": "result", "ok": True, "html": html, "url": url, "cdp": True})
                    return
        except Exception as e:
            _emit({"event": "debug", "msg": f"DOM提取失败: {e}"})

        _emit({"event": "result", "ok": False,
               "error": "CDP 超时：验证码未完成或搜索结果未加载", "url": url})

    except Exception as e:
        _emit({"event": "result", "ok": False,
               "error": f"CDP 错误: {e}", "url": url})


# ==================== 入口 ====================

def main():
    if sys.platform == "win32":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Scrapling fetch bridge")
    parser.add_argument("--url", required=True)
    parser.add_argument("--platform", default="unknown")
    parser.add_argument("--cdp", action="store_true")
    args = parser.parse_args()

    if args.cdp:
        fetch_page_cdp(args.url, args.platform)
    else:
        result = fetch_page(args.url, args.platform)
        _emit({"event": "result", **result})


if __name__ == "__main__":
    main()
