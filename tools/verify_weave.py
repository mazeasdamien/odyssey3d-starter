"""Ground truth for the viewer's WebGL weave shader (src/odyssey3d/stereo-composer.ts).

Asks the official LeiaSR weaver (SR::PredictingGLWeaver, through the runtime's own signed DLLs)
to weave a solid RED left view and a solid CYAN right view, then evaluates the viewer's shader
formula on the same panel pixels (same per-corner attributes from the SR bridge, same factory
correction LUTs) and reports how well the two agree, subpixel by subpixel.

What you will see: a 1280x720 red/cyan rectangle in the top-left corner of the 3D monitor for
about three seconds, with the 3D lens on (the official weaver refuses to weave for a hidden or
covered window, with the lens off, or when nobody is tracked). Sit still in front of the monitor
while it runs.

    python tools/verify_weave.py [outDir] [--wait=SECONDS]     (the SR bridge must be running)

--wait is how long to wait for a face holding still before giving up (default 20 s).

Pure Python + ctypes on purpose: Smart App Control blocks freshly compiled unsigned executables.
"""
from __future__ import annotations

import ctypes as C
import ctypes.wintypes as WT
import json
import os
import sys
import time
import urllib.request

import numpy as np

BIN = r"C:\Program Files\LeiaSR\Platform\bin"
BRIDGE_STATE_URL = "http://127.0.0.1:5033/state"

# Test window, in physical panel pixels (top-left corner of the 3D display).
WIN_X, WIN_Y, WIN_W, WIN_H = 0, 0, 1280, 720

GL_FRAMEBUFFER = 0x8D40
GL_COLOR_ATTACHMENT0 = 0x8CE0
GL_FRAMEBUFFER_COMPLETE = 0x8CD5
GL_READ_FRAMEBUFFER = 0x8CA8
GL_DRAW_FRAMEBUFFER = 0x8CA9
GL_TEXTURE_2D = 0x0DE1
GL_RGBA = 0x1908
GL_RGBA8 = 0x8058
GL_UNSIGNED_BYTE = 0x1401
GL_NEAREST = 0x2600
GL_TEXTURE_MAG_FILTER = 0x2800
GL_TEXTURE_MIN_FILTER = 0x2801
GL_COLOR_BUFFER_BIT = 0x4000
GL_SCISSOR_TEST = 0x0C11
GL_PACK_ALIGNMENT = 0x0D05

CLEANUP: list = []


class FLOAT2(C.Structure):
    _fields_ = [("x", C.c_float), ("y", C.c_float)]


class PIXELFORMATDESCRIPTOR(C.Structure):
    _fields_ = [
        ("nSize", C.c_ushort), ("nVersion", C.c_ushort), ("dwFlags", C.c_uint),
        ("iPixelType", C.c_ubyte), ("cColorBits", C.c_ubyte),
        ("cRedBits", C.c_ubyte), ("cRedShift", C.c_ubyte), ("cGreenBits", C.c_ubyte),
        ("cGreenShift", C.c_ubyte), ("cBlueBits", C.c_ubyte), ("cBlueShift", C.c_ubyte),
        ("cAlphaBits", C.c_ubyte), ("cAlphaShift", C.c_ubyte), ("cAccumBits", C.c_ubyte),
        ("cAccumRedBits", C.c_ubyte), ("cAccumGreenBits", C.c_ubyte), ("cAccumBlueBits", C.c_ubyte),
        ("cAccumAlphaBits", C.c_ubyte), ("cDepthBits", C.c_ubyte), ("cStencilBits", C.c_ubyte),
        ("cAuxBuffers", C.c_ubyte), ("iLayerType", C.c_ubyte), ("bReserved", C.c_ubyte),
        ("dwLayerMask", C.c_uint), ("dwVisibleMask", C.c_uint), ("dwDamageMask", C.c_uint),
    ]


def fn(dll, name, restype, *argtypes):
    f = dll[name]
    f.restype = restype
    f.argtypes = list(argtypes)
    return f


def bridge_state() -> dict:
    with urllib.request.urlopen(BRIDGE_STATE_URL, timeout=2) as resp:
        text = resp.read().decode("utf-8")
    return json.loads(text.replace("-nan(ind)", "0").replace("nan", "0").replace("inf", "0"))


STILL_MM = 4.0  # head movement tolerated while measuring


def head_spread_mm(positions: list) -> float:
    """Largest distance between any two of the given eye positions (mm)."""
    pts = np.asarray(positions, dtype=np.float64)
    if len(pts) < 2:
        return 0.0
    return float(np.max(np.linalg.norm(pts[:, None, :] - pts[None, :, :], axis=-1)))


def wait_for_still_face(max_wait_s: float) -> None:
    """Waits for a tracked face that holds still.

    The official weaver shows the plain left view when nobody is tracked, and it weaves for a
    *predicted* head position while the bridge reports the current one: the two only agree when
    the head is not moving.
    """
    deadline = time.monotonic() + max_wait_s
    recent: list = []
    told = False
    while True:
        try:
            state = bridge_state()
        except OSError:
            raise SystemExit("the SR bridge is not running on 127.0.0.1:5033 - start it first")
        if not state.get("weaveCorners", {}).get("valid"):
            raise SystemExit("the SR bridge has no lens calibration (monitor not identified) - nothing to compare")
        if not (state.get("apiVersion") or 0) >= 2:
            raise SystemExit("outdated SR bridge (eye position in mm) - start sr-bridge/sr_bridge.py")
        if state.get("tracking"):
            recent.append(state["weaverPosMm"])
            recent = recent[-10:]  # ~1.5 s
        else:
            recent = []
        if len(recent) == 10 and head_spread_mm(recent) <= STILL_MM:
            return
        if time.monotonic() > deadline:
            raise SystemExit("no still face tracked - sit in front of the monitor, hold still, and run it again")
        if not told:
            print("Waiting for a face holding still in front of the monitor...", flush=True)
            told = True
        time.sleep(0.15)


def capture(out_dir: str, max_wait_s: float) -> dict:
    """Runs the official weaver in a small visible window. Writes official.npy / calib.npy."""
    wait_for_still_face(max_wait_s)

    os.add_dll_directory(BIN)
    kernel32 = C.WinDLL("kernel32", use_last_error=True)
    kernel32.SetDllDirectoryW(BIN)
    user32 = C.WinDLL("user32", use_last_error=True)
    gdi32 = C.WinDLL("gdi32", use_last_error=True)
    gl = C.WinDLL("opengl32", use_last_error=True)
    # Physical pixels everywhere: the weave phase is defined on the panel's real pixel grid.
    user32.SetProcessDpiAwarenessContext.argtypes = [C.c_void_p]
    user32.SetProcessDpiAwarenessContext(C.c_void_p(-4))  # PER_MONITOR_AWARE_V2

    core = C.CDLL(os.path.join(BIN, "SimulatedRealityCore.dll"))
    displays = C.CDLL(os.path.join(BIN, "SimulatedRealityDisplays.dll"))
    C.CDLL(os.path.join(BIN, "SimulatedRealityFaceTrackers.dll"))
    weaving = C.CDLL(os.path.join(BIN, "DimencoWeaving.dll"))
    srgl = C.CDLL(os.path.join(BIN, "SimulatedRealityOpenGL.dll"))

    new_ctx = fn(core, "newSRContext", C.c_void_p)
    init_ctx = fn(core, "initializeSRContext", None, C.c_void_p)
    create_screen = fn(displays, "createScreen", C.c_void_p, C.c_void_p)
    phys_w = fn(displays, "getPhysicalResolutionWidth", C.c_int, C.c_void_p)
    phys_h = fn(displays, "getPhysicalResolutionHeight", C.c_int, C.c_void_p)
    create_lens = fn(displays, "createSwitchableLensHint", C.c_void_p, C.c_void_p)
    lens_on = fn(displays, "lensEnableHint", None, C.c_void_p)
    lens_off = fn(displays, "lensDisableHint", None, C.c_void_p)
    lens_is_on = fn(displays, "isLensEnabled", C.c_bool, C.c_void_p)

    ctor = fn(srgl, "??0PredictingGLWeaver@SR@@QEAA@AEAVSRContext@1@IIPEAUHWND__@@@Z",
              C.c_void_p, C.c_void_p, C.c_void_p, C.c_uint, C.c_uint, C.c_void_p)
    weave = fn(srgl, "?weave@GLWeaverBase@SR@@QEAAXII@Z", None, C.c_void_p, C.c_uint, C.c_uint)
    get_fb = fn(srgl, "?getFrameBuffer@GLWeaverBase@SR@@QEAAIXZ", C.c_uint, C.c_void_p)
    load_tex = fn(weaving, "?LoadTexture@Weaver@Dimenco@@SA?AW4WeaverErrorCode@@W4WeaverTextureType@@PEAPEAEPEAH222_N@Z",
                  C.c_int, C.c_int, C.POINTER(C.POINTER(C.c_ubyte)),
                  C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_int), C.c_bool)
    get_slope = fn(weaving, "GetViewfilterSlope", C.c_float)
    get_xtalk = fn(weaving, "GetXTalkFactor", C.c_float)

    ctx = new_ctx()
    if not ctx:
        raise SystemExit("newSRContext() failed - is the SR Service running?")
    screen = create_screen(ctx)
    panel_w, panel_h = phys_w(screen), phys_h(screen)

    # Small borderless window, always on top, never activated (it must not take the focus).
    user32.CreateWindowExA.restype = C.c_void_p
    user32.CreateWindowExA.argtypes = [C.c_uint, C.c_char_p, C.c_char_p, C.c_uint, C.c_int, C.c_int,
                                       C.c_int, C.c_int, C.c_void_p, C.c_void_p, C.c_void_p, C.c_void_p]
    user32.GetDC.restype = C.c_void_p
    user32.GetDC.argtypes = [C.c_void_p]
    user32.ShowWindow.argtypes = [C.c_void_p, C.c_int]
    user32.DestroyWindow.argtypes = [C.c_void_p]
    user32.PeekMessageW.argtypes = [C.POINTER(WT.MSG), C.c_void_p, C.c_uint, C.c_uint, C.c_uint]
    user32.DispatchMessageW.argtypes = [C.POINTER(WT.MSG)]
    gdi32.ChoosePixelFormat.argtypes = [C.c_void_p, C.POINTER(PIXELFORMATDESCRIPTOR)]
    gdi32.SetPixelFormat.argtypes = [C.c_void_p, C.c_int, C.POINTER(PIXELFORMATDESCRIPTOR)]
    gdi32.SwapBuffers.argtypes = [C.c_void_p]
    gl.wglCreateContext.restype = C.c_void_p
    gl.wglCreateContext.argtypes = [C.c_void_p]
    gl.wglMakeCurrent.argtypes = [C.c_void_p, C.c_void_p]
    gl.wglGetProcAddress.restype = C.c_void_p
    gl.wglGetProcAddress.argtypes = [C.c_char_p]
    gl.glClearColor.argtypes = [C.c_float] * 4
    gl.glTexImage2D.argtypes = [C.c_uint, C.c_int, C.c_int, C.c_int, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_void_p]
    gl.glReadPixels.argtypes = [C.c_int, C.c_int, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_void_p]
    gl.glGenTextures.argtypes = [C.c_int, C.POINTER(C.c_uint)]

    ws_popup = 0x80000000
    ex_style = 0x00000008 | 0x08000000 | 0x00000080  # TOPMOST | NOACTIVATE | TOOLWINDOW
    hwnd = user32.CreateWindowExA(ex_style, b"STATIC", b"SR weave check", ws_popup,
                                  WIN_X, WIN_Y, WIN_W, WIN_H, None, None, None, None)
    CLEANUP.append(lambda: user32.DestroyWindow(hwnd))
    hdc = user32.GetDC(hwnd)
    pfd = PIXELFORMATDESCRIPTOR()
    pfd.nSize = C.sizeof(PIXELFORMATDESCRIPTOR)
    pfd.nVersion = 1
    pfd.dwFlags = 0x4 | 0x20 | 0x1  # DRAW_TO_WINDOW | SUPPORT_OPENGL | DOUBLEBUFFER
    pfd.cColorBits = 32
    gdi32.SetPixelFormat(hdc, gdi32.ChoosePixelFormat(hdc, C.byref(pfd)), C.byref(pfd))
    glrc = gl.wglCreateContext(hdc)
    if not glrc or not gl.wglMakeCurrent(hdc, glrc):
        raise SystemExit("could not create an OpenGL context")

    def glext(name: bytes, restype, *argtypes):
        addr = gl.wglGetProcAddress(name)
        if not addr:
            raise SystemExit(f"OpenGL entry point missing: {name.decode()}")
        return C.CFUNCTYPE(restype, *argtypes)(addr)

    gen_fbo = glext(b"glGenFramebuffers", None, C.c_int, C.POINTER(C.c_uint))
    bind_fbo = glext(b"glBindFramebuffer", None, C.c_uint, C.c_uint)
    fbo_tex = glext(b"glFramebufferTexture2D", None, C.c_uint, C.c_uint, C.c_uint, C.c_uint, C.c_int)
    fbo_status = glext(b"glCheckFramebufferStatus", C.c_uint, C.c_uint)
    blit = glext(b"glBlitFramebuffer", None, C.c_int, C.c_int, C.c_int, C.c_int,
                 C.c_int, C.c_int, C.c_int, C.c_int, C.c_uint, C.c_uint)

    kernel32.VirtualAlloc.restype = C.c_void_p
    kernel32.VirtualAlloc.argtypes = [C.c_void_p, C.c_size_t, C.c_uint, C.c_uint]
    weaver = kernel32.VirtualAlloc(None, 65536, 0x3000, 0x04)
    ctor(weaver, ctx, WIN_W, WIN_H, hwnd)
    init_ctx(ctx)

    out_tex, out_fbo = C.c_uint(0), C.c_uint(0)
    gl.glGenTextures(1, C.byref(out_tex))
    gl.glBindTexture(GL_TEXTURE_2D, out_tex.value)
    gl.glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, WIN_W, WIN_H, 0, GL_RGBA, GL_UNSIGNED_BYTE, None)
    gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST)
    gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST)
    gl.glBindTexture(GL_TEXTURE_2D, 0)
    gen_fbo(1, C.byref(out_fbo))
    bind_fbo(GL_FRAMEBUFFER, out_fbo.value)
    fbo_tex(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, out_tex.value, 0)
    if fbo_status(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE:
        raise SystemExit("offscreen framebuffer incomplete")

    lens = create_lens(ctx)
    lens_on(lens)
    CLEANUP.append(lambda: lens_off(lens))
    user32.ShowWindow(hwnd, 4)  # SW_SHOWNOACTIVATE

    msg = WT.MSG()
    pixels = np.zeros((WIN_H, WIN_W, 4), dtype=np.uint8)
    bridge: dict = {}
    woven = False
    tracked = True
    frames = 0
    deadline = time.monotonic() + 6.0
    settle = 0
    head_positions: list = []
    while time.monotonic() < deadline:
        while user32.PeekMessageW(C.byref(msg), None, 0, 0, 1):
            user32.DispatchMessageW(C.byref(msg))

        bind_fbo(GL_FRAMEBUFFER, get_fb(weaver))
        gl.glViewport(0, 0, WIN_W, WIN_H)
        gl.glEnable(GL_SCISSOR_TEST)
        gl.glScissor(0, 0, WIN_W // 2, WIN_H)                 # left half  = LEFT eye  -> red
        gl.glClearColor(1.0, 0.0, 0.0, 1.0)
        gl.glClear(GL_COLOR_BUFFER_BIT)
        gl.glScissor(WIN_W // 2, 0, WIN_W - WIN_W // 2, WIN_H)  # right half = RIGHT eye -> cyan
        gl.glClearColor(0.0, 1.0, 1.0, 1.0)
        gl.glClear(GL_COLOR_BUFFER_BIT)
        gl.glDisable(GL_SCISSOR_TEST)

        bind_fbo(GL_FRAMEBUFFER, out_fbo.value)
        gl.glViewport(0, 0, WIN_W, WIN_H)
        weave(weaver, WIN_W, WIN_H)
        gl.glFinish()
        # What the viewer would use for this very frame: the bridge's per-corner attributes.
        bridge = bridge_state()
        gl.glPixelStorei(GL_PACK_ALIGNMENT, 1)
        gl.glReadPixels(0, 0, WIN_W, WIN_H, GL_RGBA, GL_UNSIGNED_BYTE, pixels.ctypes.data_as(C.c_void_p))

        # Show the same image in the window, so what is measured is what is on the panel.
        bind_fbo(GL_READ_FRAMEBUFFER, out_fbo.value)
        bind_fbo(GL_DRAW_FRAMEBUFFER, 0)
        blit(0, 0, WIN_W, WIN_H, 0, 0, WIN_W, WIN_H, GL_COLOR_BUFFER_BIT, GL_NEAREST)
        gdi32.SwapBuffers(hdc)

        frames += 1
        tracked = bool(bridge.get("tracking"))
        head_positions = (head_positions + [bridge["weaverPosMm"]])[-12:]
        # Woven = both views present. Keep a few more frames once it is, so the predictor settles.
        cyan_share = float((pixels[::16, ::16, 1] > 127).mean())
        woven = 0.2 < cyan_share < 0.8
        settle = settle + 1 if woven and tracked else 0
        if settle >= 12:
            break
        time.sleep(0.012)

    lens_was_on = bool(lens_is_on(lens))
    luts = []
    lut_w = lut_h = 0
    for tex_type in (0, 1):
        data = C.POINTER(C.c_ubyte)()
        w, h, ch, bpp = C.c_int(), C.c_int(), C.c_int(), C.c_int()
        err = load_tex(tex_type, C.byref(data), C.byref(w), C.byref(h), C.byref(ch), C.byref(bpp), True)
        if err != 0 or not data or w.value <= 0:
            raise SystemExit(f"factory correction texture {tex_type} not available (error {err})")
        lut_w, lut_h = w.value, h.value
        luts.append(np.ctypeslib.as_array(data, shape=(h.value, w.value)).copy())

    meta = {
        "panelW": panel_w, "panelH": panel_h,
        "window": [WIN_X, WIN_Y, WIN_W, WIN_H],
        "calibW": lut_w, "calibH": lut_h,
        "viewFilterSlope": get_slope(), "xtalkFactor": get_xtalk(),
        "lensOn": lens_was_on, "frames": frames, "woven": woven, "trackedAtCapture": tracked,
        "weaverPosMm": bridge.get("weaverPosMm"),
        "headMovedMm": round(head_spread_mm(head_positions), 1),
        "corners": {k: bridge["weaveCorners"][k] for k in ("tl", "tr", "bl", "br")},
    }
    os.makedirs(out_dir, exist_ok=True)
    np.save(os.path.join(out_dir, "official.npy"), pixels)
    np.save(os.path.join(out_dir, "calib.npy"), np.stack(luts))
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1)
    return meta


def bilinear(lut: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """GL_LINEAR + CLAMP_TO_EDGE sample of a single-channel texture, row 0 at v = 0."""
    h, w = lut.shape
    x = np.clip(u * w - 0.5, 0, w - 1)
    y = np.clip(v * h - 0.5, 0, h - 1)
    x0 = np.floor(x).astype(np.int32)
    y0 = np.floor(y).astype(np.int32)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    fx = x - x0
    fy = y - y0
    t = lut.astype(np.float64) / 255.0
    low = t[y0, x0] * (1 - fx) + t[y0, x1] * fx
    high = t[y1, x0] * (1 - fx) + t[y1, x1] * fx
    return low * (1 - fy) + high * fy


def viewer_weights(meta: dict, luts: np.ndarray, cols: np.ndarray, rows_top_down: np.ndarray,
                   phase_offset: float = 0.0) -> np.ndarray:
    """The viewer's fragment shader (calibrated branch of stereo-composer.ts), in float64.

    `cols` / `rows_top_down` are physical panel pixel indices. Returns w[row, col, channel] in
    [0, 1]: the share of the LEFT eye view in that subpixel. Keep in sync with the shader.
    """
    width, height = meta["panelW"], meta["panelH"]
    c = meta["corners"]  # [a2.x, a3.z, a3.w, a5.x, a5.y] per corner
    phys_x = cols.astype(np.float64)[None, :] + 0.5
    phys_y_top_down = rows_top_down.astype(np.float64)[:, None] + 0.5
    u = phys_x / width
    v = 1.0 - phys_y_top_down / height

    def lerp_corner(i: int, base: float = 0.0):
        bot = (c["bl"][i] - base) * (1 - u) + (c["br"][i] - base) * u
        top = (c["tl"][i] - base) * (1 - u) + (c["tr"][i] - base) * u
        return bot * (1 - v) + top * v

    a2 = lerp_corner(0, float(np.floor(c["tl"][0])))
    a3z = lerp_corner(1)
    a3w = lerp_corner(2)
    a5x = lerp_corner(3)

    uu = np.broadcast_to(u, a2.shape)
    vv = np.broadcast_to(v, a2.shape)
    corr_a = bilinear(luts[0], uu, vv)
    corr_b = bilinear(luts[1], uu, vv)

    a5y = lerp_corner(4)
    rsq = 1.0 / np.sqrt(a3z * a3z + a3w * a3w + 1.0)
    base = a2 + a5x * rsq + 2.0 * a5y * (corr_b - 0.5) - corr_a + phase_offset
    d_phase_dx = (c["tr"][0] - c["tl"][0] + c["tr"][3] - c["tl"][3]) / width
    slope = meta["viewFilterSlope"] or 10.0

    out = np.empty(a2.shape + (3,), dtype=np.float64)
    for ch in range(3):
        phase = base + d_phase_dx * (ch / 3.0)
        p = np.mod(phase + 0.25, 1.0)
        t = 2.0 * p - 1.0
        out[..., ch] = np.clip(-np.abs(t) * slope + slope * 0.5 + 0.5, 0.0, 1.0)
    return out


def compare(out_dir: str, meta: dict) -> dict:
    official = np.load(os.path.join(out_dir, "official.npy"))
    luts = np.load(os.path.join(out_dir, "calib.npy"))
    x0, y0, w, h = meta["window"]

    # glReadPixels rows are bottom-up inside the window: row r is panel row y0 + h - 1 - r.
    fb_rows = np.arange(0, h, 2)
    rows_top_down = y0 + h - 1 - fb_rows
    cols = x0 + np.arange(w)
    off = official[fb_rows].astype(np.float64) / 255.0
    # Inputs were LEFT = red (1,0,0) and RIGHT = cyan (0,1,1): per channel, the LEFT view's share
    # in the official output is R -> value, G and B -> 1 - value.
    official_left = np.stack([off[..., 0], 1.0 - off[..., 1], 1.0 - off[..., 2]], axis=-1)

    def score(phase_offset: float):
        viewer_left = viewer_weights(meta, luts, cols, rows_top_down, phase_offset)
        agree = ((viewer_left > 0.5) == (official_left > 0.5)).mean()
        return float(agree), float(np.abs(viewer_left - official_left).mean())

    agree0, mad0 = score(0.0)
    scan = [(float(d),) + score(float(d)) for d in np.arange(-0.5, 0.5, 0.01)]
    best = max(scan, key=lambda s: s[1])
    return {
        "official_left_view_share": round(float(official_left.mean()), 4),
        # Share of subpixels that show the same eye's view as the official weaver. 0.5 = no
        # relation (wrong formula), 1.0 = identical. Expect > 0.9 when sitting still.
        "agreement": round(agree0, 4),
        "mean_abs_diff": round(mad0, 4),
        "agreement_if_eyes_swapped": round(1.0 - agree0, 4),
        # Residual phase error in lens cycles: 0 = none. A small value comes from head motion
        # between the two measurements.
        "best_phase_offset": round(best[0], 3),
        "agreement_at_best_phase_offset": round(best[1], 4),
    }


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--wait=")]
    waits = [a for a in sys.argv[1:] if a.startswith("--wait=")]
    max_wait_s = float(waits[0].split("=", 1)[1]) if waits else 20.0
    out_dir = args[0] if args else os.path.join(os.path.dirname(os.path.abspath(__file__)), "weave-check")
    try:
        meta = capture(out_dir, max_wait_s)
    finally:
        for undo in reversed(CLEANUP):
            undo()
    print(json.dumps(meta))
    if not meta["woven"]:
        raise SystemExit("the official weaver did not weave (window covered, lens off or face lost) - run it again")
    result = compare(out_dir, meta)
    print(json.dumps(result, indent=1))
    if meta["headMovedMm"] > STILL_MM:
        print(f"UNRELIABLE: the head moved {meta['headMovedMm']} mm during the measurement - hold still and run it again")
    elif result["agreement"] >= 0.9:
        print("OK: the viewer weaves like the official LeiaSR weaver")
    else:
        print("MISMATCH: the viewer's weave differs from the official weaver")


if __name__ == "__main__":
    main()
