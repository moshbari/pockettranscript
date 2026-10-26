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

module.exports = { openingHint };
