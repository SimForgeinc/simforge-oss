"""M5: LLM mechanism labels + blind stage-A judgement for admitted re-cast scenes.

- Labeller: gpt-5.6-sol (medium), names the mechanism from RAW-trace symbolic facts
  (judge_blind.facts_text); label vs rule-mapped category = the coverage claim.
- Blind judge: stage-A conventions verbatim from tools/gates/judge_blind.py
  (gpt-5.6-luna medium, same prompt, same facts builder, blind to authoring).
No vision anywhere, so assert_vision.py is not required for this path.

Usage: label_and_judge.py <promotion-results.json> [--out FILE]
"""
import argparse, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'gates'))
sys.path.insert(0, os.path.join(ROOT, 'research', 'edge-case-corpus', 'tools', 'vista'))
import judge_blind as JB                                                   # noqa: E402
import vlm                                                                 # noqa: E402

LABEL = """You are naming the causal MECHANISM of one autonomous-driving simulation scene,
from symbolic facts computed from its raw trace. Do not guess beyond the facts.

%s

Answer as ONE JSON object:
{"mechanism": "<one sentence: the causal chain that produced the critical approach>",
 "category": "<one of: %s>",
 "confidence": 0.0-1.0}"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('promotion')
    ap.add_argument('--out', default=None)
    args = ap.parse_args()
    promo = json.load(open(args.promotion))
    rows = []
    for att in promo['attemptRecords']:
        if not att.get('admitted') and not att.get('passed'):
            continue
        cell = (att.get('passingCells') or [{}])[0]
        trace = cell.get('trace')
        if not trace or not os.path.exists(trace):
            continue
        text, facts = JB.facts_text(trace)
        # mechanism label: sol, medium
        os.environ['VISTA_MODEL'] = 'gpt-5.6-sol'
        lab, _ = vlm.ask_json(LABEL % (text, ', '.join(JB.CATEGORIES)))
        # blind stage-A judge: luna, medium (judge_blind conventions)
        os.environ['VISTA_MODEL'] = 'gpt-5.6-luna'
        judged, _ = vlm.ask_json(JB.STAGE_A % (text, '\n'.join('  - ' + c
                                                               for c in JB.CATEGORIES)))
        rows.append({
            'attempt': att['attempt'], 'family': att['family'],
            'minedCategory': att['sourceEvent']['category'],
            'trace': trace,
            'label': lab, 'judge': judged,
        })
        print(json.dumps({'attempt': att['attempt'], 'family': att['family'],
                          'mined': att['sourceEvent']['category'],
                          'labelCat': (lab or {}).get('category'),
                          'judgeCritical': (judged or {}).get('isCriticalEdgeCase'),
                          'judgeCat': (judged or {}).get('category')}), flush=True)
    out = args.out or os.path.join(os.path.dirname(args.promotion), 'labels-judge.json')
    json.dump(rows, open(out, 'w'), indent=1)
    print('wrote %s (%d rows)' % (out, len(rows)))


if __name__ == '__main__':
    main()
