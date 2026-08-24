import { useSyncExternalStore } from 'react';
import type { User, ChatDTO, MediaDTO, ReactionGroup, ForwardInfo, GroupMemberDTO } from './api';
import type { IncomingMessage } from './socket';
import { sendMessage } from './socket';

export type FolderId = 'all' | 'private' | 'secret' | 'groups' | 'channels' | 'archive';

export interface ActiveCallState {
  callId: string;
  chatId: number;
  callType: 'audio' | 'video';
  callerId: number;
  callerName: string;
  direction: 'outgoing' | 'incoming';
  status: 'ringing' | 'connecting' | 'connected' | 'ended';
}

export interface StoredMessage {
  id: number;
  chat_id: number;
  sender_id: number;
  client_id?: string | null;
  sender_user?: { id: number; username?: string; first_name?: string; last_name?: string; photo?: string | null } | null;
  created_at: string;
  read_at?: string | null;
  delivered_at?: string | null;
  edited_at?: string | null;
  expires_at?: string | null;
  text?: string;
  cipher?: string;
  iv?: string;
  media?: MediaDTO | null;
  reply_to?: number | null;
  thread_id?: number | null;
  topic_id?: number | null;
  hashtags?: string[];
  forwarded_from?: ForwardInfo | null;
  reactions?: ReactionGroup[];
  pending?: boolean;
  failed?: boolean;
  deleted_for?: number[];
  link_preview?: { url: string; title: string | null; description: string | null; image: string | null } | null;
}

interface AppState {
  me: User | null;
  chats: ChatDTO[];
  activeChatId: number | null;
  messages: Record<number, StoredMessage[]>;
  online: Record<number, boolean>;
  typing: Record<number, { userId: number; isTyping: boolean }>;
  folder: FolderId;
  infoOpen: boolean;
  settingsOpen: boolean;
  adminOpen: boolean;
  forwardOpen:
    | { chatId: number; messageId: number; text: string; media: MediaDTO | null; senderId: number; senderName: string }
    | null;
  users: Record<number, User>;
  groupMembers: Record<number, GroupMemberDTO[]>;
  activeCall: ActiveCallState | null;
}

let state: AppState = {
  me: null,
  chats: [],
  activeChatId: (() => { try { const v = localStorage.getItem('activeChatId'); return v && v !== 'null' ? Number(v) : null; } catch { return null; } })(),
  messages: {},
  online: {},
  typing: {},
  folder: 'all',
  infoOpen: false,
  settingsOpen: false,
  adminOpen: false,
  forwardOpen: null,
  users: {},
  groupMembers: {},
  activeCall: null,
};

const listeners = new Set<() => void>();

function setState(patch: Partial<AppState>) {
  state = { ...state, ...patch };
  if (patch.activeChatId !== undefined) {
    try { localStorage.setItem('activeChatId', String(patch.activeChatId)); } catch { /* ignore */ }
  }
  listeners.forEach((l) => l());
}

export const store = {
  get: () => state,
  set: setState,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useApp(): AppState {
  return useSyncExternalStore(store.subscribe, store.get);
}

export function mergeMessage(m: IncomingMessage & { pending?: boolean }) {
  const existing = state.messages[m.chat_id] ?? [];
  if (!m.pending && existing.some((x) => x.id === m.id)) return;
  const chatMsgs = [...existing, m];
  setState({ messages: { ...state.messages, [m.chat_id]: chatMsgs } });
}

export function replacePending(chatId: number, tempId: number, real: IncomingMessage) {
  const chatMsgs = (state.messages[chatId] ?? []).map((m) =>
    m.pending && m.id === tempId ? { ...real } : m,
  );
  setState({ messages: { ...state.messages, [chatId]: chatMsgs } });
}

export function setMessages(chatId: number, msgs: StoredMessage[]) {
  setState({ messages: { ...state.messages, [chatId]: msgs } });
}

export function updateMessage(
  chatId: number,
  messageId: number,
  patch: Partial<StoredMessage>,
) {
  const chatMsgs = (state.messages[chatId] ?? []).map((m) => (m.id === messageId ? { ...m, ...patch } : m));
  setState({ messages: { ...state.messages, [chatId]: chatMsgs } });
}

export function updateMessageReactions(chatId: number, messageId: number, reactions: ReactionGroup[]) {
  updateMessage(chatId, messageId, { reactions });
}

export function removeMessage(chatId: number, messageId: number) {
  const chatMsgs = (state.messages[chatId] ?? []).filter((m) => m.id !== messageId);
  setState({ messages: { ...state.messages, [chatId]: chatMsgs } });
}

export function markChatRead(chatId: number, upToMessageId: number, readerId: number, readAt: string) {
  const meId = state.me?.id;
  const iAmReader = readerId === meId;
  const chatMsgs = (state.messages[chatId] ?? []).map((m) =>
    (iAmReader ? m.sender_id !== meId : m.sender_id === meId) && m.id <= upToMessageId && !m.read_at
      ? { ...m, read_at: readAt }
      : m,
  );
  setState({
    messages: { ...state.messages, [chatId]: chatMsgs },
    chats: state.chats.map((c) => {
      if (c.chat.id !== chatId) return c;
      const lastMessage =
        !iAmReader && c.last_message && c.last_message.sender_id === meId && c.last_message.id <= upToMessageId
          ? { ...c.last_message, read_at: readAt }
          : c.last_message;
      return {
        ...c,
        unread: iAmReader ? 0 : c.unread,
        last_message: lastMessage,
      };
    }),
  });
}

export function upsertUser(u: User) {
  if (!state.users[u.id] || state.users[u.id] !== u) {
    setState({ users: { ...state.users, [u.id]: u } });
  }
}

export function setUsers(us: User[]) {
  const next = { ...state.users };
  for (const u of us) next[u.id] = u;
  setState({ users: next });
}

export function setGroupMembers(chatId: number, members: GroupMemberDTO[]) {
  setState({
    groupMembers: { ...state.groupMembers, [chatId]: members },
    users: members.reduce<Record<number, User>>((acc, m) => {
      acc[m.user.id] = m.user;
      return acc;
    }, { ...state.users }),
  });
}

export function resendMessage(chatId: number, messageId: number, text: string) {
  updateMessage(chatId, messageId, { failed: false, pending: true });
  const clientId = Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, '0')).join('');
  sendMessage({ chatId, text, clientId }).then((real) => {
    replacePending(chatId, messageId, real);
  }).catch(() => {
    updateMessage(chatId, messageId, { failed: true, pending: false });
  });
}

export function cancelMessage(chatId: number, messageId: number) {
  removeMessage(chatId, messageId);
}
