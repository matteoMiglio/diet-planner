/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | { url: string })[] };

// App shell: precache the build and answer navigations with index.html. The API is never
// touched by the service worker.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }),
);

self.skipWaiting();
clientsClaim();

interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

self.addEventListener('push', (event) => {
  let payload: PushPayload = { title: 'Diet', body: '', url: '/', tag: 'diet' };
  try {
    payload = { ...payload, ...(event.data?.json() as Partial<PushPayload>) };
  } catch {
    payload.body = event.data?.text() ?? '';
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      icon: '/pwa-192x192.png',
      badge: '/pwa-64x64.png',
      data: { url: payload.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(
    (event.notification.data as { url?: string })?.url ?? '/',
    self.location.origin,
  );
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === url.origin);
      if (open) {
        await open.focus();
        await open.navigate(url.href);
      } else {
        await self.clients.openWindow(url.href);
      }
    })(),
  );
});
