// Service worker for the driver page: shows booking notifications, counts them on the app icon
// (red badge, "new since last opened"), and opens the right day when tapped.

// Take over right away when this file changes, instead of waiting for every window to close.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// The unread count lives in the Cache API so the page can reset it too (same key in index.html).
const BADGE_CACHE = "yire-badge";
const BADGE_KEY = "/chofer/__badge";
async function bumpBadge() {
  const cache = await caches.open(BADGE_CACHE);
  const stored = await cache.match(BADGE_KEY);
  const count = (stored ? Number(await stored.text()) || 0 : 0) + 1;
  await cache.put(BADGE_KEY, new Response(String(count)));
  // iPhone shows the badge only for the home-screen app with notifications allowed.
  if ("setAppBadge" in self.navigator) await self.navigator.setAppBadge(count).catch(() => {});
}

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  // iOS requires every push to show a notification.
  event.waitUntil(Promise.all([
    self.registration.showNotification(data.title || "Yire Oil", {
      body: data.body || "",
      icon: "/logo.jpg",
      tag: data.tag,
      data: { url: data.url || "/chofer/" }
    }),
    bumpBadge().catch(() => {})
  ]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/chofer/", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((client) => new URL(client.url).pathname.startsWith("/chofer"));
    if (open) {
      await open.focus();
      return open.navigate(url).catch(() => {});
    }
    return self.clients.openWindow(url);
  })());
});
