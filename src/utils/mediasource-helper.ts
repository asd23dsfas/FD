/**
 * MediaSource helper
 */

export function getMediaSource(): typeof MediaSource | undefined {
  if (typeof self === 'undefined') return undefined;
  return (
    ((self as any).ManagedMediaSource as typeof MediaSource) ||
    self.MediaSource ||
    ((self as any).WebKitMediaSource as typeof MediaSource)
  );
}
