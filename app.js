/* Trip Split — client logic */
(function () {
  "use strict";

  const CFG = window.TRIP_SPLIT_CONFIG;

  // ── room keys ──
  // A locked trip is proven with a header, not a screen check: the server
  // refuses to hand over members or expenses unless `x-trip-key` matches. The
  // password itself never leaves the device — only sha256(roomId:password).
  function makeClient(key) {
    const opts = key ? { global: { headers: { "x-trip-key": key } } } : undefined;
    return window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, opts);
  }
  let sb = makeClient(null);

  // crypto.subtle only exists in a secure context. Over plain http it is simply
  // absent, and without a clear message that surfaces as the app dying on the
  // password screen.
  const canHash = () => !!(window.crypto && window.crypto.subtle);
  async function sha256Hex(s) {
    if (!canHash()) throw new Error("주소가 https 여야 비밀번호를 쓸 수 있어요");
    const buf = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const roomKey = (roomId, pw) => sha256Hex(roomId + ":" + pw);

  const keyStore = (roomId) => "tripsplit_key_" + roomId;
  const recallKey = (roomId) => localStorage.getItem(keyStore(roomId));
  const rememberKey = (roomId, key) => localStorage.setItem(keyStore(roomId), key);
  const forgetKey = (roomId) => localStorage.removeItem(keyStore(roomId));
  // every query from here on carries this key
  function useKey(key) { sb = makeClient(key || null); }

  // `select *` is out: once the password migration lands, anon loses blanket
  // select on rooms so pw_hash can never be read, and a star fails outright.
  // But naming columns means naming ones this database might not have — the
  // rate migration was never run here, for instance. So ask for everything and
  // drop whatever it says it lacks, once, then remember.
  let roomCols = ["id", "name", "default_currency", "start_date",
                  "base_rate_jpy", "base_rate_date", "has_pw", "created_at"];
  let hasPwCol = true;
  async function roomQuery(build) {
    for (let i = 0; i <= roomCols.length; i++) {
      const res = await build(roomCols.join(","));
      if (!res.error) return res;
      const miss = /column rooms\.(\w+) does not exist/.exec(res.error.message || "");
      if (!miss || roomCols.indexOf(miss[1]) < 0) return res;
      if (miss[1] === "has_pw") hasPwCol = false;
      roomCols = roomCols.filter((c) => c !== miss[1]);
    }
    return { data: null, error: { message: "rooms 조회 실패" } };
  }

  const CATEGORIES = [
    { key: "식비", emoji: "🍚" }, { key: "카페", emoji: "☕" },
    { key: "교통", emoji: "🚕" }, { key: "숙소", emoji: "🏠" },
    { key: "선물", emoji: "🎁" }, { key: "마트", emoji: "🛒" },
    { key: "술",   emoji: "🍺" }, { key: "기타", emoji: "➕" },
  ];
  const EMOJI = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.emoji]));
  const CUR = { KRW: "₩", JPY: "¥" };

  // ── day / slot ──
  // An expense carries the day of the trip it belongs to, not a calendar date:
  // "3일차 저녁" is what people actually remember. Day 0 is everything bought
  // before leaving (flights, accommodation, gear).
  const SLOTS = [
    { key: "아침", emoji: "🌅" }, { key: "점심", emoji: "🍜" },
    { key: "오후", emoji: "☀️" }, { key: "저녁", emoji: "🌆" },
    { key: "밤",   emoji: "🌙" },
  ];
  const SLOT_EMOJI = Object.fromEntries(SLOTS.map((s) => [s.key, s.emoji]));
  const SLOT_ORDER = Object.fromEntries(SLOTS.map((s, i) => [s.key, i]));
  const PREP_DAY = 0;
  const MAX_DAY_CHIPS = 60; // guard: a wildly wrong start date shouldn't spawn 500 chips

  // ── FX ──
  // Everything settles in KRW. A foreign-currency expense carries the rate it was
  // saved with, so past settlement numbers never shift when the market moves.
  const FX_API = "https://api.frankfurter.dev/v1/"; // ECB reference rates, no key needed
  const FALLBACK_JPY_KRW = 9.0; // last resort: offline since the trip was created

  // Set when the DB predates migration-rate.sql. Saving must keep working on an
  // un-migrated database, so we drop the rate columns and convert at the room rate.
  let rateColsMissing = false;
  const isMissingRateCol = (err) => !!err && /rate_krw|rate_date|rate_source|base_rate_/.test(err.message || "");
  function stripRateCols(p) {
    const q = Object.assign({}, p);
    delete q.rate_krw; delete q.rate_date; delete q.rate_source;
    return q;
  }

  // Same story for the timeline columns (migration-timeline.sql). Postgres words
  // these two ways: `column expenses.slot does not exist` and PostgREST's
  // `Could not find the 'slot' column ... in the schema cache`. Match on whole
  // words so `expenses_id_seq` and "sequence" don't trip it.
  let timelineColsMissing = false;
  const isMissingTimelineCol = (err) =>
    !!err && /day_index|start_date|\bslot\b|\bseq\b/.test(err.message || "");
  function stripTimelineCols(p) {
    const q = Object.assign({}, p);
    delete q.day_index; delete q.slot; delete q.seq;
    return q;
  }
  const isMissingReceiptCol = (err) => !!err && /receipt_path/.test(err.message || "");
  // Drop whatever this particular database turned out not to have.
  function sanitize(p) {
    let q = p;
    if (rateColsMissing) q = stripRateCols(q);
    if (timelineColsMissing) q = stripTimelineCols(q);
    if (receiptColMissing) { q = Object.assign({}, q); delete q.receipt_path; }
    return q;
  }

  // ── receipts ──
  // Storage holds "<key>.jpg" (full) and "<key>_t.jpg" (list thumbnail); the
  // row keeps only the key. The bucket is public — same threat model as the
  // room link itself, which is already the only thing guarding the data.
  const RECEIPT_BASE = CFG.SUPABASE_URL + "/storage/v1/object/public/receipts/";
  const FULL_PX = 1400, FULL_Q = 0.82;   // readable enough to check a total
  const THUMB_PX = 220, THUMB_Q = 0.7;
  let receiptColMissing = false;
  const receiptUrl = (key, thumb) => RECEIPT_BASE + key + (thumb ? "_t.jpg" : ".jpg");

  // ── app state ──
  const state = {
    room: null,
    members: [],
    expenses: [],
    me: null, // member id
    draft: null, // {amount, currency, category, note, payerId, participants:Set, editingId}
    filter: { memberId: null, mode: "paid" }, // timeline: null = everyone, mode paid|share
  };

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  const trimZeros = (s) => s.replace(/\.?0+$/, ""); // "908.40" -> "908.4", "900.00" -> "900"
  const money = (n, cur) => (CUR[cur] || "") + fmt(n);
  const memberName = (id) => (state.members.find((m) => m.id === id) || {}).name || "?";

  // ── screens ──
  function show(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    $(id).classList.add("active");
    window.scrollTo(0, 0);
    renderInstallHint(id);
  }

  // ── "홈 화면에 추가" ──
  // Only where it helps: the trip list, and the moment a friend first opens a
  // shared link. Never on top of the input screen, which has a save button
  // right where this sits.
  const INSTALL_KEY = "tripsplit_install_dismissed";
  let installPrompt = null; // Chrome hands us one; Safari never will
  const UA = navigator.userAgent;
  const isIOS = /iphone|ipad|ipod/i.test(UA);
  // Links get shared over KakaoTalk, and its in-app browser has no "add to
  // home screen" at all. That, not the instructions, is where most people
  // actually get stuck.
  const inKakao = /KAKAOTALK/i.test(UA);
  const inAppBrowser = inKakao || /Instagram|FBAN|FBAV|NAVER\(inapp|Line\//i.test(UA);
  const isStandalone = () =>
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    window.navigator.standalone === true; // iOS reports it here instead

  function renderInstallHint(screenId) {
    const el = $("install-hint");
    const wanted = screenId === "screen-home" || screenId === "screen-identity";
    if (!wanted || isStandalone() || localStorage.getItem(INSTALL_KEY)) {
      el.classList.remove("show");
      return;
    }
    const oneTap = !!installPrompt;
    $("install-go").style.display = "block";
    $("install-go").textContent = oneTap ? "추가" : "방법";
    $("install-how").textContent = inAppBrowser
      ? "브라우저로 열어야 추가할 수 있어요"
      : (oneTap ? "앱처럼 전체화면으로 열려요"
                : (isIOS ? "공유 버튼 → '홈 화면에 추가'" : "브라우저 메뉴 → '홈 화면에 추가'"));
    el.classList.add("show");
  }
  function dismissInstallHint() {
    localStorage.setItem(INSTALL_KEY, "1");
    $("install-hint").classList.remove("show");
  }

  // Apple never implemented beforeinstallprompt, so on iOS the best available
  // "one tap" is a clear set of steps pointing at the real share button.
  const SHARE_ICON = `<svg class="ico" viewBox="0 0 24 24" width="19" height="19" fill="none"
      stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 15V3"/><path d="M8 7l4-4 4 4"/>
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>`;
  const step = (n, html) =>
    `<div class="guide-step"><span class="guide-num">${n}</span><span class="guide-body">${html}</span></div>`;

  function openInstallGuide() {
    const steps = $("guide-steps"), action = $("guide-action"), arrow = $("guide-arrow");
    arrow.innerHTML = "";
    action.style.display = "none";
    action.onclick = null;

    if (inAppBrowser) {
      $("guide-title").textContent = "브라우저로 먼저 열어주세요";
      steps.innerHTML =
        step(1, `지금은 <b>${inKakao ? "카톡" : "앱"} 안의 브라우저</b>예요.
                 <small>여기에는 '홈 화면에 추가'가 없어요.</small>`) +
        step(2, `${isIOS ? "사파리" : "크롬"}로 열면 추가할 수 있어요.
                 <small>${inKakao ? "아래 버튼을 누르거나, 오른쪽 아래 메뉴에서 '다른 브라우저로 열기'"
                                  : "메뉴에서 '다른 브라우저로 열기'"}를 골라주세요.</small>`);
      if (inKakao) {
        action.style.display = "block";
        action.textContent = "🌐 브라우저로 열기";
        action.onclick = () => {
          location.href = "kakaotalk://web/openExternal?url=" + encodeURIComponent(location.href);
        };
      }
    } else if (isIOS) {
      $("guide-title").textContent = "홈 화면에 추가하기";
      steps.innerHTML =
        step(1, `아래쪽 공유 버튼 ${SHARE_ICON} 을 눌러요`) +
        step(2, `목록을 내려서 <b>'홈 화면에 추가'</b>를 골라요`) +
        step(3, `오른쪽 위 <b>'추가'</b>를 눌러요
                 <small>홈 화면에 아이콘이 생기고, 주소창 없이 앱처럼 열려요.</small>`);
      arrow.innerHTML = `<div class="guide-arrow">↓</div>`; // 공유 버튼은 화면 아래에 있다
    } else {
      $("guide-title").textContent = "홈 화면에 추가하기";
      steps.innerHTML =
        step(1, `브라우저 메뉴(⋮)를 눌러요`) +
        step(2, `<b>'홈 화면에 추가'</b> 또는 <b>'앱 설치'</b>를 골라요
                 <small>홈 화면에 아이콘이 생기고, 주소창 없이 앱처럼 열려요.</small>`);
    }
    $("guide-back").classList.add("show");
  }
  function closeInstallGuide() { $("guide-back").classList.remove("show"); }

  // ── toast ──
  let toastT;
  function toast(msg, isErr) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "show" + (isErr ? " err" : "");
    clearTimeout(toastT);
    toastT = setTimeout(() => (t.className = ""), 1800);
  }

  // ── localStorage identity ──
  const meKey = (roomId) => "tripsplit_me_" + roomId;
  const rememberMe = (roomId, memberId) => localStorage.setItem(meKey(roomId), memberId);
  const recallMe = (roomId) => localStorage.getItem(meKey(roomId));

  // ── localStorage: my trips list ──
  const ROOMS_KEY = "tripsplit_rooms";
  function getSavedRooms() {
    try { return JSON.parse(localStorage.getItem(ROOMS_KEY)) || []; } catch (e) { return []; }
  }
  function saveRoomToList(room) {
    const list = getSavedRooms().filter((r) => r.id !== room.id);
    list.unshift({ id: room.id, name: room.name }); // most-recent first
    localStorage.setItem(ROOMS_KEY, JSON.stringify(list));
  }
  function removeRoomFromList(roomId) {
    localStorage.setItem(ROOMS_KEY, JSON.stringify(getSavedRooms().filter((r) => r.id !== roomId)));
  }
  const goHome = () => { location.href = location.pathname; };

  // ── ownership (only the creating device can delete the trip) ──
  const ownerKey = (roomId) => "tripsplit_owner_" + roomId;
  const markOwner = (roomId) => localStorage.setItem(ownerKey(roomId), "1");
  const isOwner = (roomId) => localStorage.getItem(ownerKey(roomId)) === "1";
  function forgetRoomLocal(roomId) {
    localStorage.removeItem(meKey(roomId));
    localStorage.removeItem(ownerKey(roomId));
    removeRoomFromList(roomId);
  }

  // ── generic confirm modal ──
  let confirmCb = null;
  function openConfirm(title, msg, onYes) {
    $("confirm-title").textContent = title;
    $("confirm-msg").innerHTML = msg;
    confirmCb = onYes;
    $("confirm-back").classList.add("show");
  }
  function closeConfirm() { $("confirm-back").classList.remove("show"); confirmCb = null; }

  // ── id generator (readable, url-safe) ──
  function genRoomId() {
    const s = "abcdefghijkmnpqrstuvwxyz23456789";
    let out = "";
    for (let i = 0; i < 7; i++) out += s[Math.floor(Math.random() * s.length)];
    return out;
  }

  // ═══════════════════ ACCOUNTS ═══════════════════
  // There is no email here. A handle is turned into one behind the scenes so
  // Supabase can do the hashing, sessions and tokens — none of that is worth
  // hand-rolling. The user only ever types a name and six digits.
  const MAIL_DOMAIN = "@tripsplit.app";
  const HANDLE_RE = /^[가-힣a-zA-Z0-9]{2,8}$/;

  // Supabase refuses an address whose local part isn't ASCII — "민수@…" is
  // rejected outright as an invalid format. So the handle is written out as the
  // hex of its UTF-8 bytes: "민수" becomes u_eba28cec8898@tripsplit.app.
  // Deterministic, so the same name always lands on the same account, and the
  // readable handle still lives in profiles.
  function handleMail(h) {
    const bytes = new TextEncoder().encode(h.trim().toLowerCase());
    let hex = "";
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
    return "u_" + hex + MAIL_DOMAIN;
  }

  let me = null;      // { id, handle, name }
  let authMode = "in";
  // The accounts migration may not have run yet. Until it has, the app behaves
  // exactly as it did before — no login screen, no personal list.
  let accountsReady = false;
  async function checkAccounts() {
    try {
      // Ask something a signed-out visitor is allowed to ask. Probing the
      // profiles table can't work: nobody may read it without a session, so it
      // would answer "no accounts here" forever and the login screen would
      // never appear.
      const { error } = await sb.rpc("handle_available", { p_handle: "__probe__" });
      accountsReady = !error;
    } catch (err) { accountsReady = false; }
  }

  async function loadMe() {
    const { data } = await sb.auth.getUser();
    if (!data || !data.user) { me = null; return null; }
    const p = await sb.from("profiles").select("id,handle,name").eq("id", data.user.id).maybeSingle();
    me = p.data || { id: data.user.id, handle: "?", name: "?" };
    return me;
  }

  // Ask yes/no rather than reading the table: a readable profiles table is a
  // list of everyone's names for anyone who asks.
  async function handleTaken(handle) {
    const { data, error } = await sb.rpc("handle_available", { p_handle: handle.trim() });
    if (error) return false;
    return data === false;
  }

  // Suggest 민수2, 민수3 … so a common name isn't a dead end.
  async function freeHandle(base) {
    if (!(await handleTaken(base))) return base;
    for (let n = 2; n <= 20 && base.length < 8; n++) {
      const t = base + n;
      if (!(await handleTaken(t))) return t;
    }
    return null;
  }

  async function doSignUp(handle, pw, q, a) {
    const { data, error } = await sb.auth.signUp({ email: handleMail(handle), password: pw });
    if (error) throw new Error(/already/i.test(error.message) ? "이미 쓰이는 이름이에요" : error.message);
    if (!data.session) throw new Error("가입은 됐는데 로그인이 안 됐어요. 다시 로그인해 주세요.");
    const uid = data.user.id;
    const { error: pErr } = await sb.from("profiles")
      .insert({ id: uid, handle: handle.trim(), name: handle.trim() });
    if (pErr) throw new Error("프로필 저장 실패: " + pErr.message);
    if (q && a) {
      // the answer lives in its own table, and never leaves here in the clear
      const { error: sErr } = await sb.from("profile_secrets").insert({
        id: uid, hint_q: q.trim(),
        hint_hash: await sha256Hex(a.trim().toLowerCase() + ":" + uid),
      });
      if (sErr) toast("질문은 저장 못 했어요 — 비밀번호를 잘 기억해 주세요", true);
    }
    await loadMe();
  }

  async function doSignIn(handle, pw) {
    const { error } = await sb.auth.signInWithPassword({ email: handleMail(handle), password: pw });
    if (error) throw new Error(/Invalid login/i.test(error.message)
      ? "이름이나 비밀번호가 맞지 않아요" : error.message);
    await loadMe();
  }

  // ═══════════════════ DATA ═══════════════════
  // Columns are listed rather than `select *`: once the migration lands, anon
  // loses blanket select on rooms so that pw_hash can never be read, and a
  // star would fail the permission check outright.
  async function loadRoom(roomId) {
    const res = await roomQuery((cols) =>
      sb.from("rooms").select(cols).eq("id", roomId).maybeSingle());
    if (res.error) throw res.error;
    return res.data;
  }

  // The whole catalogue, so a trip is never lost with the browser storage.
  async function loadAllRooms() {
    const res = await roomQuery((cols) =>
      sb.from("rooms").select(cols).order("created_at", { ascending: false }));
    return res.error ? [] : res.data;
  }
  const isLocked = (room) => hasPwCol && room && room.has_pw === true;
  async function refetch() {
    const [mRes, eRes] = await Promise.all([
      sb.from("members").select("*").eq("room_id", state.room.id).order("created_at"),
      sb.from("expenses").select("*").eq("room_id", state.room.id).order("created_at", { ascending: false }),
    ]);
    if (!mRes.error) state.members = mRes.data;
    if (!eRes.error) state.expenses = eRes.data;
    renderAll();
  }

  // ═══════════════════ FX ═══════════════════
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // KRW per 1 JPY on the given date. Returns {rate, date} or null if unreachable.
  // A weekend/holiday date answers with the prior business day, and says so in `date`.
  async function fetchRate(dateStr) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(FX_API + dateStr + "?base=JPY&symbols=KRW", { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const j = await res.json();
      const rate = j && j.rates && j.rates.KRW;
      return rate ? { rate, date: j.date || dateStr } : null;
    } catch (err) {
      return null;
    }
  }

  // Keep the room's fallback rate fresh. Returns true if it changed.
  async function warmRoomRate() {
    if (!state.room) return false;
    const r = await fetchRate(todayStr());
    if (!r) return false;
    if (state.room.base_rate_date === r.date && Number(state.room.base_rate_jpy) === r.rate) return false;
    // keep it in memory regardless — it still drives conversion for this session
    state.room.base_rate_jpy = r.rate;
    state.room.base_rate_date = r.date;
    const { error } = await sb.from("rooms")
      .update({ base_rate_jpy: r.rate, base_rate_date: r.date }).eq("id", state.room.id);
    if (isMissingRateCol(error)) rateColsMissing = true;
    return true;
  }

  // The rate a brand-new JPY expense would get if the API is unreachable right now.
  function currentJpyRate() {
    const base = state.room && state.room.base_rate_jpy;
    return base ? { rate: Number(base), source: "room" } : { rate: FALLBACK_JPY_KRW, source: "fallback" };
  }

  // KRW per 1 unit of this expense's currency, and where that number came from.
  function rateOf(e) {
    if ((e.currency || "KRW") === "KRW") return { rate: 1, source: "krw" };
    if (e.rate_krw) return { rate: Number(e.rate_krw), source: e.rate_source || "api" };
    return currentJpyRate(); // pre-migration rows: fall back to the room rate
  }

  const krwAmount = (e) => Math.round(e.amount * rateOf(e).rate);
  // Flag rows whose rate is a stand-in rather than the real rate of that day.
  const isEstimated = (e) => {
    const s = rateOf(e).source;
    return s === "room" || s === "fallback";
  };

  // ═══════════════════ DAY / SLOT ═══════════════════
  const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];
  const dayOf = (e) => (typeof e.day_index === "number" ? e.day_index : null);
  const slotKeyOf = (e) => e.slot || null;
  const slotRank = (s) => (s in SLOT_ORDER ? SLOT_ORDER[s] : 99);
  const dayRank = (d) => (d === null ? 1e9 : d); // unassigned rows sink to the bottom

  // "2026-08-01" -> local midnight. `new Date(str)` would parse it as UTC and
  // shift the whole trip by a day for anyone east of Greenwich.
  function parseYmd(s) {
    if (!s) return null;
    const p = String(s).slice(0, 10).split("-").map(Number);
    if (p.length !== 3 || p.some(isNaN)) return null;
    return new Date(p[0], p[1] - 1, p[2]);
  }
  const startDate = () => parseYmd(state.room && state.room.start_date);

  // calendar date of day N (1-based); null while the start date is unknown
  function dateOfDay(dayIndex) {
    const s = startDate();
    if (!s || dayIndex < 1) return null;
    const d = new Date(s);
    d.setDate(d.getDate() + (dayIndex - 1));
    return d;
  }
  const dayLabel = (i) => (i === PREP_DAY ? "여행 전 준비" : i + "일차");
  function dayDateLabel(i) {
    const d = dateOfDay(i);
    return d ? `${d.getMonth() + 1}/${d.getDate()} (${WEEKDAY[d.getDay()]})` : "";
  }

  // which day of the trip is it right now? day 1 until a start date exists
  function todayDayIndex() {
    const s = startDate();
    if (!s) return 1;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diff = Math.round((today - s) / 86400000) + 1;
    return diff < 1 ? PREP_DAY : Math.min(diff, MAX_DAY_CHIPS);
  }
  function slotNow() {
    const h = new Date().getHours();
    if (h >= 5 && h < 10) return "아침";
    if (h >= 10 && h < 14) return "점심";
    if (h >= 14 && h < 17) return "오후";
    if (h >= 17 && h < 21) return "저녁";
    return "밤";
  }
  // how far the day picker runs: today, or the latest day already logged
  function lastDayIndex() {
    let max = 1;
    state.expenses.forEach((e) => { if (dayOf(e) > max) max = e.day_index; });
    return Math.min(Math.max(max, todayDayIndex()), MAX_DAY_CHIPS);
  }
  // next order number inside a (day, slot) bucket
  function nextSeq(dayIndex, slot) {
    let max = -1;
    state.expenses.forEach((e) => {
      if (e.day_index === dayIndex && e.slot === slot && typeof e.seq === "number" && e.seq > max) max = e.seq;
    });
    return max + 1;
  }
  // rows sharing a bucket, in display order
  function bucketSiblings(e) {
    return state.expenses
      .filter((x) => dayOf(x) === dayOf(e) && slotKeyOf(x) === slotKeyOf(e))
      .sort((a, b) => (a.seq || 0) - (b.seq || 0) || (new Date(a.created_at) - new Date(b.created_at)));
  }
  // one member's share of an expense in KRW — same rounding rule as computeSettlement,
  // so the filter total and the settlement figure never disagree by a won or two
  function shareOf(e, memberId) {
    const parts = (e.participant_ids && e.participant_ids.length) ? e.participant_ids : [e.payer_id];
    const i = parts.indexOf(memberId);
    if (i < 0) return 0;
    const total = krwAmount(e);
    const each = Math.round(total / parts.length);
    return i === parts.length - 1 ? total - each * (parts.length - 1) : each;
  }

  // ═══════════════════ RECEIPTS ═══════════════════
  // Phone photos are several megabytes; a list of fifty would be unusable.
  // Shrink to two sizes in the browser before anything leaves the device.
  function shrink(file, maxPx, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        c.toBlob((b) => b ? resolve(b) : reject(new Error("이미지를 변환하지 못했어요")),
                 "image/jpeg", quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("사진을 읽지 못했어요")); };
      img.src = url;
    });
  }

  function receiptKey() {
    const s = "abcdefghijkmnpqrstuvwxyz23456789";
    let out = "";
    for (let i = 0; i < 12; i++) out += s[Math.floor(Math.random() * s.length)];
    return state.room.id + "/" + out;
  }

  // Returns the storage key, or throws with something worth showing a user.
  async function uploadReceipt(shot) {
    const key = receiptKey();
    const store = sb.storage.from("receipts");
    let r = await store.upload(key + ".jpg", shot.full, { contentType: "image/jpeg", upsert: true });
    if (r.error) throw r.error;
    r = await store.upload(key + "_t.jpg", shot.thumb, { contentType: "image/jpeg", upsert: true });
    if (r.error) throw r.error;
    return key;
  }

  // Read a chosen file into the two sizes we keep, plus a local preview URL.
  async function readShot(file) {
    if (!file) return null;
    if (!/^image\//.test(file.type)) throw new Error("이미지 파일만 첨부할 수 있어요");
    const full = await shrink(file, FULL_PX, FULL_Q);
    const thumb = await shrink(file, THUMB_PX, THUMB_Q);
    return { full: full, thumb: thumb, preview: URL.createObjectURL(thumb) };
  }

  function subscribeRealtime() {
    sb.channel("room-" + state.room.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "expenses", filter: "room_id=eq." + state.room.id }, refetch)
      .on("postgres_changes", { event: "*", schema: "public", table: "members", filter: "room_id=eq." + state.room.id }, refetch)
      .subscribe();
  }

  // ═══════════════════ SETTLEMENT ═══════════════════
  // Single KRW ledger — foreign-currency expenses are converted first.
  // Returns { balances: {memberId: net}, transfers: [{from,to,amount}] }, all in KRW.
  function computeSettlement() {
    const balances = {}; // memberId -> net KRW
    for (const e of state.expenses) {
      if (e.settled) continue; // on-the-spot payments excluded from settlement
      // convert once per expense, then split — otherwise per-person rounding drifts
      const total = krwAmount(e);
      const parts = (e.participant_ids && e.participant_ids.length) ? e.participant_ids : [e.payer_id];
      const each = total / parts.length;
      // payer fronted the whole amount
      balances[e.payer_id] = (balances[e.payer_id] || 0) + total;
      // each participant owes their share
      let assigned = 0;
      parts.forEach((pid, i) => {
        // absorb rounding remainder on the last participant
        const share = (i === parts.length - 1) ? (total - assigned) : Math.round(each);
        assigned += (i === parts.length - 1) ? 0 : Math.round(each);
        balances[pid] = (balances[pid] || 0) - share;
      });
    }
    // greedy min-transfer
    const creditors = [], debtors = [];
    for (const mid in balances) {
      const v = Math.round(balances[mid]);
      if (v > 0) creditors.push({ mid, v });
      else if (v < 0) debtors.push({ mid, v: -v });
    }
    creditors.sort((a, b) => b.v - a.v);
    debtors.sort((a, b) => b.v - a.v);
    const transfers = [];
    let ci = 0, di = 0;
    while (ci < creditors.length && di < debtors.length) {
      const pay = Math.min(creditors[ci].v, debtors[di].v);
      if (pay > 0) transfers.push({ from: debtors[di].mid, to: creditors[ci].mid, amount: pay });
      creditors[ci].v -= pay; debtors[di].v -= pay;
      if (creditors[ci].v === 0) ci++;
      if (debtors[di].v === 0) di++;
    }
    return { balances, transfers };
  }

  // ═══════════════════ RENDER ═══════════════════
  function renderAll() {
    if (state.room) {
      $("input-room-name").textContent = state.room.name;
      $("status-room").textContent = state.room.name;
    }
    renderWho();
    renderWhen();
    renderReceiptBar();
    renderStatus();
    renderTimeline();
  }

  // draft init
  function freshDraft() {
    // the old preview is a blob URL; dropping the draft without releasing it
    // leaks the image for the life of the page
    if (state.draft && state.draft.shot) URL.revokeObjectURL(state.draft.shot.preview);
    state.draft = {
      amount: "",
      currency: state.room.default_currency || "KRW",
      category: null,
      note: "",
      payerId: state.me,
      participants: new Set(state.members.map((m) => m.id)),
      editingId: null,
      // rate carried over when editing, so a later edit doesn't re-price the expense
      rateKrw: null,
      rateDate: null,
      rateSource: null,
      // when it was spent — prefilled from the clock, changeable by tapping
      dayIndex: todayDayIndex(),
      slot: slotNow(),
      seq: null,
      origDayIndex: null,
      origSlot: null,
      // receipt: `shot` is a freshly picked photo, `receiptPath` one already stored
      shot: null,
      receiptPath: null,
    };
  }

  function renderCurToggle(containerId, current) {
    $(containerId).querySelectorAll("button").forEach((b) => {
      b.classList.toggle("on", b.dataset.cur === current);
    });
  }

  function renderCats() {
    const wrap = $("cats");
    wrap.innerHTML = "";
    CATEGORIES.forEach((c) => {
      const el = document.createElement("button");
      el.className = "cat" + (state.draft.category === c.key ? " on" : "");
      el.innerHTML = `<span class="emoji">${c.emoji}</span><span class="lbl">${c.key}</span>`;
      el.onclick = () => { state.draft.category = c.key; renderCats(); };
      wrap.appendChild(el);
    });
  }

  // small helper for the chip rows used by the day/slot pickers and the filters
  function chip(label, on, fn) {
    const b = document.createElement("button");
    b.className = "chip" + (on ? " sel" : "");
    b.textContent = label;
    b.onclick = fn;
    return b;
  }

  function renderReceiptBar() {
    if (!state.draft) return;
    const bar = $("receipt-bar"), thumb = $("receipt-thumb"), text = $("receipt-text");
    const d = state.draft;
    bar.style.display = "flex";
    $("receipt-note").innerHTML = receiptColMissing
      ? `<div class="receipt-note">⚠️ 영수증을 저장할 칸이 아직 없어요 —
         <b>migration-receipt.sql</b>을 실행하기 전까지는 첨부 없이 저장돼요.</div>`
      : "";
    // an expense that already has one keeps it unless a new photo is chosen
    const existing = d.editingId && d.receiptPath && !d.shot;
    if (d.shot) {
      bar.className = "receipt-bar done";
      thumb.innerHTML = `<img src="${d.shot.preview}" alt="" />`;
      text.innerHTML = `영수증 <b>첨부됨</b><span class="rb-sub">탭해서 다시 고르기</span>`;
    } else if (existing) {
      bar.className = "receipt-bar done";
      thumb.innerHTML = `<img src="${receiptUrl(d.receiptPath, true)}" alt="" />`;
      text.innerHTML = `영수증 <b>있음</b><span class="rb-sub">탭해서 바꾸기</span>`;
    } else {
      bar.className = "receipt-bar" + (receiptColMissing || d.editingId ? "" : " missing");
      thumb.innerHTML = "📷";
      text.innerHTML = `영수증 · 결제내역`
        + (receiptColMissing || d.editingId ? "" : ` <b>필수</b>`)
        + `<span class="rb-sub">찍거나 사진첩에서 고르기</span>`;
    }
  }

  async function pickReceipt(file) {
    if (!file) return;
    const bar = $("receipt-bar");
    bar.disabled = true;
    try {
      const shot = await readShot(file);
      if (state.draft.shot) URL.revokeObjectURL(state.draft.shot.preview);
      state.draft.shot = shot;
      renderReceiptBar();
    } catch (err) {
      toast(err.message || "사진을 처리하지 못했어요", true);
    }
    bar.disabled = false;
    $("receipt-file").value = ""; // same file twice must still fire change
  }

  function renderWhen() {
    if (!state.draft) return;
    const d = state.draft;
    // "여행 전 준비" has no time of day — nobody remembers when they booked a flight
    const isPrep = d.dayIndex === PREP_DAY;
    $("slot-wrap").style.display = isPrep ? "none" : "block";
    $("when-text").innerHTML = `<b>${dayLabel(d.dayIndex)}</b>`
      + (isPrep ? "" : ` · ${SLOT_EMOJI[d.slot] || ""}${d.slot}`
                     + ` <span style="color:var(--faint)">${dayDateLabel(d.dayIndex)}</span>`);

    const dc = $("day-chips"); dc.innerHTML = "";
    dc.appendChild(chip("🎒 준비", d.dayIndex === PREP_DAY,
      () => { d.dayIndex = PREP_DAY; renderWhen(); }));
    // one day past the furthest we know about, so tomorrow can be logged in advance
    for (let i = 1; i <= Math.min(lastDayIndex() + 1, MAX_DAY_CHIPS); i++) {
      dc.appendChild(chip(i + "일차", d.dayIndex === i,
        ((n) => () => { d.dayIndex = n; renderWhen(); })(i)));
    }

    const sc = $("slot-chips"); sc.innerHTML = "";
    SLOTS.forEach((s) => {
      sc.appendChild(chip(s.emoji + " " + s.key, d.slot === s.key,
        () => { d.slot = s.key; renderWhen(); }));
    });
  }

  function renderWho() {
    if (!state.draft) return;
    const d = state.draft;
    // sync currency toggle + symbol
    renderCurToggle("input-cur", d.currency);
    $("amt-sym").textContent = CUR[d.currency];
    renderAmountPreview();
    // who summary
    const payer = memberName(d.payerId);
    const n = d.participants.size;
    const allN = state.members.length;
    const splitTxt = n === allN ? `${n}명이 나눔` : `${n}명이 나눔`;
    $("who-text").innerHTML = `<b>${payer}</b>가 냄 · ${splitTxt}`;
    // payer chips
    const pc = $("payer-chips"); pc.innerHTML = "";
    state.members.forEach((m) => {
      const b = document.createElement("button");
      b.className = "chip" + (m.id === d.payerId ? " sel" : "");
      b.textContent = m.name;
      b.onclick = () => { d.payerId = m.id; renderWho(); };
      pc.appendChild(b);
    });
    // split chips
    const sc = $("split-chips"); sc.innerHTML = "";
    state.members.forEach((m) => {
      const b = document.createElement("button");
      b.className = "chip" + (d.participants.has(m.id) ? " sel" : "");
      b.textContent = m.name;
      b.onclick = () => {
        if (d.participants.has(m.id)) d.participants.delete(m.id);
        else d.participants.add(m.id);
        renderWho();
      };
      sc.appendChild(b);
    });
  }

  function renderStatus() {
    if (!state.room) return;
    // hero: total + avg, all in KRW
    const total = state.expenses.reduce((sum, e) => sum + krwAmount(e), 0);
    const hero = $("stat-hero");
    const memberCount = state.members.length || 1;
    if (state.expenses.length === 0) {
      hero.innerHTML = `<div class="total">${money(0, "KRW")}</div>
        <div class="avg">아직 지출이 없어요</div>`;
    } else {
      hero.innerHTML = `<div class="total">${money(total, "KRW")}</div>
        <div class="avg">1인 평균 ${money(total / memberCount, "KRW")}</div>`;
    }

    // balances
    const { balances } = computeSettlement();
    const box = $("balances");
    box.innerHTML = "";
    if (state.members.length === 0) { box.innerHTML = `<div class="empty">멤버가 없어요</div>`; }
    state.members.forEach((m) => {
      const row = document.createElement("div");
      row.className = "bal-row tappable";
      const v = Math.round(balances[m.id] || 0);
      const meTag = m.id === state.me ? `<span class="me-tag">나</span>` : "";
      const amtHtml = v === 0
        ? `<span class="bal-amt zero">±0</span>`
        : `<span class="bal-amt ${v > 0 ? "pos" : "neg"}">${v > 0 ? "+" : "−"}${money(Math.abs(v), "KRW")}</span>`;
      row.innerHTML = `<span class="bal-name">${escapeHtml(m.name)}${meTag}</span><span>${amtHtml}</span>`;
      row.onclick = () => openTimeline(m.id);
      box.appendChild(row);
    });

    // expense list on status (tap to mark on-the-spot settled)
    renderExpenseList($("status-exp-list"), state.expenses, "아직 지출이 없어요.");
    renderMembers();
    renderStartDate();
    renderLockRow();
    $("whoami-name").textContent = memberName(state.me);
    $("delete-trip-btn").style.display = isOwner(state.room.id) ? "block" : "none";
    $("settle-box").innerHTML = "";
    $("settle-btn").textContent = "🧮 정산하기";
  }

  // ── trip start date ──
  // The migration guesses this from the earliest expense, which is a day late
  // whenever nobody spent anything on the first day. So it stays editable.
  function renderStartDate() {
    const btn = $("startdate-btn");
    const s = startDate();
    if (s) {
      btn.classList.remove("unset");
      $("startdate-text").textContent =
        `여행 시작 ${s.getMonth() + 1}월 ${s.getDate()}일 (${WEEKDAY[s.getDay()]})`;
    } else {
      btn.classList.add("unset");
      $("startdate-text").textContent = "여행 시작일을 정해주세요";
    }
  }
  function openDateModal() {
    const s = state.room && state.room.start_date;
    $("date-input").value = s ? String(s).slice(0, 10) : todayStr();
    $("date-back").classList.add("show");
  }
  function closeDateModal() { $("date-back").classList.remove("show"); }

  // Day 1 always means the start date. So when the start date moves, every
  // expense stays on the calendar day it actually happened and its day *number*
  // shifts instead. Anything that ends up before the new start becomes prep.
  async function shiftDays(from, to) {
    const a = parseYmd(from), b = parseYmd(to);
    if (!a || !b) return { delta: 0 };
    const delta = Math.round((b - a) / 86400000);
    if (!delta) return { delta: 0 };

    const days = [];
    state.expenses.forEach((e) => {
      const d = dayOf(e);
      if (d > 0 && days.indexOf(d) < 0) days.push(d);
    });
    // walk in the direction that never writes onto a day we still have to read
    days.sort((x, y) => (delta > 0 ? x - y : y - x));
    for (let i = 0; i < days.length; i++) {
      const d = days[i], target = Math.max(0, d - delta);
      if (target === d) continue;
      // prep has no time of day, so drop the slot on the way in
      const patch = target === PREP_DAY ? { day_index: PREP_DAY, slot: null } : { day_index: target };
      const { error } = await sb.from("expenses").update(patch)
        .eq("room_id", state.room.id).eq("day_index", d);
      if (error) return { delta: 0, error: error };
    }
    return { delta: delta };
  }

  // Several days can collapse into prep at once, and their seq numbers collide
  // when they land. Renumber that bucket by when each expense was entered.
  async function renumberPrep() {
    const prep = state.expenses
      .filter((e) => dayOf(e) === PREP_DAY)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    for (let i = 0; i < prep.length; i++) {
      if (prep[i].seq !== i) await sb.from("expenses").update({ seq: i }).eq("id", prep[i].id);
    }
  }

  async function saveStartDate() {
    const v = $("date-input").value;
    if (!v) { toast("날짜를 선택하세요", true); return; }
    const prev = state.room.start_date ? String(state.room.start_date).slice(0, 10) : null;
    if (prev === v) { closeDateModal(); return; }
    closeDateModal();

    const { error } = await sb.from("rooms").update({ start_date: v }).eq("id", state.room.id);
    if (error) {
      if (isMissingTimelineCol(error)) {
        timelineColsMissing = true;
        toast("migration-timeline.sql 먼저 실행해 주세요", true);
      } else toast("저장 실패: " + error.message, true);
      return;
    }
    state.room.start_date = v;

    let moved = 0;
    if (prev) {
      const r = await shiftDays(prev, v);
      if (r.error) { toast("일차 이동 실패: " + r.error.message, true); await refetch(); return; }
      moved = r.delta;
      if (moved) { await refetch(); await renumberPrep(); }
    }
    if (state.draft && !state.draft.editingId) state.draft.dayIndex = todayDayIndex();
    toast(moved
      ? `시작일 변경 · 일차 ${Math.abs(moved)}칸 ${moved > 0 ? "당겨짐" : "밀림"}`
      : "시작일 저장됨");
    await refetch();
  }

  // ── 비밀번호 설정·변경 ──
  function renderLockRow() {
    const btn = $("lock-btn");
    if (!hasPwCol) { btn.style.display = "none"; return; }
    btn.style.display = "flex";
    const locked = isLocked(state.room);
    btn.classList.toggle("unset", !locked);
    $("lock-icon").textContent = locked ? "🔒" : "🔓";
    $("lock-text").textContent = locked
      ? "비밀번호가 걸려 있어요"
      : "비밀번호 없음 — 목록에서 누구나 열 수 있어요";
  }
  function openSetPw() {
    $("setpw-sub").textContent = isLocked(state.room)
      ? "새 비밀번호로 바꿔요. 비우고 저장하면 잠금이 풀려요.\n이미 들어와 있는 친구들은 다시 입력해야 해요."
      : "비밀번호를 걸면 아는 사람만 열 수 있어요.\n친구들에게 따로 알려주세요.";
    $("setpw-input").value = "";
    $("setpw-back").classList.add("show");
    setTimeout(() => $("setpw-input").focus(), 80);
  }
  function closeSetPw() { $("setpw-back").classList.remove("show"); }

  async function saveRoomPassword() {
    const pw = $("setpw-input").value;
    const id = state.room.id;
    closeSetPw();
    let key = null, patch;
    try {
      key = pw ? await roomKey(id, pw) : null;
      patch = { pw_hash: key ? await sha256Hex(key) : null };
    } catch (err) { toast(err.message, true); return; }
    const { error } = await sb.from("rooms").update(patch).eq("id", id);
    if (error) {
      toast(/pw_hash/.test(error.message || "")
        ? "migration-password.sql 먼저 실행해 주세요" : "저장 실패: " + error.message, true);
      return;
    }
    // Swap our own key over before the next query goes out, or we lock
    // ourselves out of the trip we just secured.
    if (key) rememberKey(id, key); else forgetKey(id);
    useKey(key);
    state.room.has_pw = !!key;
    toast(key ? "비밀번호 설정됨 🔒" : "잠금 해제됨");
    renderStatus();
  }

  function deleteTrip() {
    if (!isOwner(state.room.id)) { toast("방을 만든 사람만 삭제할 수 있어요", true); return; }
    openConfirm(
      "이 여행을 삭제할까요?",
      `<b>${escapeHtml(state.room.name)}</b>의 모든 지출·멤버가 <b>모두에게서</b> 영구 삭제돼요. 되돌릴 수 없어요.`,
      async () => {
        const rid = state.room.id;
        closeConfirm();
        const { error } = await sb.from("rooms").delete().eq("id", rid);
        if (error) { toast("삭제 실패: " + error.message, true); return; }
        forgetRoomLocal(rid);
        toast("여행이 삭제됐어요");
        setTimeout(goHome, 600);
      });
  }

  // ── member management ──
  function memberHasExpenses(id) {
    return state.expenses.some((e) =>
      e.payer_id === id || (e.participant_ids || []).includes(id));
  }

  function renderMembers() {
    const box = $("members-box");
    box.innerHTML = "";
    if (!state.members.length) { box.innerHTML = `<div class="empty">멤버가 없어요</div>`; return; }
    state.members.forEach((m) => {
      const row = document.createElement("div");
      row.className = "mem-row";
      const meTag = m.id === state.me ? `<span class="me-tag">나</span>` : "";
      let right;
      if (m.id === state.me) {
        right = `<span class="mem-locked">본인</span>`;
      } else if (memberHasExpenses(m.id)) {
        right = `<span class="mem-locked">지출 있음</span>`;
      } else {
        right = "";
      }
      row.innerHTML = `<span class="mem-name">${escapeHtml(m.name)}${meTag}</span>`;
      if (right) {
        row.insertAdjacentHTML("beforeend", right);
      } else {
        const del = document.createElement("button");
        del.className = "mem-del";
        del.textContent = "×";
        del.title = "삭제";
        del.onclick = () => deleteMember(m);
        row.appendChild(del);
      }
      box.appendChild(row);
    });
  }

  async function addMember() {
    const name = $("member-new").value.trim();
    if (!name) { toast("이름을 입력하세요", true); return; }
    if (state.members.some((m) => m.name === name)) { toast("같은 이름이 이미 있어요", true); return; }
    const { error } = await sb.from("members").insert({ room_id: state.room.id, name });
    if (error) { toast("추가 실패: " + error.message, true); return; }
    $("member-new").value = "";
    toast(name + " 추가됨");
    await refetch();
  }

  async function deleteMember(m) {
    if (m.id === state.me) { toast("본인은 삭제할 수 없어요", true); return; }
    if (memberHasExpenses(m.id)) { toast("지출 내역이 있어 삭제할 수 없어요", true); return; }
    const { error } = await sb.from("members").delete().eq("id", m.id);
    if (error) { toast("삭제 실패: " + error.message, true); return; }
    toast(m.name + " 삭제됨");
    await refetch();
  }

  function renderSettlement() {
    const { transfers } = computeSettlement();
    const box = $("settle-box");
    // warn when some rows were converted with a stand-in rate rather than that day's
    const estN = state.expenses.filter((e) => !e.settled && isEstimated(e)).length;
    const note = estN
      ? `<div class="settle-note">⚡ ${estN}건은 실시간 환율을 못 받아 기준 환율로 계산했어요. 지출을 탭해 고칠 수 있어요.</div>`
      : "";
    if (transfers.length === 0) {
      box.innerHTML = note + `<div class="settle-done">✨ 정산 끝! 주고받을 게 없어요.</div>`;
      return;
    }
    box.innerHTML = note + transfers.map((t) =>
      `<div class="settle-row">
        <span class="from">${memberName(t.from)}</span>
        <span class="arrow">→</span>
        <span class="to">${memberName(t.to)}</span>
        <span class="amt">${money(t.amount, "KRW")}</span>
      </div>`).join("");
  }

  // `share` (a KRW number) switches the right column to one member's portion
  function expenseItem(e, share) {
    const cur = e.currency || "KRW";
    const parts = (e.participant_ids && e.participant_ids.length) ? e.participant_ids : [e.payer_id];
    const item = document.createElement("button");
    item.className = "exp-item" + (e.settled ? " settled" : "");
    item.style.width = "100%";
    item.style.textAlign = "left";
    const badge = e.settled ? ` · <span class="exp-badge">✓정산완료</span>` : "";
    const est = isEstimated(e) ? ` · <span class="exp-est">⚡기준환율</span>` : "";
    // foreign currency keeps its original amount up front, with the KRW value underneath
    const krwLine = cur === "KRW" ? "" : `<span class="exp-krw">≈${money(krwAmount(e), "KRW")}</span>`;
    const amtCol = (typeof share === "number")
      ? `<span class="exp-amt">${money(share, "KRW")}</span>
         <span class="tl-share">${parts.length}인 나눔</span>`
      : `<span class="exp-amt">${money(e.amount, cur)}</span>${krwLine}`;
    // the receipt stands in for the category tile, with the category kept as a
    // corner badge — the row can't get any wider on a phone
    const cat = EMOJI[e.category] || "💸";
    const tile = e.receipt_path
      ? `<span class="exp-emoji shot"><img src="${receiptUrl(e.receipt_path, true)}" alt="영수증"
           loading="lazy" /><span class="cat-badge">${cat}</span></span>`
      : `<span class="exp-emoji">${cat}</span>`;
    item.innerHTML = `
      ${tile}
      <span class="exp-mid">
        <span class="exp-title">${e.note ? escapeHtml(e.note) : (e.category || "지출")}</span>
        <span class="exp-sub">${memberName(e.payer_id)} 냄 · ${parts.length}명${badge}${est}</span>
      </span>
      <span class="exp-amt-col">${amtCol}</span>`;
    item.onclick = () => openExpenseModal(e);
    // tapping the thumbnail opens the photo, not the expense
    const shot = item.querySelector(".exp-emoji.shot");
    if (shot) {
      shot.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        openShot(e.receipt_path);
      });
      // a half-finished upload would otherwise leave a broken-image icon
      // sitting where the category used to be
      shot.querySelector("img").onerror = () => {
        shot.className = "exp-emoji";
        shot.textContent = cat;
      };
    }
    return item;
  }

  // ── receipt lightbox ──
  function openShot(key) {
    if (!key) return;
    $("shot-img").src = receiptUrl(key, false);
    $("shot-back").classList.add("show");
  }
  function closeShot() {
    $("shot-back").classList.remove("show");
    $("shot-img").removeAttribute("src"); // stop a slow load once it's dismissed
  }

  function renderExpenseList(listEl, items, emptyMsg) {
    if (!items.length) {
      listEl.innerHTML = `<div class="empty">${emptyMsg}</div>`;
      return;
    }
    listEl.innerHTML = "";
    items.forEach((e) => listEl.appendChild(expenseItem(e)));
  }

  // ═══════════════════ TIMELINE ═══════════════════
  function filteredExpenses() {
    const f = state.filter;
    if (!f.memberId) return state.expenses;
    if (f.mode === "paid") return state.expenses.filter((e) => e.payer_id === f.memberId);
    return state.expenses.filter((e) => {
      const parts = (e.participant_ids && e.participant_ids.length) ? e.participant_ids : [e.payer_id];
      return parts.indexOf(f.memberId) >= 0;
    });
  }
  // what this row contributes to the totals — the member's share in "나눈 것" mode
  function rowKrw(e) {
    const f = state.filter;
    return (f.memberId && f.mode === "share") ? shareOf(e, f.memberId) : krwAmount(e);
  }

  // -> [{ dayIndex, total, slots: [{ slot, items }] }], earliest day first
  function groupByDay(items) {
    const days = new Map();
    items.forEach((e) => {
      const d = dayOf(e), s = slotKeyOf(e);
      if (!days.has(d)) days.set(d, new Map());
      const slots = days.get(d);
      if (!slots.has(s)) slots.set(s, []);
      slots.get(s).push(e);
    });
    const byOrder = (a, b) =>
      (a.seq || 0) - (b.seq || 0) || (new Date(a.created_at) - new Date(b.created_at));
    const out = [];
    days.forEach((slots, dayIndex) => {
      const list = [];
      slots.forEach((arr, slot) => list.push({ slot, items: arr.sort(byOrder) }));
      list.sort((a, b) => slotRank(a.slot) - slotRank(b.slot));
      const total = list.reduce((sum, g) => sum + g.items.reduce((t, e) => t + rowKrw(e), 0), 0);
      out.push({ dayIndex, slots: list, total });
    });
    out.sort((a, b) => dayRank(a.dayIndex) - dayRank(b.dayIndex));
    return out;
  }

  function openTimeline(memberId) {
    state.filter = { memberId: memberId || null, mode: "paid" };
    renderTimeline();
    show("screen-history");
  }

  function renderFilters() {
    const f = state.filter;
    const box = $("tl-filters");
    box.innerHTML = "";
    box.appendChild(chip("전체", !f.memberId, () => { f.memberId = null; renderTimeline(); }));
    state.members.forEach((m) => {
      box.appendChild(chip(m.name, f.memberId === m.id,
        ((id) => () => { f.memberId = id; renderTimeline(); })(m.id)));
    });

    const wrap = $("tl-modes-wrap");
    if (!f.memberId) { wrap.innerHTML = ""; return; }
    const items = filteredExpenses();
    const total = items.reduce((s, e) => s + rowKrw(e), 0);
    wrap.innerHTML = `
      <div class="tl-modes">
        <button data-mode="paid" class="${f.mode === "paid" ? "on" : ""}">낸 것</button>
        <button data-mode="share" class="${f.mode === "share" ? "on" : ""}">나눈 것</button>
      </div>
      <div class="tl-sum">${escapeHtml(memberName(f.memberId))} · ${items.length}건 합계
        <b>${money(total, "KRW")}</b></div>`;
    wrap.querySelectorAll("button").forEach((b) => {
      b.onclick = () => { f.mode = b.dataset.mode; renderTimeline(); };
    });
  }

  // Empty slots and empty days are hidden normally — blank rows only make the
  // page longer. While dragging they have to exist, or there is nowhere to drop.
  const SLOT_KEYS = SLOTS.map((s) => s.key);
  const MAX_VACANT_DAYS = 14;
  function addDropTargets(days) {
    const have = {};
    days.forEach((d) => { have[d.dayIndex] = d; });
    const last = lastDayIndex();
    if (last <= MAX_VACANT_DAYS) {
      for (let i = 0; i <= last; i++) {
        if (!have[i]) { have[i] = { dayIndex: i, slots: [], total: 0, vacant: true }; days.push(have[i]); }
      }
    }
    if (!have[PREP_DAY]) {
      have[PREP_DAY] = { dayIndex: PREP_DAY, slots: [], total: 0, vacant: true };
      days.push(have[PREP_DAY]);
    }
    days.forEach((d) => {
      if (d.dayIndex === null) return;
      if (d.dayIndex === PREP_DAY) {
        if (!d.slots.length) d.slots = [{ slot: null, items: [] }];
        return;
      }
      const bySlot = {};
      d.slots.forEach((g) => { bySlot[g.slot] = g; });
      d.slots = SLOT_KEYS.map((k) => bySlot[k] || { slot: k, items: [] });
    });
    days.sort((a, b) => dayRank(a.dayIndex) - dayRank(b.dayIndex));
  }

  // one timeline row: the expense itself plus the grip that drags it
  function timelineRow(e, share) {
    const row = document.createElement("div");
    row.className = "tl-row";
    row.dataset.id = e.id;
    row.appendChild(expenseItem(e, share));
    const grip = document.createElement("button");
    grip.className = "tl-grip";
    grip.textContent = "⋮⋮";
    grip.title = "끌어서 옮기기";
    grip.onclick = (ev) => ev.preventDefault();
    grip.addEventListener("pointerdown", (ev) => beginDrag(ev, e.id));
    row.appendChild(grip);
    return row;
  }

  function dropZone(dayIndex, slot) {
    const z = document.createElement("div");
    z.className = "tl-rows";
    z.dataset.day = String(dayIndex);
    z.dataset.slot = slot || "";
    return z;
  }

  function renderTimeline(expand) {
    if (!state.room) return;
    if (dragging && !expand) return; // never rebuild the list out from under a drag
    renderFilters();
    $("tl-notice").innerHTML = timelineColsMissing
      ? `<div class="tl-notice">⚠️ 일차·시간대를 저장할 칸이 아직 없어요 —
         <b>migration-timeline.sql</b>을 한 번 실행해 주세요.</div>`
      : "";

    const box = $("timeline");
    const items = filteredExpenses();
    if (!items.length) {
      box.innerHTML = `<div class="empty">${state.filter.memberId
        ? "해당하는 지출이 없어요."
        : "아직 등록된 지출이 없어요.<br>입력 화면에서 첫 지출을 넣어보세요."}</div>`;
      return;
    }

    const days = groupByDay(items);
    if (expand) addDropTargets(days);
    const peak = Math.max.apply(null, days.map((d) => d.total).concat([1]));
    const shareMode = state.filter.memberId && state.filter.mode === "share";
    box.innerHTML = "";
    days.forEach((day) => {
      const wrap = document.createElement("div");
      wrap.className = "tl-day" + (day.vacant ? " vacant" : "");
      const name = day.dayIndex === null ? "❓ 미지정"
        : (day.dayIndex === PREP_DAY ? "🎒 여행 전 준비" : day.dayIndex + "일차");
      const date = (day.dayIndex === null || day.dayIndex === PREP_DAY) ? "" : dayDateLabel(day.dayIndex);

      const head = document.createElement("div");
      head.className = "tl-day-head";
      head.innerHTML = `<span class="tl-day-num">${name}</span>
        <span class="tl-day-date">${date}</span>
        <span class="tl-day-total">${money(day.total, "KRW")}</span>`;
      wrap.appendChild(head);

      // relative bar — shows at a glance which day the money went
      const bar = document.createElement("div");
      bar.className = "tl-bar";
      bar.innerHTML = `<i style="width:${Math.max(2, Math.round(day.total / peak * 100))}%"></i>`;
      wrap.appendChild(bar);

      const row = (e) => timelineRow(e, shareMode ? shareOf(e, state.filter.memberId) : undefined);
      if (day.dayIndex === PREP_DAY) {
        // prep spending has no time of day, so no spine — just the list
        const zone = dropZone(PREP_DAY, null);
        day.slots.forEach((g) => g.items.forEach((e) => zone.appendChild(row(e))));
        wrap.appendChild(zone);
      } else {
        const body = document.createElement("div");
        body.className = "tl-body";
        day.slots.forEach((g) => {
          const sl = document.createElement("div");
          sl.className = "tl-slot" + (g.items.length ? "" : " vacant");
          sl.innerHTML = `<span class="tl-dot">${SLOT_EMOJI[g.slot] || "❓"}</span>
            <div class="tl-slot-name">${g.slot || "미지정"}</div>`;
          const zone = dropZone(day.dayIndex, g.slot);
          g.items.forEach((e) => zone.appendChild(row(e)));
          sl.appendChild(zone);
          body.appendChild(sl);
        });
        wrap.appendChild(body);
      }
      box.appendChild(wrap);
    });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ═══════════════════ DRAG ═══════════════════
  // Grab the ⋮⋮ grip and drop the expense into any slot on any day. The row
  // itself stays in the list as the placeholder while a clone follows the
  // finger, so the surrounding rows reflow exactly where it will land.
  let dragging = null;
  let arming = null;

  // Re-render without the list sliding around: whatever the page height does,
  // this one row keeps the same spot on screen.
  function keepRowInPlace(id, render) {
    const sel = '.tl-row[data-id="' + id + '"]';
    const el = document.querySelector(sel);
    const before = el ? el.getBoundingClientRect().top : null;
    render();
    if (before === null) return;
    const after = document.querySelector(sel);
    if (after) window.scrollBy(0, after.getBoundingClientRect().top - before);
  }

  const HOLD_MS = 320;   // how long a finger must sit still before it drags
  const SLIP_PX = 8;     // travel that means "this was a scroll, not a grab"

  // A thumb scrolling the list lands right on the grip. Touch therefore has to
  // hold still to start a drag — any travel means scroll, and the page keeps
  // scrolling normally (the grip is pan-y). A mouse has no such ambiguity.
  function beginDrag(ev, id) {
    if (dragging || arming) return;
    if (ev.button > 0) return;
    const grip = ev.currentTarget;
    if (ev.pointerType === "mouse") {
      ev.preventDefault();
      startDrag(id, ev.clientY, ev.pointerId);
      return;
    }
    arming = { id: id, grip: grip, startY: ev.clientY, lastY: ev.clientY,
               panY: ev.clientY, mode: "hold", pointerId: ev.pointerId };
    arming.onMove = (e) => {
      const a = arming;
      if (!a) return;
      if (a.mode === "hold") {
        if (Math.abs(e.clientY - a.startY) <= SLIP_PX) { a.lastY = e.clientY; return; }
        // Travelled: this is a swipe, not a grab. The grip is touch-action:none
        // so the browser will not scroll for us — do it by hand, matching the
        // finger, so the right edge of the list doesn't become a dead strip.
        a.mode = "pan";
        clearTimeout(a.timer);
        a.grip.classList.remove("arming");
        a.panY = a.startY; // count the travel so far, or the swipe starts late
      }
      window.scrollBy(0, a.panY - e.clientY);
      a.panY = e.clientY;
    };
    arming.onOff = () => disarm();
    // on document, not the grip: the finger slides off it, and after the drag
    // starts the grip element is replaced anyway
    document.addEventListener("pointermove", arming.onMove);
    document.addEventListener("pointerup", arming.onOff);
    document.addEventListener("pointercancel", arming.onOff);
    grip.classList.add("arming");
    arming.timer = setTimeout(() => {
      const a = arming;
      disarm();
      if (navigator.vibrate) navigator.vibrate(12);
      startDrag(a.id, a.lastY, a.pointerId);
    }, HOLD_MS);
  }

  function disarm() {
    const a = arming;
    if (!a) return;
    arming = null;
    clearTimeout(a.timer);
    a.grip.classList.remove("arming");
    document.removeEventListener("pointermove", a.onMove);
    document.removeEventListener("pointerup", a.onOff);
    document.removeEventListener("pointercancel", a.onOff);
  }

  function startDrag(id, clientY, pointerId) {
    if (dragging) return;
    const first = document.querySelector('.tl-row[data-id="' + id + '"]');
    if (!first) return;

    // Open up every slot and day as a drop target. That adds a lot of height,
    // so hold this row still on screen or the list jumps out from under the
    // finger before the drag has even started.
    keepRowInPlace(id, () => renderTimeline(true));
    const row = document.querySelector('.tl-row[data-id="' + id + '"]');
    if (!row) return;

    // The re-render replaced every row, so the grip that was pressed is now
    // detached and will never see another pointer event. Bind to the new one.
    const grip = row.querySelector(".tl-grip");
    if (!grip) return;

    const r = row.getBoundingClientRect();
    // The page can't always scroll far enough to keep the row exactly under the
    // finger (near the bottom it runs out), so pin the grab point inside the row
    // — otherwise the clone floats off at an angle nowhere near the finger.
    const grab = Math.max(0, Math.min(clientY - r.top, r.height));
    const e = state.expenses.find((x) => x.id === id);
    const float = document.createElement("div");
    float.className = "tl-float";
    float.style.width = r.width + "px";
    float.appendChild(expenseItem(e));
    document.body.appendChild(float);

    dragging = { id: id, row: row, float: float, grip: grip,
                 left: r.left, grabY: grab, lastY: clientY, raf: 0,
                 // where it started, so an interrupted drag can put it back
                 homeZone: row.parentElement, homeNext: row.nextElementSibling };
    row.classList.add("placeholder");
    document.body.classList.add("dragging");
    followFinger();

    // Deliberately NO setPointerCapture. The captured element would be the grip,
    // which lives inside the row we re-parent on every move — and moving a
    // capturing element releases the capture and fires pointercancel, so the
    // drag died on the first finger movement. Listening on document needs no
    // capture anyway.
    document.addEventListener("pointermove", onDragMove);
    document.addEventListener("pointerup", endDrag);
    // A cancel is not a drop: put the row back rather than filing it somewhere
    // the user never chose.
    document.addEventListener("pointercancel", cancelDrag);
    window.addEventListener("blur", cancelDrag);
    document.addEventListener("visibilitychange", cancelDrag);
    dragging.raf = requestAnimationFrame(dragTick);
  }

  function followFinger() {
    const d = dragging;
    d.float.style.transform = "translate(" + d.left + "px," + (d.lastY - d.grabY) + "px)";
  }

  function onDragMove(ev) {
    if (!dragging) return;
    ev.preventDefault();
    dragging.lastY = ev.clientY;
    followFinger();
    placeRow(ev.clientY); // on the event itself, not the frame loop — see dragTick
  }

  // Only job is the edge scroll: hold the finger near the top or bottom and the
  // page keeps moving even though no pointermove events are arriving. Placement
  // is driven by onDragMove instead, so a throttled or paused rAF (background
  // tab, reduced motion) can never leave the placeholder stuck.
  function dragTick() {
    if (!dragging) return;
    const pad = 90, h = window.innerHeight, y = dragging.lastY;
    let by = 0;
    if (y < pad) by = -Math.ceil((pad - y) / 8);
    else if (y > h - pad) by = Math.ceil((y - (h - pad)) / 8);
    if (by) { window.scrollBy(0, by); placeRow(y); followFinger(); }
    dragging.raf = requestAnimationFrame(dragTick);
  }

  // Move the placeholder into whichever drop zone the finger is over. Zones can
  // be a few pixels tall when empty, so fall back to the nearest one.
  function placeRow(y) {
    const zones = [].slice.call(document.querySelectorAll("#timeline .tl-rows"));
    let best = null, bestGap = Infinity;
    zones.forEach((z) => {
      const r = z.getBoundingClientRect();
      const gap = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
      if (gap < bestGap) { bestGap = gap; best = z; }
    });
    if (!best) return;
    const rows = [].slice.call(best.children).filter((n) => n !== dragging.row);
    let before = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) { before = rows[i]; break; }
    }
    if (before) best.insertBefore(dragging.row, before);
    else best.appendChild(dragging.row);
  }

  // tear down the drag and hand back the row so callers can decide what it means
  function stopDrag() {
    const d = dragging;
    if (!d) return null;
    dragging = null;
    cancelAnimationFrame(d.raf);
    document.removeEventListener("pointermove", onDragMove);
    document.removeEventListener("pointerup", endDrag);
    document.removeEventListener("pointercancel", cancelDrag);
    window.removeEventListener("blur", cancelDrag);
    document.removeEventListener("visibilitychange", cancelDrag);
    d.float.remove();
    d.row.classList.remove("placeholder");
    document.body.classList.remove("dragging");
    return d;
  }

  // the finger lifted — file the expense wherever the placeholder ended up
  async function endDrag() {
    const d = stopDrag();
    if (!d) return;
    const zone = d.row.parentElement;
    if (!zone || !zone.classList.contains("tl-rows")) { renderTimeline(); return; }
    const index = [].slice.call(zone.children).indexOf(d.row);
    await commitDrag(d.id, Number(zone.dataset.day), zone.dataset.slot || null, index);
  }

  // the gesture was taken away (app switch, incoming call) — put it back
  function cancelDrag() {
    const d = stopDrag();
    if (!d) return;
    if (d.homeZone && d.homeZone.isConnected) d.homeZone.insertBefore(d.row, d.homeNext);
    renderTimeline();
  }

  // Write the new arrangement: the target bucket is renumbered 0..n-1 with the
  // expense inserted, and the bucket it left closes its gap.
  async function commitDrag(id, day, slot, index) {
    const moving = state.expenses.find((e) => e.id === id);
    if (!moving) { renderTimeline(); return; }
    const fromDay = dayOf(moving), fromSlot = slotKeyOf(moving);
    const byOrder = (a, b) =>
      (a.seq || 0) - (b.seq || 0) || (new Date(a.created_at) - new Date(b.created_at));
    const inBucket = (e, dd, ss) => e.id !== id && dayOf(e) === dd && slotKeyOf(e) === ss;

    const target = state.expenses.filter((e) => inBucket(e, day, slot)).sort(byOrder);
    target.splice(Math.max(0, Math.min(index, target.length)), 0, moving);

    const writes = [];
    const local = []; // what to apply here, so the list settles before the network does
    target.forEach((e, k) => {
      const patch = {};
      if (e.id === id) {
        if (fromDay !== day) patch.day_index = day;
        if (fromSlot !== slot) patch.slot = slot;
      }
      if (e.seq !== k) patch.seq = k;
      if (Object.keys(patch).length) {
        writes.push(sb.from("expenses").update(patch).eq("id", e.id));
        local.push([e, patch]);
      }
    });
    if (fromDay !== day || fromSlot !== slot) {
      state.expenses.filter((e) => inBucket(e, fromDay, fromSlot)).sort(byOrder)
        .forEach((e, k) => {
          if (e.seq !== k) {
            writes.push(sb.from("expenses").update({ seq: k }).eq("id", e.id));
            local.push([e, { seq: k }]);
          }
        });
    }
    if (!writes.length) { keepRowInPlace(id, renderTimeline); return; }

    // Collapse the expanded grid right away. Waiting for the round trip leaves
    // every empty slot on screen — a long stretch of dashed boxes on a phone.
    local.forEach((p) => Object.assign(p[0], p[1]));
    keepRowInPlace(id, renderTimeline);

    const bad = (await Promise.all(writes)).find((r) => r && r.error);
    if (bad) {
      if (isMissingTimelineCol(bad.error)) {
        timelineColsMissing = true;
        toast("migration-timeline.sql 먼저 실행해 주세요", true);
      } else toast("이동 실패: " + bad.error.message, true);
      await refetch();
      return;
    }
    if (fromDay !== day || fromSlot !== slot) {
      toast(`${dayLabel(day)}${slot ? " · " + slot : ""}(으)로 옮김`);
    }
    // No refetch: the local copy already matches what was just written, and
    // re-rendering identical content would only shift the page again.
  }

  // ═══════════════════ ACTIONS ═══════════════════
  function parseAmount() {
    const raw = $("amount").value.replace(/[^\d]/g, "");
    return raw ? parseInt(raw, 10) : 0;
  }

  // live "≈₩…" hint under the amount while typing a foreign-currency expense
  function renderAmountPreview() {
    const el = $("amt-krw");
    if (!el || !state.draft) return;
    if (state.draft.currency === "KRW") { el.textContent = ""; return; }
    const amt = parseAmount();
    const r = state.draft.rateKrw ? Number(state.draft.rateKrw) : currentJpyRate().rate;
    el.textContent = amt ? `≈ ${money(amt * r, "KRW")}  ·  100¥ = ${fmt(r * 100)}원` : "";
  }

  async function saveExpense() {
    const d = state.draft;
    const amount = parseAmount();
    if (!amount || amount <= 0) { toast("금액을 입력하세요", true); return; }
    if (d.participants.size === 0) { toast("나눌 사람을 1명 이상 선택", true); return; }
    // New expenses must carry proof. Editing an older one that predates this
    // rule doesn't — otherwise the 49 already in there become uneditable.
    if (!d.editingId && !d.shot && !receiptColMissing) {
      toast("영수증이나 결제내역을 첨부해 주세요", true);
      $("receipt-file").click();
      return;
    }
    const slot = d.dayIndex === PREP_DAY ? null : d.slot;
    const payload = {
      room_id: state.room.id,
      payer_id: d.payerId,
      amount,
      currency: d.currency,
      category: d.category || "기타",
      note: $("note").value.trim() || null,
      participant_ids: [...d.participants],
      day_index: d.dayIndex,
      slot: slot,
      // moving an expense to a different bucket puts it at the end of that one
      seq: (d.editingId && d.dayIndex === d.origDayIndex && slot === d.origSlot && typeof d.seq === "number")
        ? d.seq : nextSeq(d.dayIndex, slot),
    };
    const btn = $("save-btn");
    btn.disabled = true;

    // Upload before writing the row: if the photo can't be stored there must
    // not be an expense pointing at nothing.
    payload.receipt_path = d.receiptPath || null;
    if (d.shot) {
      const label = btn.textContent;
      btn.textContent = "영수증 올리는 중…";
      try {
        payload.receipt_path = await uploadReceipt(d.shot);
      } catch (err) {
        btn.textContent = label;
        btn.disabled = false;
        toast("영수증 업로드 실패 — 연결을 확인하고 다시 시도해 주세요", true);
        return;
      }
      btn.textContent = label;
    }

    // attach the exchange rate this expense settles at
    if (d.currency === "KRW") {
      payload.rate_krw = null; payload.rate_date = null; payload.rate_source = null;
    } else if (d.editingId && d.rateKrw) {
      // editing an existing foreign-currency expense → keep the rate it was saved with
      payload.rate_krw = d.rateKrw; payload.rate_date = d.rateDate; payload.rate_source = d.rateSource;
    } else {
      const live = await fetchRate(todayStr());
      if (live) {
        payload.rate_krw = live.rate; payload.rate_date = live.date; payload.rate_source = "api";
        state.room.base_rate_jpy = live.rate;
        state.room.base_rate_date = live.date;
        sb.from("rooms").update({ base_rate_jpy: live.rate, base_rate_date: live.date }).eq("id", state.room.id);
      } else {
        // offline: never block the save — use the room rate and flag it for later fixing
        const f = currentJpyRate();
        payload.rate_krw = f.rate;
        payload.rate_date = (state.room && state.room.base_rate_date) || null;
        payload.rate_source = f.source;
      }
    }

    const send = (p) => d.editingId
      ? sb.from("expenses").update(p).eq("id", d.editingId)
      : sb.from("expenses").insert(p);

    // An un-migrated DB rejects columns it doesn't have. Drop them and retry —
    // saving must never be blocked by a SQL file nobody ran yet. Two rounds
    // because the rate columns and the timeline columns can both be missing.
    let { error } = await send(sanitize(payload));
    for (let i = 0; i < 3 && error; i++) {
      let dropped = false;
      if (isMissingRateCol(error) && !rateColsMissing) { rateColsMissing = true; dropped = true; }
      if (isMissingTimelineCol(error) && !timelineColsMissing) { timelineColsMissing = true; dropped = true; }
      if (isMissingReceiptCol(error) && !receiptColMissing) { receiptColMissing = true; dropped = true; }
      if (!dropped) break;
      ({ error } = await send(sanitize(payload)));
    }
    btn.disabled = false;
    if (error) { toast("저장 실패: " + error.message, true); return; }
    // Only nag about columns whose absence is a surprise. Running without the
    // rate columns is a deliberate choice here — the ⚡기준환율 badge and the
    // settlement note already say so, and repeating it on every single save is
    // just noise about a decision already made.
    toast(timelineColsMissing || receiptColMissing
      ? "저장됨 (일부 항목 미적용 — SQL 실행 필요)"
      : (d.editingId ? "수정됨" : "저장됨 ✓"));
    // reset for next entry
    freshDraft();
    $("amount").value = "";
    $("note").value = "";
    $("save-btn").textContent = "저장";
    $("who-panel").classList.remove("open");
    $("when-panel").classList.remove("open");
    renderCats();
    renderWho();
    renderWhen();
    renderReceiptBar();
    await refetch();
    $("amount").focus();
  }

  // edit / delete modal
  let modalExpense = null;
  function openExpenseModal(e) {
    modalExpense = e;
    const cur = e.currency || "KRW";
    $("modal-title").textContent = (e.note || e.category || "지출");
    let sub = `${memberName(e.payer_id)} 냄 · ${money(e.amount, cur)}`;
    if (cur !== "KRW") {
      const r = rateOf(e);
      sub += ` → ${money(krwAmount(e), "KRW")}`
        + `\n환율 100¥ = ${fmt(r.rate * 100)}원`
        + (e.rate_date && !isEstimated(e) ? ` (${e.rate_date} 기준)` : "")
        + (isEstimated(e) ? " ⚡기준환율" : "")
        + (r.source === "manual" ? " (직접 입력)" : "");
    }
    if (e.settled) sub += " · ✓정산완료";
    if (dayOf(e) !== null) sub += `\n${dayLabel(e.day_index)}${e.slot ? " · " + (SLOT_EMOJI[e.slot] || "") + e.slot : ""}`;
    $("modal-sub").textContent = sub;
    $("modal-settle").textContent = e.settled ? "↩ 정산완료 해제" : "✓ 현장정산 완료로 표시";
    $("modal-rate").style.display = cur === "KRW" ? "none" : "block";
    $("modal-shot").style.display = receiptColMissing ? "none" : "block";
    $("modal-shot").textContent = e.receipt_path ? "🧾 영수증 보기" : "📷 영수증 첨부";
    // reordering only makes sense when something else shares this day+slot
    const sibs = bucketSiblings(e);
    const i = sibs.findIndex((x) => x.id === e.id);
    $("modal-move").style.display = sibs.length > 1 ? "flex" : "none";
    $("modal-up").disabled = i <= 0;
    $("modal-down").disabled = i < 0 || i >= sibs.length - 1;
    $("modal-back").classList.add("show");
  }

  // Renumber the whole bucket instead of swapping two rows: pre-migration rows
  // have no seq at all, so a swap would be a no-op on them.
  async function moveExpense(dir) {
    const e = modalExpense;
    const list = bucketSiblings(e);
    const i = list.findIndex((x) => x.id === e.id);
    const j = i + dir;
    closeModal();
    if (i < 0 || j < 0 || j >= list.length) return;
    list.splice(j, 0, list.splice(i, 1)[0]);
    const writes = list
      .map((x, k) => (x.seq === k ? null : sb.from("expenses").update({ seq: k }).eq("id", x.id)))
      .filter(Boolean);
    const bad = (await Promise.all(writes)).find((r) => r && r.error);
    if (bad) {
      if (isMissingTimelineCol(bad.error)) {
        timelineColsMissing = true;
        toast("migration-timeline.sql 먼저 실행해 주세요", true);
      } else toast("순서 변경 실패: " + bad.error.message, true);
      return;
    }
    await refetch();
  }

  // ── manual rate override ──
  let rateExpense = null;
  function openRateModal() {
    const e = modalExpense;
    rateExpense = e; // our own handle — closeModal() clears modalExpense
    closeModal();
    $("rate-sub").textContent = `${money(e.amount, e.currency)} → 현재 ${money(krwAmount(e), "KRW")}`;
    $("rate-input").value = trimZeros((rateOf(e).rate * 100).toFixed(2));
    $("rate-back").classList.add("show");
  }
  function closeRateModal() { $("rate-back").classList.remove("show"); rateExpense = null; }

  async function saveRate() {
    const per100 = parseFloat($("rate-input").value.replace(/[^\d.]/g, ""));
    if (!per100 || per100 <= 0) { toast("환율을 입력하세요", true); return; }
    const e = rateExpense;
    closeRateModal();
    const { error } = await sb.from("expenses")
      .update({ rate_krw: per100 / 100, rate_source: "manual" }).eq("id", e.id);
    if (isMissingRateCol(error)) {
      rateColsMissing = true;
      toast("환율 저장용 칼럼이 없어요 — migration-rate.sql 먼저 실행", true);
      return;
    }
    if (error) { toast("실패: " + error.message, true); return; }
    toast("환율 수정됨");
    await refetch();
  }
  function closeModal() { $("modal-back").classList.remove("show"); modalExpense = null; }

  async function toggleSettled() {
    const e = modalExpense;
    const next = !e.settled;
    closeModal();
    const { error } = await sb.from("expenses").update({ settled: next }).eq("id", e.id);
    if (error) { toast("실패: " + error.message, true); return; }
    toast(next ? "현장정산 처리됨 — 최종 정산에서 제외" : "정산완료 해제됨");
    await refetch();
  }

  // modal: view the photo, or attach one to an expense that predates the rule
  let attachTo = null;
  function modalShot() {
    const e = modalExpense;
    closeModal();
    if (e.receipt_path) { openShot(e.receipt_path); return; }
    attachTo = e;
    $("attach-file").click();
  }

  async function attachReceipt(file) {
    const e = attachTo;
    attachTo = null;
    $("attach-file").value = "";
    if (!e || !file) return;
    toast("영수증 올리는 중…");
    let key;
    try {
      key = await uploadReceipt(await readShot(file));
    } catch (err) {
      toast(err.message || "업로드 실패 — 연결을 확인해 주세요", true);
      return;
    }
    const { error } = await sb.from("expenses").update({ receipt_path: key }).eq("id", e.id);
    if (error) {
      if (isMissingReceiptCol(error)) {
        receiptColMissing = true;
        toast("migration-receipt.sql 먼저 실행해 주세요", true);
      } else toast("저장 실패: " + error.message, true);
      return;
    }
    toast("영수증 첨부됨 ✓");
    await refetch();
  }

  function editExpense() {
    const e = modalExpense;
    freshDraft();
    state.draft.editingId = e.id;
    state.draft.currency = e.currency || "KRW";
    state.draft.rateKrw = e.rate_krw;
    state.draft.rateDate = e.rate_date;
    state.draft.rateSource = e.rate_source;
    state.draft.category = e.category;
    state.draft.payerId = e.payer_id;
    state.draft.participants = new Set((e.participant_ids && e.participant_ids.length) ? e.participant_ids : [e.payer_id]);
    // keep the slot it already sits in; only recompute seq if the user moves it
    if (dayOf(e) !== null) state.draft.dayIndex = e.day_index;
    if (e.slot) state.draft.slot = e.slot;
    state.draft.seq = (typeof e.seq === "number") ? e.seq : null;
    state.draft.origDayIndex = state.draft.dayIndex;
    state.draft.origSlot = slotKeyOf(e);
    state.draft.receiptPath = e.receipt_path || null;
    closeModal();
    show("screen-input");
    $("amount").value = fmt(e.amount);
    $("note").value = e.note || "";
    renderCats();
    renderWho();
    renderWhen();
    renderReceiptBar();
    $("save-btn").textContent = "수정 저장";
    toast("수정 모드");
  }

  async function deleteExpense() {
    const e = modalExpense;
    closeModal();
    const { error } = await sb.from("expenses").delete().eq("id", e.id);
    if (error) { toast("삭제 실패", true); return; }
    toast("삭제됨");
    await refetch();
  }

  // ═══════════════════ ONBOARDING ═══════════════════
  async function createRoom() {
    const name = $("create-name").value.trim();
    const meName = $("create-me").value.trim();
    const cur = $("create-cur").querySelector(".on").dataset.cur;
    const start = $("create-start").value;
    if (!name) { toast("여행 이름을 입력하세요", true); return; }
    if (!start) { toast("여행 시작일을 선택하세요", true); return; }
    if (!meName) { toast("내 이름을 입력하세요", true); return; }
    const id = genRoomId();
    const pw = $("create-pw").value;
    const btn = $("create-go"); btn.disabled = true;

    // The key goes in at creation time and is remembered here, so the creator
    // never has to type it again on this device.
    const row = { id, name, default_currency: cur, start_date: start };
    if (accountsReady && me) row.created_by = me.id;
    let key = null;
    if (pw) {
      try {
        key = await roomKey(id, pw);
        row.pw_hash = await sha256Hex(key); // the server stores the hash of the key
        rememberKey(id, key);
      } catch (err) { btn.disabled = false; toast(err.message, true); return; }
    }
    let { error: rErr } = await sb.from("rooms").insert(row);
    if (rErr && /pw_hash/.test(rErr.message || "")) {
      // database predates the password migration — make the room unlocked
      delete row.pw_hash;
      forgetKey(id); key = null;
      ({ error: rErr } = await sb.from("rooms").insert(row));
      if (!rErr && pw) toast("비밀번호는 아직 적용 안 됨 — SQL 실행 필요", true);
    }
    if (rErr && isMissingTimelineCol(rErr)) {
      // un-migrated DB: make the room anyway, the date can be set later
      timelineColsMissing = true;
      delete row.start_date;
      ({ error: rErr } = await sb.from("rooms").insert(row));
    }
    if (rErr) { btn.disabled = false; toast("방 생성 실패: " + rErr.message, true); return; }
    useKey(key); // members/expenses below need the key straight away
    const memRow = { room_id: id, name: meName };
    if (accountsReady && me) memRow.user_id = me.id;
    const { data: mem, error: mErr } = await sb.from("members").insert(memRow).select().single();
    if (mErr) { btn.disabled = false; toast("멤버 생성 실패", true); return; }
    rememberMe(id, mem.id);
    markOwner(id); // this device created the trip → can delete it
    // put slug in URL and boot
    history.replaceState(null, "", "?r=" + id);
    btn.disabled = false;
    await boot();
  }

  function renderIdentity() {
    $("ident-room").textContent = state.room.name;
    const wrap = $("ident-chips");
    wrap.innerHTML = "";
    state.members.forEach((m) => {
      const b = document.createElement("button");
      b.className = "name-chip";
      b.textContent = m.name;
      b.onclick = () => { rememberMe(state.room.id, m.id); enterApp(m.id); };
      wrap.appendChild(b);
    });
  }
  function openIdentityChange() {
    $("ident-back").style.display = "block";
    renderIdentity();
    show("screen-identity");
  }

  async function addIdentity() {
    const name = $("ident-new").value.trim();
    if (!name) { toast("이름을 입력하세요", true); return; }
    const row = { room_id: state.room.id, name };
    if (accountsReady && me) row.user_id = me.id; // this row is now mine
    const { data: mem, error } = await sb.from("members").insert(row).select().single();
    if (error) { toast("추가 실패", true); return; }
    rememberMe(state.room.id, mem.id);
    state.members.push(mem);
    enterApp(mem.id);
  }

  function enterApp(meId) {
    state.me = meId;
    saveRoomToList(state.room); // remember this trip on this device
    freshDraft();
    $("save-btn").textContent = "저장";
    renderCats();
    renderAll();
    show("screen-input");
    setTimeout(() => $("amount").focus(), 100);
  }

  // ── home (every trip) ──
  // The list used to live only in this browser, which meant a trip vanished on
  // a new device, after installing to the home screen, or simply because iOS
  // clears site storage that hasn't been touched for a week. It comes from the
  // server now; the local record only marks which ones you've been in.
  async function renderHome() {
    const box = $("home-list");
    box.innerHTML = `<div class="empty">불러오는 중…</div>`;
    const mine = {};
    getSavedRooms().forEach((r) => { mine[r.id] = true; });
    const rooms = await loadAllRooms();
    if (!rooms.length) {
      box.innerHTML = `<div class="empty">아직 만들어진 여행이 없어요.</div>`;
      return;
    }
    box.innerHTML = "";
    // ones you've already joined first — that's almost always what you want
    rooms.sort((a, b) => (mine[b.id] ? 1 : 0) - (mine[a.id] ? 1 : 0));
    rooms.forEach((r) => {
      const b = document.createElement("button");
      b.className = "trip-row";
      const lock = isLocked(r)
        ? `<span class="t-lock">${recallKey(r.id) ? "🔓" : "🔒"}</span>` : "";
      const tag = mine[r.id] ? `<span class="t-mine">참여 중</span>` : "";
      b.innerHTML = `<span class="t-name">${escapeHtml(r.name)}${lock}${tag}</span>
        <span class="t-arrow">→</span>`;
      b.onclick = () => enterRoom(r);
      box.appendChild(b);
    });
  }

  // Tapping a trip: unlocked ones open, locked ones ask once and remember.
  function enterRoom(room) {
    if (isLocked(room) && !recallKey(room.id)) { askPassword(room); return; }
    location.search = "?r=" + room.id;
  }

  // ── 로그인 화면 ──
  function renderAuth() {
    const up = authMode === "up";
    $("auth-tabs").querySelectorAll("button").forEach((b) =>
      b.classList.toggle("on", b.dataset.mode === authMode));
    $("auth-sub").textContent = up ? "이름과 비밀번호를 정해요" : "이름과 비밀번호로 들어와요";
    $("auth-id-hint").textContent = up ? "— 실명 두 글자" : "";
    $("auth-signup-only").style.display = up ? "block" : "none";
    $("auth-go").textContent = up ? "시작하기" : "로그인";
    $("auth-pw").setAttribute("autocomplete", up ? "new-password" : "current-password");
    $("auth-forgot").style.display = up ? "none" : "block";
  }

  async function submitAuth() {
    const handle = $("auth-handle").value.trim();
    const pw = $("auth-pw").value;
    const btn = $("auth-go");
    if (!HANDLE_RE.test(handle)) { toast("이름은 2~8글자로 적어주세요", true); return; }
    if (pw.length < 6) { toast("비밀번호는 6자리예요", true); return; }
    btn.disabled = true;
    try {
      if (authMode === "up") {
        const q = $("auth-q").value.trim(), a = $("auth-a").value.trim();
        if (!q || !a) { toast("비밀번호를 잊었을 때 쓸 질문과 답을 적어주세요", true); btn.disabled = false; return; }
        if (await handleTaken(handle)) {
          const free = await freeHandle(handle);
          toast(free ? `'${handle}'은 이미 있어요 — '${free}'는 어때요?` : `'${handle}'은 이미 있어요`, true);
          if (free) $("auth-handle").value = free;
          btn.disabled = false; return;
        }
        await doSignUp(handle, pw, q, a);
      } else {
        await doSignIn(handle, pw);
      }
      btn.disabled = false;
      await afterLogin();
    } catch (err) {
      btn.disabled = false;
      toast(err.message || "실패했어요", true);
    }
  }

  // Where to go once we know who you are: straight into the trip from a link,
  // otherwise the list.
  async function afterLogin() {
    const roomId = new URLSearchParams(location.search).get("r");
    if (roomId) { await boot(); return; }
    show("screen-home");
    $("home-me").textContent = me ? me.name : "-";
    await renderHome();
  }

  async function logout() {
    await sb.auth.signOut();
    me = null;
    location.href = location.pathname;
  }

  // ── 비밀번호 찾기 ──
  function openForgot() {
    $("forgot-handle").value = "";
    $("forgot-a").value = "";
    $("forgot-new").value = "";
    $("forgot-step2").style.display = "none";
    $("forgot-sub").textContent = "이름을 넣으면 가입할 때 정한 질문이 나와요.";
    $("forgot-back").classList.add("show");
  }
  function closeForgot() { $("forgot-back").classList.remove("show"); }

  async function askHint() {
    const h = $("forgot-handle").value.trim();
    if (!h) { toast("이름을 적어주세요", true); return; }
    const { data, error } = await sb.rpc("hint_question", { p_handle: h });
    if (error) { toast("확인 실패: " + error.message, true); return; }
    if (!data) { toast("그 이름으로 정해둔 질문이 없어요", true); return; }
    $("forgot-q").textContent = data;
    $("forgot-step2").style.display = "block";
    $("forgot-sub").textContent = "답을 맞히면 새 비밀번호로 바꿀 수 있어요.";
    setTimeout(() => $("forgot-a").focus(), 60);
  }

  async function resetPassword() {
    const h = $("forgot-handle").value.trim();
    const a = $("forgot-a").value.trim();
    const np = $("forgot-new").value;
    if (!a) { toast("답을 적어주세요", true); return; }
    if (np.length < 6) { toast("새 비밀번호는 6자리예요", true); return; }
    const { data, error } = await sb.rpc("reset_password",
      { p_handle: h, p_answer: a, p_new_pw: np });
    if (error) { toast("실패: " + error.message, true); return; }
    const msg = { ok: null, wrong: "답이 맞지 않아요", locked: "여러 번 틀려서 15분간 잠겼어요",
                  nohint: "그 이름으로 정해둔 질문이 없어요", short: "비밀번호는 6자리예요" };
    if (data !== "ok") { toast(msg[data] || "실패했어요", true); return; }
    closeForgot();
    toast("비밀번호가 바뀌었어요 — 새 비밀번호로 로그인하세요");
    $("auth-handle").value = h;
    $("auth-pw").value = "";
    $("auth-pw").focus();
  }

  // ── 이 사람이 나예요 (기존 기록 잇기) ──
  function openClaim(unclaimed) {
    const box = $("claim-chips");
    box.innerHTML = "";
    unclaimed.forEach((m) => {
      const b = document.createElement("button");
      b.className = "name-chip";
      b.textContent = m.name;
      b.onclick = () => claimMember(m.id);
      box.appendChild(b);
    });
    $("claim-sub").textContent = unclaimed.length
      ? "전에 쓰던 이름을 고르면 그동안의 기록이 그대로 이어져요."
      : "아직 아무도 없어요. 새로 참여하면 돼요.";
    $("claim-back").classList.add("show");
  }
  function closeClaim() { $("claim-back").classList.remove("show"); }

  // Taking a seat goes through the server, which checks the seat is in this
  // trip and still free. Leaving that to a row policy would mean the policy has
  // to let strangers see unclaimed rows — and a policy that shows rows also
  // lets them be listed.
  const missingFn = (err) => !!err && /does not exist|schema cache|PGRST202/i.test(err.message || "");

  async function claimMember(memberId) {
    let { data, error } = await sb.rpc("claim_seat",
      { p_room: state.room.id, p_member: memberId });
    if (missingFn(error)) {
      // The locking migration hasn't run yet, so the function isn't there —
      // take the seat directly, which the current policies still allow.
      const r = await sb.from("members").update({ user_id: me.id })
        .eq("id", memberId).eq("room_id", state.room.id).is("user_id", null).select();
      error = r.error;
      data = !!(r.data && r.data.length);
    }
    if (error) { toast("실패: " + error.message, true); return; }
    if (data !== true) { toast("이미 다른 사람이 가져갔어요", true); return; }
    closeClaim();
    rememberMe(state.room.id, memberId);
    // Re-boot rather than patch state: until this moment the trip's rows were
    // invisible to us, so there is nothing loaded to update.
    location.search = "?r=" + state.room.id;
  }

  async function claimAsNew() {
    const name = (me && me.name) || "";
    let { data, error } = await sb.rpc("join_room", { p_room: state.room.id, p_name: name });
    if (missingFn(error)) {
      const r = await sb.from("members")
        .insert({ room_id: state.room.id, name: name, user_id: me.id }).select().single();
      error = r.error;
      data = r.data && r.data.id;
    }
    if (error || !data) { toast("참여 실패" + (error ? ": " + error.message : ""), true); return; }
    closeClaim();
    rememberMe(state.room.id, data);
    location.search = "?r=" + state.room.id;
  }

  // ── password gate ──
  // Does the key we already stored still open this trip? (The owner may have
  // changed the password since.)
  async function keyWorks(roomId) {
    const key = recallKey(roomId);
    if (!key) return false;
    useKey(key);
    const { data, error } = await sb.rpc("room_ok", { p_room: roomId });
    if (error) return true; // database predates the migration — nothing is locked yet
    if (data !== true) { forgetKey(roomId); useKey(null); return false; }
    return true;
  }

  let pwRoom = null;
  function askPassword(room, opts) {
    pwRoom = room;
    const retry = opts && opts.retry;
    $("pw-title").textContent = escapeHtml(room.name);
    $("pw-sub").textContent = retry
      ? "비밀번호가 맞지 않아요. 다시 입력해 주세요."
      : "이 여행은 비밀번호가 걸려 있어요.";
    $("pw-input").value = "";
    $("pw-back").classList.add("show");
    setTimeout(() => $("pw-input").focus(), 80);
  }
  function closePassword() { $("pw-back").classList.remove("show"); pwRoom = null; }

  async function submitPassword() {
    const room = pwRoom;
    const pw = $("pw-input").value;
    if (!room || !pw) { toast("비밀번호를 입력하세요", true); return; }
    let key;
    try { key = await roomKey(room.id, pw); }
    catch (err) { toast(err.message, true); return; }
    // The server decides, not this screen. room_ok() reads a hash this client
    // is not allowed to select, so there is nothing here to bypass — and it
    // answers even for a trip that has no expenses in it yet.
    const { data, error } = await makeClient(key).rpc("room_ok", { p_room: room.id });
    if (error) { toast("확인 실패: " + error.message, true); return; }
    if (data !== true) { askPassword(room, { retry: true }); return; }
    rememberKey(room.id, key);
    closePassword();
    location.search = "?r=" + room.id;
  }

  // ═══════════════════ BOOT ═══════════════════
  async function boot() {
    const params = new URLSearchParams(location.search);
    const roomId = params.get("r");
    await checkAccounts();
    // Everything starts from "who is this?". Without a session there is
    // nothing to show — the trip list is now personal.
    if (accountsReady && !me) {
      await loadMe();
      if (!me) { renderAuth(); show("screen-auth"); return; }
    }

    if (!roomId) {
      show("screen-home");
      $("home-me").textContent = me ? me.name : "-";
      await renderHome();
      return;
    }

    show("screen-loading");
    useKey(recallKey(roomId)); // a trip unlocked before stays unlocked
    let room;
    try { room = await loadRoom(roomId); }
    catch (err) {
      toast("연결 오류: " + (err && err.message ? err.message : err), true);
      $("create-start").value = todayStr();
      show("screen-create");
      return;
    }
    // Invited by link but not in the trip yet: the row policy hides it, so ask
    // the server what it's called and who is still unclaimed.
    if (!room && accountsReady && me) {
      const peek = await sb.rpc("room_peek", { p_room: roomId });
      if (peek.data) {
        state.room = { id: roomId, name: peek.data };
        const roster = await sb.rpc("room_roster", { p_room: roomId });
        $("ident-room").textContent = peek.data;
        $("ident-chips").innerHTML = "";
        $("ident-back").style.display = "none";
        show("screen-identity");
        openClaim((roster.data || []).map((m) => ({ id: m.id, name: m.name })));
        return;
      }
    }
    if (!room) {
      forgetRoomLocal(roomId); // deleted or gone → drop from my list
      toast("방을 찾을 수 없어요 (삭제됐을 수 있어요)", true);
      goHome();
      return;
    }

    // A locked trip opened straight from a link. Without this the members and
    // expenses would come back empty and it would look like a blank trip
    // rather than one that needs a password.
    if (isLocked(room) && !(await keyWorks(roomId))) {
      show("screen-home");
      await renderHome();
      askPassword(room);
      return;
    }

    state.room = room;
    // Ask once whether receipts can be stored at all. Requiring a photo the
    // database has nowhere to put would lock the app up entirely. Anything
    // unexpected here must not strand the boot on the loading screen.
    try {
      const probe = await sb.from("expenses").select("receipt_path").limit(1);
      receiptColMissing = !!probe.error;
    } catch (err) {
      receiptColMissing = true;
    }
    await refetch();
    subscribeRealtime();
    // refresh the room's fallback rate in the background; re-render if it moved
    warmRoomRate().then((changed) => { if (changed) renderAll(); });

    // With accounts, "who am I in this trip" is answered by the link between a
    // member row and the logged-in user, not by a name saved in this browser.
    if (accountsReady && me) {
      const mine = state.members.find((m) => m.user_id === me.id);
      if (mine) { rememberMe(roomId, mine.id); enterApp(mine.id); return; }
      const unclaimed = state.members.filter((m) => !m.user_id);
      show("screen-identity");
      renderIdentity();
      $("ident-back").style.display = "none";
      openClaim(unclaimed);
      return;
    }

    const savedMe = recallMe(roomId);
    if (savedMe && state.members.some((m) => m.id === savedMe)) {
      enterApp(savedMe);
    } else {
      $("ident-back").style.display = "none"; // first join: no cancel
      renderIdentity();
      show("screen-identity");
    }
  }

  // ═══════════════════ WIRE EVENTS ═══════════════════
  function wire() {
    // install hint
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();       // keep Chrome's own banner out of the way
      installPrompt = e;
      renderInstallHint(document.querySelector(".screen.active").id);
    });
    window.addEventListener("appinstalled", dismissInstallHint);
    $("install-x").onclick = dismissInstallHint;
    $("install-go").onclick = async () => {
      // Chrome: one tap straight into the OS install dialog.
      // Everywhere else: the closest thing available, which is instructions.
      if (!installPrompt) { openInstallGuide(); return; }
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      dismissInstallHint();
    };
    $("guide-close").onclick = closeInstallGuide;
    $("guide-back").onclick = (e) => { if (e.target === $("guide-back")) closeInstallGuide(); };

    // home (my trips)
    $("home-new").onclick = () => {
      $("create-back").style.display = getSavedRooms().length ? "block" : "none";
      if (!$("create-start").value) $("create-start").value = todayStr();
      show("screen-create");
    };
    $("create-back").onclick = () => { show("screen-home"); renderHome(); };

    // accounts
    $("auth-tabs").querySelectorAll("button").forEach((b) => {
      b.onclick = () => { authMode = b.dataset.mode; renderAuth(); };
    });
    $("auth-go").onclick = submitAuth;
    $("auth-handle").addEventListener("keydown", (e) => { if (e.key === "Enter") $("auth-pw").focus(); });
    $("auth-pw").addEventListener("keydown", (e) => { if (e.key === "Enter" && authMode === "in") submitAuth(); });
    $("auth-a").addEventListener("keydown", (e) => { if (e.key === "Enter") submitAuth(); });
    $("auth-forgot").onclick = openForgot;
    $("home-logout").onclick = logout;
    $("forgot-ask").onclick = askHint;
    $("forgot-save").onclick = resetPassword;
    $("forgot-cancel").onclick = closeForgot;
    $("forgot-back").onclick = (e) => { if (e.target === $("forgot-back")) closeForgot(); };
    $("forgot-handle").addEventListener("keydown", (e) => { if (e.key === "Enter") askHint(); });
    $("claim-new").onclick = claimAsNew;
    $("claim-cancel").onclick = closeClaim;

    // password gate
    $("pw-go").onclick = submitPassword;
    $("pw-cancel").onclick = closePassword;
    $("pw-back").onclick = (e) => { if (e.target === $("pw-back")) closePassword(); };
    $("pw-input").addEventListener("keydown", (e) => { if (e.key === "Enter") submitPassword(); });
    $("lock-btn").onclick = openSetPw;
    $("setpw-save").onclick = saveRoomPassword;
    $("setpw-cancel").onclick = closeSetPw;
    $("setpw-back").onclick = (e) => { if (e.target === $("setpw-back")) closeSetPw(); };
    $("setpw-input").addEventListener("keydown", (e) => { if (e.key === "Enter") saveRoomPassword(); });

    // create screen
    $("create-cur").querySelectorAll("button").forEach((b) => {
      b.onclick = () => { renderCurToggle("create-cur", b.dataset.cur); };
    });
    $("create-go").onclick = createRoom;
    $("create-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("create-me").focus(); });
    $("create-me").addEventListener("keydown", (e) => { if (e.key === "Enter") createRoom(); });

    // identity
    $("ident-add").onclick = addIdentity;
    $("ident-new").addEventListener("keydown", (e) => { if (e.key === "Enter") addIdentity(); });
    $("ident-back").onclick = () => show("screen-status");
    $("change-me").onclick = openIdentityChange;

    // input screen
    $("input-cur").querySelectorAll("button").forEach((b) => {
      b.onclick = () => { state.draft.currency = b.dataset.cur; renderWho(); };
    });
    $("amount").addEventListener("input", (e) => {
      const raw = e.target.value.replace(/[^\d]/g, "");
      e.target.value = raw ? parseInt(raw, 10).toLocaleString("en-US") : "";
      renderAmountPreview();
    });
    $("who-bar").onclick = () => $("who-panel").classList.toggle("open");
    $("when-bar").onclick = () => $("when-panel").classList.toggle("open");
    $("save-btn").onclick = saveExpense;
    $("input-room").onclick = goHome;
    $("go-status").onclick = () => { renderStatus(); show("screen-status"); };

    // status
    $("status-back").onclick = () => show("screen-input");
    $("go-history").onclick = () => openTimeline(null);
    $("startdate-btn").onclick = openDateModal;
    $("settle-btn").onclick = renderSettlement;
    $("member-add-btn").onclick = addMember;
    $("member-new").addEventListener("keydown", (e) => { if (e.key === "Enter") addMember(); });
    $("delete-trip-btn").onclick = deleteTrip;

    // confirm modal
    $("confirm-no").onclick = closeConfirm;
    $("confirm-yes").onclick = () => { if (confirmCb) confirmCb(); };
    $("confirm-back").onclick = (e) => { if (e.target === $("confirm-back")) closeConfirm(); };

    // history
    $("history-back").onclick = () => show("screen-status");

    // modal
    $("modal-cancel").onclick = closeModal;
    $("modal-back").onclick = (e) => { if (e.target === $("modal-back")) closeModal(); };
    $("modal-settle").onclick = toggleSettled;
    $("modal-edit").onclick = editExpense;
    $("modal-delete").onclick = deleteExpense;
    $("modal-rate").onclick = openRateModal;
    $("modal-up").onclick = () => moveExpense(-1);
    $("modal-down").onclick = () => moveExpense(1);
    $("modal-shot").onclick = modalShot;

    // receipts
    $("receipt-bar").onclick = () => $("receipt-file").click();
    $("receipt-file").addEventListener("change", (e) => pickReceipt(e.target.files[0]));
    $("attach-file").addEventListener("change", (e) => attachReceipt(e.target.files[0]));
    $("shot-back").onclick = (e) => { if (e.target !== $("shot-img")) closeShot(); };
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $("shot-back").classList.contains("show")) closeShot();
    });

    // trip start date modal
    $("date-save").onclick = saveStartDate;
    $("date-cancel").onclick = closeDateModal;
    $("date-back").onclick = (e) => { if (e.target === $("date-back")) closeDateModal(); };

    // rate override modal
    $("rate-save").onclick = saveRate;
    $("rate-cancel").onclick = closeRateModal;
    $("rate-back").onclick = (e) => { if (e.target === $("rate-back")) closeRateModal(); };
    $("rate-input").addEventListener("keydown", (e) => { if (e.key === "Enter") saveRate(); });
  }

  wire();
  boot();
})();
