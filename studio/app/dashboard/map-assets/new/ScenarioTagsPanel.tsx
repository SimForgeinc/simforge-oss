"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { MAP_ASSET_DESCRIPTOR_TAG_IDS, getMapAssetDescriptorTag } from "@simforge-oss/studio-shared";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import { cn } from "@simforge-oss/studio-ui/lib/utils";
import { displayTag } from "@/app/lib/maps/frontend/add-map-utils";

interface ScenarioTagsPanelProps {
  tags: string[];
  autoTagSet: Set<string>;
  autoTagsLoading: boolean;
  onAddTag: (tagId: string) => void;
  onRemoveTag: (tagId: string) => void;
  onBulkAddCsv: (tagIds: string[]) => void;
}

/** Scenario tags section: tag chips, tag dropdown with search, CSV bulk-add.
 *  Overture-derived enrichment tags are merged in asynchronously after submit
 *  — this panel no longer shows an in-form enrichment preview. */
export function ScenarioTagsPanel({
  tags,
  autoTagSet,
  autoTagsLoading,
  onAddTag,
  onRemoveTag,
  onBulkAddCsv,
}: ScenarioTagsPanelProps) {
  const [tagDropdownOpen, setTagDropdownOpen] = useState(false);
  const [tagSearch, setTagSearch] = useState("");
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvInput, setCsvInput] = useState("");
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const tagDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    if (!tagDropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (tagDropdownRef.current && !tagDropdownRef.current.contains(e.target as Node)) {
        setTagDropdownOpen(false);
        setTagSearch("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [tagDropdownOpen]);

  function applyCSV() {
    const ids = csvInput
      .split(/[\n,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const valid = ids.filter((id) => MAP_ASSET_DESCRIPTOR_TAG_IDS.includes(id));
    const invalid = ids.filter((id) => !MAP_ASSET_DESCRIPTOR_TAG_IDS.includes(id));
    if (valid.length > 0) onBulkAddCsv(valid);
    setCsvErrors(invalid);
    if (invalid.length === 0) setCsvInput("");
  }

  const filteredDropdownTags = MAP_ASSET_DESCRIPTOR_TAG_IDS.filter((id) => {
    if (tags.includes(id)) return false;
    const q = tagSearch.toLowerCase();
    return id.toLowerCase().includes(q) || displayTag(id).toLowerCase().includes(q);
  });

  return (
    <div>
      <div className={stylex.props(styles.s_267).className}>
        <h2 className={stylex.props(styles.s_880).className}>Scenario tags</h2>
        <span
          className={stylex.props(styles.u_952, styles.u_937, styles.u_941, styles.u_961).className}
        >
          {tags.length} tags
        </span>
        {autoTagsLoading && (
          <span className={stylex.props(styles.s_973).className}>deriving...</span>
        )}
      </div>

      {/* Tag chips */}
      {tags.length > 0 && (
        <div className={stylex.props(styles.s_270).className}>
          {tags.map((tagId) => {
            const descriptor = getMapAssetDescriptorTag(tagId);
            const isAuto = autoTagSet.has(tagId);
            return (
              <span
                key={tagId}
                title={descriptor?.shortDefinition}
                className={stylex.props(styles.u_927, styles.u_928, styles.u_916, styles.u_951, styles.u_903, styles.u_935, styles.u_941).className}
              >
                {isAuto && (
                  <span className={stylex.props(styles.s_271).className}>
                    auto
                  </span>
                )}
                {displayTag(tagId)}
                <button
                  type="button"
                  onClick={() => onRemoveTag(tagId)}
                  className={stylex.props(styles.u_931, styles.u_970).className}
                  aria-label={`Remove ${tagId}`}
                >
                  <X className={stylex.props(styles.s_967).className} />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Add tag button + dropdown */}
      <div className={stylex.props(styles.s_273).className} ref={tagDropdownRef}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={stylex.props(styles.s_288).className}
          onClick={() => { setTagDropdownOpen((o) => !o); setTagSearch(""); }}
        >
          + Add tag
        </Button>
        {tagDropdownOpen && (
          <div className={stylex.props(styles.s_275).className}>
            <div className={stylex.props(styles.s_276).className}>
              <Input
                value={tagSearch}
                onChange={(e) => setTagSearch(e.target.value)}
                placeholder="Search tags..."
                className={stylex.props(styles.s_288).className}
                autoFocus
              />
            </div>
            <ul className={stylex.props(styles.s_278).className}>
              {filteredDropdownTags.length === 0 && (
                <li className={stylex.props(styles.s_279).className}>No matching tags</li>
              )}
              {filteredDropdownTags.map((tagId) => {
                const descriptor = getMapAssetDescriptorTag(tagId);
                return (
                  <li key={tagId}>
                    <button
                      type="button"
                      className={stylex.props(styles.s_280).className}
                      onClick={() => {
                        onAddTag(tagId);
                        setTagDropdownOpen(false);
                        setTagSearch("");
                      }}
                    >
                      <span className={stylex.props(styles.s_281).className}>{displayTag(tagId)}</span>
                      {descriptor?.shortDefinition && (
                        <span className={stylex.props(styles.s_1005).className}>{descriptor.shortDefinition}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {/* CSV paste — secondary escape hatch */}
      <div>
        <button
          type="button"
          onClick={() => setCsvOpen((o) => !o)}
          className={stylex.props(styles.s_351).className}
        >
          <ChevronDown
            className={cn("size-3 shrink-0 transition-transform", !csvOpen && "-rotate-90")}
          />
          Bulk-add via CSV paste
        </button>
        {csvOpen && (
          <div className={stylex.props(styles.s_284).className}>
            <textarea
              value={csvInput}
              onChange={(e) => { setCsvInput(e.target.value); setCsvErrors([]); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); applyCSV(); }
              }}
              placeholder={"SCHOOL_ZONE_BOUNDARY,\nINTERSECTION_SIGNALIZED"}
              spellCheck={false}
              rows={3}
              className={stylex.props(styles.s_285).className}
            />
            {csvErrors.length > 0 && (
              <p className={stylex.props(styles.s_451).className}>
                Unrecognised (ignored):{" "}
                <span className={stylex.props(styles.s_940).className}>{csvErrors.join(", ")}</span>
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={stylex.props(styles.s_288).className}
              disabled={!csvInput.trim()}
              onClick={applyCSV}
            >
              Apply CSV
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
