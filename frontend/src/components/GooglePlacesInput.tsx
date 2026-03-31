import React, { useEffect, useRef, useCallback } from 'react';

const GOOGLE_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

// Singleton loader — only inject the script once
let scriptLoaded = false;
let scriptLoading = false;
const callbacks: (() => void)[] = [];

function loadGoogleMapsScript(cb: () => void) {
  if (scriptLoaded) { cb(); return; }
  callbacks.push(cb);
  if (scriptLoading) return;
  scriptLoading = true;

  (window as any).__googleMapsInit = () => {
    scriptLoaded = true;
    callbacks.forEach(fn => fn());
    callbacks.length = 0;
  };

  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_API_KEY}&libraries=places&callback=__googleMapsInit`;
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

interface GooglePlacesInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
  id?: string;
  required?: boolean;
  disabled?: boolean;
}

const GooglePlacesInput: React.FC<GooglePlacesInputProps> = ({
  value,
  onChange,
  placeholder = '123 Main St, City, State',
  className,
  style,
  id,
  required,
  disabled,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<any>(null);

  const initAutocomplete = useCallback(() => {
    if (!inputRef.current || autocompleteRef.current) return;
    const google = (window as any).google;
    if (!google?.maps?.places) return;

    const ac = new google.maps.places.Autocomplete(inputRef.current, {
      types: ['address'],
      componentRestrictions: { country: 'us' },
      fields: ['formatted_address'],
    });

    ac.addListener('place_changed', () => {
      const place = ac.getPlace();
      if (place?.formatted_address) {
        onChange(place.formatted_address);
      }
    });

    autocompleteRef.current = ac;
  }, [onChange]);

  useEffect(() => {
    loadGoogleMapsScript(initAutocomplete);
  }, [initAutocomplete]);

  // Keep the input value in sync when parent changes it
  useEffect(() => {
    if (inputRef.current && document.activeElement !== inputRef.current) {
      inputRef.current.value = value;
    }
  }, [value]);

  return (
    <input
      ref={inputRef}
      id={id}
      type="text"
      defaultValue={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className={className}
      style={style}
      required={required}
      disabled={disabled}
      autoComplete="off"
    />
  );
};

export default GooglePlacesInput;
