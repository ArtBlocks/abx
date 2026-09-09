/**
 * MIME-type inference from a file path: a pure extension-map lookup with no storage-backend
 * dependency, so it belongs
 * in the neutral layer every consumer (the storage package, the CLI, a third-party provider)
 * shares instead of each keeping its own copy or importing storage just for this.
 */

/** Best-effort MIME type from a file path — a *labeled* extension-map fallback (the data plane's
 *  declared-type rule permits it for locator forms; bytes are never sniffed). Unknown → the
 *  honest floor, `application/octet-stream`. */
export function contentTypeFromPath(path: string): string {
  const ext = path.toLowerCase().slice(path.lastIndexOf('.') + 1);
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    tiff: 'image/tiff',
    tif: 'image/tiff',
    psd: 'image/vnd.adobe.photoshop',
    mp4: 'video/mp4',
    webm: 'video/webm',
    html: 'text/html; charset=utf-8',
    json: 'application/json',
    glb: 'model/gltf-binary',
    gltf: 'model/gltf+json',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    zip: 'application/zip',
  };
  return map[ext] ?? 'application/octet-stream';
}
