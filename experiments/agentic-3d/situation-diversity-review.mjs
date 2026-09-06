#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {canonicalJson} from '@simforge-oss/engine';
import {assert, hash, saveJson} from './situation-authoring-resources.mjs';
import {createGatewayAgent} from './gateway.mjs';
import {DIVERSITY_REVIEW_POLICY, policyDigest, reviewEnsemble, validateEnsembleReview} from './situation-ensemble.mjs';
import {reportSituationBenchmarkCollection} from './situation-benchmark-collection.mjs';

export async function reviewCorpusDiversity({manifests, out}) {
  assert(Array.isArray(manifests) && manifests.length && typeof out === 'string' && out, 'Manifests and output directory are required');
  const report = reportSituationBenchmarkCollection({manifests});
  const evidenceDigest = hash(canonicalJson(report.evidence));
  assert(evidenceDigest === report.evidenceDigest, 'Collection evidence digest mismatch');
  const directory = path.resolve(out), reviewFile = path.join(directory, 'review.json');
  if (fs.existsSync(directory)) {
    assert(fs.existsSync(reviewFile), 'Existing incomplete review cannot be rerolled; retain it and investigate its recorded failure');
    const review = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
    const evidence = JSON.parse(fs.readFileSync(path.join(directory, 'evidence.json'), 'utf8'));
    assert(hash(canonicalJson(evidence)) === evidenceDigest, 'Existing review covers different collection evidence');
    const validation = validateEnsembleReview(review, {policy:DIVERSITY_REVIEW_POLICY, evidenceDigest});
    // Invalid/error votes are retained too; cache them rather than buying another verdict.
    assert(review.evidenceDigest === evidenceDigest && review.policyDigest === policyDigest(DIVERSITY_REVIEW_POLICY), 'Existing review binding mismatch');
    return {out:directory, reviewFile, evidenceDigest, decision:review.decision, validation, cached:true};
  }
  fs.mkdirSync(directory, {mode:0o700});
  saveJson(path.join(directory, 'evidence.json'), report.evidence);
  saveJson(path.join(directory, 'input.json'), {manifests:manifests.map(p=>path.resolve(p)), evidenceDigest, policyDigest:policyDigest(DIVERSITY_REVIEW_POLICY), scope:'Additional corpus assessment; requests are not part of any initial bounded authoring run. Full frozen textual collection evidence is supplied without truncation. Pixel inspection remains with the per-scenario reviews; corpus reviewers receive their retained evidence records, not image bytes.'});
  const agents = [], started = performance.now();
  const review = await reviewEnsemble({policy:DIVERSITY_REVIEW_POLICY, evidenceDigest,
    content:[{type:'text',text:canonicalJson(report.evidence)}],
    makeReviewer:(id,systemPrompt)=> {
      const reviewer = {id,...createGatewayAgent({systemPrompt,tools:[],sessionDir:path.join(directory,'sessions',id),maxTokens:8000})};
      agents.push(reviewer);
      return reviewer;
    },
    prompt:async(reviewer,content)=> {
      try { await reviewer.agent.prompt({role:'user',content,timestamp:Date.now()}); }
      finally { reviewer.save(); }
    },
  });
  saveJson(reviewFile, review);
  const validation = validateEnsembleReview(review,{policy:DIVERSITY_REVIEW_POLICY,evidenceDigest});
  const metrics = {elapsedMs:performance.now()-started, modelRequests:agents.reduce((n,a)=>n+a.usage.requests.length,0),
    members:agents.map(a=>({id:a.id,identity:a.identity,usage:a.usage})),
    scope:'Corpus-level evaluation overhead, reported separately from bounded authoring; unknown prices are not zero.'};
  saveJson(path.join(directory,'metrics.json'),metrics);
  return {out:directory,reviewFile,evidenceDigest,decision:review.decision,votes:review.votes,validation,cached:false,modelRequests:metrics.modelRequests,elapsedMs:metrics.elapsedMs};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const manifests=[]; let out;
    for(let i=2;i<process.argv.length;i+=2) {
      const name=process.argv[i],value=process.argv[i+1];
      assert(value && !value.startsWith('--'),'Usage: --manifest FILE [--manifest FILE ...] --out NEW_DIRECTORY');
      if(name==='--manifest') manifests.push(value);
      else if(name==='--out' && out===undefined) out=value;
      else throw new Error('Unknown or duplicate option: '+name);
    }
    const result=await reviewCorpusDiversity({manifests,out});
    console.log(JSON.stringify(result));
    if(!result.validation.valid || result.decision!=='accept') process.exitCode=2;
  } catch(error) {console.error(error.stack??error);process.exitCode=1;}
}
