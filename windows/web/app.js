// The window of Slovo for Windows: the screens of the Mac app (drop zone, progress, result) drawn from the state that
// the local server sends.
import { applyFormat, mergeFormat, render as renderFormat, wordCount, CASE_MODES, FORMATS } from "./transform.js";

const token = document.querySelector('meta[name="token"]').content;
const view = document.getElementById("view");
const sheet = document.getElementById("sheet");
const toast = document.getElementById("toast");

const state = {
  version: "",
  settings: {},
  models: [],
  job: null,
  upload: null, // {name, progress, handle} while a file is handed to the server
  fileHandle: null, // the file being transcribed, where Save opens
  edits: {}, // edited text by format
  sheet: null, // "settings" or "models"
  rerun: false,
  flash: null, // "copied" or "saved", for a moment
};

// MARK: - Words and numbers

const ICONS = {
  // Feather icons (MIT) and simple strokes.
  waveform: '<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>',
  silence: '<path d="M3 12h3M9 8v8M12 5v14M15 8v8M18 12h3"/>',
  scope: '<circle cx="12" cy="12" r="9"/><path d="M21 12h-4M7 12H3M12 7V3M12 21v-4"/>',
  model: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  xmark: '<path d="M6 6l12 12M18 6L6 18"/>',
  rotate: '<path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 2v7h7"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
};
const icon = (name, size = 16) => `<svg class="icon" viewBox="0 0 24 24" style="--size:${size}px" aria-hidden="true">${ICONS[name]}</svg>`;
const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const FORMAT_TITLES = { text: "Текст", timecodes: "Таймкоды", srt: "SRT" };
const MODE_SHORT = { original: "Аа ,.!?", originalNoPunctuation: "Аа", lowercase: "аа ,.!?", lowercaseNoPunctuation: "аа" };
const MODE_TITLES = {
  original: "Заглавные и строчные, со знаками препинания",
  originalNoPunctuation: "Заглавные и строчные, без знаков препинания",
  lowercase: "Все строчные, со знаками препинания",
  lowercaseNoPunctuation: "Все строчные, без знаков препинания",
};

/** Languages shown first, then every language Whisper knows. */
const COMMON_LANGUAGES = ["ru", "en", "uk", "be", "kk", "uz", "hy", "ka", "az", "de", "fr", "es", "it", "pt", "pl", "tr", "zh", "ja", "ko", "ar", "he"];
const ALL_LANGUAGES = ("en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml "
  + "cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo "
  + "ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue").split(" ");
const languageNames = new Intl.DisplayNames(["ru"], { type: "language" });

function languageName(code) {
  if (code === "auto") return "Определить автоматически";
  let name = code;
  try {
    name = languageNames.of(code === "jw" ? "jv" : code) || code;
  } catch {}
  return name.charAt(0).toLocaleUpperCase("ru") + name.slice(1);
}

function plural(n, one, few, many) {
  const tens = n % 100, units = n % 10;
  if (units === 1 && tens !== 11) return one;
  return units >= 2 && units <= 4 && (tens < 12 || tens > 14) ? few : many;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const minutes = Math.floor(total / 60), hours = Math.floor(minutes / 60);
  if (total < 60) return `${total} с`;
  if (hours) return `${hours} ч ${minutes % 60} мин`;
  return minutes < 10 && total % 60 ? `${minutes} мин ${total % 60} с` : `${minutes} мин`;
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toLocaleString("ru", { maximumFractionDigits: 2 })} ГБ`;
  return `${Math.max(0, Math.round(bytes / 1e6))} МБ`;
}

const baseName = (name) => (name || "Расшифровка").replace(/\.[^.]+$/, "");
const shortName = (name) => (name || "").replace(/^Whisper /, "");

// MARK: - State

const PREFERRED = ["large-v3-turbo-q8_0", "large-v3-turbo-q5_0", "large-v3-q5_0"];
const format = () => (FORMATS.includes(state.settings.format) ? state.settings.format : "text");
const mode = () => (CASE_MODES.includes(state.settings.caseMode) ? state.settings.caseMode : "original");
const busy = () => Boolean(state.upload) || state.job?.status === "working";

function currentModel() {
  const downloaded = state.models.filter((m) => m.downloaded);
  return downloaded.find((m) => m.id === state.settings.model)
    ?? PREFERRED.map((id) => downloaded.find((m) => m.id === id)).find(Boolean)
    ?? downloaded[0];
}

/** The text of a format with the user's edits, before the case and punctuation variant. */
const baseText = (f) => state.edits[f] ?? renderFormat(f, state.job?.segments ?? []);

async function api(path, body = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "X-Slovo-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Ошибка ${response.status}`);
  return result;
}

function saveSettings(patch) {
  Object.assign(state.settings, patch);
  api("/api/settings", patch).catch(showError);
}

async function loadState() {
  const data = await (await fetch("/api/state", { cache: "no-store" })).json();
  state.version = data.version;
  state.settings = data.settings;
  state.models = data.models ?? [];
  setJob(data.job);
  render();
}

function setJob(job) {
  if (job) job.segments ??= [];
  if (job && job.id !== state.job?.id) {
    state.edits = {};
    state.rerun = false;
    // Another pass keeps the file; a file opened from Explorer has no place to save to.
    if (state.upload) state.fileHandle = state.upload.handle;
    else if (job.fileName !== state.job?.fileName) state.fileHandle = null;
  }
  if (job?.status === "working") state.upload = null;
  state.job = job;
}

function connect() {
  const events = new EventSource("/api/events");
  events.addEventListener("open", () => loadState().catch(() => {}));
  events.addEventListener("job", (event) => {
    const job = JSON.parse(event.data);
    if (job && state.job && job.id === state.job.id) {
      const segments = state.job.segments;
      Object.assign(state.job, job, { segments });
      if (job.status === "working") state.upload = null;
      if (job.segmentCount !== segments.length) return void loadState();
    } else {
      setJob(job);
      if (job?.segmentCount) return void loadState();
    }
    render();
  });
  events.addEventListener("segment", (event) => {
    const { job, index, segment } = JSON.parse(event.data);
    if (!state.job || state.job.id !== job || index !== state.job.segments.length) return void loadState();
    state.job.segments.push(segment);
    updateLive();
  });
  events.addEventListener("models", (event) => {
    state.models = JSON.parse(event.data);
    render();
  });
}

// MARK: - Screens

let current = { key: "", update: () => {} };

function viewKey() {
  const job = state.job;
  if (busy()) return "work";
  if (job?.status === "done") return `result:${job.id}`;
  if (job?.status === "error") return `error:${job.id}`;
  return state.models.some((m) => m.downloaded) ? "idle" : "setup";
}

function render() {
  const key = viewKey();
  if (key !== current.key) {
    const build = { work: buildWork, result: buildResult, error: buildError, idle: buildIdle, setup: buildSetup }[key.split(":")[0]];
    current = { key, update: build() };
  }
  current.update();
  renderSheet();
  const job = state.job;
  document.title = job?.status === "working" && job.step === "speech" ? `${Math.floor(job.progress * 100)}% · Slovo` : "Slovo";
}

function refs(root) {
  const found = {};
  root.querySelectorAll("[data-ref]").forEach((element) => { found[element.dataset.ref] = element; });
  return found;
}

function fillModels(select, selected) {
  const models = state.models.filter((m) => m.downloaded);
  const signature = models.map((m) => m.id).join("|");
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.innerHTML = models.map((m) => `<option value="${escape(m.id)}">${escape(m.name)}</option>`).join("")
      + '<option disabled>──────────</option><option value="__models">Скачать другие модели…</option>';
  }
  if (selected) select.value = selected;
}

function fillLanguages(select) {
  const option = (code) => `<option value="${code}">${escape(languageName(code))}</option>`;
  const others = ALL_LANGUAGES.filter((code) => !COMMON_LANGUAGES.includes(code))
    .sort((a, b) => languageName(a).localeCompare(languageName(b), "ru"));
  select.innerHTML = option("auto") + COMMON_LANGUAGES.map(option).join("")
    + `<optgroup label="Все языки">${others.map(option).join("")}</optgroup>`;
}

function buildIdle() {
  view.innerHTML = `
    <section class="card drop">
      <button class="icon-button corner" data-action="settings" title="Настройки (Ctrl+,)">${icon("gear")}</button>
      <div class="drop-circle">${icon("waveform", 32)}</div>
      <div class="drop-title" data-ref="title"></div>
      <button class="button primary large" data-action="choose" title="Открыть файл (Ctrl+O)">Выбрать файл</button>
      <div class="drop-hint">MP3, M4A, WAV, MP4, MOV, MKV и любые другие форматы. Распознавание идёт на этом компьютере, без интернета</div>
    </section>
    <section class="tiles">
      <label class="tile" title="Модель распознавания">
        <span class="tile-icon">${icon("model")}</span>
        <span class="tile-text"><span class="tile-title">Модель</span><span class="tile-value" data-ref="modelValue"></span></span>
        <select data-ref="model" aria-label="Модель"></select>
      </label>
      <label class="tile" title="Язык записи">
        <span class="tile-icon">${icon("globe")}</span>
        <span class="tile-text"><span class="tile-title">Язык</span><span class="tile-value" data-ref="languageValue"></span></span>
        <select data-ref="language" aria-label="Язык"></select>
      </label>
      <button class="tile" data-ref="skipSilence" data-action="toggle" data-setting="skipSilence"
        title="Whisper не придумывает фразы там, где никто не говорит. Если пропадают тихие реплики, выключите пропуск тишины">
        <span class="tile-icon">${icon("silence")}</span>
        <span class="tile-text"><span class="tile-title">Пропуск тишины</span><span class="tile-value"></span></span>
      </button>
      <button class="tile" data-ref="accurate" data-action="toggle" data-setting="accurate"
        title="Whisper перебирает несколько вариантов каждой фразы: ошибок меньше, но распознавание медленнее">
        <span class="tile-icon">${icon("scope")}</span>
        <span class="tile-text"><span class="tile-title">Точный режим</span><span class="tile-value"></span></span>
      </button>
    </section>`;
  const r = refs(view);
  fillLanguages(r.language);
  r.model.addEventListener("change", () => {
    if (r.model.value === "__models") {
      r.model.value = currentModel()?.id ?? "";
      return openSheet("models");
    }
    saveSettings({ model: r.model.value });
    render();
  });
  r.language.addEventListener("change", () => {
    saveSettings({ language: r.language.value });
    render();
  });
  return () => {
    const model = currentModel();
    fillModels(r.model, model?.id);
    r.modelValue.textContent = shortName(model?.name);
    const language = state.settings.language || "ru";
    r.language.value = language;
    r.languageValue.textContent = languageName(language);
    for (const key of ["skipSilence", "accurate"]) {
      const on = Boolean(state.settings[key]);
      r[key].classList.toggle("on", on);
      r[key].setAttribute("aria-pressed", String(on));
      r[key].querySelector(".tile-value").textContent = on ? "Вкл." : "Выкл.";
    }
    r.title.textContent = dropping ? "Отпустите файл" : "Перетащите аудио или видео";
  };
}

/** First launch: no model yet. */
function buildSetup() {
  view.innerHTML = `
    <section class="card drop">
      <button class="icon-button corner" data-action="settings" title="Настройки">${icon("gear")}</button>
      <div class="drop-circle">${icon("download", 30)}</div>
      <div class="drop-title">Скачайте модель распознавания</div>
      <div class="setup-text" data-ref="text"></div>
      <div class="setup-action" data-ref="action"></div>
      <button class="link" data-action="models">Другие модели</button>
    </section>`;
  const r = refs(view);
  let shown = "";
  return () => {
    const model = state.models.find((m) => m.recommended) ?? state.models[0];
    if (!model) return;
    r.text.textContent = `${model.name}, ${formatBytes(model.size)}. ${model.details}. `
      + "Модель скачивается один раз, дальше Slovo работает без интернета";
    const html = model.downloading ? progressHTML(model)
      : `<button class="button primary large" data-action="download" data-id="${escape(model.id)}">Скачать</button>`
        + (model.error ? `<div class="error-text">${escape(model.error)}</div>` : "");
    if (html !== shown) r.action.innerHTML = shown = html;
  };
}

function progressHTML(model) {
  const percent = model.size ? (model.received / model.size) * 100 : 0;
  return `<div class="download-progress">
      <div class="bar${model.verifying ? " indeterminate" : ""}"><div class="bar-fill" style="width:${percent.toFixed(1)}%"></div></div>
      <div class="download-row">
        <span>${model.verifying ? "Проверяю файл…" : `${formatBytes(model.received)} из ${formatBytes(model.size)}`}</span>
        ${model.verifying ? "" : `<button class="link" data-action="cancel-download" data-id="${escape(model.id)}">Отменить</button>`}
      </div>
    </div>`;
}

function buildWork() {
  view.innerHTML = `
    <section class="card">
      <div class="file-row">
        <div class="file-icon">${icon("file")}</div>
        <div class="file-text"><div class="file-name" data-ref="name"></div><div class="file-subtitle" data-ref="subtitle"></div></div>
        <button class="icon-button" data-action="cancel" title="Отменить (Esc)">${icon("xmark")}</button>
      </div>
      <div class="divider"></div>
      <div class="progress-section">
        <div class="progress-head"><span data-ref="step"></span><span class="percent" data-ref="percent"></span></div>
        <div class="bar" data-ref="bar"><div class="bar-fill" data-ref="fill"></div></div>
        <div class="progress-foot"><span class="ellipsis" data-ref="model"></span><span data-ref="remaining"></span></div>
      </div>
    </section>
    <section class="card text-card">
      <div class="live" data-ref="live"></div>
      <div class="live-empty" data-ref="empty">${icon("waveform", 26)}</div>
    </section>`;
  const r = refs(view);
  let shownSegments = -1;
  return () => {
    const job = state.job?.status === "working" ? state.job : null;
    const upload = job ? null : state.upload;
    const steps = { audio: "Извлекаю звук…", model: "Загружаю модель…", speech: "Распознаю речь…" };
    const progress = upload ? upload.progress : job?.progress ?? -1;
    r.name.textContent = upload?.name ?? job?.fileName ?? "";
    r.subtitle.textContent = job?.duration ? formatDuration(job.duration) : "Читаю файл…";
    r.step.textContent = upload ? "Читаю файл…" : steps[job?.step] ?? "Готовлюсь…";
    r.bar.classList.toggle("indeterminate", progress < 0);
    r.fill.style.width = progress < 0 ? "" : `${(progress * 100).toFixed(1)}%`;
    r.percent.textContent = progress < 0 ? "" : `${Math.floor(progress * 100)}%`;
    r.model.textContent = job?.modelName ?? currentModel()?.name ?? "";
    r.remaining.textContent = remainingText(job);
    const count = job?.segments.length ?? 0;
    if (count !== shownSegments) {
      shownSegments = count;
      updateLive();
    }
  };
}

function remainingText(job) {
  if (!job || job.step !== "speech" || !job.speechStarted || job.progress < 0.02) return "";
  const elapsed = (Date.now() - job.speechStarted) / 1000;
  if (elapsed < 5) return "";
  return `Осталось примерно ${formatDuration(Math.max(1, (elapsed * (1 - job.progress)) / job.progress))}`;
}

/** Phrases as they come, in the chosen format and variant. */
function updateLive() {
  if (current.key !== "work") return;
  const live = view.querySelector('[data-ref="live"]'), empty = view.querySelector('[data-ref="empty"]');
  const segments = state.job?.status === "working" ? state.job.segments : [];
  const atEnd = live.scrollTop + live.clientHeight >= live.scrollHeight - 40;
  live.textContent = applyFormat(format(), mode(), renderFormat(format(), segments));
  empty.hidden = segments.length > 0;
  if (atEnd) live.scrollTop = live.scrollHeight;
}

function buildResult() {
  view.innerHTML = `
    <section class="card" data-ref="top"></section>
    <section class="card text-card">
      <div class="result-head">
        <div class="segment-groups">
          <div class="segments" role="group" aria-label="Вид">${FORMATS.map((f) =>
            `<button data-action="format" data-value="${f}">${FORMAT_TITLES[f]}</button>`).join("")}</div>
          <div class="segments" role="group" aria-label="Регистр и знаки препинания">${CASE_MODES.map((m) =>
            `<button data-action="mode" data-value="${m}" title="${MODE_TITLES[m]}">${MODE_SHORT[m]}</button>`).join("")}</div>
        </div>
        <div class="words" data-ref="words"></div>
      </div>
      <div class="divider"></div>
      <textarea class="transcript" data-ref="text" spellcheck="false" aria-label="Текст расшифровки"></textarea>
    </section>
    <div class="actions">
      <button class="link" data-ref="revert" data-action="revert" title="Вернуть исходный текст, правки в этом виде пропадут">${icon("undo", 14)}Вернуть</button>
      <span class="spacer"></span>
      <button class="button secondary" data-ref="save" data-action="save" title="Сохранить в файл (Ctrl+S)">Сохранить</button>
      <button class="button primary" data-ref="copy" data-action="copy" title="Скопировать весь текст (Ctrl+Shift+C)">Скопировать</button>
    </div>`;
  const r = refs(view);
  const updateMeta = () => {
    const words = wordCount(r.text.value);
    r.words.textContent = `${words.toLocaleString("ru")} ${plural(words, "слово", "слова", "слов")}`;
    r.words.title = `Готово за ${formatDuration(state.job.elapsed)}`;
    r.revert.hidden = state.edits[format()] === undefined;
    r.save.textContent = state.flash === "saved" ? "Сохранено" : "Сохранить";
    r.copy.textContent = state.flash === "copied" ? "Скопировано" : "Скопировать";
  };
  // An edit of the shown variant goes back into the text, so capitals and marks the user did not touch stay.
  r.text.addEventListener("input", () => {
    const f = format(), m = mode();
    const merged = mergeFormat(f, r.text.value, baseText(f), m);
    if (merged === renderFormat(f, state.job.segments)) delete state.edits[f];
    else state.edits[f] = merged;
    const shown = applyFormat(f, m, merged);
    if (shown !== r.text.value) {
      const fromEnd = r.text.value.length - r.text.selectionEnd;
      r.text.value = shown;
      const caret = Math.max(0, shown.length - fromEnd);
      r.text.setSelectionRange(caret, caret);
    }
    updateMeta();
  });
  let top = "", shownKey = "";
  return () => {
    const job = state.job;
    if ((state.rerun ? "rerun" : "file") !== top) {
      top = state.rerun ? "rerun" : "file";
      r.top.innerHTML = state.rerun ? rerunHTML() : fileRowHTML(job);
      if (state.rerun) setupRerun(r.top);
    }
    view.querySelectorAll('[data-action="format"]').forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === format())));
    view.querySelectorAll('[data-action="mode"]').forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === mode())));
    const key = `${format()}|${mode()}|${state.edits[format()] ?? ""}`;
    if (key !== shownKey) {
      shownKey = key;
      const shown = applyFormat(format(), mode(), baseText(format()));
      if (r.text.value !== shown) r.text.value = shown;
    }
    updateMeta();
  };
}

function fileRowHTML(job) {
  const subtitle = [formatDuration(job.duration), job.modelName, job.language === "auto" ? "" : languageName(job.language)]
    .filter(Boolean).join(" · ");
  return `<div class="file-row">
      <div class="file-icon">${icon("file")}</div>
      <div class="file-text"><div class="file-name">${escape(job.fileName)}</div><div class="file-subtitle">${escape(subtitle)}</div></div>
      <button class="icon-button" data-action="rerun" title="Распознать заново, например другой моделью">${icon("rotate")}</button>
      <button class="icon-button" data-action="reset" title="Закрыть и распознать другой файл">${icon("xmark")}</button>
    </div>`;
}

function rerunHTML() {
  return `<div class="setting-row"><span>Модель</span><select class="plain" data-ref="rerunModel"></select></div>
    <div class="divider"></div>
    <div class="setting-row"><span>Язык</span><select class="plain" data-ref="rerunLanguage"></select></div>
    <div class="panel-actions">
      <button class="button secondary small" data-action="rerun-cancel">Отмена</button>
      <button class="button primary small" data-action="rerun-go" title="Распознать файл заново, правки текста пропадут">Распознать</button>
    </div>`;
}

function setupRerun(root) {
  const r = refs(root);
  fillModels(r.rerunModel, currentModel()?.id);
  fillLanguages(r.rerunLanguage);
  r.rerunLanguage.value = state.job.language || "ru";
  r.rerunModel.addEventListener("change", () => {
    if (r.rerunModel.value !== "__models") return;
    r.rerunModel.value = currentModel()?.id ?? "";
    openSheet("models");
  });
}

function buildError() {
  const job = state.job;
  view.innerHTML = `
    <section class="card message">
      <div class="message-icon">${icon("alert", 30)}</div>
      <div class="message-title">Не удалось распознать «${escape(job.fileName)}»</div>
      <div class="message-text">${escape(job.error)}</div>
      <button class="button primary" data-action="reset">Закрыть</button>
    </section>`;
  return () => {};
}

// MARK: - Sheets

let sheetShown = null, modelsShown = "", confirmDelete = null;

function openSheet(name) {
  state.sheet = name;
  render();
}

function renderSheet() {
  if (state.sheet !== sheetShown) {
    sheetShown = state.sheet;
    modelsShown = "";
    sheet.hidden = !state.sheet;
    sheet.innerHTML = state.sheet === "settings" ? settingsHTML() : state.sheet === "models" ? modelsHTML() : "";
    if (state.sheet === "settings") {
      const prompt = sheet.querySelector('[data-ref="prompt"]');
      prompt.value = state.settings.prompt ?? "";
      let timer;
      prompt.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => saveSettings({ prompt: prompt.value }), 400);
      });
    }
  }
  if (state.sheet === "models") {
    const html = state.models.map(modelHTML).join("");
    if (html !== modelsShown) sheet.querySelector('[data-ref="list"]').innerHTML = modelsShown = html;
  }
}

function settingsHTML() {
  return `<div class="sheet-panel" role="dialog" aria-label="Настройки">
      <div class="sheet-head"><div class="sheet-title">Настройки</div>
        <button class="icon-button" data-action="close-sheet" title="Закрыть (Esc)">${icon("xmark")}</button></div>
      <label class="field"><span class="field-title">Подсказка</span>
        <textarea data-ref="prompt" rows="3" placeholder="Имена и термины из записи, например: Анна Ковалёва, Kubernetes, ВШЭ"></textarea>
        <span class="field-hint">Подставляется в каждое 30-секундное окно Whisper и помогает правильно написать имена и термины</span></label>
      <div class="row"><span>Модели распознавания</span><button class="button secondary small" data-action="models">Открыть</button></div>
      <div class="row"><span>Папка с моделями</span><button class="button secondary small" data-action="folder">Показать</button></div>
      <div class="about">Slovo ${escape(state.version)} для Windows. Речь распознаёт Whisper (whisper.cpp) на этом компьютере, звук читает ffmpeg</div>
    </div>`;
}

function modelsHTML() {
  return `<div class="sheet-panel" role="dialog" aria-label="Модели распознавания">
      <div class="sheet-head"><div class="sheet-title">Модели распознавания</div>
        <button class="icon-button" data-action="close-sheet" title="Закрыть (Esc)">${icon("xmark")}</button></div>
      <div class="model-list" data-ref="list"></div>
      <div class="sheet-foot"><span class="about">Скачанные модели работают без интернета</span>
        <button class="link" data-action="folder">Показать папку</button></div>
    </div>`;
}

function modelHTML(m) {
  const badges = (m.recommended ? '<span class="badge">Рекомендуем</span>' : "")
    + (m.russianTuned ? '<span class="badge">Русская речь</span>' : "") + (m.custom ? '<span class="badge">Своя</span>' : "");
  const id = escape(m.id);
  let side;
  if (m.downloading) {
    side = `<div class="bar${m.verifying ? " indeterminate" : ""}"><div class="bar-fill" style="width:${((m.received / m.size) * 100).toFixed(1)}%"></div></div>`
      + (m.verifying ? '<span class="model-size">Проверяю…</span>' : `<button class="link" data-action="cancel-download" data-id="${id}">Отменить</button>`);
  } else if (m.downloaded) {
    side = `<button class="button secondary small" data-action="delete" data-id="${id}">${confirmDelete === m.id ? "Точно удалить?" : "Удалить"}</button>`;
  } else {
    side = `<button class="button primary small" data-action="download" data-id="${id}">Скачать</button>`;
  }
  const size = m.downloading && !m.verifying ? `${formatBytes(m.received)} из ${formatBytes(m.size)}` : formatBytes(m.size);
  return `<div class="model">
      <div class="model-text"><div class="model-name">${escape(m.name)}${badges}</div>
        ${m.details ? `<div class="model-details">${escape(m.details)}</div>` : ""}
        ${m.error ? `<div class="error-text">${escape(m.error)}</div>` : ""}</div>
      <div class="model-side">${side}<span class="model-size">${size}</span></div>
    </div>`;
}

// MARK: - Actions

let uploadRequest = null;

/** Hands a file to the server: the page cannot tell where the file is, so it sends the file itself. */
function openFile(file, handle) {
  if (busy()) return;
  state.upload = { name: file.name, progress: 0, handle };
  render();
  const request = new XMLHttpRequest();
  uploadRequest = request;
  request.open("POST", `/api/upload?name=${encodeURIComponent(file.name)}`);
  request.setRequestHeader("X-Slovo-Token", token);
  request.upload.onprogress = (event) => {
    if (event.lengthComputable && state.upload) {
      state.upload.progress = event.loaded / event.total;
      render();
    }
  };
  const finish = (error) => {
    uploadRequest = null;
    if (!error) return; // the job's events take over
    state.upload = null;
    render();
    if (error !== "abort") showError(error);
  };
  request.onload = () => {
    let error = null;
    if (request.status >= 300) {
      try {
        error = new Error(JSON.parse(request.responseText).error);
      } catch {
        error = new Error(`Ошибка ${request.status}`);
      }
    }
    finish(error);
  };
  request.onerror = () => finish(new Error("Не удалось передать файл"));
  request.onabort = () => finish("abort");
  request.send(file);
}

async function chooseFile() {
  if (busy()) return;
  try {
    if (window.showOpenFilePicker) {
      const [handle] = await window.showOpenFilePicker({ id: "slovo-open" });
      openFile(await handle.getFile(), handle);
    } else {
      const input = Object.assign(document.createElement("input"), { type: "file" });
      input.onchange = () => input.files[0] && openFile(input.files[0], null);
      input.click();
    }
  } catch (error) {
    if (error.name !== "AbortError") showError(error);
  }
}

function cancel() {
  if (uploadRequest) uploadRequest.abort();
  else if (state.job?.status === "working") api("/api/cancel").catch(showError);
}

function currentText() {
  return view.querySelector("textarea.transcript")?.value ?? "";
}

function flash(kind) {
  state.flash = kind;
  render();
  setTimeout(() => {
    if (state.flash !== kind) return;
    state.flash = null;
    render();
  }, 1600);
}

async function copyText() {
  try {
    await navigator.clipboard.writeText(currentText());
    flash("copied");
  } catch (error) {
    showError(error);
  }
}

/** Saves next to the file when the window knows it (the Save dialog opens in its folder). */
async function save() {
  const text = currentText().replace(/\r?\n/g, "\r\n");
  const extension = format() === "srt" ? ".srt" : ".txt";
  const name = baseName(state.job.fileName) + extension;
  if (!window.showSaveFilePicker) {
    const link = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: name,
    });
    link.click();
    URL.revokeObjectURL(link.href);
    return flash("saved");
  }
  try {
    const options = {
      suggestedName: name, id: "slovo-save",
      types: [{ description: extension === ".srt" ? "Субтитры SRT" : "Текст", accept: { "text/plain": [extension] } }],
    };
    if (state.fileHandle) options.startIn = state.fileHandle;
    const handle = await window.showSaveFilePicker(options);
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    flash("saved");
  } catch (error) {
    if (error.name !== "AbortError") showError(error);
  }
}

function deleteModel(id) {
  if (confirmDelete !== id) {
    confirmDelete = id;
    render();
    setTimeout(() => {
      if (confirmDelete !== id) return;
      confirmDelete = null;
      render();
    }, 3000);
    return;
  }
  confirmDelete = null;
  api("/api/models/delete", { id }).catch(showError);
}

let toastTimer;
function showError(error) {
  toast.textContent = error?.message ?? String(error);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
}

document.addEventListener("click", (event) => {
  if (event.target === sheet) {
    state.sheet = null;
    return render();
  }
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const { action, id, value, setting } = target.dataset;
  switch (action) {
    case "settings": return openSheet("settings");
    case "models": return openSheet("models");
    case "close-sheet": state.sheet = null; return render();
    case "folder": return void api("/api/models/folder").catch(showError);
    case "choose": return void chooseFile();
    case "cancel": return cancel();
    case "reset": return void api("/api/reset").catch(showError);
    case "toggle": saveSettings({ [setting]: !state.settings[setting] }); return render();
    case "format": saveSettings({ format: value }); return render();
    case "mode": saveSettings({ caseMode: value }); return render();
    case "revert": delete state.edits[format()]; return render();
    case "save": return void save();
    case "copy": return void copyText();
    case "rerun": state.rerun = true; return render();
    case "rerun-cancel": state.rerun = false; return render();
    case "rerun-go": {
      const model = view.querySelector('[data-ref="rerunModel"]').value;
      const language = view.querySelector('[data-ref="rerunLanguage"]').value;
      state.rerun = false;
      render();
      return void api("/api/rerun", { model, language }).catch(showError);
    }
    case "download": return void api("/api/models/download", { id }).catch(showError);
    case "cancel-download": return void api("/api/models/cancel", { id }).catch(showError);
    case "delete": return deleteModel(id);
  }
});

// Keys by their place, so they work with the Russian layout too.
window.addEventListener("keydown", (event) => {
  const result = current.key.startsWith("result");
  if (event.key === "Escape") {
    if (state.sheet) state.sheet = null;
    else if (state.rerun) state.rerun = false;
    else if (busy()) return cancel();
    return render();
  }
  if (!event.ctrlKey || event.altKey) return;
  const actions = {
    KeyO: () => !busy() && chooseFile(),
    KeyS: () => result && save(),
    KeyC: () => event.shiftKey && result && copyText(),
    Comma: () => openSheet("settings"),
  };
  if (!actions[event.code] || (event.code === "KeyC" && !event.shiftKey)) return;
  event.preventDefault();
  actions[event.code]();
});

// MARK: - Dropping files

let dragDepth = 0, dropping = false;

function setDropping(value) {
  dropping = value;
  document.body.classList.toggle("dropping", value && !busy());
  if (current.key === "idle") current.update();
}

const carriesFiles = (event) => event.dataTransfer?.types.includes("Files");
window.addEventListener("dragenter", (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dragDepth++;
  setDropping(true);
});
window.addEventListener("dragleave", () => {
  if (--dragDepth > 0) return;
  dragDepth = 0;
  setDropping(false);
});
window.addEventListener("dragover", (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = busy() ? "none" : "copy";
});
window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  setDropping(false);
  const file = event.dataTransfer.files[0];
  if (!file || busy()) return;
  // The handle lets Save open in the file's folder; it has to be asked for during the drop.
  const item = [...event.dataTransfer.items].find((i) => i.kind === "file");
  const handle = item?.getAsFileSystemHandle?.() ?? Promise.resolve(null);
  handle.then((h) => openFile(file, h?.kind === "file" ? h : null), () => openFile(file, null));
});

// For screenshots: "#sheet=models" opens a sheet, "#still" draws the state once, without live updates.
const debug = new URLSearchParams(location.hash.slice(1));
state.sheet = debug.get("sheet");
setInterval(() => { if (current.key === "work") current.update(); }, 1000);
loadState().catch(showError);
if (!debug.has("still")) connect();
