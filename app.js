/* Physics-realism 2AFC user study. Static page; answers are POSTed to a Google Apps Script web app. */
(() => {
  "use strict";
  const CFG = window.STUDY_CONFIG || {};
  const ENDPOINT = (CFG.ENDPOINT || "").trim();
  const HAS_ENDPOINT = ENDPOINT.startsWith("https://") && !ENDPOINT.includes("PASTE");
  const LS_KEY = "physstudy_v1";
  const MIN_GAP = 8;          // min trials between two appearances of the same prompt
  const SEC_PER_TRIAL = 24;   // for the time estimate only

  const $ = (id) => document.getElementById(id);
  let M = null;   // manifest
  let S = null;   // session state (persisted)

  // ---------------- utils ----------------
  function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  function randHex(n) {
    const a = new Uint8Array(n);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  function show(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.add("hidden"));
    $(id).classList.remove("hidden");
    window.scrollTo(0, 0);
  }
  // Size the trial screen to the window: at most 88% of the window width (videos are not blown up so far that the
  // 832x480 encode looks soft), and no taller than the window so prompt + videos + answer buttons fit without
  // scrolling (browser windows are shorter than the screen, so the height often decides). Two passes because the
  // prompt text re-wraps when the width changes.
  const MAX_FRAC = 0.88;
  function fitPair() {
    const scr = $("screen-trial");
    if (scr.classList.contains("hidden")) return;
    if (window.innerWidth <= 760) { scr.style.maxWidth = ""; return; }
    scr.style.maxWidth = MAX_FRAC * window.innerWidth + "px";
    const pair = scr.querySelector(".pair"), cs = getComputedStyle($("app"));
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const gap = parseFloat(getComputedStyle(pair).columnGap) || 14;
    for (let i = 0; i < 2; i++) {
      const other = scr.getBoundingClientRect().height - pair.getBoundingClientRect().height;
      const avail = window.innerHeight - other - pad - 6;
      scr.style.maxWidth = Math.min(MAX_FRAC * window.innerWidth, Math.max(560, avail * (832 / 480) * 2 + gap)) + "px";
    }
  }
  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) { /* private mode */ } }
  function loadSaved() { try { return JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch (e) { return null; } }

  // ---------------- trial construction ----------------
  // Exactly n_per_baseline trials per baseline; every prompt is used floor/ceil(T/P) times, never twice with the
  // same baseline; Ours-left/right balanced within each baseline; repeats of a prompt kept >= MIN_GAP apart.
  function buildTrials(rng) {
    const P = M.prompts.length, B = M.baselines.slice(), k = M.n_per_baseline, T = B.length * k;
    const base = Math.floor(T / P), extra = T % P;
    if (base + (extra ? 1 : 0) > B.length) throw new Error("too many trials per prompt for the number of baselines");
    const mult = new Array(P).fill(base);
    shuffle([...Array(P).keys()], rng).slice(0, extra).forEach((p) => mult[p]++);

    const remain = Object.fromEntries(B.map((b) => [b, k]));
    const assign = Array.from({ length: P }, () => []);
    const procOrder = shuffle([...Array(P).keys()], rng).sort((a, b) => mult[b] - mult[a]);
    for (const p of procOrder) {
      const cand = shuffle(B.slice(), rng).sort((a, b) => remain[b] - remain[a]);
      for (let j = 0; j < mult[p]; j++) {
        const b = cand[j];
        if (remain[b] <= 0) throw new Error("baseline assignment failed");
        assign[p].push(b); remain[b]--;
      }
      shuffle(assign[p], rng);
    }

    // order: shuffle ALL trials together (repeats spread over the whole session, not bunched at the end) and keep
    // the first order in which two showings of the same prompt are > MIN_GAP trials apart. Fallback (practically
    // never needed): rounds = r-th appearance of each prompt, round boundary kept free of near repeats.
    const items = [];
    for (let p = 0; p < P; p++) for (let r = 0; r < mult[p]; r++) items.push({ p, b: assign[p][r] });
    let seq = null;
    for (let tries = 0; tries < 20000 && !seq; tries++) {
      shuffle(items, rng);
      const last = {};
      let ok = true;
      for (let i = 0; i < items.length && ok; i++) {
        const q = items[i].p;
        if (q in last && i - last[q] <= MIN_GAP) ok = false;
        last[q] = i;
      }
      if (ok) seq = items.slice();
    }
    const maxM = seq ? 0 : Math.max(...mult);
    if (!seq) seq = [];
    for (let r = 0; r < maxM; r++) {
      let round = [];
      for (let p = 0; p < P; p++) if (mult[p] > r) round.push({ p, b: assign[p][r] });
      for (let tries = 0; tries < 500; tries++) {
        shuffle(round, rng);
        const tail = new Set(seq.slice(-MIN_GAP).map((t) => t.p));
        if (round.slice(0, MIN_GAP).every((t) => !tail.has(t.p))) break;
      }
      seq = seq.concat(round);
    }

    const sides = {};
    for (const b of B) {
      // odd k (e.g. 15): which side gets the extra trial is random per baseline, so A/B stays balanced overall
      const nA = k % 2 ? (rng() < 0.5 ? Math.ceil(k / 2) : Math.floor(k / 2)) : k / 2;
      sides[b] = shuffle([...Array(k)].map((_, i) => (i < nA ? "A" : "B")), rng);
    }
    let trials = seq.map(({ p, b }) => {
      const side = sides[b].pop();
      const ref = M.prompts[p].ref, other = M.prompts[p].b[b];
      return { p, b, ours_side: side, va: side === "A" ? ref : other, vb: side === "A" ? other : ref,
               is_repeat: 0, repeat_of: -1 };
    });

    // consistency checks: copy early trials, sides swapped, re-insert late
    const nr = M.n_repeat_checks || 0;
    const srcIdx = shuffle([...Array(Math.floor(0.4 * T)).keys()], rng).slice(0, nr);
    for (const si of srcIdx) {
      const s = trials[si];
      const copy = { p: s.p, b: s.b, ours_side: s.ours_side === "A" ? "B" : "A", va: s.vb, vb: s.va,
                     is_repeat: 1, repeat_of: si };
      let at = trials.length;
      for (let tries = 0; tries < 200; tries++) {
        const cand = Math.ceil(0.6 * trials.length) + Math.floor(rng() * (trials.length - Math.ceil(0.6 * trials.length) + 1));
        const near = trials.slice(Math.max(0, cand - 3), cand + 3).some((t) => t.p === s.p);
        if (!near) { at = cand; break; }
      }
      trials.splice(at, 0, copy);
    }
    // repeat_of must point at the final position of the source trial
    const orig = trials.filter((t) => !t.is_repeat);
    trials.forEach((t, i) => (t.pos = i));
    trials.forEach((t) => { if (t.is_repeat) t.repeat_of = orig[t.repeat_of].pos; });
    return trials;
  }

  // ---------------- result upload ----------------
  let inflight = false;
  function makeRow(kind, extra) {
    return Object.assign({
      row_id: `${S.sid}-${kind}-${extra.trial_pos ?? 0}`, kind, session_id: S.sid, rater_name: S.name,
      n_trials: S.trials.length, client_ts: new Date().toISOString(),
      user_agent: navigator.userAgent, screen: `${window.innerWidth}x${window.innerHeight}`,
    }, extra);
  }
  function queue(row) { S.unsent.push(row); save(); flush(); }
  async function flush() {
    if (!HAS_ENDPOINT || inflight || !S || !S.unsent.length) return !S || !S.unsent.length;
    inflight = true;
    const batch = S.unsent.slice();
    try {
      const r = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
                                        body: JSON.stringify({ rows: batch }) });
      const js = await r.json();
      if (js.ok) {
        const sent = new Set(batch.map((x) => x.row_id));
        S.unsent = S.unsent.filter((x) => !sent.has(x.row_id));
        save();
      }
    } catch (e) { /* retried later */ }
    inflight = false;
    return S.unsent.length === 0;
  }
  setInterval(flush, 20000);
  window.addEventListener("pagehide", () => {
    if (HAS_ENDPOINT && S && S.unsent.length && navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([JSON.stringify({ rows: S.unsent })], { type: "text/plain" }));
    }
  });

  // ---------------- video handling ----------------
  const blobCache = new Map();  // vid -> Promise<url>
  function videoURL(vid) {
    if (!blobCache.has(vid)) {
      blobCache.set(vid, fetch(`v/${vid}.mp4`).then((r) => {
        if (!r.ok) throw new Error(r.status);
        return r.blob();
      }).then((b) => URL.createObjectURL(b)).catch(() => `v/${vid}.mp4`));
    }
    return blobCache.get(vid);
  }
  function prefetch(pos) {
    for (let i = pos; i < Math.min(pos + 3, S.trials.length); i++) {
      videoURL(S.trials[i].va); videoURL(S.trials[i].vb);
    }
    // free blobs of trials well behind us
    const keep = new Set();
    for (let i = Math.max(0, pos - 1); i < Math.min(pos + 3, S.trials.length); i++) {
      keep.add(S.trials[i].va); keep.add(S.trials[i].vb);
    }
    for (const [vid, pr] of blobCache) {
      if (!keep.has(vid)) {
        pr.then((u) => { if (u.startsWith("blob:")) URL.revokeObjectURL(u); });
        blobCache.delete(vid);
      }
    }
  }

  const vA = $("vA"), vB = $("vB");
  let cur = null;  // per-trial runtime: {loops, last, enabledAt, shownAt, replays, token}
  function onTime(which, v) {
    if (!cur) return;
    const t = v.currentTime;
    if (t + 0.4 < cur.last[which]) cur.loops[which]++;
    cur.last[which] = t;
    maybeEnable();
  }
  function onEnded(which) { if (cur) { cur.loops[which]++; maybeEnable(); } }
  vA.addEventListener("timeupdate", () => onTime("A", vA));
  vB.addEventListener("timeupdate", () => onTime("B", vB));
  vA.addEventListener("ended", () => onEnded("A"));
  vB.addEventListener("ended", () => onEnded("B"));
  [vA, vB].forEach((v) => v.addEventListener("click", replay));

  function setAnswersEnabled(on) {
    document.querySelectorAll(".ans").forEach((b) => (b.disabled = !on));
    $("wait-hint").classList.toggle("hidden", on);
  }
  function maybeEnable() {
    if (cur && !cur.enabledAt && cur.loops.A >= 1 && cur.loops.B >= 1) {
      cur.enabledAt = performance.now();
      setAnswersEnabled(true);
    }
  }
  function playBoth() {
    vA.currentTime = 0; vB.currentTime = 0;
    if (cur) { cur.last = { A: 0, B: 0 }; }
    Promise.all([vA.play(), vB.play()]).catch(() => {
      $("loading").textContent = "Click a video to start playback.";
      $("loading").classList.remove("hidden");
    });
  }
  function replay() {
    if (!cur) return;
    cur.replays++;
    vA.pause(); vB.pause();
    playBoth();
  }
  function waitReady(v) {
    return new Promise((res) => {
      if (v.readyState >= 3) return res();
      const f = () => { v.removeEventListener("canplay", f); res(); };
      v.addEventListener("canplay", f);
    });
  }

  async function showTrial(pos) {
    const t = S.trials[pos];
    const pr = M.prompts[t.p];
    const token = Symbol();
    cur = { loops: { A: 0, B: 0 }, last: { A: 0, B: 0 }, enabledAt: 0, shownAt: performance.now(), replays: 0, token };
    setAnswersEnabled(false);
    $("progress-text").textContent = `${pos + 1} / ${S.trials.length}`;
    $("progress-fill").style.width = `${(100 * pos) / S.trials.length}%`;
    $("prompt-action").textContent = pr.action ? pr.action.charAt(0).toUpperCase() + pr.action.slice(1) : "";
    $("prompt-text").textContent = pr.text;
    fitPair();
    $("loading").textContent = "Loading videos…";
    $("loading").classList.remove("hidden");
    vA.pause(); vB.pause();
    const [ua, ub] = await Promise.all([videoURL(t.va), videoURL(t.vb)]);
    if (!cur || cur.token !== token) return;
    vA.src = ua; vB.src = ub;
    vA.load(); vB.load();
    await Promise.all([waitReady(vA), waitReady(vB)]);
    if (!cur || cur.token !== token) return;
    $("loading").classList.add("hidden");
    playBoth();
    // fallback in case timeupdate is throttled (background tab etc.)
    const dur = Math.max(vA.duration || 5.1, vB.duration || 5.1);
    setTimeout(() => {
      if (cur && cur.token === token && !cur.enabledAt) { cur.loops.A = Math.max(cur.loops.A, 1); cur.loops.B = Math.max(cur.loops.B, 1); maybeEnable(); }
    }, (2 * dur + 1) * 1000);
    prefetch(pos + 1);
  }

  function answer(choice) {
    if (!cur || !cur.enabledAt || (choice !== "A" && choice !== "B")) return;   // forced choice: no tie
    setAnswersEnabled(false);
    const pos = S.pos, t = S.trials[pos];
    const ours_result = choice === t.ours_side ? "win" : "loss";
    const row = makeRow("trial", {
      trial_pos: pos, prompt_id: M.prompts[t.p].pid, baseline_code: t.b, ours_side: t.ours_side,
      video_a: t.va, video_b: t.vb, choice, ours_result, is_repeat: t.is_repeat, repeat_of: t.repeat_of,
      rt_ms: Math.round(performance.now() - cur.enabledAt), loops: Math.min(cur.loops.A, cur.loops.B),
      replays: cur.replays,
    });
    S.answers[pos] = { choice, ours_result };
    S.pos = pos + 1;
    cur = null;
    queue(row);
    if (S.pos >= S.trials.length) finish(); else showTrial(S.pos);
  }

  async function finish() {
    vA.pause(); vB.pause(); vA.removeAttribute("src"); vB.removeAttribute("src");
    if (!S.completed) {
      S.completed = true;
      S.unsent.push(makeRow("complete", { trial_pos: S.trials.length,
        note: JSON.stringify({ answered: S.answers.filter(Boolean).length, minutes: ((Date.now() - S.created) / 60000).toFixed(1) }) }));
      save();
    }
    show("screen-done");
    $("done-code").textContent = S.sid.toUpperCase();
    $("done-retry").classList.add("hidden");
    $("done-status").textContent = "Saving your answers…";
    let ok = false;
    for (let i = 0; i < 4 && !ok; i++) {
      ok = await flush();
      if (!ok) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
    if (ok) {
      $("done-status").textContent = "Your answers have been saved. You can close this tab.";
    } else {
      $("done-status").textContent = HAS_ENDPOINT
        ? "We couldn't reach the server to save your answers. Please press Retry; if that keeps failing, download the backup file and send it to the study organiser."
        : "Saving isn't configured on this page. Please download the backup file and send it to the study organiser.";
      $("done-retry").classList.remove("hidden");
      $("done-contact").textContent = CFG.CONTACT ? `Contact: ${CFG.CONTACT}` : "";
    }
  }

  // ---------------- screens / wiring ----------------
  function newSession() {
    // no names: each browser gets a random anonymous ID (kept in localStorage for resume)
    const nonce = randHex(8), sid = randHex(5);
    const rng = mulberry32(cyrb53(`${sid}|${nonce}`) % 4294967296);
    S = { v: 2, sid, name: `anon-${sid}`, nonce, created: Date.now(), manifest_version: M.version, sig: studySig(),
          trials: [], answers: [], pos: 0, unsent: [], completed: false };
    S.trials = buildTrials(rng);
    save();
    queue(makeRow("start", { trial_pos: 0, note: JSON.stringify({ manifest_version: M.version, baselines: M.baselines }) }));
  }

  function studySig() {
    return `${M.version}|${M.baselines.join(",")}|${M.prompts.map((p) => p.ref).join(",")}`;
  }

  function wire() {
    $("btn-begin").addEventListener("click", () => {
      if (!S) newSession();
      if (S.completed) return finish();
      show("screen-trial"); showTrial(S.pos);
    });
    $("btn-help").addEventListener("click", () => {
      vA.pause(); vB.pause(); cur = null;
      $("btn-begin").textContent = "Back to the videos";
      $("start-note").textContent = "";
      show("screen-instr");
    });
    $("link-new").addEventListener("click", (e) => {
      e.preventDefault();
      if (HAS_ENDPOINT && S && S.unsent.length && navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, new Blob([JSON.stringify({ rows: S.unsent })], { type: "text/plain" }));
      }
      try { localStorage.removeItem(LS_KEY); } catch (err) { /* ignore */ }
      location.reload();
    });
    $("btn-replay").addEventListener("click", replay);
    window.addEventListener("resize", fitPair);
    document.querySelectorAll(".ans").forEach((b) => b.addEventListener("click", () => answer(b.dataset.choice)));
    document.addEventListener("keydown", (e) => {
      if ($("screen-trial").classList.contains("hidden") || e.target.tagName === "INPUT") return;
      const k = e.key.toLowerCase();
      const map = { a: "A", arrowleft: "A", b: "B", arrowright: "B" };
      if (k === "r") { replay(); e.preventDefault(); return; }
      if (map[k]) { e.preventDefault(); answer(map[k]); }
    });
    $("btn-retry").addEventListener("click", finish);
    $("btn-download").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(S, null, 1)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = `physstudy_${S.name}_${S.sid}.json`; a.click();
    });
  }

  async function init() {
    wire();
    try {
      // manifest.js (a <script>) works when index.html is opened from disk (file://), where fetch() is blocked
      M = window.STUDY_MANIFEST || (await (await fetch("manifest.json", { cache: "no-cache" })).json());
    } catch (e) {
      document.body.innerHTML = "<main><h1>Could not load the study.</h1><p>Please reload the page.</p></main>";
      return;
    }
    // fill {TRIALS} / {MINUTES} placeholders in the (editable) instruction text; text nodes only, so the
    // buttons and their listeners are untouched
    const nTot = M.baselines.length * M.n_per_baseline + (M.n_repeat_checks || 0);
    const minutes = Math.max(5, Math.round((nTot * SEC_PER_TRIAL) / 300) * 5);
    const walker = document.createTreeWalker($("screen-instr"), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue.includes("{")) n.nodeValue = n.nodeValue.replaceAll("{TRIALS}", nTot).replaceAll("{MINUTES}", minutes);
    }
    if (!HAS_ENDPOINT) console.warn("STUDY_CONFIG.ENDPOINT not set: answers are kept locally only.");
    const saved = loadSaved();
    if (saved && (saved.v !== 2 || saved.sig !== studySig())) {   // study changed: drop the stale session
      try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
    } else if (saved && saved.trials && saved.trials.length) {
      S = saved;
      flush();
      if (S.completed) return finish();
      if (S.pos > 0) {
        $("btn-begin").textContent = "Continue where you left off";
        $("start-note").textContent = `${S.pos} / ${S.trials.length} done`;
      }
    }
  }
  init();
})();
