---
id: single-file-canvas-game
description: Build a complete browser game in one HTML file using Canvas API.
when_to_use: Task asks for a playable game (or interactive simulation) delivered as a single HTML file with keyboard controls and real-time rendering.
kind: llm
---

1. write_file index.html with: <canvas> element, inline <style> (dark bg, centered), single <script>.
2. In script: init canvas+ctx, define game state object, input map (keydown/keyup), game loop via requestAnimationFrame.
3. Add collision detection, scoring, reset logic.
4. Expose window.__test__ hook returning game state for validation.
5. start_static_server.
6. validate_html: check canvas exists, __test__ returns expected keys.
