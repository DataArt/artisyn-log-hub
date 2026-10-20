'use strict';
const fs = require('fs');
const path = require('path');
const { getWorkDirPath, ensureWorkDir } = require('./git-context');

const RECOMMENDATIONS_FILE = 'hook-recommendations.json';

/**
 * Resolve the path to <gitRoot>/.artisyn/ai_work_dir/hook-recommendations.json.
 * @param {string|null} cwd
 * @returns {string}
 */
function recommendationsPath(cwd) {
  return path.join(getWorkDirPath(cwd), RECOMMENDATIONS_FILE);
}

/**
 * Read the current recommendations set. Never throws — returns an empty
 * set on a missing or corrupt file.
 * @param {string|null} cwd
 * @returns {{ recommendations: Array<{ rule: string, message: string, detectedAt: string }> }}
 */
function readRecommendations(cwd) {
  try {
    const raw = fs.readFileSync(recommendationsPath(cwd), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.recommendations)) {
      return { recommendations: parsed.recommendations };
    }
    return { recommendations: [] };
  } catch {
    return { recommendations: [] };
  }
}

/**
 * Insert or replace (by `rule`) a recommendation entry and persist the file.
 * Extensible: any future rule just calls this with a new `rule` value — no
 * format change needed.
 * @param {string|null} cwd
 * @param {{ rule: string, message: string, detectedAt: string }} entry
 */
function upsertRecommendation(cwd, entry) {
  try {
    const filePath = recommendationsPath(cwd);
    const current = readRecommendations(cwd);
    const idx = current.recommendations.findIndex((r) => r.rule === entry.rule);
    if (idx === -1) {
      current.recommendations.push(entry);
    } else {
      current.recommendations[idx] = entry;
    }
    ensureWorkDir(cwd);
    fs.writeFileSync(filePath, JSON.stringify(current, null, 2), 'utf8');
  } catch {
    // recommendations are best-effort; must never cause hook failures
  }
}

/**
 * Remove a recommendation entry (by `rule`), if present, and persist the file.
 * No-op (never throws) if the file or entry doesn't exist.
 * @param {string|null} cwd
 * @param {string} rule
 */
function removeRecommendation(cwd, rule) {
  try {
    const filePath = recommendationsPath(cwd);
    const current = readRecommendations(cwd);
    const idx = current.recommendations.findIndex((r) => r.rule === rule);
    if (idx === -1) return;
    current.recommendations.splice(idx, 1);
    ensureWorkDir(cwd);
    fs.writeFileSync(filePath, JSON.stringify(current, null, 2), 'utf8');
  } catch {
    // recommendations are best-effort; must never cause hook failures
  }
}

module.exports = { readRecommendations, upsertRecommendation, removeRecommendation };
