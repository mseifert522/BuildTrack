import { useRef, useState } from 'react';
import { MessageSquare, Send } from 'lucide-react';
import Avatar from './Avatar';
import api from '../lib/api';
import { formatEasternDateTime } from '../lib/time';
import { useAuthStore } from '../store/authStore';

export interface NoteReply {
  id: string;
  note_id: string;
  user_id: string;
  user_name: string;
  user_avatar_url?: string | null;
  note: string;
  created_at: string;
}

export default function NoteReplies({ projectId, noteId, replies = [], canReply = true }: {
  projectId: string;
  noteId: string;
  replies?: NoteReply[];
  canReply?: boolean;
}) {
  const { user } = useAuthStore();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState<NoteReply[]>([]);
  const pending = useRef<{ text: string; id: string } | null>(null);
  const inFlight = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const visibleReplies = [...replies, ...confirmed.filter(reply => !replies.some(saved => saved.id === reply.id))]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));

  const send = async () => {
    const text = draft.trim();
    if (!text || inFlight.current) return;
    if (pending.current?.text !== text) pending.current = { text, id: crypto.randomUUID() };
    inFlight.current = true;
    setSending(true);
    setError('');
    try {
      const response = await api.post(`/projects/${projectId}/notes/${noteId}/replies`, { note: text, client_id: pending.current.id });
      setConfirmed(current => current.some(reply => reply.id === response.data.id) ? current : [...current, response.data]);
      setDraft('');
      pending.current = null;
      // Keep focus in the composer so a live refresh does not interrupt typing.
      textarea.current?.focus();
    } catch (err: unknown) {
      const failure = err as { response?: { data?: { error?: string } } };
      setError(failure.response?.data?.error || 'Your reply could not be saved. Your text is here — please try again.');
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  return (
    <section className="bt-note-replies" aria-label="Note conversation" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      {visibleReplies.length > 0 && <div className="bt-note-reply-list">
        {visibleReplies.map(reply => <article className="bt-note-reply" key={reply.id}>
          <Avatar src={reply.user_avatar_url} name={reply.user_name} size={30} />
          <div className="bt-note-reply-content">
            <div className="bt-note-reply-meta"><strong>{reply.user_name}</strong><time dateTime={reply.created_at}>{formatEasternDateTime(reply.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></div>
            <p>{reply.note}</p>
          </div>
        </article>)}
      </div>}
      {canReply && user && !noteId.startsWith('temp-') && (open ? (
        <form className="bt-note-reply-form" onSubmit={event => { event.preventDefault(); void send(); }}>
          <Avatar src={user.avatar_url} name={user.name} size={30} />
          <div className="bt-note-reply-content">
            <label htmlFor={`reply-${noteId}`}>Reply as {user.name}</label>
            <textarea ref={textarea} id={`reply-${noteId}`} autoFocus rows={3} maxLength={10000} placeholder="Write a reply…" value={draft} disabled={sending}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); } }} />
            {error && <p className="bt-note-reply-error" role="alert">{error}</p>}
            <div className="bt-note-reply-controls">
              <span>Shared with this project’s conversation</span>
              <button type="button" disabled={sending} onClick={() => setOpen(false)}>Cancel</button>
              <button type="submit" disabled={sending || !draft.trim()}><Send size={14} />{sending ? 'Sending…' : 'Send reply'}</button>
            </div>
          </div>
        </form>
      ) : <button type="button" className="bt-note-reply-trigger" onClick={() => setOpen(true)} aria-label={`Reply to note (${visibleReplies.length} replies)`}><MessageSquare size={14} />Reply{visibleReplies.length ? ` · ${visibleReplies.length}` : ''}</button>)}
    </section>
  );
}
