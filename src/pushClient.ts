// Client-side push notification registration.
// Checks VAPID support, registers service worker, subscribes to push.

import { api } from './api';

export async function registerPushNotifications(): Promise<void> {
  // Check if the browser supports notifications and push
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return;
  }

  // Only subscribe if user has granted notification permission
  if (Notification.permission !== 'granted') {
    // Don't auto-request; let SettingsModal handle permission request
    return;
  }

  try {
    // Check if server has VAPID configured
    const { enabled, publicKey } = await api.getVapidPublicKey();
    if (!enabled || !publicKey) return;

    const registration = await navigator.serviceWorker.ready;

    // Check existing subscription
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      // Verify it's still valid by pinging the server
      return;
    }

    // Convert VAPID key
    const applicationServerKey = urlBase64ToUint8Array(publicKey);

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey as BufferSource,
    });

    // Send to server
    const sub = subscription.toJSON();
    if (sub.endpoint && sub.keys) {
      await api.subscribePush({
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh || '',
        auth: sub.keys.auth || '',
      });
    }
  } catch (err) {
    console.warn('[push] registration failed:', err);
  }
}

export async function unregisterPushNotifications(): Promise<void> {
  try {
    if (!('serviceWorker' in navigator)) return;
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await api.unsubscribePush(endpoint);
  } catch (err) {
    console.warn('[push] unregistration failed:', err);
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
