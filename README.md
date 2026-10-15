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
with placeholder values (`YOUR_API_KEY_HERE`) - the real keys have been removed and are **not**
present in this repository:

```json
{
  "ai_config_1": { "api_key": "YOUR_API_KEY_HERE", "base_url": "https://api.perplexity.ai", "model": "sonar-pro" },
  "ai_config_2": { "api_key": "YOUR_API_KEY_HERE", "base_url": "https://api.siliconflow.cn/v1", "model": "deepseek-ai/DeepSeek-V3.2" }
}
```

You can also enter the keys directly in the Python GUI: the AI config section has input
fields per profile (`ai_api_key_vars`); saving writes them back into `config.json`. No
environment variables are required - `python_app/ai_engine.py` starts with `self.api_key = ""`
and only uses whatever key the GUI / `config.json` provides.

## Requirements

- **Windows** (the desktop client uses `native_input.py` with Windows `ctypes`/`SendInput`).
- Python 3.x. The only third-party dependency is the [`openai`](https://pypi.org/project/openai/) package; everything else (Tkinter, `http.server`, `ctypes`) is in the standard library:
  ```
  pip install openai
  ```

## Run

1. Install the dependency above and start the client (`一键启动.bat` or `python -m python_app.main` from the `plugin_interaction_demo/` directory).
2. Load the unpacked extensions under `extension/youtube` and `extension/tiktok` in Chrome (chrome://extensions -> Developer mode -> Load unpacked).
3. Open a YouTube / TikTok tab, open the extension popup, and use the client UI to drive it.

## Extension permissions (as declared in each manifest.json)

- **YouTube extension**: permissions `scripting`, `activeTab`, `tabs`; host permissions `https://www.youtube.com/*` and `http://localhost:8088/*`.
- **TikTok extension**: permissions `activeTab`, `tabs`, `scripting`, `storage`; host permissions `https://www.tiktok.com/*` and `http://localhost:8099/*`.
- Both are Manifest V3 with a background service worker; they talk only to the platform pages and the local loopback ports above.

> This project talks only to `127.0.0.1` and runs locally. It is intended for personal
> automation; automated liking / commenting / following on YouTube or TikTok may violate
> each platform's Terms of Service. Use at your own risk and do not run it against accounts
> you are not authorized to automate.

## License & Attribution / 许可与来源

Original project code authored for this repository is released under the MIT License; see [LICENSE](./LICENSE).

When reusing or redistributing a substantial portion, retain the LICENSE and its copyright notice. The copyright notice includes this original source URL: https://github.com/change979666/plugin-interaction-bridge. Please keep the source link visible in your redistributed source or project documentation.

This license applies only to original material that the repository maintainer has the right to license. Third-party libraries, vendor code, platform SDKs, trademarks, screenshots, icons, fonts, and other external assets remain subject to their respective licenses and terms. Review those terms before reuse.

**Project status:** personal/archived project, shared as-is. Maintenance, compatibility, and production readiness are not guaranteed.
