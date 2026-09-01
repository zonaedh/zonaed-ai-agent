// ============================================================================
// Zonaed AI service worker (plan §4 /push, Priority 10)
//
// Minimal, dependency-free: push event -> notification; click -> focus/open
// /tasks (or the payload's url). No fetch handler on purpose — app caching is
// handled by Next.js; intercepting fetches here would risk stale offline UX.
// ============================================================================

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = { title: "Zonaed AI", body: "Notification", url: "/", tag: "generic" };
  try {
    if (event.data) {
      const parsed = event.data.json();
      payload = {
        title: typeof parsed.title === "string" ? parsed.title : payload.title,
        body: typeof parsed.body === "string" ? parsed.body : payload.body,
        url: typeof parsed.url === "string" ? parsed.url : payload.url,
        tag: typeof parsed.tag === "string" ? parsed.tag : payload.tag,
      };
    }
  } catch {
    // Non-JSON push — fall through with defaults rather than swallowing the
    // notification silently.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: payload.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Focus an existing window and navigate it if it isn't already there.
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          return client.focus().then((focused) => {
            if ("navigate" in focused && !client.url.includes(target)) {
              return focused.navigate(target);
            }
            return focused;
          });
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
