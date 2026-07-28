// Drives the real saveStartDate() against a writable fake Supabase.
// Reproduces the Kyoto case: start date corrected 07-21 -> 07-24.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const APP = path.join(__dirname, "..");
const ROOM = "kyoto";
const M = { a: "m-a", b: "m-b" };
const ALL = [M.a, M.b];

let n = 0;
// day -> the real calendar date it sat on, given the original 07-21 start
const mk = (day, slot, note) => ({
  id: "e" + (++n), room_id: ROOM, payer_id: M.a, amount: 10000, currency: "KRW",
  category: "식비", note: note, participant_ids: ALL, settled: false,
  day_index: day, slot: slot, seq: 0,
  created_at: "2026-07-" + String(20 + day).padStart(2, "0") + "T0" + (n % 9) + ":00:00Z",
});

function fixture() {
  n = 0;
  return {
    rooms: [{ id: ROOM, name: "교토", default_currency: "KRW", start_date: "2026-07-21",
              base_rate_jpy: 9.1, base_rate_date: "2026-07-21", created_at: "2026-07-20T00:00:00Z" }],
    members: [
      { id: M.a, room_id: ROOM, name: "민수", created_at: "2026-07-20T00:00:01Z" },
      { id: M.b, room_id: ROOM, name: "지현", created_at: "2026-07-20T00:00:02Z" },
    ],
    expenses: [
      mk(1, "저녁", "숙소 선결제"),
      mk(4, "오후", "d4-a"), Object.assign(mk(4, "저녁", "d4-b"), { seq: 1 }),
      mk(5, "점심", "d5-a"),
      mk(6, "오후", "d6-a"),
      mk(7, "저녁", "d7-a"), Object.assign(mk(7, "저녁", "d7-b"), { seq: 1 }),
      mk(8, "밤", "d8-a"),
    ],
  };
}

function makeClient(TABLES) {
  function query(table) {
    let filters = [], orderBy = null, single = false, mode = null, patch = null;
    function match(r) { return filters.every((f) => String(r[f[0]]) === String(f[1])); }
    function run() {
      const rows = TABLES[table].filter(match);
      if (mode === "update") {
        rows.forEach((r) => Object.assign(r, patch));
        return { data: rows, error: null };
      }
      let out = rows;
      if (orderBy) {
        const col = orderBy[0], asc = orderBy[1];
        out = rows.slice().sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
      }
      return { data: single ? (out[0] || null) : out, error: null };
    }
    const api = {
      select() { return api; },
      eq(c, v) { filters.push([c, v]); return api; },
      order(c, o) { orderBy = [c, !o || o.ascending !== false]; return api; },
      maybeSingle() { single = true; return Promise.resolve(run()); },
      single() { single = true; return Promise.resolve(run()); },
      insert() { return api; },
      update(p) { mode = "update"; patch = p; return api; },
      delete() { return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }
  return {
    from: (t) => query(t),
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

function boot(TABLES) {
  const dom = new JSDOM(html, { url: "https://x.test/?r=" + ROOM, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.TRIP_SPLIT_CONFIG = { SUPABASE_URL: "https://fake", SUPABASE_ANON_KEY: "fake" };
  w.supabase = { createClient: () => makeClient(TABLES) };
  w.fetch = () => Promise.reject(new Error("offline"));
  w.localStorage.setItem("tripsplit_me_" + ROOM, M.a);
  w.eval(appSrc);
  return w;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const layout = (T) => {
  const by = {};
  T.expenses.slice()
    .sort((a, b) => a.day_index - b.day_index || a.seq - b.seq)
    .forEach((e) => { (by[e.day_index] = by[e.day_index] || []).push((e.slot || "-") + ":" + e.note + "#" + e.seq); });
  return by;
};

(async () => {
  console.log("[교토 케이스] 시작일 07-21 -> 07-24 (3일 늦춤)");
  let T = fixture();
  let w = boot(T);
  await wait(200);
  w.document.getElementById("date-input").value = "2026-07-24";
  w.document.getElementById("date-save").click();
  await wait(300);

  ok("시작일 저장됨", T.rooms[0].start_date, "2026-07-24");
  ok("일차가 3칸씩 당겨지고 07-21건은 준비로", layout(T), {
    0: ["-:숙소 선결제#0"],
    1: ["오후:d4-a#0", "저녁:d4-b#1"],
    2: ["점심:d5-a#0"],
    3: ["오후:d6-a#0"],
    4: ["저녁:d7-a#0", "저녁:d7-b#1"],
    5: ["밤:d8-a#0"],
  });
  ok("준비로 간 건 시간대가 지워짐", T.expenses.filter((e) => e.day_index === 0).map((e) => e.slot), [null]);
  ok("건수 유지", T.expenses.length, 8);

  console.log("\n[되돌리기] 07-24 -> 07-21 (3일 앞당김)");
  w.document.getElementById("date-input").value = "2026-07-21";
  w.document.getElementById("date-save").click();
  await wait(300);
  ok("일차가 3칸씩 밀림", layout(T), {
    0: ["-:숙소 선결제#0"],          // prep stays prep — its real date is unknown
    4: ["오후:d4-a#0", "저녁:d4-b#1"],
    5: ["점심:d5-a#0"],
    6: ["오후:d6-a#0"],
    7: ["저녁:d7-a#0", "저녁:d7-b#1"],
    8: ["밤:d8-a#0"],
  });

  console.log("\n[여러 날이 한꺼번에 준비로] 07-21 -> 07-27 (6일 늦춤)");
  T = fixture();
  w = boot(T);
  await wait(200);
  w.document.getElementById("date-input").value = "2026-07-27";
  w.document.getElementById("date-save").click();
  await wait(400);
  ok("1·4·5·6일차가 전부 준비로 모이고 seq가 0,1,2,3,4로 다시 매겨짐", layout(T), {
    0: ["-:숙소 선결제#0", "-:d4-a#1", "-:d4-b#2", "-:d5-a#3", "-:d6-a#4"],
    1: ["저녁:d7-a#0", "저녁:d7-b#1"],
    2: ["밤:d8-a#0"],
  });
  ok("준비로 모인 건 전부 시간대 없음",
    T.expenses.filter((e) => e.day_index === 0).every((e) => e.slot === null), true);
  ok("seq 중복 없음",
    new Set(T.expenses.filter((e) => e.day_index === 0).map((e) => e.seq)).size, 5);

  console.log("\n[변화 없음] 같은 날짜로 저장");
  const before = JSON.stringify(layout(T));
  w.document.getElementById("date-input").value = "2026-07-27";
  w.document.getElementById("date-save").click();
  await wait(200);
  ok("아무것도 안 건드림", JSON.stringify(layout(T)), before);

  console.log("\n" + (failures ? failures + "건 실패" : "전부 통과"));
  process.exit(failures ? 1 : 0);
})();
