import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { FastForward, Loader2, Maximize, Minimize, Pause, Play, Rewind, RotateCcw, RotateCw, Square, Volume2, VolumeX } from 'lucide-react';

// The ONE video player for viewing project media (per Mike 2026-10-26: play, pause,
// stop, forward, reverse and volume must always be usable). The control bar sits
// BELOW the picture, never over it - the lightbox's picture-description overlay used
// to cover the browser's native controls, which is why videos "could not be
// controlled". Fullscreen takes the whole player so these controls stay visible.
//
// Keyboard (when the player has focus): Space/K play-pause, J/L or arrows back/forward,
// Up/Down volume, M mute, F fullscreen. Keys are stopped here so a surrounding
// lightbox doesn't also switch pictures.

const SKIP_SECONDS = 10;
const ARROW_SECONDS = 5;

function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const total = Math.floor(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

type VideoPlayerProps = {
  src: string;
  autoPlay?: boolean;
  className?: string;
  // Server is still straightening/re-encoding this clip (photos.video_status).
  processing?: boolean;
  // Manual fallback when the automatic orientation is wrong; omit to hide the buttons.
  onRotate?: (degrees: 90 | 270) => void;
  rotating?: boolean;
};

const controlButton = 'bt-video-control inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-white transition hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-40';

export default function VideoPlayer({ src, autoPlay = false, className = '', processing = false, onRotate, rotating = false }: VideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setPlaying(false);
    setCurrent(0);
    setDuration(0);
    setFailed(false);
  }, [src]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const video = () => videoRef.current;

  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused || el.ended) el.play().catch(() => setPlaying(false));
    else el.pause();
  }, []);

  const stop = () => {
    const el = video();
    if (!el) return;
    el.pause();
    el.currentTime = 0;
    setCurrent(0);
  };

  const seekBy = useCallback((seconds: number) => {
    const el = videoRef.current;
    if (!el) return;
    const end = Number.isFinite(el.duration) ? el.duration : el.currentTime + seconds;
    el.currentTime = Math.min(Math.max(0, el.currentTime + seconds), end);
    setCurrent(el.currentTime);
  }, []);

  const seekTo = (seconds: number) => {
    const el = video();
    if (!el) return;
    el.currentTime = seconds;
    setCurrent(seconds);
  };

  const changeVolume = useCallback((next: number) => {
    const el = videoRef.current;
    if (!el) return;
    const clamped = Math.min(1, Math.max(0, next));
    el.volume = clamped;
    el.muted = clamped === 0;
  }, []);

  const toggleMute = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.muted && el.volume === 0) el.volume = 0.5;
    el.muted = !el.muted;
  }, []);

  const toggleFullscreen = useCallback(() => {
    const box = containerRef.current;
    if (!box) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else box.requestFullscreen?.().catch(() => {});
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    // Sliders handle their own arrow keys.
    if (target.tagName === 'INPUT' && event.key.startsWith('Arrow')) {
      event.stopPropagation();
      return;
    }
    const key = event.key.toLowerCase();
    const actions: Record<string, () => void> = {
      ' ': togglePlay,
      k: togglePlay,
      j: () => seekBy(-SKIP_SECONDS),
      l: () => seekBy(SKIP_SECONDS),
      arrowleft: () => seekBy(-ARROW_SECONDS),
      arrowright: () => seekBy(ARROW_SECONDS),
      arrowup: () => changeVolume((videoRef.current?.volume || 0) + 0.1),
      arrowdown: () => changeVolume((videoRef.current?.volume || 0) - 0.1),
      m: toggleMute,
      f: toggleFullscreen,
    };
    const action = actions[key];
    if (!action) return;
    // Space on a focused button already clicks it.
    if (key === ' ' && target.tagName === 'BUTTON') return;
    event.preventDefault();
    event.stopPropagation();
    action();
  };


  const volumeShown = muted ? 0 : volume;

  return (
    <div
      ref={containerRef}
      data-video-player="true"
      data-no-image-lightbox="true"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onClick={event => event.stopPropagation()}
      className={`bt-video-player flex min-h-0 flex-col overflow-hidden bg-black text-white focus:outline-none ${fullscreen ? 'h-screen w-screen' : ''} ${className}`}
    >
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        <video
          ref={videoRef}
          key={src}
          src={src}
          autoPlay={autoPlay}
          playsInline
          preload="metadata"
          className="block max-h-full max-w-full object-contain"
          onClick={togglePlay}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={event => setCurrent(event.currentTarget.currentTime)}
          onLoadedMetadata={event => {
            setDuration(event.currentTarget.duration);
            setVolume(event.currentTarget.volume);
            setMuted(event.currentTarget.muted);
          }}
          onDurationChange={event => setDuration(event.currentTarget.duration)}
          onVolumeChange={event => {
            setVolume(event.currentTarget.volume);
            setMuted(event.currentTarget.muted);
          }}
          onWaiting={() => setBuffering(true)}
          onPlaying={() => setBuffering(false)}
          onCanPlay={() => setBuffering(false)}
          onError={() => setFailed(true)}
        />
        {!playing && !failed && (
          <button
            type="button"
            onClick={togglePlay}
            className="absolute inset-0 m-auto inline-flex h-16 w-16 items-center justify-center rounded-full border border-white/30 bg-black/60 text-white shadow-xl transition hover:bg-black/80"
            aria-label="Play video"
          >
            <Play className="ml-1 h-8 w-8" />
          </button>
        )}
        {buffering && playing && (
          <Loader2 className="pointer-events-none absolute inset-0 m-auto h-10 w-10 animate-spin text-white/80" />
        )}
        {failed && (
          <p className="absolute inset-x-4 top-1/2 -translate-y-1/2 text-center text-sm font-semibold text-white/80">
            This video can&apos;t be played in this browser yet.{processing ? ' It is being converted - check back in a few minutes.' : ''}
          </p>
        )}
        {processing && !failed && (
          <div className="pointer-events-none absolute left-3 top-3 inline-flex items-center gap-2 rounded-full bg-black/70 px-3 py-1 text-xs font-semibold text-white/90">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Straightening this video - it updates in a few minutes
          </div>
        )}
      </div>

      <div className="bt-video-controls flex-shrink-0 border-t border-white/10 bg-slate-950 px-2 pb-2 pt-1.5 sm:px-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold tabular-nums text-white/75">
          <span className="w-12 text-right">{formatTime(current)}</span>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(current, duration || 0)}
            onChange={event => seekTo(Number(event.target.value))}
            disabled={!duration}
            className="bt-video-seek h-1.5 min-w-0 flex-1 cursor-pointer accent-cyan-400"
            aria-label="Seek"
          />
          <span className="w-12">{formatTime(duration)}</span>
        </div>
        <div className="mt-1 flex items-center gap-0.5 sm:gap-1">
          <button type="button" className={controlButton} onClick={() => seekBy(-SKIP_SECONDS)} aria-label={`Back ${SKIP_SECONDS} seconds`} title={`Back ${SKIP_SECONDS} seconds (J)`}>
            <Rewind className="h-5 w-5" />
          </button>
          <button type="button" className={`${controlButton} h-10 w-10 bg-white/10`} onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
            {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
          </button>
          <button type="button" className={controlButton} onClick={stop} aria-label="Stop" title="Stop">
            <Square className="h-4 w-4" />
          </button>
          <button type="button" className={controlButton} onClick={() => seekBy(SKIP_SECONDS)} aria-label={`Forward ${SKIP_SECONDS} seconds`} title={`Forward ${SKIP_SECONDS} seconds (L)`}>
            <FastForward className="h-5 w-5" />
          </button>

          <div className="ml-1 flex items-center gap-1 sm:ml-3">
            <button type="button" className={controlButton} onClick={toggleMute} aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'} title="Mute (M)">
              {muted || volume === 0 ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volumeShown}
              onChange={event => changeVolume(Number(event.target.value))}
              className="bt-video-volume h-1.5 w-16 cursor-pointer accent-cyan-400 sm:w-24"
              aria-label="Volume"
            />
          </div>

          <div className="ml-auto flex items-center gap-0.5">
            {onRotate && (
              <>
                <button type="button" className={controlButton} onClick={() => onRotate(270)} disabled={rotating} aria-label="Turn video left" title="Turn video left">
                  <RotateCcw className="h-4 w-4" />
                </button>
                <button type="button" className={controlButton} onClick={() => onRotate(90)} disabled={rotating} aria-label="Turn video right" title="Turn video right">
                  <RotateCw className="h-4 w-4" />
                </button>
              </>
            )}
            <button type="button" className={controlButton} onClick={toggleFullscreen} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} title="Full screen (F)">
              {fullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
