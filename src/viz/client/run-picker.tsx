import {
  Combobox,
  ComboboxButton,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from '@headlessui/react';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import SearchIcon from '@mui/icons-material/Search';
import { useMemo, useRef, useState } from 'react';
import { matchesSearchQuery } from './search.js';

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

export function RunPicker({ options, value, placeholder, emptyLabel, onChange }: RunPickerProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = options.find((option) => option.id === value) ?? null;
  const filtered = useMemo(() => {
    return options.filter((option) => matchesSearchQuery(option.search, query));
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
      {({ open }) => (
        <>
          <div className="run-picker-control">
            <span className="run-picker-search" aria-hidden="true"><SearchIcon /></span>
            <ComboboxInput
              ref={inputRef}
              aria-label={placeholder}
              className="run-picker-input"
              placeholder={placeholder}
              value={open ? query : selected?.title ?? ''}
              onChange={(event) => setQuery(event.target.value)}
              onFocus={() => {
                if (!open) setQuery('');
              }}
            />
            <ComboboxButton
              className="run-picker-button"
              aria-label={placeholder}
              onClick={() => {
                setQuery('');
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
            >
              <ArrowDropDownIcon aria-hidden="true" />
            </ComboboxButton>
          </div>
          <ComboboxOptions anchor="bottom start" className="run-picker-options">
            {({ option }) => (
              <ComboboxOption key={option.id} value={option} className="run-picker-option">
                <span className={`run-picker-state ${option.state}`} aria-hidden="true" />
                <span className="run-picker-copy">
                  <strong title={option.title}>{option.title}</strong>
                  <span>{option.meta}</span>
                </span>
              </ComboboxOption>
            )}
          </ComboboxOptions>
          {filtered.length === 0 ? <span className="sr-only">{emptyLabel}</span> : null}
        </>
      )}
    </Combobox>
  );
}
