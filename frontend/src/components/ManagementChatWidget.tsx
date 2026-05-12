import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { ChevronDown, MessageSquare, Send, User, Users } from 'lucide-react';
import api from '../lib/api';
import { useAuthStore, isAdminRole, roleLabels } from '../store/authStore';

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

const parseDate = (value: string) => new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);

function playChime() {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(1320, context.currentTime + 0.12);
    gain.gain.setValueAtTime(0.001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.22);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.24);
    setTimeout(() => context.close?.(), 500);
  } catch {
    // Browser audio can be blocked until the user interacts with the page.
  }
}

interface ManagementChatWidgetProps {
  sidebarWidth?: number;
}

export default function ManagementChatWidget({ sidebarWidth = 0 }: ManagementChatWidgetProps) {
  const { user } = useAuthStore();
  const [minimized, setMinimized] = useState(false);
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches
  );
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
      playChime();
    }
    initializedRef.current = true;
  };

  useEffect(() => {
    if (!canChat) return;
    const media = window.matchMedia('(min-width: 1024px)');
    const onMediaChange = () => setIsDesktop(media.matches);
    onMediaChange();
    media.addEventListener?.('change', onMediaChange);
    loadUsers().catch(() => {});
    loadMessages().catch(() => {});
    const timer = window.setInterval(() => {
      loadUsers().catch(() => {});
      loadMessages().catch(() => {});
    }, 5000);
    return () => {
      window.clearInterval(timer);
      media.removeEventListener?.('change', onMediaChange);
    };
  }, [canChat, user?.id, minimized]);

  useEffect(() => {
    if (!minimized) {
      setUnread(0);
      window.setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
  }, [minimized, messages.length]);

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

  return (
    <div
      className="fixed z-40"
      style={{
        left: isDesktop ? sidebarWidth + 16 : 12,
        right: 16,
        bottom: 12,
      }}
    >
      <div className="rounded-2xl overflow-hidden bg-white border border-gray-200 shadow-2xl">
        <button
          type="button"
          onClick={() => setMinimized(value => !value)}
          className="w-full px-4 py-3 flex items-center justify-between text-left"
          style={{ background: '#111827', color: 'white' }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(217,157,38,0.18)' }}>
              <MessageSquare className="w-4 h-4" style={{ color: '#D99D26' }} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold leading-tight">Management Chat</p>
              <p className="text-xs text-white/50 truncate">{recipientName} - real-time team messages</p>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            {unread > 0 && (
              <span className="min-w-6 h-6 px-2 rounded-full bg-red-600 text-white text-xs flex items-center justify-center">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
            <ChevronDown className={`w-4 h-4 transition-transform ${minimized ? 'rotate-180' : ''}`} />
          </div>
        </button>

        {!minimized && (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] border-b border-gray-100">
              <div className="p-3 border-b lg:border-b-0 lg:border-r border-gray-100">
                <label className="text-xs font-bold text-gray-500 block mb-1">Send to</label>
                <select
                  value={recipientId}
                  onChange={event => setRecipientId(event.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                >
                  <option value="">Everyone</option>
                  {users.filter(item => item.id !== user?.id).map(item => (
                    <option key={item.id} value={item.id}>
                      {item.name} - {roleLabels[item.role] || item.role}{item.is_online ? ' - live' : ''}
                    </option>
                  ))}
                </select>
                <div className="hidden lg:flex flex-wrap gap-1.5 mt-3">
                  {users.slice(0, 8).map(item => (
                    <span key={item.id} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full bg-gray-100 text-gray-600">
                      <span className={`w-1.5 h-1.5 rounded-full ${item.is_online ? 'bg-green-500' : 'bg-gray-300'}`} />
                      {item.name.split(' ')[0]}
                    </span>
                  ))}
                </div>
              </div>

              <div className="min-w-0">
                <div className="h-44 overflow-y-auto px-4 py-3 space-y-2" style={{ background: '#F9FAFB' }}>
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
                        <div className={`max-w-[78%] rounded-2xl px-3 py-2 ${mine ? 'bg-amber-500 text-white' : 'bg-white border border-gray-200 text-gray-900'}`}>
                          <div className="flex items-center gap-1.5 mb-1">
                            {direct ? <User className="w-3 h-3 opacity-70" /> : <Users className="w-3 h-3 opacity-70" />}
                            <span className="text-[11px] font-bold opacity-80">
                              {mine ? 'You' : message.sender_name}
                              {direct && message.recipient_name ? ` to ${message.recipient_name}` : ''}
                            </span>
                            <span className={`text-[10px] ${mine ? 'text-white/65' : 'text-gray-400'}`}>
                              {formatDistanceToNow(parseDate(message.created_at), { addSuffix: true })}
                            </span>
                          </div>
                          <p className="text-sm whitespace-pre-wrap break-words">{message.message}</p>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={bottomRef} />
                </div>

                <form onSubmit={sendMessage} className="p-3 flex items-end gap-2 border-t border-gray-100 bg-white">
                  <textarea
                    value={draft}
                    onChange={event => setDraft(event.target.value)}
                    rows={1}
                    maxLength={1000}
                    placeholder={recipientId ? `Message ${recipientName}` : 'Message everyone'}
                    className="flex-1 resize-none px-3 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                  <button
                    type="submit"
                    disabled={sending || !draft.trim()}
                    className="h-10 px-4 rounded-xl flex items-center gap-2 justify-center text-white font-bold text-sm disabled:opacity-50"
                    style={{ background: '#D99D26' }}
                    title="Send message"
                  >
                    <Send className="w-4 h-4" />
                    Send
                  </button>
                </form>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
