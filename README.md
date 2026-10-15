# Plugin Interaction Bridge

A local automation bridge between a Python desktop client (Tkinter UI + built-in HTTP server)
and Chrome (Manifest V3) extensions for YouTube and TikTok.

## What it does

- The **Chrome extensions** run inside the YouTube / TikTok tabs, scrape page data
  (video title, URL, duration, like/comment counts, top comments) and perform automated
  actions (like, comment, follow, watch-and-skip, monitor-next).
- The **Python client** displays and records that data, calls a configurable AI engine
  to generate comments / action strategies, and dispatches commands back to the extensions.
- The two sides talk over a local HTTP loopback API, with one isolated port per platform
  to keep state separate.

## Architecture

```
plugin_interaction_demo/
  python_app/                 # Python client: UI + HTTP server + AI engine
    main.py                   # entry point
    ui.py                     # Tkinter UI (YouTube left / TikTok right)
    server.py                 # local HTTP server: /poll, /data, /clear_queue
    ai_engine.py              # calls the configured LLM endpoint
    config.py / state.py
    config.json               # <-- fill in your own API keys (see below)
  extension/
    youtube/                  # YouTube MV3 extension
    tiktok/                   # TikTok MV3 extension
```

- YouTube extension connects to `http://127.0.0.1:8088`
- TikTok extension connects to `http://127.0.0.1:8099`

## HTTP protocol (extension <-> Python)

- `GET  /poll?ready=true|false` - extension polls for the next command.
- `POST /data`                  - extension reports the current video data / events.
- `POST /clear_queue`           - clear the pending command queue for a platform.

## Configuration

Edit `python_app/config.json` and set your own API credentials. The committed file ships
with placeholder values - the keys have been removed:

```json
{
  "ai_config_1": { "api_key": "YOUR_API_KEY_HERE", "base_url": "https://api.perplexity.ai", "model": "sonar-pro" },
  "ai_config_2": { "api_key": "YOUR_API_KEY_HERE", "base_url": "https://api.siliconflow.cn/v1", "model": "deepseek-ai/DeepSeek-V3.2" }
}
```

## Run

1. Install Python dependencies and start the client (`一键启动.bat` or `python main.py`).
2. Load the unpacked extensions under `extension/youtube` and `extension/tiktok` in Chrome.
3. Open a YouTube / TikTok tab, open the extension popup, and use the client UI to drive it.

> This project talks only to `127.0.0.1` and runs locally. It is intended for personal
> automation; respect each platform's Terms of Service.
