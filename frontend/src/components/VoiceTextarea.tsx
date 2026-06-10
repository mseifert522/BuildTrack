import { forwardRef, type CSSProperties, type TextareaHTMLAttributes, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import toast from 'react-hot-toast';

type VoiceTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  wrapperClassName?: string;
  wrapperStyle?: CSSProperties;
  buttonClassName?: string;
  stopSignal?: number | string | boolean;
};

function appendDictationText(base: string, spokenText: string) {
  const cleanSpoken = spokenText.replace(/\s+/g, ' ').trim();
  if (!cleanSpoken) return base;
  if (!base.trim()) return cleanSpoken;
  return `${base}${/\s$/.test(base) ? '' : ' '}${cleanSpoken}`;
}

function setNativeTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) setter.call(textarea, value);
  else textarea.value = value;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

const getSpeechRecognition = () => {
  if (typeof window === 'undefined') return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
};

const defaultButtonClass =
  'absolute right-2 top-2 inline-flex h-9 w-9 items-center justify-center rounded-lg border border-amber-300 bg-amber-50 text-amber-800 shadow-sm transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50';

const listeningButtonClass = 'border-amber-500 bg-amber-500 text-slate-950 hover:bg-amber-400';

const VoiceTextarea = forwardRef<HTMLTextAreaElement, VoiceTextareaProps>(function VoiceTextarea(
  {
    wrapperClassName = '',
    wrapperStyle,
    buttonClassName = '',
    className = '',
    style,
    disabled,
    stopSignal,
    onBlur,
    onFocus,
    ...props
  },
  forwardedRef
) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const recognitionRef = useRef<any>(null);
  const manualStopRef = useRef(false);
  const stopSignalMountedRef = useRef(false);
  const dictationBaseRef = useRef('');
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);

  useImperativeHandle(forwardedRef, () => textareaRef.current as HTMLTextAreaElement);

  const stopListening = useCallback(() => {
    const recognition = recognitionRef.current;
    if (recognition) {
      manualStopRef.current = true;
      try {
        recognition.stop?.();
      } catch {
        // Browser speech recognition can throw if it already stopped.
      }
    }
    recognitionRef.current = null;
    setListening(false);
    setStarting(false);
  }, []);

  useEffect(() => () => {
    stopListening();
  }, [stopListening]);

  useEffect(() => {
    if (disabled) stopListening();
  }, [disabled, stopListening]);

  useEffect(() => {
    if (!stopSignalMountedRef.current) {
      stopSignalMountedRef.current = true;
      return;
    }
    stopListening();
  }, [stopSignal, stopListening]);

  const startListening = () => {
    if (disabled) return;
    if (listening || starting) {
      stopListening();
      return;
    }

    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) {
      textareaRef.current?.focus();
      toast.error('Use the keyboard microphone for dictation on this device');
      return;
    }

    stopListening();
    manualStopRef.current = false;
    dictationBaseRef.current = textareaRef.current?.value || '';
    const recognition = new SpeechRecognition();
    recognition.lang = navigator.language || 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      setStarting(false);
      setListening(true);
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
        setStarting(false);
        setListening(false);
      }
      manualStopRef.current = false;
    };
    recognition.onerror = (event: any) => {
      const wasManualStop = manualStopRef.current || event?.error === 'aborted' || event?.error === 'no-speech';
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      manualStopRef.current = false;
      setStarting(false);
      setListening(false);
      if (!wasManualStop) toast.error('Microphone dictation stopped');
    };
    recognition.onresult = (event: any) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      let finalText = '';
      let interimText = '';
      for (let index = event.resultIndex || 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = String(result?.[0]?.transcript || '').trim();
        if (!transcript) continue;
        if (result.isFinal) finalText = appendDictationText(finalText, transcript);
        else interimText = appendDictationText(interimText, transcript);
      }

      if (finalText) {
        dictationBaseRef.current = appendDictationText(dictationBaseRef.current, finalText);
      }
      const nextValue = interimText
        ? appendDictationText(dictationBaseRef.current, interimText)
        : dictationBaseRef.current;
      setNativeTextareaValue(textarea, nextValue);
      textarea.focus();
    };

    recognitionRef.current = recognition;
    setStarting(true);
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      manualStopRef.current = false;
      setStarting(false);
      toast.error('Microphone dictation could not start');
    }
  };

  return (
    <div className={`relative w-full ${wrapperClassName}`} style={wrapperStyle}>
      <textarea
        {...props}
        ref={textareaRef}
        disabled={disabled}
        onBlur={event => {
          onBlur?.(event);
        }}
        onFocus={event => {
          onFocus?.(event);
        }}
        className={`${className} pr-12`}
        style={{ ...style, paddingRight: style?.paddingRight || 48 }}
      />
      <button
        type="button"
        onClick={startListening}
        disabled={disabled}
        className={`${defaultButtonClass} ${listening || starting ? listeningButtonClass : ''} ${buttonClassName}`}
        aria-label={listening || starting ? 'Stop microphone dictation' : 'Start microphone dictation'}
        title={listening || starting ? 'Stop microphone' : 'Use microphone'}
      >
        {listening || starting ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </button>
    </div>
  );
});

export default VoiceTextarea;
