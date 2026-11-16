import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  Mesh,
  NoToneMapping,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Uniform,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
  WebGLRenderTarget,
  type PerspectiveCamera,
} from 'three';

import type { OdysseyDisplayInfo, OdysseyOpticsInfo, OdysseyWeaveCorners } from './sr-client';

/**
 * 3D Stereo Composition & Hardware Lenticular Weaver for the Samsung Odyssey 3D (G90XF).
 *
 * Reproduces the official LeiaSR GL weaver (`SimulatedRealityOpenGL.dll`):
 *   - Uses `Dimenco::Weaver::FillAttributes` per-corner attributes (`a2.x, a3.zw, a5.xy`)
 *     streamed live from the SR bridge for the user's tracked 3D eye coordinates.
 *   - Samples the monitor's two 480x270 factory-calibrated optical correction LUT textures
 *     (`LoadTexture(0)` and `LoadTexture(1)`) fetched from the SR bridge (`/calibration`).
 *   - phase = a2.x + a5.x / sqrt(1 + a3.z^2 + a3.w^2) + 2 a5.y (corrB - 0.5) - corrA, RGB
 *     subpixel offsets `(0, 1/3, 2/3)`, viewFilterSlope (`10.0`), static crosstalk
 *     compensation (`0.012854`).
 *
 * `tools/verify_weave.py` checks this against the official weaver on the real monitor. Without
 * factory calibration (monitor not identified by the runtime) a generic approximation is used,
 * which cannot be expected to give a clean 3D image.
 */

export type StereoDisplayMode = 'weave' | 'sbs' | 'anaglyph' | 'mono';

export interface WeaveFineTuning {
  /** Manual phase offset in [0..1] cycles. */
  phaseOffset: number;
  /** Fine adjustment multiplier around hardware Px (1.80). */
  pitchAdjust: number;
  /** Fine adjustment around hardware Slant (0.29). */
  slantAdjust: number;
  /** Static crosstalk compensation factor (default 0.012854 from DimencoWeaving.dll). */
  xtalkFactor: number;
  /** View filter slope (default 10.0 from DimencoWeaving.dll). */
  viewFilterSlope: number;
  /**
   * Calibration aid: replaces the left view by solid red and the right view by solid cyan.
   * Close one eye and turn the phase until that eye sees one flat colour, no stripes.
   */
  testPattern: boolean;
}

export const DEFAULT_WEAVE_TUNING: WeaveFineTuning = {
  phaseOffset: 0.0,
  pitchAdjust: 0.0,
  slantAdjust: 0.0,
  xtalkFactor: 0.012854,
  viewFilterSlope: 10.0,
  testPattern: false,
};

const VERTEX_SHADER = /* glsl */ `
precision highp float;

varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform sampler2D uLeftTex;
uniform sampler2D uRightTex;
uniform sampler2D uCalibTex0;
uniform sampler2D uCalibTex1;
uniform int uMode; // 0 = weave, 1 = sbs, 2 = anaglyph
uniform int uUseCalibCorners;
uniform float uA2TL;
uniform float uA2TR;
uniform float uA2BL;
uniform float uA2BR;
uniform vec4 uA35TL; // (a3.z, a3.w, a5.x, a5.y) at Top-Left
uniform vec4 uA35TR; // (a3.z, a3.w, a5.x, a5.y) at Top-Right
uniform vec4 uA35BL; // (a3.z, a3.w, a5.x, a5.y) at Bottom-Left
uniform vec4 uA35BR; // (a3.z, a3.w, a5.x, a5.y) at Bottom-Right
uniform vec2 uResolution;
uniform vec2 uPanelResolution;
uniform vec2 uWindowOrigin;
uniform vec3 uWeaverPosMm;
uniform float uDotPitchMm;
uniform float uPx;
uniform float uSlant;
uniform float uDoN;
uniform float uDPhaseDx;
uniform float uPitchAdjust;
uniform float uSlantAdjust;
uniform float uViewFilterSlope;
uniform float uXTalkFactor;
uniform float uPhaseOffset;
uniform int uTestPattern;

varying vec2 vUv;

// The eye render targets are SRGB8_ALPHA8: three.js writes LINEAR light into them and the GPU
// decodes back to LINEAR on sampling. So texture2D() already returns linear values; the only
// conversion needed is the final linear -> sRGB encode for the default framebuffer.
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

vec3 sampleLeft(vec2 uv) {
  return uTestPattern == 1 ? vec3(1.0, 0.0, 0.0) : texture2D(uLeftTex, uv).rgb;
}

vec3 sampleRight(vec2 uv) {
  return uTestPattern == 1 ? vec3(0.0, 0.85, 1.0) : texture2D(uRightTex, uv).rgb;
}

void main() {
  if (uMode == 1) {
    // Side-by-Side (SBS)
    vec3 sbs = vUv.x < 0.5
      ? sampleLeft(vec2(vUv.x * 2.0, vUv.y))
      : sampleRight(vec2((vUv.x - 0.5) * 2.0, vUv.y));
    gl_FragColor = vec4(toSrgb(sbs), 1.0);
    return;
  }

  if (uMode == 2) {
    // Dubois Red-Cyan Anaglyph
    // Dubois matrices are defined on display (gamma-encoded) values.
    vec3 leftCol = toSrgb(sampleLeft(vUv));
    vec3 rightCol = toSrgb(sampleRight(vUv));
    mat3 mLeft = mat3(
      0.437, -0.062, -0.048,
      0.449, -0.062, -0.050,
      0.164, -0.024, -0.017
    );
    mat3 mRight = mat3(
      -0.011, 0.377, -0.026,
      -0.032, 0.761, -0.093,
      -0.007, 0.009, 1.234
    );
    vec3 col = clamp(mLeft * leftCol + mRight * rightCol, 0.0, 1.0);
    gl_FragColor = vec4(col, 1.0);
    return;
  }

  // Mode 0: subpixel lenticular weave, reproducing the official LeiaSR GL weaver
  // (SimulatedRealityOpenGL.dll). tools/verify_weave.py compares this formula with the official
  // weaver's output on this monitor. Like the official weaver in its default configuration, the
  // two views are blended as display (gamma-encoded) values.
  vec3 leftView = toSrgb(sampleLeft(vUv));
  vec3 rightView = toSrgb(sampleRight(vUv));

  // Physical pixel coordinates on the 3840x2160 panel
  float physX = uWindowOrigin.x + gl_FragCoord.x;
  float physYTopDown = uWindowOrigin.y + (uResolution.y - gl_FragCoord.y);
  float screenU = clamp(physX / max(1.0, uPanelResolution.x), 0.0, 1.0);
  float screenV = clamp(1.0 - (physYTopDown / max(1.0, uPanelResolution.y)), 0.0, 1.0);

  vec3 phase;
  float dynamicXTalk = uXTalkFactor;
  if (uUseCalibCorners == 1) {
    // Per-fragment bilinear interpolation in physical panel space (avoids 2-triangle diagonal drift)
    float a2Bot = mix(uA2BL, uA2BR, screenU);
    float a2Top = mix(uA2TL, uA2TR, screenU);
    float fragA2 = mix(a2Bot, a2Top, screenV);

    vec4 a35Bot = mix(uA35BL, uA35BR, screenU);
    vec4 a35Top = mix(uA35TL, uA35TR, screenU);
    vec4 fragA35 = mix(a35Bot, a35Top, screenV);

    // Sample factory 480x270 optical calibration LUTs
    vec2 calibUv = vec2(screenU, screenV);
    float corrA = texture2D(uCalibTex0, calibUv).r;
    float corrB = texture2D(uCalibTex1, calibUv).r;

    // Official weaver phase (fragment program of SR::GLWeaverBase):
    //   phase = a2.x + a5.x / sqrt(1 + a3.z^2 + a3.w^2) + 2 * a5.y * (corrB - 0.5) - corrA
    // a2 is the lens phase of the pixel, a3 the refracted view direction, a5 the view-dependent
    // shift; corrA / corrB are the monitor's factory correction maps.
    float rsq = inversesqrt(fragA35.x * fragA35.x + fragA35.y * fragA35.y + 1.0);
    float manualDelta = (physX * uPitchAdjust) + (physYTopDown * uSlantAdjust);
    float basePhase = fragA2 + fragA35.z * rsq + 2.0 * fragA35.w * (corrB - 0.5) - corrA
      + manualDelta + uPhaseOffset;

    // R, G, B subpixels sit at 0, 1/3 and 2/3 of a pixel: phase + dPhase/dx * offset
    vec3 subOffX = vec3(0.0, 0.33333333, 0.66666667);
    phase = vec3(basePhase) + uDPhaseDx * subOffX;
  } else {
    float eyeZ = max(250.0, uWeaverPosMm.z);
    float pixelMmX = (physX - 0.5 * uPanelResolution.x) * uDotPitchMm;
    float viewAngleTan = (uWeaverPosMm.x - pixelMmX) / eyeZ;
    float trackedShiftCycles = (uDoN * viewAngleTan) / max(0.01, uPx * uDotPitchMm);
    float invPx = 1.0 / max(0.1, uPx + uPitchAdjust);
    vec3 subpixelX = vec3(physX, physX + 0.3333333, physX + 0.6666667);
    phase = (subpixelX + physYTopDown * (uSlant + uSlantAdjust)) * invPx + trackedShiftCycles + uPhaseOffset;
  }

  // Crosstalk pre-compensation: push each view away from the other one
  vec3 dRL = rightView - leftView;
  float xt = clamp(dynamicXTalk, 0.0, 0.25) / max(0.01, 1.0 - dynamicXTalk);
  vec3 Lp = leftView - xt * dRL;
  vec3 Rp = rightView + xt * dRL;

  // View selection per subpixel: w = share of the LEFT eye view, a trapezoid over the lens cycle
  vec3 outc;
  for (int c = 0; c < 3; c++) {
    float p = fract(phase[c] + 0.25);
    float t = 2.0 * p - 1.0;
    float w = clamp(-abs(t) * uViewFilterSlope + uViewFilterSlope * 0.5 + 0.5, 0.0, 1.0);
    outc[c] = mix(Rp[c], Lp[c], w);
  }

  gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}
`;

export class StereoComposer {
  private leftTarget: WebGLRenderTarget;
  private rightTarget: WebGLRenderTarget;
  private calibTex0: DataTexture;
  private calibTex1: DataTexture;
  private readonly quadScene = new Scene();
  private readonly quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: ShaderMaterial;
  private readonly quad: Mesh<PlaneGeometry, ShaderMaterial>;

  private targetW = 0;
  private targetH = 0;
  private readonly scratchSize = new Vector2();

  constructor() {
    this.leftTarget = this.createTarget(1920, 1080);
    this.rightTarget = this.createTarget(1920, 1080);
    // Default neutral calibration LUTs (94/255 and 128/255) until /calibration binary arrives
    this.calibTex0 = this.createSingleChannelLut(new Uint8Array([94, 94, 94, 94]), 2, 2);
    this.calibTex1 = this.createSingleChannelLut(new Uint8Array([128, 128, 128, 128]), 2, 2);

    this.material = new ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uLeftTex: new Uniform(this.leftTarget.texture),
        uRightTex: new Uniform(this.rightTarget.texture),
        uCalibTex0: new Uniform(this.calibTex0),
        uCalibTex1: new Uniform(this.calibTex1),
        uMode: new Uniform(0),
        uUseCalibCorners: new Uniform(1),
        uA2TL: new Uniform(8763.014648),
        uA2TR: new Uniform(10890.018555),
        uA2BL: new Uniform(9109.266602),
        uA2BR: new Uniform(11236.270508),
        uA35TL: new Uniform(new Vector4(0.037451, -0.104417, 0.050618, 0.009606)),
        uA35TR: new Uniform(new Vector4(-0.037432, -0.104417, -0.473445, -0.08985)),
        uA35BL: new Uniform(new Vector4(0.037451, -0.146538, -0.034694, -0.006584)),
        uA35BR: new Uniform(new Vector4(-0.037432, -0.146538, -0.558757, -0.10604)),
        uDPhaseDx: new Uniform(0.55390727),
        uPitchAdjust: new Uniform(0.0),
        uSlantAdjust: new Uniform(0.0),
        uResolution: new Uniform(new Vector2(3840, 2160)),
        uPanelResolution: new Uniform(new Vector2(3840, 2160)),
        uWindowOrigin: new Uniform(new Vector2(0, 0)),
        uWeaverPosMm: new Uniform(new Vector3(0, 100, 600)),
        uDotPitchMm: new Uniform(0.1554),
        uPx: new Uniform(1.8),
        uSlant: new Uniform(0.29),
        uDoN: new Uniform(1.5),
        uViewFilterSlope: new Uniform(10.0),
        uXTalkFactor: new Uniform(0.012854),
        uPhaseOffset: new Uniform(0.0),
        uTestPattern: new Uniform(0),
      },
    });

    this.quad = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /**
   * Uploads the Samsung Odyssey G90XF's 480x270 factory optical calibration LUTs
   * (`LoadTexture(0)` and `LoadTexture(1)`) streamed from the SR bridge (`/calibration`).
   */
  setCalibrationTextures(tex0: Uint8Array, tex1: Uint8Array, width: number, height: number): void {
    this.calibTex0.dispose();
    this.calibTex1.dispose();
    this.calibTex0 = this.createSingleChannelLut(tex0, width, height);
    this.calibTex1 = this.createSingleChannelLut(tex1, width, height);
    this.material.uniforms['uCalibTex0']!.value = this.calibTex0;
    this.material.uniforms['uCalibTex1']!.value = this.calibTex1;
  }

  render(
    renderer: WebGLRenderer,
    scene: Scene,
    monoCamera: PerspectiveCamera,
    leftCamera: PerspectiveCamera,
    rightCamera: PerspectiveCamera,
    mode: StereoDisplayMode,
    weaverPosMm: readonly [number, number, number],
    display: OdysseyDisplayInfo,
    optics: OdysseyOpticsInfo,
    fineTuning: WeaveFineTuning,
    weaveCorners: OdysseyWeaveCorners | undefined,
    panelPx: { w: number; h: number },
    windowOriginPx: { x: number; y: number },
  ): void {
    const drawingBufferSize = renderer.getDrawingBufferSize(this.scratchSize);
    const bufW = Math.max(1, Math.round(drawingBufferSize.x));
    const bufH = Math.max(1, Math.round(drawingBufferSize.y));

    if (mode === 'mono' && !fineTuning.testPattern) {
      renderer.setRenderTarget(null);
      renderer.render(scene, monoCamera);
      return;
    }
    if (mode === 'mono') mode = 'weave';

    // For SBS, half horizontal resolution per eye is native; for Weave/Anaglyph, render at full resolution
    const eyeW = mode === 'sbs' ? Math.max(1, Math.round(bufW * 0.5)) : bufW;
    const eyeH = bufH;
    this.ensureTargetSize(eyeW, eyeH);

    // Render Left Eye
    renderer.setRenderTarget(this.leftTarget);
    renderer.clear();
    renderer.render(scene, leftCamera);

    // Render Right Eye
    renderer.setRenderTarget(this.rightTarget);
    renderer.clear();
    renderer.render(scene, rightCamera);

    // Composite to screen
    renderer.setRenderTarget(null);
    const prevToneMapping = renderer.toneMapping;
    renderer.toneMapping = NoToneMapping;

    // Panel size comes from the screen the window is actually on, never from the SR runtime
    // alone (it can describe a different panel when it has not identified the monitor).
    const panelW = panelPx.w || 3840;
    const panelH = panelPx.h || 2160;
    const u = this.material.uniforms;
    u['uLeftTex']!.value = this.leftTarget.texture;
    u['uRightTex']!.value = this.rightTarget.texture;
    u['uMode']!.value = mode === 'weave' ? 0 : mode === 'sbs' ? 1 : 2;
    (u['uResolution']!.value as Vector2).set(bufW, bufH);
    (u['uPanelResolution']!.value as Vector2).set(panelW, panelH);

    if (weaveCorners && weaveCorners.valid) {
      const a2Base = Math.floor(weaveCorners.tl[0]);
      u['uUseCalibCorners']!.value = 1;
      u['uA2TL']!.value = weaveCorners.tl[0] - a2Base;
      u['uA2TR']!.value = weaveCorners.tr[0] - a2Base;
      u['uA2BL']!.value = weaveCorners.bl[0] - a2Base;
      u['uA2BR']!.value = weaveCorners.br[0] - a2Base;
      (u['uA35TL']!.value as Vector4).set(
        weaveCorners.tl[1],
        weaveCorners.tl[2],
        weaveCorners.tl[3],
        weaveCorners.tl[4],
      );
      (u['uA35TR']!.value as Vector4).set(
        weaveCorners.tr[1],
        weaveCorners.tr[2],
        weaveCorners.tr[3],
        weaveCorners.tr[4],
      );
      (u['uA35BL']!.value as Vector4).set(
        weaveCorners.bl[1],
        weaveCorners.bl[2],
        weaveCorners.bl[3],
        weaveCorners.bl[4],
      );
      (u['uA35BR']!.value as Vector4).set(
        weaveCorners.br[1],
        weaveCorners.br[2],
        weaveCorners.br[3],
        weaveCorners.br[4],
      );
      // d(phase)/dx per panel pixel: the lens term (a2) plus the view-dependent term (a5.x).
      u['uDPhaseDx']!.value =
        (weaveCorners.tr[0] - weaveCorners.tl[0] + (weaveCorners.tr[3] - weaveCorners.tl[3])) /
        Math.max(1.0, panelW);
    } else {
      u['uUseCalibCorners']!.value = 0;
    }

    (u['uWindowOrigin']!.value as Vector2).set(windowOriginPx.x, windowOriginPx.y);
    (u['uWeaverPosMm']!.value as Vector3).set(weaverPosMm[0], weaverPosMm[1], weaverPosMm[2]);
    u['uDotPitchMm']!.value = (display.dotPitchCm || 0.01554) * 10.0;
    u['uPx']!.value = optics.px || 1.8;
    u['uSlant']!.value = optics.slant || 0.29;
    u['uDoN']!.value = optics.doN || 1.5;
    u['uPitchAdjust']!.value = fineTuning.pitchAdjust;
    u['uSlantAdjust']!.value = fineTuning.slantAdjust;
    u['uViewFilterSlope']!.value = fineTuning.viewFilterSlope || optics.viewFilterSlope || 10.0;
    u['uXTalkFactor']!.value = fineTuning.xtalkFactor;
    u['uPhaseOffset']!.value = fineTuning.phaseOffset;
    u['uTestPattern']!.value = fineTuning.testPattern ? 1 : 0;

    renderer.render(this.quadScene, this.quadCamera);
    renderer.toneMapping = prevToneMapping;
  }

  dispose(): void {
    this.leftTarget.dispose();
    this.rightTarget.dispose();
    this.calibTex0.dispose();
    this.calibTex1.dispose();
    this.quad.geometry.dispose();
    this.material.dispose();
  }

  private createSingleChannelLut(gray: Uint8Array, width: number, height: number): DataTexture {
    const pixelCount = width * height;
    const rgba = new Uint8Array(pixelCount * 4);
    for (let i = 0; i < pixelCount; i += 1) {
      const v = gray[i] ?? 128;
      const base = i * 4;
      rgba[base] = v;
      rgba[base + 1] = v;
      rgba[base + 2] = v;
      rgba[base + 3] = 255;
    }
    const tex = new DataTexture(rgba, width, height, RGBAFormat, UnsignedByteType);
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
    tex.wrapS = ClampToEdgeWrapping;
    tex.wrapT = ClampToEdgeWrapping;
    tex.flipY = false; // Already flipped bottom-up by Dimenco::Weaver::LoadTexture(..., flipY=true)
    tex.needsUpdate = true;
    return tex;
  }

  private createTarget(width: number, height: number): WebGLRenderTarget {
    return new WebGLRenderTarget(width, height, {
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      format: RGBAFormat,
      type: UnsignedByteType,
      colorSpace: SRGBColorSpace,
      samples: 4,
      depthBuffer: true,
    });
  }

  private ensureTargetSize(w: number, h: number): void {
    if (this.targetW === w && this.targetH === h) return;
    this.targetW = w;
    this.targetH = h;
    this.leftTarget.setSize(w, h);
    this.rightTarget.setSize(w, h);
  }
}
