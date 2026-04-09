/**
 * Z2WAV Web Application - UI Controller
 */

import { encode } from './encoder.js';
import { decode } from './decoder.js';
import { detectEnvironment } from './environment.js';
import { downloadFile, getFiles } from './file-io.js';

// --- State ---
let currentMode = 'encode';
let isProcessing = false;

// --- DOM References ---
const $ = (id) => document.getElementById(id);

function init() {
  const env = detectEnvironment();
  displayEnvironment(env);

  // Tab switching
  $('tab-encode').addEventListener('click', () => switchMode('encode'));
  $('tab-decode').addEventListener('click', () => switchMode('decode'));

  // Encode UI
  $('encode-input').addEventListener('change', handleEncodeFileSelect);
  $('encode-dropzone').addEventListener('dragover', handleDragOver);
  $('encode-dropzone').addEventListener('drop', handleEncodeDrop);
  $('encode-dropzone').addEventListener('click', () => $('encode-input').click());
  $('btn-encode').addEventListener('click', handleEncode);
  $('use-deflate').addEventListener('change', updateEncodeInfo);

  // Decode UI
  $('decode-input').addEventListener('change', handleDecodeFileSelect);
  $('decode-dropzone').addEventListener('dragover', handleDragOver);
  $('decode-dropzone').addEventListener('drop', handleDecodeDrop);
  $('decode-dropzone').addEventListener('click', () => $('decode-input').click());
  $('btn-decode').addEventListener('click', handleDecode);

  // Safety warning acknowledgment
  $('btn-acknowledge').addEventListener('click', () => {
    $('safety-warning').classList.add('hidden');
    $('main-content').classList.remove('hidden');
  });
}

function displayEnvironment(env) {
  const envInfo = $('env-info');
  const parts = [];

  if (env.isIOS) {
    parts.push('<span class="env-tag env-ios">iOS</span>');
    parts.push(`<span class="env-detail">Max part: 256MB (auto-split)</span>`);
  }
  parts.push(`<span class="env-tag">${env.outputMethod === 'streaming' ? 'Streaming' : 'Blob'}</span>`);
  parts.push(`<span class="env-detail">${env.label}</span>`);

  envInfo.innerHTML = parts.join(' ');
}

function switchMode(mode) {
  currentMode = mode;
  $('tab-encode').classList.toggle('active', mode === 'encode');
  $('tab-decode').classList.toggle('active', mode === 'decode');
  $('panel-encode').classList.toggle('hidden', mode !== 'encode');
  $('panel-decode').classList.toggle('hidden', mode !== 'decode');
}

// --- Drag & Drop ---
function handleDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('dragover');
}

function handleDragLeave(e) {
  e.currentTarget.classList.remove('dragover');
}

// --- Encode ---
let encodeFile = null;

function handleEncodeFileSelect(e) {
  const files = getFiles(e.target.files);
  if (files.length > 0) {
    encodeFile = files[0];
    updateEncodeInfo();
  }
}

function handleEncodeDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('dragover');
  const files = getFiles(e.dataTransfer);
  if (files.length > 0) {
    encodeFile = files[0];
    updateEncodeInfo();
    $('encode-input').files = e.dataTransfer.files;
  }
}

function updateEncodeInfo() {
  if (!encodeFile) return;

  const env = detectEnvironment();
  const useDeflate = $('use-deflate').checked;
  const info = $('encode-file-info');

  const sizeMB = (encodeFile.size / (1024 * 1024)).toFixed(2);
  let html = `<strong>${escapeHtml(encodeFile.name)}</strong> (${sizeMB} MB)`;

  if (env.maxPartSize > 0 && encodeFile.size > env.maxPartSize) {
    const partCount = Math.ceil(encodeFile.size / env.maxPartSize);
    html += `<br><span class="info-note">Will be split into ~${partCount} parts (${env.isIOS ? '256MB' : '512MB'} each)</span>`;
  }

  html += `<br>Compression: ${useDeflate ? 'DEFLATE' : 'STORED (no compression)'}`;
  info.innerHTML = html;
  info.classList.remove('hidden');
  $('btn-encode').disabled = false;
}

async function handleEncode() {
  if (!encodeFile || isProcessing) return;
  isProcessing = true;
  $('btn-encode').disabled = true;

  const env = detectEnvironment();
  const useDeflate = $('use-deflate').checked;
  const progressBar = $('encode-progress');
  const progressText = $('encode-progress-text');
  const progressContainer = $('encode-progress-container');
  const resultContainer = $('encode-result');

  progressContainer.classList.remove('hidden');
  resultContainer.classList.add('hidden');
  resultContainer.innerHTML = '';

  try {
    const results = [];

    for await (const part of encode(encodeFile, {
      maxPartSize: env.maxPartSize,
      useDeflate,
      onProgress: (info) => {
        const phaseNames = {
          hash: 'Computing SHA-256',
          compress: 'Compressing',
          output: 'Generating WAV'
        };
        const phaseName = phaseNames[info.phase] || info.phase;
        const pct = Math.round(info.progress * 100);
        progressBar.value = pct;
        progressText.textContent = `${phaseName}... ${pct}%`;
      }
    })) {
      results.push(part);
    }

    progressBar.value = 100;
    progressText.textContent = 'Complete!';

    // Show results
    let html = `<h3>Encoded ${results.length} file(s)</h3>`;
    for (const result of results) {
      const sizeMB = (result.wavData.length / (1024 * 1024)).toFixed(2);
      html += `<div class="result-item">
        <span>${escapeHtml(result.filename)} (${sizeMB} MB)</span>
        <button class="btn-download" data-index="${result.partIndex}">Download</button>
      </div>`;
    }

    if (results.length > 1) {
      html += `<button id="btn-download-all" class="btn-primary">Download All</button>`;
    }

    resultContainer.innerHTML = html;
    resultContainer.classList.remove('hidden');

    // Attach download handlers
    resultContainer.querySelectorAll('.btn-download').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.index);
        const part = results[idx];
        await downloadFile(part.wavData, part.filename);
      });
    });

    const dlAll = $('btn-download-all');
    if (dlAll) {
      dlAll.addEventListener('click', async () => {
        for (const part of results) {
          await downloadFile(part.wavData, part.filename);
        }
      });
    }

  } catch (err) {
    progressText.textContent = `Error: ${err.message}`;
    progressBar.value = 0;
    console.error('Encode error:', err);
  } finally {
    isProcessing = false;
    $('btn-encode').disabled = false;
  }
}

// --- Decode ---
let decodeFiles = [];

function handleDecodeFileSelect(e) {
  decodeFiles = getFiles(e.target.files);
  updateDecodeInfo();
}

function handleDecodeDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('dragover');
  decodeFiles = getFiles(e.dataTransfer);
  updateDecodeInfo();
}

function updateDecodeInfo() {
  if (decodeFiles.length === 0) return;

  const info = $('decode-file-info');
  let html = `<strong>${decodeFiles.length} file(s) selected:</strong><br>`;
  for (const f of decodeFiles) {
    const sizeMB = (f.size / (1024 * 1024)).toFixed(2);
    html += `${escapeHtml(f.name)} (${sizeMB} MB)<br>`;
  }

  info.innerHTML = html;
  info.classList.remove('hidden');
  $('btn-decode').disabled = false;
}

async function handleDecode() {
  if (decodeFiles.length === 0 || isProcessing) return;
  isProcessing = true;
  $('btn-decode').disabled = true;

  const progressBar = $('decode-progress');
  const progressText = $('decode-progress-text');
  const progressContainer = $('decode-progress-container');
  const resultContainer = $('decode-result');

  progressContainer.classList.remove('hidden');
  resultContainer.classList.add('hidden');
  resultContainer.innerHTML = '';

  try {
    const result = await decode(decodeFiles, {
      strictCrc: false,
      onProgress: (info) => {
        const phaseNames = {
          parse: 'Parsing WAV files',
          chunks: 'Processing chunks',
          decompress: 'Decompressing',
          verify: 'Verifying SHA-256'
        };
        const phaseName = phaseNames[info.phase] || info.phase;
        const pct = Math.round(info.progress * 100);
        progressBar.value = pct;
        progressText.textContent = `${phaseName}... ${pct}%`;
      }
    });

    progressBar.value = 100;
    progressText.textContent = 'Complete!';

    const sizeMB = (result.data.length / (1024 * 1024)).toFixed(2);
    let html = `<h3>Decoded Successfully</h3>`;
    html += `<div class="result-item">
      <span><strong>${escapeHtml(result.filename)}</strong> (${sizeMB} MB)</span>
      <button id="btn-download-decoded" class="btn-primary">Download</button>
    </div>`;

    html += `<div class="verify-status ${result.verified ? 'verify-ok' : 'verify-fail'}">
      SHA-256: ${result.verified ? 'VERIFIED' : 'MISMATCH'}
    </div>`;

    if (result.warnings.length > 0) {
      html += `<div class="warnings">
        <strong>Warnings:</strong><br>
        ${result.warnings.map(w => escapeHtml(w)).join('<br>')}
      </div>`;
    }

    resultContainer.innerHTML = html;
    resultContainer.classList.remove('hidden');

    $('btn-download-decoded').addEventListener('click', async () => {
      await downloadFile(result.data, result.filename);
    });

  } catch (err) {
    progressText.textContent = `Error: ${err.message}`;
    progressBar.value = 0;
    console.error('Decode error:', err);
  } finally {
    isProcessing = false;
    $('btn-decode').disabled = false;
  }
}

// --- Utilities ---
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Initialize ---
document.addEventListener('DOMContentLoaded', init);
