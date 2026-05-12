import { useState, useEffect } from 'react';

interface CurrencyInputProps {
  value: string | number;
  onChange: (rawValue: string) => void;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
}

function formatCurrency(val: string): string {
  const num = parseFloat(val.replace(/[^0-9.]/g, ''));
  if (isNaN(num)) return '';
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function stripFormatting(val: string): string {
  return val.replace(/[^0-9.]/g, '');
}

export default function CurrencyInput({ value, onChange, placeholder = '0.00', className, style }: CurrencyInputProps) {
  const [display, setDisplay] = useState('');
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) {
      const raw = typeof value === 'number' ? String(value) : String(value || '');
      const stripped = stripFormatting(raw);
      if (stripped && !isNaN(parseFloat(stripped))) {
        setDisplay(formatCurrency(stripped));
      } else {
        setDisplay('');
      }
    }
  }, [value, focused]);

  const handleFocus = () => {
    setFocused(true);
    const raw = stripFormatting(display);
    setDisplay(raw);
  };

  const handleBlur = () => {
    setFocused(false);
    const raw = stripFormatting(display);
    if (raw && !isNaN(parseFloat(raw))) {
      setDisplay(formatCurrency(raw));
      onChange(raw);
    } else {
      setDisplay('');
      onChange('');
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val === '' || /^[0-9]*\.?[0-9]*$/.test(val)) {
      setDisplay(val);
      onChange(val);
    }
  };

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <span style={{
        position: 'absolute',
        left: className ? 14 : 0,
        color: '#6B7280',
        fontWeight: 600,
        fontSize: className ? 14 : 15,
        pointerEvents: 'none',
      }}>$</span>
      <input
        type="text"
        inputMode="decimal"
        value={display}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onChange={handleChange}
        placeholder={placeholder}
        className={className}
        style={{
          paddingLeft: className ? 28 : 16,
          ...(style || {}),
        }}
      />
    </div>
  );
}
