/**
 * Test multi-chunk and multi-part splitting
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
globalThis.pako = require('pako');

import { webcrypto } from 'crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import { encode } from './js/encoder.js';
import { decode } from './js/decoder.js';

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

async function testMultiChunk() {
  console.log('=== Test: Multi-Chunk (small chunk size) ===');

  // 20KB data with 1KB chunks → should produce multiple chunks
  const testData = new Uint8Array(20000);
  for (let i = 0; i < testData.length; i++) testData[i] = (i * 3) & 0xFF;

  const file = new MockFile(testData, 'multi-chunk.dat');

  const parts = [];
  for await (const part of encode(file, { chunkDataSize: 1024, useDeflate: true })) {
    parts.push(part);
  }

  console.log('Parts:', parts.length);
  console.log('WAV size:', parts[0].wavData.length);

  const wavFiles = parts.map(p => new MockFile(p.wavData, p.filename));
  const result = await decode(wavFiles);

  console.log('Decoded size:', result.data.length, result.data.length === testData.length ? 'OK' : 'FAIL');
  console.log('SHA-256 verified:', result.verified ? 'OK' : 'FAIL');

  let match = true;
  for (let i = 0; i < result.data.length; i++) {
    if (result.data[i] !== testData[i]) { match = false; break; }
  }
  console.log('Content match:', match ? 'OK' : 'FAIL');
  return match && result.verified;
}

async function testMultiPart() {
  console.log('\n=== Test: Multi-Part (small max part size) ===');

  const testData = new Uint8Array(30000);
  for (let i = 0; i < testData.length; i++) testData[i] = (i * 11 + 7) & 0xFF;

  const file = new MockFile(testData, 'multi-part.dat');

  const parts = [];
  // Very small part size to force splitting: 500 bytes
  for await (const part of encode(file, { maxPartSize: 500, chunkDataSize: 256, useDeflate: false })) {
    parts.push(part);
    console.log(`  Part ${part.partIndex + 1}/${part.partTotal}: ${part.filename} (${part.wavData.length} bytes)`);
  }

  console.log('Total parts:', parts.length);

  // Test with parts in order
  const wavFiles = parts.map(p => new MockFile(p.wavData, p.filename));
  const result = await decode(wavFiles);

  console.log('Decoded size:', result.data.length, result.data.length === testData.length ? 'OK' : 'FAIL');
  console.log('SHA-256 verified:', result.verified ? 'OK' : 'FAIL');

  let match = true;
  for (let i = 0; i < result.data.length; i++) {
    if (result.data[i] !== testData[i]) { match = false; break; }
  }
  console.log('Content match:', match ? 'OK' : 'FAIL');

  // Test with parts in reverse order (should still work due to sorting)
  console.log('\nTest decode with reversed part order...');
  const reversed = [...wavFiles].reverse();
  const result2 = await decode(reversed);
  console.log('SHA-256 verified:', result2.verified ? 'OK' : 'FAIL');

  let match2 = true;
  for (let i = 0; i < result2.data.length; i++) {
    if (result2.data[i] !== testData[i]) { match2 = false; break; }
  }
  console.log('Content match:', match2 ? 'OK' : 'FAIL');

  return match && match2 && result.verified && result2.verified;
}

async function main() {
  let allPassed = true;

  try {
    allPassed &= await testMultiChunk();
  } catch (e) {
    console.error('Multi-chunk test failed:', e);
    allPassed = false;
  }

  try {
    allPassed &= await testMultiPart();
  } catch (e) {
    console.error('Multi-part test failed:', e);
    allPassed = false;
  }

  console.log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
  process.exit(allPassed ? 0 : 1);
}

main();
