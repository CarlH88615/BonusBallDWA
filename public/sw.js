self.addEventListener("push", (event) => {
  console.log("[sw] push event received");

  let data = {};
  if (event.data) {
    const text = event.data.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = { title: "Notification", body: text };
    }
  }

  const title = data.title || "Notification";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow("/"));
});
