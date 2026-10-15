import os
import json

# 获取当前文件所在目录，确保能正确找到同目录下的 config.json
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")

DEFAULT_PORT = 8088

DEFAULT_BASE_URL = "https://api.openai.com/v1"


def _normalize_ai_config(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raw = {}
    return {
        "api_key": str(raw.get("api_key", "") or ""),
        "base_url": str(
            raw.get("base_url", DEFAULT_BASE_URL) or DEFAULT_BASE_URL
        ),
        "model": str(raw.get("model", "gpt-3.5-turbo") or "gpt-3.5-turbo"),
        "prompt_template": str(
            raw.get("prompt_template", DEFAULT_PROMPT) or DEFAULT_PROMPT
        ),
    }


def get_platform_ai_config(config: dict, platform: str, profile=None) -> dict:
    """读取指定平台 AI 配置。

    新格式：
      - youtube_ai: { api_key, base_url, model, prompt_template }
      - tiktok_ai:  { api_key, base_url, model, prompt_template }

    TikTok 额外支持两组配置（方便快速切换）：
      - tiktok_ai   (profile A)
      - tiktok_ai_2 (profile B)

    兼容旧格式（顶层 api_key/base_url/model/prompt_template）：
      - 当新字段缺失时回退到旧字段。
    """
    if not isinstance(config, dict):
        config = {}

    pk = str(platform).lower()
    if pk == "youtube":
        p = str(profile or "A").strip().upper()
        key = "youtube_ai_2" if p in ("B", "2") else "youtube_ai"
    elif pk == "tiktok":
        p = str(profile or "A").strip().upper()
        key = "tiktok_ai_2" if p in ("B", "2") else "tiktok_ai"
    else:
        key = "youtube_ai"

    if isinstance(config.get(key), dict):
        merged = dict(config.get(key) or {})
    else:
        # profile B：如果未配置 _2，则复用 A
        base_key = "youtube_ai" if pk == "youtube" else "tiktok_ai"
        if key.endswith("_2") and isinstance(config.get(base_key), dict):
            merged = dict(config.get(base_key) or {})
        else:
            merged = {}

    # 兼容旧格式的回退
    for k in ("api_key", "base_url", "model", "prompt_template"):
        if k not in merged or merged.get(k) in (None, ""):
            if k in config:
                merged[k] = config.get(k)

    return _normalize_ai_config(merged)


DEFAULT_PROMPT = """# Role: 
You are a passionate inheritor of Chinese Intangible Cultural Heritage, specializing in Huaiyang Folk Art. Your expertise covers "Ni-Ni-Gou" (mysterious clay sculptures) and "Cloth Tigers" (traditional fabric crafts). You value history, mythology, handmade warmth, and the preservation of dying arts.

# Task:
Analyze the Video Title and Top Comments to determine:
1. Is this video RELEVANT to your niche (Folk Art, Clay/Pottery, Textile/Fabric Crafts, Cultural Heritage, Mythology, Traditional Skills)?
2. Is the creator a high-quality PEER worth following?

- If RELEVANT: 
  Line 1: YES
  Line 2: [Comment Content] Write a short, engaging, and warm English comment (under 50 words). Show appreciation from a traditional craftsman's perspective. Be humorous but respectful.
  Line 3: FOLLOW: YES (Only if the content features Clay, Sculpture, Pottery, Traditional Fabric/Textile Art, or Cultural Heritage preservation). Otherwise, FOLLOW: NO.

- If IRRELEVANT (Gaming, Politics, Finance, Gossip, Modern Tech reviews, Low-quality Vlogs): 
  Line 1: NO

# Data:
- Video Title: {title}
- Top Comment 1: {comment_1}
- Top Comment 2: {comment_2}
- Top Comment 3: {comment_3}

# Rules for "FOLLOW":
- YES: "Handmade pottery", "Wood carving", "Traditional embroidery/weaving", "Folk art documentary", "Museum restoration", "Clay sculpting", "Fabric sewing/crafts".
- NO: "Slime mixing", "Industrial manufacturing", "Funny pranks", "Cooking/Food" (unless it's traditional cultural food), "Life hacks".

# Output Example 1 (Clay/Pottery Peer - Follow):
YES
The texture you achieved is incredible! 🏺 Reminds me of the ancient soil we use for our Huaiyang clay dogs. Beautiful connection to the earth.
FOLLOW: YES

# Output Example 2 (Fabric/Textile Peer - Follow):
YES
That stitching precision is masterful! 🧵 As someone who makes traditional Cloth Tigers, I know how much patience this takes. stunning work!
FOLLOW: YES

# Output Example 3 (Relevant Topic but Generic - No Follow):
YES
Seeing young people interested in history makes my heart smile! ❤️ Keep sharing these stories; our heritage needs to be heard.
FOLLOW: NO

# Output Example 4 (Irrelevant):
NO

# Start Analysis:"""


def load_config():
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        print(f"Failed to load config: {e}")
    return {}


def save_config(config_data):
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(config_data, f, indent=2)
        return True
    except Exception as e:
        print(f"Failed to save config: {e}")
        return False
