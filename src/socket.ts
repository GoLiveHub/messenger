import { io, Socket } from 'socket.io-client';
import type { MediaDTO, ReactionGroup, ForwardInfo, ChatInfoDTO } from './api';
import { enqueueSync, type SyncAction } from './offlineDb';

export interface SenderUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  photo?: string | null;
}

export interface IncomingMessage {
  id: number;
  chat_id: number;
  sender_id: number;
  client_id?: string | null;
  sender_user?: SenderUser | null;
  created_at: string;
  read_at?: string | null;
  delivered_at?: string | null;
  service?: boolean | number;
  edited_at?: string | null;
  text?: string;
  cipher?: string;
  iv?: string;
  media?: MediaDTO | null;
  reply_to?: number | null;
  forwarded_from?: ForwardInfo | null;
  reactions?: ReactionGroup[];
  expires_at?: string | null;
  topic_id?: number | null;
  pending?: boolean;
  link_preview?: { url: string; title: string | null; description: string | null; image: string | null } | null;
}

export interface ChatEvents {
  'message:new': (m: IncomingMessage) => void;
  presence: (p: { userId: number; online: boolean }) => void;
  typing: (p: { chatId: number; userId: number; isTyping: boolean }) => void;
  recording: (p: { chatId: number; userId: number; isRecording: boolean }) => void;
  'message:read': (p: { chatId: number; messageId: number; userId: number; read_at?: string }) => void;
  'message:edited': (p: { chatId: number; messageId: number; text: string }) => void;
  'message:deleted': (p: { chatId: number; messageId: number }) => void;
  'message:reaction': (p: { chatId: number; messageId: number; reactions: ReactionGroup[] }) => void;
  'message:delivered': (p: { chatId: number; messageId: number; delivered_at: string }) => void;
  'history:cleared': (p: { chatId: number }) => void;
  'group:updated': (info: ChatInfoDTO) => void;
  'group:added': (info: ChatInfoDTO) => void;
  'chat:added': (chat: ChatInfoDTO['chat']) => void;
  'chat:removed': (p: { chatId: number }) => void;
  'chat:updated': (p: { chatId: number; pinned_id?: number | null; pinned?: boolean; pinned_messages?: number[] }) => void;
  'call:ringing': (p: { callId: string; chatId: number; callType: 'audio' | 'video'; callerId: number; callerName: string }) => void;
  'call:initiated': (p: { callId: string; chatId: number; callType: 'audio' | 'video' }) => void;
  'call:accepted': (p: { callId: string }) => void;
  'call:rejected': (p: { callId: string }) => void;
  'call:ended': (p: { callId: string }) => void;
  'call:offer': (p: { callId: string; sdp: RTCSessionDescriptionInit }) => void;
  'call:answer': (p: { callId: string; sdp: RTCSessionDescriptionInit }) => void;
  'call:ice-candidate': (p: { callId: string; candidate: RTCIceCandidateInit }) => void;
  'group-call:participant-joined': (p: { chatId: number; userId: number; callType: string }) => void;
  'group-call:participant-left': (p: { chatId: number; userId: number }) => void;
  'group-call:offer': (p: { chatId: number; fromId: number; sdp: RTCSessionDescriptionInit }) => void;
  'group-call:answer': (p: { chatId: number; fromId: number; sdp: RTCSessionDescriptionInit }) => void;
  'group-call:ice-candidate': (p: { chatId: number; fromId: number; candidate: RTCIceCandidateInit }) => void;
}

let socket: Socket | null = null;

/**
 * Connect Socket.IO with cookie-based authentication.
 * The browser automatically sends the session cookie with `withCredentials: true`.
 */
export function connectSocket(_token: string, handlers: ChatEvents): Socket {
  socket?.disconnect();
  socket = io('/', {
    withCredentials: true,
    timeout: 10_000,
  });
  (Object.keys(handlers) as (keyof ChatEvents)[]).forEach((event) => {
    socket!.on(event as string, handlers[event] as never);
  });
  const authFailed = (error: unknown) => {
    if (String((error as Error)?.message ?? error).toLowerCase().includes('unauthorized')) {
      window.dispatchEvent(new Event('messenger:unauthorized'));
    }
  };
  socket.on('connect_error', authFailed);
  socket.on('error', authFailed);
  // Flush offline sync queue on reconnect
  socket.on('connect', async () => {
    window.dispatchEvent(new Event('messenger:socket-connected'));
    // Re-join active chat room on reconnect
    try {
      const { store } = await import('./store');
      const activeChatId = store.get().activeChatId;
      if (activeChatId) {
        socket!.emit('chat:join', activeChatId);
        // Re-emit read receipts for active chat
        const msgs = store.get().messages[activeChatId] ?? [];
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg) socket!.emit('message:read', { chatId: activeChatId, lastMessageId: lastMsg.id });
      }
    } catch { /* ignore */ }
    try {
      const { getSyncQueue, dequeueSync } = await import('./offlineDb');
      const queue = await getSyncQueue();
      for (const action of queue) {
        try {
          if (action.type === 'message:send') {
            // Wait for server ack before removing from queue
            const ok = await new Promise<boolean>((resolve) => {
              socket!.timeout(15_000).emit('message:send', action.payload, (err: Error | null, res?: { ok?: boolean }) => {
                resolve(!err && res?.ok !== false);
              });
            });
            if (ok) await dequeueSync(action.id);
            // If not ok, leave in queue for next reconnect
          } else {
            // Unknown action type — remove to prevent infinite retry
            await dequeueSync(action.id);
          }
        } catch { /* leave in queue for next attempt */ }
      }
    } catch { /* ignore */ }
  });
  socket.on('disconnect', () => {
    window.dispatchEvent(new Event('messenger:socket-disconnected'));
  });
  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function sendMessage(payload: {
  chatId: number;
  text?: string;
  cipher?: string;
  iv?: string;
  mediaId?: number;
  replyTo?: number;
  forwardMessageId?: number;
  clientId?: string;
  expiresIn?: number; // seconds
  topicId?: number; // forum topic
}): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (!socket || !socket.connected) {
      // Offline: queue for later
      enqueueSync({ type: 'message:send', payload: payload as unknown as Record<string, unknown>, chatId: payload.chatId, created_at: new Date().toISOString() }).catch(() => {});
      // Return a fake message for optimistic UI
      const fake: IncomingMessage = {
        id: -Date.now(),
        chat_id: payload.chatId,
        sender_id: 0,
        created_at: new Date().toISOString(),
        text: payload.text as string,
        pending: true,
      };
      return resolve(fake);
    }
    socket.timeout(15_000).emit('message:send', payload, (timeoutError: Error | null, res?: { ok: boolean; message?: IncomingMessage; error?: string }) => {
      if (timeoutError) return reject(new Error('Server did not confirm the message. Please retry.'));
      if (!res) return reject(new Error('Invalid server response'));
      if (res.ok && res.message) resolve(res.message);
      else reject(new Error(res.error || 'Send failed'));
    });
  });
}

export function sendReact(chatId: number, messageId: number, emoji: string): Promise<ReactionGroup[]> {
  return new Promise((resolve, reject) => {
    if (!socket) return reject(new Error('Not connected'));
    socket.timeout(10_000).emit('message:react', { chatId, messageId, emoji }, (timeoutError: Error | null, res?: { ok: boolean; reactions?: ReactionGroup[]; error?: string }) => {
      if (timeoutError) return reject(new Error('Reaction timed out'));
      if (!res) return reject(new Error('Invalid server response'));
      if (res.ok && res.reactions) resolve(res.reactions);
      else reject(new Error(res.error || 'React failed'));
    });
  });
}

export function sendTyping(chatId: number, isTyping: boolean) {
  socket?.emit('typing', { chatId, isTyping });
}

export function signalRecording(chatId: number, isRecording: boolean) {
  socket?.emit('recording', { chatId, isRecording });
}

export function joinChat(chatId: number) {
  socket?.emit('chat:join', chatId);
}

export function sendRead(chatId: number, messageId: number) {
  socket?.emit('message:read', { chatId, messageId });
}

export function editMessage(chatId: number, messageId: number, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!socket) return reject(new Error('Not connected'));
    socket.timeout(10_000).emit('message:edit', { chatId, messageId, text }, (timeoutError: Error | null, res?: { ok: boolean; error?: string }) => {
      if (timeoutError) return reject(new Error('Edit timed out'));
      if (!res) return reject(new Error('Invalid server response'));
      if (res.ok) resolve();
      else reject(new Error(res.error || 'Edit failed'));
    });
  });
}

export function deleteMessage(chatId: number, messageId: number, forMe = false): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!socket) return reject(new Error('Not connected'));
    socket.timeout(10_000).emit('message:delete', { chatId, messageId, forMe }, (timeoutError: Error | null, res?: { ok: boolean; error?: string }) => {
      if (timeoutError) return reject(new Error('Delete timed out'));
      if (!res) return reject(new Error('Invalid server response'));
      if (res.ok) resolve();
      else reject(new Error(res.error || 'Delete failed'));
    });
  });
}

export function pinMessage(chatId: number, messageId: number | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!socket) return reject(new Error('Not connected'));
    socket.timeout(10_000).emit('message:pin', { chatId, messageId }, (timeoutError: Error | null, res?: { ok: boolean; error?: string }) => {
      if (timeoutError) return reject(new Error('Pin request timed out'));
      if (!res) return reject(new Error('Invalid server response'));
      if (res.ok) resolve();
      else reject(new Error(res.error || 'Pin failed'));
    });
  });
}

export function initCall(chatId: number, callType: 'audio' | 'video') {
  socket?.emit('call:init', { chatId, callType });
}

export function acceptCall(callId: string) {
  socket?.emit('call:accept', { callId });
}

export function rejectCall(callId: string) {
  socket?.emit('call:reject', { callId });
}

export function endCall(callId: string) {
  socket?.emit('call:end', { callId });
}

export function sendCallOffer(callId: string, sdp: RTCSessionDescriptionInit) {
  socket?.emit('call:offer', { callId, sdp });
}

export function sendCallAnswer(callId: string, sdp: RTCSessionDescriptionInit) {
  socket?.emit('call:answer', { callId, sdp });
}

export function sendCallIceCandidate(callId: string, candidate: RTCIceCandidateInit) {
  socket?.emit('call:ice-candidate', { callId, candidate });
}

// --- Group call functions ---
export function joinGroupCall(chatId: number, callType: string): Promise<{ ok: boolean; participants?: Array<{ userId: number; callType: string }>; error?: string }> {
  return new Promise((resolve) => {
    socket?.timeout(10_000).emit('group-call:join', { chatId, callType }, (timeoutError: Error | null, res?: any) => {
      if (timeoutError) resolve({ ok: false, error: 'Timeout' });
      else resolve(res || { ok: false, error: 'No response' });
    });
  });
}

export function leaveGroupCall(chatId: number) {
  socket?.emit('group-call:leave', { chatId });
}

export function sendGroupCallOffer(chatId: number, targetId: number, sdp: RTCSessionDescriptionInit) {
  socket?.emit('group-call:offer', { chatId, targetId, sdp });
}

export function sendGroupCallAnswer(chatId: number, targetId: number, sdp: RTCSessionDescriptionInit) {
  socket?.emit('group-call:answer', { chatId, targetId, sdp });
}

export function sendGroupCallIceCandidate(chatId: number, targetId: number, candidate: RTCIceCandidateInit) {
  socket?.emit('group-call:ice-candidate', { chatId, targetId, candidate });
}
