// 지출 삭제 되돌리기 + 정산 결과 카톡 공유.
//
// 1. 지출을 지우면 곧바로 "삭제됨 · 되돌리기" 막대가 뜨고, 5초 안에 누르면 그
//    지출이 같은 id로 되살아난다. 시간이 지나거나 다른 화면으로 가면 사라진다.
// 2. 정산 화면의 카톡 공유 버튼은 이름·금액이 들어간 텍스트를 만든다. 공유
//    시트가 있으면 그걸로, 없으면 클립보드로 물러난다.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const APP = path.join(__dirname, "..");
const ROOM = "r1";

function fixture() {
  return {
    rooms: [{ id: ROOM, name: "이시가키", default_currency: "JPY", start_date: "2026-09-13",
              day_count: 5, manager_id: "m1", created_at: "2026-08-01T00:00:00Z" }],
    members: [
      { id: "m1", room_id: ROOM, name: "이수형", is_ledger: false, created_at: "2026-08-01T00:00:01Z" },
      { id: "m2", room_id: ROOM, name: "정원호", is_ledger: false, created_at: "2026-08-01T00:00:02Z" },
    ],
    expenses: [
      { id: "e1", room_id: ROOM, payer_id: "m1", amount: 12000, currency: "KRW", category: "식사",
        note: "라멘", participant_ids: ["m1", "m2"], spent_at: "2026-09-13T03:00:00Z",
        created_at: "2026-09-13T03:00:01Z" },
    ],
  };
}

function makeClient(T, log) {
  function query(table) {
    let filters = [], single = false, pendingUpdate = null, pendingInsert = null, pendingDelete = false;
    const run = () => {
      if (pendingDelete) {
        const idFilter = filters.find((f) => f[0] === "id");
        if (idFilter) T[table] = T[table].filter((r) => r.id !== idFilter[1]);
        return { data: null, error: null };
      }
      if (pendingInsert) {
        if (T.failRestore) return { data: null, error: { message: "boom" } };
        T[table].push(pendingInsert);
        return { data: null, error: null };
      }
      if (pendingUpdate) {
        const idFilter = filters.find((f) => f[0] === "id");
        const row = idFilter && T[table].find((r) => r.id === idFilter[1]);
        if (row) Object.assign(row, pendingUpdate);
        return { data: null, error: null };
      }
      const rows = (T[table] || []).filter((r) => filters.every((f) => String(r[f[0]]) === String(f[1])));
      return { data: single ? (rows[0] || null) : rows, error: null };
    };
    const api = {
      select() { return api; },
      eq(c, v) { filters.push([c, v]); return api; },
      order() { return api; }, limit() { return api; },
      maybeSingle() { single = true; return Promise.resolve().then(run); },
      single() { single = true; return Promise.resolve().then(run); },
      insert(p) { pendingInsert = p; log.push(["insert", table, p]); return api; },
      update(p) { pendingUpdate = p; return api; },
      delete() { pendingDelete = true; log.push(["delete", table]); return api; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    return api;
  }
  return {
    from: (t) => query(t),
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

function boot(T, { share } = {}) {
  const log = [];
  const dom = new JSDOM(html, { url: "https://x.test/?r=" + ROOM,
    runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.TRIP_SPLIT_CONFIG = { SUPABASE_URL: "https://fake", SUPABASE_ANON_KEY: "fake" };
  w.supabase = { createClient: () => makeClient(T, log) };
  w.fetch = () => Promise.reject(new Error("offline"));
  w.confirm = () => true;
  w.localStorage.setItem("tripsplit_me_" + ROOM, "m1");
  if (share) w.navigator.share = share;
  w.eval(appSrc);
  return { w, log };
}
const $ = (w, id) => w.document.getElementById(id);
async function openAndDelete(w) {
  $(w, "go-history").click();
  await wait(60);
  w.document.querySelector('#timeline [data-id="e1"]').click();
  await wait(60);
  $(w, "modal-delete").click();
  await wait(30);
  $(w, "confirm-yes").click();
  await wait(80);
}

(async () => {
  console.log("[삭제 되돌리기]");
  const T = fixture();
  let { w, log } = boot(T);
  await wait(250);
  await openAndDelete(w);
  ok("삭제 요청이 나갔다", log.some((l) => l[0] === "delete"), true);
  ok("확인 시트가 닫혔다", $(w, "confirm-back").classList.contains("show"), false);
  ok("되돌리기 막대가 떴다", $(w, "undo-toast").classList.contains("show"), true);
  ok("메시지에 이름이 있다", /라멘/.test($(w, "undo-msg").textContent), true);
  ok("목록에서 사라졌다", T.expenses.length, 0);

  $(w, "undo-btn").click();
  await wait(80);
  ok("되돌리기 요청이 나갔다", log.some((l) => l[0] === "insert"), true);
  ok("같은 id로 되살아났다", T.expenses.map((e) => e.id), ["e1"]);
  ok("막대가 닫혔다", $(w, "undo-toast").classList.contains("show"), false);

  console.log("\n[5초가 지나면 되돌릴 수 없다]");
  ({ w, log } = boot(fixture()));
  await wait(250);
  await openAndDelete(w);
  ok("일단 막대가 뜬다", $(w, "undo-toast").classList.contains("show"), true);
  await wait(5200);
  ok("시간이 지나면 스스로 닫힌다", $(w, "undo-toast").classList.contains("show"), false);

  console.log("\n[화면을 옮기면 그 제안을 잊는다]");
  ({ w, log } = boot(fixture()));
  await wait(250);
  await openAndDelete(w);
  ok("떠 있다", $(w, "undo-toast").classList.contains("show"), true);
  $(w, "history-back").click();
  await wait(30);
  ok("다른 화면으로 가면 닫힌다", $(w, "undo-toast").classList.contains("show"), false);

  console.log("\n[되돌리기가 실패하면]");
  const T2 = fixture(); T2.failRestore = true;
  ({ w } = boot(T2));
  await wait(250);
  await openAndDelete(w);
  $(w, "undo-btn").click();
  await wait(80);
  ok("실패를 알린다", /되돌리지 못했어요/.test($(w, "toast").textContent), true);

  console.log("\n[카톡 공유] 공유 시트가 있으면 그걸 쓴다");
  let shared = null;
  ({ w } = boot(fixture(), { share: (data) => { shared = data; return Promise.resolve(); } }));
  await wait(250);
  $(w, "go-status").click();
  await wait(60);
  $(w, "share-btn").click();
  await wait(30);
  ok("공유 시트를 불렀다", !!shared, true);
  ok("방 이름이 들어간다", shared.text.indexOf("이시가키") >= 0, true);
  ok("사람 이름이 들어간다", /이수형|정원호/.test(shared.text), true);
  ok("금액이 들어간다", shared.text.indexOf("₩") >= 0, true);
  ok("링크가 들어간다", shared.text.indexOf("?r=" + ROOM) >= 0, true);

  console.log("\n[카톡 공유] 시트가 없으면 클립보드로 물러난다");
  let copied = null;
  ({ w } = boot(fixture()));
  w.navigator.clipboard = { writeText: (t) => { copied = t; return Promise.resolve(); } };
  await wait(250);
  $(w, "go-status").click();
  await wait(60);
  $(w, "share-btn").click();
  await wait(30);
  ok("클립보드에 복사했다", !!copied, true);
  ok("복사됐다고 알린다", /복사했어요/.test($(w, "toast").textContent), true);

  console.log("\n[카톡 공유] 정산 끝일 때도 뜬다");
  const T3 = fixture(); T3.expenses = [];
  let shared3 = null;
  ({ w } = boot(T3, { share: (data) => { shared3 = data; return Promise.resolve(); } }));
  await wait(250);
  $(w, "go-status").click();
  await wait(60);
  $(w, "share-btn").click();
  await wait(30);
  ok("정산 끝 문구가 들어간다", shared3.text.indexOf("정산 끝") >= 0, true);

  console.log("\n" + (failures ? failures + "건 실패" : "전부 통과"));
  process.exit(failures ? 1 : 0);
})();
