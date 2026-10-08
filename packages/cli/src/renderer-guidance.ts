import type {ServiceDescriptor} from '@artblocks/abx-sdk';

type ManagedRender = NonNullable<ServiceDescriptor['render']>;

export function managedRendererConstraintNote(render: ManagedRender | null | undefined): string | null {
  if (!render?.attached || render.constraints?.hardwareAcceleration !== false) return null;
  const delay = render.constraints.maxCaptureDelayMs;
  return (
    `This managed renderer is CPU/headless: GPU/WebGL hardware acceleration is unavailable. ` +
    `Software-compatible projects can use render.captureDelay${delay !== undefined ? ` up to ${delay}ms` : ''}; ` +
    `projects that require GPU acceleration need a GPU-capable effects worker.`
  );
}

export function renderFailureGuidance(render: ManagedRender | null | undefined): string {
  const delay = render?.constraints?.maxCaptureDelayMs;
  const gpu = render?.constraints?.hardwareAcceleration === false
    ? ' This managed renderer explicitly has no GPU/WebGL hardware acceleration; use a GPU-capable effects worker if the project requires it.'
    : ' If the project requires GPU/WebGL hardware acceleration, use a GPU-capable effects worker.';
  return (
    `A missing or failed thumbnail can mean the page did not call abx.done(), capture needs more time` +
    `${delay !== undefined ? ` (render.captureDelay supports up to ${delay}ms here)` : ' (try a larger render.captureDelay)'}, or the browser could not render the project.` +
    gpu
  );
}
