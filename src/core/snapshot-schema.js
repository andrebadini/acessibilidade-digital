export const SNAPSHOT_SCHEMA_VERSION = 1;

const RUNTIME_INDEX_FIELDS = Object.freeze(['byNodeId', 'byDomId', 'byId']);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nodeIdKey(value) {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (Number.isSafeInteger(value)) return String(value);
  return null;
}

function serializationError(value, path, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${path} contains a non-finite number`;
  if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof value)) {
    return `${path} is not JSON-serializable`;
  }
  if (typeof value !== 'object') return `${path} is not JSON-serializable`;
  if (ancestors.has(value)) return `${path} contains a cycle`;
  if (!Array.isArray(value) && !isRecord(value)) return `${path} contains a non-data object`;

  ancestors.add(value);
  try {
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return `${path}.${key} must be a data property`;
      const error = serializationError(descriptor.value, `${path}.${key}`, ancestors);
      if (error) return error;
    }
  } finally {
    ancestors.delete(value);
  }
  return null;
}

/**
 * Validates the serializable SnapshotV1 wire shape:
 * `{ schemaVersion: 1, document, nodes }`. Each normalized node owns a
 * `nodeId`, an `attributes` record, `children` containing only nodeIds, and a
 * `parentId` containing a nodeId or null. Runtime indexes never belong to the
 * wire object.
 */
export function validateSnapshotV1(snapshot) {
  const errors = [];
  if (!isRecord(snapshot)) return ['SnapshotV1 must be a plain object'];
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) errors.push('SnapshotV1 schemaVersion must be 1');
  if (!isRecord(snapshot.document)) errors.push('SnapshotV1 document must be a plain object');
  if (!Array.isArray(snapshot.nodes)) errors.push('SnapshotV1 nodes must be an array');
  for (const field of RUNTIME_INDEX_FIELDS) {
    if (Object.hasOwn(snapshot, field)) errors.push(`SnapshotV1 must not serialize runtime index ${field}`);
  }
  if (!Array.isArray(snapshot.nodes)) return errors;

  const ids = new Set();
  for (const [index, node] of snapshot.nodes.entries()) {
    if (!isRecord(node)) {
      errors.push(`SnapshotV1 nodes[${index}] must be a plain object`);
      continue;
    }
    const id = nodeIdKey(node.nodeId);
    if (id === null) errors.push(`SnapshotV1 nodes[${index}].nodeId is invalid`);
    else if (ids.has(id)) errors.push(`SnapshotV1 has duplicate nodeId ${id}`);
    else ids.add(id);
    if (!isRecord(node.attributes)) errors.push(`SnapshotV1 node ${id ?? index} attributes must be a plain object`);
    if (!Array.isArray(node.children)) errors.push(`SnapshotV1 node ${id ?? index} children must be an array of nodeIds`);
    if (!Object.hasOwn(node, 'parentId')) errors.push(`SnapshotV1 node ${id ?? index} must own parentId`);
    else if (node.parentId !== null && nodeIdKey(node.parentId) === null) errors.push(`SnapshotV1 node ${id ?? index} parentId is invalid`);
  }

  const documentId = nodeIdKey(snapshot.document?.nodeId);
  for (const [index, node] of snapshot.nodes.entries()) {
    if (!isRecord(node)) continue;
    for (const childId of Array.isArray(node.children) ? node.children : []) {
      const key = nodeIdKey(childId);
      if (key === null || !ids.has(key)) errors.push(`SnapshotV1 node ${nodeIdKey(node.nodeId) ?? index} references missing child ${String(childId)}`);
    }
    if (Object.hasOwn(node, 'labels')) {
      if (!Array.isArray(node.labels)) {
        errors.push(`SnapshotV1 node ${nodeIdKey(node.nodeId) ?? index} labels must be an array of nodeIds`);
      } else {
        for (const labelId of node.labels) {
          const key = nodeIdKey(labelId);
          if (key === null || !ids.has(key)) errors.push(`SnapshotV1 node ${nodeIdKey(node.nodeId) ?? index} references missing label ${String(labelId)}`);
        }
      }
    }
    if (node.parentId !== null && node.parentId !== undefined) {
      const parent = nodeIdKey(node.parentId);
      if (parent !== documentId && !ids.has(parent)) errors.push(`SnapshotV1 node ${nodeIdKey(node.nodeId) ?? index} references missing parent ${String(node.parentId)}`);
    }
  }

  const serializable = serializationError(snapshot, 'SnapshotV1');
  if (serializable) errors.push(serializable);
  return errors;
}

export function assertSnapshotV1(snapshot) {
  const errors = validateSnapshotV1(snapshot);
  if (errors.length > 0) throw new TypeError(`Invalid SnapshotV1: ${errors.join('; ')}`);
  return snapshot;
}

/** Builds authoritative runtime-only indexes without modifying the snapshot. */
export function buildSnapshotIndexes(snapshot) {
  assertSnapshotV1(snapshot);
  const byNodeId = new Map();
  const byDomId = new Map();
  for (const node of snapshot.nodes) {
    byNodeId.set(String(node.nodeId), node);
    const domId = typeof node.attributes.id === 'string' ? node.attributes.id.trim() : '';
    if (!domId) continue;
    const matches = byDomId.get(domId) ?? [];
    matches.push(node);
    byDomId.set(domId, matches);
  }
  for (const [id, matches] of byDomId) byDomId.set(id, Object.freeze(matches));
  return Object.freeze({ byNodeId, byDomId });
}
