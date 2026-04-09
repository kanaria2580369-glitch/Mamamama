/**
 * Browser/platform detection for Z2WAV
 * Determines output capabilities and recommended part sizes
 */

import { PART_SIZE_UNLIMITED, PART_SIZE_BLOB, PART_SIZE_IOS } from './constants.js';

/**
 * Detect current browser environment capabilities
 * @returns {{ isIOS: boolean, hasStreamingWrite: boolean, hasServiceWorker: boolean, maxPartSize: number, outputMethod: string, label: string }}
 */
export function detectEnvironment() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const hasStreamingWrite = typeof window.showSaveFilePicker === 'function';
  const hasServiceWorker = 'serviceWorker' in navigator;

  let maxPartSize, outputMethod, label;

  if (hasStreamingWrite && !isIOS) {
    maxPartSize = PART_SIZE_UNLIMITED;
    outputMethod = 'streaming';
    label = 'Streaming (File System Access API)';
  } else if (isIOS) {
    maxPartSize = PART_SIZE_IOS;
    outputMethod = 'blob';
    label = 'Blob (iOS - 256MB limit per part)';
  } else {
    maxPartSize = PART_SIZE_BLOB;
    outputMethod = 'blob';
    label = 'Blob (512MB limit per part)';
  }

  return {
    isIOS,
    hasStreamingWrite,
    hasServiceWorker,
    maxPartSize,
    outputMethod,
    label
  };
}
