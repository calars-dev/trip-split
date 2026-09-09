// 공금과 멤버 명단은 총무 한 사람 몫이다.
//
// 열네 명이 각자 공금을 결제자로 고르면 장부가 아니라 낙서가 된다. 화면에서 아예
// 안 보이게 하는 쪽을 골랐다 — 눌렀다가 거절당하는 것보다, 애초에 없는 편이
// 설명이 필요 없다.
//
// ⚠️ 이건 실수를 막는 것이지 서버가 막는 것이 아니다. 같은 방 멤버는 여전히 API 로
//    무엇이든 쓸 수 있고, 이 앱은 처음부터 "링크를 아는 사람은 다 고칠 수 있다"는
//    모델이다. 그 선을 옮기는 테스트가 아니라, 화면이 약속한 것을 지키는 테스트다.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const APP = path.join(__dirname, "..");
const ROOM = "r1";
const M = { boss: "m-boss", other: "m-other", pot: "m-pot" };

function fixture() {
  return {
    rooms: [{ id: ROOM, name: "이시가키", default_currency: "JPY", start_date: "2026-09-13",
              day_count: 5, manager_id: M.boss, created_at: "2026-08-01T00:00:00Z" }],
    members: [
      { id: M.boss,  room_id: ROOM, name: "이수형", is_ledger: false, created_at: "2026-08-01T00:00:01Z" },
      { id: M.other, room_id: ROOM, name: "정원호", is_ledger: false, created_at: "2026-08-01T00:00:02Z" },
      { id: M.pot,   room_id: ROOM, name: "공금",   is_ledger: true,  created_at: "2026-08-01T00:00:03Z" },
    ],
    expenses: [],
  };
}

function makeClient(T) {
  function query(table) {
    let filters = [], single = false;
    const run = () => {
      const rows = (T[table] || []).filter((r) =>
        filters.every((f) => String(r[f[0]]) === String(f[1])));
      return { data: single ? (rows[0] || null) : rows, error: null };
    };
    const api = {
      select() { return api; }, eq(c, v) { filters.push([c, v]); return api; },
      order() { return api; }, limit() { return api; },
      maybeSingle() { single = true; return Promise.resolve(run()); },
      single() { single = true; return Promise.resolve(run()); },
      insert() { return api; }, update() { return api; }, delete() { return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
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

function boot(T, meId) {
  const dom = new JSDOM(html, { url: "https://x.test/?r=" + ROOM,
    runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.TRIP_SPLIT_CONFIG = { SUPABASE_URL: "https://fake", SUPABASE_ANON_KEY: "fake" };
  w.supabase = { createClient: () => makeClient(T) };
  w.fetch = () => Promise.reject(new Error("offline"));
  w.localStorage.setItem("tripsplit_me_" + ROOM, meId);
  w.eval(appSrc);
  return w;
}
const payers = (w) => [...w.document.querySelectorAll("#payer-chips .chip")].map((b) => b.textContent);
const vis = (w, id) => {
  const el = w.document.getElementById(id) || w.document.querySelector(id);
  if (!el) return "(없음)";
  return el.style.display === "none" ? "숨김" : "보임";
};

(async () => {
  console.log("[총무] 이수형");
  let w = boot(fixture(), M.boss);
  await wait(250);
  w.document.getElementById("when-bar").click(); // 낸 사람 패널을 열어 칩을 그린다
  w.document.getElementById("who-bar").click();
  await wait(50);
  ok("낸 사람에 공금이 있다", payers(w).indexOf("공금") >= 0, true);
  ok("사람 둘 + 공금", payers(w), ["이수형", "정원호", "공금"]);
  w.document.getElementById("go-history").click();
  w.document.getElementById("go-status").click();
  await wait(80);
  ok("멤버 추가 줄이 보인다", vis(w, ".member-add"), "보임");
  ok("총무 안내는 숨어 있다", vis(w, "member-hint"), "숨김");
  ok("남의 자리에 삭제 버튼", w.document.querySelectorAll(".mem-del").length >= 1, true);

  console.log("\n[총무 아님] 정원호");
  w = boot(fixture(), M.other);
  await wait(250);
  w.document.getElementById("who-bar").click();
  await wait(50);
  ok("낸 사람에 공금이 없다", payers(w).indexOf("공금") >= 0, false);
  ok("사람 둘만", payers(w), ["이수형", "정원호"]);
  w.document.getElementById("go-history").click();
  w.document.getElementById("go-status").click();
  await wait(80);
  ok("멤버 추가 줄이 사라진다", vis(w, ".member-add"), "숨김");
  ok("누가 총무인지 알려준다", vis(w, "member-hint"), "보임");
  ok("안내 문구에 총무 이름",
    /이수형/.test(w.document.getElementById("member-hint").textContent), true);
  ok("삭제 버튼이 하나도 없다", w.document.querySelectorAll(".mem-del").length, 0);

  console.log("\n[총무 미지정] 옛 방은 예전대로");
  // manager_id 가 없는 방까지 잠가버리면, 만든 사람도 못 고치는 방이 생긴다
  const T = fixture(); T.rooms[0].manager_id = null;
  w = boot(T, M.other);
  await wait(250);
  w.document.getElementById("who-bar").click();
  await wait(50);
  ok("아무나 공금을 쓸 수 있다", payers(w).indexOf("공금") >= 0, true);
  w.document.getElementById("go-history").click();
  w.document.getElementById("go-status").click();
  await wait(80);
  ok("멤버 추가도 열려 있다", vis(w, ".member-add"), "보임");

  console.log("\n" + (failures ? failures + "건 실패" : "전부 통과"));
  process.exit(failures ? 1 : 0);
})();
