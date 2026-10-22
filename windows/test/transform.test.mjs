// Port of Tests/TransCoreTests/TextTransformerTests.swift: node windows/test/transform.test.mjs
import assert from "node:assert/strict";
import { applyMode, mergeEdit, applyFormat, mergeFormat, render, CASE_MODES, FORMATS } from "../web/transform.js";

let passed = 0;
function test(name, body) {
  try {
    body();
    passed++;
  } catch (error) {
    console.error(`✗ ${name}\n${error.message}`);
    process.exitCode = 1;
  }
}
const merge = (edited, text, mode, format = "text") => mergeFormat(format, edited, text, mode);

// Variants

test("four variants of a sentence", () => {
  const text = "Привет, мир! Как дела?";
  assert.equal(applyMode(text, "original"), text);
  assert.equal(applyMode(text, "originalNoPunctuation"), "Привет мир Как дела");
  assert.equal(applyMode(text, "lowercase"), "привет, мир! как дела?");
  assert.equal(applyMode(text, "lowercaseNoPunctuation"), "привет мир как дела");
});

test("joiners and numbers stay", () => {
  assert.equal(applyMode("Что-то стоит 3.5 рубля, в 10:30 — don't (честно).", "originalNoPunctuation"),
    "Что-то стоит 3.5 рубля в 10:30 don't честно");
  assert.equal(applyMode("Т-34, 1,5 литра", "lowercaseNoPunctuation"), "т-34 1,5 литра");
});

test("marks between words leave one space", () => {
  assert.equal(applyMode("слово,слово…слово", "originalNoPunctuation"), "слово слово слово");
  assert.equal(applyMode("«Цитата» и (скобки) - вот", "originalNoPunctuation"), "Цитата и скобки вот");
  assert.equal(applyMode("Да?! Нет...", "originalNoPunctuation"), "Да Нет");
});

test("lines and replies stay", () => {
  assert.equal(applyMode("Первый абзац. Конец!\n\nВторой, абзац.", "lowercaseNoPunctuation"), "первый абзац конец\n\nвторой абзац");
  assert.equal(applyMode("— Привет!\n— Пока.", "originalNoPunctuation"), "Привет\nПока");
});

test("spacing without marks is kept", () => {
  assert.equal(applyMode("Два  пробела ", "originalNoPunctuation"), "Два  пробела ");
  assert.equal(applyMode("ЁЖ ПРОПИСНЫЕ", "lowercase"), "ёж прописные");
});

// Formats

test("timecodes keep their times", () => {
  const text = "[01:23] Привет, мир.\n[1:01:05] — Да!";
  assert.equal(applyFormat("timecodes", "lowercaseNoPunctuation", text), "[01:23] привет мир\n[1:01:05] да");
  assert.equal(applyFormat("timecodes", "lowercase", text), "[01:23] привет, мир.\n[1:01:05] — да!");
});

test("subtitles keep numbers and times", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,500\nПривет, мир.\n\n2\n00:00:03,000 --> 00:00:04,000\n— Да!\n";
  assert.equal(applyFormat("srt", "lowercaseNoPunctuation", srt),
    "1\n00:00:01,000 --> 00:00:02,500\nпривет мир\n\n2\n00:00:03,000 --> 00:00:04,000\nда\n");
  assert.equal(applyFormat("srt", "original", srt), srt);
});

test("rendered formats", () => {
  const segments = [{ start: 0, end: 2, text: "Привет, мир." }, { start: 4, end: 6, text: "Как дела?" }];
  const mode = "lowercaseNoPunctuation";
  assert.equal(applyFormat("text", mode, render("text", segments)), "привет мир\n\nкак дела");
  assert.equal(applyFormat("timecodes", mode, render("timecodes", segments)), "[00:00] привет мир\n[00:04] как дела");
  assert.equal(applyFormat("srt", mode, render("srt", segments)),
    "1\n00:00:00,000 --> 00:00:02,000\nпривет мир\n\n2\n00:00:04,000 --> 00:00:06,000\nкак дела\n");
});

// Edits under a variant

test("edit without variant is taken as is", () => {
  assert.equal(merge("Новый текст", "Старый текст", "original"), "Новый текст");
});

test("unchanged text stays", () => {
  const text = "— Привет, Мир!\n\n«Цитата» и (скобки).";
  for (const mode of CASE_MODES) assert.equal(merge(applyFormat("text", mode, text), text, mode), text, mode);
});

test("fixed word keeps capitals around", () => {
  assert.equal(merge("привет, мир.", "Превет, Мир.", "lowercase"), "Привет, Мир.");
});

test("edits keep hidden marks", () => {
  const text = "Привет, мир.";
  assert.equal(merge("Привет дорогой мир", text, "originalNoPunctuation"), "Привет, дорогой мир.");
  assert.equal(merge("Приветик мир", text, "originalNoPunctuation"), "Приветик, мир.");
  assert.equal(merge("Привет миру", text, "originalNoPunctuation"), "Привет, миру.");
  assert.equal(merge("Привет друг", text, "originalNoPunctuation"), "Привет, друг.");
  assert.equal(merge("Приветмир", text, "originalNoPunctuation"), "Приветмир.");
});

test("space typed at the end of a line stays", () => {
  let text = "Привет, мир.";
  text = merge("Привет мир ", text, "originalNoPunctuation");
  assert.equal(text, "Привет, мир. ");
  assert.equal(applyMode(text, "originalNoPunctuation"), "Привет мир ");
  text = merge("Привет мир и", text, "originalNoPunctuation");
  assert.equal(text, "Привет, мир. и");
  assert.equal(merge("Привет мир у и", "Привет, мир.", "originalNoPunctuation"), "Привет, мир. у и");
  assert.equal(merge("Привет миру и", "Привет, мир.", "originalNoPunctuation"), "Привет, миру и.");
});

test("typing at the start of a reply", () => {
  assert.equal(merge("Ну привет\nпока", "— Привет!\n— Пока.", "lowercaseNoPunctuation"), "— Ну Привет!\n— Пока.");
});

test("typed marks and capitals are kept but not shown", () => {
  const text = merge("Привет, мир", "Привет мир", "originalNoPunctuation");
  assert.equal(text, "Привет, мир");
  assert.equal(applyMode(text, "originalNoPunctuation"), "Привет мир");
  const lowered = merge("привет Мир", "привет", "lowercase");
  assert.equal(lowered, "привет Мир");
  assert.equal(applyMode(lowered, "lowercase"), "привет мир");
});

test("other variants show the edit", () => {
  const text = merge("привет дорогой мир", "Привет, мир.", "lowercaseNoPunctuation");
  assert.equal(applyMode(text, "original"), "Привет, дорогой мир.");
  assert.equal(applyMode(text, "lowercase"), "привет, дорогой мир.");
});

test("edits of subtitles and timecodes", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,500\nПривет, Мир.\n";
  const edited = applyFormat("srt", "lowercaseNoPunctuation", srt).replaceAll("мир", "друг");
  assert.equal(merge(edited, srt, "lowercaseNoPunctuation", "srt"), "1\n00:00:01,000 --> 00:00:02,500\nПривет, друг.\n");
  const timecodes = "[00:01] — Да, конечно.\n[00:05] Нет!";
  const edit = applyFormat("timecodes", "originalNoPunctuation", timecodes).replaceAll("конечно", "разумеется");
  assert.equal(merge(edit, timecodes, "originalNoPunctuation", "timecodes"), "[00:01] — Да, разумеется.\n[00:05] Нет!");
});

test("replace all changes only the words", () => {
  const text = "Превет, Анна. Как дела? Превет, Борис!";
  const edited = applyMode(text, "lowercaseNoPunctuation").replaceAll("превет", "привет");
  assert.equal(merge(edited, text, "lowercaseNoPunctuation"), "Привет, Анна. Как дела? Привет, Борис!");
});

// Random edits

function generator(seed) {
  let state = seed >>> 0;
  return (n) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}
const letters = Array.from("абвгдеёжзиклмнопрстуфхцчшщыэюяАБВГДЕЖЗИКЛМНОПРСТУФХЦЧЭЮЯabcdefxyzABCXYZ");
const alphabet = letters.concat(Array.from("     ..,,!?—–-'’«»\"():;…\n"));
const pick = (random, list) => list[random(list.length)];
const randomText = (random) => Array.from({ length: random(61) }, () => pick(random, alphabet)).join("");

test("typed letter shows where typed", () => {
  const random = generator(42);
  for (let n = 0; n < 3000; n++) {
    const text = randomText(random), mode = pick(random, CASE_MODES), format = pick(random, FORMATS);
    const shown = Array.from(applyFormat(format, mode, text));
    shown.splice(random(shown.length + 1), 0, pick(random, letters));
    const edited = shown.join("");
    const merged = mergeFormat(format, edited, text, mode);
    assert.equal(applyFormat(format, mode, merged), applyFormat(format, mode, edited),
      `${mode} ${format}: ${JSON.stringify(text)} → ${JSON.stringify(edited)}`);
  }
});

test("random edits", () => {
  const random = generator(7);
  for (let n = 0; n < 3000; n++) {
    const text = randomText(random), mode = pick(random, CASE_MODES), format = pick(random, FORMATS);
    const shown = Array.from(applyFormat(format, mode, text));
    const edited = shown.slice();
    const start = random(edited.length + 1);
    const end = start + random(Math.min(edited.length, start + 8) - start + 1);
    edited.splice(start, end - start, ...Array.from(randomText(random)).slice(0, random(7)));
    mergeFormat(format, edited.join(""), text, mode);
    assert.equal(mergeFormat(format, shown.join(""), text, mode), text);
  }
});

test("long text is quick", () => {
  const paragraph = "Привет, мир! Это длинная расшифровка — с репликами, «кавычками» и числами 3.5 и 10:30.\n\n";
  const text = paragraph.repeat(1500);
  const began = Date.now();
  const shown = Array.from(applyMode(text, "lowercaseNoPunctuation"));
  shown.splice(shown.length / 2, 0, "я");
  mergeEdit(shown.join(""), text, "lowercaseNoPunctuation");
  const took = Date.now() - began;
  assert.ok(took < 1500, `took ${took} ms`);
});

console.log(`${passed} passed`);
