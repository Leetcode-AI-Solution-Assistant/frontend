# LeetCode Solution Assistant Extension

Chrome extension that captures the current LeetCode problem, starts a username-backed session with the FastAPI backend, and lets you chat with an assistant that already knows your question context.

## Setup

1. Run the backend (default): `uvicorn backend.main:app --reload`
2. Load the unpacked extension: Chrome > Extensions > Load unpacked > select `frontend/`.
3. Open a LeetCode question page (e.g., `https://leetcode.com/problems/.../description/`).
4. Click the extension icon, create a username (hits `/create_session/{name}`), then chat. The extension automatically extracts the question number and calls `/questions` before chatting.

If your backend is on a different host/port, update `BACKEND_BASE_URL` at the top of `popup.js`.

## Load the extension in Chrome

1. Open Chrome and go to `chrome://extensions/`.
2. Toggle on Developer mode (top-right).
3. Click "Load unpacked" and select the `frontend/` directory of this repo.
4. You should now see the LeetCode Solution Assistant listed with its icon; pin it if you want quick access.
