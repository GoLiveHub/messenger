import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp, store, setMessages, mergeMessage, resendMessage, cancelMessage, type StoredMessage } from '../store';
import { api, type MediaDTO, type User, type Topic } from '../api';
import { sendMessage, sendTyping, joinChat, sendRead, editMessage, deleteMessage, sendReact, pinMessage } from '../socket';
import { getE2EKeys } from '../crypto/ensureKeys';
import { deriveSharedKey, x3dh, encryptSecret, decryptSecret, ratchetStep, encryptFile, decryptFile, generateFileKey, exportFileKey, importFileKey, bytesToBase64, base64ToBytes, type RatchetState } from '../crypto/e2e';
import { Avatar } from './Avatar';
import { MediaImage } from './MediaImage';
import { VoicePlayer } from './VoicePlayer';
import { ForwardModal } from './ForwardModal';
import { EmojiPicker } from './EmojiPicker';
import { AddMembersModal } from './AddMembersModal';
import { EditGroupModal } from './EditGroupModal';
import { MentionAutocomplete } from './MentionAutocomplete';
import { t, tx, useLang } from '../i18n';
import { formatBytes, downloadMedia, getMediaUrl } from '../media';
import type React from 'react';
import {
  SearchIcon,
  DotsIcon,
  TrashIcon,
  BanIcon,
  CheckIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  CloseIcon,
  ClockIcon,
  CheckCheckIcon,
  PencilIcon,
  AlertIcon,
  LockIcon,
  SendIcon,
  InfoIcon,
  PaperclipIcon,
  SmileIcon,
  MicIcon,
  ReplyIcon,
  ForwardIcon,
  DownloadIcon,
  FileIcon,
  StopIcon,
  PersonPlusIcon,
  ExitIcon,
  MegaphoneIcon,
  PinIcon,
  ChevronLeftIcon,
  BookmarkIcon,
} from './icons';

interface SecretSession {
  rootKey: CryptoKey;
  sendKey: CryptoKey;
  recvKey: CryptoKey;
  messageNum: number;
  prevChainLen: number;
  skippedKeys: Map<string, CryptoKey>;
}

const secretKeys = new Map<string, SecretSession>();

function secretKeyId(userId: number, chatId: number): string {
  return `${userId}:${chatId}`;
}

const GROUP_GAP_MS = 7 * 60 * 1000;
const QUICK_REACTIONS = ['❤️', '👍', '👏', '😮', '😂', '😢', '🙏', '🔥', '😍'];

async function downloadE2EMedia(media: MediaDTO, fileKey?: string) {
  if (!fileKey) {
    return downloadMedia(media);
  }
  const blob = await api.fetchMediaBlob(media.id, true);
  const arrayBuf = await blob.arrayBuffer();
  const key = await importFileKey(fileKey);
  const decrypted = await decryptFile(arrayBuf, new ArrayBuffer(0), key);
  const decBlob = new Blob([decrypted], { type: media.mime || 'application/octet-stream' });
  const url = URL.createObjectURL(decBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = media.name || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return t('Today');
  const yest = new Date(now.getTime() - 86400000);
  if (d.toDateString() === yest.toDateString()) return t('Yesterday');
  return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatExpiry(iso: string): string {
  const remaining = new Date(iso).getTime() - Date.now();
  if (remaining <= 0) return '';
  const s = Math.floor(remaining / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

interface LayoutMsg extends StoredMessage {
  decrypted?: { text: string; decryptError?: boolean; fileKey?: string };
  first: boolean;
  last: boolean;
}

function computeLayout(msgs: Array<{ sender_id: number; created_at: string }>): Array<{ first: boolean; last: boolean }> {
  const out: Array<{ first: boolean; last: boolean }> = [];
  for (let i = 0; i < msgs.length; i++) {
    const prev = msgs[i - 1];
    const next = msgs[i + 1];
    const prevGap = prev
      ? new Date(msgs[i].created_at).getTime() - new Date(prev.created_at).getTime()
      : Infinity;
    const nextGap = next
      ? new Date(next.created_at).getTime() - new Date(msgs[i].created_at).getTime()
      : Infinity;
    const samePrev = prev ? prev.sender_id === msgs[i].sender_id && prevGap < GROUP_GAP_MS : false;
    const sameNext = next ? next.sender_id === msgs[i].sender_id && nextGap < GROUP_GAP_MS : false;
    out.push({ first: !samePrev, last: !sameNext });
  }
  return out;
}

interface ReplyState {
  id: number;
  name: string;
  text: string;
}

function formatMarkdown(text: string, onHashtag?: (tag: string) => void): React.ReactNode[] {
  const regex = /(\*\*(.+?)\*\*)|(_(.+?)_)|(`(.+?)`)|(\~\~(.+?)\~\~)|(https?:\/\/[^\s]+)|(#([\w\u00C0-\u024F]+))/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[1]) {
      parts.push(<strong key={key++}>{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<em key={key++}>{match[4]}</em>);
    } else if (match[5]) {
      parts.push(<code key={key++} className="inline-code">{match[6]}</code>);
    } else if (match[7]) {
      parts.push(<del key={key++}>{match[8]}</del>);
    } else if (match[9]) {
      const url = match[9];
      parts.push(
        <a key={key++} href={url} target="_blank" rel="noopener noreferrer" className="msg-link" onClick={(e) => {
          e.stopPropagation();
          try {
            const u = new URL(url);
            const suspiciousTlds = ['.xyz', '.top', '.buzz', '.click', '.link', '.gq', '.ml', '.ga', '.cf'];
            const hasIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname);
            const hasAt = url.includes('@');
            const hasSuspiciousTld = suspiciousTlds.some((t) => u.hostname.endsWith(t));
            if (hasIp || hasAt || hasSuspiciousTld) {
              if (!confirm(t('This link may be suspicious. Open anyway?'))) return;
            }
          } catch { /* invalid URL, let it through */ }
          window.open(url, '_blank', 'noopener,noreferrer');
        }}>{url}</a>,
      );
    } else if (match[10]) {
      const tag = match[11];
      parts.push(
        <button key={key++} className="hashtag-link" onClick={(e) => { e.stopPropagation(); onHashtag?.(tag); }}>
          #{tag}
        </button>,
      );
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length ? parts : [text];
}

export function ChatWindow() {
  useLang();
  const { me, chats, messages, activeChatId, online, typing, forwardOpen, users } = useApp();
  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState<Record<number, Record<number, { text: string; decryptError?: boolean; fileKey?: string }>>>({});
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [replyTo, setReplyTo] = useState<ReplyState | null>(null);
  const [expiresIn, setExpiresIn] = useState<number | null>(null);
  const [expiresMenu, setExpiresMenu] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [lightbox, setLightbox] = useState<MediaDTO | null>(null);
  const [lightboxFileKey, setLightboxFileKey] = useState<string | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState('');
  const [showAddMembers, setShowAddMembers] = useState(false);
  const [showEditGroup, setShowEditGroup] = useState(false);
  const [hashtagSearch, setHashtagSearch] = useState<{ tag: string; results: Array<{ id: number; chat_id: number; sender_id: number; text: string; created_at: string }> } | null>(null);
  const [threadOpen, setThreadOpen] = useState<{ parentId: number; replies: Array<any> } | null>(null);
  const [editHistoryOpen, setEditHistoryOpen] = useState<{ messageId: number; history: Array<{ id: number; user: { id: number; first_name?: string; last_name?: string; username?: string }; text: string; edited_at: string }> } | null>(null);
  const [search, setSearch] = useState<{ open: boolean; q: string; hits: number[]; current: number }>({
    open: false,
    q: '',
    hits: [],
    current: -1,
  });
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadingFile, setUploadingFile] = useState<string>('');
  const uploadAbortRef = useRef<AbortController | null>(null);
  const [undoToast, setUndoToast] = useState<{ messageId: number; chatId: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const readSentFor = useRef<Set<number>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);
  const [rec, setRec] = useState<{ state: 'idle' | 'recording' | 'stopped'; seconds: number; blob?: Blob; duration?: number }>({
    state: 'idle',
    seconds: 0,
  });
  const recorderRef = useRef<{ mediaRecorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; analyser?: AnalyserNode; rafId?: number } | null>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const [liveWaveform, setLiveWaveform] = useState<number[]>(new Array(24).fill(0));
  const recSwipeRef = useRef<{ startX: number; currentX: number } | null>(null);
  const [recSwipeX, setRecSwipeX] = useState(0);
  const SWIPE_CANCEL_THRESHOLD = 120;
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [linkPreviews, setLinkPreviews] = useState<Record<string, { url: string; title: string | null; description: string | null; image: string | null }>>({});
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleDate, setScheduleDate] = useState('');
  const [topics, setTopics] = useState<Topic[]>([]);
  const [activeTopicId, setActiveTopicId] = useState<number | null>(null);
  const [newTopicTitle, setNewTopicTitle] = useState('');
  const [showNewTopic, setShowNewTopic] = useState(false);

  const chat = chats.find((c) => c.chat.id === activeChatId);
  const peer = chat?.peer ?? null;
  const isGroup = chat ? (chat.chat.kind === 'group' || chat.chat.kind === 'channel') : false;
  const isChannel = chat?.chat.kind === 'channel';
  const isSecret = chat?.chat.kind === 'secret';
  const isForum = isGroup && Boolean(chat?.chat.is_forum);
  const canManageGroup = chat && (chat.role === 'owner' || chat.role === 'admin');
  const peerOnline = peer ? online[peer.id] : false;
  const peerTyping = chat ? typing[chat.chat.id] : undefined;
  const msgs = activeChatId ? (messages[activeChatId] ?? []) : [];

  // group chats use the group row as avatar/title source; messages show sender names
  const groupAvatarUser: User | null = isGroup
    ? ({ id: chat!.chat.id, first_name: chat!.chat.title ?? '', last_name: '', photo: chat!.chat.photo ?? null } as User)
    : null;
  const chatTitle = isGroup ? (chat!.chat.title ?? '') : peer ? [peer.first_name, peer.last_name].filter(Boolean).join(' ') || peer.username : '';

  useEffect(() => {
    if (!activeChatId || !isForum) {
      setTopics([]);
      setActiveTopicId(null);
      setShowNewTopic(false);
      setNewTopicTitle('');
      return;
    }
    // Reset selected topic when switching chats
    setActiveTopicId(null);
    api.getTopics(activeChatId).then(setTopics).catch(() => setTopics([]));
  }, [activeChatId, isForum]);

  const createTopic = async () => {
    if (!activeChatId || !newTopicTitle.trim()) return;
    try {
      const topic = await api.createTopic(activeChatId, newTopicTitle.trim());
      setTopics((list) => [...list, topic]);
      setNewTopicTitle('');
      setShowNewTopic(false);
      setActiveTopicId(topic.id);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const toggleForumMode = async () => {
    if (!activeChatId) return;
    setMoreOpen(false);
    try {
      await api.setGroupForum(activeChatId, !isForum);
      const fresh = await api.getChats();
      store.set({ chats: fresh });
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const loadMessages = useCallback(async (chatId: number, before?: number) => {
    setLoadError(false);
    try {
      const list = await api.getMessages(chatId, before);
      if (before) {
        // Prepend older messages to existing list
        const existing = store.get().messages[chatId] ?? [];
        const existingIds = new Set(existing.map((m) => m.id));
        const newMsgs = list.filter((m) => !existingIds.has(m.id));
        if (newMsgs.length > 0) setMessages(chatId, [...newMsgs, ...existing]);
      } else {
        setMessages(chatId, list);
      }
      return list;
    } catch {
      setLoadError(true);
      return [];
    }
  }, []);

  useEffect(() => {
    if (!activeChatId) return;
    joinChat(activeChatId);
    const cached = messages[activeChatId];
    if (!cached || cached.length === 0) {
      loadMessages(activeChatId);
    }
    store.set({ infoOpen: false, forwardOpen: null });
    // Restore draft from localStorage
    try {
      const saved = localStorage.getItem(`draft_${activeChatId}`);
      if (saved) setDraft(saved);
      else setDraft('');
    } catch { setDraft(''); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId]);

  // Persist draft to localStorage and server on change
  useEffect(() => {
    if (!activeChatId) return;
    try {
      if (draft) localStorage.setItem(`draft_${activeChatId}`, draft);
      else localStorage.removeItem(`draft_${activeChatId}`);
    } catch { /* ignore */ }
    // Save to server (debounced)
    const timer = setTimeout(() => {
      if (activeChatId) {
        if (draft.trim()) api.saveDraft(activeChatId, draft.trim()).catch(() => {});
        else api.deleteDraft(activeChatId).catch(() => {});
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [draft, activeChatId]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!activeChatId || !chat || !peer || !me || chat.chat.kind !== 'secret' || !peer.e2e_public) return;
      try {
        const keyId = secretKeyId(me.id, activeChatId);
        if (!secretKeys.has(keyId)) {
          const { privateKey, publicJwk: myPublicJwk } = await getE2EKeys(me.id);
          // Try X3DH first (needs prekey bundle), fallback to static ECDH
          try {
            const bundle = await api.fetchPrekeyBundle(peer.id);
            const { key: sessionKey } = await x3dh(
              privateKey,
              bundle.signed_prekey!.public_jwk,
              bundle.one_time_prekey?.public_jwk ?? null,
              bundle.identity_key,
            );
            const { chainKey: sendKey } = await ratchetStep(sessionKey);
            const { chainKey: recvKey } = await ratchetStep(sessionKey);
            secretKeys.set(keyId, { rootKey: sessionKey, sendKey, recvKey, messageNum: 0, prevChainLen: 0, skippedKeys: new Map() });
          } catch {
            // Fallback: prekey bundle not available, use static derivation
            const sessionKey = await deriveSharedKey(privateKey, peer.e2e_public);
            const { chainKey: sendKey } = await ratchetStep(sessionKey);
            const { chainKey: recvKey } = await ratchetStep(sessionKey);
            secretKeys.set(keyId, { rootKey: sessionKey, sendKey, recvKey, messageNum: 0, prevChainLen: 0, skippedKeys: new Map() });
          }
        }
        const session = secretKeys.get(keyId)!;
        const list = store.get().messages[activeChatId] ?? [];
        const entries = await Promise.all(
          list.map(async (message) => {
            if (!message.cipher || !message.iv) return [message.id, { text: message.text ?? '' }] as const;
            try {
              let text = await decryptSecret(session.recvKey, message.cipher, message.iv);
              let fileKey: string | undefined;
              try {
                const parsed = JSON.parse(text);
                if (parsed?.e2e_file && parsed.cipher && parsed.iv) {
                  const fileKeyB64 = await decryptSecret(session.recvKey, parsed.cipher, parsed.iv);
                  fileKey = fileKeyB64;
                  text = '';
                }
              } catch { /* not a JSON e2e_file message */ }
              return [message.id, { text, fileKey }] as const;
            } catch {
              return [message.id, { text: '', decryptError: true }] as const;
            }
          }),
        );
        if (!cancelled) setHistory((previous) => ({ ...previous, [activeChatId]: Object.fromEntries(entries) }));
      } catch {
        if (!cancelled) {
          const list = store.get().messages[activeChatId] ?? [];
          setHistory((previous) => ({
            ...previous,
            [activeChatId]: Object.fromEntries(list.map((message) => [message.id, { text: '', decryptError: true }])),
          }));
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [activeChatId, chat?.chat.kind, peer?.e2e_fp, msgs.length, me?.id]);

  useEffect(() => {
    if (!activeChatId || !me) return;
    const list = messages[activeChatId] ?? [];
    const unread = list.filter((m) => m.sender_id !== me.id && !m.read_at && !m.pending && !readSentFor.current.has(m.id));
    if (unread.length > 0) {
      const last = unread[unread.length - 1];
      readSentFor.current.add(last.id);
      sendRead(activeChatId, last.id);
    }
  }, [activeChatId, msgs.length, me?.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (nearBottom) el.scrollTo({ top: el.scrollHeight });
  }, [msgs.length, Object.keys(history[activeChatId ?? 0] ?? {}).length]);

  useEffect(() => {
    if (!peer || isGroup) return;
    api
      .getBlocks()
      .then((list) => setBlocked(list.some((b) => b.id === peer.id)))
      .catch(() => {});
  }, [peer?.id, isGroup]);

  useEffect(() => {
    if (search.current < 0 || !search.hits.length) return;
    document.getElementById(`msg-${search.hits[search.current]}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [search.current, search.hits]);

  useEffect(() => {
    if (editingId === null) setEmojiOpen(false);
  }, [editingId]);

  // Global mouse handlers for swipe-to-cancel recording
  useEffect(() => {
    if (rec.state !== 'recording') return;
    const onMove = (e: MouseEvent) => onRecSwipeMove(e.clientX);
    const onUp = () => onRecSwipeEnd();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [rec.state]);

  useEffect(() => () => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    recorderRef.current?.stream.getTracks().forEach((tr) => tr.stop());
    if (recTimerRef.current) clearInterval(recTimerRef.current);
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (replyTo) { setReplyTo(null); return; }
        if (editingId) { setEditingId(null); return; }
        if (forwardOpen) { store.set({ forwardOpen: null }); return; }
        if (threadOpen) { setThreadOpen(null); return; }
        if (hashtagSearch) { setHashtagSearch(null); return; }
        if (showAddMembers) { setShowAddMembers(false); return; }
        if (showEditGroup) { setShowEditGroup(false); return; }
        if (search.open) { setSearch({ open: false, q: '', hits: [], current: -1 }); return; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setSearch((prev) => ({ ...prev, open: true }));
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
        e.preventDefault();
        if (activeChatId) store.set({ infoOpen: true });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [replyTo, editingId, forwardOpen, threadOpen, hashtagSearch, showAddMembers, showEditGroup, search.open, activeChatId]);

  const senderName = (uid: number) => {
    if (uid === me?.id) return [me.first_name, me.last_name].filter(Boolean).join(' ') || me.username;
    const u = users[uid] ?? chats.find((x) => x.peer?.id === uid)?.peer;
    return u ? [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username : t('Unknown');
  };

  const doSend = async (payload: { text?: string; mediaId?: number; replyTo?: number; clientId?: string }) => {
    if (!activeChatId) return null;
    if (isSecret) {
      const session = me ? secretKeys.get(secretKeyId(me.id, activeChatId)) : undefined;
      if (!session) return null;
      let cipher: string | undefined;
      let iv: string | undefined;
      if (payload.text) {
        const enc = await encryptSecret(session.sendKey, payload.text);
        cipher = enc.cipher;
        iv = enc.iv;
        // Advance send ratchet
        const { chainKey: newSendKey } = await ratchetStep(session.sendKey);
        session.sendKey = newSendKey;
        session.messageNum++;
      }
      return sendMessage({
        chatId: activeChatId,
        cipher,
        iv,
        mediaId: payload.mediaId,
        replyTo: payload.replyTo,
        clientId: payload.clientId,
        expiresIn: expiresIn ?? undefined,
        topicId: activeTopicId ?? undefined,
      });
    }
    return sendMessage({
      chatId: activeChatId,
      text: payload.text ?? '',
      mediaId: payload.mediaId,
      replyTo: payload.replyTo,
      clientId: payload.clientId,
      expiresIn: expiresIn ?? undefined,
      topicId: activeTopicId ?? undefined,
    });
  };

  const handleHashtagClick = async (tag: string) => {
    if (!activeChatId) return;
    try {
      const results = await api.searchHashtag(tag);
      setHashtagSearch({ tag, results });
    } catch { /* ignore */ }
  };

  const handleThreadOpen = async (parentId: number) => {
    if (!activeChatId) return;
    try {
      const { parent, replies } = await api.getThread(activeChatId, parentId);
      setThreadOpen({ parentId, replies });
    } catch { /* ignore */ }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeChatId || !draft.trim()) return;
    if (isSecret && (!me || !secretKeys.has(secretKeyId(me.id, activeChatId)))) {
      alert(t('Encryption is still initializing. Please try again in a moment.'));
      return;
    }
    const text = draft.trim();
    const clientId = crypto.randomUUID();
    setDraft('');
    try { localStorage.removeItem(`draft_${activeChatId}`); } catch { /* ignore */ }
    setReplyTo(null);
    sendTyping(activeChatId, false);

    const tempId = -Date.now();
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    const preview = urlMatch ? linkPreviews[urlMatch[0]] : undefined;
    mergeMessage({ id: tempId, chat_id: activeChatId, sender_id: me!.id, client_id: clientId, created_at: new Date().toISOString(), text, pending: true, link_preview: preview });

    try {
      const real = await doSend({ text, replyTo: replyTo?.id, clientId });
      if (!real) return;
      const list = store.get().messages[activeChatId] ?? [];
      store.set({
        messages: {
          ...store.get().messages,
          [activeChatId]: list.map((m) => (m.id === tempId ? real : m)),
        },
      });
      if (isSecret) {
        // Sender-side: try to decrypt via recvKey (may fail until peer replies, which advances the ratchet)
        const session = secretKeys.get(secretKeyId(me!.id, activeChatId))!;
        try {
          const dec = await decryptSecret(session.recvKey, real.cipher!, real.iv!);
          let fileKey: string | undefined;
          try {
            const parsed = JSON.parse(dec);
            if (parsed?.e2e_file && parsed.cipher && parsed.iv) {
              const fileKeyB64 = await decryptSecret(session.recvKey, parsed.cipher, parsed.iv);
              fileKey = fileKeyB64;
            }
          } catch { /* not e2e_file */ }
          setHistory((h) => ({ ...h, [activeChatId]: { ...(h[activeChatId] ?? {}), [real.id]: { text: fileKey ? '' : dec, fileKey } } }));
        } catch {
          // Sender can't decrypt own message yet — will show when peer replies
        }
      }
    } catch (err) {
      const list = store.get().messages[activeChatId] ?? [];
      store.set({
        messages: {
          ...store.get().messages,
          [activeChatId]: list.map((m) => (m.id === tempId ? { ...m, failed: true, pending: false } : m)),
        },
      });
    }
  };

  const sendMedia = async (file: File, kind: 'photo' | 'file') => {
    if (!activeChatId) return;
    const abortCtrl = new AbortController();
    uploadAbortRef.current = abortCtrl;
    setUploadProgress(0);
    setUploadingFile(kind === 'photo' ? t('Sending photo…') : t('Sending file…'));
    try {
      let uploadFile: File | Blob = file;
      if (kind === 'photo' && file.type.startsWith('image/')) {
        const { compressImage } = await import('../mediaUpload');
        uploadFile = await compressImage(file as File);
      }
      let mediaId: number | undefined;
      if (isSecret && me) {
        // Client-side E2E encryption for secret chat files
        const session = secretKeys.get(secretKeyId(me.id, activeChatId));
        if (!session) throw new Error('Encryption session not ready');
        const fileBuffer = await (uploadFile as Blob).arrayBuffer();
        const fileKey = await generateFileKey();
        const { encrypted, iv } = await encryptFile(fileBuffer, fileKey);
        // Encrypt the file key using the E2E ratchet
        const fileKeyB64 = await exportFileKey(fileKey);
        const encKey = await encryptSecret(session.sendKey, fileKeyB64);
        // Advance send ratchet
        const { chainKey: newSendKey } = await ratchetStep(session.sendKey);
        session.sendKey = newSendKey;
        session.messageNum++;
        // Upload the encrypted blob (server adds its own at-rest encryption)
        const { media } = await api.uploadFileWithProgress(
          activeChatId,
          kind,
          new Blob([encrypted], { type: 'application/octet-stream' }),
          `e2e_${file.name}`,
          'application/octet-stream',
          (pct) => setUploadProgress(pct),
          undefined,
          abortCtrl.signal,
        );
        mediaId = media.id;
        // Send message with E2E file key info as the text
        const keyInfo = JSON.stringify({ e2e_file: true, cipher: encKey.cipher, iv: encKey.iv });
        const real = await doSend({ text: keyInfo, mediaId, replyTo: replyTo?.id });
        if (real) mergeMessage(real);
        setReplyTo(null);
        return;
      }
      // Non-secret: upload normally
      const { media } = await api.uploadFileWithProgress(
        activeChatId,
        kind,
        uploadFile,
        file.name,
        file.type || 'application/octet-stream',
        (pct) => setUploadProgress(pct),
        undefined,
        abortCtrl.signal,
      );
      const real = await doSend({ mediaId: media.id, replyTo: replyTo?.id });
      if (real) mergeMessage(real);
      setReplyTo(null);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        alert((err as Error).message);
      }
    } finally {
      setUploadProgress(null);
      setUploadingFile('');
      uploadAbortRef.current = null;
    }
  };

  const onFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach((f) => {
      const kind: 'photo' | 'file' = f.type.startsWith('image/') ? 'photo' : 'file';
      void sendMedia(f, kind);
    });
  };

  const cancelUpload = () => {
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
    setUploadProgress(null);
    setUploadingFile('');
  };

  const handleSchedule = async () => {
    if (!activeChatId || !draft.trim() || !scheduleDate) return;
    try {
      await api.scheduleMessage(activeChatId, draft.trim(), new Date(scheduleDate).toISOString());
      setDraft('');
      setScheduleOpen(false);
      setScheduleDate('');
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.files;
    if (items && items.length > 0) {
      e.preventDefault();
      onFiles(items);
    }
  };

  const dismissUndoToast = useCallback(() => {
    if (undoToast) {
      clearTimeout(undoToast.timer);
      setUndoToast(null);
    }
  }, [undoToast]);

  const onTyping = (val: string) => {
    setDraft(val);
    if (!activeChatId) return;
    if (typingTimer.current) clearTimeout(typingTimer.current);
    sendTyping(activeChatId, true);
    typingTimer.current = setTimeout(() => sendTyping(activeChatId, false), 1500);
    // Mention autocomplete
    const atIdx = val.lastIndexOf('@');
    if (atIdx >= 0 && (atIdx === 0 || val[atIdx - 1] === ' ')) {
      setMentionQuery(val.slice(atIdx + 1).split(/\s/)[0] || '');
    } else {
      setMentionQuery(null);
    }
    // Link preview detection
    const urlMatch = val.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      const url = urlMatch[0];
      if (!linkPreviews[url]) {
        api.getLinkPreview(url).then((preview) => {
          if (preview) setLinkPreviews((prev) => ({ ...prev, [url]: preview }));
        }).catch(() => {});
      }
    }
  };

  const insertEmoji = (emoji: string) => {
    setDraft((d) => d + emoji);
  };

  const startEdit = (m: { id: number; text?: string }) => {
    setEditingId(m.id);
    setEditText(m.text ?? '');
  };

  const submitEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeChatId || editingId === null || !editText.trim()) return;
    try {
      await editMessage(activeChatId, editingId, editText.trim());
      setEditingId(null);
      setEditText('');
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const onDelete = async (messageId: number) => {
    if (!activeChatId) return;
    const isOwn = msgs.find((m) => m.id === messageId)?.sender_id === me?.id;
    if (isOwn) {
      const choice = window.confirm(t('Delete for everyone?') + '\n\n' + t('OK = for everyone, Cancel = for me'));
      try {
        if (choice) {
          await deleteMessage(activeChatId, messageId, false);
        } else {
          dismissUndoToast();
          const msg = msgs.find((m) => m.id === messageId);
          const timer = setTimeout(() => {
            deleteMessage(activeChatId, messageId, true).catch(() => {});
            setUndoToast(null);
          }, 5000);
          setUndoToast({ messageId, chatId: activeChatId, timer });
        }
      } catch (err) {
        alert((err as Error).message);
      }
    } else {
      dismissUndoToast();
      const timer = setTimeout(() => {
        deleteMessage(activeChatId, messageId, true).catch(() => {});
        setUndoToast(null);
      }, 5000);
      setUndoToast({ messageId, chatId: activeChatId, timer });
    }
  };

  const undoDelete = useCallback(() => {
    if (!undoToast) return;
    clearTimeout(undoToast.timer);
    const { chatId, messageId } = undoToast;
    setUndoToast(null);
    api.undeleteMessage(chatId, messageId).then(() => {
      const list = store.get().messages[chatId] ?? [];
      const msg = list.find((m) => m.id === messageId);
      if (msg) {
        const deletedFor = msg.deleted_for ? [...msg.deleted_for] : [];
        const idx = deletedFor.indexOf(me?.id ?? 0);
        if (idx !== -1) {
          deletedFor.splice(idx, 1);
          mergeMessage({ ...msg, deleted_for: deletedFor } as any);
        }
      }
    }).catch(() => {});
  }, [undoToast, me?.id]);

  const onReply = (m: LayoutMsg) => {
    setReplyTo({ id: m.id, name: senderName(m.sender_id), text: m.text ?? (m.media ? mediaLabel(m.media) : '') });
  };

  const onForward = (m: LayoutMsg) => {
    store.set({
      forwardOpen: {
        chatId: activeChatId!,
        messageId: m.id,
        text: m.decrypted?.text ?? m.text ?? '',
        media: m.media ?? null,
        senderId: m.sender_id,
        senderName: senderName(m.sender_id),
      },
    });
  };

  const onPin = async (m: { id: number }) => {
    if (!activeChatId) return;
    const pins = chat?.chat.pinned_messages ?? (chat?.chat.pinned_id ? [chat.chat.pinned_id] : []);
    const isPinned = pins.includes(m.id);
    const action = isPinned ? 'remove' : 'add';
    try {
      await pinMessage(activeChatId, isPinned ? null : m.id);
      const newPins = isPinned ? pins.filter((id) => id !== m.id) : [...pins, m.id];
      store.set({
        chats: store.get().chats.map((c) =>
          c.chat.id === activeChatId
            ? { ...c, chat: { ...c.chat, pinned_id: newPins[0] ?? null, pinned_messages: newPins } }
            : c,
        ),
      });
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const onReact = async (m: LayoutMsg, emoji: string) => {
    if (!activeChatId) return;
    try {
      const res = await sendReact(activeChatId, m.id, emoji);
      store.set({
        messages: {
          ...store.get().messages,
          [activeChatId]: (store.get().messages[activeChatId] ?? []).map((x) =>
            x.id === m.id ? { ...x, reactions: res } : x,
          ),
        },
      });
    } catch {
      /* ignore */
    }
  };

  const scrollToMessage = (id: number) => {
    document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const clearHistory = async () => {
    if (!activeChatId) return;
    try {
      await api.clearHistory(activeChatId);
      setMessages(activeChatId, []);
      setHistory((h) => ({ ...h, [activeChatId]: {} }));
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setMoreOpen(false);
    }
  };

  const deleteChat = async () => {
    if (!activeChatId) return;
    setMoreOpen(false);
    if (!confirm(t('Delete this chat?'))) return;
    try {
      await api.deleteChat(activeChatId);
      const chats = await api.getChats();
      store.set({ chats, activeChatId: null });
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const toggleBlock = async () => {
    if (!peer) return;
    try {
      if (blocked) await api.removeBlock(peer.id);
      else await api.addBlock(peer.id);
      setBlocked(!blocked);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setMoreOpen(false);
    }
  };

  const leaveGroup = async () => {
    if (!activeChatId) return;
    setMoreOpen(false);
    if (!confirm(t('Leave this group?'))) return;
    try {
      await api.deleteChat(activeChatId);
      const chats = await api.getChats();
      store.set({ chats, activeChatId: null, infoOpen: false });
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = search.q.trim();
    if (!q || !activeChatId) return;
    if (isSecret) {
      // Client-side search for E2E chats: search decrypted text
      const lower = q.toLowerCase();
      const hits: number[] = [];
      for (const m of msgs) {
        const entry = hist[m.id];
        const text = entry?.text ?? m.text ?? '';
        if (text.toLowerCase().includes(lower)) {
          hits.push(m.id);
        }
      }
      setSearch((s) => ({ ...s, hits, current: hits.length ? 0 : -1 }));
    } else {
      const res = await api.searchMessages(activeChatId, q);
      setSearch((s) => ({ ...s, hits: res.map((m) => m.id), current: res.length ? 0 : -1 }));
    }
  };

  const jumpSearch = (dir: number) => {
    setSearch((s) => {
      if (!s.hits.length) return s;
      const n = (s.current + dir + s.hits.length) % s.hits.length;
      return { ...s, current: n };
    });
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';
      const mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: mime || 'audio/webm' });
        if (recorderRef.current?.rafId) cancelAnimationFrame(recorderRef.current.rafId);
        stream.getTracks().forEach((tr) => tr.stop());
        setRec((r) => ({ ...r, state: 'stopped', blob, duration: r.seconds }));
        setLiveWaveform(new Array(24).fill(0));
        if (recTimerRef.current) clearInterval(recTimerRef.current);
      };
      mediaRecorder.start();
      // Live waveform via AnalyserNode
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const BAR_COUNT = 24;
      const drawWaveform = () => {
        analyser.getByteFrequencyData(dataArray);
        const step = Math.floor(dataArray.length / BAR_COUNT);
        const bars = new Array<number>(BAR_COUNT);
        for (let i = 0; i < BAR_COUNT; i++) {
          bars[i] = dataArray[i * step] / 255;
        }
        setLiveWaveform(bars);
        const id = requestAnimationFrame(drawWaveform);
        if (recorderRef.current) recorderRef.current.rafId = id;
      };
      const rafId = requestAnimationFrame(drawWaveform);
      recorderRef.current = { mediaRecorder, stream, chunks, analyser, rafId };
      setRec({ state: 'recording', seconds: 0 });
      recTimerRef.current = setInterval(() => {
        setRec((r) => {
          if (r.state !== 'recording') return r;
          if (r.seconds >= 300) { // 5 minute limit
            if (recorderRef.current?.mediaRecorder.state === 'recording') {
              recorderRef.current.mediaRecorder.stop();
            }
            return { ...r, seconds: 300 };
          }
          return { ...r, seconds: r.seconds + 1 };
        });
      }, 1000);
    } catch {
      alert(t('Microphone unavailable'));
    }
  };

  const stopRecording = () => {
    recorderRef.current?.mediaRecorder.stop();
  };

  const cancelRecording = () => {
    if (recorderRef.current?.rafId) cancelAnimationFrame(recorderRef.current.rafId);
    recorderRef.current?.stream.getTracks().forEach((tr) => tr.stop());
    recorderRef.current = null;
    if (recTimerRef.current) clearInterval(recTimerRef.current);
    setLiveWaveform(new Array(24).fill(0));
    setRec({ state: 'idle', seconds: 0 });
    setRecSwipeX(0);
    recSwipeRef.current = null;
  };

  // Swipe-to-cancel for recording bar
  const onRecSwipeStart = (clientX: number) => {
    recSwipeRef.current = { startX: clientX, currentX: clientX };
  };
  const onRecSwipeMove = (clientX: number) => {
    if (!recSwipeRef.current) return;
    recSwipeRef.current.currentX = clientX;
    const dx = Math.min(0, clientX - recSwipeRef.current.startX); // only left swipe
    setRecSwipeX(dx);
  };
  const onRecSwipeEnd = () => {
    const dx = recSwipeRef.current ? recSwipeRef.current.currentX - recSwipeRef.current.startX : 0;
    recSwipeRef.current = null;
    if (dx < -SWIPE_CANCEL_THRESHOLD) {
      cancelRecording();
    } else {
      setRecSwipeX(0);
    }
  };

  const sendRecording = async () => {
    if (!activeChatId || !rec.blob) return;
    setSending(t('Sending voice…'));
    try {
      if (isSecret && me) {
        const session = secretKeys.get(secretKeyId(me.id, activeChatId));
        if (!session) throw new Error('Encryption session not ready');
        const fileBuffer = await rec.blob.arrayBuffer();
        const fileKey = await generateFileKey();
        const { encrypted, iv } = await encryptFile(fileBuffer, fileKey);
        const fileKeyB64 = await exportFileKey(fileKey);
        const encKey = await encryptSecret(session.sendKey, fileKeyB64);
        const { chainKey: newSendKey } = await ratchetStep(session.sendKey);
        session.sendKey = newSendKey;
        session.messageNum++;
        const { media } = await api.uploadMedia(activeChatId, 'audio', new Blob([encrypted], { type: 'application/octet-stream' }), `e2e_voice_${Date.now()}.webm`, 'application/octet-stream', {
          duration: String(rec.duration ?? 0),
        });
        const keyInfo = JSON.stringify({ e2e_file: true, cipher: encKey.cipher, iv: encKey.iv });
        const real = await doSend({ text: keyInfo, mediaId: media.id });
        if (real) mergeMessage(real);
      } else {
        const { media } = await api.uploadMedia(activeChatId, 'audio', rec.blob, `voice_${Date.now()}.webm`, rec.blob.type, {
          duration: String(rec.duration ?? 0),
        });
        const real = await doSend({ mediaId: media.id });
        if (real) mergeMessage(real);
      }
      setRec({ state: 'idle', seconds: 0 });
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setSending('');
    }
  };

  if (!chat || (!peer && !isGroup)) {
    return (
      <main className="chat-window empty-chat">
        <div className="empty-state">
          <span className="empty-state-icon"><SendIcon size={56} /></span>
          <b>{t('Select a chat to start messaging')}</b>
          <span>{t('Use the search on the left to find a user, or pick an existing conversation.')}</span>
        </div>
      </main>
    );
  }

  const hist = history[activeChatId!] ?? {};
  // In forum mode only show messages of the selected topic (null = General)
  const visibleMsgs: StoredMessage[] = useMemo(
    () => (isForum ? msgs.filter((m) => (m.topic_id ?? null) === activeTopicId) : msgs),
    [msgs, isForum, activeTopicId],
  );
  const layout = useMemo(() => computeLayout(visibleMsgs), [visibleMsgs]);
  const shownMsgs: LayoutMsg[] = useMemo(() => visibleMsgs.map((m, i) => ({ ...m, decrypted: hist[m.id], ...layout[i] })), [visibleMsgs, hist, layout]);

  const withDays: Array<{ type: 'day'; label: string } | { type: 'msg'; msg: LayoutMsg }> = useMemo(() => {
    const result: Array<{ type: 'day'; label: string } | { type: 'msg'; msg: LayoutMsg }> = [];
    let lastDay = '';
    for (const m of shownMsgs) {
      const label = dayLabel(m.created_at);
      if (label !== lastDay) {
        result.push({ type: 'day', label });
        lastDay = label;
      }
      result.push({ type: 'msg', msg: m });
    }
    return result;
  }, [shownMsgs]);

  const replyBar = replyTo ? { name: replyTo.name, text: replyTo.text || t('Deleted message') } : null;
  const pinnedIds = useMemo(() => chat?.chat.pinned_messages ?? (chat?.chat.pinned_id ? [chat.chat.pinned_id] : []), [chat?.chat.pinned_messages, chat?.chat.pinned_id]);
  const pinnedMsgs = useMemo(() => pinnedIds.map((id) => msgs.find((m) => m.id === id)).filter(Boolean) as LayoutMsg[], [pinnedIds, msgs]);

  return (
    <main className="chat-window">
      <header className="chat-header">
        <button
          className="icon-btn mobile-chat-back"
          title={t('Back')}
          aria-label={t('Back')}
          onClick={() => store.set({ activeChatId: null, infoOpen: false })}
        >
          <ChevronLeftIcon size={22} />
        </button>
        <button className="chat-header-user" onClick={() => store.set({ infoOpen: true })} aria-label={`${chatTitle} — ${t('Details')}`}>
          <Avatar user={groupAvatarUser ?? peer} online={isGroup ? undefined : peerOnline} />
          <div className="chat-header-info">
            <b>
              {chatTitle}
              {isSecret && (
                <span className="lock" title={t('Secret chat — end-to-end encrypted')}><LockIcon size={15} /></span>
              )}
              {isChannel && (
                <span className="lock" title={t('Channel')}><MegaphoneIcon size={15} /></span>
              )}
            </b>
            {peerTyping?.isTyping ? (
              <span className="chat-header-status typing">{t('typing…')}</span>
            ) : isGroup ? (
              <span className="chat-header-status">{tx('N members', { n: chat.member_count ?? 0 })}</span>
            ) : (
              <span className={`chat-header-status${peerOnline ? ' online' : ''}`}>
                {peerOnline ? t('online') : t('offline')}
              </span>
            )}
          </div>
        </button>
        <div className="chat-header-actions">
          <button className="icon-btn" title={t('Details')} onClick={() => store.set({ infoOpen: true })}>
            <InfoIcon size={20} />
          </button>
          <button
            className="icon-btn"
            title={t('Search in chat')}
            onClick={() => {
              setSearch((s) => ({ ...s, open: !s.open }));
              setTimeout(() => searchRef.current?.focus(), 50);
            }}
          >
            <SearchIcon size={20} />
          </button>
          <button className="icon-btn" title={t('More')} onClick={() => setMoreOpen((o) => !o)}>
            <DotsIcon size={20} />
          </button>
          {moreOpen && (
            <>
              <div className="overlay-catch" onClick={() => setMoreOpen(false)} />
              <div className="chat-more-menu">
                <button onClick={() => { setMoreOpen(false); store.set({ infoOpen: true }); }}>
                  <InfoIcon size={18} /> {t('Details')}
                </button>
                <button
                  onClick={() => {
                    setMoreOpen(false);
                    setSearch((s) => ({ ...s, open: true }));
                    setTimeout(() => searchRef.current?.focus(), 50);
                  }}
                >
                  <SearchIcon size={18} /> {t('Search in chat')}
                </button>
                {isGroup && canManageGroup && (
                  <>
                    <button onClick={() => { setMoreOpen(false); setShowAddMembers(true); }}>
                      <PersonPlusIcon size={18} /> {t('Add members')}
                    </button>
                    <button onClick={() => { setMoreOpen(false); setShowEditGroup(true); }}>
                      <PencilIcon size={18} /> {t('Edit info')}
                    </button>
                    <button onClick={() => void toggleForumMode()}>
                      <MegaphoneIcon size={18} /> {isForum ? t('Disable topics') : t('Enable topics')}
                    </button>
                  </>
                )}
                <button onClick={clearHistory}><TrashIcon size={18} /> {t('Clear history')}</button>
                {isGroup ? (
                  <button onClick={leaveGroup} className="danger-text"><ExitIcon size={18} /> {t('Leave group')}</button>
                ) : (
                  <>
                    <button onClick={deleteChat} className="danger-text"><BanIcon size={18} /> {t('Delete chat')}</button>
                    <button onClick={toggleBlock} className="danger-text">
                      {blocked ? (<><CheckIcon size={18} /> {t('Unblock')}</>) : (<><BanIcon size={18} /> {t('Block')}</>)}
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </header>

      {search.open && (
        <div className="chat-search-bar">
          <form className="chat-search-form" onSubmit={runSearch}>
            <input
              ref={searchRef}
              value={search.q}
              onChange={(e) => setSearch((s) => ({ ...s, q: e.target.value }))}
              placeholder={t('Search in chat…')}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSearch({ open: false, q: '', hits: [], current: -1 });
              }}
            />
          </form>
          <span className="chat-search-count">
            {search.hits.length ? `${search.current + 1}/${search.hits.length}` : t('no results')}
          </span>
          <button className="icon-btn" title={t('Previous')} disabled={!search.hits.length} onClick={() => jumpSearch(-1)}>
            <ArrowUpIcon size={18} />
          </button>
          <button className="icon-btn" title={t('search_next')} disabled={!search.hits.length} onClick={() => jumpSearch(1)}>
            <ArrowDownIcon size={18} />
          </button>
          <button className="icon-btn" title={t('Close search')} onClick={() => setSearch({ open: false, q: '', hits: [], current: -1 })}>
            <CloseIcon size={18} />
          </button>
        </div>
      )}

      {isForum && (
        <div className="forum-bar" role="tablist" aria-label={t('Topics')}>
          <button
            role="tab"
            aria-selected={activeTopicId === null}
            className={`forum-chip${activeTopicId === null ? ' active' : ''}`}
            onClick={() => setActiveTopicId(null)}
          >
            {t('General')}
          </button>
          {topics.map((tp) => (
            <button
              key={tp.id}
              role="tab"
              aria-selected={activeTopicId === tp.id}
              className={`forum-chip${activeTopicId === tp.id ? ' active' : ''}`}
              onClick={() => setActiveTopicId(tp.id)}
            >
              {canManageGroup && (
                <span
                  className="topic-delete"
                  title={t('Delete topic')}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!confirm(t('Delete this topic?'))) return;
                    api.deleteTopic(chat!.chat.id, tp.id)
                      .then(() => {
                        setTopics((list) => list.filter((x) => x.id !== tp.id));
                        setActiveTopicId((cur) => (cur === tp.id ? null : cur));
                      })
                      .catch((err) => alert((err as Error).message));
                  }}
                >
                  ×
                </span>
              )}
              {tp.title}
            </button>
          ))}
          {canManageGroup && (
            showNewTopic ? (
              <span className="forum-new-topic">
                <input
                  autoFocus
                  value={newTopicTitle}
                  placeholder={t('Topic title')}
                  maxLength={128}
                  onChange={(e) => setNewTopicTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void createTopic();
                    }
                    if (e.key === 'Escape') {
                      setShowNewTopic(false);
                      setNewTopicTitle('');
                    }
                  }}
                />
                <button type="button" className="forum-chip forum-chip-create" onClick={() => void createTopic()}>
                  {t('Create')}
                </button>
              </span>
            ) : (
              <button type="button" className="forum-chip forum-chip-create" onClick={() => setShowNewTopic(true)}>
                + {t('New topic')}
              </button>
            )
          )}
        </div>
      )}

      <div
        className="messages"
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-label={t('Messages')}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDragging(true);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
            setDragging(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          onFiles(e.dataTransfer.files);
        }}
      >
        {dragging && (
          <div className="drop-overlay">
            <PaperclipIcon size={40} />
            <b>{t('Drop files here to send')}</b>
          </div>
        )}
        {/* Lazy-load sentinel: load older messages when scrolled to top */}
        <div ref={(el) => {
          if (!el || !activeChatId) return;
          const observer = new IntersectionObserver(
            (entries) => {
              if (entries[0]?.isIntersecting && msgs.length > 0 && !loadError) {
                const oldestId = msgs[0]?.id;
                if (oldestId) loadMessages(activeChatId, oldestId);
              }
            },
            { root: scrollRef.current, threshold: 0.1 },
          );
          observer.observe(el);
          return () => observer.disconnect();
        }} className="scroll-sentinel" style={{ height: 1 }} />
        {loadError && (
          <div className="empty-state">
            <span className="empty-state-icon"><AlertIcon size={56} /></span>
            <b>{t('Failed to load messages')}</b>
            <button className="btn primary" onClick={() => activeChatId && loadMessages(activeChatId)}>{t('Retry')}</button>
          </div>
        )}
        {!loadError && msgs.length === 0 && !sending && (
          <div className="empty-state">
            <span className="empty-state-icon"><SendIcon size={48} /></span>
            <b>{t('No messages yet. Say hello!')}</b>
          </div>
        )}
        {activeChatId && !(messages[activeChatId]) && !loadError && (
          <div className="chat-skeleton" role="status" aria-label={t('Loading…')}>
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className={`skeleton-msg ${i % 2 === 0 ? 'skeleton-msg-mine' : ''}`}>
                <div className="skeleton-avatar" />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div className="skeleton-bar skeleton-bar-name" />
                  <div className="skeleton-bar skeleton-bar-text" />
                  <div className="skeleton-bar skeleton-bar-text" style={{ width: '8rem' }} />
                </div>
              </div>
            ))}
          </div>
        )}
        {pinnedMsgs.length > 0 && (
          <div className="pinned-bar">
            <PinIcon size={15} />
            <div className="pinned-bar-body">
              <b>{pinnedMsgs.length === 1 ? t('Pinned message') : tx('Pinned messages', { n: pinnedMsgs.length })}</b>
              <span>{pinnedMsgs.map((pm) => pm.text ?? (pm.media ? mediaLabel(pm.media) : '')).join(' · ')}</span>
            </div>
            <button className="icon-btn" title={t('Scroll to pinned')} onClick={() => scrollToMessage(pinnedMsgs[0].id)}>
              <ArrowDownIcon size={16} />
            </button>
          </div>
        )}
        {withDays.map((item, i) =>
          item.type === 'day' ? (
            <div key={`d${i}`} className="day-sep">{item.label}</div>
          ) : (
            <MessageRow
              key={item.msg.id}
              msg={item.msg}
              mine={item.msg.sender_id === me!.id}
              meId={me!.id}
              meName={senderName(me!.id)}
              peer={peer}
              groupMode={isGroup}
              senderUser={
                isGroup
                  ? (item.msg.sender_user ??
                    users[item.msg.sender_id] ?? {
                      id: item.msg.sender_id,
                      first_name: senderName(item.msg.sender_id),
                    })
                  : undefined
              }
              allMsgs={msgs}
              onEdit={startEdit}
              onDelete={onDelete}
              onReply={onReply}
              onForward={onForward}
              allowForward={true}
              onReact={onReact}
              onPin={onPin}
              allowEdit={!isSecret}
              isPinned={pinnedIds.includes(item.msg.id)}
              onOpenMedia={(m, fk) => { setLightbox(m); setLightboxFileKey(fk); }}
              editing={editingId === item.msg.id}
              editText={editText}
              setEditText={setEditText}
              submitEdit={submitEdit}
              highlight={search.open ? search.q.trim() : ''}
              searchHit={search.current >= 0 && search.hits[search.current] === item.msg.id}
              scrollToMessage={scrollToMessage}
              onRetry={(m) => {
                if (!activeChatId) return;
                resendMessage(activeChatId, m.id, m.text ?? '');
              }}
              onCancel={(m) => {
                if (!activeChatId) return;
                cancelMessage(activeChatId, m.id);
              }}
              onThreadOpen={handleThreadOpen}
              onHashtagClick={handleHashtagClick}
              onEditHistory={async (messageId: number) => {
                try {
                  const resp = await fetch(`/api/messages/${messageId}/history`, { credentials: 'include' });
                  const data = await resp.json();
                  setEditHistoryOpen({ messageId, history: data });
                } catch { /* ignore */ }
              }}
            />
          ),
        )}
      </div>

      {editingId !== null && (
        <div className="editing-bar">{t('Editing message — press Enter to save')}</div>
      )}

      {replyBar && (
        <div className="reply-bar">
          <div className="reply-bar-body">
            <b>{t('Replying to')} {replyBar.name}</b>
            <span>{replyBar.text}</span>
          </div>
          <button className="icon-btn" title={t('Cancel')} onClick={() => setReplyTo(null)}>
            <CloseIcon size={16} />
          </button>
        </div>
      )}

      {rec.state === 'recording' || rec.state === 'stopped' ? (
        <div
          className={`recording-bar${recSwipeX < -20 ? ' swiping' : ''}${recSwipeX < -SWIPE_CANCEL_THRESHOLD ? ' cancel-ready' : ''}`}
          style={{ transform: `translateX(${Math.max(-150, recSwipeX)}px)`, opacity: recSwipeX < -SWIPE_CANCEL_THRESHOLD ? 0.5 : 1 }}
          onTouchStart={(e) => onRecSwipeStart(e.touches[0].clientX)}
          onTouchMove={(e) => onRecSwipeMove(e.touches[0].clientX)}
          onTouchEnd={onRecSwipeEnd}
          onMouseDown={(e) => { e.preventDefault(); onRecSwipeStart(e.clientX); }}
        >
          <button className="icon-btn danger-text" onClick={cancelRecording} title={t('Cancel')}>
            <CloseIcon size={20} />
          </button>
          <span className={`rec-dot${rec.state === 'recording' ? ' live' : ''}`} />
          <span className="rec-time">{String(Math.floor(rec.seconds / 60)).padStart(2, '0')}:{String(rec.seconds % 60).padStart(2, '0')}</span>
          {rec.state === 'recording' && (
            <div className="rec-waveform">
              {liveWaveform.map((h, i) => (
                <span key={i} className="rec-waveform-bar" style={{ height: `${Math.max(2, h * 24)}px` }} />
              ))}
            </div>
          )}
          <span className="rec-label">{rec.state === 'recording' ? t('Recording…') : t('Ready to send')}</span>
          {rec.state === 'recording' ? (
            <button className="composer-send" onClick={stopRecording} title={t('Stop recording')}>
              <StopIcon size={20} />
            </button>
          ) : (
            <button className="composer-send" onClick={sendRecording} title={t('Send')}>
              <SendIcon size={20} />
            </button>
          )}
        </div>
      ) : (
        <>
          {mentionQuery !== null && activeChatId && (
            <MentionAutocomplete
              chatId={activeChatId}
              query={mentionQuery}
              onSelect={(username) => {
                setDraft((prev) => {
                  const atIdx = prev.lastIndexOf('@');
                  return prev.slice(0, atIdx) + '@' + username + ' ';
                });
                setMentionQuery(null);
              }}
              onClose={() => setMentionQuery(null)}
            />
          )}
        <form className="composer" onSubmit={handleSend}>
          <input
            type="file"
            ref={fileRef}
            multiple
            hidden
            onChange={(e) => {
              onFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <button type="button" className="composer-attach" onClick={() => setEmojiOpen((o) => !o)} title={t('Emoji')}>
            <SmileIcon size={22} />
          </button>
          <button type="button" className="composer-attach" onClick={() => fileRef.current?.click()} title={t('Attach')}>
            <PaperclipIcon size={22} />
          </button>
          <input
            placeholder={editingId !== null ? t('Edit message…') : t('Write a message…')}
            value={editingId !== null ? editText : draft}
            onChange={(e) => (editingId !== null ? setEditText(e.target.value) : onTyping(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setEditingId(null);
                setEditText('');
              }
            }}
            onPaste={editingId !== null ? undefined : onPaste}
            autoFocus
            maxLength={4096}
            aria-label={editingId !== null ? t('Edit message…') : t('Write a message…')}
          />
          {editingId === null && (
            <div className="expires-picker-wrap">
              <button type="button" className={`composer-attach${expiresIn ? ' expires-active' : ''}`} onClick={() => setExpiresMenu((o) => !o)} title={t('Disappearing message')}>
                <ClockIcon size={20} />
                {expiresIn && <span className="expires-badge">{expiresIn < 3600 ? `${expiresIn / 60}s` : `${expiresIn / 3600}h`}</span>}
              </button>
              {expiresMenu && (
                <>
                  <div className="overlay-catch" onClick={() => setExpiresMenu(false)} />
                  <div className="expires-menu">
                    <button className={!expiresIn ? 'active' : ''} onClick={() => { setExpiresIn(null); setExpiresMenu(false); }}>{t('Off')}</button>
                    <button className={expiresIn === 30 ? 'active' : ''} onClick={() => { setExpiresIn(30); setExpiresMenu(false); }}>30 {t('seconds')}</button>
                    <button className={expiresIn === 60 ? 'active' : ''} onClick={() => { setExpiresIn(60); setExpiresMenu(false); }}>1 {t('minute')}</button>
                    <button className={expiresIn === 300 ? 'active' : ''} onClick={() => { setExpiresIn(300); setExpiresMenu(false); }}>5 {t('minutes')}</button>
                    <button className={expiresIn === 3600 ? 'active' : ''} onClick={() => { setExpiresIn(3600); setExpiresMenu(false); }}>1 {t('hour')}</button>
                    <button className={expiresIn === 86400 ? 'active' : ''} onClick={() => { setExpiresIn(86400); setExpiresMenu(false); }}>1 {t('day')}</button>
                    <button className={expiresIn === 604800 ? 'active' : ''} onClick={() => { setExpiresIn(604800); setExpiresMenu(false); }}>7 {t('days')}</button>
                  </div>
                </>
              )}
            </div>
          )}
          {editingId !== null || draft.trim() ? (
            <button
              type="submit"
              className="composer-send"
              disabled={editingId !== null ? !editText.trim() : !draft.trim()}
              title={t('Send')}
            >
              <SendIcon />
            </button>
          ) : (
            <button type="button" className="composer-attach" onClick={startRecording} title={t('Voice message')}>
              <MicIcon size={22} />
            </button>
          )}
        </form>
        {isChannel && (
          <div className="schedule-bar">
            <button type="button" className="icon-btn" title={t('Schedule message')} onClick={() => setScheduleOpen((o) => !o)}>
              <ClockIcon size={18} />
            </button>
            {scheduleOpen && (
              <div className="schedule-menu">
                <input type="datetime-local" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)} />
                <button className="btn primary" disabled={!scheduleDate || !draft.trim()} onClick={handleSchedule}>{t('Schedule')}</button>
              </div>
            )}
          </div>
        )}
        </>
      )}

      {emojiOpen && (
        <>
          <div className="overlay-catch" onClick={() => setEmojiOpen(false)} />
          <EmojiPicker onPick={insertEmoji} onStickerPick={(sticker) => { setEmojiOpen(false); doSend({ text: sticker.emoji, mediaId: sticker.file_id }); }} onGifPick={(gif) => { setEmojiOpen(false); setDraft((prev) => (prev ? prev + ' ' : '') + gif.url); }} />
        </>
      )}

      {uploadProgress !== null && (
        <div className="upload-progress-bar">
          <div className="upload-progress-info">
            <span>{uploadingFile || t('Uploading…')} {uploadProgress}%</span>
            <button className="icon-btn danger-text" onClick={cancelUpload} title={t('Cancel upload')}>
              <CloseIcon size={16} />
            </button>
          </div>
          <div className="upload-progress-track">
            <div className="upload-progress-fill" style={{ width: `${uploadProgress}%` }} />
          </div>
        </div>
      )}

      {sending && <div className="sending-toast">{sending}</div>}

      {lightbox && (
        <Lightbox media={lightbox} onClose={() => setLightbox(null)} fileKey={lightboxFileKey} />
      )}

      {forwardOpen && (
        <ForwardModal forward={forwardOpen} onClose={() => store.set({ forwardOpen: null })} />
      )}

      {showAddMembers && activeChatId && (
        <AddMembersModal chatId={activeChatId} onClose={() => setShowAddMembers(false)} />
      )}
      {showEditGroup && activeChatId && (
        <EditGroupModal chatId={activeChatId} onClose={() => setShowEditGroup(false)} />
      )}

      {undoToast && (
        <div className="undo-toast">
          <span>{t('Message deleted. Undo?')}</span>
          <button className="undo-toast-btn" onClick={undoDelete}>{t('Undo')}</button>
        </div>
      )}

      {hashtagSearch && (
        <>
          <div className="overlay-catch" onClick={() => setHashtagSearch(null)} />
          <div className="modal-overlay" onClick={() => setHashtagSearch(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480, width: '95%', maxHeight: '70vh', display: 'flex', flexDirection: 'column' }}>
              <div className="modal-header">
                <h3>#{hashtagSearch.tag}</h3>
                <button className="icon-btn" onClick={() => setHashtagSearch(null)}>✕</button>
              </div>
              <div style={{ overflow: 'auto', flex: 1, padding: '8px 0' }}>
                {hashtagSearch.results.length === 0 && <div className="muted" style={{ padding: 16 }}>{t('Nothing found')}</div>}
                {hashtagSearch.results.map((r) => (
                  <div key={r.id} className="search-item" style={{ cursor: 'pointer' }} onClick={() => { setHashtagSearch(null); scrollToMessage(r.id); }}>
                    <div className="search-item-info" style={{ flex: 1 }}>
                      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{r.text}</div>
                      <span className="muted" style={{ fontSize: 12 }}>{new Date(r.created_at).toLocaleString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {threadOpen && (
        <>
          <div className="overlay-catch" onClick={() => setThreadOpen(null)} />
          <div className="modal-overlay" onClick={() => setThreadOpen(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520, width: '95%', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
              <div className="modal-header">
                <h3>{t('Thread')}</h3>
                <button className="icon-btn" onClick={() => setThreadOpen(null)}>✕</button>
              </div>
              <div style={{ overflow: 'auto', flex: 1, padding: '8px 0' }}>
                {threadOpen.replies.length === 0 && <div className="muted" style={{ padding: 16 }}>{t('No replies yet')}</div>}
                {threadOpen.replies.map((r: any) => (
                  <div key={r.id} className="search-item" style={{ alignItems: 'flex-start' }}>
                    <div className="search-item-info" style={{ flex: 1 }}>
                      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{r.text || t('Media')}</div>
                      <span className="muted" style={{ fontSize: 12 }}>{new Date(r.created_at).toLocaleString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {editHistoryOpen && (
        <>
          <div className="overlay-catch" onClick={() => setEditHistoryOpen(null)} />
          <div className="modal-overlay" onClick={() => setEditHistoryOpen(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520, width: '95%', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
              <div className="modal-header">
                <h3>{t('Edit history')}</h3>
                <button className="icon-btn" onClick={() => setEditHistoryOpen(null)}>✕</button>
              </div>
              <div style={{ overflow: 'auto', flex: 1, padding: '8px 0' }}>
                {editHistoryOpen.history.length === 0 && <div className="muted" style={{ padding: 16 }}>{t('No edit history')}</div>}
                {editHistoryOpen.history.map((h) => (
                  <div key={h.id} className="search-item" style={{ alignItems: 'flex-start' }}>
                    <div className="search-item-info" style={{ flex: 1 }}>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {[h.user.first_name, h.user.last_name].filter(Boolean).join(' ') || `@${h.user.username || ''}`} · {new Date(h.edited_at).toLocaleString()}
                      </span>
                      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 4 }}>{h.text || t('Media')}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </main>
  );
}

function mediaLabel(media: MediaDTO): string {
  if (media.kind === 'photo') return t('Photo');
  if (media.kind === 'audio') return t('Voice message');
  return media.name || t('File');
}

function MessageRowInner(props: {
  msg: LayoutMsg;
  mine: boolean;
  meId: number;
  meName: string;
  peer: { id: number; first_name: string; last_name?: string; photo?: string | null } | null;
  groupMode: boolean;
  senderUser?: { id?: number; username?: string; first_name?: string; last_name?: string; photo?: string | null } | null;
  allMsgs: StoredMessage[];
  onEdit: (m: { id: number; text?: string }) => void;
  onDelete: (id: number) => void;
  onReply: (m: LayoutMsg) => void;
  onForward: (m: LayoutMsg) => void;
  allowForward: boolean;
  onReact: (m: LayoutMsg, emoji: string) => void;
  onPin: (m: LayoutMsg) => void;
  allowEdit: boolean;
  isPinned: boolean;
  onOpenMedia: (m: MediaDTO, fileKey?: string) => void;
  editing: boolean;
  editText: string;
  setEditText: (s: string) => void;
  submitEdit: (e: React.FormEvent) => void;
  highlight?: string;
  searchHit?: boolean;
  scrollToMessage: (id: number) => void;
  onRetry?: (m: LayoutMsg) => void;
  onCancel?: (m: LayoutMsg) => void;
  onThreadOpen?: (parentId: number) => void;
  onHashtagClick?: (tag: string) => void;
  onEditHistory?: (messageId: number) => void;
}) {
  const {
    msg,
    mine,
    meId,
    meName,
    peer,
    groupMode,
    senderUser,
    allMsgs,
    onEdit,
    onDelete,
    onReply,
    onForward,
    allowForward,
    onReact,
    onPin,
    allowEdit,
    isPinned,
    onOpenMedia,
    editing,
    editText,
    setEditText,
    submitEdit,
    highlight,
    searchHit,
    scrollToMessage,
    onRetry,
    onCancel,
    onThreadOpen,
    onHashtagClick,
    onEditHistory,
  } = props;
  useLang();
  const [menu, setMenu] = useState<'actions' | 'react' | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const longPressed = useRef(false);

  const openReactPicker = () => {
    setMenu((m) => (m === 'react' ? null : 'react'));
  };

  const clearPressTimer = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = undefined;
    }
  };

  const onBubbleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    openReactPicker();
  };

  const onBubbleTouchStart = () => {
    longPressed.current = false;
    clearPressTimer();
    pressTimer.current = setTimeout(() => {
      longPressed.current = true;
      openReactPicker();
    }, 500);
  };

  const onBubbleTouchEnd = () => {
    clearPressTimer();
  };

  useEffect(() => () => clearPressTimer(), []);

  const text = msg.decrypted?.text ?? msg.text ?? '';
  const read = Boolean(msg.read_at);
  const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const replyMsg = msg.reply_to ? allMsgs.find((m) => m.id === msg.reply_to) : null;
  const replyText = replyMsg
    ? (replyMsg.text ?? (replyMsg.media ? mediaLabel(replyMsg.media) : t('Encrypted message')))
    : '';
  const senderDisplay = senderUser
    ? [senderUser.first_name, senderUser.last_name].filter(Boolean).join(' ') || `@${senderUser.username || ''}`.trim() || t('Unknown')
    : '';
  const replyName = replyMsg
    ? (replyMsg.sender_id === meId ? meName : senderDisplay || (peer ? [peer.first_name, peer.last_name].filter(Boolean).join(' ') : t('Unknown')))
    : '';
  const reactions = msg.reactions ?? [];

  const content = editing ? (
    <form className="inline-edit" onSubmit={submitEdit}>
      <input value={editText} onChange={(e) => setEditText(e.target.value)} autoFocus />
    </form>
  ) : msg.decrypted?.decryptError ? (
    <span className="decrypt-err"><LockIcon size={15} /> {t('Cannot decrypt message')}</span>
  ) : null;

  return (
    <div
      id={`msg-${msg.id}`}
      className={`bubble-row ${mine ? 'mine' : 'theirs'} ${msg.first ? 'first' : ''} ${msg.last ? 'last' : ''} ${searchHit ? 'msg-hit' : ''}`}
      onDoubleClick={() => onReact(msg, '❤️')}
      onContextMenu={onBubbleContextMenu}
      onTouchStart={onBubbleTouchStart}
      onTouchEnd={onBubbleTouchEnd}
      onTouchMove={onBubbleTouchEnd}
      role="article"
      aria-label={mine ? t('You') : (senderUser?.first_name || peer?.first_name || t('Unknown'))}
    >
      {!mine && msg.last && <Avatar user={groupMode ? (senderUser ?? peer) : peer} size={42} />}

      <div
        className={`bubble ${mine ? 'mine' : 'theirs'} ${msg.pending ? 'pending' : ''} ${msg.failed ? 'failed' : ''} ${menu ? 'menu-open' : ''}`}
        onClick={() => {
          if (longPressed.current) {
            longPressed.current = false;
            return;
          }
          setMenu(null);
        }}
      >
        {menu && (
          <>
            <div className="overlay-catch" onClick={() => setMenu(null)} />
            {menu === 'react' ? (
              <div className="react-quick">
                {QUICK_REACTIONS.map((e) => (
                  <button key={e} className="emoji-cell" onClick={() => { onReact(msg, e); setMenu(null); }}>
                    {e}
                  </button>
                ))}
              </div>
            ) : (
              <div className="bubble-actions">
                <button title={t('React')} onClick={() => setMenu('react')}><SmileIcon size={16} /></button>
                <button title={t('Reply')} onClick={() => onReply(msg)}><ReplyIcon size={16} /></button>
                <button title={t('Reply in thread')} onClick={() => { onThreadOpen?.(msg.id); setMenu(null); }}>🧵</button>
                {allowForward && <button title={t('Forward')} onClick={() => onForward(msg)}><ForwardIcon size={16} /></button>}
                {allowForward && <button title={t('Save to Saved Messages')} onClick={() => onForward(msg)}><BookmarkIcon size={16} /></button>}
                {isPinned ? (
                  <button title={t('Unpin')} className={isPinned ? 'pinned-active' : ''} onClick={() => onPin(msg)}><PinIcon size={16} /></button>
                ) : (
                  <button title={t('Pin')} onClick={() => onPin(msg)}><PinIcon size={16} /></button>
                )}
                {mine && allowEdit && text && !editing && (
                  <button title={t('Edit')} onClick={() => onEdit({ id: msg.id, text })}><PencilIcon size={16} /></button>
                )}
                {msg.edited_at && (
                  <button title={t('Edit history')} onClick={() => onEditHistory?.(msg.id)}>📜</button>
                )}
                {mine && !editing && (
                  <button title={t('Delete')} className="danger-text" onClick={() => onDelete(msg.id)}><TrashIcon size={16} /></button>
                )}
                {!mine && !editing && (
                  <button title={t('Report')} className="danger-text" onClick={async () => {
                    const reason = prompt(t('Report reason') + ':');
                    if (reason) {
                      try { await api.report('message', msg.id, reason); } catch { /* ignore */ }
                    }
                  }}><AlertIcon size={16} /></button>
                )}
              </div>
            )}
          </>
        )}
        {replyMsg && (
          <button className="reply-preview" onClick={() => scrollToMessage(replyMsg.id)}>
            <span className="reply-name">{replyName}</span>
            <span className="reply-text">{replyText}</span>
          </button>
        )}
        {msg.forwarded_from && (
          <div className="forwarded-head">
            <ForwardIcon size={14} />
            <b>{t('Forwarded from')} {msg.forwarded_from.name}</b>
          </div>
        )}
        {groupMode && !mine && msg.first && senderDisplay && (
          <span className="bubble-sender-name">{senderDisplay}</span>
        )}
        {msg.media && (
          <div className="bubble-media">
            {msg.media.kind === 'photo' ? (
              <MediaImage media={msg.media} className="bubble-photo" onClick={() => onOpenMedia(msg.media!, msg.decrypted?.fileKey)} e2eFileKey={msg.decrypted?.fileKey} />
            ) : msg.media.kind === 'audio' ? (
              <VoicePlayer media={msg.media} e2eFileKey={msg.decrypted?.fileKey} />
            ) : (
              <div className="file-card">
                <span className="file-card-icon"><FileIcon size={30} /></span>
                <div className="file-card-info">
                  <b>{msg.media.name}</b>
                  <span className="muted">{formatBytes(msg.media.size)}</span>
                </div>
                <button className="icon-btn" title={t('Download')} onClick={() => downloadE2EMedia(msg.media!, msg.decrypted?.fileKey)}>
                  <DownloadIcon size={18} />
                </button>
              </div>
            )}
          </div>
        )}
        {content !== null
          ? content
          : !msg.decrypted?.decryptError && text && (
              <span className="bubble-text">{highlight ? highlightText(text, highlight) : formatMarkdown(text, onHashtagClick)}</span>
            )}
        {msg.link_preview && (
          <a href={msg.link_preview.url} target="_blank" rel="noopener noreferrer" className="link-preview">
            {msg.link_preview.image && <img src={msg.link_preview.image} alt="" className="link-preview-img" />}
            <div className="link-preview-info">
              {msg.link_preview.title && <b className="link-preview-title">{msg.link_preview.title}</b>}
              {msg.link_preview.description && <span className="link-preview-desc">{msg.link_preview.description}</span>}
              <span className="link-preview-url">{new URL(msg.link_preview.url).hostname}</span>
            </div>
          </a>
        )}
        {!editing && (
          <span className="bubble-meta">
            {msg.edited_at && <span className="edited">{t('edited')}</span>}
            {msg.expires_at && <span className="msg-timer-badge"><ClockIcon size={12} /> {formatExpiry(msg.expires_at)}</span>}
            <span>{time}</span>
            {msg.failed && <AlertIcon size={14} className="status-failed" />}
            {msg.failed && onRetry && (
              <button className="retry-btn" title={t('Retry')} onClick={(e) => { e.stopPropagation(); onRetry(msg); }}>↻</button>
            )}
            {msg.failed && onCancel && (
              <button className="cancel-btn" title={t('Cancel')} onClick={(e) => { e.stopPropagation(); onCancel(msg); }}>✕</button>
            )}
            {mine && !msg.failed && (
              <span className={`ticks ${msg.pending ? '' : read ? '' : msg.delivered_at ? '' : 'gray'}`}>
                {msg.pending ? <ClockIcon size={14} /> : read ? <CheckCheckIcon size={14} /> : msg.delivered_at ? <CheckCheckIcon size={14} /> : <CheckIcon size={14} />}
              </span>
            )}
          </span>
        )}
      </div>

      {reactions.length > 0 && (
        <div className={`bubble-reactions${mine ? ' mine' : ''}`}>
          {reactions.map((r) => (
            <span key={r.emoji} className={`reaction-chip${r.mine ? ' mine' : ''}`} onClick={() => onReact(msg, r.emoji)}>
              {r.emoji} {r.count > 1 && <i>{r.count}</i>}
            </span>
          ))}
        </div>
      )}
      {allMsgs.filter((m) => m.thread_id === msg.id).length > 0 && (
        <button className="thread-count-btn" onClick={(e) => { e.stopPropagation(); /* handled by parent */ }}>
          💬 {allMsgs.filter((m) => m.thread_id === msg.id).length} {t('replies')}
        </button>
      )}
    </div>
  );
}

const MessageRow = memo(MessageRowInner);

function Lightbox({ media, onClose, fileKey }: { media: MediaDTO; onClose: () => void; fileKey?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (fileKey) {
      (async () => {
        try {
          const blob = await api.fetchMediaBlob(media.id);
          const arrayBuf = await blob.arrayBuffer();
          const key = await importFileKey(fileKey);
          const decrypted = await decryptFile(arrayBuf, new ArrayBuffer(0), key);
          const decBlob = new Blob([decrypted], { type: media.mime || 'application/octet-stream' });
          if (alive) setUrl(URL.createObjectURL(decBlob));
        } catch { /* ignore */ }
      })();
    } else {
      getMediaUrl(media.id).then((u) => alive && setUrl(u)).catch(() => {});
    }
    return () => { alive = false; };
  }, [media.id, fileKey]);
  return (
    <div className="lightbox" onClick={onClose}>
      <button className="icon-btn lightbox-close" onClick={onClose} title={t('Close')}>
        <CloseIcon size={22} />
      </button>
      {url && <img src={url} alt={media.name} onClick={(e) => e.stopPropagation()} />}
      <button className="lightbox-download icon-btn" title={t('Download')} onClick={() => downloadE2EMedia(media, fileKey)}>
        <DownloadIcon size={20} />
      </button>
    </div>
  );
}

function highlightText(text: string, q: string) {
  const qLower = q.toLowerCase();
  const lower = text.toLowerCase();
  if (!qLower || !lower.includes(qLower)) return text;
  const parts: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(qLower, i);
    if (idx === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(<mark key={idx}>{text.slice(idx, idx + q.length)}</mark>);
    i = idx + q.length;
  }
  return parts;
}
