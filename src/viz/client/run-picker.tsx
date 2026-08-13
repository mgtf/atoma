import {
  Combobox,
  ComboboxButton,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from '@headlessui/react';
import { useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

export interface RunPickerOption {
  id: string;
  title: string;
  meta: string;
  search: string;
  state: 'live' | 'cancelled' | 'error' | 'complete';
}

export interface RunPickerProps {
  options: RunPickerOption[];
  value: string | null;
  placeholder: string;
  emptyLabel: string;
  onChange: (id: string) => void;
}

function RunPicker({ options, value, placeholder, emptyLabel, onChange }: RunPickerProps) {
  const [query, setQuery] = useState('');
  const selected = options.find((option) => option.id === value) ?? null;
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return options;
    return options.filter((option) => option.search.includes(normalized));
  }, [options, query]);

  return (
    <Combobox
      value={selected}
      by="id"
      virtual={{ options: filtered }}
      immediate
      onChange={(option) => {
        if (option) onChange(option.id);
      }}
      onClose={() => setQuery('')}
    >
      <div className="run-picker-control">
        <ComboboxInput
          aria-label={placeholder}
          className="run-picker-input"
          placeholder={placeholder}
          displayValue={(option: RunPickerOption | null) => option?.title ?? ''}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
        />
        <ComboboxButton className="run-picker-button" aria-label={placeholder}>
          <span aria-hidden="true">⌄</span>
        </ComboboxButton>
      </div>
      <ComboboxOptions anchor="bottom start" className="run-picker-options">
        {({ option }) => (
          <ComboboxOption key={option.id} value={option} className="run-picker-option">
            <span className={`run-picker-state ${option.state}`} aria-hidden="true" />
            <span className="run-picker-copy">
              <strong>{option.title}</strong>
              <span>{option.meta}</span>
            </span>
          </ComboboxOption>
        )}
      </ComboboxOptions>
      {filtered.length === 0 ? <span className="sr-only">{emptyLabel}</span> : null}
    </Combobox>
  );
}

export interface RunPickerController {
  update(props: RunPickerProps): void;
  setValue(value: string | null): void;
  destroy(): void;
}

export function mountRunPicker(
  host: HTMLElement,
  initialProps: RunPickerProps
): RunPickerController {
  const root: Root = createRoot(host);
  let props = initialProps;
  const render = () => root.render(<RunPicker {...props} />);
  render();
  return {
    update(nextProps) {
      props = nextProps;
      render();
    },
    setValue(value) {
      props = { ...props, value };
      render();
    },
    destroy() {
      root.unmount();
    },
  };
}
