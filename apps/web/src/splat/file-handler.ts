/** Download a model before native asset decoding, with progress and cancellation. */
export async function fetchSplatBlob(
  url: string,
  signal: AbortSignal,
  onProgress: (message: string, fraction?: number) => void,
): Promise<Blob> {
  // Fetch explicitly so HTTP errors, SPA fallback HTML and cancellation are handled
  // before the binary decoder is invoked. The runtime reads the resulting Blob.
  onProgress('Downloading city model…');
  const response = await fetch(url, { signal });
  if (!response.ok || response.headers.get('content-type')?.includes('text/html')) {
    throw new Error(`City model is unavailable (${response.status}).`);
  }
  const length = Number(response.headers.get('content-length'));
  const chunks: ArrayBuffer[] = [];
  const reader = response.body?.getReader();
  let loaded = 0;
  if (!reader) throw new Error('This browser cannot stream the city model.');
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value.slice().buffer);
      loaded += value.byteLength;
      onProgress(`Downloading city model… ${(loaded / 1048576).toFixed(1)} MB`, length > 0 ? Math.min(loaded / length, 1) : undefined);
    }
  } finally { reader.releaseLock(); }
  return new Blob(chunks);
}
