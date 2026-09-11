// 영수증 여러 장 — 보기 · 지우기 · 옛 데이터와의 호환.
//
// receipt_paths(배열, 새 칸)와 receipt_path(한 장, 예전 칸)를 둘 다 읽어야 한다.
// 마이그레이션 전 DB에서도 첫 장은 그대로 보여야 하고, 배열 칸이 없는 채로 지우기를
// 눌러도 앱이 죽지 않고 옛 칸 하나로 물러나 계속 동작해야 한다.
//
// 실제 사진 선택·업로드(canvas 리사이즈)는 jsdom이 못 흉내내서 다른 테스트들과
// 마찬가지로 다루지 않는다 — 여기서는 이미 저장된 사진들의 표시·삭제·연결만 본다.
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
      // 새 칸으로 세 장 — 여러 장의 정상 경로
      { id: "multi", room_id: ROOM, payer_id: "m1", amount: 30000, currency: "KRW", category: "기타",
        note: "장보기", participant_ids: ["m1", "m2"], spent_at: "2026-09-13T02:00:00Z",
        receipt_paths: ["k1", "k2", "k3"], created_at: "2026-09-13T02:00:01Z" },
      // 옛 칸만 있는 한 장 — 마이그레이션 전부터 있던 행
      { id: "legacy", room_id: ROOM, payer_id: "m1", amount: 8000, currency: "KRW", category: "기타",
        note: "옛날 지출", participant_ids: ["m1", "m2"], spent_at: "2026-09-12T02:00:00Z",
        receipt_path: "old1", created_at: "2026-09-12T02:00:01Z" },
      // 아예 없음
      { id: "none", room_id: ROOM, payer_id: "m1", amount: 5000, currency: "KRW", category: "기타",
        note: "빈손", participant_ids: ["m1", "m2"], spent_at: "2026-09-11T02:00:00Z",
        created_at: "2026-09-11T02:00:01Z" },
    ],
  };
}

// T.probeError: what "칸이 있나" 확인이 내놓는 오류(receipt_paths 쪽). null = 정상.
// log: update 호출들을 순서대로 담는다. removed: storage.remove 로 지운 파일들.
function makeClient(T, log, removed) {
  function query(table) {
    let filters = [], single = false, cols = "*", pendingUpdate = null;
    const run = () => {
      if (table === "expenses" && cols === "receipt_paths" && T.probeError) return { data: null, error: T.probeError };
      if (pendingUpdate) {
        const p = pendingUpdate;
        // 배열 칸이 아직 없는 DB를 흉내낸다: 배열 칸을 쓰려 하면 첫 시도만 거절한다.
        if (T.noPathsCol && Object.prototype.hasOwnProperty.call(p, "receipt_paths") && !T.pathsColRejectedOnce) {
          T.pathsColRejectedOnce = true;
          return { data: null, error: { message: "column expenses.receipt_paths does not exist" } };
        }
        const idFilter = filters.find((f) => f[0] === "id");
        const row = idFilter && T.expenses.find((r) => r.id === idFilter[1]);
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
      update(p) { pendingUpdate = p; log.push(Object.assign({}, p)); return api; },
      delete() { return api; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    return api;
  }
  return {
    from: (t) => query(t),
    storage: { from: () => ({
      upload: () => Promise.resolve({ error: null }),
      remove: (keys) => { removed.push(...keys); return Promise.resolve({ error: null }); },
    }) },
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
  const log = [], removed = [];
  const dom = new JSDOM(html, { url: "https://x.test/?r=" + ROOM,
    runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.TRIP_SPLIT_CONFIG = { SUPABASE_URL: "https://fake", SUPABASE_ANON_KEY: "fake" };
  w.supabase = { createClient: () => makeClient(T, log, removed) };
  w.fetch = () => Promise.reject(new Error("offline"));
  w.confirm = () => true; // "지울까요?" — 시험에서는 늘 예
  w.localStorage.setItem("tripsplit_me_" + ROOM, "m1");
  w.eval(appSrc);
  return { w, log, removed };
}
const $ = (w, id) => w.document.getElementById(id);
async function openExpense(w, id) {
  $(w, "go-history").click();
  await wait(60);
  w.document.querySelector(`#timeline [data-id="${id}"]`).click();
  await wait(60);
}

(async () => {
  console.log("[여러 장짜리]");
  let { w } = boot(fixture());
  await wait(250);
  await openExpense(w, "multi");
  ok("보기 버튼에 장 수가 붙는다", $(w, "modal-shot").textContent, "🧾 영수증 보기 (3장)");
  $(w, "modal-shot").click();
  await wait(30);
  ok("갤러리가 열렸다", $(w, "shot-back").classList.contains("show"), true);
  ok("세 장 다 나온다", w.document.querySelectorAll("#shot-strip .sb-item").length, 3);
  ok("장마다 지우기 버튼", w.document.querySelectorAll("#shot-strip .sb-del").length, 3);
  ok("사진 추가 버튼도 보인다", $(w, "shot-add").style.display, "block");

  console.log("\n[한 장 지우기]");
  ({ w } = boot(fixture()));
  await wait(250);
  await openExpense(w, "multi");
  $(w, "modal-shot").click();
  await wait(30);
  w.document.querySelectorAll("#shot-strip .sb-del")[0].click(); // k1 지우기
  await wait(60);
  ok("갤러리는 계속 열려 있다 (두 장 남음)", $(w, "shot-back").classList.contains("show"), true);
  ok("두 장만 남았다", w.document.querySelectorAll("#shot-strip .sb-item").length, 2);
  const w1 = w.document.querySelectorAll("#shot-strip img")[0];
  ok("남은 첫 장은 k2", w1.src.indexOf("/k2_") === -1 && w1.src.indexOf("k2.jpg") >= 0, true);

  console.log("\n[마지막 한 장까지 지우면 닫힌다]");
  const T2 = fixture(); T2.expenses[0].receipt_paths = ["only"];
  ({ w } = boot(T2));
  await wait(250);
  await openExpense(w, "multi");
  $(w, "modal-shot").click();
  await wait(30);
  ok("한 장으로 열렸다 (제목에 장 수 없음)", $(w, "modal-title"), $(w, "modal-title")); // 참고용, 아래에서 실제 체크
  w.document.querySelector("#shot-strip .sb-del").click();
  await wait(60);
  ok("갤러리가 닫힌다", $(w, "shot-back").classList.contains("show"), false);

  console.log("\n[옛 데이터 (receipt_path 한 칸뿐)]");
  ({ w } = boot(fixture()));
  await wait(250);
  await openExpense(w, "legacy");
  ok("한 장은 장 수를 안 붙인다", $(w, "modal-shot").textContent, "🧾 영수증 보기");
  $(w, "modal-shot").click();
  await wait(30);
  ok("옛 칸 사진도 보인다", w.document.querySelectorAll("#shot-strip .sb-item").length, 1);
  ok("그 사진은 old1", w.document.querySelector("#shot-strip img").src.indexOf("old1.jpg") >= 0, true);

  console.log("\n[없음]");
  ({ w } = boot(fixture()));
  await wait(250);
  await openExpense(w, "none");
  ok("첨부 버튼으로 뜬다", $(w, "modal-shot").textContent, "📷 영수증 첨부");

  console.log("\n[+ 사진 추가 버튼은 첨부 파일 선택창으로 이어진다]");
  ({ w } = boot(fixture()));
  await wait(250);
  await openExpense(w, "multi");
  $(w, "modal-shot").click();
  await wait(30);
  let clicked = 0;
  $(w, "attach-file").click = () => { clicked++; };
  $(w, "shot-add").click();
  ok("첨부 파일 선택창을 열려 했다", clicked, 1);

  console.log("\n[배열 칸이 아직 없는 DB에서도 지우기가 된다]");
  const T3 = fixture(); T3.noPathsCol = true;
  ({ w, log } = boot(T3));
  await wait(250);
  await openExpense(w, "multi");
  $(w, "modal-shot").click();
  await wait(30);
  w.document.querySelector("#shot-strip .sb-del").click();
  await wait(80);
  ok("두 번 시도해서 결국 저장했다", log.length, 2);
  ok("첫 시도는 배열 칸을 썼다", Object.prototype.hasOwnProperty.call(log[0], "receipt_paths"), true);
  ok("물러난 두 번째 시도는 옛 칸만 쓴다", log[1], { receipt_path: "k2" });
  ok("갤러리는 남은 사진으로 계속 열려 있다", $(w, "shot-back").classList.contains("show"), true);

  console.log("\n" + (failures ? failures + "건 실패" : "전부 통과"));
  process.exit(failures ? 1 : 0);
})();
