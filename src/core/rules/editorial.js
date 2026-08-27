import { createEditorialRuleRegistry } from './registry.js';
import { cloneJsonSafe } from './safe-data.js';

const RULE_ID = 'editorial.placeholder-text';
const VERSION = '1.0.0';
const MAX_SCANNED_NODES = 5_000;
const MAX_RESULTS = 64;
const MAX_TEXT = 4_096;
const EXECUTABLE_TAGS = new Set(['script', 'style', 'template']);
const EDITABLE_TAGS = new Set(['input', 'select', 'textarea']);
const CONTEXT_EDITABLE = new Set(['', 'true', 'plaintext-only']);

function text(value) {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT).replace(/\s+/gu, ' ').trim() : '';
}

function normalized(value) {
  return text(value).normalize('NFKC').toLocaleLowerCase('pt-BR');
}

function attributes(node) {
  return node?.attributes && typeof node.attributes === 'object' && !Array.isArray(node.attributes)
    ? node.attributes
    : {};
}

function tag(node) {
  return normalized(node?.tagName);
}

function editable(node) {
  if (EDITABLE_TAGS.has(tag(node))) return true;
  const values = attributes(node);
  if (!Object.hasOwn(values, 'contenteditable')) return false;
  return CONTEXT_EDITABLE.has(normalized(values.contenteditable));
}

function hidden(node) {
  const values = attributes(node);
  return node?.hidden === true || Object.hasOwn(values, 'hidden') || normalized(values['aria-hidden']) === 'true';
}

function placeholder(node) {
  if (node?.placeholderTextCandidate === true) return true;
  const value = normalized(node?.visibleText || node?.text);
  return /(?:^|[^\p{L}])lorem\s+ipsum(?:[^\p{L}]|$)/u.test(value);
}

function safeNodes(snapshot) {
  const safe = cloneJsonSafe(snapshot);
  if (!safe || typeof safe !== 'object' || !Array.isArray(safe.nodes)) return [];
  return safe.nodes.slice(0, MAX_SCANNED_NODES).filter(node => node && typeof node === 'object' && !Array.isArray(node));
}

function evaluatePlaceholder(snapshot) {
  const nodes = safeNodes(snapshot);
  const byId = new Map(nodes.map(node => [typeof node.nodeId === 'string' ? node.nodeId : '', node]));
  const excluded = node => {
    let current = node;
    const visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      if (hidden(current) || editable(current) || EXECUTABLE_TAGS.has(tag(current))) return true;
      current = typeof current.parentId === 'string' ? byId.get(current.parentId) : null;
    }
    return false;
  };
  const matches = nodes.filter(node => !excluded(node) && placeholder(node));
  const matchedIds = new Set(matches.map(node => typeof node.nodeId === 'string' ? node.nodeId : '').filter(Boolean));
  const hasMatchingDescendant = node => {
    const queue = Array.isArray(node.children) ? [...node.children] : [];
    const visited = new Set();
    while (queue.length && visited.size < MAX_SCANNED_NODES) {
      const childId = String(queue.shift());
      if (visited.has(childId)) continue;
      visited.add(childId);
      if (matchedIds.has(childId)) return true;
      const child = byId.get(childId);
      if (Array.isArray(child?.children)) queue.push(...child.children);
    }
    return false;
  };
  const targets = [];
  for (const node of matches) {
    if (targets.length >= MAX_RESULTS) break;
    if (hasMatchingDescendant(node)) continue;
    const nodeId = typeof node.nodeId === 'string' && /^[A-Za-z0-9._:-]{1,200}$/u.test(node.nodeId)
      ? node.nodeId
      : null;
    targets.push(Object.freeze({
      nodeId,
      selectorHint: '',
      message: 'Substitua o conteúdo provisório antes da publicação.',
      data: Object.freeze({ reason: 'placeholder-text' }),
    }));
  }
  return Object.freeze({
    outcome: targets.length ? 'failed' : 'inapplicable',
    summary: targets.length
      ? 'Há conteúdo provisório inequívoco na página.'
      : 'Não foi observado conteúdo provisório inequívoco.',
    targets: Object.freeze(targets),
    limitations: Object.freeze([]),
  });
}

export const EDITORIAL_RULES = createEditorialRuleRegistry([{
  id: RULE_ID,
  mode: 'automated',
  classification: 'editorial',
  impact: 'minor',
  confidence: 'high',
  source: { engine: 'audita-editorial', version: VERSION },
  evaluate: evaluatePlaceholder,
}]);

export function validateEditorialRuleComposition(rules = EDITORIAL_RULES) {
  if (!Array.isArray(rules) || rules.length !== 1) return ['Editorial rule count must be exactly 1'];
  const rule = rules[0];
  if (rule?.id !== RULE_ID || rule.mode !== 'automated' || rule.classification !== 'editorial' ||
    rule.impact !== 'minor' || rule.confidence !== 'high' || rule.source?.engine !== 'audita-editorial' ||
    rule.source?.version !== VERSION || typeof rule.evaluate !== 'function') {
    return ['Editorial rule metadata is invalid'];
  }
  return [];
}

export async function runEditorialRules(snapshot, rules = EDITORIAL_RULES) {
  const errors = validateEditorialRuleComposition(rules);
  if (errors.length) throw new TypeError(errors.join('; '));
  const output = [];
  for (const rule of rules) {
    const evaluation = rule.evaluate(snapshot);
    output.push(Object.freeze({
      ruleId: rule.id,
      outcome: evaluation.outcome,
      mode: rule.mode,
      classification: rule.classification,
      impact: rule.impact,
      confidence: rule.confidence,
      source: Object.freeze({ engine: rule.source.engine, ruleId: rule.id, version: rule.source.version }),
      nbrItems: Object.freeze([]),
      wcag: Object.freeze([]),
      targets: evaluation.targets,
      summary: evaluation.summary,
      limitations: evaluation.limitations,
    }));
  }
  return Object.freeze(output);
}
