/**
 * Client for the local Samsung Odyssey 3D (G90XF) / LeiaSR hardware bridge (`sr-bridge/sr_bridge.py`).
 *
 * Streams:
 *   - Real-time 3D stereo eye positions (leftEyeMm, rightEyeMm, weaverPosMm) from SR Eye Tracker.
 *   - Physical display geometry (59.6736 cm x 33.5664 cm, 3840x2160, dot pitch 0.01554 cm).
 *   - DimencoWeaving optical calibration (px=1.80, slant=0.29, doN=1.50, n=1.50, slope=10, xtalk=0.012854).
 *   - Live per-corner FillAttributes (`weaveCorners`) and 480x270 factory lens LUTs (`/calibration`).
 *   - Switchable Lenticular Lens control (`/lens/enable`, `/lens/disable`).
 */

export interface OdysseyDisplayInfo {
  model: string;
  resW: number;
  resH: number;
  physResW: number;
  physResH: number;
  widthCm: number;
  heightCm: number;
  dotPitchCm: number;
  recViewW: number;
  recViewH: number;
}

export interface OdysseyOpticsInfo {
  px: number;
  slant: number;
  doN: number;
  n: number;
  pattern: number;
  viewFilterSlope: number;
  xtalkFactor: number;
}

/** 5-tuple `[a2.x, a3.z, a3.w, a5.x, a5.y]` returned by Dimenco::Weaver::FillAttributes for a screen corner. */
export type WeaveCornerTuple = [number, number, number, number, number];

export interface OdysseyWeaveCorners {
  valid: boolean;
  calibW: number;
  calibH: number;
  tl: WeaveCornerTuple;
  tr: WeaveCornerTuple;
  bl: WeaveCornerTuple;
  br: WeaveCornerTuple;
}

export interface SrBridgeState {
  bridgeReachable: boolean;
  connected: boolean;
  lensEnabled: boolean;
  lensRequested: boolean;
  tracking: boolean;
  /**
   * Samsung's Odyssey 3D Hub is converting the full-screen window to 3D by itself (its setting
   * "Convert to 3D in full screen"): its player draws over the page and ruins the weave.
   */
  hubConversion: boolean;
  frameId: number;
  timestampUs: number;
  ipdMm: number;
  leftEyeMm: [number, number, number];
  rightEyeMm: [number, number, number];
  weaverPosMm: [number, number, number];
  display: OdysseyDisplayInfo;
  optics: OdysseyOpticsInfo;
  weaveCorners: OdysseyWeaveCorners;
  /**
   * False when the LeiaSR runtime describes a panel that is not the one this window is on
   * (e.g. 7680x2160 / 69.8 cm while Windows reports a 3840x2160 G90XF), or returns
   * zero/NaN lens optics. The viewer then ignores the runtime geometry, optics and
   * per-corner weave attributes and uses the G90XF factory defaults instead.
   */
  displayTrusted: boolean;
  /** Why the runtime data was rejected or is incomplete (empty when all is well). */
  diagnostics: SrDiagnostic[];
}

export type SrDiagnostic =
  | { code: 'display-mismatch'; reportedW: number; reportedH: number; reportedCm: number; screenW: number; screenH: number }
  | { code: 'no-optics' }
  | { code: 'bridge-outdated' }
  | { code: 'hub-conversion' }
  | { code: 'no-tracking' };

/**
 * Bridges before API version 2 computed the weave attributes with the eye position in
 * millimetres where the Dimenco weaver expects centimetres: their `weaveCorners` are unusable.
 */
export const REQUIRED_BRIDGE_API_VERSION = 2;

/** Exact hardware defaults probed from the connected Samsung Odyssey G90XF (LeiaSR 1.36.4). */
export const ODYSSEY_G90XF_DEFAULTS: SrBridgeState = {
  bridgeReachable: false,
  connected: false,
  lensEnabled: false,
  lensRequested: false,
  tracking: false,
  hubConversion: false,
  frameId: 0,
  timestampUs: 0,
  ipdMm: 63.0,
  leftEyeMm: [-31.5, 100.0, 600.0],
  rightEyeMm: [31.5, 100.0, 600.0],
  weaverPosMm: [0.0, 100.0, 600.0],
  display: {
    model: 'Samsung Odyssey 3D (G90XF)',
    resW: 3840,
    resH: 2160,
    physResW: 3840,
    physResH: 2160,
    widthCm: 59.6736,
    heightCm: 33.5664,
    dotPitchCm: 0.01554,
    recViewW: 1920,
    recViewH: 1080,
  },
  optics: {
    px: 1.8,
    slant: 0.29,
    doN: 1.5,
    n: 1.5,
    pattern: 0.0,
    viewFilterSlope: 10.0,
    xtalkFactor: 0.012854,
  },
  weaveCorners: {
    valid: true,
    calibW: 480,
    calibH: 270,
    // Placeholder only (never used for weaving: `valid` is forced to false until a bridge
    // supplies real attributes for the tracked eye position).
    tl: [8763.014648, 0, 0, 0, 0],
    tr: [10890.018555, 0, 0, 0, 0],
    bl: [9109.266602, 0, 0, 0, 0],
    br: [11236.270508, 0, 0, 0, 0],
  },
  displayTrusted: false,
  diagnostics: [],
};

/** Physical pixel size of the screen this window is on (CSS screen size x devicePixelRatio). */
export function actualScreenPixels(): { w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  return {
    w: Math.round(window.screen.width * dpr),
    h: Math.round(window.screen.height * dpr),
  };
}

const finitePositive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;

export interface SrBridgeClientOptions {
  baseUrl?: string;
  onStateChange?: (state: SrBridgeState) => void;
  onCalibrationLoaded?: (tex0: Uint8Array, tex1: Uint8Array, width: number, height: number) => void;
}

export class SrBridgeClient {
  private baseUrl: string;
  private readonly fallbackUrl = 'http://127.0.0.1:5033';
  private readonly onStateChange?: (state: SrBridgeState) => void;
  private readonly onCalibrationLoaded?: (
    tex0: Uint8Array,
    tex1: Uint8Array,
    width: number,
    height: number,
  ) => void;

  private state: SrBridgeState = structuredClone(ODYSSEY_G90XF_DEFAULTS);
  private smoothedLeftMm: [number, number, number] = [-31.5, 100.0, 600.0];
  private smoothedRightMm: [number, number, number] = [31.5, 100.0, 600.0];
  private smoothedWeaverMm: [number, number, number] = [0.0, 100.0, 600.0];

  private pollTimer: number | null = null;
  private inFlight = false;
  private calibLoaded = false;
  private calibInFlight = false;
  private disposed = false;
  private lastLensHeartbeatMs = 0;
  private lastSmoothMs = performance.now();
  private calibRetryAtMs = 0;

  /** Optional mouse-driven head simulation when testing parallax without webcam face tracking. */
  private simulateMouseHead = false;
  private mouseHeadMm: [number, number, number] = [0.0, 80.0, 600.0];

  constructor(options: SrBridgeClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '/sr-bridge').replace(/\/+$/, '');
    this.onStateChange = options.onStateChange;
    this.onCalibrationLoaded = options.onCalibrationLoaded;

    window.addEventListener('mousemove', this.handleMouseMove, { passive: true });
    window.addEventListener('pagehide', this.handlePageUnload);
    window.addEventListener('beforeunload', this.handlePageUnload);
  }

  start(): void {
    if (this.pollTimer !== null) return;
    void this.pollOnce();
    this.pollTimer = window.setInterval(() => {
      void this.pollOnce();
    }, 16); // ~60 Hz bridge poll (localhost), smoothed per render frame
  }

  stop(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    window.removeEventListener('mousemove', this.handleMouseMove);
    window.removeEventListener('pagehide', this.handlePageUnload);
    window.removeEventListener('beforeunload', this.handlePageUnload);
    void this.setLensEnabled(false);
  }

  get current(): SrBridgeState {
    return this.state;
  }

  get mouseHeadSimulation(): boolean {
    return this.simulateMouseHead;
  }

  setMouseHeadSimulation(enabled: boolean): void {
    this.simulateMouseHead = enabled;
  }

  /**
   * Returns the smoothed stereo eye coordinates in millimeters relative to the
   * center of the Samsung Odyssey G90XF panel (+X right, +Y up, +Z out toward viewer).
   */
  getSmoothedEyesMm(): {
    leftEyeMm: readonly [number, number, number];
    rightEyeMm: readonly [number, number, number];
    weaverPosMm: readonly [number, number, number];
    tracking: boolean;
  } {
    if (this.simulateMouseHead) {
      const [cx, cy, cz] = this.mouseHeadMm;
      const halfIpd = 31.5;
      return {
        leftEyeMm: [cx - halfIpd, cy, cz],
        rightEyeMm: [cx + halfIpd, cy, cz],
        weaverPosMm: [cx, cy, cz],
        tracking: true,
      };
    }

    // Frame-rate independent exponential smoothing (time constant ~20 ms). The weave phase
    // depends on the eye position, so heavy smoothing shows up as the wrong view while moving.
    const nowMs = performance.now();
    const dtMs = Math.min(100, Math.max(0, nowMs - this.lastSmoothMs));
    this.lastSmoothMs = nowMs;
    const alpha = 1 - Math.exp(-dtMs / 20);
    for (let i = 0; i < 3; i += 1) {
      this.smoothedLeftMm[i] += (this.state.leftEyeMm[i] - this.smoothedLeftMm[i]) * alpha;
      this.smoothedRightMm[i] += (this.state.rightEyeMm[i] - this.smoothedRightMm[i]) * alpha;
      this.smoothedWeaverMm[i] += (this.state.weaverPosMm[i] - this.smoothedWeaverMm[i]) * alpha;
    }

    return {
      leftEyeMm: this.smoothedLeftMm,
      rightEyeMm: this.smoothedRightMm,
      weaverPosMm: this.smoothedWeaverMm,
      tracking: this.state.tracking,
    };
  }

  /** Enables or disables the physical Switchable Lenticular Lens on the Samsung Odyssey G90XF. */
  async setLensEnabled(enable: boolean): Promise<boolean> {
    if (enable) {
      this.lastLensHeartbeatMs = performance.now();
    }
    const endpoint = enable ? '/lens/enable' : '/lens/disable';
    for (const base of [this.baseUrl, this.fallbackUrl]) {
      try {
        const resp = await fetch(`${base}${endpoint}`, {
          method: 'POST',
          cache: 'no-store',
        });
        if (!resp.ok) continue;
        const data = await readBridgeJson(resp);
        if (!data) continue;
        this.baseUrl = base;
        this.applyPayload(data, true);
        return Boolean(this.state.lensEnabled);
      } catch {
        // Try fallback URL
      }
    }
    return false;
  }

  async toggleLens(): Promise<boolean> {
    return this.setLensEnabled(!this.state.lensEnabled);
  }

  private async fetchCalibrationOnce(): Promise<void> {
    if (this.calibLoaded || this.calibInFlight || this.disposed) return;
    this.calibInFlight = true;
    try {
      for (const base of [this.baseUrl, this.fallbackUrl]) {
        try {
          const resp = await fetch(`${base}/calibration`, {
            method: 'GET',
          });
          if (!resp.ok) continue;
          const buf = await resp.arrayBuffer();
          const w = this.state.weaveCorners.calibW || 480;
          const h = this.state.weaveCorners.calibH || 270;
          const planeSize = w * h;
          if (buf.byteLength >= planeSize * 2) {
            const bytes = new Uint8Array(buf);
            const tex0 = bytes.slice(0, planeSize);
            const tex1 = bytes.slice(planeSize, planeSize * 2);
            this.calibLoaded = true;
            this.onCalibrationLoaded?.(tex0, tex1, w, h);
            return;
          }
        } catch {
          // Try next base URL
        }
      }
    } finally {
      this.calibInFlight = false;
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.inFlight || this.disposed) return;
    this.inFlight = true;
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 450);
      try {
        let resp = await fetch(`${this.baseUrl}/state`, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
        }).catch(() => null);
        if ((!resp || !resp.ok) && this.baseUrl !== this.fallbackUrl) {
          resp = await fetch(`${this.fallbackUrl}/state`, {
            method: 'GET',
            cache: 'no-store',
            signal: controller.signal,
          }).catch(() => null);
          if (resp && resp.ok) {
            this.baseUrl = this.fallbackUrl;
          }
        }
        if (resp && resp.ok) {
          const data = await readBridgeJson(resp);
          if (!data) {
            this.markUnreachable();
            return;
          }
          this.applyPayload(data, true);
          // The LUTs only exist when the runtime identified the panel; ask at most every 10 s.
          if (!this.calibLoaded && this.state.displayTrusted && performance.now() >= this.calibRetryAtMs) {
            this.calibRetryAtMs = performance.now() + 10_000;
            void this.fetchCalibrationOnce();
          }
          // Watchdog heartbeat: when lens is requested, continuously assert /lens/enable every 1.5s
          // so the hardware watchdog in sr-bridge never drops the physical 3D lenticular lens!
          if (this.state.lensRequested && performance.now() - this.lastLensHeartbeatMs > 1500) {
            this.lastLensHeartbeatMs = performance.now();
            void fetch(`${this.baseUrl}/lens/enable`, { method: 'POST', cache: 'no-store' }).catch(() => {});
          }
        } else {
          this.markUnreachable();
        }
      } finally {
        window.clearTimeout(timeout);
      }
    } catch {
      this.markUnreachable();
    } finally {
      this.inFlight = false;
    }
  }

  private applyPayload(data: Partial<SrBridgeState>, reachable: boolean): void {
    const wc = data.weaveCorners;
    const nextCorners: OdysseyWeaveCorners =
      wc &&
      isVec5(wc.tl) &&
      isVec5(wc.tr) &&
      isVec5(wc.bl) &&
      isVec5(wc.br)
        ? {
            valid: Boolean(wc.valid),
            calibW: typeof wc.calibW === 'number' && wc.calibW > 0 ? wc.calibW : 480,
            calibH: typeof wc.calibH === 'number' && wc.calibH > 0 ? wc.calibH : 270,
            tl: wc.tl,
            tr: wc.tr,
            bl: wc.bl,
            br: wc.br,
          }
        : this.state.weaveCorners;

    const diagnostics: SrDiagnostic[] = [];
    const defaults = ODYSSEY_G90XF_DEFAULTS;

    // --- Display geometry: only trust the runtime when it matches the screen we are on.
    let display = this.state.display;
    if (data.display) {
      const d = data.display;
      const screenPx = actualScreenPixels();
      const physW = finitePositive(d.physResW) ? d.physResW : 0;
      const physH = finitePositive(d.physResH) ? d.physResH : 0;
      const sizeOk = finitePositive(d.widthCm) && finitePositive(d.heightCm) && finitePositive(d.dotPitchCm);
      // The screen size seen by the page scales with browser zoom, so also accept the known
      // G90XF panel (3840x2160, ~59.7 cm wide) when the runtime describes exactly that.
      const isG90xfPanel =
        physW === defaults.display.physResW &&
        physH === defaults.display.physResH &&
        Math.abs((d.widthCm ?? 0) - defaults.display.widthCm) < 1;
      const resMatches =
        (Math.abs(physW - screenPx.w) <= 2 && Math.abs(physH - screenPx.h) <= 2) || isG90xfPanel;
      if (sizeOk && resMatches) {
        display = { ...defaults.display, ...d };
      } else {
        display = { ...defaults.display };
        diagnostics.push({
          code: 'display-mismatch',
          reportedW: physW,
          reportedH: physH,
          reportedCm: finitePositive(d.widthCm) ? d.widthCm : 0,
          screenW: screenPx.w,
          screenH: screenPx.h,
        });
      }
    }

    // --- Lens optics: reject zero / NaN values field by field.
    let optics = this.state.optics;
    if (data.optics) {
      const o = data.optics;
      const pick = (key: keyof OdysseyOpticsInfo): number => {
        const v = o[key];
        return typeof v === 'number' && Number.isFinite(v) && (key === 'pattern' || v > 0)
          ? v
          : defaults.optics[key];
      };
      const opticsOk = finitePositive(o.px) && finitePositive(o.slant) && finitePositive(o.doN);
      optics = {
        px: pick('px'),
        slant: pick('slant'),
        doN: pick('doN'),
        n: pick('n'),
        pattern: pick('pattern'),
        viewFilterSlope: pick('viewFilterSlope'),
        xtalkFactor: pick('xtalkFactor'),
      };
      if (!opticsOk) {
        diagnostics.push({ code: 'no-optics' });
      }
    }

    const apiVersion = (data as { apiVersion?: unknown }).apiVersion;
    if (data.connected && !(typeof apiVersion === 'number' && apiVersion >= REQUIRED_BRIDGE_API_VERSION)) {
      diagnostics.push({ code: 'bridge-outdated' });
    }

    const displayTrusted = diagnostics.length === 0 && Boolean(data.connected) && Boolean(wc?.valid);
    const corners: OdysseyWeaveCorners = displayTrusted
      ? nextCorners
      : { ...nextCorners, valid: false };
    if (data.hubConversion) {
      diagnostics.push({ code: 'hub-conversion' });
    }
    if (data.connected && !data.tracking) {
      diagnostics.push({ code: 'no-tracking' });
    }

    const next: SrBridgeState = {
      bridgeReachable: reachable,
      connected: Boolean(data.connected),
      lensEnabled: Boolean(data.lensEnabled),
      lensRequested: Boolean(data.lensRequested),
      tracking: Boolean(data.tracking),
      hubConversion: Boolean(data.hubConversion),
      frameId: typeof data.frameId === 'number' ? data.frameId : this.state.frameId,
      timestampUs: typeof data.timestampUs === 'number' ? data.timestampUs : this.state.timestampUs,
      ipdMm: typeof data.ipdMm === 'number' && data.ipdMm > 10 ? data.ipdMm : 63.0,
      leftEyeMm: isVec3(data.leftEyeMm) ? data.leftEyeMm : this.state.leftEyeMm,
      rightEyeMm: isVec3(data.rightEyeMm) ? data.rightEyeMm : this.state.rightEyeMm,
      weaverPosMm: isVec3(data.weaverPosMm) ? data.weaverPosMm : this.state.weaverPosMm,
      display,
      optics,
      weaveCorners: corners,
      displayTrusted,
      diagnostics,
    };

    const changed =
      next.bridgeReachable !== this.state.bridgeReachable ||
      next.connected !== this.state.connected ||
      next.lensEnabled !== this.state.lensEnabled ||
      next.tracking !== this.state.tracking ||
      next.hubConversion !== this.state.hubConversion ||
      next.displayTrusted !== this.state.displayTrusted ||
      next.diagnostics.length !== this.state.diagnostics.length ||
      Math.abs(next.weaverPosMm[0] - this.state.weaverPosMm[0]) > 0.5 ||
      Math.abs(next.weaverPosMm[1] - this.state.weaverPosMm[1]) > 0.5 ||
      Math.abs(next.weaverPosMm[2] - this.state.weaverPosMm[2]) > 0.5;

    this.state = next;
    if (changed) {
      this.onStateChange?.(this.state);
    }
  }

  private markUnreachable(): void {
    if (!this.state.bridgeReachable) return;
    this.state = {
      ...this.state,
      bridgeReachable: false,
      connected: false,
      tracking: false,
    };
    this.onStateChange?.(this.state);
  }

  private readonly handleMouseMove = (event: MouseEvent): void => {
    if (!this.simulateMouseHead) return;
    const nx = (event.clientX / Math.max(window.innerWidth, 1)) * 2 - 1;
    const ny = 1 - (event.clientY / Math.max(window.innerHeight, 1)) * 2;
    this.mouseHeadMm = [nx * 180.0, 80.0 + ny * 110.0, 600.0];
  };

  private readonly handlePageUnload = (): void => {
    try {
      navigator.sendBeacon(`${this.baseUrl}/lens/disable`);
    } catch {}
    try {
      navigator.sendBeacon(`${this.fallbackUrl}/lens/disable`);
    } catch {}
  };
}

/**
 * Parses a bridge response. A native bridge formats floats with printf, so a NaN lens parameter
 * arrives as `-nan(ind)` / `inf`, which is not JSON: replace those tokens with null first.
 */
async function readBridgeJson(resp: Response): Promise<Partial<SrBridgeState> | null> {
  try {
    const text = await resp.text();
    const cleaned = text.replace(/-?\b(?:nan|inf|infinity)\b(?:\([a-z]*\))?/gi, 'null');
    return JSON.parse(cleaned) as Partial<SrBridgeState>;
  } catch {
    return null;
  }
}

function isVec3(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    typeof value[2] === 'number' &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Number.isFinite(value[2])
  );
}

function isVec5(value: unknown): value is WeaveCornerTuple {
  return (
    Array.isArray(value) &&
    value.length === 5 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    typeof value[2] === 'number' &&
    typeof value[3] === 'number' &&
    typeof value[4] === 'number' &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Number.isFinite(value[2]) &&
    Number.isFinite(value[3]) &&
    Number.isFinite(value[4])
  );
}
