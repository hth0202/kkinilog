import assert from 'node:assert/strict';
// Run a Vite dev server, then: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/ux-browser-check.mjs
// Isolated browser storage; Firebase requests are blocked.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const screenshots = await mkdtemp(join(tmpdir(), 'kkinilog-ux-'));
const appUrl = process.env.UX_APP_URL || 'http://127.0.0.1:4180/eat/';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', locale: 'ko-KR' });
await context.route(/https:\/\/.*(googleapis\.com|firebaseapp\.com|gstatic\.com).*/, r => r.abort());
const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-09-27T07:00:00Z'));
page.setDefaultTimeout(6000);
const errors = []; page.on('pageerror', e => errors.push(e.message));
let acceptConfirm = false;
page.on('dialog', d => acceptConfirm ? d.accept() : d.dismiss());
const meal = (id = 'lunch', extra = {}) => ({ id, date: '2026-09-27', slot: '점심', title: '우동', tags: ['flour', 'delivery'], photos: [], fullness: '적당함', carbs: '보통', speed: '모르겠음', memo: '회의 후 먹음', createdAt: 1, mealTime: '12:10', ...extra });
const fixture = { settingsVersion: 7, conditionPromptHour: 6, dailyNotes: { '2026-09-27': { mood: 'good', memo: '' } }, trackedTags: ['flour', 'sweet', 'veg'], meals: [meal(), meal('breakfast', { slot: '아침', title: '샐러드', tags: ['veg'] }), meal('drink', { slot: '음료', title: '물', tags: ['water'] })], favorites: [] };
async function state() { return page.evaluate(() => JSON.parse(localStorage.getItem('kkinilog-state-v1-react'))); }
async function seed(extra = {}) {
  acceptConfirm = false;
  await page.goto(appUrl);
  await page.evaluate(data => { localStorage.clear(); localStorage.setItem('kkinilog-state-v1-react', JSON.stringify(data)); }, { ...fixture, ...extra });
  await page.reload(); await page.getByRole('button', { name: '검색', exact: true }).waitFor();
}
async function failStorage() {
  await page.evaluate(() => { window.originalSet = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key === 'kkinilog-state-v1-react') throw new Error('quota'); window.originalSet.call(this, key, value); }; });
}
async function openDetail() { await page.getByRole('button', { name: /^점심 ·/ }).click(); await page.locator('#detail-title').waitFor(); }
async function openEditor() { await page.getByRole('button', { name: '오늘 끼니 기록 추가', exact: true }).click(); await page.locator('#editor-title').waitFor(); }
let failures = 0;
async function check(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (e) { failures++; console.error('FAIL', name, e.message); await page.screenshot({ path: `${screenshots}/failure-${failures}.png` }); }
}
try {
await check('new meal storage failure retains draft', async () => {
  await seed(); await openEditor(); await page.locator('#editor-title').fill('새 기록'); await failStorage();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  assert.equal(await page.locator('#editor-title').inputValue(), '새 기록');
  assert.equal((await state()).meals.length, 3); assert.match(await page.getByRole('status').innerText(), /저장하지 못/);
});
await check('detail save and delete failure retain record', async () => {
  await seed(); await openDetail(); await page.locator('#detail-title').fill('수정 기록'); await failStorage();
  await page.getByRole('button', { name: '저장', exact: true }).click(); assert.equal(await page.locator('#detail-title').inputValue(), '수정 기록');
  assert.equal((await state()).meals[0].title, '우동'); acceptConfirm = true;
  await page.getByRole('button', { name: '삭제', exact: true }).click(); assert.equal((await state()).meals.length, 3);
  assert.equal(await page.locator('#detail-title').count(), 1);
});
await check('close and repeated back cancellation preserve draft and history', async () => {
  await seed(); await openEditor(); await page.locator('#editor-title').fill('닫기 전 입력');
  await page.getByRole('button', { name: '닫기', exact: true }).click(); assert.equal(await page.locator('#editor-title').inputValue(), '닫기 전 입력');
  for (let i = 0; i < 2; i++) { await page.evaluate(() => history.back()); await page.waitForTimeout(100); assert.equal(await page.locator('#editor-title').inputValue(), '닫기 전 입력'); }
  acceptConfirm = true; await page.evaluate(() => history.back()); await page.locator('#editor-title').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '검색', exact: true }).count(), 1);
});
await check('slot switch clears hidden tags and allows alcohol', async () => {
  await seed(); await openDetail(); await page.getByRole('button', { name: '음료', exact: true }).click();
  await page.getByRole('button', { name: '술', exact: true }).click(); await page.getByRole('button', { name: '저장', exact: true }).click();
  assert.deepEqual((await state()).meals.find(m => m.id === 'lunch').tags, ['alcohol']);
});
await check('summary adds on today with date visible', async () => {
  await seed(); await page.getByRole('button', { name: '이전 날', exact: true }).click();
  await page.getByRole('button', { name: '요약', exact: true }).click(); await openEditor();
  assert.equal(await page.locator('input[type=date]').inputValue(), '2026-09-27');
  await page.locator('#editor-title').fill('요약 추가'); await page.getByRole('button', { name: '저장', exact: true }).click();
  assert.equal((await state()).meals.at(-1).date, '2026-09-27');
});
await check('tracked tags affect summary and empty selection survives', async () => {
  await seed({ trackedTags: ['caffeine'] }); await page.getByRole('button', { name: '요약', exact: true }).click();
  assert.doesNotMatch(await page.locator('main').innerText(), /채소를 챙긴 끼니|밀가루|배달\/외식/);
  await seed({ trackedTags: [] }); await page.getByRole('button', { name: '설정', exact: true }).click();
  assert.match(await page.locator('main').innerText(), /0\/5/); await page.reload();
  await page.getByRole('button', { name: '설정', exact: true }).click(); assert.match(await page.locator('main').innerText(), /0\/5/);
});
await check('date edits reject occupied slot then persist valid date', async () => {
  await seed({ meals: [...fixture.meals, meal('past', { date: '2026-09-26' })] }); await openDetail();
  await page.locator('input[type=date]').fill('2026-09-26'); await page.getByRole('button', { name: '저장', exact: true }).click();
  assert.match(await page.getByRole('status').innerText(), /이미 기록/);
  await page.locator('input[type=date]').fill('2026-09-25'); await page.getByRole('button', { name: '저장', exact: true }).click();
  assert.equal((await state()).meals.find(m => m.id === 'lunch').date, '2026-09-25');
});
await check('favorite saves current unsaved fields', async () => {
  await seed(); await openDetail(); await page.locator('#detail-title').fill('수정한 음식'); await page.getByRole('button', { name: '즐겨찾기 추가', exact: true }).click();
  assert.equal((await state()).favorites[0].title, '수정한 음식'); assert.equal((await state()).meals[0].title, '우동');
});
await check('taken slots disabled and minute precision preserved by keyboard', async () => {
  await seed(); await openDetail(); assert.equal(await page.getByRole('button', { name: '아침', exact: true }).isDisabled(), true);
  const minute = page.getByRole('spinbutton', { name: '분 · 방향키로 선택', exact: true });
  assert.equal(await minute.getAttribute('aria-valuetext'), '10'); await minute.focus(); await minute.press('ArrowDown'); await page.waitForTimeout(800);
  await page.getByRole('button', { name: '저장', exact: true }).click(); assert.equal((await state()).meals[0].mealTime, '12:11');
});
await check('drinks excluded from meal and fullness totals', async () => {
  await seed({ meals: [meal('water', { slot: '음료', tags: ['water'] })] }); await page.getByRole('button', { name: '요약', exact: true }).click();
  for (const label of ['기록한 끼니', '적당한 포만감']) assert.equal(await page.locator('div').filter({ has: page.locator('span', { hasText: label }) }).filter({ has: page.locator('strong') }).last().locator('strong').innerText(), '0');
});
await check('search covers slot tag memo and Escape closes it', async () => {
  await seed(); await page.getByRole('button', { name: '검색', exact: true }).click(); const input = page.getByRole('textbox', { name: '먹은 것, 끼니, 태그, 메모 검색' });
  for (const query of ['점심', '밀가루', '회의']) { await input.fill(query); assert.equal(await page.getByRole('dialog', { name: '기록 검색', exact: true }).getByRole('button', { name: /^점심 ·/ }).count(), 1); }
  await input.press('Escape'); await input.waitFor({ state: 'hidden' });
});
await check('Tab stays inside detail dialog', async () => {
  await seed(); await openDetail();
  const save = page.getByRole('button', { name: '저장', exact: true }); await save.focus(); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.closest('[aria-modal=true]')?.getAttribute('aria-label')), '끼니 수정');
});
await check('past period copy is accurate', async () => {
  await seed({ meals: [meal('past', { date: '2026-09-20' })] }); await page.getByRole('button', { name: '요약', exact: true }).click();
  await page.getByRole('button', { name: '이전 주', exact: true }).click(); assert.doesNotMatch(await page.locator('main').innerText(), /이번 주/);
});
await check('slow photo blocks save and preserves processed photo', async () => {
  await seed(); await openEditor(); await page.locator('#editor-title').fill('사진 처리 테스트');
  await page.evaluate(() => { const NativeImage = window.Image; window.Image = class extends NativeImage { set src(value) { setTimeout(() => { super.src = value; }, 600); } }; });
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh7kAAAAASUVORK5CYII=', 'base64') });
  assert.equal(await page.getByRole('button', { name: '사진 처리 중…', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '저장', exact: true }).waitFor(); await page.getByRole('button', { name: '저장', exact: true }).click();
  assert.equal((await state()).meals.at(-1).photos.length, 1);
});
await check('320px photo menu stays in hero and search has no overflow', async () => {
  await seed(); await page.setViewportSize({ width: 320, height: 568 });
  await page.evaluate(async () => { const { putPhoto } = await import('/eat/src/utils/photoDB.js'); await putPhoto('existing', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh7kAAAAASUVORK5CYII='); const data = JSON.parse(localStorage.getItem('kkinilog-state-v1-react')); data.meals[0].photos = ['existing']; localStorage.setItem('kkinilog-state-v1-react', JSON.stringify(data)); });
  await page.reload(); await openDetail(); await page.getByRole('button', { name: '사진 편집', exact: true }).click();
  const add = page.getByRole('button', { name: '추가', exact: true }); await add.waitFor(); const box = await add.boundingBox(); const menu = await add.locator('..').boundingBox();
  assert.ok(box.y >= menu.y && box.y + box.height <= menu.y + menu.height);
  await page.screenshot({ path: `${screenshots}/detail-320.png` }); await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '검색', exact: true }).click(); await page.getByRole('textbox').fill('회의');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${screenshots}/search-320.png` });
});
await check('empty date keeps editor open and reports validation', async () => {
  await seed(); await openEditor(); await page.locator('#editor-title').fill('날짜 확인');
  await page.locator('input[type=date]').fill(''); await page.getByRole('button', { name: '저장', exact: true }).click();
  assert.match(await page.getByRole('status').innerText(), /올바른 날짜/); assert.equal(await page.locator('#editor-title').inputValue(), '날짜 확인');
});
await check('tag limit explains refusal, selected tags expose state', async () => {
  await seed({ trackedTags: ['flour', 'sweet', 'veg', 'caffeine', 'carbonated'] });
  await page.getByRole('button', { name: '설정', exact: true }).click(); await page.getByRole('button', { name: '편집', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '밀가루', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: '술', exact: true }).click(); assert.match(await page.getByRole('status').innerText(), /최대 5개/);
  assert.equal((await state()).trackedTags.length, 5);
});
await check('photo limit announces count and attaches five', async () => {
  await seed(); await openEditor(); await page.locator('#editor-title').fill('사진 여섯 장');
  const buffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh7kAAAAASUVORK5CYII=', 'base64');
  await page.locator('input[type=file][multiple]').setInputFiles(Array.from({ length: 6 }, (_, i) => ({ name: `${i}.png`, mimeType: 'image/png', buffer })));
  await page.getByRole('button', { name: '저장', exact: true }).waitFor(); assert.match(await page.getByRole('status').innerText(), /최대 5장/);
  await page.getByRole('button', { name: '저장', exact: true }).click(); assert.equal((await state()).meals.at(-1).photos.length, 5);
});
await check('canceling photo removal retains original file', async () => {
  await seed(); await page.evaluate(async () => { const { putPhoto } = await import('/eat/src/utils/photoDB.js'); await putPhoto('keep-photo', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh7kAAAAASUVORK5CYII='); const data = JSON.parse(localStorage.getItem('kkinilog-state-v1-react')); data.meals[0].photos = ['keep-photo']; localStorage.setItem('kkinilog-state-v1-react', JSON.stringify(data)); });
  await page.reload(); await openDetail(); await page.getByRole('button', { name: '사진 편집', exact: true }).click();
  acceptConfirm = true; await page.getByRole('button', { name: '삭제', exact: true }).first().click(); await page.getByRole('button', { name: '닫기', exact: true }).click();
  assert.equal((await state()).meals[0].photos.length, 1);
  assert.ok(await page.evaluate(async () => (await import('/eat/src/utils/photoDB.js')).getPhoto('keep-photo')));
});
await check('nested search/detail restores focus, closes only top overlay', async () => {
  await seed(); await page.getByRole('button', { name: '검색', exact: true }).click(); await page.getByRole('textbox').fill('우동');
  await page.getByRole('dialog', { name: '기록 검색', exact: true }).getByRole('button', { name: /^점심 ·/ }).click();
  await page.locator('#detail-title').waitFor(); await page.keyboard.press('Escape'); await page.locator('#detail-title').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('dialog', { name: '기록 검색', exact: true }).count(), 1);
  await page.keyboard.press('Escape'); await page.getByRole('dialog', { name: '기록 검색', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.body.style.overflow), '');
});
await check('desktop and mobile share the same shell, navigation and overlays', async () => {
  await page.evaluate(async () => { const { putPhoto } = await import('/eat/src/utils/photoDB.js'); await putPhoto('layout-photo', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh7kAAAAASUVORK5CYII='); });
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 }); await seed({ meals: [meal('lunch', { photos: ['layout-photo'] })] });
    const shell = await page.locator('.app-shell').boundingBox();
    assert.ok(shell.width <= 464 && shell.width <= width);
    if (width > 464) assert.equal(shell.width, 464);
    const matchesShell = async locator => {
      const box = await locator.boundingBox();
      assert.ok(Math.abs(box.x - shell.x) < 1 && Math.abs(box.width - shell.width) < 1, JSON.stringify({ width, shell, box }));
    };
    await matchesShell(page.locator('nav'));
    if (width === 1440) await page.screenshot({ path: `${screenshots}/home-desktop.png` });
    await openEditor(); await matchesShell(page.getByRole('dialog', { name: '끼니 기록', exact: true }));
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    await openDetail(); await matchesShell(page.getByRole('dialog', { name: '끼니 수정', exact: true }));
    await page.getByAltText('식사 사진', { exact: true }).click();
    await matchesShell(page.getByRole('dialog', { name: '사진 보기', exact: true }));
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    await page.getByRole('button', { name: '검색', exact: true }).click();
    await matchesShell(page.getByRole('dialog', { name: '기록 검색', exact: true }));
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '컨디션 수정', exact: true }).click();
    await matchesShell(page.getByRole('dialog', { name: '컨디션 기록', exact: true }));
    await page.keyboard.press('Escape');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
});
await check('no page runtime errors', async () => assert.deepEqual(errors, []));
console.log(`${failures} browser failure(s); screenshots: ${screenshots}`);
} finally { await browser.close(); }
process.exit(failures ? 1 : 0);
