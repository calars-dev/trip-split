// 시작일을 바꿔도 지출은 제자리에 있어야 한다.
//
// 예전에는 지출이 "며칠차"만 들고 있어서, 시작일을 고치면 모든 지출의 day_index 를
// 다시 써야 했다(shiftDays). 쓰는 도중에 끊기면 절반만 옮겨진 장부가 남고, 여러 날이
// 한꺼번에 '준비'로 접히면 seq 가 충돌해 순서가 뒤집혔다. 교토 여행에서 실제로 겪은 일이다.
//
// 지금은 지출이 `spent_at` 으로 자기가 언제였는지 알고 있다. 시작일은 "몇 일차"라는
// 라벨을 세는 기준일 뿐이라, 바꿔도 **아무것도 쓰지 않는다.** 이 테스트가 지키는 건
// 그 한 줄이다 — 데이터는 그대로, 라벨만 다시 센다.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const APP = path.join(__dirname, "..");
const ROOM = "kyoto";
const M = { a: "m-a", b: "m-b" };
const ALL = [M.a, M.b];

let n = 0;
const mk = (isoLocal, note) => ({
  id: "e" + (++n), room_id: ROOM, payer_id: M.a, amount: 10000, currency: "KRW",
  category: "식비", note: note, participant_ids: ALL, settled: false,
  spent_at: isoLocal, created_at: "2026-07-20T0" + (n % 9) + ":00:00Z",
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
      mk("2026-07-21T19:00:00", "숙소 선결제"),
      mk("2026-07-24T15:00:00", "d4-a"),
      mk("2026-07-24T19:30:00", "d4-b"),
      mk("2026-07-25T12:20:00", "d5-a"),
      mk("2026-07-26T15:40:00", "d6-a"),
      mk("2026-07-27T18:10:00", "d7-a"),
      mk("2026-07-27T20:00:00", "d7-b"),
      mk("2026-07-28T22:30:00", "d8-a"),
    ],
  };
}

function makeClient(TABLES, log) {
  function query(table) {
    let filters = [], orderBy = null, single = false, mode = null, patch = null;
    function match(r) { return filters.every((f) => String(r[f[0]]) === String(f[1])); }
    function run() {
      const rows = TABLES[table].filter(match);
      if (mode === "update") {
        log.push({ table: table, patch: patch, rows: rows.length });
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

function boot(TABLES, log) {
  const dom = new JSDOM(html, { url: "https://x.test/?r=" + ROOM, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.TRIP_SPLIT_CONFIG = { SUPABASE_URL: "https://fake", SUPABASE_ANON_KEY: "fake" };
  w.supabase = { createClient: () => makeClient(TABLES, log) };
  w.fetch = () => Promise.reject(new Error("offline"));
  w.localStorage.setItem("tripsplit_me_" + ROOM, M.a);
  w.eval(appSrc);
  return w;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 지출을 지문처럼 찍어둔다 — 시작일을 바꾼 뒤 한 글자라도 달라지면 잡힌다
const fingerprint = (T) => T.expenses.slice()
  .sort((a, b) => (a.id > b.id ? 1 : -1))
  .map((e) => [e.id, e.spent_at, e.day_index, e.slot, e.seq, e.amount].join("|"));
// 화면이 세는 일차 라벨
const dayHeads = (w) => [...w.document.querySelectorAll("#timeline .tl-day-date")]
  .map((el) => el.textContent.trim());

async function setStart(w, v) {
  w.document.getElementById("date-input").value = v;
  w.document.getElementById("date-save").click();
  await wait(300);
}

(async () => {
  const T = fixture();
  const log = [];
  const w = boot(T, log);
  await wait(250);
  w.document.getElementById("go-history").click();
  await wait(50);

  console.log("[출발점] 시작일 07-21");
  ok("지출 8건", T.expenses.length, 8);
  ok("일차 라벨", dayHeads(w), ["1일차", "4일차", "5일차", "6일차", "7일차", "8일차"]);
  const before = fingerprint(T);

  console.log("\n[3일 늦춤] 07-21 -> 07-24");
  await setStart(w, "2026-07-24");
  ok("방에는 새 시작일이 저장됨", T.rooms[0].start_date, "2026-07-24");
  ok("지출은 한 건도 안 바뀜", fingerprint(T), before);
  ok("expenses 에 쓰기가 아예 없었음", log.filter((l) => l.table === "expenses").length, 0);
  w.document.getElementById("go-history").click();
  await wait(50);
  ok("라벨만 다시 세어짐 (07-21건은 여행 전으로)",
    dayHeads(w), ["여행 전", "1일차", "2일차", "3일차", "4일차", "5일차"]);

  console.log("\n[6일 늦춤] 07-24 -> 07-27 — 예전이라면 네 날이 한꺼번에 준비로 접혀 seq가 충돌하던 자리");
  await setStart(w, "2026-07-27");
  ok("지출은 여전히 그대로", fingerprint(T), before);
  ok("expenses 쓰기 없음", log.filter((l) => l.table === "expenses").length, 0);
  w.document.getElementById("go-history").click();
  await wait(50);
  ok("네 날이 여행 전으로, 나머지는 1·2일차",
    dayHeads(w), ["여행 전", "여행 전", "여행 전", "여행 전", "1일차", "2일차"]);

  console.log("\n[되돌리기] 07-27 -> 07-21");
  await setStart(w, "2026-07-21");
  ok("되돌려도 지출은 그대로", fingerprint(T), before);
  w.document.getElementById("go-history").click();
  await wait(50);
  ok("라벨이 처음으로 복귀", dayHeads(w), ["1일차", "4일차", "5일차", "6일차", "7일차", "8일차"]);

  console.log("\n[같은 날짜] 아무것도 안 함");
  const n0 = log.length;
  await setStart(w, "2026-07-21");
  ok("쓰기 자체가 없음", log.length, n0);

  console.log("\n" + (failures ? failures + "건 실패" : "전부 통과"));
  process.exit(failures ? 1 : 0);
})();
