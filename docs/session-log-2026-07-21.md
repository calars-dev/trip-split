# 작업 로그 — 2026-07-21 (trip-split 최초 제작·배포)

친구 5명 여행 정산 웹앱을 하룻밤 핸드오프로 0에서 만들어 공개 배포까지 완료.

## 한 일 (완료)

- **설계 확정** — 입력 우선 UX, 로그인 없음(링크+이름), 실시간 동기화, 원/엔 통화별
  분리 정산. 설계 문서: `docs/superpowers/specs/2026-07-21-trip-split-design.md`.
- **앱 구현** — 단일 페이지(`index.html`+`app.js`), Supabase(Postgres+Realtime).
  supabase-js는 `vendor/`에 vendoring(런타임 CDN 의존 0).
- **DB 세팅** — 브라우저로 Supabase SQL Editor에서 `schema.sql` 실행(테이블·RLS·
  Realtime), anon GRANT 추가, `settled` 컬럼(현장정산) 추가. 전부 "Success" 확인.
- **엔드투엔드 검증** — 방 생성→멤버→지출 저장이 실제 DB에 기록됨을 확인, 테스트
  데이터는 삭제.
- **추가 기능** — ①내 여행 목록(총무 폰 localStorage) ②현장정산 완료→최종정산 제외.
- **폴더 정리** — `Documents\Claude\trip-split` → `Documents\Claude\Web\trip-split`.
  개인 웹앱은 `Web\` 밑에 두기로 정함.
- **배포** — `calars-dev` 계정으로 GitHub Pages. 배포 후 `farax-creative`로 복귀.
  라이브: https://calars-dev.github.io/trip-split/ (200 확인).

## 금지·주의 사항

- 🔴 **계정 전환 구간 주의** — 배포는 `gh auth switch`로 farax→calars-dev 전환이 필요.
  다른 세션이 farax 저장소를 쓰는 중이면 위험. 이번엔 전환→배포→즉시 복귀로 처리.
- ⚠️ **폴더 이동은 robocopy로** — 세션이 상위 작업폴더를 파일감시해 `trip-split`
  디렉토리 rename/mv가 "액세스 거부"로 막힘. `robocopy /E /MOVE`는 성공(파일 미잠금).
- ⚠️ **config.js의 anon 키는 공개용** — public 저장소에 있어도 안전. 위협모델: 링크
  아는 사람은 그 방 데이터 열람·수정 가능(친구 여행용, 의도됨). DB 비번은 별개, 미노출.
- ⚠️ **로컬 http.server(8777)는 Windows에서 pkill로 안 죽음** — 폴더 잠금 유발.
  `Stop-Process`로 확실히 종료할 것.

## 다음 할 일 (선택)

1. CLAUDE.md에 "개인 웹앱은 `Web\`에 둔다" 규칙 명문화 — 사용자 승인 대기(규칙 변경).
2. 정산 결과에 계좌번호/카톡송금 링크 붙이기 — 요청 시.
3. 방 이름 인앱 수정 UI(현재 스키마는 지원, UI 미노출).

## 상태 변화 (이 세션)

- GitHub: `github.com/calars-dev/trip-split`(public) 생성·푸시, Pages 활성화(main/root).
- Supabase(project `imwzgmfugixjlaxgkhde`): 테이블 3종·RLS·Realtime·GRANT·settled 컬럼 생성.
