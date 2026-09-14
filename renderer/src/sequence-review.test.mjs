import test from 'node:test'; import assert from 'node:assert/strict'; import {reviewSequence} from './sequence-review.mjs';
test('fails weak final sequence',()=>assert.equal(reviewSequence({visuals:Array(7),scores:{relevance:5,coverage:5,variety:5,readability:5,pacing:5}}).passed,false));
