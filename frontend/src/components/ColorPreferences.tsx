import { useRef, useState, type CSSProperties } from 'react';
import { Check, Moon, Sun } from 'lucide-react';
import api from '../lib/api';
import { COLOR_SCHEMES, normalizeColorScheme, type ColorSchemeId } from '../lib/colorSchemes';
import { useAuthStore } from '../store/authStore';

export default function ColorPreferences() {
  const user = useAuthStore(state => state.user);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState(false);
  const pending = useRef(false);
  const selected = normalizeColorScheme(user?.color_scheme);

  async function select(id: ColorSchemeId) {
    if (!user || pending.current || selected === id) return;
    const userId = user.id;
    const previous = selected;
    pending.current = true;
    setSaving(true);
    setError(false);
    setFeedback('Saving your preference…');
    useAuthStore.getState().updateUser({ color_scheme: id });
    try {
      await api.put('/users/me/preferences', { color_scheme: id });
      setFeedback('Saved to your account. Your colors follow you when you sign in.');
    } catch {
      if (useAuthStore.getState().user?.id === userId) {
        useAuthStore.getState().updateUser({ color_scheme: previous });
      }
      setError(true);
      setFeedback('Could not save your preference. Your previous colors were restored. Please try again.');
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <section className="bt-color-settings" aria-labelledby="color-settings-heading">
      <div className="bt-color-heading">
        <span className="bt-color-eyebrow">YOUR WORKSPACE</span>
        <h2 id="color-settings-heading">Preferred color</h2>
        <p>Choose a color scheme that feels right for you. Your screen updates immediately.</p>
      </div>
      <div className="bt-color-options" role="group" aria-label="Preferred color scheme" aria-busy={saving}>
        {COLOR_SCHEMES.map(scheme => {
          const active = selected === scheme.id;
          const ModeIcon = scheme.mode === 'Light' ? Sun : Moon;
          return (
            <button type="button" key={scheme.id} className={'bt-color-option' + (active ? ' is-selected' : '')}
              aria-pressed={active} aria-label={(scheme.id === 'dark-knight' ? '05' : scheme.id) + ' ' + scheme.name} disabled={saving}
              onClick={() => void select(scheme.id)}>
              <div className="bt-color-mini" aria-hidden="true" style={{
                '--sample-page': scheme.colors.page, '--sample-surface': scheme.colors.surface,
                '--sample-nav': scheme.colors.nav, '--sample-border': scheme.colors.border,
                '--sample-accent': scheme.colors.accent, '--sample-text': scheme.colors.text,
                '--sample-muted': scheme.colors.muted, '--sample-selected': scheme.colors.selected,
              } as CSSProperties}>
                <div className="bt-color-mini-nav"><b /><i /><i /><i /></div>
                <div className="bt-color-mini-main"><div className="bt-color-mini-top"><i /><b /></div>
                  <div className="bt-color-mini-cards"><span /><span /><span /></div>
                  <div className="bt-color-mini-table"><i /><i /><i /></div>
                </div>
              </div>
              <div className="bt-color-option-title"><span className="bt-color-number">{scheme.id === 'dark-knight' ? '05' : scheme.id}</span><strong>{scheme.name}</strong>
                <span className="bt-color-check">{active && <Check size={14} />}</span>
              </div>
              <p className="bt-color-description">{scheme.description}</p>
              <div className="bt-color-option-footer"><span><ModeIcon size={13} />{scheme.mode}</span>
                {scheme.id === '07' && <span>Default</span>}
                {active && <span className="bt-color-selected-label">Selected</span>}
              </div>
            </button>
          );
        })}
      </div>
      <p className={'bt-color-feedback' + (error ? ' is-error' : '')} role={error ? 'alert' : 'status'} aria-live="polite">
        {feedback || 'Saved for your login across devices. Midnight Navy (07) is the default.'}
      </p>
    </section>
  );
}
