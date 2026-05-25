/**
 * Page-level skeleton barrel — backwards-compatible re-exports.
 * Implementation lives in the topical files alongside this one.
 * Splitting was done to help the bundler tree-shake more aggressively
 * (a single 1,007-line client module forces every importer to pull
 * a large chunk; smaller per-section files let unused sections drop).
 */

export * from './AdminLayout';
export * from './AdminPages';
export * from './UserDashboard';
export * from './PaymentPages';
