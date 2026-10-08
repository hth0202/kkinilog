import { MAX_PHOTO_EDGE, PHOTO_QUALITY } from '../constants';

export class PhotoDecodeError extends Error {}

const CLOUD_BYTES_LIMIT = 950_000; // Firestore 문서 한도(1MiB) 안쪽

// WebP로 저장할 수 있으면 WebP, 아니면 JPEG(iOS Safari는 canvas WebP 저장 미지원).
let webpSupported;
function outputType() {
  if (webpSupported === undefined) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    webpSupported = canvas.toDataURL('image/webp').startsWith('data:image/webp');
  }
  return webpSupported ? 'image/webp' : 'image/jpeg';
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new PhotoDecodeError('Image decode failed'));
    img.src = src;
  });
}

function encode(img, maxEdge, quality) {
  const { naturalWidth: w, naturalHeight: h } = img;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(outputType(), quality);
}

const byteLength = (dataUrl) => Math.ceil((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);

// 크기가 한도를 넘으면 품질을 낮춰 다시 만든다.
function encodeWithinLimit(img, maxEdge) {
  let quality = PHOTO_QUALITY;
  let dataUrl = encode(img, maxEdge, quality);
  while (byteLength(dataUrl) > CLOUD_BYTES_LIMIT && quality > 0.35) {
    quality -= 0.15;
    dataUrl = encode(img, maxEdge, quality);
  }
  return dataUrl;
}

export async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    return encodeWithinLimit(await loadImage(url), MAX_PHOTO_EDGE);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 예전 방식(1280px)으로 저장된 사진은 올리기 전에 지금 기준으로 다시 줄인다. 이미 맞으면 그대로.
export async function optimizePhoto(dataUrl) {
  const img = await loadImage(dataUrl);
  const oversized = Math.max(img.naturalWidth, img.naturalHeight) > MAX_PHOTO_EDGE;
  if (!oversized && byteLength(dataUrl) <= CLOUD_BYTES_LIMIT) return dataUrl;
  return encodeWithinLimit(img, MAX_PHOTO_EDGE);
}

// Firestore에는 base64 글자 대신 이진 데이터로 넣어 용량을 약 25% 줄인다.
export function dataUrlToBytes(dataUrl) {
  const [head, base64] = dataUrl.split(',');
  const type = head.slice(5, head.indexOf(';'));
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { type, bytes };
}

export function bytesToDataUrl(type, bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

export function photoErrorMessage(err) {
  return err instanceof PhotoDecodeError
    ? '이 사진은 불러올 수 없어요. 다른 사진을 골라주세요'
    : '저장 공간이 부족해요. 사진을 더 작은 파일로 바꾸거나 오래된 사진을 지워주세요';
}
