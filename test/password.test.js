// 여행 비밀번호. 잠금 판정은 서버(room_ok)가 하고 화면은 그 답을 따를 뿐이라,
// 여기서 확인하는 건 "화면이 서버 답을 제대로 따르는가"다.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const APP = path.join(__dirname, "..");
const OPEN = "openroom", LOCKED = "lockroom";
// sha256("lockroom:1234") — 앱이 헤더로 보내는 값
const RIGHT_KEY = "3f0a5b1c";  // 아래 fake 가 비교에만 쓰므로 실제 값일 필요는 없다

function tables() {
  return {
    rooms: [
      { id: OPEN, name: "이시가키", default_currency: "KRW", start_date: "2026-09-13",
        has_pw: false, created_at: "2026-07-01T00:00:00Z" },
      { id: LOCKED, name: "교토 - 띱", default_currency: "KRW", start_date: "2026-07-24",
        has_pw: true, created_at: "2026-07-20T00:00:00Z" },
    ],
    members: [{ id: "m-a", room_id: LOCKED, name: "민수", created_at: "2026-07-20T00:00:01Z" }],
    expenses: [],
  };
}

// 서버를 흉내낸다: 헤더의 키가 맞아야 room_ok 가 true 를 준다.
function makeClient(T, opts, log) {
  const key = opts && opts.global && opts.global.headers && opts.global.headers["x-trip-key"];
  const roomOk = (room) => {
    const r = T.rooms.find((x) => x.id === room);
    if (!r) return false;
    return !r.has_pw || key === T.secret[room];
  };
  function query(table) {
    let filters = [], single = false, patch = null, adding = null;
    function run() {
      if (adding) { T[table].push(Object.assign({ id: "new" }, adding)); return { data: [adding], error: null }; }
      let rows = T[table].filter((r) => filters.every((f) => String(r[f[0]]) === String(f[1])));
      // 서버 정책: 멤버·지출은 키가 맞아야 나온다
      if (table !== "rooms") rows = rows.filter((r) => roomOk(r.room_id));
      if (patch) { rows.forEach((r) => Object.assign(r, patch)); return { data: rows, error: null }; }
      return { data: single ? (rows[0] || null) : rows, error: null };
    }
    const api = {
      select() { return api; }, eq(c, v) { filters.push([c, v]); return api; },
      order() { return api; }, limit() { return api; },
      maybeSingle() { single = true; return Promise.resolve(run()); },
      single() { single = true; return Promise.resolve(run()); },
      insert(p) { adding = p; return api; }, update(p) { patch = p; return api; },
      delete() { return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }
  return {
    from: (t) => query(t),
    rpc: (fn, args) => {
      log.push({ rpc: fn, key: key });
      return Promise.resolve({ data: fn === "room_ok" ? roomOk(args.p_room) : null, error: null });
    },
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
const $ = (w, id) => w.document.getElementById(id);
const screenOf = (w) => w.document.querySelector(".screen.active").id;

async function session(query, stored) {
  const T = tables();
  const log = [];
  const dom = new JSDOM(html, { url: "https://x.test/" + (query || ""),
    runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.TRIP_SPLIT_CONFIG = { SUPABASE_URL: "https://fake", SUPABASE_ANON_KEY: "fake" };
  // 앱이 계산하는 키를 그대로 정답으로 삼는다 (crypto.subtle 은 node 것을 빌린다)
  const enc = new (require("util").TextEncoder)();
  const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  const digest = async (s) => hex(await require("crypto").webcrypto.subtle.digest("SHA-256", enc.encode(s)));
  T.secret = { [LOCKED]: await digest(LOCKED + ":1234") };
  // jsdom's window.crypto is a read-only accessor with no subtle, so replace it
  Object.defineProperty(w, "crypto", { value: require("crypto").webcrypto, configurable: true });
  w.TextEncoder = require("util").TextEncoder;
  w.supabase = { createClient: (u, k, opts) => makeClient(T, opts, log) };
  w.fetch = () => Promise.reject(new Error("offline"));
  if (stored) w.localStorage.setItem("tripsplit_key_" + LOCKED, stored === true ? T.secret[LOCKED] : stored);
  w.eval(appSrc);
  await wait(300);
  return { w, T, log };
}

(async () => {
  console.log("[목록] 서버에서 모든 여행을 가져온다");
  let { w } = await session();
  ok("홈 화면", screenOf(w), "screen-home");
  const rows = [...w.document.querySelectorAll("#home-list .trip-row")];
  ok("브라우저 기록이 없어도 두 개 다 보임", rows.length, 2);
  ok("잠긴 것에 자물쇠", rows.map((r) => !!r.querySelector(".t-lock")).sort(), [false, true]);

  console.log("\n[잠긴 여행] 탭하면 비밀번호를 묻는다");
  ({ w } = await session());
  const locked = [...w.document.querySelectorAll("#home-list .trip-row")]
    .find((r) => r.querySelector(".t-lock"));
  locked.click();
  await wait(120);
  ok("비밀번호 창이 열림", $(w, "pw-back").classList.contains("show"), true);
  ok("여행 이름을 보여줌", $(w, "pw-title").textContent, "교토 - 띱");

  console.log("\n[틀린 비밀번호] 서버가 거절한다");
  $(w, "pw-input").value = "0000";
  $(w, "pw-go").click();
  await wait(250);
  ok("창이 닫히지 않음", $(w, "pw-back").classList.contains("show"), true);
  ok("다시 입력하라고 알려줌", /맞지 않아요/.test($(w, "pw-sub").textContent), true);
  ok("키를 저장하지 않음", w.localStorage.getItem("tripsplit_key_" + LOCKED), null);

  console.log("\n[맞는 비밀번호] 키를 기억한다");
  $(w, "pw-input").value = "1234";
  $(w, "pw-go").click();
  await wait(250);
  ok("키가 저장됨", typeof w.localStorage.getItem("tripsplit_key_" + LOCKED), "string");
  ok("비밀번호 원문은 저장하지 않음",
    /1234/.test(JSON.stringify(Object.entries(w.localStorage))), false);

  console.log("\n[링크로 바로] 키가 있으면 그냥 열린다");
  ({ w } = await session("?r=" + LOCKED, true));
  ok("여행 안으로 들어감", ["screen-input", "screen-identity"].indexOf(screenOf(w)) >= 0, true);
  ok("비밀번호를 다시 묻지 않음", $(w, "pw-back").classList.contains("show"), false);

  console.log("\n[링크로 바로] 키가 없으면 막는다");
  ({ w } = await session("?r=" + LOCKED));
  ok("여행 안으로 못 들어감", screenOf(w), "screen-home");
  ok("비밀번호를 물어봄", $(w, "pw-back").classList.contains("show"), true);

  console.log("\n[비밀번호가 바뀐 경우] 낡은 키는 버린다");
  ({ w } = await session("?r=" + LOCKED, "낡은키"));
  ok("막힘", $(w, "pw-back").classList.contains("show"), true);
  ok("안 맞는 키는 지워짐", w.localStorage.getItem("tripsplit_key_" + LOCKED), null);

  console.log("\n[안 잠근 여행] 지금까지처럼 그냥 열린다");
  ({ w } = await session("?r=" + OPEN));
  ok("바로 들어감", ["screen-input", "screen-identity"].indexOf(screenOf(w)) >= 0, true);
  ok("비밀번호 창 없음", $(w, "pw-back").classList.contains("show"), false);

  console.log("\n" + (failures ? failures + "건 실패" : "전부 통과"));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
