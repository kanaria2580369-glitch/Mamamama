/**
 * File I/O abstraction for Z2WAV
 * Handles streaming output (File System Access API) and blob fallback
 */

import { detectEnvironment } from './environment.js';

/**
 * Download data as a file using Blob + <a download>
 * @param {Uint8Array} data
 * @param {string} filename
 */
export function downloadBlob(data, filename) {
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Download data using File System Access API (streaming)
 * @param {Uint8Array} data
 * @param {string} filename
 * @returns {Promise<boolean>} true if successful, false if user cancelled
 */
export async function downloadStreaming(data, filename) {
  try {
    const ext = filename.endsWith('.wav') ? '.wav' : '';
    const handle = await window.showSaveFilePicker({
      suggestedName: filename,
      types: [{
        description: 'WAV Audio File',
        accept: { 'audio/wav': ['.wav'] }
      }]
    });

    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
    return true;
  } catch (err) {
    if (err.name === 'AbortError') {
      return false; // User cancelled
    }
    throw err;
  }
}

/**
 * Download a WAV file using the best available method
 * @param {Uint8Array} data
 * @param {string} filename
 * @param {string} method - 'streaming' or 'blob'
 */
export async function downloadFile(data, filename, method = null) {
  if (!method) {
    const env = detectEnvironment();
    method = env.outputMethod;
  }

  if (method === 'streaming') {
    const ok = await downloadStreaming(data, filename);
    if (!ok) {
      // User cancelled streaming, fall back to blob
      downloadBlob(data, filename);
    }
  } else {
    downloadBlob(data, filename);
  }
}

/**
 * Read files from a drop event or file input
 * @param {DataTransfer|FileList} source
 * @param {string} accept - File extension filter (e.g., '.wav')
 * @returns {File[]}
 */
export function getFiles(source) {
  const files = [];
  if (source instanceof DataTransfer) {
    for (const item of source.items) {
      if (item.kind === 'file') {
        files.push(item.getAsFile());
      }
    }
  } else if (source instanceof FileList) {
    for (const file of source) {
      files.push(file);
    }
  }
  return files;
}
