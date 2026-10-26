// Comments written by the app all started "One thing…" — readers spot that.
// Each comment gets a different way in, picked at random, on top of the
// "no pattern" rules in the comment prompts.
const WAYS_IN = [
  'a concrete detail from the post itself',
  'the reader\'s own situation (the person this advice is for)',
  'a short, realistic example',
  'the result someone gets when they do this',
  'a genuine question that leads into the point',
  'the advice itself, in plain words, with no lead-in',
  'the common mistake people make here',
  'a number, a name or a phrase used in the post',
  'what usually happens next, after someone tries this',
];

const SHAPES = [
  'one or two short sentences',
  'three or four sentences',
  'a short example followed by the point',
  'the point first, then one sentence on why it works',
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];

function openingHint() {
  return `\n\nFOR THIS COMMENT ONLY: build the first sentence around ${pick(WAYS_IN)}, if that fits the post naturally (otherwise pick another way in that fits). Shape: ${pick(SHAPES)}.
Never start with "One thing", "One tip", "One item" or any "One …" opener, never announce the point ("Adding to this", "Quick tip"), and don't open by pointing back at the post with "This", "That", "These", "Those" or "Your". The first words must not be ones that could start a comment under any other post.`;
}

// Posts and threads had the same problem: every one opened on the input's
// first line, and every story starred "Rashed". Same idea, per piece.
const HOOKS = [
  'a small scene from daily life abroad',
  'a line someone says (a wife, a boss, a friend, a mother on the phone)',
  'a surprising detail or number from the input',
  'a confession',
  'the result first, then how it happened',
  'a question the reader has asked themselves',
  'the problem itself, with no build-up',
  'a funny everyday observation',
];

function postHint(kind) {
  const what = kind === 'thread' ? 'main post' : 'post';
  const hook = pick(HOOKS);
  const numbers = hook.includes('number') || hook.includes('result') ? '' : ' Don\'t open with the money or the numbers; save them for later.';
  return `\n\nFOR THIS ONE ONLY: the first line of the ${what} MUST be ${hook}.${numbers} Don't reuse the input's first sentence as the opening, and if there is a character, give them a name you haven't used before (not Rashed, Rahim or Karim).`;
}

module.exports = { openingHint, postHint };
