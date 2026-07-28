// Drives the real drag handlers and checks what lands in the database.
// jsdom reports every rect as 0, so the pointer hit-test can't be exercised —
// rAF is stubbed out and the placeholder is placed by hand, which is exactly
// what placeRow() would have done. Everything after that is the real code.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const APP = path.join(__dirname, "..");
const ROOM = "kyoto";
const M = { a: "m-a", b: "m-b" };
const ALL = [M.a, M.b];

let seq = 0;
const mk = (note, day, slot, s) => ({
  id: note, room_id: ROOM, payer_id: M.a, amount: 10000, currency: "KRW",
  category: "식비", note: note, participant_ids: ALL, settled: false,
  day_index: day, slot: slot, seq: s,
  created_at: "2026-07-24T0" + (seq++ % 9) + ":00:00Z",
});

function fixture() {
  seq = 0;
  return {
    rooms: [{ id: ROOM, name: "교토", default_currency: "KRW", start_date: "2026-07-24",
              base_rate_jpy: 9.1, base_rate_date: "2026-07-24", created_at: "2026-07-20T00:00:00Z" }],
    members: [
      { id: M.a, room_id: ROOM, name: "민수", created_at: "2026-07-20T00:00:01Z" },
      { id: M.b, room_id: ROOM, name: "지현", created_at: "2026-07-20T00:00:02Z" },
    ],
    expenses: [
      mk("P", 0, null, 0),
      mk("A", 1, "점심", 0), mk("B", 1, "점심", 1), mk("C", 1, "점심", 2),
      mk("D", 1, "저녁", 0),
      mk("E", 2, "밤", 0),
    ],
  };
}

function makeClient(TABLES, log) {
  function query(table) {
    let filters = [], orderBy = null, single = false, mode = null, patch = null;
    function run() {
      const rows = TABLES[table].filter((r) => filters.every((f) => String(r[f[0]]) === String(f[1])));
      if (mode === "update") {
        log.push({ table: table, where: filters.map((f) => f.join("=")).join("&"), patch: patch });
        rows.forEach((r) => Object.assign(r, patch));
        return { data: rows, error: null };
      }
      let out = rows;
      if (orderBy) {
        const c = orderBy[0], asc = orderBy[1];
        out = rows.slice().sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function session() {
  const T = fixture(), log = [];
  const dom = new JSDOM(html, { url: "https://x.test/?r=" + ROOM, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.TRIP_SPLIT_CONFIG = { SUPABASE_URL: "https://fake", SUPABASE_ANON_KEY: "fake" };
  w.supabase = { createClient: () => makeClient(T, log) };
  w.fetch = () => Promise.reject(new Error("offline"));
  w.localStorage.setItem("tripsplit_me_" + ROOM, M.a);
  // pin "today" to 07-25 = day 2, so the day range the picker opens up is fixed
  const RealDate = w.Date;
  class PinnedDate extends RealDate {
    constructor(...a) { super(...(a.length ? a : [2026, 6, 25, 12, 0, 0])); }
    static now() { return new RealDate(2026, 6, 25, 12, 0, 0).getTime(); }
  }
  w.Date = PinnedDate;
  w.eval(appSrc);
  await wait(200);
  w.document.getElementById("go-history").click();
  // freeze the per-frame loop so the hand-placed drop position survives
  w.requestAnimationFrame = () => 0;
  w.cancelAnimationFrame = () => {};
  return { T: T, log: log, w: w, doc: w.document };
}

// jsdom has no PointerEvent, so stamp pointerType onto a MouseEvent
function ptr(w, type, opts, pointerType) {
  const e = new w.MouseEvent(type, Object.assign({ bubbles: true }, opts));
  Object.defineProperty(e, "pointerType", { value: pointerType || "mouse" });
  Object.defineProperty(e, "pointerId", { value: 1 });
  return e;
}

// grab id, drop it into (day, slot) at position index
async function dragTo(ctx, id, day, slot, index) {
  const { doc, w } = ctx;
  const grip = doc.querySelector('.tl-row[data-id="' + id + '"] .tl-grip');
  if (!grip) throw new Error("grip 없음: " + id);
  grip.dispatchEvent(ptr(w, "pointerdown", { clientY: 100 }));
  const row = doc.querySelector(".tl-row.placeholder");
  if (!row) throw new Error("placeholder 없음");
  const zone = doc.querySelector('.tl-rows[data-day="' + day + '"][data-slot="' + (slot || "") + '"]');
  if (!zone) throw new Error("drop zone 없음: " + day + "/" + slot);
  const others = [].slice.call(zone.children).filter((n) => n !== row);
  if (index >= others.length) zone.appendChild(row);
  else zone.insertBefore(row, others[index]);
  // Release on the grip that is actually in the document now. Starting a drag
  // rebuilds the list, so the pressed grip is detached — dispatching on that
  // stale node would pass here while doing nothing in a real browser.
  const live = row.querySelector(".tl-grip");
  if (live === grip) throw new Error("손잡이가 갱신되지 않음 — 떨어져 나간 요소에 붙어 있음");
  live.dispatchEvent(ptr(w, "pointerup", { clientY: 100 }));
  await wait(150);
}

const layout = (T) => {
  const by = {};
  T.expenses.slice()
    .sort((a, b) => a.day_index - b.day_index || String(a.slot).localeCompare(String(b.slot)) || a.seq - b.seq)
    .forEach((e) => {
      const k = e.day_index + "/" + (e.slot || "-");
      (by[k] = by[k] || []).push(e.note + "#" + e.seq);
    });
  return by;
};

(async () => {
  // The bug that shipped: a thumb scrolling the list rests on the grip, the
  // drag fired on touchdown, and the page froze mid-scroll.
  console.log("[스크롤 오작동] 손가락이 손잡이 위를 지나가도 드래그가 걸리면 안 된다");
  let ctx = await session();
  let g = ctx.doc.querySelector('.tl-row[data-id="A"] .tl-grip');
  g.dispatchEvent(ptr(ctx.w, "pointerdown", { clientY: 300 }, "touch"));
  ok("누른 직후엔 아직 드래그 아님", !!ctx.doc.querySelector(".tl-row.placeholder"), false);
  g.dispatchEvent(ptr(ctx.w, "pointermove", { clientY: 260 }, "touch"));  // 40px 스크롤
  await wait(420);                                                        // 홀드 시간 지나도
  ok("스크롤로 판정되어 드래그가 안 시작됨", !!ctx.doc.querySelector(".tl-row.placeholder"), false);
  ok("화면이 잠기지 않음", ctx.doc.body.classList.contains("dragging"), false);
  ok("떠있는 복제본 없음", ctx.doc.querySelectorAll(".tl-float").length, 0);

  // Second failure: with the grip left pan-y, iOS started a pan the moment the
  // finger moved. Once Safari owns the gesture, preventDefault does nothing —
  // the pointer got cancelled and the drag died. The grip is touch-action:none
  // now, so the browser never scrolls from it and the script scrolls instead.
  console.log("\n[손잡이 위 스와이프] 브라우저 대신 직접 스크롤한다");
  ctx = await session();
  const scrolls = [];
  ctx.w.scrollBy = (x, y) => scrolls.push(y);
  g = ctx.doc.querySelector('.tl-row[data-id="A"] .tl-grip');
  g.dispatchEvent(ptr(ctx.w, "pointerdown", { clientY: 300 }, "touch"));
  g.dispatchEvent(ptr(ctx.w, "pointermove", { clientY: 260 }, "touch"));  // 40px 위로 쓸기
  g.dispatchEvent(ptr(ctx.w, "pointermove", { clientY: 235 }, "touch"));  // 25px 더
  ok("손가락을 따라 페이지가 스크롤됨", scrolls, [40, 25]);
  await wait(420);
  ok("스와이프였으므로 드래그는 안 걸림", !!ctx.doc.querySelector(".tl-row.placeholder"), false);
  ok("화면도 안 잠김", ctx.doc.body.classList.contains("dragging"), false);
  g.dispatchEvent(ptr(ctx.w, "pointerup", { clientY: 235 }, "touch"));
  await wait(100);
  ok("손 뗀 뒤 더 스크롤되지 않음", scrolls.length, 2);

  console.log("\n[손잡이 밖] 손가락이 손잡이를 벗어나도 추적한다");
  ctx = await session();
  g = ctx.doc.querySelector('.tl-row[data-id="A"] .tl-grip');
  g.dispatchEvent(ptr(ctx.w, "pointerdown", { clientY: 300 }, "touch"));
  await wait(420);
  ok("드래그 시작", !!ctx.doc.querySelector(".tl-row.placeholder"), true);
  // 손잡이가 아니라 body에서 발생한 pointerup으로도 끝나야 한다
  ctx.doc.body.dispatchEvent(ptr(ctx.w, "pointerup", { clientY: 300 }, "touch"));
  await wait(250);
  ok("손잡이 밖에서 놓아도 드래그가 끝남", ctx.doc.body.classList.contains("dragging"), false);

  // Third failure, and the one that actually shipped broken: the grip had
  // pointer capture, the grip lives inside the row, and placeRow re-parents
  // that row on every move. Moving a capturing element releases the capture
  // and fires pointercancel — so the drag ended on the first finger movement
  // and dropped the expense wherever it happened to be.
  console.log("\n[중단] pointercancel은 '거기 놓기'가 아니라 '원래대로'다");
  ctx = await session();
  g = ctx.doc.querySelector('.tl-row[data-id="A"] .tl-grip');
  g.dispatchEvent(ptr(ctx.w, "pointerdown", { clientY: 300 }, "touch"));
  await wait(420);
  const held = ctx.doc.querySelector(".tl-row.placeholder");
  // 사용자가 손가락을 움직여 다른 묶음 위로 갔다고 치자
  ctx.doc.querySelector('.tl-rows[data-day="2"][data-slot="밤"]').appendChild(held);
  ctx.doc.dispatchEvent(ptr(ctx.w, "pointercancel", { clientY: 300 }, "touch"));
  await wait(250);
  ok("중단 시 아무것도 저장하지 않음", ctx.log.length, 0);
  ok("데이터가 그대로", layout(ctx.T)["1/점심"], ["A#0", "B#1", "C#2"]);
  ok("화면 잠금도 풀림", ctx.doc.body.classList.contains("dragging"), false);

  console.log("\n[홀드] 가만히 누르고 있으면 드래그가 걸린다");
  ctx = await session();
  g = ctx.doc.querySelector('.tl-row[data-id="A"] .tl-grip');
  g.dispatchEvent(ptr(ctx.w, "pointerdown", { clientY: 300 }, "touch"));
  g.dispatchEvent(ptr(ctx.w, "pointermove", { clientY: 303 }, "touch"));  // 손떨림 3px
  await wait(420);
  ok("홀드 후 드래그 시작됨", !!ctx.doc.querySelector(".tl-row.placeholder"), true);
  ok("이때만 화면이 잠김", ctx.doc.body.classList.contains("dragging"), true);
  ctx.doc.querySelector(".tl-row.placeholder .tl-grip")
     .dispatchEvent(ptr(ctx.w, "pointerup", { clientY: 300 }, "touch"));
  await wait(200);
  ok("놓으면 잠금 해제", ctx.doc.body.classList.contains("dragging"), false);

  console.log("\n[드롭 대상] 드래그를 시작하면 빈 시간대·빈 일차가 열린다");
  ctx = await session();
  const before = ctx.doc.querySelectorAll("#timeline .tl-rows").length;
  const grip = ctx.doc.querySelector('.tl-row[data-id="A"] .tl-grip');
  grip.dispatchEvent(ptr(ctx.w, "pointerdown", { clientY: 100 }));  // 마우스는 즉시
  const after = ctx.doc.querySelectorAll("#timeline .tl-rows").length;
  ok("평소엔 지출 있는 묶음만", before, 4);           // prep, 1일차 점심/저녁, 2일차 밤
  // 오늘(07-25)이 2일차 -> 준비 1 + 1·2일차 각 5시간대
  ok("드래그 중엔 준비 + 오늘까지의 모든 일차 × 5시간대", after, 11);
  ok("2일차 아침도 드롭 가능해짐",
    !!ctx.doc.querySelector('.tl-rows[data-day="2"][data-slot="아침"]'), true);
  grip.dispatchEvent(ptr(ctx.w, "pointerup", { clientY: 100 }));
  await wait(100);

  console.log("\n[다른 일차·시간대로] B를 1일차 점심 -> 2일차 밤 맨 앞으로");
  ctx = await session();
  await dragTo(ctx, "B", 2, "밤", 0);
  ok("B가 옮겨가고 양쪽 묶음 번호가 다시 매겨짐", layout(ctx.T), {
    "0/-": ["P#0"],
    "1/저녁": ["D#0"],
    "1/점심": ["A#0", "C#1"],
    "2/밤": ["B#0", "E#1"],
  });
  ok("B에 일차·시간대·순서가 함께 기록됨",
    ctx.log.filter((l) => l.where.indexOf("id=B") >= 0).map((l) => l.patch),
    [{ day_index: 2, slot: "밤", seq: 0 }]);
  ok("안 움직인 A는 건드리지 않음", ctx.log.filter((l) => l.where.indexOf("id=A") >= 0).length, 0);

  console.log("\n[같은 묶음 안 순서] A를 점심 맨 뒤로");
  ctx = await session();
  await dragTo(ctx, "A", 1, "점심", 2);
  ok("순서만 바뀜", layout(ctx.T)["1/점심"], ["B#0", "C#1", "A#2"]);
  ok("일차·시간대는 안 씀 (seq만)",
    ctx.log.map((l) => Object.keys(l.patch).join("+")).join(","), "seq,seq,seq");

  console.log("\n[준비 구간으로] D를 1일차 저녁 -> 여행 전 준비");
  ctx = await session();
  await dragTo(ctx, "D", 0, null, 1);
  ok("준비로 가면서 시간대가 지워짐", layout(ctx.T)["0/-"], ["P#0", "D#1"]);
  ok("D의 slot이 null", ctx.T.expenses.find((e) => e.id === "D").slot, null);
  ok("비워진 1일차 저녁엔 아무것도 안 남음", layout(ctx.T)["1/저녁"], undefined);

  console.log("\n[출발 지점 정리] C를 빼면 점심 묶음이 빈틈을 메운다");
  ctx = await session();
  await dragTo(ctx, "A", 2, "아침", 0);   // A(seq0)를 빼내면 B,C가 1,2 -> 0,1 이 돼야
  ok("남은 B·C가 0,1로 당겨짐", layout(ctx.T)["1/점심"], ["B#0", "C#1"]);

  console.log("\n[제자리] 원래 있던 곳에 그대로 놓기");
  ctx = await session();
  await dragTo(ctx, "B", 1, "점심", 1);
  ok("아무것도 저장하지 않음", ctx.log.length, 0);

  console.log("\n" + (failures ? failures + "건 실패" : "전부 통과"));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
