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
  /**
   * The mid-eye the bridge PREDICTS for `leadMs` ahead, the one the weave attributes were computed
   * for. Equal to weaverPosMm with no prediction (old bridge, nobody tracked, lead 0).
   */
  weavePosMm: [number, number, number];
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
  weavePosMm: [0.0, 100.0, 600.0],
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

const clampLead = (ms: number): number => (Number.isFinite(ms) ? Math.min(80, Math.max(0, Math.round(ms))) : 0);

const finitePositive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * How far ahead the bridge predicts the head, in milliseconds: the time between the eye tracker's
 * measurement and the picture reaching the panel. 0 = no prediction. Too low and the views lag
 * behind a moving head (the image doubles when moving fast); too high and they overshoot.
 *
 * The official LeiaSR weaver predicts one frame (16.7 ms, its `getLatency` on this machine) but
 * draws straight to the screen. A browser page adds about two frames on top: the bridge's stream
 * (up to 8 ms), the wait for the next animation frame (up to 16.7 ms) and the compositor (16.7 ms).
 * Hence 50 (was 35, which doubled on fast head moves, 2026-11-17).
 */
export const DEFAULT_PREDICTION_LEAD_MS = 50;

export interface SrBridgeClientOptions {
  baseUrl?: string;
  predictionLeadMs?: number;
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
  private stream: EventSource | null = null;
  private lastStreamMs = -1e9;
  private leadMs: number;
  private inFlight = false;
  private calibLoaded = false;
  private calibInFlight = false;
  private disposed = false;
  private lastLensHeartbeatMs = 0;
  /** What THIS page last asked for. Another page may hold the lens too: never act on its wish. */
  private wantLens = false;
  private lastSmoothMs = performance.now();
  /** Learnt eye separation (mm) and the smoothed left→right eye direction (unit vector). */
  private ipdEstMm = 63;
  private ipdSamples = 0;
  private ipdRejects = 0;
  private eyeDir: [number, number, number] = [1, 0, 0];
  private calibRetryAtMs = 0;

  /** Optional mouse-driven head simulation when testing parallax without webcam face tracking. */
  private simulateMouseHead = false;
  private mouseHeadMm: [number, number, number] = [0.0, 80.0, 600.0];

  constructor(options: SrBridgeClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '/sr-bridge').replace(/\/+$/, '');
    this.leadMs = clampLead(options.predictionLeadMs ?? DEFAULT_PREDICTION_LEAD_MS);
    this.onStateChange = options.onStateChange;
    this.onCalibrationLoaded = options.onCalibrationLoaded;

    window.addEventListener('mousemove', this.handleMouseMove, { passive: true });
    window.addEventListener('pagehide', this.handlePageUnload);
    window.addEventListener('beforeunload', this.handlePageUnload);
  }

  start(): void {
    if (this.pollTimer !== null) return;
    void this.pollOnce();
    this.openStream();
    // The stream carries the state; this timer is the fallback (old bridge, proxy without
    // streaming) and runs the housekeeping (calibration fetch, lens heartbeat).
    this.pollTimer = window.setInterval(() => {
      void this.pollOnce();
    }, 16);
  }

  stop(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.stream?.close();
    this.stream = null;
  }

  get predictionLeadMs(): number {
    return this.leadMs;
  }

  /** Changes how far ahead the bridge predicts the head (see DEFAULT_PREDICTION_LEAD_MS). */
  setPredictionLeadMs(ms: number): void {
    const next = clampLead(ms);
    if (next === this.leadMs) return;
    this.leadMs = next;
    if (this.stream) this.openStream();
  }

  /**
   * Server-sent events from the bridge: the state arrives 120 times a second without a request
   * per sample, which removes the polling delay and its jitter.
   */
  private openStream(): void {
    this.stream?.close();
    this.stream = null;
    if (this.disposed || typeof EventSource === 'undefined') return;
    const stream = new EventSource(`${this.baseUrl}/stream?lead=${this.leadMs}`);
    stream.onmessage = (ev: MessageEvent<string>) => {
      try {
        const data = JSON.parse(ev.data) as Partial<SrBridgeState>;
        this.lastStreamMs = performance.now();
        this.applyPayload(data, true);
      } catch {
        // a malformed sample is skipped; the next one is 8 ms away
      }
    };
    this.stream = stream; // EventSource reconnects by itself; polling covers the gap
  }

  private get streaming(): boolean {
    return performance.now() - this.lastStreamMs < 250;
  }

  private afterState(): void {
    // The LUTs only exist when the runtime identified the panel; ask at most every 10 s.
    if (!this.calibLoaded && this.state.displayTrusted && performance.now() >= this.calibRetryAtMs) {
      this.calibRetryAtMs = performance.now() + 10_000;
      void this.fetchCalibrationOnce();
    }
    // Watchdog heartbeat: while the lens is requested, re-assert it every 1.5 s so the bridge's
    // watchdog never drops it under a live viewer.
    if (this.wantLens && performance.now() - this.lastLensHeartbeatMs > 1500) {
      this.lastLensHeartbeatMs = performance.now();
      void fetch(`${this.baseUrl}/lens/enable`, { method: 'POST', cache: 'no-store' }).catch(() => {});
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

    // The views are rendered for the SAME predicted head as the weave (2026-11-17): the bridge
    // computes the weave for where the head will be `leadMs` ahead; eyes left at their measured
    // place gave views for an older head than the weave expects, and on a fast move each eye got
    // part of the other's view (the image doubled). Both eyes are moved by the prediction's offset.
    // Then a light, frame-rate independent smoothing (12 ms) against the stream's jitter.
    const s = this.state;
    const ahead = [0, 1, 2].map((i) => {
      const d = s.weavePosMm[i]! - s.weaverPosMm[i]!;
      return Number.isFinite(d) && Math.abs(d) < 150 ? d : 0; // a wild prediction is ignored
    });
    const nowMs = performance.now();
    const dtMs = Math.min(100, Math.max(0, nowMs - this.lastSmoothMs));
    this.lastSmoothMs = nowMs;

    // The eye separation (2026-11-17, « la 3D tremble quand on bouge la tête »): recorded on the
    // real tracker, the distance between the two eyes is steady at rest (62 ± 1 mm) but jumps to
    // anywhere between 36 and 98 mm during a fast move, and the left/right depth difference
    // wobbles by ±1 cm. Taken as measured, it made each eye's view jump by centimetres: the stereo
    // shook. The eyes are now the (predicted, filtered) mid-eye ± half a slowly learnt IPD along a
    // smoothed eye direction. A different person is picked up within a second or so.
    const hx = s.rightEyeMm[0] - s.leftEyeMm[0];
    const hy = s.rightEyeMm[1] - s.leftEyeMm[1];
    const hz = s.rightEyeMm[2] - s.leftEyeMm[2];
    const len = Math.hypot(hx, hy, hz);
    if (s.tracking && len > 40 && len < 90) {
      const learning = this.ipdSamples < 60;
      if (learning || Math.abs(len - this.ipdEstMm) < 6) {
        this.ipdEstMm += (len - this.ipdEstMm) * (learning ? 0.1 : 1 - Math.exp(-dtMs / 2000));
        this.ipdSamples += 1;
        this.ipdRejects = 0;
        const aDir = 1 - Math.exp(-dtMs / 250);
        // No vertical component: the tracker puts one eye above the other by ±8 mm at random
        // (recorded: right−left height 0.7 ± 8.0 mm), which gave the two views a shaking
        // vertical offset (user: « quand je monte et descends la tête aussi ça tremble »). The
        // eyes are kept level; a tilted head then sees no vertical disparity, which is harmless.
        this.eyeDir[0] += (hx / len - this.eyeDir[0]) * aDir;
        this.eyeDir[1] = 0;
        this.eyeDir[2] += (hz / len - this.eyeDir[2]) * aDir;
        const n = Math.hypot(this.eyeDir[0], this.eyeDir[1], this.eyeDir[2]) || 1;
        for (let i = 0; i < 3; i += 1) this.eyeDir[i] /= n;
      } else if ((this.ipdRejects += 1) > 120) {
        this.ipdSamples = 0; // consistently different for a while: someone else, learn again
      }
    }
    const half = 0.5 * this.ipdEstMm;
    const alpha = 1 - Math.exp(-dtMs / 12);
    for (let i = 0; i < 3; i += 1) {
      const mid = s.weaverPosMm[i]! + ahead[i]!;
      this.smoothedLeftMm[i] += (mid - this.eyeDir[i]! * half - this.smoothedLeftMm[i]) * alpha;
      this.smoothedRightMm[i] += (mid + this.eyeDir[i]! * half - this.smoothedRightMm[i]) * alpha;
      this.smoothedWeaverMm[i] += (mid - this.smoothedWeaverMm[i]) * alpha;
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
    this.wantLens = enable;
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
    if (this.streaming) {
      this.afterState();
      return;
    }
    this.inFlight = true;
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 450);
      try {
        let resp = await fetch(`${this.baseUrl}/state?lead=${this.leadMs}`, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
        }).catch(() => null);
        if ((!resp || !resp.ok) && this.baseUrl !== this.fallbackUrl) {
          resp = await fetch(`${this.fallbackUrl}/state?lead=${this.leadMs}`, {
            method: 'GET',
            cache: 'no-store',
            signal: controller.signal,
          }).catch(() => null);
          if (resp && resp.ok) {
            this.baseUrl = this.fallbackUrl;
            this.openStream();
          }
        }
        if (resp && resp.ok) {
          const data = await readBridgeJson(resp);
          if (!data) {
            this.markUnreachable();
            return;
          }
          this.applyPayload(data, true);
          this.afterState();
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
      weavePosMm: isVec3(data.weavePosMm)
        ? data.weavePosMm
        : isVec3(data.weaverPosMm)
          ? data.weaverPosMm
          : this.state.weavePosMm,
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
