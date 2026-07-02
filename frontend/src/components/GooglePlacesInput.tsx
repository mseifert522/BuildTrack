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
  script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_API_KEY}&libraries=places&loading=async&callback=__googleMapsInit`;
  script.async = true;
  script.defer = true;
  script.onerror = () => {
    // Reset loader state so a later mount can retry; the plain <input> still
    // accepts manual typing when autocomplete is unavailable.
    scriptLoading = false;
    callbacks.length = 0;
    console.error('Google Maps failed to load');
  };
  document.head.appendChild(script);
}

interface GooglePlacesInputProps {
  value: string;
  onChange: (value: string) => void;
  onPlaceSelect?: (place: {
    formattedAddress: string;
    streetAddress: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  }) => void;
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
  onPlaceSelect,
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
      fields: ['formatted_address', 'address_components'],
    });

    ac.addListener('place_changed', () => {
      const place = ac.getPlace();
      if (place?.formatted_address) {
        onChange(place.formatted_address);
        const components = place.address_components || [];
        const getComponent = (type: string, useShortName = false) => {
          const component = components.find((item: any) => item.types?.includes(type));
          return component ? (useShortName ? component.short_name : component.long_name) : '';
        };
        const streetNumber = getComponent('street_number');
        const route = getComponent('route');
        onPlaceSelect?.({
          formattedAddress: place.formatted_address,
          streetAddress: [streetNumber, route].filter(Boolean).join(' ') || place.formatted_address,
          city: getComponent('locality') || getComponent('postal_town') || getComponent('sublocality_level_1'),
          state: getComponent('administrative_area_level_1', true),
          postalCode: getComponent('postal_code'),
          country: getComponent('country', true),
        });
      }
    });

    autocompleteRef.current = ac;
  }, [onChange, onPlaceSelect]);

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
