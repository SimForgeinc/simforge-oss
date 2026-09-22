"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./SearchInputBox.stylex";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import { getMapSearchSuggestions } from "@/app/lib/maps/search/map-search";

interface SearchInputBoxProps {
  draftQuery: string;
  onDraftQueryChange: (value: string) => void;
  onSubmitSearch: (nextQuery?: string) => void;
  autoFocus?: boolean;
}

export function SearchInputBox({
  draftQuery,
  onDraftQueryChange,
  onSubmitSearch,
  autoFocus = false,
}: SearchInputBoxProps) {
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedSuggestionIndex, setHighlightedSuggestionIndex] = useState(-1);
  const suggestions = useMemo(() => getMapSearchSuggestions(draftQuery), [draftQuery]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setHighlightedSuggestionIndex(-1);
  }, [draftQuery, suggestions.length]);

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
    }
  }, [autoFocus]);

  function applySuggestion(applyValue: string) {
    onDraftQueryChange(applyValue);
    onSubmitSearch(applyValue);
    setShowSuggestions(false);
    setHighlightedSuggestionIndex(-1);
  }

  return (
    <div {...stylex.props(styles.searchContainer)}>
      <Search {...stylex.props(styles.searchIcon)} />
      <Input
        ref={inputRef}
        type="text"
        placeholder="Search for scenario locations on this map…"
        value={draftQuery}
        onChange={(event) => {
          onDraftQueryChange(event.target.value);
          setShowSuggestions(true);
        }}
        onFocus={() => setShowSuggestions(true)}
        onBlur={() => {
          window.setTimeout(() => setShowSuggestions(false), 0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            if (suggestions.length === 0) return;
            event.preventDefault();
            setShowSuggestions(true);
            setHighlightedSuggestionIndex((current) => (current + 1) % suggestions.length);
            return;
          }

          if (event.key === "ArrowUp") {
            if (suggestions.length === 0) return;
            event.preventDefault();
            setShowSuggestions(true);
            setHighlightedSuggestionIndex((current) =>
              current <= 0 ? suggestions.length - 1 : current - 1,
            );
            return;
          }

          if (event.key === "Escape") {
            setShowSuggestions(false);
            setHighlightedSuggestionIndex(-1);
            return;
          }

          if (event.key === "Enter") {
            if (showSuggestions && highlightedSuggestionIndex >= 0 && highlightedSuggestionIndex < suggestions.length) {
              event.preventDefault();
              applySuggestion(suggestions[highlightedSuggestionIndex]!.applyValue);
              return;
            }
            setShowSuggestions(false);
            setHighlightedSuggestionIndex(-1);
            onSubmitSearch();
          }
        }}
        xstyle={styles.searchInput}
        aria-label="Search this map"
        aria-autocomplete="list"
        aria-expanded={showSuggestions && suggestions.length > 0}
        aria-controls="map-search-suggestions"
        aria-activedescendant={
          showSuggestions && highlightedSuggestionIndex >= 0
            ? `map-search-suggestion-${highlightedSuggestionIndex}`
            : undefined
        }
      />
      {draftQuery ? (
        <button
          type="button"
          onClick={() => {
            onDraftQueryChange("");
            onSubmitSearch("");
          }}
          {...stylex.props(styles.clearButton)}
          aria-label="Clear search"
        >
          <X {...stylex.props(styles.clearIcon)} />
        </button>
      ) : null}
      {showSuggestions && suggestions.length > 0 ? (
        <div
          id="map-search-suggestions"
          {...stylex.props(styles.suggestionsList)}
          role="listbox"
        >
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.id}
              id={`map-search-suggestion-${index}`}
              type="button"
              role="option"
              aria-selected={index === highlightedSuggestionIndex}
              {...stylex.props(styles.suggestion, index === highlightedSuggestionIndex && styles.suggestionHighlighted)}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onMouseEnter={() => {
                setHighlightedSuggestionIndex(index);
              }}
              onClick={() => {
                applySuggestion(suggestion.applyValue);
              }}
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
