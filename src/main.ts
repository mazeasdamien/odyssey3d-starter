/**
 * Minimal glasses-free 3D page for the Samsung Odyssey 3D (G90XF).
 *
 * Replace `buildScene()` with your own three.js scene; keep the rest. The parts that make the 3D
 * work, and that are easy to break, are marked « 3D rule ».
 *
 * Keys: F full-screen 3D · 1 weave · 2 side-by-side · 3 anaglyph · 4 2D · T red/cyan test
 * pattern · [ ] phase · , . head prediction −/+ 5 ms · X swap eyes · H hide the status box.
 */
import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  TorusKnotGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';

import { DEFAULT_KOOIMA_TUNING, KooimaStereoRig, type KooimaTuning } from './odyssey3d/kooima-camera';
import { SrBridgeClient, actualScreenPixels } from './odyssey3d/sr-client';
import {
  DEFAULT_WEAVE_TUNING,
  StereoComposer,
  type StereoDisplayMode,
  type WeaveFineTuning,
} from './odyssey3d/stereo-composer';

// ── Your scene ───────────────────────────────────────────────────────────────

/** What the camera looks at. It sits on the screen plane: nearer pops out, farther recedes. */
const TARGET = new Vector3(0, 0.12, 0);

function buildScene(): { scene: Scene; animate: (seconds: number) => void } {
  const scene = new Scene();
  scene.background = new Color(0x07090d);
  scene.add(new AmbientLight(0xffffff, 0.7));
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(1.5, 3, 2);
  scene.add(sun);
  scene.add(new GridHelper(2, 20, 0x3b4a63, 0x1c2433));

  const knot = new Mesh(
    new TorusKnotGeometry(0.06, 0.02, 160, 24),
    new MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.35, metalness: 0.2 }),
  );
  knot.position.set(0, 0.16, 0.22); // in front of the screen plane
  scene.add(knot);

  const colors = [0x2f8cf0, 0xe9cf1f, 0x34d17a];
  colors.forEach((color, i) => {
    const box = new Mesh(new BoxGeometry(0.12, 0.12, 0.12), new MeshStandardMaterial({ color, roughness: 0.6 }));
    box.position.set(-0.3 + i * 0.3, 0.06, -0.35 - i * 0.2); // behind the screen plane
    scene.add(box);
  });

  return {
    scene,
    animate: (seconds) => {
      knot.rotation.set(seconds * 0.4, seconds * 0.6, 0);
    },
  };
}

// ── Display plumbing ─────────────────────────────────────────────────────────

const renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
document.body.appendChild(renderer.domElement);
const canvas = renderer.domElement;

const camera = new PerspectiveCamera(32, 16 / 9, 0.05, 25);
camera.position.set(0, 0.45, 1.25);
camera.lookAt(TARGET);

const { scene, animate } = buildScene();
const rig = new KooimaStereoRig();
const composer = new StereoComposer();

let mode: StereoDisplayMode = 'weave';
const kooima: KooimaTuning = { ...DEFAULT_KOOIMA_TUNING };
const weave: WeaveFineTuning = { ...DEFAULT_WEAVE_TUNING };

// Optional URL flags, for automated checks: ?test=1 starts on the test pattern, ?hud=0 hides the
// status box, ?mode=weave|sbs|anaglyph|mono picks the display mode.
const params = new URLSearchParams(window.location.search);
if (params.get('test') === '1') weave.testPattern = true;
if (params.get('hud') === '0') document.getElementById('status')?.classList.add('hidden');
const askedMode = params.get('mode');
if (askedMode === 'weave' || askedMode === 'sbs' || askedMode === 'anaglyph' || askedMode === 'mono') mode = askedMode;

const sr = new SrBridgeClient({
  onStateChange: () => syncLens(),
  onCalibrationLoaded: (tex0, tex1, width, height) => composer.setCalibrationTextures(tex0, tex1, width, height),
});

const isFullscreen = (): boolean =>
  document.fullscreenElement !== null ||
  (Math.abs(window.innerWidth - window.screen.width) <= 2 &&
    Math.abs(window.innerHeight - window.screen.height) <= 2);

/**
 * 3D rule: the drawing buffer must be exactly window x devicePixelRatio (3840x2160 in full-screen
 * on the G90XF), so one buffer pixel is one panel pixel. Checked every frame because
 * devicePixelRatio can change without a resize event.
 */
function ensureBufferSize(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(window.innerWidth * dpr));
  const h = Math.max(1, Math.round(window.innerHeight * dpr));
  if (canvas.width === w && canvas.height === h) return;
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  canvas.style.width = `${w / dpr}px`;
  canvas.style.height = `${h / dpr}px`;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

/**
 * 3D rule: the weave phase depends on the absolute panel column, so the shader needs the canvas
 * position on the panel. Exact in full-screen (0,0); an estimate in a window.
 */
function windowOriginOnPanel(): { x: number; y: number } {
  if (isFullscreen()) return { x: 0, y: 0 };
  const dpr = window.devicePixelRatio || 1;
  const border = Math.max(0, (window.outerWidth - window.innerWidth) * 0.5);
  const chromeTop = Math.max(0, window.outerHeight - window.innerHeight - border);
  return {
    x: Math.max(0, Math.round((window.screenX + border) * dpr)),
    y: Math.max(0, Math.round((window.screenY + chromeTop) * dpr)),
  };
}

/**
 * 3D rule: the lens stripes everything on the monitor, so it is only on while this page is the
 * visible full-screen window in weave mode. The bridge switches it off by itself if the page
 * stops polling.
 */
let lensWanted: boolean | null = null;
let lensReassertedMs = 0;
function syncLens(force = false): void {
  const want = mode === 'weave' && isFullscreen() && !document.hidden;
  if (force || want !== lensWanted) {
    // Our own wish changed: say so once. A page that is windowed or in the background releases
    // the lens here and then leaves it alone, so it never fights the page that is showing 3D.
    lensWanted = want;
    lensReassertedMs = performance.now();
    void sr.setLensEnabled(want);
    return;
  }
  // We are the visible full-screen 3D page and something else dropped the lens: take it back,
  // at most once a second.
  if (want && sr.current.connected && !sr.current.lensEnabled && performance.now() - lensReassertedMs > 1000) {
    lensReassertedMs = performance.now();
    void sr.setLensEnabled(true);
  }
}

document.addEventListener('fullscreenchange', () => syncLens(true));
document.addEventListener('visibilitychange', () => syncLens(true));
window.addEventListener('resize', () => syncLens());
window.addEventListener('beforeunload', () => void sr.setLensEnabled(false));

// ── Keys and status ──────────────────────────────────────────────────────────

const statusEl = document.getElementById('status')!;

window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (key === 'f') {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  } else if (key === '1') mode = 'weave';
  else if (key === '2') mode = 'sbs';
  else if (key === '3') mode = 'anaglyph';
  else if (key === '4') mode = 'mono';
  else if (key === 't') weave.testPattern = !weave.testPattern;
  else if (key === '[') weave.phaseOffset -= e.shiftKey ? 0.05 : 0.01;
  else if (key === ']') weave.phaseOffset += e.shiftKey ? 0.05 : 0.01;
  else if (key === 'x') kooima.swapEyes = !kooima.swapEyes;
  else if (key === 'h') statusEl.classList.toggle('hidden');
  // Head prediction: raise it if the depth lags behind when you move, lower it if it overshoots.
  else if (key === ',') sr.setPredictionLeadMs(sr.predictionLeadMs - 5);
  else if (key === '.') sr.setPredictionLeadMs(sr.predictionLeadMs + 5);
  else return;
  syncLens();
});

function refreshStatus(): void {
  const s = sr.current;
  const flag = (ok: boolean, yes: string, no: string): string =>
    `<b class="${ok ? 'ok' : 'warn'}">${ok ? yes : no}</b>`;
  const problems = s.diagnostics.map((d) => d.code).join(', ');
  statusEl.innerHTML = [
    `SR bridge: ${flag(s.bridgeReachable, 'online', 'offline (run Start-Odyssey3D.bat)')}`,
    `Calibration: ${flag(s.displayTrusted, 'factory data loaded', `missing${problems ? ` (${problems})` : ''}`)}`,
    `Eyes: ${flag(s.tracking, `tracked at ${(s.weaverPosMm[2] / 10).toFixed(0)} cm`, 'not tracked')}`,
    `Lens: ${flag(s.lensEnabled, '3D', '2D')} · mode ${mode}${weave.testPattern ? ' · test pattern' : ''}`,
    `Head prediction: ${sr.predictionLeadMs} ms (keys , and .)`,
    isFullscreen() ? 'F: leave full-screen' : 'F: full-screen 3D (depth is only exact in full-screen)',
    ...(s.hubConversion
      ? [
          '<b class="warn">Samsung Odyssey 3D Hub is converting this window to 3D itself and covers the page.</b>',
          '<b class="warn">In Odyssey 3D Hub, turn off "Convert to 3D in full screen".</b>',
        ]
      : []),
  ].join('\n');
  if (s.hubConversion) statusEl.classList.remove('hidden');
}

// ── Frame loop ───────────────────────────────────────────────────────────────

if (import.meta.env.DEV) {
  // Dev only: lets a console check read the composer's uniforms and the woven pixels.
  (window as unknown as { __odysseyDebug?: object }).__odysseyDebug = { stereoComposer: composer, srClient: sr };
}

sr.start();
let lastStatusMs = 0;

function frame(nowMs: number): void {
  ensureBufferSize();
  animate(nowMs / 1000);

  const { leftEyeMm, rightEyeMm, weaverPosMm } = sr.getSmoothedEyesMm();
  const state = sr.current;
  rig.update(camera, TARGET, leftEyeMm, rightEyeMm, state.display.widthCm, state.display.heightCm, kooima);

  composer.render(
    renderer,
    scene,
    camera,
    rig.leftCamera,
    rig.rightCamera,
    mode,
    weaverPosMm,
    state.display,
    state.optics,
    weave,
    state.weaveCorners,
    actualScreenPixels(),
    windowOriginOnPanel(),
  );

  if (nowMs - lastStatusMs > 250) {
    lastStatusMs = nowMs;
    refreshStatus();
    if (params.get('diag') === '1') {
      // Geometry as the browser sees it, readable from outside through the window title.
      const r = canvas.getBoundingClientRect();
      document.title = JSON.stringify({
        dpr: window.devicePixelRatio,
        inner: [window.innerWidth, window.innerHeight],
        outer: [window.outerWidth, window.outerHeight],
        screen: [window.screen.width, window.screen.height],
        buffer: [canvas.width, canvas.height],
        css: [r.left, r.top, r.width, r.height],
        zoom: window.visualViewport?.scale ?? null,
        fullscreen: isFullscreen(),
        origin: windowOriginOnPanel(),
      });
    }
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
