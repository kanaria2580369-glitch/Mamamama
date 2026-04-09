/**
 * CRC32 implementation for Z2WAV format
 * Uses standard CRC-32 (ISO 3309 / ITU-T V.42) polynomial
 */

const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  TABLE[i] = c;
}

/**
 * Update running CRC32 with new data
 * @param {number} crc - Current CRC value (pass 0xFFFFFFFF for initial)
 * @param {Uint8Array} data - Data to process
 * @returns {number} Updated CRC value (not finalized)
 */
export function crc32Update(crc, data) {
  for (let i = 0; i < data.length; i++) {
    crc = TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return crc;
}

/**
 * Compute CRC32 of data
 * @param {Uint8Array} data
 * @returns {number} CRC32 value
 */
export function crc32(data) {
  return (crc32Update(0xFFFFFFFF, data) ^ 0xFFFFFFFF) >>> 0;
}
