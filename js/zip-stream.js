/**
 * ZIP64 stream builder
 * Produces a valid ZIP64 archive with DEFLATE (Z_FULL_FLUSH at chunk boundaries) or STORED
 *
 * Uses pako for DEFLATE compression (loaded globally via script tag)
 */

import { crc32, crc32Update } from './crc32.js';
import {
  ZIP_LOCAL_FILE_SIG, ZIP_DATA_DESC_SIG, ZIP_CENTRAL_DIR_SIG,
  ZIP_EOCD_SIG, ZIP64_EOCD_SIG, ZIP64_LOCATOR_SIG,
  ZIP64_EXTRA_TAG, ZIP_VERSION_NEEDED, ZIP_DEFLATE, ZIP_STORED
} from './constants.js';

/**
 * Encode a string as UTF-8 bytes
 */
function encodeFilename(name) {
  return new TextEncoder().encode(name);
}

/**
 * Get DOS date/time from a Date object
 */
function dosDateTime(date) {
  const time = ((date.getHours() & 0x1F) << 11) |
               ((date.getMinutes() & 0x3F) << 5) |
               ((date.getSeconds() >> 1) & 0x1F);
  const d = (((date.getFullYear() - 1980) & 0x7F) << 9) |
            (((date.getMonth() + 1) & 0x0F) << 5) |
            (date.getDate() & 0x1F);
  return { time, date: d };
}

/**
 * Build a ZIP64 archive containing a single file
 * Returns segments of the ZIP stream aligned at DEFLATE flush boundaries
 *
 * @param {File} file - Input file
 * @param {number} chunkDataSize - Target chunk data size in bytes
 * @param {boolean} useDeflate - true for DEFLATE, false for STORED
 * @param {function} onProgress - Progress callback (bytesRead, totalBytes)
 * @returns {AsyncGenerator<{ data: Uint8Array, isLast: boolean }>} ZIP segments
 */
export async function* buildZipStream(file, chunkDataSize, useDeflate, onProgress) {
  const filename = encodeFilename(file.name);
  const dt = dosDateTime(new Date(file.lastModified));
  const method = useDeflate ? ZIP_DEFLATE : ZIP_STORED;

  // --- Local File Header ---
  const extraFieldSize = 20; // ZIP64 extra: tag(2) + size(2) + uncomp(8) + comp(8)
  const lfhSize = 30 + filename.length + extraFieldSize;
  const lfh = new ArrayBuffer(lfhSize);
  const lfhView = new DataView(lfh);

  lfhView.setUint32(0, ZIP_LOCAL_FILE_SIG, true);
  lfhView.setUint16(4, ZIP_VERSION_NEEDED, true); // version needed
  lfhView.setUint16(6, 0x0008, true);              // flags: data descriptor present
  lfhView.setUint16(8, method, true);
  lfhView.setUint16(10, dt.time, true);
  lfhView.setUint16(12, dt.date, true);
  lfhView.setUint32(14, 0, true);                  // CRC-32 placeholder
  lfhView.setUint32(18, 0xFFFFFFFF, true);          // compressed size (ZIP64)
  lfhView.setUint32(22, 0xFFFFFFFF, true);          // uncompressed size (ZIP64)
  lfhView.setUint16(26, filename.length, true);
  lfhView.setUint16(28, extraFieldSize, true);

  const lfhBytes = new Uint8Array(lfh);
  lfhBytes.set(filename, 30);

  // ZIP64 extra field in local header
  const extraOffset = 30 + filename.length;
  lfhView.setUint16(extraOffset, ZIP64_EXTRA_TAG, true);
  lfhView.setUint16(extraOffset + 2, 16, true);          // data size
  // Sizes set to 0 initially (will be in data descriptor)
  // setBigUint64 defaults to 0

  yield { data: lfhBytes, isLast: false };

  // --- File Data (DEFLATE or STORED) ---
  const fileSize = file.size;
  let fileCrc = 0xFFFFFFFF;
  let compressedSize = 0n;
  let bytesRead = 0;

  if (useDeflate) {
    // Use pako for DEFLATE with Z_FULL_FLUSH
    const deflater = new pako.Deflate({ level: 6, raw: true });
    let pendingOutput = [];
    let pendingSize = 0;

    deflater.onData = function(chunk) {
      pendingOutput.push(chunk);
      pendingSize += chunk.length;
    };

    const readSize = chunkDataSize;

    while (bytesRead < fileSize) {
      const end = Math.min(bytesRead + readSize, fileSize);
      const slice = await file.slice(bytesRead, end).arrayBuffer();
      const input = new Uint8Array(slice);

      fileCrc = crc32Update(fileCrc, input);
      bytesRead = end;

      if (onProgress) onProgress(bytesRead, fileSize);

      const isLastSlice = bytesRead >= fileSize;
      const flush = isLastSlice ? true : 2; // true = Z_FINISH, 2 = Z_SYNC_FLUSH

      // pako push: flush mode 2 = Z_SYNC_FLUSH, 3 = Z_FULL_FLUSH, 4 = Z_FINISH
      // For Z_FULL_FLUSH, use numeric mode
      deflater.push(input, isLastSlice ? 4 : 3); // 3 = Z_FULL_FLUSH, 4 = Z_FINISH

      if (deflater.err) {
        throw new Error(`Deflate error: ${deflater.msg}`);
      }

      // Collect output
      if (pendingSize > 0) {
        const combined = new Uint8Array(pendingSize);
        let off = 0;
        for (const chunk of pendingOutput) {
          combined.set(chunk, off);
          off += chunk.length;
        }
        compressedSize += BigInt(combined.length);
        yield { data: combined, isLast: false };
        pendingOutput = [];
        pendingSize = 0;
      }
    }
  } else {
    // STORED: pass through raw bytes
    while (bytesRead < fileSize) {
      const end = Math.min(bytesRead + chunkDataSize, fileSize);
      const slice = await file.slice(bytesRead, end).arrayBuffer();
      const input = new Uint8Array(slice);

      fileCrc = crc32Update(fileCrc, input);
      bytesRead = end;
      compressedSize += BigInt(input.length);

      if (onProgress) onProgress(bytesRead, fileSize);

      yield { data: input, isLast: false };
    }
  }

  fileCrc = (fileCrc ^ 0xFFFFFFFF) >>> 0;

  // --- Data Descriptor (ZIP64) ---
  const ddSize = 4 + 4 + 8 + 8; // sig + crc + comp64 + uncomp64
  const dd = new ArrayBuffer(ddSize);
  const ddView = new DataView(dd);
  ddView.setUint32(0, ZIP_DATA_DESC_SIG, true);
  ddView.setUint32(4, fileCrc, true);
  ddView.setBigUint64(8, compressedSize, true);
  ddView.setBigUint64(16, BigInt(fileSize), true);

  yield { data: new Uint8Array(dd), isLast: false };

  // --- Central Directory ---
  const cdExtraSize = 28; // uncomp(8) + comp(8) + offset(8) + disk(4) ... actually let's use 24
  // ZIP64 extra for central dir: tag(2) + size(2) + uncomp(8) + comp(8) + offset(8) = 28
  const cdExtraDataSize = 24;
  const cdSize = 46 + filename.length + 4 + cdExtraDataSize;
  const cd = new ArrayBuffer(cdSize);
  const cdView = new DataView(cd);

  const centralDirOffset = BigInt(lfhSize) + compressedSize + BigInt(ddSize);

  cdView.setUint32(0, ZIP_CENTRAL_DIR_SIG, true);
  cdView.setUint16(4, (ZIP_VERSION_NEEDED << 8) | 0, true); // version made by
  cdView.setUint16(6, ZIP_VERSION_NEEDED, true);
  cdView.setUint16(8, 0x0008, true);     // flags
  cdView.setUint16(10, method, true);
  cdView.setUint16(12, dt.time, true);
  cdView.setUint16(14, dt.date, true);
  cdView.setUint32(16, fileCrc, true);
  cdView.setUint32(20, 0xFFFFFFFF, true); // comp size (ZIP64)
  cdView.setUint32(24, 0xFFFFFFFF, true); // uncomp size (ZIP64)
  cdView.setUint16(28, filename.length, true);
  cdView.setUint16(30, 4 + cdExtraDataSize, true); // extra field length
  cdView.setUint16(32, 0, true);          // comment length
  cdView.setUint16(34, 0xFFFF, true);     // disk number (ZIP64)
  cdView.setUint16(36, 0, true);          // internal attributes
  cdView.setUint32(38, 0, true);          // external attributes
  cdView.setUint32(42, 0xFFFFFFFF, true); // local header offset (ZIP64)

  const cdBytes = new Uint8Array(cd);
  cdBytes.set(filename, 46);

  // ZIP64 extra field in central directory
  const cdExtraOff = 46 + filename.length;
  cdView.setUint16(cdExtraOff, ZIP64_EXTRA_TAG, true);
  cdView.setUint16(cdExtraOff + 2, cdExtraDataSize, true);
  cdView.setBigUint64(cdExtraOff + 4, BigInt(fileSize), true);   // uncompressed
  cdView.setBigUint64(cdExtraOff + 12, compressedSize, true);    // compressed
  cdView.setBigUint64(cdExtraOff + 20, 0n, true);                // local header offset

  yield { data: cdBytes, isLast: false };

  // --- ZIP64 End of Central Directory Record ---
  const centralDirSize = BigInt(cdSize);
  const zip64EocdOffset = centralDirOffset + centralDirSize;

  const eocd64Size = 56;
  const eocd64 = new ArrayBuffer(eocd64Size);
  const eocd64View = new DataView(eocd64);

  eocd64View.setUint32(0, ZIP64_EOCD_SIG, true);
  eocd64View.setBigUint64(4, 44n, true);   // size of remaining record
  eocd64View.setUint16(12, ZIP_VERSION_NEEDED, true);
  eocd64View.setUint16(14, ZIP_VERSION_NEEDED, true);
  eocd64View.setUint32(16, 0, true);        // this disk
  eocd64View.setUint32(20, 0, true);        // disk with central dir
  eocd64View.setBigUint64(24, 1n, true);    // entries on this disk
  eocd64View.setBigUint64(32, 1n, true);    // total entries
  eocd64View.setBigUint64(40, centralDirSize, true);
  eocd64View.setBigUint64(48, centralDirOffset, true);

  yield { data: new Uint8Array(eocd64), isLast: false };

  // --- ZIP64 End of Central Directory Locator ---
  const locSize = 20;
  const loc = new ArrayBuffer(locSize);
  const locView = new DataView(loc);

  locView.setUint32(0, ZIP64_LOCATOR_SIG, true);
  locView.setUint32(4, 0, true);            // disk with ZIP64 EOCD
  locView.setBigUint64(8, zip64EocdOffset, true);
  locView.setUint32(16, 1, true);            // total disks

  yield { data: new Uint8Array(loc), isLast: false };

  // --- End of Central Directory Record ---
  const eocdSize = 22;
  const eocd = new ArrayBuffer(eocdSize);
  const eocdView = new DataView(eocd);

  eocdView.setUint32(0, ZIP_EOCD_SIG, true);
  eocdView.setUint16(4, 0xFFFF, true);     // this disk
  eocdView.setUint16(6, 0xFFFF, true);     // disk with central dir
  eocdView.setUint16(8, 0xFFFF, true);     // entries on this disk
  eocdView.setUint16(10, 0xFFFF, true);    // total entries
  eocdView.setUint32(12, 0xFFFFFFFF, true);// central dir size
  eocdView.setUint32(16, 0xFFFFFFFF, true);// central dir offset
  eocdView.setUint16(20, 0, true);          // comment length

  yield { data: new Uint8Array(eocd), isLast: true };
}
