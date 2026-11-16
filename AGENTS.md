# Instructions for AI coding agents

WebGL page (three.js) shown in glasses-free 3D on a Samsung Odyssey 3D G90XF through the LeiaSR
runtime. Read `docs/display-3d.md` before changing anything about rendering.

## Environment

- Windows 11, G90XF at 3840×2160 and 150 % scaling (the window is 2560×1440 CSS px), USB upstream cable connected.
- LeiaSR runtime in `C:\Program Files\LeiaSR`; services "SR Service" and "SR Eye Tracker".
- Python 3 (standard library; `numpy` for `tools/verify_weave.py`), Node.js, Chrome or Edge.
- three 0.172, Vite 6, TypeScript 5.7 strict.

## Commands

```
Start-Odyssey3D.bat                       start everything: fresh bridge, server, full-screen page
python sr-bridge\sr_bridge.py --probe     hardware state (0 calibrated, 2 monitor not identified, 1 no runtime)
npm run dev                               dev server on 127.0.0.1:5173
npm run build                             type-check + bundle
python tools\verify_weave.py              compare the weave formula with the official weaver
python tools\verify_page.py               open the real page full-screen and check what the panel receives
```

## Rules

- Work in `src/main.ts` (`buildScene`) and in new files. Do not edit `stereo-composer.ts`,
  `sr-client.ts` or `sr_bridge.py` unless a measurement shows they are at fault; afterwards
  `python tools\verify_weave.py` must report `agreement` above 0.9.
- Drawing buffer = window × devicePixelRatio. Never scale the canvas with CSS.
- Left view = left eye; eye position in cm for Dimenco; lens on only in full-screen weave mode.
- You cannot see depth: a screenshot only shows stripes. "Done" means built **and** checked, by
  `verify_weave.py` or by a person in front of the monitor (key `T`: red with the right eye
  closed, cyan with the left eye closed). Say so when it was not checked.
- If `/state` says `hubConversion: true`, Samsung's Odyssey 3D Hub is drawing over the page: ask
  the user to turn off "Convert to 3D in full screen" in that app. Do not change it yourself.
- Smart App Control may block freshly built unsigned executables. Do not disable or bypass it;
  stay with Python (ctypes on the runtime's signed DLLs) and JavaScript.
- Before finishing: lens off, and say whether a bridge or a server is still running.
- Do not read `node_modules/`, `dist/`, `tools/weave-check/`.

## Kickoff prompt

Paste this as the first message, with the last paragraph replaced by your project.

> This folder drives a Samsung Odyssey 3D G90XF (glasses-free 3D, LeiaSR runtime) from a WebGL
> page. The 3D pipeline here was verified against the official weaver: do not rewrite what works.
>
> First read `AGENTS.md` and `docs/display-3d.md`. Then run
> `python sr-bridge\sr_bridge.py --probe`. Exit code 0 with `"weaveCorners":{"valid":true`: go on.
> Exit code 2, or a 7680×4320 panel: the monitor's USB upstream cable is not connected; ask me to
> plug it in and stop. Exit code 1: ask me to start the SR services.
>
> You cannot see the 3D effect. To know whether it is right, run `python tools\verify_weave.py`
> while I sit still in front of the monitor (warn me first: a red/cyan rectangle appears for
> three seconds and the lens switches on), or start `Start-Odyssey3D.bat` and ask me what I see.
> Never say the 3D works because the build passed.
>
> The project: <what to show in 3D, the data, the interactions, and what counts as done>.
