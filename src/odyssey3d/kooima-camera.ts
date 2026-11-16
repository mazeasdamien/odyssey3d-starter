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
 *   2. Real-time tracked eye positions `(leftEyeMm, rightEyeMm)` from `sr-bridge` are
 *      converted from physical screen-space millimeters (relative to the nominal viewing
 *      position `(0, +100 mm, +600 mm)`) into virtual camera-space meters, scaled by the
 *      world-to-screen ratio `worldPerPhysicalMeter = virtualScreenWidthM / displayWidthM`.
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
  /** Stereo baseline multiplier (0 = 2D mono, 1.0 = physical 1:1 IPD, up to 2.0). */
  stereoStrength: number;
  /** Shifts the zero-parallax convergence plane forward (-) or backward (+) in meters. */
  convergenceOffsetM: number;
  /** Scales head-tracking motion parallax (0 = fixed sweet-spot, 1.0 = 1:1 physical head tracking). */
  parallaxScale: number;
  /** Swaps Left and Right eye views if needed for phase calibration. */
  swapEyes: boolean;
}

export const DEFAULT_KOOIMA_TUNING: KooimaTuning = {
  stereoStrength: 0.40, // Doux et naturel (évite le dédoublement / diplopie sur écran 27" 4K)
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

  private readonly nominalEyeCenterM = new Vector3(0, 0.10, 0.60); // matches sr-bridge default eye (0, 100, 600) mm

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

    // Convert tracked left & right eyes from physical mm to head center + stereo baseline in meters
    const lxM = leftEyeMm[0] * 0.001;
    const lyM = leftEyeMm[1] * 0.001;
    const lzM = Math.max(0.25, leftEyeMm[2] * 0.001);

    const rxM = rightEyeMm[0] * 0.001;
    const ryM = rightEyeMm[1] * 0.001;
    const rzM = Math.max(0.25, rightEyeMm[2] * 0.001);

    // Cyclopean (mid-eye) position and inter-eye half-vector in physical meters
    const midX = 0.5 * (lxM + rxM);
    const midY = 0.5 * (lyM + ryM);
    const midZ = 0.5 * (lzM + rzM);

    // Inter-eye separation (IPD) scaled by stereoStrength
    const nominalIpdM = 0.063;
    const measuredIpdM = Math.hypot(rxM - lxM, ryM - lyM, rzM - lzM);
    const effectiveIpdM = measuredIpdM > 0.03 && measuredIpdM < 0.12 ? measuredIpdM : nominalIpdM;
    const ipdSign = tuning.swapEyes ? -1 : 1;

    const halfIpdX = 0.5 * effectiveIpdM * tuning.stereoStrength * ipdSign;
    const halfIpdY = 0.5 * (ryM - lyM) * tuning.stereoStrength * ipdSign;
    const halfIpdZ = 0.5 * (rzM - lzM) * tuning.stereoStrength * ipdSign;

    // Head displacement from nominal center (with soft damping on Z so camera stays in sweet convergence range)
    const headShiftX = (midX - this.nominalEyeCenterM.x) * tuning.parallaxScale;
    const headShiftY = (midY - this.nominalEyeCenterM.y) * tuning.parallaxScale;
    const headShiftZ = (midZ - this.nominalEyeCenterM.z) * tuning.parallaxScale * 0.35;

    // Keep camera near nominal convergence distance to preserve crisp, punchy stereo depth
    const nominalCameraZM = convergenceDist;
    const leftScreenX = (headShiftX - halfIpdX) * worldPerPhysM;
    const leftScreenY = (headShiftY - halfIpdY) * worldPerPhysM;
    const leftScreenZ = Math.max(0.20, nominalCameraZM + headShiftZ * worldPerPhysM - halfIpdZ);

    const rightScreenX = (headShiftX + halfIpdX) * worldPerPhysM;
    const rightScreenY = (headShiftY + halfIpdY) * worldPerPhysM;
    const rightScreenZ = Math.max(0.20, nominalCameraZM + headShiftZ * worldPerPhysM + halfIpdZ);

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
