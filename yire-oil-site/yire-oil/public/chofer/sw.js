// Service worker for the driver page: shows booking notifications and opens the right day when tapped.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  // iOS requires every push to show a notification.
  event.waitUntil(self.registration.showNotification(data.title || "Yire Oil", {
    body: data.body || "",
    icon: "/logo.jpg",
    tag: data.tag,
    data: { url: data.url || "/chofer/" }
  }));
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
