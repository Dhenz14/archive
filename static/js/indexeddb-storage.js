/**
 * ArcHive IndexedDB Storage Module
 * Persistent storage for multi-part content with automatic cleanup
 * 
 * @author Dr. Sarah Chen (Database Architecture)
 * @version 1.0.0
 * @date November 24, 2025
 * 
 * Features:
 * - Large content storage (100MB+ capacity vs 5MB localStorage)
 * - Automatic expiry management (7-day retention)
 * - Quota monitoring and cleanup
 * - Cross-tab synchronization
 * - Transaction safety
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONFIGURATION & CONSTANTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const DB_NAME = 'ArcHiveMultiPartStorage';
const DB_VERSION = 1;

/**
 * Object Store Schemas
 */
const STORES = {
    CONTENT_PARTS: 'content_parts',      // Stores actual content parts
    PIPELINE_STATE: 'pipeline_state',    // Enhanced pipeline state (includes metadata)
    CLEANUP_LOG: 'cleanup_log'           // Cleanup history for debugging
};

/**
 * Retention policies (in days)
 */
const RETENTION_POLICY = {
    INCOMPLETE_POSTING: 14,  // Keep incomplete postings for 14 days
    COMPLETED_POSTING: 7,    // Keep completed postings for 7 days
    FAILED_POSTING: 30       // Keep failed postings for 30 days (debugging)
};

/**
 * Storage quota monitoring thresholds
 */
const QUOTA_THRESHOLDS = {
    WARNING: 0.8,    // Warn at 80% usage
    CRITICAL: 0.95   // Emergency cleanup at 95% usage
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DEBUG MODE CONFIGURATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const IDB_DEBUG = false;
const idbDebugLog = (...args) => { if (IDB_DEBUG) console.log(...args); };
const idbDebugWarn = (...args) => { if (IDB_DEBUG) console.warn(...args); };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DATABASE INITIALIZATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Initialize IndexedDB database with schema
 * Creates object stores and indexes
 * 
 * @returns {Promise<IDBDatabase>} - Database instance
 */
async function initDatabase() {
    return new Promise((resolve, reject) => {
        idbDebugLog(`🗄️  Initializing IndexedDB: ${DB_NAME} v${DB_VERSION}`);
        
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => {
            console.error('❌ Failed to open IndexedDB:', request.error);
            reject(request.error);
        };
        
        request.onsuccess = () => {
            const db = request.result;
            idbDebugLog(`✅ IndexedDB opened successfully`);
            idbDebugLog(`   Stores: ${Array.from(db.objectStoreNames).join(', ')}`);
            resolve(db);
        };
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            idbDebugLog(`🔧 Upgrading IndexedDB schema (v${event.oldVersion} → v${event.newVersion})`);
            
            // Store 1: Content Parts
            // Stores the actual content for each part of a multi-part series
            if (!db.objectStoreNames.contains(STORES.CONTENT_PARTS)) {
                const contentStore = db.createObjectStore(STORES.CONTENT_PARTS, { 
                    keyPath: 'id',
                    autoIncrement: true 
                });
                
                // Index by series_id for fast lookup
                contentStore.createIndex('series_id', 'series_id', { unique: false });
                
                // Index by expiry for cleanup
                contentStore.createIndex('expires_at', 'expires_at', { unique: false });
                
                // Compound index for series + part number
                contentStore.createIndex('series_part', ['series_id', 'part_number'], { unique: true });
                
                idbDebugLog(`   ✅ Created store: ${STORES.CONTENT_PARTS}`);
            }
            
            // Store 2: Pipeline State
            // Enhanced state storage with metadata and timestamps
            if (!db.objectStoreNames.contains(STORES.PIPELINE_STATE)) {
                const stateStore = db.createObjectStore(STORES.PIPELINE_STATE, { 
                    keyPath: 'series_id' 
                });
                
                // Index by status for filtering (in_progress, completed, failed)
                stateStore.createIndex('status', 'status', { unique: false });
                
                // Index by updated_at for cleanup
                stateStore.createIndex('updated_at', 'updated_at', { unique: false });
                
                idbDebugLog(`   ✅ Created store: ${STORES.PIPELINE_STATE}`);
            }
            
            // Store 3: Cleanup Log
            // Tracks cleanup operations for debugging
            if (!db.objectStoreNames.contains(STORES.CLEANUP_LOG)) {
                const cleanupStore = db.createObjectStore(STORES.CLEANUP_LOG, { 
                    keyPath: 'id',
                    autoIncrement: true 
                });
                
                cleanupStore.createIndex('timestamp', 'timestamp', { unique: false });
                
                idbDebugLog(`   ✅ Created store: ${STORES.CLEANUP_LOG}`);
            }
            
            idbDebugLog('🎉 Database schema created successfully');
        };
    });
}

/**
 * Get database instance (cached)
 * Opens DB if not already open
 * 
 * @returns {Promise<IDBDatabase>}
 */
let dbInstance = null;
async function getDB() {
    if (!dbInstance || dbInstance.version !== DB_VERSION) {
        dbInstance = await initDatabase();
    }
    return dbInstance;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONTENT PARTS OPERATIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Save content parts to IndexedDB
 * Stores all parts of a multi-part series with metadata
 * 
 * @param {string} seriesId - Series ID (UUID)
 * @param {Array<Object>} parts - Array of content parts
 * @param {Object} metadata - Additional metadata (title, url, etc.)
 * @returns {Promise<void>}
 */
async function saveContentParts(seriesId, parts, metadata = {}) {
    const db = await getDB();
    const tx = db.transaction(STORES.CONTENT_PARTS, 'readwrite');
    const store = tx.objectStore(STORES.CONTENT_PARTS);
    
    idbDebugLog(`💾 Saving ${parts.length} content parts for series: ${seriesId}`);
    
    // Calculate expiry based on retention policy
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + RETENTION_POLICY.INCOMPLETE_POSTING);
    
    const savePromises = parts.map((part, index) => {
        const record = {
            series_id: seriesId,
            part_number: index + 1,
            content: part.content || part, // Support both object and string
            byte_size: part.byteSize || part.byte_size || 0,
            word_count: part.wordCount || part.word_count || 0,
            metadata: {
                title: metadata.title || 'Untitled',
                url: metadata.url || '',
                saved_at: new Date().toISOString(),
                expires_at: expiresAt.toISOString()
            },
            expires_at: expiresAt  // For index-based cleanup
        };
        
        return new Promise((resolve, reject) => {
            const request = store.put(record);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    });
    
    await Promise.all(savePromises);
    await new Promise((resolve, reject) => {
        tx.oncomplete = () => {
            idbDebugLog(`   ✅ Saved ${parts.length} parts successfully`);
            idbDebugLog(`   📅 Expires: ${expiresAt.toLocaleDateString()}`);
            resolve();
        };
        tx.onerror = () => reject(tx.error);
    });
    
    // Check storage quota
    await checkStorageQuota();
}

/**
 * Load content parts from IndexedDB
 * Retrieves all parts for a given series
 * 
 * @param {string} seriesId - Series ID
 * @returns {Promise<Array<Object>>} - Array of content parts (sorted by part_number)
 */
async function loadContentParts(seriesId) {
    const db = await getDB();
    const tx = db.transaction(STORES.CONTENT_PARTS, 'readonly');
    const store = tx.objectStore(STORES.CONTENT_PARTS);
    const index = store.index('series_id');
    
    idbDebugLog(`📂 Loading content parts for series: ${seriesId}`);
    
    return new Promise((resolve, reject) => {
        const request = index.getAll(seriesId);
        
        request.onsuccess = () => {
            const parts = request.result;
            
            if (parts.length === 0) {
                idbDebugLog(`   ⚠️  No content parts found`);
                resolve([]);
                return;
            }
            
            // Sort by part_number
            parts.sort((a, b) => a.part_number - b.part_number);
            
            idbDebugLog(`   ✅ Loaded ${parts.length} parts`);
            idbDebugLog(`   📊 Total size: ${(parts.reduce((sum, p) => sum + (p.byte_size || 0), 0) / 1024).toFixed(1)} KB`);
            
            resolve(parts);
        };
        
        request.onerror = () => {
            console.error(`   ❌ Failed to load content parts:`, request.error);
            reject(request.error);
        };
    });
}

/**
 * Delete content parts for a series
 * Used after successful posting completion
 * 
 * @param {string} seriesId - Series ID
 * @returns {Promise<number>} - Number of parts deleted
 */
async function deleteContentParts(seriesId) {
    const db = await getDB();
    const tx = db.transaction(STORES.CONTENT_PARTS, 'readwrite');
    const store = tx.objectStore(STORES.CONTENT_PARTS);
    const index = store.index('series_id');
    
    idbDebugLog(`🗑️  Deleting content parts for series: ${seriesId}`);
    
    return new Promise((resolve, reject) => {
        const request = index.getAllKeys(seriesId);
        
        request.onsuccess = () => {
            const keys = request.result;
            
            if (keys.length === 0) {
                idbDebugLog(`   ℹ️  No content parts to delete`);
                resolve(0);
                return;
            }
            
            // Delete all parts
            const deletePromises = keys.map(key => {
                return new Promise((res, rej) => {
                    const delReq = store.delete(key);
                    delReq.onsuccess = () => res();
                    delReq.onerror = () => rej(delReq.error);
                });
            });
            
            Promise.all(deletePromises)
                .then(() => {
                    idbDebugLog(`   ✅ Deleted ${keys.length} parts`);
                    resolve(keys.length);
                })
                .catch(reject);
        };
        
        request.onerror = () => reject(request.error);
    });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PIPELINE STATE OPERATIONS (Enhanced)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Save enhanced pipeline state to IndexedDB
 * Includes metadata and content references
 * 
 * @param {string} seriesId - Series ID
 * @param {Object} state - Pipeline state object
 * @returns {Promise<void>}
 */
async function savePipelineState(seriesId, state) {
    const db = await getDB();
    const tx = db.transaction(STORES.PIPELINE_STATE, 'readwrite');
    const store = tx.objectStore(STORES.PIPELINE_STATE);
    
    const enhancedState = {
        series_id: seriesId,
        ...state,
        has_content_stored: true,  // Flag indicating content is in CONTENT_PARTS store
        updated_at: new Date().toISOString(),
        version: 2  // Enhanced state version
    };
    
    return new Promise((resolve, reject) => {
        const request = store.put(enhancedState);
        
        request.onsuccess = () => {
            idbDebugLog(`💾 Pipeline state saved to IndexedDB: ${seriesId}`);
            resolve();
        };
        
        request.onerror = () => {
            console.error(`❌ Failed to save pipeline state:`, request.error);
            reject(request.error);
        };
    });
}

/**
 * Load pipeline state from IndexedDB
 * 
 * @param {string} seriesId - Series ID
 * @returns {Promise<Object|null>} - State object or null
 */
async function loadPipelineState(seriesId) {
    const db = await getDB();
    const tx = db.transaction(STORES.PIPELINE_STATE, 'readonly');
    const store = tx.objectStore(STORES.PIPELINE_STATE);
    
    return new Promise((resolve, reject) => {
        const request = store.get(seriesId);
        
        request.onsuccess = () => {
            const state = request.result;
            
            if (state) {
                idbDebugLog(`📂 Pipeline state loaded from IndexedDB: ${seriesId}`);
                idbDebugLog(`   Status: ${state.status}`);
                idbDebugLog(`   Progress: ${state.currentPart}/${state.manifest.total_parts}`);
            } else {
                idbDebugLog(`ℹ️  No pipeline state found for: ${seriesId}`);
            }
            
            resolve(state || null);
        };
        
        request.onerror = () => reject(request.error);
    });
}

/**
 * Delete pipeline state
 * 
 * @param {string} seriesId - Series ID
 * @returns {Promise<void>}
 */
async function deletePipelineState(seriesId) {
    const db = await getDB();
    const tx = db.transaction(STORES.PIPELINE_STATE, 'readwrite');
    const store = tx.objectStore(STORES.PIPELINE_STATE);
    
    return new Promise((resolve, reject) => {
        const request = store.delete(seriesId);
        
        request.onsuccess = () => {
            idbDebugLog(`🗑️  Pipeline state deleted: ${seriesId}`);
            resolve();
        };
        
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get all incomplete pipeline states
 * Used for resume detection
 * 
 * @returns {Promise<Array<Object>>} - Array of incomplete states
 */
async function getAllIncompletePipelines() {
    const db = await getDB();
    const tx = db.transaction(STORES.PIPELINE_STATE, 'readonly');
    const store = tx.objectStore(STORES.PIPELINE_STATE);
    
    return new Promise((resolve, reject) => {
        const request = store.getAll();
        
        request.onsuccess = () => {
            const allStates = request.result;
            
            // Filter for incomplete/paused/failed statuses
            const incomplete = allStates.filter(state => 
                state.status === 'in_progress' || 
                state.status === 'paused' ||
                state.status === 'failed'
            );
            
            idbDebugLog(`📊 Found ${incomplete.length} incomplete pipeline(s)`);
            
            resolve(incomplete);
        };
        
        request.onerror = () => reject(request.error);
    });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STORAGE QUOTA MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Check storage quota and trigger cleanup if needed
 * 
 * @returns {Promise<Object>} - Quota information
 */
async function checkStorageQuota() {
    if (!navigator.storage || !navigator.storage.estimate) {
        idbDebugWarn('⚠️  Storage API not available - cannot check quota');
        return null;
    }
    
    const estimate = await navigator.storage.estimate();
    const usedMB = (estimate.usage / 1024 / 1024).toFixed(2);
    const quotaMB = (estimate.quota / 1024 / 1024).toFixed(2);
    const usagePercent = (estimate.usage / estimate.quota);
    
    idbDebugLog(`💾 Storage: ${usedMB} MB / ${quotaMB} MB (${(usagePercent * 100).toFixed(1)}%)`);
    
    // Trigger cleanup if approaching quota limits
    if (usagePercent >= QUOTA_THRESHOLDS.CRITICAL) {
        console.warn(`🚨 CRITICAL storage usage (${(usagePercent * 100).toFixed(1)}%) - triggering emergency cleanup`);
        await cleanupExpiredContent(true);
    } else if (usagePercent >= QUOTA_THRESHOLDS.WARNING) {
        console.warn(`⚠️  HIGH storage usage (${(usagePercent * 100).toFixed(1)}%) - consider cleanup`);
    }
    
    return {
        used: estimate.usage,
        quota: estimate.quota,
        usagePercent: usagePercent,
        usedMB: parseFloat(usedMB),
        quotaMB: parseFloat(quotaMB)
    };
}

/**
 * Clean up expired content based on retention policy
 * 
 * @param {boolean} emergency - Emergency cleanup (more aggressive)
 * @returns {Promise<Object>} - Cleanup statistics
 */
async function cleanupExpiredContent(emergency = false) {
    idbDebugLog(`🧹 Starting ${emergency ? 'EMERGENCY' : 'routine'} cleanup...`);
    
    const db = await getDB();
    const now = new Date();
    const stats = {
        content_parts_deleted: 0,
        pipeline_states_deleted: 0,
        bytes_freed: 0
    };
    
    // Cleanup content parts
    {
        const tx = db.transaction(STORES.CONTENT_PARTS, 'readwrite');
        const store = tx.objectStore(STORES.CONTENT_PARTS);
        const index = store.index('expires_at');
        
        const range = IDBKeyRange.upperBound(now);
        const request = index.openCursor(range);
        
        await new Promise((resolve, reject) => {
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    const record = cursor.value;
                    stats.bytes_freed += record.byte_size || 0;
                    cursor.delete();
                    stats.content_parts_deleted++;
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            request.onerror = () => reject(request.error);
        });
    }
    
    // Cleanup pipeline states (completed/failed older than retention policy)
    {
        const tx = db.transaction(STORES.PIPELINE_STATE, 'readwrite');
        const store = tx.objectStore(STORES.PIPELINE_STATE);
        
        const request = store.openCursor();
        
        await new Promise((resolve, reject) => {
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    const state = cursor.value;
                    const updatedAt = new Date(state.updated_at || state.savedAt);
                    const ageInDays = (now - updatedAt) / (1000 * 60 * 60 * 24);
                    
                    let shouldDelete = false;
                    
                    if (state.status === 'completed' && ageInDays > RETENTION_POLICY.COMPLETED_POSTING) {
                        shouldDelete = true;
                    } else if (state.status === 'failed' && ageInDays > RETENTION_POLICY.FAILED_POSTING) {
                        shouldDelete = true;
                    } else if (emergency && (state.status === 'in_progress' || state.status === 'paused') && ageInDays > 7) {
                        // Emergency cleanup: Remove incomplete states older than 7 days
                        shouldDelete = true;
                    }
                    
                    if (shouldDelete) {
                        cursor.delete();
                        stats.pipeline_states_deleted++;
                    }
                    
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            request.onerror = () => reject(request.error);
        });
    }
    
    // Log cleanup operation
    await logCleanup(stats);
    
    idbDebugLog(`✅ Cleanup complete:`);
    idbDebugLog(`   Content parts deleted: ${stats.content_parts_deleted}`);
    idbDebugLog(`   Pipeline states deleted: ${stats.pipeline_states_deleted}`);
    idbDebugLog(`   Storage freed: ${(stats.bytes_freed / 1024).toFixed(1)} KB`);
    
    return stats;
}

/**
 * Log cleanup operation for debugging
 * 
 * @param {Object} stats - Cleanup statistics
 * @returns {Promise<void>}
 */
async function logCleanup(stats) {
    const db = await getDB();
    const tx = db.transaction(STORES.CLEANUP_LOG, 'readwrite');
    const store = tx.objectStore(STORES.CLEANUP_LOG);
    
    const logEntry = {
        timestamp: new Date().toISOString(),
        stats: stats
    };
    
    return new Promise((resolve, reject) => {
        const request = store.add(logEntry);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PUBLIC API EXPORT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if (typeof window !== 'undefined') {
    window.ArcHiveStorage = {
        // Database management
        initDatabase,
        getDB,
        
        // Content operations
        saveContentParts,
        loadContentParts,
        deleteContentParts,
        
        // Pipeline state operations
        savePipelineState,
        loadPipelineState,
        deletePipelineState,
        getAllIncompletePipelines,
        
        // Quota management
        checkStorageQuota,
        cleanupExpiredContent,
        
        // Constants
        RETENTION_POLICY,
        QUOTA_THRESHOLDS
    };
    
    idbDebugLog('✅ ArcHive IndexedDB Storage module loaded');
    idbDebugLog('   Available as: window.ArcHiveStorage');
}
