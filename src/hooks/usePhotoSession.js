import { useRef, useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { deletePhoto } from '../utils/photoDB';

// 편집 화면에서 추가·삭제한 사진을 모아 두었다가, 저장하면 삭제분을, 저장 없이 닫으면 추가분을 지운다.
// 추가분은 아직 기록에 쓰이지 않아 클라우드에 올라가지 않았으므로 기기에서만 지운다.
export function usePhotoSession() {
  const sessionRef = useRef({ added: [], removed: [], committed: false, active: true });

  useEffect(() => {
    sessionRef.current = { added: [], removed: [], committed: false, active: true };
    return () => {
      const s = sessionRef.current;
      s.active = false;
      if (s.committed) useAppStore.getState().deletePhotos(s.removed);
      else s.added.forEach((id) => deletePhoto(id));
    };
  }, []);

  return {
    markAdded: (ids) => {
      if (!sessionRef.current.active) { ids.forEach((id) => deletePhoto(id)); return false; }
      sessionRef.current.added.push(...ids);
      return true;
    },
    markRemoved: (id) => { if (id) sessionRef.current.removed.push(id); },
    commit: (extraRemoved = []) => {
      sessionRef.current.removed.push(...extraRemoved);
      sessionRef.current.committed = true;
    },
  };
}
