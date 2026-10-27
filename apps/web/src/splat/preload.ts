/** Warm the viewer module on 3D intent; imports are shared by the browser cache.
 * Leave GPU allocation and tile downloads to scene activation. */
export function preloadSplatViewer(): void {
  void import('./session').catch(() => { /* Activation retains the normal retry UI. */ });
}
