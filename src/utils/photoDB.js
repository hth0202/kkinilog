// 기기 IndexedDB에 사진(dataURL)을 저장한다. 앱 전체가 하나의 연결을 공유한다.
let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      const req = indexedDB.open('kkinilog-photos', 1);
      req.onupgradeneeded = (e) => e.target.result.createObjectStore('photos');
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = () => resolve(null);
    });
  }
  return dbPromise;
}

// 저장 실패(용량 초과 등)는 호출한 쪽에서 안내할 수 있도록 reject한다.
export async function putPhoto(id, dataUrl) {
  const db = await openDB();
  if (!db) throw new Error('Photo DB unavailable');
  return new Promise((resolve, reject) => {
    const tx = db.transaction('photos', 'readwrite');
    tx.objectStore('photos').put(dataUrl, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getPhoto(id) {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction('photos', 'readonly');
    const req = tx.objectStore('photos').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

export async function deletePhoto(id) {
  const db = await openDB();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction('photos', 'readwrite');
    tx.objectStore('photos').delete(id);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}
