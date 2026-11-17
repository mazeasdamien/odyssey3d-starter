import { Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';

/**
 * Kooima Off-Axis Asymmetric Frustum Stereo Camera Rig for the Samsung Odyssey 3D (G90XF).
 *
 * Implements Robert Kooima's "Generalized Perspective Projection" (2009), mapping the
 * physical active display surface of the 27" Samsung Odyssey G90XF (0.5967 m x 0.3357 m)
 * onto the zero-parallax convergence plane of the scene.
 *
 * How it works:
 *   1. The main Orbit Camera (`baseCamera`) defines the center of the virtual screen window
 *      at distance `convergenceDist` along its look direction (typically the center of the
 *      scene, plus an adjustable `convergenceOffsetM`).
 *   2. Each tracked eye (physical metres, relative to the screen's centre) is placed in the
 *      virtual scene as that position times one factor, on all three axes: the factor that puts
 *      the nominal head (60 cm, centred) on the orbit camera. One factor for all three axes and
 *      both eyes is what keeps the scene fixed in space while the head moves.
 *   3. Each eye camera (`leftCamera`, `rightCamera`) is placed at its exact 3D offset in
 *      world space and given an asymmetric off-axis projection matrix (`makePerspective`)
 *      whose frustum edges pass strictly through the four corners of the virtual screen
 *      rectangle on the zero-parallax plane.
 *
 * Result:
 *   - Objects at the convergence plane have zero screen disparity (sit right at the glass).
 *   - Whatever is nearer than the convergence plane pops out in front of
 *     the monitor glass (negative disparity) with natural tracked head-motion parallax.
 *   - The rear of the cell extends comfortably behind the monitor glass (positive disparity).
 */

export interface KooimaTuning {
  /** Eye separation, 1 = the true one (stereo and head motion then agree). 0 = no stereo. */
  stereoStrength: number;
  /** Shifts the zero-parallax convergence plane forward (-) or backward (+) in meters. */
  convergenceOffsetM: number;
  /** Head motion, 1 = the physical head (the scene stays fixed in space). 0 = a fixed viewpoint. */
  parallaxScale: number;
  /** Swaps Left and Right eye views if needed for phase calibration. */
  swapEyes: boolean;
}

/** Where the head is expected: 60 cm in front of the screen's centre (the eye tracker's frame). */
const NOMINAL_EYE_DISTANCE_M = 0.6;
const NOMINAL_EYE_HEIGHT_M = 0.0;

export const DEFAULT_KOOIMA_TUNING: KooimaTuning = {
  // 1 = the true eye separation, the only value at which stereo and head motion agree on the depth.
  stereoStrength: 1.0,
  convergenceOffsetM: 0.0, // Plan de l'écran calé sur le centre de la scène
  parallaxScale: 1.0,
  swapEyes: false,
};

export class KooimaStereoRig {
  readonly leftCamera = new PerspectiveCamera(60, 16 / 9, 0.05, 25);
  readonly rightCamera = new PerspectiveCamera(60, 16 / 9, 0.05, 25);

  private readonly camPos = new Vector3();
  private readonly camQuat = new Quaternion();
  private readonly rightAxis = new Vector3();
  private readonly upAxis = new Vector3();
  private readonly backAxis = new Vector3();
  private readonly screenCenter = new Vector3();
  private readonly eyeWorld = new Vector3();


  /**
   * Updates `leftCamera` and `rightCamera` world transforms and off-axis projection
   * matrices for the current frame.
   */
  update(
    baseCamera: PerspectiveCamera,
    targetWorld: Vector3,
    leftEyeMm: readonly [number, number, number],
    rightEyeMm: readonly [number, number, number],
    displayWidthCm: number,
    displayHeightCm: number,
    tuning: KooimaTuning,
  ): void {
    baseCamera.updateMatrixWorld(true);
    baseCamera.getWorldPosition(this.camPos);
    baseCamera.getWorldQuaternion(this.camQuat);

    // Camera orthonormal basis in world space (+X right, +Y up, +Z out toward viewer)
    this.rightAxis.set(1, 0, 0).applyQuaternion(this.camQuat).normalize();
    this.upAxis.set(0, 1, 0).applyQuaternion(this.camQuat).normalize();
    this.backAxis.set(0, 0, 1).applyQuaternion(this.camQuat).normalize();

    const baseDist = Math.max(0.25, this.camPos.distanceTo(targetWorld));
    const convergenceDist = Math.max(0.25, baseDist + tuning.convergenceOffsetM);

    // Virtual screen rectangle at the zero-parallax convergence plane
    const fovRad = (baseCamera.fov * Math.PI) / 180;
    const virtualScreenHeightM = 2 * convergenceDist * Math.tan(fovRad * 0.5);
    const physAspect =
      displayWidthCm > 1 && displayHeightCm > 1
        ? displayWidthCm / displayHeightCm
        : baseCamera.aspect || 16 / 9;
    const virtualScreenWidthM = virtualScreenHeightM * physAspect;

    const physWidthM = Math.max(0.2, (displayWidthCm || 59.6736) * 0.01);
    const worldPerPhysM = virtualScreenWidthM / physWidthM;

    // Center of the virtual screen plane in world coordinates
    this.screenCenter
      .copy(this.camPos)
      .addScaledVector(this.backAxis, -convergenceDist);

    // ── The eyes: one scale for everything ──────────────────────────────────────────────────
    // For the scene to stay put behind the glass while the head moves, each virtual eye must be
    // the physical eye (relative to the screen's centre) times ONE factor, on all three axes, both
    // eyes alike. Then the rays of every head position through their screen points meet at the
    // same place: the scene is seen fixed in space, and moving the head looks around it. Different
    // scales per axis (or a reduced eye separation) make the scene turn with the head, and stereo
    // and head motion disagree on the depth.
    // The factor puts the nominal head position (60 cm, centred) exactly on the orbit camera, so
    // the 3D view frames the scene as the 2D view does.
    const k = convergenceDist / NOMINAL_EYE_DISTANCE_M;
    const toVirtual = (eyeMm: readonly [number, number, number]): [number, number, number] => {
      const x = eyeMm[0] * 0.001;
      const y = eyeMm[1] * 0.001;
      const z = Math.max(0.25, eyeMm[2] * 0.001);
      // parallaxScale < 1 pulls the head towards the nominal point (less look-around, at the cost
      // of the scene no longer being exactly fixed); 1 = the physical head.
      const p = tuning.parallaxScale;
      return [k * x * p, k * (NOMINAL_EYE_HEIGHT_M + (y - NOMINAL_EYE_HEIGHT_M) * p), k * (NOMINAL_EYE_DISTANCE_M + (z - NOMINAL_EYE_DISTANCE_M) * p)];
    };
    let left = toVirtual(leftEyeMm);
    let right = toVirtual(rightEyeMm);
    // A lost or implausible eye pair (IPD outside 3..12 cm): the mid-eye with a nominal IPD.
    const ipdPhys = Math.hypot(rightEyeMm[0] - leftEyeMm[0], rightEyeMm[1] - leftEyeMm[1], rightEyeMm[2] - leftEyeMm[2]) * 0.001;
    if (!(ipdPhys > 0.03 && ipdPhys < 0.12)) {
      const mid: [number, number, number] = [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2, (left[2] + right[2]) / 2];
      const half = 0.5 * 0.063 * k;
      left = [mid[0] - half, mid[1], mid[2]];
      right = [mid[0] + half, mid[1], mid[2]];
    }
    // stereoStrength scales the separation about the mid-eye: 1 = the true one (the scene is then
    // seen at a single, consistent depth); less flattens the stereo without flattening head motion.
    const mx = (left[0] + right[0]) / 2, my = (left[1] + right[1]) / 2, mz = (left[2] + right[2]) / 2;
    const sep = tuning.stereoStrength * (tuning.swapEyes ? -1 : 1);
    const leftScreenX = mx + (left[0] - mx) * sep;
    const leftScreenY = my + (left[1] - my) * sep;
    const leftScreenZ = Math.max(0.2, mz + (left[2] - mz) * sep);
    const rightScreenX = mx + (right[0] - mx) * sep;
    const rightScreenY = my + (right[1] - my) * sep;
    const rightScreenZ = Math.max(0.2, mz + (right[2] - mz) * sep);

    this.configureEyeCamera(
      this.leftCamera,
      leftScreenX,
      leftScreenY,
      leftScreenZ,
      virtualScreenWidthM,
      virtualScreenHeightM,
      baseCamera.near,
      baseCamera.far,
    );

    this.configureEyeCamera(
      this.rightCamera,
      rightScreenX,
      rightScreenY,
      rightScreenZ,
      virtualScreenWidthM,
      virtualScreenHeightM,
      baseCamera.near,
      baseCamera.far,
    );
  }

  private configureEyeCamera(
    eyeCam: PerspectiveCamera,
    eyeScreenX: number,
    eyeScreenY: number,
    eyeScreenZ: number,
    screenWidthM: number,
    screenHeightM: number,
    near: number,
    far: number,
  ): void {
    // Position the eye camera in world space relative to screenCenter
    this.eyeWorld
      .copy(this.screenCenter)
      .addScaledVector(this.rightAxis, eyeScreenX)
      .addScaledVector(this.upAxis, eyeScreenY)
      .addScaledVector(this.backAxis, eyeScreenZ);

    eyeCam.position.copy(this.eyeWorld);
    eyeCam.quaternion.copy(this.camQuat);
    eyeCam.updateMatrixWorld(true);

    // Kooima off-axis frustum bounds projected from screen plane (dist = eyeScreenZ) to near plane
    const halfW = screenWidthM * 0.5;
    const halfH = screenHeightM * 0.5;
    const nearOverDist = near / Math.max(0.05, eyeScreenZ);

    const left = (-halfW - eyeScreenX) * nearOverDist;
    const right = (halfW - eyeScreenX) * nearOverDist;
    const bottom = (-halfH - eyeScreenY) * nearOverDist;
    const top = (halfH - eyeScreenY) * nearOverDist;

    eyeCam.projectionMatrix.makePerspective(left, right, top, bottom, near, far);
    eyeCam.projectionMatrixInverse.copy(eyeCam.projectionMatrix).invert();
  }
}
