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
  participant_ids: ALL, created_at: "2026-08-01T0" + (n % 9) + ":00:00Z",
}, o);
// spent_at is the only thing that decides where a row lands and in what order.
// Local time, no Z — the app reads these back as local instants.
const expenses = [
  // before the trip — one calendar day of its own
  exp({ payer_id: M.a, amount: 640000, category: "기타", note: "항공권", spent_at: "2026-07-20T14:00:00" }),
  exp({ payer_id: M.b, amount: 40000,  category: "기타", note: "유심",   spent_at: "2026-07-20T16:30:00" }),
  // 8/1 — deliberately out of order to prove sorting works
  exp({ payer_id: M.a, amount: 38000, category: "술",   note: "이자카야", spent_at: "2026-08-01T22:00:00" }),
  exp({ payer_id: M.b, amount: 12000, category: "식비", note: "라멘",     spent_at: "2026-08-01T12:30:00" }),
  exp({ payer_id: M.a, amount: 4500,  category: "식비", note: "삼각김밥", spent_at: "2026-08-01T08:10:00" }),
  exp({ payer_id: M.c, amount: 9000,  category: "카페", note: "커피",     spent_at: "2026-08-01T12:05:00" }),
  // 8/3 — 8/2 is skipped on purpose (a day with no spending)
  exp({ payer_id: M.c, amount: 1200, currency: "JPY", rate_krw: 9.1, rate_date: "2026-08-03",
        rate_source: "api", category: "식비", note: "우동", spent_at: "2026-08-03T12:40:00" }),
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

  console.log("\n[입력 화면] 시각 기본값");
  // 칩 세 줄(며칠차·시간대·몇 시쯤) 대신 시각 하나. 기본값은 지금.
  check("현재 시각(8/3 19:30)이 그대로 채워짐", txt($("when-text")), "19:30 8월 3일 (월) 3일차");
  check("datetime 입력칸도 같은 값", $("when-input").value, "2026-08-03T19:30");
  check("옛 칩들은 사라짐",
    [$("day-chips"), $("slot-chips"), $("hour-chips")].map((el) => el === null), [true, true, true]);

  // 빠른 보정 - "20분 전이었는데" 가 대부분이라 달력을 여는 것보다 빠르다
  $("when-m30").click();
  check("-30분", txt($("when-text")), "19:00 8월 3일 (월) 3일차");
  $("when-m60").click();
  check("-1시간", txt($("when-text")), "18:00 8월 3일 (월) 3일차");
  $("when-m1d").click();
  check("-1일은 날짜와 일차가 같이 움직임", txt($("when-text")), "18:00 8월 2일 (일) 2일차");
  $("when-now").click();
  check("지금으로 되돌리기", txt($("when-text")), "19:30 8월 3일 (월) 3일차");

  // 직접 친 값이 그대로 반영된다
  $("when-input").value = "2026-08-01T09:05";
  $("when-input").dispatchEvent(new w.Event("input", { bubbles: true }));
  check("직접 입력", txt($("when-text")), "09:05 8월 1일 (토) 1일차");
  $("when-now").click();

  console.log("\n[화면 순서] 입력 -> 기록 -> 정산");
  // 기록이 앞이고 잔액(정산)은 그 뒤다. 매일 보는 건 기록이라서.
  $("go-history").click();
  check("입력에서 기록으로", doc.querySelector(".screen.active").id, "screen-history");
  $("go-status").click();
  check("기록에서 정산으로", doc.querySelector(".screen.active").id, "screen-status");
  check("시작일 표시", txt($("startdate-text")), "여행 시작 8월 1일 (토)");
  check("잔액 행이 탭 가능", doc.querySelectorAll(".bal-row.tappable").length, 3);
  $("status-back").click();
  check("정산에서 나가면 기록으로", doc.querySelector(".screen.active").id, "screen-history");

  console.log("\n[타임라인] 날짜별 묶음과 시계 순서");
  const days = [...doc.querySelectorAll("#timeline .tl-day")];
  check("날짜 묶음 3개 (7/20, 8/1, 8/3 - 지출 없는 8/2는 안 나옴)", days.length, 3);
  check("날짜 헤더", days.map((d) => txt(d.querySelector(".tl-day-num")) + " " + txt(d.querySelector(".tl-day-date"))),
    ["7월 20일 (월) 여행 전", "8월 1일 (토) 1일차", "8월 3일 (월) 3일차"]);
  check("날짜별 합계", days.map((d) => txt(d.querySelector(".tl-day-total"))),
    ["₩680,000", "₩63,500", "₩10,920"]);
  check("시간대 스파인은 사라짐", doc.querySelectorAll(".tl-slot").length, 0);
  check("기본은 요약 보기", [...$("tl-view").children].filter((b) => b.className === "on").map(txt), ["요약"]);
  check("8/1은 시계 순서 (08:10 -> 12:05 -> 12:30 -> 22:00)",
    [...days[1].querySelectorAll(".tlb-n")].map(txt), ["삼각김밥", "커피", "라멘", "이자카야"]);
  check("요약은 한 줄에 시각이 앞선다",
    [...days[1].querySelectorAll(".tlb-t")].map(txt), ["08:10", "12:05", "12:30", "22:00"]);
  check("요약에는 영수증 썸네일이 없다", doc.querySelectorAll("#timeline .exp-emoji").length, 0);
  check("막대는 가장 많이 쓴 날이 100%",
    days.map((d) => d.querySelector(".tl-bar i").style.width), ["100%", "9%", "2%"]);

  console.log("\n[타임라인] 상세 보기로 전환");
  [...$("tl-view").children].find((b) => txt(b) === "상세").click();
  const days2 = [...doc.querySelectorAll("#timeline .tl-day")];
  check("상세로 바뀜", [...$("tl-view").children].filter((b) => b.className === "on").map(txt), ["상세"]);
  check("순서는 그대로",
    [...days2[1].querySelectorAll(".exp-title")].map(txt), ["삼각김밥", "커피", "라멘", "이자카야"]);
  check("상세는 시각과 낸 사람을 같이",
    txt(days2[1].querySelector(".exp-sub")).slice(0, 10), "08:10 · 민수");
  check("엔화 행은 원화 환산도 같이", txt(days2[2].querySelector(".exp-krw")), "≈₩10,920");
  check("고른 보기는 기억된다", w.localStorage.getItem("tripsplit_tlview"), "full");

  console.log("\n[타임라인] 정렬");
  [...$("tl-view").children].find((b) => txt(b) === "요약").click();
  check("기본은 오래된순", [...$("tl-sort").children].filter((b) => b.className === "on").map(txt), ["오래된순"]);
  const dayNames = () => [...doc.querySelectorAll("#timeline .tl-day-num")].map(txt);
  const firstRows = () => [...doc.querySelectorAll("#timeline .tl-day")][0].querySelectorAll(".tlb-t");
  check("오래된순 날짜", dayNames(), ["7월 20일 (월)", "8월 1일 (토)", "8월 3일 (월)"]);

  [...$("tl-sort").children].find((b) => txt(b) === "최신순").click();
  check("최신순으로 바뀜", [...$("tl-sort").children].filter((b) => b.className === "on").map(txt), ["최신순"]);
  check("날짜가 뒤집힘", dayNames(), ["8월 3일 (월)", "8월 1일 (토)", "7월 20일 (월)"]);
  // 날짜만 뒤집고 그 안을 그대로 두면 "최신이 위"가 하루 안에서 깨진다
  check("하루 안쪽도 뒤집힘",
    [...[...doc.querySelectorAll("#timeline .tl-day")][1].querySelectorAll(".tlb-t")].map(txt),
    ["22:00", "12:30", "12:05", "08:10"]);
  check("정렬도 기억된다", w.localStorage.getItem("tripsplit_tlsort"), "desc");
  [...$("tl-sort").children].find((b) => txt(b) === "오래된순").click();
  check("되돌리면 원래대로", dayNames(), ["7월 20일 (월)", "8월 1일 (토)", "8월 3일 (월)"]);

  console.log("\n[타임라인] 멤버 필터");
  const chips = [...$("tl-filters").children];
  check("필터 칩 = 전체 + 멤버 3명", chips.map((c) => c.textContent), ["전체", "민수", "지현", "영훈"]);
  chips[1].click(); // 민수
  check("낸 것 합계 (640,000 + 38,000 + 4,500)", txt(doc.querySelector(".tl-sum")), "민수 · 3건 합계 ₩682,500");
  doc.querySelector('.tl-modes button[data-mode="share"]').click();
  // 민수 shares: 640000/3=213333, 38000/3=12667, 4500/3=1500, 12000/3=4000,
  //              9000/3=3000, 40000/3=13333, 10920/3=3640  → 251,473
  check("나눈 것 합계 = 6건 전부의 1/3", txt(doc.querySelector(".tl-sum")), "민수 · 7건 합계 ₩251,473");
  // 인원수는 상세 줄에만 붙는다 — 요약은 시각·내용·금액 셋뿐이라
  [...$("tl-view").children].find((b) => txt(b) === "상세").click();
  check("나눈 것 모드는 인원수를 표시", txt(doc.querySelector(".tl-share")), "3인 나눔");
  [...$("tl-view").children].find((b) => txt(b) === "요약").click(); // 뒷 검증은 합계만 쓴다

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
