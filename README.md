# arsubs

Live subtitles for a face-to-face conversation, rendered as a floating panel in the
passthrough of a Meta Quest 3.

You point the headset at whoever is talking and read the words underneath them.
This repository holds the host-side static server, the headset client (WebXR) and
the shell scripts that wire the two together over `adb reverse`.

> **Status: milestone 2 (M2).** The client opens a WebXR `immersive-ar` session
> and shows one world-locked text panel you can grab, drag and resize with your
> hands. Speech recognition, translation and speaker tracking are *not* built
> yet — the panel currently shows a small set of hardcoded sample lines.

## What it does

- The host runs a tiny static server (`server.mjs`) and exposes the client over
  `http://localhost:<port>` on the headset, carried by `adb reverse`.
- The headset browser opens that URL, checks that `immersive-ar` is supported
  and starts a WebXR session with the passthrough left untouched.
- A single subtitle panel is drawn in world space at a fixed depth, in front of
  the wearer. It is transparent: the Quest compositor already shows the room in
  real light, so the client never renders a second copy of the camera feed.
- The panel is grabbed, moved and resized directly with your hands (or with a
  thumbstick, if a controller is paired), and it stays where you leave it.
- The headset reports what it is doing back to the host, because a Quest 3
  refuses `adb exec-out screencap` (VR surfaces are `FLAG_SECURE`) and there is
  therefore no way to look at it from the host.

## Features

- **Passthrough AR** — one `immersive-ar` session, `local-floor` reference
  space, hand tracking requested as an optional feature.
- **Direct manipulation** — pinch (or squeeze / trigger) to grab the panel,
  push your hand forward or pull it back to change its distance, spread two
  hands to resize the text.
- **Persistent layout** — the panel position and scale are clamped to sane
  limits and stored in `localStorage` under `arsubs.layout.v1`, so the headset
  remembers where you put it.
- **Presets** — `below-chin`, `upper-chest`, `left-shoulder` and `close`.
- **Readable over anything** — the line is drawn on a translucent dark pill with
  a dark stroke, because the background is an arbitrary real room: a white
  wall, a sunny window, a dark jacket.
- **Vendored fonts** — Noto Sans subsets (Latin, Latin Extended, Cyrillic) ship
  in `public/fonts`; nothing is fetched from the network at runtime. Chinese
  rides on the headset's own Noto Sans CJK.
- **Self-reporting client** — the page posts its state to `/log`; the host
  exposes `/state` and `/build`.
- **One window, one URL** — reloads happen in place against a stable URL, and
  the HUD prints a short build id so you can always tell which build is
  loaded. Add `?autoreload` to the URL to have the page reload itself whenever
  the build changes.

## Requirements

- **Meta Quest 3** with Oculus Browser (Chromium) — the client needs WebXR
  `immersive-ar` and, for the hand gestures, hand tracking.
- **Android platform-tools** (`adb`) on the host, with the headset connected
  over USB and authorised.
- **Node.js 18 or newer** on the host — the server uses ES modules and
  top-level `await`, and has no third-party dependencies.
- **bash**, `coreutils` and `python3` for the helper scripts.

## Install

```sh
git clone <this repository>
cd arsubs
```

There is nothing to install: the server has no dependencies, and the client is
plain HTML/JS/CSS. The fonts are vendored.

## Usage

```sh
./run.sh            # server + adb tunnel + wake the headset + open the page
./run.sh --tunnel   # only re-arm the adb reverse tunnel
./run.sh --logs     # tail the headset's self-reported state
./run.sh --stop     # stop the keep-awake watchdog
```

`run.sh` starts `server.mjs` in the background (its output goes to
`logs/server.log`), arms `adb reverse tcp:<port> tcp:<port>`, starts
`keepawake.sh`, and opens `http://localhost:<port>/` in the headset browser.
Then put the headset on and press **Enter AR** in the page.

The server can also be run on its own:

```sh
node server.mjs            # 127.0.0.1:8787
PORT=9000 node server.mjs  # different port
```

### Endpoints

| endpoint | method | what it does |
|---|---|---|
| `/` | GET | the client page (`public/index.html`) |
| `/build` | GET | `{"build": "<8 hex chars>", "page": …}` — recomputed on every request |
| `/state` | GET | the last thing the headset reported, plus the last 12 events |
| `/log` | POST | the headset's self-report; returns `204` |

### Controls

Hands (no controller needed):

| gesture | effect |
|---|---|
| point at the text | a white ring appears — a pinch will grab it |
| pinch / squeeze / trigger | grab the panel and move it with your hand |
| still pinching, push the hand forward | bring the text toward you |
| still pinching, pull the hand back | send the text away |
| release | the panel stays where you let go |
| two hands, spread apart | resize the text (pinch-zoom) |
| pinch on empty space | next sample line |

With a controller paired:

| input | effect |
|---|---|
| right stick (vertical / horizontal) | distance / text size |
| left stick | fine nudge of position |
| X or A | cycle the presets |
| Y or B | next sample line |
| grip | toggle the position readout |
| menu + squeeze | reset to the default layout |

## Layout of the repository

| path | |
|---|---|
| `server.mjs` | static file server plus the `/log`, `/state` and `/build` endpoints |
| `build.mjs` | build id (a short hash of the client sources) |
| `public/index.html` | HUD, styles, secure-context notes |
| `public/app.js` | the WebXR session, the panel, the input model |
| `public/layout.js` | layout limits, presets and the anchoring rule — no XR, no DOM, no WebGL |
| `run.sh` | server, `adb reverse`, wake the headset, launch the page |
| `keepawake.sh` | watchdog that re-wakes a suspended headset |
| `test-shaders.sh` | compiles the GLSL in `app.js` with a real compiler |
| `public/fonts/` | vendored Noto Sans subsets |
| `logs/` | runtime output (ignored by git) |

`layout.js` is deliberately free of XR, DOM and WebGL so that a future Android
client can share the exact same placement math. `anchorFor()` — the rule that
will eventually follow a detected face — is already there, but no face
detection runs yet.

## Development

```sh
node --check server.mjs          # parse check, all of it
node --check build.mjs
node --check public/app.js
node --check public/layout.js
```

```sh
./test-shaders.sh                # needs glslangValidator (package: glslang-tools)
```

`node --check` only parses JavaScript, so a shader typo would otherwise ship
silently and surface on the headset as a bare compile error with no stack.
`test-shaders.sh` extracts both shader template literals and compiles them with
`glslangValidator`, and additionally asserts that the fragment shader samples
the panel texture, samples the cursor texture and premultiplies alpha (the XR
layer requires premultiplied alpha).

Serve the client on the desktop browser to iterate on the layout maths, but
note that only a headset has `navigator.xr`.

## Configuration

| variable | default | used by | meaning |
|---|---|---|---|
| `PORT` | `8787` | `run.sh`, `server.mjs` | port served on the host and tunnelled to the headset |
| `HOST` | `127.0.0.1` | `server.mjs` | address the server binds to |
| `QUEST` | `2G0YC5ZG1W00QH` | `run.sh`, `keepawake.sh` | adb serial of the headset |
| `POLL` | `4` | `keepawake.sh` | seconds between wakefulness checks |

The headset URL can take two query parameters: `?autoreload` reloads the page
in place whenever the build id changes, and `?dump` shows the current layout as
JSON.

## Limitations and known issues

- **No speech yet.** The panel shows hardcoded sample lines (English, Russian,
  Chinese, Latvian). ASR, translation and the "is this thought finished?"
  boundary policy are not implemented.
- **No face tracking.** The camera is not used at all — the `camera-access`
  feature is deliberately not requested. The panel stays where you put it.
- **The headset must be awake.** A Quest 3 suspends on wear-detection and a
  suspended headset does not fetch pages, which looks exactly like a broken
  tunnel. `keepawake.sh` removes that as a variable; if `/state` is empty while
  the tunnel answers from the device, check `logs/keepawake.log`.
- **No TLS.** The client is served over plain `http://localhost`, which the
  headset browser accepts as a secure context (so WebXR works) and which only
  exists on the headset's loopback thanks to `adb reverse`. The server binds
  `127.0.0.1` by default.
- **No screenshots.** `adb exec-out screencap` returns a 0-byte file on the
  Quest 3. Verification goes through `/state` instead: a non-empty state with
  `"ev": "firstframe"` is the proof that the client rendered a frame.
- **Verified on one device.** Quest 3, Android 14, Snapdragon XR2 Gen 2,
  Adreno/Vulkan, Oculus Browser 152, OpenXR runtime broker present. Other
  headsets are untested.

## License

MIT — see [LICENSE](LICENSE).
