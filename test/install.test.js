// "홈 화면에 추가" 안내가 환경별로 맞게 나오는지.
// 여기가 틀리면 친구가 링크를 열고도 앱을 못 깐다 — 특히 카톡 인앱 브라우저.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const APP = path.join(__dirname, "..");
const ROOM = "kyoto";
const ME = "m-a";

const TABLES = () => ({
  rooms: [{ id: ROOM, name: "교토", default_currency: "KRW", start_date: "2026-07-24",
            created_at: "2026-07-20T00:00:00Z" }],
  members: [{ id: ME, room_id: ROOM, name: "민수", created_at: "2026-07-20T00:00:01Z" }],
  expenses: [],
});

function makeClient(T) {
  function query(table) {
    let filters = [], single = false;
    function run() {
      const rows = T[table].filter((r) => filters.every((f) => String(r[f[0]]) === String(f[1])));
      return { data: single ? (rows[0] || null) : rows, error: null };
    }
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

const UA = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 " +
                "(KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  iphoneKakao: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 " +
               "(KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.5.0",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) " +
                 "Chrome/126.0.0.0 Mobile Safari/537.36",
};

const html = fs.readFileSync(path.join(APP, "index.html"), "utf8")
  .replace(/<script src="(config\.js|vendor\/supabase\.js|app\.js)"><\/script>/g, "");
const appSrc = fs.readFileSync(path.join(APP, "app.js"), "utf8");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (name, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures++;
  console.log((pass ? "  PASS  " : "  FAIL  ") + name);
  if (!pass) console.log("          기대: " + JSON.stringify(want) + "\n          실제: " + JSON.stringify(got));
};

async function session(userAgent, standalone) {
  const T = TABLES();
  const dom = new JSDOM(html, {
    url: "https://x.test/?r=" + ROOM,
    runScripts: "outside-only", pretendToBeVisual: true,
  });
  const w = dom.window;
  // jsdom 24 ignores the userAgent option, so set it on the navigator itself
  Object.defineProperty(w.navigator, "userAgent", { value: userAgent, configurable: true });
  w.TRIP_SPLIT_CONFIG = { SUPABASE_URL: "https://fake", SUPABASE_ANON_KEY: "fake" };
  w.supabase = { createClient: () => makeClient(T) };
  w.fetch = () => Promise.reject(new Error("offline"));
  if (standalone) w.navigator.standalone = true; // 홈 화면에서 연 상태
  w.eval(appSrc);
  await wait(250);
  return w;
}
const $ = (w, id) => w.document.getElementById(id);
const txt = (el) => el.textContent.replace(/\s+/g, " ").trim();


// 실제로 친구가 밟는 길: 링크 -> 이름 고르기(screen-join) -> 들어가면 기록.
// 옛 테스트는 계정 기능이 없는 DB를 흉내내 screen-identity 로 떨어졌고, 그래서
// 이름 고르는 화면이 join 으로 바뀐 뒤에도 초록불이 켜져 있었다.
const SEATS = [
  { id: "s-1", name: "민수", taken: false },
  { id: "s-2", name: "지현", taken: false },
];
function joinClient(T) {
  const base = makeClient(T);
  base.rpc = (fn, args) => {
    if (fn === "handle_available") return Promise.resolve({ data: true, error: null });
    if (fn === "room_peek") return Promise.resolve({ data: "교토", error: null });
    if (fn === "room_seats") return Promise.resolve({ data: SEATS, error: null });
    return Promise.resolve({ data: null, error: { message: "function does not exist" } });
  };
  base.auth = {
    getUser: () => Promise.resolve({ data: { user: null } }),
    signInWithPassword: () => Promise.resolve({ error: { message: "no" } }),
    signUp: () => Promise.resolve({ error: { message: "no" } }),
    signOut: () => Promise.resolve({}),
  };
  return base;
}
async function joinSession(userAgent) {
  const T = TABLES();
  const dom = new JSDOM(html, { url: "https://x.test/?r=" + ROOM,
    runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  Object.defineProperty(w.navigator, "userAgent", { value: userAgent, configurable: true });
  w.TRIP_SPLIT_CONFIG = { SUPABASE_URL: "https://fake", SUPABASE_ANON_KEY: "fake" };
  w.supabase = { createClient: () => joinClient(T) };
  w.fetch = () => Promise.reject(new Error("offline"));
  w.eval(appSrc);
  await wait(300);
  return w;
}

(async () => {
  console.log("[아이폰 사파리] 링크로 처음 들어온 친구");
  let w = await session(UA.iphoneSafari);
  ok("이름 고르는 화면", w.document.querySelector(".screen.active").id, "screen-identity");
  ok("설치 안내가 뜸", $(w, "install-hint").classList.contains("show"), true);
  ok("공유 버튼을 가리킴", txt($(w, "install-how")), "공유 버튼 → '홈 화면에 추가'");
  $(w, "install-go").click();
  await wait(100);
  ok("방법 시트가 열림", $(w, "guide-back").classList.contains("show"), true);
  ok("제목", txt($(w, "guide-title")), "홈 화면에 추가하기");
  ok("3단계 안내", [...w.document.querySelectorAll("#guide-steps .guide-step")].length, 3);
  ok("공유 아이콘이 그려짐", !!w.document.querySelector("#guide-steps svg"), true);
  ok("아래(공유 버튼 쪽)를 가리키는 화살표", !!w.document.querySelector(".guide-arrow"), true);
  ok("iOS엔 누를 버튼이 없음 (애플이 API를 안 줌)",
    $(w, "guide-action").style.display, "none");

  console.log("\n[카톡 인앱 브라우저] 실제로 가장 많이 막히는 자리");
  w = await session(UA.iphoneKakao);
  ok("먼저 브라우저로 옮기라고 안내", txt($(w, "install-how")), "브라우저로 열어야 추가할 수 있어요");
  $(w, "install-go").click();
  await wait(100);
  ok("제목이 다름", txt($(w, "guide-title")), "브라우저로 먼저 열어주세요");
  ok("카톡이라고 짚어줌", /카톡 안의 브라우저/.test(txt(w.document.querySelector("#guide-steps"))), true);
  ok("사파리로 안내 (안드로이드용 크롬 아님)",
    /사파리로 열면/.test(txt(w.document.querySelector("#guide-steps"))), true);
  ok("바로 여는 버튼이 있음", txt($(w, "guide-action")), "🌐 브라우저로 열기");

  console.log("\n[안드로이드 크롬] 설치 프롬프트가 아직 안 왔을 때");
  w = await session(UA.androidChrome);
  ok("메뉴를 가리킴", txt($(w, "install-how")), "브라우저 메뉴 → '홈 화면에 추가'");
  $(w, "install-go").click();
  await wait(100);
  ok("2단계 안내", [...w.document.querySelectorAll("#guide-steps .guide-step")].length, 2);
  ok("아이폰용 화살표는 없음", !!w.document.querySelector(".guide-arrow"), false);

  console.log("\n[이미 설치함] 홈 화면 아이콘으로 연 경우");
  w = await session(UA.iphoneSafari, true);
  ok("이름 고르는 화면인 건 같지만", w.document.querySelector(".screen.active").id, "screen-identity");
  ok("이미 깔았으니 안내를 안 띄움", $(w, "install-hint").classList.contains("show"), false);

  console.log("\n[한 번 닫음] 다시 보채지 않는다");
  w = await session(UA.iphoneSafari);
  ok("처음엔 뜸", $(w, "install-hint").classList.contains("show"), true);
  $(w, "install-x").click();
  ok("닫으면 사라지고", $(w, "install-hint").classList.contains("show"), false);
  ok("기억함", w.localStorage.getItem("tripsplit_install_dismissed"), "1");

  console.log("\n[진짜 친구가 보는 화면] 생일 로그인 화면에서도 떠야 한다");
  w = await joinSession(UA.iphoneSafari);
  ok("이름 고르는 화면은 screen-join", w.document.querySelector(".screen.active").id, "screen-join");
  ok("여기서 안내가 뜸", $(w, "install-hint").classList.contains("show"), true);
  ok("공유 버튼을 가리킴", txt($(w, "install-how")), "공유 버튼 → '홈 화면에 추가'");

  // 로그인 폼 위에 설치 배너를 얹으면 입력칸을 가린다
  $(w, "join-other").click();
  await wait(60);
  ok("아이디 로그인 화면으로 감", w.document.querySelector(".screen.active").id, "screen-auth");
  ok("거기서는 안 뜬다", $(w, "install-hint").classList.contains("show"), false);

  console.log("\n" + (failures ? failures + "건 실패" : "전부 통과"));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
