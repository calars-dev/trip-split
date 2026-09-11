// 새 지출 알림 — 앱 쪽 약속.
//
// 1. 새 지출을 저장하면 notify-expense 를 부른다(그 지출 id 와 로그인 토큰을 실어서).
//    고치기·저장 실패는 부르지 않는다 — 수정할 때마다 열세 명 폰이 울리면 안 된다.
// 2. 알림을 눌러 ?e=<id> 로 들어오면 그 지출이 바로 열리고, 주소에서 ?e= 는 지워진다.
// 3. 알림 버튼: 켜면 구독을 만들어 서버에 등록, 다시 누르면 끈다.
//    알림을 못 받는 브라우저에서는 이유를 말한다(아이폰은 홈 화면 추가 안내로).
//
// 서버(Edge Function)와 암호화는 webpush.test.js 가 따로 본다.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const APP = path.join(__dirname, "..");
const ROOM = "r1";
const M = { boss: "m-boss", other: "m-other", pot: "m-pot" };
const VAPID = "BL91OAAVEer2NJ7lHo-miQ58i57wG37it68FjOe3PE4mhwYd5f7_BuOBjfjnb-IWewS1a5TLvGkaDZw5uEdqP0k";

function fixture() {
  return {
    rooms: [{ id: ROOM, name: "이시가키", default_currency: "JPY", start_date: "2026-09-13",
              day_count: 5, manager_id: M.boss, created_at: "2026-08-01T00:00:00Z" }],
    members: [
      { id: M.boss,  room_id: ROOM, name: "이수형", is_ledger: false, created_at: "2026-08-01T00:00:01Z" },
      { id: M.other, room_id: ROOM, name: "정원호", is_ledger: false, created_at: "2026-08-01T00:00:02Z" },
      { id: M.pot,   room_id: ROOM, name: "공금",   is_ledger: true,  created_at: "2026-08-01T00:00:03Z" },
    ],
    expenses: [
      { id: "e1", room_id: ROOM, payer_id: M.other, amount: 1200, currency: "JPY", category: "식사",
        note: "라멘", participant_ids: [M.boss, M.other], spent_at: "2026-09-13T03:00:00Z",
        rate_krw: 9.1, created_at: "2026-09-13T03:00:01Z" },
    ],
  };
}

// log: what the app asked the server for
function makeClient(T, log) {
  function query(table) {
    let filters = [], single = false, cols = "*", inserted = null, failInsert = false;
    const run = () => {
      // The receipt-column probe fails on purpose: without it every new expense
      // would demand a photo, which a test can't pick.
      if (table === "expenses" && cols === "receipt_path") return { data: null, error: { message: "column expenses.receipt_path does not exist" } };
      if (inserted) return failInsert
        ? { data: null, error: { message: "boom" } }
        : { data: [{ id: inserted.id }], error: null };
      const rows = (T[table] || []).filter((r) =>
        filters.every((f) => String(r[f[0]]) === String(f[1])));
      return { data: single ? (rows[0] || null) : rows, error: null };
    };
    const api = {
      select(c) { if (!inserted) cols = c || "*"; return api; },
      eq(c, v) { filters.push([c, v]); return api; },
      order() { return api; }, limit() { return api; },
      maybeSingle() { single = true; return Promise.resolve(run()); },
      single() { single = true; return Promise.resolve(run()); },
      insert(p) {
        failInsert = !!T.failInsert;
        inserted = Object.assign({ id: "e-new" }, p);
        if (!failInsert) T[table].push(inserted);
        log.push(["insert", table]);
        return api;
      },
      update() { log.push(["update", table]); return api; },
      delete() { return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }
  return {
    from: (t) => query(t),
    rpc(name, args) {
      if (name === "handle_available") return Promise.resolve({ data: null, error: { message: "off" } });
      log.push(["rpc", name, args]);
      return Promise.resolve({ data: true, error: null });
    },
    auth: { getSession: () => Promise.resolve({ data: { session: { access_token: "tok-123" } } }) },
    storage: { from: () => ({ upload: () => Promise.resolve({ error: null }) }) },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
  };
}

let failures = 0;
const ok = (name, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures++;
  console.log((pass ? "  PASS  " : "  FAIL  ") + name);
  if (!pass) console.log("          기대: " + JSON.stringify(want) + "\n          실제: " + JSON.stringify(got));
};

const html = fs.readFileSync(path.join(APP, "index.html"), "utf8")
  .replace(/<script src="(config\.js|vendor\/supabase\.js|app\.js)"><\/script>/g, "");
const appSrc = fs.readFileSync(path.join(APP, "app.js"), "utf8");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// push: undefined → a browser without push (jsdom as is); an object → a fake
// browser that has it, recording what the app did with it.
function boot(T, { meId = M.boss, search = "?r=" + ROOM, push } = {}) {
  const log = [];
  const fetched = [];
  const dom = new JSDOM(html, { url: "https://x.test/trip-split/" + search,
    runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.TRIP_SPLIT_CONFIG = { SUPABASE_URL: "https://fake", SUPABASE_ANON_KEY: "anon-key", VAPID_PUBLIC_KEY: VAPID };
  w.supabase = { createClient: () => makeClient(T, log) };
  w.fetch = (url, opts) => {
    if (String(url).indexOf("/functions/v1/") >= 0) {
      fetched.push({ url: String(url), opts });
      return Promise.resolve({ ok: true });
    }
    return Promise.reject(new Error("offline"));
  };
  w.localStorage.setItem("tripsplit_me_" + ROOM, meId);
  if (push) {
    w.localStorage.setItem("tripsplit_install_dismissed", "1");
    const reg = { pushManager: {
      getSubscription: async () => push.sub,
      subscribe: async (opts) => {
        push.subscribeOpts = opts;
        push.sub = {
          endpoint: "https://web.push.apple.com/QAbc",
          toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "P256", auth: "AUTH" } }; },
          unsubscribe: async () => { push.unsubscribed = true; push.sub = null; return true; },
        };
        return push.sub;
      },
    } };
    push.listeners = {};
    Object.defineProperty(w.navigator, "serviceWorker", { configurable: true, value: {
      register: async (u) => { push.registered = u; return reg; },
      ready: Promise.resolve(reg),
      addEventListener: (t, fn) => { push.listeners[t] = fn; },
    } });
    w.PushManager = function () {};
    w.Notification = { permission: push.permission || "default",
      requestPermission: async () => { w.Notification.permission = push.answer || "granted"; return w.Notification.permission; } };
  }
  w.eval(appSrc);
  return { w, log, fetched };
}
const $ = (w, id) => w.document.getElementById(id);
const modalOpen = (w) => $(w, "modal-back").classList.contains("show");
const toastText = (w) => $(w, "toast").textContent;

async function saveNew(w, amount) {
  $(w, "amount").value = String(amount);
  $(w, "amount").dispatchEvent(new w.Event("input"));
  $(w, "save-btn").click();
  await wait(250);
}

(async () => {
  console.log("[저장] 새 지출이면 알림을 부른다");
  let T = fixture();
  let r = boot(T);
  await wait(250);
  await saveNew(r.w, 500);
  ok("지출이 저장됐다", r.log.some((l) => l[0] === "insert" && l[1] === "expenses"), true);
  ok("notify-expense 를 한 번 불렀다", r.fetched.length, 1);
  const call = r.fetched[0] || { opts: { headers: {} } };
  ok("주소", call.url, "https://fake/functions/v1/notify-expense");
  ok("방금 저장한 지출 id 를 싣는다", JSON.parse(call.opts.body || "{}"), { expense_id: "e-new" });
  ok("로그인 토큰으로 부른다", call.opts.headers.Authorization, "Bearer tok-123");
  ok("anon 키도 함께", call.opts.headers.apikey, "anon-key");

  console.log("\n[저장] 실패하면 부르지 않는다");
  T = fixture(); T.failInsert = true;
  r = boot(T);
  await wait(250);
  await saveNew(r.w, 500);
  ok("알림 호출 없음", r.fetched.length, 0);
  ok("실패를 알린다", /저장 실패/.test(toastText(r.w)), true);

  console.log("\n[저장] 고치기는 부르지 않는다");
  T = fixture();
  r = boot(T);
  await wait(250);
  $(r.w, "go-history").click();
  await wait(50);
  const row = r.w.document.querySelector("#timeline [data-id], #timeline .tlb, #timeline .exp");
  if (row) row.click();
  await wait(50);
  ok("지출을 눌러 열었다", modalOpen(r.w), true);
  $(r.w, "modal-edit").click();
  await wait(50);
  $(r.w, "save-btn").click();
  await wait(250);
  ok("수정으로 저장됐다", r.log.some((l) => l[0] === "update" && l[1] === "expenses"), true);
  ok("알림 호출 없음", r.fetched.length, 0);

  console.log("\n[알림 누름] ?e= 로 들어오면 그 지출이 열린다");
  r = boot(fixture(), { meId: M.other, search: "?r=" + ROOM + "&e=e1" });
  await wait(300);
  ok("상세가 열려 있다", modalOpen(r.w), true);
  ok("그 지출이다", $(r.w, "modal-title").textContent, "라멘");
  ok("뒤는 기록 화면", $(r.w, "screen-history").classList.contains("active"), true);
  ok("주소에서 ?e= 가 지워졌다", r.w.location.search, "?r=" + ROOM);

  r = boot(fixture(), { meId: M.other, search: "?r=" + ROOM + "&e=gone" });
  await wait(300);
  ok("지워진 지출이면 열지 않는다", modalOpen(r.w), false);
  ok("그렇다고 말한다", /찾지 못했어요/.test(toastText(r.w)), true);

  console.log("\n[알림 버튼] 알림을 못 받는 브라우저");
  r = boot(fixture());
  await wait(250);
  $(r.w, "go-history").click();
  await wait(30);
  ok("기록 화면에 버튼이 있다", /알림 받기/.test($(r.w, "push-btn").textContent), true);
  ok("안내 막대는 뜨지 않는다", $(r.w, "push-hint").classList.contains("show"), false);
  $(r.w, "push-btn").click();
  await wait(30);
  ok("못 받는다고 말한다", /알림을 받을 수 없어요/.test(toastText(r.w)), true);

  console.log("\n[알림 버튼] 켜고 끄기");
  const push = {};
  T = fixture();
  r = boot(T, { push });
  await wait(250);
  ok("서비스 워커를 등록했다", push.registered, "sw.js");
  $(r.w, "go-history").click();
  await wait(30);
  ok("처음엔 안내 막대가 뜬다", $(r.w, "push-hint").classList.contains("show"), true);
  $(r.w, "push-go").click();
  await wait(80);
  ok("안내 막대가 닫혔다", $(r.w, "push-hint").classList.contains("show"), false);
  ok("VAPID 공개키로 구독 (65바이트)", push.subscribeOpts && push.subscribeOpts.applicationServerKey.length, 65);
  ok("보이는 알림만", push.subscribeOpts && push.subscribeOpts.userVisibleOnly, true);
  const saveCall = r.log.find((l) => l[1] === "save_push_subscription");
  ok("서버에 등록했다", saveCall && saveCall[2],
    { p_room: ROOM, p_endpoint: "https://web.push.apple.com/QAbc", p_p256dh: "P256", p_auth: "AUTH" });
  ok("버튼이 켜짐으로", /알림 켜짐/.test($(r.w, "push-btn").textContent), true);
  $(r.w, "push-btn").click();
  await wait(80);
  ok("서버에서 지웠다", r.log.some((l) => l[1] === "delete_push_subscription"), true);
  ok("폰 구독도 해제", push.unsubscribed, true);
  ok("버튼이 다시 받기로", /알림 받기/.test($(r.w, "push-btn").textContent), true);

  console.log("\n[알림 버튼] 거절하면");
  const no = { answer: "denied" };
  r = boot(fixture(), { push: no });
  await wait(250);
  $(r.w, "go-history").click();
  $(r.w, "push-btn").click();
  await wait(80);
  ok("구독을 만들지 않는다", no.subscribeOpts, undefined);
  ok("버튼이 차단됨으로", /알림 차단됨/.test($(r.w, "push-btn").textContent), true);

  console.log("\n[열려 있을 때 알림 누름] 워커가 보낸 메시지로 이동");
  const open = { permission: "granted" };
  r = boot(fixture(), { meId: M.other, push: open });
  await wait(250);
  ok("폰에 구독이 없으면 서버에 보내지 않는다", r.log.some((l) => l[1] === "save_push_subscription"), false);
  await open.listeners.message({ data: { open: "https://x.test/trip-split/?r=" + ROOM + "&e=e1" } });
  await wait(80);
  ok("그 지출이 열린다", modalOpen(r.w) && $(r.w, "modal-title").textContent, "라멘");

  console.log("\n" + (failures ? failures + "건 실패" : "전부 통과"));
  process.exit(failures ? 1 : 0);
})();
