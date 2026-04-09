/**
 * Z2WAV Encoder
 * Converts an arbitrary file into one or more WAV files containing Z2WAV data
 */

import { crc32 } from './crc32.js';
import {
  PART_MAGIC, FULL_MAGIC, FORMAT_VERSION,
  PART_HEADER_SIZE, FULL_HEADER_SIZE,
  DEFAULT_CHUNK_DATA_SIZE, CHUNK_OVERHEAD,
  FLAG_DEFLATE, FLAG_STORED
} from './constants.js';
import { buildZipStream } from './zip-stream.js';
import { buildWavHeader } from './wav.js';

/**
 * Create a PART HEADER (64 bytes)
 * SHA-256 field is initially zeroed (filled after computing hash)
 */
function createPartHeader(partIndex, partTotal, globalOffset, partSize) {
  const buf = new ArrayBuffer(PART_HEADER_SIZE);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  bytes.set(PART_MAGIC, 0);                                  // "Z2WAVP"
  view.setUint16(6, FORMAT_VERSION, true);                    // version
  view.setUint32(8, partIndex, true);                         // part_index
  view.setUint32(12, partTotal, true);                        // part_total
  view.setBigUint64(16, BigInt(globalOffset), true);          // global_offset
  view.setBigUint64(24, BigInt(partSize), true);              // part_size
  // bytes 32..63: part_SHA256 = zeroed (filled later)

  return bytes;
}

/**
 * Create a FULL HEADER (72 bytes)
 */
function createFullHeader(zipSize, chunkCount, sha256Hash, indexOffset, flags) {
  const buf = new ArrayBuffer(FULL_HEADER_SIZE);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  bytes.set(FULL_MAGIC, 0);                                  // "Z2WAV1"
  view.setUint16(6, FORMAT_VERSION, true);                    // version
  view.setBigUint64(8, BigInt(zipSize), true);                // ZIP size
  view.setBigUint64(16, BigInt(chunkCount), true);            // chunk count
  bytes.set(sha256Hash, 24);                                  // SHA-256
  view.setBigUint64(56, BigInt(indexOffset), true);           // INDEX offset
  view.setBigUint64(64, flags, true);                         // flags

  return bytes;
}

/**
 * Build a CHUNK record
 * @param {number} id - Chunk ID
 * @param {Uint8Array} data - Chunk data
 * @returns {Uint8Array} Complete chunk (id + size + data + crc32)
 */
function buildChunk(id, data) {
  const total = CHUNK_OVERHEAD + data.length;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  view.setUint32(0, id, true);
  view.setUint32(4, data.length, true);
  bytes.set(data, 8);
  view.setUint32(8 + data.length, crc32(data), true);

  return bytes;
}

/**
 * Build the INDEX block
 * @param {Array<{id: number, offset: number, size: number}>} entries
 * @returns {Uint8Array}
 */
function buildIndex(entries) {
  const size = 4 + entries.length * 16;
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);

  view.setUint32(0, entries.length, true);

  for (let i = 0; i < entries.length; i++) {
    const off = 4 + i * 16;
    view.setUint32(off, entries[i].id, true);
    view.setBigUint64(off + 4, BigInt(entries[i].offset), true);
    view.setUint32(off + 12, entries[i].size, true);
  }

  return new Uint8Array(buf);
}

/**
 * Compute SHA-256 of data using Web Crypto API
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>} 32-byte hash
 */
async function sha256(data) {
  const hash = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hash);
}

/**
 * Compute SHA-256 of a File object by reading in chunks
 * @param {File} file
 * @param {function} onProgress
 * @returns {Promise<Uint8Array>}
 */
async function sha256File(file, onProgress) {
  // For files that fit in memory, use simple approach
  // For larger files, we'd need incremental hashing which Web Crypto doesn't natively support
  // We'll read the file in one go for now (Web Crypto digest requires complete data)
  // For very large files, a WASM-based incremental SHA-256 would be better

  const SLICE = 64 * 1024 * 1024; // 64MB slices for progress reporting
  if (file.size <= SLICE) {
    const buf = await file.arrayBuffer();
    return sha256(new Uint8Array(buf));
  }

  // Incremental SHA-256 using SubtleCrypto is not available
  // Fall back to reading entire file
  if (onProgress) onProgress(0, file.size, 'Hashing file...');
  const buf = await file.arrayBuffer();
  if (onProgress) onProgress(file.size, file.size, 'Hashing file...');
  return sha256(new Uint8Array(buf));
}

/**
 * Compute part SHA-256: hash of (PART_HEADER with SHA field zeroed) + all subsequent data
 * @param {Uint8Array} partHeader - PART_HEADER (64 bytes, SHA field already zeroed)
 * @param {Uint8Array[]} dataBlocks - All data blocks after the header
 * @returns {Promise<Uint8Array>}
 */
async function computePartSha256(partHeader, dataBlocks) {
  let totalSize = partHeader.length;
  for (const block of dataBlocks) totalSize += block.length;

  const combined = new Uint8Array(totalSize);
  let offset = 0;
  combined.set(partHeader, offset);
  offset += partHeader.length;
  for (const block of dataBlocks) {
    combined.set(block, offset);
    offset += block.length;
  }

  return sha256(combined);
}

/**
 * Encode a file into Z2WAV format
 *
 * @param {File} file - Input file
 * @param {Object} options
 * @param {number} options.maxPartSize - Maximum part size (0 = unlimited)
 * @param {number} options.chunkDataSize - Chunk data size (default 4MB)
 * @param {boolean} options.useDeflate - Use DEFLATE compression (default true)
 * @param {function} options.onProgress - Progress callback
 * @returns {AsyncGenerator<{ partIndex: number, partTotal: number, wavData: Uint8Array, filename: string }>}
 */
export async function* encode(file, options = {}) {
  const {
    maxPartSize = 0,
    chunkDataSize = DEFAULT_CHUNK_DATA_SIZE,
    useDeflate = true,
    onProgress = null
  } = options;

  if (onProgress) onProgress({ phase: 'hash', progress: 0 });

  // Step 1: Compute SHA-256 of original file
  const fileSha256 = await sha256File(file, (read, total) => {
    if (onProgress) onProgress({ phase: 'hash', progress: read / total });
  });

  if (onProgress) onProgress({ phase: 'compress', progress: 0 });

  // Step 2: Generate ZIP stream and collect chunks
  const allChunks = [];     // Array of { id, data: Uint8Array }
  const indexEntries = [];  // For INDEX
  let chunkId = 0;
  let zipTotalSize = 0;
  let currentChunkBuffer = [];
  let currentChunkSize = 0;

  function flushChunkBuffer() {
    if (currentChunkSize === 0) return;

    let data;
    if (currentChunkBuffer.length === 1) {
      data = currentChunkBuffer[0];
    } else {
      data = new Uint8Array(currentChunkSize);
      let off = 0;
      for (const piece of currentChunkBuffer) {
        data.set(piece, off);
        off += piece.length;
      }
    }

    const chunk = buildChunk(chunkId, data);
    allChunks.push({ id: chunkId, raw: chunk, dataSize: data.length });
    chunkId++;
    currentChunkBuffer = [];
    currentChunkSize = 0;
  }

  for await (const segment of buildZipStream(file, chunkDataSize, useDeflate, (read, total) => {
    if (onProgress) onProgress({ phase: 'compress', progress: read / total });
  })) {
    zipTotalSize += segment.data.length;

    // Accumulate into current chunk, flushing at chunkDataSize boundary
    let remaining = segment.data;

    while (remaining.length > 0) {
      const space = chunkDataSize - currentChunkSize;
      if (remaining.length <= space) {
        currentChunkBuffer.push(remaining);
        currentChunkSize += remaining.length;
        remaining = new Uint8Array(0);
      } else {
        currentChunkBuffer.push(remaining.slice(0, space));
        currentChunkSize += space;
        remaining = remaining.slice(space);
        flushChunkBuffer();
      }
    }

    // Flush on segment boundary from ZIP stream (DEFLATE flush points)
    if (segment.isLast || currentChunkSize >= chunkDataSize) {
      flushChunkBuffer();
    }
  }

  // Flush any remaining data
  flushChunkBuffer();

  const totalChunks = allChunks.length;

  // Step 3: Build INDEX entries (offsets are relative to start of chunk data stream)
  let chunkStreamOffset = 0;
  for (const chunk of allChunks) {
    indexEntries.push({
      id: chunk.id,
      offset: chunkStreamOffset,
      size: chunk.raw.length
    });
    chunkStreamOffset += chunk.raw.length;
  }

  const indexData = buildIndex(indexEntries);

  // Step 4: Determine partitioning
  // Calculate total data payload size (FULL_HEADER + all chunks + INDEX)
  const fullHeaderSize = FULL_HEADER_SIZE;
  let totalPayloadSize = fullHeaderSize;
  for (const chunk of allChunks) {
    totalPayloadSize += chunk.raw.length;
  }
  totalPayloadSize += indexData.length;

  let partTotal = 1;
  let partChunkAssignments = [{ start: 0, end: allChunks.length }];

  if (maxPartSize > 0) {
    // Calculate how to split chunks across parts
    partChunkAssignments = [];
    let currentPartSize = PART_HEADER_SIZE + fullHeaderSize; // First part has FULL HEADER
    let partStart = 0;

    for (let i = 0; i < allChunks.length; i++) {
      const chunkSize = allChunks[i].raw.length;

      // Check if adding this chunk exceeds limit
      if (currentPartSize + chunkSize > maxPartSize && i > partStart) {
        partChunkAssignments.push({ start: partStart, end: i });
        partStart = i;
        currentPartSize = PART_HEADER_SIZE; // Non-first parts only have PART HEADER
      }

      currentPartSize += chunkSize;

      // For the last part, also account for INDEX
      if (i === allChunks.length - 1) {
        currentPartSize += indexData.length;
      }
    }

    // Handle remaining
    if (partStart < allChunks.length) {
      partChunkAssignments.push({ start: partStart, end: allChunks.length });
    }

    partTotal = partChunkAssignments.length;
  }

  // Calculate INDEX global offset
  let indexGlobalOffset = 0;
  for (const chunk of allChunks) {
    indexGlobalOffset += chunk.raw.length;
  }
  // Add FULL HEADER size and PART HEADER sizes
  indexGlobalOffset += fullHeaderSize;
  indexGlobalOffset += PART_HEADER_SIZE * partTotal;

  const flags = useDeflate ? FLAG_DEFLATE : FLAG_STORED;
  const fullHeader = createFullHeader(zipTotalSize, totalChunks, fileSha256, indexGlobalOffset, flags);

  // Step 5: Generate WAV parts
  if (onProgress) onProgress({ phase: 'output', progress: 0 });

  let globalOffset = 0;

  for (let p = 0; p < partTotal; p++) {
    const assignment = partChunkAssignments[p];
    const isFirst = p === 0;
    const isLast = p === partTotal - 1;

    // Collect data blocks for this part
    const dataBlocks = [];

    if (isFirst) {
      dataBlocks.push(fullHeader);
    }

    for (let i = assignment.start; i < assignment.end; i++) {
      dataBlocks.push(allChunks[i].raw);
    }

    if (isLast) {
      dataBlocks.push(indexData);
    }

    // Calculate part data size
    let partDataSize = 0;
    for (const block of dataBlocks) partDataSize += block.length;

    // Create PART HEADER (SHA field zeroed initially)
    const partHeader = createPartHeader(p, partTotal, globalOffset, partDataSize);

    // Compute part SHA-256
    const partSha = await computePartSha256(partHeader, dataBlocks);
    partHeader.set(partSha, 32); // Fill SHA-256 field

    // Total WAV data = PART HEADER + data blocks
    const wavDataSize = PART_HEADER_SIZE + partDataSize;

    // Build WAV header
    const wavHeader = buildWavHeader(wavDataSize);
    const wavHeaderBytes = new Uint8Array(wavHeader);

    // Assemble complete WAV file
    const totalWavSize = wavHeaderBytes.length + wavDataSize;
    const wavFile = new Uint8Array(totalWavSize);
    let offset = 0;

    wavFile.set(wavHeaderBytes, offset);
    offset += wavHeaderBytes.length;

    wavFile.set(partHeader, offset);
    offset += PART_HEADER_SIZE;

    for (const block of dataBlocks) {
      wavFile.set(block, offset);
      offset += block.length;
    }

    // Generate filename
    let filename;
    const baseName = file.name.replace(/\.[^.]+$/, '');
    if (partTotal === 1) {
      filename = `${baseName}.z2wav.wav`;
    } else {
      const partNum = String(p + 1).padStart(String(partTotal).length, '0');
      filename = `${baseName}.z2wav.part${partNum}of${partTotal}.wav`;
    }

    globalOffset += wavDataSize;

    if (onProgress) onProgress({ phase: 'output', progress: (p + 1) / partTotal });

    yield {
      partIndex: p,
      partTotal,
      wavData: wavFile,
      filename
    };
  }
}
