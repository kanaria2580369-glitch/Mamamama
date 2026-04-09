/**
 * Z2WAV format constants
 */

// Magic bytes
export const PART_MAGIC = new Uint8Array([0x5A, 0x32, 0x57, 0x41, 0x56, 0x50]); // "Z2WAVP"
export const FULL_MAGIC = new Uint8Array([0x5A, 0x32, 0x57, 0x41, 0x56, 0x31]); // "Z2WAV1"

// Version
export const FORMAT_VERSION = 1;

// Header sizes
export const PART_HEADER_SIZE = 64;
export const FULL_HEADER_SIZE = 72;

// Chunk constraints
export const CHUNK_OVERHEAD = 12; // id(4) + size(4) + crc32(4)
export const DEFAULT_CHUNK_DATA_SIZE = 4 * 1024 * 1024; // 4MB
export const MAX_CHUNK_DATA_SIZE = 4 * 1024 * 1024;     // 4MB hard limit

// Part size limits by environment
export const PART_SIZE_UNLIMITED = 0;
export const PART_SIZE_BLOB = 512 * 1024 * 1024;  // 512MB
export const PART_SIZE_IOS = 256 * 1024 * 1024;   // 256MB

// WAV parameters
export const WAV_SAMPLE_RATE = 44100;
export const WAV_BITS_PER_SAMPLE = 8;
export const WAV_CHANNELS = 1;
export const WAV_HEADER_SIZE = 44;

// RF64 threshold: standard RIFF supports up to ~4GB
export const RF64_THRESHOLD = 0xFFFFFFFF - 44;

// Flags
export const FLAG_DEFLATE = 0n;
export const FLAG_STORED = 1n;

// ZIP constants
export const ZIP_LOCAL_FILE_SIG = 0x04034b50;
export const ZIP_DATA_DESC_SIG = 0x08074b50;
export const ZIP_CENTRAL_DIR_SIG = 0x02014b50;
export const ZIP_EOCD_SIG = 0x06054b50;
export const ZIP64_EOCD_SIG = 0x06064b50;
export const ZIP64_LOCATOR_SIG = 0x07064b50;
export const ZIP64_EXTRA_TAG = 0x0001;
export const ZIP_VERSION_NEEDED = 45;
export const ZIP_DEFLATE = 8;
export const ZIP_STORED = 0;
