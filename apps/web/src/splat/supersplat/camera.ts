import { Entity, EventHandler, PROJECTION_PERSPECTIVE, Vec3, type BoundingBox, type CameraComponent } from 'playcanvas';
import type { PCApp } from './pc-app';
import type { mapViewFrame } from '../mapViewFrame';
import { PointerController } from './controllers';

export interface SurfaceControls {
  pan(x: number, y: number, dx: number, dy: number): void;
  orbit(dx: number, dy: number): void;
  focus(x: number, y: number): void;
  constrainElevation(elevation: number): number;
  reset(): void;
}

/** Viewer adapter for SuperSplat's PointerController and azimuth/elevation convention. */
export class Camera {
  readonly mainCamera: Entity;
  readonly controller: PointerController;
  readonly scene: { app: PCApp; events: EventHandler; config: { controls: { orbitSensitivity: number; zoomSensitivity: number } } };
  readonly focalPoint = new Vec3();
  readonly distanceTween = { value: { distance: 1 } };
  sceneRadius = 1;
  azim = 0;
  elevation = -30;
  controlMode: 'orbit' | 'fly' = 'orbit';
  flySpeed = 1;
  maxDistance = 1000;
  minDistance = .005;
  zoomFloor = .001;
  readonly ortho = false;
  surfaceControls?: SurfaceControls;
  private framing: BoundingBox | undefined;
  private dirty = true;
  private entryFrame: ReturnType<typeof mapViewFrame> | undefined;

  constructor(app: PCApp, canvas: HTMLCanvasElement) {
    this.mainCamera = new Entity('SuperSplat viewer camera', app);
    this.mainCamera.addComponent('camera', { projection: PROJECTION_PERSPECTIVE, fov: 50, nearClip: 0.1, farClip: 10000, clearColor: [0.025, 0.035, 0.05, 1] });
    app.root.addChild(this.mainCamera);
    this.scene = { app, events: new EventHandler(), config: { controls: { orbitSensitivity: 0.2, zoomSensitivity: 0.3 } } };
    this.scene.events.on('camera.setControlMode', (mode: 'orbit' | 'fly') => { this.controlMode = mode; });
    this.controller = new PointerController(this, canvas);
  }
  get camera(): CameraComponent { return this.mainCamera.camera!; }
  get distance(): number { return this.distanceTween.value.distance; }
  get fovFactor(): number { return Math.sin(this.camera.fov * Math.PI / 360); }
  get worldTransform() { return this.mainCamera.getWorldTransform(); }
  setAzimElev(azim: number, elevation: number): void {
    this.azim = azim;
    this.elevation = this.surfaceControls?.constrainElevation(elevation) ?? Math.max(-90, Math.min(89, elevation));
    this.dirty = true;
    this.update(0);
  }
  setDistance(distance: number, _damping = 1): void {
    this.distanceTween.value.distance = Math.max((this.minDistance ?? .005) * this.fovFactor, Math.min((this.maxDistance ?? 1000) * this.fovFactor, distance));
    if (this.surfaceControls) this.elevation = this.surfaceControls.constrainElevation(this.elevation);
    this.dirty = true;
    this.update(0);
  }
  setFocalPoint(point: Vec3): void { this.focalPoint.copy(point); this.dirty = true; this.update(0); }
  look(dx: number, dy: number): void {
    const position = this.mainCamera.getPosition().clone();
    this.setAzimElev(this.azim - dx * 0.2, this.elevation - dy * 0.2);
    const offset = this.mainCamera.getPosition().clone().sub(this.focalPoint);
    this.setFocalPoint(position.sub(offset));
  }
  pickFocalPoint(x: number, y: number): void {
    if (this.surfaceControls) { this.surfaceControls.focus(x, y); return; }
    // Focus on the model's horizontal ground plane; no editor picking passes are installed.
    const canvas = this.scene.app.graphicsDevice.canvas as HTMLCanvasElement;
    const point = this.camera.screenToWorld(x * canvas.clientWidth, y * canvas.clientHeight, 1);
    const origin = this.ortho
      ? this.camera.screenToWorld(x * canvas.clientWidth, y * canvas.clientHeight, 0)
      : this.mainCamera.getPosition();
    const direction = point.sub(origin).normalize();
    const t = (this.focalPoint.y - origin.y) / direction.y;
    if (Number.isFinite(t) && t > 0) this.setFocalPoint(origin.clone().add(direction.mulScalar(t)));
  }
  frame(bounds: BoundingBox, entryFrame: ReturnType<typeof mapViewFrame>): void {
    this.framing = bounds.clone(); this.entryFrame = entryFrame; this.reset();
  }
  reset(): void {
    if (!this.framing || !this.entryFrame) return;
    this.controlMode = 'orbit';
    this.sceneRadius = Math.max(1, this.framing.halfExtents.length(), this.entryFrame.halfHeight);
    this.flySpeed = this.sceneRadius * 0.2;
    this.camera.farClip = Math.max(1000, this.sceneRadius * 30);
    this.focalPoint.set(...this.entryFrame.focalPoint);
    this.azim = this.entryFrame.azimuth;
    this.elevation = this.entryFrame.elevation;
    this.distanceTween.value.distance = this.entryFrame.halfHeight / Math.tan(this.camera.fov * Math.PI / 360) * this.fovFactor / this.sceneRadius;
    this.surfaceControls?.reset();
    if (this.surfaceControls) this.elevation = this.surfaceControls.constrainElevation(this.elevation);
    this.dirty = true;
    this.update(0);
  }
  updateClipping(): void {
    const distance = this.distance * this.sceneRadius / this.fovFactor;
    this.camera.farClip = Math.max(1000, this.sceneRadius * 30, distance * 4);
    this.camera.nearClip = Math.max(0.1, distance / 100000);
  }
  update(delta: number): void {
    if (delta > 0) this.controller?.update(delta);
    if (!this.dirty) return;
    this.dirty = false;
    const az = -this.azim * Math.PI / 180;
    const el = -this.elevation * Math.PI / 180;
    const distance = this.distance * this.sceneRadius / this.fovFactor;
    this.updateClipping();
    this.mainCamera.setPosition(
      this.focalPoint.x - Math.cos(el) * Math.sin(az) * distance,
      this.focalPoint.y + Math.sin(el) * distance,
      this.focalPoint.z + Math.cos(el) * Math.cos(az) * distance,
    );
    this.mainCamera.lookAt(this.focalPoint, this.elevation === -90
      ? new Vec3(Math.sin(az), 0, -Math.cos(az)) : Vec3.UP);
  }
  destroy(): void { this.controller.destroy(); this.scene.events.off(); this.mainCamera.destroy(); }
}
