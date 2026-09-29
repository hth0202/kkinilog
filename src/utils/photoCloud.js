import { Bytes, deleteDoc, doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { getPhoto, putPhoto } from './photoDB';
import { bytesToDataUrl, dataUrlToBytes, optimizePhoto } from './photo';

// 클라우드 사진: users/{uid}/photos/{photoId} 문서 하나에 기기와 같은 사진 한 벌(이진 데이터 + 형식).
// 이미 올렸거나 받은 사진 id는 계정별로 localStorage에 기억해 다시 읽거나 쓰지 않는다.
const syncedKey = (uid) => `kkinilog-photos-synced-${uid}`;
const photoRef = (uid, id) => doc(db, 'users', uid, 'photos', id);

function readSynced(uid) {
  try {
    return new Set(JSON.parse(localStorage.getItem(syncedKey(uid)) || '[]'));
  } catch {
    return new Set();
  }
}

function writeSynced(uid, set) {
  try { localStorage.setItem(syncedKey(uid), JSON.stringify([...set])); } catch { /* ignore */ }
}

const missingInCloud = new Set(); // 이번 실행에서 클라우드에 없던 id(읽기 반복 방지)
let uploading = null;
let uploadingUid = null;
let uploadAgain = false;

// 기록에 쓰였는데 아직 안 올린 사진을 올린다. 여러 번 불려도 한 번에 하나씩만 돈다.
export function uploadPendingPhotos(uid, meals) {
  if (uploading) {
    if (uploadingUid !== uid) return uploading.then(() => uploadPendingPhotos(uid, meals));
    uploadAgain = true;
    return uploading;
  }
  uploadingUid = uid;
  uploading = (async () => {
    let allSaved = true;
    do {
      uploadAgain = false;
      const synced = readSynced(uid);
      const ids = [...new Set(meals().flatMap((m) => m.photos))].filter((id) => !synced.has(id));
      for (const id of ids) {
        const local = await getPhoto(id);
        if (!local) continue;
        let optimized;
        try {
          optimized = await optimizePhoto(local);
        } catch {
          allSaved = false;
          continue; // 기기 사진이 손상돼 읽을 수 없으면 건너뛴다
        }
        // 기기에도 같은 한 벌만 남긴다(예전 큰 사진 교체).
        if (optimized !== local) await putPhoto(id, optimized).catch(() => {});
        const { type, bytes } = dataUrlToBytes(optimized);
        try {
          await setDoc(photoRef(uid, id), { data: Bytes.fromUint8Array(bytes), type, createdAt: serverTimestamp() });
          synced.add(id);
          writeSynced(uid, synced);
        } catch (err) {
          console.error('Photo upload failed:', err);
          return false; // 오프라인 등: 다음 동기화 때 다시 시도
        }
      }
    } while (uploadAgain);
    return allSaved;
  })().catch((err) => {
    console.error('Photo upload failed:', err);
    return false;
  }).finally(() => { uploading = null; uploadingUid = null; });
  return uploading;
}

// 이 기기에 없는 사진을 클라우드에서 받아 기기에 저장한다. 없으면 null.
export async function fetchCloudPhoto(uid, id) {
  if (missingInCloud.has(id)) return null;
  try {
    const snap = await getDoc(photoRef(uid, id));
    const saved = snap.exists() ? snap.data() : null;
    const data = saved?.data instanceof Bytes ? bytesToDataUrl(saved.type, saved.data.toUint8Array()) : null;
    if (!data) {
      missingInCloud.add(id);
      return null;
    }
    await putPhoto(id, data).catch(() => {});
    const synced = readSynced(uid);
    synced.add(id);
    writeSynced(uid, synced);
    return data;
  } catch (err) {
    console.error('Photo download failed:', err);
    return null;
  }
}

export function deleteCloudPhotos(uid, ids) {
  const synced = readSynced(uid);
  ids.forEach((id) => {
    synced.delete(id);
    deleteDoc(photoRef(uid, id)).catch((err) => console.error('Photo delete failed:', err));
  });
  writeSynced(uid, synced);
}
