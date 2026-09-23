"""1440x540 composition: untouched 960x540 render plus a 480-pixel log panel."""
import argparse
from collections import deque
import json
from pathlib import Path
import subprocess
from PIL import Image, ImageDraw, ImageFont

BG, CARD = (17, 23, 34), (27, 36, 50)
WHITE, MUTED, GREEN, AMBER, RED = (238, 243, 250), (158, 174, 191), (83, 214, 165), (246, 190, 92), (255, 109, 108)
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

class DecisionPanel:
    def __init__(self, focus=None):
        self.focus = focus
        self.font = ImageFont.truetype(FONT, 14)
        self.small = ImageFont.truetype(FONT, 12)
        self.heading = ImageFont.truetype(BOLD, 19)

    def draw(self, row, history):
        panel = Image.new("RGB", (480, 540), BG)
        draw = ImageDraw.Draw(panel)
        def text(x, y, value, color=WHITE, font=None):
            draw.text((x, y), str(value), font=font or self.font, fill=color)
        def number(value, suffix="", digits=2):
            return "—" if value is None else f"{value:.{digits}f}{suffix}"
        text(18, 12, "JEV  /  LIVE DECISION RECORD", GREEN, self.heading)
        text(18, 39, f"tick {row['tick']}   •   simulation {row['time_s']:.2f} s", MUTED)
        drivers = row["drivers"]
        focused = next((d for d in drivers if d["actor_id"] == self.focus), drivers[0])
        others = [d for d in drivers if d is not focused]
        draw.rounded_rectangle((12, 64, 468, 348), radius=8, fill=CARD)
        text(24, 73, f"{focused['actor_id']}   /   {focused['persona']}", WHITE, self.heading)
        fresh = focused["fresh_decision"]
        age = number(focused["decision_age_s"], " s")
        text(24, 100, "FRESH DECISION" if fresh else f"LATCHED  •  age {age}", GREEN if fresh else AMBER)
        text(24, 124, f"Applied: {focused['latched_maneuver']}")
        text(24, 145, f"Raw Jev choice: {focused['jev_choice'] or '—'}", MUTED)
        y = 168
        for option, probability in focused["probabilities"].items():
            color = GREEN if option == focused["jev_choice"] else MUTED
            text(24, y, option, color, self.small)
            draw.rectangle((140, y + 3, 396, y + 11), fill=BG)
            draw.rectangle((140, y + 3, 140 + round(256 * probability), y + 11), fill=color)
            text(405, y - 1, f"{probability:.2f}", color, self.small)
            y += 15
        if not focused["probabilities"]:
            text(24, y, "No model distribution for this decision", MUTED, self.small)
        text(24, 265, f"Confidence {number(focused['confidence'])}   API {number(focused['api_latency_ms'], ' ms', 1)}")
        text(24, 286, f"Stale {number(focused['staleness_m'], ' m')}   Visible {focused['visible_objects']}   Occluded omitted {focused['omitted_occluded_objects']}", MUTED, self.small)
        reason = focused.get("safety_override") or focused["fallback_reason"]
        text(24, 308, "Safety: " + (reason or "vetted Jev choice"), AMBER if reason else GREEN, self.small)
        y = 357
        for driver in others:
            fresh_tag = "NEW" if driver["fresh_decision"] else number(driver["decision_age_s"], "s", 2)
            text(18, y, f"{driver['actor_id']} / {driver['persona']}   {driver['latched_maneuver']}   {fresh_tag}", MUTED, self.small)
            y += 19
        y += 3
        draw.line((18, y, 462, y), fill=(57, 70, 86))
        text(18, y + 5, "RECENT DECISIONS  (newest first)", GREEN, self.small)
        available = max(1, (514 - (y + 24)) // 16)
        for offset, decision in enumerate(list(history)[-available:][::-1]):
            text(18, y + 24 + 16 * offset,
                 f"{decision['tick']:04d}  {decision['actor_id']}  {decision['jev_choice'] or '—'} → {decision['latched_maneuver']}",
                 AMBER if decision["fallback_reason"] else MUTED, self.small)
        text(18, 522, "Text-only advisory model • deterministic safety owns motion", MUTED, self.small)
        return panel


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True)
    parser.add_argument("--focus")
    args = parser.parse_args()
    run = Path(args.run)
    ticks = [json.loads(line) for line in (run / "ticks.jsonl").open()]
    decisions = [json.loads(line) for line in (run / "decisions.jsonl").open()]
    by_tick = {}
    for decision in decisions:
        by_tick.setdefault(decision["tick"], []).append(decision)
    out = run / "composite"
    out.mkdir(exist_ok=True)
    panel = DecisionPanel(args.focus)
    history = deque(maxlen=30)
    for i, row in enumerate(ticks):
        source = run / "frames" / "chase" / f"{i:08d}.rgb.png"
        image = Image.open(source).convert("RGB")
        if image.size != (960, 540):
            raise ValueError(f"render must remain unscaled 960x540, got {image.size}")
        history.extend(by_tick.get(row["tick"], []))
        canvas = Image.new("RGB", (1440, 540))
        canvas.paste(image, (0, 0))
        canvas.paste(panel.draw(row, history), (960, 0))
        canvas.save(out / f"frame-{i:04d}.png")
    # One rendered image per native tick: 1000/50 = exactly twenty seconds.
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "50", "-i", str(out / "frame-%04d.png"),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "19", str(run / "jev-closed-loop.mp4")], check=True)
    print(f"Composited {len(ticks)} unscaled render frames with a 480px sidebar")

if __name__ == "__main__":
    main()
