// No conversation/API caching. Background execution belongs to the Ubuntu service.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
