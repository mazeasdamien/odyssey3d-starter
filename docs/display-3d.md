# How the Odyssey 3D (G90XF) makes depth, and how to drive it

Measured on one monitor (LeiaSR runtime 1.36.4) by comparing this project's output with the
official LeiaSR weaver. Not vendor documentation: it is what worked, and what broke.

## The display

- 3840×2160 panel, 59.67 × 33.57 cm, behind a **switchable lenticular lens**. Lens off: a normal
  2D screen. Lens on: each eye sees only every other subpixel.
- An **eye-tracking camera** in the monitor, reached through the **USB upstream cable**. Without
  it the runtime does not identify the monitor: no calibration, no tracking.
- Software must **weave** a left-eye and a right-eye image, subpixel by subpixel, for the current
  eye position and this monitor's factory calibration.

## The chain

```
Windows services "SR Service" + "SR Eye Tracker"      (LeiaSR runtime)
        │  signed DLLs, loaded with ctypes
sr-bridge/sr_bridge.py        http://127.0.0.1:5033
        │  /state 60 times a second, /calibration once, /lens/enable|disable
src/odyssey3d/sr-client.ts    validated state, smoothed eyes
        ├─ kooima-camera.ts    two off-axis cameras (left eye, right eye)
        └─ stereo-composer.ts  renders both views, then weaves them
                │
        WebGL canvas = exactly 3840×2160, full-screen, lens on
```

## Bridge API

| Route | Answer |
|---|---|
| `GET /state` | JSON: `apiVersion` (2), `connected`, `lensEnabled`, `tracking`, `leftEyeMm`, `rightEyeMm`, `weaverPosMm` (mm; origin at the screen centre, x to the viewer's right, y up, z towards the viewer), `display`, `optics`, `weaveCorners` |
| `GET /state?lead=35` | same, with `weaveCorners` computed for where the head will be in 35 ms (the runtime's own predictor) |
| `GET /stream?lead=35` | the state pushed 120 times a second as server-sent events; this is what the page uses |
| `POST /lens/enable` · `/lens/disable` | switches the lens, answers with the state |
| `GET /calibration` | 2 × 480×270 bytes: the two factory correction maps (A then B), first row = bottom of the panel |

`weaveCorners` holds, for the four panel corners (`tl`, `tr`, `bl`, `br`), the five values
`[a2.x, a3.z, a3.w, a5.x, a5.y]` from `Dimenco::Weaver::FillAttributes` for the current eye
position. `valid: false` means no calibration, so no correct 3D.

The bridge switches the lens off by itself when the page stops polling for 3.5 s.

## The weave

For each panel pixel, interpolate the five values between the four corners, read `corrA` and
`corrB` from the two calibration maps, then:

```
rsq   = 1 / sqrt(1 + a3.z² + a3.w²)
phase = a2.x + a5.x · rsq + 2 · a5.y · (corrB − 0.5) − corrA
for each subpixel c in {R, G, B}:
    p = fract(phase + dphase/dx · c/3 + 0.25)
    w = clamp(−|2p − 1| · 10 + 5.5, 0, 1)        # share of the LEFT view
    out[c] = mix(right'[c], left'[c], w)
```

`left'` and `right'` are the two views after crosstalk compensation
(`k = 0.012854 / (1 − 0.012854)`; `left' = left − k·(right − left)`,
`right' = right + k·(right − left)`), blended as display (sRGB) values.

## Rules that must not be broken

1. **One canvas pixel = one panel pixel.** Drawing buffer = window × `devicePixelRatio`. No CSS
   scaling of the canvas, no browser zoom. Checked every frame.
2. **Full-screen on the 3D monitor.** The phase depends on the absolute panel column.
3. **Eye position in centimetres** for `SetGlobalParameters` (the tracker gives millimetres).
4. **The left view is the left eye's** (negative x). No swapping.
5. **Lens on only in full-screen weave mode**, and off when leaving.
6. **Restart the bridge after any hardware change.** It reads geometry and calibration once, at
   start-up. A bridge started before the USB cable was plugged in serves wrong data for ever.
7. **2D interface large, opaque and bold** while the lens is on.
8. **Samsung's own conversion off.** Odyssey 3D Hub has a setting "Convert to 3D in full screen".
   When it is on, a few seconds after any browser window goes full-screen the Hub starts
   `Odyssey3DPlayer.exe`, which converts the window to 3D by itself and draws over it. The page
   is pixel-perfect underneath and the viewer sees mush. The bridge reports it as
   `hubConversion: true` in `/state`.

## Failures seen

| Symptom | Cause | Fix |
|---|---|---|
| `--probe` reports 7680×4320, 69.8 cm, no calibration; log says "Can not retrieve product code" | USB upstream cable not connected | Connect it, restart the bridge |
| Double image, no depth, hardware recognised | Wrong phase formula, or eyes passed in mm | Use `stereo-composer.ts` and `sr_bridge.py` as they are |
| No depth although every check on the page passes; `verify_page.py` says COVERED | Odyssey 3D Hub's "Convert to 3D in full screen" draws over the page | Turn that setting off in Odyssey 3D Hub (rule 8) |
| Depth stutters or lags when the head moves | Eye data too slow or too late. Seen here: the lens-state query took 31 ms inside every `/state` answer (30 updates a second, 31 ms late), and no prediction | Use `/stream` (120 Hz), keep slow runtime calls out of the state path, tune the prediction lead (keys `,` `.`) |
| Lens flickers on and off several times a second | Two pages talk to the bridge and one keeps forcing the lens off | A page only says what it wants when that changes; close stray tabs of the page |
| Moiré, bands | Canvas resampled (CSS size ≠ buffer, browser zoom) | Rule 1 |
| Striped Windows desktop | Lens left on | `POST /lens/disable`; rule 5 |
| The official weaver outputs the left view only | Its window is hidden or covered, the lens is off, or nobody is tracked | Visible window on top, lens on, someone in front |
| "Blocked by an application control policy" | Smart App Control refuses freshly built unsigned executables | Do not work around it: stay with Python + ctypes on the signed DLLs |
| Bridge "offline" in the page | The minimised Python window was closed | Run `Start-Odyssey3D.bat` again |

## Limits

- The weave is computed for a **predicted** head position (35 ms ahead by default, the runtime's
  own predictor). The right lead depends on the PC and the refresh rate; it has only been tuned
  by eye on one machine.
- Without factory calibration the shader falls back to a generic approximation that does not give
  a clean 3D image. It is not a usable fallback.
- Chrome or Edge (WebGL2), page zoom 100 %. Windows only.
