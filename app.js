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

  // ── app state ──
  const state = {
    room: null,
    members: [],
    expenses: [],
    me: null, // member id
    draft: null, // {amount, currency, category, note, payerId, participants:Set, editingId}
  };

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
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

  function subscribeRealtime() {
    sb.channel("room-" + state.room.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "expenses", filter: "room_id=eq." + state.room.id }, refetch)
      .on("postgres_changes", { event: "*", schema: "public", table: "members", filter: "room_id=eq." + state.room.id }, refetch)
      .subscribe();
  }

  // ═══════════════════ SETTLEMENT ═══════════════════
  // Returns { balances: {currency: {memberId: net}}, transfers: {currency: [{from,to,amount}]} }
  function computeSettlement() {
    const balances = {}; // cur -> memberId -> net
    for (const e of state.expenses) {
      if (e.settled) continue; // on-the-spot payments excluded from settlement
      const cur = e.currency || "KRW";
      balances[cur] = balances[cur] || {};
      const parts = (e.participant_ids && e.participant_ids.length) ? e.participant_ids : [e.payer_id];
      const each = e.amount / parts.length;
      // payer fronted the whole amount
      balances[cur][e.payer_id] = (balances[cur][e.payer_id] || 0) + e.amount;
      // each participant owes their share
      let assigned = 0;
      parts.forEach((pid, i) => {
        // absorb rounding remainder on the last participant
        const share = (i === parts.length - 1) ? (e.amount - assigned) : Math.round(each);
        assigned += (i === parts.length - 1) ? 0 : Math.round(each);
        balances[cur][pid] = (balances[cur][pid] || 0) - share;
      });
    }
    // greedy min-transfer per currency
    const transfers = {};
    for (const cur in balances) {
      const creditors = [], debtors = [];
      for (const mid in balances[cur]) {
        const v = Math.round(balances[cur][mid]);
        if (v > 0) creditors.push({ mid, v });
        else if (v < 0) debtors.push({ mid, v: -v });
      }
      creditors.sort((a, b) => b.v - a.v);
      debtors.sort((a, b) => b.v - a.v);
      const list = [];
      let ci = 0, di = 0;
      while (ci < creditors.length && di < debtors.length) {
        const pay = Math.min(creditors[ci].v, debtors[di].v);
        if (pay > 0) list.push({ from: debtors[di].mid, to: creditors[ci].mid, amount: pay });
        creditors[ci].v -= pay; debtors[di].v -= pay;
        if (creditors[ci].v === 0) ci++;
        if (debtors[di].v === 0) di++;
      }
      transfers[cur] = list;
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
    renderStatus();
    renderHistory();
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

  function renderWho() {
    if (!state.draft) return;
    const d = state.draft;
    // sync currency toggle + symbol
    renderCurToggle("input-cur", d.currency);
    $("amt-sym").textContent = CUR[d.currency];
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

  function currenciesInUse() {
    const set = new Set(state.expenses.map((e) => e.currency || "KRW"));
    if (set.size === 0) set.add(state.room.default_currency || "KRW");
    return [...set];
  }

  function renderStatus() {
    if (!state.room) return;
    // hero: total + avg per currency
    const totals = {};
    state.expenses.forEach((e) => {
      const c = e.currency || "KRW";
      totals[c] = (totals[c] || 0) + e.amount;
    });
    const hero = $("stat-hero");
    const memberCount = state.members.length || 1;
    if (Object.keys(totals).length === 0) {
      hero.innerHTML = `<div class="total">${money(0, state.room.default_currency)}</div>
        <div class="avg">아직 지출이 없어요</div>`;
    } else {
      hero.innerHTML = Object.entries(totals).map(([c, t]) =>
        `<div class="cur-group"><div class="total">${money(t, c)}</div>
         <div class="avg">1인 평균 ${money(t / memberCount, c)}</div></div>`).join("");
    }

    // balances
    const { balances } = computeSettlement();
    const box = $("balances");
    box.innerHTML = "";
    if (state.members.length === 0) { box.innerHTML = `<div class="empty">멤버가 없어요</div>`; }
    state.members.forEach((m) => {
      const row = document.createElement("div");
      row.className = "bal-row";
      const parts = [];
      let hasAny = false;
      currenciesInUse().forEach((c) => {
        const v = Math.round((balances[c] && balances[c][m.id]) || 0);
        if (v !== 0) { hasAny = true; parts.push({ v, c }); }
      });
      const meTag = m.id === state.me ? `<span class="me-tag">나</span>` : "";
      let amtHtml;
      if (!hasAny) {
        amtHtml = `<span class="bal-amt zero">±0</span>`;
      } else {
        amtHtml = parts.map((p) =>
          `<span class="bal-amt ${p.v > 0 ? "pos" : "neg"}">${p.v > 0 ? "+" : "−"}${money(Math.abs(p.v), p.c).replace(/^[₩¥]/, CUR[p.c])}</span>`
        ).join(" ");
      }
      row.innerHTML = `<span class="bal-name">${m.name}${meTag}</span><span>${amtHtml}</span>`;
      box.appendChild(row);
    });

    // expense list on status (tap to mark on-the-spot settled)
    renderExpenseList($("status-exp-list"), state.expenses, "아직 지출이 없어요.");
    renderMembers();
    $("delete-trip-btn").style.display = isOwner(state.room.id) ? "block" : "none";
    $("settle-box").innerHTML = "";
    $("settle-btn").textContent = "🧮 정산하기";
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
    const all = [];
    for (const c in transfers) transfers[c].forEach((t) => all.push({ ...t, c }));
    if (all.length === 0) {
      box.innerHTML = `<div class="settle-done">✨ 정산 끝! 주고받을 게 없어요.</div>`;
      return;
    }
    box.innerHTML = all.map((t) =>
      `<div class="settle-row">
        <span class="from">${memberName(t.from)}</span>
        <span class="arrow">→</span>
        <span class="to">${memberName(t.to)}</span>
        <span class="amt">${money(t.amount, t.c)}</span>
      </div>`).join("");
  }

  function expenseItem(e) {
    const cur = e.currency || "KRW";
    const parts = (e.participant_ids && e.participant_ids.length) ? e.participant_ids : [e.payer_id];
    const item = document.createElement("button");
    item.className = "exp-item" + (e.settled ? " settled" : "");
    item.style.width = "100%";
    item.style.textAlign = "left";
    const badge = e.settled ? ` · <span class="exp-badge">✓정산완료</span>` : "";
    item.innerHTML = `
      <span class="exp-emoji">${EMOJI[e.category] || "💸"}</span>
      <span class="exp-mid">
        <span class="exp-title">${e.note ? escapeHtml(e.note) : (e.category || "지출")}</span>
        <span class="exp-sub">${memberName(e.payer_id)} 냄 · ${parts.length}명${badge}</span>
      </span>
      <span class="exp-amt">${money(e.amount, cur)}</span>`;
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

  function renderHistory() {
    renderExpenseList($("history-list"), state.expenses,
      "아직 등록된 지출이 없어요.<br>입력 화면에서 첫 지출을 넣어보세요.");
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ═══════════════════ ACTIONS ═══════════════════
  function parseAmount() {
    const raw = $("amount").value.replace(/[^\d]/g, "");
    return raw ? parseInt(raw, 10) : 0;
  }

  async function saveExpense() {
    const d = state.draft;
    const amount = parseAmount();
    if (!amount || amount <= 0) { toast("금액을 입력하세요", true); return; }
    if (d.participants.size === 0) { toast("나눌 사람을 1명 이상 선택", true); return; }
    const payload = {
      room_id: state.room.id,
      payer_id: d.payerId,
      amount,
      currency: d.currency,
      category: d.category || "기타",
      note: $("note").value.trim() || null,
      participant_ids: [...d.participants],
    };
    const btn = $("save-btn");
    btn.disabled = true;
    let error;
    if (d.editingId) {
      ({ error } = await sb.from("expenses").update(payload).eq("id", d.editingId));
    } else {
      ({ error } = await sb.from("expenses").insert(payload));
    }
    btn.disabled = false;
    if (error) { toast("저장 실패: " + error.message, true); return; }
    toast(d.editingId ? "수정됨" : "저장됨 ✓");
    // reset for next entry
    freshDraft();
    $("amount").value = "";
    $("note").value = "";
    $("save-btn").textContent = "저장";
    $("who-panel").classList.remove("open");
    renderCats();
    renderWho();
    await refetch();
    $("amount").focus();
  }

  // edit / delete modal
  let modalExpense = null;
  function openExpenseModal(e) {
    modalExpense = e;
    const cur = e.currency || "KRW";
    $("modal-title").textContent = (e.note || e.category || "지출");
    $("modal-sub").textContent = `${memberName(e.payer_id)} 냄 · ${money(e.amount, cur)}`
      + (e.settled ? " · ✓정산완료" : "");
    $("modal-settle").textContent = e.settled ? "↩ 정산완료 해제" : "✓ 현장정산 완료로 표시";
    $("modal-back").classList.add("show");
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
    state.draft.category = e.category;
    state.draft.payerId = e.payer_id;
    state.draft.participants = new Set((e.participant_ids && e.participant_ids.length) ? e.participant_ids : [e.payer_id]);
    closeModal();
    show("screen-input");
    $("amount").value = fmt(e.amount);
    $("note").value = e.note || "";
    renderCats();
    renderWho();
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
    if (!name) { toast("여행 이름을 입력하세요", true); return; }
    if (!meName) { toast("내 이름을 입력하세요", true); return; }
    const id = genRoomId();
    const btn = $("create-go"); btn.disabled = true;
    const { error: rErr } = await sb.from("rooms").insert({ id, name, default_currency: cur });
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
      else show("screen-create");
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

    const savedMe = recallMe(roomId);
    if (savedMe && state.members.some((m) => m.id === savedMe)) {
      enterApp(savedMe);
    } else {
      renderIdentity();
      show("screen-identity");
    }
  }

  // ═══════════════════ WIRE EVENTS ═══════════════════
  function wire() {
    // home (my trips)
    $("home-new").onclick = () => {
      $("create-back").style.display = getSavedRooms().length ? "block" : "none";
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

    // input screen
    $("input-cur").querySelectorAll("button").forEach((b) => {
      b.onclick = () => { state.draft.currency = b.dataset.cur; renderWho(); };
    });
    $("amount").addEventListener("input", (e) => {
      const raw = e.target.value.replace(/[^\d]/g, "");
      e.target.value = raw ? parseInt(raw, 10).toLocaleString("en-US") : "";
    });
    $("who-bar").onclick = () => $("who-panel").classList.toggle("open");
    $("save-btn").onclick = saveExpense;
    $("input-room").onclick = goHome;
    $("go-status").onclick = () => { renderStatus(); show("screen-status"); };

    // status
    $("status-back").onclick = () => show("screen-input");
    $("go-history").onclick = () => { renderHistory(); show("screen-history"); };
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
  }

  wire();
  boot();
})();
