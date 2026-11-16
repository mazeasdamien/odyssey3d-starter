"""LeiaSR / Samsung Odyssey 3D (G90XF) hardware bridge for the WebGL viewer.

Local HTTP API on http://127.0.0.1:5033:

    GET  /state          eye positions (mm), display geometry, lens optics, and the per-corner
                         Dimenco weave attributes for the eye position; ?lead=35 computes them
                         for where the head will be in 35 ms (the runtime's own predictor)
    GET  /stream         the same state pushed 120 times a second (server-sent events)
    POST /lens/enable    switch the 3D lens on   (answers with the state)
    POST /lens/disable   switch the 3D lens off  (answers with the state)
    GET  /calibration    the two factory 480x270 correction maps, one byte per texel

Why Python: Windows Smart App Control refuses freshly compiled unsigned executables, so a rebuilt
unsigned bridge executable may not be allowed to start. This script only loads the LeiaSR runtime's own signed
DLLs through ctypes and needs nothing but the standard library.

    python sr_bridge.py [--port 5033] [--probe]

--probe prints one state and exits: 0 = calibrated, 2 = runtime connected but the monitor is not
identified (no factory calibration), 1 = runtime not reachable.
"""
from __future__ import annotations

import atexit
import ctypes as C
import json
import math
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BIN = r"C:\Program Files\LeiaSR\Platform\bin"
API_VERSION = 2  # 2: weave attributes computed with the eye position in centimetres
STREAM_HZ = 120
MAX_LEAD_MS = 80.0
LENS_WATCHDOG_S = 3.5
TRACKING_TIMEOUT_S = 0.35
# Samsung's Odyssey 3D Hub starts this player to convert a full-screen window to 3D by itself
# (Hub setting "Convert to 3D in full screen"). It draws over the page, which ruins our weave.
HUB_CONVERSION_PROCESS = "odyssey3dplayer.exe"


class Point3d(C.Structure):
    _fields_ = [("x", C.c_double), ("y", C.c_double), ("z", C.c_double)]


class EyePair(C.Structure):
    _fields_ = [("frameId", C.c_uint64), ("timeUs", C.c_uint64), ("left", Point3d), ("right", Point3d)]


class WeaverPosition(C.Structure):
    _fields_ = [("frameId", C.c_uint64), ("timeUs", C.c_uint64), ("pos", Point3d)]


class FLOAT2(C.Structure):
    _fields_ = [("x", C.c_float), ("y", C.c_float)]


class FLOAT3(C.Structure):
    _fields_ = [("x", C.c_float), ("y", C.c_float), ("z", C.c_float)]


class FLOAT4(C.Structure):
    _fields_ = [("x", C.c_float), ("y", C.c_float), ("z", C.c_float), ("w", C.c_float)]


class PIXELFORMATDESCRIPTOR(C.Structure):
    _fields_ = [("nSize", C.c_ushort), ("nVersion", C.c_ushort), ("dwFlags", C.c_uint),
                ("iPixelType", C.c_ubyte), ("cColorBits", C.c_ubyte), ("rest", C.c_ubyte * 30)]


# A 64-byte struct passed "by value" is passed as a pointer to a copy in the Windows x64 ABI.
EYE_CALLBACK = C.CFUNCTYPE(None, C.POINTER(EyePair))


def finite(v: float, fallback: float = 0.0) -> float:
    return v if math.isfinite(v) else fallback


class ProcessEntry32(C.Structure):
    _fields_ = [("dwSize", C.c_uint32), ("cntUsage", C.c_uint32), ("th32ProcessID", C.c_uint32),
                ("th32DefaultHeapID", C.c_size_t), ("th32ModuleID", C.c_uint32), ("cntThreads", C.c_uint32),
                ("th32ParentProcessID", C.c_uint32), ("pcPriClassBase", C.c_long), ("dwFlags", C.c_uint32),
                ("szExeFile", C.c_wchar * 260)]


def process_running(exe_name: str) -> bool:
    """True when a process with this executable name exists (Toolhelp snapshot, no extra rights)."""
    kernel32 = C.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.restype = C.c_void_p
    kernel32.CreateToolhelp32Snapshot.argtypes = [C.c_uint32, C.c_uint32]
    kernel32.Process32FirstW.argtypes = [C.c_void_p, C.POINTER(ProcessEntry32)]
    kernel32.Process32NextW.argtypes = [C.c_void_p, C.POINTER(ProcessEntry32)]
    kernel32.CloseHandle.argtypes = [C.c_void_p]
    snapshot = kernel32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if not snapshot or snapshot == C.c_void_p(-1).value:
        return False
    try:
        entry = ProcessEntry32()
        entry.dwSize = C.sizeof(ProcessEntry32)
        ok = kernel32.Process32FirstW(snapshot, C.byref(entry))
        while ok:
            if entry.szExeFile.lower() == exe_name:
                return True
            ok = kernel32.Process32NextW(snapshot, C.byref(entry))
        return False
    finally:
        kernel32.CloseHandle(snapshot)


class Bridge:
    def __init__(self) -> None:
        self.connected = False
        self._hub_conversion = False
        self._hub_conversion_checked = 0.0
        self.calibrated = False
        self.lens_requested = False
        self.last_heartbeat = 0.0
        self.display = {
            "model": "Samsung Odyssey 3D (G90XF)", "resW": 3840, "resH": 2160, "physResW": 3840,
            "physResH": 2160, "widthCm": 59.6736, "heightCm": 33.5664, "dotPitchCm": 0.01554,
            "recViewW": 1920, "recViewH": 1080,
        }
        self.optics = {"px": 0.0, "slant": 0.0, "doN": 0.0, "n": 0.0, "pattern": 0.0,
                       "viewFilterSlope": 10.0, "xtalkFactor": 0.012854}
        self.calib_w = 480
        self.calib_h = 270
        self.calib_blob = b""

        self.eye_lock = threading.Lock()
        self.weave_lock = threading.Lock()
        self.frame_id = 0
        self.time_us = 0
        self.last_tracked = 0.0
        self.left = [-31.5, 100.0, 600.0]
        self.right = [31.5, 100.0, 600.0]
        self.weaver_pos = [0.0, 100.0, 600.0]
        self.ipd = 63.0

        self._lens = None
        self._lens_state = False
        self._predictor = None
        self._predict = None
        self._keep = []  # ctypes objects that must outlive the SR runtime's use of them

    # ---- LeiaSR runtime -------------------------------------------------------------------

    def init(self) -> bool:
        if not os.path.isdir(BIN):
            print(f"[sr-bridge] LeiaSR runtime not found in {BIN}", flush=True)
            return False
        os.add_dll_directory(BIN)
        kernel32 = C.WinDLL("kernel32", use_last_error=True)
        kernel32.SetDllDirectoryW(BIN)
        user32 = C.WinDLL("user32", use_last_error=True)
        gdi32 = C.WinDLL("gdi32", use_last_error=True)
        opengl32 = C.WinDLL("opengl32", use_last_error=True)
        try:
            user32.SetProcessDpiAwarenessContext.argtypes = [C.c_void_p]
            user32.SetProcessDpiAwarenessContext(C.c_void_p(-4))  # PER_MONITOR_AWARE_V2
        except (AttributeError, OSError):
            pass

        def load(name: str):
            return C.CDLL(os.path.join(BIN, name))

        def fn(dll, name, restype, *argtypes):
            f = dll[name]
            f.restype = restype
            f.argtypes = list(argtypes)
            return f

        try:
            core = load("SimulatedRealityCore.dll")
            displays = load("SimulatedRealityDisplays.dll")
            trackers = load("SimulatedRealityFaceTrackers.dll")
            weaving = load("DimencoWeaving.dll")
            srgl = load("SimulatedRealityOpenGL.dll")
        except OSError as err:
            print(f"[sr-bridge] cannot load the LeiaSR runtime: {err}", flush=True)
            return False

        print("[sr-bridge] Connecting to LeiaSR Service...", flush=True)
        ctx = fn(core, "newSRContext", C.c_void_p)()
        if not ctx:
            print("[sr-bridge] newSRContext() returned NULL (is the SR Service running?)", flush=True)
            return False
        init_ctx = fn(core, "initializeSRContext", None, C.c_void_p)

        screen = fn(displays, "createScreen", C.c_void_p, C.c_void_p)(ctx)
        if screen:
            geti = lambda name: fn(displays, name, C.c_int, C.c_void_p)(screen)
            getf = lambda name: fn(displays, name, C.c_float, C.c_void_p)(screen)
            self.display.update({
                "resW": geti("getResolutionWidth"), "resH": geti("getResolutionHeight"),
                "physResW": geti("getPhysicalResolutionWidth"), "physResH": geti("getPhysicalResolutionHeight"),
                "widthCm": finite(getf("getPhysicalSizeWidth")), "heightCm": finite(getf("getPhysicalSizeHeight")),
                "dotPitchCm": finite(getf("getDotPitch")),
                "recViewW": geti("getRecommendedViewsTextureWidth"),
                "recViewH": geti("getRecommendedViewsTextureHeight"),
            })

        self._lens = fn(displays, "createSwitchableLensHint", C.c_void_p, C.c_void_p)(ctx)
        self._lens_on = fn(displays, "lensEnableHint", None, C.c_void_p)
        self._lens_off = fn(displays, "lensDisableHint", None, C.c_void_p)
        self._lens_is_on = fn(displays, "isLensEnabled", C.c_bool, C.c_void_p)
        self._lens_is_on_pref = fn(displays, "isLensEnabledByPreference", C.c_bool, C.c_void_p)

        tracker = fn(trackers, "createEyeTracker", C.c_void_p, C.c_void_p)(ctx)
        if tracker:
            callback = EYE_CALLBACK(self._on_eye_pair)
            self._keep.append(callback)
            fn(trackers, "createEyePairListener", C.c_void_p, C.c_void_p, EYE_CALLBACK)(tracker, callback)
        # The runtime's own motion predictor, the one the official weaver uses: it answers "where
        # will the weaving position be in N microseconds", in centimetres.
        try:
            self._predictor = fn(trackers, "?create@PredictingWeaverTracker@SR@@SAPEAV12@AEAVSRContext@2@@Z",
                                 C.c_void_p, C.c_void_p)(ctx)
            self._predict = fn(trackers, "?predict@PredictingWeaverTracker@SR@@QEAAX_KAEAUSR_weaverPosition@@@Z",
                               None, C.c_void_p, C.c_uint64, C.POINTER(WeaverPosition))
        except (AttributeError, OSError):
            self._predictor = None
        init_ctx(ctx)
        time.sleep(0.12)

        # Building the official GL weaver once (on a hidden window) makes the runtime configure
        # DimencoWeaving.dll for this monitor: serial number, lens parameters, correction maps.
        user32.CreateWindowExA.restype = C.c_void_p
        user32.CreateWindowExA.argtypes = [C.c_uint, C.c_char_p, C.c_char_p, C.c_uint, C.c_int, C.c_int,
                                           C.c_int, C.c_int, C.c_void_p, C.c_void_p, C.c_void_p, C.c_void_p]
        user32.GetDC.restype = C.c_void_p
        user32.GetDC.argtypes = [C.c_void_p]
        gdi32.ChoosePixelFormat.argtypes = [C.c_void_p, C.c_void_p]
        gdi32.SetPixelFormat.argtypes = [C.c_void_p, C.c_int, C.c_void_p]
        opengl32.wglCreateContext.restype = C.c_void_p
        opengl32.wglCreateContext.argtypes = [C.c_void_p]
        opengl32.wglMakeCurrent.argtypes = [C.c_void_p, C.c_void_p]
        kernel32.VirtualAlloc.restype = C.c_void_p
        kernel32.VirtualAlloc.argtypes = [C.c_void_p, C.c_size_t, C.c_uint, C.c_uint]

        w, h = self.display["physResW"], self.display["physResH"]
        hwnd = user32.CreateWindowExA(0, b"STATIC", b"SRBridgeHiddenGL", 0x80000000, 0, 0, w, h,
                                      None, None, None, None)
        hdc = user32.GetDC(hwnd)
        pfd = PIXELFORMATDESCRIPTOR()
        pfd.nSize = C.sizeof(PIXELFORMATDESCRIPTOR)
        pfd.nVersion = 1
        pfd.dwFlags = 0x4 | 0x20 | 0x1  # DRAW_TO_WINDOW | SUPPORT_OPENGL | DOUBLEBUFFER
        pfd.cColorBits = 32
        gdi32.SetPixelFormat(hdc, gdi32.ChoosePixelFormat(hdc, C.byref(pfd)), C.byref(pfd))
        glrc = opengl32.wglCreateContext(hdc)
        if glrc and opengl32.wglMakeCurrent(hdc, glrc):
            ctor = fn(srgl, "??0PredictingGLWeaver@SR@@QEAA@AEAVSRContext@1@IIPEAUHWND__@@@Z",
                      C.c_void_p, C.c_void_p, C.c_void_p, C.c_uint, C.c_uint, C.c_void_p)
            weave = fn(srgl, "?weave@GLWeaverBase@SR@@QEAAXII@Z", None, C.c_void_p, C.c_uint, C.c_uint)
            weaver = kernel32.VirtualAlloc(None, 65536, 0x3000, 0x04)
            ctor(weaver, ctx, w, h, hwnd)
            init_ctx(ctx)
            time.sleep(0.12)
            weave(weaver, w, h)
            self._load_calibration(fn, weaving)

        self.set_lens(False)  # the desktop stays in crisp 2D until the viewer asks for 3D

        getter = lambda name: finite(fn(weaving, name, C.c_float)())
        self.optics = {
            "px": getter("GetPx"), "slant": getter("GetSlant"), "doN": getter("GetDoN"), "n": getter("GetN"),
            "pattern": getter("GetPattern"), "viewFilterSlope": getter("GetViewfilterSlope"),
            "xtalkFactor": getter("GetXTalkFactor"),
        }
        self._set_eye = fn(weaving, "?SetGlobalParameters@Weaver@Dimenco@@SAXUFLOAT3@@@Z", None, FLOAT3)
        self._fill = fn(weaving, "?FillAttributes@Weaver@Dimenco@@SAXAEBUFLOAT2@@0AEBUFLOAT4@@AEAU4@2AEAU3@3@Z",
                        None, C.POINTER(FLOAT2), C.POINTER(FLOAT2), C.POINTER(FLOAT4),
                        C.POINTER(FLOAT4), C.POINTER(FLOAT4), C.POINTER(FLOAT2), C.POINTER(FLOAT2))

        self.connected = True
        d = self.display
        print(f"[sr-bridge] Connected! Display: {d['physResW']}x{d['physResH']} "
              f"({d['widthCm']:.2f} cm x {d['heightCm']:.2f} cm, pitch {d['dotPitchCm']:.5f} cm)", flush=True)
        if not self.calibrated:
            print("[sr-bridge] WARNING: no factory lens calibration - the LeiaSR runtime has not identified "
                  "the monitor (USB cable?). Restart the bridge once it has.", flush=True)
        return True

    def _load_calibration(self, fn, weaving) -> None:
        load_tex = fn(weaving,
                      "?LoadTexture@Weaver@Dimenco@@SA?AW4WeaverErrorCode@@W4WeaverTextureType@@PEAPEAEPEAH222_N@Z",
                      C.c_int, C.c_int, C.POINTER(C.POINTER(C.c_ubyte)),
                      C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_int), C.c_bool)
        planes = []
        size = None
        for tex_type in (0, 1):
            data = C.POINTER(C.c_ubyte)()
            w, h, ch, bpp = C.c_int(), C.c_int(), C.c_int(), C.c_int()
            # flipY = True: first row = bottom of the panel, as the official GL weaver uploads it
            err = load_tex(tex_type, C.byref(data), C.byref(w), C.byref(h), C.byref(ch), C.byref(bpp), True)
            if err != 0 or not data or w.value <= 0 or h.value <= 0:
                return
            if size is not None and size != (w.value, h.value):
                return
            size = (w.value, h.value)
            planes.append(C.string_at(data, w.value * h.value))
        self.calib_w, self.calib_h = size
        self.calib_blob = planes[0] + planes[1]
        self.calibrated = True
        print(f"[sr-bridge] Loaded factory optical calibration LUTs: {size[0]}x{size[1]} "
              f"({len(self.calib_blob)} bytes)", flush=True)

    # ---- eye tracking ---------------------------------------------------------------------

    def _on_eye_pair(self, pair_ptr) -> None:
        pair = pair_ptr.contents
        lx, ly, lz = pair.left.x, pair.left.y, pair.left.z
        rx, ry, rz = pair.right.x, pair.right.y, pair.right.z
        ipd = math.sqrt((rx - lx) ** 2 + (ry - ly) ** 2 + (rz - lz) ** 2)
        # A tracked face has an IPD between 25 and 100 mm and is more than 150 mm away.
        face = lz > 150.0 and rz > 150.0 and 25.0 <= ipd <= 100.0
        now = time.monotonic()
        with self.eye_lock:
            self.frame_id = pair.frameId
            self.time_us = pair.timeUs
            if face:
                self.last_tracked = now
                self.left = [lx, ly, lz]
                self.right = [rx, ry, rz]
                self.weaver_pos = [0.5 * (lx + rx), 0.5 * (ly + ry), 0.5 * (lz + rz)]
                self.ipd = ipd
            elif lz > 150.0 and ipd < 5.0 and (self.last_tracked == 0.0 or now - self.last_tracked > 0.4):
                # Nobody tracked: the runtime reports its default viewing position for both eyes.
                self.weaver_pos = [lx, ly, lz]
                self.left = [lx - 31.5, ly, lz]
                self.right = [rx + 31.5, ry, rz]
                self.ipd = 63.0

    # ---- lens -----------------------------------------------------------------------------

    def _query_lens(self) -> bool:
        """Asks the runtime. Slow (about 30 ms): never call it while answering /state."""
        if not self._lens:
            return False
        state = bool(self._lens_is_on(self._lens)) or bool(self._lens_is_on_pref(self._lens))
        self._lens_state = state
        return state

    def lens_enabled(self) -> bool:
        """Last known lens state, refreshed in the background by `lens_poller` and by `set_lens`."""
        return self._lens_state

    def set_lens(self, enable: bool) -> None:
        self.lens_requested = enable
        if enable:
            self.last_heartbeat = time.monotonic()
        if not self._lens:
            return
        (self._lens_on if enable else self._lens_off)(self._lens)
        for _ in range(8):
            if self._query_lens() == enable:
                break
            time.sleep(0.02)

    # ---- state ----------------------------------------------------------------------------

    def predicted_weaver_cm(self, raw_mm, lead_ms: float):
        """Where the weaving position will be in `lead_ms`, in cm; None when there is no usable answer."""
        if not self._predictor or lead_ms <= 0:
            return None
        out = WeaverPosition()
        with self.weave_lock:
            self._predict(self._predictor, int(lead_ms * 1000), C.byref(out))
        p = (out.pos.x, out.pos.y, out.pos.z)
        if not all(math.isfinite(v) for v in p):
            return None
        # A prediction is a small step from where the eyes are now. Anything further is the
        # predictor's idle default or a glitch: keep the measured position instead.
        if math.dist(p, (raw_mm[0] * 0.1, raw_mm[1] * 0.1, raw_mm[2] * 0.1)) > 6.0:
            return None
        return p

    def weave_corners(self, eye_cm) -> dict:
        corners = {"valid": False, "calibW": self.calib_w, "calibH": self.calib_h}
        zero = [0.0, 0.0, 0.0, 0.0, 0.0]
        values = {"tl": zero, "tr": zero, "bl": zero, "br": zero}
        if self.calibrated:
            size = FLOAT2(float(self.display["physResW"]), float(self.display["physResH"]))
            offset = FLOAT2(0.0, 0.0)
            with self.weave_lock:
                # Dimenco::Weaver::SetGlobalParameters takes the eye position in CENTIMETRES; the
                # eye tracker reports millimetres. (Checked with tools/verify_weave.py.)
                self._set_eye(FLOAT3(eye_cm[0], eye_cm[1], eye_cm[2]))
                for name, (nx, ny) in (("tl", (-1, 1)), ("tr", (1, 1)), ("bl", (-1, -1)), ("br", (1, -1))):
                    a2, a3, a4, a5 = FLOAT4(), FLOAT4(), FLOAT2(), FLOAT2()
                    self._fill(C.byref(size), C.byref(offset), C.byref(FLOAT4(nx, ny, 0.0, 1.0)),
                               C.byref(a2), C.byref(a3), C.byref(a4), C.byref(a5))
                    values[name] = [round(finite(v), 6) for v in (a2.x, a3.z, a3.w, a5.x, a5.y)]
            corners["valid"] = values["tl"][0] != 0.0
        corners.update(values)
        return corners

    def hub_conversion(self) -> bool:
        now = time.monotonic()
        if now - self._hub_conversion_checked > 1.5:
            self._hub_conversion_checked = now
            try:
                self._hub_conversion = process_running(HUB_CONVERSION_PROCESS)
            except OSError:
                self._hub_conversion = False
        return self._hub_conversion

    def state(self, lead_ms: float = 0.0) -> dict:
        with self.eye_lock:
            left, right, weaver = list(self.left), list(self.right), list(self.weaver_pos)
            frame_id, time_us, ipd, last_tracked = self.frame_id, self.time_us, self.ipd, self.last_tracked
        tracking = last_tracked > 0.0 and (time.monotonic() - last_tracked) < TRACKING_TIMEOUT_S
        weave_cm = [weaver[0] * 0.1, weaver[1] * 0.1, weaver[2] * 0.1]
        predicted = self.predicted_weaver_cm(weaver, lead_ms) if tracking else None
        if predicted:
            weave_cm = list(predicted)
        return {
            "apiVersion": API_VERSION,
            "connected": self.connected,
            "lensEnabled": self.lens_enabled(),
            "lensRequested": self.lens_requested,
            "tracking": tracking,
            "hubConversion": self.hub_conversion(),
            "frameId": frame_id,
            "timestampUs": time_us,
            "ipdMm": round(ipd, 2),
            "leftEyeMm": [round(v, 3) for v in left],
            "rightEyeMm": [round(v, 3) for v in right],
            "weaverPosMm": [round(v, 3) for v in weaver],
            "leadMs": round(lead_ms, 1) if predicted else 0.0,
            "weavePosMm": [round(v * 10.0, 3) for v in weave_cm],
            "display": self.display,
            "optics": self.optics,
            "weaveCorners": self.weave_corners(weave_cm),
        }


CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Private-Network": "true",
}


def make_handler(bridge: Bridge):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args) -> None:  # one line per request at 60 Hz would be noise
            pass

        def _send(self, code: int, body: bytes, content_type: str, extra: dict | None = None) -> None:
            self.send_response(code)
            for key, value in {**CORS, **(extra or {})}.items():
                self.send_header(key, value)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            if body:
                self.wfile.write(body)
            self.close_connection = True

        def do_OPTIONS(self) -> None:
            self._send(204, b"", "text/plain", {
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Access-Control-Request-Private-Network",
            })

        def _lead_ms(self) -> float:
            query = self.path.split("?", 1)[1] if "?" in self.path else ""
            for part in query.split("&"):
                if part.startswith("lead="):
                    try:
                        return min(MAX_LEAD_MS, max(0.0, float(part[5:])))
                    except ValueError:
                        return 0.0
            return 0.0

        def _stream(self, lead_ms: float) -> None:
            self.send_response(200)
            for key, value in CORS.items():
                self.send_header(key, value)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            period = 1.0 / STREAM_HZ
            while True:  # ends with a ConnectionError when the page goes away
                started = time.monotonic()
                bridge.last_heartbeat = started
                body = json.dumps(bridge.state(lead_ms), separators=(",", ":")).encode("utf-8")
                self.wfile.write(b"data: " + body + b"\n\n")
                self.wfile.flush()
                time.sleep(max(0.0, period - (time.monotonic() - started)))

        def do_GET(self) -> None:
            bridge.last_heartbeat = time.monotonic()
            path = self.path.split("?", 1)[0]
            if path.startswith("/stream"):
                self._stream(self._lead_ms())
                return
            if path.startswith("/calibration"):
                if not bridge.calibrated:
                    self._send(404, b"", "application/octet-stream")
                    return
                self._send(200, bridge.calib_blob, "application/octet-stream", {
                    "Cache-Control": "public, max-age=3600",
                    "X-Calib-Width": str(bridge.calib_w),
                    "X-Calib-Height": str(bridge.calib_h),
                })
                return
            wanted = None
            if path.startswith("/lens/enable"):
                wanted = True
            elif path.startswith("/lens/disable"):
                wanted = False
            elif path.startswith("/lens/toggle"):
                wanted = not bridge.lens_requested
            if wanted is not None:
                changed = wanted != bridge.lens_requested
                bridge.set_lens(wanted)
                if changed:
                    print(f"[sr-bridge] 3D lens -> {'ON' if wanted else 'OFF'}", flush=True)
            body = json.dumps(bridge.state(self._lead_ms()), separators=(",", ":")).encode("utf-8")
            self._send(200, body, "application/json; charset=utf-8", {"Cache-Control": "no-store"})

        do_POST = do_GET

    return Handler


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            return  # the page went away while we were answering
        super().handle_error(request, client_address)


def lens_poller(bridge: Bridge) -> None:
    """Keeps the lens state fresh without making every /state answer wait for the runtime."""
    while True:
        time.sleep(0.3)
        try:
            bridge._query_lens()
        except OSError:
            pass


def lens_watchdog(bridge: Bridge) -> None:
    """Never leave the desktop striped: lens off when the viewer stops talking to the bridge."""
    while True:
        time.sleep(0.25)
        if bridge.lens_requested and time.monotonic() - bridge.last_heartbeat > LENS_WATCHDOG_S:
            bridge.set_lens(False)
            print("[sr-bridge] Watchdog: viewer silent for 3.5 s -> 3D lens DISABLED", flush=True)


def main() -> int:
    args = sys.argv[1:]
    probe = "--probe" in args
    port = 5033
    if "--port" in args and args.index("--port") + 1 < len(args):
        port = int(args[args.index("--port") + 1])

    bridge = Bridge()
    ok = bridge.init()

    if probe:
        time.sleep(0.25)
        print(json.dumps(bridge.state(), separators=(",", ":")))
        bridge.set_lens(False)
        if not ok:
            return 1
        return 0 if bridge.calibrated else 2

    atexit.register(lambda: bridge.set_lens(False))
    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, lambda *_: sys.exit(0))

    try:
        server = QuietServer(("127.0.0.1", port), make_handler(bridge))
    except OSError as err:
        print(f"[sr-bridge] cannot listen on 127.0.0.1:{port}: {err} (another bridge running?)", flush=True)
        return 1
    threading.Thread(target=lens_watchdog, args=(bridge,), daemon=True).start()
    threading.Thread(target=lens_poller, args=(bridge,), daemon=True).start()
    print(f"[sr-bridge] Listening on http://127.0.0.1:{port} (2D desktop watchdog active)", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        bridge.set_lens(False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
