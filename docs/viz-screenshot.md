# viz:shot — capture the GPU client for visual review

`npm run viz:shot` renders the real GPU client in headless Chrome and writes a
PNG. It exists so a UI change can be **seen** before it ships — the mocked test
suite proves geometry and contracts, but only a rendered frame shows spacing,
rhythm and colour the way a viewer meets them. It is a review tool, not a
release gate: nothing in `check` or `release:check` depends on it.

## Quick reference

```bash
npm run viz:shot                                    # anonymous visitor (login gate when auth is armed)
npm run viz:shot -- --auth                          # logged-in member, Projects view
npm run viz:shot -- --auth --select-first           # first project selected: run list + run form
npm run viz:shot -- --auth --view Runs              # any nav tab by its label
npm run viz:shot -- --auth --tuning                  # open the floating Scene Tuning window
npm run viz:shot -- --out /tmp/before.png           # explicit destination
npm run viz:shot -- --url http://127.0.0.1:5173     # attach to a dev stack already running
npm run viz:shot -- --debug                         # page console + failed requests on stderr
npm run viz:shot -- --width 528 --height 800        # narrow/compact layouts
```

PNGs default to `screenshots/<view>-<mode>.png` (git-ignored). Viewport
defaults to 1600×900 at deviceScaleFactor 2.

## What each mode renders

- **No flags** — whatever an anonymous browser gets. With the checkout `.env`
  arming the auth gate (the usual state here) that is the **login gate**, and
  the script says so instead of failing. With auth off it enters the app and
  opens the requested view.
- **`--auth`** — a logged-in org member **without any real OAuth session**:
  `/auth/whoami`, `/api/org`, `/api/projects`, the run list, `/api/profiles`,
  `/api/account/models` and `/api/github/installations` are stubbed via
  Puppeteer request interception (the same technique as `viz-gpu-smoke`'s
  account arm). The fixture is one project with five runs covering delivered
  (+ commit receipt), failed (+ error line) and cost display.
- **`--select-first`** — clicks the first project row through the canvas hit
  targets (`?atomaDiag=1`), so the expanded run list and the run form render.

## How it works, and its sharp edges

- With no `--url` it spawns `scripts/viz-dev.mjs` (source path, no build) on
  two freshly reserved ports and tears it down afterwards. The two ports are
  reserved **simultaneously** — two sequential `listen(0)` calls can return the
  same port.
- The arrival gate is passed through the a11y bridge; `atoma.viz.entered` is
  cleared first so the capture is always a fresh visitor.
- Every un-stubbed `/api/*` call in `--auth` mode still reaches the real dev
  server, which answers 401 when the gate is armed. A 401 on a route the
  client treats as session loss causes a **reload loop** — the symptom is a
  timeout with an empty `#root`. If a capture starts timing out after new API
  routes are added to the client, run `--debug`, look for `[http 401]`, and add
  the route to `gatedStubs()` in `scripts/viz-screenshot.mjs`.
- The interception handler must never throw: an interception left neither
  responded nor continued hangs its request forever, which presents as the
  same empty-page timeout.

## Reviewing a change

Capture before and after on the same flags and compare:

```bash
git stash && npm run viz:shot -- --auth --select-first --out screenshots/before.png && git stash pop
npm run viz:shot -- --auth --select-first --out screenshots/after.png
```

For layout work also capture a narrow viewport (`--width 528`) — the compact
project rows and the stacked DOM form have their own geometry.
