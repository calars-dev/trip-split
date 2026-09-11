// Supabase connection — anon key is public-safe (protected by link-based access model).
window.TRIP_SPLIT_CONFIG = {
  // 이 배포는 이시가키 여행 하나에만 쓴다. 주소에 ?r= 이 없고 기기가 기억하는 여행도
  // 없으면 여기로 보낸다 — 홈 화면 아이콘, 북마크, 주소 직접 입력이 전부 여기 걸린다.
  // 비워두면 예전처럼 로그인 화면으로 간다.
  DEFAULT_ROOM: "qx73ifx",
  // 새 지출 알림(Web Push)의 공개키. 이름 그대로 공개해도 되는 값이다 — 짝이 되는
  // 비밀키는 Supabase 시크릿(VAPID_PRIVATE_KEY)에만 있다.
  VAPID_PUBLIC_KEY: "BL91OAAVEer2NJ7lHo-miQ58i57wG37it68FjOe3PE4mhwYd5f7_BuOBjfjnb-IWewS1a5TLvGkaDZw5uEdqP0k",
  SUPABASE_URL: "https://imwzgmfugixjlaxgkhde.supabase.co",
  SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltd3pnbWZ1Z2l4amxheGdraGRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NjAyMTYsImV4cCI6MjEwMDEzNjIxNn0.GaXM1dSLuoFJ2PWjFSsvTmqchW_UzwGxikl01FdG30k",
};
