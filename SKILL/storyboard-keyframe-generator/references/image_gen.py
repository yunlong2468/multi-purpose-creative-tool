"""
桃妖妖 - 分镜关键帧图片生成器
对接 yijiarj image2 API，支持文生图和图生图模式。
支持站位参考帧、版本管理、废弃图存档。
"""

import argparse
import base64
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

import requests

# ============================================================
# 配置
# ============================================================

API_URL = "https://api.yijiarj.cn/v1/chat/completions"
API_KEY = "sk-eGcYBsFjUTYIiaTwY9ux8WFNSiz87Jx5768jebK8nvRgAAGb"
MODEL = "image2"
SIZE = "9:16"  # 竖屏 9:16（ad分组用比例值，非ad分组用 "1024x1792"）

# 项目根目录（脚本所在目录）
PROJECT_DIR = Path(__file__).resolve().parent

# 关键帧 JSON 路径
KEYFRAME_JSON = PROJECT_DIR / "分镜关键帧提示词.json"

# 输出目录
OUTPUT_DIR = PROJECT_DIR / "生成结果"
OUTPUT_DIR.mkdir(exist_ok=True)

# 废弃图存档目录
DISCARD_DIR = PROJECT_DIR / "废弃分镜图"
DISCARD_DIR.mkdir(exist_ok=True)

# 请求间隔（秒），避免触发频率限制
REQUEST_INTERVAL = 3


# ============================================================
# 工具函数
# ============================================================

def image_to_base64(image_path: Path) -> str:
    """将本地图片转为 base64 data URI."""
    if not image_path.exists():
        raise FileNotFoundError(f"图片不存在: {image_path}")

    ext = image_path.suffix.lower()
    mime_map = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }
    mime = mime_map.get(ext, "image/png")

    with open(image_path, "rb") as f:
        data = base64.b64encode(f.read()).decode("utf-8")

    return f"data:{mime};base64,{data}"


def resolve_path(relative_path: str) -> Path:
    """将 JSON 中的相对路径（如 '人物/桃夭夭.jpg'）转为绝对路径."""
    return PROJECT_DIR / relative_path


def extract_image_url(content: str) -> str | None:
    """从 API 返回的 markdown 内容中提取图片 URL.

    API 返回格式: ![image](https://xxx.png)
    """
    match = re.search(r"!\[.*?\]\((https?://[^\)]+)\)", content)
    if match:
        return match.group(1)
    # 尝试直接匹配 URL
    match = re.search(r"https?://[^\s\)]+\.(?:png|jpg|jpeg|webp)", content)
    if match:
        return match.group(0)
    return None


def download_image(url: str, save_path: Path) -> bool:
    """下载生成的图片到本地."""
    try:
        resp = requests.get(url, timeout=60)
        resp.raise_for_status()
        save_path.parent.mkdir(parents=True, exist_ok=True)
        with open(save_path, "wb") as f:
            f.write(resp.content)
        print(f"  -> 已保存: {save_path}")
        return True
    except Exception as e:
        print(f"  -> 下载失败: {e}")
        return False


def archive_existing(frame_id: str) -> None:
    """检查生成结果中是否已有同名文件，有则移动到废弃目录并编号."""
    existing = OUTPUT_DIR / f"{frame_id}.png"
    if not existing.exists():
        return

    # 找废弃目录中已有的最大版本号
    max_v = 0
    for f in DISCARD_DIR.glob(f"{frame_id}_v*.png"):
        m = re.search(r"_v(\d+)\.png$", f.name)
        if m:
            max_v = max(max_v, int(m.group(1)))

    new_name = f"{frame_id}_v{max_v + 1}.png"
    archive_path = DISCARD_DIR / new_name
    shutil.move(str(existing), str(archive_path))
    print(f"  [存档] {existing.name} -> 废弃分镜图/{new_name}")


def count_generation_rounds(frame_id: str, ref_frame_id: str | None) -> int:
    """估算当前帧的溶图次数.

    - 文生图（无参考）: 0次
    - 图生图（仅原始素材参考）: 1次
    - 用了已生成的帧作为参考: 2次（上限，再多次会变形）
    """
    rounds = 0

    # 如果有 ref-frame，说明用了已生成图作参考，基础就是1次
    if ref_frame_id:
        ref_img = OUTPUT_DIR / f"{ref_frame_id}.png"
        if ref_img.exists():
            rounds += 1
        # 检查 ref-frame 本身是否经历过废弃（被再生过）
        archive_versions = list(DISCARD_DIR.glob(f"{ref_frame_id}_v*.png"))
        if archive_versions:
            rounds += 1  # ref图本身也是生成结果，叠加一次

    # 有其他参考图（角色/场景/道具原始素材）则 +1
    rounds += 1

    return min(rounds, 3)  # 上限标记


# ============================================================
# 请求构建
# ============================================================

def build_messages(
    prompt: str,
    scene_images: list[Path],
    position_images: list[Path],
    other_images: list[Path],
) -> list[dict]:
    """构建 API messages，按顺序排列参考图.

    图片顺序: 场景图 → 站位参考图 → 角色/道具图
    提示词中明确标注每张图的用途.
    """
    all_images: list[Path] = []
    img_labels: list[str] = []

    # 第1组: 场景图
    for p in scene_images:
        if p.exists():
            all_images.append(p)
            img_labels.append("场景环境参考")

    # 第2组: 站位参考图（上一帧生成结果）
    for p in position_images:
        if p.exists():
            all_images.append(p)
            img_labels.append("上一帧站位+光影+构图参考")

    # 第3组: 角色+道具图
    for p in other_images:
        if p.exists():
            all_images.append(p)
            img_labels.append("角色/道具参考")

    if not all_images:
        # 文生图模式
        return [{"role": "user", "content": prompt}]

    # 构建带标注的提示词前缀
    img_desc_lines = []
    for i, label in enumerate(img_labels, 1):
        img_desc_lines.append(f"图{i}是{label}")
    img_desc = "，".join(img_desc_lines)

    full_prompt = (
        f"【参考图说明】{img_desc}。"
        f"请保持场景、服饰、光影、色调与参考图一致，仅按下方指令修改画面内容。"
        f"\n【生成指令】{prompt}"
    )

    # 构建 content 数组: text 在前，图片按顺序在后
    content: list[dict] = [{"type": "text", "text": full_prompt}]
    for img_path in all_images:
        data_uri = image_to_base64(img_path)
        content.append({
            "type": "image_url",
            "image_url": {"url": data_uri},
        })

    return [{"role": "user", "content": content}]


def call_api(messages: list[dict], size: str = SIZE) -> dict | None:
    """调用 image2 API."""
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
    }
    payload = {
        "messages": messages,
        "model": MODEL,
        "size": size,
    }

    try:
        resp = requests.post(API_URL, json=payload, headers=headers, timeout=120)
        resp.raise_for_status()
        return resp.json()
    except requests.exceptions.RequestException as e:
        print(f"  -> API 请求失败: {e}")
        if hasattr(e, "response") and e.response is not None:
            print(f"     响应内容: {e.response.text[:500]}")
        return None


# ============================================================
# 关键帧处理
# ============================================================

def collect_ref_images(keyframe: dict) -> tuple[list[Path], list[Path], list[Path]]:
    """从关键帧数据中分组收集参考图.

    返回: (场景图列表, [], 角色+道具图列表)
    站位参考图由 --ref-frame 外部提供，这里返回空列表占位.
    """
    scene_images: list[Path] = []
    char_prop_images: list[Path] = []

    # 场景
    scene_file = keyframe.get("场景", "")
    if scene_file:
        p = resolve_path(f"场景图/{scene_file}")
        if p.exists():
            scene_images.append(p)

    # 道具（排在角色前面，因为道具是场景的一部分）
    for prop_file in keyframe.get("道具", []):
        p = resolve_path(f"道具/{prop_file}")
        if p.exists():
            char_prop_images.append(p)

    # 角色
    for role_file in keyframe.get("角色", []):
        p = resolve_path(f"人物/{role_file}")
        if p.exists():
            char_prop_images.append(p)

    return scene_images, [], char_prop_images


def process_keyframe(
    keyframe: dict,
    ref_frame_id: str | None = None,
    size: str = SIZE,
) -> bool:
    """处理单个关键帧：构建请求 -> 调用 API -> 保存结果."""
    frame_id = keyframe["id"]
    prompt = keyframe["提示词"]

    print(f"[{frame_id}] 生成中...")
    print(f"  景别: {keyframe.get('景别', '')}  |  角度: {keyframe.get('角度', '')}")

    # 收集参考图（分组）
    scene_images, _, char_prop_images = collect_ref_images(keyframe)

    # 站位参考图（来自 --ref-frame）
    position_images: list[Path] = []
    if ref_frame_id:
        ref_path = OUTPUT_DIR / f"{ref_frame_id}.png"
        if ref_path.exists():
            position_images.append(ref_path)
            print(f"  站位参考帧: {ref_frame_id}.png")
        else:
            print(f"  [警告] 站位参考帧不存在: {ref_path}")

    # 溶图次数估算
    rounds = count_generation_rounds(frame_id, ref_frame_id)
    round_label = ["纯文生图(0次)", "一次图生图(1次)", "二次溶图(2次-注意变形风险)", "多次溶图(>2次-高风险)"]
    print(f"  溶图次数: {round_label[min(rounds, 3)]}")

    total_refs = len(scene_images) + len(position_images) + len(char_prop_images)
    print(f"  参考图: 场景{len(scene_images)} + 站位{len(position_images)} + 角色/道具{len(char_prop_images)} = {total_refs}张")

    # 构建消息（图片按 场景→站位→角色/道具 顺序排列）
    messages = build_messages(prompt, scene_images, position_images, char_prop_images)

    # 调用 API
    result = call_api(messages, size)
    if result is None:
        print(f"[{frame_id}] 失败: API 无响应")
        return False

    # 解析返回
    try:
        choices = result.get("choices", [])
        if not choices:
            print(f"[{frame_id}] 失败: 返回无 choices")
            print(f"  完整响应: {json.dumps(result, ensure_ascii=False)[:300]}")
            return False

        content = choices[0].get("message", {}).get("content", "")
        image_url = extract_image_url(content)

        if not image_url:
            print(f"[{frame_id}] 失败: 无法从响应中提取图片 URL")
            print(f"  content 预览: {content[:200]}")
            return False

        print(f"  图片URL: {image_url[:80]}...")

        # 存档旧图 -> 保存新图
        archive_existing(frame_id)
        return download_image(image_url, OUTPUT_DIR / f"{frame_id}.png")

    except Exception as e:
        print(f"[{frame_id}] 解析响应异常: {e}")
        return False


def load_keyframes() -> list[dict]:
    """从 JSON 文件加载所有关键帧."""
    with open(KEYFRAME_JSON, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("关键帧列表", [])


# ============================================================
# 主流程
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="桃妖妖分镜关键帧图片生成器")
    parser.add_argument(
        "--frame", "--frames",
        type=str,
        default=None,
        help="指定要生成的帧ID（逗号分隔），如: V1_K1 或 V1_K1,V1_K2。不指定则全部生成。",
    )
    parser.add_argument(
        "--ref-frame",
        type=str,
        default=None,
        help="站位参考帧ID，将该帧的已生成图片作为站位+光影+构图参考。",
    )
    parser.add_argument(
        "--size",
        type=str,
        default=SIZE,
        help=f"输出尺寸（默认: {SIZE}）",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=REQUEST_INTERVAL,
        help=f"请求间隔秒数（默认: {REQUEST_INTERVAL}）",
    )
    args = parser.parse_args()

    all_keyframes = load_keyframes()

    # 帧过滤
    if args.frame:
        ids = {s.strip() for s in args.frame.split(",")}
        keyframes = [kf for kf in all_keyframes if kf["id"] in ids]
        missing = ids - {kf["id"] for kf in keyframes}
        if missing:
            print(f"警告: 以下ID不存在: {missing}")
        if not keyframes:
            print("错误: 没有匹配的关键帧")
            sys.exit(1)
    else:
        keyframes = all_keyframes

    total = len(keyframes)
    print(f"加载 {len(all_keyframes)} 个关键帧，本次处理 {total} 个")
    if args.ref_frame:
        print(f"站位参考帧: {args.ref_frame}")
    print(f"输出目录: {OUTPUT_DIR}")
    print(f"废弃存档: {DISCARD_DIR}")
    print(f"图生图模式: 场景图 → 站位参考 → 角色/道具 (按序排列)")
    print(f"尺寸: {args.size}")
    print(f"请求间隔: {args.interval}s")
    print("-" * 50)

    success = 0
    fail = 0

    for i, kf in enumerate(keyframes, 1):
        print(f"\n({i}/{total}) ", end="")

        ok = process_keyframe(kf, ref_frame_id=args.ref_frame, size=args.size)
        if ok:
            success += 1
        else:
            fail += 1

        if i < total:
            time.sleep(args.interval)

    print(f"\n{'=' * 50}")
    print(f"完成! 成功: {success}, 失败: {fail}, 总计: {total}")
    print(f"输出目录: {OUTPUT_DIR}")
    if fail == 0:
        # 列出废弃目录中的存档
        discards = sorted(DISCARD_DIR.glob("*.png"))
        if discards:
            print(f"废弃存档 ({len(discards)}张): {DISCARD_DIR}")


if __name__ == "__main__":
    main()
