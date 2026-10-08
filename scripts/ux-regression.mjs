// Run: node scripts/ux-regression.mjs. Firebase is mocked; no account or cloud writes.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const reportError = console.error.bind(console);
console.error = (message, err) => reportError(`${message}${err ? ` ${err.message}` : ''}`);

const root = fileURLToPath(new URL('../', import.meta.url));
const result = await build({
  stdin: { contents: `export { useAppStore } from './src/store/appStore.js';
    export * from './src/utils/meal.js'; export * from './src/utils/insights.js';
    export * from './src/constants.js';`, resolveDir: root },
  bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'offline-firebase', setup(build) {
    build.onResolve({ filter: /^(firebase\/|.*\/firebase$)/ }, ({ path }) => ({ path, namespace: 'mock' }));
    build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents:
      path === 'firebase/firestore'
        ? `export const doc = (...args) => args; export const serverTimestamp = () => null;
           export const runTransaction = (...args) => globalThis.cloudTransaction(...args);
           export const getDoc = async () => ({ exists: () => false });
           export const setDoc = async () => {}; export const deleteDoc = async () => {};
           export const Bytes = { fromUint8Array: x => x };`
        : path === 'firebase/auth'
          ? `export class GoogleAuthProvider { static credentialFromError() { return null; } }
             export const getRedirectResult = async () => null;
             export const linkWithPopup = async () => {}; export const linkWithRedirect = async () => {};
             export const signInWithCredential = async () => {}; export const signInWithPopup = async () => {};
             export const signInWithRedirect = async () => {}; export const signOut = async () => {};`
          : `export const db = {}; export const auth = {}; export const googleProvider = {};`,
    }));
  } }],
});
const { useAppStore, STORAGE_KEY, tagsForSlot, applyTagToggle, migrateSpeed, todayInsight, flowInsight, getWeekHighlights } =
  await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const stored = new Map();
let failStorage = false;
globalThis.localStorage = {
  getItem: key => stored.get(key) ?? null,
  setItem: (key, value) => { if (failStorage) throw new Error('quota'); stored.set(key, value); },
  removeItem: key => stored.delete(key),
};
const get = useAppStore.getState;
const meal = (id = 'meal', extra = {}) => ({ id, date: '2026-09-27', slot: '점심', title: '밥', tags: [],
  photos: [], fullness: '적당함', carbs: '보통', speed: '모르겠음', memo: '', createdAt: 1, ...extra });
function reset(extra = {}) {
  failStorage = false;
  stored.set(STORAGE_KEY, JSON.stringify({ meals: [meal()], favorites: [{ id: 'favorite', fromMealId: 'meal' }],
    trackedTags: [], dailyNotes: {}, conditionPromptHour: 0, ...extra }));
  useAppStore.setState({ currentUser: null, conditionSheet: null });
  get().initState();
}
let failures = 0;
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (err) { failures++; console.error(`FAIL ${name}: ${err.message}`); }
}
for (const [name, change] of [
  ['add', () => get().addMeal(meal('new', { slot: '간식' }))],
  ['update', () => get().updateMeal('meal', { title: '수정' })],
  ['delete', () => get().deleteMeal('meal')],
  ['favorite', () => get().addFavorite({ id: 'new-fav', fromMealId: 'other' })],
  ['remove favorite', () => get().removeFavorite('favorite')],
  ['condition', () => get().saveCondition('2026-09-27', 'good', '메모')],
]) await check(`storage failure preserves ${name}`, () => {
  reset(); const before = get().appState; failStorage = true;
  assert.equal(change(), false); assert.equal(get().appState, before);
  assert.match(get().toast, /저장하지 못/);
});
await check('empty tracked tags survives reload', () => { reset(); assert.deepEqual(get().appState.trackedTags, []); });
await check('past condition skip leaves today unchanged', () => {
  reset(); get().openConditionSheet('2000-01-01'); get().skipCondition();
  assert.equal(get().appState.lastConditionSkippedDate, null); assert.equal(get().conditionSheet, null);
});
await check('slot rules remove hidden tags, keep alcohol for drinks', () => {
  assert.deepEqual(tagsForSlot(['flour', 'delivery', 'caffeine', 'alcohol'], '음료'), ['caffeine', 'alcohol']);
});
await check('comfortable conflicts with discomfort, discomfort can coexist', () => {
  assert.deepEqual(applyTagToggle(['comfortable'], 'heartburn'), ['heartburn']);
  assert.deepEqual(applyTagToggle(['heartburn', 'stomachache'], 'comfortable'), ['comfortable']);
  assert.deepEqual(applyTagToggle(['bloat'], 'heartburn'), ['bloat', 'heartburn']);
});
await check('existing speed migrates to continuous range', () => assert.equal(migrateSpeed('30-50분 이내'), '20분 초과~1시간 미만'));
await check('carbs none never claims carbohydrate balance', () => {
  assert.doesNotMatch(todayInsight([meal('m', { carbs: '없음', fullness: '가볍게 먹음', tags: ['veg', 'protein'] })], { veg: 1, protein: 1 }), /탄수화물까지/);
});
await check('weekly copy reports real counts and selected period', () => {
  const week = Array.from({ length: 21 }, (_, i) => meal(String(i), { fullness: '가볍게 먹음', speed: i < 5 ? '20분 이내' : '모르겠음' }));
  assert.doesNotMatch(flowInsight(week, {}, 0, '지난주'), /거의 매 끼니|이번 주/);
  assert.doesNotMatch(flowInsight(week.map(m => ({ ...m, speed: '모르겠음' })), { delivery: 5 }), /대부분|배달이/);
  assert.doesNotMatch(getWeekHighlights(week, {}, 0, '지난주').map(h => h.text).join(' '), /모두|이번 주/);
});
await check('weekly insight shows findings and advice or short guidance', () => {
  const neutral = Array.from({ length: 26 }, (_, i) => meal(String(i), { fullness: '가볍게 먹음' }));
  for (const meals of [[], [meal()], [meal('drink', { slot: '음료' })], neutral]) {
    assert.equal(flowInsight(meals, {}, 0, '이번 주', []), '아직 눈에 띄는 식습관 특징은 없어요');
  }
  const fast = neutral.slice(0, 3).map(m => ({ ...m, speed: '20분 이내' }));
  assert.match(flowInsight(fast, {}), /3끼.*천천히/);
  const past = flowInsight(fast, {}, 0, '지난주');
  assert.match(past, /지난주.*3끼.*천천히/);
  assert.doesNotMatch(past, /이번 주|다음 주/);
  assert.match(flowInsight(neutral, { veg: 5, protein: 6 }), /채소를 5번, 단백질을 6번.*함께 챙겨봐요/);
  assert.match(flowInsight(neutral.slice(0, 4).map(m => ({ ...m, fullness: '적당함' })), {}, 0, '지난주'), /4번.*앞으로도.*살펴봐요/);
  assert.match(flowInsight([meal()], { sweet: 2 }, 0, '지난주'), /지난주.*앞으로는 조금 줄여봐요/);
});
await check('duplicate main meal cannot be saved', () => {
  reset(); assert.equal(get().addMeal(meal('duplicate')), false); assert.equal(get().appState.meals.length, 1);
});
await check('invalid and future dates cannot be saved', () => {
  reset(); assert.equal(get().addMeal(meal('bad', { date: '2026-02-30' })), false);
  assert.equal(get().addMeal(meal('future', { date: '2999-01-01' })), false);
});
await check('successful save persists before success, filters tags', () => {
  reset(); assert.equal(get().addMeal(meal('drink', { slot: '음료', tags: ['flour', 'water'] })), true);
  assert.deepEqual(JSON.parse(stored.get(STORAGE_KEY)).meals.at(-1).tags, ['water']);
});
await check('cloud status exposes success and failure', async () => {
  reset(); useAppStore.setState({ currentUser: { uid: 'offline-test', isAnonymous: true } });
  globalThis.cloudTransaction = async () => { throw new Error('offline'); };
  assert.equal(await get().syncCloud(), false); assert.equal(get().syncStatus, 'error');
  globalThis.cloudTransaction = async () => get().appState;
  assert.equal(await get().syncCloud(), true); assert.equal(get().syncStatus, 'synced');
});
console.log(`${failures} failure(s)`);
process.exit(failures ? 1 : 0);
