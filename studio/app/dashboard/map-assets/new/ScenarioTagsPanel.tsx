"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenarioTagsPanel.stylex";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { MAP_ASSET_DESCRIPTOR_TAG_IDS, getMapAssetDescriptorTag } from "@simforge-oss/studio-shared";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import { displayTag } from "@/app/lib/maps/frontend/add-map-utils";
import { motionRecipe } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

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
      <div {...stylex.props(styles.sectionHeader)}>
        <h2 {...stylex.props(styles.sectionTitle)}>Scenario tags</h2>
        <span
          {...stylex.props(styles.tagCount, tags.length > 0 ? styles.tagCountFilled : styles.tagCountEmpty)}
        >
          {tags.length} tags
        </span>
        {autoTagsLoading && (
          <span {...stylex.props(styles.loadingStatus)}>deriving...</span>
        )}
      </div>

      {/* Tag chips */}
      {tags.length > 0 && (
        <div {...stylex.props(styles.tagList)}>
          {tags.map((tagId) => {
            const descriptor = getMapAssetDescriptorTag(tagId);
            const isAuto = autoTagSet.has(tagId);
            return (
              <span
                key={tagId}
                title={descriptor?.shortDefinition}
                {...stylex.props(styles.tagChip, isAuto ? styles.tagChipAuto : styles.tagChipManual)}
              >
                {isAuto && (
                  <span {...stylex.props(styles.autoBadge)}>
                    auto
                  </span>
                )}
                {displayTag(tagId)}
                <button
                  type="button"
                  onClick={() => onRemoveTag(tagId)}
                  {...stylex.props([motionRecipe.colors, styles.tagRemove], isAuto ? styles.tagRemoveAuto : styles.tagRemoveManual)}
                  aria-label={`Remove ${tagId}`}
                >
                  <X {...stylex.props(styles.removeIcon)} />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Add tag button + dropdown */}
      <div {...stylex.props(styles.addTagSection)} ref={tagDropdownRef}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          xstyle={styles.compactOutlineControl}
          onClick={() => { setTagDropdownOpen((o) => !o); setTagSearch(""); }}
        >
          + Add tag
        </Button>
        {tagDropdownOpen && (
          <div {...stylex.props(styles.tagDropdownPanel)}>
            <div {...stylex.props(styles.searchInputWrapper)}>
              <Input
                value={tagSearch}
                onChange={(e) => setTagSearch(e.target.value)}
                placeholder="Search tags..."
                xstyle={styles.compactOutlineControl}
                autoFocus
              />
            </div>
            <ul {...stylex.props(styles.tagOptionsList)}>
              {filteredDropdownTags.length === 0 && (
                <li {...stylex.props(styles.noMatchingTags)}>No matching tags</li>
              )}
              {filteredDropdownTags.map((tagId) => {
                const descriptor = getMapAssetDescriptorTag(tagId);
                return (
                  <li key={tagId}>
                    <button
                      type="button"
                      {...stylex.props(styles.tagOptionButton)}
                      onClick={() => {
                        onAddTag(tagId);
                        setTagDropdownOpen(false);
                        setTagSearch("");
                      }}
                    >
                      <span {...stylex.props(styles.tagOptionLabel)}>{displayTag(tagId)}</span>
                      {descriptor?.shortDefinition && (
                        <span {...stylex.props(styles.tagOptionDescription)}>{descriptor.shortDefinition}</span>
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
          {...stylex.props([motionRecipe.colors, styles.csvToggle])}
        >
          <ChevronDown
            {...stylex.props([motionRecipe.transform, styles.chevron], !csvOpen && styles.rotateMinus90)}
          />
          Bulk-add via CSV paste
        </button>
        {csvOpen && (
          <div {...stylex.props(styles.csvPanel)}>
            <textarea
              value={csvInput}
              onChange={(e) => { setCsvInput(e.target.value); setCsvErrors([]); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); applyCSV(); }
              }}
              placeholder={"SCHOOL_ZONE_BOUNDARY,\nINTERSECTION_SIGNALIZED"}
              spellCheck={false}
              rows={3}
              {...stylex.props(styles.csvTextarea, styles.stackY1_5)}
            />
            {csvErrors.length > 0 && (
              <p {...stylex.props(styles.csvErrorMessage, styles.stackY1_5)}>
                Unrecognised (ignored):{" "}
                <span {...stylex.props(styles.csvErrorList)}>{csvErrors.join(", ")}</span>
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              xstyle={[styles.compactOutlineControl, styles.stackY1_5]}
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
