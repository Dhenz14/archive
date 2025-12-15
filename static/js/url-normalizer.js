/**
 * URL Normalization Utility
 * Provides canonical URL comparison for content verification
 * 
 * Handles platform-specific rules to strip tracking parameters
 * while preserving content identifiers
 */

/**
 * Check if hostname matches a domain (exact or subdomain)
 * @param {string} hostname - Hostname to check (without www.)
 * @param {string} domain - Domain to match against
 * @returns {boolean} - True if matches
 */
function matchesDomain(hostname, domain) {
    return hostname === domain || hostname.endsWith('.' + domain);
}

/**
 * Normalize URL for canonical comparison
 * Strips tracking parameters and normalizes format
 * 
 * @param {string} url - URL to normalize
 * @returns {string} - Normalized URL
 */
function normalizeUrl(url) {
    if (!url) return '';
    
    try {
        const urlObj = new URL(url);
        let hostname = urlObj.hostname.toLowerCase().replace(/^www\./, '');
        let pathname = urlObj.pathname;
        let search = urlObj.search;
        
        // Platform-specific normalization rules (use exact domain matching)
        if (matchesDomain(hostname, 'twitter.com') || matchesDomain(hostname, 'x.com')) {
            // Twitter/X: Status ID in path is canonical, strip ALL query params
            search = '';
        } else if (matchesDomain(hostname, 'youtube.com') || hostname === 'youtu.be') {
            // YouTube: Keep video ID and playlist, strip everything else (including timestamps)
            const params = new URLSearchParams(search);
            const videoId = params.get('v');
            const playlist = params.get('list');
            
            const keepParams = new URLSearchParams();
            if (videoId) keepParams.set('v', videoId);
            if (playlist) keepParams.set('list', playlist);
            
            search = keepParams.toString() ? '?' + keepParams.toString() : '';
        } else {
            // Generic URLs: Strip common tracking/referral parameters
            const params = new URLSearchParams(search);
            
            // Comprehensive list of tracking parameters to remove
            // Includes analytics, referral tracking, share tracking, and marketing campaign params
            const trackingParams = [
                // Google Analytics & Marketing
                'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
                'utm_id', 'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic',
                '_ga', '_gl', 'gclid', 'gclsrc',
                
                // Social media click IDs
                'fbclid', 'fb_action_ids', 'fb_action_types', 'fb_source', 'fb_ref',
                'msclkid', 'igshid',
                
                // Referral tracking (ubiquitous across platforms)
                'ref', 'ref_src', 'ref_url', 'source',
                
                // Email marketing
                'mc_cid', 'mc_eid',
                
                // Other common tracking
                'campaign_id', 'ad_id', 'adset_id', 'ad_name', 'adset_name', 'campaign_name',
                'share', 'shared'
            ];
            
            trackingParams.forEach(param => params.delete(param));
            search = params.toString() ? '?' + params.toString() : '';
        }
        
        // Return normalized URL (hostname is already lowercased, preserve case for path/query)
        return hostname + pathname + search;
        
    } catch (e) {
        // Fallback for malformed URLs: Try to fix by prepending https:// and normalizing again
        // This ensures tracking params are stripped consistently
        const hasProtocol = /^https?:\/\//i.test(url);
        if (!hasProtocol) {
            try {
                // Strip leading slashes (protocol-relative URLs) and prepend https://
                const cleaned = url.replace(/^\/+/, '');
                // Recursive call to apply full normalization (params, fragments, etc.)
                return normalizeUrl('https://' + cleaned);
            } catch (e2) {
                // Still failed, do manual normalization
            }
        }
        
        // Last resort: manual normalization (shouldn't reach here often)
        const stripped = url.replace(/^(https?:)?\/+/i, '');  // Strip protocol and slashes
        const firstSlashOrQuery = stripped.search(/[/?#]/);
        if (firstSlashOrQuery === -1) {
            return stripped.replace(/^www\./i, '').toLowerCase();
        } else {
            const hostname = stripped.substring(0, firstSlashOrQuery).replace(/^www\./i, '').toLowerCase();
            const rest = stripped.substring(firstSlashOrQuery);
            return hostname + rest;
        }
    }
}

/**
 * Check if two URLs are canonically equivalent
 * 
 * @param {string} url1 - First URL
 * @param {string} url2 - Second URL
 * @returns {boolean} - True if URLs are equivalent
 */
function urlsMatch(url1, url2) {
    return normalizeUrl(url1) === normalizeUrl(url2);
}

/**
 * Get platform name from URL
 * 
 * @param {string} url - URL to analyze
 * @returns {string} - Platform name (twitter, youtube, generic)
 */
function getPlatform(url) {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase().replace('www.', '');
        
        if (hostname.includes('twitter.com') || hostname.includes('x.com')) {
            return 'twitter';
        } else if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
            return 'youtube';
        } else {
            return 'generic';
        }
    } catch {
        return 'generic';
    }
}

// Export for module usage (if supported)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalizeUrl, urlsMatch, getPlatform };
}

// Also expose globally for direct script inclusion
if (typeof window !== 'undefined') {
    window.ArcHiveUrlNormalizer = { normalizeUrl, urlsMatch, getPlatform };
}
