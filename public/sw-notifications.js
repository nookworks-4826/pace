/* Optional generic push messages. No financial data or decryption keys are used here. */
self.addEventListener('activate', event => {
  // OCR code changes need a fresh static cache. No IndexedDB/user records are touched.
  event.waitUntil(caches.keys().then(names => Promise.all(names
    .filter(name => name.startsWith('pace-ocr-static-') && name !== 'pace-ocr-static-v7-2.2.0')
    .map(name => caches.delete(name)))));
});
self.addEventListener('push', event => {
  event.waitUntil(self.registration.showNotification('今日のPaceを確認してください', {
    tag: 'pace-daily', icon: new URL('icon-sunny-192.png', self.registration.scope).href,
    data: { url: self.registration.scope }
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async clients => {
    const client=clients.find(c=>c.url.startsWith(self.registration.scope));
    if(client)return client.focus();return self.clients.openWindow(self.registration.scope);
  }));
});
