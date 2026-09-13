import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";
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
      <p className={stylex.props(styles.s_327).className}>
        Optional. Auto-filled from map coordinates. Override if the nearest city is incorrect.
      </p>
      <div className={stylex.props(styles.s_291).className}>
        <div>
          <label className={stylex.props(styles.s_296).className}>City</label>
          <Input
            value={city}
            onChange={(e) => onCityChange(e.target.value)}
            placeholder="e.g. San Jose"
            xstyle={styles.s_297}
          />
        </div>
        <div>
          <label className={stylex.props(styles.s_296).className}>State / Region</label>
          <Input
            value={state}
            onChange={(e) => onStateChange(e.target.value)}
            placeholder="e.g. California"
            xstyle={styles.s_297}
          />
        </div>
        <div>
          <label className={stylex.props(styles.s_296).className}>Country</label>
          <Input
            value={country}
            onChange={(e) => onCountryChange(e.target.value)}
            placeholder="e.g. United States"
            xstyle={styles.s_297}
          />
        </div>
      </div>
    </div>
  );
}
