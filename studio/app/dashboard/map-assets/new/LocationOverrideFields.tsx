import * as stylex from "@stylexjs/stylex";
import { styles } from "./LocationOverrideFields.stylex";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import { FieldLabel } from "./FieldLabel";

interface LocationOverrideFieldsProps {
  city: string;
  state: string;
  country: string;
  onCityChange: (v: string) => void;
  onStateChange: (v: string) => void;
  onCountryChange: (v: string) => void;
}

/** City / State / Country 3-column grid for optional location override. */
export function LocationOverrideFields({
  city, state, country,
  onCityChange, onStateChange, onCountryChange,
}: LocationOverrideFieldsProps) {
  return (
    <div>
      <FieldLabel>Location</FieldLabel>
      <p {...stylex.props(styles.locationOverrideHint)}>
        Optional. Auto-filled from map coordinates. Override if the nearest city is incorrect.
      </p>
      <div {...stylex.props(styles.locationFieldsGrid)}>
        <div>
          <label {...stylex.props(styles.locationFieldLabel)}>City</label>
          <Input
            value={city}
            onChange={(e) => onCityChange(e.target.value)}
            placeholder="e.g. San Jose"
            xstyle={styles.locationFieldInput}
          />
        </div>
        <div>
          <label {...stylex.props(styles.locationFieldLabel)}>State / Region</label>
          <Input
            value={state}
            onChange={(e) => onStateChange(e.target.value)}
            placeholder="e.g. California"
            xstyle={styles.locationFieldInput}
          />
        </div>
        <div>
          <label {...stylex.props(styles.locationFieldLabel)}>Country</label>
          <Input
            value={country}
            onChange={(e) => onCountryChange(e.target.value)}
            placeholder="e.g. United States"
            xstyle={styles.locationFieldInput}
          />
        </div>
      </div>
    </div>
  );
}
