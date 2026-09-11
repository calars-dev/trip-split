// 기록 화면의 🗑 — 지운 지출이 사라지지 않고 여기 남는다.
//
// 1. 지운 지출은 잔액·정산·타임라인·지출목록에서 빠지지만 🗑에는 남는다.
// 2. 🗑에서 되돌리면 그 계산들에 다시 들어간다.
// 3. deleted_at 칸이 없는 DB에서는 예전처럼 영구 삭제고, 되돌리기를 권하지 않는다.
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
      { id: "e1", room_id: ROOM, payer_id: "m1", amount: 10000, currency: "KRW", category: "식사",
        note: "라멘", participant_ids: ["m1", "m2"], spent_at: "2026-09-13T03:00:00Z",
        created_at: "2026-09-13T03:00:01Z" },
      { id: "e2", room_id: ROOM, payer_id: "m2", amount: 5000, currency: "KRW", category: "카페",
        note: "커피", participant_ids: ["m1", "m2"], spent_at: "2026-09-13T04:00:00Z",
        created_at: "2026-09-13T04:00:01Z" },
    ],
  };
}

// T.noDeletedAtCol: deleted_at 칸이 아직 없는 DB 흉내 — 그 칸을 건드리는 시도만 거절한다.
function makeClient(T, log) {
  function query(table) {
    let filters = [], single = false, cols = "*", pendingUpdate = null, pendingDelete = false;
    const run = () => {
      // 칸이 없는 DB 흉내: 그 칸을 실제로 건드리는 시도만 거절한다 — 평범한
      // select("*")·나머지 update 는 항상 성공해야 refetch 가 정상적으로 돈다.
      if (table === "expenses" && cols === "deleted_at" && T.noDeletedAtCol) {
        return { data: null, error: { message: "column expenses.deleted_at does not exist" } };
      }
      if (pendingDelete) {
        const idFilter = filters.find((f) => f[0] === "id");
        if (idFilter) T[table] = T[table].filter((r) => r.id !== idFilter[1]);
        return { data: null, error: null };
      }
      if (pendingUpdate) {
        const p = pendingUpdate;
        if (T.noDeletedAtCol && Object.prototype.hasOwnProperty.call(p, "deleted_at")) {
          return { data: null, error: { message: "column expenses.deleted_at does not exist" } };
        }
        const idFilter = filters.find((f) => f[0] === "id");
        const row = idFilter && T[table].find((r) => r.id === idFilter[1]);
        if (row) Object.assign(row, p);
        return { data: null, error: null };
      }
      const rows = (T[table] || []).filter((r) => filters.every((f) => String(r[f[0]]) === String(f[1])));
      return { data: single ? (rows[0] || null) : rows, error: null };
    };
    const api = {
      select(c) { cols = c || "*"; return api; },
      eq(c, v) { filters.push([c, v]); return api; },
      order() { return api; }, limit() { return api; },
      maybeSingle() { single = true; return Promise.resolve().then(run); },
      single() { single = true; return Promise.resolve().then(run); },
      insert() { return api; },
      update(p) { pendingUpdate = p; log.push(["update", table, p]); return api; },
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

function boot(T) {
  const log = [];
  const dom = new JSDOM(html, { url: "https://x.test/?r=" + ROOM,
    runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.TRIP_SPLIT_CONFIG = { SUPABASE_URL: "https://fake", SUPABASE_ANON_KEY: "fake" };
  w.supabase = { createClient: () => makeClient(T, log) };
  w.fetch = () => Promise.reject(new Error("offline"));
  w.confirm = () => true;
  w.localStorage.setItem("tripsplit_me_" + ROOM, "m1");
  w.eval(appSrc);
  return { w, log };
}
const $ = (w, id) => w.document.getElementById(id);
async function deleteViaModal(w, id) {
  $(w, "go-history").click();
  await wait(60);
  w.document.querySelector(`#timeline [data-id="${id}"]`).click();
  await wait(60);
  $(w, "modal-delete").click();
  await wait(30);
  $(w, "confirm-yes").click();
  await wait(80);
}

(async () => {
  console.log("[지우면 목록·계산에서 빠지고 🗑에만 남는다]");
  let { w } = boot(fixture());
  await wait(250);
  await deleteViaModal(w, "e1");
  ok("타임라인에는 없다", w.document.querySelector('#timeline [data-id="e1"]'), null);
  ok("남은 하나는 그대로 있다", !!w.document.querySelector('#timeline [data-id="e2"]'), true);
  ok("🗑 표시에 1이 뜬다", $(w, "trash-count").textContent, "1");

  $(w, "go-status").click();
  await wait(60);
  ok("정산 지출 목록에도 없다", $(w, "status-exp-list").textContent.indexOf("라멘") === -1, true);
  ok("잔액에서도 빠졌다 (남은 커피 5,000을 반씩 나눈 2,500만 보인다)",
    $(w, "balances").textContent.indexOf("2,500") >= 0, true);

  $(w, "trash-btn").click();
  await wait(30);
  ok("🗑 화면이 열렸다", $(w, "screen-trash").classList.contains("active"), true);
  ok("지운 지출이 보인다", /라멘/.test($(w, "trash-list").textContent), true);

  console.log("\n[🗑에서 되돌리면 다시 계산에 들어간다]");
  w.document.querySelector(".trash-restore").click();
  await wait(80);
  ok("🗑 목록에서 사라졌다", /라멘/.test($(w, "trash-list").textContent), false);
  ok("🗑 표시가 비었다", $(w, "trash-count").textContent, "");
  $(w, "trash-back").click();
  await wait(30);
  ok("타임라인에 다시 있다", !!w.document.querySelector('#timeline [data-id="e1"]'), true);

  console.log("\n[빈 🗑]");
  ({ w } = boot(fixture()));
  await wait(250);
  $(w, "go-history").click();
  await wait(60);
  ok("표시가 비어 있다", $(w, "trash-count").textContent, "");
  $(w, "trash-btn").click();
  await wait(30);
  ok("빈 화면 문구", /지운 지출이 없어요/.test($(w, "trash-list").textContent), true);

  console.log("\n[deleted_at 칸이 없는 DB]");
  const T2 = fixture(); T2.noDeletedAtCol = true;
  let { w: w2, log } = boot(T2);
  await wait(250);
  await deleteViaModal(w2, "e1");
  // 부팅할 때 이미 칸이 없다는 걸 확인했으므로, update 를 다시 시도하지 않고
  // 곧바로 예전 방식(영구 삭제)으로 간다.
  ok("바로 delete 로 간다 (헛수고인 update 를 또 시도하지 않는다)",
    log.map((l) => l[0]), ["delete"]);
  ok("영구 삭제라고 알린다", /되돌릴 수 없어요/.test($(w2, "toast").textContent), true);
  ok("되돌리기 막대는 뜨지 않는다", $(w2, "undo-toast").classList.contains("show"), false);
  ok("🗑도 비어 있다 (되살릴 방법이 없으니 보여줄 것도 없다)", $(w2, "trash-count").textContent, "");

  console.log("\n" + (failures ? failures + "건 실패" : "전부 통과"));
  process.exit(failures ? 1 : 0);
})();
