'use strict';

// Normalise an answer for comparison:
// lowercase, strip accents, remove all spaces and punctuation.
// "Century Cycles" -> "centurycycles" ; "century-cycles" -> "centurycycles"
function normalizeAnswer(input) {
  if (input == null) return '';
  return String(input)
    .normalize('NFD')          // split accents from their base letters
    .replace(/\p{M}/gu, '')    // remove the separated accent marks
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ''); // drop everything not a letter/digit
}

// Parse the facilitator's "accepted answers" field (pipe-separated) into a
// list of normalised keys. Blank entries are ignored.
function parseAnswerKeys(raw) {
  if (!raw) return [];
  return String(raw)
    .split('|')
    .map((s) => normalizeAnswer(s))
    .filter((s) => s.length > 0);
}

function checkAnswer(raw, submitted) {
  const keys = parseAnswerKeys(raw);
  if (keys.length === 0) return false; // draft / no key = never correct
  return keys.includes(normalizeAnswer(submitted));
}

// A mission is "live" (visible to teams, counts for scoring) when it has at
// least one accepted answer. Missions without answers are drafts.
function missionIsLive(mission) {
  return parseAnswerKeys(mission && mission.answers).length > 0;
}

module.exports = { normalizeAnswer, parseAnswerKeys, checkAnswer, missionIsLive };
