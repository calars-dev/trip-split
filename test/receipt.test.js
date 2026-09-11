// 영수증 칸 확인이 한 번 삐끗했다고 영수증 기능을 통째로 끄지 않는다.
//
// 앱은 켜질 때 "영수증 칸이 DB에 있나"를 한 번 묻는다. 예전엔 그 질문이 어떤 이유로든
// 실패하면(연결이 잠깐 끊김, 로그인 토큰 갱신 중) 칸이 없는 걸로 쳤고, 그 세션 내내
// 📷 영수증 첨부 버튼이 사라지고 사진 없이도 저장됐다(2026-09-11, 여행 이틀 전 발견).
// 칸이 없다는 답은 "receipt_path" 를 직접 말하는 오류뿐이다.
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
      { id: "e1", room_id: ROOM, payer_id: "m1", amount: 50470, currency: "KRW", category: "기타",
        note: "공용 물품", participant_ids: ["m1", "m2"], spent_at: "2026-09-11T13:16:00Z",
        receipt_path: null, created_at: "2026-09-11T13:16:32Z" },
    ],
  };
}

// probe: what the "does receipt_path exist?" question returns — an error object,
// or "throw" for a request that never came back
function makeClient(T, probe) {
  function query(table) {
    let filters = [], single = false, cols = "*";
    const run = () => {
      if (table === "expenses" && cols === "receipt_path") {
        if (probe === "throw") throw new Error("Failed to fetch");
        return { data: probe ? null : [], error: probe || null };
      }
      const rows = (T[table] || []).filter((r) =>
        filters.every((f) => String(r[f[0]]) === String(f[1])));
      return { data: single ? (rows[0] || null) : rows, error: null };
    };
    const api = {
      select(c) { cols = c || "*"; return api; },
      eq(c, v) { filters.push([c, v]); return api; },
      order() { return api; }, limit() { return api; },
      maybeSingle() { single = true; return Promise.resolve().then(run); },
      single() { single = true; return Promise.resolve().then(run); },
      insert() { return api; }, update() { return api; }, delete() { return api; },
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

function boot(probe) {
  const dom = new JSDOM(html, { url: "https://x.test/?r=" + ROOM,
    runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.TRIP_SPLIT_CONFIG = { SUPABASE_URL: "https://fake", SUPABASE_ANON_KEY: "fake" };
  w.supabase = { createClient: () => makeClient(fixture(), probe) };
  w.fetch = () => Promise.reject(new Error("offline"));
  w.localStorage.setItem("tripsplit_me_" + ROOM, "m1");
  w.eval(appSrc);
  return w;
}

async function check(label, probe, wantMissing) {
  console.log("\n[" + label + "]");
  const w = boot(probe);
  await wait(250);
  const d = w.document;
  ok("입력 화면에 영수증 '필수' " + (wantMissing ? "없음" : "표시"),
    /필수/.test(d.getElementById("receipt-text").textContent), !wantMissing);
  ok("'칸이 없어요' 경고 " + (wantMissing ? "뜸" : "안 뜸"),
    /migration-receipt/.test(d.getElementById("receipt-note").textContent), wantMissing);
  d.getElementById("go-history").click();
  await wait(50);
  const row = d.querySelector("#timeline [data-id], #timeline .tlb, #timeline .exp");
  if (row) row.click();
  await wait(50);
  ok("지출 상세가 열렸다", d.getElementById("modal-back").classList.contains("show"), true);
  ok("📷 영수증 첨부 버튼 " + (wantMissing ? "숨김" : "보임"),
    d.getElementById("modal-shot").style.display, wantMissing ? "none" : "block");
}

(async () => {
  await check("정상 응답", null, false);
  await check("연결이 끊겨 요청이 실패", "throw", false);
  await check("토큰 문제 등 다른 오류", { message: "JWT expired" }, false);
  await check("권한 오류", { message: "permission denied for table expenses" }, false);
  await check("정말로 칸이 없는 DB", { message: "column expenses.receipt_path does not exist" }, true);

  console.log("\n" + (failures ? failures + "건 실패" : "전부 통과"));
  process.exit(failures ? 1 : 0);
})();
