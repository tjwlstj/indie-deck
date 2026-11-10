import { $, el, setStatus } from '../dom.js';
import { currentLocale, t } from '../i18n.js';
import { api, mutationBlocked } from '../store.js';

const text = (key, ko, en) => t(`ui.gaming.${key}`, undefined, currentLocale().startsWith('ko') ? ko : en);
let snapshot = null, request = 0, busy = false, readError = false, registration = null;
let pendingFocus = null;

function captureSettingsFocus(body) {
  const active = document.activeElement;
  if (active && body.contains(active)) pendingFocus = active.dataset?.gamingFocus ?? null;
  // Keep a key while busy controls are temporarily disabled and focus falls
  // back to the document. Respect deliberate navigation outside this panel.
  else if (active && active !== document.body && active !== document.documentElement) pendingFocus = null;
}

function restoreSettingsFocus(body) {
  if (!pendingFocus) return;
  const control = [...body.querySelectorAll('[data-gaming-focus]')].find(node => node.dataset.gamingFocus === pendingFocus && !node.disabled);
  control?.focus({ preventScroll: true });
}

export function normalizeGamingSnapshot(value) {
  if (!value || !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      typeof value.fullscreen !== 'boolean' || typeof value.minimizeOnLaunch !== 'boolean' || typeof value.restoreOnExit !== 'boolean' ||
      !Number.isSafeInteger(value.activeGameCount) || value.activeGameCount < 0 || value.activeGameCount > 1000 ||
      !Array.isArray(value.runningGameIds) || value.runningGameIds.length !== value.activeGameCount ||
      value.runningGameIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) || new Set(value.runningGameIds).size !== value.runningGameIds.length ||
      value.settingsError !== undefined && typeof value.settingsError !== 'boolean') return null;
  return { sequence: value.sequence, fullscreen: value.fullscreen, minimizeOnLaunch: value.minimizeOnLaunch,
    restoreOnExit: value.restoreOnExit, activeGameCount: value.activeGameCount, runningGameIds: [...value.runningGameIds], settingsError: value.settingsError === true };
}

function accept(value) {
  const next = normalizeGamingSnapshot(value);
  if (!next || snapshot && next.sequence < snapshot.sequence) return false;
  snapshot = next; readError = false; return true;
}

export async function refreshGamingSettings() {
  const token = ++request;
  try {
    const value = await api.gaming.current();
    if (token !== request) return;
    if (!accept(value)) readError = true;
  } catch { if (token === request) readError = true; }
  if (token === request) renderGamingSettings();
}

export function bindGamingSettingsEvents() {
  if (typeof api.gaming?.onState === 'function') api.gaming.onState(value => {
    if (accept(value)) { request += 1; renderGamingSettings(); }
  });
  void refreshGamingSettings();
}

async function perform(task) {
  if (busy || mutationBlocked()) return;
  busy = true; request += 1; renderGamingSettings();
  try { await task(); }
  catch { setStatus(text('failed', '요청을 완료하지 못했어요. 상태를 다시 확인해 주세요.', 'The request could not be completed. Refresh the status and try again.'), 'err'); }
  finally { busy = false; renderGamingSettings(); }
}

function action(label, cls, task, disabled = false) {
  const button = el('button', `ghost ${cls}`, label);
  button.dataset.gamingFocus = cls;
  button.type = 'button'; button.disabled = busy || mutationBlocked() || disabled;
  button.addEventListener('click', () => void perform(task));
  return button;
}

function appendRegistration(container, value) {
  if (!value || typeof value.executable !== 'string' || value.executable.length > 32767 ||
      typeof value.argumentLine !== 'string' || value.argumentLine.length > 256) return;
  const card = el('div', 'gaming-registration');
  for (const [key, label, content] of [
    ['executable', text('executable', '등록할 실행 파일', 'Executable to register'), value.executable],
    ['arguments', text('arguments', '시작 옵션', 'Launch options'), value.argumentLine],
  ]) {
    const field = el('label', 'store-product-label'), input = el('input');
    input.type = 'text'; input.readOnly = true; input.value = content;
    input.dataset.gamingFocus = `registration-${key}`;
    input.addEventListener('focus', () => input.select());
    field.append(el('span', null, label), input); card.append(field);
  }
  card.append(el('p', 'settings-hint', text('copyHint', '값을 눌러 선택한 뒤 복사해 주세요. Xbox·Steam에는 실행 파일과 시작 옵션을 각각 지정해요.', 'Select a field and copy it. Enter the executable and launch options separately in Xbox or Steam.')));
  container.append(card);
}

function appendRegistrationActions(container, gameId) {
  const row = el('div', 'store-actions');
  row.append(action(text('showRegistration', '등록 정보 보기', 'Show registration details'), 'gaming-registration-show', async () => {
    const value = await api.gaming.registration(gameId);
    if (gameId) { container.querySelector('.gaming-registration')?.remove(); appendRegistration(container, value); }
    else registration = value;
  }), action(text('exportShortcut', '등록용 바로가기 만들기', 'Create registration shortcut'), 'gaming-shortcut-export', async () => {
    const result = await api.gaming.exportShortcut(gameId);
    if (result?.created) setStatus(text('shortcutCreated', '선택한 폴더에 바로가기를 만들었어요. Xbox·Steam의 추가 화면에서 등록을 마쳐 주세요.', 'Created the shortcut in your selected folder. Finish registration from the Xbox or Steam add screen.'), 'ok');
  }));
  container.append(row);
}

/** Optional detail section: the main process validates this opaque game id again. */
export function renderGameGamingActions(panel, context) {
  const gameId = context?.profile?.id;
  if (typeof gameId !== 'string' || !/^[0-9a-f]{16}$/.test(gameId) || !api.gaming) return;
  const card = el('section', 'detail-gaming');
  card.append(el('h3', null, text('gameRegistration', 'Xbox·Steam에 이 게임 연결', 'Use this game from Xbox or Steam')),
    el('p', 'settings-hint', text('gameRegistrationHint', '바로가기는 IndieDeck을 거쳐 실행해 기존 검사와 게임별 설정을 적용해요. 라이브러리에서 게임 경로가 바뀌면 다시 만들어 주세요.', 'The shortcut launches through IndieDeck so its checks and game settings still apply. Recreate it if the game location changes.')));
  appendRegistrationActions(card, gameId); panel.append(card);
}

export function renderGamingSettings() {
  const body = $('gamingSettingsBody'); if (!body) return;
  captureSettingsFocus(body);
  body.replaceChildren();
  if (!api.gaming) { body.append(el('p', 'settings-hint', text('unavailable', '이 빌드에서는 게임 모드 설정을 사용할 수 없어요.', 'Gaming mode settings are unavailable in this build.'))); return; }
  body.append(el('p', 'settings-hint', text('intro', '전체 화면과 컨트롤러 탐색으로 라이브러리를 사용하고 Xbox·Steam에서 IndieDeck을 열 수 있어요.', 'Use fullscreen and controller navigation, and open IndieDeck from Xbox or Steam.')));
  const row = el('div', 'store-actions');
  row.append(action(text(snapshot?.fullscreen ? 'fullscreenOff' : 'fullscreenOn', snapshot?.fullscreen ? '전체 화면 해제' : '전체 화면 켜기', snapshot?.fullscreen ? 'Leave fullscreen' : 'Enter fullscreen'), 'gaming-fullscreen', async () => {
    accept(await api.gaming.setFullscreen(!snapshot?.fullscreen));
  }, !snapshot || readError), action(text('refresh', '상태 새로고침', 'Refresh status'), 'gaming-refresh', refreshGamingSettings));
  body.append(row);
  if (readError) body.append(el('p', 'update-warning', text('unavailable', '게임 모드 상태를 읽지 못했어요. 다시 확인해 주세요.', 'Gaming mode status is unavailable. Refresh and try again.')));
  if (!snapshot) body.append(el('p', 'settings-hint', text('loading', '게임 모드 상태를 읽고 있어요.', 'Reading gaming mode status…')));
  if (snapshot) {
    body.append(el('p', 'settings-hint', `${text('trackingLabel', '이 런처가 실행 준비·추적 중인 게임:', 'Games starting or tracked by this launcher:')} ${snapshot.activeGameCount}`));
    if (snapshot.settingsError) body.append(el('p', 'update-warning', text('settingsError', '저장된 게임 모드 설정을 읽지 못했어요. 기존 파일을 보존하기 위해 설정 저장을 막았어요.', 'Saved gaming preferences are unavailable. Preference writes are blocked to preserve the existing file.')));
    for (const [key, ko, en] of [
      ['minimizeOnLaunch', '게임 실행 후 런처 최소화', 'Minimize the launcher after game launch'],
      ['restoreOnExit', '실행한 프로세스 종료 후 런처 복원', 'Restore the launcher after the launched process exits'],
    ]) {
      const label = el('label', 'security-launch-scan'), input = el('input'); input.type = 'checkbox'; input.checked = snapshot[key];
      input.dataset.gamingFocus = `preference-${key}`;
      input.disabled = busy || mutationBlocked() || readError || snapshot.settingsError;
      input.addEventListener('change', () => void perform(async () => { accept(await api.gaming.configure({ minimizeOnLaunch: snapshot.minimizeOnLaunch, restoreOnExit: snapshot.restoreOnExit, [key]: input.checked })); }));
      label.append(input, el('span', null, text(key, ko, en))); body.append(label);
    }
    body.append(el('p', 'settings-hint', text('restoreHint', '게임이 별도 런처나 자식 프로세스를 띄우면 종료 시점을 정확히 알 수 없어 자동 복원은 기본으로 꺼져 있어요.', 'Games can hand off to another launcher or child process, so automatic restore is off by default.')),
      el('p', 'settings-hint', text('resourceHint', '최소화는 런처의 화면 작업을 줄이는 옵션이에요. FPS 향상이나 게임의 CPU·GPU 자원 확보를 보장하지 않아요.', 'Minimizing reduces launcher display activity. It does not guarantee higher FPS or additional CPU/GPU resources for the game.')));
  }
  body.append(el('h3', null, text('registrationTitle', 'Xbox·Steam 등록', 'Xbox and Steam registration')),
    el('p', 'settings-hint', text('registrationGuide', 'Xbox 앱의 라이브러리에서 게임·앱 수동 추가를 열거나, Steam의 게임 → 비 Steam 게임 추가에서 IndieDeck 실행 파일을 선택하고 아래 시작 옵션을 지정해 주세요. 기능 위치와 제공 여부는 앱 버전에 따라 달라요.', 'Use manual game/app addition in the Xbox library, or Games → Add a Non-Steam Game in Steam. Choose the IndieDeck executable and enter the shown launch options. Availability and placement vary by app version.')));
  appendRegistrationActions(body);
  appendRegistration(body, registration);
  body.append(el('p', 'settings-hint', text('registrationBoundary', '바로가기 생성은 Xbox·Steam 등록 완료를 확인한 결과가 아니에요. Xbox mode의 Home app 등록은 별도 지원 여부 확인이 필요해요.', 'Creating a shortcut does not confirm Xbox/Steam registration. Xbox mode home-app registration requires separate support.')));
  const settings = el('div', 'store-actions');
  for (const [key, ko, en] of [['xboxMode', 'Xbox mode 설정', 'Xbox mode settings'], ['gameMode', 'Windows 게임 모드 설정', 'Windows Game Mode settings'], ['gameBar', 'Game Bar 설정', 'Game Bar settings']]) {
    settings.append(action(text(key, ko, en), `gaming-open-${key}`, async () => { await api.gaming.openSettings(key); }));
  }
  body.append(settings, el('p', 'settings-hint', text('xboxRequirements', 'Xbox mode는 Windows 11 24H2 이상과 지원 시장·기능 배포가 필요해요. Game Bar는 Win+G로 여는 오버레이예요.', 'Xbox mode requires Windows 11 24H2 or later and a supported market/rollout. Game Bar is the Win+G overlay.')));
  restoreSettingsFocus(body);
}
