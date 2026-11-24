// SPDX-License-Identifier: AGPL-3.0-only
// In memory only. No previous place after a reload or a direct link.
const VIEWER = /^\/rooms\/[^/]+\/view\//;

let current: string | null = null;
let before: string | null = null;
let steps = 0;

export function isViewerPath(path: string): boolean {
  return VIEWER.test(path);
}

const pathOf = (url: string) => url.split(/[?#]/)[0]!;

export function notePlace(url: string): void {
  if (url === current) return;
  if (isViewerPath(pathOf(url))) {
    if (current && !isViewerPath(pathOf(current))) {
      before = current;
      steps = 1;
    } else if (before) {
      steps += 1;
    }
  }
  current = url;
}

export function placeBeforeViewer(): { url: string; oneStepBack: boolean } | null {
  return before ? { url: before, oneStepBack: steps === 1 } : null;
}

export function resetPlaces(): void {
  current = null;
  before = null;
  steps = 0;
}
