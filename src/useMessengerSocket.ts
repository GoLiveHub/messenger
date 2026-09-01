import { useEffect } from 'react';
import { connectSocket, type ChatEvents } from './socket';
import {
  store,
  mergeMessage,
  replacePending,
  updateMessage,
  removeMessage,
  markChatRead,
  updateMessageReactions,
  setGroupMembers,
  upsertUser,
  type ActiveCallState,
} from './store';
import { playNotificationSound } from './sound';

const BASE_TITLE = document.title;

// Chats opened right after their creation should not trigger a "New message"
// notification/toast (the chat is already open in front of the user).
const chatAutoOpened = new Map<number, number>();
const AUTO_OPEN_QUIET_MS = 4000;

// Hold a peer "online" briefly after their socket drops so transient
// disconnects (mobile backgrounding) don't flap the online indicator.
const PRESENCE_OFFLINE_GRACE_MS = 90_000;
const presenceOfflineTimers = new Map<number, ReturnType<typeof setTimeout>>();

// Buffer the most recent WebRTC offer per call. The offer often arrives in the
// same socket burst as "call:ringing", i.e. BEFORE CallWindow has mounted and
// registered its "webrtc:offer" listener — without this buffer Bob would never
// see the offer and the call would stay at "Connecting" forever.
let pendingCallOffers = new Map<string, RTCSessionDescriptionInit>();

export function consumePendingCallOffer(callId: string): RTCSessionDescriptionInit | null {
  const offer = pendingCallOffers.get(callId) ?? null;
  pendingCallOffers.delete(callId);
  return offer;
}

export function markChatAutoOpened(chatId: number) {
  chatAutoOpened.set(chatId, Date.now());
  setTimeout(() => chatAutoOpened.delete(chatId), AUTO_OPEN_QUIET_MS + 500);
}

export function resetTitle() {
  document.title = BASE_TITLE;
}

export function useMessengerSocket(_token?: string) {
  useEffect(() => {
    if (!_token) return;

    const handlers: ChatEvents = {
      'message:new': (m) => {
        if (m.sender_user) upsertUser(m.sender_user as Parameters<typeof upsertUser>[0]);
        // ignore echoes of our own pending messages
        const st = store.get();
        const existing = (st.messages[m.chat_id] ?? []).find(
          (x) => x.pending && m.client_id && x.client_id === m.client_id,
        );
        if (existing && existing.sender_id === m.sender_id) {
          // Echo of our own optimistic message: replace wholesale so the
          // message adopts the real id / delivered_at and pending is cleared.
          replacePending(m.chat_id, existing.id, m);
        } else {
          mergeMessage(m);
        }
        const mine = m.sender_id === st.me?.id;
        const active = st.activeChatId === m.chat_id;
        const justCreated = chatAutoOpened.has(m.chat_id);
        if (!st.chats.some((chat) => chat.chat.id === m.chat_id)) {
          void import('./api').then(({ api }) => api.getChats()).then((chats) => store.set({ chats })).catch(() => {});
        }
        if (!mine) {
          const notifications = st.me?.settings?.notifications ?? { enabled: true, sound: true };
          const chatEntry = st.chats.find((c) => c.chat.id === m.chat_id);
          const notifyLevel = chatEntry?.notify_level ?? 'all';
          const mentionsOnly = notifyLevel === 'mentions';
          const mentionsNone = notifyLevel === 'none';
          const isMention = m.text?.includes(`@${st.me?.username}`) || m.text?.includes(`@${[st.me?.first_name, st.me?.last_name].filter(Boolean).join(' ')}`);
          const shouldNotify = !m.service && !mentionsNone && (!mentionsOnly || isMention);
          if (shouldNotify && notifications.enabled !== false && notifications.sound !== false && st.activeChatId !== m.chat_id && !justCreated) {
            playNotificationSound();
          }
          // flash title when tab hidden
          if (document.hidden) {
            document.title = `(1) ${BASE_TITLE}`;
          }
          // browser Notification when tab hidden or viewing another chat
          if (shouldNotify && notifications.enabled !== false && !justCreated && (document.hidden || st.activeChatId !== m.chat_id)) {
            const senderName = m.sender_user
              ? [m.sender_user.first_name, m.sender_user.last_name].filter(Boolean).join(' ') || 'Unknown'
              : 'Unknown';
            const title = st.chats.find((c) => c.chat.id === m.chat_id)?.chat.title ?? senderName;
            if ('Notification' in window && Notification.permission === 'granted') {
              const n = new Notification(title, {
                body: m.text?.slice(0, 200) || (m.media ? `[${m.media.kind}]` : ''),
                icon: '/icon-192.png',
                tag: `msg-${m.id}`,
              } as NotificationOptions);
              n.onclick = () => {
                window.focus();
                store.set({ activeChatId: m.chat_id });
                n.close();
              };
            }
          }
        }
        // update chat list preview + time
        store.set({
          chats: st.chats.map((c) =>
            c.chat.id === m.chat_id
              ? {
                  ...c,
                  last_message: {
                    id: m.id,
                    sender_id: m.sender_id,
                    created_at: m.created_at,
                    preview: m.text ?? '',
                    media_kind: m.media?.kind ?? null,
                    read_at: m.read_at,
                  },
                  unread: !mine && !active ? c.unread + 1 : c.unread,
                }
              : c,
          ),
        });
        bumpChat(m.chat_id);
        // if the active chat, mark as read
        if (st.activeChatId === m.chat_id && m.sender_id !== st.me?.id) {
          sendReadUpTo(m.chat_id, m.id);
        }
      },
      presence: (p) => {
        // Add a short grace period before flipping a peer to "offline":
        // mobile/backgrounded tabs briefly drop their socket, which would
        // otherwise make the online indicator flap inconsistently.
        const timers = presenceOfflineTimers;
        const existing = timers.get(p.userId);
        if (existing) {
          clearTimeout(existing);
          timers.delete(p.userId);
        }
        if (p.online) {
          const online = { ...store.get().online, [p.userId]: true };
          store.set({ online });
        } else {
          const t = setTimeout(() => {
            timers.delete(p.userId);
            const online = { ...store.get().online, [p.userId]: false };
            store.set({ online });
          }, PRESENCE_OFFLINE_GRACE_MS);
          timers.set(p.userId, t);
        }
      },
      typing: (p) => {
        const typing = { ...store.get().typing, [p.chatId]: { userId: p.userId, isTyping: p.isTyping } };
        store.set({ typing });
      },
      recording: (p) => {
        const recording = { ...store.get().recording, [p.chatId]: { userId: p.userId, isRecording: p.isRecording } };
        store.set({ recording });
      },
      'message:read': (p) => {
        markChatRead(p.chatId, p.messageId, p.userId, p.read_at ?? new Date().toISOString());
      },
      'message:delivered': (p) => {
        updateMessage(p.chatId, p.messageId, { delivered_at: p.delivered_at });
      },
      'message:edited': (p) => {
        updateMessage(p.chatId, p.messageId, { text: p.text, edited_at: new Date().toISOString() });
        bumpChat(p.chatId);
      },
      'message:deleted': (p) => {
        removeMessage(p.chatId, p.messageId);
      },
      'message:reaction': (p) => {
        updateMessageReactions(p.chatId, p.messageId, p.reactions);
      },
      'history:cleared': ({ chatId }) => {
        const st = store.get();
        store.set({
          messages: { ...st.messages, [chatId]: [] },
          chats: st.chats.map((chat) =>
            chat.chat.id === chatId
              ? { ...chat, last_message: null, unread: 0, chat: { ...chat.chat, pinned_id: null } }
              : chat,
          ),
        });
      },
      'group:updated': (info) => {
        const st = store.get();
        const entry = info.chat;
        info.members.forEach((m) => upsertUser(m.user));
        const exists = st.chats.some((c) => c.chat.id === entry.chat.id);
        const chats = exists
          ? st.chats.map((c) => (c.chat.id === entry.chat.id ? entry : c))
          : [entry, ...st.chats];
        store.set({ chats });
        setGroupMembers(entry.chat.id, info.members);
      },
      'group:added': (info) => {
        const st = store.get();
        const entry = info.chat;
        info.members.forEach((m) => upsertUser(m.user));
        const chats = st.chats.some((c) => c.chat.id === entry.chat.id)
          ? st.chats.map((c) => (c.chat.id === entry.chat.id ? entry : c))
          : [entry, ...st.chats];
        store.set({ chats });
        setGroupMembers(entry.chat.id, info.members);
      },
      'chat:added': (entry) => {
        const st = store.get();
        const chats = st.chats.some((chat) => chat.chat.id === entry.chat.id)
          ? st.chats.map((chat) => (chat.chat.id === entry.chat.id ? entry : chat))
          : [entry, ...st.chats];
        if (entry.peer) upsertUser(entry.peer);
        store.set({ chats });
      },
      'chat:removed': ({ chatId }) => {
        const st = store.get();
        const chats = st.chats.filter((c) => c.chat.id !== chatId);
        const patch: Parameters<typeof store.set>[0] = { chats };
        if (st.activeChatId === chatId) patch.activeChatId = null;
        store.set(patch);
      },
      'chat:updated': ({ chatId, pinned_id, pinned }) => {
        const st = store.get();
        const chats = st.chats.map((c) => {
          if (c.chat.id !== chatId) return c;
          const next: typeof c = { ...c };
          if (pinned_id !== undefined) next.chat = { ...c.chat, pinned_id };
          if (pinned !== undefined) next.pinned = pinned;
          return next;
        });
        store.set({ chats });
      },
      'call:ringing': (p) => {
        store.set({
          activeCall: {
            callId: p.callId,
            chatId: p.chatId,
            callType: p.callType,
            callerId: p.callerId,
            callerName: p.callerName,
            direction: 'incoming',
            status: 'ringing',
          },
        });
        if ('Notification' in window && Notification.permission === 'granted') {
          try {
            const n = new Notification(p.callerName, {
              body: p.callType === 'video' ? 'Incoming video call…' : 'Incoming voice call…',
              icon: '/icon-192.png',
              tag: `call-${p.callId}`,
            } as NotificationOptions);
            n.onclick = () => { window.focus(); n.close(); };
          } catch {
            // Notification construction can throw (e.g. some mobile browsers);
            // never let it break the incoming-call UI.
          }
        }
      },
      'call:initiated': (p) => {
        const st = store.get();
        if (st.activeCall && st.activeCall.direction === 'outgoing' && st.activeCall.chatId === p.chatId) {
          store.set({ activeCall: { ...st.activeCall, callId: p.callId } });
        }
      },
      'call:accepted': (p) => {
        const st = store.get();
        if (st.activeCall?.callId === p.callId) {
          store.set({ activeCall: { ...st.activeCall, status: 'connecting' } });
        }
      },
      'call:rejected': (p) => {
        const st = store.get();
        if (st.activeCall?.callId === p.callId) {
          store.set({ activeCall: null });
        }
      },
      'call:ended': (p) => {
        const st = store.get();
        if (st.activeCall?.callId === p.callId) {
          store.set({ activeCall: null });
        }
      },
      'call:offer': (_p) => {
        // Buffer so CallWindow can pick it up even if it hasn't mounted yet
        // (offer arrives in the same burst as call:ringing). CallWindow clears
        // it via consumePendingCallOffer.
        pendingCallOffers.set(_p.callId, _p.sdp as RTCSessionDescriptionInit);
        window.dispatchEvent(new CustomEvent('webrtc:offer', { detail: _p }));
      },
      'call:answer': (_p) => {
        window.dispatchEvent(new CustomEvent('webrtc:answer', { detail: _p }));
      },
      'call:ice-candidate': (_p) => {
        window.dispatchEvent(new CustomEvent('webrtc:ice-candidate', { detail: _p }));
      },
      'group-call:participant-joined': (_p) => {
        window.dispatchEvent(new CustomEvent('groupcall:participant-joined', { detail: _p }));
      },
      'group-call:participant-left': (_p) => {
        window.dispatchEvent(new CustomEvent('groupcall:participant-left', { detail: _p }));
      },
      'group-call:offer': (_p) => {
        window.dispatchEvent(new CustomEvent('groupcall:offer', { detail: _p }));
      },
      'group-call:answer': (_p) => {
        window.dispatchEvent(new CustomEvent('groupcall:answer', { detail: _p }));
      },
      'group-call:ice-candidate': (_p) => {
        window.dispatchEvent(new CustomEvent('groupcall:ice-candidate', { detail: _p }));
      },
    };

    const connected = connectSocket('', handlers);
    return () => {
      connected.disconnect();
    };
  }, [_token]);

  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) resetTitle();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Track socket connection state
  useEffect(() => {
    const onConnected = () => store.set({ socketConnected: true });
    const onDisconnected = () => store.set({ socketConnected: false });
    window.addEventListener('messenger:socket-connected', onConnected);
    window.addEventListener('messenger:socket-disconnected', onDisconnected);
    return () => {
      window.removeEventListener('messenger:socket-connected', onConnected);
      window.removeEventListener('messenger:socket-disconnected', onDisconnected);
    };
  }, []);
}

function bumpChat(chatId: number) {
  const st = store.get();
  const chats = [...st.chats];
  const idx = chats.findIndex((c) => c.chat.id === chatId);
  if (idx >= 0) {
    const [chat] = chats.splice(idx, 1);
    chats.unshift(chat);
    store.set({ chats });
  }
}

function sendReadUpTo(chatId: number, messageId: number) {
  import('./socket').then(({ sendRead }) => sendRead(chatId, messageId));
}
