/**
 * WAV / RF64 header construction and parsing
 * Uses 8-bit mono PCM at 44100 Hz
 */

import {
  WAV_SAMPLE_RATE, WAV_BITS_PER_SAMPLE, WAV_CHANNELS,
  RF64_THRESHOLD
} from './constants.js';

const BYTE_RATE = WAV_SAMPLE_RATE * WAV_CHANNELS * (WAV_BITS_PER_SAMPLE / 8);
const BLOCK_ALIGN = WAV_CHANNELS * (WAV_BITS_PER_SAMPLE / 8);

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Create standard RIFF WAV header (for data < 4GB)
 * @param {number} dataSize - Size of the data chunk payload
 * @returns {ArrayBuffer} 44-byte WAV header
 */
export function createWavHeader(dataSize) {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);  // file size - 8
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);                      // chunk size
  view.setUint16(20, 1, true);                        // PCM format
  view.setUint16(22, WAV_CHANNELS, true);
  view.setUint32(24, WAV_SAMPLE_RATE, true);
  view.setUint32(28, BYTE_RATE, true);
  view.setUint16(32, BLOCK_ALIGN, true);
  view.setUint16(34, WAV_BITS_PER_SAMPLE, true);

  // data chunk header
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  return buffer;
}

/**
 * Create RF64 header (for data >= 4GB)
 * @param {bigint} dataSize - Size of the data chunk payload
 * @returns {ArrayBuffer} 80-byte RF64 header
 */
export function createRF64Header(dataSize) {
  const buffer = new ArrayBuffer(80);
  const view = new DataView(buffer);

  const riffSize = BigInt(80 - 8) + dataSize;  // total - 8 for "RF64" + size field
  const sampleCount = dataSize / BigInt(BLOCK_ALIGN);

  // RF64 header
  writeString(view, 0, 'RF64');
  view.setUint32(4, 0xFFFFFFFF, true);
  writeString(view, 8, 'WAVE');

  // ds64 chunk
  writeString(view, 12, 'ds64');
  view.setUint32(16, 28, true);           // ds64 chunk size
  view.setBigUint64(20, riffSize, true);   // RIFF size
  view.setBigUint64(28, dataSize, true);   // data size
  view.setBigUint64(36, sampleCount, true);// sample count
  view.setUint32(44, 0, true);             // table length

  // fmt chunk
  writeString(view, 48, 'fmt ');
  view.setUint32(52, 16, true);
  view.setUint16(56, 1, true);
  view.setUint16(58, WAV_CHANNELS, true);
  view.setUint32(60, WAV_SAMPLE_RATE, true);
  view.setUint32(64, BYTE_RATE, true);
  view.setUint16(68, BLOCK_ALIGN, true);
  view.setUint16(70, WAV_BITS_PER_SAMPLE, true);

  // data chunk header
  writeString(view, 72, 'data');
  view.setUint32(76, 0xFFFFFFFF, true);

  return buffer;
}

/**
 * Build appropriate WAV header based on data size
 * @param {number|bigint} dataSize
 * @returns {ArrayBuffer}
 */
export function buildWavHeader(dataSize) {
  const size = typeof dataSize === 'bigint' ? dataSize : BigInt(dataSize);
  if (size > BigInt(RF64_THRESHOLD)) {
    return createRF64Header(size);
  }
  return createWavHeader(Number(size));
}

/**
 * Parse a WAV/RF64 file and extract the data chunk payload
 * @param {ArrayBuffer} buffer - Complete WAV file
 * @returns {{ data: Uint8Array, isRF64: boolean }}
 */
export function parseWav(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)
  );

  const isRF64 = magic === 'RF64';
  if (magic !== 'RIFF' && magic !== 'RF64') {
    throw new Error('Not a valid WAV file: invalid RIFF/RF64 header');
  }

  const wave = String.fromCharCode(
    view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)
  );
  if (wave !== 'WAVE') {
    throw new Error('Not a valid WAV file: missing WAVE identifier');
  }

  let ds64DataSize = null;
  let offset = 12;

  // Parse chunks to find 'data'
  while (offset < buffer.byteLength - 8) {
    const chunkId = String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1),
      view.getUint8(offset + 2), view.getUint8(offset + 3)
    );
    let chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 'ds64') {
      ds64DataSize = view.getBigUint64(offset + 8 + 8, true); // data size at offset+16
      offset += 8 + chunkSize;
      if (chunkSize % 2 !== 0) offset++; // pad byte
      continue;
    }

    if (chunkId === 'data') {
      let dataSize;
      if (isRF64 && chunkSize === 0xFFFFFFFF && ds64DataSize !== null) {
        dataSize = Number(ds64DataSize);
      } else {
        dataSize = chunkSize;
      }
      const dataStart = offset + 8;
      const actualSize = Math.min(dataSize, buffer.byteLength - dataStart);
      return {
        data: new Uint8Array(buffer, dataStart, actualSize),
        isRF64
      };
    }

    // Skip this chunk
    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset++; // pad byte
  }

  throw new Error('No data chunk found in WAV file');
}
