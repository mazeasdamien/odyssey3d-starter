"""Checks what the real page puts on the real panel.

Opens the page full-screen on the test pattern (left view red, right view cyan), grabs the screen
at native resolution, and compares every subpixel with the weave expected from the bridge's
attributes at that moment. This covers what verify_weave.py cannot see: the browser, the window,
display scaling, the canvas size.

    python tools/verify_page.py [url] [--keep]

Starts the bridge and the dev server if they are not running, and stops what it started.
The screen shows the full-screen test pattern for about ten seconds. Needs numpy and Pillow.
"""
from __future__ import annotations

import ctypes
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

import numpy as np
from PIL import ImageGrab

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import verify_weave as vw  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRIDGE = "http://127.0.0.1:5033"
DEFAULT_URL = "http://localhost:5173/?test=1&hud=0"
BROWSERS = [
    os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
    os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
    os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
    os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
]


def get(url: str, timeout: float = 2.0) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read()


def up(url: str) -> bool:
    try:
        get(url)
        return True
    except OSError:
        return False


def wait_until(check, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.3)
    return False


def kill_tree(proc: subprocess.Popen) -> None:
    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    url = args[0] if args else DEFAULT_URL
    ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # physical pixels

    started = []
    try:
        if not up(BRIDGE + "/state"):
            started.append(subprocess.Popen([sys.executable, os.path.join(ROOT, "sr-bridge", "sr_bridge.py")],
                                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            if not wait_until(lambda: up(BRIDGE + "/state"), 20):
                print("the SR bridge did not start")
                return 1
        state = vw.bridge_state()
        if not state["weaveCorners"]["valid"]:
            print("no lens calibration: the runtime has not identified the monitor")
            return 2

        origin = url.split("/?")[0].rstrip("/") + "/"
        if not up(origin):
            started.append(subprocess.Popen("npm run dev", cwd=ROOT, shell=True,
                                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            if not wait_until(lambda: up(origin), 40):
                print("the dev server did not start")
                return 1

        browser = next((b for b in BROWSERS if os.path.isfile(b)), None)
        if not browser:
            print("Chrome or Edge not found")
            return 1
        profile = os.path.join(tempfile.gettempdir(), "odyssey3d-verify-profile")
        page = subprocess.Popen([browser, f"--user-data-dir={profile}", f"--app={url}", "--start-fullscreen",
                                 "--window-position=0,0", "--no-first-run", "--no-default-browser-check"])
        started.append(page)
        time.sleep(7.0)  # page load, first frames, lens switch

        luts = np.frombuffer(get(BRIDGE + "/calibration"), dtype=np.uint8)
        calib_w, calib_h = state["weaveCorners"]["calibW"], state["weaveCorners"]["calibH"]
        luts = luts.reshape(2, calib_h, calib_w)

        results = []
        for _ in range(5):
            before = vw.bridge_state()
            shot = np.asarray(ImageGrab.grab().convert("RGB"), dtype=np.float64) / 255.0
            after = vw.bridge_state()
            moved = float(np.linalg.norm(np.subtract(before["weaverPosMm"], after["weaverPosMm"])))
            height, width = shot.shape[:2]
            meta = {
                "panelW": before["display"]["physResW"], "panelH": before["display"]["physResH"],
                "corners": {k: after["weaveCorners"][k] for k in ("tl", "tr", "bl", "br")},
                "viewFilterSlope": before["optics"]["viewFilterSlope"],
            }
            rows = np.arange(200, height - 200, 4)   # keep clear of anything at the screen edges
            cols = np.arange(200, width - 200)
            got = shot[rows][:, cols]
            # Test pattern: left = red (1,0,0), right = cyan (0,0.93,1) as displayed.
            left_share = np.stack([got[..., 0], 1.0 - got[..., 1] / 0.93, 1.0 - got[..., 2]], axis=-1)
            want = vw.viewer_weights(meta, luts, cols, rows)
            agree = float(((want > 0.5) == (left_share > 0.5)).mean())
            results.append({
                "screen": [width, height], "lens": bool(after["lensEnabled"]), "tracking": bool(after["tracking"]),
                "headMovedMm": round(moved, 1), "contrast": round(float(got[..., 0].std()), 3),
                "agreement": round(agree, 4), "hubConversion": bool(after.get("hubConversion")),
            })
            time.sleep(2.0)  # Samsung's own conversion, when enabled, takes a few seconds to cut in

        for r in results:
            print(json.dumps(r))
        last = results[-1]
        if last["screen"] != [meta["panelW"], meta["panelH"]]:
            print(f"MISMATCH: the screen grab is {last['screen']}, the panel is {[meta['panelW'], meta['panelH']]}")
        elif last["hubConversion"] or (results[0]["agreement"] >= 0.9 and last["agreement"] < 0.9):
            print('COVERED: Samsung Odyssey 3D Hub converts the full-screen window itself and draws over the page.')
            print('         In Odyssey 3D Hub, turn off "Convert to 3D in full screen", then run this again.')
        elif last["agreement"] >= 0.9:
            print("OK: the panel receives the expected weave")
        elif last["contrast"] < 0.2:
            print("MISMATCH: the picture on the panel is blurred (resampled canvas, or something drawn over the page)")
        else:
            print("MISMATCH: the panel does not receive the expected weave")
        return 0
    finally:
        try:
            urllib.request.urlopen(urllib.request.Request(BRIDGE + "/lens/disable", method="POST"), timeout=2).read()
        except OSError:
            pass
        if "--keep" not in sys.argv:
            for proc in reversed(started):
                kill_tree(proc)
            time.sleep(0.5)
            shutil.rmtree(os.path.join(tempfile.gettempdir(), "odyssey3d-verify-profile"), ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
