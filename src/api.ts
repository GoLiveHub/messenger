export type PrivacyValue = 'everybody' | 'contacts' | 'nobody';

export interface UserSettings {
  theme?: 'dark' | 'light';
  animations?: boolean;
  effects?: boolean;
  lang?: string;
  rtl?: boolean;
  notifications?: { enabled: boolean; sound: boolean };
  media?: { wifi: boolean; roaming: boolean; mobile: boolean };
  privacy?: {
    last_seen?: PrivacyValue;
    phone?: PrivacyValue;
    photo?: PrivacyValue;
    bio?: PrivacyValue;
    groups?: PrivacyValue;
    forwarded?: PrivacyValue;
  };
}

export interface User {
  id: number;
  phone: string;
  username: string;
  first_name: string;
  last_name: string;
  bio: string;
  photo: string | null;
  settings: UserSettings;
  has_2fa: boolean;
  recovery_email: string | null;
  birthday: string | null;
  e2e_public: JsonWebKey | null;
  e2e_fp: string | null;
  last_seen_visible?: boolean;
  is_admin?: number;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
}

export interface Session {
  id: number;
  created_at: string;
  expires_at: string;
  label: string | null;
  last_seen_at: string | null;
  current: boolean;
}

export interface MediaDTO {
  id: number;
  kind: 'photo' | 'file' | 'audio';
  name: string;
  mime: string;
  size: number;
  url: string;
  thumb_url?: string;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
}

export interface ReactionGroup {
  emoji: string;
  count: number;
  mine: boolean;
}

export interface ForwardInfo {
  user_id: number;
  name: string;
}

export type ChatKind = 'regular' | 'secret' | 'group' | 'channel';

export interface ChatMeta {
  id: number;
  kind: ChatKind;
  created_at: string;
  title?: string | null;
  about?: string;
  photo?: string | null;
  username?: string | null;
  pinned_id?: number | null;
  pinned_messages?: number[];
  is_forum?: boolean;
}

export interface Topic {
  id: number;
  chat_id: number;
  title: string;
  created_by: { id: number; username?: string; first_name?: string; last_name?: string; photo?: string | null } | null;
  created_at: string;
}

export interface ChatDTO {
  chat: ChatMeta;
  peer: User | null;
  member_count: number;
  role: 'owner' | 'admin' | 'member' | null;
  muted: boolean;
  notify_level: 'all' | 'mentions' | 'none';
  pinned: boolean;
  last_message: {
    id: number;
    sender_id: number;
    created_at: string;
    preview: string;
    media_kind?: string | null;
    read_at?: string | null;
  } | null;
  unread: number;
  archived: boolean;
}

export interface GroupMemberDTO {
  user: User;
  role: 'owner' | 'admin' | 'member';
  rank: string;
  joined_at: string;
}

export interface ChatInfoDTO {
  chat: ChatDTO;
  members: GroupMemberDTO[];
}

export interface MessageDTO {
  id: number;
  chat_id: number;
  sender_id: number;
  client_id?: string | null;
  sender_user?: { id: number; username?: string; first_name?: string; last_name?: string; photo?: string | null } | null;
  created_at: string;
  read_at: string | null;
  delivered_at: string | null;
  service?: boolean | number;
  edited_at: string | null;
  text?: string;
  cipher?: string;
  iv?: string;
  media?: MediaDTO | null;
  reply_to?: number | null;
  topic_id?: number | null;
  forwarded_from?: ForwardInfo | null;
  reactions?: ReactionGroup[];
  link_preview?: { url: string; title: string | null; description: string | null; image: string | null } | null;
}

// ======================== CSRF HELPERS ========================

/**
 * Read a cookie value by name from the document.
 */
function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Read the CSRF token from the csrf_token cookie set by the server.
 */
function getCsrfToken(): string | null {
  return getCookie('csrf_token');
}

// ======================== AUTH ========================

function notifyUnauthorized() {
  try {
    // Clear cookies on the client side
    document.cookie = 'session_token=; Path=/; Max-Age=0';
    document.cookie = 'csrf_token=; Path=/; Max-Age=0';
  } catch {
    // Storage can be unavailable in private browsing modes.
  }
  window.dispatchEvent(new Event('messenger:unauthorized'));
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';

  // CSRF token for state-changing requests
  const method = (options.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const csrfToken = getCsrfToken();
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }

  const res = await fetch(path, {
    ...options,
    headers,
    credentials: 'include', // Send cookies with every request
  });

  // Sync CSRF cookie if server sends a new one
  // (CSRF token is set in cookies by the server, no action needed here)

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    const err = (data as { error?: string } | null)?.error;
    throw new Error(err || (res.status >= 500 ? 'Server error. Please try again.' : `Request failed (HTTP ${res.status})`));
  }
  if (data === null) throw new Error('Empty server response. Please try again.');
  return data as T;
}

export const api = {
  me: () => request<User>('/api/me'),
  updateProfile: (body: { first_name?: string; last_name?: string; bio?: string; username?: string; photo?: string | null; password?: string | null; birthday?: string | null }) =>
    request<User>('/api/me', { method: 'PATCH', body: JSON.stringify(body) }),
  updateSettings: (settings: Partial<UserSettings>) =>
    request<User>('/api/me/settings', { method: 'PUT', body: JSON.stringify({ settings }) }),
  setup2FA: (body: { password: string; recovery_email?: string; current_password?: string }) =>
    request<{ ok: boolean; user: User }>('/api/me/2fa', { method: 'POST', body: JSON.stringify(body) }),
  disable2FA: (password: string) =>
    request<{ ok: boolean; user: User }>('/api/me/2fa', { method: 'DELETE', body: JSON.stringify({ password }) }),
  getSessions: () => request<Session[]>('/api/sessions'),
  terminateSession: (id: number) => request<{ ok: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),
  terminateAllSessions: () => request<{ ok: boolean }>('/api/sessions/terminate-all', { method: 'POST' }),
  getBlocks: () => request<User[]>('/api/blocks'),
  addBlock: (userId: number) => request<{ ok: boolean }>(`/api/blocks/${userId}`, { method: 'PUT' }),
  removeBlock: (userId: number) => request<{ ok: boolean }>(`/api/blocks/${userId}`, { method: 'DELETE' }),
  deleteAccount: (password?: string) =>
    request<{ ok: boolean }>('/api/me', { method: 'DELETE', body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  logoutAll: () => request<{ ok: boolean }>('/api/auth/logout-all', { method: 'POST' }),
  setQuietHours: (start: string | null, end: string | null) =>
    request<{ ok: boolean; quiet_hours_start: string | null; quiet_hours_end: string | null }>('/api/me/quiet-hours', {
      method: 'PATCH',
      body: JSON.stringify({ start, end }),
    }),
  checkPhone: (phone: string) =>
    request<{ registered: boolean; phone: string }>('/api/auth/checkPhone', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    }),
  sendCode: (phone: string) =>
    request<{ phone_code_hash: string; dev_code?: string }>('/api/auth/sendCode', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    }),
  signUp: (body: { phone: string; code: string; phone_code_hash: string; first_name: string; last_name?: string; username?: string; password?: string; device?: string }) =>
    request<{ user: User }>('/api/auth/signUp', { method: 'POST', body: JSON.stringify(body) }),
  signIn: (body: { phone: string; code: string; phone_code_hash: string; device?: string }) =>
    request<{ status: 'ok'; user: User } | { status: 'need_password' } | { status: 'need_totp' }>('/api/auth/signIn', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  checkPassword: (body: { phone: string; code: string; phone_code_hash: string; password: string; device?: string }) =>
    request<{ user: User }>('/api/auth/checkPassword', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  verifyTotp: (body: { phone: string; code: string; phone_code_hash: string; totp_token: string; device?: string }) =>
    request<{ user: User }>('/api/auth/verifyTotp', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  uploadE2EKey: (publicKey: JsonWebKey, fingerprint: string) =>
    request<{ ok: boolean }>('/api/users/e2e-key', {
      method: 'POST',
      body: JSON.stringify({ publicKey, fingerprint }),
    }),
  uploadSignedPrekey: (prekey_id: number, public_jwk: JsonWebKey, signature: string) =>
    request<{ ok: boolean }>('/api/e2e/prekeys/signed', {
      method: 'POST',
      body: JSON.stringify({ prekey_id, public_jwk, signature }),
    }),
  uploadOneTimePrekeys: (keys: Array<{ prekey_id: number; public_jwk: JsonWebKey }>) =>
    request<{ ok: boolean; added: number }>('/api/e2e/prekeys/one-time', {
      method: 'POST',
      body: JSON.stringify({ keys }),
    }),
  fetchPrekeyBundle: (userId: number) =>
    request<{
      identity_key: JsonWebKey;
      identity_fp: string;
      signed_prekey: { prekey_id: number; public_jwk: JsonWebKey; signature: string } | null;
      one_time_prekey: { prekey_id: number; public_jwk: JsonWebKey } | null;
    }>(`/api/e2e/prekeys/${userId}`),
  listE2EDevices: () =>
    request<Array<{ id: number; user_id: number; device_label: string; identity_key: string; created_at: string }>>('/api/e2e/devices'),
  registerE2EDevice: (device_label: string, identity_key: string) =>
    request<{ ok: boolean; id: number }>('/api/e2e/devices', {
      method: 'POST',
      body: JSON.stringify({ device_label, identity_key }),
    }),
  revokeE2EDevice: (deviceId: number) =>
    request<{ ok: boolean }>(`/api/e2e/devices/${deviceId}`, { method: 'DELETE' }),
  searchUsers: (q: string) => request<User[]>(`/api/users/search?q=${encodeURIComponent(q)}`),
  createChat: (peerId: number, kind: 'regular' | 'secret') =>
    request<{ chat: ChatMeta; peer: User }>('/api/chats', {
      method: 'POST',
      body: JSON.stringify({ peerId, kind }),
    }),
  getChats: (opts?: { limit?: number; before?: number }) => {
    const params = new URLSearchParams();
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.before) params.set('before', String(opts.before));
    const qs = params.toString();
    return request<ChatDTO[] | { chats: ChatDTO[]; hasMore: boolean }>(`/api/chats${qs ? '?' + qs : ''}`).then((r) => Array.isArray(r) ? r : r.chats);
  },
  createGroup: (body: { title: string; about?: string; photo?: string; userIds?: number[]; kind?: 'group' | 'channel' }) =>
    request<ChatInfoDTO>('/api/groups', { method: 'POST', body: JSON.stringify(body) }),
  getChatInfo: (chatId: number) => request<ChatInfoDTO>(`/api/chats/${chatId}`),
  addGroupMembers: (chatId: number, userIds: number[]) =>
    request<ChatInfoDTO>(`/api/groups/${chatId}/members`, { method: 'POST', body: JSON.stringify({ userIds }) }),
  removeGroupMember: (chatId: number, userId: number) =>
    request<ChatInfoDTO | { ok: boolean; left?: boolean }>(`/api/groups/${chatId}/members/${userId}`, { method: 'DELETE' }),
  editGroup: (chatId: number, body: { title?: string; about?: string; photo?: string | null; username?: string }) =>
    request<ChatInfoDTO>(`/api/groups/${chatId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  promoteMember: (chatId: number, userId: number, role: 'admin' | 'member') =>
    request<ChatInfoDTO>(`/api/groups/${chatId}/promote`, {
      method: 'POST',
      body: JSON.stringify({ userId, role }),
    }),
  transferGroupOwnership: (chatId: number, userId: number) =>
    request<ChatInfoDTO>(`/api/groups/${chatId}/transfer-ownership`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
  setMuted: (chatId: number, muted: boolean) =>
    request<{ ok: boolean }>(`/api/chats/${chatId}`, {
      method: 'PATCH',
      body: JSON.stringify({ muted }),
    }),
  getMessages: (chatId: number, before?: number) => request<MessageDTO[]>(`/api/chats/${chatId}/messages${before ? `?before=${before}` : ''}`),
  searchMessages: async (chatId: number, q: string) => {
    const res = await request<{ results: MessageDTO[]; hasMore?: boolean }>(`/api/chats/${chatId}/search?q=${encodeURIComponent(q)}`);
    return res.results ?? [];
  },
  searchAllMessages: (q: string, opts?: { author?: number; from?: string; to?: string }) => {
    const params = new URLSearchParams({ q });
    if (opts?.author) params.set('author', String(opts.author));
    if (opts?.from) params.set('from', opts.from);
    if (opts?.to) params.set('to', opts.to);
    return request<any[]>(`/api/messages/search?${params.toString()}`);
  },
  deleteChat: (chatId: number) => request<{ ok: boolean }>(`/api/chats/${chatId}`, { method: 'DELETE' }),
  clearHistory: (chatId: number) =>
    request<{ ok: boolean }>(`/api/chats/${chatId}/messages`, { method: 'DELETE' }),
  setArchived: (chatId: number, archived: boolean) =>
    request<{ ok: boolean; archived: boolean }>(`/api/chats/${chatId}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived }),
    }),
  setPinned: (chatId: number, pinned: boolean) =>
    request<{ ok: boolean; pinned: boolean }>(`/api/chats/${chatId}`, {
      method: 'PATCH',
      body: JSON.stringify({ pinned }),
    }),
  getUser: (id: number) => request<User>(`/api/users/${id}`),
  chatMedia: (chatId: number, limit = 50, before?: number) =>
    request<MediaDTO[]>(`/api/chats/${chatId}/media?limit=${limit}${before ? `&before=${before}` : ''}`),
  uploadMedia: (
    chatId: number,
    kind: string,
    file: Blob,
    name: string,
    _mime: string,
    extra?: Record<string, string>,
  ) => {
    const form = new FormData();
    form.append('chatId', String(chatId));
    form.append('kind', kind);
    form.append('file', file, name);
    if (extra) for (const [k, v] of Object.entries(extra)) form.append(k, v);
    return request<{ media: MediaDTO }>('/api/media', {
      method: 'POST',
      body: form,
    });
  },
  forwardMedia: (mediaId: number, chatId: number) =>
    request<{ media: MediaDTO }>(`/api/media/${mediaId}/forward`, {
      method: 'POST',
      body: JSON.stringify({ chatId }),
    }),
  fetchMediaBlob: async (mediaId: number, download = false) => {
    const res = await fetch(`/api/media/${mediaId}${download ? '?download=1' : ''}`, {
      credentials: 'include',
    });
    if (res.status === 401) notifyUnauthorized();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  },
  recover: (phone: string, code: string) =>
    request<{ user: User }>('/api/auth/recover', {
      method: 'POST',
      body: JSON.stringify({ phone, code }),
    }),
  getRecoveryCodes: () => request<{ count: number }>('/api/me/recovery-codes'),
  regenerateRecoveryCodes: (password?: string) =>
    request<{ codes: string[] }>('/api/me/recovery-codes', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  requestPhoneChange: (new_phone: string, password?: string) =>
    request<{ ok: boolean }>('/api/me/phone/request', {
      method: 'POST',
      body: JSON.stringify({ new_phone, password }),
    }),
  confirmPhoneChange: (code: string) =>
    request<{ ok: boolean; user: User }>('/api/me/phone/confirm', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  exportAccount: () => request<any>('/api/me/export'),
  getSaved: () => request<any[]>('/api/me/saved'),
  saveMessage: (messageId: number, chatId: number, body?: string) =>
    request<{ ok: boolean; id: number }>('/api/me/saved', { method: 'POST', body: JSON.stringify({ message_id: messageId, chat_id: chatId, body }) }),
  removeSaved: (id: number) => request<{ ok: boolean }>(`/api/me/saved/${id}`, { method: 'DELETE' }),
  getScheduled: () => request<any[]>('/api/me/scheduled'),
  scheduleMessage: (chatId: number, body: string, scheduledAt: string, replyTo?: number) =>
    request<{ ok: boolean; id: number }>('/api/me/scheduled', { method: 'POST', body: JSON.stringify({ chat_id: chatId, body, scheduled_at: scheduledAt, reply_to: replyTo }) }),
  cancelScheduled: (id: number) => request<{ ok: boolean }>(`/api/me/scheduled/${id}`, { method: 'DELETE' }),
  getFolders: () => request<any[]>('/api/folders'),
  createFolder: (name: string, emoji?: string, chatIds?: number[]) =>
    request<{ ok: boolean; id: number }>('/api/folders', { method: 'POST', body: JSON.stringify({ name, emoji, chat_ids: chatIds }) }),
  updateFolder: (id: number, data: { name?: string; emoji?: string; chat_ids?: number[]; sort_order?: number }) =>
    request<{ ok: boolean }>(`/api/folders/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteFolder: (id: number) => request<{ ok: boolean }>(`/api/folders/${id}`, { method: 'DELETE' }),
  muteChatDuration: (chatId: number, muted: boolean, duration?: number) =>
    request<{ ok: boolean; muted_until: string | null }>(`/api/chats/${chatId}/mute`, {
      method: 'PUT', body: JSON.stringify({ muted, duration }),
    }),
  setNotifyLevel: (chatId: number, level: 'all' | 'mentions' | 'none') =>
    request<{ ok: boolean; level: string }>(`/api/chats/${chatId}/notify`, {
      method: 'PUT', body: JSON.stringify({ level }),
    }),
  subscribePush: (subscription: { endpoint: string; p256dh: string; auth: string }) =>
    request<{ ok: boolean }>('/api/push/subscribe', {
      method: 'POST', body: JSON.stringify(subscription),
    }),
  unsubscribePush: (endpoint: string) =>
    request<{ ok: boolean }>('/api/push/subscribe', {
      method: 'DELETE', body: JSON.stringify({ endpoint }),
    }),
  getVapidPublicKey: () =>
    request<{ enabled: boolean; publicKey?: string }>('/api/push/vapid-public-key'),
  setChannelDiscussion: (channelId: number, discussionChatId: number | null) =>
    request<{ ok: boolean; discussion_chat_id: number | null }>(`/api/channels/${channelId}/discussion`, {
      method: 'PUT', body: JSON.stringify({ discussion_chat_id: discussionChatId }),
    }),
  viewChannelMessage: (channelId: number, msgId: number) =>
    request<{ ok: boolean }>(`/api/channels/${channelId}/messages/${msgId}/view`, { method: 'POST' }),
  getChannelStats: (channelId: number) =>
    request<{ total_messages: number; total_views: number; members: number; top_posts: Array<{ id: number; sender_id: number; created_at: string; views: number }> }>(`/api/channels/${channelId}/stats`),
  importContacts: (vcard: string) =>
    request<{ contacts: Array<{ phone: string; name: string; user?: User }> }>('/api/contacts/import', {
      method: 'POST', body: JSON.stringify({ vcard }),
    }),
  getStickerPacks: () => request<Array<{ id: number; name: string; emoji: string | null; thumbnail: string | null }>>('/api/sticker-packs'),
  getStickerPackStickers: (packId: number) => request<Array<{ id: number; pack_id: number; file_id: number; emoji: string; sort_order: number }>>(`/api/sticker-packs/${packId}/stickers`),
  installStickerPack: (packId: number) => request<{ ok: boolean }>(`/api/sticker-packs/${packId}/install`, { method: 'POST' }),
  uninstallStickerPack: (packId: number) => request<{ ok: boolean }>(`/api/sticker-packs/${packId}/install`, { method: 'DELETE' }),
  getMyStickerPacks: () => request<Array<{ id: number; name: string; emoji: string | null }>>('/api/me/sticker-packs'),
  searchGifs: (q: string, limit = 20) =>
    request<Array<{ id: string; url: string; preview: string; width: number; height: number }>>(`/api/gifs/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  attachGif: (chatId: number, url: string) =>
    request<{ media: MediaDTO }>('/api/gifs/attach', { method: 'POST', body: JSON.stringify({ chatId, url }) }),
  // Custom reactions (REST fallback to the socket path)
  addReaction: (messageId: number, emoji: string) =>
    request<{ ok: boolean; reactions: ReactionGroup[] }>(`/api/messages/${messageId}/reactions`, {
      method: 'POST', body: JSON.stringify({ emoji }),
    }),
  removeReaction: (messageId: number, emoji: string) =>
    request<{ ok: boolean; reactions: ReactionGroup[] }>(`/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, { method: 'DELETE' }),
  getReactions: (messageId: number) =>
    request<ReactionGroup[]>(`/api/messages/${messageId}/reactions`),
  // Forum topics
  setGroupForum: (groupId: number, enabled: boolean) =>
    request<{ ok: boolean; is_forum: boolean }>(`/api/groups/${groupId}/forum`, {
      method: 'PATCH', body: JSON.stringify({ enabled }),
    }),
  getTopics: (chatId: number) => request<Topic[]>(`/api/chats/${chatId}/topics`),
  createTopic: (chatId: number, title: string) =>
    request<Topic>(`/api/chats/${chatId}/topics`, {
      method: 'POST', body: JSON.stringify({ title }),
    }),
  deleteTopic: (chatId: number, topicId: number) =>
    request<{ ok: boolean }>(`/api/chats/${chatId}/topics/${topicId}`, { method: 'DELETE' }),
  report: (targetType: string, targetId: number, reason: string, details?: string) =>
    request<{ ok: boolean }>('/api/reports', { method: 'POST', body: JSON.stringify({ target_type: targetType, target_id: targetId, reason, details }) }),
  // Admin
  getAdminReports: (status = 'pending') =>
    request<Array<{ id: number; reporter_id: number; reporter_username: string; reporter_name: string; target_type: string; target_id: number; reason: string; details: string | null; status: string; created_at: string }>>(`/api/admin/reports?status=${status}`),
  reviewReport: (id: number, status: 'reviewed' | 'dismissed') =>
    request<{ ok: boolean }>(`/api/admin/reports/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  getAdminUsers: (q = '') =>
    request<Array<{ id: number; username: string; first_name: string; last_name: string; phone: string; is_admin: number; created_at: string }>>(`/api/admin/users?q=${encodeURIComponent(q)}`),
  adminBanUser: (userId: number, reason = '') =>
    request<{ ok: boolean }>(`/api/admin/users/${userId}/ban`, { method: 'POST', body: JSON.stringify({ reason }) }),
  adminUnbanUser: (userId: number) =>
    request<{ ok: boolean }>(`/api/admin/users/${userId}/ban`, { method: 'DELETE' }),
  getAdminBans: () =>
    request<Array<{ user_id: number; username: string; first_name: string; last_name: string; reason: string | null; created_at: string }>>('/api/admin/bans'),
  adminDeleteUserMessages: (userId: number) =>
    request<{ ok: boolean }>(`/api/admin/users/${userId}/delete-messages`, { method: 'POST' }),
  getFolderFilters: () => request<Record<string, number[]>>('/api/folder-filters'),
  setFolderFilters: (filters: Record<string, number[]>) =>
    request<{ ok: boolean }>('/api/folder-filters', { method: 'PUT', body: JSON.stringify(filters) }),
  getLinkPreview: (url: string) =>
    request<{ url: string; title: string | null; description: string | null; image: string | null } | null>(`/api/link-preview?url=${encodeURIComponent(url)}`),

  uploadFileWithProgress: (
    chatId: number,
    kind: string,
    file: File | Blob,
    name: string,
    mime: string,
    onProgress: (percent: number) => void,
    extra?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ media: MediaDTO }> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const form = new FormData();
      form.append('chatId', String(chatId));
      form.append('kind', kind);
      form.append('file', file, name);
      if (extra) for (const [k, v] of Object.entries(extra)) form.append(k, v);

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });

      xhr.addEventListener('load', () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(data);
          } else {
            if (xhr.status === 401) notifyUnauthorized();
            reject(new Error(data?.error || `Request failed (HTTP ${xhr.status})`));
          }
        } catch {
          reject(new Error('Invalid server response'));
        }
      });

      xhr.addEventListener('error', () => reject(new Error('Network error')));
      xhr.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));

      if (signal) {
        signal.addEventListener('abort', () => xhr.abort());
      }

      const csrfToken = getCsrfToken();
      xhr.open('POST', '/api/media');
      if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
      xhr.withCredentials = true;
      xhr.send(form);
    });
  },
  searchHashtag: (tag: string) => request<any[]>(`/api/hashtags/${encodeURIComponent(tag)}`),
  getThread: (chatId: number, msgId: number) =>
    request<{ parent: any; replies: any[] }>(`/api/chats/${chatId}/threads/${msgId}`),
  getCustomEmoji: (chatId: number) =>
    request<any[]>(`/api/chats/${chatId}/emoji`),
  addCustomEmoji: (chatId: number, shortcut: string, emoji_url: string) =>
    request<{ ok: boolean; id: number }>(`/api/chats/${chatId}/emoji`, {
      method: 'POST',
      body: JSON.stringify({ shortcut, emoji_url }),
    }),
  deleteCustomEmoji: (chatId: number, id: number) =>
    request<{ ok: boolean }>(`/api/chats/${chatId}/emoji/${id}`, { method: 'DELETE' }),
  // Drafts
  getDrafts: () => request<Array<{ chat_id: number; text: string; updated_at: string }>>('/api/drafts'),
  saveDraft: (chatId: number, text: string) =>
    request<{ ok: boolean; draft: { chat_id: number; text: string; updated_at: string } }>(`/api/drafts/${chatId}`, {
      method: 'PUT',
      body: JSON.stringify({ text }),
    }),
  deleteDraft: (chatId: number) =>
    request<{ ok: boolean }>(`/api/drafts/${chatId}`, { method: 'DELETE' }),
  undeleteMessage: (chatId: number, messageId: number) =>
    request<{ ok: boolean }>(`/api/chats/${chatId}/messages/${messageId}/undelete`, { method: 'POST' }),
  // Bots
  getBots: () => request<Array<{ id: number; name: string; description: string; webhook_url: string; is_active: number; created_at: string; bot_user_id: number; username: string }>>('/api/bots'),
  createBot: (name: string, description: string, webhookUrl: string) =>
    request<{ ok: boolean; id: number; token: string; bot_user_id: number; username: string; name: string; description: string; webhook_url: string }>('/api/bots', {
      method: 'POST', body: JSON.stringify({ name, description, webhook_url: webhookUrl }),
    }),
  deleteBot: (botId: number) =>
    request<{ ok: boolean }>(`/api/bots/${botId}`, { method: 'DELETE' }),
  setBotWebhook: (botId: number, webhookUrl: string) =>
    request<{ ok: boolean; webhook_url: string }>(`/api/bots/${botId}/set-webhook`, {
      method: 'POST', body: JSON.stringify({ webhook_url: webhookUrl }),
    }),
  importPhoneContacts: (phones: string[]) =>
    request<{ matched: number; users: Array<{ id: number; phone: string; username: string; first_name: string; last_name: string; photo: string | null }> }>(
      '/api/contacts/import-phones',
      { method: 'POST', body: JSON.stringify({ phones }) },
    ),
  // Feature flags
  getFeatures: () => request<{ calls: boolean; e2eSecretChats: boolean; scheduledMessages: boolean; folders: boolean }>('/api/features'),
};
