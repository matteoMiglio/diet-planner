import { api } from './api';

export type PushSupport = 'supported' | 'needs_install' | 'unsupported';

/** iOS only allows web push for apps added to the Home Screen. */
export function pushSupport(): PushSupport {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return 'unsupported';
  if ('PushManager' in window) return 'supported';
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone = globalThis.matchMedia('(display-mode: standalone)').matches;
  return ios && !standalone ? 'needs_install' : 'unsupported';
}

function base64UrlToBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64Url + '='.repeat((4 - (base64Url.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'supported') return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

/** Asks for permission (must run from a tap), subscribes this device and registers it. */
export async function enablePush(publicKey: string): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked. Allow them for this app in iOS Settings → Notifications.'
        : 'Notifications were not allowed.',
    );
  }
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(publicKey),
    }));
  const json = subscription.toJSON();
  await api.post('/push/subscriptions', {
    endpoint: json.endpoint,
    keys: json.keys,
    deviceLabel: /iPhone/.test(navigator.userAgent) ? 'iPhone' : navigator.platform || 'Browser',
  });
}

export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await api.delete('/push/subscriptions', { endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}
