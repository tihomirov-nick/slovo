// Port of TransCore (TextTransformer.swift, Transcript.swift): the three formats of the transcript, the four case and
// punctuation variants (Subline's style) and edits made under a variant. Characters are Unicode code points.

/** Characters removed in the "without punctuation" variants. */
const PUNCTUATION = new Set([".", ",", "!", "?", ";", ":", "…", "\"", "'", "«", "»", "„", "“", "”", "‟", "‘", "’", "‚",
  "(", ")", "[", "]", "{", "}", "<", ">", "‹", "›", "—", "–", "―", "‒", "-", "‐", "‑", "¡", "¿", "*", "_"]);
/** Kept when they join two letters or digits: "что-то", "don't", "д'Артаньян". */
const JOINERS = new Set(["-", "‐", "‑", "'", "’"]);
/** Kept between digits: "3.5", "1,5", "10:30". */
const NUMBER_SEPARATORS = new Set([".", ",", ":"]);
/** An edit spread over a longer stretch is taken as one replacement: comparing it char by char would take too long. */
const LONGEST_COMPARED = 4000;

export const CASE_MODES = ["original", "originalNoPunctuation", "lowercase", "lowercaseNoPunctuation"];
export const FORMATS = ["text", "timecodes", "srt"];

const isNewline = (c) => c === "\n" || c === "\r" || c === " " || c === " " || c === "\u0085" || c === "\v" || c === "\f";
const isWhitespace = (c) => /\s/u.test(c);
const isNumber = (c) => /\p{N}/u.test(c);
const isWordChar = (c) => /[\p{L}\p{N}]/u.test(c);
const removesPunctuation = (mode) => mode === "originalNoPunctuation" || mode === "lowercaseNoPunctuation";
const lowercases = (mode) => mode === "lowercase" || mode === "lowercaseNoPunctuation";

/**
 * The variant and, for each of its characters, the characters of the source it stands for (lo..hi): one character,
 * or a run of spaces and marks for the space left in their place. Removed characters stand for nothing.
 */
function shown(source, mode, kept) {
  const out = { chars: [], lo: [], hi: [], speechAfterMarks: new Set() };
  const push = (c, lo, hi) => { out.chars.push(c); out.lo.push(lo); out.hi.push(hi); };
  let lineStart = 0;
  while (lineStart <= source.length) {
    let lineEnd = lineStart;
    while (lineEnd < source.length && !isNewline(source[lineEnd])) lineEnd++;
    const speech = lineStart + Math.min(Math.max(0, kept(source, lineStart, lineEnd)), lineEnd - lineStart);
    for (let k = lineStart; k < speech; k++) push(source[k], k, k + 1);
    if (removesPunctuation(mode)) {
      removePunctuation(source, speech, lineEnd, out, push);
    } else {
      for (let k = speech; k < lineEnd; k++) push(source[k], k, k + 1);
    }
    if (lineEnd < source.length) push(source[lineEnd], lineEnd, lineEnd + 1);
    lineStart = lineEnd + 1;
  }
  if (lowercases(mode)) lowercase(out);
  return out;
}

/**
 * Removes the marks of one line's speech. A run of marks and spaces becomes one space between words ("слово, слово"
 * and "слово,слово" give "слово слово") and nothing at the start of the line; spaces without marks stay as they are.
 */
function removePunctuation(source, lo, hi, out, push) {
  const removable = (k) => {
    const c = source[k];
    if (!PUNCTUATION.has(c)) return false;
    const prev = k > lo ? source[k - 1] : null;
    const next = k + 1 < hi ? source[k + 1] : null;
    if (JOINERS.has(c) && prev !== null && next !== null && isWordChar(prev) && isWordChar(next)) return false;
    if (NUMBER_SEPARATORS.has(c) && prev !== null && next !== null && isNumber(prev) && isNumber(next)) return false;
    return true;
  };
  let k = lo;
  while (k < hi) {
    if (!isWhitespace(source[k]) && !removable(k)) {
      push(source[k], k, k + 1);
      k++;
      continue;
    }
    const start = k;
    let marks = false, spaces = false;
    while (k < hi && (isWhitespace(source[k]) || removable(k))) {
      if (isWhitespace(source[k])) spaces = true; else marks = true;
      k++;
    }
    if (!marks) {
      for (let s = start; s < k; s++) push(source[s], s, s + 1);
    } else if (start === lo) {
      // "— Привет": the dash of a reply goes together with the space after it.
      out.speechAfterMarks.add(k);
    } else if (k === hi) {
      // A space typed after the last mark of a line stays: the next word is on its way.
      if (spaces && isWhitespace(source[k - 1])) push(" ", start, k);
    } else if (spaces || (isWordChar(source[start - 1]) && isWordChar(source[k]))) {
      push(" ", start, k);
    }
  }
}

function lowercase(out) {
  const lowered = Array.from(out.chars.join("").toLocaleLowerCase("ru"));
  if (lowered.length === out.chars.length) {
    out.chars = lowered;
    return;
  }
  // A letter that turns into several characters (rare): one at a time, so the origins stay right.
  const chars = [], lo = [], hi = [];
  out.chars.forEach((c, i) => {
    for (const l of Array.from(c.toLocaleLowerCase("ru"))) {
      chars.push(l);
      lo.push(out.lo[i]);
      hi.push(out.hi[i]);
    }
  });
  Object.assign(out, { chars, lo, hi });
}

/**
 * Myers' diff with the tie rule of Swift's `difference(from:)`: offsets removed from `a` and inserted into `b`.
 */
function diff(a, b) {
  const n = a.length, m = b.length, max = n + m, offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let done = false;
  for (let d = 0; d <= max && !done; d++) {
    trace.push({ base: offset - d - 1, values: v.slice(offset - d - 1, offset + d + 2) });
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { done = true; break; }
    }
  }
  const removed = [], inserted = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const { base, values } = trace[d];
    const at = (k) => values[offset + k - base];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK), prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; }
    if (y !== prevY) inserted.push(prevY); else removed.push(prevX);
    x = prevX;
    y = prevY;
  }
  return { removed, inserted };
}

/** `text` in the variant. `kept(source, lineStart, lineEnd)` tells how many first characters of a line are not speech. */
export function applyMode(text, mode, kept = () => 0) {
  if (mode === "original") return text;
  return shown(Array.from(text), mode, kept).chars.join("");
}

/**
 * The text after an edit of its variant: `edited` is `applyMode(text, mode)` with the user's changes. They go to the same
 * places of `text`, so capitals and marks stay wherever the user did not touch the text and show again in the other
 * variants; what the user typed is kept as typed.
 */
export function mergeEdit(edited, text, mode, kept = () => 0) {
  if (mode === "original") return edited;
  const source = Array.from(text);
  const sh = shown(source, mode, kept);
  const old = sh.chars, neu = Array.from(edited);
  if (old.length === neu.length && old.every((c, i) => c === neu[i])) return text;

  // The changed stretch, then what exactly changed in it: one stretch for typing, several for Replace All.
  let prefix = 0;
  while (prefix < old.length && prefix < neu.length && old[prefix] === neu[prefix]) prefix++;
  let suffix = 0;
  while (suffix < old.length - prefix && suffix < neu.length - prefix
    && old[old.length - 1 - suffix] === neu[neu.length - 1 - suffix]) suffix++;
  const oldEnd = old.length - suffix, newEnd = neu.length - suffix;
  let isRemoved = (i) => i >= prefix && i < oldEnd;
  let isInserted = (j) => j >= prefix && j < newEnd;
  if ((oldEnd - prefix) + (newEnd - prefix) <= LONGEST_COMPARED) {
    const changes = diff(old.slice(prefix, oldEnd), neu.slice(prefix, newEnd));
    const removed = new Set(changes.removed.map((o) => prefix + o));
    const inserted = new Set(changes.inserted.map((o) => prefix + o));
    isRemoved = (i) => removed.has(i);
    isInserted = (j) => inserted.has(j);
  }

  const result = [];
  let copied = 0; // characters of the source dealt with
  let replacing = false; // after removed characters: typed ones take their place
  let typing = false; // inside typed text, its place is chosen
  const copy = (end) => {
    if (end <= copied) return;
    for (let k = copied; k < end; k++) result.push(source[k]);
    copied = end;
  };
  let i = 0, j = 0;
  while (i < old.length || j < neu.length) {
    if (i < old.length && (isRemoved(i) || j >= neu.length)) {
      // Marks hidden between two removed characters go with them.
      if (replacing) copied = Math.max(copied, sh.lo[i]); else copy(sh.lo[i]);
      copied = Math.max(copied, sh.hi[i]);
      replacing = true;
      i++;
    } else if (j < neu.length && (isInserted(j) || i >= old.length)) {
      // Typed text goes right after the character before it ("мир." with "у" typed after "мир" becomes "миру."), and
      // after the marks hidden around it when it starts with a space at the end of a line ("мир." becomes "мир. ")
      // and at the start of a line ("— Привет" stays a reply).
      if (!replacing && !typing) {
        const lineEnd = i >= old.length || isNewline(old[i]);
        if (lineEnd && isWhitespace(neu[j])) {
          copy(i < old.length ? sh.lo[i] : source.length);
        } else if (!lineEnd && sh.speechAfterMarks.has(sh.lo[i])) {
          copy(sh.lo[i]);
        }
      }
      typing = true;
      result.push(neu[j]);
      j++;
    } else {
      copy(sh.hi[i]);
      replacing = false;
      typing = false;
      i++;
      j++;
    }
  }
  copy(source.length);
  return result.join("");
}

// MARK: - Formats

/** How many first characters of a line are not speech: times in front of lines, subtitle numbers and times. */
function notSpeech(format) {
  if (format === "timecodes") {
    // "[01:23] " or "[1:01:23] "
    return (source, start, end) => {
      if (start >= end || source[start] !== "[") return 0;
      let close = -1;
      for (let k = start; k < end; k++) if (source[k] === "]") { close = k; break; }
      if (close < 0) return 0;
      const time = source.slice(start + 1, close);
      if (!time.includes(":") || time.length > 10 || !time.every((c) => c === ":" || (c >= "0" && c <= "9"))) return 0;
      return (close + 1 < end && source[close + 1] === " " ? close + 2 : close + 1) - start;
    };
  }
  if (format === "srt") {
    // "00:01:02,345 --> 00:01:04,000"; numbers have no letters or marks to change.
    return (source, start, end) => (source.slice(start, end).join("").includes("-->") ? end - start : 0);
  }
  return () => 0;
}

/** The transcript in a variant: only what was said changes, times and subtitle numbers stay as they are. */
export function applyFormat(format, mode, text) {
  return applyMode(text, mode, notSpeech(format));
}

/** The transcript after an edit of its variant (see `mergeEdit`). */
export function mergeFormat(format, edited, text, mode) {
  return mergeEdit(edited, text, mode, notSpeech(format));
}

const pad = (n, width = 2) => String(n).padStart(width, "0");

/** "01:23" or "1:01:23". */
export function clock(seconds, hours) {
  const total = Math.floor(Math.max(0, seconds));
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  return hours ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m + h * 60)}:${pad(s)}`;
}

/** "00:01:02,345". */
export function srtTime(seconds) {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/** A new paragraph starts after a finished sentence followed by a pause, or when the paragraph grows long. */
export function paragraphs(segments) {
  const result = [];
  let current = "", length = 0, previousEnd = 0;
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    if (current) {
      const endsSentence = ".!?…".includes(Array.from(current).pop());
      const pause = segment.start - previousEnd;
      if (endsSentence && (pause >= 1.5 || length >= 600)) {
        result.push(current);
        current = "";
        length = 0;
      }
    }
    current += current ? " " + text : text;
    length += Array.from(text).length + (length ? 1 : 0);
    previousEnd = segment.end;
  }
  if (current) result.push(current);
  return result;
}

export function render(format, segments) {
  if (format === "timecodes") {
    const hours = (segments.length ? segments[segments.length - 1].end : 0) >= 3600;
    return segments.map((s) => `[${clock(s.start, hours)}] ${s.text}`).join("\n");
  }
  if (format === "srt") {
    return segments.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(Math.max(s.end, s.start + 0.5))}\n${s.text}`)
      .join("\n\n") + (segments.length ? "\n" : "");
  }
  return paragraphs(segments).join("\n\n");
}

/** Number of words in a text (sequences with at least one letter or digit). */
export function wordCount(text) {
  return text.split(/\s+/u).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
