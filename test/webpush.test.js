// 알림 암호화가 리뷰 허브와 한 바이트도 다르지 않은지.
//
// 알림은 폰 하나만 풀 수 있게 암호화되어 애플·구글 푸시 서비스를 지나간다(RFC 8291).
// 이게 한 바이트라도 틀리면 서비스는 받아주는데 폰이 조용히 버린다 — 에러도 없이.
// 그래서 이미 실제 아이폰에서 도는 review_hub/push.py 로 만든 고정 벡터에 맞춘다.
// 벡터: test/fixtures/webpush-vector.json (테스트 전용 키)
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

let failures = 0;
const ok = (name, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures++;
  console.log((pass ? "  PASS  " : "  FAIL  ") + name);
  if (!pass) console.log("          기대: " + JSON.stringify(want).slice(0, 160) +
    "\n          실제: " + JSON.stringify(got).slice(0, 160));
};

(async () => {
  const wp = await import(pathToFileURL(path.join(__dirname, "..",
    "supabase", "functions", "notify-expense", "webpush.mjs")).href);
  const vec = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "webpush-vector.json"), "utf8"));

  console.log("[암호화] push.py 와 같은 입력이면 같은 바이트");
  const body = await wp.encrypt(wp.unb64u(vec.payload_b64u), vec.p256dh, vec.auth,
    { salt: vec.salt, sender: vec.sender });
  ok("길이가 같다", body.length, wp.unb64u(vec.expected_b64u).length);
  ok("바이트가 같다", wp.b64u(body), vec.expected_b64u);
  ok("머리: salt 16 + 레코드 4096 + 키 길이 65",
    [body.slice(0, 16).length, new DataView(body.buffer, body.byteOffset).getUint32(16), body[20]],
    [16, 4096, 65]);

  console.log("\n[암호화] 실제 전송처럼 매번 무작위면 매번 다르다");
  const a = await wp.encrypt(new TextEncoder().encode("x"), vec.p256dh, vec.auth);
  const b = await wp.encrypt(new TextEncoder().encode("x"), vec.p256dh, vec.auth);
  ok("같은 내용이라도 두 번은 다르다 (salt·임시키가 새로)", wp.b64u(a) === wp.b64u(b), false);

  console.log("\n[VAPID] 푸시 서비스에 보낼 서명");
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const header = await wp.vapidAuth("https://web.push.apple.com/QGuYv/abc", "https://calars-dev.github.io",
    wp.b64u(pub), jwk.d, 1900000000);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  ok("형식: vapid t=<jwt>, k=<공개키>", !!m, true);
  const claims = JSON.parse(new TextDecoder().decode(wp.unb64u(m[2])));
  ok("aud 는 푸시 서비스 오리진만", claims.aud, "https://web.push.apple.com");
  ok("sub 는 보내는 쪽", claims.sub, "https://calars-dev.github.io");
  ok("k 는 공개키 그대로", m[4], wp.b64u(pub));
  const sig = wp.unb64u(m[3]);
  ok("서명은 r||s 64바이트 (JWT ES256)", sig.length, 64);
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, sig,
    new TextEncoder().encode(m[1] + "." + m[2]));
  ok("공개키로 서명이 풀린다", valid, true);

  console.log("\n" + (failures ? failures + "건 실패" : "전부 통과"));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
