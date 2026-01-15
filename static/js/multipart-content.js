/**
 * ArcHive Multi-Part Content System
 * Handles splitting, linking, and reassembly of content exceeding Hive's posting limits
 * 
 * Key Features:
 * - Paragraph-aware content splitting (~58KB chunks)
 * - Cryptographic linking via series manifests
 * - Dual hash verification (per-part + full content)
 * - Smart tag harmonization across parts
 * - Frontend reassembly for unified viewing
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DEBUG MODE CONFIGURATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const MULTIPART_DEBUG = false;
const mpDebugLog = (...args) => { if (MULTIPART_DEBUG) console.log(...args); };
const mpDebugWarn = (...args) => { if (MULTIPART_DEBUG) console.warn(...args); };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONSTANTS & CONFIGURATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * State versioning for future migrations (Phase 9)
 */
const STATE_VERSION = 1;

/**
 * Posting lock configuration (Phase 9)
 * Prevents concurrent posting across tabs
 */
const POSTING_LOCK_CONFIG = {
    expiryMs: 5 * 60 * 1000, // 5 minutes (locks older than this are considered stale)
    checkIntervalMs: 1000 // 1 second polling interval for lock status
};

/**
 * State retention policy (Phase 9)
 * Automatic cleanup of old pipeline states
 */
const STATE_RETENTION_CONFIG = {
    incompleteMaxAgeDays: 14, // Remove incomplete states older than 14 days
    completedMaxAgeDays: 7 // Remove completed states older than 7 days
};

/**
 * Hive blockchain posting limits
 * Using 58KB instead of 64KB to account for:
 * - JSON encoding overhead (~5%)
 * - Metadata storage (~3%)
 * - Safety margin (~2%)
 */
const HIVE_BODY_LIMIT_BYTES = 64 * 1024; // 64KB absolute limit
const SAFE_CHUNK_SIZE_BYTES = 58 * 1024; // 58KB safe limit with 10% headroom
const METADATA_OVERHEAD_BYTES = 2 * 1024; // Reserve 2KB for manifest metadata

/**
 * Content splitting configuration
 */
const SPLIT_CONFIG = {
    // Try to split at paragraph boundaries first
    preferredBoundary: 'paragraph',
    
    // Fallback hierarchy for boundary detection
    boundaryFallbacks: ['sentence', 'word', 'character'],
    
    // Minimum chunk size to avoid tiny parts
    minChunkSizeBytes: 10 * 1024, // 10KB minimum
    
    // Paragraph markers (double newline or HTML paragraph tags)
    paragraphMarkers: ['\n\n', '</p>', '<br><br>', '<br/><br/>'],
    
    // Sentence markers
    sentenceMarkers: ['. ', '! ', '? ', '.\n', '!\n', '?\n'],
    
    // Word marker
    wordMarker: ' '
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONTENT SIZE CALCULATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Calculate byte size of content including encoding overhead
 * Accounts for UTF-8 multibyte characters and JSON encoding
 * 
 * @param {string} content - Content to measure
 * @returns {number} - Size in bytes
 */
function calculateByteSize(content) {
    if (!content || typeof content !== 'string') {
        return 0;
    }
    
    // Use TextEncoder for accurate UTF-8 byte calculation
    const encoder = new TextEncoder();
    const encoded = encoder.encode(content);
    
    // Add JSON encoding overhead (quotes, escapes, etc.)
    // Estimate ~3% overhead for typical content
    const jsonOverhead = Math.ceil(encoded.length * 0.03);
    
    return encoded.length + jsonOverhead;
}

/**
 * Check if content exceeds safe posting limit
 * 
 * @param {string} content - Content to check
 * @returns {boolean} - True if content needs splitting
 */
function needsSplitting(content) {
    const size = calculateByteSize(content);
    mpDebugLog(`📏 Content size: ${size.toLocaleString()} bytes (limit: ${SAFE_CHUNK_SIZE_BYTES.toLocaleString()})`);
    return size > SAFE_CHUNK_SIZE_BYTES;
}

/**
 * Estimate how many parts content will need
 * 
 * @param {string} content - Content to analyze
 * @returns {number} - Estimated number of parts
 */
function estimatePartCount(content) {
    const totalSize = calculateByteSize(content);
    const usableChunkSize = SAFE_CHUNK_SIZE_BYTES - METADATA_OVERHEAD_BYTES;
    return Math.ceil(totalSize / usableChunkSize);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONTENT SPLITTING ENGINE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Find the best split position using paragraph-aware algorithm
 * 
 * @param {string} content - Content to split
 * @param {number} targetSize - Target size in bytes
 * @param {string} boundary - Boundary type ('paragraph', 'sentence', 'word', 'character')
 * @returns {number} - Best split position (character index)
 */
function findSplitPosition(content, targetSize, boundary = 'paragraph') {
    const encoder = new TextEncoder();
    let currentPos = 0;
    let currentSize = 0;
    
    // Get boundary markers based on type
    let markers = [];
    switch (boundary) {
        case 'paragraph':
            markers = SPLIT_CONFIG.paragraphMarkers;
            break;
        case 'sentence':
            markers = SPLIT_CONFIG.sentenceMarkers;
            break;
        case 'word':
            markers = [SPLIT_CONFIG.wordMarker];
            break;
        case 'character':
            // BUG FIX: O(n) character-level splitting using incremental byte tracking
            // Old implementation was O(n²) - recalculated entire substring each iteration
            // New implementation tracks bytes incrementally for linear performance
            const encoder = new TextEncoder();
            let charPos = 0;
            let byteCount = 0;
            
            while (charPos < content.length) {
                // Get next character (handle UTF-16 surrogates correctly)
                const codePoint = content.codePointAt(charPos);
                const char = String.fromCodePoint(codePoint);
                
                // Calculate byte size of this single character
                const charBytes = encoder.encode(char).length;
                
                // Check if adding this character would exceed target
                if (byteCount + charBytes > targetSize) {
                    // Return position before this character
                    return charPos > 0 ? charPos : 0;
                }
                
                // Add character's bytes to running total
                byteCount += charBytes;
                
                // Advance position (handle surrogate pairs)
                charPos += char.length;
            }
            
            // Entire content fits
            return content.length;
    }
    
    // Find the last boundary marker before targetSize
    let bestSplitPos = 0;
    let searchPos = 0;
    
    while (searchPos < content.length) {
        // Find next boundary marker
        let nextMarkerPos = -1;
        let nextMarker = null;
        
        for (const marker of markers) {
            const pos = content.indexOf(marker, searchPos);
            if (pos !== -1 && (nextMarkerPos === -1 || pos < nextMarkerPos)) {
                nextMarkerPos = pos;
                nextMarker = marker;
            }
        }
        
        // No more markers found
        if (nextMarkerPos === -1) {
            break;
        }
        
        // Calculate size up to this marker
        const posAfterMarker = nextMarkerPos + nextMarker.length;
        const chunk = content.substring(0, posAfterMarker);
        const chunkSize = calculateByteSize(chunk);
        
        // If this chunk fits, it's our new best split position
        if (chunkSize <= targetSize) {
            bestSplitPos = posAfterMarker;
            searchPos = posAfterMarker;
        } else {
            // Exceeded target size, return previous best position
            break;
        }
    }
    
    return bestSplitPos > 0 ? bestSplitPos : searchPos;
}

/**
 * Split content into parts with smart boundary detection
 * Uses paragraph boundaries first, falls back to sentence/word if needed
 * 
 * @param {string} content - Content to split
 * @param {string} title - Content title (for logging)
 * @returns {Array<Object>} - Array of parts with metadata
 */
function splitContentIntoParts(content, title = 'Untitled') {
    // BUG FIX: Input validation to prevent null/undefined crashes
    // Note: Empty strings ('') are valid - they return a single empty part
    if (content == null || typeof content !== 'string') {
        throw new Error('splitContentIntoParts requires a string (got ' + typeof content + ')');
    }
    
    if (!needsSplitting(content)) {
        // Content fits in single post - no splitting needed
        return [{
            partNumber: 1,
            totalParts: 1,
            content: content,
            byteSize: calculateByteSize(content),
            wordCount: content.trim().split(/\s+/).length,
            boundary: 'none'
        }];
    }
    
    mpDebugLog(`✂️  Splitting content: "${title}"`);
    mpDebugLog(`📏 Total size: ${calculateByteSize(content).toLocaleString()} bytes`);
    
    const parts = [];
    let remainingContent = content;
    let partNumber = 1;
    const usableChunkSize = SAFE_CHUNK_SIZE_BYTES - METADATA_OVERHEAD_BYTES;
    
    while (remainingContent.length > 0) {
        let splitPos = 0;
        let boundaryUsed = 'character';
        
        // Try each boundary type in order of preference
        const boundaryTypes = [
            SPLIT_CONFIG.preferredBoundary,
            ...SPLIT_CONFIG.boundaryFallbacks
        ];
        
        for (const boundary of boundaryTypes) {
            splitPos = findSplitPosition(remainingContent, usableChunkSize, boundary);
            
            // Check if we found a good split position
            if (splitPos > 0) {
                const chunk = remainingContent.substring(0, splitPos);
                const chunkSize = calculateByteSize(chunk);
                
                // Verify chunk meets minimum size (unless it's the last chunk)
                if (chunkSize >= SPLIT_CONFIG.minChunkSizeBytes || 
                    remainingContent.substring(splitPos).trim().length === 0) {
                    boundaryUsed = boundary;
                    break;
                }
            }
        }
        
        // If no good split found, force split at character boundary
        if (splitPos === 0) {
            splitPos = findSplitPosition(remainingContent, usableChunkSize, 'character');
            boundaryUsed = 'character (forced)';
        }
        
        // BUG FIX: Zero-split bailout prevents infinite loop
        // If findSplitPosition returns 0 even after character fallback,
        // treat remaining content as final part to avoid infinite loop
        if (splitPos === 0) {
            mpDebugWarn('⚠️ Zero split detected - emitting remainder as final part');
            parts.push({
                partNumber: partNumber,
                totalParts: 0,
                content: remainingContent,
                byteSize: calculateByteSize(remainingContent),
                wordCount: remainingContent.trim().split(/\s+/).filter(w => w.length > 0).length,
                boundary: 'emergency (no split possible)'
            });
            break; // Exit loop to prevent infinite iteration
        }
        
        // Extract this part (DO NOT TRIM - preserves exact whitespace for reconstruction)
        const partContent = remainingContent.substring(0, splitPos);
        const partSize = calculateByteSize(partContent);
        const wordCount = partContent.trim().split(/\s+/).filter(w => w.length > 0).length;
        
        parts.push({
            partNumber: partNumber,
            totalParts: 0, // Will be updated after all parts are created
            content: partContent,
            byteSize: partSize,
            wordCount: wordCount,
            boundary: boundaryUsed
        });
        
        mpDebugLog(`📄 Part ${partNumber}: ${wordCount.toLocaleString()} words, ${partSize.toLocaleString()} bytes (${boundaryUsed})`);
        
        // Move to next chunk (DO NOT TRIM - preserves exact whitespace)
        remainingContent = remainingContent.substring(splitPos);
        partNumber++;
        
        // Safety check: prevent runaway splitting
        if (partNumber > 100) {
            console.error('❌ Safety limit: exceeded 100 parts');
            throw new Error('Content too large - exceeded maximum of 100 parts');
        }
    }
    
    // Update totalParts for all parts
    const totalParts = parts.length;
    parts.forEach(part => {
        part.totalParts = totalParts;
    });
    
    mpDebugLog(`✅ Split complete: ${totalParts} parts created`);
    return parts;
}

/**
 * Generate preview summary for multi-part content
 * Shows how content will be split before posting
 * 
 * @param {Array<Object>} parts - Parts array from splitContentIntoParts
 * @returns {Object} - Preview object with summary statistics
 */
function generateSplitPreview(parts) {
    const totalWords = parts.reduce((sum, part) => sum + part.wordCount, 0);
    const totalBytes = parts.reduce((sum, part) => sum + part.byteSize, 0);
    
    return {
        totalParts: parts.length,
        totalWords: totalWords,
        totalBytes: totalBytes,
        totalSizeKB: (totalBytes / 1024).toFixed(2),
        parts: parts.map(part => ({
            partNumber: part.partNumber,
            wordCount: part.wordCount,
            byteSize: part.byteSize,
            sizeKB: (part.byteSize / 1024).toFixed(2),
            boundary: part.boundary,
            preview: part.content.substring(0, 100) + (part.content.length > 100 ? '...' : '')
        })),
        estimatedPostingTime: parts.length * 5, // ~5 seconds per part
        safetyMargin: ((SAFE_CHUNK_SIZE_BYTES - Math.max(...parts.map(p => p.byteSize))) / 1024).toFixed(2)
    };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DUAL HASH SYSTEM (Phase 3)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Strip manifest HTML comment from content before hashing
 * Removes the <!--ARCHIVE-MANIFEST:...-->  comment that's added after hashing
 * to prevent hash verification mismatches
 * 
 * During archiving: Content is hashed FIRST (clean), THEN manifest is added
 * During verification: Content is fetched WITH manifest, must be stripped before hashing
 * 
 * @param {string} content - Content that may contain manifest comment
 * @returns {string} - Content with manifest comment removed
 */
function stripManifestComment(content) {
    if (!content || typeof content !== 'string') {
        return content;
    }
    
    // BUG FIX: Use [\s\S]*? to match multi-line manifests (. doesn't match newlines)
    // The manifest contains JSON which spans multiple lines
    // Also handle optional leading newlines (may be \n\n, \n, or nothing)
    return content.replace(/\n*<!--ARCHIVE-MANIFEST:[\s\S]*?-->/g, '');
}

/**
 * Hash a string with SHA-256, BLAKE2b, and MD5
 * Requires: blakejs and md5 libraries to be loaded globally
 * 
 * @param {string} input - String to hash
 * @returns {Promise<Object>} - Object with sha256, blake2b, and md5 hashes
 */
async function hashString(input) {
    if (typeof input !== 'string') {
        throw new Error('hashString requires a string input');
    }
    
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    
    // SHA-256 (Native Web Crypto API)
    const sha256Buffer = await crypto.subtle.digest('SHA-256', data);
    const sha256 = Array.from(new Uint8Array(sha256Buffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    
    // BLAKE2b (requires blakejs library)
    let blake2b = null;
    if (typeof blakejs !== 'undefined' && blakejs.blake2bHex) {
        try {
            // Pass string directly - library handles conversion internally
            blake2b = blakejs.blake2bHex(input);
        } catch (e) {
            mpDebugWarn('⚠️  BLAKE2b hashing failed:', e.message);
            blake2b = null;  // Skip BLAKE2b, rely on SHA-256 + MD5
        }
    }
    
    // MD5 (requires md5 library)
    if (typeof md5 === 'undefined') {
        throw new Error('md5 library not loaded - required for MD5 hashing');
    }
    const md5Hash = md5(input);
    
    return {
        sha256: sha256,
        blake2b: blake2b,
        md5: md5Hash
    };
}

/**
 * Generate dual-layer hashes for multi-part content
 * Creates both per-part hashes and full-content canonical hash
 * 
 * This is the core cryptographic verification system:
 * 1. Each part is hashed individually (for part-level integrity)
 * 2. All parts are reassembled and hashed together (for content-level authenticity)
 * 
 * @param {Array<string>} contentParts - Array of content strings (in order)
 * @returns {Promise<Object>} - Object with partHashes and fullContentHash
 * 
 * @example
 * const parts = ['Part 1 content...', 'Part 2 content...'];
 * const hashes = await hashMultiPartContent(parts);
 * console.log(hashes.partHashes); // [{part_number: 1, sha256: '...', blake2b: '...', md5: '...'}, ...]
 * console.log(hashes.fullContentHash); // {sha256: '...', blake2b: '...', md5: '...'}
 */
async function hashMultiPartContent(contentParts) {
    if (!Array.isArray(contentParts) || contentParts.length === 0) {
        throw new Error('hashMultiPartContent requires a non-empty array of content parts');
    }
    
    mpDebugLog(`🔐 Starting dual hash generation for ${contentParts.length} parts...`);
    
    // STEP 1: Hash each part individually
    const partHashes = [];
    for (let i = 0; i < contentParts.length; i++) {
        const partContent = contentParts[i];
        mpDebugLog(`  📝 Hashing part ${i + 1}/${contentParts.length} (${partContent.length} chars)...`);
        
        const hashes = await hashString(partContent);
        partHashes.push({
            part_number: i + 1,
            sha256: hashes.sha256,
            blake2b: hashes.blake2b,
            md5: hashes.md5
        });
    }
    mpDebugLog(`  ✅ Per-part hashes complete`);
    
    // STEP 2: Reassemble all parts and hash the full content
    mpDebugLog(`  🔗 Reassembling ${contentParts.length} parts for canonical hash...`);
    const fullContent = contentParts.join('');
    mpDebugLog(`  📊 Full content: ${fullContent.length} chars`);
    
    const fullContentHash = await hashString(fullContent);
    mpDebugLog(`  ✅ Full content hash complete`);
    
    mpDebugLog(`🔐 Dual hash generation complete!`);
    mpDebugLog(`  📦 Part hashes: ${partHashes.length} entries`);
    mpDebugLog(`  🌐 Full SHA-256: ${fullContentHash.sha256.substring(0, 16)}...`);
    
    return {
        partHashes: partHashes,
        fullContentHash: fullContentHash
    };
}

/**
 * Verify multi-part content integrity using dual hash system
 * Checks both per-part hashes and full-content hash
 * 
 * @param {Array<string>} contentParts - Array of content strings (in order)
 * @param {Object} expectedHashes - Expected hashes from manifest
 * @param {Array<Object>} expectedHashes.partHashes - Expected per-part hashes
 * @param {Object} expectedHashes.fullContentHash - Expected full content hash
 * @returns {Promise<Object>} - Verification result with details
 */
async function verifyMultiPartContent(contentParts, expectedHashes) {
    mpDebugLog(`🔍 Verifying multi-part content integrity...`);
    
    // Generate hashes for the provided content
    const actualHashes = await hashMultiPartContent(contentParts);
    
    // Verify part count matches
    if (actualHashes.partHashes.length !== expectedHashes.partHashes.length) {
        return {
            valid: false,
            reason: 'part_count_mismatch',
            expected: expectedHashes.partHashes.length,
            actual: actualHashes.partHashes.length
        };
    }
    
    // Verify each part hash (backward-compatible)
    // Only compare algorithms that are present in expected hashes
    const partVerifications = [];
    for (let i = 0; i < actualHashes.partHashes.length; i++) {
        const actual = actualHashes.partHashes[i];
        const expected = expectedHashes.partHashes[i];
        
        // Build matches object - only compare algorithms present in expected
        const matches = {
            sha256: actual.sha256 === expected.sha256
        };
        
        // Optional algorithms (backward compatibility with Phase 2)
        if (expected.blake2b !== undefined) {
            matches.blake2b = actual.blake2b === expected.blake2b;
        }
        if (expected.md5 !== undefined) {
            matches.md5 = actual.md5 === expected.md5;
        }
        
        // All present algorithms must match
        const allMatch = Object.values(matches).every(m => m === true);
        
        partVerifications.push({
            partNumber: i + 1,
            valid: allMatch,
            matches: matches
        });
        
        if (!allMatch) {
            console.warn(`  ⚠️  Part ${i + 1} hash mismatch:`, matches);
        }
    }
    
    // Verify full content hash (backward-compatible)
    // Handle both legacy string format and new object format
    let fullHashMatches = {};
    let fullHashValid = false;
    
    if (typeof expectedHashes.fullContentHash === 'string') {
        // Legacy Phase 2 format - compare SHA-256 only
        fullHashMatches.sha256 = actualHashes.fullContentHash.sha256 === expectedHashes.fullContentHash;
        fullHashValid = fullHashMatches.sha256;
    } else {
        // Phase 3 format - compare all present algorithms
        fullHashMatches.sha256 = actualHashes.fullContentHash.sha256 === expectedHashes.fullContentHash.sha256;
        
        // Optional algorithms (backward compatibility)
        if (expectedHashes.fullContentHash.blake2b !== undefined) {
            fullHashMatches.blake2b = actualHashes.fullContentHash.blake2b === expectedHashes.fullContentHash.blake2b;
        }
        if (expectedHashes.fullContentHash.md5 !== undefined) {
            fullHashMatches.md5 = actualHashes.fullContentHash.md5 === expectedHashes.fullContentHash.md5;
        }
        
        // All present algorithms must match
        fullHashValid = Object.values(fullHashMatches).every(m => m === true);
    }
    
    const allPartsValid = partVerifications.every(p => p.valid);
    
    const result = {
        valid: allPartsValid && fullHashValid,
        partVerifications: partVerifications,
        fullHashMatches: fullHashMatches,
        allPartsValid: allPartsValid,
        fullHashValid: fullHashValid
    };
    
    if (result.valid) {
        mpDebugLog(`  ✅ All hashes verified! Content is authentic.`);
    } else {
        console.warn(`  ❌ Hash verification failed!`);
        if (!allPartsValid) {
            console.warn(`    - Part-level mismatches detected`);
        }
        if (!fullHashValid) {
            console.warn(`    - Full content hash mismatch`);
        }
    }
    
    return result;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MANIFEST SCHEMA & GENERATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Generate a UUIDv4 for series identification
 * Uses crypto.randomUUID if available, falls back to manual generation
 * 
 * @returns {string} - UUIDv4 string
 */
function generateUUID() {
    // Use native crypto.randomUUID if available (modern browsers)
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    
    // Fallback: manual UUID v4 generation
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Generate SERIES tag for multi-part content discovery (Phase 5)
 * 
 * Creates 16 discovery buckets (SERIES0-SERIESF) based on series_id
 * Enables efficient search: find all parts of a series without scanning all posts
 * 
 * Tag Format: SERIES<hex>
 * - SERIES0, SERIES1, ..., SERIES9, SERIESA, SERIESB, ..., SERIESF
 * 
 * Discovery Math:
 * - Without SERIES tag: Must scan all multi-part posts to find series
 * - With SERIES tag: Narrows to ~1/16th of multi-part posts
 * - Example: 1,600 multi-part posts → ~100 posts per bucket
 * 
 * @param {string} series_id - UUIDv4 series identifier
 * @returns {string} - SERIES tag (e.g., 'SERIESA', 'SERIES7', 'SERIESF')
 * @throws {Error} - If series_id is invalid or missing
 * 
 * @example
 * // Series ID: a7b3c4d5-1234-4abc-8def-123456789abc
 * // First hex char: 'a'
 * // Result: 'SERIESA'
 * const tag = generateSeriesTag('a7b3c4d5-1234-4abc-8def-123456789abc');
 * console.log(tag); // 'SERIESA'
 */
function generateSeriesTag(series_id) {
    // Validate input
    if (!series_id || typeof series_id !== 'string') {
        throw new Error('generateSeriesTag requires a valid series_id (UUIDv4 string)');
    }
    
    // Remove hyphens and get first character
    const cleanId = series_id.replace(/-/g, '');
    
    if (cleanId.length === 0) {
        throw new Error('series_id cannot be empty after removing hyphens');
    }
    
    // Extract first hex character
    const firstChar = cleanId.charAt(0).toLowerCase();
    
    // Validate hex character (0-9, a-f)
    if (!/^[0-9a-f]$/.test(firstChar)) {
        throw new Error(`Invalid series_id: first character '${firstChar}' is not a valid hex digit (0-9, a-f)`);
    }
    
    // Generate tag: SERIES + uppercase hex char
    const tag = 'SERIES' + firstChar.toUpperCase();
    
    mpDebugLog(`🏷️  Generated series tag: ${tag} (from series_id: ${series_id.substring(0, 8)}...)`);
    
    return tag;
}

/**
 * Create a multi-part series manifest
 * Contains all metadata needed to link and reassemble parts
 * 
 * @param {Object} config - Configuration object
 * @param {string} config.sourceUrl - Original URL of content
 * @param {string} config.title - Content title
 * @param {number} config.totalParts - Total number of parts
 * @param {Object} config.contentHashFull - Hash of complete reassembled content {sha256, blake2b, md5}
 * @param {Array<Object>} config.partHashes - Array of per-part hashes [{part_number, sha256, blake2b, md5}, ...]
 * @param {Array<string>} config.tags - Smart tags for discovery
 * @param {string} config.seriesId - Optional custom series ID (auto-generated if not provided)
 * @param {string} config.author - Optional author username (for all parts)
 * @param {Array<Object>} config.parts - Optional pre-existing part descriptors (for migration/resume)
 * @returns {Object} - Manifest object with threaded replies architecture metadata
 * 
 * Manifest Fields:
 * - architecture: 'threaded_replies' - Indicates posting structure (Part 1 = root post, Parts 2+ = threaded comment replies)
 * - root_permlink: null - Part 1's permlink (populated after Part 1 posts successfully). Used by Link Explorer to reconstruct full article by fetching comment replies.
 */
function createManifest(config) {
    const {
        sourceUrl,
        title,
        totalParts,
        contentHashFull,
        partHashes,
        tags = [],
        seriesId = null,
        author = null,
        parts = null
    } = config;
    
    // Validate required fields
    if (!sourceUrl || !title || !totalParts || !contentHashFull || !partHashes) {
        throw new Error('Missing required manifest fields');
    }
    
    if (partHashes.length !== totalParts) {
        throw new Error(`Part hash count (${partHashes.length}) doesn't match total parts (${totalParts})`);
    }
    
    // Validate hash format (SHA-256 and MD5 required, BLAKE2b optional for resilience)
    // Note: hashString() may return blake2b=null if blakejs fails, so we don't require it
    if (!contentHashFull.sha256 || !contentHashFull.md5) {
        throw new Error('contentHashFull must contain sha256 and md5');
    }
    // Log if BLAKE2b is missing (for debugging, not blocking)
    if (!contentHashFull.blake2b) {
        mpDebugWarn('⚠️  BLAKE2b hash missing from contentHashFull (falling back to SHA-256 + MD5)');
    }
    
    // Validate pre-existing parts if provided
    if (parts && parts.length !== totalParts) {
        throw new Error(`Parts array length (${parts.length}) doesn't match total parts (${totalParts})`);
    }
    
    const manifest = {
        // Series identification
        series_id: seriesId || generateUUID(),
        version: '1.0',
        
        // Content metadata
        source_url: sourceUrl,
        title: title,
        created_at: new Date().toISOString(),
        
        // Part structure
        total_parts: totalParts,
        
        // Threaded replies architecture (Task 3)
        architecture: 'threaded_replies', // Part 1 = root post, Parts 2+ = threaded comment replies
        root_permlink: null, // Part 1's permlink (populated after Part 1 posts). Used by Link Explorer to reconstruct full article.
        
        // Cryptographic verification (Phase 3: Dual Hash System)
        content_hash_full: contentHashFull, // Full content hash {sha256, blake2b, md5}
        hash_algorithm: 'SHA-256, BLAKE2b, MD5',
        part_hashes: partHashes, // Each entry: {part_number, sha256, blake2b, md5}
        
        // Discovery & tagging
        tags: tags,
        
        // Part linkage (permlinks added after posting)
        // Use pre-existing parts if provided, otherwise create fresh entries
        parts: parts || Array.from({ length: totalParts }, (_, i) => ({
            part_number: i + 1,
            permlink: null, // Filled in after posting to Hive
            author: author, // Use provided author or null
            status: 'pending' // pending, posted, failed
        })),
        
        // Splitting metadata
        boundary_algorithm: 'paragraph-aware-v1',
        chunk_size_target: SAFE_CHUNK_SIZE_BYTES,
        metadata_overhead_reserved: METADATA_OVERHEAD_BYTES
    };
    
    return manifest;
}

/**
 * Update manifest with post information after successful Hive posting
 * 
 * @param {Object} manifest - Original manifest
 * @param {number} partNumber - Part number (1-indexed)
 * @param {Object} postInfo - Post information from Hive
 * @param {string} postInfo.permlink - Hive permlink
 * @param {string} postInfo.author - Hive author
 * @returns {Object} - Updated manifest
 */
function updateManifestWithPost(manifest, partNumber, postInfo) {
    const partIndex = partNumber - 1;
    
    if (partIndex < 0 || partIndex >= manifest.total_parts) {
        throw new Error(`Invalid part number: ${partNumber}`);
    }
    
    // Update the specific part
    manifest.parts[partIndex] = {
        part_number: partNumber,
        permlink: postInfo.permlink,
        author: postInfo.author,
        status: 'posted',
        posted_at: new Date().toISOString()
    };
    
    return manifest;
}

/**
 * Generate compact manifest for embedding in Hive post body
 * Strips out verbose fields to save space
 * 
 * @param {Object} manifest - Full manifest
 * @param {number} currentPartNumber - Current part number (for part-specific info)
 * @returns {string} - Compact JSON manifest
 */
function compactManifestForPost(manifest, currentPartNumber) {
    const compact = {
        s: manifest.series_id, // series_id
        v: manifest.version,
        t: manifest.total_parts,
        p: currentPartNumber, // current part
        h: manifest.content_hash_full, // full content hash
        u: manifest.source_url
    };
    
    const manifestJson = JSON.stringify(compact);
    
    // BUG FIX: Prevent DoS via oversized manifests (16KB limit)
    const MANIFEST_SIZE_LIMIT = 16 * 1024; // 16KB maximum
    if (manifestJson.length > MANIFEST_SIZE_LIMIT) {
        throw new Error(`Manifest too large: ${manifestJson.length} bytes (limit: ${MANIFEST_SIZE_LIMIT})`);
    }
    
    return manifestJson;
}

/**
 * Parse compact manifest from Hive post
 * Reconstructs full manifest structure from compact format
 * 
 * @param {string} compactJson - Compact manifest JSON
 * @returns {Object} - Partial manifest object
 */
function parseCompactManifest(compactJson) {
    try {
        // BUG FIX: Prevent DoS via oversized manifest inputs (16KB limit)
        const MANIFEST_SIZE_LIMIT = 16 * 1024; // 16KB maximum
        if (compactJson && compactJson.length > MANIFEST_SIZE_LIMIT) {
            throw new Error(`Manifest input too large: ${compactJson.length} bytes (limit: ${MANIFEST_SIZE_LIMIT})`);
        }
        
        const compact = JSON.parse(compactJson);
        
        return {
            series_id: compact.s,
            version: compact.v,
            total_parts: compact.t,
            current_part: compact.p,
            content_hash_full: compact.h,
            source_url: compact.u
        };
    } catch (error) {
        throw new Error(`Failed to parse compact manifest: ${error.message}`);
    }
}

/**
 * Extract manifest from Hive post metadata
 * Looks for manifest in json_metadata.arcMultiPart
 * 
 * @param {Object} post - Hive post object
 * @returns {Object|null} - Manifest object or null if not found
 */
function extractManifestFromPost(post) {
    try {
        // Parse json_metadata if it's a string
        let metadata = post.json_metadata;
        if (typeof metadata === 'string') {
            metadata = JSON.parse(metadata);
        }
        
        // Check for full manifest in metadata
        if (metadata && metadata.arcMultiPart) {
            return metadata.arcMultiPart;
        }
        
        // Check for compact manifest in post body
        const bodyMatch = post.body?.match(/<!--ARCHIVE-MANIFEST:(.*?)-->/);
        if (bodyMatch) {
            return parseCompactManifest(bodyMatch[1]);
        }
        
        return null;
    } catch (error) {
        mpDebugWarn('⚠️  Failed to extract manifest:', error);
        return null;
    }
}

/**
 * Validate manifest structure and data
 * 
 * @param {Object} manifest - Manifest to validate
 * @returns {boolean} - True if valid
 * @throws {Error} - If validation fails
 */
function validateManifest(manifest) {
    // Required fields
    const required = ['series_id', 'version', 'total_parts', 'content_hash_full', 'source_url', 'part_hashes'];
    for (const field of required) {
        if (!manifest[field]) {
            throw new Error(`Manifest missing required field: ${field}`);
        }
    }
    
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(manifest.series_id)) {
        throw new Error(`Invalid series_id format: ${manifest.series_id}`);
    }
    
    // Validate total_parts
    if (manifest.total_parts < 1 || manifest.total_parts > 100) {
        throw new Error(`Invalid total_parts: ${manifest.total_parts} (must be 1-100)`);
    }
    
    // CRITICAL: Parts array must always exist
    if (!manifest.parts || !Array.isArray(manifest.parts)) {
        throw new Error('Manifest must have a parts array');
    }
    
    if (manifest.parts.length !== manifest.total_parts) {
        throw new Error(`Parts array length mismatch: expected ${manifest.total_parts}, got ${manifest.parts.length}`);
    }
    
    // CRITICAL: Validate content_hash_full (backward-compatible)
    // Accept both legacy format (string SHA-256) and new format (object with 3 algorithms)
    if (typeof manifest.content_hash_full === 'string') {
        // Legacy Phase 2 format - single SHA-256 hash
        if (manifest.content_hash_full.length === 0) {
            throw new Error('content_hash_full cannot be empty');
        }
    } else if (typeof manifest.content_hash_full === 'object') {
        // Phase 3 format - multi-algorithm object
        if (!manifest.content_hash_full.sha256) {
            throw new Error('content_hash_full object must contain sha256');
        }
        // blake2b and md5 are optional for backward compatibility
    } else {
        throw new Error('content_hash_full must be a string (legacy) or object (Phase 3)');
    }
    
    // CRITICAL: Validate part_hashes array (now mandatory)
    if (!Array.isArray(manifest.part_hashes)) {
        throw new Error('Part hashes must be an array');
    }
    
    if (manifest.part_hashes.length !== manifest.total_parts) {
        throw new Error(`Part hashes count mismatch: expected ${manifest.total_parts}, got ${manifest.part_hashes.length}`);
    }
    
    // Validate each hash entry (backward-compatible)
    // Accept both legacy format (sha256 only) and new format (all 3 algorithms)
    manifest.part_hashes.forEach((hashEntry, index) => {
        if (typeof hashEntry !== 'object') {
            throw new Error(`Part hash ${index + 1} must be an object`);
        }
        
        // Required fields for all formats
        if (!hashEntry.part_number || !hashEntry.sha256) {
            throw new Error(`Part hash ${index + 1} missing required fields (part_number, sha256)`);
        }
        
        if (hashEntry.part_number !== index + 1) {
            throw new Error(`Part hash ${index + 1} has incorrect part_number: ${hashEntry.part_number}`);
        }
        
        // blake2b and md5 are optional for backward compatibility with Phase 2
        // New Phase 3 manifests should include all three, but we don't enforce it
    });
    
    // Validate each part entry (parts array is already validated to exist above)
    manifest.parts.forEach((part, index) => {
        if (typeof part !== 'object') {
            throw new Error(`Part ${index + 1} must be an object`);
        }
        
        // Validate required fields
        if (!part.part_number) {
            throw new Error(`Part ${index + 1} missing part_number`);
        }
        if (part.part_number !== index + 1) {
            throw new Error(`Part ${index + 1} has incorrect part_number: ${part.part_number}`);
        }
        
        // CRITICAL: Status field is mandatory for lifecycle tracking
        if (!part.status) {
            throw new Error(`Part ${index + 1} missing required status field`);
        }
        
        // Validate status field value
        const validStatuses = ['pending', 'posted', 'failed'];
        if (!validStatuses.includes(part.status)) {
            throw new Error(`Part ${index + 1} has invalid status: ${part.status} (must be one of: ${validStatuses.join(', ')})`);
        }
        
        // Validate posted parts have required metadata
        if (part.status === 'posted') {
            if (!part.permlink) {
                throw new Error(`Part ${index + 1} marked as posted but missing permlink`);
            }
            if (!part.author) {
                throw new Error(`Part ${index + 1} marked as posted but missing author`);
            }
        }
    });
    
    // Task 3: Validate threaded replies architecture fields (backwards-compatible)
    // Old manifests (pre-threading) won't have these fields - validation is optional
    if (manifest.architecture !== undefined) {
        // If architecture field exists, validate it
        if (manifest.architecture !== 'threaded_replies') {
            throw new Error(`Invalid architecture: ${manifest.architecture} (must be 'threaded_replies')`);
        }
    }
    
    if (manifest.root_permlink !== undefined) {
        // If root_permlink field exists, validate it's either null or a string
        if (manifest.root_permlink !== null && typeof manifest.root_permlink !== 'string') {
            throw new Error(`Invalid root_permlink: must be null or string (got ${typeof manifest.root_permlink})`);
        }
    }
    
    return true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BLOCKCHAIN VERIFICATION (Phase 9)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Verify completed parts on blockchain before resuming
 * Checks if parts exist on chain and validates content hashes
 * 
 * @param {Object} manifest - Series manifest with parts
 * @param {Array<Object>} partHashes - Expected hashes from manifest
 * @param {Function} progressCallback - Optional progress callback
 * @returns {Promise<Object>} - Verification results
 */
async function verifyCompletedParts(manifest, partHashes, progressCallback = null) {
    mpDebugLog(`🔍 Verifying ${manifest.parts.length} parts on blockchain...`);
    
    const results = {
        verified: [],
        failed: [],
        missing: [],
        totalChecked: 0
    };
    
    for (let i = 0; i < manifest.parts.length; i++) {
        const part = manifest.parts[i];
        const partNumber = part.part_number;
        
        // Skip parts that are not marked as posted
        if (part.status !== 'posted') {
            results.missing.push(partNumber);
            mpDebugLog(`  ⏭️  Part ${partNumber}: Not posted yet - will skip`);
            continue;
        }
        
        results.totalChecked++;
        
        // Call progress callback
        if (progressCallback) {
            progressCallback({
                partNumber,
                totalParts: manifest.parts.length,
                status: 'checking',
                message: `Checking part ${partNumber} on blockchain...`
            });
        }
        
        try {
            // Fetch post from blockchain
            mpDebugLog(`  📡 Fetching part ${partNumber}: @${part.author}/${part.permlink}`);
            
            const post = await window.getHiveContent(part.author, part.permlink);
            
            if (!post || !post.body) {
                // Post not found on blockchain
                results.failed.push(partNumber);
                console.warn(`  ❌ Part ${partNumber}: Not found on blockchain - will retry`);
                
                if (progressCallback) {
                    progressCallback({
                        partNumber,
                        status: 'failed',
                        reason: 'not_found',
                        message: `Part ${partNumber}: Not found on blockchain`
                    });
                }
                continue;
            }
            
            // Verify content hash (if available)
            if (partHashes && partHashes[i]) {
                const expectedHash = partHashes[i];
                const actualHash = await hashString(post.body);
                
                // Check SHA-256 match
                if (actualHash.sha256 !== expectedHash.sha256) {
                    results.failed.push(partNumber);
                    console.warn(`  ⚠️  Part ${partNumber}: Hash mismatch - will retry`);
                    console.warn(`     Expected: ${expectedHash.sha256.substring(0, 16)}...`);
                    console.warn(`     Actual:   ${actualHash.sha256.substring(0, 16)}...`);
                    
                    if (progressCallback) {
                        progressCallback({
                            partNumber,
                            status: 'failed',
                            reason: 'hash_mismatch',
                            message: `Part ${partNumber}: Content modified - will retry`
                        });
                    }
                    continue;
                }
            }
            
            // Part verified successfully!
            results.verified.push(partNumber);
            mpDebugLog(`  ✅ Part ${partNumber}: Verified on blockchain`);
            
            if (progressCallback) {
                progressCallback({
                    partNumber,
                    status: 'verified',
                    message: `Part ${partNumber}: Verified on blockchain`
                });
            }
            
        } catch (error) {
            console.error(`  💥 Part ${partNumber}: Verification error:`, error);
            results.failed.push(partNumber);
            
            if (progressCallback) {
                progressCallback({
                    partNumber,
                    status: 'error',
                    reason: error.message,
                    message: `Part ${partNumber}: Verification failed`
                });
            }
        }
    }
    
    mpDebugLog(`🔍 Verification complete:`);
    mpDebugLog(`   ✅ Verified: ${results.verified.length} parts`);
    mpDebugLog(`   ❌ Failed: ${results.failed.length} parts`);
    mpDebugLog(`   ⏳ Missing: ${results.missing.length} parts`);
    
    return results;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHASE 4: MULTI-PART POSTING PIPELINE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Retry configuration for exponential backoff
 */
const RETRY_CONFIG = {
    maxAttempts: 3,
    backoffDelays: [1000, 3000, 9000], // 1s, 3s, 9s
};

/**
 * Error classification for retry logic
 */
const ERROR_TYPES = {
    TRANSIENT: 'transient', // Retry allowed (network, timeout, rate limit)
    PERMANENT: 'permanent', // No retry (auth, validation, user error)
    CANCELLED: 'cancelled'  // User cancelled
};

/**
 * Progress phases for pipeline lifecycle
 */
const PIPELINE_PHASES = {
    PREPARING: 'preparing',
    POSTING: 'posting',
    RETRYING: 'retrying',
    SUCCESS: 'success',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
};

/**
 * Part status codes
 */
const PART_STATUS = {
    PENDING: 'pending',
    IN_PROGRESS: 'in_progress',
    POSTED: 'posted',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
};

/**
 * Classify error type for retry decision
 * 
 * @param {Error} error - Error object
 * @returns {string} - ERROR_TYPES constant
 */
function classifyError(error) {
    const errorMessage = error.message?.toLowerCase() || '';
    const errorString = error.toString().toLowerCase();
    
    // Auth failures - don't retry
    if (errorMessage.includes('auth') || 
        errorMessage.includes('permission') ||
        errorMessage.includes('unauthorized') ||
        errorMessage.includes('invalid key') ||
        errorMessage.includes('posting key')) {
        return ERROR_TYPES.PERMANENT;
    }
    
    // Validation errors - don't retry
    if (errorMessage.includes('validation') ||
        errorMessage.includes('invalid') ||
        errorMessage.includes('missing required') ||
        errorString.includes('assert')) {
        return ERROR_TYPES.PERMANENT;
    }
    
    // User cancellation
    if (errorMessage.includes('cancel') ||
        errorMessage.includes('abort')) {
        return ERROR_TYPES.CANCELLED;
    }
    
    // Network/transient errors - retry allowed
    if (errorMessage.includes('network') ||
        errorMessage.includes('timeout') ||
        errorMessage.includes('fetch') ||
        errorMessage.includes('connection') ||
        errorMessage.includes('rate limit') ||
        errorString.includes('networkerror')) {
        return ERROR_TYPES.TRANSIENT;
    }
    
    // Default to transient for unknown errors (safer to retry)
    return ERROR_TYPES.TRANSIENT;
}

/**
 * Sleep/delay utility
 * 
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise} - Resolves after delay
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Multi-Part Posting Pipeline
 * Manages sequential posting of multi-part content to Hive blockchain
 * 
 * Features:
 * - Sequential part posting (1, 2, 3...)
 * - Progress tracking with callbacks
 * - Retry logic with exponential backoff
 * - State persistence to localStorage
 * - Pause/resume/cancel support
 * - Error classification (transient vs permanent)
 * 
 * @example
 * const pipeline = new HivePostingPipeline({
 *   manifest: seriesManifest,
 *   contentParts: ['Part 1 content...', 'Part 2 content...'],
 *   progressCallback: (progress) => console.log(progress),
 *   transportFunction: postToHiveKeychain,
 *   author: 'myusername'
 * });
 * 
 * await pipeline.start();
 */
class HivePostingPipeline {
    /**
     * Create a new posting pipeline
     * 
     * @param {Object} config - Configuration object
     * @param {Object} config.manifest - Series manifest
     * @param {Array<string>} config.contentParts - Array of content strings (in order)
     * @param {Function} config.progressCallback - Progress callback function
     * @param {Function} config.transportFunction - Hive posting function
     * @param {string} config.author - Author username
     */
    constructor(config) {
        const {
            manifest,
            contentParts,
            progressCallback = null,
            transportFunction,
            author
        } = config;
        
        // Validate required fields
        if (!manifest) throw new Error('manifest is required');
        if (!contentParts || !Array.isArray(contentParts)) {
            throw new Error('contentParts must be an array');
        }
        if (contentParts.length !== manifest.total_parts) {
            throw new Error(`Content parts count (${contentParts.length}) doesn't match manifest total_parts (${manifest.total_parts})`);
        }
        if (typeof transportFunction !== 'function') {
            throw new Error('transportFunction must be a function');
        }
        if (!author) throw new Error('author is required');
        
        // Validate manifest
        validateManifest(manifest);
        
        // Core configuration
        this.manifest = manifest;
        this.contentParts = contentParts;
        this.progressCallback = progressCallback || (() => {});
        this.transportFunction = transportFunction;
        this.author = author;
        
        // State tracking
        this.currentPart = 1;
        this.attempts = {}; // Track attempts per part: {1: 2, 2: 1, ...}
        this.cancelled = false;
        this.paused = false;
        this.errors = []; // Error log: [{partNumber, attempt, error, timestamp}, ...]
        this.rootPermlink = null; // Permlink of Part 1 (for threaded replies)
        
        // Retry configuration
        this.maxAttempts = RETRY_CONFIG.maxAttempts;
        this.backoffDelays = RETRY_CONFIG.backoffDelays;
        
        mpDebugLog(`📦 HivePostingPipeline initialized`);
        mpDebugLog(`   Series ID: ${manifest.series_id}`);
        mpDebugLog(`   Total parts: ${manifest.total_parts}`);
        mpDebugLog(`   Author: ${author}`);
        
        // PHASE 9 ENHANCED: Save content parts to IndexedDB for resume capability
        this._saveContentToIndexedDB().catch(err => {
            mpDebugWarn('⚠️  Failed to save content to IndexedDB:', err);
            mpDebugWarn('   Resume will require re-extraction');
        });
    }
    
    /**
     * Save content parts to IndexedDB for resume capability
     * Runs asynchronously - doesn't block pipeline initialization
     * 
     * @private
     */
    async _saveContentToIndexedDB() {
        if (!window.ArcHiveStorage) {
            return; // IndexedDB not available
        }
        
        try {
            // Extract metadata from manifest
            const metadata = {
                title: this.manifest.title || 'Untitled',
                url: this.manifest.source_url || '',
                author: this.author
            };
            
            await window.ArcHiveStorage.saveContentParts(
                this.manifest.series_id,
                this.contentParts,
                metadata
            );
            mpDebugLog(`💾 Content parts saved to IndexedDB (${this.contentParts.length} parts)`);
        } catch (error) {
            // Non-critical error - pipeline can continue without IndexedDB
            throw error;
        }
    }
    
    /**
     * Start or resume posting pipeline
     * Posts parts sequentially from currentPart to end
     * 
     * @returns {Promise<Object>} - Result object with success status and manifest
     */
    async start() {
        mpDebugLog(`🚀 Starting posting pipeline from part ${this.currentPart}/${this.manifest.total_parts}`);
        
        // Reset flags
        this.cancelled = false;
        this.paused = false;
        
        // Fire preparing phase callback
        this._fireProgressCallback({
            phase: PIPELINE_PHASES.PREPARING,
            partNumber: this.currentPart,
            totalParts: this.manifest.total_parts,
            attempt: 0,
            status: PART_STATUS.PENDING,
            message: `Preparing to post part ${this.currentPart}/${this.manifest.total_parts}`,
            manifestSnapshot: this._getManifestSnapshot()
        });
        
        try {
            // Post each part sequentially
            while (this.currentPart <= this.manifest.total_parts) {
                // Check for cancellation
                if (this.cancelled) {
                    mpDebugLog(`🛑 Pipeline cancelled at part ${this.currentPart}`);
                    this._fireProgressCallback({
                        phase: PIPELINE_PHASES.CANCELLED,
                        partNumber: this.currentPart,
                        totalParts: this.manifest.total_parts,
                        attempt: this.attempts[this.currentPart] || 0,
                        status: PART_STATUS.CANCELLED,
                        message: 'Posting cancelled by user',
                        manifestSnapshot: this._getManifestSnapshot()
                    });
                    this._saveState();
                    return {
                        success: false,
                        reason: 'cancelled',
                        manifest: this.manifest,
                        lastCompletedPart: this.currentPart - 1
                    };
                }
                
                // Check for pause
                while (this.paused && !this.cancelled) {
                    await sleep(500); // Check every 500ms
                }
                
                // Post this part (with retry logic)
                const result = await this._postPartWithRetry(this.currentPart);
                
                if (!result.success) {
                    // Part failed after all retries
                    console.error(`❌ Part ${this.currentPart} failed permanently`);
                    this._fireProgressCallback({
                        phase: PIPELINE_PHASES.FAILED,
                        partNumber: this.currentPart,
                        totalParts: this.manifest.total_parts,
                        attempt: this.attempts[this.currentPart] || 0,
                        status: PART_STATUS.FAILED,
                        message: `Part ${this.currentPart} failed: ${result.error}`,
                        error: result.error,
                        manifestSnapshot: this._getManifestSnapshot()
                    });
                    this._saveState();
                    return {
                        success: false,
                        reason: 'part_failed',
                        failedPart: this.currentPart,
                        error: result.error,
                        manifest: this.manifest
                    };
                }
                
                // Part posted successfully - move to next
                mpDebugLog(`✅ Part ${this.currentPart}/${this.manifest.total_parts} posted successfully`);
                
                // THREADED REPLIES: Add 20-second cooldown before posting next part
                // Part 1 → Part 2 requires cooldown (Part 1 was root, Part 2 will be comment)
                // Part N → Part N+1 requires cooldown (both are comments, 20s between comments)
                const isLastPart = this.currentPart === this.manifest.total_parts;
                if (!isLastPart) {
                    const nextPartNumber = this.currentPart + 1;
                    const cooldownSeconds = 20;
                    
                    mpDebugLog(`⏱️  Hive comment cooldown: Waiting ${cooldownSeconds} seconds before posting part ${nextPartNumber}...`);
                    
                    // Countdown with progress updates every 1 second for smooth progress bar
                    for (let remainingSeconds = cooldownSeconds; remainingSeconds > 0; remainingSeconds--) {
                        // Fire progress callback with countdown
                        this._fireProgressCallback({
                            phase: 'cooldown', // New phase for cooldown
                            partNumber: this.currentPart,
                            totalParts: this.manifest.total_parts,
                            attempt: 0,
                            status: 'cooldown',
                            message: `Waiting ${remainingSeconds} seconds before posting part ${nextPartNumber}...`,
                            cooldownRemaining: remainingSeconds,
                            cooldownTotal: cooldownSeconds,
                            manifestSnapshot: this._getManifestSnapshot()
                        });
                        
                        // Sleep for 1 second
                        await sleep(1000);
                        
                        // Check for cancellation during cooldown
                        if (this.cancelled) {
                            mpDebugLog(`🛑 Cancelled during cooldown`);
                            break;
                        }
                    }
                    
                    mpDebugLog(`✅ Cooldown complete - ready to post part ${nextPartNumber}`);
                }
                
                // Check if cancelled during cooldown
                if (this.cancelled) {
                    mpDebugLog(`🛑 Pipeline cancelled during cooldown before part ${this.currentPart + 1}`);
                    this._fireProgressCallback({
                        phase: PIPELINE_PHASES.CANCELLED,
                        partNumber: this.currentPart,
                        totalParts: this.manifest.total_parts,
                        attempt: this.attempts[this.currentPart] || 0,
                        status: PART_STATUS.CANCELLED,
                        message: 'Posting cancelled by user during cooldown',
                        manifestSnapshot: this._getManifestSnapshot()
                    });
                    this._saveState(); // Save current state (part NOT incremented)
                    return {
                        success: false,
                        reason: 'cancelled',
                        manifest: this.manifest,
                        lastCompletedPart: this.currentPart
                    };
                }
                
                this.currentPart++;
                this._saveState();
            }
            
            // All parts posted successfully!
            mpDebugLog(`🎉 All ${this.manifest.total_parts} parts posted successfully!`);
            this._fireProgressCallback({
                phase: PIPELINE_PHASES.SUCCESS,
                partNumber: this.manifest.total_parts,
                totalParts: this.manifest.total_parts,
                attempt: 0,
                status: PART_STATUS.POSTED,
                message: `All ${this.manifest.total_parts} parts posted successfully`,
                manifestSnapshot: this._getManifestSnapshot()
            });
            
            // Clear saved state (completed)
            this._clearState();
            
            return {
                success: true,
                manifest: this.manifest,
                totalParts: this.manifest.total_parts
            };
            
        } catch (error) {
            console.error(`💥 Pipeline error:`, error);
            this._fireProgressCallback({
                phase: PIPELINE_PHASES.FAILED,
                partNumber: this.currentPart,
                totalParts: this.manifest.total_parts,
                attempt: 0,
                status: PART_STATUS.FAILED,
                message: `Pipeline error: ${error.message}`,
                error: error.message,
                manifestSnapshot: this._getManifestSnapshot()
            });
            this._saveState();
            throw error;
        }
    }
    
    /**
     * Pause the posting pipeline
     * Can be resumed with resume()
     */
    pause() {
        if (!this.paused) {
            this.paused = true;
            mpDebugLog(`⏸️  Pipeline paused at part ${this.currentPart}`);
            this._saveState();
        }
    }
    
    /**
     * Resume the posting pipeline
     * Continues from where it was paused
     */
    resume() {
        if (this.paused) {
            this.paused = false;
            mpDebugLog(`▶️  Pipeline resumed at part ${this.currentPart}`);
            this._saveState();
        }
    }
    
    /**
     * Cancel the posting pipeline
     * Stops gracefully and preserves state
     */
    cancel() {
        if (!this.cancelled) {
            this.cancelled = true;
            mpDebugLog(`🛑 Pipeline cancel requested`);
            this._saveState();
        }
    }
    
    /**
     * Get current pipeline state
     * 
     * @returns {Object} - State object
     */
    getState() {
        return {
            seriesId: this.manifest.series_id,
            currentPart: this.currentPart,
            totalParts: this.manifest.total_parts,
            attempts: { ...this.attempts },
            cancelled: this.cancelled,
            paused: this.paused,
            errors: [...this.errors],
            postedParts: this.manifest.parts.filter(p => p.status === 'posted').length,
            pendingParts: this.manifest.parts.filter(p => p.status === 'pending').length,
            failedParts: this.manifest.parts.filter(p => p.status === 'failed').length
        };
    }
    
    /**
     * Post a single part with retry logic
     * Implements exponential backoff for transient errors
     * 
     * @param {number} partNumber - Part number (1-indexed)
     * @returns {Promise<Object>} - {success: boolean, error?: string, postInfo?: Object}
     * @private
     */
    async _postPartWithRetry(partNumber) {
        const partIndex = partNumber - 1;
        const part = this.contentParts[partIndex];
        const content = part.content; // Extract content string from part object
        
        // Initialize attempt counter
        if (!this.attempts[partNumber]) {
            this.attempts[partNumber] = 0;
        }
        
        // Try up to maxAttempts times
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            // Check for cancellation before each attempt
            if (this.cancelled) {
                return {
                    success: false,
                    error: 'Cancelled by user'
                };
            }
            
            this.attempts[partNumber] = attempt;
            
            // Fire progress callback for this attempt
            const isRetry = attempt > 1;
            this._fireProgressCallback({
                phase: isRetry ? PIPELINE_PHASES.RETRYING : PIPELINE_PHASES.POSTING,
                partNumber: partNumber,
                totalParts: this.manifest.total_parts,
                attempt: attempt,
                status: PART_STATUS.IN_PROGRESS,
                message: isRetry 
                    ? `Retrying part ${partNumber} (attempt ${attempt}/${this.maxAttempts})`
                    : `Posting part ${partNumber}/${this.manifest.total_parts}`,
                manifestSnapshot: this._getManifestSnapshot()
            });
            
            mpDebugLog(`📤 Posting part ${partNumber}/${this.manifest.total_parts} (attempt ${attempt}/${this.maxAttempts})`);
            
            try {
                // Generate post payload
                const postPayload = this._generatePostPayload(partNumber, content);
                
                // Call transport function (Keychain or HAS)
                const postResult = await this.transportFunction(postPayload);
                
                // Validate post result
                if (!postResult || !postResult.permlink) {
                    throw new Error('Transport function returned invalid result (missing permlink)');
                }
                
                // Update manifest with post info
                const postInfo = {
                    permlink: postResult.permlink,
                    author: this.author
                };
                updateManifestWithPost(this.manifest, partNumber, postInfo);
                
                // THREADED REPLIES: Store Part 1 permlink for comment threading
                if (partNumber === 1) {
                    this.rootPermlink = postResult.permlink;
                    this.manifest.root_permlink = postResult.permlink; // Task 3: Update manifest with root permlink
                    mpDebugLog(`  🔗 Stored root permlink for threading: ${this.rootPermlink}`);
                    mpDebugLog(`  📝 Updated manifest.root_permlink: ${this.manifest.root_permlink}`);
                }
                
                // BUG FIX 1: Ensure ALL prior parts (1 to currentPart) are marked as 'posted'
                // This is critical for resume functionality - pipeline must know which parts are done
                for (let i = 1; i <= partNumber; i++) {
                    const partIndex = i - 1;
                    if (this.manifest.parts[partIndex].status !== 'posted') {
                        this.manifest.parts[partIndex].status = 'posted';
                        mpDebugLog(`  📝 Marked part ${i} as 'posted' (status correction)`);
                    }
                }
                
                // BUG FIX 2: Clear retry counter for successfully posted part
                // Prevents stale retry counters on resume
                if (this.attempts[partNumber]) {
                    delete this.attempts[partNumber];
                    mpDebugLog(`  🧹 Cleared retry counter for part ${partNumber}`);
                }
                
                // Success! Fire progress callback
                this._fireProgressCallback({
                    phase: PIPELINE_PHASES.POSTING,
                    partNumber: partNumber,
                    totalParts: this.manifest.total_parts,
                    attempt: attempt,
                    status: PART_STATUS.POSTED,
                    message: `Part ${partNumber} posted successfully`,
                    postInfo: postInfo,
                    manifestSnapshot: this._getManifestSnapshot()
                });
                
                mpDebugLog(`✅ Part ${partNumber} posted: @${postInfo.author}/${postInfo.permlink}`);
                
                return {
                    success: true,
                    postInfo: postInfo
                };
                
            } catch (error) {
                console.error(`❌ Part ${partNumber} attempt ${attempt} failed:`, error);
                
                // Log error
                this.errors.push({
                    partNumber: partNumber,
                    attempt: attempt,
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
                
                // Classify error
                const errorType = classifyError(error);
                
                // Permanent errors - don't retry
                if (errorType === ERROR_TYPES.PERMANENT) {
                    console.error(`🚫 Permanent error detected - not retrying`);
                    return {
                        success: false,
                        error: error.message
                    };
                }
                
                // Cancelled - don't retry
                if (errorType === ERROR_TYPES.CANCELLED || this.cancelled) {
                    return {
                        success: false,
                        error: 'Cancelled by user'
                    };
                }
                
                // Transient error - retry if attempts remain
                if (attempt < this.maxAttempts) {
                    const delay = this.backoffDelays[attempt - 1] || this.backoffDelays[this.backoffDelays.length - 1];
                    mpDebugLog(`⏳ Waiting ${delay}ms before retry...`);
                    await sleep(delay);
                } else {
                    // Exhausted all retries - Phase 9: Pause instead of failing
                    console.error(`❌ Part ${partNumber} failed after ${this.maxAttempts} attempts`);
                    mpDebugLog(`⏸️  Pausing pipeline - can be resumed later`);
                    
                    // Mark as paused (preserves state for resume)
                    this.markAsPaused();
                    
                    // Fire paused callback
                    this._fireProgressCallback({
                        phase: 'paused', // Phase 9: New phase
                        partNumber: partNumber,
                        totalParts: this.manifest.total_parts,
                        attempt: attempt,
                        status: 'paused',
                        message: `Posting paused after ${this.maxAttempts} failed attempts on part ${partNumber}. You can resume later.`,
                        error: error.message,
                        manifestSnapshot: this._getManifestSnapshot(),
                        canResume: true // Phase 9: Signal that resume is available
                    });
                    
                    return {
                        success: false,
                        error: error.message,
                        paused: true // Phase 9: Signal that posting was paused (not failed)
                    };
                }
            }
        }
        
        // Should never reach here, but just in case
        return {
            success: false,
            error: 'Max retries exhausted'
        };
    }
    
    /**
     * Generate Hive post payload for a part
     * 
     * @param {number} partNumber - Part number (1-indexed)
     * @param {string} content - Part content
     * @returns {Object} - Post payload for transport function
     * @private
     */
    _generatePostPayload(partNumber, content) {
        const baseTitle = this.manifest.title || 'Untitled';
        const isRootPost = partNumber === 1;
        
        // FIX: Comments (Parts 2+) should have empty title per Hive standards
        // Root post (Part 1) gets the full title
        const title = isRootPost 
            ? `${baseTitle} [Part ${partNumber}/${this.manifest.total_parts}]`
            : ''; // Empty title for comment replies
        
        // Generate compact manifest for embedding
        const compactManifest = compactManifestForPost(this.manifest, partNumber);
        
        // Embed manifest in post body as HTML comment
        const bodyWithManifest = `${content}\n\n<!--ARCHIVE-MANIFEST:${compactManifest}-->`;
        
        // FIX: Minimize json_metadata for Parts 2+ to avoid size limits
        // Part 1 gets full manifest, Parts 2+ get minimal reference data
        let jsonMetadata;
        
        if (isRootPost) {
            // Part 1: Include full manifest (this is the primary lookup point)
            const manifestSnapshot = JSON.parse(JSON.stringify(this.manifest));
            jsonMetadata = {
                tags: this.manifest.tags || [],
                app: 'archive/1.0',
                arcMultiPart: {
                    ...manifestSnapshot,
                    current_part: partNumber,
                    part_number: partNumber
                }
            };
        } else {
            // Parts 2+: Minimal metadata to avoid size limits
            // Full manifest is in Part 1 and body HTML comment
            jsonMetadata = {
                tags: this.manifest.tags || [],
                app: 'archive/1.0',
                arcMultiPart: {
                    series_id: this.manifest.series_id,
                    current_part: partNumber,
                    part_number: partNumber,
                    total_parts: this.manifest.total_parts,
                    root_author: this.author,
                    root_permlink: this.rootPermlink,
                    title: baseTitle // Include title for context
                }
            };
            mpDebugLog(`  📦 Using minimal metadata for Part ${partNumber} (${JSON.stringify(jsonMetadata).length} bytes)`);
        }
        
        // THREADED REPLIES: Determine parent parameters based on part number
        let parentAuthor, parentPermlink;
        
        if (isRootPost) {
            // Part 1: Root post (parent_author='', parent_permlink=firstTag)
            parentAuthor = '';
            parentPermlink = this.manifest.tags?.[0] || 'archive';
            mpDebugLog(`  📝 Part 1: Posting as ROOT (parent_permlink: ${parentPermlink})`);
        } else {
            // Part 2+: Threaded reply (parent_author=username, parent_permlink=rootPermlink)
            parentAuthor = this.author;
            parentPermlink = this.rootPermlink;
            mpDebugLog(`  💬 Part ${partNumber}: Posting as REPLY to @${parentAuthor}/${parentPermlink}`);
            
            // Validation: rootPermlink must be set for parts 2+
            if (!this.rootPermlink) {
                throw new Error(`Part ${partNumber} requires rootPermlink from Part 1, but it is not set. Cannot post as threaded reply.`);
            }
        }
        
        // Build post payload
        return {
            parent_author: parentAuthor,
            author: this.author,
            title: title,
            body: bodyWithManifest,
            json_metadata: jsonMetadata,
            permlink: `${this.manifest.series_id.substring(0, 8)}-part-${partNumber}`,
            parent_permlink: parentPermlink
        };
    }
    
    /**
     * Fire progress callback with error handling
     * 
     * @param {Object} progress - Progress object
     * @private
     */
    _fireProgressCallback(progress) {
        try {
            this.progressCallback(progress);
        } catch (error) {
            mpDebugWarn('⚠️  Progress callback error:', error);
        }
    }
    
    /**
     * Get manifest snapshot for progress callbacks
     * Returns a safe copy to prevent external mutations
     * 
     * @returns {Object} - Manifest snapshot
     * @private
     */
    _getManifestSnapshot() {
        return {
            series_id: this.manifest.series_id,
            total_parts: this.manifest.total_parts,
            parts: this.manifest.parts.map(p => ({
                part_number: p.part_number,
                status: p.status,
                permlink: p.permlink,
                author: p.author
            }))
        };
    }
    
    /**
     * Save pipeline state to localStorage AND IndexedDB
     * Allows resume after browser refresh or crash
     * 
     * @private
     */
    async _saveState() {
        try {
            const stateKey = `archive_multipart_pipeline_${this.manifest.series_id}`;
            const state = {
                stateVersion: STATE_VERSION, // Phase 9: State versioning for future migrations
                manifest: this.manifest,
                currentPart: this.currentPart,
                attempts: this.attempts,
                cancelled: this.cancelled,
                paused: this.paused,
                errors: this.errors,
                rootPermlink: this.rootPermlink, // THREADED REPLIES: Persist for resume capability
                savedAt: new Date().toISOString(),
                status: this._getStatus() // Phase 9: Track pipeline status
            };
            
            // Save to localStorage (backward compatibility)
            localStorage.setItem(stateKey, JSON.stringify(state));
            mpDebugLog(`💾 State saved to localStorage: ${stateKey}`);
            
            // Save to IndexedDB (enhanced with content reference)
            if (window.ArcHiveStorage) {
                await window.ArcHiveStorage.savePipelineState(
                    this.manifest.series_id,
                    state
                ).catch(err => {
                    mpDebugWarn('⚠️  Failed to save to IndexedDB, continuing with localStorage only:', err);
                });
            }
            
            if (this.rootPermlink) {
                mpDebugLog(`   🔗 Root permlink saved: ${this.rootPermlink}`);
            }
        } catch (error) {
            mpDebugWarn('⚠️  Failed to save state to localStorage:', error);
        }
    }
    
    /**
     * Get current pipeline status (Phase 9)
     * 
     * @returns {string} - Status ('in_progress', 'paused', 'completed', 'failed', 'cancelled')
     * @private
     */
    _getStatus() {
        if (this.cancelled) return 'cancelled';
        if (this.paused) return 'paused';
        if (this.currentPart > this.manifest.total_parts) return 'completed';
        
        const failedParts = this.manifest.parts.filter(p => p.status === 'failed');
        if (failedParts.length > 0 && this.currentPart > failedParts[0].part_number) {
            return 'failed';
        }
        
        return 'in_progress';
    }
    
    /**
     * Mark pipeline as paused (Phase 9)
     * Called when retries are exhausted - preserves state for resume
     */
    markAsPaused() {
        this.paused = true;
        this._saveState();
        mpDebugLog(`⏸️  Pipeline marked as paused (can be resumed later)`);
    }
    
    /**
     * Clear pipeline state from localStorage AND IndexedDB
     * Called after successful completion
     * 
     * @private
     */
    async _clearState() {
        try {
            const stateKey = `archive_multipart_pipeline_${this.manifest.series_id}`;
            
            // Clear localStorage
            localStorage.removeItem(stateKey);
            mpDebugLog(`🗑️  State cleared from localStorage: ${stateKey}`);
            
            // Clear IndexedDB (both content and state)
            if (window.ArcHiveStorage) {
                await window.ArcHiveStorage.deletePipelineState(this.manifest.series_id);
                await window.ArcHiveStorage.deleteContentParts(this.manifest.series_id);
                mpDebugLog(`🗑️  Content and state cleared from IndexedDB`);
            }
        } catch (error) {
            mpDebugWarn('⚠️  Failed to clear state:', error);
        }
    }
    
    /**
     * Restore pipeline state from a saved state object
     * Used to resume a pipeline with all state (including rootPermlink)
     * 
     * @param {Object} state - Saved state object
     */
    restoreState(state) {
        if (!state) {
            throw new Error('restoreState requires a valid state object');
        }
        
        mpDebugLog(`🔄 Restoring pipeline state...`);
        
        // Restore core state
        this.currentPart = state.currentPart || 1;
        this.attempts = state.attempts || {};
        this.cancelled = state.cancelled || false;
        this.paused = state.paused || false;
        this.errors = state.errors || [];
        this.rootPermlink = state.rootPermlink || null; // THREADED REPLIES: Restore root permlink
        
        // Update manifest with saved state
        if (state.manifest) {
            this.manifest = state.manifest;
        }
        
        mpDebugLog(`   ✅ State restored`);
        mpDebugLog(`   Current part: ${this.currentPart}/${this.manifest.total_parts}`);
        if (this.rootPermlink) {
            mpDebugLog(`   🔗 Root permlink restored: ${this.rootPermlink}`);
        }
    }
    
    /**
     * Load pipeline state from localStorage (static method)
     * Used to resume a previously saved pipeline
     * 
     * @param {string} seriesId - Series ID to load
     * @returns {Object|null} - Saved state or null if not found
     */
    static loadState(seriesId) {
        try {
            const stateKey = `archive_multipart_pipeline_${seriesId}`;
            const stateJson = localStorage.getItem(stateKey);
            
            if (!stateJson) {
                return null;
            }
            
            const state = JSON.parse(stateJson);
            mpDebugLog(`📂 State loaded from localStorage: ${stateKey}`);
            mpDebugLog(`   Saved at: ${state.savedAt}`);
            mpDebugLog(`   Current part: ${state.currentPart}/${state.manifest.total_parts}`);
            if (state.rootPermlink) {
                mpDebugLog(`   🔗 Root permlink: ${state.rootPermlink}`);
            }
            
            return state;
        } catch (error) {
            mpDebugWarn('⚠️  Failed to load state from localStorage:', error);
            return null;
        }
    }
    
    /**
     * Resume pipeline from saved state (static method)
     * Creates a new pipeline instance from localStorage
     * 
     * @param {string} seriesId - Series ID to resume
     * @param {Function} transportFunction - Hive posting function
     * @param {Function} progressCallback - Progress callback
     * @returns {HivePostingPipeline|null} - Pipeline instance or null if no saved state
     */
    static resumeFromState(seriesId, transportFunction, progressCallback = null) {
        const state = HivePostingPipeline.loadState(seriesId);
        
        if (!state) {
            mpDebugLog(`❌ No saved state found for series: ${seriesId}`);
            return null;
        }
        
        // Extract content parts from manifest (if available)
        // NOTE: Content parts are NOT saved to localStorage (too large)
        // This is a limitation - user must provide content parts to resume
        // Phase 9 will address this with content reconstruction
        
        mpDebugLog(`🔄 Resuming pipeline from saved state...`);
        mpDebugLog(`   Series: ${seriesId}`);
        mpDebugLog(`   Progress: ${state.currentPart - 1}/${state.manifest.total_parts} parts posted`);
        
        // For now, return the state object - caller must create pipeline with content
        return state;
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MODULE EXPORTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Expose public API
if (typeof window !== 'undefined') {
    window.ArcHiveMultiPart = {
        // Configuration
        HIVE_BODY_LIMIT_BYTES,
        SAFE_CHUNK_SIZE_BYTES,
        METADATA_OVERHEAD_BYTES,
        
        // Phase 9: Resume Configuration
        STATE_VERSION,
        POSTING_LOCK_CONFIG,
        STATE_RETENTION_CONFIG,
        
        // Size utilities
        calculateByteSize,
        needsSplitting,
        estimatePartCount,
        
        // Splitting engine
        splitContentIntoParts,
        generateSplitPreview,
        
        // Dual Hash System (Phase 3)
        stripManifestComment,
        hashString,
        hashMultiPartContent,
        verifyMultiPartContent,
        
        // Manifest management
        generateUUID,
        generateSeriesTag,  // Phase 5: Series tag for multi-part discovery (16 buckets)
        createManifest,
        updateManifestWithPost,
        compactManifestForPost,
        parseCompactManifest,
        extractManifestFromPost,
        validateManifest,
        
        // Phase 4: Posting Pipeline
        HivePostingPipeline,
        PIPELINE_PHASES,
        PART_STATUS,
        ERROR_TYPES,
        
        // Phase 9: Resume Capability
        verifyCompletedParts,
        
        // Internal utilities (exposed for testing)
        _internal: {
            findSplitPosition,
            SPLIT_CONFIG,
            classifyError,
            sleep
        }
    };
    
    mpDebugLog('✅ ArcHive Multi-Part module loaded successfully (Phase 9)');
    mpDebugLog('   Available as: window.ArcHiveMultiPart');
    mpDebugLog('   Functions:', Object.keys(window.ArcHiveMultiPart).length);
    mpDebugLog('   Phase 9: Resume Capability ready');
}
