/**
 * Z2WAV Decoder
 * Reconstructs original file from one or more Z2WAV WAV files
 */

import { crc32 } from './crc32.js';
import {
  PART_MAGIC, FULL_MAGIC, FORMAT_VERSION,
  PART_HEADER_SIZE, FULL_HEADER_SIZE,
  FLAG_STORED
} from './constants.js';
import { parseWav } from './wav.js';

/**
 * Compare two Uint8Arrays
 */
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Read a string from bytes
 */
function readMagic(data, offset, length) {
  return Array.from(data.slice(offset, offset + length))
    .map(b => String.fromCharCode(b))
    .join('');
}

/**
 * Parse PART HEADER from data
 * @param {Uint8Array} data - Data starting at PART HEADER
 * @returns {Object} Parsed header fields
 */
function parsePartHeader(data) {
  if (data.length < PART_HEADER_SIZE) {
    throw new Error('Insufficient data for PART HEADER');
  }

  const magic = data.slice(0, 6);
  if (!bytesEqual(magic, PART_MAGIC)) {
    throw new Error('Invalid PART HEADER magic');
  }

  const view = new DataView(data.buffer, data.byteOffset, PART_HEADER_SIZE);

  return {
    version: view.getUint16(6, true),
    partIndex: view.getUint32(8, true),
    partTotal: view.getUint32(12, true),
    globalOffset: view.getBigUint64(16, true),
    partSize: view.getBigUint64(24, true),
    partSha256: new Uint8Array(data.slice(32, 64))
  };
}

/**
 * Parse FULL HEADER from data
 * @param {Uint8Array} data - Data starting at FULL HEADER
 * @returns {Object} Parsed header fields
 */
function parseFullHeader(data) {
  if (data.length < FULL_HEADER_SIZE) {
    throw new Error('Insufficient data for FULL HEADER');
  }

  const magic = data.slice(0, 6);
  if (!bytesEqual(magic, FULL_MAGIC)) {
    throw new Error('Invalid FULL HEADER magic');
  }

  const view = new DataView(data.buffer, data.byteOffset, FULL_HEADER_SIZE);

  return {
    version: view.getUint16(6, true),
    zipSize: view.getBigUint64(8, true),
    chunkCount: view.getBigUint64(16, true),
    sha256: new Uint8Array(data.slice(24, 56)),
    indexOffset: view.getBigUint64(56, true),
    flags: view.getBigUint64(64, true)
  };
}

/**
 * Parse chunks from data stream
 * @param {Uint8Array} data - Chunk stream
 * @param {number} maxChunks - Maximum number of chunks to parse (0 = unlimited)
 * @returns {{ chunks: Array<{ id: number, data: Uint8Array, crcValid: boolean }>, bytesConsumed: number }}
 */
function parseChunks(data, maxChunks = 0) {
  const chunks = [];
  let offset = 0;

  while (offset < data.length) {
    if (maxChunks > 0 && chunks.length >= maxChunks) break;

    // We need at least 12 bytes for a minimal chunk (id + size + crc with 0 data)
    if (offset + 12 > data.length) break;

    const view = new DataView(data.buffer, data.byteOffset + offset);
    const id = view.getUint32(0, true);
    const size = view.getUint32(4, true);

    // Sanity check
    if (offset + 8 + size + 4 > data.length) break;

    const chunkData = new Uint8Array(data.buffer, data.byteOffset + offset + 8, size);
    const storedCrc = view.getUint32(8 + size, true);
    const computedCrc = crc32(chunkData);
    const crcValid = storedCrc === computedCrc;

    chunks.push({ id, data: new Uint8Array(chunkData), crcValid });
    offset += 8 + size + 4;
  }

  return { chunks, bytesConsumed: offset };
}

/**
 * Parse INDEX from data
 * @param {Uint8Array} data - Index data
 * @returns {Array<{ chunkId: number, offset: bigint, size: number }>}
 */
function parseIndex(data) {
  if (data.length < 4) {
    throw new Error('Insufficient data for INDEX');
  }

  const view = new DataView(data.buffer, data.byteOffset);
  const entryCount = view.getUint32(0, true);
  const entries = [];

  for (let i = 0; i < entryCount; i++) {
    const off = 4 + i * 16;
    if (off + 16 > data.length) break;

    entries.push({
      chunkId: view.getUint32(off, true),
      offset: view.getBigUint64(off + 4, true),
      size: view.getUint32(off + 12, true)
    });
  }

  return entries;
}

/**
 * Verify part SHA-256
 * @param {Uint8Array} partHeader - Original PART HEADER
 * @param {Uint8Array} payload - All data after PART HEADER
 * @returns {Promise<boolean>}
 */
async function verifyPartSha256(partHeader, payload) {
  const storedHash = partHeader.slice(32, 64);

  // Zero the SHA field for computation
  const headerCopy = new Uint8Array(partHeader);
  headerCopy.fill(0, 32, 64);

  const combined = new Uint8Array(headerCopy.length + payload.length);
  combined.set(headerCopy, 0);
  combined.set(payload, headerCopy.length);

  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', combined));
  return bytesEqual(storedHash, hash);
}

/**
 * Decompress ZIP data to extract the original file
 * @param {Uint8Array} zipData - Complete ZIP stream
 * @param {bigint} flags - Flags from FULL HEADER
 * @returns {{ data: Uint8Array, filename: string }}
 */
function decompressZip(zipData, flags) {
  const view = new DataView(zipData.buffer, zipData.byteOffset);

  // Parse local file header
  const sig = view.getUint32(0, true);
  if (sig !== 0x04034b50) {
    throw new Error('Invalid ZIP local file header signature');
  }

  const gpFlags = view.getUint16(6, true);
  const method = view.getUint16(8, true);
  const filenameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);

  const filenameBytes = zipData.slice(30, 30 + filenameLen);
  const filename = new TextDecoder().decode(filenameBytes);

  const dataStart = 30 + filenameLen + extraLen;

  // Find where compressed data ends
  // If data descriptor flag is set, we need to find the descriptor
  let compressedEnd = dataStart;
  const hasDataDescriptor = (gpFlags & 0x0008) !== 0;

  if (hasDataDescriptor) {
    // Scan for data descriptor signature or central directory
    let pos = dataStart;
    while (pos < zipData.length - 4) {
      const maybeSig = view.getUint32(pos, true);
      if (maybeSig === 0x08074b50) {
        compressedEnd = pos;
        break;
      }
      // Also check for central directory signature as fallback
      if (maybeSig === 0x02014b50) {
        compressedEnd = pos;
        break;
      }
      pos++;
    }
    if (compressedEnd === dataStart) {
      compressedEnd = zipData.length; // fallback
    }
  } else {
    // Sizes are in the local header (or ZIP64 extra)
    let compSize = view.getUint32(18, true);
    if (compSize === 0xFFFFFFFF) {
      // Parse ZIP64 extra field
      let extraOff = 30 + filenameLen;
      const extraEnd = extraOff + extraLen;
      while (extraOff + 4 <= extraEnd) {
        const tag = view.getUint16(extraOff, true);
        const sz = view.getUint16(extraOff + 2, true);
        if (tag === 0x0001) {
          // ZIP64: first 8 bytes = uncompressed, next 8 = compressed
          if (sz >= 16) {
            compSize = Number(view.getBigUint64(extraOff + 4 + 8, true));
          }
          break;
        }
        extraOff += 4 + sz;
      }
    }
    compressedEnd = dataStart + compSize;
  }

  const compressedData = zipData.slice(dataStart, compressedEnd);

  let decompressed;
  if (method === 0) {
    // STORED
    decompressed = compressedData;
  } else if (method === 8) {
    // DEFLATE
    decompressed = pako.inflateRaw(compressedData);
  } else {
    throw new Error(`Unsupported compression method: ${method}`);
  }

  return { data: decompressed, filename };
}

/**
 * Decode Z2WAV files back to original file
 *
 * @param {File[]} wavFiles - One or more WAV files containing Z2WAV data
 * @param {Object} options
 * @param {function} options.onProgress - Progress callback
 * @param {boolean} options.strictCrc - Fail on CRC mismatch (default: false)
 * @returns {Promise<{ data: Uint8Array, filename: string, verified: boolean, warnings: string[] }>}
 */
export async function decode(wavFiles, options = {}) {
  const { onProgress = null, strictCrc = false } = options;
  const warnings = [];

  if (onProgress) onProgress({ phase: 'parse', progress: 0 });

  // Step 1: Parse all parts
  const parts = [];

  for (let i = 0; i < wavFiles.length; i++) {
    const buffer = await wavFiles[i].arrayBuffer();
    const { data } = parseWav(buffer);

    // Parse PART HEADER
    const partHeader = parsePartHeader(data);

    let offset = PART_HEADER_SIZE;
    let fullHeader = null;

    // Parse FULL HEADER if first part
    if (partHeader.partIndex === 0) {
      fullHeader = parseFullHeader(data.slice(offset));
      offset += FULL_HEADER_SIZE;
    }

    // The remaining data contains chunks (and possibly INDEX for last part)
    const remainingData = data.slice(offset);

    // Verify part SHA-256
    const partHeaderRaw = data.slice(0, PART_HEADER_SIZE);
    const partPayload = data.slice(PART_HEADER_SIZE);
    const partValid = await verifyPartSha256(partHeaderRaw, partPayload);

    if (!partValid) {
      warnings.push(`Part ${partHeader.partIndex}: SHA-256 verification failed`);
    }

    parts.push({
      partHeader,
      fullHeader,
      payload: remainingData,
      partHeaderRaw: data.slice(0, PART_HEADER_SIZE)
    });

    if (onProgress) onProgress({ phase: 'parse', progress: (i + 1) / wavFiles.length });
  }

  // Step 2: Sort parts by partIndex
  parts.sort((a, b) => a.partHeader.partIndex - b.partHeader.partIndex);

  // Validate part completeness
  const expectedTotal = parts[0].partHeader.partTotal;
  if (parts.length !== expectedTotal) {
    throw new Error(`Expected ${expectedTotal} parts, got ${parts.length}`);
  }

  for (let i = 0; i < parts.length; i++) {
    if (parts[i].partHeader.partIndex !== i) {
      throw new Error(`Missing part ${i}`);
    }
  }

  // Step 3: Get FULL HEADER from first part
  const fullHeader = parts[0].fullHeader;
  if (!fullHeader) {
    throw new Error('First part missing FULL HEADER');
  }

  if (onProgress) onProgress({ phase: 'chunks', progress: 0 });

  // Step 4: Extract and verify chunks from all parts
  const allChunks = [];
  const isStored = fullHeader.flags === 1n;
  const expectedChunkCount = Number(fullHeader.chunkCount);
  let chunksRemaining = expectedChunkCount;

  for (let p = 0; p < parts.length; p++) {
    const payload = parts[p].payload;

    // Limit chunk parsing to expected remaining count
    const { chunks } = parseChunks(payload, chunksRemaining);
    chunksRemaining -= chunks.length;

    for (const chunk of chunks) {
      if (!chunk.crcValid) {
        if (strictCrc) {
          throw new Error(`CRC mismatch in chunk ${chunk.id}`);
        }
        if (isStored) {
          // STORED mode: zero-fill corrupt data
          warnings.push(`Chunk ${chunk.id}: CRC mismatch, data zero-filled`);
          chunk.data.fill(0);
        } else {
          // DEFLATE mode: discard chunk
          warnings.push(`Chunk ${chunk.id}: CRC mismatch, chunk discarded`);
          continue;
        }
      }
      allChunks.push(chunk);
    }

    if (onProgress) onProgress({ phase: 'chunks', progress: (p + 1) / parts.length });
  }

  // Sort chunks by ID
  allChunks.sort((a, b) => a.id - b.id);

  if (onProgress) onProgress({ phase: 'decompress', progress: 0 });

  // Step 5: Reassemble ZIP stream
  let zipTotalSize = 0;
  for (const chunk of allChunks) {
    zipTotalSize += chunk.data.length;
  }

  const zipStream = new Uint8Array(zipTotalSize);
  let offset = 0;
  for (const chunk of allChunks) {
    zipStream.set(chunk.data, offset);
    offset += chunk.data.length;
  }

  if (onProgress) onProgress({ phase: 'decompress', progress: 0.5 });

  // Step 6: Decompress ZIP
  const { data: fileData, filename } = decompressZip(zipStream, fullHeader.flags);

  if (onProgress) onProgress({ phase: 'verify', progress: 0 });

  // Step 7: Verify file SHA-256
  const computedHash = new Uint8Array(await crypto.subtle.digest('SHA-256', fileData));
  const verified = bytesEqual(computedHash, fullHeader.sha256);

  if (!verified) {
    warnings.push('File SHA-256 verification failed - data may be corrupted or re-encoded');
  }

  if (onProgress) onProgress({ phase: 'verify', progress: 1 });

  return {
    data: fileData,
    filename,
    verified,
    warnings
  };
}
