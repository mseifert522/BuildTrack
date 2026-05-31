import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, MessageSquare, Send, User, Users } from 'lucide-react';
import api from '../lib/api';
import { useAuthStore, isAdminRole, roleLabels } from '../store/authStore';
import { formatEasternRelative } from '../lib/time';
import toast from 'react-hot-toast';

interface ChatUser {
  id: string;
  name: string;
  email: string;
  role: string;
  avatar_url?: string | null;
  is_online: number;
}

interface ChatMessage {
  id: string;
  sender_id: string;
  recipient_id?: string | null;
  message: string;
  created_at: string;
  sender_name: string;
  sender_role: string;
  sender_avatar_url?: string | null;
  recipient_name?: string | null;
}

let notificationAudioContext: AudioContext | null = null;
let notificationAudioUnlocked = false;

function getNotificationAudioContext() {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!notificationAudioContext || notificationAudioContext.state === 'closed') {
      notificationAudioContext = new AudioContextClass();
    }
    return notificationAudioContext;
  } catch {
    return null;
  }
}

async function primeNotificationAudio() {
  try {
    const context = getNotificationAudioContext();
    if (!context) return;
    if (context.state === 'suspended') await context.resume();

    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = context.createBuffer(1, 1, context.sampleRate);
    gain.gain.value = 0.0001;
    source.connect(gain);
    gain.connect(context.destination);
    source.start();
    notificationAudioUnlocked = true;
  } catch {
    // Browsers only allow notification audio after a user gesture.
  }
}

async function playChime() {
  try {
    const context = getNotificationAudioContext();
    if (!context) return;
    if (context.state === 'suspended') await context.resume();
    if (context.state !== 'running') return;
    notificationAudioUnlocked = true;
    const baseTime = context.currentTime + 0.01;
    const playTone = (frequency: number, start: number, duration: number) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, baseTime + start);
      gain.gain.setValueAtTime(0.001, baseTime + start);
      gain.gain.exponentialRampToValueAtTime(0.16, baseTime + start + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.001, baseTime + start + duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(baseTime + start);
      oscillator.stop(baseTime + start + duration + 0.02);
    };
    playTone(880, 0, 0.16);
    playTone(1175, 0.17, 0.18);
  } catch {
    // The toast and unread badge still provide a visual notification if audio is blocked.
  }
}

export default function ManagementChatWidget() {
  const { user } = useAuthStore();
  const [minimized, setMinimized] = useState(true);
  const [users, setUsers] = useState<ChatUser[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [recipientId, setRecipientId] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [unread, setUnread] = useState(0);
  const initializedRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  const canChat = user && isAdminRole(user.role);

  const recipientName = useMemo(() => {
    if (!recipientId) return 'Everyone';
    return users.find(item => item.id === recipientId)?.name || 'Direct message';
  }, [recipientId, users]);

  const loadUsers = async () => {
    const res = await api.get('/chat/users');
    setUsers(res.data || []);
  };

  const loadMessages = async () => {
    const res = await api.get('/chat/messages?limit=100');
    const nextMessages: ChatMessage[] = res.data || [];
    const currentIds = new Set(messagesRef.current.map(message => message.id));
    const incoming = nextMessages.filter(message => !currentIds.has(message.id) && message.sender_id !== user?.id);
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
    if (initializedRef.current && incoming.length > 0) {
      if (minimized) setUnread(count => count + incoming.length);
      void playChime();
      const newest = incoming[incoming.length - 1];
      toast.custom(t => (
        <button
          type="button"
          onClick={() => {
            toast.dismiss(t.id);
            setRecipientId(newest.recipient_id ? newest.sender_id : '');
            setMinimized(false);
          }}
          className="pointer-events-auto flex w-80 max-w-[calc(100vw-1rem)] items-start gap-3 rounded-xl border border-amber-100 bg-white p-3 text-left shadow-xl"
        >
          <span className="mt-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700">
            <MessageSquare className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-black uppercase tracking-wide text-amber-700">New IM message</span>
            <span className="mt-0.5 block truncate text-sm font-bold text-gray-900">{newest.sender_name}</span>
            <span className="mt-0.5 block line-clamp-2 text-xs text-gray-600">{newest.message}</span>
          </span>
        </button>
      ), { duration: 6500, position: 'top-right' });
    }
    initializedRef.current = true;
  };

  useEffect(() => {
    if (!canChat) return;
    const unlockNotificationAudio = () => {
      if (!notificationAudioUnlocked) void primeNotificationAudio();
    };

    window.addEventListener('pointerdown', unlockNotificationAudio);
    window.addEventListener('keydown', unlockNotificationAudio);
    window.addEventListener('touchstart', unlockNotificationAudio);
    loadUsers().catch(() => {});
    loadMessages().catch(() => {});
    const timer = window.setInterval(() => {
      loadUsers().catch(() => {});
      loadMessages().catch(() => {});
    }, 5000);
    return () => {
      window.removeEventListener('pointerdown', unlockNotificationAudio);
      window.removeEventListener('keydown', unlockNotificationAudio);
      window.removeEventListener('touchstart', unlockNotificationAudio);
      window.clearInterval(timer);
    };
  }, [canChat, user?.id, minimized]);

  useEffect(() => {
    if (!minimized) {
      setUnread(0);
      window.setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
  }, [minimized, messages.length]);

  useEffect(() => {
    if (!canChat) return;
    const openChat = (event: Event) => {
      const detail = (event as CustomEvent<{ recipientId?: string }>).detail;
      setRecipientId(detail?.recipientId || '');
      setMinimized(false);
      setUnread(0);
      window.setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 80);
    };
    window.addEventListener('buildtrack-open-chat', openChat);
    return () => window.removeEventListener('buildtrack-open-chat', openChat);
  }, [canChat]);

  if (!canChat) return null;

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message) return;
    setSending(true);
    try {
      const res = await api.post('/chat/messages', {
        message,
        recipient_id: recipientId || null,
      });
      const nextMessages = [...messagesRef.current, res.data];
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
      setDraft('');
    } finally {
      setSending(false);
    }
  };

  const unreadLabel = unread > 9 ? '9+' : String(unread);

  if (minimized) {
    return (
      <div className="fixed bottom-3 right-3 z-40">
        <button
          type="button"
          onClick={() => setMinimized(false)}
          className="relative h-11 w-11 rounded-full flex items-center justify-center shadow-lg border border-white/10"
          style={{ background: '#111827', color: 'white' }}
          aria-label="Open management chat"
          title="Management chat"
        >
          <MessageSquare className="w-5 h-5" style={{ color: '#D99D26' }} />
          {unread > 0 && (
            <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-red-600 text-white text-[10px] font-black flex items-center justify-center">
              {unreadLabel}
            </span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="fixed bottom-3 right-3 z-40" style={{ width: 'min(20rem, calc(100vw - 1rem))' }}>
      <div className="rounded-xl overflow-hidden bg-white border border-gray-200 shadow-xl">
        <button
          type="button"
          onClick={() => setMinimized(true)}
          className="w-full px-3 py-2.5 flex items-center justify-between text-left"
          style={{ background: '#111827', color: 'white' }}
          aria-label="Collapse management chat"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(217,157,38,0.18)' }}>
              <MessageSquare className="w-4 h-4" style={{ color: '#D99D26' }} />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold leading-tight truncate">Management Chat</p>
              <p className="text-xs text-white/50 truncate">{recipientName} - team messages</p>
            </div>
          </div>
          <ChevronDown className="w-4 h-4 flex-shrink-0" />
        </button>

        <div className="p-2.5 border-b border-gray-100">
          <label className="text-xs font-bold text-gray-500 block mb-1">Send to</label>
          <select
            value={recipientId}
            onChange={event => setRecipientId(event.target.value)}
            className="w-full px-2.5 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500"
          >
            <option value="">Everyone</option>
            {users.filter(item => item.id !== user?.id).map(item => (
              <option key={item.id} value={item.id}>
                {item.name} - {roleLabels[item.role] || item.role}{item.is_online ? ' - live' : ''}
              </option>
            ))}
          </select>
          <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
            {users.slice(0, 8).map(item => (
              <span key={item.id} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full bg-gray-100 text-gray-600 whitespace-nowrap">
                <span className={`w-1.5 h-1.5 rounded-full ${item.is_online ? 'bg-green-500' : 'bg-gray-300'}`} />
                {item.name.split(' ')[0]}
              </span>
            ))}
          </div>
        </div>

        <div className="h-56 max-h-[34vh] overflow-y-auto px-2.5 py-2.5 space-y-2" style={{ background: '#F9FAFB' }}>
          {messages.length === 0 ? (
            <div className="h-full flex items-center justify-center text-center text-gray-400">
              <div>
                <MessageSquare className="w-7 h-7 mb-2 mx-auto" />
                <p className="text-sm font-semibold">No messages yet</p>
                <p className="text-xs">Start a team chat or direct message.</p>
              </div>
            </div>
          ) : messages.map(message => {
            const mine = message.sender_id === user?.id;
            const direct = !!message.recipient_id;
            return (
              <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[86%] rounded-2xl px-3 py-2 ${mine ? 'bg-amber-500 text-white' : 'bg-white border border-gray-200 text-gray-900'}`}>
                  <div className="flex items-center gap-1.5 mb-1 min-w-0">
                    {direct ? <User className="w-3 h-3 opacity-70 flex-shrink-0" /> : <Users className="w-3 h-3 opacity-70 flex-shrink-0" />}
                    <span className="text-[11px] font-bold opacity-80 truncate">
                      {mine ? 'You' : message.sender_name}
                      {direct && message.recipient_name ? ` to ${message.recipient_name}` : ''}
                    </span>
                    <span className={`text-[10px] flex-shrink-0 ${mine ? 'text-white/65' : 'text-gray-400'}`}>
                      {formatEasternRelative(message.created_at)}
                    </span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap break-words">{message.message}</p>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        <form onSubmit={sendMessage} className="p-2.5 flex items-end gap-2 border-t border-gray-100 bg-white">
          <textarea
            value={draft}
            onChange={event => setDraft(event.target.value)}
            rows={2}
            maxLength={1000}
            placeholder={recipientId ? `Message ${recipientName}` : 'Message everyone'}
            className="flex-1 resize-none min-h-9 max-h-20 px-2.5 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
          <button
            type="submit"
            disabled={sending || !draft.trim()}
            className="h-9 w-9 rounded-lg flex items-center justify-center text-white disabled:opacity-50 flex-shrink-0"
            style={{ background: '#D99D26' }}
            title="Send message"
            aria-label="Send message"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
