import { create } from 'zustand';
import { doc, runTransaction, serverTimestamp } from 'firebase/firestore';
import {
  GoogleAuthProvider, getRedirectResult, linkWithPopup, linkWithRedirect, signInWithCredential,
  signInWithPopup, signInWithRedirect, signOut as firebaseSignOut,
} from 'firebase/auth';
import { db, auth, googleProvider } from '../firebase';
import {
  DEFAULT_TAGS, DEFAULT_TRACKED_TAGS, TRACKED_TAG_LIMIT,
  FULLNESS_OPTIONS, CARB_OPTIONS, SPEED_OPTIONS,
  MEAL_TITLE_LIMIT, MEAL_MEMO_LIMIT, CONDITION_NOTE_LIMIT,
  MAX_PHOTOS_PER_MEAL, SETTINGS_VERSION, STORAGE_KEY, MEAL_SLOTS,
} from '../constants';
import { todayKey, effectiveDateKey, dateFromKey, formatDateKey } from '../utils/date';
import { tagsForSlot, migrateSpeed, slotIsTaken } from '../utils/meal';
import { trimMealTitle, trimMealMemo } from '../utils/text';
import { deletePhoto, getPhoto } from '../utils/photoDB';
import { deleteCloudPhotos, fetchCloudPhoto, uploadPendingPhotos } from '../utils/photoCloud';

const validIds = DEFAULT_TAGS.map((t) => t.id);
const removedIds = ['slow', 'overeat', 'sweet-drink'];
const TOMBSTONE_TTL = 180 * 86400000;
const CLOUD_SIZE_WARN = 900_000; // Firestore 문서 한도 1MiB

const toNum = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

function normalizeState(raw) {
  const shouldRefresh = raw.settingsVersion !== SETTINGS_VERSION;
  const savedTags = Array.isArray(raw.selectedTags)
    ? raw.selectedTags.filter((id) => validIds.includes(id) && !removedIds.includes(id))
    : null;
  const selectedTags = shouldRefresh || !savedTags
    ? validIds
    : [...new Set([...savedTags, ...validIds.filter((id) => !raw.selectedTags.includes(id) && !removedIds.includes(id))])];
  const trackedTags = Array.isArray(raw.trackedTags)
    ? raw.trackedTags.filter((id) => validIds.includes(id))
    : DEFAULT_TRACKED_TAGS;

  return {
    meals: Array.isArray(raw.meals)
      ? raw.meals.map((meal) => {
          const ms = migrateSpeed(meal.speed);
          const rawPhotos = Array.isArray(meal.photos) ? meal.photos : meal.photo ? [meal.photo] : [];
          const { photo: _p, photos: _ph, ...rest } = meal;
          return {
            ...rest,
            title: trimMealTitle(meal.title || ''),
            memo: trimMealMemo(meal.memo || ''),
            createdAt: toNum(meal.createdAt, Date.now()),
            updatedAt: toNum(meal.updatedAt, toNum(meal.createdAt, 0)),
            tags: tagsForSlot((Array.isArray(meal.tags) ? meal.tags : []).filter((id) => validIds.includes(id) && !removedIds.includes(id)), meal.slot),
            fullness: FULLNESS_OPTIONS.includes(meal.fullness) ? meal.fullness : '적당함',
            carbs: CARB_OPTIONS.includes(meal.carbs) ? meal.carbs : '보통',
            speed: SPEED_OPTIONS.includes(ms) ? ms : '모르겠음',
            photos: rawPhotos.filter((p) => typeof p === 'string' && p).slice(0, MAX_PHOTOS_PER_MEAL),
          };
        })
      : [],
    selectedTags: selectedTags.length ? selectedTags : validIds,
    trackedTags: [...new Set(trackedTags)].slice(0, TRACKED_TAG_LIMIT),
    favorites: Array.isArray(raw.favorites)
      ? raw.favorites.map((f) => ({
          id: typeof f.id === 'string' ? f.id : crypto.randomUUID(),
          fromMealId: typeof f.fromMealId === 'string' ? f.fromMealId : null,
          name: String(f.name || f.title || '').slice(0, 30).trim(),
          slot: ['아침', '점심', '저녁', '간식', '음료'].includes(f.slot) ? f.slot : '점심',
          title: trimMealTitle(f.title || ''),
          tags: tagsForSlot((Array.isArray(f.tags) ? f.tags : []).filter((id) => validIds.includes(id) && !removedIds.includes(id)), f.slot),
          fullness: FULLNESS_OPTIONS.includes(f.fullness) ? f.fullness : '적당함',
          carbs: CARB_OPTIONS.includes(f.carbs) ? f.carbs : '보통',
          speed: SPEED_OPTIONS.includes(migrateSpeed(f.speed)) ? migrateSpeed(f.speed) : '모르겠음',
          memo: trimMealMemo(f.memo || ''),
          lastUsedAt: toNum(f.lastUsedAt, Date.now()),
          updatedAt: toNum(f.updatedAt, toNum(f.lastUsedAt, 0)),
        }))
      : [],
    settingsVersion: SETTINGS_VERSION,
    dailyNotes: raw.dailyNotes && typeof raw.dailyNotes === 'object' && !Array.isArray(raw.dailyNotes)
      ? Object.fromEntries(
          Object.entries(raw.dailyNotes)
            .filter(([k, v]) => typeof k === 'string' && v && typeof v === 'object' && ['good', 'ok', 'bad'].includes(v.mood))
            .map(([k, v]) => [k, {
              mood: v.mood,
              memo: typeof v.memo === 'string' ? Array.from(v.memo).slice(0, CONDITION_NOTE_LIMIT).join('') : '',
              updatedAt: toNum(v.updatedAt, 0),
            }])
        )
      : {},
    conditionPromptHour: Number.isInteger(raw.conditionPromptHour) && raw.conditionPromptHour >= 0 && raw.conditionPromptHour <= 23
      ? raw.conditionPromptHour : 6,
    lastConditionSkippedDate: typeof raw.lastConditionSkippedDate === 'string'
      ? raw.lastConditionSkippedDate : null,
    settingsUpdatedAt: toNum(raw.settingsUpdatedAt, 0),
    deleted: normalizeDeleted(raw.deleted),
  };
}

// 삭제 기록(tombstone): { [id]: 삭제 시각 }. 다른 기기에서 지운 항목이 병합으로 되살아나지 않게 한다.
function normalizeDeleted(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const cutoff = Date.now() - TOMBSTONE_TTL;
  return Object.fromEntries(
    Object.entries(raw).filter(([, ts]) => Number.isFinite(ts) && ts > cutoff)
  );
}

// 같은 id면 updatedAt이 더 최신인 쪽을 쓰고, 동률이면 클라우드를 우선한다.
function mergeById(cloudItems, localItems, deleted) {
  const byId = new Map();
  cloudItems.forEach((item) => byId.set(item.id, item));
  localItems.forEach((item) => {
    const existing = byId.get(item.id);
    if (!existing || (item.updatedAt ?? 0) > (existing.updatedAt ?? 0)) byId.set(item.id, item);
  });
  return [...byId.values()].filter((item) => !deleted[item.id]);
}

function mergeStates(cloudRaw, localRaw) {
  const cloud = normalizeState(cloudRaw || {});
  const local = normalizeState(localRaw || {});

  const deleted = { ...cloud.deleted };
  Object.entries(local.deleted).forEach(([id, ts]) => {
    deleted[id] = Math.max(deleted[id] ?? 0, ts);
  });

  const dailyNotes = { ...cloud.dailyNotes };
  Object.entries(local.dailyNotes).forEach(([key, note]) => {
    if (!dailyNotes[key] || note.updatedAt > dailyNotes[key].updatedAt) dailyNotes[key] = note;
  });

  const settingsSource = local.settingsUpdatedAt > cloud.settingsUpdatedAt ? local : cloud;
  const skipped = [cloud.lastConditionSkippedDate, local.lastConditionSkippedDate].filter(Boolean).sort().pop() ?? null;

  return normalizeState({
    ...cloud,
    selectedTags: settingsSource.selectedTags,
    trackedTags: settingsSource.trackedTags,
    conditionPromptHour: settingsSource.conditionPromptHour,
    settingsUpdatedAt: settingsSource.settingsUpdatedAt,
    lastConditionSkippedDate: skipped,
    meals: mergeById(cloud.meals, local.meals, deleted),
    favorites: mergeById(cloud.favorites, local.favorites, deleted),
    dailyNotes,
    deleted,
  });
}

function writeLocal(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (err) {
    console.error('Local save failed:', err);
    return false;
  }
}

function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function toUserInfo(user) {
  return user
    ? { uid: user.uid, isAnonymous: user.isAnonymous, displayName: user.displayName, email: user.email }
    : null;
}

let cloudSaveTimer = null;
let toastTimer = null;

function isRedirectFallback(err) {
  return err?.code === 'auth/popup-blocked' || err?.code === 'auth/operation-not-supported-in-this-environment';
}

export const useAppStore = create((set, get) => ({
  // Persisted data
  appState: null,

  // UI state
  activeTab: 'today',
  today: todayKey(),
  viewedDate: todayKey(),
  datePickerOpen: false,
  pickerMonth: todayKey().slice(0, 7),
  editor: null,
  mealDetailId: null,
  settingsOpen: false,
  tagEditMode: false,
  conditionSheet: null, // { date, selectedMood }
  toast: null,
  currentUser: null,
  syncStatus: 'idle',
  photoViewer: null, // { photos, index }

  // ── Init ──────────────────────────────────────────────
  initState() {
    const state = normalizeState(readLocal());
    const today = effectiveDateKey(state.conditionPromptHour);
    set({ appState: state, today, viewedDate: today });
  },

  // 앱을 켜둔 채 하루가 바뀌면(백그라운드 복귀 포함) 오늘 보기를 새 날짜로 옮긴다.
  refreshToday() {
    const { appState, today, viewedDate } = get();
    if (!appState) return;
    const next = effectiveDateKey(appState.conditionPromptHour);
    if (next === today) return;
    set({ today: next, viewedDate: viewedDate === today || viewedDate > next ? next : viewedDate });
  },

  // ── Persistence ───────────────────────────────────────
  saveAppState(nextState) {
    const state = nextState ?? get().appState;
    if (!writeLocal(state)) {
      get().showToast('기기 저장 공간이 부족해서 저장하지 못했어요');
      return false;
    }
    set({ appState: state });
    get()._cloudSave();
    return true;
  },

  _cloudSave() {
    if (!get().currentUser) return;
    set({ syncStatus: 'pending' });
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = setTimeout(() => get().syncCloud(), 1500);
  },

  // 대기 중인 저장이 있으면 바로 올린다(앱이 백그라운드로 갈 때).
  flushCloud() {
    if (cloudSaveTimer) get().syncCloud();
  },

  // 클라우드 문서를 읽어 로컬과 병합한 뒤 다시 쓴다. 저장·앱 복귀·로그인 시 모두 이 경로를 탄다.
  async syncCloud() {
    const { currentUser } = get();
    if (!currentUser) return false;
    set({ syncStatus: 'syncing' });
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = null;
    const ref = doc(db, 'users', currentUser.uid);
    try {
      const merged = await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const cloudJson = snap.exists() ? snap.data().state || '{}' : '{}';
        const next = mergeStates(JSON.parse(cloudJson), get().appState ?? readLocal());
        const json = JSON.stringify(next);
        if (json !== cloudJson) {
          if (json.length > CLOUD_SIZE_WARN) console.warn(`Cloud state is ${json.length} bytes`);
          tx.set(ref, { state: json, updatedAt: serverTimestamp() });
        }
        return next;
      });
      // 동기화 도중 계정이 바뀌었으면 결과를 버린다.
      if (get().currentUser?.uid !== currentUser.uid) return false;
      // 트랜잭션 도중 생긴 로컬 변경까지 반영한다.
      const next = mergeStates(merged, get().appState);
      if (!writeLocal(next)) {
        set({ syncStatus: 'error' });
        get().showToast('동기화한 기록을 기기에 저장하지 못했어요. 저장 공간을 확인해주세요');
        return false;
      }
      set({ appState: next });
      get().refreshToday();
      const photosSaved = await get().uploadPhotos();
      if (get().currentUser?.uid !== currentUser.uid) return false;
      set({ syncStatus: photosSaved === false ? 'error' : cloudSaveTimer ? 'pending' : 'synced' });
      if (photosSaved === false) return false;
      return true;
    } catch (err) {
      if (get().currentUser?.uid !== currentUser.uid) return false;
      set({ syncStatus: 'error' });
      console.error('Cloud sync failed:', err);
      if (err?.code === 'invalid-argument' || String(err?.message).includes('exceeds the maximum')) {
        get().showToast('기록이 너무 많아 클라우드에 저장하지 못했어요');
      }
      return false;
    }
  },

  // ── Photos ────────────────────────────────────────────
  // 사진 클라우드 백업은 구글 로그인 계정만 한다(익명 계정은 다른 기기에서 복구할 수 없으므로).
  _photoUid() {
    const { currentUser } = get();
    return currentUser && !currentUser.isAnonymous ? currentUser.uid : null;
  },

  uploadPhotos() {
    const uid = get()._photoUid();
    return uid ? uploadPendingPhotos(uid, () => get().currentUser?.uid === uid ? get().appState?.meals ?? [] : []) : Promise.resolve(true);
  },

  // 기기에 없으면 클라우드 사본을 받아온다. 둘 다 없으면 null.
  async loadPhoto(id) {
    const local = await getPhoto(id);
    if (local) return local;
    const uid = get()._photoUid();
    return uid ? fetchCloudPhoto(uid, id) : null;
  },

  deletePhotos(ids) {
    ids.forEach((id) => deletePhoto(id));
    const uid = get()._photoUid();
    if (uid && ids.length) deleteCloudPhotos(uid, ids);
  },

  async setUser(user) {
    set({ currentUser: toUserInfo(user), syncStatus: 'idle' });
    if (user) await get().syncCloud();
  },

  // ── Meals ─────────────────────────────────────────────
  validateMeal(meal, exceptId = null) {
    if (!MEAL_SLOTS.includes(meal.slot)) { get().showToast('올바른 끼니를 선택해주세요'); return false; }
    if (!trimMealTitle(meal.title || '')) { get().showToast('먹은 것을 입력해주세요'); return false; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(meal.date) || !Number.isFinite(dateFromKey(meal.date).getTime()) || formatDateKey(dateFromKey(meal.date)) !== meal.date || meal.date > get().today) {
      get().showToast('오늘까지의 올바른 날짜를 선택해주세요'); return false;
    }
    if (slotIsTaken(get().appState.meals, meal.slot, exceptId, meal.date)) {
      get().showToast('이 날짜에 이미 기록한 끼니예요. 다른 끼니를 선택해주세요'); return false;
    }
    return true;
  },

  addMeal(meal) {
    if (!get().validateMeal(meal)) return false;
    const { appState, saveAppState } = get();
    const next = { ...appState, meals: [...appState.meals, { ...meal, tags: tagsForSlot(meal.tags, meal.slot), updatedAt: Date.now() }] };
    return saveAppState(next);
  },

  updateMeal(id, updates) {
    const { appState, saveAppState } = get();
    const current = appState.meals.find((m) => m.id === id);
    if (!current) { get().showToast('이 기록을 찾을 수 없어요'); return false; }
    const meal = { ...current, ...updates };
    if (!get().validateMeal(meal, id)) return false;
    const next = {
      ...appState,
      meals: appState.meals.map((m) => m.id === id ? { ...meal, tags: tagsForSlot(meal.tags, meal.slot), updatedAt: Date.now() } : m),
    };
    return saveAppState(next);
  },

  deleteMeal(id) {
    const { appState, saveAppState } = get();
    const next = {
      ...appState,
      meals: appState.meals.filter((m) => m.id !== id),
      deleted: { ...appState.deleted, [id]: Date.now() },
    };
    return saveAppState(next);
  },

  // ── Favorites ─────────────────────────────────────────
  addFavorite(fav) {
    const { appState, saveAppState } = get();
    const existing = appState.favorites.find((f) => f.fromMealId === fav.fromMealId);
    if (existing) return false;
    const next = { ...appState, favorites: [{ ...fav, updatedAt: Date.now() }, ...appState.favorites] };
    return saveAppState(next);
  },

  removeFavorite(id) {
    const { appState, saveAppState } = get();
    const next = {
      ...appState,
      favorites: appState.favorites.filter((f) => f.id !== id),
      deleted: { ...appState.deleted, [id]: Date.now() },
    };
    return saveAppState(next);
  },

  isFavorite(mealId) {
    return get().appState?.favorites?.some((f) => f.fromMealId === mealId) ?? false;
  },

  // ── Tags ──────────────────────────────────────────────
  toggleTrackedTag(id) {
    const { appState, saveAppState } = get();
    const current = appState.trackedTags;
    let next;
    if (current.includes(id)) {
      next = current.filter((tid) => tid !== id);
    } else if (current.length < TRACKED_TAG_LIMIT) {
      next = [...current, id];
    } else {
      get().showToast(`요약 태그는 최대 ${TRACKED_TAG_LIMIT}개까지 선택할 수 있어요`);
      return;
    }
    saveAppState({ ...appState, trackedTags: next, settingsUpdatedAt: Date.now() });
  },

  // ── Daily Notes (Condition) ───────────────────────────
  saveCondition(dateKey, mood, memo) {
    const { appState, saveAppState } = get();
    const next = {
      ...appState,
      dailyNotes: { ...appState.dailyNotes, [dateKey]: { mood, memo, updatedAt: Date.now() } },
    };
    return saveAppState(next);
  },

  skipCondition() {
    const { appState, saveAppState, conditionSheet, today } = get();
    if (conditionSheet?.date === today && !saveAppState({ ...appState, lastConditionSkippedDate: today })) return false;
    set({ conditionSheet: null });
    return true;
  },

  setConditionPromptHour(hour) {
    const { appState, saveAppState } = get();
    if (!saveAppState({ ...appState, conditionPromptHour: hour, settingsUpdatedAt: Date.now() })) return false;
    get().refreshToday();
  },

  // ── UI Actions ────────────────────────────────────────
  setActiveTab: (tab) => set({ activeTab: tab }),
  setViewedDate: (date) => set({ viewedDate: date }),
  setDatePickerOpen: (open) => set({ datePickerOpen: open }),
  setPickerMonth: (month) => set({ pickerMonth: month }),
  openEditor: (editor) => set({ editor }),
  closeEditor: () => set({ editor: null }),
  openMealDetail: (id) => set({ mealDetailId: id }),
  closeMealDetail: () => set({ mealDetailId: null }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  setTagEditMode: (v) => set({ tagEditMode: v }),
  openPhotoViewer: (photos, index = 0) => set({ photoViewer: { photos, index } }),
  closePhotoViewer: () => set({ photoViewer: null }),

  openConditionSheet(date, selectedMood = null) {
    const hour = get().appState?.conditionPromptHour ?? 0;
    set({ conditionSheet: { date: date ?? effectiveDateKey(hour), selectedMood } });
  },
  closeConditionSheet: () => set({ conditionSheet: null }),
  setConditionSheetMood: (mood) =>
    set((s) => ({ conditionSheet: s.conditionSheet ? { ...s.conditionSheet, selectedMood: mood } : null })),

  showToast(message) {
    set({ toast: message });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: null }), 3000);
  },

  // 익명 계정이면 구글 계정을 연결해 uid(=클라우드 문서)를 그대로 유지한다.
  async signInWithGoogle() {
    const user = auth.currentUser;
    try {
      if (user?.isAnonymous) {
        try {
          const result = await linkWithPopup(user, googleProvider);
          set({ currentUser: toUserInfo(result.user) });
          get().uploadPhotos();
        } catch (err) {
          if (err?.code === 'auth/credential-already-in-use') {
            // 이미 쓰던 구글 계정: 그 계정으로 로그인하고 현재 로컬 기록을 병합한다.
            const credential = GoogleAuthProvider.credentialFromError(err);
            if (!credential) throw err;
            await signInWithCredential(auth, credential);
          } else if (isRedirectFallback(err)) {
            await linkWithRedirect(user, googleProvider);
          } else {
            throw err;
          }
        }
      } else {
        try {
          await signInWithPopup(auth, googleProvider);
        } catch (err) {
          if (!isRedirectFallback(err)) throw err;
          await signInWithRedirect(auth, googleProvider);
        }
      }
      get().showToast('로그인했어요');
    } catch (err) {
      if (err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') return;
      console.error('Google 로그인 실패:', err);
      get().showToast('로그인하지 못했어요. 잠시 후 다시 시도해주세요');
    }
  },

  // 리다이렉트 로그인에서 돌아왔을 때 결과·오류를 처리한다.
  async handleRedirectResult() {
    try {
      const result = await getRedirectResult(auth);
      if (result?.user) {
        set({ currentUser: toUserInfo(result.user) });
        get().uploadPhotos();
        get().showToast('로그인했어요');
      }
    } catch (err) {
      if (err?.code === 'auth/credential-already-in-use') {
        const credential = GoogleAuthProvider.credentialFromError(err);
        if (credential) {
          try { await signInWithCredential(auth, credential); return; } catch { /* fall through */ }
        }
      }
      console.error('Google 로그인 실패:', err);
      get().showToast('로그인하지 못했어요. 잠시 후 다시 시도해주세요');
    }
  },

  // 로그아웃하면 이 기기의 기록을 비운다(클라우드에는 남아 있어 다시 로그인하면 불러온다).
  // 사진 캐시는 기기에 그대로 둔다.
  async signOut() {
    if (!window.confirm('로그아웃하면 이 기기에서 기록이 사라져요. 다시 로그인하면 불러올 수 있어요')) return;
    if (!(await get().syncCloud())) {
      get().showToast('아직 저장되지 않은 기록이 있어요. 인터넷 연결을 확인한 뒤 다시 시도해주세요');
      return;
    }
    const empty = normalizeState({});
    const today = effectiveDateKey(empty.conditionPromptHour);
    set({ currentUser: null, appState: empty, today, viewedDate: today, mealDetailId: null, editor: null });
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    try {
      await firebaseSignOut(auth);
      get().showToast('로그아웃했어요');
    } catch (err) {
      console.error('로그아웃 실패:', err);
      // 로그아웃이 안 됐으면 계정 데이터를 다시 불러온다.
      await get().setUser(auth.currentUser);
      get().showToast('로그아웃하지 못했어요');
    }
  },

  shouldShowConditionPrompt() {
    const { appState } = get();
    const hour = appState?.conditionPromptHour ?? 0;
    const today = effectiveDateKey(hour);
    if (appState?.dailyNotes?.[today]?.mood) return false;
    if (appState?.lastConditionSkippedDate === today) return false;
    return new Date().getHours() >= (appState?.conditionPromptHour ?? 6);
  },
}));
