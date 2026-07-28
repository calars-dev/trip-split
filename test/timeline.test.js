// Renders trip-split against a fake Supabase and checks the timeline DOM.
// No network, no real database.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const APP = path.join(__dirname, "..");
const ROOM = "test123";

// ── fixture ────────────────────────────────────────────────────────
const M = { a: "m-a", b: "m-b", c: "m-c" };
const room = { id: ROOM, name: "오사카", default_currency: "KRW", start_date: "2026-08-01",
               base_rate_jpy: 9.1, base_rate_date: "2026-08-01", created_at: "2026-07-20T00:00:00Z" };
const members = [
  { id: M.a, room_id: ROOM, name: "민수", created_at: "2026-07-20T00:00:01Z" },
  { id: M.b, room_id: ROOM, name: "지현", created_at: "2026-07-20T00:00:02Z" },
  { id: M.c, room_id: ROOM, name: "영훈", created_at: "2026-07-20T00:00:03Z" },
];
const ALL = [M.a, M.b, M.c];
let n = 0;
const exp = (o) => Object.assign({
  id: "e" + (++n), room_id: ROOM, currency: "KRW", settled: false,
  rate_krw: null, rate_date: null, rate_source: null,
  participant_ids: ALL, created_at: "2026-08-0" + (o.day_index || 1) + "T0" + (n % 9) + ":00:00Z",
}, o);
const expenses = [
  exp({ payer_id: M.a, amount: 640000, category: "기타", note: "항공권", day_index: 0, slot: null, seq: 0 }),
  exp({ payer_id: M.b, amount: 40000,  category: "기타", note: "유심",   day_index: 0, slot: null, seq: 1 }),
  // day 1 — deliberately out of order to prove sorting works
  exp({ payer_id: M.a, amount: 38000, category: "술",   note: "이자카야", day_index: 1, slot: "밤",   seq: 0 }),
  exp({ payer_id: M.b, amount: 12000, category: "식비", note: "라멘",     day_index: 1, slot: "점심", seq: 1 }),
  exp({ payer_id: M.a, amount: 4500,  category: "식비", note: "삼각김밥", day_index: 1, slot: "아침", seq: 0 }),
  exp({ payer_id: M.c, amount: 9000,  category: "카페", note: "커피",     day_index: 1, slot: "점심", seq: 0 }),
  // day 3 — day 2 is skipped on purpose (a day with no spending)
  exp({ payer_id: M.c, amount: 1200, currency: "JPY", rate_krw: 9.1, rate_date: "2026-08-03",
        rate_source: "api", category: "식비", note: "우동", day_index: 3, slot: "점심", seq: 0 }),
];

// ── fake supabase ──────────────────────────────────────────────────
const TABLES = { rooms: [room], members, expenses };
function query(table) {
  const st = { table, filters: [], orderBy: null, single: false };
  const run = () => {
    let rows = TABLES[st.table].filter((r) =>
      st.filters.every(([col, val]) => String(r[col]) === String(val)));
    if (st.orderBy) {
      const [col, asc] = st.orderBy;
      rows = rows.slice().sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
    }
    return { data: st.single ? (rows[0] || null) : rows, error: null };
  };
  const api = {
    select() { return api; },
    eq(col, val) { st.filters.push([col, val]); return api; },
    order(col, o) { st.orderBy = [col, !o || o.ascending !== false]; return api; },
    maybeSingle() { st.single = true; return Promise.resolve(run()); },
    single() { st.single = true; return Promise.resolve(run()); },
    insert() { return api; },
    update() { return api; },
    delete() { return api; },
    then(res, rej) { return Promise.resolve(run()).then(res, rej); },
  };
  return api;
}
const fakeSb = {
  from: (t) => query(t),
  channel: () => ({ on() { return this; }, subscribe() { return this; } }),
};

// ── boot ───────────────────────────────────────────────────────────
const html = fs.readFileSync(path.join(APP, "index.html"), "utf8")
  .replace(/<script src="config\.js"><\/script>/, "")
  .replace(/<script src="vendor\/supabase\.js"><\/script>/, "")
  .replace(/<script src="app\.js"><\/script>/, "");

const dom = new JSDOM(html, { url: "https://x.test/?r=" + ROOM, runScripts: "outside-only", pretendToBeVisual: true });
const w = dom.window;
w.TRIP_SPLIT_CONFIG = { SUPABASE_URL: "https://fake", SUPABASE_ANON_KEY: "fake" };
w.supabase = { createClient: () => fakeSb };
w.fetch = () => Promise.reject(new Error("offline in test")); // FX must degrade, not crash
w.localStorage.setItem("tripsplit_me_" + ROOM, M.a);
// pin "today" to day 3 of the trip so the default day/slot is predictable
const RealDate = w.Date;
class PinnedDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [2026, 7, 3, 19, 30, 0])); }
  static now() { return new RealDate(2026, 7, 3, 19, 30, 0).getTime(); }
}
w.Date = PinnedDate;

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log((ok ? "  PASS  " : "  FAIL  ") + name);
  if (!ok) console.log("          기대: " + JSON.stringify(want) + "\n          실제: " + JSON.stringify(got));
};
const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
const $ = (id) => w.document.getElementById(id);

w.eval(fs.readFileSync(path.join(APP, "app.js"), "utf8"));

setTimeout(() => {
  const doc = w.document;

  console.log("\n[입력 화면] 일차·시간대 기본값");
  check("현재 시각(8/3 19:30) 기준으로 채워짐", txt($("when-text")), "3일차 · 🌆저녁 8/3 (월)");
  check("일차 칩은 준비 + 1~4일차 (오늘 3일차 +1)",
    [...$("day-chips").children].map((b) => b.textContent),
    ["🎒 준비", "1일차", "2일차", "3일차", "4일차"]);
  check("시간대 칩 5개", [...$("slot-chips").children].map((b) => b.textContent),
    ["🌅 아침", "🍜 점심", "☀️ 오후", "🌆 저녁", "🌙 밤"]);

  console.log("\n[현황 화면] 시작일");
  check("시작일 표시", txt($("startdate-text")), "여행 시작 8월 1일 (토)");
  check("잔액 행이 탭 가능", doc.querySelectorAll(".bal-row.tappable").length, 3);

  // open the timeline
  $("go-history").click();

  console.log("\n[타임라인] 묶음과 순서");
  const days = [...doc.querySelectorAll("#timeline .tl-day")];
  check("일차 묶음 3개 (준비/1일차/3일차 — 지출 없는 2일차는 안 나옴)", days.length, 3);
  check("일차 헤더", days.map((d) => txt(d.querySelector(".tl-day-num")) + " " + txt(d.querySelector(".tl-day-date"))),
    ["🎒 여행 전 준비 ", "1일차 8/1 (토)", "3일차 8/3 (월)"]);
  check("일차별 합계", days.map((d) => txt(d.querySelector(".tl-day-total"))),
    ["₩680,000", "₩63,500", "₩10,920"]);
  check("준비 묶음엔 시간대 스파인이 없음", days[0].querySelectorAll(".tl-slot").length, 0);
  check("1일차 시간대 순서 (아침→점심→밤)",
    [...days[1].querySelectorAll(".tl-slot-name")].map(txt), ["아침", "점심", "밤"]);
  check("같은 점심 안에서는 seq 순서 (커피 seq0 → 라멘 seq1)",
    [...days[1].querySelectorAll(".tl-slot")[1].querySelectorAll(".exp-title")].map(txt), ["커피", "라멘"]);
  check("막대는 가장 많이 쓴 날이 100%",
    days.map((d) => d.querySelector(".tl-bar i").style.width), ["100%", "9%", "2%"]);
  check("엔화 행은 원화 환산도 같이", txt(days[2].querySelector(".exp-krw")), "≈₩10,920");

  console.log("\n[타임라인] 멤버 필터");
  const chips = [...$("tl-filters").children];
  check("필터 칩 = 전체 + 멤버 3명", chips.map((c) => c.textContent), ["전체", "민수", "지현", "영훈"]);
  chips[1].click(); // 민수
  check("낸 것 합계 (640,000 + 38,000 + 4,500)", txt(doc.querySelector(".tl-sum")), "민수 · 3건 합계 ₩682,500");
  doc.querySelector('.tl-modes button[data-mode="share"]').click();
  // 민수 shares: 640000/3=213333, 38000/3=12667, 4500/3=1500, 12000/3=4000,
  //              9000/3=3000, 40000/3=13333, 10920/3=3640  → 251,473
  check("나눈 것 합계 = 6건 전부의 1/3", txt(doc.querySelector(".tl-sum")), "민수 · 7건 합계 ₩251,473");
  check("나눈 것 모드는 인원수를 표시", txt(doc.querySelector(".tl-share")), "3인 나눔");

  console.log("\n[정산과의 일치]");
  // every member's "나눈 것" total must equal what the settlement charges them
  const shareTotals = {};
  members.forEach((m) => {
    const i = chips.findIndex((c) => c.textContent === m.name);
    chips[i].click();
    doc.querySelector('.tl-modes button[data-mode="share"]').click();
    shareTotals[m.name] = Number(txt(doc.querySelector(".tl-sum")).match(/₩([\d,]+)/)[1].replace(/,/g, ""));
  });
  const grand = expenses.reduce((s, e) => s + Math.round(e.amount * (e.currency === "JPY" ? 9.1 : 1)), 0);
  check("세 사람 부담액의 합 = 전체 지출액 (원 단위까지)",
    Object.values(shareTotals).reduce((a, b) => a + b, 0), grand);

  console.log("\n" + (failures ? failures + "건 실패" : "전부 통과"));
  process.exit(failures ? 1 : 0);
}, 300);
