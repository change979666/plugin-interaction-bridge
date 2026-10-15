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

## License & Attribution / 许可与来源

Original project code authored for this repository is released under the MIT License; see [LICENSE](./LICENSE).

When reusing or redistributing a substantial portion, retain the LICENSE and its copyright notice. The copyright notice includes this original source URL: https://github.com/change979666/plugin-interaction-bridge. Please keep the source link visible in your redistributed source or project documentation.

This license applies only to original material that the repository maintainer has the right to license. Third-party libraries, vendor code, platform SDKs, trademarks, screenshots, icons, fonts, and other external assets remain subject to their respective licenses and terms. Review those terms before reuse.

**Project status:** personal/archived project, shared as-is. Maintenance, compatibility, and production readiness are not guaranteed.
