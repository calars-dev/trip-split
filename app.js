/* Trip Split — client logic */
(function () {
  "use strict";

  const CFG = window.TRIP_SPLIT_CONFIG;
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

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
  // Drop whatever this particular database turned out not to have.
  function sanitize(p) {
    let q = p;
    if (rateColsMissing) q = stripRateCols(q);
    if (timelineColsMissing) q = stripTimelineCols(q);
    return q;
  }

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
  }

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

  // ═══════════════════ DATA ═══════════════════
  async function loadRoom(roomId) {
    const { data: room, error } = await sb.from("rooms").select("*").eq("id", roomId).maybeSingle();
    if (error) throw error;
    return room;
  }
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
    renderStatus();
    renderTimeline();
  }

  // draft init
  function freshDraft() {
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
    item.innerHTML = `
      <span class="exp-emoji">${EMOJI[e.category] || "💸"}</span>
      <span class="exp-mid">
        <span class="exp-title">${e.note ? escapeHtml(e.note) : (e.category || "지출")}</span>
        <span class="exp-sub">${memberName(e.payer_id)} 냄 · ${parts.length}명${badge}${est}</span>
      </span>
      <span class="exp-amt-col">${amtCol}</span>`;
    item.onclick = () => openExpenseModal(e);
    return item;
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

      const row = (e) => expenseItem(e, shareMode ? shareOf(e, state.filter.memberId) : undefined);
      if (day.dayIndex === PREP_DAY) {
        // prep spending has no time of day, so no spine — just the list
        const list = document.createElement("div");
        list.className = "exp-list";
        day.slots.forEach((g) => g.items.forEach((e) => list.appendChild(row(e))));
        wrap.appendChild(list);
      } else {
        const body = document.createElement("div");
        body.className = "tl-body";
        day.slots.forEach((g) => {
          const sl = document.createElement("div");
          sl.className = "tl-slot";
          sl.innerHTML = `<span class="tl-dot">${SLOT_EMOJI[g.slot] || "❓"}</span>
            <div class="tl-slot-name">${g.slot || "미지정"}</div>`;
          g.items.forEach((e) => sl.appendChild(row(e)));
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
    for (let i = 0; i < 2 && error; i++) {
      let dropped = false;
      if (isMissingRateCol(error) && !rateColsMissing) { rateColsMissing = true; dropped = true; }
      if (isMissingTimelineCol(error) && !timelineColsMissing) { timelineColsMissing = true; dropped = true; }
      if (!dropped) break;
      ({ error } = await send(sanitize(payload)));
    }
    btn.disabled = false;
    if (error) { toast("저장 실패: " + error.message, true); return; }
    toast(rateColsMissing || timelineColsMissing
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
    closeModal();
    show("screen-input");
    $("amount").value = fmt(e.amount);
    $("note").value = e.note || "";
    renderCats();
    renderWho();
    renderWhen();
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
    const btn = $("create-go"); btn.disabled = true;
    let { error: rErr } = await sb.from("rooms")
      .insert({ id, name, default_currency: cur, start_date: start });
    if (rErr && isMissingTimelineCol(rErr)) {
      // un-migrated DB: make the room anyway, the date can be set later
      timelineColsMissing = true;
      ({ error: rErr } = await sb.from("rooms").insert({ id, name, default_currency: cur }));
    }
    if (rErr) { btn.disabled = false; toast("방 생성 실패: " + rErr.message, true); return; }
    const { data: mem, error: mErr } = await sb.from("members").insert({ room_id: id, name: meName }).select().single();
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
    const { data: mem, error } = await sb.from("members")
      .insert({ room_id: state.room.id, name }).select().single();
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

  // ── home (my trips) ──
  function renderHome() {
    const list = getSavedRooms();
    const box = $("home-list");
    box.innerHTML = "";
    list.forEach((r) => {
      const b = document.createElement("button");
      b.className = "trip-row";
      b.innerHTML = `<span class="t-name">${escapeHtml(r.name)}</span><span class="t-arrow">→</span>`;
      b.onclick = () => { location.search = "?r=" + r.id; };
      box.appendChild(b);
    });
  }

  // ═══════════════════ BOOT ═══════════════════
  async function boot() {
    const params = new URLSearchParams(location.search);
    const roomId = params.get("r");
    if (!roomId) {
      if (getSavedRooms().length) { renderHome(); show("screen-home"); }
      else { $("create-start").value = todayStr(); show("screen-create"); }
      return;
    }

    show("screen-loading");
    let room;
    try { room = await loadRoom(roomId); }
    catch (err) { toast("연결 오류: " + err.message, true); show("screen-create"); return; }
    if (!room) {
      forgetRoomLocal(roomId); // deleted or gone → drop from my list
      toast("방을 찾을 수 없어요 (삭제됐을 수 있어요)", true);
      goHome();
      return;
    }

    state.room = room;
    await refetch();
    subscribeRealtime();
    // refresh the room's fallback rate in the background; re-render if it moved
    warmRoomRate().then((changed) => { if (changed) renderAll(); });

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
    // home (my trips)
    $("home-new").onclick = () => {
      $("create-back").style.display = getSavedRooms().length ? "block" : "none";
      if (!$("create-start").value) $("create-start").value = todayStr();
      show("screen-create");
    };
    $("create-back").onclick = () => { renderHome(); show("screen-home"); };

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
