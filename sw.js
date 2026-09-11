// Service worker: here only to show "새 지출" notifications and open the expense
// they name. There is deliberately NO fetch handler — nothing is ever cached, so the
// old rule still holds: a bug fixed on the server reaches every phone on its next
// load, instead of living on in one phone's stale copy.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let msg;
  try { msg = event.data ? event.data.json() : {}; }
  catch (_) { msg = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(msg.title || "이시가키 정산", {
    body: msg.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: msg.url || "trip-split",          // the same expense twice replaces, never stacks
    data: { url: msg.url || "./" },
  }));
});

// Tap: bring the app forward on that expense, or open it there.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "./",
    self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    const win = wins.find((w) => "focus" in w);
    if (!win) return self.clients.openWindow(url);
    // Safari may not offer navigate() on an open window: the page moves itself instead.
    if ("navigate" in win) {
      return win.navigate(url).then((w) => (w || win).focus()).catch(() => self.clients.openWindow(url));
    }
    win.postMessage({ open: url });
    return win.focus();
  }));
});
