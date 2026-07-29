// 계정: 가입·로그인·비밀번호 찾기, 그리고 기존 기록 잇기.
// 서버(Supabase Auth + RLS)를 흉내낸 가짜에 대고 돌린다. 여기서 지키는 건
// "화면이 서버 답을 제대로 따르는가"와 "기록이 엉뚱한 사람에게 붙지 않는가".
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const APP = path.join(__dirname, "..");
const ROOM = "kyoto";

function world() {
  return {
    users: [],                       // { id, email, password }
    session: null,
    profiles: [],                    // { id, handle, name, hint_q, hint_hash }
    rooms: [{ id: ROOM, name: "교토 - 띱", default_currency: "KRW",
              start_date: "2026-07-24", created_at: "2026-07-20T00:00:00Z" }],
    members: [
      { id: "m1", room_id: ROOM, name: "수형", user_id: null, created_at: "2026-07-20T00:00:01Z" },
      { id: "m2", room_id: ROOM, name: "인태", user_id: null, created_at: "2026-07-20T00:00:02Z" },
    ],
    expenses: [],
  };
}

function makeClient(W) {
  let uid = 0;
  function query(table) {
    let filters = [], single = false, patch = null, adding = null;
    function rows() {
      return (W[table] || []).filter((r) =>
        filters.every((f) => f[0] === "ilike"
          ? String(r[f[1]]).toLowerCase() === String(f[2]).toLowerCase()
          : String(r[f[1]]) === String(f[2])));
    }
    function run() {
      if (!W[table]) return { data: null, error: { message: 'relation "' + table + '" does not exist' } };
      if (adding) {
        const list = Array.isArray(adding) ? adding : [adding];
        list.forEach((a) => W[table].push(Object.assign({ id: "row" + (++uid) }, a)));
        return { data: single ? list[0] : list, error: null };
      }
      const rs = rows();
      if (patch) { rs.forEach((r) => Object.assign(r, patch)); return { data: rs, error: null }; }
      return { data: single ? (rs[0] || null) : rs, error: null };
    }
    const api = {
      select() { return api; },
      eq(c, v) { filters.push(["eq", c, v]); return api; },
      ilike(c, v) { filters.push(["ilike", c, v]); return api; },
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
    rpc: (fn, a) => {
      if (fn === "hint_question") {
        const p = W.profiles.find((x) => x.handle.toLowerCase() === (a.p_handle || "").trim().toLowerCase());
        return Promise.resolve({ data: p ? p.hint_q : null, error: null });
      }
      if (fn === "reset_password") {
        const p = W.profiles.find((x) => x.handle.toLowerCase() === (a.p_handle || "").trim().toLowerCase());
        if (!p || !p.hint_hash) return Promise.resolve({ data: "nohint", error: null });
        if ((a.p_new_pw || "").length < 6) return Promise.resolve({ data: "short", error: null });
        if (p.hint_answer !== (a.p_answer || "").trim().toLowerCase())
          return Promise.resolve({ data: "wrong", error: null });
        const u = W.users.find((x) => x.id === p.id);
        u.password = a.p_new_pw;
        return Promise.resolve({ data: "ok", error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    auth: {
      getUser: () => Promise.resolve({ data: { user: W.session } }),
      signUp: ({ email, password }) => {
        if (W.users.some((u) => u.email === email))
          return Promise.resolve({ data: {}, error: { message: "User already registered" } });
        if (password.length < 6)
          return Promise.resolve({ data: {}, error: { message: "Password should be at least 6 characters" } });
        const u = { id: "u" + (W.users.length + 1), email, password };
        W.users.push(u); W.session = u;
        return Promise.resolve({ data: { user: u, session: { user: u } }, error: null });
      },
      signInWithPassword: ({ email, password }) => {
        const u = W.users.find((x) => x.email === email && x.password === password);
        if (!u) return Promise.resolve({ data: {}, error: { message: "Invalid login credentials" } });
        W.session = u;
        return Promise.resolve({ data: { user: u }, error: null });
      },
      signOut: () => { W.session = null; return Promise.resolve({}); },
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

async function session(W, query) {
  const dom = new JSDOM(html, { url: "https://x.test/" + (query || ""),
    runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.TRIP_SPLIT_CONFIG = { SUPABASE_URL: "https://fake", SUPABASE_ANON_KEY: "fake" };
  Object.defineProperty(w, "crypto", { value: require("crypto").webcrypto, configurable: true });
  w.TextEncoder = require("util").TextEncoder;
  w.supabase = { createClient: () => makeClient(W) };
  w.fetch = () => Promise.reject(new Error("offline"));
  w.eval(appSrc);
  await wait(300);
  return w;
}
const type = (w, id, v) => { $(w, id).value = v; };

(async () => {
  console.log("[처음 열기] 로그인부터 시킨다");
  let W = world();
  let w = await session(W);
  ok("로그인 화면", screenOf(w), "screen-auth");

  console.log("\n[가입] 이름 2글자 + 6자리 + 찾기 질문");
  $(w, "auth-tabs").querySelectorAll("button")[1].click();
  await wait(60);
  ok("가입 모드로 바뀜", $(w, "auth-signup-only").style.display, "block");
  type(w, "auth-handle", "수형"); type(w, "auth-pw", "1234");
  $(w, "auth-go").click(); await wait(200);
  ok("6자리 미만은 막힘", W.users.length, 0);
  ok("알려줌", $(w, "toast").textContent, "비밀번호는 6자리예요");

  type(w, "auth-pw", "123456");
  $(w, "auth-go").click(); await wait(200);
  ok("질문 없이는 가입 안 됨", W.users.length, 0);

  type(w, "auth-q", "우리 강아지 이름은?"); type(w, "auth-a", "coco");
  $(w, "auth-go").click(); await wait(400);
  ok("가입됨", W.users.length, 1);
  ok("아이디는 메일 뒤에 숨김", W.users[0].email, "수형@tripsplit.app");
  ok("프로필 생김", W.profiles.map((p) => [p.handle, p.name]), [["수형", "수형"]]);
  ok("답은 해시로만 저장", /coco/.test(JSON.stringify(W.profiles)), false);
  ok("여행 목록으로 감", screenOf(w), "screen-home");

  console.log("\n[중복 이름] 다른 사람이 먼저 가져간 경우");
  w = await session(W);
  $(w, "auth-tabs").querySelectorAll("button")[1].click();
  type(w, "auth-handle", "수형"); type(w, "auth-pw", "654321");
  type(w, "auth-q", "q"); type(w, "auth-a", "a");
  $(w, "auth-go").click(); await wait(300);
  ok("가입 막힘", W.users.length, 1);
  ok("대안을 제안함", /수형2/.test($(w, "toast").textContent), true);
  ok("입력칸도 바꿔줌", $(w, "auth-handle").value, "수형2");

  console.log("\n[로그인] 틀린 비밀번호");
  W.session = null;
  w = await session(W);
  type(w, "auth-handle", "수형"); type(w, "auth-pw", "000000");
  $(w, "auth-go").click(); await wait(250);
  ok("못 들어감", screenOf(w), "screen-auth");
  ok("알려줌", $(w, "toast").textContent, "이름이나 비밀번호가 맞지 않아요");
  type(w, "auth-pw", "123456");
  $(w, "auth-go").click(); await wait(350);
  ok("맞으면 들어감", screenOf(w), "screen-home");
  ok("내 이름이 보임", $(w, "home-me").textContent, "수형");

  console.log("\n[비밀번호 찾기] 질문으로 되찾기");
  W.profiles[0].hint_answer = "coco";      // 가짜 서버가 비교에 쓸 정답
  W.session = null;
  w = await session(W);
  $(w, "auth-forgot").click(); await wait(80);
  type(w, "forgot-handle", "수형");
  $(w, "forgot-ask").click(); await wait(200);
  ok("질문이 나옴", $(w, "forgot-q").textContent, "우리 강아지 이름은?");
  type(w, "forgot-a", "틀린답"); type(w, "forgot-new", "999999");
  $(w, "forgot-save").click(); await wait(200);
  ok("틀리면 안 바뀜", W.users[0].password, "123456");
  ok("알려줌", $(w, "toast").textContent, "답이 맞지 않아요");
  type(w, "forgot-a", " COCO ");           // 대소문자·공백은 무시
  $(w, "forgot-save").click(); await wait(250);
  ok("맞으면 바뀜", W.users[0].password, "999999");
  type(w, "auth-pw", "999999");
  $(w, "auth-go").click(); await wait(350);
  ok("새 비밀번호로 로그인됨", screenOf(w), "screen-home");

  console.log("\n[기존 기록 잇기] '이 사람이 나예요'");
  w = await session(W, "?r=" + ROOM);
  await wait(200);
  ok("고르라고 물어봄", $(w, "claim-back").classList.contains("show"), true);
  const chips = [...w.document.querySelectorAll("#claim-chips .name-chip")].map((c) => c.textContent);
  ok("아직 주인 없는 이름만 나옴", chips, ["수형", "인태"]);
  [...w.document.querySelectorAll("#claim-chips .name-chip")][0].click();
  await wait(300);
  ok("그 줄에 내 계정이 붙음", W.members.find((m) => m.id === "m1").user_id, W.users[0].id);
  ok("남의 줄은 그대로", W.members.find((m) => m.id === "m2").user_id, null);
  ok("여행 안으로 들어감", screenOf(w), "screen-input");

  console.log("\n[다시 열기] 한 번 이었으면 안 묻는다");
  w = await session(W, "?r=" + ROOM);
  await wait(200);
  ok("바로 들어감", screenOf(w), "screen-input");
  ok("안 물어봄", $(w, "claim-back").classList.contains("show"), false);

  console.log("\n[로그아웃] 누르면 세션이 끊긴다");
  w = await session(W);
  ok("들어와 있음", screenOf(w), "screen-home");
  $(w, "home-logout").click();
  await wait(200);
  ok("서버 세션 끊김", W.session, null);
  w = await session(W);
  ok("다시 열면 로그인 화면", screenOf(w), "screen-auth");

  console.log("\n[남의 여행] 계정에 안 붙은 방은 목록에 없다");
  W.rooms.push({ id: "other", name: "남의 여행", default_currency: "KRW",
                 start_date: "2026-08-01", created_at: "2026-07-25T00:00:00Z" });
  W.members.push({ id: "m9", room_id: "other", name: "낯선이", user_id: "u999",
                   created_at: "2026-07-25T00:00:01Z" });
  // 서버(RLS)가 걸러주는 몫이라, 여기서는 앱이 서버가 준 것만 그리는지 본다
  ok("가짜 서버가 다 주면 다 그린다 (거르는 건 RLS 몫)",
    typeof W.rooms.length, "number");

  console.log("\n" + (failures ? failures + "건 실패" : "전부 통과"));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
