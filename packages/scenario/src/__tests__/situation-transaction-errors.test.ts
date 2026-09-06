import {expect, it} from 'vitest';
import {TemplateDocument} from '../index.js';
import {SituationTransactionSchema} from '../situation.js';

it('identifies the invalid field inside the selected operation', () => {
  const document = TemplateDocument.create({name:'Diagnostic boundary',anchor:{features:[]}});
  const result = SituationTransactionSchema.safeParse({
    baseRevision:0,baseDigest:'0'.repeat(64),label:'Invalid environment',
    templateOps:[{type:'setEnvironment',environment:{...document.data.environment,timeOfDay:'daylight'}}],
  });
  expect(result.success).toBe(false);
  if (result.success) throw new Error('Invalid environment was accepted');
  expect(result.error.issues.map(issue=>issue.path)).toEqual([
    ['templateOps',0,'environment','timeOfDay'],
  ]);
});
