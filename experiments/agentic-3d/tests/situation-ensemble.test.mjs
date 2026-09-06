import assert from 'node:assert/strict';
import test from 'node:test';
import { SCENARIO_REVIEW_POLICY as policy, DIVERSITY_REVIEW_POLICY, aggregateReviews, validateEnsembleReview, reviewEnsemble } from '../situation-ensemble.mjs';

// Synthetic member records exercise accounting only; these are not model results.
const evidenceDigest = 'a'.repeat(64);
function member(id, decision = 'accept', capabilities = [], reviewPolicy = policy) {
  const verdict = { decision, explanation: `Synthetic ${decision} fixture.`, findings: decision === 'accept' ? [] : ['Synthetic dissent retained.'],
    capabilityAssessments: capabilities, criteria: reviewPolicy.rubric.map(r => ({ id: r.id, decision, explanation: 'Synthetic rubric fixture.' })) };
  return { id: reviewPolicy.perspectives['abc'.indexOf(id)]?.id ?? id, sessionId: `synthetic-session-${id}`, evidenceDigest, error: null,
    identity: { requestedModel: policy.model, requestedEffort: policy.effort, gatewayUrl: 'http://synthetic.invalid/v1', routingVerified: true, requestEffortVerified: true,
      catalog: { id: policy.model, owned_by: 'openai-codex', api: 'openai-codex-responses' } },
    verdict, response: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(verdict) }] } };
}
const validate = review => validateEnsembleReview(review, { policy, evidenceDigest });
test('two accepting votes retain dissent; a split without quorum is insufficient', () => {
  const review = aggregateReviews(policy, evidenceDigest, [member('a'), member('b'), member('c', 'reject')]);
  assert.equal(review.decision, 'accept');
  assert.equal(review.disagreement.decisions, true);
  assert.deepEqual(review.findings, ['Synthetic dissent retained.']);
  assert.deepEqual(review.members[2].verdict.decision, 'reject');
  assert.equal(validate(review).valid, true);
  assert.equal(aggregateReviews(policy, evidenceDigest, [member('a'), member('b', 'reject'), member('c', 'insufficient')]).decision, 'insufficient');
});
test('missing or invalid members cannot be outvoted and duplicate sessions cannot manufacture independence', () => {
  const invalid = member('c'); invalid.verdict = null; invalid.error = 'Malformed JSON';
  const duplicate = member('c'); duplicate.sessionId = member('a').sessionId;
  const wrongEvidence = member('c'); wrongEvidence.evidenceDigest = 'b'.repeat(64);
  for (const members of [[member('a'), member('b')], [member('a'), member('b'), invalid], [member('a'), member('b'), duplicate], [member('a'), member('b'), wrongEvidence]]) {
    const review = aggregateReviews(policy, evidenceDigest, members);
    assert.equal(review.decision, 'insufficient');
    assert.equal(validate(review).valid, false);
  }
});
test('capability disposition needs exact-finding quorum and retains disagreement', () => {
  const assessment = (finding, disposition) => ({ finding, disposition, explanation: 'Synthetic capability reason.' });
  const review = aggregateReviews(policy, evidenceDigest, [
    member('a', 'accept', [assessment('exact renderer limitation', 'not-required'), assessment('unshared limitation', 'not-required')]),
    member('b', 'accept', [assessment('exact renderer limitation', 'not-required')]),
    member('c', 'reject', [assessment('exact renderer limitation', 'blocks-brief')]),
  ]);
  assert.equal(review.capabilityAssessments.find(a => a.finding === 'exact renderer limitation').disposition, 'not-required');
  assert.equal(review.capabilityAssessments.find(a => a.finding === 'unshared limitation').disposition, 'unresolved');
  assert.deepEqual(review.disagreement.capabilities, ['exact renderer limitation']);
});
test('strict validation rejects aggregate edits and altered member evidence', () => {
  const original = aggregateReviews(policy, evidenceDigest, [member('a'), member('b'), member('c', 'reject')]);
  for (const mutate of [r => { r.decision = 'reject'; }, r => { r.votes.accept = 3; }, r => { r.members[0].evidenceDigest = 'b'.repeat(64); }, r => { r.members[0].verdict.criteria.pop(); }, r => { r.members[0].identity.requestedEffort = 'high'; }, r => { delete r.members[0].response; }, r => { r.members[0].id = 'unregistered-perspective'; }]) {
    const review = structuredClone(original); mutate(review); assert.equal(validate(review).valid, false);
  }
});
test('corpus policy evaluates its own complete rubric rather than scenario rubric', () => {
  const members = ['a', 'b', 'c'].map(id => member(id, 'accept', [], DIVERSITY_REVIEW_POLICY));
  const review = aggregateReviews(DIVERSITY_REVIEW_POLICY, evidenceDigest, members);
  assert.equal(review.scope, 'corpus-diversity');
  assert.equal(validateEnsembleReview(review, { policy: DIVERSITY_REVIEW_POLICY, evidenceDigest }).valid, true);
  assert.equal(validate(review).valid, false);
});
test('one transport failure does not discard other responses or silently re-ask', async () => {
  const calls = [];
  let sequence = 0;
  const review = await reviewEnsemble({ policy, evidenceDigest, content: 'Synthetic transport fixture, not model evidence.',
    makeReviewer: () => {
      const id = String(++sequence); const row = member(id);
      return { id, identity: row.identity, usage: { requests: [] }, agent: { sessionId: row.sessionId, state: { tools: [], messages: [] } } };
    },
    prompt: async reviewer => {
      calls.push(reviewer.id); reviewer.usage.requests.push({ synthetic: true });
      if (reviewer.id === '2') throw new Error('Synthetic transport failure');
      reviewer.agent.state.messages.push({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(member(reviewer.id).verdict) }] });
    },
  });
  assert.deepEqual(calls.sort(), ['1', '2', '3']);
  assert.equal(review.members.length, 3);
  assert.equal(review.members[1].verdict, null);
  assert.match(review.members[1].error, /Synthetic transport failure/);
  assert.equal(review.members[2].verdict.decision, 'accept');
  assert.equal(review.decision, 'insufficient');
});
