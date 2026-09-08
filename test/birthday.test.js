// 이름 고르고 생일 네 자리로 들어오기.
//
// 생일이 맞는지 판정하는 건 서버(birth_ok / claim_by_birth)다. 여기서 보는 건
// "화면이 서버 답을 제대로 따르는가"와, 화면이 서버를 **어떤 순서로** 부르는가다.
// 순서가 중요한 이유: 생일을 확인하기 전에 계정을 만들어 버리면, 오타를 친
// 사람은 그 오타로만 열리는 계정에 갇힌다. 여행 중엔 손쓸 방법이 없다.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const APP = path.join(__dirname, "..");
const ROOM = "qx73ifx";

// 세 자리만 둔다 — 빈 자리, 내가 이미 가져간 자리, 남이 가져간 자리.
function tables() {
  return {
    rooms: [{ id: ROOM, name: "이시가키 2026", default_currency: "KRW",
              start_date: "2026-09-13", has_pw: false, created_at: "2026-08-01T00:00:00Z" }],
    seats: [
      { id: "m-free", name: "정원호", birth: "0206", user_id: null },
      { id: "m-mine", name: "김우성", birth: "0610", user_id: "u-mine" },
      { id: "m-other", name: "권오훈", birth: "1227", user_id: "u-someone-else" },
    ],
    members: [], expenses: [],
    users: {},            // email → { id, password }
    profiles: [],
  };
}

// 서버 흉내. 계정 기능은 있는 DB이고, 생일 마이그레이션도 돌아간 상태다.
function makeClient(T, log, opts) {
  let session = (opts && opts.session) || null;
  const seat = (id) => T.seats.find((s) => s.id === id);

  function query(table) {
    let filters = [], single = false, adding = null;
    function run() {
      if (adding) {
        if (table === "profiles") T.profiles.push(adding);
        return { data: [adding], error: null };
      }
      const src = table === "profiles" ? T.profiles : (T[table] || []);
      const rows = src.filter((r) => filters.every((f) => String(r[f[0]]) === String(f[1])));
      return { data: single ? (rows[0] || null) : rows, error: null };
    }
    const api = {
      select() { return api; }, eq(c, v) { filters.push([c, v]); return api; },
      order() { return api; }, limit() { return api; },
      maybeSingle() { single = true; return Promise.resolve(run()); },
      single() { single = true; return Promise.resolve(run()); },
      insert(p) { adding = p; return api; }, update() { return api; }, delete() { return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }

  return {
    from: (t) => query(t),
    auth: {
      getUser: () => Promise.resolve({ data: { user: session } }),
      signInWithPassword: ({ email, password }) => {
        log.push({ call: "signIn", email: email });
        const u = T.users[email];
        if (!u || u.password !== password) {
          return Promise.resolve({ data: {}, error: { message: "Invalid login credentials" } });
        }
        session = { id: u.id };
        return Promise.resolve({ data: { user: session, session: {} }, error: null });
      },
      signUp: ({ email, password }) => {
        log.push({ call: "signUp", email: email });
        if (T.users[email]) return Promise.resolve({ data: {}, error: { message: "already registered" } });
        const u = { id: "u-" + Object.keys(T.users).length, password: password };
        T.users[email] = u;
        session = { id: u.id };
        return Promise.resolve({ data: { user: session, session: {} }, error: null });
      },
      signOut: () => { log.push({ call: "signOut" }); session = null; return Promise.resolve({}); },
    },
    rpc: (fn, args) => {
      log.push({ call: fn });
      if (fn === "handle_available") return Promise.resolve({ data: true, error: null });
      // 생일 마이그레이션을 아직 안 돌린 DB: 새 함수 둘이 없다. 서버가 그러듯
      // 오류를 돌려줘야 앱이 옛 로그인 화면으로 물러나는지 볼 수 있다.
      if (opts && opts.noMigration && (fn === "room_seats" || fn === "birth_ok" || fn === "claim_by_birth")) {
        return Promise.resolve({ data: null,
          error: { message: "function public." + fn + " does not exist" } });
      }
      if (fn === "room_peek") return Promise.resolve({ data: T.rooms[0].name, error: null });
      if (fn === "room_seats") {
        return Promise.resolve({ error: null,
          data: T.seats.map((s) => ({ id: s.id, name: s.name, taken: s.user_id !== null })) });
      }
      if (fn === "birth_ok") {
        const s = seat(args.p_member);
        return Promise.resolve({ data: !!s && s.birth === args.p_birth, error: null });
      }
      if (fn === "claim_by_birth") {
        const s = seat(args.p_member);
        if (!s || s.birth !== args.p_birth || !session) return Promise.resolve({ data: false, error: null });
        // 빈 자리거나 이미 내 자리면 참. 남의 자리면 거짓.
        if (s.user_id !== null && s.user_id !== session.id) return Promise.resolve({ data: false, error: null });
        s.user_id = session.id;
        return Promise.resolve({ data: true, error: null });
      }
      return Promise.resolve({ data: null,
        error: { message: "function public." + fn + " does not exist" } });
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
const screenOf = (w) => {
  const el = w.document.querySelector(".screen.active");
  return el ? el.id : "(없음)";
};
const chips = (w) => [...w.document.querySelectorAll("#join-chips .name-chip")];

async function session(opts) {
  const T = tables();
  const log = [];
  const dom = new JSDOM(html, { url: "https://x.test/?r=" + ROOM,
    runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.TRIP_SPLIT_CONFIG = { SUPABASE_URL: "https://fake", SUPABASE_ANON_KEY: "fake" };
  Object.defineProperty(w, "crypto", { value: require("crypto").webcrypto, configurable: true });
  w.TextEncoder = require("util").TextEncoder;
  w.supabase = { createClient: () => makeClient(T, log, opts) };
  w.fetch = () => Promise.reject(new Error("offline"));
  w.eval(appSrc);
  await wait(300);
  return { w, T, log };
}

(async () => {
  console.log("[링크로 처음] 계정을 만들라고 하지 않는다");
  let { w, T, log } = await session();
  ok("생일 화면이 뜸", screenOf(w), "screen-join");
  ok("방 이름을 보여줌", $(w, "join-room").textContent, "이시가키 2026");
  ok("이름 세 개가 다 뜸", chips(w).map((c) => c.textContent), ["정원호", "김우성", "권오훈"]);
  ok("자리를 가져간 사람도 명단에 남음 (폰 지우고 다시 들어와야 하므로)",
    chips(w).some((c) => c.textContent === "김우성"), true);
  ok("생일 칸은 아직 숨어 있음", $(w, "join-birth-wrap").style.display, "none");

  console.log("\n[이름을 고르면] 생일 칸이 열린다");
  chips(w)[0].click();
  await wait(60);
  ok("생일 칸이 보임", $(w, "join-birth-wrap").style.display, "");
  ok("고른 이름에 표시", chips(w)[0].classList.contains("on"), true);
  ok("누구 차례인지 알려줌", /정원호/.test($(w, "join-sub").textContent), true);

  console.log("\n[네 자리가 아니면] 서버를 부르지 않는다");
  $(w, "join-birth").value = "26";
  $(w, "join-go").click();
  await wait(120);
  ok("생일 확인을 안 부름", log.filter((l) => l.call === "birth_ok").length, 0);
  ok("가입도 안 함", log.filter((l) => l.call === "signUp").length, 0);

  console.log("\n[생일이 틀리면] 계정을 만들지 않는다 ← 오타로 갇히는 걸 막는 곳");
  $(w, "join-birth").value = "9999";
  $(w, "join-go").click();
  await wait(200);
  ok("생일을 물어봄", log.filter((l) => l.call === "birth_ok").length, 1);
  ok("가입하지 않음", log.filter((l) => l.call === "signUp").length, 0);
  ok("로그인도 시도하지 않음", log.filter((l) => l.call === "signIn").length, 0);
  ok("자리는 그대로 비어 있음", T.seats[0].user_id, null);
  ok("화면에 남아 있음", screenOf(w), "screen-join");

  console.log("\n[생일이 맞으면] 계정을 만들고 자리를 가져간다");
  $(w, "join-birth").value = "0206";
  $(w, "join-go").click();
  await wait(300);
  ok("가입함", log.filter((l) => l.call === "signUp").length, 1);
  ok("자리가 내 것이 됨", T.seats[0].user_id !== null, true);
  ok("보이는 이름은 실제 이름", T.profiles[0] && T.profiles[0].name, "정원호");
  ok("아이디는 자리에서 만들어진 것 (사람이 외울 필요 없음)",
    /^s_qx73ifx_/.test(T.profiles[0] && T.profiles[0].handle), true);

  console.log("\n[남의 자리] 생일이 맞아도 못 들어간다");
  ({ w, T, log } = await session());
  chips(w)[2].click();          // 권오훈 — 이미 다른 사람이 쓰는 자리
  await wait(60);
  $(w, "join-birth").value = "1227";
  $(w, "join-go").click();
  await wait(300);
  ok("자리 주인이 안 바뀜", T.seats[2].user_id, "u-someone-else");
  ok("로그아웃시킴 (남의 계정으로 남지 않게)",
    log.filter((l) => l.call === "signOut").length, 1);
  ok("화면에 남아 있음", screenOf(w), "screen-join");

  console.log("\n[다시 들어오기] 폰을 지워도 같은 생일로 돌아온다");
  ({ w, T, log } = await session());
  chips(w)[0].click();
  await wait(60);
  $(w, "join-birth").value = "0206";
  $(w, "join-go").click();
  await wait(300);
  const email = Object.keys(T.users)[0];
  const firstId = T.users[email].id;
  // 같은 자리·같은 생일로 두 번째 기기에서 들어온다
  const T2 = T, log2 = [];
  const sb2 = makeClient(T2, log2, {});
  await sb2.auth.signInWithPassword({ email: email, password: "bd0206" });
  const again = await sb2.rpc("claim_by_birth",
    { p_room: ROOM, p_member: "m-free", p_birth: "0206" });
  ok("같은 계정으로 로그인됨", T2.users[email].id, firstId);
  ok("이미 내 자리여도 참을 준다", again.data, true);

  console.log("\n[마이그레이션 전] 옛 로그인 화면으로 물러난다");
  // 앱을 먼저 배포하고 SQL 을 나중에 돌리는 순서라, 그 사이에도 앱이 돌아야 한다.
  ({ w, log } = await session({ noMigration: true }));
  ok("생일 화면을 띄우지 않음", screenOf(w) === "screen-join", false);
  ok("옛 로그인 화면으로 감", screenOf(w), "screen-auth");
  ok("명단을 물어보긴 함", log.filter((l) => l.call === "room_seats").length, 1);

  console.log(failures ? "\n" + failures + "개 실패" : "\n전부 통과");
  process.exit(failures ? 1 : 0);
})();
