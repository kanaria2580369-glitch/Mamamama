/**
 * End-to-end round-trip test for Z2WAV
 * Tests: encode a buffer → WAV → decode → verify match
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pakoModule = require('pako');
globalThis.pako = pakoModule;

// Polyfill crypto.subtle for Node
import { webcrypto } from 'crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import { crc32 } from './js/crc32.js';
import { createWavHeader, parseWav } from './js/wav.js';
import {
  PART_MAGIC, FULL_MAGIC, FORMAT_VERSION,
  PART_HEADER_SIZE, FULL_HEADER_SIZE, CHUNK_OVERHEAD
} from './js/constants.js';
import { buildZipStream } from './js/zip-stream.js';

// Create a mock File object for Node.js
class MockFile {
  constructor(data, name) {
    this._data = data;
    this.name = name;
    this.size = data.length;
    this.lastModified = Date.now();
  }

  slice(start, end) {
    const sliced = this._data.slice(start, end);
    return {
      arrayBuffer: () => Promise.resolve(sliced.buffer.slice(sliced.byteOffset, sliced.byteOffset + sliced.byteLength))
    };
  }

  arrayBuffer() {
    return Promise.resolve(this._data.buffer.slice(this._data.byteOffset, this._data.byteOffset + this._data.byteLength));
  }
}

async function testZipStream() {
  console.log('=== Test: ZIP Stream ===');

  const testData = new Uint8Array(10000);
  for (let i = 0; i < testData.length; i++) testData[i] = i & 0xFF;

  const file = new MockFile(testData, 'test.bin');
  const segments = [];

  for await (const seg of buildZipStream(file, 4096, true, null)) {
    segments.push(seg);
  }

  console.log('Segments:', segments.length);

  // Concatenate all segments to form ZIP
  let totalSize = 0;
  for (const s of segments) totalSize += s.data.length;

  const zipData = new Uint8Array(totalSize);
  let offset = 0;
  for (const s of segments) {
    zipData.set(s.data, offset);
    offset += s.data.length;
  }

  console.log('ZIP total size:', totalSize);

  // Verify it starts with local file header signature
  const view = new DataView(zipData.buffer);
  const sig = view.getUint32(0, true);
  console.log('ZIP signature:', '0x' + sig.toString(16), sig === 0x04034b50 ? 'OK' : 'FAIL');

  // Try decompressing
  const method = view.getUint16(8, true);
  const fnLen = view.getUint16(26, true);
  const exLen = view.getUint16(28, true);
  const dataStart = 30 + fnLen + exLen;

  // Find data descriptor
  let compEnd = dataStart;
  for (let i = dataStart; i < zipData.length - 4; i++) {
    if (view.getUint32(i, true) === 0x08074b50) {
      compEnd = i;
      break;
    }
  }

  const compressed = zipData.slice(dataStart, compEnd);
  console.log('Compressed data size:', compressed.length);

  const decompressed = pako.inflateRaw(compressed);
  console.log('Decompressed size:', decompressed.length, decompressed.length === 10000 ? 'OK' : 'FAIL');

  // Verify content
  let match = true;
  for (let i = 0; i < decompressed.length; i++) {
    if (decompressed[i] !== (i & 0xFF)) { match = false; break; }
  }
  console.log('Content match:', match ? 'OK' : 'FAIL');

  return true;
}

async function testFullRoundTrip() {
  console.log('\n=== Test: Full Round-Trip ===');

  // Import encoder and decoder
  const { encode } = await import('./js/encoder.js');
  const { decode } = await import('./js/decoder.js');

  // Create test data
  const testData = new Uint8Array(50000);
  for (let i = 0; i < testData.length; i++) testData[i] = (i * 7 + 13) & 0xFF;

  const file = new MockFile(testData, 'testfile.dat');

  // Encode
  console.log('Encoding...');
  const parts = [];
  for await (const part of encode(file, { useDeflate: true })) {
    parts.push(part);
    console.log(`  Part ${part.partIndex + 1}/${part.partTotal}: ${part.filename} (${part.wavData.length} bytes)`);
  }

  console.log('Total parts:', parts.length);

  // Create mock WAV files for decoder
  const wavFiles = parts.map(p => new MockFile(p.wavData, p.filename));

  // Decode
  console.log('Decoding...');
  const result = await decode(wavFiles, { strictCrc: false });

  console.log('Decoded filename:', result.filename);
  console.log('Decoded size:', result.data.length, result.data.length === testData.length ? 'OK' : 'FAIL');
  console.log('SHA-256 verified:', result.verified ? 'OK' : 'FAIL');
  console.log('Warnings:', result.warnings.length === 0 ? 'None' : result.warnings);

  // Verify content
  let match = true;
  for (let i = 0; i < result.data.length; i++) {
    if (result.data[i] !== testData[i]) {
      console.log('Content mismatch at byte', i, ':', result.data[i], '!==', testData[i]);
      match = false;
      break;
    }
  }
  console.log('Content match:', match ? 'OK' : 'FAIL');

  return match && result.verified;
}

async function testStoredMode() {
  console.log('\n=== Test: STORED Mode ===');

  const { encode } = await import('./js/encoder.js');
  const { decode } = await import('./js/decoder.js');

  const testData = new Uint8Array(5000);
  for (let i = 0; i < testData.length; i++) testData[i] = i & 0xFF;

  const file = new MockFile(testData, 'stored.bin');

  const parts = [];
  for await (const part of encode(file, { useDeflate: false })) {
    parts.push(part);
  }

  const wavFiles = parts.map(p => new MockFile(p.wavData, p.filename));
  const result = await decode(wavFiles, { strictCrc: false });

  console.log('Decoded size:', result.data.length, result.data.length === testData.length ? 'OK' : 'FAIL');
  console.log('SHA-256 verified:', result.verified ? 'OK' : 'FAIL');

  let match = true;
  for (let i = 0; i < result.data.length; i++) {
    if (result.data[i] !== testData[i]) { match = false; break; }
  }
  console.log('Content match:', match ? 'OK' : 'FAIL');

  return match && result.verified;
}

async function main() {
  let allPassed = true;

  try {
    allPassed &= await testZipStream();
  } catch (e) {
    console.error('ZIP Stream test failed:', e);
    allPassed = false;
  }

  try {
    allPassed &= await testFullRoundTrip();
  } catch (e) {
    console.error('Full round-trip test failed:', e);
    allPassed = false;
  }

  try {
    allPassed &= await testStoredMode();
  } catch (e) {
    console.error('STORED mode test failed:', e);
    allPassed = false;
  }

  console.log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
  process.exit(allPassed ? 0 : 1);
}

main();
