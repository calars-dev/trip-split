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
  let roomCols = ["id", "name", "default_currency", "start_date", "day_count",
                  "manager_id", "base_rate_jpy", "base_rate_date", "has_pw", "created_at"];
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

  // ⚠️ members 는 select("*") 로 읽지 않는다. birth_hash 가 같이 실려 나오는데
  // 앱은 그 값을 쓰지 않고(생일 확인은 birth_ok RPC 가 예/아니오만 답한다),
  // 멤버 id 는 room_seats 로 이미 공개돼 있어 해시만 손에 넣으면 네 자리
  // 1만 가지를 다 돌려 생일을 되찾을 수 있다. 지출과 달리 생일은 "링크를 아는
  // 사람은 다 본다"는 이 앱의 선 밖이므로 아예 내려받지 않는다.
  // roomQuery 와 같은 이유로 없는 칸은 한 번 걸러내고 기억한다.
  let memberCols = ["id", "room_id", "name", "created_at", "user_id", "is_ledger"];
  async function memberQuery(build) {
    for (let i = 0; i <= memberCols.length; i++) {
      const res = await build(memberCols.join(","));
      if (!res.error) return res;
      const miss = /column members\.(\w+) does not exist/.exec(res.error.message || "");
      if (!miss || memberCols.indexOf(miss[1]) < 0) return res;
      memberCols = memberCols.filter((c) => c !== miss[1]);
    }
    return { data: null, error: { message: "members 조회 실패" } };
  }

  // What you tap on the road. 숙소·투어·렌터카·입장료 are booked once, usually
  // before leaving, so they cost a button each while earning almost no taps.
  const CATEGORIES = [
    { key: "식비", emoji: "🍚" }, { key: "카페", emoji: "☕" },
    { key: "교통", emoji: "🚕" }, { key: "선물", emoji: "🎁" },
    { key: "마트", emoji: "🛒" }, { key: "술",   emoji: "🍺" },
    { key: "기타", emoji: "➕" },
  ];
  // Retired from the buttons but still sitting on older expenses. Without their
  // icons those rows would render blank where every other row has a face.
  const RETIRED_EMOJI = { 숙소: "🏠", 투어: "🤿", 렌터카: "🚗", 입장료: "🎟" };
  const EMOJI = Object.assign(
    Object.fromEntries(CATEGORIES.map((c) => [c.key, c.emoji])), RETIRED_EMOJI);
  const CUR = { KRW: "₩", JPY: "¥" };

  // A ledger member — the shared pot — is a column in the books, not a person.
  // It pays for things, but it never takes a share of them and nobody can claim
  // it as their identity. Absent the migration the flag is undefined, i.e. false,
  // and everything behaves as it did before.
  const isLedger = (m) => !!(m && m.is_ledger);
  // 받침이 있으면 "이", 없으면 "가". "공금가 냄"을 없앤다.
  function particle(word) {
    const s = String(word || "");
    const c = s.charCodeAt(s.length - 1);
    if (!(c >= 0xac00 && c <= 0xd7a3)) return "가";
    return ((c - 0xac00) % 28) ? "이" : "가";
  }
  const realPeople = () => state.members.filter((m) => !isLedger(m));
  // Paying money *into* the pot — the trip fee everyone hands over up front.
  // It needs no column of its own: an expense whose only recipient is the pot
  // can be nothing else.
  function isDeposit(e) {
    // Only an explicit single recipient counts. Falling back to the payer would
    // read a pot-paid expense with no participants as money coming *in*, and it
    // would then vanish from every spending total.
    const parts = e.participant_ids;
    if (!parts || parts.length !== 1) return false;
    if (parts[0] === e.payer_id) return false;
    return isLedger(state.members.find((m) => m.id === parts[0]));
  }

  // Above this, a yen figure is often a won figure that was typed with the wrong
  // toggle — and that error multiplies the shared cost, so the save stops to ask.
  const BIG_JPY = 10000;

  // ── day / slot ──
  // An expense carries the day of the trip it belongs to, not a calendar date:
  // When something was spent is one instant, not a day bucket plus a vague
  // "저녁". `spent_at` holds it; everything else on screen is derived from it.
  // The old day_index / slot / hour columns are still written for one release so
  // a rollback has somewhere to land, but nothing reads them any more.
  const PREP_DAY = 0;
  const MAX_DAY_CHIPS = 60; // guard: a wildly wrong start date shouldn't spawn 500 chips

  // ── FX ──
  // Everything settles in KRW. A foreign-currency expense carries the rate it was
  // saved with, so past settlement numbers never shift when the market moves.
  const FX_API = "https://api.frankfurter.dev/v1/"; // ECB reference rates, no key needed
  // Last resort: offline since the trip was created, and the room has no rate yet.
  // Refresh this before a trip — 9.0 was a year stale by 2026-09 and overstated
  // every yen expense by 3.5%. Measured 2026-09-08 (ECB via frankfurter): 8.6954.
  const FALLBACK_JPY_KRW = 8.70;

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
  // And the clock column (migration-pot.sql).
  let hourColMissing = false;
  const isMissingHourCol = (err) => !!err && /\bhour\b/.test(err.message || "");
  // Drop whatever this particular database turned out not to have.
  function sanitize(p) {
    let q = p;
    if (rateColsMissing) q = stripRateCols(q);
    if (timelineColsMissing) q = stripTimelineCols(q);
    if (receiptColMissing) { q = Object.assign({}, q); delete q.receipt_path; }
    if (hourColMissing) { q = Object.assign({}, q); delete q.hour; }
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
    if (id === "screen-input") refreshDraftClock();
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
      memberQuery((cols) =>
        sb.from("members").select(cols).eq("room_id", state.room.id).order("created_at")),
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
  // ── 총무 ──
  // Adding and removing members, and spending from the pot, belong to one
  // person. Fourteen people each nudging the pot turns a ledger into graffiti.
  //
  // ⚠️ This hides controls; it does not enforce anything. Any member of the room
  //    can still write whatever they like through the API — the app has always
  //    been "whoever has the link can edit." It stops accidents, not intent.
  function managerId() {
    const m = state.room && state.room.manager_id;
    return m || null;
  }
  // With no manager recorded (an older room), everyone keeps the old freedom
  // rather than everyone losing it.
  function iAmManager() {
    const mid = managerId();
    return !mid || (state.me && state.me === mid);
  }

  // ── the clock ──
  // One instant per expense. Everything the screen shows about "when" comes out
  // of here, so there is exactly one thing to get right.
  let spentAtColMissing = false;
  const isMissingSpentCol = (err) => !!err && /spent_at/.test(err.message || "");

  // Falls back through the old columns so a database that predates the
  // migration still sorts and groups sensibly instead of collapsing to one heap.
  function spentAt(e) {
    if (e && e.spent_at) return new Date(e.spent_at);
    if (e && typeof e.day_index === "number" && e.day_index > 0) {
      const d = dateOfDay(e.day_index);
      if (d) { d.setHours(typeof e.hour === "number" ? e.hour : 12, 0, 0, 0); return d; }
    }
    return e && e.created_at ? new Date(e.created_at) : new Date(0);
  }
  const two = (n) => String(n).padStart(2, "0");
  const clockLabel = (dt) => `${two(dt.getHours())}:${two(dt.getMinutes())}`;
  // Local date key — never toISOString(), which would shift an evening in Seoul
  // onto the previous day.
  const dateKey = (dt) => `${dt.getFullYear()}-${two(dt.getMonth() + 1)}-${two(dt.getDate())}`;
  // <input type="datetime-local"> wants local time with no zone suffix.
  const toLocalInput = (dt) => `${dateKey(dt)}T${clockLabel(dt)}`;
  const fromLocalInput = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s || "");
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
  };

  // "9월 14일 (월)" — and which day of the trip that is, when a start date exists.
  function dayNumberOf(dt) {
    const s = startDate();
    if (!s || !dt) return null;
    const a = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
    const diff = Math.round((a - s) / 86400000) + 1;
    return diff < 1 ? PREP_DAY : Math.min(diff, MAX_DAY_CHIPS);
  }
  function dateHeading(dt) {
    return `${dt.getMonth() + 1}월 ${dt.getDate()}일 (${WEEKDAY[dt.getDay()]})`;
  }
  function dayTag(dt) {
    const n = dayNumberOf(dt);
    if (n === null) return "";
    return n === PREP_DAY ? "여행 전" : n + "일차";
  }
  // The instant decides the order. Two expenses on the same minute fall back to
  // when they were entered, so the list never reshuffles between renders.
  const byClock = (a, b) =>
    (spentAt(a) - spentAt(b)) || (new Date(a.created_at) - new Date(b.created_at));
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
      // The person entering is usually the person who just paid. A pot that only
      // covers a few big pre-arranged things (lodging, the rental car) would make
      // the wrong default here — most rows on the ground are somebody's card.
      payerId: state.me,
      // the pot never takes a share of what it pays for
      participants: new Set(realPeople().map((m) => m.id)),
      editingId: null,
      // rate carried over when editing, so a later edit doesn't re-price the expense
      rateKrw: null,
      rateDate: null,
      rateSource: null,
      // when it was spent — now, unless someone picks a different time
      spentAt: new Date(),
      // Until someone picks a time themselves, the clock keeps the draft current
      // — an app left open since lunch must not stamp lunch on a dinner receipt.
      whenTouched: false,
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
    const dt = d.spentAt || new Date();
    const tag = dayTag(dt);
    $("when-text").innerHTML =
      `<b>${clockLabel(dt)}</b> <span style="color:var(--muted)">${dateHeading(dt)}</span>`
      + (tag ? ` <span style="color:var(--faint)">${tag}</span>` : "");
    const inp = $("when-input");
    // Only write into the field when it disagrees — assigning on every render
    // would fight the user mid-edit and reset the caret.
    const want = toLocalInput(dt);
    if (inp.value !== want) inp.value = want;
  }

  // The field is the truth while it holds a valid instant. A half-typed date is
  // ignored rather than snapped to something wrong.
  function onWhenInput() {
    const dt = fromLocalInput($("when-input").value);
    if (!dt) return;
    state.draft.spentAt = dt;
    state.draft.whenTouched = true;
    renderWhen();
  }
  function setWhenNow() {
    state.draft.spentAt = new Date();
    state.draft.whenTouched = false;   // back under the clock's care
    renderWhen();
  }
  // Nudge by whole minutes — for "it was about twenty minutes ago", which is
  // most corrections, and which a date picker makes needlessly slow.
  function nudgeWhen(mins) {
    const d = state.draft;
    d.spentAt = new Date((d.spentAt || new Date()).getTime() + mins * 60000);
    d.whenTouched = true;
    renderWhen();
  }

  // Re-read the clock for a draft nobody has dated by hand. Called when the
  // input screen comes up and when the app returns to the foreground, which is
  // where a stale default would otherwise be saved without anyone noticing.
  function refreshDraftClock() {
    const d = state.draft;
    if (!d || d.editingId || d.whenTouched) return;
    d.spentAt = new Date();
    renderWhen();
  }

  function renderWho() {
    if (!state.draft) return;
    const d = state.draft;
    // sync currency toggle + symbol
    renderCurToggle("input-cur", d.currency);
    $("amt-sym").textContent = CUR[d.currency];
    renderAmountPreview();
    // who summary
    const payerName = memberName(d.payerId);
    const payer = escapeHtml(payerName);
    const n = d.participants.size;
    const potM = state.members.find(isLedger);
    const depositOn = !!potM && n === 1 && d.participants.has(potM.id);
    // "전원" means every real person; the pot is not one of them. Saying it in
    // words rather than a headcount is what makes a stray selection visible.
    const splitTxt = n === realPeople().length ? "전원 나눔" : `${n}명이 나눔`;
    $("who-text").innerHTML = depositOn
      ? `<b>${payer}</b>${particle(payerName)} <b>${escapeHtml(potM.name)}</b>에 입금`
      : `<b>${payer}</b>${particle(payerName)} 냄 · ${splitTxt}`;
    // payer chips
    const pc = $("payer-chips"); pc.innerHTML = "";
    state.members.forEach((m) => {
      // The pot is the trip's shared wallet; only the person holding it files
      // against it. Everyone else sees people, which is all they need.
      if (isLedger(m) && !iAmManager()) return;
      const b = document.createElement("button");
      b.className = "chip" + (m.id === d.payerId ? " sel" : "");
      b.textContent = m.name;
      b.onclick = () => { d.payerId = m.id; renderWho(); };
      pc.appendChild(b);
    });
    // Paying *into* the pot is the one case where the pot is the recipient, and
    // the split chips deliberately hide it. Without this toggle there is no way
    // to record a trip fee from inside the app at all.
    const dep = $("deposit-row");
    if (potM) {
      dep.innerHTML = "";
      dep.appendChild(chip("💰 " + potM.name + "에 입금", depositOn, () => {
        if (depositOn) {
          d.participants = new Set(realPeople().map((m) => m.id));
        } else {
          d.participants = new Set([potM.id]);
          // The pot cannot hand money to itself; that row would count as neither
          // a deposit nor an expense and the money would vanish from every total.
          if (isLedger(state.members.find((m) => m.id === d.payerId))) d.payerId = state.me;
        }
        renderWho();
      }));
      $("split-wrap").style.display = depositOn ? "none" : "block";
    } else {
      dep.innerHTML = "";
      $("split-wrap").style.display = "block";
    }
    // split chips — the pot is not offered here at all, so it cannot creep into
    // a split by a stray tap
    const sc = $("split-chips"); sc.innerHTML = "";
    realPeople().forEach((m) => {
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
    const pot = state.members.find(isLedger);
    // Money handed to the pot is not money spent. Counting it would double the
    // headline: once when everyone pays in, again when the pot pays out.
    // `settled` rows are already out of computeSettlement, so counting them here
    // would let the two halves of this screen disagree.
    const spent = state.expenses.filter((e) => !isDeposit(e) && !e.settled);
    const total = spent.reduce((sum, e) => sum + krwAmount(e), 0);
    const hero = $("stat-hero");
    const headCount = state.members.length || 1;
    if (state.expenses.length === 0) {
      hero.innerHTML = `<div class="total">${money(0, "KRW")}</div>
        <div class="avg">아직 지출이 없어요</div>`;
    } else if (pot) {
      // With a pot, the question on everyone's mind is what is left in it, so
      // that is the number in the big type; the spend sits underneath.
      const { balances } = computeSettlement();
      const left = -Math.round(balances[pot.id] || 0);
      const low = left <= 0;
      const per = realPeople().length || 1;
      hero.innerHTML = `<div class="avg" style="margin-bottom:2px">${escapeHtml(pot.name)} 남은 돈</div>
        <div class="total"${low ? ` style="color:var(--neg)"` : ""}>${money(left, "KRW")}</div>
        <div class="avg">쓴 돈 ${money(total, "KRW")} · 1인 ${money(left / per, "KRW")}씩 돌려받기</div>`;
    } else {
      hero.innerHTML = `<div class="total">${money(total, "KRW")}</div>
        <div class="avg">1인 평균 ${money(total / headCount, "KRW")}</div>`;
    }

    // balances
    const { balances } = computeSettlement();
    const box = $("balances");
    box.innerHTML = "";
    if (state.members.length === 0) { box.innerHTML = `<div class="empty">멤버가 없어요</div>`; }
    // People first, the pot last and set apart. Its raw balance is the negative
    // of what it holds, and printing −₩2,812,213 directly under a headline that
    // says +₩2,812,213 makes one number look like two.
    const ordered = pot ? realPeople().concat([pot]) : state.members;
    ordered.forEach((m) => {
      const row = document.createElement("div");
      const led = isLedger(m);
      row.className = "bal-row tappable" + (led ? " ledger" : "");
      const v = Math.round(balances[m.id] || 0);
      const meTag = m.id === state.me ? `<span class="me-tag">나</span>` : "";
      const amtHtml = led
        ? `<span class="bal-amt">${money(-v, "KRW")}</span>`
        : (v === 0
          ? `<span class="bal-amt zero">±0</span>`
          : `<span class="bal-amt ${v > 0 ? "pos" : "neg"}">${v > 0 ? "+" : "−"}${money(Math.abs(v), "KRW")}</span>`);
      const label = led
        ? `${escapeHtml(m.name)} <span class="bal-note">남은 돈</span>`
        : `${escapeHtml(m.name)}${meTag}`;
      row.innerHTML = `<span class="bal-name">${label}</span><span>${amtHtml}</span>`;
      row.onclick = () => openTimeline(m.id);
      box.appendChild(row);
    });

    // Anything saved through the offline escape hatch is listed here until the
    // photo catches up, so a missing receipt is a visible debt rather than a
    // thing nobody remembers.
    // Every other column announces itself when it is missing. Without this one
    // the pot silently becomes a fifteenth person and every bill is divided by
    // one more head than there are people — wrong numbers, no error.
    $("pot-notice").innerHTML =
      (state.members.length && !("is_ledger" in state.members[0]))
        ? `<div class="tl-notice">⚠️ 공금 칸을 쓸 준비가 안 됐어요 —
           <b>migration-pot.sql</b>을 한 번 실행해 주세요.
           그때까지 공금이 사람 한 명으로 계산돼요.</div>`
        : "";
    const noShot = receiptColMissing ? 0 : state.expenses.filter((e) => !e.receipt_path).length;
    $("receipt-todo").innerHTML = noShot
      ? `<div class="tl-notice">📷 영수증이 없는 지출 <b>${noShot}건</b> — 지출을 탭해 붙일 수 있어요.</div>`
      : "";
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
    $("date-days").value = state.room && state.room.day_count ? String(state.room.day_count) : "";
    $("date-back").classList.add("show");
  }
  function closeDateModal() { $("date-back").classList.remove("show"); }

  // Day 1 always means the start date. So when the start date moves, every
  // expense stays on the calendar day it actually happened and its day *number*
  // shifts instead. Anything that ends up before the new start becomes prep.
  // Moving the start date used to rewrite every expense's day_index, walking the
  // days in the safe direction and renumbering the prep bucket afterwards. An
  // expense now carries the instant it happened, so the start date only changes
  // what the headings are counted from — nothing is written, nothing can go wrong
  // halfway through.

  async function saveStartDate() {
    const v = $("date-input").value;
    if (!v) { toast("날짜를 선택하세요", true); return; }
    const prev = state.room.start_date ? String(state.room.start_date).slice(0, 10) : null;

    // Trip length lives in the same box, so it has to be saveable on its own —
    // the usual visit here changes only the number of days.
    const rawDays = $("date-days").value.trim();
    let days = rawDays === "" ? null : Math.round(Number(rawDays));
    if (days !== null && (!isFinite(days) || days < 1 || days > 60)) {
      toast("여행 일수는 1~60 사이로 넣어주세요", true); return;
    }
    const prevDays = state.room.day_count == null ? null : Number(state.room.day_count);
    const daysChanged = days !== prevDays;
    if (prev === v && !daysChanged) { closeDateModal(); return; }
    closeDateModal();

    if (daysChanged) {
      const r = await sb.from("rooms").update({ day_count: days }).eq("id", state.room.id);
      if (r.error) {
        if (/column rooms\.day_count does not exist/.test(r.error.message || "")) {
          toast("migration-daycount.sql 먼저 실행해 주세요", true);
        } else toast("여행 일수 저장 실패: " + r.error.message, true);
      } else {
        state.room.day_count = days;
        if (state.draft) renderWhen();
      }
    }
    if (prev === v) { toast("여행 일수 저장됨"); return; }

    const { error } = await sb.from("rooms").update({ start_date: v }).eq("id", state.room.id);
    if (error) {
      if (isMissingTimelineCol(error)) {
        timelineColsMissing = true;
        toast("migration-timeline.sql 먼저 실행해 주세요", true);
      } else toast("저장 실패: " + error.message, true);
      return;
    }
    state.room.start_date = v;

    toast("시작일 저장됨 — 일차 번호만 다시 셉니다");
    if (state.draft) renderWhen();
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
      if (!iAmManager()) {
        right = `<span class="mem-locked">${m.id === state.me ? "본인" : ""}</span>`;
      } else if (m.id === state.me) {
        right = `<span class="mem-locked">본인</span>`;
      } else if (memberHasExpenses(m.id)) {
        right = `<span class="mem-locked">지출 있음</span>`;
      } else {
        right = "";
      }
      const ledTag = isLedger(m) ? `<span class="mem-tag">장부용</span>` : "";
      row.innerHTML = `<span class="mem-name">${escapeHtml(m.name)}${meTag}${ledTag}</span>`;
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
    // Offered only while the room has no pot: a second one would split the
    // balance in two and only the first would ever be shown.
    const mine = iAmManager();
    $("pot-add").style.display = (!mine || state.members.some(isLedger)) ? "none" : "block";
    // The add row goes away entirely rather than greying out — a disabled field
    // invites a tap and then explains nothing.
    const add = document.querySelector(".member-add");
    if (add) add.style.display = mine ? "" : "none";
    const hint = $("member-hint");
    if (hint) {
      hint.style.display = mine ? "none" : "block";
      hint.textContent = "멤버 추가·삭제는 총무" +
        (managerId() ? "(" + memberName(managerId()) + ")" : "") + "만 할 수 있어요.";
    }
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

  // 회비를 미리 걷어 한 지갑에서 쓰는 여행을 위한 칸. 사람이 아니라 장부의 한 줄이라
  // 결제자로만 고를 수 있고, 나눔 대상과 이름 고르기 목록에는 나오지 않는다.
  async function addPot() {
    if (state.members.some(isLedger)) { toast("이미 있어요", true); return; }
    const name = ($("member-new").value.trim() || "공금");
    if (state.members.some((m) => m.name === name)) { toast("같은 이름이 이미 있어요", true); return; }
    openConfirm("공금 칸을 만들까요?",
      `<b>${escapeHtml(name)}</b> 칸이 생겨요.<br>사람이 아니라 장부용이라 아무도 이 이름을 가져갈 수 없어요.
       <br><br>회비로 걷은 돈을 여기 넣어두고, 다 같이 쓰는 것은 이 이름으로 결제하면 돼요.`,
      async () => {
        const { data, error } = await sb.from("members")
          .insert({ room_id: state.room.id, name, is_ledger: true })
          .select("id,is_ledger").single();
        if (error) {
          // 컬럼이 없으면 사람으로 들어가 조용히 15번째 참가자가 된다 — 만들지 않는 편이 낫다.
          if (/is_ledger/.test(error.message || "")) toast("migration-pot.sql 먼저 실행해 주세요", true);
          else toast("만들기 실패: " + error.message, true);
          return;
        }
        if (data && !data.is_ledger) {
          await sb.from("members").delete().eq("id", data.id);
          toast("migration-pot.sql 먼저 실행해 주세요", true);
          return;
        }
        $("member-new").value = "";
        toast(name + " 칸이 생겼어요");
        await refetch();
      });
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
        <span class="from">${escapeHtml(memberName(t.from))}</span>
        <span class="arrow">→</span>
        <span class="to">${escapeHtml(memberName(t.to))}</span>
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
    const badge = (e.settled ? ` · <span class="exp-badge">✓정산완료</span>` : "")
      + (isDeposit(e) ? ` · <span class="exp-badge">입금</span>` : "")
      + ((!e.receipt_path && !receiptColMissing) ? ` · <span class="exp-badge todo">영수증 없음</span>` : "");
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
        <span class="exp-sub">${clockLabel(spentAt(e))} · ${escapeHtml(memberName(e.payer_id))} 냄 · ${parts.length}명${badge}${est}</span>
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
  // One bucket per calendar day, newest last, each already in clock order.
  // Slots are gone: a heading that says the date and rows that say the minute
  // answer "when was that" better than 아침/점심/저녁 ever did.
  function groupByDay(items) {
    const days = new Map();
    items.forEach((e) => {
      const k = dateKey(spentAt(e));
      if (!days.has(k)) days.set(k, []);
      days.get(k).push(e);
    });
    const out = [];
    days.forEach((arr, key) => {
      arr.sort(byClock);
      // Deposits sit in the list but not in the total: a day bar is about how
      // much went out, and 7,000,000원 of trip fees would dwarf every real day.
      const total = arr.reduce((s, e) => s + (isDeposit(e) ? 0 : rowKrw(e)), 0);
      out.push({ key: key, when: spentAt(arr[0]), items: arr, total: total });
    });
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
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
    // Same rule as the day totals: paying into the pot is not spending. Without
    // this the header said ₩500,000 above a day total of ₩0.
    const total = items.reduce((s, e) => s + (isDeposit(e) ? 0 : rowKrw(e)), 0);
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

  // one timeline row — order comes from the clock, so there is nothing to grab
  function timelineRow(e, share) {
    const row = document.createElement("div");
    row.className = "tl-row";
    row.dataset.id = e.id;
    row.appendChild(expenseItem(e, share));
    return row;
  }

  function renderTimeline() {
    if (!state.room) return;
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
    const peak = Math.max.apply(null, days.map((d) => d.total).concat([1]));
    const shareMode = state.filter.memberId && state.filter.mode === "share";
    box.innerHTML = "";
    days.forEach((day) => {
      const wrap = document.createElement("div");
      wrap.className = "tl-day";
      const tag = dayTag(day.when);

      const head = document.createElement("div");
      head.className = "tl-day-head";
      head.innerHTML = `<span class="tl-day-num">${dateHeading(day.when)}</span>
        <span class="tl-day-date">${tag}</span>
        <span class="tl-day-total">${money(day.total, "KRW")}</span>`;
      wrap.appendChild(head);

      // relative bar — shows at a glance which day the money went
      const bar = document.createElement("div");
      bar.className = "tl-bar";
      bar.innerHTML = `<i style="width:${Math.max(2, Math.round(day.total / peak * 100))}%"></i>`;
      wrap.appendChild(bar);

      const zone = document.createElement("div");
      zone.className = "tl-rows";
      day.items.forEach((e) => zone.appendChild(
        timelineRow(e, shareMode ? shareOf(e, state.filter.memberId) : undefined)));
      wrap.appendChild(zone);
      box.appendChild(wrap);
    });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }


  // ═══════════════════ ACTIONS ═══════════════════
  function parseAmount() {
    const raw = $("amount").value.replace(/[^\d]/g, "");
    return raw ? parseInt(raw, 10) : 0;
  }

  // Live conversion under the amount, both ways. Typing yen answers "how much
  // is that really?"; typing won answers "is this the number on the till?" —
  // in Japan the price tag is in yen even when the card is charged in won.
  function renderAmountPreview() {
    const el = $("amt-krw");
    if (!el || !state.draft) return;
    const amt = parseAmount();
    if (!amt) { el.textContent = ""; return; }
    const r = state.draft.rateKrw ? Number(state.draft.rateKrw) : currentJpyRate().rate;
    el.textContent = state.draft.currency === "KRW"
      ? `≈ ${money(Math.round(amt / r), "JPY")}  ·  100¥ = ${fmt(r * 100)}원`
      : `≈ ${money(amt * r, "KRW")}  ·  100¥ = ${fmt(r * 100)}원`;
  }

  async function saveExpense() {
    // The clock is deliberately NOT re-read here. 밤 spans midnight by design,
    // so a 22시 entry saved at 00:05 would silently land on the next day while
    // the screen still said 1일차. What the screen shows is what gets saved;
    // the screen-entry and foreground hooks keep it fresh everywhere else.
    const d = state.draft;
    const amount = parseAmount();
    if (!amount || amount <= 0) { toast("금액을 입력하세요", true); return; }
    if (d.participants.size === 0) { toast("나눌 사람을 1명 이상 선택", true); return; }
    // New expenses must carry proof. Editing an older one that predates this
    // rule doesn't — otherwise the 49 already in there become uneditable.
    // This gate comes BEFORE the currency question: it sends the user off to the
    // photo picker and back, and asking first would ask twice.
    if (!d.editingId && !d.shot && !receiptColMissing) {
      toast("영수증이나 결제내역을 첨부해 주세요", true);
      $("receipt-file").click();
      return;
    }
    // Only one direction of the currency slip is worth stopping for. A won
    // amount saved as yen inflates the expense roughly nine-fold and everyone
    // carries the difference; yen saved as won only shrinks it, and that lands
    // on whoever typed it. So the question is asked on the yen side.
    if (!d.editingId) {
      if (d.currency === "JPY" && amount >= BIG_JPY) {
        const krw = Math.round(amount * currentJpyRate().rate);
        if (!confirm(`¥${fmt(amount)} — 약 ${fmt(krw)}원으로 잡혀요.\n엔이 맞나요? 원화 금액이라면 위에서 ₩ 원으로 바꿔주세요.`)) {
          toast("저장하지 않았어요 — 통화를 확인해 주세요", true); return;
        }
      }
    }
    const when = d.spentAt || new Date();
    const payload = {
      room_id: state.room.id,
      payer_id: d.payerId,
      amount,
      currency: d.currency,
      category: d.category || "기타",
      note: $("note").value.trim() || null,
      participant_ids: [...d.participants],
      spent_at: when.toISOString(),
      // Still written for one release so a rollback finds the old columns
      // populated. Nothing reads them; spent_at is the truth.
      day_index: dayNumberOf(when),
      hour: when.getHours(),
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
        // Losing the record is worse than losing the photo. On a bad connection
        // the expense can go in now and the receipt can follow from the hotel
        // wifi; the status screen counts what is still owed a photo.
        if (!confirm("영수증을 올리지 못했어요. 연결이 나쁜 것 같아요.\n\n지출만 먼저 저장하고 영수증은 나중에 붙일까요?\n(현황 화면에 미첨부로 남습니다)")) {
          btn.disabled = false;
          toast("저장하지 않았어요 — 연결이 돌아오면 저장을 다시 눌러 주세요", true);
          return;
        }
        payload.receipt_path = null;
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
    for (let i = 0; i < 4 && error; i++) {
      let dropped = false;
      if (isMissingRateCol(error) && !rateColsMissing) { rateColsMissing = true; dropped = true; }
      if (isMissingTimelineCol(error) && !timelineColsMissing) { timelineColsMissing = true; dropped = true; }
      if (isMissingReceiptCol(error) && !receiptColMissing) { receiptColMissing = true; dropped = true; }
      if (isMissingHourCol(error) && !hourColMissing) { hourColMissing = true; dropped = true; }
      if (!dropped) break;
      ({ error } = await send(sanitize(payload)));
    }
    btn.disabled = false;
    if (error) { toast("저장 실패: " + error.message, true); return; }
    // Only nag about columns whose absence is a surprise. Running without the
    // rate columns is a deliberate choice here — the ⚡기준환율 badge and the
    // settlement note already say so, and repeating it on every single save is
    // just noise about a decision already made.
    toast(timelineColsMissing || receiptColMissing || hourColMissing
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
    const w = spentAt(e);
    sub += `\n${dateHeading(w)} ${clockLabel(w)}${dayTag(w) ? " · " + dayTag(w) : ""}`;
    $("modal-sub").textContent = sub;
    // "Settled on the spot" means the payer was paid back right there. Nobody
    // pays the pot back, so offering it on a pot expense only invites a tap that
    // quietly inflates the balance by that amount.
    // Also hidden on a deposit: marking the trip fee "settled" would drop it out
    // of the balance and the pot would look that much emptier for no reason.
    const potPaid = isLedger(state.members.find((m) => m.id === e.payer_id));
    $("modal-settle").style.display = ((potPaid || isDeposit(e)) && !e.settled) ? "none" : "block";
    $("modal-settle").textContent = e.settled ? "↩ 정산완료 해제" : "✓ 현장정산 완료로 표시";
    $("modal-rate").style.display = cur === "KRW" ? "none" : "block";
    $("modal-shot").style.display = receiptColMissing ? "none" : "block";
    $("modal-shot").textContent = e.receipt_path ? "🧾 영수증 보기" : "📷 영수증 첨부";
    $("modal-back").classList.add("show");
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
    // An existing row keeps the instant it already has — stamping "now" onto a
    // three-day-old expense invents a fact.
    state.draft.spentAt = spentAt(e);
    state.draft.whenTouched = true;
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
    // Fourteen people tap around this list and 삭제 sits right above 닫기.
    // There is no undo, so the question has to come first.
    openConfirm("이 지출을 지울까요?",
      `${escapeHtml(e.note || e.category || "지출")} · ${money(e.amount, e.currency || "KRW")}<br>되돌릴 수 없어요.`,
      async () => {
        const { error } = await sb.from("expenses").delete().eq("id", e.id);
        if (error) { toast("삭제 실패", true); return; }
        toast("삭제됨");
        await refetch();
      });
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
    const { data: mem, error: mErr } = await sb.from("members").insert(memRow)
      .select("id").single();
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
    // The pot is not a seat anyone can sit in. This screen is reachable three
    // ways — first join, cancelling the claim dialog, and "이름 바꾸기" — so the
    // filter belongs here rather than at each caller.
    realPeople().forEach((m) => {
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
    const { data: mem, error } = await sb.from("members").insert(row)
      .select("id,room_id,name,created_at,user_id").single();
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
    // No autofocus on arrival. Most of a group never enters anything — they open
    // the app to read a number — and a keyboard covering half the screen on
    // launch reads as "type something" to people who came to look.
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
    // Both modes carry the hint: without it on the login side, people who
    // signed up with a full name try their given name alone and get nowhere.
    $("auth-id-hint").textContent = "— 성까지 세 글자";
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
        .eq("id", memberId).eq("room_id", state.room.id).is("user_id", null).select("id");
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
        .insert({ room_id: state.room.id, name: name, user_id: me.id })
        .select("id").single();
      error = r.error;
      data = r.data && r.data.id;
    }
    if (error || !data) { toast("참여 실패" + (error ? ": " + error.message : ""), true); return; }
    closeClaim();
    rememberMe(state.room.id, data);
    location.search = "?r=" + state.room.id;
  }

  // ── 이름 고르고 생일 네 자리 ──
  // The old way asked for an id, six digits and a memory question before the
  // trip even appeared. For fourteen people on the first morning that is three
  // screens too many. Here the name they tap *is* the id, and the four digits
  // of their birthday are the password.
  //
  // The seat's login is derived from the seat, so nothing has to be handed out:
  // everyone can work theirs out from what is already on screen. That is the
  // trade — among friends who know each other's birthdays, a seat is no longer
  // proof of who is sitting in it. Chosen deliberately; see migration-birthday.sql.
  let joinRoom = null;
  let joinPick = null;

  function seatHandle(roomId, memberId) {
    return "s_" + roomId + "_" + memberId.replace(/-/g, "").slice(0, 12);
  }
  // Supabase refuses anything under six characters, so the four digits ride
  // along with a fixed prefix. The secret is still just the four digits.
  function birthPw(birth) { return "bd" + birth; }

  // Returns false when this trip can't be joined this way — an old database
  // without the migration, or a room whose seats have no birthdays. The caller
  // then falls back to the id-and-password screen, so nothing is ever a dead end.
  async function openJoin(roomId) {
    let name, seats;
    try {
      const peek = await sb.rpc("room_peek", { p_room: roomId });
      if (peek.error || !peek.data) return false;
      const rows = await sb.rpc("room_seats", { p_room: roomId });
      if (rows.error || !rows.data || !rows.data.length) return false;
      name = peek.data;
      seats = rows.data;
    } catch (err) { return false; }

    joinRoom = roomId;
    joinPick = null;
    $("join-room").textContent = name;
    $("join-sub").textContent = "누구세요? 이름을 골라주세요";
    $("join-birth").value = "";
    $("join-birth-wrap").style.display = "none";
    $("join-go").style.display = "none";

    const box = $("join-chips");
    box.innerHTML = "";
    seats.forEach((s) => {
      const b = document.createElement("button");
      b.className = "name-chip";
      b.textContent = s.name;   // textContent, not innerHTML — names come from the database
      b.onclick = () => pickSeat(s, b);
      box.appendChild(b);
    });
    show("screen-join");
    return true;
  }

  function pickSeat(seat, btn) {
    joinPick = seat;
    $("join-chips").querySelectorAll(".name-chip")
      .forEach((b) => b.classList.toggle("on", b === btn));
    $("join-sub").textContent = seat.name + " — 생일 네 자리를 넣어주세요";
    $("join-birth-wrap").style.display = "";
    $("join-go").style.display = "";
    $("join-birth").focus();
  }

  async function submitJoin() {
    if (!joinPick) { toast("이름을 먼저 골라주세요", true); return; }
    const birth = $("join-birth").value.trim();
    if (!/^\d{4}$/.test(birth)) { toast("생일 네 자리예요 — 월일 (예: 2월 6일이면 0206)", true); return; }

    const btn = $("join-go");
    btn.disabled = true;
    try {
      // Ask before creating anything. A typo must not leave behind an account
      // that only the typo can ever open.
      const ok = await sb.rpc("birth_ok",
        { p_room: joinRoom, p_member: joinPick.id, p_birth: birth });
      if (ok.error) throw new Error(ok.error.message);
      if (ok.data !== true) { toast("생일이 맞지 않아요", true); $("join-birth").select(); return; }

      const handle = seatHandle(joinRoom, joinPick.id);
      const email = handleMail(handle);
      const pw = birthPw(birth);

      // Been here before on any device → sign in. First time on this seat →
      // make the account. The birthday was already checked, so this is safe.
      const inRes = await sb.auth.signInWithPassword({ email: email, password: pw });
      if (inRes.error) {
        const up = await sb.auth.signUp({ email: email, password: pw });
        if (up.error) throw new Error(up.error.message);
        if (!up.data.session) throw new Error("가입은 됐는데 로그인이 안 됐어요. 다시 눌러주세요.");
        const { error: pErr } = await sb.from("profiles")
          .insert({ id: up.data.user.id, handle: handle, name: joinPick.name });
        if (pErr) throw new Error("프로필 저장 실패: " + pErr.message);
      }
      await loadMe();

      // The server is the gatekeeper, not the screen above. It hands back the
      // seat if it is free or already ours, and refuses if it is someone else's.
      const claim = await sb.rpc("claim_by_birth",
        { p_room: joinRoom, p_member: joinPick.id, p_birth: birth });
      if (claim.error) throw new Error(claim.error.message);
      if (claim.data !== true) {
        await sb.auth.signOut();
        toast("이 자리는 이미 다른 사람이 쓰고 있어요", true);
        return;
      }

      rememberMe(joinRoom, joinPick.id);
      location.search = "?r=" + joinRoom;
    } catch (err) {
      toast("들어가기 실패: " + (err && err.message ? err.message : err), true);
    } finally {
      btn.disabled = false;
    }
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
      if (!me) {
        // Arriving on a trip link: let them in by name and birthday instead of
        // making them build an account before they can see anything. Falls
        // through to the id-and-password screen if this trip can't do that.
        if (roomId && await openJoin(roomId)) return;
        renderAuth(); show("screen-auth"); return;
      }
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
      // Never hand someone the create-a-trip form here. They arrived on a link
      // to a trip that exists; the only thing that failed is the network. The
      // old behaviour put an empty "새 여행 방을 만들어요" in front of them with
      // no way back, which on airport wifi is an invitation to start a second
      // trip that half the group then joins.
      $("offline-sub").textContent =
        "신호가 약한 곳인지 확인하고 다시 눌러주세요. (" +
        (err && err.message ? err.message : err) + ")";
      show("screen-offline");
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
      // The pot may be parked on someone's account so no one else can take it;
      // that must not make its owner *become* the pot.
      const mine = state.members.find((m) => m.user_id === me.id && !isLedger(m));
      if (mine) { rememberMe(roomId, mine.id); enterApp(mine.id); return; }
      const unclaimed = state.members.filter((m) => !m.user_id && !isLedger(m));
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

    $("offline-retry").onclick = () => location.reload();

    $("join-go").onclick = submitJoin;
    $("join-birth").addEventListener("keydown", (e) => { if (e.key === "Enter") submitJoin(); });
    // A way out for anyone this screen can't place — someone who joined the old
    // way, or whose name isn't on the list.
    $("join-other").onclick = () => { renderAuth(); show("screen-auth"); };
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
    $("ident-back").onclick = () => show("screen-input");
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
    $("when-input").addEventListener("input", onWhenInput);
    $("when-input").addEventListener("change", onWhenInput);
    $("when-now").onclick = setWhenNow;
    $("when-m30").onclick = () => nudgeWhen(-30);
    $("when-m60").onclick = () => nudgeWhen(-60);
    $("when-m1d").onclick = () => nudgeWhen(-1440);
    $("save-btn").onclick = saveExpense;
    // Phones keep the page alive in the background for hours. Coming back to it
    // should feel like opening it fresh, not like resuming this morning.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshDraftClock();
    });
    $("input-room").onclick = goHome;
    $("go-status").onclick = () => { renderStatus(); show("screen-status"); };
    $("history-room").textContent = "기록";

    // status
    // 정산에서 나가면 기록으로 — 들어온 길로 되돌아간다
    $("status-back").onclick = () => openTimeline(state.filter.memberId);
    $("go-history").onclick = () => openTimeline(null);
    $("startdate-btn").onclick = openDateModal;
    $("settle-btn").onclick = renderSettlement;
    $("member-add-btn").onclick = addMember;
    $("pot-add").onclick = addPot;
    $("member-new").addEventListener("keydown", (e) => { if (e.key === "Enter") addMember(); });
    $("delete-trip-btn").onclick = deleteTrip;

    // confirm modal
    $("confirm-no").onclick = closeConfirm;
    $("confirm-yes").onclick = () => { if (confirmCb) confirmCb(); };
    $("confirm-back").onclick = (e) => { if (e.target === $("confirm-back")) closeConfirm(); };

    // history
    $("history-back").onclick = () => show("screen-input");

    // modal
    $("modal-cancel").onclick = closeModal;
    $("modal-back").onclick = (e) => { if (e.target === $("modal-back")) closeModal(); };
    $("modal-settle").onclick = toggleSettled;
    $("modal-edit").onclick = editExpense;
    $("modal-delete").onclick = deleteExpense;
    $("modal-rate").onclick = openRateModal;
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
