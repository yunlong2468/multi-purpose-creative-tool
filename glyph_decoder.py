"""
字形解码器 — 破解字节跳动自定义字体反爬。
双模式：PaddleOCR API（优先）→ 感知哈希像素比对（兜底）。
将PUA码点的字形识别为对应汉字，构建 PUA→汉字 映射表。
"""
import io
import json
import os
import re
import struct
import sys
import time
import urllib.request
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont
import imagehash

# ===== PaddleOCR API 配置 =====
PADDLEOCR_URL = os.environ.get("PADDLEOCR_API_URL", "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs")
PADDLEOCR_TOKEN = os.environ.get("PADDLEOCR_TOKEN", "")
PADDLEOCR_MODEL = "PaddleOCR-VL-1.5"

# 批次参数（每次 API 调用处理的字符数）
OCR_CHARS_PER_ROW = 5           # 每行字符数（编号锚点模式，单元格更宽）
OCR_ROWS_PER_BATCH = 10         # 每批次行数
OCR_CHARS_PER_BATCH = OCR_CHARS_PER_ROW * OCR_ROWS_PER_BATCH  # 50
OCR_CELL_W = 170                # 单元格宽度（容纳 NNN: + 字符）
OCR_CELL_H = 80                 # 单元格高度
OCR_FONT_SIZE = 48              # PUA字符渲染字号
OCR_NUM_FONT_SIZE = 22          # 编号字号
OCR_PADDING = 20                # 单元格间距

# 编号用标准字体（需确保在所有系统上可渲染数字和标点）
_NUM_FONT_CANDIDATES = [
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/calibri.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
]
_NUM_FONT_PATH = None
for _fp in _NUM_FONT_CANDIDATES:
    if os.path.exists(_fp):
        _NUM_FONT_PATH = _fp
        break

# 参考中文字体候选（phash 兜底模式用）
_REF_FONT_PATHS = [
    "C:/Windows/Fonts/msyh.ttc",   # 微软雅黑（现代风格，最接近网页字体）
    "C:/Windows/Fonts/simhei.ttf", # 黑体
]

# 常用汉字集（前2500字，覆盖日常阅读的97%）
_COMMON_CHARS = (
    "的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学家所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞"
)

# 字体大小和渲染尺寸（phash 兜底用）
_FONT_SIZE = 128
_IMG_SIZE = 128


def _render_glyph_pixels(font_path: str, char: str) -> list:
    """渲染字符为二值像素数组"""
    try:
        font = ImageFont.truetype(font_path, _FONT_SIZE)
    except Exception:
        return None
    img = Image.new("L", (_IMG_SIZE, _IMG_SIZE), 255)
    draw = ImageDraw.Draw(img)
    bbox = draw.textbbox((0, 0), char, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    if w <= 0 or h <= 0:
        return None
    x = (_IMG_SIZE - w) // 2 - bbox[0]
    y = (_IMG_SIZE - h) // 2 - bbox[1]
    draw.text((x, y), char, fill=0, font=font)
    return [1 if p < 128 else 0 for p in img.getdata()]


def _pixel_similarity(p1: list, p2: list) -> float:
    """像素相似度 0~1"""
    if not p1 or not p2 or len(p1) != len(p2):
        return 0.0
    return sum(1 for a, b in zip(p1, p2) if a == b) / len(p1)


def _render_glyph_hash(font_path: str, char: str) -> imagehash.ImageHash:
    """渲染字符为图像，返回感知哈希（粗筛用）"""
    try:
        font = ImageFont.truetype(font_path, _FONT_SIZE)
    except Exception:
        return None
    img = Image.new("L", (_IMG_SIZE, _IMG_SIZE), 255)
    draw = ImageDraw.Draw(img)
    bbox = draw.textbbox((0, 0), char, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    if w <= 0 or h <= 0:
        return None
    x = (_IMG_SIZE - w) // 2 - bbox[0]
    y = (_IMG_SIZE - h) // 2 - bbox[1]
    draw.text((x, y), char, fill=0, font=font)
    return imagehash.phash(img, hash_size=16)  # 16=256bit


# ============================================================
#  矢量特征比对模式（默认，无需OCR/API，从字体轮廓提取特征）
# ============================================================

def _get_glyph_vector_features(font, cmap: dict, char: str) -> dict:
    """从fontTools字形矢量数据提取特征：轮廓数、点数、宽高比。
    自动处理复合字形（递归统计组件轮廓）。返回None表示提取失败。"""
    try:
        cp = ord(char)
        glyph_name = cmap.get(cp)
        if not glyph_name:
            return None

        glyf_table = font.get("glyf")
        if not glyf_table:
            return None

        glyph_set = font.getGlyphSet()
        if glyph_name not in glyph_set:
            return None

        glyph = glyf_table[glyph_name]

        # 包围盒
        try:
            from fontTools.pens.boundsPen import ControlBoundsPen
            pen = ControlBoundsPen(glyph_set)
            glyph_set[glyph_name].draw(pen)
            bnd = pen.bounds
            if not bnd:
                return None
            x_min, y_min, x_max, y_max = bnd
        except Exception:
            return None

        w = x_max - x_min
        h = y_max - y_min
        if w <= 0 and h <= 0:
            return None

        # 轮廓数和点数（兼容不同fontTools版本的getCoordinates）
        if glyph.numberOfContours > 0:
            n_contours = glyph.numberOfContours
            result = glyph.getCoordinates(glyf_table)
            coords = result[0] if result else []
            n_points = len(coords)
        else:
            # 复合字形：递归统计
            def _count_comp(g):
                nc, np_val = 0, 0
                if hasattr(g, "components"):
                    for comp in g.components:
                        sg = glyf_table[comp.glyphName]
                        if sg.numberOfContours > 0:
                            nc += sg.numberOfContours
                            r = sg.getCoordinates(glyf_table)
                            np_val += len(r[0]) if r else 0
                        elif sg.numberOfContours < 0:
                            sc, sp = _count_comp(sg)
                            nc += sc
                            np_val += sp
                return nc, np_val
            n_contours, n_points = _count_comp(glyph)
            if n_contours == 0:
                return None
    except Exception:
        return None

    return {
        "n_contours": n_contours,
        "n_points": n_points,
        "width": w,
        "height": h,
        "aspect": w / max(h, 1),
    }


def _build_vector_index(font, cmap: dict, char_set: str) -> dict:
    """为给定字符集构建矢量特征索引。{char: features}"""
    index = {}
    for ch in char_set:
        feat = _get_glyph_vector_features(font, cmap, ch)
        if feat:
            index[ch] = feat
    return index


def _vector_match(pua_features: dict, ref_index: dict) -> tuple:
    """矢量特征匹配：返回 (最佳汉字, 置信分)。分数越小越好。"""
    if not pua_features:
        return "□", 999

    nc = pua_features["n_contours"]
    np = pua_features["n_points"]
    ar = pua_features["aspect"]

    best_char = "□"
    best_score = float("inf")

    for ch, ref in ref_index.items():
        cd = abs(nc - ref["n_contours"])
        if cd >= 4:
            continue  # 轮廓数差太多，直接跳过

        # 点数比率
        if ref["n_points"] > 0 and np > 0:
            r = np / ref["n_points"]
            pd = abs(1.0 - (r if r <= 1 else 1 / r))
        else:
            pd = 1.0

        # 宽高比差
        if ar > 0 and ref["aspect"] > 0:
            ad = abs(ar - ref["aspect"])
        else:
            ad = 1.0

        score = cd * 100 + pd * 60 + ad * 40
        if score < best_score:
            best_score = score
            best_char = ch

    return best_char, best_score


def _vector_prefilter(pua_features: dict, ref_index: dict, top_n: int = 20) -> list:
    """矢量特征预筛：从参考字集中选出top-N候选供像素比对精排。"""
    if not pua_features:
        return list(ref_index.keys())[:top_n]

    nc = pua_features["n_contours"]
    np_val = pua_features["n_points"]
    ar = pua_features["aspect"]

    scored = []
    for ch, ref in ref_index.items():
        cd = abs(nc - ref["n_contours"])
        if cd >= 5:
            continue

        if ref["n_points"] > 0 and np_val > 0:
            r = np_val / ref["n_points"]
            pd = abs(1.0 - (r if r <= 1 else 1 / r))
        else:
            pd = 1.0

        if ar > 0 and ref["aspect"] > 0:
            ad = abs(ar - ref["aspect"])
        else:
            ad = 1.0

        score = cd * 100 + pd * 60 + ad * 40
        scored.append((score, ch))

    scored.sort(key=lambda x: x[0])
    return [ch for _, ch in scored[:top_n]]


# requests 为OCR API调用所需（可选依赖，仅使用OCR模式时需要）
try:
    import requests as _requests_module
except ImportError:
    _requests_module = None


def _create_numbered_batch_image(pua_chars: list, font_path: str, batch_idx: int) -> tuple:
    """
    创建PUA字符编号锚点图片（双字体渲染），供PaddleOCR识别。
    每格格式：左侧 Arial 渲染 "NNN:"，右侧 PUA字体 渲染待解码字符。
    OCR漏字/重排不影响映射，正则按编号匹配。
    返回 (图片路径, 该批次的PUA字符列表, 全局起始编号)。
    """
    chars_per_row = OCR_CHARS_PER_ROW
    chars_per_batch = OCR_CHARS_PER_BATCH
    cell_w = OCR_CELL_W
    cell_h = OCR_CELL_H
    font_size = OCR_FONT_SIZE
    num_size = OCR_NUM_FONT_SIZE
    padding = OCR_PADDING

    start = batch_idx * chars_per_batch
    batch_chars = pua_chars[start:start + chars_per_batch]
    if not batch_chars:
        return None, [], start

    cols = min(chars_per_row, len(batch_chars))
    rows = (len(batch_chars) + cols - 1) // cols

    img_w = cols * (cell_w + padding) + padding
    img_h = rows * (cell_h + padding) + padding

    img = Image.new("L", (img_w, img_h), 255)
    draw = ImageDraw.Draw(img)

    try:
        pua_font = ImageFont.truetype(font_path, font_size)
    except Exception:
        return None, batch_chars, start

    num_font = None
    if _NUM_FONT_PATH:
        try:
            num_font = ImageFont.truetype(_NUM_FONT_PATH, num_size)
        except Exception:
            pass

    for i, ch in enumerate(batch_chars):
        global_idx = start + i + 1  # 编号从 001 开始
        row = i // cols
        col = i % cols

        cell_x = padding + col * (cell_w + padding)
        cell_y = padding + row * (cell_h + padding)
        cell_cx = cell_x + cell_w // 2
        cell_cy = cell_y + cell_h // 2

        # 左侧：编号 "NNN:" 用标准字体（Arial），靠左垂直居中
        label = f"{global_idx:03d}:"
        if num_font:
            lbox = draw.textbbox((0, 0), label, font=num_font)
            lw, lh = lbox[2] - lbox[0], lbox[3] - lbox[1]
            lx = cell_x + 6 - lbox[0]
            ly = cell_cy - lh // 2 - lbox[1]
            draw.text((lx, ly), label, fill=0, font=num_font)

        # 右侧：PUA字符
        if ch.strip():
            cbox = draw.textbbox((0, 0), ch, font=pua_font)
            cw, ch_h = cbox[2] - cbox[0], cbox[3] - cbox[1]
            if cw > 0 and ch_h > 0:
                cx = cell_x + 80 - cbox[0]  # 偏移到编号右侧
                cy = cell_cy - ch_h // 2 - cbox[1]
                draw.text((cx, cy), ch, fill=0, font=pua_font)

    tmp_path = f"C:/temp/_ocr_batch_{batch_idx}.png"
    os.makedirs("C:/temp", exist_ok=True)
    img.save(tmp_path)
    return tmp_path, batch_chars, start


def _submit_ocr_job(image_path: str, token: str = None) -> str:
    """提交OCR任务，返回 jobId"""
    token = token or PADDLEOCR_TOKEN
    headers = {"Authorization": f"bearer {token}"}

    data = {
        "model": PADDLEOCR_MODEL,
        "optionalPayload": json.dumps({
            "useDocOrientationClassify": False,
            "useDocUnwarping": False,
            "useChartRecognition": False,
        })
    }

    with open(image_path, "rb") as f:
        resp = _requests_module.post(PADDLEOCR_URL, headers=headers, data=data,
                                 files={"file": f}, timeout=30)

    if resp.status_code != 200:
        raise Exception(f"OCR提交失败 HTTP {resp.status_code}: {resp.text[:200]}")

    job_id = resp.json()["data"]["jobId"]
    return job_id


def _poll_ocr_job(job_id: str, token: str = None, timeout: int = 120) -> str:
    """轮询OCR任务直到完成，返回 resultUrl.jsonUrl"""
    token = token or PADDLEOCR_TOKEN
    headers = {"Authorization": f"bearer {token}"}
    deadline = time.time() + timeout

    while time.time() < deadline:
        resp = _requests_module.get(f"{PADDLEOCR_URL}/{job_id}", headers=headers, timeout=15)
        if resp.status_code != 200:
            time.sleep(3)
            continue

        data = resp.json()["data"]
        state = data["state"]

        if state == "done":
            return data["resultUrl"]["jsonUrl"]
        elif state == "failed":
            raise Exception(f"OCR任务失败: {data.get('errorMsg', '未知错误')}")
        else:
            # pending / running
            time.sleep(3)

    raise Exception(f"OCR任务超时 ({timeout}s)")


def _download_ocr_text(jsonl_url: str) -> str:
    """下载OCR结果JSONL，提取所有识别文本"""
    resp = _requests_module.get(jsonl_url, timeout=30)
    resp.raise_for_status()

    all_text = []
    for line in resp.text.strip().split('\n'):
        if not line.strip():
            continue
        try:
            result = json.loads(line)["result"]
            for res in result.get("layoutParsingResults", []):
                md_text = res.get("markdown", {}).get("text", "")
                if md_text:
                    all_text.append(md_text)
        except (json.JSONDecodeError, KeyError):
            pass

    return "\n".join(all_text)


def _parse_numbered_ocr_text(ocr_text: str, batch_chars: list, global_start: int) -> dict:
    """从OCR结果按编号锚点提取字符映射，兼容各种分隔符，返回 {PUA→汉字}。"""
    pairs = re.findall(r'(\d{3})\W*(\S)', ocr_text)
    if not pairs:
        # 回退：尝试更宽松的匹配（只匹配数字+字符）
        pairs = re.findall(r'(\d{3})\W*(\S)', ocr_text.replace('\n', ' '))

    mapping = {}
    decoded = 0
    for num_str, recognized_char in pairs:
        num = int(num_str)
        idx = num - global_start - 1  # 全局编号 → 批内索引
        if idx < 0 or idx >= len(batch_chars):
            continue
        pua_char = batch_chars[idx]
        # 只保留有意义的结果（排除纯空白、空）
        if recognized_char and recognized_char.strip():
            mapping[pua_char] = recognized_char
            decoded += 1

    # 未被编号锚点匹配到的字符标记为失败
    failed = 0
    for ch in batch_chars:
        if ch not in mapping:
            mapping[ch] = "□"
            failed += 1

    print(f"[OCR] 编号锚点解析: 成功{decoded} 失败{failed}/{len(batch_chars)}",
          file=sys.stderr, flush=True)
    if decoded > 0:
        # 显示前几个匹配样例
        samples = list(mapping.items())[:5]
        print(f"[OCR] 样例: {samples}", file=sys.stderr, flush=True)

    return mapping


def decode_font_via_ocr(font_url: str, token: str = None, timeout: int = 180) -> dict:
    """
    PaddleOCR API 解码模式。
    将PUA字符分批渲染为网格图片 → 提交OCR识别 → 构建映射表。
    返回 {PUA码点→汉字} 映射表。
    """
    token = token or PADDLEOCR_TOKEN
    if not token:
        print("[OCR] 未配置 PADDLEOCR_TOKEN，跳过OCR模式", file=sys.stderr, flush=True)
        return {}

    if _requests_module is None:
        print("[OCR] 缺少 requests 库，请执行 pip install requests", file=sys.stderr, flush=True)
        return {}

    # 1. 下载字体
    req = urllib.request.Request(font_url, headers={"User-Agent": "Mozilla/5.0"})
    font_data = urllib.request.urlopen(req, timeout=timeout).read()

    # 2. woff2 → TTF 解压
    tmp_path = "C:/temp/_fanqie_decoded.ttf"
    tmp_woff2 = "C:/temp/_fanqie_raw.woff2"
    os.makedirs("C:/temp", exist_ok=True)
    try:
        with open(tmp_woff2, "wb") as f:
            f.write(font_data)
        from fontTools.ttLib.woff2 import decompress
        decompress(tmp_woff2, tmp_path)
        font = TTFont(tmp_path)
    except Exception:
        font = TTFont(io.BytesIO(font_data))
        font.flavor = None
        font.save(tmp_path)
    cmap = font.getBestCmap()

    # 3. 提取PUA字符集
    pua_chars = [chr(cp) for cp in cmap if 0xE000 <= cp <= 0xF8FF]
    total = len(pua_chars)
    print(f"[OCR] PUA字符数: {total}", file=sys.stderr, flush=True)

    if total == 0:
        return {}

    # 5. 分批创建编号锚点图片并OCR识别
    batch_count = (total + OCR_CHARS_PER_BATCH - 1) // OCR_CHARS_PER_BATCH
    mapping = {}
    total_decoded = 0
    total_failed = 0

    for batch_idx in range(batch_count):
        img_path, batch_chars, global_start = _create_numbered_batch_image(
            pua_chars, tmp_path, batch_idx
        )
        if not img_path or not batch_chars:
            continue

        try:
            print(f"[OCR] 批次 {batch_idx+1}/{batch_count}: "
                  f"{len(batch_chars)}字 (编号{global_start+1:03d}-{global_start+len(batch_chars):03d}), "
                  f"提交中...", file=sys.stderr, flush=True)

            job_id = _submit_ocr_job(img_path, token)
            print(f"[OCR] jobId={job_id[:12]}..., 等待结果...", file=sys.stderr, flush=True)

            jsonl_url = _poll_ocr_job(job_id, token, timeout=timeout)
            ocr_text = _download_ocr_text(jsonl_url)

            # 显示OCR原始输出片段（调试用）
            preview = ocr_text[:200].replace('\n', ' ').strip()
            print(f"[OCR] 原始输出: {preview}...", file=sys.stderr, flush=True)

            # 编号锚点解析（替代位置映射）
            batch_map = _parse_numbered_ocr_text(ocr_text, batch_chars, global_start)
            mapping.update(batch_map)

            decoded = sum(1 for v in batch_map.values() if v != "□")
            failed = sum(1 for v in batch_map.values() if v == "□")
            total_decoded += decoded
            total_failed += failed

        except Exception as e:
            print(f"[OCR] 批次 {batch_idx+1} 失败: {e}", file=sys.stderr, flush=True)
            for ch in batch_chars:
                mapping[ch] = "□"
                total_failed += len(batch_chars)
        finally:
            # 清理临时图片
            try:
                if os.path.exists(img_path):
                    os.remove(img_path)
            except Exception:
                pass

    print(f"[OCR] 解码完成: {total_decoded}/{total}字 ({total_failed}失败)",
          file=sys.stderr, flush=True)
    return mapping


# ============================================================
#  phash 像素比对模式（兜底，无网络依赖）
# ============================================================

def decode_font_phash(font_url: str, timeout: int = 10) -> dict:
    """下载并解析字体文件，通过感知哈希+像素比对返回 {PUA码点→汉字} 映射表"""
    # 1. 下载字体
    req = urllib.request.Request(font_url, headers={"User-Agent": "Mozilla/5.0"})
    font_data = urllib.request.urlopen(req, timeout=timeout).read()

    # 2. woff2 → TTF 解压
    tmp_path = "C:/temp/_fanqie_decoded.ttf"
    try:
        tmp_woff2 = "C:/temp/_fanqie_raw.woff2"
        with open(tmp_woff2, "wb") as f:
            f.write(font_data)
        from fontTools.ttLib.woff2 import decompress
        decompress(tmp_woff2, tmp_path)
        font = TTFont(tmp_path)
        os.makedirs("C:/temp", exist_ok=True)
    except Exception:
        font = TTFont(io.BytesIO(font_data))
        font.flavor = None
        font.save(tmp_path)
    cmap = font.getBestCmap()

    # 3. 提取PUA字符集
    pua_chars = [chr(cp) for cp in cmap if 0xE000 <= cp <= 0xF8FF]
    print(f"[Decoder] PUA字符数: {len(pua_chars)}", flush=True)

    # 5. 渲染PUA字符（哈希 + 像素数组）
    pua_data = {}  # pua_char → {hash, pixels}
    for ch in pua_chars:
        h = _render_glyph_hash(tmp_path, ch)
        p = _render_glyph_pixels(tmp_path, ch)
        if h is not None and p is not None:
            pua_data[ch] = {"hash": h, "pixels": p}

    # 6. 用多个参考字体尝试匹配，选最佳结果
    best_mapping = {}
    best_score = 0
    for ref_font_path in _REF_FONT_PATHS:
        if not os.path.exists(ref_font_path):
            continue
        # 渲染参考汉字
        ref_data = {}
        for ch in _COMMON_CHARS:
            h = _render_glyph_hash(ref_font_path, ch)
            p = _render_glyph_pixels(ref_font_path, ch)
            if h is not None and p is not None:
                ref_data[ch] = {"hash": h, "pixels": p}

        # 两阶段匹配
        mapping = {}
        TOP_N = 5
        PIXEL_THRESHOLD = 0.55
        for pua_ch, pua_info in pua_data.items():
            candidates = []
            for ref_ch, ref_info in ref_data.items():
                dist = pua_info["hash"] - ref_info["hash"]
                candidates.append((dist, ref_ch))
            candidates.sort(key=lambda x: x[0])
            top5 = candidates[:TOP_N]

            best_char = top5[0][1] if top5 else "?"
            best_sim = 0.0
            for _, ref_ch in top5:
                sim = _pixel_similarity(pua_info["pixels"], ref_data[ref_ch]["pixels"])
                if sim > best_sim:
                    best_sim = sim
                    best_char = ref_ch

            if best_sim >= PIXEL_THRESHOLD or (top5 and top5[0][0] <= 15):
                mapping[pua_ch] = best_char
            else:
                mapping[pua_ch] = "□"

        score = sum(1 for v in mapping.values() if v != "□")
        print(f"[Decoder] 字体{os.path.basename(ref_font_path)}: {score}/{len(mapping)}字", flush=True)
        if score > best_score:
            best_score = score
            best_mapping = mapping

    print(f"[Decoder] 最佳匹配: {best_score}/{len(best_mapping)}字", flush=True)
    return best_mapping


# ============================================================
#  统一入口（自动选择OCR → phash兜底）
# ============================================================

def decode_font(font_url: str, timeout: int = 10, token: str = None) -> dict:
    """
    解码字体，混合策略：
    1. 矢量特征预筛（2500字→20候选）
    2. phash+像素比对精排（20候选择最优）
    3. PaddleOCR补漏（可选）
    返回 {PUA码点→汉字} 映射表
    """
    import urllib.request as _ur

    # 1. 下载字体
    req = _ur.Request(font_url, headers={"User-Agent": "Mozilla/5.0"})
    font_data = _ur.urlopen(req, timeout=timeout).read()

    # 2. woff2 → TTF 显式解压（fontTools可直读woff2，但解压后Pillow才能用）
    tmp_ttf = "C:/temp/_fanqie_decoded.ttf"
    tmp_woff2 = "C:/temp/_fanqie_raw.woff2"
    os.makedirs("C:/temp", exist_ok=True)
    try:
        # 保存原始woff2
        with open(tmp_woff2, "wb") as f:
            f.write(font_data)
        # 显式解压woff2 → TTF
        from fontTools.ttLib.woff2 import decompress
        decompress(tmp_woff2, tmp_ttf)
        font = TTFont(tmp_ttf)
        print("[Decoder] woff2已解压为TTF", file=sys.stderr, flush=True)
    except Exception as e:
        # 回退：fontTools直接读（可能已经是TTF/OTF格式）
        print(f"[Decoder] woff2解压失败({e})，尝试直接读取", file=sys.stderr, flush=True)
        font = TTFont(io.BytesIO(font_data))
        font.flavor = None
        font.save(tmp_ttf)
    cmap = font.getBestCmap()

    # 3. 提取PUA字符集
    pua_chars = [chr(cp) for cp in cmap if 0xE000 <= cp <= 0xF8FF]
    total = len(pua_chars)
    print(f"[Decoder] PUA字符数: {total}", file=sys.stderr, flush=True)
    if total == 0:
        return {}

    # 4. 提取PUA矢量特征（用于预筛，CFF字体此步全失败）
    pua_vec = {}
    pua_hashes = {}  # 感知哈希（CFF字体无矢量特征时的备选预筛）
    for ch in pua_chars:
        feat = _get_glyph_vector_features(font, cmap, ch)
        if feat:
            pua_vec[ch] = feat
        # 同时计算感知哈希（矢量失败时的回退预筛）
        h = _render_glyph_hash(tmp_ttf, ch)
        if h:
            pua_hashes[ch] = h
    print(f"[Decoder] 矢量特征: {len(pua_vec)}/{total}"
          + (f" 感知哈希: {len(pua_hashes)}/{total}" if len(pua_vec) < total else ""),
          file=sys.stderr, flush=True)

    # 5. 渲染PUA像素（用于精排）
    pua_pixels = {}
    for ch in pua_chars:
        p = _render_glyph_pixels(tmp_ttf, ch)
        if p:
            pua_pixels[ch] = p

    # 6. 多参考字体混合匹配
    best_mapping = {}
    best_decoded = 0

    for ref_path in _REF_FONT_PATHS:
        if not os.path.exists(ref_path):
            continue
        try:
            ref_font = TTFont(ref_path)
            ref_cmap = ref_font.getBestCmap()
        except Exception:
            continue

        print(f"[Decoder] 参考字体 {os.path.basename(ref_path)}...",
              file=sys.stderr, flush=True)

        try:
            # 建矢量索引（预筛用）
            vec_idx = _build_vector_index(ref_font, ref_cmap, _COMMON_CHARS)
            print(f"[Decoder]   矢量索引 {len(vec_idx)} 字", file=sys.stderr, flush=True)

            # CFF回退：预建参考字体感知哈希索引（只建一次，不在循环内重复渲染）
            ref_hashes = {}
            if len(pua_vec) < total:
                print(f"[Decoder]   预建感知哈希索引...", file=sys.stderr, flush=True)
                for ref_ch in _COMMON_CHARS:
                    rh = _render_glyph_hash(ref_path, ref_ch)
                    if rh is not None:
                        ref_hashes[ref_ch] = rh
                print(f"[Decoder]   感知哈希索引 {len(ref_hashes)} 字", file=sys.stderr, flush=True)

            mapping = {}
            decoded = 0

            for pua_ch in pua_chars:
                # 阶段1：预筛 → top20候选（矢量优先，CFF回退感知哈希）
                pua_feat = pua_vec.get(pua_ch)
                if pua_feat:
                    candidates = _vector_prefilter(pua_feat, vec_idx, top_n=20)
                elif ref_hashes:
                    pua_hash = pua_hashes.get(pua_ch)
                    if pua_hash:
                        scored = [(pua_hash - rh, ch) for ch, rh in ref_hashes.items()]
                        scored.sort(key=lambda x: x[0])
                        candidates = [ch for _, ch in scored[:20]]
                    else:
                        candidates = list(vec_idx.keys())[:20]
                else:
                    candidates = list(vec_idx.keys())[:20]

                # 阶段2：像素比对精排
                pua_pix = pua_pixels.get(pua_ch)
                if pua_pix is None:
                    mapping[pua_ch] = "□"
                    continue

                best_char = "□"
                best_sim = 0.0
                for candidate in candidates:
                    ref_pix = _render_glyph_pixels(ref_path, candidate)
                    if ref_pix is None:
                        continue
                    sim = _pixel_similarity(pua_pix, ref_pix)
                    if sim > best_sim:
                        best_sim = sim
                        best_char = candidate

                if best_sim >= 0.55:
                    mapping[pua_ch] = best_char
                    decoded += 1
                else:
                    mapping[pua_ch] = "□"

            print(f"[Decoder]   {os.path.basename(ref_path)}: {decoded}/{total}字",
                  file=sys.stderr, flush=True)
            if decoded > best_decoded:
                best_decoded = decoded
                best_mapping = mapping
        except Exception as e:
            print(f"[Decoder]   {os.path.basename(ref_path)} 异常: {e}",
                  file=sys.stderr, flush=True)

    print(f"[Decoder] 像素精排: {best_decoded}/{total}字",
          file=sys.stderr, flush=True)

    # 7. OCR补漏（可选）
    ocr_token = token or PADDLEOCR_TOKEN
    if ocr_token and best_decoded < total:
        unmapped = [k for k, v in best_mapping.items() if v == "□"]
        print(f"[Decoder] {len(unmapped)}字未匹配, OCR补漏...",
              file=sys.stderr, flush=True)
        try:
            ocr_result = decode_font_via_ocr(font_url, token=ocr_token, timeout=max(timeout, 180))
            ocr_added = 0
            for k, v in ocr_result.items():
                if v != "□" and best_mapping.get(k, "□") == "□":
                    best_mapping[k] = v
                    ocr_added += 1
            if ocr_added > 0:
                best_decoded += ocr_added
                print(f"[Decoder] OCR补漏 {ocr_added} 字", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"[Decoder] OCR补漏失败: {e}", file=sys.stderr, flush=True)

    print(f"[Decoder] 最终: {best_decoded}/{total}字",
          file=sys.stderr, flush=True)
    return best_mapping


def apply_mapping(html: str, mapping: dict) -> str:
    """将HTML中的PUA字符替换为映射后的汉字"""
    result = []
    for ch in html:
        if ch in mapping:
            result.append(mapping[ch])
        else:
            result.append(ch)
    return "".join(result)


def extract_font_url_from_page(page) -> list:
    """通过CDP找到所有自定义字体(.woff2)的URL（支持多字体分片）。
    返回 URL 列表，可能为空。"""
    urls = []
    try:
        # 1. 从页面HTML中提取所有CSS文件链接
        css_links = page.evaluate(
            "JSON.stringify(Array.from(document.querySelectorAll("
            "'link[rel=\"stylesheet\"]')).map(function(l){return l.href}))"
        )
        css_urls = json.loads(css_links) if css_links else []

        # 2. 逐个下载CSS文件，收集所有woff2 URL
        for css_url in css_urls:
            if not css_url or '.css' not in css_url.lower():
                continue
            if css_url.startswith('//'):
                css_url = 'https:' + css_url
            try:
                req = urllib.request.Request(css_url, headers={"User-Agent": "Mozilla/5.0"})
                css_text = urllib.request.urlopen(req, timeout=8).read().decode('utf-8', errors='replace')
                # 收集所有 woff2 URL
                found = re.findall(
                    r"url\([\"']?(https?://[^\"')\s]+\.woff2)[\"']?\)",
                    css_text, re.I
                )
                if found:
                    urls.extend(found)
            except Exception:
                pass

        # 3. 兜底：从HTML文本中搜索
        if not urls:
            html = page.content() if hasattr(page, 'content') else ''
            found = re.findall(r"(https?://[^\"'\s]+\.woff2)", html, re.I)
            urls.extend(found)
        # 去重保持顺序
        seen = set()
        return [u for u in urls if not (u in seen or seen.add(u))]
    except Exception:
        return []


def extract_font_url_from_html(html: str) -> list:
    """从HTML文本中提取字体URL列表（备用方案）"""
    urls = re.findall(r"(https?://[^\"'\s]+\.woff2)", html, re.I)
    if not urls:
        urls = re.findall(r"url\([\"']?(https?://[^\"')\s]+\.woff2)[\"']?\)", html, re.I)
    seen = set()
    return [u for u in urls if not (u in seen or seen.add(u))]


if __name__ == "__main__":
    # 独立测试
    import sys

    url = sys.argv[1] if len(sys.argv) > 1 else ""
    if url:
        mapping = decode_font(url, timeout=15)
        print(f"映射表: {len(mapping)} 条")
        # 展示前10条
        for i, (pua, han) in enumerate(mapping.items()):
            if i >= 10:
                break
            print(f"  U+{ord(pua):04X} → {han}")
